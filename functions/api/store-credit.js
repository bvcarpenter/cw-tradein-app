/**
 * POST /api/store-credit — Issue Shopify store credit to a customer.
 *
 * Body: { customerId, amount, note }
 *   customerId — Shopify customer GID (e.g. "gid://shopify/Customer/12345")
 *   amount     — Dollar amount (number)
 *   note       — Optional note (e.g. credit memo reference)
 *
 * Uses the storeCreditAccountCredit mutation. Passing a customer ID
 * as the account owner auto-creates the store credit account if needed.
 *
 * Required scope: write_store_credit_account_transactions
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
    mutation StoreCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
      storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
        storeCreditAccountTransaction {
          amount { amount currencyCode }
          account {
            id
            balance { amount currencyCode }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    id: customerId,
    creditInput: {
      creditAmount: { amount: String(amount), currencyCode: 'USD' },
    },
  };

  try {
    const data = await shopifyGQL(env, gql, variables);
    const result = data.storeCreditAccountCredit;
    if (result.userErrors?.length) {
      return Response.json(
        { error: result.userErrors.map(e => e.message).join('; ') },
        { status: 422, headers: cors }
      );
    }
    const txn = result.storeCreditAccountTransaction;
    return Response.json({
      storeCredit: {
        credited: txn.amount.amount,
        currency: txn.amount.currencyCode,
        balance:  txn.account.balance.amount,
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
