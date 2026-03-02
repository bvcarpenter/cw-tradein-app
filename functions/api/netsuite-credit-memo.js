/**
 * POST /api/netsuite-credit-memo — Create a Credit Memo in NetSuite.
 *
 * Body: {
 *   customerEmail, customerFirst, customerLast, customerPhone,
 *   items: [{ name, grade, serial, catalog, systemId, accessories, notes, net, tradein, priceType }],
 *   totalAmount, date, associate, issuedBy,
 *   location, shippingAddress
 * }
 *
 * Returns: { success, tranId, internalId }
 *
 * Required env: NS_ACCOUNT_ID, NS_CONSUMER_KEY, NS_CONSUMER_SECRET,
 *               NS_TOKEN_ID, NS_TOKEN_SECRET, NS_RESTLET_URL
 */

import { netsuiteRequest } from './_netsuite.js';

const cors = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  if (!env.NS_RESTLET_URL) {
    return Response.json(
      { error: 'NetSuite RESTlet URL not configured (NS_RESTLET_URL)' },
      { status: 500, headers: cors }
    );
  }

  if (!body.items?.length) {
    return Response.json(
      { error: 'At least one item is required' },
      { status: 400, headers: cors }
    );
  }

  try {
    const data = await netsuiteRequest(env, 'POST', env.NS_RESTLET_URL, body);

    if (!data.success) {
      return Response.json(
        { error: data.error || 'NetSuite returned an error' },
        { status: 422, headers: cors }
      );
    }

    return Response.json({
      success: true,
      tranId:     data.tranId,
      internalId: data.internalId,
    }, { headers: cors });

  } catch (err) {
    console.error('NetSuite credit memo error:', err);
    return Response.json({ error: err.message }, { status: 502, headers: cors });
  }
}

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
