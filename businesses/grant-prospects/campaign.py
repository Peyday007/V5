"""Funder Ledger — grant prospect reports for small nonprofits. Consumed by businesses/common/outreach.py,
which adds the owner's name, phone, mailing address and opt-out to every step (no signature here)."""
import csv, os

NAME = 'Grant Prospects · nonprofits wave 1'
BRAND = 'Funder Ledger'
DAILY_LIMIT = 5
HERE = os.path.dirname(os.path.abspath(__file__))

STEPS = [
    ('Foundations that funded {{cause_label}} in {{state_name}}',
     '<p>{{greeting}},</p>'
     '<p>I put together grant prospect lists for small nonprofits from public tax filings. '
     'I ran {{companyName}} through it and found this: {{teaser}}.</p>'
     '<p>The full report lists each of those funders with the actual grants it made to organizations like yours '
     '(recipient, amount, purpose), the contact and application instructions from its own 990-PF, and any open '
     'federal opportunities on Grants.gov that match your work.</p>'
     '<p>If it would be useful, reply "yes" and I will send {{companyName}}\'s report, free. No call needed.</p>',
     0),
    ('Re: Foundations that funded {{cause_label}} in {{state_name}}',
     '<p>{{greeting}},</p>'
     '<p>A quick follow-up in case this got buried. The report for {{companyName}} is built from the funders\' '
     'own filings, so it shows who has actually given to {{cause_label}} work in {{state_name}}, not just who '
     'lists it as an interest.</p>'
     '<p>Reply "yes" and I will send it over, free.</p>',
     3),
    ('Last note about your grant prospect list',
     '<p>{{greeting}},</p>'
     '<p>Last note from me on this. If a list of {{state_name}} foundations with their past {{cause_label}} grants '
     'and how to apply would help {{companyName}}, reply "yes" and it is yours, free. '
     'If not, no reply is needed.</p>',
     5),
]

def _state_names():
    # the STATE_NAMES literal from the prospect finder, read without importing its network code
    src = open(os.path.join(HERE, 'build', 'find_prospects.py')).read()
    start = src.index('STATE_NAMES = dict(')
    end = src.index(')\n', start)
    return eval(src[start + len('STATE_NAMES = '):end + 1], {'dict': dict})


CAUSE_LABELS = {'youth': 'youth development', 'literacy': 'literacy', 'food': 'hunger relief', 'animal': 'animal welfare',
                'housing': 'housing and homelessness', 'arts': 'arts and culture', 'environment': 'environment and conservation',
                'health': 'community health', 'seniors': 'older adults', 'veterans': 'veterans',
                'domestic-violence': 'domestic violence and victim services', 'disability': 'disability services',
                'workforce': 'workforce and economic opportunity', 'refugee': 'immigrant and refugee services'}


def leads():
    names = _state_names()
    out = []
    with open(os.path.join(HERE, 'prospects.csv'), newline='') as f:
        for r in csv.DictReader(f):
            out.append({'email': r['email'], 'company_name': r['name'], 'website': r['website'],
                        'custom_variables': {'greeting': r['greeting'], 'teaser': r['teaser'],
                                             'cause_label': CAUSE_LABELS[r['cause']], 'state_name': names[r['state']],
                                             'city': r['city'], 'ein': r['ein'], 'prospect_id': r['id'],
                                             'source_url': r['source_url']}})
    return out


def sample(lead):
    """The free report for an organization that said yes, built from its row in prospects.csv."""
    import sys
    email = (lead.get('email') or '').lower()
    with open(os.path.join(HERE, 'prospects.csv'), newline='') as f:
        row = next((r for r in csv.DictReader(f) if r['email'].lower() == email), None)
    if row is None:
        raise SystemExit(f'{email} is not in prospects.csv; run generate.py by hand with its EIN and cause')
    # The same profile the teaser was computed from (find_prospects.py): the IRS master file's city and ZIP area.
    sys.path.insert(0, os.path.join(HERE, 'build'))
    import generate as gen, grantdata as gd
    ein = row['ein'].replace('-', '')
    b = next((r for r in gd.bmf(row['state']) if r['EIN'] == ein), {})
    prof = {'ein': ein, 'name': row['name'], 'city': row['city'], 'state': row['state'], 'zip3': (b.get('ZIP') or '')[:3],
            'ntee': b.get('NTEE_CD'), 'revenue': int(row['revenue'] or 0), 'revenue_year': None, 'url': row['website']}
    report = gen.build(prof, [row['cause']], log=lambda *x: None)
    page = gen.render(report)
    intro = (f'<p>Here is the grant prospect report for {row["name"]}, as promised. Each funder below made grants '
             f'to {CAUSE_LABELS[row["cause"]]} work in {_state_names()[row["state"]]} in its latest tax filing, with the '
             'amounts, purposes and how to apply from its own 990-PF. If you would like a second focus area or a '
             'monthly update when new filings and federal postings appear, just reply.</p>')
    return f'Grant prospect report for {row["name"]}', intro + page
