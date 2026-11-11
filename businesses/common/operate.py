"""Operate the expansion businesses' inboxes: read replies, answer the ones that asked.

  python3 businesses/common/operate.py pending
      Every reply received on each business's campaign, with whether we have
      already answered it (a sent email later in the same thread). State is read
      from Instantly every time, never kept here.
  python3 businesses/common/operate.py sample <business> <lead-email>
      Builds the free sample for that lead (the business's campaign.sample())
      and writes it to businesses/<business>/out/, without sending.
  python3 businesses/common/operate.py fulfill <business> <reply-email-uuid>
      Builds the sample for the person who replied and sends it as a reply in
      the same thread, from the mailbox that received the reply. Refuses a
      thread we already answered, so a second run sends nothing.

A business's campaign.py provides sample(lead) -> (subject, html), where lead
is the Instantly lead (its custom variables hold the profile the prospect list
was built with).
"""
import html as htmllib, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from outreach import BUSINESSES, OWNER, PHONE, ROOT, call, campaign, load  # noqa: E402

AUTO = ('out of office', 'automatic reply', 'auto-reply', 'autoreply', 'away from', 'delivery status', 'undeliverable', 'mail delivery')


def thread_mail(thread_id):
    return call('GET', f'/emails?thread_id={thread_id}&limit=50').get('items', [])


def answered(reply):
    later = [m for m in thread_mail(reply['thread_id'])
             if m.get('ue_type') in (1, 3, 4) and m.get('timestamp_email', '') > reply.get('timestamp_email', '')
             and (m.get('from_address_email') or '').lower() != (reply.get('from_address_email') or '').lower()]
    return bool(later)


def received(business):
    c = campaign(load(business))
    if not c:
        return []
    return call('GET', f"/emails?campaign_id={c['id']}&email_type=received&limit=100").get('items', [])


def pending():
    out = []
    for b in BUSINESSES:
        for m in received(b):
            subj = (m.get('subject') or '').lower()
            auto = any(a in subj or a in (m.get('content_preview') or '').lower() for a in AUTO)
            row = {'business': b, 'id': m['id'], 'from': m.get('from_address_email'), 'at': m.get('timestamp_email'),
                   'auto': auto, 'answered': answered(m), 'preview': (m.get('content_preview') or '')[:240].replace('\n', ' ')}
            out.append(row)
            print(f"{b} | {row['at']} | {row['from']} | {'AUTO' if auto else ''}{' ANSWERED' if row['answered'] else ''} | {row['preview']}  [{m['id']}]")
    if not out:
        print('no replies yet')
    return out


def lead_for(business, email):
    c = campaign(load(business))
    items = call('POST', '/leads/list', {'campaign': c['id'], 'search': email, 'limit': 10}).get('items', [])
    hit = [l for l in items if (l.get('email') or '').lower() == email.lower()]
    if not hit:
        sys.exit(f'{email} is not a lead of {business}')
    return hit[0]


def build(business, email):
    cfg = load(business)
    if not hasattr(cfg, 'sample'):
        sys.exit(f'{business}/campaign.py has no sample(lead)')
    lead = lead_for(business, email)
    subject, body = cfg.sample(lead)
    out = os.path.join(ROOT, business, 'out')
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, f"{email.replace('@', '_at_')}.html")
    open(path, 'w').write(body)
    return subject, body, path


def sign(brand):
    return (f'<p>— {htmllib.escape(OWNER)} · {htmllib.escape(brand)} · {PHONE}</p>'
            '<p><i>Reply "no thanks" and I won\'t contact you again.</i></p>')


def fulfill(business, reply_id):
    reply = call('GET', f'/emails/{reply_id}')
    if answered(reply):
        sys.exit('already answered in this thread; nothing sent')
    subject, body, path = build(business, reply['from_address_email'])
    cfg = load(business)
    sent = call('POST', '/emails/reply', {
        'eaccount': reply['eaccount'], 'reply_to_uuid': reply_id,
        'subject': subject if subject.lower().startswith('re:') else f"Re: {reply.get('subject') or subject}",
        'body': {'html': body + sign(cfg.BRAND)},
    })
    print('sent', sent.get('id'), 'to', reply['from_address_email'], 'copy at', path)


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['pending']:
        pending()
    elif len(a) == 3 and a[0] == 'sample':
        print(build(a[1], a[2])[2])
    elif len(a) == 3 and a[0] == 'fulfill':
        fulfill(a[1], a[2])
    else:
        sys.exit(__doc__)
