"""Free public data behind a Grant Prospect Report.

Sources (all free, no key):
  * IRS Exempt Organizations Business Master File, per state
      https://www.irs.gov/pub/irs-soi/eo_<st>.csv   -> every private foundation in a state, with assets
  * IRS Form 990 e-file index, 2024-2026
      https://apps.irs.gov/pub/epostcard/990/xml/<yr>/index_<yr>.csv -> the latest 990-PF object id per EIN
  * The 990-PF XML itself (Part XV: every grant paid, recipient, city/state, purpose, amount,
    and how to apply), mirrored by the GivingTuesday 990 data lake
      https://gt990datalake-rawdata.s3.amazonaws.com/EfileData/XmlFiles/<object_id>_public.xml
  * ProPublica Nonprofit Explorer API (the customer's own profile)
  * Grants.gov search2 / fetchOpportunity (open federal opportunities)

Everything fetched is cached under build/cache/ so a re-run is cheap and a report can be
re-derived from exactly the bytes it was built from.
"""
import csv, hashlib, json, math, os, re, ssl, threading, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
CA = '/root/.ccr/ca-bundle.crt'
CTX = ssl.create_default_context(cafile=CA) if os.path.exists(CA) else ssl.create_default_context()
UA = 'grant-prospect-report/1.0 (public-data research)'
GT_XML = 'https://gt990datalake-rawdata.s3.amazonaws.com/EfileData/XmlFiles/{}_public.xml'
NS = '{http://www.irs.gov/efile}'
_lock = threading.Lock()


# ---------------------------------------------------------------- http + cache
def _path(*p):
    full = os.path.join(CACHE, *p)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    return full


def fetch(url, data=None, cache_key=None, max_age_days=None, timeout=60, tries=3):
    """GET (or POST JSON when data is given) with an on-disk cache. Returns bytes or None on 404/403."""
    key = cache_key or hashlib.sha1((url + json.dumps(data, sort_keys=True) if data else url).encode()).hexdigest()
    fp = _path('http', key[:2], key)
    if os.path.exists(fp) and (max_age_days is None or time.time() - os.path.getmtime(fp) < max_age_days * 86400):
        b = open(fp, 'rb').read()
        return None if b == b'__MISSING__' else b
    body = json.dumps(data).encode() if data is not None else None
    hdr = {'User-Agent': UA}
    if body is not None:
        hdr['Content-Type'] = 'application/json'
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=hdr), timeout=timeout, context=CTX) as r:
                b = r.read()
            open(fp, 'wb').write(b)
            return b
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                open(fp, 'wb').write(b'__MISSING__')
                return None
            if i == tries - 1:
                raise
        except Exception:
            if i == tries - 1:
                raise
        time.sleep(1.5 * (i + 1))


def fetch_json(url, data=None, **kw):
    b = fetch(url, data=data, **kw)
    return json.loads(b) if b else None


# ---------------------------------------------------------------- causes
# Each cause: regex fragments matched at a word start against a grant's purpose and recipient
# name (foundation side), and plain keywords sent to Grants.gov (federal side).
CAUSES = {
    'youth': {'label': 'youth development',
              'match': [r'youth', r'teens?\b', r'after[- ]?school', r'out[- ]of[- ]school', r'mentor', r'boys? (and|&) girls', r'big brothers', r'juvenile', r'4-?h\b', r'scouts?\b', r'ymca', r'summer camp', r'young people'],
              'weak': [r'kids\b', r'children', r'camp\b'],
              'fed_match': [r'youth', r'mentor', r'after[- ]?school', r'out[- ]of[- ]school', r'juvenile', r'adolescen', r'young people'],
              'federal': ['youth', 'mentoring', 'after school', 'juvenile']},
    'literacy': {'label': 'literacy',
                 'match': [r'literac', r'early reading', r'reading (program|skill|readiness|is fundamental|ready|proficien|intervention|level|buddies|partners)', r'read to', r'tutor', r'ged\b', r'adult (basic )?educ', r'english (as a second|language learn)', r'esl\b', r'book (gift|distribut|bank)', r'imagination library'],
                 'weak': [r'librar', r'books?\b'],
                 'exclude': [r'(media|financial|health|data|news|environmental|digital|civic) literac'],
                 'fed_match': [r'(adult|family|early|child|children.s|youth|english|basic|reading) literac', r'literacy (program|services|instruction|skills|council)', r'adult (basic )?education', r'reading', r'tutor', r'english language acquisition'],
                 'federal': ['literacy', 'adult education', 'reading']},
    'food': {'label': 'hunger relief',
             'match': [r'food', r'hunger', r'meals?\b', r'pantry', r'pantries', r'soup kitchen', r'feeding', r'harvest'],
             'weak': [r'nutrition'],
             'exclude': [r'food allerg', r'whole foods', r'seafood', r'animal', r'pets?\b', r'wildlife', r'food (systems? policy|forest)'],
             'fed_match': [r'food (security|insecurity|bank|pantr|access|assistance|recovery|distribution)', r'hunger', r'nutrition', r'feeding', r'emergency food', r'meals'],
             'federal': ['food security', 'hunger', 'nutrition', 'food assistance']},
    'animal': {'label': 'animal welfare',
               'match': [r'animal', r'humane', r'spca\b', r'aspca', r'pets?\b', r'dogs?\b', r'cats?\b', r'feline', r'canine', r'wildlife rehab', r'wildlife (center|rescue)', r'equine', r'horse rescue', r'veterinar', r'spay', r'neuter'],
               'exclude': [r'animal science', r'4-?h'],
               'fed_match': [r'animal welfare', r'companion animal', r'veterinar', r'wildlife rehab', r'shelter animals?', r'animal care'],
               'federal': ['animal welfare', 'veterinary', 'animal care']},
    'housing': {'label': 'housing and homelessness',
                'match': [r'homeless', r'affordable housing', r'housing', r'shelter', r'habitat for humanity', r'transitional', r'rescue mission', r'eviction', r'supportive housing'],
                'exclude': [r'animal shelter', r'humane'],
                'fed_match': [r'homeless', r'housing', r'shelter', r'eviction'],
                'federal': ['homeless', 'housing', 'shelter']},
    'arts': {'label': 'arts and culture',
             'match': [r'arts\b', r'art (center|museum|gallery|program|education|league|council|association)', r'museum', r'theat(er|re)', r'symphony', r'orchestra', r'music', r'dance', r'opera', r'choir', r'chorale', r'gallery', r'ballet', r'playhouse'],
             'weak': [r'cultural', r'heritage'],
             'exclude': [r'martial arts', r'liberal arts', r'arts? and sciences'],
             'fed_match': [r'arts\b', r'artist', r'museum', r'humanities', r'theat', r'music', r'cultural heritage'],
             'federal': ['arts', 'humanities', 'museum', 'cultural']},
    'environment': {'label': 'environment and conservation',
                    'match': [r'conservanc', r'conservation', r'environment', r'watershed', r'land trust', r'nature (center|preserve|conservancy)', r'audubon', r'riverkeeper', r'open space', r'clean water', r'forest', r'climate', r'wetland', r'habitat restor', r'stream restor', r'trail(s)? (conservancy|association|club|council)'],
                    'weak': [r'river', r'parks?\b', r'trails?\b', r'garden', r'nature'],
                    'exclude': [r'habitat for humanity', r'learning environment', r'safe environment'],
                    'fed_match': [r'conservation', r'watershed', r'environmental education', r'habitat', r'wetland', r'restoration', r'climate', r'stewardship'],
                    'federal': ['conservation', 'watershed', 'environmental education', 'habitat']},
    'health': {'label': 'community health',
               'match': [r'health', r'clinic', r'medical', r'hospice', r'mental', r'behavioral', r'cancer', r'diabet', r'dental', r'wellness', r'recovery', r'addiction', r'substance'],
               'fed_match': [r'community health', r'mental health', r'behavioral health', r'substance use', r'rural health', r'health (services|equity|access)', r'opioid'],
               'federal': ['community health', 'mental health', 'substance use', 'health services']},
    'seniors': {'label': 'older adults',
                'match': [r'seniors?\b', r'aging', r'elder', r'older adult', r'meals on wheels', r'alzheimer', r'dementia', r'caregiv', r'retired and senior'],
                'fed_match': [r'older (adult|american|individual)', r'aging', r'elder', r'caregiv', r'dementia', r'senior'],
                'federal': ['older adults', 'aging', 'caregiver', 'elder']},
    'veterans': {'label': 'veterans',
                 'match': [r'veteran', r'military', r'service members', r'vfw\b', r'american legion', r'gold star', r'troops', r'uso\b'],
                 'fed_match': [r'veteran', r'military famil', r'service member'],
                 'federal': ['veterans', 'military families', 'service members']},
    'domestic-violence': {'label': 'domestic violence and victim services',
                          'match': [r'domestic', r'abuse', r'violence', r'victim', r'safe ?house', r'women.s (center|shelter|resource)', r'sexual assault', r'trafficking', r'rape crisis', r'child advocacy'],
                          'weak': [r'crisis'],
                          'exclude': [r'substance abuse', r'drug abuse', r'alcohol abuse', r'domestic (and|&) foreign', r'domestic missions?'],
                          'fed_match': [r'domestic violence', r'dating violence', r'sexual assault', r'victim', r'stalking', r'trafficking', r'violence against women'],
                          'federal': ['domestic violence', 'victim services', 'sexual assault', 'violence against women']},
    'disability': {'label': 'disability services',
                   'match': [r'disabilit', r'disabled', r'special needs', r'autism', r'autistic', r'down syndrome', r'blind', r'deaf', r'the arc\b', r'special olympics', r'therapeutic riding', r'intellectual', r'cerebral palsy', r'easter ?seals'],
                   'fed_match': [r'disabilit', r'autism', r'independent living', r'developmental'],
                   'federal': ['disabilities', 'disability', 'autism', 'independent living']},
    'workforce': {'label': 'workforce and economic opportunity',
                  'match': [r'workforce', r'job training', r'employment', r'careers?\b', r'job readiness', r'financial (literacy|empowerment|coaching|capability)', r'small business', r'entrepreneur', r'goodwill', r'job skills', r'reentry', r're-entry'],
                  'fed_match': [r'workforce', r'job training', r'employment', r'apprentice', r'reentry', r'career'],
                  'federal': ['workforce development', 'job training', 'employment', 'reentry']},
    'refugee': {'label': 'immigrant and refugee services',
                'match': [r'refugee', r'immigra', r'newcomer', r'asylum', r'resettle', r'english as a second', r'citizenship', r'welcoming center'],
                'fed_match': [r'refugee', r'immigra', r'newcomer', r'resettle', r'citizenship', r'asylee'],
                'federal': ['refugee', 'immigrant', 'resettlement', 'citizenship']},
}


def cause_regex(causes):
    frags = [f for c in causes for f in CAUSES[c]['match']]
    return re.compile(r'\b(?:' + '|'.join(frags) + ')', re.I)


# ---------------------------------------------------------------- the customer
def propublica_org(ein):
    return fetch_json(f'https://projects.propublica.org/nonprofits/api/v2/organizations/{int(ein)}.json', max_age_days=30)


def propublica_search(q, state=None):
    url = 'https://projects.propublica.org/nonprofits/api/v2/search.json?q=' + urllib.parse.quote(q)
    if state:
        url += '&state%5Bid%5D=' + state
    return (fetch_json(url, max_age_days=30) or {}).get('organizations', [])


def profile(ein):
    d = propublica_org(ein)
    if not d:
        return None
    o = d['organization']
    fil = sorted(d.get('filings_with_data', []), key=lambda f: f.get('tax_prd') or 0, reverse=True)
    rev = fil[0].get('totrevenue') if fil else o.get('revenue_amount') or o.get('income_amount')
    return {'ein': f"{int(ein):09d}", 'name': o['name'], 'city': o.get('city'), 'state': o.get('state'),
            'ntee': o.get('ntee_code'), 'zip3': (o.get('zipcode') or '')[:3], 'revenue': rev, 'revenue_year': fil[0].get('tax_prd_yr') if fil else None,
            'url': f'https://projects.propublica.org/nonprofits/organizations/{int(ein)}'}


# ---------------------------------------------------------------- foundations
def bmf(state):
    fp = _path('bmf', f'eo_{state.lower()}.csv')
    if not os.path.exists(fp) or time.time() - os.path.getmtime(fp) > 30 * 86400:
        b = fetch(f'https://www.irs.gov/pub/irs-soi/eo_{state.lower()}.csv', cache_key=f'bmf_{state}', max_age_days=30)
        open(fp, 'wb').write(b)
    with open(fp, newline='', encoding='utf-8', errors='replace') as f:
        return list(csv.DictReader(f))


_pf_index = None


def pf_index():
    """EIN -> [tax_period, object_id] of the latest e-filed 990-PF in the 2024-2026 IRS indexes."""
    global _pf_index
    if _pf_index is not None:
        return _pf_index
    fp = _path('irs', 'pf_index.json')
    if not os.path.exists(fp):
        idx = {}
        for y in (2024, 2025, 2026):
            raw = _path('irs', f'index_{y}.csv')
            if not os.path.exists(raw):
                open(raw, 'wb').write(fetch(f'https://apps.irs.gov/pub/epostcard/990/xml/{y}/index_{y}.csv', timeout=600))
            with open(raw, newline='', encoding='utf-8', errors='replace') as f:
                for r in csv.DictReader(f):
                    if r['RETURN_TYPE'] != '990PF':
                        continue
                    e, k = r['EIN'].zfill(9), [r['TAX_PERIOD'], r['OBJECT_ID']]
                    if e not in idx or k > idx[e]:
                        idx[e] = k
        json.dump(idx, open(fp, 'w'))
    _pf_index = json.load(open(fp))
    return _pf_index


def _t(el, path):
    if el is None:
        return ''
    x = el.find('/'.join(NS + p for p in path.split('/')))
    return x.text.strip() if x is not None and x.text else ''


def clean_name(s):
    s = re.sub(r'\s(IN|INCO?|I)$', ' INC', (s or '').strip())
    s = re.sub(r'\s+C/O\b.*$', '', s, flags=re.I)
    s = re.sub(r'\bX{4,}\b|\b\d{2}[A-Z]?\d{6,}\b|\b(UA|U/A|DTD)\b.*$', '', s)
    return re.sub(r'\s+', ' ', s).strip(' ,-')


def _name(el):
    l1, l2 = _t(el, 'RecipientBusinessName/BusinessNameLine1Txt'), _t(el, 'RecipientBusinessName/BusinessNameLine2Txt')
    return _t(el, 'RecipientPersonNm') or (l1 if not l2 or l2.lower() in l1.lower() else f'{l1} {l2}')


def _addr(el, tag='RecipientUSAddress'):
    return {'line': _t(el, f'{tag}/AddressLine1Txt'), 'city': _t(el, f'{tag}/CityNm').title(),
            'state': _t(el, f'{tag}/StateAbbreviationCd'), 'zip': _t(el, f'{tag}/ZIPCd')}


def parse_990pf(xml_bytes):
    root = ET.fromstring(xml_bytes)
    hdr, pf = root.find(NS + 'ReturnHeader'), root.find(f'{NS}ReturnData/{NS}IRS990PF')
    if pf is None:
        return None
    filer = hdr.find(NS + 'Filer')
    out = {'tax_period_end': _t(hdr, 'TaxPeriodEndDt'), 'tax_year': _t(hdr, 'TaxYr'),
           'name': clean_name(' '.join(filter(None, [_t(filer, 'BusinessName/BusinessNameLine1Txt'), _t(filer, 'BusinessName/BusinessNameLine2Txt')]))),
           'address': _addr(filer, 'USAddress'), 'phone': _t(filer, 'PhoneNum'),
           'website': _t(pf, 'StatementsRegardingActyGrp/WebsiteAddressTxt'),
           'fmv_assets': _num(_t(pf, 'FMVAssetsEOYAmt')),
           'total_grants': _num(_t(pf, 'SupplementaryInformationGrp/TotalGrantOrContriPdDurYrAmt')) or _num(_t(pf, 'AnalysisOfRevenueAndExpenses/ContriPaidRevAndExpnssAmt')),
           'preselected_only': _t(pf, 'SupplementaryInformationGrp/OnlyContriToPreselectedInd') == 'X',
           'apply': [], 'grants': []}
    sup = pf.find(NS + 'SupplementaryInformationGrp')
    if sup is None:
        return out
    for a in sup.findall(NS + 'ApplicationSubmissionInfoGrp'):
        out['apply'].append({'contact': _t(a, 'RecipientPersonNm'), 'address': _addr(a), 'phone': _t(a, 'RecipientPhoneNum'),
                             'email': _t(a, 'RecipientEmailAddressTxt'), 'how': _t(a, 'FormAndInfoAndMaterialsTxt'),
                             'deadlines': _t(a, 'SubmissionDeadlinesTxt'), 'restrictions': _t(a, 'RestrictionsOnAwardsTxt')})
    for g in sup.findall(NS + 'GrantOrContributionPdDurYrGrp'):
        a = _addr(g)
        own = out['address']
        loc_ok = bool(a['state']) and not re.search(r'UPON REQUEST|SEE ATTACH|ON FILE|^N/?A$', a['line'], re.I) \
            and not (a['line'] and a['line'].upper() == own['line'].upper() and a['zip'][:5] == own['zip'][:5])
        out['grants'].append({'recipient': _name(g), 'city': a['city'], 'state': a['state'] if loc_ok else '', 'zip3': a['zip'][:3] if loc_ok else '',
                              'status': _t(g, 'RecipientFoundationStatusCd'), 'purpose': _t(g, 'GrantOrContributionPurposeTxt'),
                              'amount': _num(_t(g, 'Amt'))})
    return out


def _num(s):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return 0


def foundation_filing(ein, object_id):
    """Parsed 990-PF for one foundation, cached as small JSON."""
    fp = _path('pf', object_id[:4], f'{object_id}.json')
    if os.path.exists(fp):
        return json.load(open(fp))
    b = fetch(GT_XML.format(object_id), cache_key=f'xml_{object_id}')
    parsed = None
    if b:
        try:
            parsed = parse_990pf(b)
        except ET.ParseError:
            parsed = None
    if parsed:
        parsed['ein'] = ein
        parsed['object_id'] = object_id
    json.dump(parsed, open(fp, 'w'))
    # the raw XML is kept only in the http cache; drop it if large to keep the cache small
    return parsed


def state_foundations(state, top=350, workers=16, log=print, zip3=None, local_min_assets=250_000, local_cap=150):
    """The `top` largest grantmaking private foundations based in `state` (IRS BMF foundation code 04,
    by assets), each with its latest e-filed 990-PF parsed."""
    idx = pf_index()
    rows = [r for r in bmf(state) if r.get('FOUNDATION') == '04' and r['EIN'] in idx]
    rows.sort(key=lambda r: -_num(r.get('ASSET_AMT')))
    local = [r for r in rows[top:] if zip3 and r.get('ZIP', '')[:3] == zip3 and _num(r.get('ASSET_AMT')) >= local_min_assets][:local_cap]
    rows = rows[:top] + local
    log(f'  {state}: scanning the {top} largest private foundations by assets + {len(local)} smaller ones in ZIP area {zip3}')
    with ThreadPoolExecutor(workers) as ex:
        filings = list(ex.map(lambda r: foundation_filing(r['EIN'], idx[r['EIN']][1]), rows))
    out = []
    for r, f in zip(rows, filings):
        if f:
            f['bmf_assets'] = _num(r.get('ASSET_AMT'))
            f['bmf_name'] = r['NAME']
            out.append(f)
    return out


def _norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower().replace('incorporated', '').replace(' inc', ''))


def cause_rx(causes, kind):
    frags = [f for c in causes for f in CAUSES[c].get(kind, [])]
    return re.compile(r'\b(?:' + '|'.join(frags) + ')', re.I) if frags else None


def grant_strength(g, strong, weak, excl):
    text = f"{g['purpose']} | {g['recipient']}"
    if excl and excl.search(text):
        return 0
    if strong.search(text):
        return 1.0
    return 0.5 if weak and weak.search(text) else 0


MATCHING = re.compile(r'matching gift|employee match|match(ed|ing)? (employee|donation|contribution)|dollars for doers|volunteer grant', re.I)


def match_foundations(foundations, state, causes, city=None, own_name=None, zip3=None):
    strong, weak, excl = cause_rx(causes, 'match'), cause_rx(causes, 'weak'), cause_rx(causes, 'exclude')
    own = _norm(own_name)
    res = []
    for f in foundations:
        if f['grants'] and sum(1 for g in f['grants'] if g['state'] == state and g['city'] == f['address']['city']) > 0.9 * len(f['grants']) > 5:
            continue  # every grant carries the filer's own city: recipient locations are not real
        hits = []
        for g in f['grants']:
            if g['state'] != state or g['amount'] <= 0 or MATCHING.search(g['purpose'] or ''):
                continue
            w = grant_strength(g, strong, weak, excl)
            if w:
                hits.append({**g, 'w': w, 'near': bool(zip3 and g.get('zip3') == zip3)})
        if not hits:
            continue
        instate = [g for g in f['grants'] if g['state'] == state]
        regions = {g.get('zip3') for g in instate if g.get('zip3')}
        hits.sort(key=lambda g: (-g['near'], -g['w'], -g['amount']))
        near = [g for g in hits if g['near']]
        funds_you = [g for g in f['grants'] if own and len(own) > 6 and _norm(g['recipient']).startswith(own[:24])]
        amounts = sorted(g['amount'] for g in hits)
        f_near = bool(zip3 and f['address']['zip'][:3] == zip3)
        cities = {}
        for g in instate:
            cities[g['city']] = cities.get(g['city'], 0) + 1
        top_cities = sorted(cities.items(), key=lambda kv: -kv[1])[:3]
        z2 = zip3[:2] if zip3 else None
        in_region = sum(1 for g in instate if z2 and (g.get('zip3') or '').startswith(z2))
        region_share = in_region / len(instate) if instate else 0
        concentrated_elsewhere = bool(z2) and not near and not f_near and region_share < 0.1
        score = (0.35 if concentrated_elsewhere else 1) * (sum(g['w'] for g in hits) + 3 * sum(g['w'] for g in near) + (3 if f_near else 0) + 4 * region_share
                 + (1.5 if len(regions) >= 6 else 0) + math.log10(1 + sum(amounts))) + (8 if funds_you else 0)
        res.append({**{k: f[k] for k in ('ein', 'name', 'address', 'phone', 'website', 'fmv_assets', 'total_grants', 'preselected_only', 'apply', 'tax_period_end', 'object_id')},
                    'n_grants': len(f['grants']), 'n_instate': len(instate), 'n_regions': len(regions), 'hits': hits, 'n_hits': len(hits),
                    'n_strong': sum(1 for g in hits if g['w'] == 1), 'hit_total': sum(amounts), 'median_hit': amounts[len(amounts) // 2],
                    'n_near': len(near), 'f_near': f_near, 'top_cities': top_cities, 'concentrated_elsewhere': concentrated_elsewhere, 'region_share': round(region_share, 2), 'funds_you': funds_you, 'score': round(score, 2)})
    # a foundation reached only through weak matches (e.g. one library grant) is not a best fit
    res = [r for r in res if r['n_strong'] or r['n_near'] or len(r['hits']) >= 3]
    res.sort(key=lambda r: (r['preselected_only'], -r['score']))
    return res


# ---------------------------------------------------------------- federal
GG = 'https://api.grants.gov/v1/api/'
# programs a typical small domestic 501(c)(3) cannot lead: overseas diplomacy, research consortia, tribal/territory set-asides
NOT_LOCAL = re.compile(r'embassy|consulate|public diplomacy|alumni|u\.s\. mission|clinical trial|native hawaiian|alaska native|tribal|tribes|'
                       r'american indian|pacific islands|insular|research|surveillance|consortium|coordinating center|innovation center|scholarships in science|'
                       r'nrsa|training program|indian health|cooperative ecosystem|technical assistance|telehealth|hubs?\b|evaluat|centers? of excellence|indemnity|state arts agencies|endowments for|data access|assessment program|supplement|'
                       r'regional treatment|\bR0[13]\b|\bU(24|G4|01|54)\b|fellowship|postdoc', re.I)
ELIGIBLE = {'12', '13', '25', '99'}  # 501(c)(3) nonprofits; other nonprofits; "others"; unrestricted


def federal_opportunities(causes, today=None, limit=15, log=print):
    today = today or date.today()
    rx = cause_rx(causes, 'fed_match') or cause_rx(causes, 'match')
    kws = sorted({k for c in causes for k in CAUSES[c]['federal']})
    ids = {}
    for kw in kws:
        d = fetch_json(GG + 'search2', data={'keyword': kw, 'rows': 100, 'oppStatuses': 'forecasted|posted',
                                              'eligibilities': '12|13|25|99'}, max_age_days=1) or {}
        for h in (d.get('data') or {}).get('oppHits', []):
            ids[h['id']] = h
    log(f'  grants.gov: {len(ids)} candidate opportunities from {len(kws)} keyword searches')
    with ThreadPoolExecutor(8) as ex:
        details = list(ex.map(lambda i: fetch_json(GG + 'fetchOpportunity', data={'opportunityId': int(i)}, max_age_days=1), ids))
    out = []
    for hit, d in zip(ids.values(), details):
        d = (d or {}).get('data') or {}
        syn = d.get('synopsis') or d.get('forecast') or {}
        types = {t.get('id') for t in syn.get('applicantTypes') or []}
        if types and not (types & ELIGIBLE):
            continue
        close = _gg_date(hit.get('closeDate'))
        if close and close < today:
            continue
        if NOT_LOCAL.search(hit['title']) or (hit.get('agencyCode') or '').startswith(('DOS', 'USAID', 'HHS-NIH', 'HHS-IHS', 'NSF', 'DOD')):
            continue
        text = f"{hit['title']} {_strip(syn.get('synopsisDesc') or syn.get('forecastDesc') or '')}"
        n_title = len(rx.findall(hit['title']))
        n_all = len(rx.findall(text))
        if n_all == 0:
            continue
        out.append({'id': hit['id'], 'number': hit['number'], 'title': hit['title'], 'agency': hit.get('agency'),
                    'status': hit.get('oppStatus'), 'open': hit.get('openDate'), 'close': hit.get('closeDate') or 'not stated',
                    'close_date': close, 'ceiling': _num(syn.get('awardCeiling')), 'floor': _num(syn.get('awardFloor')),
                    'total': _num(syn.get('estimatedFunding')), 'eligibility': [t.get('description') for t in syn.get('applicantTypes') or []],
                    'eligibility_note': _strip(syn.get('applicantEligibilityDesc') or '')[:300],
                    'summary': _strip(syn.get('synopsisDesc') or syn.get('forecastDesc') or '')[:420],
                    'contact': syn.get('agencyContactEmail') or '', 'cfda': ', '.join(hit.get('cfdaList') or []),
                    'url': f"https://www.grants.gov/search-results-detail/{hit['id']}",
                    'in_title': n_title > 0, 'score': 3 * n_title + min(n_all, 6)})
    out.sort(key=lambda o: (-o['score'], o['close_date'] or date(2100, 1, 1)))
    named = [o for o in out if o['in_title']]
    related = [o for o in out if not o['in_title'] and o['score'] >= 2][:3]
    return (named + related)[:limit], len(named)


def _gg_date(s):
    try:
        return datetime.strptime(s, '%m/%d/%Y').date()
    except (TypeError, ValueError):
        return None


def _strip(s):
    import html
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s))).strip()
