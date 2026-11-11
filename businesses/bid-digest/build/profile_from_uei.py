#!/usr/bin/env python3
"""Draft a customer profile from public USAspending records for a firm's UEI.

  python3 build/profile_from_uei.py UEI OUT.json [--state XX] [--trade KEY]

Certifications come from the business types on the firm's award records (as reported there; the customer
confirms them on the first reply), NAICS from the codes it has actually been paid under in the last 3 years.
"""
import json, os, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usaspending
from trades import TRADES
from make_prospects import display

TYPES = {'small_business': 'small business', '8a_program_participant': '8(a)',
         'service_disabled_veteran_owned_business': 'SDVOSB', 'women_owned_small_business': 'WOSB',
         'economically_disadvantaged_women_owned_small_business': 'WOSB', 'historically_underutilized_business_firm': 'HUBZone'}
KNOWN = {c for _, codes in TRADES.values() for c in codes}
BASE = 'https://api.usaspending.gov/api/v2/'


def api(path, body=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60, context=usaspending.CTX) as r:
        return json.loads(r.read())


def main():
    uei, out = sys.argv[1], sys.argv[2]
    opt = lambda k: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else None
    rec = next(r for r in api('recipient/', {'keyword': uei, 'limit': 5})['results'] if r['recipient_level'] in ('C', 'R'))
    detail = api(f"recipient/{rec['id']}/")
    certs = sorted({TYPES[t] for t in detail.get('business_types', []) if t in TYPES})
    naics = api('search/spending_by_category/naics/', {'filters': {'recipient_search_text': [uei], 'award_type_codes': ['A', 'B', 'C', 'D'],
                                                                   'time_period': usaspending.window(1095)}, 'limit': 10})['results']
    paid = [n['code'] for n in naics]
    trade = opt('--trade') or next((t for t, (_, codes) in TRADES.items() if any(c in codes for c in paid)), None)
    p = {'customer': display(rec['name']), 'uei': uei, 'trades': [trade] if trade else [],
         # other trade NAICS it has been paid under (first 5 by dollars), so the digest covers its real lines of work
         'naics': [c for c in paid[:5] if c in KNOWN and (not trade or c not in TRADES[trade][1])][:2],
         'setasides': certs, 'states': [opt('--state') or detail['location']['state_code']], 'include_neighbors': True,
         'basis': {'business_types_reported': detail.get('business_types', []), 'naics_paid_last_3y': naics,
                   'recipient_location': detail.get('location')}}
    json.dump(p, open(out, 'w'), indent=1)
    print(json.dumps({k: p[k] for k in ('customer', 'trades', 'naics', 'setasides', 'states')}))


if __name__ == '__main__':
    main()
