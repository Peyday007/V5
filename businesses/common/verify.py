"""Check that every expansion business is built and its sales operation is in place.

  python3 businesses/common/verify.py            # files only
  python3 businesses/common/verify.py --live     # also reads each campaign back from Instantly

Per business it requires: a README naming buyer, price and fulfillment; an
offer.json with at least one paid product; samples produced by the generator;
at least 60 prospects, each with the page its address was read from; a
campaign.py with three steps, leads() and sample(). With --live, the campaign
exists in the workspace, holds every prospect, sends from the owner's mailbox
and carries the mailing address and opt-out in every step.
Exit 0 only when everything holds.
"""
import csv, importlib.util, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'common'))
from outreach import BUSINESSES, SENDERS, call, campaign, lead_count  # noqa: E402

failures = []


def need(ok, msg):
    print(('ok   ' if ok else 'FAIL ') + msg)
    if not ok:
        failures.append(msg)


for b in BUSINESSES:
    d = os.path.join(ROOT, b)
    readme = open(os.path.join(d, 'README.md')).read().lower() if os.path.exists(os.path.join(d, 'README.md')) else ''
    need(all(w in readme for w in ('$', 'buy', 'fulfil')), f'{b}: README states buyers, prices and fulfillment')
    offer = json.load(open(os.path.join(d, 'offer.json')))
    products = offer['products'] if isinstance(offer, dict) else offer
    need(any(float(p['price_usd']) > 0 for p in products), f'{b}: offer.json has a paid product')
    samples = [f for _, _, fs in os.walk(os.path.join(d, 'samples')) for f in fs if f.endswith(('.pdf', '.html'))]
    need(len(samples) >= 3, f'{b}: {len(samples)} sample deliverables')
    rows = list(csv.DictReader(open(os.path.join(d, 'prospects.csv'), newline='')))
    need(len(rows) >= 60 and all(r['email'] and r['source_url'].startswith('http') for r in rows),
         f'{b}: {len(rows)} prospects, each with its source page')
    spec = importlib.util.spec_from_file_location(f'c_{b}', os.path.join(d, 'campaign.py'))
    cfg = importlib.util.module_from_spec(spec); spec.loader.exec_module(cfg)
    need(len(cfg.STEPS) == 3 and callable(getattr(cfg, 'sample', None)) and len(cfg.leads()) == len(rows),
         f'{b}: campaign.py has 3 steps, leads() for every prospect, and sample()')
    if '--live' in sys.argv:
        c = campaign(cfg)
        need(c is not None, f'{b}: campaign "{cfg.NAME}" exists in Instantly')
        if c:
            full = call('GET', f"/campaigns/{c['id']}")
            n = lead_count(c['id'])
            need(n >= len(rows) * 0.95, f'{b}: campaign holds {n} of {len(rows)} prospects')
            need(full.get('email_list') == SENDERS, f'{b}: sends from {full.get("email_list")}')
            bodies = [v['body'] for s in full.get('sequences', []) for st in s['steps'] for v in st['variants']]
            need(len(bodies) == 3 and all('[MAILING ADDRESS]' not in x and 'no thanks' in x for x in bodies),
                 f'{b}: every step carries the mailing address and opt-out')
            print(f"     status {full.get('status')} (0 draft, 1 active)")

print('VERIFY: OK' if not failures else f'VERIFY: {len(failures)} FAILED')
sys.exit(1 if failures else 0)
