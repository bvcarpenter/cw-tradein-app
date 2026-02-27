/**
 * GET /api/auth/session
 *
 * Returns the current session info if valid.
 * Called by the app on load to check if the user is authenticated.
 */

export async function onRequestGet({ request, env }) {
  const corsHeaders = {
    'Content-Type': 'application/json',
  };

  try {
    const cookieHeader = request.headers.get('Cookie') || '';
    const sessionId = parseCookie(cookieHeader, 'cw_session');

    if (!sessionId) {
      return Response.json({ authenticated: false }, { headers: corsHeaders });
    }

    const raw = await env.AUTH_KV.get(`session:${sessionId}`);

    if (!raw) {
      return Response.json({ authenticated: false }, { headers: corsHeaders });
    }

    const { email, expires } = JSON.parse(raw);

    if (Date.now() > expires) {
      await env.AUTH_KV.delete(`session:${sessionId}`);
      return Response.json({ authenticated: false }, { headers: corsHeaders });
    }

    return Response.json({ authenticated: true, email }, { headers: corsHeaders });

  } catch (err) {
    return Response.json({ authenticated: false }, { headers: corsHeaders });
  }
}

/**
 * POST /api/auth/session (logout)
 */
export async function onRequestPost({ request, env }) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const sessionId = parseCookie(cookieHeader, 'cw_session');

  if (sessionId) {
    await env.AUTH_KV.delete(`session:${sessionId}`);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'cw_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    },
  });
}

function parseCookie(cookieStr, name) {
  const match = cookieStr.split(';').map(c => c.trim())
    .find(c => c.startsWith(`${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}
