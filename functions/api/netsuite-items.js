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

async function lookupClassId(env, name) {
  if (!name) return null;
  const accountId = env.NS_ACCOUNT_ID;
  const sqlUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  try {
    const data = await netsuiteRequest(env, 'POST', sqlUrl, {
      q: `SELECT id FROM classification WHERE name = '${name.replace(/'/g, "''")}'`,
    }, { 'Prefer': 'transient' });
    const id = data?.items?.[0]?.id;
    if (id) {
      console.log(`Classification "${name}" → id ${id}`);
      return { id: String(id) };
    }
    console.log(`Classification "${name}" not found`);
  } catch (e) {
    console.log('Classification lookup failed:', e.message);
  }
  return null;
}

async function lookupDepartmentId(env, name) {
  if (!name) return null;
  const accountId = env.NS_ACCOUNT_ID;
  const sqlUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  try {
    const data = await netsuiteRequest(env, 'POST', sqlUrl, {
      q: `SELECT id, name FROM department WHERE LOWER(name) = LOWER('${name.replace(/'/g, "''")}')`,
    }, { 'Prefer': 'transient' });
    const id = data?.items?.[0]?.id;
    if (id) {
      console.log(`Department "${name}" → id ${id} (matched: "${data.items[0].name}")`);
      return { id: String(id) };
    }
    console.log(`Department "${name}" not found`);
  } catch (e) {
    console.log('Department lookup failed:', e.message);
  }
  return null;
}

async function lookupSubDepartmentId(env, name) {
  if (!name) return null;
  const accountId = env.NS_ACCOUNT_ID;
  const sqlUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  try {
    const data = await netsuiteRequest(env, 'POST', sqlUrl, {
      q: `SELECT DISTINCT custitem_subdepartment AS id, BUILTIN.DF(custitem_subdepartment) AS name FROM inventoryItem WHERE custitem_subdepartment IS NOT NULL FETCH FIRST 200 ROWS ONLY`,
    }, { 'Prefer': 'transient' });
    const items = data?.items || [];
    if (items.length) {
      const match = items.find(v => v.name === name)
        || items.find(v => v.name?.toLowerCase() === name?.toLowerCase());
      if (match) {
        console.log(`SubDepartment "${name}" → id ${match.id} via BUILTIN.DF`);
        return { id: String(match.id) };
      }
      console.log(`SubDepartment "${name}" not found. Available: ${items.slice(0, 10).map(v => v.name).join(', ')}`);
    }
  } catch (e) {
    console.log('SubDepartment BUILTIN.DF lookup failed:', e.message);
  }
  return null;
}

async function lookupLocationId(env, locationName) {
  const accountId = env.NS_ACCOUNT_ID;
  const sqlUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  try {
    const data = await netsuiteRequest(env, 'POST', sqlUrl, {
      q: `SELECT id FROM location WHERE name = '${locationName.replace(/'/g, "''")}'`,
    }, { 'Prefer': 'transient' });
    const id = data?.items?.[0]?.id;
    if (id) return { id: String(id) };
  } catch (e) {
    console.log('Location lookup failed:', e.message);
  }
  return { name: locationName };
}

async function lookupTaxScheduleId(env, name) {
  const accountId = env.NS_ACCOUNT_ID;
  const sqlUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  try {
    const data = await netsuiteRequest(env, 'POST', sqlUrl, {
      q: `SELECT id FROM taxSchedule WHERE name = '${name.replace(/'/g, "''")}'`,
    }, { 'Prefer': 'transient' });
    const id = data?.items?.[0]?.id;
    if (id) return { id: String(id) };
  } catch (e) {
    console.log('Tax schedule lookup failed:', e.message);
  }
  return { name };
}

async function lookupCustomListValue(env, fieldId, valueName) {
  if (!valueName) return null;
  const accountId = env.NS_ACCOUNT_ID;
  const sqlUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

  // Query actual values from existing inventory items using BUILTIN.DF
  try {
    const data = await netsuiteRequest(env, 'POST', sqlUrl, {
      q: `SELECT DISTINCT ${fieldId} AS id, BUILTIN.DF(${fieldId}) AS name FROM inventoryItem WHERE ${fieldId} IS NOT NULL FETCH FIRST 200 ROWS ONLY`,
    }, { 'Prefer': 'transient' });
    const items = data?.items || [];
    if (items.length) {
      const match = items.find(v => v.name === valueName)
        || items.find(v => v.name?.toLowerCase() === valueName?.toLowerCase());
      if (match) {
        console.log(`${fieldId} resolved "${valueName}" → id ${match.id} via BUILTIN.DF`);
        return { id: String(match.id) };
      }
      console.log(`${fieldId}: ${items.length} values found but no match for "${valueName}". Sample: ${items.slice(0, 5).map(v => v.name).join(', ')}`);
    }
  } catch (e) {
    console.log(`${fieldId} BUILTIN.DF lookup failed:`, e.message);
  }

  console.log(`${fieldId} lookup failed for "${valueName}"`);
  return null;
}

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
  brand:                'class',
  systemIdentifier:     'custitem5',
  softVouch:            'custitem_soft_vouch',
  mainDepartment:       'custitem_maindepartment',
  subDepartment:        'custitem_subdepartment',
  subletDepartment:     'department',
  cosmeticCondition:    'custitem2',
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
  newUsed:              'custitem_item_condition',
  vendorNameCode:       'custitem_vendor_name_code',
};

const MAIN_DEPT = { 'Digital': '1', 'Film': '2', 'Sport Optics': '4', 'Watches': '5' };

const COSMETIC_GRADE = {
  '10-': '1', '9+': '2', '9': '3', '8+': '4', '8': '5',
  '7+': '6', '7': '7', '6+': '8',
};

function isLeicaSystemId(systemId) {
  return /^LS/i.test(systemId || '');
}

function isWatch(itemType) {
  return /watch/i.test(itemType || '');
}

function buildItemRecord(item, idx, cmNum, locationRef, refs) {
  const itemNum = `${cmNum}-${String(idx + 1).padStart(3, '0')}`;
  const displayName = item.serial
    ? `${item.name} ${item.serial}`
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
    taxSchedule: refs?.taxSchedule || { name: 'Taxable' },
    location: locationRef,
    preferredLocation: locationRef,

    // Custom fields — mapped values
    [CF.softVouch]:         true,
    [CF.mainDepartment]:    { id: '1' },
    [CF.vendorNameCode]:    item.serial || '',

    // Custom fields — defaults
    [CF.cwWebsite]:         true,
    [CF.amazonCategory]:    'Camera and Photo > ImagingAccessory [Deprecated]',
    [CF.ebayItemCondition]: 'Used',
    [CF.ebayPaymentPolicy]: 'PayPal:Immediate pay',
    [CF.ebayReturnPolicy]:  'Standard Return',
    [CF.ebayShippingPolicy]:'Standard Fedex Shipping',
    [CF.etailChannel2]:     'Shopify',
    [CF.shopifyStores]:     'Camera West',
    [CF.shopifyVisibility]: 'Point of sale',
  };

  record[CF.brand] = refs?.brand || '';
  record[CF.newUsed] = { id: '2' };

  // custitem5 (System ID) and custitem_subdepartment (Sub Department) skipped —
  // BUILTIN.DF lookup returns values but NetSuite rejects all formats tried.
  // These need manual investigation of the correct value format.
  if (refs?.department) record[CF.subletDepartment] = refs.department;

  const gradeId = COSMETIC_GRADE[item.grade];
  if (gradeId) record[CF.cosmeticCondition] = { id: gradeId };

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
  const locationRef = await lookupLocationId(env, locationName);
  const taxRef = await lookupTaxScheduleId(env, 'Taxable');

  const brandNames = [...new Set(body.items.map(it => it.brand).filter(Boolean))];
  const brandRefs = {};
  for (const bn of brandNames) {
    brandRefs[bn] = await lookupClassId(env, bn);
  }

  const itemTypeNames = [...new Set(body.items.map(it => it.itemType).filter(Boolean))];
  const deptRefs = {};
  for (const it of itemTypeNames) {
    deptRefs[it] = await lookupDepartmentId(env, it);
  }

  const results = [];
  const errors = [];

  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    const refs = {
      taxSchedule: taxRef,
      brand: brandRefs[item.brand] || null,
      department: deptRefs[item.itemType] || null,
    };
    console.log(`NS item[${i}]: brand="${item.brand}" type="${item.itemType}" format="${item.format}" grade="${item.grade}" → brand=${JSON.stringify(refs.brand)} dept=${JSON.stringify(refs.department)}`);
    const record = buildItemRecord(item, i, body.cmNum, locationRef, refs);

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

export { buildItemRecord, LOCATION_MAP, CF, isLeicaSystemId, isWatch, lookupLocationId, lookupTaxScheduleId, lookupCustomListValue, lookupClassId, lookupDepartmentId, lookupSubDepartmentId };
