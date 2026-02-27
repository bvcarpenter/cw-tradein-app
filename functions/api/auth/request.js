/**
 * POST /api/auth/request
 * Body: { email: "staff@camerawest.com" }
 *
 * Checks email against allowed list in KV, generates a magic link token,
 * stores it in KV with 15min expiry, sends email via Mailchannels (free on Cloudflare).
 *
 * KV bindings required (set in Cloudflare dashboard):
 *   AUTH_KV  — stores tokens and the allowed emails list
 *
 * Environment variables:
 *   APP_URL  — https://cw-tradein.pages.dev
 *   FROM_EMAIL — noreply@camerawest.com (must be a domain you control)
 */

export async function onRequestPost({ request, env }) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': env.APP_URL || '*',
    'Content-Type': 'application/json',
  };

  try {
    const { email } = await request.json();

    if (!email || !email.includes('@')) {
      return Response.json({ error: 'Invalid email' }, { status: 400, headers: corsHeaders });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ── Check against allowed staff email list ──────────────────────
    // Stored in KV as key "allowed_emails" → JSON array of email strings
    const allowedRaw = await env.AUTH_KV.get('allowed_emails');
    const allowed = allowedRaw ? JSON.parse(allowedRaw) : [];

    if (!allowed.includes(normalizedEmail)) {
      // Return same message to avoid email enumeration
      return Response.json({
        ok: true,
        message: 'If that email is registered, a link is on its way.'
      }, { headers: corsHeaders });
    }

    // ── Generate token ──────────────────────────────────────────────
    const token = crypto.randomUUID() + '-' + crypto.randomUUID();
    const expires = Date.now() + 15 * 60 * 1000; // 15 minutes

    await env.AUTH_KV.put(
      `token:${token}`,
      JSON.stringify({ email: normalizedEmail, expires }),
      { expirationTtl: 900 } // KV auto-deletes after 15min
    );

    // ── Send magic link email via MailChannels ──────────────────────
    const magicLink = `${env.APP_URL}/api/auth/verify?token=${token}`;

    const emailPayload = {
      personalizations: [{
        to: [{ email: normalizedEmail }],
      }],
      from: {
        email: env.FROM_EMAIL || 'noreply@camerawest.com',
        name: 'Camera West Trade-In',
      },
      subject: 'Your Trade-In Manager sign-in link',
      content: [{
        type: 'text/html',
        value: `
          <!DOCTYPE html>
          <html>
          <body style="font-family:'Helvetica Neue',sans-serif;background:#0e0e0e;color:#f5f5f0;
                       max-width:480px;margin:0 auto;padding:40px 24px;">
            <p style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;
                      color:rgba(245,245,240,0.45);margin-bottom:8px;">Camera West</p>
            <h1 style="font-size:26px;font-weight:300;margin:0 0 24px;">Trade-In Manager</h1>
            <p style="font-size:13px;color:rgba(245,245,240,0.7);line-height:1.7;margin-bottom:32px;">
              Click the button below to sign in. This link expires in 15 minutes
              and can only be used once.
            </p>
            <a href="${magicLink}"
               style="display:inline-block;background:#d95e00;color:#fff;
                      text-decoration:none;padding:14px 32px;font-size:11px;
                      letter-spacing:0.16em;text-transform:uppercase;">
              Sign In to Trade-In Manager
            </a>
            <p style="font-size:11px;color:rgba(245,245,240,0.35);margin-top:32px;line-height:1.7;">
              If you didn't request this, you can safely ignore this email.<br>
              This link will expire at ${new Date(expires).toLocaleTimeString()}.
            </p>
          </body>
          </html>
        `,
      }],
    };

    const sendResult = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload),
    });

    if (!sendResult.ok && sendResult.status !== 202) {
      const errText = await sendResult.text();
      console.error('MailChannels error:', sendResult.status, errText);
      // Still return success to avoid leaking info
    }

    return Response.json({
      ok: true,
      message: 'If that email is registered, a link is on its way.',
    }, { headers: corsHeaders });

  } catch (err) {
    console.error('Auth request error:', err);
    return Response.json({ error: 'Server error' }, { status: 500, headers: corsHeaders });
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
