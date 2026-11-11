"""Prepare (and, only on the owner's word, start) The Neighbor Card outreach in Instantly.

  python3 build/instantly_campaign.py prepare
      Creates the campaign as a DRAFT in the owner's Instantly workspace (or
      finds it by name), writes the 3-step sequence, and adds every prospect
      with a published email. Mails nobody. Safe to re-run.

  python3 build/instantly_campaign.py activate --address "123 Main St, Camp Hill, PA 17011"
      Writes the owner's physical mailing address into every step (CAN-SPAM
      requires it), then activates. Refuses without an address.

The API key is never read here: the session's network proxy adds it to every
request to api.instantly.ai.
"""
import csv, json, sys, ssl, urllib.request, urllib.error

HERE = __file__.rsplit('/', 2)[0]
API = 'https://api.instantly.ai/api/v2'
NAME = 'Neighbor Card · Camp Hill Jan 2027'
ADDRESS_SLOT = '[MAILING ADDRESS]'
OWNER = 'Peyton Rosser'
PHONE = '313-671-6425'
# The one sending account whose From name is the owner's own. The others carry
# other people's names, and an honest From line is a CAN-SPAM requirement.
SENDERS = ['info@cleanflowco.com']
# Published addresses that belong to a web vendor, an agency or a franchise head
# office rather than the local business.
NOT_THE_BUSINESS = {'P038', 'P087', 'P088', 'P101'}

PAYBACK = {
    'Auto repair': 'one winter service and tire job', 'Barber': 'a handful of new regulars',
    'Brewery': 'one busy January event night', 'Car wash': 'a few road-salt wash plans',
    'Chiropractor': 'one new patient', 'Coffee': 'a few new regulars',
    'Dental specialist': 'one new patient', 'Dentist': 'one new patient',
    'Eye care': 'two new eye-exam patients', 'Fitness studio': 'a couple of new members',
    'Gym': 'a couple of new members', 'HVAC': 'one furnace repair call',
    'Landscaping': 'one spring design job', 'Martial arts': 'one new student',
    'Med spa': 'one new client', 'Orthodontist': 'one new case',
    'Personal training': 'one new client', 'Physical therapy': 'one new patient',
    'Plumbing': 'one water-heater or frozen-pipe call', 'Real estate': 'one listing appointment',
    'Restaurant': 'a few new regular tables', 'Salon/waxing': 'a handful of new clients',
    'Senior home care': 'one new family', 'Spa': 'a few new clients',
}

SIGN = f'<p>{OWNER} · The Neighbor Card · {PHONE}<br>{ADDRESS_SLOT}</p>'
OPT_OUT = '<p><i>This is an advertising offer. Reply "no thanks" and I won\'t contact you again.</i></p>'

STEP1 = f"""<p>Hi {{{{greeting}}}},</p>
<p>I'm putting together <b>The Neighbor Card</b>, a big 9×12 postcard of local offers that USPS delivers to <b>4,944 homes in Camp Hill &amp; East Hampden</b> on <b>January 4</b>. That's the week people {{{{january_angle}}}}.</p>
<p><b>Where the homes are</b> (11 whole USPS carrier routes in 17011, homes only):</p>
<ul><li>Camp Hill borough: 2,804 homes (57%)</li><li>Hampden Twp: 1,565 (32%)</li><li>East Pennsboro Twp: 431 (9%)</li><li>Lemoyne: 140 (3%)</li></ul>
<ul><li><b>One {{{{category_lc}}}} per card.</b> The spot is yours if you take it first.</li>
<li><b>$295 for a standard spot</b> (about 6¢ a home), and I design the ad for free.</li>
<li><b>No risk to you.</b> It prints only if 10 of the 22 ad cells are paid by Dec 9. Otherwise you get a full refund by Dec 11.</li></ul>
<p>Reply "card" and I'll send you the front and back of the actual card, the route map and the one-page rate card. Or should I just hold the {{{{category_lc}}}} spot for you?</p>
{SIGN}{OPT_OUT}"""

STEP2 = f"""<p>Hi {{{{greeting}}}}, a quick follow-up with the one number most people ask about:</p>
<p>At $295, {{{{payback}}}} pays for the spot. The card goes to 4,944 homes with a USPS-counted median household income of about $109k.</p>
<p>The {{{{category_lc}}}} spot is still open. Should I send the 2-minute order form?</p>
{SIGN}<p><i>Reply "no thanks" to opt out.</i></p>"""

STEP3 = f"""<p>Hi {{{{greeting}}}}, last note from me on this. I'm filling the January card's remaining categories this week. If it isn't for you this time, no problem, and I'll leave you alone.</p>
<p>If you'd like the {{{{category_lc}}}} spot, reply "yes" and I'll send the order form and a secure payment link. You're still covered by the full refund if the card doesn't fill by Dec 9.</p>
{SIGN}<p><i>Reply "no thanks" to opt out.</i></p>"""

ANGLE = {  # how the January hook reads after "That's the week people …"
    'Auto repair': 'deal with winter car trouble', 'Barber': 'start the year with a fresh cut',
    'Brewery': 'look for something to do in January', 'Car wash': 'want the road salt off',
    'Chiropractor': 'book the appointments they put off', 'Coffee': 'pick new routines',
    'Dental specialist': 'use their reset dental benefits', 'Dentist': 'use their reset dental benefits',
    'Eye care': 'use their reset vision benefits', 'Fitness studio': 'join a gym',
    'Gym': 'join a gym', 'HVAC': 'call about the furnace', 'Landscaping': 'plan spring projects',
    'Martial arts': "sign the kids up for winter activities", 'Med spa': 'book something for themselves',
    'Orthodontist': 'start treatment with new benefits', 'Personal training': 'commit to getting fit',
    'Physical therapy': 'book the appointments they put off', 'Plumbing': 'deal with frozen pipes and water heaters',
    'Real estate': 'start planning a spring move', 'Restaurant': 'look for a night out after the holidays',
    'Salon/waxing': 'book something for themselves', 'Senior home care': 'plan care for a parent after the holidays',
    'Spa': 'redeem gift cards and book self-care',
}

CTX = ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt')


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Authorization': 'Bearer proxy-injected', 'Content-Type': 'application/json', 'User-Agent': 'neighbor-card-outreach/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit(f'{method} {path}: HTTP {e.code} {e.read()[:400]!r}')


def leads():
    pros = {r['id']: r for r in csv.DictReader(open(f'{HERE}/prospects.csv'))}
    out = []
    for r in csv.DictReader(open(f'{HERE}/prospect-emails.csv')):
        if not r['email'] or r['id'] in NOT_THE_BUSINESS:
            continue
        p = pros[r['id']]
        local = r['email'].split('@')[0]
        first = local.capitalize() if local.isalpha() and local in {'liam', 'megan', 'tim'} else ''
        out.append({
            'email': r['email'], 'first_name': first or None, 'company_name': p['name'],
            'website': p['website_or_email'] or None, 'phone': p['phone'] or None,
            'custom_variables': {
                'greeting': first or 'there', 'category_lc': p['category'].lower().replace('salon/waxing', 'salon'),
                'payback': PAYBACK[p['category']], 'january_angle': ANGLE[p['category']],
                'prospect_id': r['id'], 'source_url': r['found_on'],
            },
        })
    return out


def campaign():
    found = [c for c in call('GET', '/campaigns?limit=100&search=' + urllib.request.quote(NAME)).get('items', []) if c['name'] == NAME]
    return found[0] if found else None


def definition(address=ADDRESS_SLOT):
    steps = [(STEP1, 'A January postcard to 4,944 Camp Hill homes, one {{category_lc}} spot', 3),
             (STEP2, 'Re: A January postcard to 4,944 Camp Hill homes', 5),
             (STEP3, 'Closing the {{category_lc}} spot on the Camp Hill card', 0)]
    return {
        'name': NAME,
        'campaign_schedule': {'schedules': [{'name': 'Weekdays ET', 'timing': {'from': '09:00', 'to': '16:00'},
                                             'days': {str(d): True for d in range(1, 6)}, 'timezone': 'America/Detroit'}]},
        'sequences': [{'steps': [{'type': 'email', 'delay': d, 'variants': [{'subject': s, 'body': b.replace(ADDRESS_SLOT, address)}]} for b, s, d in steps]}],
        'email_list': SENDERS, 'daily_limit': 15, 'stop_on_reply': True, 'stop_on_auto_reply': False,
        'link_tracking': False, 'open_tracking': False,
    }


def prepare():
    c = campaign()
    if c is None:
        c = call('POST', '/campaigns', definition())
        print('created draft campaign', c['id'])
    elif c.get('status') not in (0, None):
        sys.exit(f"campaign {c['id']} is already status {c['status']}; prepare only edits a draft")
    else:
        d = definition(); d.pop('name')
        call('PATCH', f"/campaigns/{c['id']}", d)
        print('updated draft campaign', c['id'])
    for lead in leads():
        call('POST', '/leads', {**lead, 'campaign': c['id'], 'skip_if_in_workspace': True, 'skip_if_in_campaign': True})
    held = call('POST', '/leads/list', {'campaign': c['id'], 'limit': 100}).get('items', [])
    print(f'campaign holds {len(held)} leads ({len({x["email"] for x in held})} distinct)')
    print("status", call("GET", f"/campaigns/{c['id']}").get("status"), "(0 = draft, mails nobody)")


def activate(address):
    if not address or ADDRESS_SLOT in address or len(address) < 10:
        sys.exit('activate needs the owner\'s physical mailing address (a PO box is fine)')
    c = campaign() or sys.exit('no campaign; run prepare first')
    d = definition(address); d.pop('name')
    call('PATCH', f"/campaigns/{c['id']}", d)
    call('POST', f"/campaigns/{c['id']}/activate", {})
    print('activated', c['id'], call('GET', f"/campaigns/{c['id']}").get('status'))


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'prepare':
        prepare()
    elif cmd == 'activate' and '--address' in sys.argv:
        activate(sys.argv[sys.argv.index('--address') + 1])
    else:
        sys.exit(__doc__)
