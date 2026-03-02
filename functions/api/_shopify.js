/**
 * Shared Shopify API helper — token rotation for Dev Dashboard apps
 *
 * Shopify Dev Dashboard apps use rotating tokens:
 *   - Access tokens expire after ~24 hours
 *   - Refresh tokens are single-use and rotate on each exchange
 *   - Each refresh returns a NEW access token AND a NEW refresh token
 *
 * Token resolution order:
 *   1. SHOPIFY_TOKEN env var — static Admin API token (shpat_xxx)
 *      Works for custom apps created in Shopify Admin. Skips rotation.
 *   2. KV cached access token — from a previous successful rotation
 *   3. Refresh token rotation — exchange refresh token for new tokens
 *      Uses KV-stored refresh token first, falls back to env var.
 *
 * Environment variables (set in Cloudflare Pages dashboard):
 *   SHOPIFY_STORE          – e.g. camera-west.myshopify.com
 *   SHOPIFY_CLIENT_ID      – Client ID from Shopify Dev Dashboard
 *   SHOPIFY_CLIENT_SECRET  – Client secret
 *   SHOPIFY_REFRESH_TOKEN  – Initial refresh token from Dev Dashboard
 *
 * KV keys (AUTH_KV):
 *   shopify_access_token   – cached access token
 *   shopify_refresh_token  – latest rotated refresh token
 */

const KV_ACCESS  = 'shopify_access_token';
const KV_REFRESH = 'shopify_refresh_token';

/**
 * Get a valid Shopify access token, refreshing if necessary.
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

  // 3. Rotate: exchange refresh token for a new access + refresh token
  //    Prefer the KV-stored refresh token (from last rotation) over the
  //    env var (initial token from the Dev Dashboard).
  const refreshToken = (kv && await kv.get(KV_REFRESH)) || env.SHOPIFY_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error(
      'Shopify API token not configured. Set SHOPIFY_REFRESH_TOKEN (from the ' +
      'Shopify Dev Dashboard) as a secret env var in Cloudflare, or set ' +
      'SHOPIFY_TOKEN for a static Admin API token.'
    );
  }

  const tokenRes = await fetch(
    `https://${env.SHOPIFY_STORE}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
      }),
    }
  );

  if (!tokenRes.ok) {
    const body = await tokenRes.text();

    // Clear stale KV refresh token so we don't keep retrying it
    if (kv) await kv.delete(KV_REFRESH);

    throw new Error(
      `Shopify token refresh failed (${tokenRes.status}). ` +
      `The refresh token is likely expired or already used. ` +
      `Generate a new one in the Shopify Dev Dashboard → Settings → ` +
      `Refresh token, then update SHOPIFY_REFRESH_TOKEN in Cloudflare. ` +
      `Detail: ${body.slice(0, 200)}`
    );
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  const newRefresh  = tokenData.refresh_token;

  // Cache tokens in KV
  if (kv) {
    // Cache access token for 23 hours (tokens last ~24h)
    await kv.put(KV_ACCESS, accessToken, { expirationTtl: 82800 });

    // Persist the new single-use refresh token (replaces the old one)
    if (newRefresh) {
      await kv.put(KV_REFRESH, newRefresh);
    }
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
    // Token expired or invalid — clear cache so the next request re-rotates
    if (env.AUTH_KV) {
      await env.AUTH_KV.delete(KV_ACCESS);
    }
    throw new Error(
      `Shopify ${res.status} — token may be invalid. Check your app scopes ` +
      `(read_customers, write_customers, read_products, read_collections) ` +
      `and environment variables.`
    );
  }

  if (!res.ok) throw new Error(`Shopify returned ${res.status}`);

  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');
  return data.data;
}
