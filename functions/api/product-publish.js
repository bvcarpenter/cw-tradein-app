/**
 * POST /api/product-publish — Verify & publish products to online store.
 *
 * Called from the Verify panel after manager review.
 * Publishes product, removes "Pre-Drop" tag, adds "Drop" tag
 * and a location+date tag (e.g. "LS-04282026").
 *
 * Body: {
 *   items: [{ sku, location }],
 *   verifiedBy: string
 * }
 */

import { shopifyGQL } from './_shopify.js';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const LOC_PREFIX = {
  'Leica SF': 'LS',
  'San Francisco': 'ML',
  'SoHo — New York': 'SOHO',
  'Palm Springs': 'RM',
};

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS });
  }

  if (!body.items?.length) {
    return Response.json({ error: 'items array is required' }, { status: 400, headers: CORS });
  }

  // Look up the Online Store publication ID (cached for the request)
  let publicationId = null;
  try {
    publicationId = await getOnlineStorePublicationId(env);
  } catch (err) {
    console.error('Failed to get publication ID:', err);
  }

  const results = [];

  for (const item of body.items) {
    const result = { sku: item.sku, success: false };

    try {
      const productId = await lookupProduct(env, item.sku);
      if (!productId) {
        result.error = 'Product not found in Shopify';
        results.push(result);
        continue;
      }

      // Build date tag: PREFIX-MMDDYYYY
      const now = new Date();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const yyyy = now.getFullYear();
      const prefix = LOC_PREFIX[item.location] || 'CW';
      const locationTag = `${prefix}-${mm}${dd}${yyyy}`;

      // Update tags: remove Pre-Drop, add Drop + location tag
      await updateTags(env, productId, locationTag);

      // Set product status to ACTIVE
      await activateProduct(env, productId);

      // Publish to Online Store if we have the publication ID
      if (publicationId) {
        await publishToOnlineStore(env, productId, publicationId);
      }

      result.success = true;
      result.locationTag = locationTag;
    } catch (err) {
      console.error(`Publish error for ${item.sku}:`, err);
      result.error = err.message;
    }

    results.push(result);
  }

  const allOk = results.every(r => r.success);
  return Response.json({ results }, { status: allOk ? 200 : 207, headers: CORS });
}

async function lookupProduct(env, sku) {
  const query = `
    query productBySku($q: String!) {
      productVariants(first: 5, query: $q) {
        edges { node { sku product { id } } }
      }
    }
  `;
  const data = await shopifyGQL(env, query, { q: `sku:${sku}` });
  const match = (data?.productVariants?.edges || []).find(e => e.node.sku === sku);
  return match?.node?.product?.id || null;
}

async function updateTags(env, productId, locationTag) {
  // Get current tags
  const q = `query($id: ID!) { product(id: $id) { tags } }`;
  const data = await shopifyGQL(env, q, { id: productId });
  const current = data?.product?.tags || [];

  // Remove Pre-Drop, add Drop + location tag
  const updated = current.filter(t => t !== 'Pre-Drop');
  if (!updated.includes('Drop')) updated.push('Drop');
  if (!updated.includes(locationTag)) updated.push(locationTag);

  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id tags }
        userErrors { field message }
      }
    }
  `;
  const result = await shopifyGQL(env, mutation, {
    input: { id: productId, tags: updated },
  });
  const errors = result?.productUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error('Tag update failed: ' + errors.map(e => e.message).join(', '));
  }
}

async function activateProduct(env, productId) {
  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id status }
        userErrors { field message }
      }
    }
  `;
  const result = await shopifyGQL(env, mutation, {
    input: { id: productId, status: 'ACTIVE' },
  });
  const errors = result?.productUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error('Activate failed: ' + errors.map(e => e.message).join(', '));
  }
}

async function getOnlineStorePublicationId(env) {
  const query = `
    query {
      publications(first: 10) {
        edges { node { id name } }
      }
    }
  `;
  const data = await shopifyGQL(env, query, {});
  const pub = (data?.publications?.edges || []).find(e =>
    /online store/i.test(e.node.name)
  );
  return pub?.node?.id || null;
}

async function publishToOnlineStore(env, productId, publicationId) {
  const mutation = `
    mutation publishProduct($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { ... on Product { id } }
        userErrors { field message }
      }
    }
  `;
  const result = await shopifyGQL(env, mutation, {
    id: productId,
    input: [{ publicationId }],
  });
  const errors = result?.publishablePublish?.userErrors || [];
  if (errors.length) {
    console.error('publishablePublish errors:', errors);
  }
}
