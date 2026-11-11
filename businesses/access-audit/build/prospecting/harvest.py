"""Harvest candidate small businesses from public chamber-of-commerce member
directories (GrowthZone/ChamberMaster sites: <root>/list/category/...).

Each candidate is a member listing that links to the business's own website.
Output: JSON lines {name, website, city, state, industry, directory_url}.
Only public listing pages are read; nothing is submitted anywhere.

    python3 build/prospecting/harvest.py out/candidates.jsonl
"""
import concurrent.futures as cf, html, json, os, re, ssl, sys, urllib.request
from urllib.parse import urlparse

CTX = ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt') if os.path.exists('/root/.ccr/ca-bundle.crt') else ssl.create_default_context()
UA = 'Mozilla/5.0 (compatible; TabstopProspectResearch/1.0)'

ROOTS = [
    'https://members.durhamchamber.org/members', 'https://members.dsmpartnership.com/list', 'https://member.quadcitieschamber.com/list',
    'https://www.austinbcc.org/list', 'https://business.bellingham.com/list', 'https://business.anchoragechamber.org/list',
    'https://business.mplschamber.com/list', 'https://business.tompkinschamber.org/list', 'https://members.bostonchamber.com/list',
    'https://business.greaterbinghamtonchamber.com/list', 'https://acccolorado.org/list', 'https://www.concordchamber.com/list',
    'https://business.shelbychamber.org/list', 'https://business.tacomachamber.org/list', 'https://www.pvchamber.org/list',
    'https://www.oprfchamber.org/list', 'https://members.bozemanchamber.com/list', 'https://cm.hsvchamber.org/list',
]
INDUSTRIES = [
    ('dental', r'dentist|dental|orthodon'),
    ('medical', r'chiropract|physical-therap|optometr|eye-care|med-spa|medical-spa|dermatolog|veterinar|massage|acupunct'),
    ('legal', r'attorney|lawyer|legal'),
    ('restaurant', r'restaurant|cafe|bakeri|bakery|caterer|catering|brew|winer|coffee'),
    ('lodging', r'hotel|lodging|bed-breakfast|inns|motel'),
    ('retail', r'retail|boutique|gift|shopping|jewel|florist|clothing|furniture'),
    ('salon-spa', r'salon|spa-|day-spa|beauty|barber'),
]
CHAINS = re.compile(r'marriott|hilton|hampton|holiday inn|hyatt|sheraton|westin|courtyard|fairfield|residence inn|best western|comfort inn|'
                    r'la quinta|wyndham|aspen dental|heartland dental|state farm|edward jones|allstate|starbucks|mcdonald|subway|chick-fil|'
                    r'panera|walgreens|cvs|target|walmart|kohl|jcpenney|great clips|supercuts|sport clips|massage envy|hand & stone|'
                    r'pacific dental|smile brands|the joint|olive garden|applebee|buffalo wild|texas roadhouse|outback|kroger|hy-vee|bank|credit union', re.I)
CHAIN_DOMAINS = re.compile(r'marriott|hilton|ihg\.com|hyatt|wyndham|choicehotels|bestwestern|aspendental|statefarm|edwardjones|facebook|'
                           r'instagram|yelp|google|linkedin|\.gov\b|\.edu\b|wix\.com$', re.I)


def get(url, timeout=25):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.read().decode('utf-8', 'replace')
    except Exception:
        return ''


def categories(root):
    page = get(root)
    out = {}
    for href in set(re.findall(r'href="(https?://[^"]+/(?:category|ql)/[^"?#]+)', page)):
        slug = href.rsplit('/', 1)[-1].lower()
        for ind, rx in INDUSTRIES:
            if re.search(rx, slug):
                out[href] = ind
                break
    return out


def cards(cat_url):
    page = get(cat_url)
    out = []
    for block in page.split('gz-list-card-wrapper')[1:]:
        m = re.search(r'href="(https?://[^"]+/member/[^"]+)"[^>]*>([^<]+)</a>\s*</h5>', block) or \
            re.search(r'itemprop="name">\s*<a href="(https?://[^"]+)"[^>]*>([^<]+)</a>', block)
        if not m:
            continue
        city = re.search(r'gz-address-city">([^<]+)<', block)
        st = re.search(r'gz-address-city">[^<]+</span>\s*<span>([A-Z]{2})</span>', block)
        out.append({'detail': m.group(1), 'name': html.unescape(m.group(2)).strip(),
                    'city': html.unescape(city.group(1)).strip() if city else '', 'state': st.group(1) if st else ''})
    return out


def website(detail_url):
    page = get(detail_url)
    m = re.search(r'<a href="(https?://[^"]+)"[^>]*MemberWebsite', page) or re.search(r'<a href="(https?://[^"]+)"[^>]*itemprop="url"', page)
    # some listings carry a doubled scheme such as http://https//example.com
    return re.sub(r'^https?://(https?)(?::/?/?|/)', lambda x: x.group(1).lower() + '://', html.unescape(m.group(1)).strip(), flags=re.I) if m else ''


def main(out_path):
    seen_domains, rows = set(), []
    with cf.ThreadPoolExecutor(8) as ex:
        cat_maps = dict(zip(ROOTS, ex.map(categories, ROOTS)))
        jobs = [(root, url, ind) for root, cm in cat_maps.items() for url, ind in cm.items()]
        print(f'{len(jobs)} category pages across {sum(1 for c in cat_maps.values() if c)} directories', file=sys.stderr)
        card_lists = list(ex.map(lambda j: (j, cards(j[1])), jobs))
        details = []
        per_root_ind = {}
        for (root, url, ind), cl in card_lists:
            for c in cl:
                k = (root, ind)
                if per_root_ind.get(k, 0) >= 25 or CHAINS.search(c['name']):
                    continue
                per_root_ind[k] = per_root_ind.get(k, 0) + 1
                details.append({**c, 'industry': ind, 'directory_url': url})
        print(f'{len(details)} member listings to resolve', file=sys.stderr)
        sites = list(ex.map(lambda d: website(d['detail']), details))
    for d, site in zip(details, sites):
        if not site:
            continue
        dom = urlparse(site).hostname or ''
        dom = dom.lower().removeprefix('www.')
        if not dom or dom in seen_domains or CHAIN_DOMAINS.search(dom):
            continue
        seen_domains.add(dom)
        rows.append({'name': d['name'], 'website': site, 'city': d['city'], 'state': d['state'], 'industry': d['industry'],
                     'directory_url': d['detail']})
    with open(out_path, 'w') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')
    print(f'{len(rows)} candidates with their own website -> {out_path}', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'candidates.jsonl')
