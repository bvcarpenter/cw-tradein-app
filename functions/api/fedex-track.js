/**
 * POST /api/fedex-track
 * Check FedEx tracking status for one or more tracking numbers.
 *
 * Body: { trackingNumbers: ["7489xxxxx", ...] }
 * Returns: { results: [{ trackingNumber, status, statusDetail, delivered }, ...] }
 */
import { trackFedExShipment } from './_fedex.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const { trackingNumbers } = await request.json();
  if (!Array.isArray(trackingNumbers) || !trackingNumbers.length) {
    return json({ error: 'trackingNumbers array required' }, 400);
  }

  const results = await Promise.all(trackingNumbers.map(async tn => {
    try {
      const r = await trackFedExShipment(env, tn);
      return { trackingNumber: tn, ...r };
    } catch (err) {
      return { trackingNumber: tn, status: 'ERROR', statusDetail: err.message, delivered: false };
    }
  }));

  return json({ results });
}
