/**
 * GET /api/auth/shopify-callback?code=...&shop=...&state=...&hmac=...
 *
 * Handles the Shopify OAuth callback. Exchanges the authorization code for
 * an offline access token and stores it in KV.
 *
 * Required env vars: SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, APP_URL
 */

export async function onRequestGet({ request, env }) {
  const url   = new URL(request.url);
  const code  = url.searchParams.get('code');
  const shop  = url.searchParams.get('shop');
  const state = url.searchParams.get('state');
  const hmac  = url.searchParams.get('hmac');

  // --- Verify state nonce (CSRF protection) ---
  if (env.AUTH_KV && state) {
    const valid = await env.AUTH_KV.get(`shopify_nonce:${state}`);
    if (!valid) {
      return new Response('Invalid or expired state parameter. Please try installing again.', { status: 403 });
    }
    await env.AUTH_KV.delete(`shopify_nonce:${state}`);
  }

  // --- Verify HMAC signature ---
  if (hmac && env.SHOPIFY_CLIENT_SECRET) {
    const params = new URLSearchParams(url.search);
    params.delete('hmac');
    params.sort();
    const message = params.toString();

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.SHOPIFY_CLIENT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    const digest = [...new Uint8Array(sig)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (digest !== hmac) {
      return new Response('Invalid HMAC signature.', { status: 403 });
    }
  }

  // --- Verify shop matches expected store ---
  if (shop && shop !== env.SHOPIFY_STORE) {
    return new Response(`Shop mismatch: expected ${env.SHOPIFY_STORE}, got ${shop}`, { status: 403 });
  }

  if (!code) {
    return new Response('Missing authorization code.', { status: 400 });
  }

  // --- Exchange authorization code for offline access token ---
  const tokenRes = await fetch(
    `https://${env.SHOPIFY_STORE}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
        code,
      }),
    }
  );

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    return new Response(
      `Token exchange failed (${tokenRes.status}): ${body}`,
      { status: 500 }
    );
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  if (!accessToken) {
    return new Response('No access_token in Shopify response.', { status: 500 });
  }

  // --- Store the offline token in KV (it never expires) ---
  if (env.AUTH_KV) {
    await env.AUTH_KV.put('shopify_access_token', accessToken);
  }

  // --- Redirect to app with success ---
  const appUrl = env.APP_URL || '';
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Shopify Connected</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px">
  <h1>Shopify Connected Successfully</h1>
  <p>Your Shopify store is now linked. Customer search and product lookup are ready.</p>
  <p><a href="${appUrl}/app">Go to the app &rarr;</a></p>
</body></html>`,
    { headers: { 'Content-Type': 'text/html' } }
  );
}
