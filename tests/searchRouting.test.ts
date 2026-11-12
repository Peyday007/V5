import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { TASKS, type Completer, type LaneConfig } from '../server/services/cheap/lane.ts';
import { createDetectorFromExamples } from '../server/services/feeds/learned.ts';
import { pullDueFeeds, SCREENS_PER_PASS, screenFeedLeads } from '../server/services/feeds/run.ts';
import type { FeedSource } from '../server/services/feeds/sources.ts';
import {
  planExecution,
  routeRequest,
  type MethodResult,
} from '../server/services/research/searchRouting/route.ts';

const config: LaneConfig = { url: 'http://cheap.test/v1', key: null, models: ['m1'], dailyBudget: 1000, timeoutMs: 1000 };
const method = { id: 'mth_1', looksFor: 'county RFQs for parcel data' };
const result = (id: string, codeVerdict: MethodResult['codeVerdict']): MethodResult => ({
  id,
  source: 'https://example.gov',
  title: `t ${id}`,
  body: 'body',
  codeVerdict,
});

describe('search routing', () => {
  it('creates no Claude job for execution, and routes only uncertain results to the lane', () => {
    const plan = planExecution([result('a', 'MATCH'), result('b', 'NO_MATCH'), result('c', 'UNCERTAIN')]);
    expect(plan.claudeJobs).toBe(0);
    expect(plan.routed.map((one) => one.route)).toEqual(['CODE', 'CODE', 'CHEAP_LANE']);
    expect(plan.routed.every((one) => (one.route as string) !== 'DEVELOP')).toBe(true);
  });

  it('develops only when no stored method exists', () => {
    expect(routeRequest(null)).toBe('DEVELOP');
    expect(routeRequest(method)).toBe('CODE');
  });

  it('executes a stored method\'s uncertain results through the lane task production already runs', async () => {
    await freshProject();
    // One lane task per question: no second task for the same results.
    expect(Object.keys(TASKS)).not.toContain('CLASSIFY_RESULT');

    // A stored method's code check: a learned detector over one feed source.
    const made = await createDetectorFromExamples({
      scope: 'GENERAL',
      detectorKey: 'parcel-rfq',
      sources: ['routing'],
      positives: ['County parcel data RFQ', 'Parcel data RFQ for county', 'RFQ county parcel data cleanup'],
      negatives: ['Sales manager wanted'],
      threshold: 0.8,
    });
    expect(made.ok).toBe(true);

    // More items than one pass screens; the near-miss is the oldest, so arrival order alone never reaches it.
    const now = new Date();
    const published = new Date(now.getTime() - 86_400_000).toISOString();
    const total = SCREENS_PER_PASS + 10;
    const feed: FeedSource = {
      id: 'routing',
      label: 'routing',
      url: 'https://example.test/routing',
      intervalMs: 3_600_000,
      parse: () =>
        Array.from({ length: total }, (_, n) => ({
          externalId: `r-${n}`,
          url: `https://example.test/routing/${n}`,
          title: n === 0 ? 'County parcel listing' : `Shop needs a pricing tracker ${n}`,
          body: 'body',
          organization: 'A shop',
          publishedAt: published,
        })),
    };
    await pullDueFeeds({ now, sources: [feed], fetcher: async () => [] });
    const near = await getDb().get<{ id: string }>("SELECT id FROM feed_items WHERE external_id = 'r-0'");
    await getDb().run('UPDATE feed_items SET fetched_at = ? WHERE id = ?', [new Date(now.getTime() - 3_600_000).toISOString(), near!.id]);

    const completer: Completer = async () =>
      '{"verdict":"UNSURE","window":"UNKNOWN","deliverable":"NONE","need":"","payer":"","reason":"x"}';
    const screened = await screenFeedLeads({ now, config, completer });
    expect(screened).toBe(SCREENS_PER_PASS);

    const kinds = await getDb().all<{ kind: string }>('SELECT DISTINCT kind FROM cheap_results WHERE subject_id = ?', [near!.id]);
    expect(kinds.map((one) => one.kind)).toEqual(['SCREEN_LEAD']);
  });
});
