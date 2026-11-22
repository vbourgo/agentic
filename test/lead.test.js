import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReportEmail } from '../lib/email/report.js';

const REPORT = {
  domain: 'gemmyo.com', score: 64, color: '#FF9F0A', potential: 92, totalLabel: '8 fiches produit analysées',
  verdict: { tag: 'Partiellement prêt', title: 'Partiellement prêt pour le commerce agentique.', text: 'Les agents…' },
  subs: [{ label: 'Attributs produits', v: 76, color: '#30D158' }, { label: 'Données structurées', v: 79, color: '#30D158' }],
  issues: [
    { sev: 'Critique', title: 'Aucun connecteur UCP ou MCP exposé', detail: 'Gemini…', gain: 14 },
    { sev: 'Important', title: 'GTIN / EAN absents <script>', detail: '8 fiches sur 8', gain: 5 },
  ],
  platformLabel: 'Plateforme non identifiée', analyzedAt: '2026-11-22T10:00:00Z',
};

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('report e-mail contains every sub-score and issue, escaped', () => {
  const { html, text, subject } = renderReportEmail(REPORT, { siteUrl: 'https://example.vercel.app' });
  assert.equal(subject, 'Votre rapport Agent-Ready : gemmyo.com — 64/100');
  for (const s of ['Attributs produits', 'Données structurées', 'Aucun connecteur UCP ou MCP exposé', '+14 pts', '+5 pts', '64 &rarr;', 'https://example.vercel.app/#offres']) assert.ok(html.includes(s), s);
  assert.ok(html.includes('GTIN / EAN absents &lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(text.includes('[Important] GTIN / EAN absents <script> (+5 pts)'));
});

test('lead handler: reads the report, sends it, saves the contact', async () => {
  process.env.BREVO_API_KEY = 'test-key';
  delete process.env.BREVO_LIST_ID; delete process.env.BREVO_SENDER_EMAIL; delete process.env.BREVO_SENDER_NAME;
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.host === 'api.brevo.com' ? u.pathname : u.host + u.pathname}`;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ key, body, search: u.search, apiKey: init.headers?.['api-key'] });
    const json = (status, b) => new Response(b == null ? '' : JSON.stringify(b), { status });
    if (key === 'GET example.vercel.app/api/audit') return json(200, REPORT);
    if (key === 'GET /v3/senders') return json(200, { senders: [{ id: 1, name: 'OXYGEN.AI', email: 'owner@gmail.com', active: true }] });
    if (key === 'POST /v3/smtp/email') return json(201, { messageId: '<abc@smtp-relay>' });
    if (key === 'GET /v3/contacts/lists') return json(200, { lists: [{ id: 6, name: 'Agent-Ready Check — audits' }] });
    if (key === 'GET /v3/contacts/attributes') return json(200, { attributes: [{ name: 'AUDIT_DOMAIN' }, { name: 'AUDIT_SCORE' }] });
    if (key === 'POST /v3/contacts') return json(204, null);
    return json(404, { message: 'nf ' + key });
  };
  try {
    const { default: handler } = await import('../api/lead.js');
    const res = mockRes();
    await handler({ method: 'POST', headers: { host: 'example.vercel.app' }, body: { email: 'Lead@Marque.com', url: 'https://www.gemmyo.com/' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true, sent: true });
    const audit = calls.find((c) => c.key === 'GET example.vercel.app/api/audit');
    assert.equal(audit.search, '?url=' + encodeURIComponent('https://www.gemmyo.com/'));
    const mail = calls.find((c) => c.key === 'POST /v3/smtp/email').body;
    assert.deepEqual(mail.sender, { name: 'Agent-Ready Check', email: 'owner@gmail.com' });
    assert.deepEqual(mail.to, [{ email: 'lead@marque.com' }]);
    assert.equal(mail.subject, 'Votre rapport Agent-Ready : gemmyo.com — 64/100');
    assert.ok(mail.htmlContent.includes('GTIN / EAN absents'));
    const contact = calls.find((c) => c.key === 'POST /v3/contacts').body;
    assert.deepEqual(contact, { email: 'lead@marque.com', attributes: { AUDIT_DOMAIN: 'gemmyo.com', AUDIT_SCORE: 64 }, listIds: [6], updateEnabled: true });
    assert.ok(calls.filter((c) => c.key.startsWith('GET /v3') || c.key.startsWith('POST /v3')).every((c) => c.apiKey === 'test-key'));

    // A failed send is reported to the visitor.
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.host === 'example.vercel.app') return new Response(JSON.stringify(REPORT), { status: 200 });
      if (u.pathname === '/v3/smtp/email') return new Response('{"code":"unauthorized"}', { status: 401 });
      return new Response('{}', { status: 200 });
    };
    const res2 = mockRes();
    await handler({ method: 'POST', headers: { host: 'example.vercel.app' }, body: { email: 'a@b.fr', url: 'gemmyo.com' } }, res2);
    assert.equal(res2.statusCode, 502);
    assert.equal(res2.body.error, 'send_failed');

    const res3 = mockRes();
    await handler({ method: 'POST', headers: {}, body: { email: 'pas-un-email', url: 'x.com' } }, res3);
    assert.equal(res3.statusCode, 400);
  } finally {
    globalThis.fetch = orig;
  }
});
