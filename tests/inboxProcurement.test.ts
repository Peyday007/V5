/**
 * Inbox procurement (§110): only money the owner put in is spent, every order
 * is priced by its provider first, one domain is one purchase that is never
 * attempted twice, and an unknown answer is counted as spent and not retried.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { buyInboxes, fundInboxes, inboxBudget, inboxesUnsettled, mailboxesFor, syncInboxes } from '../server/services/inboxes/procure.ts';
import { instantlyQuoteOf } from '../server/services/inboxes/providers.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ENV = { INSTANTLY_API_KEY: 'k'.repeat(40) };
const KIT_ENV = {
  ...ENV,
  INBOXKIT_API_KEY: 'i'.repeat(40),
  INBOXKIT_WORKSPACE_ID: 'ws-1',
  INBOXKIT_CONTACT_JSON: JSON.stringify({ first_name: 'Caleb', last_name: 'Baker', email: 'c@example.com', phone: '1', address_line1: 'a', city: 'c', state: 's', country: 'US', postal_code: '1' }),
};
const PERSONA = { firstName: 'Caleb', lastName: 'Baker', seedDomain: 'windycityoutreach.com' };

/** Instantly's real simulation answer for one pre-warmed domain (2026-11-14), and the placed answer. */
const PREWARMED_QUOTE = {
  order_placed: false, order_is_valid: true, simulation: true, number_of_domains_ordered: 1, number_of_accounts_ordered: 5,
  price_per_account_per_month: 10, price_per_domain_per_year: 15, total_domains_price_per_year: 15,
  total_accounts_price_per_month: 50, total_price_per_month: 50, total_price: 65, total_discount: 0,
};

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function instantlyWorld(options: { prewarmed?: string[]; order?: (domain: string) => Response | Promise<Response>; ordered?: string[]; accounts?: string[] } = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method: String(init.method), body });
    if (url.endsWith('/domains/pre-warmed-up-list')) return json({ domains: options.prewarmed ?? ['one.com', 'two.com', 'three.com'] });
    if (url.endsWith('/domains/similar')) return json({ domains: ['windycityoutreach.org', 'getwindycity.com'] });
    if (url.includes('/dfy-email-account-orders?')) return json({ items: (options.ordered ?? []).map((domain) => ({ domain })), next_starting_after: '' });
    if (url.endsWith('/dfy-email-account-orders') && body) {
      const domain = String(((body.items as Record<string, unknown>[])[0] ?? {}).domain);
      if (body.simulation === true) return json(PREWARMED_QUOTE);
      return options.order ? options.order(domain) : json({ ...PREWARMED_QUOTE, simulation: false, order_placed: true });
    }
    if (url.includes('/accounts?')) {
      const search = new URL(url).searchParams.get('search') ?? '';
      return json({ items: (options.accounts ?? []).filter((one) => one.endsWith(search)).map((email) => ({ email, first_name: 'Caleb', last_name: 'Baker', warmup_status: 0 })), next_starting_after: '' });
    }
    if (url.endsWith('/accounts/warmup/enable')) return json({ id: 'job-1' });
    return json({ error: 'unexpected' }, 404);
  };
  return { calls, fetch, orders: () => calls.filter((c) => c.url.endsWith('/dfy-email-account-orders') && c.body?.simulation === false) };
}

beforeEach(async () => {
  await freshProject();
});
afterAll(async () => {
  await teardown();
});

describe('inbox procurement', () => {
  it('reads Instantly’s quote as what is charged now and the monthly total with the domain renewal spread', () => {
    const quote = instantlyQuoteOf(PREWARMED_QUOTE);
    expect(quote).toMatchObject({ valid: true, upfrontCents: 6500, monthlyCents: 5125 });
    expect(instantlyQuoteOf({ ...PREWARMED_QUOTE, order_is_valid: false, unavailable_domains: ['one.com'] }).problem).toMatch(/unavailable_domains/);
  });

  it('builds five distinct ordinary addresses for one sender', () => {
    expect(mailboxesFor(PERSONA, 5).map((m) => m.prefix)).toEqual(['caleb', 'caleb.baker', 'calebb', 'c.baker', 'calebbaker']);
    expect(mailboxesFor(PERSONA, 2)).toHaveLength(2);
  });

  it('buys nothing before the owner has put money in', async () => {
    const w = instantlyWorld();
    const result = await buyInboxes({ kind: 'PREWARMED', mailboxes: 5, dryRun: false, actor: 'owner', persona: PERSONA, fetch: w.fetch, env: ENV });
    expect(result.stopped).toMatch(/No money has been put in/);
    expect(w.calls).toHaveLength(0);
  });

  it('a quote prices real orders and places none', async () => {
    const w = instantlyWorld();
    const result = await buyInboxes({ kind: 'PREWARMED', mailboxes: 10, dryRun: true, actor: 'quote', persona: PERSONA, fetch: w.fetch, env: ENV });
    expect(result.lines.map((l) => l.outcome)).toEqual(['QUOTED', 'QUOTED']);
    expect(w.orders()).toHaveLength(0);
    expect((await inboxBudget()).purchases).toHaveLength(0);
  });

  it('spends inside the money put in and stops at the first domain it does not cover', async () => {
    await fundInboxes({ addCents: 15_000, monthlyCeilingCents: 20_000, actor: 'owner' });
    const w = instantlyWorld();
    const result = await buyInboxes({ kind: 'PREWARMED', mailboxes: 15, dryRun: false, actor: 'owner', persona: PERSONA, fetch: w.fetch, env: ENV });
    expect(w.orders()).toHaveLength(2); // $65 + $65 fits $150; a third $65 does not
    expect(result.lines.map((l) => l.outcome)).toEqual(['PLACED', 'PLACED', 'OVER_BUDGET']);
    const budget = await inboxBudget();
    expect(budget).toMatchObject({ spentCents: 13_000, remainingCents: 2_000, monthlyCommittedCents: 10_250, mailboxesOwned: 10 });
  });

  it('the monthly ceiling binds as well as the one-off money', async () => {
    await fundInboxes({ addCents: 100_000, monthlyCeilingCents: 6_000, actor: 'owner' });
    const w = instantlyWorld();
    const result = await buyInboxes({ kind: 'PREWARMED', mailboxes: 10, dryRun: false, actor: 'owner', persona: PERSONA, fetch: w.fetch, env: ENV });
    expect(w.orders()).toHaveLength(1);
    expect(result.stopped).toMatch(/does not cover/);
  });

  it('a lost answer is counted as spent, never retried, and reconciled when the domain shows up', async () => {
    await fundInboxes({ addCents: 100_000, monthlyCeilingCents: 100_000, actor: 'owner' });
    const lost = instantlyWorld({ order: () => new Response('oops', { status: 502 }) });
    const first = await buyInboxes({ kind: 'PREWARMED', mailboxes: 10, dryRun: false, actor: 'owner', persona: PERSONA, fetch: lost.fetch, env: ENV });
    expect(first.lines.at(-1)?.outcome).toBe('UNKNOWN');
    expect(lost.orders()).toHaveLength(1); // stopped at the first unknown
    expect((await inboxBudget()).spentCents).toBe(6_500);

    // The next buy never re-attempts that domain: it is taken.
    const again = instantlyWorld();
    await buyInboxes({ kind: 'PREWARMED', mailboxes: 5, dryRun: false, actor: 'owner', persona: PERSONA, fetch: again.fetch, env: ENV });
    expect(again.orders().map((c) => (c.body!.items as { domain: string }[])[0]!.domain)).toEqual(['two.com']);

    const sync = await syncInboxes({ fetch: instantlyWorld({ ordered: ['one.com'], accounts: ['caleb@one.com', 'calebb@one.com'] }).fetch, env: ENV });
    expect(sync.reconciled).toEqual(['one.com']);
    expect(sync.warmupEnabled).toContainEqual({ domain: 'one.com', accounts: 2 });
    expect(sync.waiting).toEqual(['two.com']);
    const one = (await inboxBudget()).purchases.find((p) => p.domain === 'one.com');
    expect(one).toMatchObject({ state: 'PLACED', warmupEnabled: true });
    expect(await inboxesUnsettled()).toBe(true); // two.com's mailboxes have not arrived
  });

  it('a refusal spends nothing and the next domain is tried', async () => {
    await fundInboxes({ addCents: 10_000, monthlyCeilingCents: 10_000, actor: 'owner' });
    const w = instantlyWorld({ order: (domain) => (domain === 'one.com' ? json({ ...PREWARMED_QUOTE, simulation: false, order_placed: false, order_is_valid: false, unavailable_domains: ['one.com'] }) : json({ ...PREWARMED_QUOTE, simulation: false, order_placed: true })) });
    const result = await buyInboxes({ kind: 'PREWARMED', mailboxes: 5, dryRun: false, actor: 'owner', persona: PERSONA, fetch: w.fetch, env: ENV });
    expect(result.lines.map((l) => l.outcome)).toEqual(['REFUSED', 'PLACED']);
    expect((await inboxBudget()).spentCents).toBe(6_500);
  });

  it('builds new inboxes through InboxKit: domain, five Google mailboxes, exported to the Instantly sequencer, no paid warmup', async () => {
    await fundInboxes({ addCents: 5_000, monthlyCeilingCents: 5_000, actor: 'owner' });
    const calls: Call[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method: String(init.method), body });
      if (url.endsWith('/domains/search')) return json({ domains: [{ name: 'windycityhq.com', price: 11.08, available: true, google_workspace_available: true }, { name: 'windycity.net', price: 9, available: true }] });
      if (url.endsWith('/sequencers/list')) return json({ sequencers: [{ uid: 'seq-1', platform: 'instantly' }] });
      if (url.endsWith('/orders')) return json([{ order_id: 'o-1', status: 'windycityhq.com queued', domain: 'windycityhq.com' }]);
      if (url.includes('/dfy-email-account-orders?')) return json({ items: [] });
      return json({ error: 'unexpected' }, 404);
    };
    const result = await buyInboxes({ kind: 'NEW', mailboxes: 5, dryRun: false, actor: 'owner', persona: PERSONA, fetch, env: KIT_ENV });
    expect(result.provider).toBe('INBOXKIT');
    expect(result.lines).toEqual([expect.objectContaining({ domain: 'windycityhq.com', outcome: 'PLACED', upfrontCents: 1_108 + 1_500, monthlyCents: 1_500 + 93 })]);
    const order = calls.find((c) => c.url.endsWith('/orders'))!.body!;
    expect(order.warmup_addon_enabled).toBe(false);
    const domain = (order.domains as Record<string, unknown>[])[0]!;
    expect(domain.redirect_url).toBe('https://windycityoutreach.com');
    expect((domain.mailboxes as Record<string, unknown>[]).map((m) => [m.email, m.platform, m.sequencer_uid])).toContainEqual(['caleb@windycityhq.com', 'GOOGLE', 'seq-1']);
  });

  it('an InboxKit wallet that does not cover the order is a refusal that spends nothing', async () => {
    await fundInboxes({ addCents: 5_000, monthlyCeilingCents: 5_000, actor: 'owner' });
    const fetch = async (url: string): Promise<Response> => {
      if (url.endsWith('/domains/search')) return json({ domains: [{ name: 'windycityhq.com', price: 11, available: true }] });
      if (url.endsWith('/sequencers/list')) return json({ sequencers: [{ uid: 'seq-1', platform: 'instantly' }] });
      if (url.endsWith('/orders')) return json({ message: 'Insufficient credits' }, 402);
      return json({}, 404);
    };
    const result = await buyInboxes({ kind: 'NEW', mailboxes: 5, dryRun: false, actor: 'owner', persona: PERSONA, fetch, env: KIT_ENV });
    expect(result.stopped).toMatch(/wallet does not cover/);
    expect((await inboxBudget()).spentCents).toBe(0);
  });
});
