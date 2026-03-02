/**
 * CW Trade-In — Credit Memo RESTlet
 *
 * Deploy: Customization > Scripting > Scripts > New
 *   Script Type : RESTlet
 *   Script File : this file
 *   POST Function: post
 *   Deploy → Status: Released, Audience: All Roles (or specific role)
 *
 * After deploying, copy the External URL and set it as NS_RESTLET_URL
 * in the trade-in app's wrangler.jsonc.
 *
 * Requires a Non-Inventory Item in NetSuite for trade-in line items.
 * Set the internal ID of that item as TRADE_IN_ITEM_ID below.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

  /**
   * ── CONFIGURE THIS ──
   * Internal ID of the Non-Inventory Item used for trade-in credit lines.
   * Create one at: Lists > Accounting > Items > New > Non-Inventory Item
   *   Name: "Trade-In Credit"
   *   Income Account: (your trade-in liability / store credit account)
   */
  const TRADE_IN_ITEM_ID = null; // e.g. 1234 — set this after creating the item

  /**
   * POST — Create a Credit Memo from trade-in session data.
   *
   * Body: {
   *   customerEmail, customerFirst, customerLast, customerPhone,
   *   items: [{ name, grade, serial, net, tradein, priceType }],
   *   totalAmount, date, associate, issuedBy
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

      // ── Add line items ──
      const items = body.items || [];
      items.forEach((it, idx) => {
        cm.selectNewLine({ sublistId: 'item' });

        if (TRADE_IN_ITEM_ID) {
          cm.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: TRADE_IN_ITEM_ID });
        }

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
   * Find customer by email, or create a new one.
   */
  function findOrCreateCustomer(body) {
    const email = (body.customerEmail || '').trim().toLowerCase();

    // Try to find by email
    if (email) {
      const results = search.create({
        type: search.Type.CUSTOMER,
        filters: [['email', 'is', email]],
        columns: ['internalid'],
      }).run().getRange({ start: 0, end: 1 });

      if (results.length > 0) {
        return results[0].getValue('internalid');
      }
    }

    // Create new customer
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
