import { test } from 'node:test';
import assert from 'node:assert/strict';

test('saveToBrevo creates folder, list and attributes once, then upserts contacts', async () => {
  process.env.BREVO_API_KEY = 'test-key';
  delete process.env.BREVO_LIST_ID;
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ key, body, apiKey: init.headers['api-key'] });
    const json = (status, b) => new Response(b == null ? '' : JSON.stringify(b), { status });
    if (key === 'GET /v3/contacts/lists') return json(200, { lists: [{ id: 2, name: 'Newsletter DSI' }], count: 1 });
    if (key === 'GET /v3/contacts/folders') return json(200, { folders: [{ id: 1, name: 'Your first folder' }] });
    if (key === 'POST /v3/contacts/folders') return json(201, { id: 9 });
    if (key === 'POST /v3/contacts/lists') return json(201, { id: 7 });
    if (key === 'GET /v3/contacts/attributes') return json(200, { attributes: [{ name: 'NOM' }, { name: 'AUDIT_DOMAIN' }] });
    if (key.startsWith('POST /v3/contacts/attributes/normal/')) return json(201, null);
    if (key === 'POST /v3/contacts') return json(201, { id: 123 });
    return json(404, { message: 'nf' });
  };
  try {
    const { saveToBrevo } = await import('../api/lead.js');
    const r1 = await saveToBrevo({ email: 'a@b.fr', domain: 'gemmyo.com', score: 64 });
    assert.equal(r1.listId, 7);
    const r2 = await saveToBrevo({ email: 'c@d.fr', domain: 'x.com', score: 40 });
    assert.equal(r2.listId, 7);
    const keys = calls.map((c) => c.key);
    assert.equal(keys.filter((k) => k === 'POST /v3/contacts/lists').length, 1);
    assert.deepEqual(calls.find((c) => c.key === 'POST /v3/contacts/lists').body, { name: 'Agent-Ready Check — audits', folderId: 9 });
    assert.deepEqual(keys.filter((k) => k.startsWith('POST /v3/contacts/attributes/')), ['POST /v3/contacts/attributes/normal/AUDIT_SCORE']);
    const contacts = calls.filter((c) => c.key === 'POST /v3/contacts');
    assert.equal(contacts.length, 2);
    assert.deepEqual(contacts[0].body, { email: 'a@b.fr', attributes: { AUDIT_DOMAIN: 'gemmyo.com', AUDIT_SCORE: 64 }, listIds: [7], updateEnabled: true });
    assert.ok(calls.every((c) => c.apiKey === 'test-key'));
  } finally {
    globalThis.fetch = orig;
  }
});
