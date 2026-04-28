/**
 * GET /api/product-lookup?sku=CWTI-260330-A7K2
 *   Exact SKU lookup — returns single product status info.
 *
 * GET /api/product-lookup?q=CM22922
 *   Search mode — searches Shopify by SKU prefix or product title.
 *   Returns multiple results for Custom Processing item selection.
 */

import { shopifyGQL } from './_shopify.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const sku = (url.searchParams.get('sku') || '').trim();
  const q = (url.searchParams.get('q') || '').trim();

  if (q) return handleSearch(q, env);
  if (sku) return handleExactLookup(sku, env);
  return Response.json({ error: 'Missing ?sku= or ?q= parameter' }, { status: 400 });
}

async function handleSearch(q, env) {
  if (q.length < 2) {
    return Response.json({ results: [] }, { headers: CORS });
  }

  try {
    const hasSpaces = /\s/.test(q);
    let results = [];

    if (hasSpaces) {
      const query = `
        query searchProducts($q: String!) {
          products(first: 30, query: $q) {
            edges {
              node {
                title
                status
                productType
                vendor
                totalInventory
                variants(first: 10) {
                  edges {
                    node {
                      sku
                      title
                      price
                      inventoryQuantity
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const data = await shopifyGQL(env, query, { q });
      for (const edge of data?.products?.edges || []) {
        const prod = edge.node;
        for (const ve of prod.variants?.edges || []) {
          const v = ve.node;
          results.push({
            title: prod.title,
            variantTitle: v.title,
            sku: v.sku || '',
            price: v.price,
            type: prod.productType || '',
            vendor: prod.vendor || '',
            status: prod.status,
            inventoryQuantity: v.inventoryQuantity,
            inStock: v.inventoryQuantity > 0,
          });
        }
      }
    } else {
      const query = `
        query searchVariants($q: String!) {
          productVariants(first: 50, query: $q) {
            edges {
              node {
                sku
                title
                price
                inventoryQuantity
                product {
                  title
                  status
                  productType
                  vendor
                  totalInventory
                }
              }
            }
          }
        }
      `;
      const data = await shopifyGQL(env, query, { q: `sku:${q}*` });
      for (const edge of data?.productVariants?.edges || []) {
        const v = edge.node;
        const prod = v.product;
        results.push({
          title: prod.title,
          variantTitle: v.title,
          sku: v.sku || '',
          price: v.price,
          type: prod.productType || '',
          vendor: prod.vendor || '',
          status: prod.status,
          inventoryQuantity: v.inventoryQuantity,
          inStock: v.inventoryQuantity > 0,
        });
      }
    }

    return Response.json({ results }, { headers: CORS });
  } catch (err) {
    return Response.json({ error: err.message, results: [] }, { status: 500, headers: CORS });
  }
}

async function handleExactLookup(sku, env) {
  try {
    const query = `
      query productBySku($query: String!) {
        productVariants(first: 5, query: $query) {
          edges {
            node {
              id
              sku
              title
              price
              inventoryQuantity
              product {
                id
                title
                status
                descriptionHtml
                onlineStoreUrl
                featuredImage {
                  url
                }
                images(first: 50) {
                  edges { node { id } }
                }
                totalInventory
              }
            }
          }
        }
      }
    `;

    const data = await shopifyGQL(env, query, { query: `sku:${sku}` });
    const edges = data?.productVariants?.edges || [];

    const match = edges.find(e => e.node.sku === sku);

    if (!match) {
      return Response.json({
        found: false,
        sku,
        status: 'NOT_FOUND',
        message: 'Product not yet in Shopify',
      });
    }

    const variant = match.node;
    const product = variant.product;

    const hasDescription = !!(product.descriptionHtml && product.descriptionHtml.trim());
    const imageCount = product.images?.edges?.length || 0;

    return Response.json({
      found: true,
      sku,
      status: product.status,
      title: product.title,
      variantTitle: variant.title,
      price: variant.price,
      inventoryQuantity: variant.inventoryQuantity,
      totalInventory: product.totalInventory,
      onlineStoreUrl: product.onlineStoreUrl,
      imageUrl: product.featuredImage?.url || null,
      hasDescription,
      imageCount,
      productId: product.id,
      variantId: variant.id,
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
