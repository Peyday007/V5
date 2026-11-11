"""Outreach for the expansion businesses, through the owner's Instantly workspace (§94).

  python3 businesses/common/outreach.py <business> prepare
      Creates (or updates) the business's campaign as a DRAFT and adds every lead
      from its prospects file. Mails nobody. Safe to re-run.
  python3 businesses/common/outreach.py <business> activate
      Writes the owner's physical mailing address (env BUSINESS_MAILING_ADDRESS;
      CAN-SPAM requires it in every message) into every step, then starts it.
  python3 businesses/common/outreach.py <business> status
  python3 businesses/common/outreach.py <business> replies
      Received mail on the campaign (the unibox), newest first.
  python3 businesses/common/outreach.py report
      Every business: leads, sent, opens, replies, bounces -> businesses/STATUS.md

<business> is a folder under businesses/ holding campaign.py, which defines
NAME, STEPS [(subject, html_body, delay_days)], DAILY_LIMIT and leads().

Rules kept here, not by each business:
  * one honest sender: the mailbox whose From name is the owner's own;
  * every step ends with the owner's name, the business, the phone, the mailing
    address and a plain-language opt-out;
  * skip_if_in_workspace, so a buyer another campaign already holds is never
    mailed twice; stop on reply; no open or link tracking.
The API key is never read here: the session's network proxy adds it.
"""
import importlib.util, json, os, ssl, sys, urllib.error, urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = 'https://api.instantly.ai/api/v2'
OWNER = 'Peyton Rosser'
PHONE = '313-671-6425'
SENDERS = ['info@cleanflowco.com']  # the one mailbox whose From name is the owner's
ADDRESS_SLOT = '[MAILING ADDRESS]'
CTX = ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt') if os.path.exists('/root/.ccr/ca-bundle.crt') else ssl.create_default_context()
BUSINESSES = ['grant-prospects', 'bid-digest', 'access-audit']


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Authorization': 'Bearer proxy-injected', 'Content-Type': 'application/json',
                                          'User-Agent': 'brain-expansion-outreach/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=40, context=CTX) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit(f'{method} {path}: HTTP {e.code} {e.read()[:400]!r}')


def load(business):
    path = os.path.join(ROOT, business, 'campaign.py')
    spec = importlib.util.spec_from_file_location(f'campaign_{business.replace("-", "_")}', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def footer(brand, address):
    return (f'<p>{OWNER} · {brand} · {PHONE}<br>{address}</p>'
            '<p><i>Reply "no thanks" and I won\'t contact you again.</i></p>')


def definition(cfg, address=ADDRESS_SLOT):
    return {
        'name': cfg.NAME,
        'campaign_schedule': {'schedules': [{'name': 'Weekdays ET', 'timing': {'from': '09:00', 'to': '16:00'},
                                             'days': {str(d): True for d in range(1, 6)}, 'timezone': 'America/Detroit'}]},
        'sequences': [{'steps': [{'type': 'email', 'delay': delay,
                                  'variants': [{'subject': subj, 'body': body + footer(cfg.BRAND, address)}]}
                                 for subj, body, delay in cfg.STEPS]}],
        'email_list': SENDERS, 'daily_limit': cfg.DAILY_LIMIT, 'stop_on_reply': True, 'stop_on_auto_reply': False,
        'link_tracking': False, 'open_tracking': False,
    }


def campaign(cfg):
    items = call('GET', '/campaigns?limit=100&search=' + urllib.request.quote(cfg.NAME)).get('items', [])
    found = [c for c in items if c['name'] == cfg.NAME]
    return found[0] if found else None


def check_leads(leads):
    bad = [l for l in leads if not l.get('email') or '@' not in l['email'] or not l.get('custom_variables', {}).get('source_url')]
    if bad:
        sys.exit(f'{len(bad)} leads lack an email or the source_url that shows the address is published: {bad[:2]}')
    return leads


def prepare(business):
    cfg = load(business)
    leads = check_leads(cfg.leads())
    c = campaign(cfg)
    if c is None:
        c = call('POST', '/campaigns', definition(cfg))
        print('created draft campaign', c['id'])
    elif c.get('status') not in (0, None):
        d = definition(cfg, os.environ.get('BUSINESS_MAILING_ADDRESS') or ADDRESS_SLOT)
        if ADDRESS_SLOT in json.dumps(d):
            sys.exit('campaign is running; re-run with BUSINESS_MAILING_ADDRESS so the copy keeps its address')
        d.pop('name')
        call('PATCH', f"/campaigns/{c['id']}", d)
        print('updated running campaign', c['id'])
    else:
        # A draft carries the finished copy (the address too, when given), so starting it is one click.
        d = definition(cfg, os.environ.get('BUSINESS_MAILING_ADDRESS') or ADDRESS_SLOT); d.pop('name')
        call('PATCH', f"/campaigns/{c['id']}", d)
        print('updated draft campaign', c['id'])
    added = 0
    for lead in leads:
        r = call('POST', '/leads', {**lead, 'campaign': c['id'], 'skip_if_in_workspace': True, 'skip_if_in_campaign': True})
        added += 1 if r.get('id') else 0
    held = call('POST', '/leads/list', {'campaign': c['id'], 'limit': 100}).get('items', [])
    print(f'{business}: {len(leads)} prepared, {added} accepted, campaign shows {len(held)}+ leads, status {call("GET", "/campaigns/" + c["id"]).get("status")}')


def activate(business):
    address = os.environ.get('BUSINESS_MAILING_ADDRESS', '')
    if len(address) < 10:
        sys.exit('activate needs BUSINESS_MAILING_ADDRESS, the owner\'s physical mailing address')
    cfg = load(business)
    c = campaign(cfg) or sys.exit('no campaign; run prepare first')
    d = definition(cfg, address); d.pop('name')
    call('PATCH', f"/campaigns/{c['id']}", d)
    call('POST', f"/campaigns/{c['id']}/activate", {})
    print('activated', business, c['id'], 'status', call('GET', f"/campaigns/{c['id']}").get('status'))


def lead_count(cid):
    # Instantly's analytics lead counter lags; the lead list is the record.
    n, cur = 0, None
    while True:
        body = {'campaign': cid, 'limit': 100, **({'starting_after': cur} if cur else {})}
        r = call('POST', '/leads/list', body)
        n += len(r.get('items', []))
        cur = r.get('next_starting_after')
        if not cur or not r.get('items'):
            return n


def analytics(cid):
    rows = call('GET', f'/campaigns/analytics?id={cid}')
    return rows[0] if isinstance(rows, list) and rows else {}


def replies(business, show=True):
    cfg = load(business)
    c = campaign(cfg)
    if not c:
        return []
    mail = call('GET', f"/emails?campaign_id={c['id']}&email_type=received&limit=50").get('items', [])
    if show:
        for m in mail:
            print(m.get('timestamp_email'), m.get('from_address_email'), '|', m.get('subject'), '|',
                  (m.get('content_preview') or '')[:160].replace('\n', ' '))
    return mail


def status(business):
    cfg = load(business)
    c = campaign(cfg)
    if not c:
        return {'business': business, 'name': cfg.NAME, 'status': 'no campaign'}
    a = analytics(c['id'])
    return {'business': business, 'name': cfg.NAME, 'id': c['id'], 'status': {0: 'draft', 1: 'active', 2: 'paused', 3: 'completed'}.get(c.get('status'), c.get('status')),
            'leads': lead_count(c['id']), 'contacted': a.get('contacted_count', 0), 'sent': a.get('emails_sent_count', 0),
            'replies': a.get('reply_count_unique', 0), 'auto_replies': a.get('reply_count_automatic_unique', 0),
            'bounced': a.get('bounced_count', 0), 'unsubscribed': a.get('unsubscribed_count', 0),
            'opportunities': a.get('total_opportunities', 0)}


def report():
    rows = [status(b) for b in BUSINESSES]
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ')
    lines = [f'# Expansion businesses — outreach status ({now})', '',
             'Read from the Instantly API by `python3 businesses/common/outreach.py report`. Do not edit by hand.', '',
             '| business | campaign | status | leads | contacted | sent | replies | auto | bounced | unsub |',
             '|---|---|---|---|---|---|---|---|---|---|']
    for r in rows:
        lines.append(f"| {r['business']} | {r['name']} | {r['status']} | {r.get('leads', 0)} | {r.get('contacted', 0)} | {r.get('sent', 0)} | "
                     f"{r.get('replies', 0)} | {r.get('auto_replies', 0)} | {r.get('bounced', 0)} | {r.get('unsubscribed', 0)} |")
    path = os.path.join(ROOT, 'STATUS.md')
    old = open(path).read().split('\n')[1:] if os.path.exists(path) else None
    if old != (('\n'.join(lines) + '\n').split('\n')[1:]):  # rewrite only when a figure changed, not the clock
        open(path, 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    return rows


if __name__ == '__main__':
    args = sys.argv[1:]
    if args[:1] == ['report']:
        report()
    elif len(args) == 2 and args[0] in BUSINESSES and args[1] in ('prepare', 'activate', 'status', 'replies'):
        r = {'prepare': prepare, 'activate': activate, 'status': lambda b: print(json.dumps(status(b), indent=1)), 'replies': replies}[args[1]](args[0])
    else:
        sys.exit(__doc__)
