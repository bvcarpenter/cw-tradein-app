/**
 * POST /api/approve-otp
 *
 * Two actions:
 *   { action: "send", email: "manager@camerawest.com" }
 *     → generates a 6-digit OTP, stores in KV (5 min TTL), emails it to the manager
 *
 *   { action: "verify", email: "manager@camerawest.com", code: "123456" }
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

function rand6() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, '0');
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS });
  }

  const { action, email, code } = body;
  const norm = (email || '').toLowerCase().trim();

  if (!norm || !MANAGER_EMAILS.includes(norm)) {
    return Response.json({ error: 'Not an authorized manager' }, { status: 403, headers: CORS });
  }

  const kv = env.AUTH_KV;
  if (!kv) return Response.json({ error: 'KV not bound' }, { status: 503, headers: CORS });

  try {
    // ── SEND ──
    if (action === 'send') {
      const otp = rand6();
      const kvKey = `otp:${norm}`;
      await kv.put(kvKey, JSON.stringify({ code: otp, created: Date.now() }), { expirationTtl: 300 });

      // Send email via MailChannels
      const emailPayload = {
        personalizations: [{ to: [{ email: norm }] }],
        from: {
          email: env.FROM_EMAIL || 'noreply@camerawest.com',
          name: 'Camera West Trade-In',
        },
        subject: 'Your approval code',
        content: [{
          type: 'text/html',
          value: `
            <!DOCTYPE html>
            <html>
            <body style="font-family:'Helvetica Neue',sans-serif;background:#0e0e0e;color:#f5f5f0;
                         max-width:480px;margin:0 auto;padding:40px 24px;">
              <p style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;
                        color:rgba(245,245,240,0.45);margin-bottom:8px;">Camera West</p>
              <h1 style="font-size:26px;font-weight:300;margin:0 0 24px;">Approval Code</h1>
              <p style="font-size:13px;color:rgba(245,245,240,0.7);line-height:1.7;margin-bottom:24px;">
                Someone is requesting manager approval to issue a Credit Memo or Store Credit.
                Use the code below to authorize — it expires in 5 minutes.
              </p>
              <div style="background:#1a1a1a;border:2px solid #d95e00;padding:18px 32px;
                          text-align:center;font-size:36px;letter-spacing:0.3em;font-weight:600;
                          color:#d95e00;">
                ${otp}
              </div>
              <p style="font-size:11px;color:rgba(245,245,240,0.35);margin-top:24px;line-height:1.7;">
                If you did not expect this request, you can safely ignore it.
              </p>
            </body>
            </html>
          `,
        }],
      };

      try {
        const r = await fetch('https://api.mailchannels.net/tx/v1/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(emailPayload),
        });
        if (!r.ok && r.status !== 202) {
          const errText = await r.text().catch(() => '');
          console.error('MailChannels OTP error:', r.status, errText);
        }
      } catch (e) {
        console.error('MailChannels OTP send failed:', e);
      }

      return Response.json({ ok: true, message: 'Code sent to ' + norm }, { headers: CORS });
    }

    // ── VERIFY ──
    if (action === 'verify') {
      if (!code) return Response.json({ error: 'Code required' }, { status: 400, headers: CORS });

      const kvKey = `otp:${norm}`;
      const raw = await kv.get(kvKey);
      if (!raw) {
        return Response.json({ error: 'No code found — it may have expired' }, { status: 410, headers: CORS });
      }

      const stored = JSON.parse(raw);
      if (stored.code !== code.trim()) {
        return Response.json({ error: 'Invalid code' }, { status: 401, headers: CORS });
      }

      // One-time use — delete immediately
      await kv.delete(kvKey);

      return Response.json({ ok: true, manager: norm }, { headers: CORS });
    }

    return Response.json({ error: 'Invalid action — use "send" or "verify"' }, { status: 400, headers: CORS });
  } catch (err) {
    console.error('approve-otp error:', err);
    return Response.json({ error: err.message || 'Internal error' }, { status: 500, headers: CORS });
  }
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
