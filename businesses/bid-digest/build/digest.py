#!/usr/bin/env python3
"""Weekly Bid Digest generator.

  python3 build/digest.py PROFILE.json OUT_DIR [--no-awards] [--max N]

PROFILE.json: {"customer": "...", "trades": ["janitorial"], "naics": ["561720"],
               "setasides": ["small business", "WOSB"], "states": ["VA"], "include_neighbors": true}
Writes OUT_DIR/digest.html, OUT_DIR/digest.pdf and OUT_DIR/rows.json (the exact source rows used,
for checking every line of the digest against the SAM.gov extract).
"""
import html, json, os, re, subprocess, sys
from datetime import datetime, timezone
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from data import load_open
from matching import match, profile_naics, profile_states
from trades import TRADES
import usaspending

BRAND = 'Weekly Bid Digest'
HERE = os.path.dirname(os.path.abspath(__file__))
e = lambda s: html.escape(str(s or ''))


def money(x):
    return '' if x is None else f'${x:,.0f}'


def fmt_deadline(ts):
    return ts.tz_convert('America/New_York').strftime('%a %b %d, %Y %I:%M %p ET')


def place(r):
    if r['PopState']:
        return ', '.join(x for x in [r['PopCity'].title(), r['PopState']] if x)
    return f"not listed (buying office: {r['City'].title()}, {r['State']})"


def awards_html(rows, area):
    if not rows:
        return '<p class="aw none">No awards under this NAICS performed here with activity in the last two years on USAspending.</p>'
    items = ''.join(
        f"<tr><td>{e(a.get('Start Date'))}</td><td>{e(a.get('Recipient Name'))}</td><td class=num>{money(a.get('Award Amount'))}</td>"
        f"<td>{e(a.get('Awarding Sub Agency') or a.get('Awarding Agency'))}</td><td>{e((a.get('Description') or '')[:110])}</td></tr>"
        for a in rows)
    return (f'<div class="aw"><div class="awh">Recent awards, same NAICS, performed in {e(area)}, active in the last two years (USAspending) — '
            f'who has been winning this work and at what price</div><table><tr><th>Start</th><th>Awardee</th><th>Amount</th>'
            f'<th>Buyer</th><th>What</th></tr>{items}</table></div>')


def card(r, i, awards):
    sa = r['SetASide'] or 'None (full and open)'
    soon = (r['deadline'] - pd.Timestamp.now(tz='UTC')).days
    flag = f'<span class="soon">closes in {soon} day{"s" if soon != 1 else ""}</span>' if soon <= 7 else ''
    kind = 'Market research (Sources Sought) — reply to get on the buyer\'s radar' if r['Type'] == 'Sources Sought' else r['Type']
    if re.search(r'sole[- ]source|intent to award', f"{r['Title']} {r['Description']}", re.I):
        kind += ' · intent to sole-source: the buyer plans to award without competition; respond only to show you can do the work'
    desc = (r['Description'] or '').strip()
    desc = '' if desc.startswith('http') else desc[:420] + ('…' if len(desc) > 420 else '')
    return f"""
<section class="opp">
  <div class="oh"><span class="n">{i}</span><h3>{e(r['Title'])}</h3></div>
  <table class="kv">
    <tr><th>Response due</th><td><b>{e(fmt_deadline(r['deadline']))}</b> {flag}</td></tr>
    <tr><th>Agency</th><td>{e(r['Department/Ind.Agency'])}{' · ' + e(r['Sub-Tier']) if r['Sub-Tier'] and r['Sub-Tier'] != r['Department/Ind.Agency'] else ''}{' · ' + e(r['Office']) if r['Office'] else ''}</td></tr>
    <tr><th>Notice</th><td>{e(kind)} · Solicitation {e(r['Sol#'] or '—')} · posted {e(r['posted'].strftime('%b %d, %Y'))}</td></tr>
    <tr><th>Place of performance</th><td>{e(place(r))}</td></tr>
    <tr><th>Set-aside</th><td>{e(sa)}</td></tr>
    <tr><th>NAICS</th><td>{e(r['NaicsCode'])}</td></tr>
    <tr><th>SAM.gov notice</th><td><a href="https://sam.gov/opp/{e(r['NoticeId'])}/view">sam.gov/opp/{e(r['NoticeId'])}/view</a></td></tr>
  </table>
  {f'<p class="desc">{e(desc)}</p>' if desc else ''}
  {awards}
</section>"""


CSS = """
body{font:13px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d2433;margin:0;background:#fff}
.wrap{max-width:860px;margin:0 auto;padding:28px 24px}
header{border-bottom:3px solid #1f4e79;padding-bottom:12px;margin-bottom:16px}
header .b{font-weight:700;color:#1f4e79;letter-spacing:.04em;text-transform:uppercase;font-size:12px}
h1{font-size:22px;margin:4px 0}
.sum{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
.sum{flex-wrap:nowrap}.sum div{flex:1;background:#f1f5fa;border-radius:6px;padding:8px 12px}
.sum b{display:block;font-size:20px;color:#1f4e79}
.prof{color:#4a5568;font-size:12px}
.opp{border:1px solid #d7dee8;border-radius:8px;padding:12px 14px;margin:12px 0;page-break-inside:avoid}
.oh{display:flex;gap:10px;align-items:baseline}.oh .n{color:#fff;background:#1f4e79;border-radius:4px;padding:0 7px;font-weight:700}
h3{font-size:15px;margin:0}
table{border-collapse:collapse;width:100%}
.kv th{text-align:left;width:150px;color:#4a5568;font-weight:600;vertical-align:top;padding:2px 8px 2px 0}
.kv td{padding:2px 0}
.soon{background:#fde8e8;color:#9b1c1c;border-radius:4px;padding:0 6px;font-size:11px;margin-left:6px}
.desc{color:#4a5568;font-size:12px;margin:8px 0 0}
.aw{margin-top:8px;background:#f8fafc;border-radius:6px;padding:6px 8px}
.awh{font-size:11px;font-weight:600;color:#4a5568;margin-bottom:4px}
.aw table{font-size:11px}.aw th{text-align:left;color:#6b7280;font-weight:600;padding:1px 6px 1px 0}.aw td{padding:1px 6px 1px 0;vertical-align:top}
.aw .num,.num{text-align:right;white-space:nowrap}
.none{font-size:11px;color:#6b7280}
a{color:#1f4e79}
footer{margin-top:22px;border-top:1px solid #d7dee8;padding-top:10px;font-size:11px;color:#6b7280}
"""


def render(p, rows, excluded, extract_time, with_awards=True):
    now = datetime.now(timezone.utc)
    cards = []
    for i, (_, r) in enumerate(rows.iterrows(), 1):
        aw = ''
        if with_awards:
            st = r['PopState'] or r['State']
            got, area = usaspending.comparable(r['NaicsCode'], st, r['PopCity'] if r['PopState'] else None)
            r_awards = [{k: a.get(k) for k in ('Award ID', 'Recipient Name', 'Award Amount', 'Start Date', 'Awarding Sub Agency')} for a in got]
            rows.at[r.name, 'comparable_awards'] = json.dumps(r_awards)
            aw = awards_html(got, area)
        cards.append(card(r, i, aw))
    soon = int(((rows['deadline'] - pd.Timestamp.now(tz='UTC')).dt.days <= 7).sum())
    sa = int(rows['family'].notna().sum())
    ss = int((rows['Type'] == 'Sources Sought').sum())
    trades = ', '.join(TRADES[t][0] for t in p.get('trades', []))
    excl = '; '.join(f'{v} {k}' for k, v in excluded.items())
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{BRAND} — {e(p['customer'])}</title><style>{CSS}</style></head>
<body><div class="wrap">
<header><div class="b">{BRAND}</div><h1>Open federal opportunities for {e(p['customer'])}</h1>
<div class="prof">Week of {now:%B %d, %Y} · {e(trades) + ' · ' if trades else ''}NAICS {e(', '.join(profile_naics(p)))} ·
work in {e(', '.join(profile_states(p)) if not p.get('nationwide') else 'any state')} ·
certifications: {e(', '.join(p.get('setasides', [])) or 'none (unrestricted only)')}</div></header>
<div class="sum"><div><b>{len(rows)}</b>open opportunities</div><div><b>{soon}</b>due within 7 days</div>
<div><b>{sa}</b>set aside for your certifications</div><div><b>{ss}</b>sources-sought (pre-bid)</div></div>
{f'<p class="prof">Left out because they are set aside for a program you do not hold: {e(excl)}.</p>' if excl else ''}
{''.join(cards) if cards else '<p>No open opportunities match this profile this week.</p>'}
<footer>Source: SAM.gov Contract Opportunities public data extract (GSA, data.gov), downloaded {extract_time:%Y-%m-%d %H:%M} UTC;
award history from the USAspending.gov API. "Open" means the notice's response deadline is after the time this digest was made.
Where a notice lists no place of performance it is matched on the buying office's state, and says so.
{BRAND} is an independent service and is not affiliated with SAM.gov, GSA or any government agency.
Always read the full notice and its attachments on SAM.gov before bidding; amendments can change dates and requirements.</footer>
</div></body></html>"""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    with_awards = '--no-awards' not in sys.argv
    cap = int(sys.argv[sys.argv.index('--max') + 1]) if '--max' in sys.argv else 40
    if '--max' in sys.argv:
        args.remove(str(cap))
    profile, out = args
    p = json.load(open(profile))
    os.makedirs(out, exist_ok=True)
    df, extract_time = load_open()
    rows, excluded = match(df, p)
    total = len(rows)
    rows = rows.head(cap).copy()
    rows['comparable_awards'] = ''
    page = render(p, rows, excluded, extract_time, with_awards)
    hp = os.path.join(out, 'digest.html')
    open(hp, 'w').write(page)
    keep = ['NoticeId', 'Title', 'Sol#', 'Department/Ind.Agency', 'Sub-Tier', 'Office', 'Type', 'PostedDate', 'ResponseDeadLine',
            'NaicsCode', 'SetASideCode', 'SetASide', 'PopCity', 'PopState', 'City', 'State', 'location_basis', 'comparable_awards']
    json.dump({'profile': p, 'extract_downloaded_utc': str(extract_time), 'matched_total': total, 'shown': len(rows),
               'excluded_by_setaside': excluded, 'rows': rows[keep].to_dict('records')}, open(os.path.join(out, 'rows.json'), 'w'), indent=1)
    subprocess.run(['node', os.path.join(HERE, 'pdf.cjs'), hp, os.path.join(out, 'digest.pdf')], check=True)
    print(f'{p["customer"]}: {total} matched, {len(rows)} shown -> {out}')


if __name__ == '__main__':
    main()
