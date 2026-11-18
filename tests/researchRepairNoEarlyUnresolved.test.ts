/**
 * A non-final repair is a search, never a search paired with "give up".
 *
 * Recorded failure class CAPABILITY:RESEARCH.RECOVERY.RETRY ("repeated
 * failure", "retry repeating the same strategy"): the condition-keyed ladder
 * ends in DEFAULT_LADDER's MARK_UNRESOLVED, so with one search rung left and
 * attempts still paid for, the plan read [<rung>, 'MARK_UNRESOLVED'] and the
 * worker was told both to search and to say it is not established and stop.
 *
 * Pure: buildRepairPlan takes values, so the shape production stores (a
 * fragment whose repairPlan names the strategies it used) reproduces it.
 */
import { describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { createWorker } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import {
  claimWork,
  completeWork,
  enqueueWork,
  failWork,
  getWorkItem,
  type OwnershipProof,
} from '../server/repos/workQueue.ts';
import { readMetric } from '../server/services/improvement/scoreboard.ts';
import { assignmentFor } from '../server/services/research/assignment.ts';
import { freshProject } from './helpers.ts';
import {
  MAX_RUNGS_PER_ATTEMPT,
  buildRepairPlan,
  describeRepairPlan,
  rungsForAttempt,
} from '../server/services/research/repair.ts';
import type { GateResult } from '../server/services/research/gate.ts';
import type { ClaimedWork, RepairPlan, RepairStrategy, ResearchFragment } from '../server/domain/types.ts';

/**
 * Every fixture below is a complete value of its declared type, with no cast,
 * so a change to GateResult, ResearchFragment or RepairPlan fails the type
 * check here instead of leaving this test exercising a shape production no
 * longer has.
 */
const GATE: GateResult = {
  integrity: 'PASS',
  sufficiency: 'INSUFFICIENT',
  unresolvedRetrieval: [],
  claims: [],
  acceptedClaims: 0,
  rejectedClaims: 0,
  independentSources: 0,
  coverage: [],
  duplicateSourceGroups: [],
  failedConditions: ['COVERAGE'],
  reasons: ['no coverage'],
  unresolvedGaps: [],
};

/** Every rung the COVERAGE ladder plus the default ladder offers, except the last search rung. */
const ALL_BUT_ONE: RepairStrategy[] = [
  'FIND_PRIMARY_DATA',
  'TRY_DIFFERENT_REPOSITORIES',
  'USE_OFFICIAL_FILINGS',
  'USE_REGULATORY_RECORDS',
  'USE_PROCUREMENT_RECORDS',
  'USE_CLASSIFICATION_CODES',
  'CHANGE_TERMINOLOGY',
  'NARROW_THE_CLAIM',
];

/** The plan an earlier attempt stored: only the strategies it used matter to the next plan. */
function storedPlan(strategies: RepairStrategy[]): RepairPlan {
  return {
    failedRequirement: 'What is the market size?',
    affectedClaims: [],
    missingEvidence: 'A sourced market-size figure.',
    rejectedEvidence: [],
    unresolvedContradiction: null,
    ecosystemsAttempted: [],
    alternativeEcosystems: [],
    alternativeTerminology: [],
    alternativeClassifications: [],
    narrowerQuestion: null,
    splitRequired: false,
    remainingBudget: 2,
    strategies,
  };
}

function fragment(strategies: RepairStrategy[] | null): ResearchFragment {
  return {
    requirementIds: [],
    evidenceLane: null,
    whyItMatters: null,
    missingEvidence: null,
    whyExistingInsufficient: null,
    existingClaimIds: [],
    excludedScope: null,
    expectedClaimTypes: [],
    preferredSourceTypes: [],
    prohibitedEvidence: [],
    requiredComparisons: [],
    requiredCalculations: [],
    contradictionTargets: [],
    failureConditions: [],
    uncertaintyTolerance: null,
    priority: 5,
    estimatedEffort: null,
    maxRepairs: 2,
    splitFromId: null,
    repairPlan: strategies ? storedPlan(strategies) : null,
    cancelledReason: null,
    id: 'frg_market_size',
    orchestrationId: 'orch_1',
    projectId: 'proj_1',
    layerId: 'layer_1',
    fragmentIndex: 0,
    fragmentKey: 'market-size',
    question: 'What is the market size?',
    geography: null,
    timeframe: null,
    population: null,
    definitions: null,
    requiredEvidence: [],
    acceptableSourceTypes: [],
    excludedSourceTypes: [],
    completionCriteria: [],
    dependsOn: [],
    minIndependentSources: 1,
    nextRetryAt: null,
    blockCause: null,
    blockHost: null,
    archiveMarker: null,
    status: 'BLOCKED',
    attempt: 1,
    parentFragmentId: null,
    repairReason: null,
    repairStrategy: null,
    integrityVerdict: 'PASS',
    sufficiencyVerdict: 'INSUFFICIENT',
    verdictDetail: null,
    blockedReason: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    acceptedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function plan(
  failed: ResearchFragment,
  history: ResearchFragment[],
  remainingBudget: number,
  blockCause: 'SOURCES_UNREADABLE' | null = null,
) {
  return buildRepairPlan({
    fragment: failed,
    gate: GATE,
    history,
    claims: [],
    splitRequired: false,
    remainingBudget,
    blockCause,
  });
}

describe('repair plan: no early MARK_UNRESOLVED', () => {
  it('offers the last search rung alone, not paired with MARK_UNRESOLVED, while attempts remain', () => {
    const earlier = fragment(ALL_BUT_ONE.slice(0, 6));
    const failed = fragment(ALL_BUT_ONE.slice(6));
    const next = plan(failed, [earlier], 2);
    expect(next.strategies).toEqual(['REPLACE_ESTIMATE_WITH_RANGE']);
    expect(next.strategies).not.toContain('MARK_UNRESOLVED');
    expect(describeRepairPlan(next)).not.toMatch(/say so explicitly, list where you looked, and stop/);
  });

  it('never pairs MARK_UNRESOLVED with a search on the default ladder either', () => {
    const noConditions: GateResult = { ...GATE, failedConditions: [] };
    const next = buildRepairPlan({
      fragment: fragment(['FIND_PRIMARY_DATA', 'TRY_DIFFERENT_REPOSITORIES', 'CHANGE_TERMINOLOGY']),
      gate: noConditions,
      history: [],
      claims: [],
      splitRequired: false,
      remainingBudget: 3,
    });
    expect(next.strategies).toEqual(['NARROW_THE_CLAIM']);
  });

  it('still answers MARK_UNRESOLVED alone when no search rung is left', () => {
    const earlier = fragment(ALL_BUT_ONE);
    const failed = fragment(['REPLACE_ESTIMATE_WITH_RANGE']);
    expect(plan(failed, [earlier], 3).strategies).toEqual(['MARK_UNRESOLVED']);
  });

  it('still answers MARK_UNRESOLVED alone on the last attempt', () => {
    expect(plan(fragment(null), [], 1).strategies).toEqual(['MARK_UNRESOLVED']);
  });

  it('leaves the unreadable ladder unchanged', () => {
    expect(plan(fragment(null), [], 3, 'SOURCES_UNREADABLE').strategies).toEqual([
      'RESOLVE_CANONICAL_LINK',
      'INSPECT_ARCHIVED_SOURCES',
    ]);
    expect(plan(fragment(null), [], 1, 'SOURCES_UNREADABLE').strategies).toEqual(['MARK_UNRESOLVED']);
  });
});

/**
 * The runner's chain for one fragment, as `packetRunner.ts` drives it: attempt
 * `a` fails, the plan is built at `maxRepairs - a + 1`, and a plan that is only
 * MARK_UNRESOLVED mints nothing. Returns every plan the chain produced.
 */
function chain(failedConditions: string[], maxRepairs: number): RepairStrategy[][] {
  const gate = { ...GATE, failedConditions } as unknown as GateResult;
  const history: ResearchFragment[] = [];
  let current = fragment(null);
  const plans: RepairStrategy[][] = [];
  for (let attempt = 1; attempt <= maxRepairs; attempt++) {
    const next = buildRepairPlan({
      fragment: current,
      gate,
      history: [...history],
      claims: [],
      splitRequired: false,
      remainingBudget: Math.max(0, maxRepairs - attempt + 1),
    });
    plans.push(next.strategies);
    if (next.strategies.every((strategy) => strategy === 'MARK_UNRESOLVED')) break;
    history.push(current);
    current = fragment(next.strategies);
  }
  return plans;
}

/** Every search rung a chain's ladder offers, from its first plan's view of the ladder. */
function ladderLength(failedConditions: string[]): number {
  const gate = { ...GATE, failedConditions } as unknown as GateResult;
  const all = buildRepairPlan({
    fragment: fragment(null),
    gate,
    history: [],
    claims: [],
    splitRequired: false,
    remainingBudget: 2,
  });
  // At budget 2 every rung up to the cap is offered; count the rest by exhausting it.
  const seen = new Set<RepairStrategy>(all.strategies);
  let used = [...all.strategies];
  for (;;) {
    const more = buildRepairPlan({
      fragment: fragment(used),
      gate,
      history: [],
      claims: [],
      splitRequired: false,
      remainingBudget: 3,
    }).strategies.filter((strategy) => strategy !== 'MARK_UNRESOLVED');
    if (more.length === 0) return seen.size;
    for (const strategy of more) seen.add(strategy);
    used = [...used, ...more];
  }
}

const CONDITION_SETS: string[][] = [
  [],
  ['COVERAGE'],
  ['SCOPE_MATCH'],
  ['SOURCE_SUPPORTS'],
  ['SOURCE_VALIDITY'],
  ['DERIVATIONS'],
  ['CONTRADICTIONS'],
  ['COVERAGE', 'CONTRADICTIONS'],
  ['SOURCE_VALIDITY', 'DERIVATIONS'],
];

describe('repair plan: no rung stranded by a fixed width', () => {
  it('gives the last automatic repair every fresh rung up to the cap', () => {
    // Budget 2 is the last repair the runner mints; with three rungs left a
    // flat width of two left the third untried before the fragment ended.
    const earlier = fragment(['FIND_PRIMARY_DATA', 'TRY_DIFFERENT_REPOSITORIES', 'CHANGE_TERMINOLOGY']);
    const failed = fragment(['NARROW_THE_CLAIM']);
    const coverage = { ...GATE, failedConditions: ['COVERAGE'] } as unknown as GateResult;
    const ordered = [
      'USE_OFFICIAL_FILINGS',
      'USE_REGULATORY_RECORDS',
      'USE_PROCUREMENT_RECORDS',
    ];
    const next = buildRepairPlan({
      fragment: failed,
      gate: coverage,
      history: [earlier, fragment(['USE_CLASSIFICATION_CODES', 'REPLACE_ESTIMATE_WITH_RANGE'])],
      claims: [],
      splitRequired: false,
      remainingBudget: 2,
    });
    expect(next.strategies).toEqual(ordered);
  });

  it('widens only the last automatic repair, to at most three', () => {
    expect(rungsForAttempt(3, 2)).toBe(3);
    expect(rungsForAttempt(1, 2)).toBe(2);
    expect(rungsForAttempt(9, 2)).toBe(MAX_RUNGS_PER_ATTEMPT);
    expect(rungsForAttempt(4, 3)).toBe(2);
    expect(rungsForAttempt(5, 3)).toBe(2);
    expect(rungsForAttempt(2, 5)).toBe(2);
  });

  it('over every condition set and budget, tries at least as many rungs as a flat two and never strands one it could have offered', () => {
    let scenarios = 0;
    let rungsTriedBefore = 0;
    let rungsTriedNow = 0;
    let strandedBefore = 0;
    let strandedNow = 0;
    for (const conditions of CONDITION_SETS) {
      const length = ladderLength(conditions);
      for (let maxRepairs = 1; maxRepairs <= 4; maxRepairs++) {
        scenarios++;
        const plans = chain(conditions, maxRepairs);
        const searches = plans.filter((plan) => !plan.includes('MARK_UNRESOLVED'));
        // Never a search paired with "stop", and never a rung twice.
        for (const plan of plans) {
          if (plan.includes('MARK_UNRESOLVED')) expect(plan).toEqual(['MARK_UNRESOLVED']);
        }
        const tried = searches.flat();
        expect(new Set(tried).size).toBe(tried.length);

        const automaticRepairs = Math.max(0, maxRepairs - 1);
        const before = Math.min(length, 2 * automaticRepairs);
        rungsTriedBefore += before;
        rungsTriedNow += tried.length;
        strandedBefore += automaticRepairs > 0 ? length - before : 0;
        strandedNow += automaticRepairs > 0 ? length - tried.length : 0;
        expect(tried.length).toBeGreaterThanOrEqual(before);
        // A ladder the automatic attempts can cover — two per earlier repair,
        // up to the cap on the last — is covered whole.
        const reach = automaticRepairs > 0 ? 2 * (automaticRepairs - 1) + MAX_RUNGS_PER_ATTEMPT : 0;
        if (length <= reach) expect(tried.length).toBe(length);
      }
    }
    // The measured reach of the change across the runner's whole state space
    // here: 36 chains, and strictly more alternates entered before giving up.
    expect(scenarios).toBe(CONDITION_SETS.length * 4);
    expect(rungsTriedNow).toBeGreaterThan(rungsTriedBefore);
    expect(strandedNow).toBeLessThan(strandedBefore);
  });
});

/**
 * The recorded failure class as the metric reads it.
 *
 * AUTO_RECOVERY_RATE counts `work_items` with `attempt_count > 1` that settled
 * SUCCEEDED or FAILED — an item the queue handed out again after it failed.
 * This drives one research fragment item through exactly that, on the real
 * queue and the real assignment a worker reads: attempt 1 fails, the queue
 * requeues it, attempt 2 reads its assignment and completes. Before the change
 * attempt 2's assignment was identical to attempt 1's — nothing in it said the
 * first attempt failed or why — so the retry could only repeat the strategy
 * that had just failed.
 */
describe('a failed research work item recovered on a later attempt', () => {
  it('tells the retry why the earlier attempt failed, and the metric counts the recovery', async () => {
    const fixture = await freshProject();
    const layer = await fixture.layerByName('Monetization Logic');
    const projectId = fixture.project.id;
    const run = await createRun({
      projectId, layerId: layer.id, runType: 'FOUNDATION',
      status: 'PLANNED', provider: 'WORKER', prompt: 'x',
    });
    const orchestration = await createOrchestration({
      projectId, layerId: layer.id, runId: run.id,
      title: 'Market size', assignment: 'Size the market.', provider: 'WORKER', autoApprove: false,
    });
    const [frag] = await createFragments([{
      orchestrationId: orchestration.id, projectId, layerId: layer.id,
      fragmentIndex: 0, fragmentKey: 'market-size',
      question: 'What is the market size?', geography: null, timeframe: '2026',
      population: null, definitions: null,
      requiredEvidence: [{ id: 'figure', description: 'a sourced figure', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['report'], excludedSourceTypes: [],
      completionCriteria: ['One sourced figure.'], dependsOn: [], minIndependentSources: 1,
      maxRepairs: 2, status: 'QUEUED',
    }]);
    const queued = await enqueueWork({
      projectId,
      workType: 'RESEARCH_FRAGMENT',
      payload: {},
      requiredScopes: ['queue:claim'],
      maxAttempts: 3,
      orchestrationId: orchestration.id,
      fragmentId: frag!.id,
      createdByType: 'SYSTEM',
    });
    const workerId = (await createWorker({ name: 'retry-worker', createdByType: 'SYSTEM', createdById: 'test' })).id;
    const claim = async (): Promise<OwnershipProof> => {
      const [won] = await claimWork({
        workerId,
        scopes: [{ projectId, scopes: ['queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'] }],
        limit: 1,
      });
      expect(won?.workItemId).toBe(queued.id);
      const c = won as ClaimedWork;
      return { workItemId: c.workItemId, workerId, leaseId: c.leaseId, leaseGeneration: c.leaseGeneration };
    };

    // Attempt 1: the worker's search fails and it says what it hit.
    const first = await claim();
    const firstView = await assignmentFor((await getWorkItem(queued.id))!);
    expect(firstView?.earlierAttempts).toEqual([]);
    const why = 'Every market report found was paywalled; the trade-association route returned nothing.';
    expect(await failWork(first, { category: 'DEPENDENCY_UNAVAILABLE', detail: why })).toMatchObject({ ok: true });
    expect((await getWorkItem(queued.id))?.state).toBe('QUEUED');

    // The queue's backoff, without waiting for real time.
    await getDb().run("UPDATE work_items SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [queued.id]);

    // Attempt 2: the same item, handed out again — and told what stopped attempt 1.
    const second = await claim();
    const retryView = await assignmentFor((await getWorkItem(queued.id))!);
    expect(retryView?.earlierAttempts).toEqual([
      { attemptNumber: 1, outcome: 'FAILED', detail: why, endedAt: expect.any(String) },
    ]);
    expect(retryView).not.toEqual(firstView);

    expect(await completeWork(second, { summary: 'figure from the statistical agency' })).toMatchObject({ ok: true });
    const settled = await getWorkItem(queued.id);
    expect(settled).toMatchObject({ state: 'SUCCEEDED', attemptCount: 2 });

    // And it is exactly what the capability's metric reads as one recovery.
    const metric = await readMetric('AUTO_RECOVERY_RATE', '2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z');
    expect(metric).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
  });
});
