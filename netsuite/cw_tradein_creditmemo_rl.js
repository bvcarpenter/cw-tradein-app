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
 *   4. Copy the External URL -> set as NS_RESTLET_URL in wrangler.jsonc
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

  /* -- Configuration -- */
  const EXCHANGE_ITEM_ID  = 21433;          // Non-Inventory Item for Sale "Exchange"
  const IN_STORE_SHIP_METHOD = 18525;       // Shipping method "In-Store Sale"
  const SHIPPING_SHIP_METHOD = 1590272;     // Shipping method for shipped orders (AvaTax-compatible)

  // Trade-In App location name -> NetSuite internal Location ID
  const STORE_LOCATIONS = {
    'Leica SF':        1,
    'San Francisco':   11,
    'SoHo \u2014 New York': 10,
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
   * POST -- Create a Credit Memo from trade-in session data.
   *
   * Body: {
   *   customerEmail, customerFirst, customerLast, customerPhone,
   *   items: [{ name, grade, serial, catalog, systemId, accessories, notes, net, tradein, priceType }],
   *   totalAmount, date, associate, issuedBy,
   *   location,                     // store key or "shipping"
   *   destStore,                    // destination store for shipping
   *   shippingAddress: { str, city, st, zip },  // only when location === "shipping"
   * }
   *
   * Returns: { success, tranId, internalId, grandTotal, subtotal, taxtotal }
   */
  function post(body) {
    log.audit('CW Trade-In CM', JSON.stringify(body));

    try {
      // -- Look up AVATAX tax item (needed for customer + credit memo) --
      const taxItemId = findAvataxId();
      log.debug('Tax item', taxItemId ? 'AVATAX id=' + taxItemId : 'not found');

      // -- Find or create customer --
      const custId = findOrCreateCustomer(body, taxItemId);

      // -- Create Credit Memo (standard mode -- avoids commitLine tax validation) --
      const cm = record.create({ type: record.Type.CREDIT_MEMO, isDynamic: false });
      cm.setValue({ fieldId: 'entity', value: custId });

      // -- Tax settings on CM body (required by AVATAX) --
      if (taxItemId) {
        try { cm.setValue({ fieldId: 'istaxable', value: true }); } catch (e) { log.debug('cm istaxable', e.message); }
        try { cm.setValue({ fieldId: 'taxitem',   value: taxItemId }); } catch (e) { log.debug('cm taxitem', e.message); }
      }

      if (body.date) {
        cm.setValue({ fieldId: 'trandate', value: new Date(body.date + 'T00:00:00') });
      }

      const memoLines = [
        'Trade-In Credit -- Camera West',
        body.associate ? 'Associate: ' + body.associate : '',
        body.issuedBy  ? 'Issued by: '  + body.issuedBy  : '',
      ].filter(Boolean).join(' | ');
      cm.setValue({ fieldId: 'memo', value: memoLines });

      // -- Location & shipping (pre-save: only simple body fields) --
      const loc = body.location || '';
      var isShipping = (loc === 'shipping' && body.shippingAddress);

      if (isShipping) {
        // Ship method and zero cost (body-level fields work fine pre-save)
        try { cm.setValue({ fieldId: 'shipmethod', value: SHIPPING_SHIP_METHOD }); }
        catch (e) { log.debug('shipmethod', e.message); }
        try { cm.setValue({ fieldId: 'shippingcost', value: 0 }); }
        catch (e) { log.debug('shippingcost', e.message); }

        var destLocId = STORE_LOCATIONS[body.destStore];
        if (destLocId) {
          try { cm.setValue({ fieldId: 'location', value: destLocId }); }
          catch (e) { log.debug('location', e.message); }
        }
      } else {
        try { cm.setValue({ fieldId: 'shipmethod', value: IN_STORE_SHIP_METHOD }); }
        catch (e) { log.debug('shipmethod', e.message); }

        var nsLocId = STORE_LOCATIONS[loc];
        if (nsLocId) {
          try { cm.setValue({ fieldId: 'location', value: nsLocId }); }
          catch (e) { log.debug('location', e.message); }
        }
      }

      // -- Add line items --
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

        if (taxItemId) {
          try { cm.setSublistValue({ sublistId: 'item', fieldId: 'taxcode', line: idx, value: taxItemId }); }
          catch (e) { log.debug('line taxcode ' + idx, e.message); }
        }
      });

      // Auto-approve so the UE auto-refund script can process it
      try { cm.setValue({ fieldId: 'approvalstatus', value: 2 }); }
      catch (e) { log.debug('approvalstatus', e.message); }

      const cmId = cm.save({ enableSourcing: true, ignoreMandatoryFields: true });
      log.audit('CM saved (first pass)', 'ID=' + cmId);

      // ================================================================
      // POST-SAVE: Reload in dynamic mode to fix the shipping address.
      // In standard mode, enableSourcing re-populates the address from
      // the customer record on save, overriding our subrecord values.
      // Loading in dynamic mode and setting the address AFTER save avoids this.
      // ================================================================
      if (isShipping) {
        try {
          var cmEdit = record.load({ type: record.Type.CREDIT_MEMO, id: cmId, isDynamic: true });
          var addr = body.shippingAddress;
          var custName = [(body.customerFirst || ''), (body.customerLast || '')].filter(Boolean).join(' ') || 'Customer';

          // Set shipoverride first so NetSuite unlocks the address subrecord
          try { cmEdit.setValue({ fieldId: 'shipoverride', value: true }); } catch(e) { log.debug('shipoverride', e.message); }

          var shipAddr = cmEdit.getSubrecord({ fieldId: 'shippingaddress' });
          shipAddr.setValue({ fieldId: 'country',   value: 'US' });
          shipAddr.setValue({ fieldId: 'addressee', value: custName });
          shipAddr.setValue({ fieldId: 'attention', value: custName });
          shipAddr.setValue({ fieldId: 'addr1',     value: addr.str  || '' });
          shipAddr.setValue({ fieldId: 'addr2',     value: '' });
          shipAddr.setValue({ fieldId: 'city',      value: addr.city || '' });
          shipAddr.setValue({ fieldId: 'state',     value: addr.st   || '' });
          shipAddr.setValue({ fieldId: 'zip',       value: addr.zip  || '' });
          try { shipAddr.setValue({ fieldId: 'override', value: true }); } catch(e) {}

          // Re-zero shipping cost (may have been recalculated on load)
          try { cmEdit.setValue({ fieldId: 'shippingcost', value: 0 }); } catch(e) {}

          cmEdit.save({ enableSourcing: false, ignoreMandatoryFields: true });
          log.audit('CM shipping address updated', custName + ' | ' + (addr.str || '') + ', ' + (addr.city || '') + ', ' + (addr.st || '') + ' ' + (addr.zip || ''));
        } catch (addrErr) {
          log.error('Post-save address update failed', addrErr.message + '\n' + (addrErr.stack || ''));
        }
      }

      // Reload to get final tranId, totals (after address/tax recalc)
      var saved = record.load({ type: record.Type.CREDIT_MEMO, id: cmId });
      const tranId   = saved.getValue({ fieldId: 'tranid' });
      const subtotal = parseFloat(saved.getValue({ fieldId: 'subtotal' })) || 0;
      var   taxtotal = 0;
      try { taxtotal = parseFloat(saved.getValue({ fieldId: 'taxtotal' })) || 0; }
      catch (e) {
        try { taxtotal = parseFloat(saved.getValue({ fieldId: 'tax' })) || 0; }
        catch (e2) { log.debug('taxtotal', e2.message); }
      }
      var rawTotal = parseFloat(saved.getValue({ fieldId: 'total' })) || 0;
      var grandTotal = rawTotal;
      if ((!rawTotal || rawTotal === subtotal) && taxtotal > 0) {
        grandTotal = subtotal + taxtotal;
      }

      // Approve if still pending
      var cmStatus = saved.getValue({ fieldId: 'approvalstatus' });
      if (cmStatus && String(cmStatus) !== '2') {
        try {
          record.submitFields({
            type: record.Type.CREDIT_MEMO, id: cmId,
            values: { approvalstatus: 2 },
            options: { enableSourcing: false, ignoreMandatoryFields: true }
          });
        } catch (e) { log.error('CM Approval Failed', e.message); }
      }

      log.audit('CW Trade-In CM Created',
        'ID: ' + cmId + ' TranID: ' + tranId +
        ' Subtotal: ' + subtotal + ' Tax: ' + taxtotal +
        ' RawTotal: ' + rawTotal + ' GrandTotal: ' + grandTotal);

      return {
        success: true, tranId: tranId, internalId: cmId,
        grandTotal: grandTotal, subtotal: subtotal, taxtotal: taxtotal
      };

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

    // No match -- create new customer
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
