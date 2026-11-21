/**
 * World Watch (§65): a watched page that changed is one append-only change row
 * and one re-read through the claim gate — ordered, never regressing, never
 * doubled, and never a fact. A key a watched source names is detected; its
 * kind is not.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordReopenCondition, reopenConditionsFor } from '../server/repos/cashReconsideration.ts';
import { getWatchedSource, sourceChangesFor, watchSource } from '../server/repos/watchedSources.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { reconsiderAffected } from '../server/services/cash/reconsider.ts';
import { conditionalFetcher, type TransportResponse } from '../server/services/feeds/access.ts';
import {
  applyObservation,
  checkDueWatchedSources,
  diffExcerpt,
  normaliseWatchedText,
  type WatchReader,
} from '../server/services/feeds/watch.ts';
import { BLOCKER_DETECTION, blockerDetectionForKey, type BlockerKey } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let modeId = '';

const RULE: BlockerKey = 'REGULATION:eu-ai-act-art-50';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `watch-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
  modeId = (await getCashMode(projectId))!.id;
});

/** A page whose body the test sets, read through the real conditional fetcher. */
function page(initial: string) {
  const state = { body: initial, etag: null as string | null, calls: 0 };
  const transport = async (_url: string, headers: Record<string, string>): Promise<TransportResponse> => {
    state.calls += 1;
    if (state.etag && headers['If-None-Match'] === state.etag) return { status: 304, headers: { etag: state.etag }, body: '' };
    return { status: 200, headers: state.etag ? { etag: state.etag } : {}, body: state.body };
  };
  const read: WatchReader = (url, prior) => conditionalFetcher(transport)(url, prior);
  return { state, read };
}

/** A clock that moves forward a minute per read, from now, so every read is due and newer. */
function clock(startMs = Date.now() + 1_000) {
  let at = startMs;
  return () => {
    at += 60_000;
    return new Date(at).toISOString();
  };
}

async function due(id: string): Promise<void> {
  await getDb().run('UPDATE watched_sources SET next_check_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', id]);
}

async function count(table: string): Promise<number> {
  const rows = await getDb().all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.n ?? 0);
}

const V1 = '<html><body><h1>Article 50</h1><p>Applies from 2026-08-02.</p><script>var n=1</script></body></html>';
const V2 = '<html><body><h1>Article 50</h1><p>Applies from 2027-08-02.</p><script>var n=1</script></body></html>';

describe('normalising and excerpting', () => {
  it('measures the words, not the markup', () => {
    expect(normaliseWatchedText(V1)).toBe('Article 50\nApplies from 2026-08-02.');
    expect(normaliseWatchedText(V1.replace('var n=1', 'var n=2').replace('<p>', '<p class="x">'))).toBe(
      normaliseWatchedText(V1),
    );
  });

  it('excerpts what was added and what was lost, bounded', () => {
    const out = diffExcerpt('a\nb', 'a\nc');
    expect(out).toBe('+ c\n- b');
    expect(diffExcerpt('', 'x'.repeat(5000)).length).toBeLessThanOrEqual(800);
  });
});

describe('watched sources', () => {
  it('an unchanged page creates no change row', async () => {
    const { source } = await watchSource({ projectId, url: 'https://example.org/rule', reason: 'the rule', createdBy: 'test' });
    const { state, read } = page(V1);
    const now = clock();
    expect((await checkDueWatchedSources(projectId, { read, now }))[0]?.kind).toBe('BASELINE');
    for (const body of [V1, V1.replace('var n=1', 'var n=9')]) {
      state.body = body;
      await due(source.id);
      expect((await checkDueWatchedSources(projectId, { read, now }))[0]?.kind).toBe('UNCHANGED');
    }
    state.etag = '"v1"';
    await due(source.id);
    await checkDueWatchedSources(projectId, { read, now });
    await due(source.id);
    const outcome = await checkDueWatchedSources(projectId, { read, now });
    expect(outcome[0]).toMatchObject({ kind: 'UNCHANGED' });
    expect(await sourceChangesFor(source.id)).toEqual([]);
    expect(await count('source_changes')).toBe(0);
    // Not due again until its interval passes: a watch is not a crawl.
    expect(await checkDueWatchedSources(projectId, { read, now })).toEqual([]);
  });

  it('a changed page creates exactly one change row and one re-read through the gate', async () => {
    const { source } = await watchSource({
      projectId,
      url: 'https://example.org/rule',
      reason: 'the effective date decides the opening',
      blockerKey: RULE,
      createdBy: 'test',
    });
    const { state, read } = page(V1);
    const now = clock();
    await checkDueWatchedSources(projectId, { read, now });
    const baseline = (await getWatchedSource(source.id))!;
    state.body = V2;
    await due(source.id);
    const [outcome] = await checkDueWatchedSources(projectId, { read, now });
    expect(outcome?.kind).toBe('CHANGED');
    const changes = await sourceChangesFor(source.id);
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    const after = (await getWatchedSource(source.id))!;
    expect(change).toMatchObject({
      url: 'https://example.org/rule',
      blockerKey: RULE,
      oldHash: baseline.textHash,
      newHash: after.textHash,
      previousFetchedAt: baseline.fetchedAt,
      fetchedAt: after.fetchedAt,
    });
    expect(change.oldHash).not.toBe(change.newHash);
    expect(change.diffExcerpt).toContain('+ Applies from 2027-08-02.');
    expect(change.diffExcerpt).toContain('- Applies from 2026-08-02.');
    const idea = await getDb().all<{ state: string; statement: string }>(
      'SELECT state, statement FROM russell_candidates WHERE id = ?',
      [change.rereadCandidateId],
    );
    expect(idea[0]?.state).toBe('CAPTURED');
    expect(idea[0]?.statement).toContain('Re-read https://example.org/rule');
    expect(idea[0]?.statement).toContain('not evidence of anything by itself');
    const events = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM project_events WHERE project_id = ? AND event_type = 'WATCHED_SOURCE_CHANGED'`,
      [projectId],
    );
    expect(Number(events[0]?.n)).toBe(1);
  });

  it('the same change delivered twice is one row', async () => {
    const { source } = await watchSource({ projectId, url: 'https://example.org/rule', reason: 'r', createdBy: 'test' });
    const now = clock();
    await applyObservation(source, { status: 'MODIFIED', httpStatus: 200, body: V1, validators: {}, contentHash: 'b1', fetchedAt: now() });
    const before = (await getWatchedSource(source.id))!;
    const delivery = { status: 'MODIFIED' as const, httpStatus: 200, body: V2, validators: {}, contentHash: 'b2', fetchedAt: now() };
    expect((await applyObservation(before, delivery)).kind).toBe('CHANGED');
    // A replay against the source as it was read before: the guard refuses it.
    expect((await applyObservation(before, delivery)).kind).toBe('STALE');
    // A replay against the source as it is now: the same text, nothing to record.
    expect((await applyObservation((await getWatchedSource(source.id))!, delivery)).kind).toBe('UNCHANGED');
    expect(await sourceChangesFor(source.id)).toHaveLength(1);
    expect(await count('russell_candidates')).toBe(1);
  });

  it('an older read never regresses a newer one', async () => {
    const { source } = await watchSource({ projectId, url: 'https://example.org/rule', reason: 'r', createdBy: 'test' });
    const t0 = new Date(Date.now() + 60_000).toISOString();
    const t1 = new Date(Date.now() + 120_000).toISOString();
    const t2 = new Date(Date.now() + 180_000).toISOString();
    await applyObservation(source, { status: 'MODIFIED', httpStatus: 200, body: V1, validators: {}, contentHash: 'b1', fetchedAt: t0 });
    const read = (await getWatchedSource(source.id))!;
    expect((await applyObservation(read, { status: 'MODIFIED', httpStatus: 200, body: V2, validators: {}, contentHash: 'b2', fetchedAt: t2 })).kind).toBe('CHANGED');
    const newest = (await getWatchedSource(source.id))!;
    // A read taken at t1, before t2, arriving late with yet other text.
    const late = await applyObservation(newest, {
      status: 'MODIFIED',
      httpStatus: 200,
      body: '<p>Withdrawn.</p>',
      validators: {},
      contentHash: 'b3',
      fetchedAt: t1,
    });
    expect(late.kind).toBe('STALE');
    // A late 304 does not move the position back either.
    await applyObservation(newest, { status: 'NOT_MODIFIED', httpStatus: 304, validators: { etag: '"old"' }, reason: '304', fetchedAt: t1 });
    const still = (await getWatchedSource(source.id))!;
    expect(still.fetchedAt).toBe(t2);
    expect(still.textHash).toBe(newest.textHash);
    expect(still.etag).toBeNull();
    expect(await sourceChangesFor(source.id)).toHaveLength(1);
  });

  it('a change reconsiders what waits on its key, and promotes nothing to a fact', async () => {
    const opportunity = await createOpportunity({
      projectId,
      cashModeId: modeId,
      ownerUserId: userId,
      title: 'Compliance labelling for AI-generated media',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    await recordReopenCondition({
      projectId,
      opportunityId: opportunity.id,
      blockerKey: RULE,
      recordedFrom: 'WEAK_ECONOMICS',
      actorRef: 'BRAIN',
    });
    const before = {
      cardFacts: await count('cash_card_facts'),
      constructionFacts: await count('construction_facts'),
      claims: await count('research_claims'),
      pathFacts: await count('monetization_path_facts'),
    };
    // Without a watch the kind is undetected; with one, that key alone is.
    expect(BLOCKER_DETECTION.REGULATION.detection).toBe('NOT_DETECTED');
    expect(blockerDetectionForKey(RULE, new Set()).detection).toBe('NOT_DETECTED');
    const { source } = await watchSource({ projectId, url: 'https://example.org/rule', reason: 'r', blockerKey: RULE, createdBy: 'test' });
    expect(blockerDetectionForKey(RULE, new Set([RULE])).detection).toBe('MARKER');
    expect(blockerDetectionForKey('REGULATION:another-rule', new Set([RULE])).detection).toBe('NOT_DETECTED');

    const { state, read } = page(V1);
    const now = clock();
    await checkDueWatchedSources(projectId, { read, now });
    expect((await reconsiderAffected(projectId)).triggered).toEqual([]);
    state.body = V2;
    await due(source.id);
    await checkDueWatchedSources(projectId, { read, now });
    const [change] = await sourceChangesFor(source.id);

    const pass = await reconsiderAffected(projectId);
    expect(pass.triggered).toEqual([
      { opportunityId: opportunity.id, key: RULE, changeRef: `${RULE}@${change!.id}`, via: 'DERIVED' },
    ]);
    // Consumed once: the next pass finds the same change already consumed.
    expect((await reconsiderAffected(projectId)).triggered).toEqual([]);
    const [condition] = await reopenConditionsFor(opportunity.id);
    expect(condition?.triggerChangeRef).toBe(`${RULE}@${change!.id}`);
    const reread = (await getOpportunity(opportunity.id))!;
    expect(reread.state).toBe(opportunity.state);

    expect({
      cardFacts: await count('cash_card_facts'),
      constructionFacts: await count('construction_facts'),
      claims: await count('research_claims'),
      pathFacts: await count('monetization_path_facts'),
    }).toEqual(before);
  });
});
