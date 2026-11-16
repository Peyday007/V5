/**
 * ALGO-16-1 items 2 and 5 in production, not only in a pure function: the
 * shortlist tick runs deterministic extraction over what arrived since the
 * last pass and records every normalized fact on the cash ledger with a link to
 * the exact stored item and text it was read from; the records the parser could
 * not read go to the free-model screen first, in their batches.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import {
  EXTRACTION_EVENT,
  openFeedShortlist,
  planScreens,
  recordFeedExtraction,
  screenFeedLeads,
  screenOrder,
  screenSubject,
  screeningEconomy,
  shortlistFunnel,
  type ExtractionPass,
} from '../server/services/feeds/run.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';

let projectId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const now = new Date();
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
const config: LaneConfig = { url: 'http://cheap.test/v1', key: null, models: ['m1', 'm2'], dailyBudget: 1000, timeoutMs: 1000 };
const drop = '{"verdict":"DROP","window":"UNKNOWN","deliverable":"NONE","need":"","payer":"","reason":"personal"}';

async function seed(source: string): Promise<void> {
  await insertFeedItems(source, [
    {
      externalId: `${source}-rfq`,
      url: `https://example.test/${source}/rfq`,
      title: 'Request for quotes: 500 kg of packaging film',
      body: 'Seeking quotes from a supplier. Delivery in Austin, TX by 2026-12-15. Budget $4,000.',
      organization: 'Acme Foods LLC',
      publishedAt: hoursAgo(5),
    },
    {
      externalId: `${source}-ad`,
      url: `https://example.test/${source}/ad`,
      title: 'Lawn care now booking',
      body: 'We offer weekly mowing in Dallas, TX for $45.',
      organization: 'Green Co',
      publishedAt: hoursAgo(4),
    },
    {
      externalId: `${source}-vague`,
      url: `https://example.test/${source}/vague`,
      title: 'Thoughts on the market',
      body: 'Something is happening and nobody knows what.',
      organization: null,
      publishedAt: hoursAgo(3),
    },
  ]);
}

async function itemId(externalId: string): Promise<string> {
  return (await getDb().get<{ id: string }>('SELECT id FROM feed_items WHERE external_id = ?', [externalId]))!.id;
}

async function activeSprint(): Promise<void> {
  const owner = await createUser({ email: `extract-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
  expect((await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
}

describe('extraction has a production caller and its facts are rows', () => {
  it('the shortlist tick records the pass, each fact linked to its stored item and exact text', async () => {
    const source = `x${Math.random().toString(36).slice(2, 8)}`;
    await activeSprint();
    await seed(source);
    await openFeedShortlist({ projectId, now });

    const rows = await cashEventsOfKindInProject(projectId, EXTRACTION_EVENT);
    expect(rows).toHaveLength(1);
    const pass = rows[0]!.detail as unknown as ExtractionPass;
    const rfq = await itemId(`${source}-rfq`);
    const ad = await itemId(`${source}-ad`);
    const vague = await itemId(`${source}-vague`);

    // A raw-evidence link on every fact, and it is the stored row's own text.
    expect(pass.facts.length).toBeGreaterThan(0);
    for (const fact of pass.facts) {
      const row = await getDb().get<{ title: string; body: string | null; organization: string | null; published_at: string | null; url: string }>(
        'SELECT title, body, organization, published_at, url FROM feed_items WHERE id = ?',
        [fact.evidence.itemId],
      );
      expect(row).toBeTruthy();
      expect(fact.evidence.url).toBe(row!.url);
      const field = { title: row!.title, body: row!.body, organization: row!.organization, publishedAt: row!.published_at }[fact.evidence.field] ?? '';
      expect(field).toContain(fact.evidence.text);
    }
    const price = pass.facts.find((f) => f.field === 'price' && f.evidence.itemId === rfq);
    expect(price).toMatchObject({ value: 400_000, currency: 'USD', demand: 'STATED_REQUEST' });
    expect(pass.facts.find((f) => f.field === 'buyer')?.evidence.itemId).toBe(rfq);
    // A supplier advert is never demand, and never yields a buyer.
    const adFacts = pass.facts.filter((f) => f.evidence.itemId === ad);
    expect(adFacts.length).toBeGreaterThan(0);
    expect(adFacts.every((f) => f.demand === 'NOT_DEMAND' && f.field !== 'buyer')).toBe(true);
    // No fact is presented as established.
    expect(pass.reconciled.every((r) => ['OBSERVED', 'CONTESTED', 'STALE'].includes(r.status))).toBe(true);
    // Only the record code could not read is escalated, in a batch.
    expect(pass.needsModel).toEqual([[vague]]);
    expect(pass.readable).toBe(2);

    // Incremental: the next tick reads nothing it has read, and writes nothing.
    await openFeedShortlist({ projectId, now: new Date(now.getTime() + 60_000) });
    expect(await cashEventsOfKindInProject(projectId, EXTRACTION_EVENT)).toHaveLength(1);
  });

  it('continues from its cursor, and runs with no model configured at all', async () => {
    const source = `y${Math.random().toString(36).slice(2, 8)}`;
    await seed(source);
    const first = await recordFeedExtraction({ projectId, now, limit: 2 });
    expect(first?.items).toBe(2);
    const second = await recordFeedExtraction({ projectId, now, limit: 2 });
    expect(second?.cursor.from).toEqual(first!.cursor.to);
    const firstIds = new Set(first!.facts.map((f) => f.evidence.itemId));
    expect(second!.facts.every((f) => !firstIds.has(f.evidence.itemId))).toBe(true);
  });
});

describe('the needsModel batches are sent to the free-model screen first', () => {
  const item = (id: string, title: string, body: string, organization: string | null = null) => ({
    id, source: 'any', url: `https://example.test/${id}`, title, body, organization, publishedAt: hoursAgo(2), fetchedAt: hoursAgo(1),
  });

  it('orders unreadable records ahead of readable ones, and drops none', () => {
    const items = [
      item('a', 'Request for quotes: 500 kg of film', 'Seeking quotes from a supplier in Austin, TX. Budget $4,000.', 'Acme'),
      item('b', 'Thoughts on the market', 'Something is happening.'),
      item('c', 'Lawn care now booking', 'We offer mowing in Dallas, TX for $45.', 'Green Co'),
      item('d', 'Musings', 'Nobody knows.'),
    ];
    expect(screenOrder(items, now).map((one) => one.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('the screen pass sends the unreadable record to the model', async () => {
    const source = `z${Math.random().toString(36).slice(2, 8)}`;
    await seed(source);
    const asked: string[] = [];
    const completer: Completer = async (_c, _model, _system, prompt) => {
      asked.push(prompt);
      return drop;
    };
    expect(await screenFeedLeads({ now, config, completer })).toBeGreaterThanOrEqual(3);
    expect(asked.some((p) => p.includes('Thoughts on the market'))).toBe(true);
  });
});

describe('the screen asks each subject once (repair F3): deterministic coverage, not only a new order', () => {
  const keep = '{"verdict":"KEEP","window":"SHORT","deliverable":"SPREADSHEET","need":"a packaging price tracker","payer":"the buyer","reason":"asks for it"}';
  const item = (id: string, source: string, title: string, organization: string | null) => ({
    id, source, url: `https://example.test/${source}/${id}`, title, body: 'Seeking quotes from a supplier in Austin, TX.', organization, publishedAt: hoursAgo(2), fetchedAt: hoursAgo(1),
  });

  it('screenSubject names the record kind, entity and deliverable, and nothing without both', () => {
    expect(screenSubject(item('a', 'one', 'Request for quotes: packaging film', 'Acme Foods LLC'))).toBe(screenSubject(item('b', 'two', 'Request for quotes: packaging film', 'ACME FOODS, LLC')));
    expect(screenSubject(item('c', 'one', 'Request for quotes: packaging film', null))).toBeNull();
    expect(screenSubject(item('d', 'one', 'Request for quotes: packaging film', 'Acme Foods LLC'))).not.toBe(screenSubject(item('e', 'one', 'Request for quotes: shrink wrap', 'Acme Foods LLC')));
  });

  it('planScreens asks the first record of a subject, coalesces the rest and any already answered, and drops nothing', () => {
    const a = item('a', 'one', 'Request for quotes: packaging film', 'Acme Foods LLC');
    const b = item('b', 'two', 'Request for quotes: packaging film', 'Acme Foods LLC');
    const c = item('c', 'one', 'Request for quotes: packaging film', null);
    const d = item('d', 'two', 'Request for quotes: packaging film', null);
    const e = item('e', 'one', 'Request for quotes: steel drums', 'Beta Corp');
    const plan = planScreens([a, b, c, d, e], new Set([screenSubject(e)!]), now);
    expect(plan.ask.map((one) => one.id).sort()).toEqual(['a', 'c', 'd']);
    expect(plan.coalesced.map((one) => one.id).sort()).toEqual(['b', 'e']);
  });

  it('in production the same request on two feeds costs one screen, reads one answer, and reaches the shortlist once', async () => {
    const owner = await createUser({ email: `f3-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    expect((await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    const tag = Math.random().toString(36).slice(2, 8);
    const first = `y${tag}a`;
    const second = `y${tag}b`;
    await seed(first);
    await seed(second);
    const asked: string[] = [];
    const completer: Completer = async (_c, _model, _system, prompt) => {
      asked.push(prompt);
      return prompt.includes('packaging film') ? keep : drop;
    };
    await screenFeedLeads({ now, config, completer });
    // Two models per screen: one screen of the request subject, not one per feed.
    expect(asked.filter((p) => p.includes('packaging film'))).toHaveLength(config.models.length);
    // A record whose subject cannot be told apart is still asked on its own, once per feed.
    expect(asked.filter((p) => p.includes('Thoughts on the market'))).toHaveLength(2 * config.models.length);
    // A second pass asks nothing more about it: the subject is answered.
    const before = asked.length;
    await screenFeedLeads({ now, config, completer });
    expect(asked.length).toBe(before);

    const funnel = await shortlistFunnel(projectId, now);
    const rfqs = [await itemId(`${first}-rfq`), await itemId(`${second}-rfq`)];
    // Both records read the subject's answer and pass the rules on their own...
    expect(funnel.passedRules).toBeGreaterThanOrEqual(2);
    // ...and Claude is shown the subject once.
    expect(funnel.chosen.filter(({ item: one }) => rfqs.includes(one.id))).toHaveLength(1);

    const since = new Date(now.getTime() - 3_600_000 * 3).toISOString();
    const reading = await screeningEconomy({ since, until: new Date(now.getTime() + 60_000).toISOString() });
    expect(reading.notScreened.coalesced).toBeGreaterThanOrEqual(1);
  });
});
