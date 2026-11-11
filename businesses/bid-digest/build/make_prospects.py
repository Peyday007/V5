#!/usr/bin/env python3
"""prospects.csv from the finder's candidates: one row per firm whose own site publishes a business address.

  python3 build/make_prospects.py

Keeps candidates whose address is on the firm's own domain, re-checks in a real browser that the address
appears on source_url, and computes each teaser from the live SAM.gov extract with matching.teaser.
"""
import csv, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from data import load_open
from matching import teaser
from trades import TRADES

BIG = re.compile(r'\b(university|college|hospital|health|county|city of|state of|school|tribe|nation)\b', re.I)
# Reviewed by hand after the automated pass: large or acquired firms, and sites that are not the recipient.
EXCLUDE = {'AKIMA DATA MANAGEMENT LLC': 'large Alaska Native corporation family; address is a jobs inbox',
           'FOUR WINDS INTERACTIVE LLC': 'acquired; site redirects to poppulo.com',
           'GRAHAM INC.': 'name too generic to be sure the site is the recipient',
           'MIAMI MARINE SERVICES, LLC': 'recipient is in Miami, OK; site is a different marine firm',
           'WEALTHCRAFT PARTNERS LLC': 'not a sitework firm on its own site',
           'VASTGLOBE LOGISTICS LLC': 'not a roofing firm on its own site'}
BIG_DOMAINS = {'akima.com'}  # every Akima operating company: large ANC family
FIX = {'Lr-associates': 'LR Associates', 'Dbi Waste Systems': 'DBI Waste Systems', 'Emd Strategies': 'EMD Strategies',
       'Hqe Systems': 'HQE Systems', 'Msab': 'MSAB', 'Omj Consultant': 'OMJ Consultant', 'Osi Vision': 'OSI Vision',
       'Usa Infotech': 'USA Infotech', 'Machine Tools Usa': 'Machine Tools USA', 'Itm4g': 'ITM4G',
       'Aspire-luke JV': 'Aspire-Luke JV', 'Rore': 'RORE', 'Dfw Cad Services': 'DFW CAD Services', 'DFW Cad Services': 'DFW CAD Services',
       'Opslab': 'OpsLab', 'Curtis Mckinley Roofing and Sheet Metal': 'Curtis McKinley Roofing and Sheet Metal'}
SUFFIX = re.compile(r'[,.]?\s+(inc|llc|l\.l\.c|corp|corporation|co|company|ltd|lp|pllc)\.?$', re.I)


def display(name):
    n = name.strip()
    while SUFFIX.search(n):
        n = SUFFIX.sub('', n).strip(' ,.')
    out = []
    for i, w in enumerate(n.split()):
        lw = w.lower()
        if lw in ('and', 'of', 'the') and i:
            out.append(lw)
        elif len(w) <= 4 and (not re.search(r'[aeiouy]', lw) or re.search(r'[0-9&]', w)):
            out.append(w.upper())
        else:
            out.append(w[:1].upper() + w[1:].lower())
    n = ' '.join(out)
    return FIX.get(n, n)


def main():
    cands = [c for c in json.load(open(os.path.join(ROOT, '.cache', 'prospect_candidates.json'))) if c['status'] == 'ok']
    cands = [c for c in cands if not BIG.search(c['name']) and not c.get('personal') and c['name'] not in EXCLUDE
             and c['domain'] not in BIG_DOMAINS]
    seen, keep = set(), []
    for c in sorted(cands, key=lambda c: c['name']):
        if c['email'] in seen or c['domain'] in seen:
            continue
        seen |= {c['email'], c['domain']}
        keep.append(c)
    tmp_in, tmp_out = os.path.join(ROOT, '.cache', 'verify_in.json'), os.path.join(ROOT, '.cache', 'verify_out.json')
    json.dump([{'id': i, 'url': c['source_url'], 'email': c['email']} for i, c in enumerate(keep)], open(tmp_in, 'w'))
    subprocess.run(['node', os.path.join(HERE, 'verify_emails.cjs'), tmp_in, tmp_out], check=True)
    ok = {v['id']: v for v in json.load(open(tmp_out)) if v['found']}
    df, extract_time = load_open()
    rows = []
    for i, c in enumerate(keep):
        if i not in ok:
            continue
        text, local, nation, sb = teaser(df, c['trade'], c['state'])
        name = display(c['name'])
        rows.append({'id': f'bd-{len(rows) + 1:03d}', 'name': name, 'email': c['email'], 'website': c['website'],
                     'source_url': c['source_url'], 'city': c['city'], 'state': c['state'], 'naics': c['naics'],
                     'trade': c['trade'], 'greeting': f'Hi {name} team,', 'teaser': text,
                     'open_local': local, 'open_nationwide': nation, 'open_local_sb_setaside': sb,
                     'email_check': ok[i]['how'], 'evidence_award_id': c.get('award_id', ''),
                     'evidence_award_usd': round(c.get('award_amount') or 0), 'recipient_uei': c.get('uei', ''),
                     'teaser_data_as_of_utc': f'{extract_time:%Y-%m-%d %H:%M}'})
    with open(os.path.join(ROOT, 'prospects.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f'{len(keep)} candidates, {len(rows)} verified in browser -> prospects.csv')
    print({t: sum(r['trade'] == t for r in rows) for t in TRADES if any(r['trade'] == t for r in rows)})
    print(sorted({r['state'] for r in rows}))


if __name__ == '__main__':
    main()
