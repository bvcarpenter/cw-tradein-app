/**
 * POST /api/customer-address — Save an address to a Shopify customer profile.
 *
 * Body: {
 *   customerId,   — Shopify GID (e.g. "gid://shopify/Customer/12345")
 *   address1,     — street address
 *   city,
 *   province,     — state/province code (e.g. "CA")
 *   zip,
 *   country       — country code (default "US")
 * }
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

  const { customerId, address1, city, province, zip, country } = body;
  if (!customerId || !address1) {
    return Response.json(
      { error: 'customerId and address1 are required' },
      { status: 400, headers: cors }
    );
  }

  const gql = `
    mutation CustomerUpdate($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer {
          id
          addresses {
            address1
            city
            province
            zip
            country
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = {
    id: customerId,
    addresses: [{
      address1: address1 || '',
      city: city || '',
      provinceCode: province || '',
      zip: zip || '',
      countryCode: country || 'US',
    }],
  };

  try {
    const data = await shopifyGQL(env, gql, { input });
    const result = data.customerUpdate;
    if (result.userErrors?.length) {
      return Response.json(
        { error: result.userErrors.map(e => e.message).join('; ') },
        { status: 422, headers: cors }
      );
    }
    return Response.json({ success: true }, { headers: cors });
  } catch (err) {
    console.error('Customer address update error:', err);
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
