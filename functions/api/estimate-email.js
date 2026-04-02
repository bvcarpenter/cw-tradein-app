/**
 * POST /api/estimate-email
 * Sends an estimate/credit-memo email to the customer with:
 *   1. Styled HTML body (matching the trade-in confirmation email look)
 *   2. PDF of the estimate attached
 *   3. FedEx shipping label PDF attached (if shipping required)
 *
 * Body: {
 *   customer: { first, last, email, phone },
 *   location, destStore, shippingAddress: { str, city, st, zip },
 *   tracking, cmNum, txnDate, assoc, issuedBy,
 *   tradeInId,       — trade-in session ID (e.g. "CWTI-260330-A7K2")
 *   items: [{ name, systemId, grade, serial, catalog, accessories, notes,
 *             tradein, net, priceType, svcCharge, svcReason }],
 *   totals: { netTotal, svcTotal, taxRate, estTax, estGrand, finalTotal },
 *   docLabel,
 *   pdfBase64,       — base64-encoded estimate PDF
 *   labelPdfBase64   — base64-encoded FedEx label PDF (optional)
 * }
 */

import { logTradeInEvent } from './_commslayer.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

/* ── helpers ─────────────────────────────────────────────────── */

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ff(v) {
  return '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ── build item row ──────────────────────────────────────────── */

function buildItemRow(item) {
  const ac = (item.accessories || []).length
    ? `<br/><span style="color:#777777;font-size:10px;">Includes: ${esc((item.accessories || []).join(', '))}</span>` : '';
  const nt = item.notes
    ? `<br/><span style="color:#999999;font-size:10px;font-style:italic;">${esc(item.notes)}</span>` : '';
  const sn = [item.serial ? `S/N: ${esc(item.serial)}` : '', item.catalog ? `Cat: ${esc(item.catalog)}` : ''].filter(Boolean).join(' &middot; ');
  const svcHtml = (item.svcCharge || 0) > 0
    ? `<br/><span style="font-size:9px;color:#cc4444;font-weight:400;">&#8722;${ff(item.svcCharge)} svc${item.svcReason ? ' (' + esc(item.svcReason) + ')' : ''}</span>` : '';

  return `<tr>
    <td style="padding:9px 7px;border-bottom:1px solid #e0ddd8;vertical-align:top;line-height:1.45;font-size:13px;color:#111111;">
      <strong style="font-weight:500;">${esc(item.name)}${item.serial ? ' ' + esc(item.serial) : ''}</strong>${ac}${nt}
      ${sn ? `<br/><span style="color:#aaaaaa;font-size:10px;">${sn}</span>` : ''}
    </td>
    <td style="padding:9px 7px;border-bottom:1px solid #e0ddd8;text-align:center;white-space:nowrap;vertical-align:top;font-size:12px;color:#444444;">${esc(item.systemId) || '&mdash;'}</td>
    <td style="padding:9px 7px;border-bottom:1px solid #e0ddd8;text-align:center;font-weight:500;vertical-align:top;font-size:12px;color:#111111;">${esc(item.grade)}</td>
    <td style="padding:9px 7px;border-bottom:1px solid #e0ddd8;text-align:right;color:#2a7a4a;vertical-align:top;font-size:12px;">${ff(item.tradein)}</td>
    <td style="padding:9px 7px;border-bottom:1px solid #e0ddd8;text-align:right;font-weight:500;vertical-align:top;font-size:12px;color:#111111;">${ff(item.net)}${svcHtml}</td>
  </tr>`;
}

/* ── build email HTML ────────────────────────────────────────── */

function buildEstimateEmailHtml({ customer, location, destStore, shippingAddress, tracking, tradeInId, cmNum, txnDate, assoc, issuedBy, items, totals, docLabel }) {
  const custName = [customer.first, customer.last].filter(Boolean).join(' ') || '—';
  const loc = location === 'shipping' ? 'Requires Shipping' : (location || '—');
  const shipTo = location === 'shipping' && shippingAddress
    ? [shippingAddress.str, shippingAddress.city, shippingAddress.st, shippingAddress.zip].filter(Boolean).join(', ') : '';
  const cm = cmNum || 'PENDING';
  const dt = txnDate || new Date().toISOString().split('T')[0];
  const itemCount = (items || []).length;
  const itemRows = (items || []).map(it => buildItemRow(it)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(docLabel || 'Estimate')} — Camera West</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f3f1;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f3f1;padding:40px 20px;">
<tr>
<td align="center">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e0ddd8;">
<!-- HEADER WITH LOGO -->
<tr>
<td style="background-color:#111111;padding:32px 48px;text-align:center;">
<img src="https://camerawest.com/cdn/shop/files/CW_Logo_2026_Whate.svg?v=1772114375" alt="Camera West" width="180" style="display:block;margin:0 auto 14px;max-width:180px;" />
<p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.3em;text-transform:uppercase;color:#888888;">
${esc(docLabel || 'Estimate')}
</p>
</td>
</tr>
<!-- THANK YOU -->
<tr>
<td style="padding:32px 48px;border-bottom:1px solid #e0ddd8;text-align:center;">
<p style="margin:0 0 8px;font-size:20px;font-weight:300;color:#111111;letter-spacing:0.04em;">
Thank you, ${esc(customer.first)}.
</p>
<p style="margin:0;font-size:13px;color:#666666;line-height:1.7;max-width:440px;margin-left:auto;margin-right:auto;">
Here is your ${cm !== 'PENDING' ? 'credit memo' : 'estimate'} from Camera West. ${cm === 'PENDING' ? 'Please note that all values are estimates pending final inspection. This estimate is valid for <strong style="color:#111111;font-weight:700;">5 days</strong> from the date of issue.' : 'Your credit memo has been finalized.'}
</p>
</td>
</tr>
<!-- DOCUMENT INFO -->
<tr>
<td style="padding:32px 48px;border-bottom:1px solid #e0ddd8;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="vertical-align:top;width:50%;">
<p style="margin:0 0 16px;font-size:9px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;color:#888888;padding-bottom:12px;border-bottom:1px solid #e0ddd8;">
Customer
</p>
<p style="margin:0 0 4px;font-size:14px;font-weight:500;color:#111111;">${esc(custName)}</p>
${customer.email ? `<p style="margin:0 0 2px;font-size:12px;color:#555555;"><a href="mailto:${esc(customer.email)}" style="color:#111111;text-decoration:underline;">${esc(customer.email)}</a></p>` : ''}
${customer.phone ? `<p style="margin:0;font-size:12px;color:#555555;">${esc(customer.phone)}</p>` : ''}
${loc !== '—' ? `<p style="margin:6px 0 0;font-size:11px;color:#777777;">Location: ${esc(loc)}</p>` : ''}
${shipTo ? `<p style="margin:2px 0 0;font-size:11px;color:#777777;">Ship From: ${esc(shipTo)}</p>` : ''}
${destStore ? `<p style="margin:2px 0 0;font-size:11px;color:#777777;">Ship To: ${esc(destStore)}</p>` : ''}
${tracking ? `<p style="margin:4px 0 0;font-size:11px;color:#d95e00;font-weight:500;">FedEx Tracking: ${esc(tracking)}</p>` : ''}
</td>
<td style="vertical-align:top;text-align:right;width:50%;">
<p style="margin:0 0 16px;font-size:9px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;color:#888888;padding-bottom:12px;border-bottom:1px solid #e0ddd8;">
${esc(docLabel || 'Estimate')}
</p>
<p style="margin:0 0 4px;font-size:20px;font-weight:300;color:#d95e00;font-family:Georgia,'Times New Roman',serif;">${esc(cm)}</p>
${tradeInId ? `<p style="margin:0 0 4px;font-size:11px;color:#d95e00;font-weight:500;letter-spacing:0.5px;">${esc(tradeInId)}</p>` : ''}
<p style="margin:0;font-size:11px;color:#666666;line-height:1.8;">${esc(dt)}<br/>Associate: ${esc(assoc || '—')}${issuedBy ? '<br/>Issued by: ' + esc(issuedBy) : ''}</p>
</td>
</tr>
</table>
</td>
</tr>
<!-- ITEMS TABLE -->
<tr>
<td style="padding:32px 48px;border-bottom:1px solid #e0ddd8;">
<p style="margin:0 0 16px;font-size:9px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;color:#888888;padding-bottom:12px;border-bottom:1px solid #e0ddd8;">
Items
</p>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
<thead><tr style="background:#111111;">
<th style="padding:8px 7px;text-align:left;font-size:8px;letter-spacing:.16em;text-transform:uppercase;font-weight:500;color:#f5f5f0;">Description</th>
<th style="padding:8px 7px;text-align:center;font-size:8px;letter-spacing:.16em;text-transform:uppercase;font-weight:500;color:#f5f5f0;">System</th>
<th style="padding:8px 7px;text-align:center;font-size:8px;letter-spacing:.16em;text-transform:uppercase;font-weight:500;color:#f5f5f0;">Grade</th>
<th style="padding:8px 7px;text-align:right;font-size:8px;letter-spacing:.16em;text-transform:uppercase;font-weight:500;color:#f5f5f0;">Trade-In</th>
<th style="padding:8px 7px;text-align:right;font-size:8px;letter-spacing:.16em;text-transform:uppercase;font-weight:500;color:#f5f5f0;">Net Price</th>
</tr></thead>
<tbody>${itemRows}</tbody>
<tfoot>
<tr style="background:#f8f7f5;">
<td colspan="3" style="padding:9px 7px;font-size:9px;color:#999999;">${itemCount} item${itemCount !== 1 ? 's' : ''}</td>
<td style="padding:9px 7px;text-align:right;font-size:11px;color:#2a7a4a;">${ff((items || []).reduce((s, i) => s + (i.tradein || 0), 0))}</td>
<td style="padding:9px 7px;text-align:right;font-size:15px;font-weight:300;color:#d95e00;font-family:Georgia,'Times New Roman',serif;">Net: ${ff(totals.netTotal)}</td>
</tr>
${totals.svcTotal > 0 ? `<tr style="background:#fff5f5;"><td colspan="4" style="padding:6px 7px;text-align:right;font-size:10px;color:#cc4444;">Total Service Charges</td><td style="padding:6px 7px;text-align:right;font-size:11px;color:#cc4444;">&#8722;${ff(totals.svcTotal)}</td></tr>` : ''}
${totals.taxRate > 0 ? `<tr style="background:#fafafa;"><td colspan="4" style="padding:6px 7px;text-align:right;font-size:10px;color:#777777;">Est. Tax (${(totals.taxRate * 100).toFixed(3).replace(/\.?0+$/, '')}%)</td><td style="padding:6px 7px;text-align:right;font-size:11px;color:#555555;">${ff(totals.estTax)}</td></tr>` : ''}
${totals.taxRate > 0 ? `<tr style="background:#fafafa;border-top:1px solid #dddddd;"><td colspan="4" style="padding:7px 7px;text-align:right;font-size:10px;color:#777777;letter-spacing:.05em;">Est. Grand Total</td><td style="padding:7px 7px;text-align:right;font-size:16px;font-weight:300;color:#d95e00;font-family:Georgia,'Times New Roman',serif;">${ff(totals.estGrand)}</td></tr>` : ''}
${totals.finalTotal ? `<tr style="background:#111111;"><td colspan="4" style="padding:9px 7px;text-align:right;font-size:10px;color:#aaaaaa;letter-spacing:.1em;text-transform:uppercase;">Final Total After Tax</td><td style="padding:9px 7px;text-align:right;font-size:18px;font-weight:300;color:#ffffff;font-family:Georgia,'Times New Roman',serif;">$${esc(totals.finalTotal)}</td></tr>` : ''}
</tfoot>
</table>
</td>
</tr>
<!-- DISCLAIMER -->
<tr>
<td style="padding:24px 48px;border-bottom:1px solid #e0ddd8;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="border-left:2px solid #d95e00;padding:8px 13px;font-size:10px;color:#777777;line-height:1.8;letter-spacing:.02em;">
All values are estimates pending final inspection. All sales and trade-ins are final.
${cm === 'PENDING' ? '<br/><strong style="color:#d95e00;font-size:10px;">&#9888; Credit Memo Number pending — to be assigned upon finalization.</strong>' : ''}
${cm === 'PENDING' ? `<br/><strong style="color:#555555;font-size:10px;">This estimate is valid for 5 days from the date of issue (${esc(dt)}).</strong>` : ''}
${location === 'shipping' && tracking ? '<br/>A copy of your FedEx shipping label is attached to this email.' : ''}
</td>
</tr>
</table>
</td>
</tr>
<!-- ATTACHMENTS NOTE -->
<tr>
<td style="padding:20px 48px;border-bottom:1px solid #e0ddd8;">
<p style="margin:0;font-size:11px;color:#888888;line-height:1.7;">
<strong style="color:#555555;">Attached:</strong> A PDF copy of this ${cm !== 'PENDING' ? 'credit memo' : 'estimate'} is attached to this email for your records.${location === 'shipping' && tracking ? ' A copy of the FedEx shipping label is also attached.' : ''}
</p>
</td>
</tr>
<!-- FOOTER -->
<tr>
<td style="padding:24px 48px;background:#111111;text-align:center;">
<img src="https://camerawest.com/cdn/shop/files/CW_Logo_2026_Whate.svg?v=1772114375" alt="Camera West" width="120" style="display:block;margin:0 auto 12px;max-width:120px;opacity:0.5;" />
<p style="margin:0;font-size:10px;color:#666666;letter-spacing:0.15em;text-transform:uppercase;">
${esc(docLabel || 'Estimate')}
</p>
<p style="margin:8px 0 0;font-size:10px;color:#555555;">
Questions? Reply to this email or contact us at <a href="mailto:support@camerawest.com" style="color:#d95e00;text-decoration:underline;">support@camerawest.com</a>
</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

/* ── Main handler ────────────────────────────────────────────── */

export async function onRequestPost({ request, env }) {
  try {
    if (!env.RESEND_API_KEY) {
      return json({ error: 'RESEND_API_KEY not configured' }, 503);
    }

    const body = await request.json();
    const { customer, pdfBase64, labelPdfBase64 } = body;

    if (!customer?.email || !customer?.first) {
      return json({ error: 'Missing required fields: customer.first, customer.email' }, 400);
    }
    if (!pdfBase64) {
      return json({ error: 'Missing required field: pdfBase64' }, 400);
    }

    const custName = [customer.first, customer.last].filter(Boolean).join(' ');
    const docLabel = body.docLabel || 'Estimate';
    const fromEmail = env.FROM_EMAIL || 'noreply@camerawest.com';
    const subject = `${docLabel} — ${custName} — Camera West`;

    const html = buildEstimateEmailHtml(body);

    // Build attachments
    const pdfFilename = custName.replace(/[^a-zA-Z0-9 ]/g, '') + ' - ' + docLabel + ' - ' + (body.txnDate || new Date().toISOString().split('T')[0]) + '.pdf';
    const attachments = [
      { filename: pdfFilename, content: pdfBase64, content_type: 'application/pdf' },
    ];

    if (labelPdfBase64) {
      attachments.push({
        filename: custName.replace(/[^a-zA-Z0-9 ]/g, '') + ' - FedEx Shipping Label.pdf',
        content: labelPdfBase64,
        content_type: 'application/pdf',
      });
    }

    // Send via Resend
    const resendPayload = {
      from: `Camera West <${fromEmail}>`,
      to: [customer.email],
      reply_to: 'support@camerawest.com',
      subject,
      html,
      attachments,
    };

    const payloadJson = JSON.stringify(resendPayload);
    const payloadSizeMB = (payloadJson.length / (1024 * 1024)).toFixed(2);
    console.log(`estimate-email: sending to ${customer.email}, payload ${payloadSizeMB} MB, ${attachments.length} attachment(s)`);

    if (payloadJson.length > 35 * 1024 * 1024) {
      return json({ error: `Email payload too large (${payloadSizeMB} MB). Try reducing PDF quality.` }, 413);
    }

    let r;
    try {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        },
        body: payloadJson,
      });
    } catch (fetchErr) {
      console.error('Resend fetch failed:', fetchErr);
      return json({ error: `Resend request failed: ${fetchErr.message || 'network error'}` }, 502);
    }

    const resBody = await r.text().catch(() => '');
    if (!r.ok) {
      console.error('Resend estimate-email error:', r.status, resBody);
      return json({ error: `Resend error (${r.status}): ${resBody}` }, 502);
    }

    const result = resBody ? JSON.parse(resBody) : {};

    // Log to CommsLayer conversation thread (non-blocking)
    const itemCount = (body.items || []).length;
    const cmDisplay = body.cmNum || 'PENDING';
    const trackingInfo = body.tracking ? `\nFedEx Tracking: ${body.tracking}` : '';
    const labelNote = labelPdfBase64 ? '\n📦 FedEx shipping label PDF attached to email.' : '';

    const csContent = [
      `📧 ${docLabel} emailed to ${customer.email}`,
      `Trade-In: ${body.tradeInId || 'N/A'}`,
      `Credit Memo: ${cmDisplay}`,
      `Items: ${itemCount}`,
      `Net Total: $${Number(body.totals?.netTotal || 0).toFixed(2)}`,
      trackingInfo,
      labelNote,
      `\nDate: ${body.txnDate || new Date().toISOString().split('T')[0]}`,
      body.assoc ? `Associate: ${body.assoc}` : '',
    ].filter(Boolean).join('\n');

    logTradeInEvent(env, {
      customer,
      tradeInId: body.tradeInId,
      content: csContent,
      customAttributes: {
        cm_number: cmDisplay,
        doc_type: docLabel,
        ...(body.tracking ? { tracking_number: body.tracking } : {}),
      },
    }).catch(err => console.error('CommsLayer estimate log error:', err));

    return json({ ok: true, id: result.id });
  } catch (err) {
    console.error('estimate-email error:', err, err?.stack);
    return json({ error: `Email error: ${err.message || String(err)}` }, 500);
  }
}
