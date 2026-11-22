# Agent-Ready Check

Landing page + real "Agent-Ready" audit of any e-commerce site, deployed on Vercel.

## Layout

- `public/index.html` — landing page (bundle exported from the design tool, patched by `tools/patch_landing.py`)
- `public/newsletter.html` — "Add to Agent" newsletter page, served at `/newsletter`
- `api/audit.js` — `GET /api/audit?url=<shop>`: crawls the public site and returns the score report
- `api/lead.js` — `POST /api/lead`: e-mails the full report to the visitor (Brevo) and saves the contact
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

## Report e-mail and leads

On the page, a visitor sees the global score, the verdict and the most critical issue.
The full report (sub-scores, every issue, potential score) is sent by e-mail through Brevo
when they leave their address; the page then only shows a confirmation.

`POST /api/lead` (`{ email, url }`) reads the report back from `/api/audit` with the same URL
(normally a CDN cache hit, so the e-mail matches what was shown), or recomputes it, then:

- sends it with Brevo's transactional API (`lib/email/report.js` builds the HTML and text);
- upserts the contact in the list **Agent-Ready Check — audits** with `AUDIT_DOMAIN` and `AUDIT_SCORE`
  (list and attributes are created on first use).

Environment variables (Vercel, Production):

| Variable | Required | Default |
|---|---|---|
| `BREVO_API_KEY` | yes (needs contacts + transactional e-mail access) | — |
| `BREVO_SENDER_EMAIL` | no | first active sender of the Brevo account |
| `BREVO_SENDER_NAME` | no | `Agent-Ready Check` |
| `BREVO_LIST_ID` | no | the "Agent-Ready Check — audits" list |

## After re-exporting the landing page

Extract the landing page from the design-tool export, then rebuild the production page from it:

```bash
python3 tools/patch_landing.py exported-landing.html public/index.html
```
