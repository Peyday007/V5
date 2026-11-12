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
import { createUser } from '../server/repos/identity.ts';
import { listLearnedDetectors, recordMethodRun } from '../server/repos/searchMethods.ts';
import { FEED_READER } from '../server/services/feeds/learnedRun.ts';
import { FAILURE_STREAK } from '../server/services/research/searchFailures/classify.ts';
import {
  bucketDetectorKey,
  bucketGates,
  compileBucketMethod,
  recordRoundAsRun,
} from '../server/services/research/searchMethods/bucketMethods.ts';
import { SEARCH_BUCKETS, openDiscovery } from '../server/services/cash/discovery.ts';
import { activate } from '../server/services/cash/lifecycle.ts';

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

/**
 * F5-2: the route is read. A bucket whose PROVEN method is compiled into code
 * is executed by the feeds pass, and discovery opens no Claude round for it;
 * a bucket without a code executor is still developed by a Claude round.
 */
describe('discovery reads the route: a compiled method is executed by code, not by a Claude round', () => {
  const titles = [
    'County parcel data RFQ',
    'Parcel data RFQ for a county assessor',
    'RFQ: county parcel data cleanup',
  ];

  async function activeProject(): Promise<string> {
    const fixture = await freshProject();
    const projectId = fixture.project.id;
    const user = await createUser({
      email: `route-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner', password: 'correct horse battery staple',
    });
    const outcome = await activate({ projectId, ownerUserId: user.id, actorUserId: user.id, objective: 'Maximize additional usable cash.' });
    expect(outcome.ok).toBe(true);
    return projectId;
  }

  /** Two measured Claude rounds that earn the bucket's method PROVEN. */
  async function prove(projectId: string, bucket: (typeof SEARCH_BUCKETS)[number]): Promise<void> {
    await recordRoundAsRun(projectId, bucket, { to: 'HARVESTED', missionState: 'DONE', found: 6, useful: 6, duplicates: 0 });
    const second = await recordRoundAsRun(projectId, bucket, { to: 'HARVESTED', missionState: 'DONE', found: 6, useful: 6, duplicates: 0 });
    expect(second?.method.trustState).toBe('PROVEN');
  }

  it('routes a compiled PROVEN bucket to CODE, and openDiscovery opens no Claude round for it', async () => {
    const projectId = await activeProject();
    const proven = SEARCH_BUCKETS[0]!;
    const developing = SEARCH_BUCKETS[1]!;
    await prove(projectId, proven);
    // The other bucket has a method, but not one code can run.
    await recordRoundAsRun(projectId, developing, { to: 'HARVESTED', missionState: 'DONE', found: 1, useful: 1, duplicates: 0 });

    // Proven but not yet compiled: still development, and flagged for compiling.
    const before = (await bucketGates(projectId, [proven.id], new Date().toISOString())).get(proven.id)!;
    expect(before).toMatchObject({ route: 'DEVELOP', proven: true, executorDetectorId: null });

    const compiled = await compileBucketMethod(projectId, proven, { positives: titles });
    expect(compiled.compiled).toBe(true);
    if (!compiled.compiled) return;
    // The executor is a GENERAL detector the feeds pass runs, serving a GENERAL copy of the method.
    expect(compiled.executor.detector.scope).toBe('GENERAL');
    expect(compiled.executor.detector.mode).toBe('SHADOW');
    expect(compiled.executor.method.scope).toBe('GENERAL');
    expect(compiled.executor.detector.methodId).toBe(compiled.executor.method.id);
    const onFeeds = (await listLearnedDetectors(FEED_READER)).map((d) => d.detectorKey);
    expect(onFeeds).toContain(bucketDetectorKey(proven.id));
    // Compiling twice is the same executor.
    const again = await compileBucketMethod(projectId, proven, { positives: titles });
    expect(again.compiled && again.executor.detector.id).toBe(compiled.executor.detector.id);

    const gates = await bucketGates(projectId, [proven.id, developing.id], new Date().toISOString());
    expect(gates.get(proven.id)).toMatchObject({ route: 'CODE', mayOpen: false, executorDetectorId: compiled.executor.detector.id });
    expect(gates.get(developing.id)).toMatchObject({ route: 'DEVELOP', mayOpen: true });

    const opened = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length + 50 });
    expect(opened.map((o) => o.bucketId)).not.toContain(proven.id);
    expect(opened.map((o) => o.bucketId)).toContain(developing.id);
  });

  it('hands a compiled bucket back to development when its code executor needs revising', async () => {
    const projectId = await activeProject();
    const bucket = SEARCH_BUCKETS[0]!;
    await prove(projectId, bucket);
    const compiled = await compileBucketMethod(projectId, bucket, { positives: titles });
    expect(compiled.compiled).toBe(true);
    if (!compiled.compiled) return;
    for (let i = 0; i < FAILURE_STREAK; i += 1) {
      await recordMethodRun({ methodId: compiled.executor.method.id, executor: 'CODE', outcome: 'FALSE_POSITIVES', surfaced: 4, rejected: 4 });
    }
    const gate = (await bucketGates(projectId, [bucket.id], new Date().toISOString())).get(bucket.id)!;
    expect(gate.route).toBe('DEVELOP');
    expect(gate.executorDetectorId).toBeNull();
    expect((await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length + 50 })).map((o) => o.bucketId)).toContain(bucket.id);
  });

  it('refuses to compile a method that has not earned PROVEN, or examples that hold private data', async () => {
    const projectId = await activeProject();
    const bucket = SEARCH_BUCKETS[0]!;
    await recordRoundAsRun(projectId, bucket, { to: 'HARVESTED', missionState: 'DONE', found: 2, useful: 2, duplicates: 0 });
    const early = await compileBucketMethod(projectId, bucket, { positives: titles });
    expect(early).toMatchObject({ compiled: false });

    await recordRoundAsRun(projectId, bucket, { to: 'HARVESTED', missionState: 'DONE', found: 10, useful: 10, duplicates: 0 });
    const leaky = await compileBucketMethod(projectId, bucket, { positives: [...titles, 'Call owner@example.test about parcel data'] });
    expect(leaky.compiled).toBe(false);
    expect((await listLearnedDetectors(FEED_READER)).map((d) => d.detectorKey)).not.toContain(bucketDetectorKey(bucket.id));
    // With no executor it is still development, not silently dropped.
    expect((await bucketGates(projectId, [bucket.id], new Date().toISOString())).get(bucket.id)?.route).toBe('DEVELOP');
  });
});
