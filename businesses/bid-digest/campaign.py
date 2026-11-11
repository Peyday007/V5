"""Weekly Bid Digest — outreach wave 1 to small contractors that already win small federal awards.

Consumed by businesses/common/outreach.py, which appends the owner's name, phone, mailing address
and the opt-out line to every step. No links, no attachments, no tracking.
"""
import csv, os

NAME = 'Bid Digest · contractors wave 1'
BRAND = 'Weekly Bid Digest'
DAILY_LIMIT = 5

STEPS = [
    ('{{companyName}}: open federal bids in your trade',
     '<p>{{greeting}}</p>'
     '<p>I run a small service that reads SAM.gov every week for small contractors. I ran your trade and area '
     'against this week\'s public SAM.gov data and found {{teaser}}.</p>'
     '<p>Each week I send a short PDF listing the ones that fit you: title, agency, due date, place of '
     'performance, set-aside, the SAM.gov notice number, and who won similar work recently and for how much '
     '(from USAspending).</p>'
     '<p>If you would like this week\'s digest for {{companyName}}, free, just reply "yes". If you hold '
     'set-aside certifications (8(a), WOSB, SDVOSB, HUBZone) or work in other states, tell me and I will '
     'include them.</p>', 0),
    ('Re: {{companyName}}: open federal bids in your trade',
     '<p>{{greeting}}</p>'
     '<p>Following up once. The digest is free for the first two weeks, with nothing to sign up for or log '
     'into. Reply "yes" and I will send this week\'s list for {{companyName}}. After two weeks it is $49 a '
     'month if you find it useful, and nothing if you don\'t.</p>', 3),
    ('Last note on federal bids',
     '<p>{{greeting}}</p>'
     '<p>Last note from me. I am an independent service, not part of SAM.gov or any agency; I just save '
     'contractors the hour a week of searching. If a free sample would help, reply "yes" any time and I '
     'will send one.</p>', 5),
]

HERE = os.path.dirname(os.path.abspath(__file__))


def leads():
    out = []
    with open(os.path.join(HERE, 'prospects.csv'), newline='') as f:
        for r in csv.DictReader(f):
            out.append({'email': r['email'], 'company_name': r['name'], 'website': r['website'],
                        'custom_variables': {'greeting': r['greeting'], 'companyName': r['name'], 'teaser': r['teaser'],
                                             'trade': r['trade'], 'state': r['state'], 'naics': r['naics'],
                                             'source_url': r['source_url']}})
    return out


def sample(lead):
    """The free digest for a lead who said yes: their trade, NAICS and state from the prospect list."""
    import json, subprocess, sys, tempfile
    v = lead.get('custom_variables') or lead.get('payload') or {}
    name = v.get('companyName') or lead.get('company_name') or lead.get('email')
    profile = {'customer': name, 'trades': [v['trade']] if v.get('trade') else [], 'naics': [v['naics']] if v.get('naics') else [],
               'setasides': ['small business'], 'states': [v['state']] if v.get('state') else [], 'include_neighbors': True}
    out = tempfile.mkdtemp(prefix='bid-digest-')
    pf = os.path.join(out, 'profile.json')
    json.dump(profile, open(pf, 'w'))
    subprocess.run([sys.executable, os.path.join(HERE, 'build', 'digest.py'), pf, out], check=True, cwd=os.path.join(HERE, 'build'))
    page = open(os.path.join(out, 'digest.html')).read()
    intro = (f'<p>Here is this week\'s digest for {name}, as promised: every open federal solicitation in your trade and area, '
             'with who won similar work recently. Tell me any certifications you hold or other states you work in, and next '
             'week\'s will include them. The first two weeks are free; after that it is $49 a month if you want to keep it.</p>')
    return f'This week\'s federal bids for {name}', intro + page
