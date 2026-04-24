/**
 * Worker entry point — routes API requests to handlers,
 * falls through to static assets for everything else.
 */
import { onRequestGet as sessionsGet, onRequestPost as sessionsPost, onRequestDelete as sessionsDelete, onRequestOptions as sessionsOptions } from '../functions/api/sessions.js';
import { onRequestGet as catalogGet } from '../functions/api/catalog.js';
import { onRequestGet as searchGet, onRequestOptions as searchOptions } from '../functions/api/search.js';
import { onRequestPost as tradeFormPost, onRequestOptions as tradeFormOptions } from '../functions/api/trade-form.js';
import { onRequestPost as customerAddressPost, onRequestOptions as customerAddressOptions } from '../functions/api/customer-address.js';
import { onRequestGet as customersGet, onRequestPost as customersPost, onRequestOptions as customersOptions } from '../functions/api/customers.js';
import { onRequestPost as customerMarketingPost, onRequestOptions as customerMarketingOptions } from '../functions/api/customer-marketing.js';
import { onRequestPost as tradeEmailPost, onRequestOptions as tradeEmailOptions } from '../functions/api/trade-email.js';
import { onRequestPost as storeCreditPost, onRequestOptions as storeCreditOptions } from '../functions/api/store-credit.js';
import { onRequestPost as creditMemoPost, onRequestOptions as creditMemoOptions } from '../functions/api/netsuite-credit-memo.js';
import { onRequestPost as nsItemsPost, onRequestOptions as nsItemsOptions } from '../functions/api/netsuite-items.js';
import { onRequestPost as estimateEmailPost, onRequestOptions as estimateEmailOptions } from '../functions/api/estimate-email.js';
import { onRequestPost as fedexLabelPost, onRequestOptions as fedexLabelOptions } from '../functions/api/fedex-label.js';
import { onRequestPost as fedexTrackPost, onRequestOptions as fedexTrackOptions } from '../functions/api/fedex-track.js';
import { onRequestPost as approveOtpPost, onRequestOptions as approveOtpOptions } from '../functions/api/approve-otp.js';
import { onRequestGet as productLookupGet, onRequestOptions as productLookupOptions } from '../functions/api/product-lookup.js';
import { onRequestPost as gdriveUploadPost, onRequestOptions as gdriveUploadOptions } from '../functions/api/gdrive-upload.js';
import { onRequestPost as createTicketPost, onRequestOptions as createTicketOptions } from '../functions/api/create-ticket.js';
import { onRequestPost as authRequestPost, onRequestOptions as authRequestOptions } from '../functions/api/auth/request.js';
import { onRequestGet as authSessionGet, onRequestPost as authSessionPost } from '../functions/api/auth/session.js';
import { onRequestGet as authVerifyGet } from '../functions/api/auth/verify.js';

function parseCookie(cookieStr, name) {
  const match = (cookieStr || '').split(';').map(c => c.trim())
    .find(c => c.startsWith(`${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

async function isAuthenticated(request, env) {
  const sessionId = parseCookie(request.headers.get('Cookie'), 'cw_session');
  if (!sessionId) return false;
  const raw = await env.AUTH_KV.get(`session:${sessionId}`);
  if (!raw) return false;
  const { expires } = JSON.parse(raw);
  return Date.now() <= expires;
}

const PUBLIC_PREFIXES = [
  '/login', '/api/auth/', '/trade-form', '/cdn-cgi/',
];

function isPublicPath(path) {
  if (PUBLIC_PREFIXES.some(p => path.startsWith(p))) return true;
  const ext = path.split('.').pop();
  if (['css', 'js', 'png', 'jpg', 'svg', 'ico', 'woff', 'woff2', 'ttf'].includes(ext)) return true;
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const c = { request, env, ctx };

    // ── Auth gate — redirect unauthenticated page requests to /login ──
    const isPage = path === '/' || path === '/app' || path === '/index.html' || path === '/app.html';
    if (isPage && !(await isAuthenticated(request, env))) {
      return Response.redirect(url.origin + '/login', 302);
    }

    // ── API routing ────────────────────────────────────────
    if (path === '/api/sessions') {
      if (method === 'OPTIONS') return sessionsOptions(c);
      if (method === 'GET')     return sessionsGet(c);
      if (method === 'POST')    return sessionsPost(c);
      if (method === 'DELETE')  return sessionsDelete(c);
    }

    if (path === '/api/catalog' && method === 'GET') {
      return catalogGet(c);
    }

    if (path === '/api/search') {
      if (method === 'OPTIONS') return searchOptions(c);
      if (method === 'GET')     return searchGet(c);
    }

    if (path === '/api/trade-form') {
      if (method === 'OPTIONS') return tradeFormOptions(c);
      if (method === 'POST')    return tradeFormPost(c);
    }

    if (path === '/api/customer-address') {
      if (method === 'OPTIONS') return customerAddressOptions(c);
      if (method === 'POST')    return customerAddressPost(c);
    }

    if (path === '/api/customers') {
      if (method === 'OPTIONS') return customersOptions(c);
      if (method === 'GET')     return customersGet(c);
      if (method === 'POST')    return customersPost(c);
    }

    if (path === '/api/trade-email') {
      if (method === 'OPTIONS') return tradeEmailOptions(c);
      if (method === 'POST')    return tradeEmailPost(c);
    }

    if (path === '/api/estimate-email') {
      if (method === 'OPTIONS') return estimateEmailOptions(c);
      if (method === 'POST')    return estimateEmailPost(c);
    }

    if (path === '/api/customer-marketing') {
      if (method === 'OPTIONS') return customerMarketingOptions(c);
      if (method === 'POST')    return customerMarketingPost(c);
    }

    if (path === '/api/store-credit') {
      if (method === 'OPTIONS') return storeCreditOptions(c);
      if (method === 'POST')    return storeCreditPost(c);
    }

    if (path === '/api/netsuite-credit-memo') {
      if (method === 'OPTIONS') return creditMemoOptions(c);
      if (method === 'POST')    return creditMemoPost(c);
    }

    if (path === '/api/netsuite-items') {
      if (method === 'OPTIONS') return nsItemsOptions(c);
      if (method === 'POST')    return nsItemsPost(c);
    }

    if (path === '/api/fedex-label') {
      if (method === 'OPTIONS') return fedexLabelOptions(c);
      if (method === 'POST')    return fedexLabelPost(c);
    }

    if (path === '/api/fedex-track') {
      if (method === 'OPTIONS') return fedexTrackOptions(c);
      if (method === 'POST')    return fedexTrackPost(c);
    }

    if (path === '/api/product-lookup') {
      if (method === 'OPTIONS') return productLookupOptions(c);
      if (method === 'GET')     return productLookupGet(c);
    }

    if (path === '/api/approve-otp') {
      if (method === 'OPTIONS') return approveOtpOptions(c);
      if (method === 'POST')    return approveOtpPost(c);
    }

    if (path === '/api/gdrive-upload') {
      if (method === 'OPTIONS') return gdriveUploadOptions(c);
      if (method === 'POST')    return gdriveUploadPost(c);
    }

    if (path === '/api/create-ticket') {
      if (method === 'OPTIONS') return createTicketOptions(c);
      if (method === 'POST')    return createTicketPost(c);
    }

    if (path === '/api/auth/request') {
      if (method === 'OPTIONS') return authRequestOptions(c);
      if (method === 'POST')    return authRequestPost(c);
    }

    if (path === '/api/auth/session') {
      if (method === 'GET')  return authSessionGet(c);
      if (method === 'POST') return authSessionPost(c);
    }

    if (path === '/api/auth/verify' && method === 'GET') {
      return authVerifyGet(c);
    }

    // ── Static assets ──────────────────────────────────────
    const res = await env.ASSETS.fetch(request);

    // Add CORS headers for embeddable assets (loaded from Shopify pages)
    if (path.startsWith('/trade-form')) {
      const corsRes = new Response(res.body, res);
      corsRes.headers.set('Access-Control-Allow-Origin', '*');
      return corsRes;
    }

    return res;
  }
};
