/**
 * GET /api/search?q=leica&limit=20
 *
 * Validates session cookie, then proxies search to Shopify Admin API.
 *
 * Environment variables:
 *   SHOPIFY_STORE    — camerawest.myshopify.com
 *   SHOPIFY_TOKEN    — shpat_xxx (Admin API token, set as secret)
 *   COLLECTION_ID    — numeric ID of your pre-owned collection
 */

export async function onRequestGet({ request, env }) {
  const corsHeaders = { 'Content-Type': 'application/json' };

  // ── Validate session ──────────────────────────────────────────────
  const cookieHeader = request.headers.get('Cookie') || '';
  const sessionId = parseCookie(cookieHeader, 'cw_session');

  if (!sessionId) {
    return Response.json({ error: 'Not authenticated', products: [] }, { status: 401 });
  }

  const sessionRaw = await env.AUTH_KV.get(`session:${sessionId}`);
  if (!sessionRaw) {
    return Response.json({ error: 'Session expired', products: [] }, { status: 401 });
  }

  const session = JSON.parse(sessionRaw);
  if (Date.now() > session.expires) {
    return Response.json({ error: 'Session expired', products: [] }, { status: 401 });
  }

  // ── Parse query ───────────────────────────────────────────────────
  const url   = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

  if (!query || query.length < 2) {
    return Response.json({ products: [] }, { headers: corsHeaders });
  }

  // ── Query Shopify ─────────────────────────────────────────────────
  const collectionGid = `gid://shopify/Collection/${env.COLLECTION_ID}`;

  const graphql = `
    query SearchProducts($query: String!, $limit: Int!) {
      collection(id: "${collectionGid}") {
        products(first: $limit, query: $query, sortKey: RELEVANCE) {
          edges {
            node {
              id
              title
              vendor
              productType
              priceRangeV2 { minVariantPrice { amount } }
              metafields(identifiers: [
                {namespace: "custom", key: "system_id"},
                {namespace: "custom", key: "item_type"},
                {namespace: "custom", key: "medium"}
              ]) { key value }
            }
          }
        }
      }
    }
  `;

  try {
    const shopifyRes = await fetch(
      `https://${env.SHOPIFY_STORE}/admin/api/2024-10/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': env.SHOPIFY_TOKEN,
        },
        body: JSON.stringify({
          query: graphql,
          variables: { query: `title:*${query}*`, limit },
        }),
      }
    );

    if (!shopifyRes.ok) {
      throw new Error(`Shopify returned ${shopifyRes.status}`);
    }

    const data = await shopifyRes.json();

    if (data.errors) {
      throw new Error(data.errors[0]?.message || 'GraphQL error');
    }

    const edges = data?.data?.collection?.products?.edges || [];

    const CAM_T = new Set(['Bodies','Instant','Cine','Video','Scanners']);
    const LEN_T = new Set(['Lenses','Filters','UV Filters','ND Filters','Close Up',
                           'Teleconverters','C-Pol Filters','IR Filters','Color Filters',
                           'Square Filters','Lens Mount Adapters']);

    const products = edges.map(({ node }) => {
      const meta     = {};
      (node.metafields || []).forEach(mf => { if (mf) meta[mf.key] = mf.value; });
      const price    = parseFloat(node.priceRangeV2?.minVariantPrice?.amount || 0);
      const itemType = meta['item_type'] || node.productType || '';
      let   cat      = 'accessory';
      if (CAM_T.has(itemType)) cat = 'camera';
      else if (LEN_T.has(itemType)) cat = 'lens';

      return {
        n:   node.title,
        v:   node.vendor   || '',
        si:  meta['system_id'] || '',
        it:  itemType,
        m:   meta['medium'] || '',
        p:   price,
        cat,
        sku: node.id.split('/').pop(),
      };
    });

    return Response.json({ products }, { headers: corsHeaders });

  } catch (err) {
    console.error('Search error:', err);
    return Response.json(
      { error: err.message, products: [] },
      { status: 502, headers: corsHeaders }
    );
  }
}

function parseCookie(cookieStr, name) {
  const match = cookieStr.split(';').map(c => c.trim())
    .find(c => c.startsWith(`${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}
