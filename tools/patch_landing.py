#!/usr/bin/env python3
"""Turn the landing page exported from the design tool into the production page.

The export is a self-contained bundle: its markup lives in a JSON string inside
<script type="__bundler/template">. Starting from an untouched export, this script:

- points the internal links to / and /newsletter and adds the mobile viewport;
- swaps the simulated audit for tools/landing-logic.js (real /api/audit call);
- shows only the global score, the verdict and the most critical issue;
- adds the e-mail form that sends the full report (/api/lead), its confirmation,
  the consent notice and the error state;
- removes the "6 / Jan. 2026 / 0 clic" cards, adds a "Voir nos offres" button to
  the method block, makes the logo link to the home page, enables smooth scrolling.

For the newsletter page it fixes the links (logo and menu back to the home page
sections) and adds the mobile viewport.

Usage, after re-exporting the pages from the design tool:
    python3 tools/patch_landing.py landing <exported-landing.html> public/index.html
    python3 tools/patch_landing.py newsletter <exported-newsletter.html> public/newsletter.html
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OPEN = '<script type="__bundler/template">'
SR_ONLY = 'position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)'
VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">'

GATE = f'''
<sc-if value="{{{{showGate}}}}" hint-placeholder-val="{{{{ true }}}}">
<div style="display: flex; flex-direction: column; gap: 14px; padding: 24px 0 8px; border-top: 1px solid #2C2C2E">
<div style="display: flex; flex-direction: column; gap: 4px">
<span style="font-size: 17px; font-weight: 600; color: #F5F5F7">{{{{gateTitle}}}}</span>
<span style="font-size: 15px; color: #A1A1A6">{{{{gateText}}}}</span>
</div>
<form class="arc-pill-form" sc-camel-on-submit="{{{{onGateSubmit}}}}" style="width: 100%; max-width: 560px; display: flex; flex-wrap: wrap; gap: 10px; padding: 6px; box-sizing: border-box; background: #1C1C1E; border: 1px solid #2C2C2E; border-radius: 30px">
<label for="gate-email" style="{SR_ONLY}">Votre e-mail professionnel</label>
<input id="gate-email" type="email" autocomplete="email" placeholder="vous@marque.com" value="{{{{gateEmail}}}}" sc-camel-on-change="{{{{onGateEmail}}}}" style="flex: 1 1 200px; min-width: 0; min-height: 52px; box-sizing: border-box; padding: 0 20px; font-size: 17px; font-family: Inter, sans-serif; color: #F5F5F7; background: transparent; border: none; border-radius: 999px; outline: none">
<button type="submit" disabled="{{{{gateBusy}}}}" style="flex: 0 0 auto; min-height: 52px; padding: 0 26px; font-size: 16px; font-weight: 600; font-family: Inter, sans-serif; color: #000000; background: #F5F5F7; border: none; border-radius: 999px; cursor: pointer">{{{{gateCta}}}}</button>
</form>
<sc-if value="{{{{hasGateError}}}}" hint-placeholder-val="{{{{ false }}}}">
<span role="alert" style="font-size: 14px; color: #FF453A">{{{{gateError}}}}</span>
</sc-if>
<span style="font-size: 13px; line-height: 1.5; color: #8E8E93">Gratuit · Envoi immédiat<br>En validant, vous acceptez d’être recontacté au sujet de votre audit.</span>
</div>
</sc-if>
<sc-if value="{{{{showSent}}}}" hint-placeholder-val="{{{{ false }}}}">
<div role="status" class="arc-rise" style="display: flex; align-items: flex-start; gap: 14px; margin-top: 8px; padding: 20px; border: 1px solid #2C2C2E; border-radius: 20px; background: #1C1C1E">
<svg width="26" height="26" sc-camel-view-box="0 0 22 22" fill="none" aria-hidden="true" style="flex: 0 0 auto"><circle cx="11" cy="11" r="10" fill="#30D158"></circle><path d="M6.5 11.5l3 3 6-6.5" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>
<div style="display: flex; flex-direction: column; gap: 6px; min-width: 0">
<span style="font-size: 17px; font-weight: 600; color: #F5F5F7">E-mail d’audit envoyé</span>
<span style="font-size: 15px; line-height: 1.5; color: #A1A1A6; overflow-wrap: anywhere">{{{{sentText}}}}</span>
<button type="button" sc-camel-on-click="{{{{changeEmail}}}}" style="align-self: flex-start; padding: 0; margin-top: 2px; border: none; background: transparent; color: #D2D2D7; font-family: Inter, sans-serif; font-size: 14px; text-decoration: underline; cursor: pointer">Envoyer à une autre adresse</button>
</div>
</div>
</sc-if>
'''

ERROR_BLOCK = '''<sc-if value="{{failed}}" hint-placeholder-val="{{ false }}">
<div style="max-width: 680px; margin: 0 auto; padding: 0 24px 120px; box-sizing: border-box">
<div class="arc-rise" role="alert" style="background: #111113; border: 1px solid #2C2C2E; border-radius: 28px; padding: 36px; display: flex; flex-direction: column; gap: 18px; text-align: left">
<span style="font-family: 'Inter Tight', sans-serif; font-weight: 700; font-size: 22px; color: #F5F5F7">Analyse impossible</span>
<p style="margin: 0; font-size: 17px; line-height: 1.5; color: #A1A1A6">{{errorMsg}}</p>
<div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px">
<button type="button" sc-camel-on-click="{{reset}}" style="min-height: 52px; padding: 0 22px; font-size: 16px; font-weight: 500; font-family: Inter, sans-serif; color: #D2D2D7; background: transparent; border: 1px solid #3A3A3C; border-radius: 999px; cursor: pointer">Essayer une autre adresse</button>
<a href="#offres" style="min-height: 52px; padding: 0 26px; display: inline-flex; align-items: center; font-size: 16px; font-weight: 600; text-decoration: none; color: #000000; background: #F5F5F7; border-radius: 999px">Demander un audit manuel</a>
</div>
</div>
</div>
</sc-if>

'''

SUBS_GRID_START = '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px">\n<sc-for list="{{subs}}"'
POTENTIAL_BLOCK = re.compile(
    r'<div style="display: flex; flex-direction: column; gap: 6px">\n'
    r'<span style="font-size: 15px; color: #A1A1A6">Score potentiel après enrichissement</span>\n'
    r'.*?</span></span>\n</div>\n', re.S)
POTENTIAL_HIDDEN = ('<sc-if value="{{hideDetails}}" hint-placeholder-val="{{ true }}">\n'
                    '<span style="font-size: 17px; color: #A1A1A6">Prêt à rendre votre catalogue achetable par les agents ?</span>\n'
                    '</sc-if>\n')


STATS_CARDS = re.compile(
    r'<div style="display: grid; grid-template-columns: repeat\(auto-fit, minmax\(260px, 1fr\)\); gap: 20px">\n'
    r'(?:(?!</section>).)*?Jan\. 2026.*?</div>\n</div>\n(?=</div>\n</section>)', re.S)

METHOD_CTA = ('<div>\n<a href="#offres" style="display: inline-flex; align-items: center; min-height: 56px; padding: 0 30px; '
              'font-size: 17px; font-weight: 600; text-decoration: none; color: #FFFFFF; background: #0F1218; border-radius: 999px">'
              'Voir nos offres</a>\n</div>\n')

SMOOTH_SCROLL = ('<style>html { scroll-behavior: smooth; }'
                 ' @media (max-width: 560px) { .arc-pill-form { border-radius: 30px !important; }'
                 ' .arc-pill-form button { flex: 1 1 100% !important; } }</style>\n')

HERO_BOX_OLD = '<div style="max-width: 1100px; margin: 0 auto; padding: 56px 24px 72px; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 28px">'
HERO_BOX_NEW = '<div style="max-width: 1100px; margin: 0 auto; padding: 40px 24px 72px; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 28px">'
H1_SIZE_OLD = 'font-size: clamp(52px, 9vw, 124px); line-height: 0.95;'
H1_SIZE_NEW = 'font-size: clamp(44px, 6vw, 84px); line-height: 0.95;'
CAROUSEL_OPEN = '<sc-if value="{{idle}}" hint-placeholder-val="{{ true }}">\n<div style="width: 100%; margin-top: 40px;'
AUDIT_FORM = re.compile(r'<form id="audit" class="arc-rise" sc-camel-on-submit="\{\{onSubmit\}\}" style="margin-top: 28px;(.*?)</form>\n(<p style="margin: 0; font-size: 14px; color: #8E8E93">.*?</p>\n)', re.S)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'patch "{label}": expected 1 occurrence, found {count}')
    return text.replace(old, new)


def patch_template(t):
    if 'onGateSubmit' in t:
        raise SystemExit('template already patched: start from an untouched export')
    logic = (ROOT / 'tools' / 'landing-logic.js').read_text()
    m = re.search(r'(<script type="text/x-dc" data-dc-script=""[^>]*>\n)(.*?)(</script>)', t, re.S)
    if not m or 'class Component extends DCLogic' not in m.group(2):
        raise SystemExit('patch "logic": component script not found')
    t = t[:m.start(2)] + logic + t[m.end(2):]

    # Sub-scores: e-mail only.
    start = t.find(SUBS_GRID_START)
    if start < 0 or t.count(SUBS_GRID_START) != 1:
        raise SystemExit('patch "subs": grid not found')
    end = t.index('</sc-for>\n</div>\n', start) + len('</sc-for>\n</div>\n')
    t = t[:start] + '<sc-if value="{{showDetails}}" hint-placeholder-val="{{ false }}">\n' + t[start:end] + '</sc-if>\n' + t[end:]

    # Potential score: e-mail only.
    pm = POTENTIAL_BLOCK.search(t)
    if not pm:
        raise SystemExit('patch "potential": block not found')
    t = (t[:pm.start()] + '<sc-if value="{{showDetails}}" hint-placeholder-val="{{ false }}">\n'
         + pm.group(0) + '</sc-if>\n' + POTENTIAL_HIDDEN + t[pm.end():])

    t = replace_once(t, '<span style="font-size: 15px; color: #A1A1A6">{{total}} produits analysés</span>',
                     '<span style="font-size: 15px; color: #A1A1A6">{{totalLabel}}</span>', 'total label')
    t = replace_once(t, '<sc-if value="{{hasMoreIssues}}" hint-placeholder-val="{{ true }}">',
                     '<sc-if value="{{showToggle}}" hint-placeholder-val="{{ false }}">', 'toggle')
    t = replace_once(t, '</sc-if>\n<sc-if value="{{issuesOpen}}" hint-placeholder-val="{{ false }}">',
                     '</sc-if>' + GATE + '<sc-if value="{{issuesOpen}}" hint-placeholder-val="{{ false }}">', 'gate')
    t = replace_once(t, 'Aperçu de démonstration : résultats simulés.', '{{footnote}}', 'footnote')
    t = replace_once(t, '<sc-if value="{{idle}}" hint-placeholder-val="{{ true }}">\n<div style="height: 48px"></div>',
                     ERROR_BLOCK + '<sc-if value="{{idle}}" hint-placeholder-val="{{ true }}">\n<div style="height: 48px"></div>', 'error')
    t = replace_once(t, 'Gratuit · Sans inscription · Shopify · Analyse UCP, ACP et MCP',
                     'Gratuit · Sans inscription · Tous sites e-commerce · Analyse UCP, ACP et MCP', 'hero note')
    t = replace_once(t, '>URL de votre boutique Shopify</label>', '>URL de votre boutique en ligne</label>', 'input label')

    # "6 / Jan. 2026 / 0 clic" cards: removed (the heading above them stays).
    t, n = STATS_CARDS.subn('', t)
    if n != 1:
        raise SystemExit(f'patch "stats cards": expected 1 block, found {n}')

    # "Voir nos offres" at the end of the method block (target of the report e-mail).
    start = t.find('<section id="methode"')
    end = t.find('</section>', start)
    if start < 0 or end < 0:
        raise SystemExit('patch "method cta": section not found')
    t = t[:end] + METHOD_CTA + t[end:]

    t = replace_once(t, '<a href="#top" style="display: flex; align-items: center; gap: 10px;',
                     '<a href="/" style="display: flex; align-items: center; gap: 10px;', 'logo')
    t = replace_once(t, '<helmet>\n', '<helmet>\n' + SMOOTH_SCROLL, 'smooth scroll')

    # Hero: URL field right under the subtitle, before the 3 cards; smaller H1 so
    # that headline, field and the top of the cards fit in a desktop viewport.
    fm = AUDIT_FORM.search(t)
    if not fm:
        raise SystemExit('patch "hero form": form not found')
    inner = fm.group(1)
    # Field sized to the hero: narrower and shorter than the export (680px wide, 72px tall).
    for a, b, label in (
        ('max-width: 680px; display: flex; flex-wrap: wrap; gap: 10px; padding: 8px;', 'max-width: 560px; display: flex; flex-wrap: wrap; gap: 8px; padding: 6px;', 'form box'),
        ('min-height: 56px; box-sizing: border-box; padding: 0 24px; font-size: 18px;', 'min-height: 48px; box-sizing: border-box; padding: 0 20px; font-size: 16px;', 'form input'),
        ('min-height: 56px; padding: 0 30px; font-size: 17px;', 'min-height: 48px; padding: 0 24px; font-size: 16px;', 'form button'),
    ):
        inner = replace_once(inner, a, b, label)
    # The note under the field ("Gratuit · Sans inscription · …") is dropped.
    form = '<form id="audit" class="arc-rise arc-pill-form" sc-camel-on-submit="{{onSubmit}}" style="margin-top: 4px;' + inner + '</form>\n'
    t = t[:fm.start()] + t[fm.end():]
    t = replace_once(t, CAROUSEL_OPEN, form + CAROUSEL_OPEN.replace('margin-top: 40px;', 'margin-top: 0;'), 'hero carousel')
    t = replace_once(t, HERO_BOX_OLD, HERO_BOX_NEW, 'hero padding')
    t = replace_once(t, H1_SIZE_OLD, H1_SIZE_NEW, 'h1 size')
    t = replace_once(t, 'Gemini, ChatGPT et Claude achètent déjà pour vos clients. Découvrez en quelques secondes si votre catalogue est prêt.',
                     'Gemini, ChatGPT et Claude achètent déjà pour vos clients.<br>Soyez prêt pour le commerce agentique.', 'subtitle text')
    t = replace_once(t, 'color: #A1A1A6; max-width: 680px; font-weight: 500">Gemini, ChatGPT',
                     'color: #A1A1A6; max-width: 780px; font-weight: 500">Gemini, ChatGPT', 'subtitle width')
    return t


def patch_newsletter(t):
    for label, anchor in (('Méthode', 'methode'), ('Offres', 'offres'), ('FAQ', 'faq')):
        t, n = re.subn(r'<a href="/"([^>]*)>' + label + '</a>', r'<a href="/#' + anchor + r'"\1>' + label + '</a>', t)
        if n != 1:
            raise SystemExit(f'patch "newsletter {label}": expected 1 link, found {n}')
    return t


def prepare_bundle(html):
    """Links and viewport, on the outer bundle (idempotent)."""
    html = html.replace('Newsletter.dc.html', '/newsletter').replace('Main.dc.html', '/')
    if 'name="viewport"' not in html[:3000]:
        html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  ' + VIEWPORT, 1)
    return html


def main(page, src, dst):
    html = prepare_bundle(Path(src).read_text())
    start = html.index(OPEN) + len(OPEN)
    end = html.index('</script>', start)
    raw = html[start:end]
    patched = (patch_template if page == 'landing' else patch_newsletter)(json.loads(raw))
    encoded = json.dumps(patched, ensure_ascii=False).replace('</', '<\\u002F')
    assert json.loads(encoded) == patched
    lead = raw[: len(raw) - len(raw.lstrip())]
    trail = raw[len(raw.rstrip()):]
    Path(dst).write_text(html[:start] + lead + encoded + trail + html[end:])
    print(f'wrote {dst}')


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] not in ('landing', 'newsletter'):
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3])
