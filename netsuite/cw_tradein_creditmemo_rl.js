/**
 * CW Trade-In — Credit Memo RESTlet
 *
 * Deploy steps:
 *   1. Upload this file: Documents > Files > SuiteScripts
 *   2. Create Script: Customization > Scripting > Scripts > New
 *        Script Type : RESTlet
 *        Script File : this file
 *        POST Function: post
 *   3. Deploy: Status = Released, Audience = All Roles (or TBA role)
 *   4. Copy the External URL → set as NS_RESTLET_URL in wrangler.jsonc
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

  /* ── Configuration ── */
  const EXCHANGE_ITEM_ID  = 21433;          // Non-Inventory Item for Sale "Exchange"
  const IN_STORE_SHIP_METHOD = 18525;       // Shipping method "In-Store Sale"

  // Trade-In App location name → NetSuite internal Location ID
  const STORE_LOCATIONS = {
    'Leica SF':        1,
    'San Francisco':   11,
    'SoHo — New York': 10,
    'Palm Springs':    3,
  };

  /**
   * Look up the AVATAX tax item/group so we can set it on customers and line items.
   * Searches tax groups first, then sales tax items. Returns internal ID or null.
   */
  function findAvataxId() {
    const types = ['taxgroup', 'salestaxitem'];
    for (const t of types) {
      try {
        const results = search.create({
          type: t,
          filters: [['name', 'contains', 'AVATAX']],
          columns: ['internalid'],
        }).run().getRange({ start: 0, end: 1 });
        if (results.length) {
          const id = results[0].getValue('internalid');
          log.debug('findAvataxId', 'Found ' + t + ' id=' + id);
          return id;
        }
      } catch (e) {
        log.debug('findAvataxId', t + ' search failed: ' + e.message);
      }
    }
    log.audit('findAvataxId', 'AVATAX tax item not found');
    return null;
  }

  /**
   * POST — Create a Credit Memo from trade-in session data.
   *
   * Body: {
   *   customerEmail, customerFirst, customerLast, customerPhone,
   *   items: [{ name, grade, serial, catalog, systemId, accessories, notes, net, tradein, priceType }],
   *   totalAmount, date, associate, issuedBy,
   *   location,                     // store key or "shipping"
   *   shippingAddress: { str, city, st, zip }  // only when location === "shipping"
   * }
   *
   * Returns: { success, tranId, internalId }
   */
  function post(body) {
    log.audit('CW Trade-In CM', JSON.stringify(body));

    try {
      // ── Look up AVATAX tax item (needed for customer + credit memo) ──
      const taxItemId = findAvataxId();
      log.debug('Tax item', taxItemId ? 'AVATAX id=' + taxItemId : 'not found — will skip tax fields');

      // ── Find or create customer ──
      const custId = findOrCreateCustomer(body, taxItemId);

      // ── Create Credit Memo (standard mode — avoids commitLine tax validation) ──
      const cm = record.create({ type: record.Type.CREDIT_MEMO, isDynamic: false });
      cm.setValue({ fieldId: 'entity', value: custId });

      // ── Tax settings on CM body (required by AVATAX) ──
      if (taxItemId) {
        try { cm.setValue({ fieldId: 'istaxable', value: true }); } catch (e) { log.debug('cm istaxable', e.message); }
        try { cm.setValue({ fieldId: 'taxitem',   value: taxItemId }); } catch (e) { log.debug('cm taxitem', e.message); }
      }

      if (body.date) {
        cm.setValue({ fieldId: 'trandate', value: new Date(body.date + 'T00:00:00') });
      }

      const memoLines = [
        'Trade-In Credit — Camera West',
        body.associate ? 'Associate: ' + body.associate : '',
        body.issuedBy  ? 'Issued by: '  + body.issuedBy  : '',
      ].filter(Boolean).join(' | ');
      cm.setValue({ fieldId: 'memo', value: memoLines });

      // ── Location & shipping ──
      const loc = body.location || '';

      if (loc === 'shipping' && body.shippingAddress) {
        const addr = body.shippingAddress;
        try {
          cm.setValue({ fieldId: 'shipaddress', value: [
            addr.str || '',
            [addr.city || '', addr.st || '', addr.zip || ''].filter(Boolean).join(', '),
          ].filter(Boolean).join('\n') });
        } catch (e) {
          log.debug('shipaddress', 'Could not set ship address: ' + e.message);
        }

        const destLocId = STORE_LOCATIONS[body.destStore];
        if (destLocId) {
          try {
            cm.setValue({ fieldId: 'location', value: destLocId });
          } catch (e) {
            log.debug('location', 'Could not set shipping dest location: ' + e.message);
          }
        }
      } else {
        try {
          cm.setValue({ fieldId: 'shipmethod', value: IN_STORE_SHIP_METHOD });
        } catch (e) {
          log.debug('shipmethod', 'Could not set ship method: ' + e.message);
        }

        const nsLocId = STORE_LOCATIONS[loc];
        if (nsLocId) {
          try {
            cm.setValue({ fieldId: 'location', value: nsLocId });
          } catch (e) {
            log.debug('location', 'Could not set location: ' + e.message);
          }
        }
      }

      // ── Add line items (standard mode — setSublistValue, no commitLine) ──
      const items = body.items || [];
      items.forEach((it, idx) => {
        cm.setSublistValue({ sublistId: 'item', fieldId: 'item', line: idx, value: EXCHANGE_ITEM_ID });

        const descParts = [
          it.name || 'Item ' + (idx + 1),
          it.grade  ? '[' + it.grade + ']' : '',
          it.serial ? 'S/N: ' + it.serial  : '',
          it.catalog ? 'Cat: ' + it.catalog : '',
          it.systemId ? 'System: ' + it.systemId : '',
          (it.accessories && it.accessories.length) ? 'Includes: ' + it.accessories.join(', ') : '',
          it.notes ? 'Notes: ' + it.notes : '',
        ].filter(Boolean).join(' | ');

        cm.setSublistValue({ sublistId: 'item', fieldId: 'description', line: idx, value: descParts });
        cm.setSublistValue({ sublistId: 'item', fieldId: 'quantity',    line: idx, value: 1 });
        cm.setSublistValue({ sublistId: 'item', fieldId: 'rate',        line: idx, value: it.net || 0 });

        // Set AVATAX tax code on each line (required by Avalara tax engine)
        if (taxItemId) {
          try { cm.setSublistValue({ sublistId: 'item', fieldId: 'taxcode', line: idx, value: taxItemId }); }
          catch (e) { log.debug('line taxcode ' + idx, e.message); }
        }
      });

      const cmId = cm.save({ enableSourcing: true, ignoreMandatoryFields: true });

      // Load back to get the auto-generated tranId (CM#)
      const saved = record.load({ type: record.Type.CREDIT_MEMO, id: cmId });
      const tranId = saved.getValue({ fieldId: 'tranid' });

      log.audit('CW Trade-In CM Created', 'ID: ' + cmId + ' TranID: ' + tranId);

      return { success: true, tranId: tranId, internalId: cmId };

    } catch (e) {
      log.error('CW Trade-In CM Error', e.message + '\n' + e.stack);
      return { success: false, error: e.message };
    }
  }

  /**
   * Find customer by email (oldest match), or create a new one.
   * Sets AVATAX tax item on new customers so credit memos pass tax validation.
   */
  function findOrCreateCustomer(body, taxItemId) {
    const email = (body.customerEmail || '').trim().toLowerCase();

    if (email) {
      const results = search.create({
        type: search.Type.CUSTOMER,
        filters: [['email', 'is', email]],
        columns: [
          search.createColumn({ name: 'internalid' }),
          search.createColumn({ name: 'datecreated', sort: search.Sort.ASC }),
        ],
      }).run().getRange({ start: 0, end: 10 });

      if (results.length > 0) {
        const custId = results[0].getValue('internalid');
        log.debug('Customer found', 'email=' + email + ' id=' + custId + ' (oldest of ' + results.length + ')');
        return custId;
      }
    }

    // No match — create new customer
    log.audit('Creating customer', email || 'no-email');
    const cust = record.create({ type: record.Type.CUSTOMER, isDynamic: true });
    const first = (body.customerFirst || '').trim();
    const last  = (body.customerLast  || '').trim();

    if (first || last) {
      cust.setValue({ fieldId: 'isperson', value: 'T' });
      if (first) cust.setValue({ fieldId: 'firstname', value: first });
      if (last)  cust.setValue({ fieldId: 'lastname',  value: last });
    } else {
      cust.setValue({ fieldId: 'companyname', value: 'Trade-In Customer' });
    }

    if (email) cust.setValue({ fieldId: 'email', value: email });
    if (body.customerPhone) cust.setValue({ fieldId: 'phone', value: body.customerPhone });

    // Set tax configuration so AVATAX can calculate on credit memos
    if (taxItemId) {
      try { cust.setValue({ fieldId: 'taxable',  value: 'T' }); } catch (e) { log.debug('cust taxable', e.message); }
      try { cust.setValue({ fieldId: 'taxitem',  value: taxItemId }); } catch (e) { log.debug('cust taxitem', e.message); }
    }

    return cust.save({ enableSourcing: true, ignoreMandatoryFields: true });
  }

  return { post };
});
