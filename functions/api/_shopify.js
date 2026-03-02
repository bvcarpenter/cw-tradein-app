/**
 * Shared Shopify API helper — Client Credentials for Dev Dashboard apps
 *
 * Dev Dashboard apps use the OAuth 2.0 Client Credentials grant:
 *   - POST client_id + client_secret to get an access token
 *   - Access tokens are valid for 24 hours
 *   - No refresh token needed — just re-request when expired
 *
 * Token resolution order:
 *   1. SHOPIFY_TOKEN env var — static Admin API token (shpat_xxx)
 *      Works for custom apps created in Shopify Admin. Skips OAuth.
 *   2. KV cached access token — from a previous client_credentials grant
 *   3. Client credentials grant — request a new 24h access token
 *
 * Environment variables (set in Cloudflare Pages dashboard):
 *   SHOPIFY_STORE          – e.g. camera-west.myshopify.com
 *   SHOPIFY_CLIENT_ID      – Client ID from Shopify Dev Dashboard
 *   SHOPIFY_CLIENT_SECRET  – Client secret from Shopify Dev Dashboard
 */

const KV_ACCESS = 'shopify_access_token';

/**
 * Get a valid Shopify access token via client credentials grant.
 */
export async function getShopifyToken(env) {
  // 1. Static token (custom apps created in Shopify Admin)
  if (env.SHOPIFY_TOKEN) return env.SHOPIFY_TOKEN;

  const kv = env.AUTH_KV;

  // 2. Cached access token in KV (still valid)
  if (kv) {
    const cached = await kv.get(KV_ACCESS);
    if (cached) return cached;
  }

  // 3. Client credentials grant — exchange client_id + client_secret for token
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    throw new Error(
      'Shopify API not configured. Set SHOPIFY_CLIENT_ID and ' +
      'SHOPIFY_CLIENT_SECRET from the Dev Dashboard, or set ' +
      'SHOPIFY_TOKEN for a static Admin API token.'
    );
  }

  const tokenRes = await fetch(
    `https://${env.SHOPIFY_STORE}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
      }),
    }
  );

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(
      `Shopify client_credentials grant failed (${tokenRes.status}). ` +
      `Check SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in Cloudflare env vars. ` +
      `Detail: ${body.slice(0, 300)}`
    );
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  if (!accessToken) {
    throw new Error(
      'Shopify returned no access_token. Response keys: ' +
      Object.keys(tokenData).join(', ')
    );
  }

  // Cache access token for 23 hours (tokens last 24h)
  if (kv) {
    await kv.put(KV_ACCESS, accessToken, { expirationTtl: 82800 });
  }

  return accessToken;
}

/**
 * Execute a Shopify Admin GraphQL query.
 */
export async function shopifyGQL(env, query, variables) {
  const token = await getShopifyToken(env);

  const res = await fetch(
    `https://${env.SHOPIFY_STORE}/admin/api/2024-10/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (res.status === 401 || res.status === 403) {
    // Token expired or invalid — clear cache so the next request gets a new one
    if (env.AUTH_KV) {
      await env.AUTH_KV.delete(KV_ACCESS);
    }
    throw new Error(
      `Shopify ${res.status} — token rejected. ` +
      `Check your app scopes (read_customers, write_customers, read_products, read_collections).`
    );
  }

  if (!res.ok) throw new Error(`Shopify returned ${res.status}`);

  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');
  return data.data;
}
