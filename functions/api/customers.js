/**
 * GET  /api/customers?q=jane         — search Shopify customers
 * POST /api/customers                — create a new Shopify customer
 *
 * Uses OAuth token rotation via _shopify.js helper.
 * Environment variables: see _shopify.js
 */

import { shopifyGQL } from './_shopify.js';

const cors = { 'Content-Type': 'application/json' };

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
            addresses {
              address1
              address2
              city
              province
              provinceCode
              zip
              country
            }
          }
        }
      }
    }
  `;

  try {
    // Simple full-text search — Shopify handles matching across name/email/phone.
    // Field-specific infix wildcards (first_name:*q*) are not supported by Shopify.
    const searchQuery = q;
    const data = await shopifyGQL(env, gql, { query: searchQuery });
    const customers = (data.customers?.edges || []).map(({ node }) => ({
      id: node.id,
      first: node.firstName || '',
      last: node.lastName || '',
      email: node.email || '',
      phone: node.phone || '',
      addresses: (node.addresses || []).map(a => ({
        street: [a.address1, a.address2].filter(Boolean).join(', '),
        city: a.city || '',
        state: a.provinceCode || a.province || '',
        zip: a.zip || '',
      })),
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
