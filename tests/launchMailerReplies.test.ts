import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, NEIGHBOR_CARD_CAMPAIGN, ORDER_FORM, orderForm, ownWords, runMailerReplies } from '../scripts/launch/mailerReplies.ts';
import type { StageContext } from '../scripts/launch/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const C = NEIGHBOR_CARD_CAMPAIGN;
const SIG = '<p>Sam Owner · The Neighbor Card · 555-0100<br />1 Main St, Town, ST 00000</p><p><i>Reply "no thanks" to opt out.</i></p>';

interface Mail { id: string; thread_id: string; ue_type: number; timestamp_email: string; campaign_id: string; subject: string; eaccount: string; body: { text: string }; is_auto_reply?: number }

/** An in-memory Instantly: the campaign, the unibox, and replies posted into threads. */
function fakeInstantly(mails: Mail[]) {
  const posted: Array<Record<string, unknown>> = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = url.pathname;
    if ((init?.headers as Record<string, string>)['Authorization'] !== 'Bearer k') return json(401, { message: 'bad key' });
    if (p === `/api/v2/campaigns/${C}`) {
      return json(200, { id: C, sequences: [{ steps: [{ variants: [{ body: `<p>Hi {{greeting}}, offer.</p>${SIG}` }] }] }] });
    }
    if (p === '/api/v2/emails' && (init?.method ?? 'GET') === 'GET') {
      const search = url.searchParams.get('search');
      if (search?.startsWith('thread:')) return json(200, { items: mails.filter((m) => m.thread_id === search.slice(7)) });
      return json(200, { items: mails.filter((m) => m.ue_type === 2 && m.campaign_id === url.searchParams.get('campaign_id')) });
    }
    if (p === '/api/v2/emails/reply' && init?.method === 'POST') {
      const b = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(b);
      const to = mails.find((m) => m.id === b['reply_to_uuid'])!;
      mails.push({ ...to, id: `sent-${posted.length}`, ue_type: 3, timestamp_email: '2026-11-12T00:00:00.000Z', body: { text: '' } });
      return json(200, { id: `sent-${posted.length}` });
    }
    return json(404, { message: `fake: no route ${p}` });
  }) as typeof fetch;
  return { posted, fetch: fetchImpl };
}

const mail = (id: string, thread: string, text: string, extra: Partial<Mail> = {}): Mail => ({
  id, thread_id: thread, ue_type: 2, timestamp_email: `2026-11-11T15:00:0${id.length % 10}.000Z`, campaign_id: C,
  subject: 'Re: A January postcard to 4,944 Camp Hill homes', eaccount: 'sender@example.com', body: { text }, ...extra,
});

const ctx = (fetchImpl: typeof fetch, env: Record<string, string> = { INSTANTLY_API_KEY: 'k' }, dryRun = false): StageContext =>
  ({ env, dryRun, fetch: fetchImpl, log: () => {}, root: ROOT });

describe('mailer replies stage', () => {
  it('classifies a reply by its own words, not the quoted offer', () => {
    const quoted = 'Card please\n\nOn Wed, Nov 11, 2026 at 9:00 AM Sam wrote:\n> Reply "no thanks" and I won\'t contact you again.';
    expect(ownWords(quoted)).toBe('Card please');
    expect(classify(quoted)).toBe('CARD');
    expect(classify('Yes, hold the dentist spot for us')).toBe('YES');
    expect(classify('Not interested, thanks')).toBe('OPT_OUT');
    expect(classify('No thanks')).toBe('OPT_OUT');
    expect(classify('No problem, what does it cost?')).toBe('CARD');
    expect(classify('I am out of the office until Monday')).toBe('AUTO');
    expect(classify('Who is this')).toBe('OTHER');
  });

  it('the embedded order form is the kit\'s, so the production machine sends the same form', () => {
    expect(ORDER_FORM).toBe(orderForm(ROOT));
    expect(orderForm('/nonexistent')).toBe(ORDER_FORM);
  });

  it('dry run checks the kit and calls nothing', async () => {
    const r = await runMailerReplies(ctx((() => { throw new Error('no network in a dry run'); }) as unknown as typeof fetch, {}, true));
    expect(r.status).toBe('DONE');
  });

  it('without a key it names the one owner action', async () => {
    const r = await runMailerReplies(ctx(fakeInstantly([]).fetch, {}));
    expect(r.status).toBe('NEEDS_OWNER');
    expect(r.ownerAction).toContain('INSTANTLY_API_KEY');
  });

  it('answers card and yes replies once, with the campaign signature, and leaves the rest', async () => {
    const mails = [
      mail('a', 't1', 'Sure, send the card'),
      mail('bb', 't2', 'Yes, hold it for us'),
      mail('ccc', 't3', 'No thanks'),
      mail('dddd', 't4', 'Out of office', { is_auto_reply: 1 }),
      mail('eeeee', 't5', 'Who is this'),
      mail('x', 'tx', 'card', { campaign_id: 'other-campaign' }),
    ];
    const fake = fakeInstantly(mails);
    const first = await runMailerReplies(ctx(fake.fetch));
    expect(first.status, first.detail).toBe('DONE');
    expect(fake.posted.map((p) => p['reply_to_uuid'])).toEqual(['a', 'bb']);
    const [card, yes] = fake.posted as Array<{ subject: string; body: { html: string; text: string } }>;
    expect(card!.body.html).toContain('raw.githubusercontent.com/Peyday007/V5/production/fast-cash/launch-2026-11-11/mailer/mockup/card-mockup-2-sides.pdf');
    expect(card!.body.html).toContain(SIG);
    expect(card!.subject).toBe('Re: A January postcard to 4,944 Camp Hill homes');
    expect(yes!.body.text).toContain('SPACE (pick one)');
    expect(first.detail).toContain('1 for a person');

    const second = await runMailerReplies(ctx(fake.fetch));
    expect(fake.posted).toHaveLength(2); // the threads now hold our answers
    expect(second.detail).toContain('0 answered now, 2 answered before');
  });
});
