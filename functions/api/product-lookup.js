/**
 * GET /api/product-lookup?sku=CWTI-260330-A7K2
 *
 * Looks up a product in Shopify by SKU (variant SKU field).
 * Returns product status info: whether it exists, is active, has inventory, etc.
 *
 * Used by the Processing module to check if an item is "ready" in Shopify.
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

  if (!sku) {
    return Response.json({ error: 'Missing ?sku= parameter' }, { status: 400 });
  }

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
                onlineStoreUrl
                featuredImage {
                  url
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

    // Find exact SKU match (Shopify search is fuzzy)
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

    return Response.json({
      found: true,
      sku,
      status: product.status, // ACTIVE, DRAFT, ARCHIVED
      title: product.title,
      variantTitle: variant.title,
      price: variant.price,
      inventoryQuantity: variant.inventoryQuantity,
      totalInventory: product.totalInventory,
      onlineStoreUrl: product.onlineStoreUrl,
      imageUrl: product.featuredImage?.url || null,
      productId: product.id,
      variantId: variant.id,
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
