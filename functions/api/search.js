/**
 * GET /api/search?q=leica&limit=20
 *
 * Searches Shopify products by title.
 * Uses OAuth token rotation via _shopify.js helper.
 * Environment variables: see _shopify.js
 */

import { shopifyGQL } from './_shopify.js';

export async function onRequestGet({ request, env }) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };


  const url   = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

  if (!query || query.length < 2) {
    return Response.json({ products: [] }, { headers: corsHeaders });
  }

  const graphql = `
    query SearchProducts($query: String!, $limit: Int!) {
      products(first: $limit, query: $query, sortKey: RELEVANCE) {
        edges {
          node {
            id
            title
            vendor
            productType
            priceRangeV2 { minVariantPrice { amount } }
            system_id: metafield(namespace: "custom", key: "system_id") { value }
            item_type: metafield(namespace: "custom", key: "item_type") { value }
            medium: metafield(namespace: "custom", key: "medium") { value }
          }
        }
      }
    }
  `;

  try {
    const data = await shopifyGQL(env, graphql, { query: `title:*${query}*`, limit });

    const edges = data?.products?.edges || [];

    const CAM_T = new Set(['Bodies','Instant','Cine','Video','Scanners']);
    const LEN_T = new Set(['Lenses','Filters','UV Filters','ND Filters','Close Up',
                           'Teleconverters','C-Pol Filters','IR Filters','Color Filters',
                           'Square Filters','Lens Mount Adapters']);

    const products = edges.map(({ node }) => {
      const systemId = node.system_id?.value || '';
      const itemType = node.item_type?.value || node.productType || '';
      const medium   = node.medium?.value || '';
      const price    = parseFloat(node.priceRangeV2?.minVariantPrice?.amount || 0);
      let   cat      = 'accessory';
      if (CAM_T.has(itemType)) cat = 'camera';
      else if (LEN_T.has(itemType)) cat = 'lens';

      return {
        n:   node.title,
        v:   node.vendor   || '',
        si:  systemId,
        it:  itemType,
        m:   medium,
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

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
