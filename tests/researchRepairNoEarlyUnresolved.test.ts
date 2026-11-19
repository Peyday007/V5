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
import { claimWork, completeWork, enqueueWork, failWork, getWorkItem, listLeases } from '../server/repos/workQueue.ts';
import { readMetric } from '../server/services/improvement/scoreboard.ts';
import { RETRY_RULE, earlierFailedAttempts } from '../server/services/research/assignment.ts';
import { freshProject } from './helpers.ts';
import {
  MAX_RUNGS_PER_ATTEMPT,
  buildRepairPlan,
  describeRepairPlan,
  rungsForAttempt,
} from '../server/services/research/repair.ts';
import type { GateResult } from '../server/services/research/gate.ts';
import type { RepairPlan, RepairStrategy, ResearchFragment } from '../server/domain/types.ts';

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
 * The re-run the metric counts is told how the run before it ended.
 *
 * AUTO_RECOVERY_RATE ("Failures recovered automatically") reads one path only:
 * a work item the queue re-ran after an attempt failed or expired
 * (`work_items.attempt_count > 1`). A better repair plan never reaches it —
 * repairs mint new fragments and new items at attempt 1 — so the change that
 * can move it is on the re-run itself. Before this, the second claimant of a
 * failed item received the identical assignment with no word of the failure,
 * and repeated the same strategy ("retry repeating the same strategy",
 * "repeated failure"). The assignment now carries each earlier attempt's end,
 * read from the queue's own lease record.
 */
describe('a re-run of a failed work item carries how each earlier attempt ended', () => {
  async function readyNow(id: string): Promise<void> {
    await getDb().run("UPDATE work_items SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [id]);
  }

  it('reproduces the recorded failure class: a FAILED then EXPIRED item, re-claimed a third time', async () => {
    const { project } = await freshProject();
    const worker = (await createWorker({ name: 'retry-worker', createdByType: 'SYSTEM', createdById: 'test' })).id;
    const scopes = [{ projectId: project.id, scopes: ['queue:claim' as const] }];
    const item = await enqueueWork({
      projectId: project.id,
      workType: 'SYNTHETIC_ECHO',
      payload: { note: 'hello' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      maxAttempts: 3,
    });

    // Attempt 1 fails with the worker's own reason; the queue re-queues it.
    const [first] = await claimWork({ workerId: worker, scopes });
    expect(first?.attemptNumber).toBe(1);
    // A first attempt has nothing to avoid repeating.
    expect(earlierFailedAttempts(await listLeases(item.id), first!.leaseGeneration)).toEqual([]);
    const failed = await failWork(
      { workItemId: item.id, workerId: worker, leaseId: first!.leaseId, leaseGeneration: first!.leaseGeneration },
      { category: 'DEPENDENCY_UNAVAILABLE', detail: 'sec.gov refused the proxy (403)' },
    );
    expect(failed.ok && failed.item.state).toBe('QUEUED');
    await readyNow(item.id);

    // Attempt 2 runs out its lease with nothing recorded, and is reclaimed.
    const [second] = await claimWork({ workerId: worker, scopes });
    expect(second?.attemptNumber).toBe(2);
    await getDb().run("UPDATE work_items SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [item.id]);
    const [third] = await claimWork({ workerId: worker, scopes });
    expect(third?.attemptNumber).toBe(3);

    const earlier = earlierFailedAttempts(await listLeases(item.id), third!.leaseGeneration);
    expect(earlier.map((a) => [a.attemptNumber, a.outcome])).toEqual([
      [1, 'FAILED'],
      [2, 'EXPIRED'],
    ]);
    // Verbatim, so the next attempt can address the cause rather than guess it.
    expect(earlier[0]!.detail).toBe('sec.gov refused the proxy (403)');
    expect(earlier[1]!.heartbeats).toBe(0);
    // The current attempt is never reported as one of its own predecessors.
    expect(earlier.every((a) => a.leaseGeneration < third!.leaseGeneration)).toBe(true);
  });

  /**
   * The class the metric reads, end to end: AUTO_RECOVERY_RATE counts a work
   * item that failed at least once and then SUCCEEDED (numerator) against every
   * item that failed at least once and settled (denominator). Each item below is
   * driven through the queue's own operations, and the reading is taken from
   * `readMetric`, the function production's scoreboard calls — so this measures
   * the outcome the capability map names ("work_items SUCCEEDED after attempt
   * 1"), not a proxy for it.
   */
  it('a failed item re-run with its earlier failure in hand succeeds, and AUTO_RECOVERY_RATE counts it recovered', async () => {
    const { project } = await freshProject();
    const worker = (await createWorker({ name: 'recovery-worker', createdByType: 'SYSTEM', createdById: 'test' })).id;
    const scopes = [{ projectId: project.id, scopes: ['queue:claim' as const] }];
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const before = await readMetric('AUTO_RECOVERY_RATE', from, to);

    async function enqueue(note: string) {
      return await enqueueWork({
        projectId: project.id,
        workType: 'SYNTHETIC_ECHO',
        payload: { note },
        createdByType: 'SYSTEM',
        requiredScopes: ['queue:claim'],
        maxAttempts: 2,
      });
    }
    async function claim(id: string) {
      await readyNow(id);
      const claimed = await claimWork({ workerId: worker, scopes, limit: 10 });
      const mine = claimed.find((c) => c.workItemId === id);
      expect(mine).toBeDefined();
      return mine!;
    }
    const proofOf = (id: string, c: { leaseId: string; leaseGeneration: number }) => ({
      workItemId: id,
      workerId: worker,
      leaseId: c.leaseId,
      leaseGeneration: c.leaseGeneration,
    });

    // Recovered: attempt 1 fails, attempt 2 is handed that failure verbatim and succeeds.
    const recovered = await enqueue('recovered');
    const r1 = await claim(recovered.id);
    const r1Failed = await failWork(proofOf(recovered.id, r1), {
      category: 'DEPENDENCY_UNAVAILABLE',
      detail: 'sec.gov refused the proxy (403)',
    });
    expect(r1Failed.ok && r1Failed.item.state).toBe('QUEUED');
    const r2 = await claim(recovered.id);
    expect(r2.attemptNumber).toBe(2);
    const handed = earlierFailedAttempts(await listLeases(recovered.id), r2.leaseGeneration);
    expect(handed.map((a) => [a.attemptNumber, a.outcome, a.detail])).toEqual([
      [1, 'FAILED', 'sec.gov refused the proxy (403)'],
    ]);
    const done = await completeWork(proofOf(recovered.id, r2), { summary: 'read through brain_fetch_source' });
    expect(done.ok && done.item.state).toBe('SUCCEEDED');
    const settled = await getWorkItem(recovered.id);
    expect(settled?.state).toBe('SUCCEEDED');
    expect(settled?.attemptCount).toBe(2);

    // Repeated failure: both attempts fail, the item settles FAILED.
    const exhausted = await enqueue('exhausted');
    const e1 = await claim(exhausted.id);
    await failWork(proofOf(exhausted.id, e1), { category: 'DEPENDENCY_UNAVAILABLE', detail: 'refused' });
    const e2 = await claim(exhausted.id);
    const e2Failed = await failWork(proofOf(exhausted.id, e2), { category: 'DEPENDENCY_UNAVAILABLE', detail: 'refused again' });
    expect(e2Failed.ok && e2Failed.item.state).toBe('FAILED');

    // First-attempt success: never failed, so the metric must not count it at all.
    const clean = await enqueue('clean');
    const c1 = await claim(clean.id);
    const cleanDone = await completeWork(proofOf(clean.id, c1));
    expect(cleanDone.ok && cleanDone.item.state).toBe('SUCCEEDED');

    const after = await readMetric('AUTO_RECOVERY_RATE', from, to);
    expect(after.numerator - before.numerator).toBe(1);
    expect(after.denominator - before.denominator).toBe(2);
  });

  it('names both ways an attempt ends in the rule handed to the re-run', () => {
    expect(RETRY_RULE).toMatch(/Do not repeat/);
    expect(RETRY_RULE).toMatch(/EXPIRED/);
    expect(RETRY_RULE).toMatch(/FAILED/);
  });
});
