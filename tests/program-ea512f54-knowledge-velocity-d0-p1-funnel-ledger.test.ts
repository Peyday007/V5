/**
 * KNOW-25-1, "No false speed": the funnel's evidence-accepted and goal-decision
 * stages are read from their own rows, and a pass's gain is measured against the
 * reading before it — never against an empty reading.
 *
 * Regression for the finding that EVIDENCE_ACCEPTED and GOAL_DECISIONS were `[]`
 * literals and that `gain` was `funnelGain(readFunnel({}), reading)`, so false
 * speed could only fire on a pass that yielded nothing usable at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordDecision } from '../server/repos/cashDecisions.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { EXTRACTION_EVENT, recordFeedExtraction, type ExtractionPass } from '../server/services/feeds/run.ts';
import {
  advanceFunnel,
  emptyFunnelLedger,
  FUNNEL_STAGES,
  readFunnelLedger,
  type FunnelRecord,
} from '../server/services/knowledge/funnel.ts';

const at = new Date('2026-11-17T00:00:00Z');
const rec = (id: string, extra: Partial<FunnelRecord> = {}): FunnelRecord => ({ id, fingerprint: `fp-${id}`, observedAt: '2026-11-16T00:00:00Z', ...extra });

describe('funnel ledger: gain against the previous reading', () => {
  it('a pass that only repeats what an earlier pass counted gains nothing and is false speed, though it yields records', () => {
    const first = advanceFunnel(emptyFunnelLedger(), { RAW_INTAKE: [rec('a'), rec('b')], NORMALIZED_FACTS: [rec('fa'), rec('fb')] }, { now: at });
    expect(first.gain).toEqual({ raw: 4, usableIntelligence: 2, falseSpeed: false });
    // New row ids, the same content: each record is non-empty and, read alone, would look usable.
    const second = advanceFunnel(
      first.ledger,
      { RAW_INTAKE: [rec('a2', { fingerprint: 'fp-a' }), rec('b2', { fingerprint: 'fp-b' })], NORMALIZED_FACTS: [rec('fa2', { fingerprint: 'fp-fa' }), rec('fb2', { fingerprint: 'fp-fb' })] },
      { now: at },
    );
    expect(second.reading.raw).toBe(4);
    expect(second.reading.excluded.DUPLICATE).toBe(4);
    expect(second.gain).toEqual({ raw: 4, usableIntelligence: 0, falseSpeed: true });
    expect(second.cumulative.usableIntelligence).toBe(2);
  });

  it('a pass that yields usable records but takes in far more than the previous pass while understanding less is false speed', () => {
    const first = advanceFunnel(emptyFunnelLedger(), { RAW_INTAKE: [rec('r1')], NORMALIZED_FACTS: [rec('f1'), rec('f2'), rec('f3')] }, { now: at });
    const second = advanceFunnel(
      first.ledger,
      { RAW_INTAKE: [rec('r2'), rec('r3'), rec('r4'), rec('r5')], NORMALIZED_FACTS: [rec('f4'), rec('f1b', { fingerprint: 'fp-f1' }), rec('f2b', { fingerprint: 'fp-f2' })] },
      { now: at },
    );
    expect(second.gain.usableIntelligence).toBe(1);
    expect(second.versusPrevious.raw).toBeGreaterThan(0);
    expect(second.versusPrevious.usableIntelligence).toBeLessThan(0);
    expect(second.versusPrevious.falseSpeed).toBe(true);
    expect(second.gain.falseSpeed).toBe(true);
  });

  it('a row an earlier pass already counted is not intake again', () => {
    const first = advanceFunnel(emptyFunnelLedger(), { EVIDENCE_ACCEPTED: [rec('claim:1')] }, { now: at });
    const second = advanceFunnel(first.ledger, { EVIDENCE_ACCEPTED: [rec('claim:1'), rec('claim:2')] }, { now: at });
    expect(second.reading.stages.find((s) => s.stage === 'EVIDENCE_ACCEPTED')).toMatchObject({ raw: 1, usable: 1 });
    expect(second.gain).toEqual({ raw: 1, usableIntelligence: 1, falseSpeed: false });
  });

  it('the ledger survives being carried as JSON, and a malformed one reads as empty rather than favourable', () => {
    const first = advanceFunnel(emptyFunnelLedger(), { PARSED: [rec('p')], GOAL_DECISIONS: [rec('d')] }, { now: at });
    const carried = readFunnelLedger(JSON.parse(JSON.stringify(first.ledger)));
    expect(carried).toEqual(first.ledger);
    expect(readFunnelLedger({ schema: 1, cumulative: { stages: [{ stage: 'PARSED', raw: -5, usable: 'lots' }] } }).cumulative.usableIntelligence).toBe(0);
    expect(readFunnelLedger('nonsense')).toEqual(emptyFunnelLedger());
  });
});

/* -------------------------------------------------------- on production rows */

let projectId = '';
let layerId = '';
let ownerId = '';
let cashModeId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  ownerId = (await createUser({ email: `funnel-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId: fixture.project.id, ownerUserId: ownerId, actorUserId: ownerId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  projectId = fixture.project.id;
  layerId = (await getDb().get<{ id: string }>('SELECT id FROM layers WHERE project_id = ? LIMIT 1', [projectId]))!.id;
  cashModeId = (await getCashMode(projectId))!.id;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

async function acceptedClaim(sourceUrl: string, contradiction: 'UNCHALLENGED' | 'REFUTED' = 'UNCHALLENGED'): Promise<string> {
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', provider: 'WORKER' });
  const orchestration = await createOrchestration({ projectId, layerId, runId: run.id, title: 'funnel fixture', assignment: 'read the feed record', provider: 'WORKER' });
  const id = `rcl_funnel_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO research_claims
       (id, orchestration_id, fragment_id, pass_id, pass_key, claim, source_url, source_title,
        source_publisher, source_date, evidence_excerpt, evidence_locator, evidence_lane,
        retrieved_at, confidence, contradiction_state, contradiction_note, validation_state,
        validation_detail, sourced, derived, derived_from, accepted, content_hash, created_at)
     VALUES (?, ?, NULL, NULL, 'RESEARCH', ?, ?, 'feed record', NULL, NULL, NULL, NULL, 'lane-1',
             ?, 0.9, ?, NULL, 'VALID', NULL, 1, 0, '[]', 1, ?, ?)`,
    [id, orchestration.id, `a buyer asked for quotes (${id})`, sourceUrl, now, contradiction, `hash-${id}`, now] as never[],
  );
  return id;
}

async function passes(): Promise<ExtractionPass[]> {
  const found = await getDb().all<{ detail: string }>('SELECT detail FROM cash_events WHERE project_id = ? AND kind = ? ORDER BY created_at, id', [projectId, EXTRACTION_EVENT]);
  return found.map((r) => JSON.parse(r.detail) as ExtractionPass);
}

const stageOf = (pass: ExtractionPass, stage: (typeof FUNNEL_STAGES)[number]) => pass.funnel!.reading.stages.find((s) => s.stage === stage)!;

describe('recordFeedExtraction reads evidence accepted and goal decisions from their own rows', () => {
  it('counts an accepted claim about a feed record and the decision made on its opening, once', async () => {
    const source = `fl${Math.random().toString(36).slice(2, 8)}`;
    const url = `https://example.test/${source}/rfq`;
    await insertFeedItems(source, [
      { externalId: `${source}-1`, url, title: 'Request for quotes: 500 kg of packaging film', body: 'Seeking quotes. Delivery in Austin, TX by 2026-12-15. Budget $4,000.', organization: 'Acme Foods LLC', publishedAt: hoursAgo(5) },
    ]);
    const first = (await recordFeedExtraction({ projectId, capacity: 0 }))!;
    expect(stageOf(first, 'EVIDENCE_ACCEPTED').raw).toBe(0);
    expect(stageOf(first, 'GOAL_DECISIONS').raw).toBe(0);

    // Downstream work on that record: the gate accepts a claim, and a goal decides on the opening.
    const claimId = await acceptedClaim(url);
    await acceptedClaim(url, 'REFUTED');
    const opening = await createOpportunity({ projectId, cashModeId, ownerUserId: ownerId, title: 'Packaging film quote', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', sourceClaimId: claimId });
    expect(await recordDecision({ projectId, opportunityId: opening.id, goalId: 'goal-funnel', verdict: 'PRIORITIZE', reason: 'stated budget', detail: '{}', reopenCondition: 'never', changeRef: 'c1' })).toBe(true);

    await tick();
    await insertFeedItems(source, [
      { externalId: `${source}-2`, url: `https://example.test/${source}/other`, title: 'Lawn care now booking', body: 'Weekly mowing in Portland, OR for $45.', organization: 'Green Co', publishedAt: hoursAgo(2) },
    ]);
    const second = (await recordFeedExtraction({ projectId, capacity: 0 }))!;
    expect(stageOf(second, 'EVIDENCE_ACCEPTED')).toMatchObject({ raw: 2, usable: 1, excluded: { UNVERIFIED: 1 } });
    expect(stageOf(second, 'GOAL_DECISIONS')).toMatchObject({ raw: 1, usable: 1 });
    // Gain is measured against the first pass's reading, not an empty one.
    expect(second.funnel!.gain.usableIntelligence).toBe(second.funnel!.cumulative!.usableIntelligence - first.funnel!.cumulative!.usableIntelligence);
    expect(second.funnel!.gain.usableIntelligence).toBeGreaterThanOrEqual(2);

    // A third pass sees the same claim and decision rows again and does not count them a second time.
    await tick();
    await insertFeedItems(source, [
      { externalId: `${source}-3`, url: `https://example.test/${source}/third`, title: 'Thoughts on the market', body: 'Something is happening.', organization: null, publishedAt: hoursAgo(1) },
    ]);
    const third = (await recordFeedExtraction({ projectId, capacity: 0 }))!;
    expect(stageOf(third, 'EVIDENCE_ACCEPTED').raw).toBe(0);
    expect(stageOf(third, 'GOAL_DECISIONS').raw).toBe(0);
    expect(third.funnel!.cumulative!.stages.find((s) => s.stage === 'GOAL_DECISIONS')!.usable).toBe(1);
    expect((await passes()).length).toBe(3);
    const summary = await getDb().get<{ summary: string }>('SELECT summary FROM cash_events WHERE project_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1', [projectId, EXTRACTION_EVENT]);
    expect(summary!.summary).toContain('goal decision');
  });

  it('when the downstream rows cannot be read, the stage is named and the next pass still counts them', async () => {
    const source = `fl${Math.random().toString(36).slice(2, 8)}`;
    const url = `https://example.test/${source}/rfq`;
    await insertFeedItems(source, [{ externalId: `${source}-1`, url, title: 'Request for quotes', body: 'Budget $4,000 in Austin, TX.', organization: 'Acme Foods LLC', publishedAt: hoursAgo(5) }]);
    await acceptedClaim(url);
    const failed = (await recordFeedExtraction({ projectId, capacity: 0, failStages: ['funnelRecords'] }))!;
    expect(failed.stageFailures!.map((f) => f.stage)).toContain('funnelRecords');
    expect(stageOf(failed, 'EVIDENCE_ACCEPTED').raw).toBe(0);
    await tick();
    await insertFeedItems(source, [{ externalId: `${source}-2`, url: `https://example.test/${source}/b`, title: 'Another', body: 'Nothing.', organization: null, publishedAt: hoursAgo(1) }]);
    const next = (await recordFeedExtraction({ projectId, capacity: 0 }))!;
    expect(stageOf(next, 'EVIDENCE_ACCEPTED')).toMatchObject({ raw: 1, usable: 1 });
  });
});
