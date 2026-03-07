/**
 * POST /api/customer-marketing — update a customer's email marketing consent in Shopify
 *
 * Body: { email: string, acceptsMarketing: boolean }
 *
 * Finds the customer by email, then updates their emailMarketingConsent.
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

  const { email, acceptsMarketing } = body;
  if (!email) {
    return Response.json({ error: 'email is required' }, { status: 400, headers: cors });
  }

  try {
    // Step 1: Find customer by email
    const searchGql = `
      query FindCustomer($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
            }
          }
        }
      }
    `;
    const searchData = await shopifyGQL(env, searchGql, { query: `email:${email}` });
    const customer = searchData.customers?.edges?.[0]?.node;

    if (!customer) {
      return Response.json({ error: 'Customer not found', skipped: true }, { status: 404, headers: cors });
    }

    // Step 2: Update marketing consent
    const state = acceptsMarketing ? 'SUBSCRIBED' : 'UNSUBSCRIBED';
    const updateGql = `
      mutation UpdateMarketingConsent($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            email
            emailMarketingConsent {
              marketingState
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const updateData = await shopifyGQL(env, updateGql, {
      input: {
        id: customer.id,
        emailMarketingConsent: {
          marketingState: state,
          marketingOptInLevel: 'SINGLE_OPT_IN',
        },
      },
    });

    const result = updateData.customerUpdate;
    if (result.userErrors?.length) {
      return Response.json(
        { error: result.userErrors.map(e => e.message).join('; ') },
        { status: 422, headers: cors }
      );
    }

    return Response.json({
      updated: true,
      marketingState: result.customer.emailMarketingConsent?.marketingState,
    }, { headers: cors });
  } catch (err) {
    console.error('Customer marketing update error:', err);
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
