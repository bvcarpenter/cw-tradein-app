const PARENT_FOLDER_ID = '0AIR37NuhBx3uUk9PVA';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
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

async function createFolder(token, name, parentId) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
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

async function uploadFile(token, name, mimeType, body, parentId) {
  const metadata = JSON.stringify({ name, parents: [parentId] });
  const boundary = '----CWBoundary' + Date.now();
  const parts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`,
    `--${boundary}--`,
  ];

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: parts.join(''),
  });
  if (!res.ok) throw new Error('Upload failed for ' + name + ': ' + await res.text());
  return (await res.json()).id;
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
      return new Response(JSON.stringify({ error: 'Google Drive service account not configured. Set GDRIVE_SA_KEY secret.' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const saKey = typeof saKeyRaw === 'string' ? JSON.parse(saKeyRaw) : saKeyRaw;
    const { cmNum, items } = await request.json();

    if (!cmNum) {
      return new Response(JSON.stringify({ error: 'cmNum is required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const token = await getAccessToken(saKey);
    const folderId = await createFolder(token, cmNum, PARENT_FOLDER_ID);

    let globalImgIdx = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemFolderName = `${String(i + 1).padStart(2, '0')}_${(item.name || 'item').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60)}`;
      const itemFolderId = await createFolder(token, itemFolderName, folderId);

      const notesTxtBase64 = btoa(unescape(encodeURIComponent(item.notesTxt || '')));
      await uploadFile(token, 'notes.txt', 'text/plain', notesTxtBase64, itemFolderId);

      for (const img of (item.images || [])) {
        const ext = img.ext || 'jpg';
        const imgName = `${cmNum}-${String(globalImgIdx).padStart(3, '0')}.${ext}`;
        const base64 = dataUrlBase64(img.dataUrl);
        await uploadFile(token, imgName, mimeFromExt(ext), base64, itemFolderId);
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
