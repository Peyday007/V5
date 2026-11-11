#!/usr/bin/env python3
"""Find small US nonprofits that publish an organizational email on their own website,
and compute a real teaser for each from the same data the report uses.

  python3 build/find_prospects.py [--per-pair 8] [--want 70]

1. Candidates: IRS Business Master File per state, by NTEE code for a cause, revenue $120K-$3M.
2. Website: the org's own latest Form 990/990-EZ e-file (WebsiteAddressTxt), via the IRS index
   and the GivingTuesday 990 data lake mirror.
3. Email: fetch the homepage and its contact/about pages; keep a role address (info@, contact@,
   office@, director@ ...) on the org's own domain that literally appears in that page's HTML.
   source_url is the page it appears on.
4. Teaser: generate.build() for the org's state and cause -> counts and the closest-fit funder.
Writes ../prospects.csv and cache/prospects_raw.json.
"""
import argparse, csv, json, os, random, re, sys, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import grantdata as gd  # noqa: E402
import generate as gen  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), 'prospects.csv')

NTEE = {'youth': ('O20', 'O50', 'O30', 'O23'), 'literacy': ('B92', 'B60', 'B90'), 'food': ('K31', 'K30', 'K35'),
        'animal': ('D20', 'D40'), 'housing': ('L41', 'P85', 'L40'), 'arts': ('A25', 'A65', 'A68', 'A6A', 'A61'),
        'environment': ('C32', 'C34', 'C30', 'C36'), 'seniors': ('P81',), 'veterans': ('W30',),
        'domestic-violence': ('P43', 'I72'), 'disability': ('P82', 'P80'), 'workforce': ('J20', 'J22'), 'refugee': ('P84', 'R21')}

PAIRS = [('PA', 'youth'), ('OH', 'food'), ('GA', 'animal'), ('NC', 'literacy'), ('MI', 'arts'), ('WI', 'environment'),
         ('MN', 'housing'), ('MO', 'seniors'), ('TN', 'domestic-violence'), ('VA', 'veterans'), ('CO', 'animal'),
         ('OR', 'environment'), ('WA', 'food'), ('TX', 'literacy'), ('NY', 'youth'), ('IL', 'disability'),
         ('IN', 'food'), ('KY', 'youth'), ('IA', 'arts'), ('AZ', 'refugee'), ('FL', 'housing'), ('MA', 'literacy'),
         ('SC', 'food'), ('AL', 'animal'), ('NJ', 'disability'), ('CT', 'arts'), ('ME', 'environment'),
         ('VT', 'food'), ('NM', 'youth'), ('MT', 'animal'), ('ID', 'domestic-violence'), ('NE', 'seniors'),
         ('KS', 'literacy'), ('OK', 'veterans'), ('MD', 'workforce'), ('CA', 'refugee'), ('UT', 'youth'), ('NH', 'housing')]

STATE_NAMES = dict(AL='Alabama', AK='Alaska', AZ='Arizona', AR='Arkansas', CA='California', CO='Colorado', CT='Connecticut', DE='Delaware',
                   FL='Florida', GA='Georgia', HI='Hawaii', ID='Idaho', IL='Illinois', IN='Indiana', IA='Iowa', KS='Kansas', KY='Kentucky',
                   LA='Louisiana', ME='Maine', MD='Maryland', MA='Massachusetts', MI='Michigan', MN='Minnesota', MS='Mississippi',
                   MO='Missouri', MT='Montana', NE='Nebraska', NV='Nevada', NH='New Hampshire', NJ='New Jersey', NM='New Mexico',
                   NY='New York', NC='North Carolina', ND='North Dakota', OH='Ohio', OK='Oklahoma', OR='Oregon', PA='Pennsylvania',
                   RI='Rhode Island', SC='South Carolina', SD='South Dakota', TN='Tennessee', TX='Texas', UT='Utah', VT='Vermont',
                   VA='Virginia', WA='Washington', WV='West Virginia', WI='Wisconsin', WY='Wyoming', DC='District of Columbia')

ROLE = re.compile(r'^(info|contact|office|admin|hello|director|executive|exec|ed|mail|inquir|general|staff|help|frontdesk|front\.desk|'
                  r'reception|team|connect|programs?|main|questions|ask|outreach|operations|board|foodbank|pantry|shelter|adopt|literacy|'
                  r'volunteer|community)', re.I)
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}')
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
SKIP_SITES = re.compile(r'facebook\.|instagram\.|linkedin\.|twitter\.|x\.com|guidestar|candid|charitynavigator|google\.|yelp\.|wix\.com/?$|godaddysites', re.I)
_pc = None


def pc_index():
    global _pc
    if _pc is None:
        _pc = json.load(open(os.path.join(gd.CACHE, 'irs', 'pc_index.json')))
    return _pc


def website_of(ein):
    rec = pc_index().get(ein)
    if not rec:
        return None
    b = gd.fetch(gd.GT_XML.format(rec[1]), cache_key=f'xml_{rec[1]}')
    if not b:
        return None
    m = re.search(rb'<WebsiteAddressTxt>([^<]+)</WebsiteAddressTxt>', b) or re.search(rb'<WebSiteAddressTxt>([^<]+)<', b)
    if not m:
        return None
    w = m.group(1).decode('utf-8', 'replace').strip().lower()
    if w in ('n/a', 'na', 'none', '') or SKIP_SITES.search(w) or '.' not in w:
        return None
    return w if w.startswith('http') else 'http://' + w


def get(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,*/*'})
        with urllib.request.urlopen(req, timeout=20, context=gd.CTX) as r:
            if 'html' not in (r.headers.get('Content-Type') or 'html'):
                return None, None
            return r.geturl(), r.read(800_000).decode('utf-8', 'replace')
    except Exception:
        return None, None


def base_domain(host):
    host = (host or '').lower().split(':')[0]
    host = host[4:] if host.startswith('www.') else host
    parts = host.split('.')
    return '.'.join(parts[-2:]) if len(parts) >= 2 else host


def find_email(site):
    final, page = get(site)
    if not page and site.startswith('http://'):
        final, page = get('https://' + site[7:])
    if not page:
        return None
    dom = base_domain(urllib.parse.urlparse(final).netloc)
    pages = [(final, page)]
    links = re.findall(r'href=["\']([^"\'#]+)["\']', page, re.I)
    cand = []
    for l in links:
        u = urllib.parse.urljoin(final, l)
        if base_domain(urllib.parse.urlparse(u).netloc) == dom and re.search(r'contact|about|connect|reach|staff|team|location', u, re.I):
            if u not in cand and not re.search(r'\.(pdf|jpg|png|docx?)$', u, re.I):
                cand.append(u)
    cand.sort(key=lambda u: (0 if 'contact' in u.lower() else 1, len(u)))
    for u in cand[:3]:
        f2, p2 = get(u)
        if p2:
            pages.append((f2, p2))
    best = None
    for url, html in pages:
        for em in set(EMAIL.findall(html)):
            local, _, edom = em.partition('@')
            if base_domain(edom) != dom or re.search(r'\.(png|jpg|gif|webp|svg)$', em, re.I):
                continue
            if not ROLE.match(local):
                continue
            if em not in html:
                continue
            rank = (0 if local.lower().startswith('info') else 1 if local.lower().startswith('contact') else 2, url != final)
            if best is None or rank < best[0]:
                best = (rank, em.lower(), url)
    return {'email': best[1], 'source_url': best[2], 'website': final} if best else None


def candidates(per_pair, seed=7):
    rnd = random.Random(seed)
    out = []
    idx = pc_index()
    for st, cause in PAIRS:
        rows = [r for r in gd.bmf(st) if (r.get('NTEE_CD') or '').startswith(NTEE[cause]) and r['EIN'] in idx
                and 120_000 <= gd._num(r.get('REVENUE_AMT')) <= 3_000_000 and r.get('SUBSECTION') == '03']
        rnd.shuffle(rows)
        out += [{'ein': r['EIN'], 'bmf_name': r['NAME'], 'city': re.sub(r'\bCty\b', 'City', re.sub(r'\bBch\b', 'Beach', r['CITY'].title())), 'state': st, 'zip3': r['ZIP'][:3],
                 'cause': cause, 'revenue': gd._num(r.get('REVENUE_AMT')), 'ntee': r.get('NTEE_CD')} for r in rows[:per_pair]]
    return out


def org_name(ein, fallback):
    rec = pc_index().get(ein)
    b = gd.fetch(gd.GT_XML.format(rec[1]), cache_key=f'xml_{rec[1]}') if rec else None
    m = re.search(rb'<Filer>.*?<BusinessNameLine1Txt>([^<]+)<(?:/BusinessNameLine1Txt>\s*<BusinessNameLine2Txt>([^<]+)<)?', b or b'', re.S)
    n = (m.group(1) + (b' ' + m.group(2) if m.group(2) else b'')).decode('utf-8', 'replace') if m else fallback
    n = gen.html.unescape(n)
    return re.sub(r'[, ]+(Inc(orporated)?|Corp(oration)?)\.?$', '', gen.tc(n).strip()).strip(' ,')


def probe(c):
    site = website_of(c['ein'])
    if not site:
        return None
    hit = find_email(site)
    if not hit:
        return None
    return {**c, **hit, 'name': org_name(c['ein'], c['bmf_name'])}


def teaser(p, report):
    st = STATE_NAMES[p['state']]
    label = gd.CAUSES[p['cause']]['label']
    fs = report['foundations']
    near = sum(1 for f in fs if f['n_near'] or f['f_near'])
    own = gd._norm(p['name'])
    strong = gd.cause_rx([p['cause']], 'match')

    def good(h):
        return (h['w'] == 1 and strong.search(h['recipient']) and len(h['recipient']) <= 45
                and not gd._norm(h['recipient']).startswith(own[:10]))
    ex, h = None, None
    for f in fs:  # best-ranked open funder whose matching grant names the cause in the recipient itself
        if f['preselected_only'] or f['funds_you'] or f.get('concentrated_elsewhere'):
            continue
        hs = sorted((x for x in f['hits'] if good(x)), key=lambda x: (-x['near'], -x['amount']))
        if hs:
            ex, h = f, hs[0]
            break
    t = f"{len(fs)} {st} foundations made {label} grants in {st} in their latest tax filings"
    if near:
        t += f", {near} of them based or giving near {p['city']}"
    fed = sum(1 for o in report['federal'] if o['in_title'])
    if fed:
        t += f", plus {fed} open or forecast federal grant program{'s' if fed != 1 else ''}"
    if ex:
        t += f" (one example: {funder(ex['name'])} gave {gen.money(h['amount'])} to {gen.tc(h['recipient'])})"
    return t, len(fs), fed, (funder(ex['name']) if ex else '')


def funder(n):
    return re.sub(r'[, ]+(INC|Inc|Incorporated)\.?$', '', gen.tc(n)).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--per-pair', type=int, default=8)
    ap.add_argument('--want', type=int, default=70)
    ap.add_argument('--max-per-pair', type=int, default=3)
    ap.add_argument('--from-raw', action='store_true', help='reuse the last crawl (cache/prospects_raw.json)')
    a = ap.parse_args()
    raw_fp = os.path.join(gd.CACHE, 'prospects_raw.json')
    if a.from_raw:
        found = json.load(open(raw_fp))
        for r in found:
            r['name'] = org_name(r['ein'], r['bmf_name'])
    else:
        cands = candidates(a.per_pair)
        print(len(cands), 'candidates')
        with ThreadPoolExecutor(16) as ex:
            found = [r for r in ex.map(probe, cands) if r]
        json.dump(found, open(raw_fp, 'w'), indent=1)
    print(len(found), 'with a role email on their own site')
    ov = json.load(open(os.path.join(HERE, 'prospect_overrides.json')))
    kept = []
    for r in found:
        o = ov.get(r['ein'], {})
        if o.get('drop'):
            continue
        r['cause'] = o.get('cause', r['cause'])
        r['name'] = o.get('name', r['name'])
        kept.append(r)
    found = kept
    seen, per, picked = set(), {}, []
    for r in found:
        k = (r['state'], r['cause'])
        if r['email'] in seen or per.get(k, 0) >= a.max_per_pair:
            continue
        seen.add(r['email']); per[k] = per.get(k, 0) + 1; picked.append(r)
    picked = picked[:a.want]
    rows, reports = [], {}
    for i, p in enumerate(picked, 1):
        prof = {'ein': p['ein'], 'name': p['name'], 'city': p['city'], 'state': p['state'], 'zip3': p['zip3'], 'ntee': p['ntee'],
                'revenue': p['revenue'], 'revenue_year': None, 'url': ''}
        rep = gen.build(prof, [p['cause']], log=lambda *x: None)
        t, nf, nfed, top = teaser(p, rep)
        rows.append({'id': f'gp-{i:03d}', 'name': p['name'], 'email': p['email'], 'website': p['website'], 'source_url': p['source_url'],
                     'city': p['city'], 'state': p['state'], 'cause': p['cause'], 'ein': f"{p['ein'][:2]}-{p['ein'][2:]}",
                     'revenue': p['revenue'], 'greeting': f"Hello {p['name']} team", 'teaser': t,
                     'n_foundations': nf, 'n_federal': nfed, 'example_funder': top})
        print(rows[-1]['id'], p['state'], p['cause'], p['name'], p['email'], '|', t)
    with open(OUT, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader(); w.writerows(rows)
    print('wrote', OUT, len(rows))


if __name__ == '__main__':
    main()
