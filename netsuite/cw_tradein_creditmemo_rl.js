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

  // NetSuite internal IDs for each store location (set these after confirming in NS)
  const STORE_LOCATIONS = {
    'Leica SF':        null,  // TODO: set NS location internal ID
    'San Francisco':   null,  // TODO: set NS location internal ID
    'SoHo — New York': null,  // TODO: set NS location internal ID
    'Palm Springs':    null,  // TODO: set NS location internal ID
  };

  /**
   * POST — Create a Credit Memo from trade-in session data.
   *
   * Body: {
   *   customerEmail, customerFirst, customerLast, customerPhone,
   *   items: [{ name, grade, serial, net, tradein, priceType }],
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
      // ── Find or create customer ──
      const custId = findOrCreateCustomer(body);

      // ── Create Credit Memo ──
      const cm = record.create({ type: record.Type.CREDIT_MEMO, isDynamic: true });
      cm.setValue({ fieldId: 'entity', value: custId });

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
        // Customer ships items in — set their address as ship-to
        const addr = body.shippingAddress;
        cm.setValue({ fieldId: 'shipaddress', value: [
          addr.str || '',
          [addr.city || '', addr.st || '', addr.zip || ''].filter(Boolean).join(', '),
        ].filter(Boolean).join('\n') });
      } else {
        // In-store — set shipping method to "In-Store Sale"
        try {
          cm.setValue({ fieldId: 'shipmethod', value: IN_STORE_SHIP_METHOD });
        } catch (e) {
          log.debug('shipmethod', 'Could not set ship method: ' + e.message);
        }

        // Set ship-to location if we have an internal ID for this store
        const nsLocId = STORE_LOCATIONS[loc];
        if (nsLocId) {
          try {
            cm.setValue({ fieldId: 'location', value: nsLocId });
          } catch (e) {
            log.debug('location', 'Could not set location: ' + e.message);
          }
        }
      }

      // ── Add line items ──
      const items = body.items || [];
      items.forEach((it, idx) => {
        cm.selectNewLine({ sublistId: 'item' });
        cm.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: EXCHANGE_ITEM_ID });

        const desc = [
          it.name || 'Item ' + (idx + 1),
          it.grade  ? '[' + it.grade + ']' : '',
          it.serial ? 'S/N: ' + it.serial  : '',
        ].filter(Boolean).join(' ');

        cm.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: desc });
        cm.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity',    value: 1 });
        cm.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate',        value: it.net || 0 });

        cm.commitLine({ sublistId: 'item' });
      });

      const cmId = cm.save({ enableSourcing: true, ignoreMandatoryFields: false });

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
   */
  function findOrCreateCustomer(body) {
    const email = (body.customerEmail || '').trim().toLowerCase();

    if (email) {
      // Search for all customers with this email, sorted by datecreated ASC (oldest first)
      const results = search.create({
        type: search.Type.CUSTOMER,
        filters: [['email', 'is', email]],
        columns: [
          search.createColumn({ name: 'internalid' }),
          search.createColumn({ name: 'datecreated', sort: search.Sort.ASC }),
        ],
      }).run().getRange({ start: 0, end: 10 });

      if (results.length > 0) {
        // First result = oldest match
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

    return cust.save({ enableSourcing: true, ignoreMandatoryFields: true });
  }

  return { post };
});
