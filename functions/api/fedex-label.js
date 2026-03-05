/**
 * POST /api/fedex-label — Generate a FedEx Express Saver One Rate shipping label.
 *
 * Body: {
 *   shipperName,          — Customer's full name
 *   shipperPhone,         — Customer's phone (optional)
 *   shipperStreet,        — Customer's street address
 *   shipperCity,          — Customer's city
 *   shipperState,         — Customer's state (2-letter)
 *   shipperZip,           — Customer's ZIP code
 *   destStore,            — Destination store name (e.g. "San Francisco")
 *   reference             — Optional reference string (e.g. CM number)
 * }
 *
 * Returns: { trackingNumber, labelPdf (base64), totalCharge }
 *
 * Required env: FEDEX_API_KEY, FEDEX_SECRET_KEY, FEDEX_ACCOUNT_NUMBER
 */

import { createFedExLabel } from './_fedex.js';

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

  // Validate required env — log which keys are missing for debugging
  const missingEnv = ['FEDEX_API_KEY', 'FEDEX_SECRET_KEY', 'FEDEX_ACCOUNT_NUMBER'].filter(k => !env[k]);
  if (missingEnv.length) {
    console.error('Missing FedEx env vars:', missingEnv.join(', '));
    return Response.json(
      { error: `FedEx credentials not configured: ${missingEnv.join(', ')}` },
      { status: 500, headers: cors },
    );
  }

  // Validate required fields
  const required = ['shipperName', 'shipperStreet', 'shipperCity', 'shipperState', 'shipperZip', 'destStore'];
  const missing = required.filter(f => !body[f]?.trim());
  if (missing.length) {
    return Response.json(
      { error: `Missing required fields: ${missing.join(', ')}` },
      { status: 400, headers: cors },
    );
  }

  try {
    const result = await createFedExLabel(
      env,
      {
        name: body.shipperName.trim(),
        phone: (body.shipperPhone || '').trim(),
        street: body.shipperStreet.trim(),
        city: body.shipperCity.trim(),
        state: body.shipperState.trim().toUpperCase(),
        zip: body.shipperZip.trim(),
      },
      body.destStore.trim(),
      (body.reference || '').trim() || undefined,
    );

    return Response.json({
      trackingNumber: result.trackingNumber,
      labelPdf: result.labelPdf,
      totalCharge: result.totalCharge,
    }, { headers: cors });

  } catch (err) {
    console.error('FedEx label error:', err);
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
