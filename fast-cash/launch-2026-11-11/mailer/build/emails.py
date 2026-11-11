"""Find each prospect's own published email address on its own website.

Reads prospects.csv, fetches the site's home page and its contact/about pages,
and writes prospect-emails.csv: id, email, found_on (the page it was read from).
Only addresses the business published are kept; nothing is guessed.
"""
import csv, re, sys, html, urllib.parse
from concurrent.futures import ThreadPoolExecutor
import urllib.request, ssl

HERE = __file__.rsplit('/', 2)[0]
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
BAD = ('example.', 'sentry', 'wixpress', 'domain.com', 'email.com', '.png', '.jpg', '.gif', '.webp',
       'yourname', 'godaddy', 'squarespace', 'wordpress', 'schema.org', 'u003e', 'name@', 'user@')
PATHS = ['', '/contact', '/contact-us', '/contact/', '/about', '/about-us', '/contactus']
CTX = ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt')

def get(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; contact-lookup)'})
        with urllib.request.urlopen(req, timeout=12, context=CTX) as r:
            return r.geturl(), r.read(600_000).decode('utf-8', 'ignore')
    except Exception:
        return None, ''

def emails_in(text):
    text = html.unescape(urllib.parse.unquote(text))
    out = []
    for e in EMAIL.findall(text):
        e = e.strip('.').lower()
        if any(b in e for b in BAD) or len(e) > 60:
            continue
        if e not in out:
            out.append(e)
    return out

def host(u):
    return (urllib.parse.urlparse(u).hostname or '').lower().removeprefix('www.')

def find(row):
    site = row['website_or_email'].strip()
    if '@' in site:
        return row['id'], site.lower(), 'prospects.csv'
    if not site.startswith('http'):
        return row['id'], '', ''
    base = site.rstrip('/')
    dom = host(base)
    best = None
    for p in PATHS:
        final, body = get(base + p)
        if not body:
            continue
        found = emails_in(body)
        same = [e for e in found if e.split('@')[1].removeprefix('www.') in (dom, host(final or ''))]
        pick = same or found
        if pick:
            best = (pick[0], final or base + p)
            if same:
                break
    return row['id'], *(best or ('', ''))

rows = list(csv.DictReader(open(f'{HERE}/prospects.csv')))
with ThreadPoolExecutor(16) as ex:
    res = list(ex.map(find, rows))
with open(f'{HERE}/prospect-emails.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['id', 'email', 'found_on'])
    w.writerows(res)
print(sum(1 for r in res if r[1]), 'of', len(rows), 'have a published email')
