import { runAudit, AuditError } from '../lib/audit/analyze.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const url = String(req.query?.url || '').slice(0, 500);
  try {
    const report = await runAudit(url);
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(report);
  } catch (err) {
    const code = err instanceof AuditError ? err.code : 'internal';
    const status = code === 'invalid_url' ? 400 : code === 'internal' ? 500 : 422;
    if (code === 'internal') console.error('audit_failed', url, err);
    res.setHeader('Cache-Control', code === 'internal' ? 'no-store' : 'public, s-maxage=600');
    return res.status(status).json({
      error: code,
      message: err instanceof AuditError ? err.message : 'L’analyse a échoué. Réessayez dans un instant.',
    });
  }
}
