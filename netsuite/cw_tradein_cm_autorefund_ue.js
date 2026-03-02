/**
 * CW Trade-In — Auto-Refund User Event Script
 *
 * Automatically creates a Customer Refund when a Credit Memo is saved
 * with "Trade-In Credit" in the memo field. Runs independently of the
 * trade-in app, so even if the RESTlet's inline refund attempt fails,
 * this script catches it on the NetSuite side.
 *
 * Deploy steps:
 *   1. Upload this file: Documents > Files > SuiteScripts
 *   2. Create Script: Customization > Scripting > Scripts > New
 *        Script Type : User Event
 *        Script File : this file
 *        Applies To  : Credit Memo
 *        After Submit: afterSubmit
 *   3. Deploy: Status = Released, Event Type = Create
 *        (only fire on Create — not Edit — to avoid duplicate refunds)
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/search', 'N/log', 'N/runtime'], (record, search, log, runtime) => {

  /**
   * afterSubmit — fires after a Credit Memo is created.
   * Checks if the CM was created by the Trade-In app (memo contains
   * "Trade-In Credit"), then creates a Customer Refund from it.
   */
  function afterSubmit(context) {
    // Only run on Create (not Edit/Delete) to prevent duplicate refunds
    if (context.type !== context.UserEventType.CREATE) return;

    const cmRec = context.newRecord;
    const cmId = cmRec.id;

    try {
      // Load the full CM record to read fields
      const cm = record.load({ type: record.Type.CREDIT_MEMO, id: cmId });
      const memo = cm.getValue({ fieldId: 'memo' }) || '';
      const tranId = cm.getValue({ fieldId: 'tranid' }) || '';
      const entity = cm.getValue({ fieldId: 'entity' });
      const total = parseFloat(cm.getValue({ fieldId: 'total' })) || 0;

      // Only process Trade-In Credit Memos
      if (memo.indexOf('Trade-In Credit') === -1) {
        log.debug('Auto-Refund Skip', 'CM ' + cmId + ' (' + tranId + ') is not a trade-in CM — memo: ' + memo);
        return;
      }

      // Skip zero-value CMs
      if (total <= 0) {
        log.debug('Auto-Refund Skip', 'CM ' + cmId + ' has zero total');
        return;
      }

      log.audit('Auto-Refund Start', 'CM ' + cmId + ' (' + tranId + ') total=' + total + ' entity=' + entity);

      // Check if a Customer Refund already exists for this CM
      // (in case the RESTlet's inline refund succeeded)
      const existingRefund = checkExistingRefund(cmId);
      if (existingRefund) {
        log.audit('Auto-Refund Skip', 'Refund already exists for CM ' + cmId + ': ' + existingRefund);
        return;
      }

      // Transform CM → Customer Refund
      const refund = record.transform({
        fromType: record.Type.CREDIT_MEMO,
        fromId: cmId,
        toType: record.Type.CUSTOMER_REFUND,
        isDynamic: true,
      });

      // Set payment method — try several common IDs
      var pmSet = false;
      var pmTry = [17, 1, 5, 3, 2, 4];
      for (var p = 0; p < pmTry.length; p++) {
        try {
          refund.setValue({ fieldId: 'paymentmethod', value: pmTry[p] });
          pmSet = true;
          break;
        } catch (e) { /* try next */ }
      }

      // Set memo
      try {
        refund.setValue({ fieldId: 'memo', value: 'Auto-Refund for Trade-In CM# ' + tranId });
      } catch (e) { /* skip */ }

      // Set location from CM
      try {
        var cmLoc = cm.getValue({ fieldId: 'location' });
        if (cmLoc) refund.setValue({ fieldId: 'location', value: cmLoc });
      } catch (e) { /* skip */ }

      // Verify apply lines — the CM should be pre-applied from the transform
      var applyCount = refund.getLineCount({ sublistId: 'apply' });
      log.debug('Auto-Refund Apply', 'Lines: ' + applyCount);

      if (applyCount === 0) {
        log.error('Auto-Refund Failed', 'No apply lines for CM ' + cmId + ' — CM may not be in refundable state');
        return;
      }

      // Make sure the CM line is checked
      for (var i = 0; i < applyCount; i++) {
        refund.selectLine({ sublistId: 'apply', line: i });
        var lineId = refund.getCurrentSublistValue({ sublistId: 'apply', fieldId: 'internalid' });
        var isApplied = refund.getCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply' });
        if (String(lineId) === String(cmId) || applyCount === 1) {
          if (!isApplied) {
            refund.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: true });
            refund.commitLine({ sublistId: 'apply' });
          }
        }
      }

      var refundId = refund.save({ enableSourcing: true, ignoreMandatoryFields: true });
      var savedRefund = record.load({ type: record.Type.CUSTOMER_REFUND, id: refundId });
      var refundTranId = savedRefund.getValue({ fieldId: 'tranid' });

      log.audit('Auto-Refund Created', 'Refund ' + refundId + ' (' + refundTranId + ') for CM ' + cmId + ' (' + tranId + ')');

    } catch (e) {
      log.error('Auto-Refund Error', 'CM ' + cmId + ': ' + e.message + '\n' + (e.stack || ''));
    }
  }

  /**
   * Check if a Customer Refund already exists that applies this CM.
   * Returns the refund tranid if found, null otherwise.
   */
  function checkExistingRefund(cmId) {
    try {
      var results = search.create({
        type: search.Type.CUSTOMER_REFUND,
        filters: [
          ['appliedtotransaction', 'anyof', cmId],
        ],
        columns: ['tranid'],
      }).run().getRange({ start: 0, end: 1 });

      if (results.length > 0) {
        return results[0].getValue({ name: 'tranid' });
      }
    } catch (e) {
      log.debug('checkExistingRefund', 'Search failed: ' + e.message);
      // If the search fails (filter not supported), check via memo match
      try {
        var results2 = search.create({
          type: search.Type.CUSTOMER_REFUND,
          filters: [
            ['memo', 'contains', 'CM ' + cmId],
          ],
          columns: ['tranid'],
        }).run().getRange({ start: 0, end: 1 });
        if (results2.length > 0) return results2[0].getValue({ name: 'tranid' });
      } catch (e2) { /* give up */ }
    }
    return null;
  }

  return { afterSubmit: afterSubmit };
});
