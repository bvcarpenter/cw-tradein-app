/**
 * POST /api/customer-timeline — Upload credit memo PDF to Shopify Files
 * and add a timeline event on the customer.
 *
 * Body: { customerId, pdfBase64, filename, cmNum }
 *
 * Flow:
 *   1. stagedUploadsCreate  — get a presigned upload URL
 *   2. PUT the PDF bytes    — upload to the staged target
 *   3. fileCreate           — register the file in Shopify's Files section
 *   4. Add a timeline event on the customer via the REST Events API
 *
 * Required scopes: write_files, read_files, write_customers
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

  const { customerId, pdfBase64, filename, cmNum } = body;
  if (!customerId || !pdfBase64 || !filename) {
    return Response.json(
      { error: 'customerId, pdfBase64, and filename are required' },
      { status: 400, headers: cors }
    );
  }

  try {
    // ── 1. Create staged upload ──
    const stagedData = await shopifyGQL(env, `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }
    `, {
      input: [{
        resource: 'FILE',
        filename,
        mimeType: 'application/pdf',
        httpMethod: 'POST',
      }],
    });

    const staged = stagedData.stagedUploadsCreate;
    if (staged.userErrors?.length) {
      return Response.json(
        { error: 'Staged upload: ' + staged.userErrors.map(e => e.message).join('; ') },
        { status: 422, headers: cors }
      );
    }

    const target = staged.stagedTargets[0];

    // ── 2. Upload PDF to staged URL ──
    const pdfBytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
    const form = new FormData();
    for (const p of target.parameters) {
      form.append(p.name, p.value);
    }
    form.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), filename);

    const uploadRes = await fetch(target.url, { method: 'POST', body: form });
    if (!uploadRes.ok) {
      const detail = await uploadRes.text().catch(() => '');
      throw new Error(`File upload failed (${uploadRes.status}): ${detail.slice(0, 200)}`);
    }

    // ── 3. Create file in Shopify ──
    const fileData = await shopifyGQL(env, `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files { id alt }
          userErrors { field message }
        }
      }
    `, {
      files: [{
        alt: `Credit Memo ${cmNum || ''} — ${filename}`,
        contentType: 'FILE',
        originalSource: target.resourceUrl,
      }],
    });

    const fileResult = fileData.fileCreate;
    if (fileResult.userErrors?.length) {
      return Response.json(
        { error: 'File create: ' + fileResult.userErrors.map(e => e.message).join('; ') },
        { status: 422, headers: cors }
      );
    }

    const fileId = fileResult.files?.[0]?.id || null;

    // ── 4. Add timeline comment on customer ──
    // Use the customer metafield to record the credit memo file reference,
    // and update the customer note for visibility in the admin timeline.
    const numericCustId = customerId.replace(/\D/g, '');
    const token = await getShopifyToken(env);

    // Append to customer note via REST (visible on the customer timeline)
    const noteDate = new Date().toISOString().split('T')[0];
    const noteText = `[${noteDate}] Credit Memo ${cmNum || 'PENDING'} — PDF uploaded to Files (${filename})`;

    // Read current note first
    const custRes = await fetch(
      `https://${env.SHOPIFY_STORE}/admin/api/2024-10/customers/${numericCustId}.json`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const custData = await custRes.json();
    const existingNote = custData.customer?.note || '';
    const updatedNote = existingNote
      ? existingNote + '\n' + noteText
      : noteText;

    // Update customer with appended note
    await fetch(
      `https://${env.SHOPIFY_STORE}/admin/api/2024-10/customers/${numericCustId}.json`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ customer: { id: numericCustId, note: updatedNote } }),
      }
    );

    return Response.json({
      ok: true,
      fileId,
      message: `Credit memo uploaded and customer note updated`,
    }, { headers: cors });

  } catch (err) {
    console.error('Customer timeline error:', err);
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
