/**
 * POST /api/approve-otp
 *
 * Two actions:
 *   { action: "send", email: "manager@…", requestedBy: "…", summaryHtml: "…" }
 *     → generates a 6-digit OTP, stores in KV (5 min TTL), emails it to the manager
 *       along with the pending credit memo preview
 *
 *   { action: "verify", email: "manager@…", code: "123456" }
 *     → verifies the OTP, deletes it (one-time use), returns { ok: true }
 *
 * Only MANAGER_EMAILS can receive OTPs.
 * Uses MailChannels (same as auth/request.js).
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

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { action, email, code, requestedBy, summaryHtml } = body;
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
      // Build the pending CM preview section for the email
      const previewSection = summaryHtml
        ? `<div style="margin:24px 0;padding:16px;background:#ffffff;border:1px solid #e0e0e0;">
             ${summaryHtml}
           </div>`
        : '';

      const emailPayload = {
        personalizations: [{ to: [{ email: norm }] }],
        from: {
          email: env.FROM_EMAIL || 'noreply@camerawest.com',
          name: 'Camera West Trade-In',
        },
        subject: `Approval code — ${requester} is requesting credit`,
        content: [{
          type: 'text/html',
          value: `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#0e0e0e;color:#f5f5f0;max-width:640px;margin:0 auto;padding:40px 24px;">
<p style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(245,245,240,0.45);margin-bottom:8px;">Camera West</p>
<h1 style="font-size:26px;font-weight:300;margin:0 0 12px;">Manager Approval Required</h1>
<p style="font-size:13px;color:rgba(245,245,240,0.7);line-height:1.7;margin-bottom:24px;">
  <strong style="color:#f5f5f0;">${requester}</strong> is requesting your approval to issue a Credit Memo / Store Credit. Use this code to authorize — it expires in <strong>5 minutes</strong>.
</p>
<div style="background:#1a1a1a;border:2px solid #d95e00;padding:18px 32px;text-align:center;font-size:36px;letter-spacing:0.3em;font-weight:600;color:#d95e00;margin-bottom:24px;">${otp}</div>
${previewSection}
<p style="font-size:11px;color:rgba(245,245,240,0.35);margin-top:24px;line-height:1.7;">If you did not expect this request, you can safely ignore it.</p>
</body></html>`,
        }],
      };

      let mailStatus = 'sent';
      try {
        const r = await fetch('https://api.mailchannels.net/tx/v1/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(emailPayload),
        });
        if (!r.ok && r.status !== 202) {
          const errText = await r.text().catch(() => '');
          console.error('MailChannels OTP error:', r.status, errText);
          mailStatus = 'mail_error_' + r.status;
        }
      } catch (e) {
        console.error('MailChannels OTP send failed:', e);
        mailStatus = 'mail_exception';
      }

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

    return json({ error: 'Invalid action — use "send" or "verify"' }, 400);
  } catch (err) {
    console.error('approve-otp error:', err);
    return json({ error: err.message || 'Internal error' }, 500);
  }
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
