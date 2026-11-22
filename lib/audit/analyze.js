// Agent-Ready audit: crawls a public e-commerce site and scores how well
// AI shopping agents can read its catalog and buy from it.
import { fetchSafe, parseJsonSafe, mapLimit } from './net.js';
import {
  extractJsonLd, isType, asArray, metaContent, hasMicrodataProduct, extractLinks,
  parseSitemap, parseRobots, robotsBlocksAgent, looksLikeBotWall, wordCount,
} from './parse.js';

export class AuditError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const PLATFORM_LABELS = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  sfcc: 'Salesforce Commerce Cloud',
  magento: 'Adobe Commerce (Magento)',
  prestashop: 'PrestaShop',
  bigcommerce: 'BigCommerce',
  shopware: 'Shopware',
  wix: 'Wix',
  squarespace: 'Squarespace',
  unknown: 'Plateforme non identifiée',
};

const AI_AGENTS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'Google-Extended', 'ClaudeBot',
  'Claude-User', 'Claude-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Applebot-Extended',
];

const KEY_ATTR_RE = /(couleur|coloris|colou?r|teinte|farbe|colore|mati[eè]re|mat[ée]riau|material|composition|tissu|fabric|cuir|leather|m[ée]tal|metal|carat|pierre|gem|stone|diamant|diamond|size|taille|pointure|tour de doigt|longueur|length|largeur|width|dimension|gr[öo]ß?e|talla|taglia|finition|finish|motif|pattern|parfum|scent|contenance|volume|poids|weight)/i;

const PRODUCT_URL_RE = /\/(products?|produits?|p|item|items|artikel|dp|pd|shop\/[^/]+)\/[^/?#]{2,}|[-_/]p[-_]?\d{3,}|\/\d{5,}(?:[/?.#-]|$)|\.html?(?:[?#]|$)/i;
const NON_PRODUCT_RE = /\/(blogs?|pages?|collections?|categor(y|ies)|cart|panier|account|compte|search|recherche|policies|cgv|faq|contact|about|journal|magazine|stores?|boutiques?|magasins?)(\/|$)|\/(index|sitemap)[^/]*\.html?$/i;

const SUB_LABELS = {
  attrs: 'Attributs produits',
  data: 'Données structurées',
  proto: 'Compatibilité UCP / ACP',
  checkout: 'Checkout par un agent',
};

export function colorFor(v) {
  return v < 45 ? '#FF453A' : v < 70 ? '#FF9F0A' : '#30D158';
}

export function normalizeTarget(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new AuditError('invalid_url', 'Indiquez l’adresse de votre boutique.');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let u;
  try { u = new URL(raw); } catch { throw new AuditError('invalid_url', 'Cette adresse n’est pas valide.'); }
  if (!u.hostname.includes('.') || u.hostname.length > 253) {
    throw new AuditError('invalid_url', 'Cette adresse n’est pas valide.');
  }
  u.protocol = 'https:';
  return { url: `https://${u.hostname}/`, host: u.hostname };
}

export function detectPlatform(html, headers) {
  const h = (k) => headers?.get?.(k) || '';
  if (/cdn\.shopify\.com|Shopify\.theme|shopify-section|\.myshopify\.com/i.test(html) || h('x-shopid') || h('x-shopify-stage') || /shopify/i.test(h('powered-by'))) return 'shopify';
  if (/demandware\.static|\/on\/demandware\.store\//i.test(html)) return 'sfcc';
  if (/woocommerce/i.test(html)) return 'woocommerce';
  if (/Magento_|mage\/cookies|requirejs-config|static\/version\d+\//i.test(html) || h('x-magento-tags') || h('x-magento-cache-debug')) return 'magento';
  if (/prestashop/i.test(html)) return 'prestashop';
  if (/cdn\d*\.bigcommerce\.com/i.test(html)) return 'bigcommerce';
  if (/shopware/i.test(html)) return 'shopware';
  if (/static\.wixstatic\.com/i.test(html)) return 'wix';
  if (/static1\.squarespace\.com/i.test(html)) return 'squarespace';
  return 'unknown';
}

function spread(list, n) {
  if (list.length <= n) return list.slice();
  const out = [];
  const step = list.length / n;
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step + step / 2)]);
  return out;
}

// When the catalog is split by locale (/de/, /en-gb/…), prefer French pages, then the
// site's default language (no locale prefix), then English.
const LOCALE_PREFIX = /^\/[a-z]{2}(?:[-_][a-z]{2})?\//i;
export function preferLocale(urls) {
  const path = (u) => { try { return new URL(u).pathname; } catch { return ''; } };
  const filters = [
    (p) => /^\/fr(?:[-_][a-z]{2})?\//i.test(p),
    (p) => !LOCALE_PREFIX.test(p),
    (p) => /^\/en(?:[-_][a-z]{2})?\//i.test(p),
  ];
  for (const f of filters) {
    const picked = urls.filter((u) => f(path(u)));
    if (picked.length >= 10) return picked;
  }
  return urls;
}

function isRootUrl(u) {
  try { return new URL(u).pathname.replace(/\/+$/, '') === ''; } catch { return true; }
}

// ---------- product page analysis (JSON-LD) ----------

const offerList = (p) => asArray(p?.offers).flatMap((o) => (isType(o, 'AggregateOffer') && o.offers ? [o, ...asArray(o.offers)] : [o]));

export function analyzeProductPage(html) {
  const { nodes } = extractJsonLd(html);
  const products = nodes.filter((n) => isType(n, 'Product', 'ProductGroup', 'IndividualProduct', 'ProductModel'));
  const group = products.find((n) => isType(n, 'ProductGroup'));
  const main = group || products.find((n) => n.name) || products[0] || null;
  const variants = group ? asArray(group.hasVariant) : products.filter((p) => p !== main && p.isVariantOf);
  const all = [main, ...variants].filter((x) => x && typeof x === 'object');
  const offers = all.flatMap(offerList).filter((o) => o && typeof o === 'object');
  const anyOf = (arr, fn) => arr.some((x) => { try { return !!fn(x); } catch { return false; } });
  const gtinOf = (x) => x.gtin || x.gtin8 || x.gtin12 || x.gtin13 || x.gtin14 || x.isbn;
  const attrs = new Set();
  for (const p of all) {
    for (const k of ['color', 'material', 'size', 'pattern']) if (p[k]) attrs.add(k);
    for (const ap of asArray(p.additionalProperty)) if (ap?.name && KEY_ATTR_RE.test(String(ap.name))) attrs.add(String(ap.name).toLowerCase());
  }
  if (group?.variesBy) asArray(group.variesBy).forEach((v) => attrs.add(String(v).replace(/^https?:\/\/schema\.org\//, '').toLowerCase()));
  const description = main?.description || '';
  return {
    ldKeys: main ? Object.keys(main).filter((k) => !k.startsWith('@')).slice(0, 30) : [],
    offerKeys: offers[0] ? Object.keys(offers[0]).filter((k) => !k.startsWith('@')).slice(0, 20) : [],
    hasLd: !!main,
    hasMicrodata: hasMicrodataProduct(html),
    ogProduct: /product/i.test(metaContent(html, 'og:type') || '') || !!metaContent(html, 'product:price:amount'),
    name: main?.name || null,
    words: wordCount(typeof description === 'string' ? description : ''),
    category: !!(main?.category),
    brand: anyOf(all, (p) => p.brand),
    image: anyOf(all, (p) => asArray(p.image).length),
    imageCount: main ? asArray(main.image).length : 0,
    keyAttr: attrs.size > 0,
    attrs: [...attrs],
    isGroup: !!group || products.some((p) => p.isVariantOf) || offers.filter((o) => !isType(o, 'AggregateOffer')).length > 1,
    price: anyOf(offers, (o) => o.price != null || o.lowPrice != null || o.priceSpecification?.price != null),
    currency: anyOf(offers, (o) => o.priceCurrency || o.priceSpecification?.priceCurrency),
    availability: anyOf(offers, (o) => o.availability),
    inStock: anyOf(offers, (o) => /InStock|LimitedAvailability|PreOrder|OnlineOnly|BackOrder|MadeToOrder/i.test(String(o.availability))),
    gtin: anyOf(all, gtinOf) || anyOf(offers, gtinOf),
    mpn: anyOf(all, (p) => p.mpn) || anyOf(offers, (o) => o.mpn),
    sku: anyOf(all, (p) => p.sku) || anyOf(offers, (o) => o.sku),
    rating: anyOf(all, (p) => p.aggregateRating),
    returnPolicy: anyOf(offers, (o) => o.hasMerchantReturnPolicy) || anyOf(all, (p) => p.hasMerchantReturnPolicy) || nodes.some((n) => isType(n, 'MerchantReturnPolicy')),
    shipping: anyOf(offers, (o) => o.shippingDetails) || nodes.some((n) => isType(n, 'OfferShippingDetails')),
  };
}

// ---------- Shopify catalog analysis (products.json) ----------

export function analyzeShopifyProduct(p) {
  const optNames = asArray(p.options).map((o) => (typeof o === 'string' ? o : o?.name)).filter((n) => n && !/^title$/i.test(n));
  const tags = Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const variants = asArray(p.variants);
  const multi = variants.length > 1;
  const tagAttr = tags.some((t) => /[:_=]/.test(t) && KEY_ATTR_RE.test(t));
  const freeTextVariant = optNames.length === 1 && variants.some((v) => /\s[/|–-]\s|,\s/.test(String(v.option1 || '')));
  return {
    keyAttr: optNames.some((n) => KEY_ATTR_RE.test(n)) || tagAttr,
    words: wordCount(p.body_html || ''),
    category: !!String(p.product_type || '').trim(),
    brand: !!String(p.vendor || '').trim(),
    imageCount: asArray(p.images).length,
    multi,
    poorVariants: multi && (optNames.length === 0 || optNames.some((n) => /^option\s*\d*$/i.test(n)) || freeTextVariant),
    barcodeField: variants.some((v) => Object.prototype.hasOwnProperty.call(v, 'barcode')),
    gtin: variants.length > 0 && variants.every((v) => /^(\d{8}|\d{12,14})$/.test(String(v.barcode || '').trim())),
    sku: variants.length > 0 && variants.every((v) => String(v.sku || '').trim()),
    available: variants.some((v) => v.available !== false),
  };
}

// ---------- discovery ----------

async function fetchShopifyCatalog(origin, deadline) {
  const first = await fetchSafe(`${origin}/products.json?limit=250&page=1`, { accept: 'application/json', timeout: 9000, maxBytes: 12_000_000 });
  const j = first.ok ? parseJsonSafe(first.text) : null;
  if (!j || !Array.isArray(j.products)) return null;
  let products = j.products;
  if (products.length === 250 && Date.now() < deadline - 12000) {
    const more = await Promise.all([2, 3, 4].map((page) => fetchSafe(`${origin}/products.json?limit=250&page=${page}`, { accept: 'application/json', timeout: 9000, maxBytes: 12_000_000 })));
    for (const r of more) {
      const jj = r.ok ? parseJsonSafe(r.text) : null;
      if (jj && Array.isArray(jj.products)) products = products.concat(jj.products);
    }
  }
  const seen = new Set();
  products = products.filter((p) => p && !seen.has(p.id) && seen.add(p.id));
  return { products, capped: products.length >= 1000 };
}

async function discoverFromSitemaps(origin, robots) {
  const roots = robots.sitemaps.length ? robots.sitemaps.slice(0, 3) : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const xmlAccept = 'application/xml,text/xml;q=0.9,*/*;q=0.5';
  const rootRes = await Promise.all(roots.map((u) => fetchSafe(u, { accept: xmlAccept, timeout: 8000, maxBytes: 10_000_000 })));
  let sitemapFound = false;
  const productMaps = [];
  const otherMaps = [];
  let urls = [];
  for (const r of rootRes) {
    if (!r.ok || !/<(urlset|sitemapindex)/i.test(r.text)) continue;
    sitemapFound = true;
    const p = parseSitemap(r.text);
    for (const s of p.sitemaps) (/product|produit|pdp|catalog|article|item/i.test(s) ? productMaps : otherMaps).push(s);
    urls = urls.concat(p.urls);
  }
  let productUrls = [];
  let productSitemap = false;
  let moreMaps = false;
  if (productMaps.length) {
    const rs = await Promise.all(productMaps.slice(0, 2).map((u) => fetchSafe(u, { accept: xmlAccept, timeout: 8000, maxBytes: 12_000_000 })));
    for (const r of rs) if (r.ok) productUrls = productUrls.concat(parseSitemap(r.text).urls);
    productSitemap = productUrls.length > 0;
    moreMaps = productMaps.length > 2;
  } else {
    if (!urls.length && otherMaps.length) {
      const rs = await Promise.all(otherMaps.slice(0, 3).map((u) => fetchSafe(u, { accept: xmlAccept, timeout: 8000, maxBytes: 12_000_000 })));
      for (const r of rs) if (r.ok) urls = urls.concat(parseSitemap(r.text).urls);
    }
    productUrls = urls.filter((u) => PRODUCT_URL_RE.test(u) && !NON_PRODUCT_RE.test(u));
  }
  productUrls = [...new Set(productUrls.filter((u) => !isRootUrl(u)))];
  return {
    sampleUrls: preferLocale(productUrls), sitemapFound, productSitemap, productUrls, estimatedTotal: productSitemap ? productUrls.length : null, moreMaps };
}

async function probeShopifyMcp(origin) {
  const res = await fetchSafe(`${origin}/api/mcp`, {
    method: 'POST',
    accept: 'application/json, text/event-stream',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    timeout: 7000,
  });
  if (!res.ok) return { ok: false };
  const body = res.text.includes('data:') ? res.text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') : res.text;
  const j = parseJsonSafe(body);
  const tools = j?.result?.tools;
  return { ok: Array.isArray(tools), tools: Array.isArray(tools) ? tools.map((t) => t.name).slice(0, 12) : [] };
}

async function probeJson(url) {
  const r = await fetchSafe(url, { accept: 'application/json', timeout: 6000, maxBytes: 500_000 });
  const j = r.ok && !/text\/html/i.test(r.contentType) ? parseJsonSafe(r.text) : null;
  return { ok: !!j && typeof j === 'object', status: r.status, json: j };
}

async function probeText(url) {
  const r = await fetchSafe(url, { accept: 'text/plain,text/markdown,*/*;q=0.5', timeout: 6000, maxBytes: 300_000 });
  const ok = r.ok && !/text\/html/i.test(r.contentType) && !/^\s*</.test(r.text) && r.text.trim().length > 20;
  return { ok, status: r.status };
}

async function probePage(url) {
  const r = await fetchSafe(url, { timeout: 6000, maxBytes: 200_000 });
  return { ok: r.ok && !looksLikeBotWall(r), status: r.status };
}

// ---------- scoring ----------

function share(items, pred) {
  if (!items.length) return null;
  const n = items.filter(pred).length;
  return { value: n / items.length, yes: n, no: items.length - n, total: items.length };
}

function buildChecks(ctx) {
  const { catalog, pages, isShopifyCatalog } = ctx;
  const P = isShopifyCatalog ? catalog : pages; // product-level source
  const N = P.length;
  const S = pages.length;
  const unit = isShopifyCatalog ? 'produits' : 'fiches';
  const checks = [];
  const add = (sub, id, weight, s, issue) => {
    if (s == null) return;
    const value = typeof s === 'number' ? s : s.value;
    if (value == null || Number.isNaN(value)) return;
    checks.push({ sub, id, weight, value: Math.max(0, Math.min(1, value)), issue: typeof issue === 'function' ? issue(s) : issue });
  };

  // A. Attributs produits
  add('attrs', 'key_attributes', 35, share(P, (p) => p.keyAttr), (s) => ({
    title: 'Attributs clés manquants',
    detail: `${s.no} ${unit} sur ${N} sans matière, taille ou couleur structurées`,
  }));
  add('attrs', 'descriptions', 25, share(P, (p) => p.words >= 40), (s) => ({
    title: 'Descriptions trop pauvres',
    detail: `${s.no} ${unit} sur ${N} avec une description de moins de 40 mots, invisible aux requêtes par intention`,
  }));
  add('attrs', 'category', 15, share(P, (p) => p.category), (s) => ({
    title: 'Catégorie produit non renseignée',
    detail: `${s.no} ${unit} sur ${N} sans type ou catégorie exploitable par un agent`,
  }));
  add('attrs', 'images', 15, share(P, (p) => (isShopifyCatalog ? p.imageCount >= 2 : p.image)), (s) => ({
    title: 'Visuels insuffisants',
    detail: isShopifyCatalog ? `${s.no} produits sur ${N} avec moins de 2 images` : `${s.no} fiches sur ${N} sans image déclarée dans les données`,
  }));
  add('attrs', 'brand', 10, share(P, (p) => p.brand), (s) => ({
    title: 'Marque non déclarée',
    detail: `${s.no} ${unit} sur ${N} sans marque explicite`,
  }));

  // B. Données structurées
  add('data', 'product_ld', 30, share(pages, (p) => p.hasLd), (s) => (s.yes === 0
    ? { title: 'Aucun balisage schema.org Product', detail: 'Les agents ne peuvent pas lire prix, stock et disponibilité de façon fiable' }
    : { title: 'Balisage schema.org Product incomplet', detail: `${s.no} fiches sur ${S} analysées sans balisage Product` }));
  add('data', 'offer_data', 25, share(pages, (p) => p.price && p.currency && p.availability), (s) => ({
    title: 'Prix et stock non lisibles par machine',
    detail: `${s.no} fiches sur ${S} analysées sans prix, devise ou disponibilité structurés`,
  }));
  // Shopify's public feed does not always expose barcodes: fall back to the pages' JSON-LD.
  const catalogHasBarcodes = isShopifyCatalog && catalog.some((p) => p.barcodeField);
  add('data', 'identifiers', 20,
    catalogHasBarcodes ? share(catalog, (p) => p.gtin) : (S ? { ...share(pages, (p) => p.gtin), value: pages.reduce((a, p) => a + (p.gtin ? 1 : p.mpn ? 0.5 : 0), 0) / S } : null),
    (s) => ({
      title: 'GTIN / EAN absents',
      detail: catalogHasBarcodes
        ? `${s.no} produits sur ${N} impossibles à rapprocher d’une recherche précise`
        : pages.some((p) => p.mpn && !p.gtin)
          ? `${s.no} fiches sur ${S} analysées sans GTIN / EAN (référence fabricant seule) : rapprochement incertain par les agents`
          : `${s.no} fiches sur ${S} analysées sans GTIN / EAN : impossibles à rapprocher d’une recherche précise`,
    }));
  if (isShopifyCatalog) {
    const multi = catalog.filter((p) => p.multi);
    add('data', 'variants', 15, share(multi, (p) => !p.poorVariants), (s) => ({
      title: 'Variantes mal structurées',
      detail: `${s.no} produits sur ${multi.length} à déclinaisons avec tailles ou coloris en texte libre`,
    }));
  } else {
    const multi = pages.filter((p) => p.hasLd);
    add('data', 'variants', 10, multi.length ? share(multi, (p) => p.isGroup || p.keyAttr) : null, (s) => ({
      title: 'Variantes mal structurées',
      detail: `${s.no} fiches sur ${multi.length} sans déclinaisons (taille, matière, coloris) décrites dans les données`,
    }));
  }
  add('data', 'organization', 10, (ctx.homeOrg ? 0.5 : 0) + (ctx.homeWebsite ? 0.5 : 0), {
    title: 'Identité marchande non structurée',
    detail: 'Pas de balisage Organization / WebSite complet sur la page d’accueil',
  });

  // C. Compatibilité UCP / ACP / MCP
  add('proto', 'ucp', 30, ctx.ucp ? 1 : 0, {
    title: 'Aucun profil UCP publié',
    detail: 'Google AI Mode et Gemini ne trouvent pas de point d’entrée commerce sur /.well-known/ucp',
  });
  add('proto', 'mcp', 25, ctx.mcp ? 1 : 0, {
    title: 'Aucun connecteur MCP exposé',
    detail: 'Claude, ChatGPT et les autres agents ne peuvent pas interroger votre catalogue',
  });
  add('proto', 'ai_bots', 20, ctx.robots ? { value: 1 - ctx.blockedAgents.length / AI_AGENTS.length } : 1, {
    title: 'Agents IA bloqués dans robots.txt',
    detail: `${ctx.blockedAgents.slice(0, 4).join(', ')}${ctx.blockedAgents.length > 4 ? '…' : ''} interdits d’accès au site`,
  });
  add('proto', 'catalog_feed', 15, ctx.catalogFeed, {
    title: 'Catalogue difficile à découvrir',
    detail: 'Pas de sitemap produits ni de flux public : les agents doivent deviner vos URL',
  });
  add('proto', 'llms_txt', 10, ctx.llms ? 1 : 0, {
    title: 'Pas de fichier llms.txt',
    detail: 'Aucun guide de lecture du site destiné aux modèles d’IA',
  });

  // D. Checkout par un agent
  add('checkout', 'page_access', 20, ctx.pageAccess, (s) => ({
    title: 'Pages produit bloquées aux robots',
    detail: `${s.no} fiches sur ${s.total} refusées à un visiteur automatisé`,
  }));
  add('checkout', 'cart_api', 25, ctx.cartApi || ctx.mcp ? 1 : 0, {
    title: 'Panier non pilotable par un agent',
    detail: 'Aucune API panier publique : l’agent ne peut pas préparer la commande',
  });
  add('checkout', 'sku', 15, share(P, (p) => p.sku), (s) => ({
    title: 'Références (SKU) manquantes',
    detail: `${s.no} ${unit} sur ${N} sans SKU : l’agent ne peut pas choisir la bonne déclinaison`,
  }));
  add('checkout', 'returns', 15, ctx.returnsLd ? 1 : ctx.returnsPage ? 0.4 : 0, {
    title: 'Politique de retour non lisible par machine',
    detail: 'Les agents écartent les marchands aux conditions ambiguës',
  });
  add('checkout', 'shipping', 10, ctx.shippingLd ? 1 : ctx.shippingPage ? 0.4 : 0, {
    title: 'Livraison non lisible par machine',
    detail: 'Délais et frais de livraison absents des données structurées',
  });
  add('checkout', 'in_stock', 10,
    isShopifyCatalog ? share(catalog, (p) => p.available) : share(pages.filter((p) => p.availability), (p) => p.inStock),
    (s) => ({ title: 'Produits indisponibles', detail: `${s.no} ${unit} sur ${s.total} indisponibles à l’achat : les agents passent à une autre boutique` }));
  return checks;
}

export function scoreChecks(checks) {
  const subs = {};
  for (const key of Object.keys(SUB_LABELS)) {
    const list = checks.filter((c) => c.sub === key);
    const wsum = list.reduce((a, c) => a + c.weight, 0);
    subs[key] = { list, wsum, v: wsum ? Math.round((100 * list.reduce((a, c) => a + c.weight * c.value, 0)) / wsum) : null };
  }
  const active = Object.values(subs).filter((s) => s.v != null);
  const score = Math.round(active.reduce((a, s) => a + s.v, 0) / active.length);
  // Global points recoverable per check.
  let issues = [];
  for (const s of active) {
    for (const c of s.list) {
      const gain = ((c.weight * (1 - c.value)) / s.wsum) * 100 / active.length;
      if (c.value < 0.95 && gain >= 0.75) issues.push({ id: c.id, gain, ...c.issue });
    }
  }
  // Merge "no UCP" + "no MCP" into the single headline issue.
  const ucp = issues.find((i) => i.id === 'ucp');
  const mcp = issues.find((i) => i.id === 'mcp');
  if (ucp && mcp) {
    issues = issues.filter((i) => i !== ucp && i !== mcp);
    issues.push({ id: 'connectors', gain: ucp.gain + mcp.gain, title: 'Aucun connecteur UCP ou MCP exposé', detail: 'Gemini, ChatGPT et Claude ne peuvent pas passer commande chez vous' });
  }
  issues.sort((a, b) => b.gain - a.gain);
  const lost = issues.reduce((a, i) => a + i.gain, 0);
  const potential = Math.max(score, Math.min(95, Math.round(score + 0.8 * lost)));
  const sevColor = ['#FF453A', '#FF9F0A', '#A1A1A6'];
  const sevLabel = ['Critique', 'Important', 'Modéré'];
  issues = issues.slice(0, 8).map((i) => {
    const rank = i.gain >= 5 ? 0 : i.gain >= 2.5 ? 1 : 2;
    return { id: i.id, sev: sevLabel[rank], rank, color: sevColor[rank], title: i.title, detail: i.detail, gain: Math.max(1, Math.round(i.gain)) };
  });
  return {
    score,
    subs: Object.entries(subs).filter(([, s]) => s.v != null).map(([k, s]) => ({ key: k, label: SUB_LABELS[k], v: s.v, color: colorFor(s.v) })),
    issues,
    potential,
  };
}

function verdictFor(score) {
  if (score < 45) return { tag: 'Pas prêt', title: 'Pas prêt pour le commerce agentique.', text: 'Les agents IA ne peuvent ni comprendre ni acheter la majorité de vos produits. Vos concurrents mieux structurés captent ces ventes.' };
  if (score < 70) return { tag: 'Partiellement prêt', title: 'Partiellement prêt pour le commerce agentique.', text: 'Les agents trouvent une partie de vos produits, mais échouent souvent au moment de comparer ou d’acheter.' };
  return { tag: 'Prêt', title: 'Prêt pour le commerce agentique.', text: 'Votre catalogue est lisible par les agents. Quelques ajustements maximiseront vos ventes.' };
}

const fmt = (n) => new Intl.NumberFormat('fr-FR').format(n);

// ---------- main ----------

export async function runAudit(input, { budgetMs = 45000 } = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const target = normalizeTarget(input);

  let home = await fetchSafe(target.url, { timeout: 10000 });
  if (!home.ok && home.status === 0 && !/^www\./.test(target.host)) {
    const alt = await fetchSafe(target.url.replace('://', '://www.'), { timeout: 10000 });
    if (alt.ok || alt.status) home = alt;
  }
  if (home.error === 'blocked_host' || home.error === 'bad_protocol') throw new AuditError('invalid_url', 'Cette adresse n’est pas un site public.');
  if (!home.status) throw new AuditError('unreachable', `Impossible de joindre ${target.host}. Vérifiez l’adresse et réessayez.`);
  if (looksLikeBotWall(home)) {
    throw new AuditError('blocked', `${target.host} bloque les visites automatisées (protection anti-robot). Les agents IA risquent d’être refusés eux aussi. Contactez-nous pour un audit manuel.`);
  }
  if (!home.ok) throw new AuditError('unreachable', `${target.host} répond avec une erreur (${home.status}).`);

  const origin = new URL(home.url).origin;
  const domain = new URL(home.url).hostname.replace(/^www\./, '');
  const platform = detectPlatform(home.text, home.headers);
  const homeLd = extractJsonLd(home.text).nodes;
  const tryShopify = platform === 'shopify' || platform === 'unknown';

  const robotsRes = await fetchSafe(`${origin}/robots.txt`, { accept: 'text/plain,*/*;q=0.5', timeout: 6000, maxBytes: 500_000 });
  const robotsOk = robotsRes.ok && !/^\s*</.test(robotsRes.text);
  const robots = parseRobots(robotsOk ? robotsRes.text : '');

  const [llms, ucpRes, mcpWk, mcpWk2, shopCatalog, sitemap, cartRes, wooRes, mcpShop] = await Promise.all([
    probeText(`${origin}/llms.txt`),
    probeJson(`${origin}/.well-known/ucp`),
    probeJson(`${origin}/.well-known/mcp.json`),
    probeJson(`${origin}/.well-known/mcp`),
    tryShopify ? fetchShopifyCatalog(origin, deadline) : Promise.resolve(null),
    discoverFromSitemaps(origin, robots),
    tryShopify ? probeJson(`${origin}/cart.js`) : Promise.resolve({ ok: false }),
    platform === 'woocommerce' ? probeJson(`${origin}/wp-json/wc/store/v1/cart`) : Promise.resolve({ ok: false }),
    tryShopify ? probeShopifyMcp(origin) : Promise.resolve({ ok: false }),
  ]);

  const isShopifyCatalog = !!(shopCatalog && shopCatalog.products.length);
  const effectivePlatform = isShopifyCatalog ? 'shopify' : platform;

  // Product pages to sample for structured data.
  let candidates;
  if (isShopifyCatalog) {
    candidates = spread(shopCatalog.products.map((p) => `${origin}/products/${p.handle}`), 6);
  } else {
    let urls = sitemap.sampleUrls;
    if (!urls.length) urls = extractLinks(home.text, origin).filter((u) => PRODUCT_URL_RE.test(u) && !NON_PRODUCT_RE.test(u));
    candidates = spread(urls, 10);
  }
  const pageFetches = [];
  const runBatch = async (urls) => {
    const res = await mapLimit(urls, 5, (u) => fetchSafe(u, { timeout: Math.max(3000, Math.min(9000, deadline - Date.now() - 2000)), maxBytes: 4_000_000 }));
    res.forEach((r, i) => pageFetches.push({ url: urls[i], res: r }));
  };
  await runBatch(candidates);
  if (!isShopifyCatalog) {
    const valid = () => pageFetches.filter((p) => p.res.ok && analyzeProductPage(p.res.text).hasLd).length;
    if (valid() < 3 && Date.now() < deadline - 12000) {
      const pool = (sitemap.sampleUrls.length ? sitemap.sampleUrls : extractLinks(home.text, origin))
        .filter((u) => !candidates.includes(u) && !NON_PRODUCT_RE.test(u) && !isRootUrl(u));
      if (pool.length) await runBatch(spread(pool, 8));
    }
  }

  const fetchedOk = pageFetches.filter((p) => p.res.ok && !looksLikeBotWall(p.res));
  const walled = pageFetches.filter((p) => looksLikeBotWall(p.res));
  let pages = fetchedOk.map((p) => ({ url: p.url, ...analyzeProductPage(p.res.text) }));
  if (!isShopifyCatalog) {
    // Keep pages that are really product pages.
    const productPages = pages.filter((p) => p.hasLd || p.hasMicrodata || p.ogProduct);
    pages = productPages.length ? productPages : [];
  }
  const catalog = isShopifyCatalog ? shopCatalog.products.map(analyzeShopifyProduct) : [];

  if (!isShopifyCatalog && !pages.length) {
    if (walled.length) throw new AuditError('blocked', `Les fiches produit de ${domain} bloquent les visites automatisées. Les agents IA risquent d’être refusés eux aussi.`);
    throw new AuditError('no_products', `Nous n’avons trouvé aucune fiche produit lisible sur ${domain}. Est-ce bien l’adresse d’une boutique en ligne ?`);
  }

  // Policies (returns / shipping) as pages, used for partial credit.
  const homeLinks = extractLinks(home.text, origin);
  const returnsLink = homeLinks.find((u) => /retour|return|refund|rembourse/i.test(u));
  const shippingLink = homeLinks.find((u) => /livraison|shipping|delivery|expedition/i.test(u));
  const [returnsPage, shippingPage] = await Promise.all([
    effectivePlatform === 'shopify' ? probePage(`${origin}/policies/refund-policy`) : Promise.resolve({ ok: !!returnsLink }),
    effectivePlatform === 'shopify' ? probePage(`${origin}/policies/shipping-policy`) : Promise.resolve({ ok: !!shippingLink }),
  ]);

  const homeOrg = homeLd.some((n) => isType(n, 'Organization', 'OnlineStore', 'Store', 'Corporation', 'LocalBusiness', 'Brand', 'JewelryStore', 'ClothingStore'));
  const homeWebsite = homeLd.some((n) => isType(n, 'WebSite'));
  const orgReturns = homeLd.some((n) => n.hasMerchantReturnPolicy || isType(n, 'MerchantReturnPolicy'));
  const orgShipping = homeLd.some((n) => n.shippingDetails || isType(n, 'OfferShippingDetails', 'ShippingService'));
  const blockedAgents = robotsOk ? AI_AGENTS.filter((a) => robotsBlocksAgent(robots, a)) : [];
  const attempted = pageFetches.filter((p) => p.res.status);

  const ctx = {
    catalog,
    pages,
    isShopifyCatalog,
    homeOrg,
    homeWebsite,
    ucp: ucpRes.ok,
    mcp: mcpShop.ok || mcpWk.ok || mcpWk2.ok,
    robots: robotsOk,
    blockedAgents,
    catalogFeed: isShopifyCatalog || sitemap.productSitemap ? 1 : sitemap.sitemapFound ? 0.5 : 0,
    llms: llms.ok,
    pageAccess: attempted.length ? share(attempted, (p) => p.res.ok && !looksLikeBotWall(p.res)) : null,
    cartApi: cartRes.ok || wooRes.ok,
    returnsLd: orgReturns || pages.some((p) => p.returnPolicy),
    returnsPage: returnsPage.ok,
    shippingLd: orgShipping || pages.some((p) => p.shipping),
    shippingPage: shippingPage.ok,
  };

  const checks = buildChecks(ctx);
  const scored = scoreChecks(checks);
  const verdict = verdictFor(scored.score);

  let total;
  let totalLabel;
  if (isShopifyCatalog) {
    total = catalog.length;
    totalLabel = `${fmt(total)}${shopCatalog.capped ? '+' : ''} produits analysés`;
  } else {
    total = pages.length;
    const est = sitemap.estimatedTotal;
    totalLabel = `${total} fiches produit analysées${est && est > total ? ` sur ${fmt(est)}${sitemap.moreMaps ? '+' : ''} au catalogue` : ''}`;
  }

  return {
    domain,
    url: origin,
    platform: effectivePlatform,
    platformLabel: PLATFORM_LABELS[effectivePlatform] || PLATFORM_LABELS.unknown,
    score: scored.score,
    color: colorFor(scored.score),
    verdict,
    subs: scored.subs,
    issues: scored.issues,
    potential: scored.potential,
    total,
    totalLabel,
    analyzedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    signals: {
      pagesAnalyzed: pages.length,
      catalogAnalyzed: isShopifyCatalog ? catalog.length : null,
      ucpProfile: ucpRes.ok,
      mcp: { shopify: mcpShop.ok, tools: mcpShop.tools || [], wellKnown: mcpWk.ok || mcpWk2.ok },
      llmsTxt: llms.ok,
      robotsTxt: robotsOk,
      blockedAgents,
      sitemap: { found: sitemap.sitemapFound, productSitemap: sitemap.productSitemap, productUrls: sitemap.productUrls.length },
      cartApi: ctx.cartApi,
      samples: pages.slice(0, 3).map((p) => ({ url: p.url, attrs: p.attrs, ldKeys: p.ldKeys, offerKeys: p.offerKeys })),
      checks: checks.map((c) => ({ sub: c.sub, id: c.id, weight: c.weight, value: Math.round(c.value * 100) / 100 })),
    },
  };
}
