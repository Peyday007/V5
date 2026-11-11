#!/usr/bin/env python3
"""Keep only prospects whose email a person would actually see on source_url (visible text or a mailto link),
per build/cache/email_check.json from verify_emails.cjs; renumber ids; add the email_seen column."""
import csv, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
fp = os.path.join(os.path.dirname(HERE), 'prospects.csv')
chk = json.load(open(os.path.join(HERE, 'cache', 'email_check.json')))
rows = [r for r in csv.DictReader(open(fp)) if chk.get(r['id'], {}).get('seen') in ('visible', 'mailto')]
for i, r in enumerate(rows, 1):
    r['email_seen'] = chk[r['id']]['seen']
    r['id'] = f'gp-{i:03d}'
with open(fp, 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
print(len(rows), 'prospects kept')
