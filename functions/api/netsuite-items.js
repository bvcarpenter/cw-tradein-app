/**
 * POST /api/netsuite-items — Create Inventory Items in NetSuite.
 *
 * Body: {
 *   cmNum:    "CM22864",
 *   location: "Palm Springs" | "Leica SF" | "SoHo — New York" | "San Francisco",
 *   items: [{
 *     name, brand, serial, catalog, systemId, format, itemType,
 *     net, retail, grade
 *   }]
 * }
 *
 * Returns: { success, items: [{ itemId, internalId }] }
 */

import { netsuiteRequest } from './_netsuite.js';

// ── Location / Vendor name mapping ───────────────────────────
// App destination → NetSuite location name
const LOCATION_MAP = {
  'Palm Springs':     'Camera West RM',
  'Leica SF':         'Leica Store SF',
  'SoHo — New York':  'Camera West SoHo',
  'San Francisco':    'Camera West SF',
};

// ── Custom field internal IDs ────────────────────────────────
// Update these to match your NetSuite instance's internal IDs.
// Find them in: Customization > Lists, Records & Fields > Item Fields
const CF = {
  brand:                'custitem_brand',
  systemIdentifier:     'custitem_system_identifier',
  softVouch:            'custitem_soft_vouch',
  mainDepartment:       'custitem_main_department',
  subDepartment:        'custitem_sub_department',
  subletDepartment:     'custitem_sublet_department',
  cosmeticCondition:    'custitem_cosmetic_condition',
  cwWebsite:            'custitem_cw_website',
  pipe17Tags:           'custitem_pipe17_tags',
  amazonCategory:       'custitem_amazon_category',
  ebayItemCondition:    'custitem_ebay_item_condition',
  ebayPaymentPolicy:    'custitem_ebay_payment_policy',
  ebayReturnPolicy:     'custitem_ebay_return_policy',
  ebayShippingPolicy:   'custitem_ebay_shipping_policy',
  etailChannel2:        'custitem_etail_channel_2',
  shopifyStores:        'custitem_shopify_stores',
  shopifyVisibility:    'custitem_shopify_product_visibility',
  newUsed:              'custitem_new_used',
  vendorNameCode:       'custitem_vendor_name_code',
};

function isLeicaSystemId(systemId) {
  return /^LS/i.test(systemId || '');
}

function isWatch(itemType) {
  return /watch/i.test(itemType || '');
}

function buildItemRecord(item, idx, cmNum, locationName) {
  const itemNum = `${cmNum}-${String(idx + 1).padStart(3, '0')}`;
  const displayName = item.serial
    ? `${item.name} / ${item.serial}`
    : item.name;

  const pipe17Tag = isLeicaSystemId(item.systemId) ? 'LSSF'
    : isWatch(item.itemType) ? 'CWWS'
    : '';

  const record = {
    itemId: itemNum,
    displayName: displayName,
    mpn: item.catalog || '',
    purchasePrice: item.net || 0,
    basePrice: item.retail || 0,
    onlinePrice: item.retail || 0,
    taxSchedule: { name: 'Taxable' },
    location: { name: locationName },
    preferredLocation: { name: locationName },

    // Custom fields — mapped values
    [CF.brand]:             item.brand || '',
    [CF.systemIdentifier]:  item.systemId || '',
    [CF.softVouch]:         true,
    [CF.mainDepartment]:    'Medium',
    [CF.subDepartment]:     item.format || '',
    [CF.subletDepartment]:  item.itemType || '',
    [CF.vendorNameCode]:    item.serial || '',

    // Custom fields — defaults
    [CF.cosmeticCondition]: 'Used',
    [CF.cwWebsite]:         true,
    [CF.amazonCategory]:    'Camera and Photo > ImagingAccessory [Deprecated]',
    [CF.ebayItemCondition]: 'Used',
    [CF.ebayPaymentPolicy]: 'PayPal:Immediate pay',
    [CF.ebayReturnPolicy]:  'Standard Return',
    [CF.ebayShippingPolicy]:'Standard Fedex Shipping',
    [CF.etailChannel2]:     'Shopify',
    [CF.shopifyStores]:     'Camera West',
    [CF.shopifyVisibility]: 'Point of sale',
    [CF.newUsed]:           'Used',
  };

  if (pipe17Tag) {
    record[CF.pipe17Tags] = pipe17Tag;
  }

  return record;
}

const cors = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  if (!body.cmNum) {
    return Response.json({ error: 'cmNum is required' }, { status: 400, headers: cors });
  }
  if (!body.items?.length) {
    return Response.json({ error: 'At least one item is required' }, { status: 400, headers: cors });
  }

  const locationName = LOCATION_MAP[body.location] || body.location || 'Camera West SF';
  const accountId = env.NS_ACCOUNT_ID;
  const apiUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/inventoryItem`;

  const results = [];
  const errors = [];

  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    const record = buildItemRecord(item, i, body.cmNum, locationName);

    try {
      const data = await netsuiteRequest(env, 'POST', apiUrl, record);
      results.push({
        itemId: record.itemId,
        internalId: data.id || data.internalId,
        success: true,
      });
    } catch (err) {
      console.error(`NS item ${record.itemId} failed:`, err.message);
      errors.push({
        itemId: record.itemId,
        itemName: item.name,
        error: err.message,
      });
    }
  }

  if (errors.length && !results.length) {
    return Response.json(
      { error: `All ${errors.length} item(s) failed`, errors },
      { status: 422, headers: cors }
    );
  }

  return Response.json({
    success: true,
    created: results.length,
    failed: errors.length,
    items: results,
    errors: errors.length ? errors : undefined,
  }, { headers: cors });
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

export { buildItemRecord, LOCATION_MAP, CF, isLeicaSystemId, isWatch };
