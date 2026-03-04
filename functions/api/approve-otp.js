/**
 * POST /api/approve-otp
 *
 * Three actions:
 *   { action: "send", email: "manager@…", requestedBy: "…", summaryHtml: "…",
 *     customerEmail: "…", customerName: "…", preferredLocation: "…" }
 *     → generates a 6-digit OTP, stores in KV (5 min TTL), emails it to the manager
 *       along with the pending credit memo preview, customer info, and location
 *
 *   { action: "verify", email: "manager@…", code: "123456" }
 *     → verifies the OTP, deletes it (one-time use), returns { ok: true }
 *
 *   { action: "confirm", email: "manager@…", tranId: "CM123", ... }
 *     → sends a confirmation email with the CM number after credit is issued
 *
 * Only MANAGER_EMAILS can receive OTPs.
 * Uses Resend (preferred) or MailChannels (fallback).
 */

const MANAGER_EMAILS = [
  'sam@leicastoresf.com',
  'sean@camerawest.com',
  'ben@camerawest.com',
  'kyle@camerawest.com',
  'allegra@cwwatchshop.com',
  'devyn@camerawest.com',
  'norman@camerawest.com',
  'adam@camerawest.com',
  'armando@camerawest.com',
  'festa@camerawest.com',
];

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function rand6() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, '0');
}

/** Send email via Resend (preferred) or MailChannels (fallback) */
async function sendEmail(env, to, subject, htmlBody) {
  const fromEmail = env.FROM_EMAIL || 'noreply@camerawest.com';
  const fromName = 'Camera West Trade-In';

  // Try Resend first
  if (env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: `${fromName} <${fromEmail}>`,
          to: [to],
          subject,
          html: htmlBody,
        }),
      });
      if (r.ok || r.status === 200 || r.status === 202) return 'sent';
      const errText = await r.text().catch(() => '');
      console.error('Resend email error:', r.status, errText);
      // Fall through to MailChannels
    } catch (e) {
      console.error('Resend email failed:', e);
    }
  }

  // Fallback: MailChannels
  try {
    const r = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: fromName },
        subject,
        content: [{ type: 'text/html', value: htmlBody }],
      }),
    });
    if (r.ok || r.status === 202) return 'sent';
    const errText = await r.text().catch(() => '');
    console.error('MailChannels email error:', r.status, errText);
    return 'mail_error_' + r.status;
  } catch (e) {
    console.error('MailChannels email failed:', e);
    return 'mail_exception';
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { action, email, code, requestedBy, summaryHtml,
          customerEmail, customerName, preferredLocation,
          tranId, refundTranId, grandTotal, credited, balance,
          associate, date } = body;
  const norm = (email || '').toLowerCase().trim();

  if (!norm || !MANAGER_EMAILS.includes(norm)) {
    return json({ error: 'Not an authorized manager' }, 403);
  }

  const kv = env.AUTH_KV;
  if (!kv) return json({ error: 'AUTH_KV not bound — add KV binding in Cloudflare Pages settings' }, 503);

  try {
    // ── SEND ──
    if (action === 'send') {
      const otp = rand6();
      const kvKey = `otp:${norm}`;
      await kv.put(kvKey, JSON.stringify({ code: otp, created: Date.now() }), { expirationTtl: 300 });

      const requester = requestedBy || 'An associate';
      const loc = preferredLocation || '—';
      const custName = customerName || '—';
      const custEmail = customerEmail || '';

      // Build the pending CM preview section for the email
      const previewSection = summaryHtml
        ? `<div style="margin:24px 0;padding:16px;background:#1a1a1a;border:1px solid #333;">
             ${summaryHtml}
           </div>`
        : '';

      const customerInfoSection = `
        <div style="margin:16px 0;padding:12px 16px;background:#1a1a1a;border-left:3px solid #d95e00;">
          <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(245,245,240,0.45);margin-bottom:8px;">Request Details</div>
          <table style="font-size:13px;color:rgba(245,245,240,0.7);line-height:2;">
            <tr><td style="padding-right:16px;color:rgba(245,245,240,0.45);">Customer:</td><td style="color:#f5f5f0;">${custName}${custEmail ? ' &nbsp;(' + custEmail + ')' : ''}</td></tr>
            <tr><td style="padding-right:16px;color:rgba(245,245,240,0.45);">Location:</td><td style="color:#f5f5f0;">${loc}</td></tr>
            <tr><td style="padding-right:16px;color:rgba(245,245,240,0.45);">Requested by:</td><td style="color:#f5f5f0;">${requester}</td></tr>
          </table>
        </div>`;

      const htmlBody = `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#0e0e0e;color:#f5f5f0;max-width:640px;margin:0 auto;padding:40px 24px;">
<p style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(245,245,240,0.45);margin-bottom:8px;">Camera West</p>
<h1 style="font-size:26px;font-weight:300;margin:0 0 12px;">Manager Approval Required</h1>
<p style="font-size:13px;color:rgba(245,245,240,0.7);line-height:1.7;margin-bottom:24px;">
  <strong style="color:#f5f5f0;">${requester}</strong> is requesting your approval to issue a Credit Memo / Store Credit. Use this code to authorize — it expires in <strong>5 minutes</strong>.
</p>
<div style="background:#1a1a1a;border:2px solid #d95e00;padding:18px 32px;text-align:center;font-size:36px;letter-spacing:0.3em;font-weight:600;color:#d95e00;margin-bottom:24px;">${otp}</div>
${customerInfoSection}
${previewSection}
<p style="font-size:11px;color:rgba(245,245,240,0.35);margin-top:24px;line-height:1.7;">If you did not expect this request, you can safely ignore it.</p>
</body></html>`;

      const mailStatus = await sendEmail(env, norm, `Approval code — ${requester} is requesting credit`, htmlBody);
      return json({ ok: true, message: 'Code sent to ' + norm, mailStatus });
    }

    // ── VERIFY ──
    if (action === 'verify') {
      if (!code) return json({ error: 'Code required' }, 400);

      const kvKey = `otp:${norm}`;
      const raw = await kv.get(kvKey);
      if (!raw) {
        return json({ error: 'No code found — it may have expired' }, 410);
      }

      const stored = JSON.parse(raw);
      if (stored.code !== code.trim()) {
        return json({ error: 'Invalid code' }, 401);
      }

      // One-time use — delete immediately
      await kv.delete(kvKey);

      return json({ ok: true, manager: norm });
    }

    // ── CONFIRM (CM confirmation email) ──
    if (action === 'confirm') {
      const cmNum = tranId || 'N/A';
      const refund = refundTranId || '';
      const total = grandTotal ? `$${parseFloat(grandTotal).toFixed(2)}` : '—';
      const custName = customerName || '—';
      const custEmail = customerEmail || '';
      const loc = preferredLocation || '—';
      const asc = associate || '—';
      const dt = date || new Date().toISOString().split('T')[0];

      const shopifySection = credited
        ? `<tr><td style="padding-right:16px;color:rgba(245,245,240,0.45);">Shopify Credit:</td><td style="color:#70d090;">$${parseFloat(credited).toFixed(2)} credited (balance: $${parseFloat(balance).toFixed(2)})</td></tr>`
        : '';
      const refundRow = refund
        ? `<tr><td style="padding-right:16px;color:rgba(245,245,240,0.45);">Refund #:</td><td style="color:#f5f5f0;">${refund}</td></tr>`
        : '';

      const previewSection = summaryHtml
        ? `<div style="margin:20px 0;padding:16px;background:#1a1a1a;border:1px solid #333;">
             ${summaryHtml}
           </div>`
        : '';

      const htmlBody = `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#0e0e0e;color:#f5f5f0;max-width:640px;margin:0 auto;padding:40px 24px;">
<p style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(245,245,240,0.45);margin-bottom:8px;">Camera West</p>
<h1 style="font-size:26px;font-weight:300;margin:0 0 12px;">Credit Memo Issued</h1>
<div style="background:#143a24;border:2px solid #2a5a3a;padding:18px 24px;text-align:center;margin-bottom:24px;">
  <div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#70d090;margin-bottom:6px;">Credit Memo Number</div>
  <div style="font-size:32px;font-weight:600;color:#70d090;letter-spacing:0.1em;">${cmNum}</div>
</div>
<div style="margin:16px 0;padding:12px 16px;background:#1a1a1a;border-left:3px solid #2a5a3a;">
  <table style="font-size:13px;color:rgba(245,245,240,0.7);line-height:2;">
    <tr><td style="padding-right:16px;color:rgba(245,245,240,0.45);">Customer:</td><td style="color:#f5f5f0;">${custName}${custEmail ? ' (' + custEmail + ')' : ''}</td></tr>
    <tr><td style="padding-right:16px;color:rgba(245,245,240,0.45);">Location:</td><td style="color:#f5f5f0;">${loc}</td></tr>
    <tr><td style="padding-right:16px;color:rgba(245,245,240,0.45);">Associate:</td><td style="color:#f5f5f0;">${asc}</td></tr>
    <tr><td style="padding-right:16px;color:rgba(245,245,240,0.45);">Date:</td><td style="color:#f5f5f0;">${dt}</td></tr>
    <tr><td style="padding-right:16px;color:rgba(245,245,240,0.45);">Grand Total:</td><td style="color:#d95e00;font-weight:600;">${total}</td></tr>
    ${refundRow}
    ${shopifySection}
  </table>
</div>
${previewSection}
<p style="font-size:11px;color:rgba(245,245,240,0.35);margin-top:24px;line-height:1.7;">This is a confirmation that the credit memo has been successfully created.</p>
</body></html>`;

      const mailStatus = await sendEmail(env, norm, `Credit Memo ${cmNum} — Issued for ${custName}`, htmlBody);
      return json({ ok: true, mailStatus });
    }

    return json({ error: 'Invalid action — use "send", "verify", or "confirm"' }, 400);
  } catch (err) {
    console.error('approve-otp error:', err);
    return json({ error: err.message || 'Internal error' }, 500);
  }
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
