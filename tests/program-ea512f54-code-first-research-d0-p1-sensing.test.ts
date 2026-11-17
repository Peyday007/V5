/**
 * ALGO-16-1 / ALGO-19-3 sensing: a feed is read incrementally from its own
 * cursor where the publisher takes a start date, every item is stored once and
 * screened at most once, and what the code-first lane saved and made is read
 * back from rows — including when the free-model lane is down.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { CURSOR_OVERLAP_MS, FEED_SOURCES, pullUrl, type FeedSource } from '../server/services/feeds/sources.ts';
import { openFeedShortlist, pullDueFeeds, screenFeedLeads, screeningEconomy, SCREENING_ECONOMY_EVENT, SCREENING_ECONOMY_INTERVAL_MS } from '../server/services/feeds/run.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { runDetectors } from '../server/services/feeds/detectors.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const config: LaneConfig = { url: 'http://cheap.test/v1', key: null, models: ['m1', 'm2'], dailyBudget: 1000, timeoutMs: 1000 };
const drop = '{"verdict":"DROP","window":"UNKNOWN","deliverable":"NONE","need":"","payer":"","reason":"personal"}';

function source(id: string, cursor: boolean): FeedSource {
  return {
    id,
    label: id,
    url: `https://example.test/${id}`,
    intervalMs: 3_600_000,
    ...(cursor ? { cursorUrl: (since: string) => `https://example.test/${id}?since=${since}` } : {}),
    parse: (body) =>
      (body as { n: number }[]).map((one) => ({
        externalId: `${id}-${one.n}`,
        url: `https://example.test/${id}/${one.n}`,
        title: `Shop needs a pricing tracker ${one.n}`,
        body: 'We need a spreadsheet to track prices.',
        organization: 'A shop',
        publishedAt: daysAgo(1),
      })),
  };
}

describe('the pull URL is incremental where the publisher takes a start date', () => {
  it('reads whole on the first pull and from the last success, less the overlap, afterwards', () => {
    const cursored = source('c', true);
    expect(pullUrl(cursored, null)).toEqual({ url: 'https://example.test/c', incremental: false });
    const last = '2026-11-10T12:00:00.000Z';
    const since = new Date(Date.parse(last) - CURSOR_OVERLAP_MS).toISOString();
    expect(pullUrl(cursored, last)).toEqual({ url: `https://example.test/c?since=${since}`, incremental: true });
    // A source with no start-date parameter is read whole; storage deduplicates it.
    expect(pullUrl(source('w', false), last)).toEqual({ url: 'https://example.test/w', incremental: false });
  });

  it('the production sources that take a start date carry one', () => {
    const fr = FEED_SOURCES.find((one) => one.id === 'federal-register-rules')!;
    expect(fr.cursorUrl!('2026-11-10T10:00:00.000Z')).toContain('conditions%5Bpublication_date%5D%5Bgte%5D=2026-11-10');
    const gdelt = FEED_SOURCES.find((one) => one.id.startsWith('news-'))!;
    const url = gdelt.cursorUrl!('2026-11-10T10:00:00.000Z');
    expect(url).toContain('startdatetime=20261110100000');
    expect(url).not.toContain('timespan');
    // Job boards take no start date and are read whole.
    expect(FEED_SOURCES.find((one) => one.id === 'remoteok')!.cursorUrl).toBeUndefined();
  });
});

describe('pulling stores each item once and says what was a repeat', () => {
  it('asks incrementally after a success and reports the items storage already held', async () => {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      asked.push(url);
      return [{ n: 1 }, { n: 2 }, { n: 3 }];
    };
    const sources = [source('c', true)];
    const first = await pullDueFeeds({ now, sources, fetcher });
    expect(first[0]).toMatchObject({ fetched: 3, inserted: 3, duplicates: 0, incremental: false });
    const later = new Date(now.getTime() + 2 * 3_600_000);
    const second = await pullDueFeeds({ now: later, sources, fetcher });
    expect(second[0]).toMatchObject({ fetched: 3, inserted: 0, duplicates: 3, incremental: true });
    expect(asked[0]).toBe('https://example.test/c');
    expect(asked[1]).toMatch(/^https:\/\/example\.test\/c\?since=/);
    expect((await getDb().all('SELECT id FROM feed_items')).length).toBe(3);
  });
});

describe('what the code-first lane saved and made, read from rows', () => {
  async function seedHiring(): Promise<void> {
    const rows = [
      ['1', 'Data Analyst', 'Acme Inc', 1],
      ['2', 'Analytics Engineer', 'Acme', 3],
      ['3', 'BI Developer', 'ACME', 6],
      ['4', 'Store Manager', 'Elsewhere', 2],
    ] as const;
    await insertFeedItems('remoteok', rows.map(([id, title, org, d]) => ({ externalId: id, url: `https://remoteok.test/${id}`, title, body: null, organization: org, publishedAt: daysAgo(d) })));
  }

  it('counts repeats, covered items and code-made leads as not screened, and the calls actually made', async () => {
    const since = new Date(now.getTime() - 60_000).toISOString();
    // A pull seen twice: three items stored, three repeats dropped.
    const fetcher = async () => [{ n: 1 }, { n: 2 }, { n: 3 }];
    await pullDueFeeds({ now, sources: [source('c', true)], fetcher });
    await pullDueFeeds({ now: new Date(now.getTime() + 2 * 3_600_000), sources: [source('c', true)], fetcher });
    await seedHiring();
    await runDetectors({ now });

    const asked: string[] = [];
    const completer: Completer = async (_c, model, _s, prompt) => {
      asked.push(`${model}:${prompt.slice(0, 40)}`);
      return drop;
    };
    const screened = await screenFeedLeads({ now, config, completer });
    const reading = await screeningEconomy({ since, until: new Date(now.getTime() + 3 * 3_600_000).toISOString() });

    // Three hiring posts are covered by the code rule and never screened one by one.
    expect(reading.notScreened.covered).toBe(3);
    expect(reading.notScreened.duplicates).toBe(3);
    expect(reading.workCreated.codeDetections).toBe(1);
    expect(reading.notScreened.provedByCode).toBe(1);
    expect(reading.notScreened.total).toBe(3 + 3 + 1);
    // Only the uncovered items were screened: three pull items and the store manager post.
    expect(screened).toBe(4);
    expect(reading.itemsScreened).toBe(4);
    expect(reading.screenCalls).toBe(asked.length);
  });

  it('with the free lane down, pulling, dedup and detectors still run and nothing is screened by a model', async () => {
    const since = new Date(now.getTime() - 60_000).toISOString();
    await pullDueFeeds({ now, sources: [source('c', true)], fetcher: async () => [{ n: 1 }] });
    await seedHiring();
    const detected = await runDetectors({ now });
    expect(detected[0]).toMatchObject({ covered: 3 });
    expect(await screenFeedLeads({ now, config: null })).toBe(0);
    const reading = await screeningEconomy({ since, until: new Date(now.getTime() + 60_000).toISOString() });
    expect(reading.screenCalls).toBe(0);
    expect(reading.stored).toBe(1 + 4 + 1);
    expect(reading.notScreened.covered).toBe(3);
  });
});

describe('the screening economy is read in production, not only on request', () => {
  it('the shortlist tick records one reading a day on the cash ledger, windows back to back', async () => {
    const owner = await createUser({ email: `economy-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    expect((await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    await pullDueFeeds({ now, sources: [source('c', true)], fetcher: async () => [{ n: 1 }, { n: 2 }] });
    await pullDueFeeds({ now: new Date(now.getTime() + 2 * 3_600_000), sources: [source('c', true)], fetcher: async () => [{ n: 1 }, { n: 2 }] });
    const asked: string[] = [];
    const completer: Completer = async (_c, model) => {
      asked.push(model);
      return drop;
    };
    await screenFeedLeads({ now, config, completer });

    // The production entry point: the loop's shortlist tick. Nothing here asks for the reading.
    const tick = new Date(now.getTime() + 3 * 3_600_000);
    await openFeedShortlist({ projectId, now: tick });
    const rows = await cashEventsOfKindInProject(projectId, SCREENING_ECONOMY_EVENT);
    expect(rows).toHaveLength(1);
    const detail = rows[0]!.detail as { since: string; until: string; screenCalls: number; notScreened: { duplicates: number }; workCreated: { total: number } };
    expect(detail.until).toBe(tick.toISOString());
    expect(detail.since).toBe(new Date(tick.getTime() - SCREENING_ECONOMY_INTERVAL_MS).toISOString());
    expect(detail.screenCalls).toBe(asked.length);
    expect(detail.screenCalls).toBeGreaterThan(0);
    expect(detail.notScreened.duplicates).toBe(2);
    expect(rows[0]!.summary).toContain('never sent to a model');
    // The same reading the function gives for that window: the row is the measurement, not a copy of a guess.
    expect(detail).toEqual(JSON.parse(JSON.stringify(await screeningEconomy({ since: detail.since, until: detail.until }))));

    // Another tick within the day writes nothing; the next day's window starts where this one ended.
    await openFeedShortlist({ projectId, now: new Date(tick.getTime() + 3_600_000) });
    expect(await cashEventsOfKindInProject(projectId, SCREENING_ECONOMY_EVENT)).toHaveLength(1);
    const nextDay = new Date(tick.getTime() + SCREENING_ECONOMY_INTERVAL_MS + 60_000);
    await openFeedShortlist({ projectId, now: nextDay });
    const after = await cashEventsOfKindInProject(projectId, SCREENING_ECONOMY_EVENT);
    expect(after).toHaveLength(2);
    expect((after[1]!.detail as { since: string }).since).toBe(tick.toISOString());
  });
});
