/**
 * GET /api/catalog
 * Proxies the Ablestar CSV so the browser doesn't hit CORS restrictions.
 * No auth needed — Cloudflare Access protects the whole domain.
 */
const CSV_URL = 'https://storage.ablestar.app/export/70932562235/535d66f56fbd462e809fd8a8ff2f91a3/Product_Titles.csv';

export async function onRequestGet() {
  const upstream = await fetch(CSV_URL, {
    cf: { cacheTtl: 3600, cacheEverything: true } // cache 1hr at edge
  });

  if (!upstream.ok) {
    return new Response('CSV fetch failed', { status: 502 });
  }

  const body = await upstream.text();

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    }
  });
}
