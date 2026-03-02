/**
 * POST /api/store-credit — Issue a Shopify gift card (store credit) to a customer.
 *
 * Body: { customerId, amount, note }
 *   customerId — Shopify customer GID (e.g. "gid://shopify/Customer/12345")
 *   amount     — Dollar amount (number)
 *   note       — Optional note (e.g. credit memo reference)
 */

import { shopifyGQL } from './_shopify.js';

const cors = { 'Content-Type': 'application/json' };

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { customerId, amount, note } = body;
  if (!customerId || !amount || amount <= 0) {
    return Response.json(
      { error: 'customerId and a positive amount are required' },
      { status: 400, headers: cors }
    );
  }

  const gql = `
    mutation GiftCardCreate($input: GiftCardCreateInput!) {
      giftCardCreate(input: $input) {
        giftCard {
          id
          lastCharacters
          balance { amount currencyCode }
        }
        userErrors { field message }
      }
    }
  `;

  const input = {
    initialValue: String(amount),
    customerId,
    note: note || 'Trade-in store credit',
  };

  try {
    const data = await shopifyGQL(env, gql, { input });
    const result = data.giftCardCreate;
    if (result.userErrors?.length) {
      return Response.json(
        { error: result.userErrors.map(e => e.message).join('; ') },
        { status: 422, headers: cors }
      );
    }
    const gc = result.giftCard;
    return Response.json({
      giftCard: {
        id: gc.id,
        lastCharacters: gc.lastCharacters,
        balance: gc.balance.amount,
        currency: gc.balance.currencyCode,
      }
    }, { headers: cors });
  } catch (err) {
    console.error('Store credit error:', err);
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
