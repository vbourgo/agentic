// E-mail gate of the audit: e-mails the full report to the visitor through Brevo
// and saves the contact (list "Agent-Ready Check — audits", attributes
// AUDIT_DOMAIN / AUDIT_SCORE, created on first use).
//
// The report is never taken from the browser: it is read back from /api/audit
// (same URL as the visitor's audit, so normally served from the CDN cache) or,
// failing that, recomputed here.
//
// Env: BREVO_API_KEY (required), BREVO_LIST_ID, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME (optional).
import { runAudit, AuditError } from '../lib/audit/analyze.js';
import { renderReportEmail } from '../lib/email/report.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const LIST_NAME = 'Agent-Ready Check — audits';
const FOLDER_NAME = 'Agent-Ready Check';
const ATTRIBUTES = { AUDIT_DOMAIN: 'text', AUDIT_SCORE: 'float' };
const API = 'https://api.brevo.com/v3';

let listIdPromise = null;
let attributesPromise = null;
let senderPromise = null;

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

async function resolveSender() {
  const name = process.env.BREVO_SENDER_NAME || 'Agent-Ready Check';
  if (process.env.BREVO_SENDER_EMAIL) return { name, email: process.env.BREVO_SENDER_EMAIL };
  const r = await brevo('/senders');
  if (!r.ok) throw new Error(`senders ${r.status} ${r.text.slice(0, 200)}`);
  const sender = (r.json?.senders || []).find((s) => s.active);
  if (!sender) throw new Error('no active Brevo sender');
  return { name, email: sender.email };
}

// Cache a setup promise; retry on the next request if it failed.
function cached(get, set, fn) {
  if (!get()) set(fn().catch((err) => { set(null); throw err; }));
  return get();
}

export async function saveContact({ email, domain, score }) {
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

export async function sendReport({ email, report, siteUrl }) {
  const sender = await cached(() => senderPromise, (v) => { senderPromise = v; }, resolveSender);
  const { html, text, subject } = renderReportEmail(report, { siteUrl });
  const r = await brevo('/smtp/email', {
    method: 'POST',
    body: {
      sender,
      replyTo: { email: sender.email, name: sender.name },
      to: [{ email }],
      subject,
      htmlContent: html,
      textContent: text,
      tags: ['agent-ready-audit'],
    },
  });
  if (!r.ok) throw new Error(`send ${r.status} ${r.text.slice(0, 300)}`);
  return { messageId: r.json?.messageId };
}

export async function getReport(url, siteUrl) {
  // Same query string as the visitor's request, so the CDN usually answers.
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 50000);
    const r = await fetch(`${siteUrl}/api/audit?url=${encodeURIComponent(url)}`, { signal: controller.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json();
      if (j && typeof j.score === 'number' && Array.isArray(j.issues)) return j;
    }
  } catch { /* fall back to a direct run */ }
  return runAudit(url);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String(body?.email || '').trim().toLowerCase();
  const url = String(body?.url || body?.domain || '').trim().slice(0, 500);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email', message: 'Adresse e-mail invalide.' });
  if (!url) return res.status(400).json({ error: 'invalid_url', message: 'Relancez l’audit de votre boutique, puis réessayez.' });
  if (!process.env.BREVO_API_KEY) {
    console.error('lead_no_brevo_key', JSON.stringify({ email, url }));
    return res.status(503).json({ error: 'not_configured', message: 'L’envoi du rapport est momentanément indisponible. Réessayez plus tard.' });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const siteUrl = `https://${host}`;

  let report;
  try {
    report = await getReport(url, siteUrl);
  } catch (err) {
    const message = err instanceof AuditError ? err.message : 'Impossible de recalculer le rapport. Réessayez dans un instant.';
    console.error('lead_audit_failed', url, err?.message);
    return res.status(422).json({ error: 'audit_failed', message });
  }

  console.log('lead', JSON.stringify({ email, domain: report.domain, score: report.score, at: new Date().toISOString() }));

  const [sent, saved] = await Promise.allSettled([
    sendReport({ email, report, siteUrl }),
    saveContact({ email, domain: report.domain, score: report.score }),
  ]);
  if (saved.status === 'rejected') console.error('brevo_contact_failed', saved.reason?.message);
  if (sent.status === 'rejected') {
    console.error('brevo_send_failed', sent.reason?.message);
    return res.status(502).json({ error: 'send_failed', message: 'L’envoi de l’e-mail a échoué. Vérifiez l’adresse ou réessayez dans un instant.' });
  }
  console.log('report_sent', JSON.stringify({ domain: report.domain, messageId: sent.value.messageId }));
  return res.status(200).json({ ok: true, sent: true });
}
