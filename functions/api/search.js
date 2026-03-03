/**
 * GET /api/search?q=leica&limit=25
 *
 * Searches products from the Google Sheets trade-in catalog.
 * Searches brand-specific price-list sheets FIRST; falls back to
 * the "Shopify Product Catalog" sheet (120-day pre-owned inventory).
 *
 * Google Sheet (published):
 *   https://docs.google.com/spreadsheets/d/1hy4RzljHDASz_K4XO__w9rztCaW7rnCg_z5wa2uBTH4
 */

const SHEET_BASE = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRUWn7iSZnGuc-0w4dqbMffAJwCQvwdy9_JqqVHYj7GrqHlovqWz7-XPVU-hyh_IrPltw9DTKw301ED/pub';

// Brand price-list tabs (searched first)
const BRAND_SHEETS = [
  { name: 'Canon EOS R',      gid: 649423356 },
  { name: 'Fujifilm GFX',     gid: 1927255526 },
  { name: 'Fujifilm X',       gid: 1075754177 },
  { name: 'Hasselblad X',     gid: 1075506952 },
  { name: 'Leica Accessories', gid: 1781634734 },
  { name: 'Leica CL-TL',     gid: 1058226739 },
  { name: 'Leica M',          gid: 1698843593 },
  { name: 'Leica Q',          gid: 566317506 },
  { name: 'Leica S',          gid: 941830797 },
  { name: 'Leica SL',         gid: 933139937 },
  { name: 'Nikon Z',          gid: 617736799 },
  { name: 'Panasonic Lumix S', gid: 110400018 },
  { name: 'Sony Alpha',       gid: 348316227 },
];

// Shopify Product Catalog tab (fallback)
const SHOPIFY_GID = 265746322;

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
    grade: row['Pre-Owned Grade'] || '',
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
    asin:  row['Amazon ASIN'] || '',
    src:   'shopify',
  };
}

// ── Sheet fetching (Cloudflare edge-cached 1 h) ────────────────────
function fetchSheet(gid) {
  const url = `${SHEET_BASE}?gid=${gid}&single=true&output=csv`;
  return fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
}

// ── In-memory product cache (survives within a single isolate) ──────
let _brand = null, _shopify = null, _ts = 0;
const MEM_TTL = 5 * 60 * 1000; // 5 min in-memory, CDN handles the rest

async function loadAll() {
  if (_brand && _shopify && Date.now() - _ts < MEM_TTL) {
    return { brand: _brand, shopify: _shopify };
  }

  const promises = [
    ...BRAND_SHEETS.map(s =>
      fetchSheet(s.gid)
        .then(csv => parseCSV(csv).map(parseBrandRow).filter(Boolean))
        .catch(() => [])
    ),
    fetchSheet(SHOPIFY_GID)
      .then(csv => parseCSV(csv).map(parseShopifyRow).filter(Boolean))
      .catch(() => []),
  ];

  const results = await Promise.all(promises);

  const brand = [];
  for (let i = 0; i < BRAND_SHEETS.length; i++) brand.push(...results[i]);
  const shopify = results[BRAND_SHEETS.length];

  _brand = brand;
  _shopify = shopify;
  _ts = Date.now();
  console.log(`Catalog loaded: ${brand.length} brand, ${shopify.length} shopify products`);
  return { brand, shopify };
}

// ── Search scoring ──────────────────────────────────────────────────
function score(products, terms) {
  const scored = [];
  for (const p of products) {
    const hay = [p.n, p.v, p.si, p.it, p.m, p.fmt, p.grade, p.sku]
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
export async function onRequestGet({ request }) {
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
    const { brand, shopify } = await loadAll();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    // Search brand price-list sheets first
    let results = score(brand, terms);

    // Fall back to Shopify Product Catalog if nothing matched
    if (!results.length) {
      results = score(shopify, terms);
    }

    const products = results.slice(0, limit).map(r => r.p);
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
