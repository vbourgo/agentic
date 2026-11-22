# Agent-Ready Check

Landing page + real "Agent-Ready" audit of any e-commerce site, deployed on Vercel.

## Layout

- `public/index.html` — landing page (bundle exported from the design tool, patched by `tools/patch_landing.py`)
- `public/newsletter.html` — "Add to Agent" newsletter page, served at `/newsletter`
- `api/audit.js` — `GET /api/audit?url=<shop>`: crawls the public site and returns the score report
- `api/lead.js` — `POST /api/lead`: e-mail that unlocks the detailed report
- `lib/audit/` — audit engine (fetching with SSRF guard, parsing, scoring)
- `test/` — unit + mocked end-to-end tests: `npm test`

Pushing to `main` deploys to production.

## How the score works

Four sub-scores (0–100), averaged into the global score:

| Sub-score | Checks (weight) |
|---|---|
| Attributs produits | structured colour/material/size (35), descriptions ≥ 40 words (25), category (15), images (15), brand (10) |
| Données structurées | schema.org Product JSON-LD (30), price + currency + availability (25), GTIN/EAN (20), structured variants (15), Organization/WebSite (10) |
| Compatibilité UCP / ACP | UCP profile at `/.well-known/ucp` (30), MCP endpoint (25), AI agents allowed in robots.txt (20), product sitemap/feed (15), `llms.txt` (10) |
| Checkout par un agent | product pages reachable by bots (20), public cart API (25), SKUs (15), machine-readable returns (15) and shipping (10), products in stock (10) |

On Shopify the catalog is read from the public `/products.json` (up to 1,000 products), plus `/api/mcp` and `/cart.js`.
Elsewhere, up to ~10 product pages are sampled from the product sitemap.
Each issue's "+N pts" is the global score recovered by fixing it.

## Leads

With `BREVO_API_KEY` set in the Vercel project, each unlock e-mail is upserted in Brevo:

- added to the list **Agent-Ready Check — audits** (folder "Agent-Ready Check"), created on first use;
  set `BREVO_LIST_ID` to use another list instead;
- with the contact attributes `AUDIT_DOMAIN` (text) and `AUDIT_SCORE` (number), created on first use.

Every lead is also written to the function logs (`lead {...}`), and a Brevo error never blocks the visitor.

## After re-exporting the landing page

```bash
python3 tools/patch_landing.py public/index.html
```
