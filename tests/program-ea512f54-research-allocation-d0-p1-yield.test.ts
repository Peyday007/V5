/**
 * RES-07 / RES-15-5: research yield per lane and per window, attributed to the
 * five purposes, with every job's resource cost counted exactly once.
 *
 * The pure fold is checked on hand-built jobs; the reader is checked on real
 * rows — a goal's constructed round, its packet, an accepted claim, the
 * free-lane jobs that answered it (one rate-limited), a bin a worker held, an
 * opening and the customer payment on it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission } from '../server/repos/russellMissions.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { openConstructedRound } from '../server/services/cash/discovery.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { createBin, recordBinEvent } from '../server/repos/bins.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import {
  attributePurposes,
  isRateLimited,
  laneQueueFrom,
  researchYieldByPurpose,
  researchYieldWindows,
  RESEARCH_PURPOSES,
  summarizeResearchYield,
  type YieldJob,
} from '../server/services/goals/researchYield.ts';
import type { BinManifest, Layer } from '../server/domain/types.ts';

const T0 = Date.parse('2026-11-14T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const job = (over: Partial<YieldJob> & { id: string }): YieldJob => ({
  lane: 'free-lane:m', purposes: ['BROAD_DISCOVERY'], basis: [], startMs: T0 + 60_000, durationMs: 1_000,
  queueWaitMs: 500, outcome: 'COMPLETED', failureCause: null, rateLimited: false, costMinor: null, ...over,
});

describe('attributing research to the five purposes (pure)', () => {
  it('reads each purpose from the row that says it, records the basis, and keeps the unattributable', () => {
    expect(attributePurposes({ binPurpose: 'BRAIN_IMPROVEMENT' }).purposes).toEqual(['SELF_IMPROVEMENT']);
    expect(attributePurposes({ projectSlug: 'brain-architecture' }).purposes).toEqual(['SELF_IMPROVEMENT']);
    expect(attributePurposes({ buckets: ['goal-g1-lens-a'] }).purposes).toEqual(['BROAD_DISCOVERY']);
    expect(attributePurposes({ buckets: ['goal-g1-mx-k'] }).purposes).toEqual(['TRANSACTION_ROUTES']);
    expect(attributePurposes({ goalId: 'g2', goalHasTarget: false }).purposes).toEqual(['FORWARD_EXPLORATION']);
    const paid = attributePurposes({ aboutOpening: true, openingPaid: true, buckets: ['goal-g1-mx-k'] });
    expect(paid.purposes).toEqual(['OPERATING_SUPPORT', 'TRANSACTION_ROUTES']);
    expect(paid.basis.join(' ')).toContain('verified customer payment');
    const none = attributePurposes({ projectSlug: 'some-market', projectPurpose: 'PROJECT' });
    expect(none.purposes).toEqual(['UNATTRIBUTED']);
    expect(none.basis[0]).toMatch(/no row names/);
  });

  it('tells a provider’s rate limit from a fault in the work', () => {
    expect(isRateLimited('model x: 429 Too Many Requests')).toBe(true);
    expect(isRateLimited('model x: quota exhausted for the day')).toBe(true);
    expect(isRateLimited('model x: no claim survived the evidence check')).toBe(false);
  });
});

describe('folding jobs and outputs into lanes and purposes (pure)', () => {
  it('counts a multi-purpose job in every purpose but its cost once, and the purposes sum back to the total', () => {
    const reading = summarizeResearchYield({
      since: iso(T0),
      until: iso(T0 + 3_600_000),
      jobs: [
        job({ id: 'a', purposes: ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES', 'FORWARD_EXPLORATION'], durationMs: 3_000, costMinor: 30 }),
        job({ id: 'b', lane: 'bin:claude', purposes: ['SELF_IMPROVEMENT'], durationMs: 2_000, costMinor: 10, queueWaitMs: 1_500 }),
        job({ id: 'c', purposes: ['UNATTRIBUTED'], outcome: 'FAILED', failureCause: 'timeout', rateLimited: false }),
        job({ id: 'd', outcome: 'FAILED', failureCause: 'whatever', rateLimited: true }),
        job({ id: 'a', purposes: ['BROAD_DISCOVERY'], durationMs: 99_999 }), // the same job read twice is one job
      ],
      outputs: [
        { kind: 'ACCEPTED_CLAIM', id: 'c1', lane: 'free-lane:m', purposes: ['BROAD_DISCOVERY', 'TRANSACTION_ROUTES'], source: 'PRIMARY' },
        { kind: 'ACCEPTED_CLAIM', id: 'c2', lane: 'free-lane:m', purposes: ['BROAD_DISCOVERY'], source: 'SECONDARY' },
        { kind: 'QUALIFIED_POSITION', id: 'o1', lane: 'free-lane:m', purposes: ['TRANSACTION_ROUTES'] },
        { kind: 'PAID_TRANSACTION', id: 'p1', lane: 'bin:claude', purposes: ['OPERATING_SUPPORT'] },
      ],
    });
    expect(reading.costCountedOnce).toMatchObject({ jobs: 4, totalJobMs: 7_000, purposeJobMs: 7_000, holds: true });
    expect(reading.total.submissions).toBe(4);
    expect(reading.total.completions).toBe(2);
    expect(reading.total.failures).toMatchObject({ total: 2, rateLimited: 1, other: 1 });
    expect(reading.total.failures.causes.map((c) => c.cause).sort()).toEqual(['rate limit or quota', 'timeout']);
    // Job a's 3 000 ms is split three ways; its count is in each purpose.
    expect(reading.purposes.TRANSACTION_ROUTES.jobMs).toBe(1_000);
    expect(reading.purposes.TRANSACTION_ROUTES.submissions).toBe(1);
    expect(reading.purposes.BROAD_DISCOVERY.jobMs).toBe(1_000 + 1_000);
    expect(reading.purposes.UNATTRIBUTED.submissions).toBe(1);
    // Money is not counted for jobs no row costs; it still sums once where it is.
    expect(reading.total.costMinor).toBe(40);
    expect(reading.total.uncostedJobs).toBe(2);
    expect(reading.costCountedOnce.purposeCostMinor).toBe(40);
    // Outputs go to every purpose they served, and once to the total.
    expect(reading.total.acceptedClaims).toBe(2);
    expect(reading.total.sourceQuality).toMatchObject({ primary: 1, secondary: 1, primaryShare: 0.5 });
    expect(reading.purposes.TRANSACTION_ROUTES.acceptedClaims).toBe(1);
    expect(reading.total.usefulResults).toBe(2);
    expect(reading.total.msPerUsefulResult).toBe(3_500);
    expect(reading.lanes['bin:claude']!.queueWait.medianMs).toBe(1_500);
    expect(reading.lanes['free-lane:m']!.submissions).toBe(3);
    expect(Object.keys(reading.purposes).sort()).toEqual([...RESEARCH_PURPOSES, 'UNATTRIBUTED'].sort());
  });
});

describe('research yield read from production rows', () => {
  let projectId = '';
  let layer: Layer;
  let userId = '';
  let fixture: TestProject;

  beforeEach(async () => {
    fixture = await freshProject();
    projectId = fixture.project.id;
    layer = await fixture.layerByName('Discovery Logic');
    userId = (await createUser({ email: `ry-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  });

  async function packet(title: string): Promise<{ orchestrationId: string; fragmentId: string }> {
    const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
    const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title, assignment: 'q', provider: 'WORKER', autoApprove: false });
    await createFragments([
      {
        orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
        requiredEvidence: [{ id: 'demand_pattern', description: 'buyers repeatedly paying', necessity: 'CONDITIONAL' }],
        acceptableSourceTypes: ['a price page'], excludedSourceTypes: ['a forecast'], completionCriteria: ['two dated examples'],
        minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'market-signal', question: 'q', dependsOn: [], attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    const [fragment] = await currentFragments(orchestration.id);
    await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
    return { orchestrationId: orchestration.id, fragmentId: fragment!.id };
  }

  function manifest(orchestrationId: string): BinManifest {
    return {
      objective: 'Improve how Brain judges sources.', why: 'Brain improvement.',
      lineage: { projectId, layerId: null, goal: null, orchestrationId },
      units: [], acceptableSources: ['the repository'], excludedSources: ['anything else'], evidence: ['a test'], outputs: ['a change'],
      authorizedActions: ['read'], prohibitedActions: ['spend'], budgetUnits: 1, retry: { maxAttempts: 2, backoffSeconds: 30 }, stoppingConditions: ['done'],
    };
  }

  it('measures every lane, attributes jobs to purposes, counts a two-purpose job’s cost once, and keeps the unattributed', async () => {
    const now = Date.now();
    const since = iso(now - 10 * 60_000);
    const until = iso(now + 10 * 60_000);
    // A goal with a target, and a constructed round Brain composed for it.
    const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: iso(now + 25 * 86_400_000), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
      capitalCeilingCents: 300_000, capitalBeforeProofCents: 37_500, hoursCeiling: 200, now: new Date(now - 60_000),
    } as Parameters<typeof setTarget>[0])).ok).toBe(true);
    const round = await openConstructedRound({ goal: (await getWorkstream(g.id))!, projectId, key: 'k1', title: 'Constructed: bookkeeping', question: 'Which firms outsource bookkeeping?' });
    const goalPacket = await packet('goal research');
    const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'q', whyNow: 'goal', idempotencyKey: `m:${round!.candidateId}`, candidateId: round!.candidateId });
    await getDb().run('UPDATE russell_missions SET orchestration_id = ? WHERE id = ?', [goalPacket.orchestrationId, mission.id]);
    const [claim] = await insertClaims([{
      orchestrationId: goalPacket.orchestrationId, fragmentId: goalPacket.fragmentId, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: 'Dental practices outsource monthly bookkeeping for 300 to 600 USD a month.', sourceUrl: 'https://example.test/bookkeeping',
      sourceTitle: 'A price page', sourcePublisher: 'A publisher', sourceDate: iso(now - 3 * 86_400_000).slice(0, 10),
      evidenceExcerpt: 'x', evidenceLocator: 'the page', evidenceLane: 'demand_pattern', opportunitySignal: null, closesOn: null,
      retrievedAt: iso(now - 86_400_000).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `ry|${goalPacket.fragmentId}`, primarySource: true,
    } as Parameters<typeof insertClaims>[0][number]]);
    await decideClaim(claim!.id, { accepted: true });
    const doc = await addDocument(fixture, 'Discovery Logic', 'v9.9');
    await getDb().run('UPDATE research_orchestrations SET document_id = ?, completed_at = ? WHERE id = ?', [doc.id, iso(now), goalPacket.orchestrationId]);
    const item = await enqueueWork({
      projectId, workType: 'RESEARCH_FRAGMENT', payload: workType('RESEARCH_FRAGMENT').validate({}),
      orchestrationId: goalPacket.orchestrationId, fragmentId: goalPacket.fragmentId, createdByType: 'SYSTEM',
    });
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', projectId, workItemId: item.id, workloadClass: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', reason: 'model runpod/Qwen/Qwen3-4B', durationMs: 4_000, evidenceClass: 'MEASURED' } as Parameters<typeof recordBinEvent>[0]);
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', projectId, workItemId: item.id, workloadClass: 'RESEARCH_FRAGMENT', outcome: 'FAILED', reason: 'model groq/llama: 429 rate limit exceeded', durationMs: 500, evidenceClass: 'MEASURED' } as Parameters<typeof recordBinEvent>[0]);
    // A free-lane job nothing attributes: no orchestration, an ordinary project.
    const loose = await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', payload: workType('RESEARCH_FRAGMENT').validate({}), createdByType: 'SYSTEM' });
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', projectId, workItemId: loose.id, workloadClass: 'RESEARCH_FRAGMENT', outcome: 'FAILED', reason: 'model groq/llama: no claim survived the evidence check', durationMs: 700, evidenceClass: 'MEASURED' } as Parameters<typeof recordBinEvent>[0]);
    // A bin a worker held, recorded as Brain improvement.
    const brainPacket = await packet('source judging');
    const bin = await createBin({ projectId, layerId: layer.id, kind: 'RESEARCH_PACKET', title: 'Source judging', objective: 'Improve how Brain judges sources.', manifest: manifest(brainPacket.orchestrationId), completionContract: 'RESEARCH_PACKET_V1', orchestrationId: brainPacket.orchestrationId, createdByType: 'SYSTEM', createdById: 'test' } as Parameters<typeof createBin>[0]);
    await getDb().run(`UPDATE bins SET purpose = 'BRAIN_IMPROVEMENT', state = 'COMPLETE' WHERE id = ?`, [bin.id]);
    await recordBinEvent({ eventType: 'BIN_ASSIGNED', projectId, binId: bin.id, provider: 'claude', leaseGeneration: 1 } as Parameters<typeof recordBinEvent>[0]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await recordBinEvent({ eventType: 'BIN_TERMINAL', projectId, binId: bin.id, leaseGeneration: 1, outcome: 'COMPLETE' } as Parameters<typeof recordBinEvent>[0]);
    // An opening the goal's research filed, about which the round's candidate asked, and a payment on it.
    const opening = await createOpportunity({
      projectId, cashModeId: (await getCashMode(projectId))!.id, ownerUserId: userId, title: 'Monthly bookkeeping for dental practices',
      mechanism: 'EXPLICIT_PAID_REQUEST', source: 'RESEARCH', currency: 'USD', orchestrationId: goalPacket.orchestrationId, fragmentId: goalPacket.fragmentId,
    } as Parameters<typeof createOpportunity>[0]);
    await getDb().run(
      `UPDATE cash_opportunities SET payer = 'dental practices', price_cents = 45000, fulfillment_owner = 'remote bookkeeper', buying_signal = 'posted request',
              offer_scope = 'monthly close', acceptance_condition = 'reconciled books', candidate_id = ? WHERE id = ?`,
      [round!.candidateId, opening.id],
    );
    expect((await recordMoney({ projectId, opportunityId: opening.id, kind: 'CUSTOMER_PAYMENT', amountCents: 45_000, currency: 'USD', verifiedReference: 'pi_ry', recordedBy: userId, idempotencyKey: 'ry-pay' })).ok).toBe(true);

    const reading = await researchYieldByPurpose({ since, until });

    // Lanes: the GPU model, the other free-lane model and the dispatched bin.
    expect(reading.lanes['free-lane:runpod/Qwen/Qwen3-4B']).toMatchObject({ submissions: 1, completions: 1, jobMs: 4_000 });
    expect(reading.lanes['free-lane:groq/llama']!.failures).toMatchObject({ total: 2, rateLimited: 1, other: 1 });
    expect(reading.lanes['bin:claude']).toMatchObject({ submissions: 1, completions: 1 });
    expect(reading.total.submissions).toBe(4);
    expect(reading.total.queueWait.measured).toBe(4);

    // Purposes: the goal's job is a constructed route about an opening that has been paid — two purposes.
    const goalJob = reading.attributions.find((a) => a.lane === 'free-lane:runpod/Qwen/Qwen3-4B')!;
    expect(goalJob.purposes.sort()).toEqual(['OPERATING_SUPPORT', 'TRANSACTION_ROUTES']);
    expect(goalJob.basis.join(' ')).toContain('-mx-k1');
    expect(reading.attributions.find((a) => a.lane === 'bin:claude')!.purposes).toEqual(['SELF_IMPROVEMENT']);
    expect(reading.purposes.UNATTRIBUTED.submissions).toBe(1);

    // Cost counted once: the 4 000 ms two-purpose job is split, and purposes sum to the total.
    expect(reading.purposes.TRANSACTION_ROUTES.jobMs).toBeCloseTo(2_000 + 250, 3);
    expect(reading.costCountedOnce.holds).toBe(true);
    expect(reading.costCountedOnce.jobs).toBe(4);
    expect(reading.costCountedOnce.purposeJobMs).toBeCloseTo(reading.costCountedOnce.totalJobMs, 3);

    // Outputs, each counted once in the total and attributed to the lane that produced it.
    expect(reading.total).toMatchObject({ acceptedClaims: 1, packetsFiled: 1, newMechanisms: 1, qualifiedPositions: 1, executableOffers: 1, paidTransactions: 1 });
    expect(reading.total.sourceQuality.primary).toBe(1);
    expect(reading.lanes['free-lane:runpod/Qwen/Qwen3-4B']!.paidTransactions).toBe(1);
    expect(reading.purposes.OPERATING_SUPPORT.paidTransactions).toBe(1);
    expect(reading.total.usefulResults).toBe(4);
    expect(reading.total.msPerUsefulResult).not.toBeNull();
    // No row records a per-job money charge, so money per result is unknown rather than zero.
    expect(reading.total.costMinor).toBeNull();
    expect(reading.total.costMinorPerUsefulResult).toBeNull();

    // A window that ends before the work saw none of it, and the TEL-07-1 windows all read.
    const before = await researchYieldByPurpose({ since: iso(now - 3_600_000), until: iso(now - 30 * 60_000) });
    expect(before.total.submissions).toBe(0);
    const windows = await researchYieldWindows(until);
    expect(Object.keys(windows)).toEqual(['1h', '6h', '24h']);
    expect(windows['1h'].total.submissions).toBe(4);
  });
});

describe('the queue in front of each free-lane lane (pure, review finding F3)', () => {
  it('measures what waits now, and headroom only up to what the resource carried without overload', () => {
    const now = Date.parse('2026-11-14T01:00:00.000Z');
    const out = laneQueueFrom({
      nowMs: now,
      waitingSince: ['2026-11-14T00:00:00.000Z', '2026-11-14T00:30:00.000Z', null],
      models: [
        { model: 'api', target: 4, busy: 4, stableHigh: 10, gpu: false },
        { model: 'runpod/q', target: 4, busy: null, stableHigh: 100, gpu: true },
        { model: 'tight', target: 6, busy: 6, stableHigh: 3, gpu: false },
      ],
      gpuCeiling: 16,
    });
    // Three jobs wait; two say since when, so the wait is the median of those two.
    expect(out['free-lane:api']).toMatchObject({ queued: 3, queueWaitMs: 30 * 60_000, saturated: true, slotsLimit: 10, quotaHeadroom: 6, resource: 'PROVIDER_QUOTA', incrementalCostPerUnit: 0 });
    // A GPU is capped by its ceiling, and busy slots nobody measured never read as saturated.
    expect(out['free-lane:runpod/q']).toMatchObject({ saturated: false, slotsLimit: 16, quotaHeadroom: 12, resource: 'GPU' });
    // Past what the provider has carried there is no headroom, never a negative one.
    expect(out['free-lane:tight']!.quotaHeadroom).toBe(0);
    // Nothing waiting: no queue wait and no saturation, whatever is busy.
    const idle = laneQueueFrom({ nowMs: now, waitingSince: [], models: [{ model: 'api', target: 4, busy: 4, stableHigh: 10, gpu: false }], gpuCeiling: 16 });
    expect(idle['free-lane:api']).toMatchObject({ queued: 0, queueWaitMs: null, saturated: false });
  });
});
