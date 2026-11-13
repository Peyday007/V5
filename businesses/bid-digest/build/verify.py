#!/usr/bin/env python3
"""Check a generated digest against the raw SAM.gov extract, independently of the generator's pandas path.

  python3 build/verify.py samples/<slug>

Re-reads .cache/opps.csv with the csv module and checks, for every row the digest shows, that title,
agency, deadline, NAICS, set-aside and place of performance equal the source row with that NoticeId, and
that the deadline is in the future. It also recounts the profile's matches from the raw file and reports
any open notice the digest missed. Writes <dir>/verification.json.
"""
import csv, json, os, sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from matching import profile_naics, profile_states, family
from data import RAW, BIDDABLE

def ts(v):
    d = datetime.fromisoformat(v)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)  # same rule as the generator: naive means UTC


FIELDS = ['Title', 'Sol#', 'Department/Ind.Agency', 'Sub-Tier', 'Type', 'ResponseDeadLine', 'NaicsCode', 'SetASide', 'PopCity', 'PopState']


def main(d):
    out = json.load(open(os.path.join(d, 'rows.json')))
    p = out['profile']
    want = {r['NoticeId']: r for r in out['rows']}
    naics, states, held = set(profile_naics(p)), set(profile_states(p)), set(p.get('setasides', []))
    now = datetime.now(timezone.utc)
    mismatches, seen, recount = [], set(), {}
    csv.field_size_limit(10**9)
    with open(RAW, encoding='cp1252', newline='') as f:
        for row in csv.DictReader(f):
            nid = row['NoticeId']
            if nid in want:
                seen.add(nid)
                for k in FIELDS:
                    if (row[k] or '') != (want[nid].get(k) or ''):
                        mismatches.append({'notice': nid, 'field': k, 'source': row[k], 'digest': want[nid].get(k)})
                dl = ts(row['ResponseDeadLine'])
                if dl <= now:
                    mismatches.append({'notice': nid, 'field': 'deadline passed', 'source': row['ResponseDeadLine']})
            if row['Type'] in BIDDABLE and row['NaicsCode'] in naics and row['ResponseDeadLine']:
                try:
                    open_ = ts(row['ResponseDeadLine']) > now
                except ValueError:
                    continue
                inside = row['PopState'] in states or (not row['PopState'] and row['State'] in states)
                fam = family(row['SetASideCode'].strip('[]"'))
                ok = fam is None or fam in held or (fam == 'small business' and held)
                if open_ and inside and ok:
                    recount[(row['Sol#'] or nid, row['Department/Ind.Agency'] if row['Sol#'] else '')] = nid
    missing = [nid for nid in want if nid not in seen]
    shown_keys = {(r['Sol#'] or r['NoticeId'], r['Department/Ind.Agency'] if r['Sol#'] else '') for r in out['rows']}
    not_shown = [v for k, v in recount.items() if k not in shown_keys]
    result = {'checked_rows': len(want), 'fields_checked': FIELDS, 'field_mismatches': mismatches,
              'notice_ids_not_in_source': missing, 'independent_recount': len(recount),
              'generator_matched_total': out['matched_total'], 'shown': out['shown'],
              'open_matches_not_shown': len(not_shown), 'checked_at_utc': now.isoformat(timespec='seconds')}
    json.dump(result, open(os.path.join(d, 'verification.json'), 'w'), indent=1)
    print(json.dumps({k: (v if not isinstance(v, list) else len(v)) for k, v in result.items()}))


if __name__ == '__main__':
    main(sys.argv[1])
