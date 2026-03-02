/**
 * POST /api/store-credit — Issue Shopify store credit to a customer
 * and append a timeline note with item details.
 *
 * Body: { customerId, amount, note, timelineNote }
 *   customerId   — Shopify customer GID (e.g. "gid://shopify/Customer/12345")
 *   amount       — Dollar amount (number)
 *   note         — Short note for the store credit transaction
 *   timelineNote — Longer note with item details to append to customer notes
 *
 * Required scopes: write_store_credit_account_transactions, write_customers, read_customers
 */

import { shopifyGQL, getShopifyToken } from './_shopify.js';

const cors = { 'Content-Type': 'application/json' };

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { customerId, amount, note, timelineNote } = body;
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

    // Append timeline note to Shopify customer notes
    let noteAppended = false;
    if (timelineNote) {
      try {
        const numericId = customerId.replace(/\D/g, '');
        const token = await getShopifyToken(env);

        // Read current note
        const custRes = await fetch(
          `https://${env.SHOPIFY_STORE}/admin/api/2024-10/customers/${numericId}.json`,
          { headers: { 'X-Shopify-Access-Token': token } }
        );
        const custData = await custRes.json();
        const existing = custData.customer?.note || '';
        const updated = existing ? existing + '\n\n' + timelineNote : timelineNote;

        // Update customer with appended note
        const updRes = await fetch(
          `https://${env.SHOPIFY_STORE}/admin/api/2024-10/customers/${numericId}.json`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': token,
            },
            body: JSON.stringify({ customer: { id: Number(numericId), note: updated } }),
          }
        );
        noteAppended = updRes.ok;
      } catch (noteErr) {
        console.warn('Failed to append customer note:', noteErr);
      }
    }

    return Response.json({
      storeCredit: {
        credited: txn.amount.amount,
        currency: txn.amount.currencyCode,
        balance:  txn.account.balance.amount,
      },
      noteAppended,
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
