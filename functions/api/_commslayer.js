/**
 * CommsLayer (conversation/inbox) integration helper.
 *
 * Manages contacts, conversations, and messages so that every trade-in
 * is tracked as a "ticket" inside CommsLayer and every outbound email
 * (estimate, label, confirmation) is reflected in the conversation thread.
 *
 * Required env:
 *   COMMSLAYER_API_TOKEN   — Bearer token for the integration API
 *   COMMSLAYER_INBOX_ID    — Inbox ID to create conversations in
 *
 * Base URL: https://app.commslayer.com/api/integration/v1
 */

const BASE = 'https://app.commslayer.com/api/integration/v1';

function headers(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/* ── Contacts ──────────────────────────────────────────── */

/**
 * Find a contact by email. Returns the contact object or null.
 */
export async function findContactByEmail(env, email) {
  const r = await fetch(
    `${BASE}/contacts/search?email=${encodeURIComponent(email)}`,
    { headers: headers(env.COMMSLAYER_API_TOKEN) },
  );
  if (!r.ok) return null;
  const { data } = await r.json();
  return data?.length ? data[0] : null;
}

/**
 * Create a contact. Returns the new contact object.
 */
export async function createContact(env, { name, email, phone }) {
  const contact = { name, email };
  if (phone) contact.phone_number = phone;
  const r = await fetch(`${BASE}/contacts`, {
    method: 'POST',
    headers: headers(env.COMMSLAYER_API_TOKEN),
    body: JSON.stringify({ contact }),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error(`CommsLayer create contact failed (${r.status}): ${err}`);
  }
  return (await r.json()).data;
}

/**
 * Find or create a contact by email. Returns the contact object.
 */
export async function findOrCreateContact(env, { name, email, phone }) {
  const existing = await findContactByEmail(env, email);
  if (existing) return existing;
  return createContact(env, { name, email, phone });
}

/* ── Conversations ─────────────────────────────────────── */

/**
 * Create a new conversation for a contact.
 * Sets custom_attributes with the trade-in ID for ticket-style tracking.
 */
export async function createConversation(env, { contactId, tradeInId, customAttributes }) {
  const conversation = {
    contact_id: contactId,
    inbox_id: parseInt(env.COMMSLAYER_INBOX_ID, 10),
    custom_attributes: {
      trade_in_id: tradeInId,
      ...customAttributes,
    },
  };
  const r = await fetch(`${BASE}/conversations`, {
    method: 'POST',
    headers: headers(env.COMMSLAYER_API_TOKEN),
    body: JSON.stringify({ conversation }),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error(`CommsLayer create conversation failed (${r.status}): ${err}`);
  }
  return (await r.json()).data;
}

/**
 * Update custom_attributes on an existing conversation.
 */
export async function updateConversation(env, conversationId, customAttributes) {
  const r = await fetch(`${BASE}/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: headers(env.COMMSLAYER_API_TOKEN),
    body: JSON.stringify({ conversation: { custom_attributes: customAttributes } }),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error(`CommsLayer update conversation failed (${r.status}): ${err}`);
  }
  return (await r.json()).data;
}

/**
 * Search conversations by trade-in ID in custom_attributes.
 * Returns the first matching conversation or null.
 */
export async function findConversationByTradeInId(env, tradeInId) {
  const r = await fetch(
    `${BASE}/conversations?custom_attributes[trade_in_id]=${encodeURIComponent(tradeInId)}`,
    { headers: headers(env.COMMSLAYER_API_TOKEN) },
  );
  if (!r.ok) return null;
  const { data } = await r.json();
  if (!data?.length) return null;
  return data.find(c => c.custom_attributes?.trade_in_id === tradeInId) || null;
}

/* ── Messages ──────────────────────────────────────────── */

/**
 * Add a message to a conversation.
 * Uses message_type "incoming" since the API only supports incoming messages.
 * Set private=true for internal notes visible only to agents.
 * content_type defaults to 'text'; set to 'input_email' for rich HTML.
 */
export async function addMessage(env, conversationId, { content, isPrivate = false, contentType }) {
  const message = {
    content,
    message_type: 'incoming',
    private: isPrivate,
  };
  if (contentType) message.content_type = contentType;
  const r = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: headers(env.COMMSLAYER_API_TOKEN),
    body: JSON.stringify({ message }),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error(`CommsLayer add message failed (${r.status}): ${err}`);
  }
  return (await r.json()).data;
}

/* ── Agents / Assignment ──────────────────────────────────── */

/**
 * Assign a conversation to an agent by updating assignee_id.
 */
export async function assignConversation(env, conversationId, assigneeId) {
  const r = await fetch(`${BASE}/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: headers(env.COMMSLAYER_API_TOKEN),
    body: JSON.stringify({ conversation: { assignee_id: assigneeId } }),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error(`CommsLayer assign conversation failed (${r.status}): ${err}`);
  }
  return (await r.json()).data;
}

/**
 * Search for an agent by email. Returns { id } or null.
 * Tries the integration search endpoint; falls back to listing agents.
 */
export async function findAgentByEmail(env, email) {
  if (!email) return null;
  const lower = email.toLowerCase();
  const r = await fetch(
    `${BASE}/agents?email=${encodeURIComponent(lower)}`,
    { headers: headers(env.COMMSLAYER_API_TOKEN) },
  );
  if (r.ok) {
    const body = await r.json();
    const list = body.data || body;
    if (Array.isArray(list)) {
      const match = list.find(a => (a.email || '').toLowerCase() === lower);
      if (match) return match;
    }
  }
  return null;
}

/* ── High-level orchestrators ──────────────────────────── */

/**
 * Log a trade-in event to CommsLayer.
 *
 * Finds or creates the contact, finds or creates the conversation
 * (linked to the trade-in ID), then posts the message.
 *
 * @param {object} env             — Cloudflare env with COMMSLAYER_API_TOKEN & COMMSLAYER_INBOX_ID
 * @param {object} customer        — { first, last, email, phone }
 * @param {string} tradeInId       — e.g. "CWTI-260330-A7K2"
 * @param {string} content         — message body (plain text / markdown)
 * @param {object} [opts]          — { isPrivate, customAttributes, contentType, assignToEmail }
 */
export async function logTradeInEvent(env, { customer, tradeInId, content, isPrivate = false, customAttributes = {}, contentType, assignToEmail }) {
  if (!env.COMMSLAYER_API_TOKEN || !env.COMMSLAYER_INBOX_ID) {
    console.warn('CommsLayer not configured — skipping event log');
    return null;
  }

  try {
    const custName = [customer.first, customer.last].filter(Boolean).join(' ') || customer.email;

    // 1. Find or create the contact
    const contact = await findOrCreateContact(env, {
      name: custName,
      email: customer.email,
      phone: customer.phone,
    });

    // 2. Find existing conversation for this trade-in, or create one
    let conversation = tradeInId ? await findConversationByTradeInId(env, tradeInId) : null;
    if (!conversation) {
      conversation = await createConversation(env, {
        contactId: contact.id,
        tradeInId: tradeInId || 'unassigned',
        customAttributes,
      });
    } else if (Object.keys(customAttributes).length) {
      await updateConversation(env, conversation.id, {
        ...conversation.custom_attributes,
        ...customAttributes,
      });
    }

    // 3. Post the message
    const message = await addMessage(env, conversation.id, { content, isPrivate, contentType });

    // 4. Auto-assign conversation to the associate who sent the email
    if (assignToEmail) {
      try {
        const agent = await findAgentByEmail(env, assignToEmail);
        if (agent?.id) {
          await assignConversation(env, conversation.id, agent.id);
        }
      } catch (assignErr) {
        console.warn('CommsLayer agent assignment failed:', assignErr.message);
      }
    }

    return { contact, conversation, message };
  } catch (err) {
    console.error('CommsLayer logTradeInEvent error:', err);
    return null;
  }
}
