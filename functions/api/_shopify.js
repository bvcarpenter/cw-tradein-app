/**
 * Shared Shopify API helper
 *
 * Token resolution order:
 *   1. SHOPIFY_TOKEN env var — static Admin API token (shpat_xxx)
 *      Works for custom apps created in Shopify Admin.
 *   2. KV "shopify_access_token" — offline OAuth token stored by the
 *      /api/auth/shopify-install → /api/auth/shopify-callback flow.
 *      Offline tokens never expire.
 *
 * If neither is available the user is directed to run the OAuth install.
 */

const KV_TOKEN = 'shopify_access_token';

/**
 * Get a valid Shopify access token.
 */
export async function getShopifyToken(env) {
  // 1. Static token from env var (simplest path)
  if (env.SHOPIFY_TOKEN) return env.SHOPIFY_TOKEN;

  // 2. OAuth offline token stored in KV
  if (env.AUTH_KV) {
    const token = await env.AUTH_KV.get(KV_TOKEN);
    if (token) return token;
  }

  // 3. Nothing configured
  throw new Error(
    'Shopify API token not configured. ' +
    'Either set SHOPIFY_TOKEN as an env var (static Admin API token), ' +
    'or visit /api/auth/shopify-install to connect your Shopify store via OAuth.'
  );
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
    // Token is invalid — clear cached KV token so the next request
    // doesn't keep using it
    if (env.AUTH_KV) {
      await env.AUTH_KV.delete(KV_TOKEN);
    }
    throw new Error(
      `Shopify ${res.status} — token is invalid or lacks required scopes. ` +
      `Visit /api/auth/shopify-install to reconnect, or check your app scopes ` +
      `(read_customers, write_customers, read_products, read_collections).`
    );
  }

  if (!res.ok) throw new Error(`Shopify returned ${res.status}`);

  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');
  return data.data;
}
