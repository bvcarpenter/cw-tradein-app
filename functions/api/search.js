/**
 * GET /api/search?q=leica&limit=25
 *
 * Searches products from the Google Sheets trade-in catalog.
 * Result ordering:
 *   1. Brand (matrix) price-list rows — canonical pricing always first
 *   2. In-stock "Shopify Product Catalog" rows (live inventory from
 *      Shopify Admin API)
 *   3. Remaining Shopify rows (out of stock / unknown)
 * Within each bucket, rows are sorted by match score, then newest-to-oldest
 * by Date Created.
 *
 * Data is cached in Cloudflare KV (AUTH_KV) for 1 hour so searches
 * are fast even on cold worker starts.
 *
 * Google Sheet:
 *   https://docs.google.com/spreadsheets/d/1hy4RzljHDASz_K4XO__w9rztCaW7rnCg_z5wa2uBTH4
 */

import { shopifyGQL } from './_shopify.js';

const SHEET_ID = '1hy4RzljHDASz_K4XO__w9rztCaW7rnCg_z5wa2uBTH4';
const GVIZ_BASE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`;

// 13 brand matrix tabs (searched first, prioritized in results)
const BRAND_SHEETS = [
  'Canon EOS R', 'Fujifilm GFX', 'Fujifilm X', 'Hasselblad X',
  'Leica Accessories', 'Leica CL-TL', 'Leica M', 'Leica Q',
  'Leica S', 'Leica SL', 'Nikon Z', 'Panasonic Lumix S', 'Sony Alpha',
];

// "Shopify Product Catalog" is the 120-day pre-owned inventory (lower priority).
const SHOPIFY_SHEET = 'Shopify Product Catalog';

// Bumped to v5: Shopify rows now carry a live `inStock` flag from the Shopify
// Admin API so the search endpoint can surface in-stock pre-owned items first.
const KV_KEY = 'catalog:v5';
const KV_TTL = 3600; // 1 hour

// ── Category helpers ────────────────────────────────────────────────
const CAM_T = new Set(['Bodies','Body','Instant','Cine','Video','Scanners']);
const LEN_T = new Set([
  'Lenses','Lens','Filters','UV Filters','ND Filters','Close Up',
  'Teleconverters','C-Pol Filters','IR Filters','Color Filters',
  'Square Filters','Lens Mount Adapters',
]);

function categorize(type) {
  if (CAM_T.has(type)) return 'camera';
  if (LEN_T.has(type)) return 'lens';
  return 'accessory';
}

// ── CSV parsing ─────────────────────────────────────────────────────
function parseCSVLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else { cur += c; }
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const hdrs = parseCSVLine(lines[0]).map(h => h.replace(/\r$/, '').trim());
  const idx = {};
  hdrs.forEach((h, i) => { idx[h] = i; });
  return lines.slice(1).map(line => {
    const cols = parseCSVLine(line);
    const row = {};
    hdrs.forEach(h => { row[h] = (cols[idx[h]] || '').replace(/\r$/, '').trim(); });
    return row;
  });
}

// ── Row → product normalizers ───────────────────────────────────────
function parseBrandRow(row) {
  const brand = row['Brand'] || '';
  const model = row['Model'] || row['Title'] || '';
  if (!brand && !model) return null;
  const type = row['Type'] || '';
  const price = parseFloat((row['Retail'] || '').replace(/[$,]/g, '')) || 0;
  return {
    n:     brand + (model ? ' ' + model : ''),
    v:     brand,
    si:    row['System'] || '',
    it:    type,
    m:     row['Medium'] || '',
    fmt:   row['Format'] || '',
    p:     price,
    cat:   categorize(type),
    sku:   row['MPN'] || '',
    src:   'brand',
  };
}

function stripToModel(raw) {
  let t = (raw || '').trim();
  t = t.replace(/\s*\([A-Z0-9+\-]{1,5}\)\s*$/i, '').trim();
  t = t.replace(/,\s*Boxed\s*\d*\s*$/i, '').trim();
  t = t.replace(/[,\s]+[A-Z0-9]{5,}\s*$/i, '').trim();
  t = t.replace(/,\s*#?\d{4,}\s*$/i, '').trim();
  t = t.replace(/,\s*$/, '').trim();
  return t;
}

function parseShopifyRow(row) {
  const rawTitle = row['Title'] || '';
  const sku = row['SKU'] || '';
  if (!rawTitle && !sku) return null;
  const type = row['Type'] || '';
  return {
    n:     stripToModel(rawTitle),
    rawTitle,
    v:     '',
    si:    row['System ID'] || '',
    it:    type,
    m:     row['Medium'] || '',
    fmt:   row['Format'] || '',
    grade: row['Pre-Owned Grade'] || '',
    p:     parseFloat(row['Price']) || 0,
    cat:   categorize(type),
    sku,
    created: row['Date Created'] || '',
    src:   'shopify',
  };
}

// ── Sheet fetching ──────────────────────────────────────────────────
function fetchSheet(sheetName) {
  const url = `${GVIZ_BASE}?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  return fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
}

/**
 * Paginate through all Shopify product variants and build a SKU → inventory
 * quantity map. Used to enrich the Google Sheet's Shopify Product Catalog
 * rows with live stock status so the search dropdown can surface in-stock
 * pre-owned items first.
 *
 * Returns null if Shopify isn't configured; the caller should degrade
 * gracefully (items simply render without stock tags).
 */
async function fetchShopifyInventoryMap(env) {
  if (!env?.SHOPIFY_STORE) return null;

  const map = new Map();
  const MAX_PAGES = 20; // 20 × 250 = up to 5 000 variants — ample for the pre-owned catalog
  // Only paginate variants with stock — everything else is treated as
  // "not in stock" by default, so fetching them wastes round-trips.
  const query = `
    query VariantInventory($cursor: String) {
      productVariants(first: 250, after: $cursor, query: "inventory_quantity:>0") {
        pageInfo { hasNextPage endCursor }
        edges { node { sku inventoryQuantity } }
      }
    }
  `;

  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await shopifyGQL(env, query, { cursor });
    const pv = data?.productVariants;
    if (!pv) break;
    for (const e of pv.edges || []) {
      const s = e.node?.sku;
      if (s) map.set(s, Number(e.node.inventoryQuantity) || 0);
    }
    if (!pv.pageInfo?.hasNextPage) break;
    cursor = pv.pageInfo.endCursor;
  }
  return map;
}

// ── In-memory cache (survives within a single worker isolate) ───────
let _brand = null, _shopify = null, _ts = 0, _refreshing = null;
const MEM_TTL = 5 * 60 * 1000; // 5 min — after this we SWR-refresh

/**
 * Stale-while-revalidate loader. Never blocks a user request on a refresh
 * if we have *any* in-memory data — we serve stale and refresh in the
 * background via `waitUntil`. Only the very first request on a cold
 * isolate with no KV data has to wait for a full fetch.
 */
async function loadAll(env, waitUntil) {
  if (_brand && _shopify) {
    const stale = Date.now() - _ts >= MEM_TTL;
    if (stale && !_refreshing) {
      const p = refreshCatalog(env).catch(err => {
        console.error('Background refresh failed:', err.message);
      });
      if (waitUntil) waitUntil(p);
    }
    return { brand: _brand, shopify: _shopify };
  }
  // Cold isolate — must block on first load
  return await refreshCatalog(env);
}

/**
 * Refresh the in-memory catalog. Prefers KV (fast), falls back to
 * Google Sheets + Shopify inventory. Concurrent callers share the same
 * in-flight promise so we never do duplicate work.
 */
function refreshCatalog(env) {
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    try {
      const kv = env?.AUTH_KV;

      // 1. KV cache first (fast, survives cold starts)
      if (kv) {
        try {
          const cached = await kv.get(KV_KEY, 'json');
          if (cached?.brand && cached?.shopify) {
            _brand = cached.brand;
            _shopify = cached.shopify;
            _ts = Date.now();
            console.log(`Catalog from KV: ${cached.brand.length} brand, ${cached.shopify.length} shopify`);
            return { brand: _brand, shopify: _shopify };
          }
        } catch (e) { /* KV miss or parse error — continue to fetch */ }
      }

      // 2. Full fetch — 14 sheets + Shopify inventory in parallel
      const [sheetResults, invMap] = await Promise.all([
        Promise.all([
          ...BRAND_SHEETS.map(name =>
            fetchSheet(name)
              .then(csv => parseCSV(csv).map(parseBrandRow).filter(Boolean))
              .catch(() => [])
          ),
          fetchSheet(SHOPIFY_SHEET)
            .then(csv => parseCSV(csv).map(parseShopifyRow).filter(Boolean))
            .catch(() => []),
        ]),
        fetchShopifyInventoryMap(env).catch(err => {
          console.error('Shopify inventory fetch failed:', err.message);
          return null;
        }),
      ]);

      const brand = [];
      for (let i = 0; i < BRAND_SHEETS.length; i++) brand.push(...sheetResults[i]);
      const shopify = sheetResults[BRAND_SHEETS.length];

      let inStockCount = 0;
      if (invMap) {
        for (const p of shopify) {
          if (p.sku && invMap.has(p.sku)) {
            p.inStock = invMap.get(p.sku) > 0;
            if (p.inStock) inStockCount++;
          }
        }
      }

      _brand = brand;
      _shopify = shopify;
      _ts = Date.now();
      console.log(
        `Catalog refreshed: ${brand.length} brand, ${shopify.length} shopify ` +
        `(${invMap ? `${inStockCount} in stock` : 'inventory unavailable'})`
      );

      if (kv) {
        kv.put(KV_KEY, JSON.stringify({ brand, shopify }), { expirationTtl: KV_TTL }).catch(() => {});
      }

      return { brand, shopify };
    } finally {
      _refreshing = null;
    }
  })();
  return _refreshing;
}

// ── Search scoring ──────────────────────────────────────────────────
function score(products, terms) {
  const scored = [];
  for (const p of products) {
    const hay = [p.n, p.v, p.si, p.it, p.m, p.fmt, p.sku]
      .filter(Boolean).join(' ').toLowerCase();
    let sc = 0, ok = true;
    for (const t of terms) {
      if (hay.includes(t)) sc += t.length;
      else { ok = false; break; }
    }
    if (ok && sc) scored.push({ p, sc });
  }
  return scored;
}

/**
 * Parse a Shopify "Date Created" value ("2023-05-08 21:43:27 +0000")
 * into a numeric timestamp (ms). Returns 0 when missing/unparseable —
 * matrix rows have no date, so they fall to the bottom of date ties.
 */
function createdMs(p) {
  const raw = p && p.created;
  if (!raw) return 0;
  const m = String(raw).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return 0;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return isNaN(t) ? 0 : t;
}

// ── Request handler ─────────────────────────────────────────────────
export async function onRequestGet({ request, env, waitUntil }) {
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const url   = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '25', 10), 50);

  if (!query || query.length < 2) {
    return Response.json({ products: [] }, { headers: cors });
  }

  // Edge cache: normalize (q lowercased, limit clamped) so near-identical
  // queries share a single cached response across users in this colo.
  const cacheUrl = new URL(url.origin + url.pathname);
  cacheUrl.searchParams.set('q', query.toLowerCase());
  cacheUrl.searchParams.set('limit', String(limit));
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const { brand, shopify } = await loadAll(env, waitUntil);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    // Matrix (brand) rows come first so the canonical price-list is
    // always surfaced. Then in-stock Shopify items, then everything else.
    // Within each bucket we sort by match score, then newest-to-oldest so
    // recent pre-owned inventory floats up among equally-matching rows.
    const bySort = (a, b) => {
      if (b.sc !== a.sc) return b.sc - a.sc;
      return createdMs(b.p) - createdMs(a.p);
    };

    const brandResults = score(brand, terms).sort(bySort);

    // Split Shopify matches into in-stock / out-of-stock buckets so live
    // inventory surfaces immediately after the matrix.
    const scoredShopify = score(shopify, terms);
    const shopifyInStock = scoredShopify.filter(r => r.p.inStock === true).sort(bySort);
    const shopifyOther   = scoredShopify.filter(r => r.p.inStock !== true).sort(bySort);

    const remaining = Math.max(0, limit - brandResults.length);
    const shopifyResults = remaining > 0
      ? [...shopifyInStock, ...shopifyOther].slice(0, remaining)
      : [];

    const products = [
      ...brandResults.slice(0, limit).map(r => r.p),
      ...shopifyResults.map(r => r.p),
    ];

    // s-maxage=60 → Cloudflare holds this at the edge for 60s so repeat
    // queries in the colo skip the worker entirely. max-age=0 keeps
    // browsers honest — we want fresh stock status within a minute.
    const body = JSON.stringify({ products });
    const headers = { ...cors, 'Cache-Control': 'public, max-age=0, s-maxage=60' };
    if (waitUntil) waitUntil(cache.put(cacheKey, new Response(body, { headers })));
    return new Response(body, { headers });
  } catch (err) {
    console.error('Search error:', err);
    return Response.json(
      { error: err.message, products: [] },
      { status: 502, headers: cors },
    );
  }
}

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
