/**
 * GET /api/search?q=leica&limit=25&source=brand|shopify|all
 *
 * Searches products from the Google Sheets trade-in catalog.
 *
 * source=brand   → Only Trade Matrix (brand) rows — fast, no Shopify dependency
 * source=shopify → Only Shopify Product Catalog rows — includes live inventory
 * source=all     → Both (default, original behavior)
 *
 * Result ordering:
 *   1. Brand (matrix) price-list rows — canonical pricing always first
 *   2. In-stock "Shopify Product Catalog" rows
 *   3. Remaining Shopify rows (out of stock / unknown)
 *
 * Data is cached separately in KV so brand results are fast even on cold starts.
 *
 * Google Sheet:
 *   https://docs.google.com/spreadsheets/d/1hy4RzljHDASz_K4XO__w9rztCaW7rnCg_z5wa2uBTH4
 */

import { shopifyGQL } from './_shopify.js';

const SHEET_ID = '1hy4RzljHDASz_K4XO__w9rztCaW7rnCg_z5wa2uBTH4';
const GVIZ_BASE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`;

const BRAND_SHEETS = [
  'Canon EOS R', 'Fujifilm GFX', 'Fujifilm X', 'Hasselblad X',
  'Leica Accessories', 'Leica CL-TL', 'Leica M', 'Leica Q',
  'Leica S', 'Leica SL', 'Nikon Z', 'Panasonic Lumix S', 'Sony Alpha',
];

const SHOPIFY_SHEET = 'Shopify Product Catalog';

const KV_BRAND_KEY = 'catalog:brand:v6';
const KV_SHOPIFY_KEY = 'catalog:shopify:v6';
const KV_TTL = 3600;

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
    v:     row['Vendor'] || '',
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

async function fetchShopifyInventoryMap(env) {
  if (!env?.SHOPIFY_STORE) return null;

  const map = new Map();
  const MAX_PAGES = 20;
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

// ── Separate in-memory caches ───────────────────────────────────────
let _brand = null, _brandTs = 0, _brandRefreshing = null;
let _shopify = null, _shopifyTs = 0, _shopifyRefreshing = null;
const MEM_TTL = 5 * 60 * 1000;

async function loadBrand(env, waitUntil) {
  if (_brand && Date.now() - _brandTs < MEM_TTL) return _brand;
  if (_brand && !_brandRefreshing) {
    const p = refreshBrand(env).catch(e => console.error('Brand refresh:', e.message));
    if (waitUntil) waitUntil(p);
    return _brand;
  }
  return await refreshBrand(env);
}

function refreshBrand(env) {
  if (_brandRefreshing) return _brandRefreshing;
  _brandRefreshing = (async () => {
    try {
      const kv = env?.AUTH_KV;
      if (kv) {
        try {
          const cached = await kv.get(KV_BRAND_KEY, 'json');
          if (cached?.length) {
            _brand = cached;
            _brandTs = Date.now();
            return _brand;
          }
        } catch(e) {}
      }

      const results = await Promise.all(
        BRAND_SHEETS.map(name =>
          fetchSheet(name)
            .then(csv => parseCSV(csv).map(parseBrandRow).filter(Boolean))
            .catch(() => [])
        )
      );
      const brand = results.flat();
      _brand = brand;
      _brandTs = Date.now();

      if (kv) kv.put(KV_BRAND_KEY, JSON.stringify(brand), { expirationTtl: KV_TTL }).catch(() => {});
      return brand;
    } finally {
      _brandRefreshing = null;
    }
  })();
  return _brandRefreshing;
}

async function loadShopify(env, waitUntil) {
  if (_shopify && Date.now() - _shopifyTs < MEM_TTL) return _shopify;
  if (_shopify && !_shopifyRefreshing) {
    const p = refreshShopify(env).catch(e => console.error('Shopify refresh:', e.message));
    if (waitUntil) waitUntil(p);
    return _shopify;
  }
  return await refreshShopify(env);
}

function refreshShopify(env) {
  if (_shopifyRefreshing) return _shopifyRefreshing;
  _shopifyRefreshing = (async () => {
    try {
      const kv = env?.AUTH_KV;
      if (kv) {
        try {
          const cached = await kv.get(KV_SHOPIFY_KEY, 'json');
          if (cached?.length) {
            _shopify = cached;
            _shopifyTs = Date.now();
            return _shopify;
          }
        } catch(e) {}
      }

      const [rows, invMap] = await Promise.all([
        fetchSheet(SHOPIFY_SHEET)
          .then(csv => parseCSV(csv).map(parseShopifyRow).filter(Boolean))
          .catch(() => []),
        fetchShopifyInventoryMap(env).catch(err => {
          console.error('Shopify inventory fetch failed:', err.message);
          return null;
        }),
      ]);

      if (invMap) {
        for (const p of rows) {
          if (p.sku && invMap.has(p.sku)) {
            p.inStock = invMap.get(p.sku) > 0;
          }
        }
      }

      _shopify = rows;
      _shopifyTs = Date.now();

      if (kv) kv.put(KV_SHOPIFY_KEY, JSON.stringify(rows), { expirationTtl: KV_TTL }).catch(() => {});
      return rows;
    } finally {
      _shopifyRefreshing = null;
    }
  })();
  return _shopifyRefreshing;
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

function createdMs(p) {
  const raw = p && p.created;
  if (!raw) return 0;
  const m = String(raw).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return 0;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return isNaN(t) ? 0 : t;
}

const bySort = (a, b) => {
  if (b.sc !== a.sc) return b.sc - a.sc;
  return createdMs(b.p) - createdMs(a.p);
};

const byNewest = (a, b) => {
  const da = createdMs(a.p), db = createdMs(b.p);
  if (da !== db) return db - da;
  return b.sc - a.sc;
};

// ── Request handler ─────────────────────────────────────────────────
export async function onRequestGet({ request, env, ctx }) {
  const waitUntil = ctx?.waitUntil?.bind(ctx);
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const url    = new URL(request.url);
  const query  = (url.searchParams.get('q') || '').trim();
  const limit  = Math.min(parseInt(url.searchParams.get('limit') || '25', 10), 50);
  const source = url.searchParams.get('source') || 'all';

  if (!query || query.length < 2) {
    return Response.json({ products: [] }, { headers: cors });
  }

  const cacheUrl = new URL(url.origin + url.pathname);
  cacheUrl.searchParams.set('q', query.toLowerCase());
  cacheUrl.searchParams.set('limit', String(limit));
  cacheUrl.searchParams.set('source', source);
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    let products = [];

    if (source === 'brand') {
      const brand = await loadBrand(env, waitUntil);
      products = score(brand, terms).sort(bySort).slice(0, limit).map(r => r.p);
    } else if (source === 'shopify') {
      const shopify = await loadShopify(env, waitUntil);
      const scored = score(shopify, terms);
      const inStock = scored.filter(r => r.p.inStock === true).sort(byNewest);
      const other = scored.filter(r => r.p.inStock !== true).sort(byNewest);
      products = [...inStock, ...other].slice(0, limit).map(r => r.p);
    } else {
      const [brand, shopify] = await Promise.all([
        loadBrand(env, waitUntil),
        loadShopify(env, waitUntil),
      ]);
      const brandResults = score(brand, terms).sort(bySort);
      const scoredShopify = score(shopify, terms);
      const shopifyInStock = scoredShopify.filter(r => r.p.inStock === true).sort(byNewest);
      const shopifyOther = scoredShopify.filter(r => r.p.inStock !== true).sort(byNewest);
      const remaining = Math.max(0, limit - brandResults.length);
      const shopifyResults = remaining > 0
        ? [...shopifyInStock, ...shopifyOther].slice(0, remaining)
        : [];
      products = [
        ...brandResults.slice(0, limit).map(r => r.p),
        ...shopifyResults.map(r => r.p),
      ];
    }

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
