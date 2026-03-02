/**
 * Worker entry point — routes API requests to handlers,
 * falls through to static assets for everything else.
 */
import { onRequestGet as sessionsGet, onRequestPost as sessionsPost, onRequestDelete as sessionsDelete, onRequestOptions as sessionsOptions } from '../functions/api/sessions.js';
import { onRequestGet as catalogGet } from '../functions/api/catalog.js';
import { onRequestGet as searchGet } from '../functions/api/search.js';
import { onRequestGet as customersGet, onRequestPost as customersPost, onRequestOptions as customersOptions } from '../functions/api/customers.js';
import { onRequestPost as storeCreditPost, onRequestOptions as storeCreditOptions } from '../functions/api/store-credit.js';
import { onRequestPost as creditMemoPost, onRequestOptions as creditMemoOptions } from '../functions/api/netsuite-credit-memo.js';
import { onRequestPost as authRequestPost, onRequestOptions as authRequestOptions } from '../functions/api/auth/request.js';
import { onRequestGet as authSessionGet, onRequestPost as authSessionPost } from '../functions/api/auth/session.js';
import { onRequestGet as authVerifyGet } from '../functions/api/auth/verify.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const c = { request, env, ctx };

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

    if (path === '/api/search' && method === 'GET') {
      return searchGet(c);
    }

    if (path === '/api/customers') {
      if (method === 'OPTIONS') return customersOptions(c);
      if (method === 'GET')     return customersGet(c);
      if (method === 'POST')    return customersPost(c);
    }

    if (path === '/api/store-credit') {
      if (method === 'OPTIONS') return storeCreditOptions(c);
      if (method === 'POST')    return storeCreditPost(c);
    }

    if (path === '/api/netsuite-credit-memo') {
      if (method === 'OPTIONS') return creditMemoOptions(c);
      if (method === 'POST')    return creditMemoPost(c);
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
    return env.ASSETS.fetch(request);
  }
};
