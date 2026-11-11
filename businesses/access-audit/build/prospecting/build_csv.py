"""Select qualified prospects from out/scanned.jsonl, re-verify each email
independently, and write prospects.csv.

Qualified = homepage scanned (never inferred), >= 3 critical/serious WCAG
instances found by axe-core itself (the focus heuristic does not count), a non-empty teaser of exact counts, an email published on the
business's own site, and not a chain, franchise, large firm or public body.

    python3 build/prospecting/build_csv.py out/scanned.jsonl prospects.csv
"""
import csv, json, os, re, ssl, sys, urllib.request, concurrent.futures as cf

CTX = ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt') if os.path.exists('/root/.ccr/ca-bundle.crt') else ssl.create_default_context()
# Public bodies, chains and firms that are not small businesses (reviewed by hand against the scanned list).
EXCLUDE = re.compile(r'\bcounty\b|\bcity of\b|authority|\babc\b board|state of|university|college|school district|hospital|health system|'
                     r'four seasons|taft\b|bradley arant|stinson|fredrikson|faegre|ballard spahr|dorsey|lathrop|perkins coie|k&l gates|'
                     r'davis wright|lane powell|foster garvey|womble|nelson mullins|smith anderson|parker poe|maynard|baker donelson|'
                     r'burr & forman|jackson lewis|ogletree|littler|fisher phillips|holland & knight|greenberg|dentons|'
                     r'nordstrom|macy|rei\b|dick.s sporting|ace hardware|true value|sherwin|benjamin moore|verizon|t-mobile|at&t|'
                     r'cinnabon|dunkin|domino|pizza hut|papa john|jimmy john|jersey mike|firehouse subs|qdoba|chipotle|culver|'
                     r'hotel indigo|embassy suites|homewood|doubletree|springhill|towneplace|staybridge|candlewood|graduate hotel|'
                     r'kimpton|ac hotel|aloft|element|moxy|tru by|home2|canopy|curio|tapestry|autograph|21c|hy-vee|costco', re.I)
EXTRA_EXCLUDE_DOMAINS = re.compile(r'\.gov$|\.edu$|\.mil$|\.us$', re.I)


# The directory category is a hint; the business's own name and page title decide (first match wins).
INDUSTRY_RULES = [
    ('pet-services', r'dog boarding|kennel|grooming|pet '), ('veterinary', r'veterinar|animal (clinic|hospital)|vet imaging'),
    ('dental', r'dental|dentist|orthodont|smile ?doc'), ('legal', r'\blaw\b|attorney|legal|immigration|lawyer|mediat'),
    ('lodging', r'\binn\b|hotel|lodge|b&b|bed and breakfast|manor|suites|motel'),
    ('restaurant', r'restaurant|pizza|cafe|café|bakery|bread|rotisserie|brew|grill|kitchen|bistro|catering|sausage|farm'),
    ('salon-spa', r'salon|\bspa\b|massage|float|skincare|barber|nail'),
    ('home-care', r'home care|senior|nursing|attendant'),
    ('health', r'chiropract|physical therap|physiotherap|therapy|clinic|nutrition|counsel|recovery|health|medical|optometr'),
]


def infer_industry(r):
    hay = f"{r['name']} {r.get('title') or ''}".lower()
    for label, rx in INDUSTRY_RULES:
        if re.search(rx, hay):
            return label
    return r['industry']


def load_review():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'review.json')
    return json.load(open(path)) if os.path.exists(path) else {'exclude': {}, 'fix': {}}


def clean_name(n):
    n = re.sub(r'\s+', ' ', n).strip()
    m = re.match(r'^(.*), (The|A)$', n)
    if m:
        n = f'{m.group(2)} {m.group(1)}'
    # legal suffixes read badly in a greeting ("Hello Visawolf, PC team")
    n = re.sub(r',?\s+(LLC|L\.L\.C\.|PLLC|PC|P\.C\.|P\.S\.|PS|LLP|Inc\.?|Co\.,? Inc\.?|Corp\.?|Ltd\.?|PA|P\.A\.)$', '', n, flags=re.I).strip()
    return n


CUSTOM = {'focus-not-visible', 'no-skip-link', 'keyboard-trap', 'reflow-horizontal-scroll'}
TITLES = {'image-alt': 'Images without alt text', 'link-name': 'Links with no readable name', 'button-name': 'Buttons with no readable name',
          'label': 'Form fields without labels', 'select-name': 'Drop-downs without labels', 'color-contrast': 'Text below minimum contrast',
          'aria-hidden-focus': 'Focusable content hidden from screen readers', 'html-has-lang': 'No page language',
          'meta-viewport': 'Pinch-zoom disabled', 'frame-title': 'Embedded frames without titles', 'list': 'Malformed lists',
          'listitem': 'List items outside a list', 'aria-required-children': 'ARIA widgets missing required children',
          'nested-interactive': 'Controls nested inside controls', 'role-img-alt': 'Image elements without names',
          'svg-img-alt': 'SVG images without names', 'aria-prohibited-attr': 'Unsupported ARIA labels', 'target-size': 'Tap targets too small',
          'aria-valid-attr-value': 'Invalid ARIA references', 'aria-allowed-attr': 'Disallowed ARIA attributes', 'link-in-text-block': 'Links shown by colour only',
          'scrollable-region-focusable': 'Scroll areas unreachable by keyboard', 'duplicate-id-aria': 'Duplicate ids used by labels',
          'input-image-alt': 'Image buttons without alt text', 'aria-command-name': 'Custom buttons without names', 'document-title': 'No page title'}
ORDER = ['critical', 'serious', 'moderate', 'minor']


def axe_stats(rules):
    wc = [r for r in rules if r[0] not in CUSTOM and not r[3]]
    total = sum(r[2] for r in wc)
    cs = sum(r[2] for r in wc if r[1] in ('critical', 'serious'))
    wc.sort(key=lambda r: (ORDER.index(r[1]) if r[1] in ORDER else 9, -r[2]))
    top = f'{TITLES.get(wc[0][0], wc[0][0])} ({wc[0][2]}x, {wc[0][1]})' if wc else ''
    return total, cs, top


def teaser(rules):
    n = lambda ids: sum(r[2] for r in rules if r[0] in ids)
    pl = lambda k, one, many: f'{k} {one if k == 1 else many}'
    parts = [(n({'image-alt', 'role-img-alt', 'svg-img-alt', 'input-image-alt'}), lambda k: pl(k, 'image', 'images') + ' without alt text'),
             (n({'label', 'select-name', 'aria-input-field-name', 'label-title-only'}), lambda k: pl(k, 'form field', 'form fields') + ' without a label'),
             (n({'link-name'}), lambda k: pl(k, 'link', 'links') + ' with no readable name'),
             (n({'button-name', 'aria-command-name'}), lambda k: pl(k, 'button', 'buttons') + ' with no readable name'),
             (n({'color-contrast'}), lambda k: pl(k, 'text element', 'text elements') + ' below the minimum contrast ratio'),
             (n({'meta-viewport'}), lambda k: 'pinch-zoom disabled on phones'),
             (n({'html-has-lang'}), lambda k: 'no page language declared')]
    chosen = [f(k) for k, f in parts if k > 0][:3]
    if not chosen:
        return ''
    return 'your homepage has ' + (chosen[0] if len(chosen) == 1 else ', '.join(chosen[:-1]) + ' and ' + chosen[-1])


def raw_contains(url, email):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; TabstopProspectResearch/1.0)'})
        with urllib.request.urlopen(req, timeout=25, context=CTX) as r:
            body = r.read().decode('utf-8', 'replace').lower()
        return email.lower() in body or email.lower().replace('@', '&#64;') in body
    except Exception:
        return False


def main(src, dst):
    rows = [json.loads(l) for l in open(src) if l.strip()]
    review = load_review()
    q = []
    for r in rows:
        if r.get('status') != 'ok' or not r.get('email_same_site') or EXCLUDE.search(r['name']):
            continue
        if r['name'] in review['exclude']:
            continue
        r = {**r, 'industry': infer_industry(r), **review['fix'].get(r['name'], {})}
        dom = (r.get('final_url') or r['website']).split('/')[2].lower()
        if EXTRA_EXCLUDE_DOMAINS.search(dom) or dom.endswith('.org') or 'chamber' in dom:  # public bodies, non-profits and directory pages are not the buyer
            continue
        r['axe_total'], r['axe_cs'], r['axe_top'] = axe_stats(r['rules'])
        r['axe_teaser'] = teaser(r['rules'])
        if r['axe_cs'] >= 3 and r['axe_teaser']:
            q.append(r)
    # one row per email and per site
    seen, uniq = set(), []
    for r in q:
        k = r['email']
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)
    with cf.ThreadPoolExecutor(8) as ex:
        raw = list(ex.map(lambda r: raw_contains(r['source_url'], r['email']), uniq))
    out = []
    for i, (r, ok_raw) in enumerate(zip(uniq, raw), 1):
        name = clean_name(r['name'])
        out.append({
            'id': f'aa-{i:03d}', 'name': name, 'email': r['email'], 'website': r.get('final_url') or r['website'],
            'source_url': r['source_url'], 'city': r['city'], 'state': r['state'], 'industry': r['industry'],
            'greeting': 'Hello' if re.search(r'attorney at law|\bd\.?d\.?s\b|\bd\.?m\.?d\b', name, re.I) else f'Hello {name} team', 'issues_total': r['axe_total'], 'critical_serious': r['axe_cs'],
            'top_issue': r['axe_top'], 'teaser': r['axe_teaser'],
            'email_verified_by': 'raw HTML of source_url' if ok_raw else 'rendered page of source_url (JavaScript-inserted)',
            'scanned_at': r['scanned_at'], 'directory_url': r['directory_url'],
        })
    with open(dst, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        w.writeheader()
        w.writerows(out)
    from collections import Counter
    print(f'{len(out)} prospects -> {dst}', file=sys.stderr)
    print('industry', dict(Counter(r['industry'] for r in out)), file=sys.stderr)
    print('state', dict(Counter(r['state'] for r in out)), file=sys.stderr)
    print('role address', sum(1 for r in uniq if r.get('email_role')), 'raw-verified', sum(raw), file=sys.stderr)


if __name__ == '__main__':
    main(*sys.argv[1:3])
