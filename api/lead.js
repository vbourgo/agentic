// Collects the e-mail that unlocks the detailed audit report.
// With BREVO_API_KEY set, the contact is upserted in Brevo with the audited
// domain and score (AUDIT_DOMAIN / AUDIT_SCORE) and added to the
// "Agent-Ready Check — audits" list. List and attributes are created on first
// use; BREVO_LIST_ID overrides the list. Every lead is also written to the logs.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const LIST_NAME = 'Agent-Ready Check — audits';
const FOLDER_NAME = 'Agent-Ready Check';
const ATTRIBUTES = { AUDIT_DOMAIN: 'text', AUDIT_SCORE: 'float' };
const API = 'https://api.brevo.com/v3';

let listIdPromise = null;
let attributesPromise = null;

async function brevo(path, { method = 'GET', body } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, json, text };
}

async function findOrCreateList() {
  if (Number(process.env.BREVO_LIST_ID)) return Number(process.env.BREVO_LIST_ID);
  for (let offset = 0; offset < 500; offset += 50) {
    const r = await brevo(`/contacts/lists?limit=50&offset=${offset}`);
    if (!r.ok) throw new Error(`lists ${r.status} ${r.text.slice(0, 200)}`);
    const found = (r.json?.lists || []).find((l) => l.name === LIST_NAME);
    if (found) return found.id;
    if ((r.json?.lists || []).length < 50) break;
  }
  const folders = await brevo('/contacts/folders?limit=50&offset=0');
  if (!folders.ok) throw new Error(`folders ${folders.status} ${folders.text.slice(0, 200)}`);
  let folderId = (folders.json?.folders || []).find((f) => f.name === FOLDER_NAME)?.id;
  if (!folderId) {
    const created = await brevo('/contacts/folders', { method: 'POST', body: { name: FOLDER_NAME } });
    if (!created.ok) throw new Error(`folder create ${created.status} ${created.text.slice(0, 200)}`);
    folderId = created.json.id;
  }
  const list = await brevo('/contacts/lists', { method: 'POST', body: { name: LIST_NAME, folderId } });
  if (!list.ok) throw new Error(`list create ${list.status} ${list.text.slice(0, 200)}`);
  console.log('brevo_list_created', list.json.id);
  return list.json.id;
}

async function ensureAttributes() {
  const r = await brevo('/contacts/attributes');
  if (!r.ok) throw new Error(`attributes ${r.status} ${r.text.slice(0, 200)}`);
  const existing = new Set((r.json?.attributes || []).map((a) => String(a.name).toUpperCase()));
  for (const [name, type] of Object.entries(ATTRIBUTES)) {
    if (existing.has(name)) continue;
    const c = await brevo(`/contacts/attributes/normal/${name}`, { method: 'POST', body: { type } });
    if (!c.ok && !/already exist/i.test(c.text)) throw new Error(`attribute ${name} ${c.status} ${c.text.slice(0, 200)}`);
    console.log('brevo_attribute_created', name);
  }
  return true;
}

// Retry setup on the next request if it failed (e.g. transient Brevo error).
function cached(getter, setter, fn) {
  if (!getter()) setter(fn().catch((err) => { setter(null); throw err; }));
  return getter();
}

export async function saveToBrevo({ email, domain, score }) {
  const [listId] = await Promise.all([
    cached(() => listIdPromise, (v) => { listIdPromise = v; }, findOrCreateList),
    cached(() => attributesPromise, (v) => { attributesPromise = v; }, ensureAttributes),
  ]);
  const attributes = {};
  if (domain) attributes.AUDIT_DOMAIN = domain;
  if (score != null) attributes.AUDIT_SCORE = score;
  const r = await brevo('/contacts', { method: 'POST', body: { email, attributes, listIds: [listId], updateEnabled: true } });
  if (!r.ok && r.status !== 204) throw new Error(`contact ${r.status} ${r.text.slice(0, 300)}`);
  return { listId };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String(body?.email || '').trim().toLowerCase();
  const domain = String(body?.domain || '').trim().toLowerCase().slice(0, 200);
  const score = Number.isFinite(Number(body?.score)) ? Math.max(0, Math.min(100, Math.round(Number(body.score)))) : null;
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email', message: 'Adresse e-mail invalide.' });

  console.log('lead', JSON.stringify({ email, domain, score, at: new Date().toISOString() }));

  if (process.env.BREVO_API_KEY) {
    try {
      await saveToBrevo({ email, domain, score });
    } catch (err) {
      // Never block the visitor on a CRM error: the lead is in the logs above.
      console.error('brevo_failed', err?.message);
    }
  }
  return res.status(200).json({ ok: true });
}
