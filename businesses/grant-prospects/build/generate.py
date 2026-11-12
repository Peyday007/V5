#!/usr/bin/env python3
"""Grant Prospect Report generator.

  python3 build/generate.py --ein 251234567 --causes literacy,youth [--state PA] [--city Pittsburgh] [--out samples]
  python3 build/generate.py --name "Literacy Council of X" --state PA --causes literacy
  python3 build/generate.py --ein ... --causes ... --teaser-only      # one line, no files (used for prospects.csv)

Writes <out>/<slug>.html, <out>/<slug>.pdf and <out>/<slug>.json (the exact rows the report was built from).
Every funder line comes from a filed 990-PF; every federal line from Grants.gov. Nothing is typed by hand.
"""
import argparse, html, json, os, re, subprocess, sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import grantdata as gd  # noqa: E402

BRAND = 'Funder Ledger'
HERE = os.path.dirname(os.path.abspath(__file__))


def money(n):
    if not n:
        return '—'
    if n >= 1_000_000:
        return f'${n / 1_000_000:.1f}M'
    if n >= 10_000:
        return f'${n / 1000:.0f}K'
    return f'${n:,.0f}'


def e(s):
    return html.escape(str(s or ''))


def tc(s):
    """Title-case an ALL-CAPS IRS string without mangling acronyms that are already mixed case."""
    s = s or ''
    if s.isupper():
        s = re.sub(r"[A-Za-z]+('[A-Za-z]+)?", lambda m: m.group(0).capitalize(), s.lower())
        s = re.sub(r'\b(Of|And|For|The|In|To|A|At|On)\b', lambda m: m.group(0).lower(), s)
        s = s[:1].upper() + s[1:]
        s = re.sub(r'\b(Inc|Llc|Ymca|Ywca|Spca|Usa|Us|Pa|Ny|Nj|Ii|Iii|Pnc|Eqt|Ppg|Ppl|Bny|Td|Rk|Ywca|Fnb|Ups|At&t|Cvs)\b', lambda m: m.group(0).upper() if m.group(0) not in ('Inc',) else 'Inc', s)
    return s


def clip(s, n):
    s = (s or '').strip()
    return s if len(s) <= n else s[:n].rsplit(' ', 1)[0] + ' …'


def phone(p):
    d = re.sub(r'\D', '', p or '')
    return f'({d[:3]}) {d[3:6]}-{d[6:]}' if len(d) == 10 else (p or '')


def resolve(args):
    if args.ein:
        prof = gd.profile(args.ein)
        if not prof:
            sys.exit(f'EIN {args.ein} not found in ProPublica Nonprofit Explorer')
        return prof
    hits = gd.propublica_search(args.name, args.state)
    if not hits:
        sys.exit(f'no organization named {args.name!r} in {args.state}')
    return gd.profile(hits[0]['ein'])


def build(prof, causes, state=None, city=None, top_foundations=350, log=print):
    state = state or prof['state']
    city = city or prof['city']
    zip3 = prof.get('zip3') if state == prof['state'] else None
    fdns = gd.state_foundations(state, top=top_foundations, log=log, zip3=zip3)
    matched = gd.match_foundations(fdns, state, causes, city=city, own_name=prof['name'], zip3=zip3)
    fed, fed_total = gd.federal_opportunities(causes, log=log)
    return {'profile': prof, 'state': state, 'city': city, 'causes': causes, 'generated': date.today().isoformat(),
            'scanned': len(fdns), 'top': top_foundations, 'zip3': zip3, 'scanned_grants': sum(len(f['grants']) for f in fdns),
            'foundations': matched, 'federal': fed, 'federal_total': fed_total}


def teaser(r):
    label = ' and '.join(gd.CAUSES[c]['label'] for c in r['causes'])
    n_f, n_open = len(r['foundations']), sum(1 for f in r['foundations'] if not f['preselected_only'])
    n_near = sum(1 for f in r['foundations'] if f['n_near'] or f['f_near'])
    near = f", {n_near} of them based or giving in your area" if n_near else ''
    fed = sum(1 for o in r['federal'] if o['in_title'])
    fed_s = f" plus {fed} open federal grant{'s' if fed != 1 else ''} on Grants.gov" if fed else ''
    return f"{n_f} {r['state']} foundations made {label} grants in {r['state']} in their latest tax filing{near}{fed_s}"


def render(r, max_fdn=35):
    p = r['profile']
    labels = ', '.join(gd.CAUSES[c]['label'] for c in r['causes'])
    open_f = [f for f in r['foundations'] if not f['preselected_only']][:max_fdn]
    invite = [f for f in r['foundations'] if f['preselected_only']][:max(0, max_fdn - len(open_f)) or 10]
    fed = r['federal']

    def fdn_card(i, f):
        a = f['apply'][0] if f['apply'] else {}
        addr = a.get('address') or {}
        how = []
        if a.get('contact'):
            how.append(f"<b>Contact:</b> {e(tc(a['contact']))}")
        if addr.get('line'):
            how.append(f"{e(tc(addr['line']))}, {e(addr['city'])}, {e(addr['state'])} {e(addr['zip'][:5])}")
        if a.get('phone'):
            how.append(e(phone(a['phone'])))
        if a.get('email'):
            how.append(e(a['email'].lower()))
        rows = ''.join(f"<tr><td>{e(tc(g['recipient']))}</td><td>{e(g['city'])}</td><td class=n>{money(g['amount'])}</td><td>{e(tc(g['purpose'])[:140])}</td></tr>"
                       for g in f['hits'][:4])
        more = f"<p class=muted>+ {f['n_hits'] - 4} more matching grants in {r['state']}.</p>" if f['n_hits'] > 4 else ''
        you = ''
        if f['funds_you']:
            you = '<p class=flag>Already funds you: ' + '; '.join(f"{money(g['amount'])} for {e(tc(g['purpose']))}" for g in f['funds_you'][:2]) + '</p>'
        web = f" · {e(f['website'].lower())}" if f.get('website') and f['website'].upper() not in ('N/A', 'NONE', '') else ''
        loc = f['address']
        return f"""
<section class=card>
  <h3><span class=rank>{i}</span>{e(tc(f['name']))}</h3>
  <p class=meta>{e(loc['city'])}, {e(loc['state'])}{web} · EIN {f['ein'][:2]}-{f['ein'][2:]} · assets {money(f['fmv_assets'])} (market value) · gave {money(f['total_grants'])} in {f['n_grants']} grants (tax year ending {e(f['tax_period_end'])})</p>
  <p class=why><b>Why it fits:</b> {f['n_hits']} grant{'s' if f['n_hits'] != 1 else ''} totalling {money(f['hit_total'])} to {labels} work in {r['state']}{f' — {f["n_near"]} of them near you (same 3-digit ZIP area as {e(r["city"])})' if f['n_near'] else ''}; typical size {money(f['median_hit'])}.</p>
  {you}
  <p class=meta><b>Where it gives in {e(r['state'])}:</b> {e(', '.join(f'{c} ({n})' for c, n in f['top_cities']))}{' — giving is concentrated in another part of the state; ask about your area before applying' if f['concentrated_elsewhere'] else ''}</p>
  <table class=grants><tr><th>Recipient</th><th>City</th><th>Amount</th><th>Purpose (as filed)</th></tr>{rows}</table>{more}
  <div class=apply><b>How to apply (990-PF Part XV):</b> {' · '.join(how) or 'no contact listed'}
    {f"<br><b>Materials:</b> {e(clip(a['how'], 360))}" if a.get('how') else ''}
    {f"<br><b>Deadlines:</b> {e(clip(a['deadlines'], 200))}" if a.get('deadlines') else ''}
    {f"<br><b>Restrictions:</b> {e(clip(a['restrictions'], 300))}" if a.get('restrictions') else ''}
  </div>
  <p class=src>Source: Form 990-PF e-file {e(f['object_id'])} · projects.propublica.org/nonprofits/organizations/{int(f['ein'])}</p>
</section>"""

    def inv_row(f):
        return f"<tr><td>{e(tc(f['name']))}</td><td>{e(f['address']['city'])}</td><td class=n>{f['n_hits']}</td><td class=n>{money(f['hit_total'])}</td><td>{e(tc(f['hits'][0]['recipient']))} — {money(f['hits'][0]['amount'])}</td></tr>"

    def fed_card(o):
        award = ' – '.join(money(x) for x in (o['floor'], o['ceiling']) if x) or 'see notice'
        el = sorted(o['eligibility'], key=lambda t: ('onprofit' not in t and 'Unrestricted' not in t, t))
        elig = '; '.join(el[:3]) + (f' (+{len(el) - 3} more)' if len(el) > 3 else '')
        closes = f"<b>closes {e(o['close'])}</b>" if o['close'] != 'not stated' else ('dates not yet announced' if o['status'] == 'forecasted' else 'close date not stated')
        return f"""
<section class=card>
  <h3>{e(o['title'])}{'' if o['in_title'] else ' <span class=tag>related</span>'}</h3>
  <p class=meta>{e(o['agency'])} · {e(o['number'])} · {e(o['status'])} · opens {e(o['open'])} · {closes}</p>
  <p>{e(o['summary'])}{'…' if len(o['summary']) >= 420 else ''}</p>
  <p class=meta><b>Award:</b> {award}{f" · program total {money(o['total'])}" if o['total'] else ''} · <b>Eligible:</b> {e(elig)}{f" · Assistance listing {e(o['cfda'])}" if o['cfda'] else ''}</p>
  <p class=meta>Notice: {e(o['url'])}{f" · agency contact {e(o['contact'])}" if o['contact'] else ''}</p>
</section>"""

    rev = (f"{money(p['revenue'])} revenue ({p['revenue_year']} filing)" if p.get('revenue_year') else f"{money(p['revenue'])} revenue") if p.get('revenue') else 'revenue not on file'
    css = open(os.path.join(HERE, 'report.css')).read()
    return f"""<!doctype html><html lang=en><head><meta charset=utf-8><title>{e(BRAND)} · Grant Prospect Report · {e(p['name'])}</title><style>{css}</style></head><body>
<header>
  <div class=brand>{e(BRAND)}</div>
  <h1>Grant Prospect Report</h1>
  <h2>{e(tc(p['name']))}</h2>
  <p class=meta>{e(p['city'])}, {e(p['state'])} · EIN {p['ein'][:2]}-{p['ein'][2:]} · NTEE {e(p['ntee'] or 'n/a')} · {rev} · focus: {e(labels)} · prepared {e(r['generated'])}</p>
</header>
<section class=summary>
  <div><b>{len(r['foundations'])}</b><span>{e(r['state'])} private foundations that made {e(labels)} grants in {e(r['state'])} in their latest 990-PF</span></div>
  <div><b>{len([f for f in r['foundations'] if not f['preselected_only']])}</b><span>of those accept applications or inquiries (not "pre-selected only")</span></div>
  <div><b>{sum(1 for o in fed if o['in_title'])}</b><span>open or forecast federal opportunities on Grants.gov named for your focus and open to nonprofits (+{sum(1 for o in fed if not o['in_title'])} related)</span></div>
</section>
<h2 class=sec>1 · Best-fit foundations that accept applications</h2>
<p class=muted>Ranked by how many {e(r['state'])} grants each made to {e(labels)} work, giving extra weight to grants near {e(r['city'])} (same 3-digit ZIP area), to foundations based there, and to purposes that name your work directly rather than a related one. Amounts and purposes are copied from each foundation's own Form 990-PF.</p>
{''.join(fdn_card(i + 1, f) for i, f in enumerate(open_f)) or '<p>None found among the foundations scanned.</p>'}
{'<h2 class=sec>2 · Other matching funders that only give to pre-selected organizations</h2><p class=muted>Their 990-PF says they do not accept unsolicited applications. Worth a relationship (board connections, a site-visit invitation), not a cold proposal.</p><table class=grants><tr><th>Foundation</th><th>City</th><th>Matching grants</th><th>Total</th><th>Largest matching grant</th></tr>' + ''.join(inv_row(f) for f in invite) + '</table>' if invite else ''}
<h2 class=sec>3 · Federal opportunities open now</h2>
<p class=muted>Grants.gov opportunities in "posted" or "forecasted" status whose title or synopsis matches your focus and whose eligibility includes nonprofits ("related" = your focus appears in the synopsis, not the title). Read the full notice before applying: many federal programs require a SAM.gov registration (UEI) and some favour larger or partnered applicants.</p>
{''.join(fed_card(o) for o in fed) or '<p>No matching federal opportunities are open today.</p>'}
<h2 class=sec>How this report was built</h2>
<ul class=muted>
<li>Foundations: {r['scanned']} private grantmaking foundations based in {e(r['state'])} — the {r['top']} largest by assets plus smaller ones (assets over $250K) in your ZIP area {e(r['zip3'] or '')}xx (IRS Business Master File, foundation code 04) — whose latest Form 990-PF was e-filed in 2024–2026 — {r['scanned_grants']:,} individual grants read from the filings' Part XV. A foundation is listed only if it actually paid a grant to a {e(r['state'])} organization whose name or stated purpose matches your focus.</li>
<li>Not covered: foundations outside {e(r['state'])} that give into it, smaller {e(r['state'])} foundations below the asset cut, community foundations and corporate giving programs (they file Form 990, not 990-PF), and grant lists filed only as PDF attachments.</li>
<li>Federal: Grants.gov search API, keywords {e(', '.join(sorted({k for c in r['causes'] for k in gd.CAUSES[c]['federal']})))}; {r['federal_total']} matched, top {len(fed)} shown.</li>
<li>Sources: IRS e-file index and 990-PF XML (GivingTuesday 990 data lake mirror), IRS EO BMF, ProPublica Nonprofit Explorer, Grants.gov. Filings lag one to two years; confirm current guidelines on each funder's site before applying.</li>
</ul>
<footer>{e(BRAND)} · prepared for {e(tc(p['name']))} · {e(r['generated'])}</footer>
</body></html>"""


def slugify(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:60]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ein'); ap.add_argument('--name'); ap.add_argument('--state'); ap.add_argument('--city')
    ap.add_argument('--causes', required=True, help='comma list of: ' + ','.join(gd.CAUSES))
    ap.add_argument('--out', default=os.path.join(os.path.dirname(HERE), 'samples'))
    ap.add_argument('--top', type=int, default=350)
    ap.add_argument('--teaser-only', action='store_true')
    ap.add_argument('--no-pdf', action='store_true')
    a = ap.parse_args()
    causes = [c.strip() for c in a.causes.split(',') if c.strip()]
    bad = [c for c in causes if c not in gd.CAUSES]
    if bad:
        sys.exit(f'unknown cause(s) {bad}; choose from {list(gd.CAUSES)}')
    log = (lambda *x: None) if a.teaser_only else print
    prof = resolve(a)
    r = build(prof, causes, state=a.state, city=a.city, top_foundations=a.top, log=log)
    if a.teaser_only:
        print(json.dumps({'ein': prof['ein'], 'name': prof['name'], 'teaser': teaser(r), 'revenue': prof['revenue']}))
        return
    os.makedirs(a.out, exist_ok=True)
    base = os.path.join(a.out, slugify(prof['name']))
    open(base + '.html', 'w').write(render(r))
    json.dump(r, open(base + '.json', 'w'), indent=1, default=str)
    if not a.no_pdf:
        subprocess.run(['node', os.path.join(HERE, 'render_pdf.cjs'), base + '.html', base + '.pdf'], check=True)
    print(f"{prof['name']}: {len(r['foundations'])} foundations, {len(r['federal'])} federal -> {base}.html/.pdf")
    print('teaser:', teaser(r))


if __name__ == '__main__':
    main()
