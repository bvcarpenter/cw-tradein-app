/**
 * POST /api/netsuite-vouch — Full vouch workflow: Create Items → Create PO → Receive PO.
 *
 * Body: {
 *   cmNum, customerName, location,
 *   items: [{ name, brand, serial, catalog, systemId, format, itemType, net, retail, grade }],
 *   existingItemIds: [{ itemId, internalId }]   // optional — skip creation for these
 * }
 *
 * Returns: { success, steps, items, purchaseOrder, itemReceipt, errors }
 */

import { netsuiteRequest } from './_netsuite.js';
import { buildItemRecord, LOCATION_MAP, CF, lookupLocationId, lookupTaxScheduleId, lookupClassId, lookupCustomListValue, lookupDepartmentId, lookupSubDepartmentId } from './netsuite-items.js';

const cors = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
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
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { cmNum, customerName, location, items, existingItemIds } = body;
  if (!cmNum) return Response.json({ error: 'cmNum is required' }, { status: 400, headers: cors });
  if (!items?.length) return Response.json({ error: 'At least one item is required' }, { status: 400, headers: cors });

  const locationName = LOCATION_MAP[location] || location || 'Camera West SF';
  const accountId = env.NS_ACCOUNT_ID;
  const baseUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/record/v1`;
  const sqlUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

  const locationRef = await lookupLocationId(env, locationName);
  const taxRef = await lookupTaxScheduleId(env, 'Taxable');

  const brandNames = [...new Set(items.map(it => it.brand).filter(Boolean))];
  const brandRefs = {};
  for (const bn of brandNames) {
    brandRefs[bn] = await lookupClassId(env, bn);
  }

  const sysIdNames = [...new Set(items.map(it => it.systemId).filter(Boolean))];
  const sysIdRefs = {};
  for (const si of sysIdNames) {
    sysIdRefs[si] = await lookupCustomListValue(env, CF.systemIdentifier, si);
  }

  const itemTypeNames = [...new Set(items.map(it => it.itemType).filter(Boolean))];
  const deptRefs = {};
  for (const it of itemTypeNames) {
    deptRefs[it] = await lookupDepartmentId(env, it);
  }

  const formatNames = [...new Set(items.map(it => it.format).filter(Boolean))];
  const subDeptRefs = {};
  for (const fn of formatNames) {
    subDeptRefs[fn] = await lookupSubDepartmentId(env, fn);
  }

  console.log(`Vouch: location="${locationName}", brands=${JSON.stringify(brandRefs)}, sysIds=${JSON.stringify(sysIdRefs)}, depts=${JSON.stringify(deptRefs)}, subDepts=${JSON.stringify(subDeptRefs)}`);

  const result = {
    success: false,
    steps: { itemsCreated: false, poCreated: false, poReceived: false },
    items: [],
    purchaseOrder: null,
    itemReceipt: null,
    errors: [],
  };

  // Build lookup of already-created items by itemId
  const existingMap = {};
  if (existingItemIds?.length) {
    for (const ei of existingItemIds) {
      if (ei.itemId && ei.internalId) existingMap[ei.itemId] = ei.internalId;
    }
  }

  // ── Step 1: Create Inventory Items ─────────────────────────
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const refs = {
        taxSchedule: taxRef,
        brand: brandRefs[item.brand] || null,
        systemId: sysIdRefs[item.systemId] || null,
        department: deptRefs[item.itemType] || null,
        subDepartment: subDeptRefs[item.format] || null,
      };
      console.log(`Vouch item[${i}]: brand="${item.brand}" sysId="${item.systemId}" type="${item.itemType}" format="${item.format}" grade="${item.grade}" → refs: brand=${JSON.stringify(refs.brand)} sysId=${JSON.stringify(refs.systemId)} dept=${JSON.stringify(refs.department)}`);
      const record = buildItemRecord(item, i, cmNum, locationRef, refs);
      const expectedItemId = record.itemId;

      if (existingMap[expectedItemId]) {
        const existingId = existingMap[expectedItemId];
        const patch = {};
        if (record[CF.brand]) patch[CF.brand] = record[CF.brand];
        patch[CF.newUsed] = { id: '2' };
        if (record[CF.systemIdentifier]) patch[CF.systemIdentifier] = record[CF.systemIdentifier];
        if (record[CF.subletDepartment]) patch[CF.subletDepartment] = record[CF.subletDepartment];
        if (record[CF.subDepartment]) patch[CF.subDepartment] = record[CF.subDepartment];
        if (record[CF.cosmeticCondition]) patch[CF.cosmeticCondition] = record[CF.cosmeticCondition];
        patch[CF.mainDepartment] = { id: '1' };
        try {
          await netsuiteRequest(env, 'PATCH', `${baseUrl}/inventoryItem/${existingId}`, patch);
          console.log(`Patched existing item ${expectedItemId} (${existingId}) with Brand/NewUsed`);
        } catch (e) {
          console.error(`Patch of ${expectedItemId} FAILED:`, e.message, 'body:', JSON.stringify(patch));
          result.errors.push({ itemId: expectedItemId, error: 'Patch failed: ' + e.message });
        }
        result.items.push({ itemId: expectedItemId, internalId: existingId, success: true, skipped: true });
        continue;
      }

      try {
        const data = await netsuiteRequest(env, 'POST', `${baseUrl}/inventoryItem`, record);
        const internalId = data.id || data.internalId;
        result.items.push({ itemId: expectedItemId, internalId, success: true });
      } catch (err) {
        console.error(`Vouch item ${expectedItemId} failed:`, err.message);
        result.errors.push({ itemId: expectedItemId, error: err.message });
      }
    }

    const successItems = result.items.filter(i => i.success && i.internalId);
    if (!successItems.length) {
      return Response.json(
        { ...result, error: 'All item creations failed' },
        { status: 422, headers: cors }
      );
    }
    result.steps.itemsCreated = true;
  } catch (err) {
    console.error('Vouch step 1 error:', err);
    return Response.json(
      { ...result, error: 'Item creation failed: ' + err.message },
      { status: 422, headers: cors }
    );
  }

  // ── Step 2: Create Purchase Order ──────────────────────────
  const successItems = result.items.filter(i => i.success && i.internalId);
  // Map item internalIds to their net prices
  const itemPriceMap = {};
  for (let i = 0; i < items.length; i++) {
    const itemNum = `${cmNum}-${String(i + 1).padStart(3, '0')}`;
    itemPriceMap[itemNum] = items[i].net || 0;
  }

  try {
    // Look up vendor ID
    let vendorId = null;
    try {
      const vendorData = await netsuiteRequest(env, 'POST', sqlUrl, {
        q: `SELECT id FROM vendor WHERE entityid = '${locationName.replace(/'/g, "''")}'`,
      }, { 'Prefer': 'transient' });
      vendorId = vendorData?.items?.[0]?.id;

      if (!vendorId) {
        const vendorData2 = await netsuiteRequest(env, 'POST', sqlUrl, {
          q: `SELECT id FROM vendor WHERE companyname = '${locationName.replace(/'/g, "''")}'`,
        }, { 'Prefer': 'transient' });
        vendorId = vendorData2?.items?.[0]?.id;
      }
      console.log(`Vouch vendor lookup "${locationName}": id=${vendorId}`);
    } catch (e) {
      console.log('Vendor lookup failed, will try name reference:', e.message);
    }

    const poBody = {
      entity: vendorId ? { id: String(vendorId) } : { name: locationName },
      location: locationRef,
      memo: `${cmNum} ${customerName || ''}`.trim(),
      item: {
        items: successItems.map(si => ({
          item: { id: String(si.internalId) },
          quantity: 1,
          rate: itemPriceMap[si.itemId] || 0,
          location: locationRef,
        })),
      },
    };

    const poData = await netsuiteRequest(env, 'POST', `${baseUrl}/purchaseOrder`, poBody);
    const poId = poData.id || poData.internalId;
    result.purchaseOrder = { id: poId, tranId: poData.tranId || null };
    result.steps.poCreated = true;
    console.log(`Vouch PO created: id=${poId}, tranId=${poData.tranId}`);
  } catch (err) {
    console.error('Vouch PO creation failed:', err.message);
    result.error = 'PO creation failed: ' + err.message;
    return Response.json(result, { status: 422, headers: cors });
  }

  // ── Step 3: Receive PO (Transform → Item Receipt) ─────────
  try {
    const poId = result.purchaseOrder.id;
    const receiptBody = {
      memo: `${cmNum} ${customerName || ''}`.trim(),
    };

    const irData = await netsuiteRequest(
      env, 'POST',
      `${baseUrl}/purchaseOrder/${poId}/!transform/itemReceipt`,
      receiptBody
    );
    const irId = irData.id || irData.internalId;
    result.itemReceipt = { id: irId, tranId: irData.tranId || null };
    result.steps.poReceived = true;
    console.log(`Vouch IR created: id=${irId}, tranId=${irData.tranId}`);
  } catch (err) {
    console.error('Vouch PO receipt failed:', err.message);
    result.error = 'PO receipt failed: ' + err.message;
    return Response.json(result, { status: 422, headers: cors });
  }

  result.success = true;
  return Response.json(result, { headers: cors });
}
