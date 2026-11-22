// Safe HTTP fetching for the audit: public hosts only (SSRF guard),
// manual redirects re-checked at every hop, per-request timeout and size cap.
import dns from 'node:dns/promises';
import net from 'node:net';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36 AgentReadyCheck/1.0 (+https://agent-ready-check-ecru.vercel.app)';

const MAX_REDIRECTS = 5;

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inRange(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/3',
];

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return PRIVATE_V4.some((cidr) => inRange(ip, cidr));
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}

const hostChecks = new Map();

export function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (!hostChecks.has(host)) {
    hostChecks.set(host, (async () => {
      if (net.isIP(host)) {
        if (isPrivateIp(host)) throw new Error('blocked_host');
        return true;
      }
      if (!host.includes('.') || /\.(local|internal|localhost)$/i.test(host) || host === 'localhost') {
        throw new Error('blocked_host');
      }
      const addrs = await dns.lookup(host, { all: true });
      if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('blocked_host');
      return true;
    })());
  }
  return hostChecks.get(host);
}

async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    if (size >= maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/**
 * Fetch a URL and return { ok, status, url, headers, text, contentType, error }.
 * Never throws.
 */
export async function fetchSafe(rawUrl, opts = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    timeout = 8000,
    maxBytes = 3_000_000,
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  } = opts;
  let url = rawUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad_protocol');
      await assertPublicHost(u.hostname);
      const res = await fetch(u, {
        method,
        body,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept,
          'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
          ...headers,
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), u).toString();
        try { await res.body?.cancel(); } catch { /* ignore */ }
        continue;
      }
      const text = await readCapped(res, maxBytes);
      return {
        ok: res.ok,
        status: res.status,
        url: u.toString(),
        headers: res.headers,
        contentType: res.headers.get('content-type') || '',
        text,
      };
    }
    return { ok: false, status: 0, url, headers: new Headers(), text: '', contentType: '', error: 'too_many_redirects' };
  } catch (err) {
    const error = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'fetch_failed');
    return { ok: false, status: 0, url, headers: new Headers(), text: '', contentType: '', error };
  } finally {
    clearTimeout(timer);
  }
}

export function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Run async tasks with a concurrency limit. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
