#!/usr/bin/env python3
"""Wire the exported landing page (index.html) to the real audit API.

The page is a self-contained bundle exported from the design tool: its markup
lives in a JSON string inside <script type="__bundler/template">. This script
decodes that template, swaps the simulated audit logic for tools/landing-logic.js,
adds the e-mail gate and the error state, and writes the bundle back.

Run it again after re-exporting the landing page from the design tool:
    python3 tools/patch_landing.py public/index.html
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OPEN = '<script type="__bundler/template">'

SR_ONLY = 'position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)'

GATE = f'''
<sc-if value="{{{{locked}}}}" hint-placeholder-val="{{{{ true }}}}">
<div style="display: flex; flex-direction: column; gap: 14px; padding: 24px 0 8px; border-top: 1px solid #2C2C2E">
<div style="display: flex; flex-direction: column; gap: 4px">
<span style="font-size: 17px; font-weight: 600; color: #F5F5F7">{{{{gateTitle}}}}</span>
<span style="font-size: 15px; color: #A1A1A6">Laissez votre e-mail pour afficher le rapport détaillé : chaque point, son impact sur votre score et le nombre de fiches concernées.</span>
</div>
<form sc-camel-on-submit="{{{{onGateSubmit}}}}" style="width: 100%; max-width: 560px; display: flex; flex-wrap: wrap; gap: 10px; padding: 6px; box-sizing: border-box; background: #1C1C1E; border: 1px solid #2C2C2E; border-radius: 999px">
<label for="gate-email" style="{SR_ONLY}">Votre e-mail professionnel</label>
<input id="gate-email" type="email" autocomplete="email" placeholder="vous@marque.com" value="{{{{gateEmail}}}}" sc-camel-on-change="{{{{onGateEmail}}}}" style="flex: 1 1 200px; min-width: 0; min-height: 52px; box-sizing: border-box; padding: 0 20px; font-size: 17px; font-family: Inter, sans-serif; color: #F5F5F7; background: transparent; border: none; border-radius: 999px; outline: none">
<button type="submit" disabled="{{{{gateBusy}}}}" style="flex: 0 0 auto; min-height: 52px; padding: 0 26px; font-size: 16px; font-weight: 600; font-family: Inter, sans-serif; color: #000000; background: #F5F5F7; border: none; border-radius: 999px; cursor: pointer">{{{{gateCta}}}}</button>
</form>
<sc-if value="{{{{hasGateError}}}}" hint-placeholder-val="{{{{ false }}}}">
<span role="alert" style="font-size: 14px; color: #FF453A">{{{{gateError}}}}</span>
</sc-if>
<span style="font-size: 13px; color: #8E8E93">Gratuit · Accès immédiat au rapport complet</span>
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


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'patch "{label}": expected 1 occurrence, found {count}')
    return text.replace(old, new)


def patch_template(t):
    if 'onGateSubmit' in t:
        raise SystemExit('template already patched')
    logic = (ROOT / 'tools' / 'landing-logic.js').read_text()
    m = re.search(r'(<script type="text/x-dc" data-dc-script=""[^>]*>\n)(.*?)(</script>)', t, re.S)
    if not m or 'class Component extends DCLogic' not in m.group(2):
        raise SystemExit('patch "logic": component script not found')
    t = t[:m.start(2)] + logic + t[m.end(2):]

    t = replace_once(t, '<span style="font-size: 15px; color: #A1A1A6">{{total}} produits analysés</span>',
                     '<span style="font-size: 15px; color: #A1A1A6">{{totalLabel}}</span>', 'total label')
    t = replace_once(t, '<sc-if value="{{hasMoreIssues}}" hint-placeholder-val="{{ true }}">',
                     '<sc-if value="{{showToggle}}" hint-placeholder-val="{{ true }}">', 'toggle')
    t = replace_once(t, '</sc-if>\n<sc-if value="{{issuesOpen}}" hint-placeholder-val="{{ false }}">',
                     '</sc-if>' + GATE + '<sc-if value="{{issuesOpen}}" hint-placeholder-val="{{ false }}">', 'gate')
    t = replace_once(t, 'Aperçu de démonstration : résultats simulés.', '{{footnote}}', 'footnote')
    t = replace_once(t, '<sc-if value="{{idle}}" hint-placeholder-val="{{ true }}">\n<div style="height: 48px"></div>',
                     ERROR_BLOCK + '<sc-if value="{{idle}}" hint-placeholder-val="{{ true }}">\n<div style="height: 48px"></div>', 'error')
    t = replace_once(t, 'Gratuit · Sans inscription · Shopify · Analyse UCP, ACP et MCP',
                     'Gratuit · Sans inscription · Tous sites e-commerce · Analyse UCP, ACP et MCP', 'hero note')
    t = replace_once(t, '>URL de votre boutique Shopify</label>', '>URL de votre boutique en ligne</label>', 'input label')
    return t


def main(path):
    p = Path(path)
    html = p.read_text()
    start = html.index(OPEN) + len(OPEN)
    end = html.index('</script>', start)
    raw = html[start:end]
    template = json.loads(raw)
    patched = patch_template(template)
    encoded = json.dumps(patched, ensure_ascii=False).replace('</', '<\\u002F')
    assert json.loads(encoded) == patched
    lead = raw[: len(raw) - len(raw.lstrip())]
    trail = raw[len(raw.rstrip()):]
    p.write_text(html[:start] + lead + encoded + trail + html[end:])
    print(f'patched {p}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'public' / 'index.html')
