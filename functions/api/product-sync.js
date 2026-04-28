/**
 * POST /api/product-sync — Sync processing data to Shopify & NetSuite.
 *
 * Called per-item from the processing panel after certification.
 * Updates product title, description, metafields, tags, and images in Shopify,
 * and displayName, custitem2, vendorname in NetSuite.
 *
 * Body: {
 *   sku, itemName, description, grade, serial,
 *   cosmeticNotes, mechOpticalNotes, generalNotes,
 *   comesWith: string[],
 *   testedBy: string,
 *   images: [{ dataUrl, name }]
 * }
 */

import { shopifyGQL, getShopifyToken } from './_shopify.js';
import { netsuiteRequest } from './_netsuite.js';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function toRichText(plain) {
  const lines = (plain || '').split('\n').filter(l => l.trim());
  const children = lines.map(line => ({
    type: 'paragraph',
    children: [{ type: 'text', value: line }],
  }));
  return JSON.stringify({ type: 'root', children });
}

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

  const { sku } = body;
  if (!sku) {
    return Response.json({ error: 'sku is required' }, { status: 400, headers: CORS });
  }

  const result = { sku, shopify: { success: false }, netsuite: { success: false } };

  // ── Shopify sync ─────────────────────────────────────────
  try {
    const productId = await lookupShopifyProduct(env, sku);
    if (!productId) {
      result.shopify.error = 'Product not found in Shopify';
    } else {
      result.shopify.productId = productId;

      await updateShopifyProduct(env, productId, body);
      await setShopifyMetafields(env, productId, body);

      if (body.images?.length) {
        await syncShopifyImages(env, productId, sku, body.images);
      }

      result.shopify.success = true;
    }
  } catch (err) {
    console.error('Shopify sync error:', err);
    result.shopify.error = err.message;
  }

  // ── NetSuite sync ────────────────────────────────────────
  try {
    const nsId = await lookupNetSuiteItem(env, sku);
    if (!nsId) {
      result.netsuite.error = 'Item not found in NetSuite';
    } else {
      result.netsuite.internalId = nsId;
      await updateNetSuiteItem(env, nsId, body);
      result.netsuite.success = true;
    }
  } catch (err) {
    console.error('NetSuite sync error:', err);
    result.netsuite.error = err.message;
  }

  const status = result.shopify.success || result.netsuite.success ? 200 : 422;
  return Response.json(result, { status, headers: CORS });
}

// ── Shopify helpers ──────────────────────────────────────────

async function lookupShopifyProduct(env, sku) {
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

async function updateShopifyProduct(env, productId, item) {
  // Get existing tags to preserve them
  const tagQuery = `query($id: ID!) { product(id: $id) { tags } }`;
  const tagData = await shopifyGQL(env, tagQuery, { id: productId });
  const existingTags = tagData?.product?.tags || [];
  const tags = [...new Set([...existingTags, 'Pre-Drop'])];

  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id title }
        userErrors { field message }
      }
    }
  `;
  const input = {
    id: productId,
    title: item.itemName || undefined,
    descriptionHtml: item.description || undefined,
    tags,
  };
  const data = await shopifyGQL(env, mutation, { input });
  const errors = data?.productUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error('Shopify productUpdate: ' + errors.map(e => e.message).join(', '));
  }
}

async function setShopifyMetafields(env, productId, item) {
  const metafields = [
    { key: 'pre_owned_grade', value: item.grade || '', type: 'single_line_text_field' },
    { key: 'used_serial', value: item.serial || '', type: 'single_line_text_field' },
    { key: 'used_cosmetic_condition_notes', value: item.cosmeticNotes || '', type: 'rich_text_field' },
    { key: 'used_mechanical_notes', value: item.mechOpticalNotes || '', type: 'rich_text_field' },
    { key: 'used_general_notes', value: item.generalNotes || '', type: 'rich_text_field' },
    { key: 'used_tested_by', value: item.testedBy || '', type: 'single_line_text_field' },
  ];

  if (item.comesWith?.length) {
    metafields.push({
      key: 'what_s_included',
      value: item.comesWith.map(a => '• ' + a).join('\n'),
      type: 'rich_text_field',
    });
  }

  // Filter out empty values to avoid clearing existing data
  const toSet = metafields
    .filter(m => m.value)
    .map(m => ({
      ownerId: productId,
      namespace: 'custom',
      key: m.key,
      type: m.type,
      value: m.type === 'rich_text_field' ? toRichText(m.value) : m.value,
    }));

  if (!toSet.length) return;

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGQL(env, mutation, { metafields: toSet });
  const errors = data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error('Shopify metafieldsSet: ' + errors.map(e => e.message).join(', '));
  }
}

async function syncShopifyImages(env, productId, sku, images) {
  const token = await getShopifyToken(env);
  const store = env.SHOPIFY_STORE;

  // Get the numeric product ID from the GID
  const numericId = productId.replace('gid://shopify/Product/', '');

  // Delete existing images first to avoid duplicates on re-sync
  const existingRes = await fetch(
    `https://${store}/admin/api/2024-10/products/${numericId}/images.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  if (existingRes.ok) {
    const existingData = await existingRes.json();
    for (const img of existingData.images || []) {
      await fetch(
        `https://${store}/admin/api/2024-10/products/${numericId}/images/${img.id}.json`,
        { method: 'DELETE', headers: { 'X-Shopify-Access-Token': token } }
      );
    }
  }

  // Upload new images in order via REST API (accepts base64 attachment)
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const base64 = img.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const filename = img.name || `${sku}-${String(i + 1).padStart(3, '0')}.jpg`;

    const imgRes = await fetch(
      `https://${store}/admin/api/2024-10/products/${numericId}/images.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: {
            attachment: base64,
            filename,
            position: i + 1,
          },
        }),
      }
    );
    if (!imgRes.ok) {
      const errText = await imgRes.text();
      console.error(`Image upload ${i + 1} failed:`, errText);
    }
  }
}

// ── NetSuite helpers ─────────────────────────────────────────

async function lookupNetSuiteItem(env, sku) {
  const accountId = env.NS_ACCOUNT_ID;
  const sqlUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  const data = await netsuiteRequest(env, 'POST', sqlUrl, {
    q: `SELECT id FROM inventoryItem WHERE itemId = '${sku.replace(/'/g, "''")}'`,
  }, { 'Prefer': 'transient' });
  const items = data?.items || [];
  return items.length ? items[0].id : null;
}

async function updateNetSuiteItem(env, internalId, item) {
  const accountId = env.NS_ACCOUNT_ID;
  const url = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/inventoryItem/${internalId}`;

  const updates = {};
  if (item.itemName) updates.displayName = item.itemName;
  if (item.grade) updates.custitem2 = item.grade;
  if (item.serial) updates.vendorname = item.serial;

  if (!Object.keys(updates).length) return;

  await netsuiteRequest(env, 'PATCH', url, updates);
}
