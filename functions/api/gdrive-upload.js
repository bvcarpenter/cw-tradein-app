const PARENT_FOLDER_ID = '10FV6E5bXRoLN5bE9Zsk2F5QoBDsKpmZ3';
const PROCESSING_SUBFOLDER = 'Processing';
const SCOPES = 'https://www.googleapis.com/auth/drive';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function base64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new TextEncoder().encode(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJWT(header, payload, privateKeyPem) {
  const enc = new TextEncoder();
  const input = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(payload));

  const pemBody = privateKeyPem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input));
  return input + '.' + base64url(new Uint8Array(sig));
}

async function getAccessToken(saKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: saKey.client_email,
    scope: SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const jwt = await signJWT(header, payload, saKey.private_key);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error('Token exchange failed: ' + txt);
  }
  const data = await res.json();
  return data.access_token;
}

async function verifyFolderAccess(token, folderId, saEmail) {
  const url = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `Cannot access parent folder ${folderId}. ` +
      `Make sure you shared the folder with the service account email: ${saEmail} (Editor access). ` +
      `Drive API response: ${txt}`
    );
  }
  return await res.json();
}

async function createFolder(token, name, parentId) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
  if (!res.ok) throw new Error('Failed to create folder: ' + await res.text());
  return (await res.json()).id;
}

async function findFolderByName(token, name, parentId) {
  const q = `name = '${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) throw new Error('Folder lookup failed: ' + await res.text());
  const data = await res.json();
  return (data.files && data.files[0]) ? data.files[0].id : null;
}

async function findOrCreateFolder(token, name, parentId) {
  const existing = await findFolderByName(token, name, parentId);
  if (existing) return existing;
  return createFolder(token, name, parentId);
}

async function deleteFile(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error('Delete failed: ' + await res.text());
  }
}

async function uploadFile(token, name, mimeType, bytes, parentId) {
  const metadata = JSON.stringify({ name, parents: [parentId] });
  const boundary = '----CWBoundary' + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const preamble = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const closing = enc.encode(`\r\n--${boundary}--`);

  const body = new Uint8Array(preamble.length + bytes.length + closing.length);
  body.set(preamble, 0);
  body.set(bytes, preamble.length);
  body.set(closing, preamble.length + bytes.length);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error('Upload failed for ' + name + ': ' + await res.text());
  return (await res.json()).id;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function dataUrlBase64(dataUrl) {
  const i = (dataUrl || '').indexOf(',');
  return i < 0 ? '' : dataUrl.slice(i + 1);
}

function mimeFromExt(ext) {
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic' };
  return map[ext] || 'image/jpeg';
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: cors });
}

export async function onRequestPost({ request, env }) {
  try {
    const saKeyRaw = env.GDRIVE_SA_KEY;
    if (!saKeyRaw) {
      const visibleKeys = Object.keys(env).filter(k =>
        /gdrive|drive|gsa|google|sa_key|service/i.test(k)
      );
      const allKeysSample = Object.keys(env).slice(0, 30);
      return new Response(JSON.stringify({
        error: 'Google Drive service account not configured. GDRIVE_SA_KEY is not present on the Worker env.',
        matching_env_keys: visibleKeys,
        sample_env_keys: allKeysSample,
        total_env_keys: Object.keys(env).length,
      }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    let saKey;
    try {
      saKey = typeof saKeyRaw === 'string' ? JSON.parse(saKeyRaw) : saKeyRaw;
    } catch (parseErr) {
      const preview = String(saKeyRaw).slice(0, 60);
      return new Response(JSON.stringify({
        error: `GDRIVE_SA_KEY is set but its value is not valid JSON. Re-paste the full Google service account JSON (must start with {"type":"service_account"...). Current value starts with: "${preview}"`,
      }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (!saKey || !saKey.client_email || !saKey.private_key) {
      return new Response(JSON.stringify({
        error: 'GDRIVE_SA_KEY parsed but is missing client_email or private_key. Make sure you pasted the ENTIRE service account JSON file.',
      }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    const { cmNum, items } = await request.json();

    if (!cmNum) {
      return new Response(JSON.stringify({ error: 'cmNum is required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const token = await getAccessToken(saKey);

    await verifyFolderAccess(token, PARENT_FOLDER_ID, saKey.client_email);

    const processingRootId = await findOrCreateFolder(token, PROCESSING_SUBFOLDER, PARENT_FOLDER_ID);

    const existingId = await findFolderByName(token, cmNum, processingRootId);
    if (existingId) await deleteFile(token, existingId);

    const folderId = await createFolder(token, cmNum, processingRootId);

    let globalImgIdx = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemFolderName = `${String(i + 1).padStart(2, '0')}_${(item.name || 'item').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60)}`;
      const itemFolderId = await createFolder(token, itemFolderName, folderId);

      const notesBytes = new TextEncoder().encode(item.notesTxt || '');
      await uploadFile(token, 'notes.txt', 'text/plain; charset=utf-8', notesBytes, itemFolderId);

      for (const img of (item.images || [])) {
        const ext = img.ext || 'jpg';
        const imgName = `${cmNum}-${String(globalImgIdx).padStart(3, '0')}.${ext}`;
        const bytes = base64ToBytes(dataUrlBase64(img.dataUrl));
        await uploadFile(token, imgName, mimeFromExt(ext), bytes, itemFolderId);
        globalImgIdx++;
      }
    }

    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
    return new Response(JSON.stringify({ ok: true, folderId, folderUrl }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
}
