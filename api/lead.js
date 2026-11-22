// Collects the e-mail that unlocks the detailed audit report.
// If BREVO_API_KEY (and optionally BREVO_LIST_ID) are set in the Vercel project,
// the contact is added to Brevo; otherwise the lead is only written to the logs.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String(body?.email || '').trim().toLowerCase();
  const domain = String(body?.domain || '').slice(0, 200);
  const score = Number.isFinite(Number(body?.score)) ? Number(body.score) : null;
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email', message: 'Adresse e-mail invalide.' });

  console.log('lead', JSON.stringify({ email, domain, score, at: new Date().toISOString() }));

  const key = process.env.BREVO_API_KEY;
  if (key) {
    const listId = Number(process.env.BREVO_LIST_ID);
    try {
      const r = await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email, updateEnabled: true, ...(listId ? { listIds: [listId] } : {}) }),
      });
      if (!r.ok && r.status !== 204) console.error('brevo_failed', r.status, (await r.text()).slice(0, 300));
    } catch (err) {
      console.error('brevo_error', err?.message);
    }
  }
  return res.status(200).json({ ok: true });
}
