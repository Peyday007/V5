"""Tabstop Accessibility Reports — outreach wave 1, consumed by businesses/common/outreach.py.

outreach.py appends the owner's name, phone, mailing address and the opt-out to
every step, so no signature or footer is written here. No links, no attachments:
the free summary and the paid report are sent only to people who reply.
"""
import csv, os

NAME = 'Accessibility Audit · small business wave 1'
BRAND = 'Tabstop Accessibility Reports'
DAILY_LIMIT = 5

STEPS = [
    ('Accessibility scan of {{website}}',
     '<p>{{greeting}},</p>'
     '<p>I ran a free automated accessibility scan of the {{companyName}} homepage using axe-core, the open-source '
     'testing engine many accessibility teams use. It found that {{teaser}}.</p>'
     '<p>Issues like these make a site hard to use for customers who rely on a screen reader, a keyboard or zoom, '
     'and most of them are quick fixes for whoever maintains your site.</p>'
     '<p>If it would be useful, reply "yes" and I will send you a free short summary of your homepage: each issue, '
     'where it is on the page, and the code change that fixes it. No obligation.</p>', 0),
    ('Following up on the {{website}} scan',
     '<p>{{greeting}},</p>'
     '<p>A quick follow-up on the accessibility scan of {{website}}. For context: website accessibility under the ADA '
     'has become a common subject of demand letters to small businesses, and the most frequently cited problems are '
     'exactly the kind the scan picks up.</p>'
     '<p>Reply "yes" for the free homepage summary. If you want the whole site covered, I also prepare a full report '
     '($149, up to 10 key pages such as contact, booking and product pages, checked at desktop and phone widths) with '
     'every issue explained in plain English and the exact fix for your developer.</p>', 3),
    ('Last note about {{website}}',
     '<p>{{greeting}},</p>'
     '<p>Last note from me. The scan results for {{companyName}} are ready if you want them: reply "yes" and I will '
     'send the free homepage summary.</p>'
     '<p>To be clear about what it is: a practical list of fixes from automated testing, not legal advice and not a '
     'compliance certificate. Automated tools catch many common problems but not all of them, and the report says '
     'which ones it cannot check.</p>', 5),
]


def leads():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prospects.csv')
    out = []
    with open(path, newline='') as f:
        for r in csv.DictReader(f):
            out.append({
                'email': r['email'],
                'company_name': r['name'],
                # Instantly's {{website}} renders this field, so it carries the bare domain the email names.
                'website': r['website'].split('://', 1)[-1].removeprefix('www.').rstrip('/'),
                'custom_variables': {
                    'greeting': r['greeting'], 'teaser': r['teaser'], 'issuesTotal': r['issues_total'], 'criticalSerious': r['critical_serious'],
                    'topIssue': r['top_issue'], 'city': r['city'], 'state': r['state'], 'industry': r['industry'],
                    'source_url': r['source_url'],
                },
            })
    return out


def sample(lead):
    """The free homepage summary for a business that said yes: a fresh scan of its own homepage."""
    import subprocess, tempfile
    here = os.path.dirname(os.path.abspath(__file__))
    site = lead.get('website') or ''
    if not site:
        with open(os.path.join(here, 'prospects.csv'), newline='') as f:
            row = next((r for r in csv.DictReader(f) if r['email'].lower() == (lead.get('email') or '').lower()), None)
        site = row['website'] if row else ''
    if not site:
        raise SystemExit(f"no website on file for {lead.get('email')}")
    url = site if site.startswith('http') else 'https://' + site
    out = tempfile.mkdtemp(prefix='tabstop-')
    subprocess.run(['node', os.path.join(here, 'build', 'audit.mjs'), url, '--quick', '--no-pdf', '--out', out], check=True, cwd=here)
    page = open(os.path.join(out, 'report.html')).read()
    host = url.split('://', 1)[-1].rstrip('/')
    intro = (f'<p>Here is the free accessibility summary for {host}, from a fresh scan today. Each issue shows where it is '
             'on the page and the code change that fixes it, so you can pass it straight to whoever maintains your site. '
             'If you would like every key page covered (contact, booking, product pages, at desktop and phone widths), '
             'the full report is $149; just reply.</p>')
    return f'Accessibility summary for {host}', intro + page
