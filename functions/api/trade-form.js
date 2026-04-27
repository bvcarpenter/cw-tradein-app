/**
 * POST /api/trade-form — Receive a public trade-in form submission
 * and create a draft session in KV for staff to review.
 *
 * Body: {
 *   customer: { first, last, email, phone },
 *   intention: "Trade In" | "Sell Outright",
 *   location: "Palm Springs" | "San Francisco" | "SoHo — New York" | "shipping",
 *   notes: "...",
 *   items: [{
 *     description, condition, grade,
 *     notes, photoLinks: [url, ...]
 *   }]
 * }
 *
 * Creates a session with key "cwti_<timestamp>" and source:"web-form"
 * so the internal app can identify web submissions.
 */

import { generateTradeInId } from './_tradein-id.js';
import { logTradeInEvent } from './_commslayer.js';

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

  const { customer, intention, location, notes, items } = body;

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
  const tradeInId = generateTradeInId();
  const custName = [customer.first, customer.last].filter(Boolean).join(' ');

  const sessionData = {
    savedAt: new Date(now).toISOString(),
    key,
    tradeInId,
    name: custName,
    source: 'web-form',
    status: 'pending',
    intention: (intention || '').trim(),
    customer: {
      first: (customer.first || '').trim(),
      last: (customer.last || '').trim(),
      email: (customer.email || '').trim(),
      phone: (customer.phone || '').trim(),
    },
    loc: location || '',
    shipping: { str: '', city: '', st: '', zip: '' },
    customerNotes: (notes || '').trim(),
    items: items.map((it, i) => ({
      id: now + i,
      name: (it.description || '').trim(),
      customerCondition: (it.condition || '').trim(),
      grade: (it.grade || '').trim(),
      customerNotes: (it.notes || '').trim(),
      photoLinks: it.photoLinks || [],
      // Unpriced — staff fills in from the app
      vendor: (it.vendor || '').trim(),
      systemId: (it.systemId || '').trim(),
      itemType: (it.itemType || '').trim(),
      medium: (it.medium || '').trim(),
      format: '',
      category: (it.category || '').trim(),
      sku: (it.sku || '').trim(),
      serial: '',
      catalog: '',
      accessories: [],
      notes: '',
      retail: parseFloat(it.retail) || 0,
      tradein: 0,
      outright: 0,
      net: 0,
      priceType: intention === 'Sell Outright' ? 'outright' : 'tradein',
      svcCharge: 0,
      svcReason: '',
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

    const index = await getIndex(kv);
    index.push({
      key,
      name: custName,
      savedAt: sessionData.savedAt,
      source: 'web-form',
    });
    await kv.put(INDEX_KEY, JSON.stringify(index));

    // Log to CommsLayer (non-blocking)
    const appOrigin = new URL(request.url).origin;
    const sessionLink = `${appOrigin}/?session=${encodeURIComponent(key)}`;
    const itemList = items.map((it, i) => `  ${i + 1}. ${it.description || 'Unknown'} (${it.condition || 'N/A'})`).join('\n');
    const csContent = [
      `🆕 Trade-in request submitted via web form`,
      `Trade-In ID: ${tradeInId}`,
      `Customer: ${custName}`,
      `Intention: ${intention || 'N/A'}`,
      `Location: ${location || 'N/A'}`,
      `\nItems:\n${itemList}`,
      notes ? `\nCustomer Notes: ${notes}` : '',
      `\nStatus: Pending review`,
      `\n[Open in Trade-In App →](${sessionLink})`,
    ].filter(Boolean).join('\n');

    logTradeInEvent(env, {
      customer: {
        first: customer.first,
        last: customer.last,
        email: customer.email,
        phone: customer.phone,
      },
      tradeInId,
      content: csContent,
      customAttributes: {
        intention: intention || '',
        location: location || '',
        status: 'pending_review',
        source: 'web-form',
        session_link: sessionLink,
      },
    }).then(async (result) => {
      if (!result?.conversation) return;
      const convId = result.conversation.id;
      const displayId = result.conversation.display_id || convId;
      const accountId = result.conversation.account_id || env.COMMSLAYER_ACCOUNT_ID;
      const convUrl = accountId
        ? `https://app.commslayer.com/app/accounts/${accountId}/conversations/${displayId}`
        : '';

      // Save conversation link back to the session so staff sees it when they load
      try {
        const raw = await kv.get(key);
        if (raw) {
          const sess = JSON.parse(raw);
          sess.commslayerId = String(convId);
          sess.commslayerUrl = convUrl;
          await kv.put(key, JSON.stringify(sess));
        }
      } catch (e) {
        console.error('Failed to update session with conversation ID:', e);
      }
    }).catch(err => console.error('CommsLayer trade-form log error:', err));

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
