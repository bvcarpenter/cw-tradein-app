/**
 * Shared Shopify API helper — OAuth token rotation
 *
 * Shopify no longer allows creating custom apps in the admin.
 * New apps use OAuth with rotating tokens:
 *   - Access tokens expire after ~1 hour
 *   - Refresh tokens last 90 days but are single-use
 *   - Each refresh returns a NEW access token AND refresh token
 *
 * Environment variables (set in Cloudflare Pages dashboard):
 *   SHOPIFY_STORE          – e.g. camerawest.myshopify.com
 *   SHOPIFY_CLIENT_ID      – API key from Shopify Partners / Dev Dashboard
 *   SHOPIFY_CLIENT_SECRET  – Client secret (shpss_...)
 *   SHOPIFY_REFRESH_TOKEN  – Initial refresh token (used only on first run)
 *
 * KV keys (AUTH_KV):
 *   shopify_access_token   – cached access token
 *   shopify_refresh_token  – latest refresh token (rotates on each exchange)
 */

const KV_ACCESS  = 'shopify_access_token';
const KV_REFRESH = 'shopify_refresh_token';

/**
 * Get a valid Shopify access token, refreshing if necessary.
 * Caches the token in KV with a 50-minute TTL (tokens last ~60 min).
 */
export async function getShopifyToken(env) {
  const kv = env.AUTH_KV;

  // 1. Check for a cached access token in KV
  if (kv) {
    const cached = await kv.get(KV_ACCESS);
    if (cached) return cached;
  }

  // 2. No valid cached token — exchange the refresh token for a new one
  const refreshToken = (kv && await kv.get(KV_REFRESH)) || env.SHOPIFY_REFRESH_TOKEN;

  if (!refreshToken) {
    const missing = ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_REFRESH_TOKEN', 'SHOPIFY_STORE']
      .filter(k => !env[k]);
    throw new Error(
      `Shopify auth not configured. Missing env vars: ${missing.length ? missing.join(', ') : 'none (but KV has no refresh token)'}. ` +
      `If you just added these in Cloudflare, trigger a new deployment for them to take effect.`
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
    throw new Error(
      `Shopify token refresh failed (${tokenRes.status}): ${body}`
    );
  }

  const tokenData = await tokenRes.json();
  const accessToken  = tokenData.access_token;
  const newRefresh   = tokenData.refresh_token;

  // 3. Cache the new tokens in KV
  if (kv) {
    // Cache access token for 50 minutes (tokens expire at 60 min)
    await kv.put(KV_ACCESS, accessToken, { expirationTtl: 3000 });

    // Persist the new refresh token (replaces the old single-use one)
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
    // Token may have expired between our check and the API call — clear cache
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
