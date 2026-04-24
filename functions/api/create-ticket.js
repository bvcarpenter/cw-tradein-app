/**
 * POST /api/create-ticket
 *
 * Creates a CommsLayer conversation at session start so the ticket number
 * can be used as the Trade-In ID (CWTI-{display_id}).
 *
 * Body: { tradeInId? }  — optional fallback ID if CommsLayer is unavailable
 * Returns: { ok, ticketId, conversationId, conversationUrl }
 */

import { findOrCreateContact, createConversation } from './_commslayer.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.COMMSLAYER_API_TOKEN || !env.COMMSLAYER_INBOX_ID) {
      return json({ ok: false, error: 'CommsLayer not configured' }, 503);
    }

    const body = await request.json().catch(() => ({}));

    const contact = await findOrCreateContact(env, {
      name: 'New Trade-In',
      email: 'tradein@camerawest.com',
    });

    const conversation = await createConversation(env, {
      contactId: contact.id,
      tradeInId: body.tradeInId || 'pending',
      customAttributes: { status: 'new' },
    });

    console.log('create-ticket conversation response:', JSON.stringify(conversation));

    const displayId = conversation.display_id ?? conversation.id;
    const ticketId = `CWTI-${displayId}`;
    const accountId = conversation.account_id || env.COMMSLAYER_ACCOUNT_ID;
    let conversationUrl = null;
    const convId = conversation.display_id || conversation.id;
    if (accountId) {
      conversationUrl = `https://app.commslayer.com/app/accounts/${accountId}/conversations/${convId}`;
    }

    return json({
      ok: true,
      ticketId,
      conversationId: conversation.id,
      displayId,
      conversationUrl,
      _debug: { keys: Object.keys(conversation || {}), display_id: conversation.display_id, id: conversation.id },
    });
  } catch (err) {
    console.error('create-ticket error:', err);
    return json({ ok: false, error: err.message }, 500);
  }
}
