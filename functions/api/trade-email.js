/**
 * POST /api/trade-email
 * Sends trade-in submission emails via Resend:
 *   1. Internal notification to the team
 *   2. Confirmation email to the customer
 *
 * Body: { firstName, lastName, email, phone, intention, location,
 *         gear_summary, notes, items: [{ model, condition, notes, photos[] }] }
 */

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

function buildItemHtml(item, idx) {
  const num = String(idx + 1).padStart(2, '0');
  const photosHtml = (item.photos || [])
    .filter(Boolean)
    .map(url => `<a href="${esc(url)}" style="color:#111111;text-decoration:underline;font-size:12px;word-break:break-all;">${esc(url)}</a>`)
    .join('<br/>') || '<span style="color:#aaaaaa;font-size:12px;">No photos uploaded</span>';

  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;border:1px solid #e0ddd8;">
<tr><td style="padding:6px 16px;background:#111111;"><span style="font-size:9px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#ffffff;">Item ${num}</span></td></tr>
<tr>
<td style="padding:16px;background:#f8f7f5;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="width:50%;padding-right:12px;padding-bottom:12px;vertical-align:top;">
<p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#aaaaaa;">Make &amp; Model</p>
<p style="margin:0;font-size:14px;color:#111111;">${esc(item.model)}</p>
</td>
<td style="width:50%;padding-left:12px;padding-bottom:12px;vertical-align:top;">
<p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#aaaaaa;">Condition</p>
<p style="margin:0;font-size:14px;color:#111111;">${esc(item.condition) || 'Not specified'}</p>
</td>
</tr>
<tr>
<td colspan="2" style="padding-bottom:12px;">
<p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#aaaaaa;">Notes</p>
<p style="margin:0;font-size:14px;color:#444444;">${esc(item.notes) || '—'}</p>
</td>
</tr>
<tr>
<td colspan="2">
<p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#aaaaaa;">Photos</p>
<p style="margin:0;line-height:1.8;">${photosHtml}</p>
</td>
</tr>
</table>
</td>
</tr>
</table>`;
}

function buildEmailHtml({ firstName, lastName, email, phone, intention, location, gear_summary, notes, items, isCustomerCopy }) {
  const itemsHtml = (items || []).map((item, i) => buildItemHtml(item, i)).join('\n');

  const bannerText = isCustomerCopy
    ? `New submission received — ${esc(firstName)} ${esc(lastName)}`
    : `&#9679; New submission received — ${esc(firstName)} ${esc(lastName)} — ${esc(location)}`;

  const thankYouSection = `
<tr>
<td style="padding:32px 48px;border-bottom:1px solid #e0ddd8;text-align:center;">
<p style="margin:0 0 8px;font-size:20px;font-weight:300;color:#111111;letter-spacing:0.04em;">
Thank you, ${esc(firstName)}.
</p>
<p style="margin:0;font-size:13px;color:#666666;line-height:1.7;max-width:400px;margin-left:auto;margin-right:auto;">
We&#8217;ve received your trade-in request and a member of our team will be in touch within <strong style="color:#111111;font-weight:700;">1&#8211;2 business days</strong> with an offer or to arrange next steps.
</p>
</td>
</tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trade-In Request — Camera West</title>
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
New Trade // Sell Request
</p>
</td>
</tr>
<!-- ALERT BANNER -->
<tr>
<td style="background:#f8f7f5;padding:16px 48px;border-bottom:1px solid #e0ddd8;">
<p style="margin:0;font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#111111;">
${bannerText}
</p>
</td>
</tr>
${isCustomerCopy ? thankYouSection : ''}
<!-- CUSTOMER + INTENTION -->
<tr>
<td style="padding:32px 48px;border-bottom:1px solid #e0ddd8;">
<p style="margin:0 0 16px;font-size:9px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;color:#888888;padding-bottom:12px;border-bottom:1px solid #e0ddd8;">
Customer
</p>
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="width:33%;padding-right:12px;padding-bottom:14px;vertical-align:top;">
<p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#aaaaaa;">Name</p>
<p style="margin:0;font-size:14px;color:#111111;">${esc(firstName)} ${esc(lastName)}</p>
</td>
<td style="width:33%;padding-right:12px;padding-bottom:14px;vertical-align:top;">
<p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#aaaaaa;">Email</p>
<p style="margin:0;font-size:14px;color:#111111;">
<a href="mailto:${esc(email)}" style="color:#111111;text-decoration:underline;">${esc(email)}</a>
</p>
</td>
<td style="width:33%;padding-bottom:14px;vertical-align:top;">
<p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#aaaaaa;">Phone</p>
<p style="margin:0;font-size:14px;color:#111111;">
${phone ? `<a href="tel:${esc(phone)}" style="color:#111111;text-decoration:underline;">${esc(phone)}</a>` : '—'}
</p>
</td>
</tr>
<tr>
<td style="padding-bottom:14px;vertical-align:top;">
<p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#aaaaaa;">Intention</p>
<table cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="background:#111111;padding:6px 14px;">
<span style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#ffffff;">${esc(intention)}</span>
</td>
</tr>
</table>
</td>
<td colspan="2" style="padding-bottom:14px;vertical-align:top;">
<p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#aaaaaa;">Preferred Location</p>
<table cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="background:#111111;padding:6px 14px;">
<span style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#ffffff;">${esc(location)}</span>
</td>
</tr>
</table>
</td>
</tr>
</table>
</td>
</tr>
<!-- GEAR OVERVIEW -->
<tr>
<td style="padding:32px 48px;border-bottom:1px solid #e0ddd8;">
<p style="margin:0 0 16px;font-size:9px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;color:#888888;padding-bottom:12px;border-bottom:1px solid #e0ddd8;">
Gear Overview
</p>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-left:3px solid #111111;">
<tr>
<td style="padding:16px 20px;background:#f8f7f5;font-size:13px;color:#444444;line-height:2;font-family:'Courier New',Courier,monospace;white-space:pre-wrap;">${esc(gear_summary)}</td>
</tr>
</table>
</td>
</tr>
<!-- ITEM DETAILS -->
<tr>
<td style="padding:32px 48px;border-bottom:1px solid #e0ddd8;">
<p style="margin:0 0 20px;font-size:9px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;color:#888888;padding-bottom:12px;border-bottom:1px solid #e0ddd8;">
Item Details
</p>
${itemsHtml}
</td>
</tr>
<!-- ADDITIONAL NOTES -->
<tr>
<td style="padding:32px 48px;border-bottom:1px solid #e0ddd8;">
<p style="margin:0 0 16px;font-size:9px;font-weight:700;letter-spacing:0.25em;text-transform:uppercase;color:#888888;padding-bottom:12px;border-bottom:1px solid #e0ddd8;">
Additional Notes
</p>
<p style="margin:0;font-size:14px;color:#444444;line-height:1.7;">${esc(notes) || '—'}</p>
</td>
</tr>
<!-- FOOTER -->
<tr>
<td style="padding:24px 48px;background:#111111;text-align:center;">
<img src="https://camerawest.com/cdn/shop/files/CW_Logo_2026_Whate.svg?v=1772114375" alt="Camera West" width="120" style="display:block;margin:0 auto 12px;max-width:120px;opacity:0.5;" />
<p style="margin:0;font-size:10px;color:#666666;letter-spacing:0.15em;text-transform:uppercase;">
${isCustomerCopy ? 'Trade // Sell Request Confirmation' : 'Internal Notification — Trade // Sell Request'}
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

/* ── Resend sender ───────────────────────────────────────────── */

async function sendViaResend(env, { from, to, cc, replyTo, subject, html }) {
  const payload = { from, to: Array.isArray(to) ? to : [to], subject, html };
  if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];
  if (replyTo) payload.reply_to = replyTo;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Resend API error ${r.status}: ${errText}`);
  }
  return r.json();
}

/* ── Main handler ────────────────────────────────────────────── */

// Team recipients for internal notification
const TEAM_RECIPIENTS = [
  'support@camerawest.com',
];

export async function onRequestPost({ request, env }) {
  try {
    if (!env.RESEND_API_KEY) {
      return json({ error: 'RESEND_API_KEY not configured' }, 503);
    }

    const body = await request.json();
    const { firstName, lastName, email, phone, intention, location, gear_summary, notes, items } = body;

    if (!email || !firstName) {
      return json({ error: 'Missing required fields: firstName, email' }, 400);
    }

    const fromEmail = env.FROM_EMAIL || 'noreply@camerawest.com';
    const fromName = 'Camera West';
    const subject = `Trade-In Request — ${firstName} ${lastName} — ${location || 'No location'}`;

    // Send notification to both support and customer
    const emailHtml = buildEmailHtml({ firstName, lastName, email, phone, intention, location, gear_summary, notes, items, isCustomerCopy: true });
    await sendViaResend(env, {
      from: `${fromName} <${fromEmail}>`,
      to: [...TEAM_RECIPIENTS, email],
      replyTo: email,
      subject,
      html: emailHtml,
    });

    return json({ ok: true });
  } catch (err) {
    console.error('trade-email error:', err);
    return json({ error: err.message || 'Failed to send email' }, 500);
  }
}
