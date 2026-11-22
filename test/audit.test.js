import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonLd, parseRobots, robotsBlocksAgent, parseSitemap, looksLikeBotWall } from '../lib/audit/parse.js';
import { analyzeProductPage, analyzeShopifyProduct, normalizeTarget, runAudit, AuditError } from '../lib/audit/analyze.js';
import { isPrivateIp } from '../lib/audit/net.js';

const productHtml = (ld) => `<html><head><meta property="og:type" content="product"><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;

test('private IPs are rejected', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('normalizeTarget', () => {
  assert.deepEqual(normalizeTarget('www.gemmyo.com/fr/bagues'), { url: 'https://www.gemmyo.com/', host: 'www.gemmyo.com' });
  assert.throws(() => normalizeTarget('localhost'), AuditError);
  assert.throws(() => normalizeTarget(''), AuditError);
});

test('JSON-LD @graph and ProductGroup are parsed', () => {
  const html = productHtml({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'x' },
      {
        '@type': 'ProductGroup', name: 'Bague', description: 'mot '.repeat(50), brand: { '@type': 'Brand', name: 'B' },
        variesBy: ['https://schema.org/size'], category: 'Bagues', image: ['a.jpg', 'b.jpg'],
        hasVariant: [{ '@type': 'Product', sku: 'S1', gtin13: '3700000000001', size: '52',
          offers: { '@type': 'Offer', price: 990, priceCurrency: 'EUR', availability: 'https://schema.org/InStock',
            hasMerchantReturnPolicy: { '@type': 'MerchantReturnPolicy' } } }],
      },
    ],
  });
  const { nodes } = extractJsonLd(html);
  assert.ok(nodes.length >= 3);
  const p = analyzeProductPage(html);
  assert.equal(p.hasLd, true);
  assert.equal(p.isGroup, true);
  assert.equal(p.keyAttr, true);
  assert.equal(p.price && p.currency && p.availability, true);
  assert.equal(p.gtin, true);
  assert.equal(p.sku, true);
  assert.equal(p.returnPolicy, true);
  assert.equal(p.words >= 40, true);
});

test('page without JSON-LD', () => {
  const p = analyzeProductPage('<html><body>hello</body></html>');
  assert.equal(p.hasLd, false);
  assert.equal(p.price, false);
});

test('Shopify product analysis', () => {
  const p = analyzeShopifyProduct({
    body_html: '<p>court</p>', product_type: '', vendor: 'V', tags: ['Matière:Or'], images: [{}],
    options: [{ name: 'Taille' }], variants: [{ option1: '50', sku: 'A', barcode: '', available: true }, { option1: '52', sku: '', barcode: '', available: false }],
  });
  assert.equal(p.keyAttr, true);
  assert.equal(p.words < 40, true);
  assert.equal(p.category, false);
  assert.equal(p.sku, false);
  assert.equal(p.gtin, false);
  assert.equal(p.poorVariants, false);
  const q = analyzeShopifyProduct({ options: [{ name: 'Title' }], variants: [{ option1: 'Or jaune / 52' }, { option1: 'Or blanc / 54' }] });
  assert.equal(q.poorVariants, true);
});

test('robots.txt AI agents', () => {
  const r = parseRobots('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /cart\nSitemap: https://x.com/sitemap.xml');
  assert.deepEqual(r.sitemaps, ['https://x.com/sitemap.xml']);
  assert.equal(robotsBlocksAgent(r, 'GPTBot'), true);
  assert.equal(robotsBlocksAgent(r, 'ClaudeBot'), false);
});

test('sitemap parsing', () => {
  const s = parseSitemap('<sitemapindex><sitemap><loc>https://x.com/sitemap_products_1.xml?from=1</loc></sitemap></sitemapindex>');
  assert.deepEqual(s.sitemaps, ['https://x.com/sitemap_products_1.xml?from=1']);
});

test('bot wall detection', () => {
  assert.equal(looksLikeBotWall({ status: 403, text: '' }), true);
  assert.equal(looksLikeBotWall({ status: 200, text: '<title>Just a moment...</title>' }), true);
  assert.equal(looksLikeBotWall({ status: 200, text: '<html>ok</html>' }), false);
});

// ---- end-to-end with a mocked network ----
function mockFetch(routes) {
  return async (input, init = {}) => {
    const url = String(input instanceof URL ? input.toString() : input);
    const key = Object.keys(routes).find((k) => url === k || (k.endsWith('*') && url.startsWith(k.slice(0, -1))));
    const r = key ? (typeof routes[key] === 'function' ? routes[key](url, init) : routes[key]) : { status: 404, body: 'not found' };
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status || 200, headers: { 'content-type': r.type || (typeof r.body === 'string' ? 'text/html' : 'application/json') } });
  };
}

test('runAudit on a mocked Shopify store', async () => {
  const O = 'https://93.184.216.34';
  const products = Array.from({ length: 20 }, (_, i) => ({
    id: i, handle: `bague-${i}`, body_html: i % 2 ? '<p>' + 'mot '.repeat(60) + '</p>' : '<p>court</p>',
    product_type: i % 3 ? 'Bague' : '', vendor: 'Maison', tags: [], images: [{}, {}],
    options: [{ name: i % 4 ? 'Taille' : 'Title' }],
    variants: [{ option1: '50', sku: 'S' + i, barcode: '', price: '100', available: true }, { option1: '52', sku: 'T' + i, barcode: '', price: '100', available: true }],
  }));
  const pdp = productHtml({ '@type': 'Product', name: 'Bague', sku: 'S', offers: { '@type': 'Offer', price: 100, priceCurrency: 'EUR', availability: 'https://schema.org/InStock' } });
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch({
    [`${O}/`]: { body: '<html><script src="https://cdn.shopify.com/x.js"></script><script type="application/ld+json">{"@type":"Organization","name":"M"}</script><a href="/policies/refund-policy">Retours</a></html>' },
    [`${O}/robots.txt`]: { body: 'User-agent: GPTBot\nDisallow: /\nUser-agent: *\nDisallow: /cart\nSitemap: ' + O + '/sitemap.xml', type: 'text/plain' },
    [`${O}/products.json?limit=250&page=1`]: { body: { products } },
    [`${O}/products/*`]: { body: pdp },
    [`${O}/sitemap.xml`]: { body: `<sitemapindex><sitemap><loc>${O}/sitemap_products_1.xml</loc></sitemap></sitemapindex>`, type: 'application/xml' },
    [`${O}/sitemap_products_1.xml`]: { body: `<urlset><url><loc>${O}/</loc></url>${products.map((p) => `<url><loc>${O}/products/${p.handle}</loc></url>`).join('')}</urlset>`, type: 'application/xml' },
    [`${O}/cart.js`]: { body: { token: 'x', items: [] } },
    [`${O}/policies/refund-policy`]: { body: '<html>Retours 30 jours</html>' },
  });
  try {
    const r = await runAudit(O);
    assert.equal(r.platform, 'shopify');
    assert.equal(r.total, 20);
    assert.equal(r.subs.length, 4);
    assert.ok(r.score > 0 && r.score < 100, String(r.score));
    assert.ok(r.issues.length >= 3);
    assert.ok(r.potential >= r.score);
    assert.deepEqual(r.signals.blockedAgents, ['GPTBot']);
    assert.equal(r.signals.cartApi, true);
    console.log(JSON.stringify({ score: r.score, subs: r.subs.map((s) => `${s.label}:${s.v}`), issues: r.issues.map((i) => `${i.sev} ${i.title} +${i.gain} — ${i.detail}`), potential: r.potential, totalLabel: r.totalLabel }, null, 2));
  } finally {
    globalThis.fetch = orig;
  }
});

test('runAudit on a mocked generic store (sitemap + JSON-LD)', async () => {
  const O = 'https://93.184.216.35';
  const urls = Array.from({ length: 30 }, (_, i) => `${O}/fr/p/bague-${i}.html`);
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch({
    [`${O}/`]: { body: '<html><a href="/fr/livraison">Livraison</a></html>' },
    [`${O}/robots.txt`]: { body: `User-agent: *\nDisallow:\nSitemap: ${O}/sitemap-index.xml`, type: 'text/plain' },
    [`${O}/sitemap-index.xml`]: { body: `<sitemapindex><sitemap><loc>${O}/sitemap-products.xml</loc></sitemap><sitemap><loc>${O}/sitemap-pages.xml</loc></sitemap></sitemapindex>`, type: 'application/xml' },
    [`${O}/sitemap-products.xml`]: { body: `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`, type: 'application/xml' },
    [`${O}/fr/p/*`]: (u) => ({ body: productHtml({ '@type': 'Product', name: 'B', description: 'mot '.repeat(45), brand: 'G', image: 'x.jpg', mpn: 'M1', offers: { '@type': 'Offer', price: 1, priceCurrency: 'EUR', availability: 'InStock' } }) }),
    [`${O}/llms.txt`]: { body: '# Site\n> Boutique de bijoux en ligne, guide pour LLM', type: 'text/plain' },
  });
  try {
    const r = await runAudit(O);
    assert.equal(r.platform, 'unknown');
    assert.equal(r.total, 10);
    assert.match(r.totalLabel, /sur 30 au catalogue/);
    assert.equal(r.signals.llmsTxt, true);
    console.log(JSON.stringify({ score: r.score, subs: r.subs.map((s) => `${s.label}:${s.v}`), issues: r.issues.map((i) => `${i.sev} ${i.title} +${i.gain}`), totalLabel: r.totalLabel }, null, 2));
  } finally {
    globalThis.fetch = orig;
  }
});

test('runAudit reports bot walls', async () => {
  const O = 'https://93.184.216.36';
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch({ [`${O}/`]: { status: 403, body: '<title>Just a moment...</title>' } });
  try {
    await assert.rejects(runAudit(O), (e) => e.code === 'blocked');
  } finally { globalThis.fetch = orig; }
});

test('locale preference for sampling', async () => {
  const { preferLocale } = await import('../lib/audit/analyze.js');
  const mk = (pre, n) => Array.from({ length: n }, (_, i) => `https://x.com${pre}/p${i}.html`);
  assert.match(preferLocale([...mk('/de', 20), ...mk('', 15), ...mk('/en', 20)])[0], /x\.com\/p0/);
  assert.match(preferLocale([...mk('/de', 20), ...mk('/fr', 12)])[0], /\/fr\//);
  assert.match(preferLocale(mk('/de', 5))[0], /\/de\//);
});

test('product sitemap detection and locale ordering', async () => {
  const { sortByLocale } = await import('../lib/audit/analyze.js');
  const maps = ['https://x.com/sitemap/sitemap-de.xml', 'https://x.com/sitemap/sitemap-en-ch.xml', 'https://x.com/sitemap/sitemap-fr-ch.xml', 'https://x.com/sitemap/sitemap-fr.xml', 'https://x.com/sitemap_pages.xml'];
  assert.deepEqual(sortByLocale(maps.slice()).slice(0, 3), ['https://x.com/sitemap/sitemap-fr.xml', 'https://x.com/sitemap/sitemap-fr-ch.xml', 'https://x.com/sitemap_pages.xml']);
  const re = /(^|[/_.-])(products?|produits?|pdp|catalog(ue)?|articles?|items?)(?=[/_.-]|\d|$)/i;
  assert.equal(re.test('https://x.com/sitemap/sitemap-filtered-de.xml'), false);
  assert.equal(re.test('https://x.com/sitemap_products_1.xml?from=1'), true);
  assert.equal(re.test('https://x.com/product-sitemap.xml'), true);
});
