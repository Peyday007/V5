#!/usr/bin/env python3
"""Find small contractors who already win small federal awards, and the business email their own site publishes.

  python3 build/find_prospects.py  -> .cache/prospect_candidates.json

1. USAspending: small-business recipients of $15k–$1.5M contracts in a trade's NAICS, recipient based in a state.
2. Try the domains a small firm registers for its own name (no search engine); keep a site whose page names
   the firm and its city or state.
3. Fetch that site's home page and contact pages; keep an address on the site's own domain that appears
   literally in the page, and record the page as source_url.
"""
import concurrent.futures as cf, json, os, re, ssl, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usaspending
from trades import TRADES

CACHE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.cache')
CTX = usaspending.CTX
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
SKIP = re.compile(r'(facebook|linkedin|bbb\.org|yelp|govtribe|highergov|usaspending|bizapedia|dnb\.com|zoominfo|opengov|'
                  r'buzzfile|manta|mapquest|yellowpages|indeed|glassdoor|govcb|sam\.gov|instagram|twitter|x\.com|youtube|'
                  r'wikipedia|bloomberg|crunchbase|opencorporates|corporationwiki|chamberofcommerce|angi|houzz|thumbtack|'
                  r'nextdoor|govspend|federalcompass|govconwire|cage\.report|sbir|usa\.gov|\.gov$|\.mil$|bing\.com|microsoft|'
                  r'apple\.com|google|amazon|procurement|dsbs|sba\.gov|govsearch|federalpay|prnewswire|issuu|scribd|pdf)', re.I)
STOP = {'inc', 'llc', 'co', 'corp', 'corporation', 'company', 'the', 'and', 'of', 'services', 'service', 'group', 'enterprises',
        'ltd', 'lp', 'llp', 'pllc', 'pc', 'solutions', 'contracting', 'construction', 'international', 'usa', 'america', 'us'}
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
PREF = ['bids', 'bid', 'estimating', 'estimates', 'contracts', 'info', 'contact', 'sales', 'office', 'admin', 'hello', 'service', 'inquiries']

PLAN = {  # trade -> states to look in
    'janitorial': ['VA', 'TX', 'GA', 'NC', 'FL', 'CO', 'MD'], 'landscaping': ['VA', 'TX', 'FL', 'GA', 'CA', 'SC'],
    'facilities': ['FL', 'TX', 'VA', 'NC', 'AL'], 'security': ['VA', 'MD', 'GA', 'TX', 'CA'],
    'hvac': ['WA', 'GA', 'TX', 'VA', 'OH', 'NY'], 'electrical': ['CA', 'OH', 'PA', 'TX', 'VA', 'NY'],
    'construction': ['NC', 'VA', 'TX', 'CA', 'NY', 'PA', 'CO'], 'roofing': ['NJ', 'TX', 'VA', 'CO', 'FL'],
    'sitework': ['CO', 'OK', 'NC', 'TX', 'NM'], 'pest': ['CA', 'TX', 'FL', 'VA'],
    'it': ['MD', 'VA', 'IL', 'TX', 'CO'], 'staffing': ['IL', 'FL', 'TX', 'VA'],
    'waste': ['VA', 'MA', 'TX', 'NC'], 'repair': ['CA', 'VA', 'HI', 'TX'], 'painting': ['IN', 'PA', 'TX', 'VA'],
}


def get(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html'})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        if 'html' not in (r.headers.get('Content-Type') or 'html'):
            return '', r.geturl()
        return r.read(800_000).decode('utf-8', 'replace'), r.geturl()


def recipients(trade, state, per=15):
    out = {}
    for n in TRADES[trade][1]:
        rows = usaspending.search({'naics_codes': {'require': [n]}, 'recipient_type_names': ['small_business'],
                                   'recipient_locations': [{'country': 'USA', 'state': state}],
                                   'award_amounts': [{'lower_bound': 15000, 'upper_bound': 1500000}],
                                   'time_period': usaspending.window(540)}, sort='Award Amount', limit=40)
        for r in rows:
            name = (r.get('Recipient Name') or '').strip()
            if name and name not in out:
                loc = r.get('Recipient Location') or {}
                out[name] = {'name': name, 'city': (loc.get('city_name') or '').title(), 'state': state, 'naics': n,
                             'trade': trade, 'uei': r.get('Recipient UEI'), 'award_id': r.get('Award ID'),
                             'award_amount': r.get('Award Amount'), 'award_desc': (r.get('Description') or '')[:120]}
    return list(out.values())[:per]


def words(name):
    return [w for w in re.findall(r'[a-z0-9]+', name.lower()) if w not in STOP and len(w) > 2]


STATES = {'AL': 'Alabama', 'AZ': 'Arizona', 'CA': 'California', 'CO': 'Colorado', 'FL': 'Florida', 'GA': 'Georgia',
          'HI': 'Hawaii', 'IL': 'Illinois', 'IN': 'Indiana', 'MA': 'Massachusetts', 'MD': 'Maryland', 'NC': 'North Carolina',
          'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York', 'OH': 'Ohio', 'OK': 'Oklahoma', 'PA': 'Pennsylvania',
          'SC': 'South Carolina', 'TX': 'Texas', 'VA': 'Virginia', 'WA': 'Washington'}
LEGAL = {'inc', 'llc', 'co', 'corp', 'corporation', 'company', 'ltd', 'lp', 'llp', 'pllc', 'pc', 'the', 'dba'}


def guesses(name):
    """Domains a small firm plausibly registered for its own name. No search engine is used."""
    toks = [w for w in re.findall(r'[a-z0-9]+', name.lower().replace('&', ' and ')) if w not in LEGAL]
    core = [w for w in toks if w not in STOP]
    cands = []
    for parts in (toks, [w for w in toks if w != 'and'], core, toks[:2], core[:2]):
        if parts and len(''.join(parts)) >= 5:
            cands += [''.join(parts), '-'.join(parts)]
    if toks:
        cands += [''.join(toks) + 'inc', ''.join(toks) + 'llc']
    return list(dict.fromkeys(c + '.com' for c in cands))


def visible(html):
    t = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', html)
    return re.sub(r'\s+', ' ', html_unescape(re.sub(r'<[^>]+>', ' ', t))).lower()


def html_unescape(s):
    import html as h
    return h.unescape(s)


def is_theirs(html, rec):
    """The page names the firm (its distinctive words, in order) and its city or state."""
    text = visible(html)
    toks = [w for w in re.findall(r'[a-z0-9]+', rec['name'].lower().replace('&', ' and ')) if w not in LEGAL and w != 'and']
    core = [w for w in toks if w not in STOP] or toks
    phrase = r'\W+(?:and\W+|&\W*)?'.join(map(re.escape, core[:3]))
    if not re.search(r'\b' + phrase + r'\b', text):
        return False
    city = rec['city'].lower()
    return (city and city in text) or STATES.get(rec['state'], '#').lower() in text


def site_for(rec):
    for dom in guesses(rec['name']):
        for url in (f'https://www.{dom}/', f'https://{dom}/'):
            try:
                html, final = get(url, timeout=10)
            except Exception:
                continue
            if html and is_theirs(html, rec):
                return final, html
            break
    return None


def cf_decode(hexstr):
    k = int(hexstr[:2], 16)
    return ''.join(chr(int(hexstr[i:i + 2], 16) ^ k) for i in range(2, len(hexstr), 2))


def emails_on(html, dom):
    found = set()
    html = html + ' ' + ' '.join(cf_decode(h) for h in re.findall(r'data-cfemail="([0-9a-f]+)"', html))
    for m in EMAIL.findall(html.replace('mailto:', ' ')):
        m = m.strip('.').lower()
        if m.split('@')[1].removeprefix('www.') == dom and not re.search(r'\.(png|jpg|gif|webp|svg)$', m):
            found.add(m)
    return found


def find_email(site, home=None):
    final = site
    if home is None:
        home, final = get(site)
    dom = (urllib.parse.urlparse(final).hostname or '').lower().removeprefix('www.')
    pages = [(final, home)]
    links = set()
    for href in re.findall(r'href=["\']([^"\'#]+)', home):
        if re.search(r'contact|about|reach|quote|bid', href, re.I) and not href.startswith('mailto'):
            u = urllib.parse.urljoin(final, href)
            if (urllib.parse.urlparse(u).hostname or '').lower().removeprefix('www.') == dom:
                links.add(u)
    for u in sorted(links, key=lambda x: 'contact' not in x.lower())[:4]:
        try:
            pages.append((u, get(u)[0]))
        except Exception:
            pass
    best = None
    for url, text in pages:
        for em in emails_on(text, dom):
            local = em.split('@')[0]
            rank = next((i for i, p in enumerate(PREF) if local.startswith(p)), len(PREF) + (5 if '.' in local else 0))
            if best is None or rank < best[0]:
                best = (rank, em, url, text)
    if not best:
        return None
    rank, em, url, text = best
    title = re.search(r'<title[^>]*>(.*?)</title>', text, re.S | re.I)
    return {'email': em, 'source_url': url, 'website': f'https://{urllib.parse.urlparse(final).hostname}/', 'domain': dom,
            'page_title': re.sub(r'\s+', ' ', title.group(1)).strip()[:120] if title else '', 'personal': rank > len(PREF)}


def process(rec):
    try:
        found = site_for(rec)
        if not found:
            return {**rec, 'status': 'no site'}
        site, home = found
        hit = find_email(site, home)
        return {**rec, 'site': site, **(hit or {}), 'status': 'ok' if hit else 'no email'}
    except Exception as ex:
        return {**rec, 'status': f'error {type(ex).__name__}'}


def main():
    path = os.path.join(CACHE, 'prospect_candidates.json')
    done = {r['name']: r for r in json.load(open(path))} if os.path.exists(path) else {}
    recs = []
    for trade, states in PLAN.items():
        for st in states:
            recs += [r for r in recipients(trade, st) if r['name'] not in done]
    print(len(recs), 'new recipients', file=sys.stderr)
    with cf.ThreadPoolExecutor(12) as ex:
        for r in ex.map(process, recs):
            done[r['name']] = r
            print(r['status'], r['name'], r.get('email', ''), file=sys.stderr)
    json.dump(list(done.values()), open(path, 'w'), indent=1)
    print(sum(1 for r in done.values() if r['status'] == 'ok'), 'with email')


if __name__ == '__main__':
    main()
