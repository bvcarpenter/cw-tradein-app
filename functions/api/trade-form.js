/**
 * POST /api/trade-form — Receive a public trade-in form submission
 * and create a draft session in KV for staff to review.
 *
 * Body: {
 *   customer: { first, last, email, phone },
 *   location: "Palm Springs" | "San Francisco" | "SoHo — New York" | "shipping",
 *   shipping?: { str, city, st, zip },
 *   items: [{ description, condition, serial, accessories, notes }]
 * }
 *
 * Creates a session with key "cwti_<timestamp>" and source:"web-form"
 * so the internal app can identify web submissions.
 */

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};
const INDEX_KEY = '__cwti_index__';

async function getIndex(kv) {
  try { const v = await kv.get(INDEX_KEY); return v ? JSON.parse(v) : []; } catch { return []; }
}

export async function onRequestPost({ request, env }) {
  const kv = env.AUTH_KV;
  if (!kv) {
    return Response.json(
      { error: 'Storage not configured' },
      { status: 503, headers: CORS }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS });
  }

  const { customer, location, shipping, items } = body;

  // Basic validation
  if (!customer?.first || !customer?.last || !customer?.email) {
    return Response.json(
      { error: 'First name, last name, and email are required' },
      { status: 400, headers: CORS }
    );
  }
  if (!items?.length) {
    return Response.json(
      { error: 'At least one item is required' },
      { status: 400, headers: CORS }
    );
  }

  const now = Date.now();
  const key = 'cwti_' + now;
  const custName = [customer.first, customer.last].filter(Boolean).join(' ');

  // Build session data matching the app's internal format.
  // Items from the web form are "draft" items — no pricing, no catalog match yet.
  const sessionData = {
    savedAt: new Date(now).toISOString(),
    key,
    name: custName,
    source: 'web-form',
    status: 'pending',
    customer: {
      first: (customer.first || '').trim(),
      last: (customer.last || '').trim(),
      email: (customer.email || '').trim(),
      phone: (customer.phone || '').trim(),
    },
    loc: location || '',
    shipping: location === 'shipping' && shipping ? {
      str: (shipping.str || '').trim(),
      city: (shipping.city || '').trim(),
      st: (shipping.st || '').trim(),
      zip: (shipping.zip || '').trim(),
    } : { str: '', city: '', st: '', zip: '' },
    items: items.map((it, i) => ({
      id: now + i,
      name: (it.description || '').trim(),
      customerCondition: (it.condition || '').trim(),
      serial: (it.serial || '').trim(),
      customerAccessories: (it.accessories || '').trim(),
      customerNotes: (it.notes || '').trim(),
      // Unpriced — staff will fill these in
      grade: '',
      retail: 0,
      tradein: 0,
      outright: 0,
      net: 0,
    })),
    cmNum: '',
    tracking: '',
    finalTot: '',
    assoc: '',
    txnDate: new Date(now).toISOString().split('T')[0],
    finalized: false,
  };

  try {
    await kv.put(key, JSON.stringify(sessionData));

    // Update the index
    const index = await getIndex(kv);
    index.push({
      key,
      name: custName,
      savedAt: sessionData.savedAt,
      source: 'web-form',
    });
    await kv.put(INDEX_KEY, JSON.stringify(index));

    return Response.json({ success: true, key }, { headers: CORS });
  } catch (err) {
    console.error('Trade form save error:', err);
    return Response.json({ error: 'Failed to save submission' }, { status: 500, headers: CORS });
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
