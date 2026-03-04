/**
 * POST /api/auth/request
 *
 * Routes by `action` field in JSON body:
 *
 *   (no action / action:"login")
 *     Body: { email }
 *     → Magic-link sign-in flow (Cloudflare Access handles actual login emails;
 *       this just generates the token + stores in KV)
 *
 *   action:"otp-send"
 *     Body: { action:"otp-send", email, requestedBy?, summaryHtml? }
 *     → Generates 6-digit OTP, stores in KV (5 min), emails it via Resend
 *
 *   action:"otp-verify"
 *     Body: { action:"otp-verify", email, code }
 *     → Verifies the OTP, one-time use, returns { ok:true, manager }
 *
 * KV bindings:  AUTH_KV
 * Env vars:     APP_URL, FROM_EMAIL, RESEND_API_KEY (from resend.com)
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

function rand6() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, '0');
}

export async function onRequestPost({ request, env }) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': env.APP_URL || '*',
    'Content-Type': 'application/json',
  };

  const json = (d, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: corsHeaders });

  try {
    const body = await request.json();
    const action = body.action || 'login';

    // ════════════════════════════════════════════════
    // OTP-SEND  (via Resend)
    // ════════════════════════════════════════════════
    if (action === 'otp-send') {
      const norm = (body.email || '').toLowerCase().trim();
      if (!norm || !MANAGER_EMAILS.includes(norm)) {
        return json({ error: 'Not an authorized manager' }, 403);
      }

      const kv = env.AUTH_KV;
      if (!kv) return json({ error: 'KV not bound' }, 503);

      if (!env.RESEND_API_KEY) {
        return json({ error: 'RESEND_API_KEY not configured — add it in Cloudflare Pages > Settings > Environment Variables' }, 503);
      }

      const otp = rand6();
      await kv.put(`otp:${norm}`, JSON.stringify({ code: otp, created: Date.now() }), { expirationTtl: 300 });

      const requester = body.requestedBy || 'An associate';
      const previewSection = body.summaryHtml
        ? `<div style="margin:24px 0;padding:16px;background:#ffffff;border:1px solid #e0e0e0;">${body.summaryHtml}</div>`
        : '';

      const fromEmail = env.FROM_EMAIL || 'noreply@camerawest.com';
      const htmlBody = `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#0e0e0e;color:#f5f5f0;max-width:640px;margin:0 auto;padding:40px 24px;">
<p style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(245,245,240,0.45);margin-bottom:8px;">Camera West</p>
<h1 style="font-size:26px;font-weight:300;margin:0 0 12px;">Manager Approval Required</h1>
<p style="font-size:13px;color:rgba(245,245,240,0.7);line-height:1.7;margin-bottom:24px;">
  <strong style="color:#f5f5f0;">${requester}</strong> is requesting your approval to issue a Credit Memo / Store Credit. Use this code to authorize — it expires in <strong>5 minutes</strong>.
</p>
<div style="background:#1a1a1a;border:2px solid #d95e00;padding:18px 32px;text-align:center;font-size:36px;letter-spacing:0.3em;font-weight:600;color:#d95e00;margin-bottom:24px;">${otp}</div>
${previewSection}
<p style="font-size:11px;color:rgba(245,245,240,0.35);margin-top:24px;line-height:1.7;">If you did not expect this request, you can safely ignore it.</p>
</body></html>`;

      let mailStatus = 'sent';
      let mailDetail = '';
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: `Camera West Trade-In <${fromEmail}>`,
            to: [norm],
            subject: `Approval code — ${requester} is requesting credit`,
            html: htmlBody,
          }),
        });
        if (!r.ok) {
          const errText = await r.text().catch(() => '');
          console.error('Resend OTP error:', r.status, errText);
          mailStatus = 'mail_error_' + r.status;
          mailDetail = errText.slice(0, 300);
        }
      } catch (e) {
        console.error('Resend OTP send failed:', e);
        mailStatus = 'mail_exception';
        mailDetail = e.message;
      }

      return json({ ok: true, message: 'Code sent to ' + norm, mailStatus, mailDetail });
    }

    // ════════════════════════════════════════════════
    // OTP-VERIFY
    // ════════════════════════════════════════════════
    if (action === 'otp-verify') {
      const norm = (body.email || '').toLowerCase().trim();
      if (!norm || !MANAGER_EMAILS.includes(norm)) {
        return json({ error: 'Not an authorized manager' }, 403);
      }

      const kv = env.AUTH_KV;
      if (!kv) return json({ error: 'KV not bound' }, 503);

      const code = body.code;
      if (!code) return json({ error: 'Code required' }, 400);

      const raw = await kv.get(`otp:${norm}`);
      if (!raw) return json({ error: 'No code found — it may have expired' }, 410);

      const stored = JSON.parse(raw);
      if (stored.code !== code.trim()) return json({ error: 'Invalid code' }, 401);

      await kv.delete(`otp:${norm}`);
      return json({ ok: true, manager: norm });
    }

    // ════════════════════════════════════════════════
    // MAGIC-LINK LOGIN (original flow)
    // ════════════════════════════════════════════════
    // Note: Cloudflare Access handles actual sign-in emails.
    // This path generates a token for the custom session layer.
    const { email } = body;

    if (!email || !email.includes('@')) {
      return json({ error: 'Invalid email' }, 400);
    }

    const normalizedEmail = email.toLowerCase().trim();

    const allowedRaw = await env.AUTH_KV.get('allowed_emails');
    const allowed = allowedRaw ? JSON.parse(allowedRaw) : [];

    if (!allowed.includes(normalizedEmail)) {
      return json({ ok: true, message: 'If that email is registered, a link is on its way.' });
    }

    const token = crypto.randomUUID() + '-' + crypto.randomUUID();
    const expires = Date.now() + 15 * 60 * 1000;

    await env.AUTH_KV.put(
      `token:${token}`,
      JSON.stringify({ email: normalizedEmail, expires }),
      { expirationTtl: 900 }
    );

    const magicLink = `${env.APP_URL}/api/auth/verify?token=${token}`;
    const fromEmail = env.FROM_EMAIL || 'noreply@camerawest.com';

    // Send magic-link email via Resend (if API key is configured)
    if (env.RESEND_API_KEY) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: `Camera West Trade-In <${fromEmail}>`,
            to: [normalizedEmail],
            subject: 'Your Trade-In Manager sign-in link',
            html: `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',sans-serif;background:#0e0e0e;color:#f5f5f0;max-width:480px;margin:0 auto;padding:40px 24px;">
  <p style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(245,245,240,0.45);margin-bottom:8px;">Camera West</p>
  <h1 style="font-size:26px;font-weight:300;margin:0 0 24px;">Trade-In Manager</h1>
  <p style="font-size:13px;color:rgba(245,245,240,0.7);line-height:1.7;margin-bottom:32px;">
    Click the button below to sign in. This link expires in 15 minutes and can only be used once.
  </p>
  <a href="${magicLink}" style="display:inline-block;background:#d95e00;color:#fff;text-decoration:none;padding:14px 32px;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;">
    Sign In to Trade-In Manager
  </a>
  <p style="font-size:11px;color:rgba(245,245,240,0.35);margin-top:32px;line-height:1.7;">
    If you didn't request this, you can safely ignore this email.<br>
    This link will expire at ${new Date(expires).toLocaleTimeString()}.
  </p>
</body></html>`,
          }),
        });
        if (!r.ok) {
          const errText = await r.text().catch(() => '');
          console.error('Resend magic-link error:', r.status, errText);
        }
      } catch (e) {
        console.error('Resend magic-link send failed:', e);
      }
    }

    return json({ ok: true, message: 'If that email is registered, a link is on its way.' });

  } catch (err) {
    console.error('Auth request error:', err);
    return json({ error: 'Server error' }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
