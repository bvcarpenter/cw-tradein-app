/**
 * NetSuite OAuth 1.0 Token-Based Authentication (TBA) helper.
 *
 * Signs requests with HMAC-SHA256 per NetSuite's TBA spec.
 * Uses Web Crypto API (available in Cloudflare Workers).
 */

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function generateNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  for (const b of bytes) nonce += chars[b % chars.length];
  return nonce;
}

async function hmacSha256(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/**
 * Call a NetSuite RESTlet with OAuth 1.0 TBA.
 *
 * @param {object} env        — Cloudflare env bindings
 * @param {string} method     — HTTP method (POST, GET, etc.)
 * @param {string} url        — Full RESTlet URL
 * @param {object} [body]     — JSON body for POST/PUT
 * @returns {Promise<object>} — Parsed JSON response
 */
export async function netsuiteRequest(env, method, url, body, extraHeaders) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNonce();

  const oauthParams = {
    oauth_consumer_key:     env.NS_CONSUMER_KEY,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp:        timestamp,
    oauth_token:            env.NS_TOKEN_ID,
    oauth_version:          '1.0',
  };

  // Parse URL to separate base URL and query params
  const urlObj = new URL(url);
  const allParams = { ...oauthParams };
  for (const [k, v] of urlObj.searchParams) {
    allParams[k] = v;
  }

  // Sort parameters and build param string
  const paramStr = Object.keys(allParams)
    .sort()
    .map(k => percentEncode(k) + '=' + percentEncode(allParams[k]))
    .join('&');

  // Base string: METHOD&url(without query)&params
  const baseUrl = urlObj.origin + urlObj.pathname;
  const baseString = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(paramStr),
  ].join('&');

  // Signing key: consumer_secret&token_secret
  const signingKey = percentEncode(env.NS_CONSUMER_SECRET) + '&' + percentEncode(env.NS_TOKEN_SECRET);
  const signature = await hmacSha256(signingKey, baseString);

  // Build Authorization header
  const authHeader = 'OAuth ' + [
    `realm="${env.NS_ACCOUNT_ID}"`,
    `oauth_consumer_key="${percentEncode(oauthParams.oauth_consumer_key)}"`,
    `oauth_token="${percentEncode(oauthParams.oauth_token)}"`,
    `oauth_signature_method="HMAC-SHA256"`,
    `oauth_timestamp="${timestamp}"`,
    `oauth_nonce="${percentEncode(nonce)}"`,
    `oauth_version="1.0"`,
    `oauth_signature="${percentEncode(signature)}"`,
  ].join(', ');

  const headers = {
    'Authorization': authHeader,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  const fetchOpts = { method, headers };
  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    fetchOpts.body = JSON.stringify(body);
  }

  const res = await fetch(url, fetchOpts);

  if (res.status === 204) {
    const loc = res.headers.get('Location') || '';
    const idMatch = loc.match(/\/(\d+)$/);
    return { success: true, id: idMatch ? idMatch[1] : undefined };
  }

  const text = await res.text();

  if (!text || !text.trim()) {
    throw new Error(`NetSuite returned empty response (HTTP ${res.status}). Check TBA credentials and RESTlet deployment.`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`NetSuite returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text.slice(0, 300);
    throw new Error(`NetSuite ${res.status}: ${msg}`);
  }

  return data;
}
