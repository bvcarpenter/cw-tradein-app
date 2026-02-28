/**
 * /api/sessions — Shared session storage via Cloudflare KV
 * KV binding: SESSIONS_KV  (bind in Cloudflare Pages > Settings > Functions > KV namespace bindings)
 *
 * GET    /api/sessions          — list all sessions
 * GET    /api/sessions?key=K    — get one session  
 * POST   /api/sessions          — save/update  body: {key, data}
 * DELETE /api/sessions?key=K    — delete
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (d, s=200) => new Response(JSON.stringify(d), {status:s, headers:{'Content-Type':'application/json',...CORS}});
const INDEX_KEY = '__cwti_index__';

async function getIndex(kv) {
  try { const v = await kv.get(INDEX_KEY); return v ? JSON.parse(v) : []; } catch { return []; }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const kv = env.SESSIONS_KV;
  if (!kv) return json({ error: 'SESSIONS_KV not bound — add KV binding in Cloudflare Pages settings' }, 503);
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (key) {
    const val = await kv.get(key);
    if (!val) return json({ error: 'not found' }, 404);
    return json({ key, data: JSON.parse(val) });
  }
  const index = await getIndex(kv);
  const sessions = (await Promise.all(index.map(async e => {
    try { const v = await kv.get(e.key); return v ? { key: e.key, data: JSON.parse(v) } : null; } catch { return null; }
  }))).filter(Boolean);
  return json(sessions);
}

export async function onRequestPost({ request, env }) {
  const kv = env.SESSIONS_KV;
  if (!kv) return json({ error: 'SESSIONS_KV not bound' }, 503);
  const { key, data } = await request.json();
  if (!key || !data) return json({ error: 'key and data required' }, 400);
  await kv.put(key, JSON.stringify(data));
  const index = await getIndex(kv);
  const i = index.findIndex(e => e.key === key);
  const entry = { key, name: data.name||key, savedAt: data.savedAt||new Date().toISOString() };
  if (i >= 0) index[i] = entry; else index.push(entry);
  await kv.put(INDEX_KEY, JSON.stringify(index));
  return json({ ok: true, key });
}

export async function onRequestDelete({ request, env }) {
  const kv = env.SESSIONS_KV;
  if (!kv) return json({ error: 'SESSIONS_KV not bound' }, 503);
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return json({ error: 'key required' }, 400);
  await kv.delete(key);
  const index = (await getIndex(kv)).filter(e => e.key !== key);
  await kv.put(INDEX_KEY, JSON.stringify(index));
  return json({ ok: true, deleted: key });
}