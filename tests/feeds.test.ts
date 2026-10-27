/**
 * Feeds: code pulls, free models sort, rules check, Claude sees a short list.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { feedReading } from '../server/repos/feeds.ts';
import {
  parseFederalRegister,
  parseGdelt,
  parseRemoteOk,
  parseRemotive,
  type FeedSource,
} from '../server/services/feeds/sources.ts';
import {
  leadPassesRules,
  openFeedShortlist,
  pullDueFeeds,
  screenFeedLeads,
  SHORTLIST_SIZE,
} from '../server/services/feeds/run.ts';
import { APPROVAL_ENVELOPES } from '../server/services/research/approvalEnvelope.ts';
import { describesOwnAction } from '../server/services/research/actorScope.ts';
import { combineLeads, parseLead, type Completer, type LaneConfig } from '../server/services/cheap/lane.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({
      email: `feeds-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
});

// The real clock: rounds and rows are stamped with it, so a fixed date drifts.
const now = new Date();
const yesterday = new Date(now.getTime() - 86_400_000).toISOString();
const config: LaneConfig = { url: 'http://cheap.test/v1', key: null, models: ['m1', 'm2'], dailyBudget: 1000, timeoutMs: 1000 };
const keep = '{"verdict":"KEEP","window":"SHORT","deliverable":"SPREADSHEET","need":"a pricing tracker","payer":"the shop","reason":"asks for it"}';
const drop = '{"verdict":"DROP","window":"UNKNOWN","deliverable":"NONE","need":"","payer":"","reason":"personal"}';

function source(id: string, items: number): FeedSource {
  return {
    id,
    label: id,
    url: `https://example.test/${id}`,
    intervalMs: 3_600_000,
    parse: (body) =>
      (body as { n: number }[]).map((one) => ({
        externalId: `${id}-${one.n}`,
        url: `https://example.test/${id}/${one.n}`,
        title: one.n === 0 ? 'We want to hire a bookkeeper and buy software' : `Shop needs a pricing tracker ${one.n}`,
        body: 'We need a spreadsheet to track prices.',
        organization: 'A shop',
        publishedAt: yesterday,
      })),
  };
}

describe('parsers', () => {
  it('read each public format and drop what they cannot read', () => {
    expect(
      parseRemoteOk([{ legal: 'notice' }, { id: 1, position: 'Data analyst', url: 'https://remoteok.com/x', company: 'Acme', date: '2026-10-20T00:00:00Z', description: '<p>Clean our <b>CRM</b></p>' }]),
    ).toEqual([
      {
        externalId: '1',
        url: 'https://remoteok.com/x',
        title: 'Data analyst',
        body: 'Clean our CRM',
        organization: 'Acme',
        publishedAt: '2026-10-20T00:00:00.000Z',
      },
    ]);
    expect(parseRemotive({ jobs: [{ id: 9, title: 'Writer', url: 'https://remotive.com/9', company_name: 'B', publication_date: '2026-10-21T00:00:00' }, { id: 2 }] })).toHaveLength(1);
    expect(
      parseFederalRegister({ results: [{ document_number: '2026-1', title: 'A rule', html_url: 'https://www.federalregister.gov/d/2026-1', publication_date: '2026-10-22', effective_on: '2026-11-22', agencies: [{ name: 'EPA' }] }] })[0],
    ).toMatchObject({ organization: 'EPA', body: 'Effective 2026-11-22.' });
    expect(parseRemoteOk('not json')).toEqual([]);
    expect(
      parseGdelt({ articles: [{ url: 'https://news.test/a', title: 'Acme opens new store', domain: 'news.test', seendate: '20261026T120000Z' }, { title: 'no url' }] }),
    ).toEqual([
      { externalId: 'https://news.test/a', url: 'https://news.test/a', title: 'Acme opens new store', body: null, organization: 'news.test', publishedAt: '2026-10-26T12:00:00.000Z' },
    ]);
  });
});

describe('pulling', () => {
  it('stores new items once, waits out the interval, and records a failure', async () => {
    const sources = [source('one', 3)];
    const fetcher = async () => [{ n: 1 }, { n: 2 }, { n: 3 }];
    expect((await pullDueFeeds({ now, sources, fetcher }))[0]).toMatchObject({ inserted: 3, error: null });
    expect(await pullDueFeeds({ now, sources, fetcher })).toEqual([]);
    const later = new Date(now.getTime() + 2 * 3_600_000);
    expect((await pullDueFeeds({ now: later, sources, fetcher }))[0]?.inserted).toBe(0);
    const failing = async () => {
      throw new Error('HTTP 403');
    };
    const failed = await pullDueFeeds({ now: new Date(later.getTime() + 2 * 3_600_000), sources, fetcher: failing });
    expect(failed[0]?.error).toBe('HTTP 403');
    expect((await feedReading(now)).bySource[0]).toMatchObject({ source: 'one', items: 3, lastError: 'HTTP 403' });
  });
});

describe('free-model answers about a lead', () => {
  it('refuse off-shape answers and need both models to agree on a KEEP', () => {
    expect(parseLead(keep)?.deliverable).toBe('SPREADSHEET');
    expect(parseLead('{"verdict":"KEEP","deliverable":"VIDEO"}')).toBeNull();
    expect(parseLead('{"verdict":"KEEP","extra":1}')).toBeNull();
    const other = keep.replace('SPREADSHEET', 'DOCUMENT');
    expect(combineLeads([parseLead(keep), parseLead(other)])?.verdict).toBe('UNSURE');
    expect(combineLeads([parseLead(keep), parseLead(drop)])?.verdict).toBe('UNSURE');
    expect(combineLeads([parseLead(keep), parseLead(keep)])?.verdict).toBe('KEEP');
  });

  it('pass the rules only when kept, recent, deliverable and stated', () => {
    const item = {
      id: 'fdi_1',
      source: 's',
      externalId: '1',
      url: 'https://x.test/1',
      title: 't',
      body: null,
      organization: null,
      publishedAt: new Date(now.getTime() - 4 * 86_400_000).toISOString(),
      fetchedAt: yesterday,
      shortlistedRoundId: null,
    };
    expect(leadPassesRules(item, parseLead(keep), now)).toBe(true);
    expect(leadPassesRules(item, parseLead(drop), now)).toBe(false);
    expect(leadPassesRules({ ...item, publishedAt: new Date(now.getTime() - 60 * 86_400_000).toISOString() }, parseLead(keep), now)).toBe(false);
    expect(leadPassesRules(item, null, now)).toBe(false);
  });
});

describe('the shortlist', () => {
  async function seeded(n: number, answer: string): Promise<void> {
    await pullDueFeeds({ now, sources: [source('one', n)], fetcher: async () => Array.from({ length: n }, (_, i) => ({ n: i })) });
    const completer: Completer = async () => answer;
    await screenFeedLeads({ now, config, completer });
  }

  it('opens one round a day with the best leads, and hands no lead to Claude twice', async () => {
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    await seeded(SHORTLIST_SIZE + 3, keep);
    const roundId = await openFeedShortlist({ projectId, now });
    expect(roundId).not.toBeNull();
    const rounds = (await listRounds(projectId)).filter((one) => one.bucketId === 'feed-shortlist');
    expect(rounds).toHaveLength(1);
    const statement = (await getCandidate(rounds[0]!.candidateId))!.statement;
    expect(statement.match(/- lead:/g)).toHaveLength(SHORTLIST_SIZE);
    expect(statement).toContain('https://example.test/one/');
    // Asks nothing any approval envelope reads as Brain's own action.
    for (const [id, envelope] of Object.entries(APPROVAL_ENVELOPES)) {
      if (!id.startsWith('RUSSELL_CASH')) continue;
      expect(describesOwnAction(statement, envelope.forbiddenActions), id).toBe(false);
    }

    // Not again while that round is open, and not again the same day.
    expect(await openFeedShortlist({ projectId, now })).toBeNull();
    await getDb().run("UPDATE cash_discovery_rounds SET state = 'HARVESTED' WHERE id = ?", [roundId]);
    expect(await openFeedShortlist({ projectId, now: new Date(now.getTime() + 3_600_000) })).toBeNull();
    const tomorrow = new Date(now.getTime() + 21 * 3_600_000);
    const second = await openFeedShortlist({ projectId, now: tomorrow });
    expect(second).not.toBeNull();
    const all = (await listRounds(projectId)).filter((one) => one.bucketId === 'feed-shortlist');
    const leads2 = (await getCandidate(all.find((one) => one.id === second)!.candidateId))!.statement.match(/- lead:/g);
    expect(leads2).toHaveLength(3);
    expect((await feedReading(now)).shortlisted).toBe(SHORTLIST_SIZE + 3);
  });

  it('opens nothing when the free models kept nothing, or with no sprint', async () => {
    await seeded(4, keep);
    expect(await openFeedShortlist({ projectId, now })).toBeNull();
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    await getDb().run("DELETE FROM cheap_results WHERE kind = 'SCREEN_LEAD'");
    await screenFeedLeads({ now, config, completer: async () => drop });
    expect(await openFeedShortlist({ projectId, now })).toBeNull();
  });

  it('screens nothing when the lane is off', async () => {
    await pullDueFeeds({ now, sources: [source('one', 2)], fetcher: async () => [{ n: 1 }] });
    expect(await screenFeedLeads({ now, config: null })).toBe(0);
  });
});

describe('self-tuning the free models', () => {
  it('pushes up when answers are clean, backs off when they fail, and pauses when most fail', async () => {
    const { lanePacing } = await import('../server/services/feeds/run.ts');
    const { isDown } = await import('../server/services/cheap/lane.ts');
    const h = (total: number, failed: number) => new Map([['m1', { total, failed }]]);
    expect(lanePacing(h(5, 0), isDown).failureRate).toBeNull();
    expect(lanePacing(h(100, 1), isDown).perPass).toBe(300);
    expect(lanePacing(h(100, 10), isDown).perPass).toBe(120);
    expect(lanePacing(h(100, 30), isDown).perPass).toBe(30);
    expect(lanePacing(h(100, 39), isDown).perPass).toBe(30);
    // A model that is simply dead is skipped, not counted against the rest.
    const mixed = new Map([['m1', { total: 100, failed: 1 }], ['m2', { total: 50, failed: 50 }]]);
    expect(lanePacing(mixed, isDown).perPass).toBe(300);
  });

  it('stops asking a model that keeps failing', async () => {
    await pullDueFeeds({ now, sources: [source('one', 30)], fetcher: async () => Array.from({ length: 30 }, (_, i) => ({ n: i })) });
    const asked: string[] = [];
    const completer: Completer = async (_c, model) => {
      asked.push(model);
      if (model === 'm2') throw new Error('down');
      return keep;
    };
    await screenFeedLeads({ now, config, completer });
    const m2First = asked.filter((m) => m === 'm2').length;
    asked.length = 0;
    await pullDueFeeds({ now: new Date(now.getTime() + 2 * 3_600_000), sources: [source('two', 10)], fetcher: async () => Array.from({ length: 10 }, (_, i) => ({ n: i })) });
    await screenFeedLeads({ now, config, completer });
    expect(m2First).toBeGreaterThanOrEqual(10);
    expect(asked.filter((m) => m === 'm2')).toHaveLength(0);
  });
});

describe('a failed pull', () => {
  it('is retried after a short doubling wait, not the whole interval', async () => {
    const { nextPullAt, PULL_RETRY_MS } = await import('../server/services/feeds/run.ts');
    const six = { intervalMs: 6 * 3_600_000 };
    const at = '2026-10-27T00:00:00.000Z';
    const t = Date.parse(at);
    expect(nextPullAt(six, { lastSuccessAt: null, failuresSince: 0, lastFailureAt: null })).toBe(0);
    expect(nextPullAt(six, { lastSuccessAt: at, failuresSince: 0, lastFailureAt: null })).toBe(t + six.intervalMs);
    expect(nextPullAt(six, { lastSuccessAt: null, failuresSince: 1, lastFailureAt: at })).toBe(t + PULL_RETRY_MS);
    expect(nextPullAt(six, { lastSuccessAt: null, failuresSince: 3, lastFailureAt: at })).toBe(t + 4 * PULL_RETRY_MS);
    expect(nextPullAt(six, { lastSuccessAt: null, failuresSince: 20, lastFailureAt: at })).toBe(t + six.intervalMs);

    const sources = [source('flaky', 1)];
    const failing = async () => {
      throw new Error('HTTP 429');
    };
    expect((await pullDueFeeds({ now, sources, fetcher: failing }))[0]?.error).toBe('HTTP 429');
    expect(await pullDueFeeds({ now: new Date(now.getTime() + 5 * 60_000), sources, fetcher: failing })).toEqual([]);
    const retried = await pullDueFeeds({ now: new Date(now.getTime() + PULL_RETRY_MS + 60_000), sources, fetcher: async () => [{ n: 1 }] });
    expect(retried[0]).toMatchObject({ inserted: 1, error: null });
  });
});
