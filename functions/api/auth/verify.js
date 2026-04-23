/**
 * GET /api/auth/verify?token=xxx
 *
 * Validates the magic link token, sets a session cookie, redirects to the app.
 * Session cookie is valid for 8 hours (a workday).
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const loginUrl = url.origin + '/login';
  const appUrl = url.origin + '/';

  if (!token) {
    return Response.redirect(`${loginUrl}?error=missing_token`, 302);
  }

  try {
    const raw = await env.AUTH_KV.get(`token:${token}`);

    if (!raw) {
      return Response.redirect(`${loginUrl}?error=invalid_or_expired`, 302);
    }

    const { email, expires } = JSON.parse(raw);

    if (Date.now() > expires) {
      await env.AUTH_KV.delete(`token:${token}`);
      return Response.redirect(`${loginUrl}?error=expired`, 302);
    }

    await env.AUTH_KV.delete(`token:${token}`);

    const sessionId = crypto.randomUUID();
    const sessionExpires = Date.now() + 8 * 60 * 60 * 1000;

    await env.AUTH_KV.put(
      `session:${sessionId}`,
      JSON.stringify({ email, expires: sessionExpires }),
      { expirationTtl: 28800 }
    );

    return new Response(null, {
      status: 302,
      headers: {
        'Location': appUrl,
        'Set-Cookie': [
          `cw_session=${sessionId}`,
          'HttpOnly',
          'Secure',
          'SameSite=Lax',
          'Path=/',
          'Max-Age=28800',
        ].join('; '),
      },
    });

  } catch (err) {
    console.error('Verify error:', err);
    return Response.redirect(`${loginUrl}?error=server_error`, 302);
  }
}
