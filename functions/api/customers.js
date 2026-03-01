/**
 * GET  /api/customers?q=jane         — search Shopify customers
 * POST /api/customers                — create a new Shopify customer
 *
 * Environment variables:
 *   SHOPIFY_STORE  – camerawest.myshopify.com
 *   SHOPIFY_TOKEN  – shpat_xxx (Admin API token)
 */

const cors = { 'Content-Type': 'application/json' };

async function shopifyGQL(env, query, variables) {
  const res = await fetch(
    `https://${env.SHOPIFY_STORE}/admin/api/2024-10/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': env.SHOPIFY_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  if (res.status === 403) throw new Error('Shopify 403 Forbidden – reinstall your app to activate the read_customers / write_customers scopes, then update SHOPIFY_TOKEN');
  if (!res.ok) throw new Error(`Shopify returned ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');
  return data.data;
}

// ── SEARCH ──────────────────────────────────────────────
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length < 2) {
    return Response.json({ customers: [] }, { headers: cors });
  }

  const gql = `
    query SearchCustomers($query: String!) {
      customers(first: 10, query: $query, sortKey: RELEVANCE) {
        edges {
          node {
            id
            firstName
            lastName
            email
            phone
          }
        }
      }
    }
  `;

  try {
    const searchQuery = `first_name:*${q}* OR last_name:*${q}* OR email:*${q}*`;
    const data = await shopifyGQL(env, gql, { query: searchQuery });
    const customers = (data.customers?.edges || []).map(({ node }) => ({
      id: node.id,
      first: node.firstName || '',
      last: node.lastName || '',
      email: node.email || '',
      phone: node.phone || '',
    }));
    return Response.json({ customers }, { headers: cors });
  } catch (err) {
    console.error('Customer search error:', err);
    return Response.json({ error: err.message, customers: [] }, { status: 502, headers: cors });
  }
}

// ── CREATE ──────────────────────────────────────────────
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { first, last, email, phone } = body;
  if (!first || !last || !email) {
    return Response.json({ error: 'first, last, and email are required' }, { status: 400, headers: cors });
  }

  const gql = `
    mutation CreateCustomer($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer {
          id
          firstName
          lastName
          email
          phone
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = { firstName: first, lastName: last, email };
  if (phone) input.phone = phone;

  try {
    const data = await shopifyGQL(env, gql, { input });
    const result = data.customerCreate;
    if (result.userErrors?.length) {
      return Response.json(
        { error: result.userErrors.map(e => e.message).join('; ') },
        { status: 422, headers: cors }
      );
    }
    const c = result.customer;
    return Response.json({
      customer: {
        id: c.id,
        first: c.firstName || '',
        last: c.lastName || '',
        email: c.email || '',
        phone: c.phone || '',
      }
    }, { headers: cors });
  } catch (err) {
    console.error('Customer create error:', err);
    return Response.json({ error: err.message }, { status: 502, headers: cors });
  }
}

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
