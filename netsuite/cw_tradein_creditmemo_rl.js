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
  const SHIPPING_SHIP_METHOD = 1590272;     // Shipping method for shipped orders (AvaTax-compatible)

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
   *   shippingAddress: { str, city, st, zip },  // only when location === "shipping"
   *   createRefund                  // boolean — also create a Customer Refund
   * }
   *
   * Returns: { success, tranId, internalId, grandTotal, refundTranId, refundInternalId }
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

        // Set shipping method for shipped orders (required for AvaTax to calculate tax correctly)
        try {
          cm.setValue({ fieldId: 'shipmethod', value: SHIPPING_SHIP_METHOD });
        } catch (e) {
          log.debug('shipmethod shipping', 'Could not set shipping method: ' + e.message);
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

      // Auto-approve the Credit Memo so it can be refunded immediately
      // approvalstatus: 1 = Pending Approval, 2 = Approved
      try { cm.setValue({ fieldId: 'approvalstatus', value: 2 }); }
      catch (e) { log.debug('approvalstatus pre-save', e.message); }
      try { cm.setValue({ fieldId: 'status', value: 'open' }); }
      catch (e) { log.debug('status pre-save', e.message); }

      const cmId = cm.save({ enableSourcing: true, ignoreMandatoryFields: true });

      // Load back to get the auto-generated tranId and grand total (includes tax)
      var saved = record.load({ type: record.Type.CREDIT_MEMO, id: cmId });
      const tranId     = saved.getValue({ fieldId: 'tranid' });
      const subtotal   = parseFloat(saved.getValue({ fieldId: 'subtotal' })) || 0;
      var   taxtotal   = 0;
      try { taxtotal = parseFloat(saved.getValue({ fieldId: 'taxtotal' })) || 0; }
      catch (e) {
        try { taxtotal = parseFloat(saved.getValue({ fieldId: 'tax' })) || 0; }
        catch (e2) { log.debug('taxtotal', 'Could not read tax fields: ' + e2.message); }
      }
      var rawTotal = parseFloat(saved.getValue({ fieldId: 'total' })) || 0;
      // If rawTotal is missing or equals subtotal but tax exists, compute manually
      var grandTotal = rawTotal;
      if ((!rawTotal || rawTotal === subtotal) && taxtotal > 0) {
        grandTotal = subtotal + taxtotal;
      }

      // Check if the CM is approved — if not, approve it now
      var cmStatus = saved.getValue({ fieldId: 'approvalstatus' });
      log.audit('CM Status after save', 'approvalstatus=' + cmStatus + ' (1=Pending, 2=Approved)');
      if (cmStatus && String(cmStatus) !== '2') {
        try {
          log.audit('Approving CM', 'Setting approvalstatus=2 on CM ' + cmId);
          record.submitFields({
            type: record.Type.CREDIT_MEMO,
            id: cmId,
            values: { approvalstatus: 2 },
            options: { enableSourcing: false, ignoreMandatoryFields: true }
          });
          // Reload to get updated status
          saved = record.load({ type: record.Type.CREDIT_MEMO, id: cmId });
          log.audit('CM Approved', 'New approvalstatus=' + saved.getValue({ fieldId: 'approvalstatus' }));
        } catch (appErr) {
          log.error('CM Approval Failed', appErr.message);
        }
      }

      log.audit('CW Trade-In CM Created',
        'ID: ' + cmId + ' TranID: ' + tranId +
        ' Subtotal: ' + subtotal + ' Tax: ' + taxtotal +
        ' RawTotal: ' + rawTotal + ' GrandTotal: ' + grandTotal);

      const result = {
        success: true, tranId: tranId, internalId: cmId,
        grandTotal: grandTotal, subtotal: subtotal, taxtotal: taxtotal
      };

      // ── Optionally create Customer Refund from the Credit Memo ──
      if (body.createRefund) {
        try {
          log.audit('Creating Refund', 'CM ' + cmId + ' (entity=' + custId + ') — approvalstatus=' + saved.getValue({ fieldId: 'approvalstatus' }));

          var refund;
          var transformOK = false;

          // Attempt 1: Transform CM → Customer Refund (preferred — auto-applies the CM)
          try {
            refund = record.transform({
              fromType: record.Type.CREDIT_MEMO,
              fromId: cmId,
              toType: record.Type.CUSTOMER_REFUND,
              isDynamic: true,
            });
            transformOK = true;
            log.audit('Refund Transform OK', 'Transformed CM ' + cmId);
          } catch (txErr) {
            log.error('Refund Transform Failed', txErr.message);
          }

          // Attempt 2: If transform failed, create from scratch
          if (!transformOK) {
            log.audit('Refund Fallback', 'Creating Customer Refund manually for entity=' + custId);
            refund = record.create({ type: record.Type.CUSTOMER_REFUND, isDynamic: true });
            refund.setValue({ fieldId: 'entity', value: custId });
          }

          // Set payment method — try several common IDs until one works
          var pmSet = false;
          var pmTry = [17, 1, 5, 3, 2, 4];
          for (var p = 0; p < pmTry.length; p++) {
            try {
              refund.setValue({ fieldId: 'paymentmethod', value: pmTry[p] });
              pmSet = true;
              log.debug('Payment method set', 'ID=' + pmTry[p]);
              break;
            } catch (pmErr) {
              log.debug('paymentmethod ' + pmTry[p] + ' failed', pmErr.message);
            }
          }

          // Set location and memo
          var cmLocation;
          try { cmLocation = saved.getValue({ fieldId: 'location' }); } catch (e) { /* skip */ }
          if (cmLocation) {
            try { refund.setValue({ fieldId: 'location', value: cmLocation }); }
            catch (e) { log.debug('refund location', e.message); }
          }
          try { refund.setValue({ fieldId: 'memo', value: 'Trade-In Refund for CM# ' + tranId }); }
          catch (e) { log.debug('refund memo', e.message); }

          // Check apply sublist — if transform succeeded, the CM should already be applied
          var applyCount = refund.getLineCount({ sublistId: 'apply' });
          log.audit('Refund apply lines', 'Count: ' + applyCount + ' transformOK=' + transformOK);

          if (applyCount > 0) {
            // Ensure our CM line is checked (apply=true)
            for (var i = 0; i < applyCount; i++) {
              refund.selectLine({ sublistId: 'apply', line: i });
              var refInternalId = refund.getCurrentSublistValue({ sublistId: 'apply', fieldId: 'internalid' });
              var isApplied = refund.getCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply' });
              log.debug('Apply line ' + i, 'internalid=' + refInternalId + ' apply=' + isApplied);

              // Apply if it matches our CM, or apply all
              if (String(refInternalId) === String(cmId) || applyCount === 1 || !transformOK) {
                if (!isApplied) {
                  refund.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: true });
                  refund.commitLine({ sublistId: 'apply' });
                  log.audit('Applied line ' + i, 'internalid=' + refInternalId);
                }
              }
            }

            var refundId = refund.save({ enableSourcing: true, ignoreMandatoryFields: true });
            var savedRefund = record.load({ type: record.Type.CUSTOMER_REFUND, id: refundId });
            result.refundTranId     = savedRefund.getValue({ fieldId: 'tranid' });
            result.refundInternalId = refundId;
            log.audit('Customer Refund Created', 'ID: ' + refundId + ' TranID: ' + result.refundTranId);
          } else {
            log.error('Refund has no apply lines', 'CM ' + cmId + ' — status=' + saved.getValue({ fieldId: 'approvalstatus' }) + ' status=' + saved.getValue({ fieldId: 'status' }));
            result.refundError = 'No credits available to apply — CM status: ' + saved.getValue({ fieldId: 'statusRef' });
          }
        } catch (refErr) {
          log.error('Customer Refund Error', refErr.message + '\n' + (refErr.stack || ''));
          result.refundError = refErr.message;
        }
      }

      return result;

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
