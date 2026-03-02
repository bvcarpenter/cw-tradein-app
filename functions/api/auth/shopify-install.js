/**
 * GET /api/auth/shopify-install
 *
 * Initiates the Shopify OAuth flow. Redirects the store owner to Shopify's
 * authorization page. After they approve, Shopify redirects back to
 * /api/auth/shopify-callback with an authorization code.
 *
 * Required env vars: SHOPIFY_STORE, SHOPIFY_CLIENT_ID, APP_URL
 */

const SCOPES = 'read_products,read_collections,read_customers,write_customers';

export async function onRequestGet({ env }) {
  const shop     = env.SHOPIFY_STORE;
  const clientId = env.SHOPIFY_CLIENT_ID;
  const appUrl   = env.APP_URL;

  if (!shop || !clientId || !appUrl) {
    return new Response(
      'Missing required env vars: SHOPIFY_STORE, SHOPIFY_CLIENT_ID, APP_URL',
      { status: 500 }
    );
  }

  const redirectUri = `${appUrl}/api/auth/shopify-callback`;

  // Generate a nonce for CSRF protection
  const nonce = crypto.randomUUID();
  if (env.AUTH_KV) {
    await env.AUTH_KV.put(`shopify_nonce:${nonce}`, '1', { expirationTtl: 300 });
  }

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${clientId}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${nonce}`;

  return Response.redirect(authUrl, 302);
}
