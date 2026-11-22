// HTML + text e-mail carrying the full Agent-Ready audit report.
// Table-based layout with inline styles so it renders in common mail clients.

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SEV_COLORS = { Critique: '#D70015', Important: '#C93400', Modéré: '#6E6E73' };
// Darker variants of the site's colours, readable on a white background.
const SCORE_COLORS = { '#FF453A': '#D70015', '#FF9F0A': '#C93400', '#30D158': '#248A3D' };

function dateFr(iso) {
  try {
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
  } catch { return ''; }
}

export function reportSubject(r) {
  return `Votre rapport Agent-Ready : ${r.domain} — ${r.score}/100`;
}

export function renderReportEmail(r, { siteUrl }) {
  const scoreColor = SCORE_COLORS[r.color] || '#1D1D1F';
  const offersUrl = `${siteUrl}/#offres`;
  const auditUrl = `${siteUrl}/#audit`;

  const subsRows = (r.subs || []).map((s) => {
    const c = SCORE_COLORS[s.color] || '#1D1D1F';
    const w = Math.max(2, Math.min(100, Number(s.v) || 0));
    return `
      <tr>
        <td style="padding:12px 0 4px;font:500 15px/1.4 ${FONT};color:#1D1D1F">${esc(s.label)}</td>
        <td align="right" style="padding:12px 0 4px;font:700 15px/1.4 ${FONT};color:#1D1D1F;white-space:nowrap">${esc(s.v)}<span style="font-weight:400;color:#86868B"> /100</span></td>
      </tr>
      <tr>
        <td colspan="2" style="padding:0 0 4px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
            <td width="${w}%" style="height:6px;background:${c};border-radius:3px;font-size:0;line-height:0">&nbsp;</td>
            <td width="${100 - w}%" style="height:6px;background:#E8E8ED;font-size:0;line-height:0">&nbsp;</td>
          </tr></table>
        </td>
      </tr>`;
  }).join('');

  const issueRows = (r.issues || []).map((it) => `
      <tr>
        <td style="padding:16px 0;border-top:1px solid #E8E8ED">
          <div style="font:600 12px/1.4 ${FONT};letter-spacing:.02em;text-transform:uppercase;color:${SEV_COLORS[it.sev] || '#6E6E73'}">${esc(it.sev)}</div>
          <div style="font:600 16px/1.4 ${FONT};color:#1D1D1F;margin-top:4px">${esc(it.title)}</div>
          <div style="font:400 14px/1.5 ${FONT};color:#515154;margin-top:2px">${esc(it.detail)}</div>
        </td>
        <td align="right" valign="middle" style="padding:16px 0 16px 16px;border-top:1px solid #E8E8ED;font:700 15px/1.4 ${FONT};color:#248A3D;white-space:nowrap">+${esc(it.gain)} pts</td>
      </tr>`).join('');

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(reportSubject(r))}</title></head>
<body style="margin:0;padding:0;background:#F5F5F7">
<div style="display:none;max-height:0;overflow:hidden">${esc(r.verdict?.title || '')} ${esc(r.issues?.length || 0)} points d’amélioration, score potentiel ${esc(r.potential)}/100.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F7"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:20px">
  <tr><td style="padding:28px 32px 0;font:700 17px/1.2 ${FONT};color:#1D1D1F">&#10003;&nbsp; Agent-Ready Check</td></tr>
  <tr><td style="padding:24px 32px 8px">
    <div style="font:400 14px/1.4 ${FONT};color:#6E6E73">Score Agent-Ready · ${esc(r.domain)}</div>
    <div style="font:800 64px/1.05 ${FONT};letter-spacing:-.03em;color:${scoreColor};margin-top:8px">${esc(r.score)}<span style="font-size:22px;font-weight:500;color:#86868B"> /100</span></div>
    <div style="display:inline-block;margin-top:12px;padding:5px 12px;border:1px solid ${scoreColor};border-radius:999px;font:600 13px/1.2 ${FONT};color:${scoreColor}">${esc(r.verdict?.tag || '')}</div>
    <div style="font:800 24px/1.2 ${FONT};letter-spacing:-.02em;color:#1D1D1F;margin-top:16px">${esc(r.verdict?.title || '')}</div>
    <div style="font:400 15px/1.55 ${FONT};color:#515154;margin-top:8px">${esc(r.verdict?.text || '')}</div>
  </td></tr>
  <tr><td style="padding:24px 32px 0">
    <div style="font:700 18px/1.3 ${FONT};color:#1D1D1F">Détail du score</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px">${subsRows}</table>
  </td></tr>
  <tr><td style="padding:28px 32px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font:700 18px/1.3 ${FONT};color:#1D1D1F">Points d’amélioration</td>
      <td align="right" style="font:400 13px/1.3 ${FONT};color:#6E6E73">${esc(r.totalLabel || '')}</td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">${issueRows}</table>
  </td></tr>
  <tr><td style="padding:12px 32px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F7;border-radius:16px"><tr><td style="padding:20px 24px">
      <div style="font:400 14px/1.4 ${FONT};color:#6E6E73">Score potentiel après enrichissement</div>
      <div style="font:800 34px/1.2 ${FONT};letter-spacing:-.02em;color:#1D1D1F;margin-top:4px">${esc(r.score)} &rarr; <span style="color:#248A3D">${esc(r.potential)}</span></div>
    </td></tr></table>
  </td></tr>
  <tr><td align="center" style="padding:28px 32px 8px">
    <a href="${esc(offersUrl)}" style="display:inline-block;padding:15px 30px;background:#1D1D1F;border-radius:999px;font:600 16px/1 ${FONT};color:#FFFFFF;text-decoration:none">J’améliore mon catalogue</a>
    <div style="margin-top:14px"><a href="${esc(auditUrl)}" style="font:500 14px/1.4 ${FONT};color:#0066CC;text-decoration:none">Lancer un nouvel audit</a></div>
  </td></tr>
  <tr><td style="padding:24px 32px 28px;font:400 12px/1.5 ${FONT};color:#86868B">
    Analyse automatique des pages publiques de ${esc(r.domain)} du ${esc(dateFr(r.analyzedAt))} · ${esc(r.platformLabel || '')}. Score indicatif, à confirmer par un audit complet.
  </td></tr>
</table>
<div style="max-width:600px;padding:16px 12px 0;font:400 12px/1.5 ${FONT};color:#86868B">Vous recevez cet e-mail car vous avez demandé le rapport d’audit de ${esc(r.domain)} sur Agent-Ready Check.</div>
</td></tr></table>
</body></html>`;

  const text = [
    `Agent-Ready Check — rapport d’audit de ${r.domain}`,
    '',
    `Score Agent-Ready : ${r.score}/100 — ${r.verdict?.tag || ''}`,
    r.verdict?.title || '',
    r.verdict?.text || '',
    '',
    'Détail du score',
    ...(r.subs || []).map((s) => `- ${s.label} : ${s.v}/100`),
    '',
    `Points d’amélioration (${r.totalLabel || ''})`,
    ...(r.issues || []).map((it) => `- [${it.sev}] ${it.title} (+${it.gain} pts) : ${it.detail}`),
    '',
    `Score potentiel après enrichissement : ${r.score} → ${r.potential}`,
    '',
    `J’améliore mon catalogue : ${offersUrl}`,
    `Lancer un nouvel audit : ${auditUrl}`,
    '',
    `Analyse automatique des pages publiques du ${dateFr(r.analyzedAt)} · ${r.platformLabel || ''}. Score indicatif, à confirmer par un audit complet.`,
  ].join('\n');

  return { html, text, subject: reportSubject(r) };
}
