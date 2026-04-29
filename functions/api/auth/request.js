/**
 * POST /api/auth/request
 *
 * Routes by `action` field in JSON body:
 *
 *   action:"login-otp-send"
 *     Body: { action:"login-otp-send", email }
 *     → Sends a 6-digit sign-in code via Resend (5 min TTL)
 *
 *   action:"login-otp-verify"
 *     Body: { action:"login-otp-verify", email, code }
 *     → Verifies code, creates session, sets cookie
 *
 *   action:"otp-send"
 *     Body: { action:"otp-send", email, requestedBy?, summaryHtml? }
 *     → Manager approval OTP (separate from login)
 *
 *   action:"otp-verify"
 *     Body: { action:"otp-verify", email, code }
 *     → Verifies manager approval OTP
 *
 * KV bindings:  AUTH_KV
 * Env vars:     APP_URL, FROM_EMAIL, RESEND_API_KEY
 */

const MANAGER_EMAILS = [
  'sam@leicastoresf.com',
  'sean@camerawest.com',
  'ben@camerawest.com',
  'kyle@camerawest.com',
  'allegra@cwwatchshop.com',
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

async function getAllowedEmails(env) {
  const set = new Set(MANAGER_EMAILS);
  try {
    const raw = await env.AUTH_KV.get('allowed_emails');
    if (raw) JSON.parse(raw).forEach(e => set.add(e.toLowerCase().trim()));
  } catch(e) {}
  return set;
}

export async function onRequestPost({ request, env }) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': env.APP_URL || '*',
    'Content-Type': 'application/json',
  };

  const json = (d, s = 200, extra = {}) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...corsHeaders, ...extra } });

  try {
    const body = await request.json();
    const action = body.action || 'login';

    // ════════════════════════════════════════════════
    // LOGIN OTP — SEND
    // ════════════════════════════════════════════════
    if (action === 'login-otp-send') {
      const norm = (body.email || '').toLowerCase().trim();
      if (!norm || !norm.includes('@')) {
        return json({ error: 'Please enter a valid email address' }, 400);
      }

      const kv = env.AUTH_KV;
      if (!kv) return json({ error: 'KV not bound' }, 503);
      if (!env.RESEND_API_KEY) return json({ error: 'Mail not configured' }, 503);

      const allowed = await getAllowedEmails(env);
      if (!allowed.has(norm)) {
        return json({ ok: true, message: 'If that email is registered, a code has been sent.' });
      }

      const otp = rand6();
      await kv.put(`login-otp:${norm}`, JSON.stringify({ code: otp, created: Date.now() }), { expirationTtl: 300 });

      const fromEmail = env.FROM_EMAIL || 'noreply@camerawest.com';
      const htmlBody = `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#0e0e0e;color:#f5f5f0;max-width:480px;margin:0 auto;padding:40px 24px;">
<p style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(245,245,240,0.45);margin-bottom:8px;">Camera West</p>
<h1 style="font-size:26px;font-weight:300;margin:0 0 12px;">Sign-In Code</h1>
<p style="font-size:13px;color:rgba(245,245,240,0.7);line-height:1.7;margin-bottom:24px;">
  Enter this code to sign in to Trade // Sell. It expires in <strong>5 minutes</strong>.
</p>
<div style="background:#1a1a1a;border:2px solid #d95e00;padding:18px 32px;text-align:center;font-size:36px;letter-spacing:0.3em;font-weight:600;color:#d95e00;margin-bottom:24px;">${otp}</div>
<p style="font-size:11px;color:rgba(245,245,240,0.35);margin-top:24px;line-height:1.7;">If you didn't request this, you can safely ignore it.</p>
</body></html>`;

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
            subject: 'Your sign-in code for Trade // Sell',
            html: htmlBody,
          }),
        });
        if (!r.ok) {
          const errText = await r.text().catch(() => '');
          console.error('Resend login OTP error:', r.status, errText);
          return json({ error: 'Failed to send code. Please try again.' }, 502);
        }
      } catch (e) {
        console.error('Resend login OTP failed:', e);
        return json({ error: 'Failed to send code. Please try again.' }, 502);
      }

      return json({ ok: true, message: 'If that email is registered, a code has been sent.' });
    }

    // ════════════════════════════════════════════════
    // LOGIN OTP — VERIFY (creates session + sets cookie)
    // ════════════════════════════════════════════════
    if (action === 'login-otp-verify') {
      const norm = (body.email || '').toLowerCase().trim();
      const code = (body.code || '').trim();
      if (!norm) return json({ error: 'Email required' }, 400);
      if (!code) return json({ error: 'Code required' }, 400);

      const kv = env.AUTH_KV;
      if (!kv) return json({ error: 'KV not bound' }, 503);

      const raw = await kv.get(`login-otp:${norm}`);
      if (!raw) return json({ error: 'Code expired or not found. Please request a new one.' }, 410);

      const stored = JSON.parse(raw);
      if (stored.code !== code) return json({ error: 'Invalid code. Please try again.' }, 401);

      await kv.delete(`login-otp:${norm}`);

      const sessionId = crypto.randomUUID();
      const sessionExpires = Date.now() + 8 * 60 * 60 * 1000;

      await kv.put(
        `session:${sessionId}`,
        JSON.stringify({ email: norm, expires: sessionExpires }),
        { expirationTtl: 28800 }
      );

      const cookie = [
        `cw_session=${sessionId}`,
        'HttpOnly',
        'Secure',
        'SameSite=Lax',
        'Path=/',
        'Max-Age=28800',
      ].join('; ');

      return json({ ok: true, email: norm }, 200, { 'Set-Cookie': cookie });
    }

    // ════════════════════════════════════════════════
    // MANAGER APPROVAL OTP — SEND (via Resend)
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
      const appUrl = env.APP_URL || 'https://cw-tradein-app.pages.dev';
      const sessionLink = body.sessionKey
        ? `<div style="margin:20px 0;text-align:center;"><a href="${appUrl}/?session=${encodeURIComponent(body.sessionKey)}" style="display:inline-block;padding:12px 28px;background:#1a1a1a;border:1px solid #d95e00;color:#d95e00;text-decoration:none;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;font-weight:500;">View &amp; Edit Session</a></div>`
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
${sessionLink}
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

    return json({ error: 'Unknown action' }, 400);

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
