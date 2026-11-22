// HTML / JSON-LD / sitemap / robots.txt parsing helpers (regex based, no deps).

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function stripTags(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

export function wordCount(text) {
  const t = stripTags(text);
  return t ? t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

function tryParseJson(raw) {
  const cleaned = raw
    .replace(/^\s*<!--/, '').replace(/-->\s*$/, '')
    .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//, '').replace(/\/\*\s*\]\]>\s*\*\/\s*$/, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .trim();
  try { return JSON.parse(cleaned); } catch { /* fallthrough */ }
  try { return JSON.parse(cleaned.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

/** All JSON-LD nodes (objects carrying @type), flattened through @graph and nesting. */
export function extractJsonLd(html) {
  const nodes = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let blocks = 0;
  let invalid = 0;
  while ((m = re.exec(html))) {
    blocks++;
    const data = tryParseJson(m[1]);
    if (data == null) { invalid++; continue; }
    collectNodes(data, nodes, 0);
  }
  return { nodes, blocks, invalid };
}

function collectNodes(value, out, depth) {
  if (depth > 6 || value == null) return;
  if (Array.isArray(value)) { value.forEach((v) => collectNodes(v, out, depth + 1)); return; }
  if (typeof value !== 'object') return;
  if (value['@type']) out.push(value);
  for (const [k, v] of Object.entries(value)) {
    if (k === '@context') continue;
    if (v && typeof v === 'object') collectNodes(v, out, depth + 1);
  }
}

export function typesOf(node) {
  const t = node?.['@type'];
  const arr = Array.isArray(t) ? t : [t];
  return arr.filter(Boolean).map((x) => String(x).replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, ''));
}

export function isType(node, ...names) {
  const ts = typesOf(node);
  return names.some((n) => ts.includes(n));
}

export function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function metaContent(html, key) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i',
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  return decodeEntities(tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? '') || null;
}

export function hasMicrodataProduct(html) {
  return /itemtype\s*=\s*["']https?:\/\/schema\.org\/Product["']/i.test(html);
}

/** Same-site absolute links found in the page. */
export function extractLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const host = base.hostname.replace(/^www\./, '');
  const out = new Set();
  const re = /<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(decodeEntities(m[1]), base);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (u.hostname.replace(/^www\./, '') !== host) continue;
      u.hash = '';
      out.add(u.toString());
    } catch { /* ignore */ }
  }
  return [...out];
}

/** Parse a sitemap (index or urlset). */
export function parseSitemap(xml) {
  const locs = (tag) => {
    const re = new RegExp(`<${tag}>[\\s\\S]*?<loc>\\s*(?:<!\\[CDATA\\[)?([^<\\]]+)(?:\\]\\]>)?\\s*</loc>`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(xml))) out.push(decodeEntities(m[1].trim()));
    return out;
  };
  return { sitemaps: locs('sitemap'), urls: locs('url') };
}

/** robots.txt → { sitemaps, groups: [{ agents: [...], rules: [{allow, path}] }] } */
export function parseRobots(text) {
  const sitemaps = [];
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'disallow') current.rules.push({ allow: false, path: val });
    if (key === 'allow') current.rules.push({ allow: true, path: val });
  }
  return { sitemaps, groups };
}

/** True when the robots rules forbid the whole site to this agent. */
export function robotsBlocksAgent(robots, agent) {
  const a = agent.toLowerCase();
  let group = robots.groups.find((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  if (!group) group = robots.groups.find((g) => g.agents.includes('*'));
  if (!group) return false;
  const blocksRoot = group.rules.some((r) => !r.allow && (r.path === '/' || r.path === '/*'));
  const allowsRoot = group.rules.some((r) => r.allow && (r.path === '/' || r.path === '/*' || r.path === ''));
  return blocksRoot && !allowsRoot;
}

export function looksLikeBotWall(res) {
  if ([401, 403, 429, 503].includes(res.status)) return true;
  const t = res.text || '';
  if (t.length > 60000) return false;
  return /cf-chl-|challenge-platform|<title>\s*Just a moment|Attention Required! \| Cloudflare|px-captcha|_Incapsula_Resource|datadome|captcha-delivery\.com|Access Denied<\/h1>/i.test(t);
}
