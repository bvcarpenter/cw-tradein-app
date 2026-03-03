/**
 * GET /api/search?q=leica&limit=25
 *
 * Searches products from the Google Sheets trade-in catalog.
 * Brand (matrix) price-list results appear first;
 * remaining slots are filled from the "Shopify Product Catalog" sheet.
 *
 * Data is cached in Cloudflare KV (AUTH_KV) for 1 hour so searches
 * are fast even on cold worker starts.
 *
 * Google Sheet:
 *   https://docs.google.com/spreadsheets/d/1hy4RzljHDASz_K4XO__w9rztCaW7rnCg_z5wa2uBTH4
 */

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

const KV_KEY = 'catalog:v3';
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
    src:   'shopify',
  };
}

// ── Sheet fetching ──────────────────────────────────────────────────
function fetchSheet(sheetName) {
  const url = `${GVIZ_BASE}?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  return fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
}

// ── In-memory cache (survives within a single worker isolate) ───────
let _brand = null, _shopify = null, _ts = 0;
const MEM_TTL = 5 * 60 * 1000; // 5 min

async function loadAll(kv) {
  // 1. In-memory cache (fastest)
  if (_brand && _shopify && Date.now() - _ts < MEM_TTL) {
    return { brand: _brand, shopify: _shopify };
  }

  // 2. KV cache (fast, survives cold starts)
  if (kv) {
    try {
      const cached = await kv.get(KV_KEY, 'json');
      if (cached && cached.brand && cached.shopify) {
        _brand = cached.brand;
        _shopify = cached.shopify;
        _ts = Date.now();
        console.log(`Catalog from KV: ${cached.brand.length} brand, ${cached.shopify.length} shopify`);
        return cached;
      }
    } catch (e) { /* KV miss or parse error — continue to fetch */ }
  }

  // 3. Fetch from Google Sheets (14 requests: 13 brand + 1 Shopify)
  const results = await Promise.all([
    ...BRAND_SHEETS.map(name =>
      fetchSheet(name)
        .then(csv => parseCSV(csv).map(parseBrandRow).filter(Boolean))
        .catch(() => [])
    ),
    fetchSheet(SHOPIFY_SHEET)
      .then(csv => parseCSV(csv).map(parseShopifyRow).filter(Boolean))
      .catch(() => []),
  ]);

  const brand = [];
  for (let i = 0; i < BRAND_SHEETS.length; i++) brand.push(...results[i]);
  const shopify = results[BRAND_SHEETS.length];

  _brand = brand;
  _shopify = shopify;
  _ts = Date.now();
  console.log(`Catalog fetched: ${brand.length} brand, ${shopify.length} shopify products`);

  // Write to KV in the background (non-blocking)
  if (kv) {
    kv.put(KV_KEY, JSON.stringify({ brand, shopify }), { expirationTtl: KV_TTL }).catch(() => {});
  }

  return { brand, shopify };
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
  scored.sort((a, b) => b.sc - a.sc);
  return scored;
}

// ── Request handler ─────────────────────────────────────────────────
export async function onRequestGet({ request, env }) {
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

  try {
    const { brand, shopify } = await loadAll(env?.AUTH_KV);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    // Brand (matrix) results first
    const brandResults = score(brand, terms);

    // Fill remaining slots with Shopify Product Catalog
    const remaining = limit - brandResults.length;
    let shopifyResults = [];
    if (remaining > 0) {
      shopifyResults = score(shopify, terms).slice(0, remaining);
    }

    const products = [
      ...brandResults.slice(0, limit).map(r => r.p),
      ...shopifyResults.map(r => r.p),
    ];

    return Response.json({ products }, { headers: cors });
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
