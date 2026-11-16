/**
 * §111, the pure rules: alternatives must be materially different, the evaluator's
 * selection (noise, guards, ties, nothing qualifying), approach-type learning with
 * retirement, the loop's yield, the shared result shape, and the verified cycle's
 * new step — a change is an improvement only once it beat an alternative.
 */
import { describe, expect, it } from 'vitest';
import {
  approachScore,
  approachSignature,
  experimentYield,
  meetsTarget,
  parseBenchResult,
  rankApproachTypes,
  selectVariant,
  shouldRetire,
  validateApproaches,
  type Approach,
  type BenchSuite,
} from '../server/domain/evolution.ts';
import { EVOLUTION_SUITES, findSuite } from '../server/domain/evolutionSuites.ts';
import { verifiedCycle, type CycleFacts } from '../server/domain/engineeringDirector.ts';

const approach = (over: Partial<Approach> = {}): Approach => ({
  label: 'index',
  approachType: 'ALGORITHM_REPLACEMENT',
  approach: 'Replace the quadratic pairwise scan of plan branches with a sorted sweep keyed by deadline and reach.',
  ownerPaths: ['server/services/goals/plan.ts'],
  ...over,
});

describe('alternatives must be materially different', () => {
  it('accepts two approaches of different types and mechanisms', () => {
    const result = validateApproaches([
      approach(),
      approach({ label: 'cache', approachType: 'REMOVE_WORK', approach: 'Memoise every reconstruction input by its hash so unchanged ledgers never recompute their forecast.' }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('refuses fewer than two, too many, and malformed entries', () => {
    expect(validateApproaches([approach()])).toMatchObject({ ok: false, reason: expect.stringMatching(/at least two/) });
    const five = Array.from({ length: 5 }, (_, i) => approach({ label: `v${i}`, approach: `Variant ${i} mechanism number ${i} with distinct wording alpha${i} beta${i} gamma${i} delta${i}.` }));
    expect(validateApproaches(five)).toMatchObject({ ok: false, reason: expect.stringMatching(/at most 4/) });
    expect(validateApproaches([approach(), approach({ label: 'Index' })])).toMatchObject({ ok: false, reason: expect.stringMatching(/used twice/) });
    expect(validateApproaches([approach(), approach({ label: 'b', approach: 'too short' })])).toMatchObject({ ok: false, reason: expect.stringMatching(/40\+/) });
    expect(validateApproaches([approach(), approach({ label: 'b', approachType: 'VIBES' as never })])).toMatchObject({ ok: false, reason: expect.stringMatching(/approach_type/) });
  });

  it('refuses a near-duplicate of the same type, with the reason', () => {
    const result = validateApproaches([
      approach(),
      approach({ label: 'index2', approach: 'Replace the quadratic pairwise scan of plan branches with a sorted sweep keyed by reach and deadline, merged by binary search.' }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/near-duplicate/);
  });

  it('refuses one idea relabelled with another type on the same files', () => {
    const result = validateApproaches([
      approach(),
      approach({ label: 'relabel', approachType: 'PARAMETER', approach: 'Replace the quadratic pairwise scan of plan branches with a sorted sweep keyed by deadline and reach.' }),
    ]);
    expect(result.ok).toBe(false);
  });

  it('signs an approach by type, mechanism words and paths, ignoring case and order', () => {
    expect(approachSignature(approach({ approach: 'SORTED sweep, replacing the quadratic scan of plan branches keyed by deadline and reach.' }))).toBe(
      approachSignature(approach({ approach: 'Replacing the quadratic scan of plan branches: a sorted sweep keyed by reach and deadline.' })),
    );
    expect(approachSignature(approach())).not.toBe(approachSignature(approach({ approachType: 'PARAMETER' })));
  });
});

const higher: BenchSuite = {
  name: 't',
  capabilityClass: 'REASONING',
  description: 'test',
  primaryMetric: 'accuracy',
  direction: 'HIGHER',
  target: 0.95,
  noise: { absolute: 0.02 },
  guards: [{ metric: 'reach', direction: 'HIGHER', tolerance: 0.01 }],
  measures: { deficiencies: ['ECONOMIC_REASONING'], paths: [] },
};

describe('the evaluator selects one variant, or none', () => {
  const base = { accuracy: 0.8, reach: 0.5 };

  it('adopts the best variant that beats the baseline beyond noise with no guard regressed', () => {
    const s = selectVariant(base, [
      { id: 'a', metrics: { accuracy: 0.9, reach: 0.5 }, linesChanged: 50 },
      { id: 'b', metrics: { accuracy: 0.85, reach: 0.5 }, linesChanged: 10 },
    ], higher);
    expect(s).toMatchObject({ verdict: 'ADOPT', winner: 'a' });
    expect(s.ranking.map((r) => r.id)).toEqual(['a', 'b']);
    expect(s.ranking[0]!.reason).toMatch(/beyond noise/);
  });

  it('does not count an improvement within noise', () => {
    const s = selectVariant(base, [
      { id: 'a', metrics: { accuracy: 0.815, reach: 0.5 }, linesChanged: 5 },
      { id: 'b', metrics: { accuracy: 0.79, reach: 0.5 }, linesChanged: 5 },
    ], higher);
    expect(s.verdict).toBe('REJECTED_ALL');
    expect(s.ranking[0]!.reason).toMatch(/within noise/);
  });

  it('refuses a variant that regresses a guard past its tolerance, and adopts the next', () => {
    const s = selectVariant(base, [
      { id: 'fast-but-wrong', metrics: { accuracy: 0.95, reach: 0.4 }, linesChanged: 5 },
      { id: 'honest', metrics: { accuracy: 0.86, reach: 0.495 }, linesChanged: 5 },
    ], higher);
    expect(s).toMatchObject({ verdict: 'ADOPT', winner: 'honest' });
    expect(s.ranking.find((r) => r.id === 'fast-but-wrong')!.guardFailures[0]).toMatch(/reach/);
  });

  it('breaks a tie within noise by the smaller diff', () => {
    const s = selectVariant(base, [
      { id: 'big', metrics: { accuracy: 0.9, reach: 0.5 }, linesChanged: 400 },
      { id: 'small', metrics: { accuracy: 0.89, reach: 0.5 }, linesChanged: 40 },
    ], higher);
    expect(s).toMatchObject({ verdict: 'ADOPT', winner: 'small' });
    expect(s.rationale).toMatch(/smaller diff/);
  });

  it('reads LOWER-is-better metrics and relative noise', () => {
    const speed = findSuite('planSpeed')!;
    const s = selectVariant({ p50ms: 1000, reachDelta: 0 }, [
      { id: 'a', metrics: { p50ms: 980, reachDelta: 0 }, linesChanged: 1 },
      { id: 'b', metrics: { p50ms: 600, reachDelta: -0.005 }, linesChanged: 100 },
    ], speed);
    expect(s).toMatchObject({ verdict: 'ADOPT', winner: 'b' });
    expect(s.ranking.find((r) => r.id === 'a')!.beatsNoise).toBe(false);
  });

  it('says INSUFFICIENT without a baseline or with fewer than two scored variants', () => {
    expect(selectVariant(null, [{ id: 'a', metrics: { accuracy: 1, reach: 1 }, linesChanged: 1 }], higher).verdict).toBe('INSUFFICIENT');
    expect(selectVariant(base, [{ id: 'a', metrics: { accuracy: 1, reach: 1 }, linesChanged: 1 }, { id: 'b', metrics: null, linesChanged: 1 }], higher).verdict).toBe('INSUFFICIENT');
  });
});

describe('approach types are learned per capability class, and retired when they keep losing', () => {
  it('explores an untried type first, then prefers lift and wins', () => {
    expect(approachScore(null, 10)).toBe(Number.POSITIVE_INFINITY);
    const good = approachScore({ trials: 4, wins: 3, totalLift: 0.8 }, 10);
    const bad = approachScore({ trials: 4, wins: 0, totalLift: -0.2 }, 10);
    expect(good).toBeGreaterThan(bad);
  });

  it('retires a type only after five trials with a low win rate', () => {
    expect(shouldRetire({ trials: 4, wins: 0 })).toBe(false);
    expect(shouldRetire({ trials: 5, wins: 0 })).toBe(true);
    expect(shouldRetire({ trials: 6, wins: 1 })).toBe(false);
    const ranked = rankApproachTypes(
      [
        { approachType: 'PARAMETER', capabilityClass: 'ALGORITHM', trials: 6, wins: 0, totalLift: 0, retiredAt: null },
        { approachType: 'REMOVE_WORK', capabilityClass: 'ALGORITHM', trials: 3, wins: 2, totalLift: 0.6, retiredAt: null },
      ],
      'ALGORITHM',
    );
    expect(ranked.at(-1)).toMatchObject({ approachType: 'PARAMETER', retired: true });
    expect(ranked.find((r) => r.approachType === 'REMOVE_WORK')!.retired).toBe(false);
  });
});

describe("the loop's own metric", () => {
  it('counts adoptions per decided experiment and the median hours from identification', () => {
    const y = experimentYield([
      { createdAt: '2026-11-01T00:00:00Z', identifiedAt: '2026-10-31T00:00:00Z', decidedAt: '2026-11-02T00:00:00Z', verdict: 'ADOPT' },
      { createdAt: '2026-11-01T00:00:00Z', decidedAt: '2026-11-01T12:00:00Z', verdict: 'REJECTED_ALL' },
      { createdAt: '2026-11-03T00:00:00Z', decidedAt: null, verdict: null },
    ]);
    expect(y).toMatchObject({ experiments: 3, decided: 2, adopted: 1, rejectedAll: 1, adoptedPerExperiment: 0.5, medianHoursToAdoption: 48 });
  });
});

describe('the shared result shape and the registered suites', () => {
  it('parses the evaluator JSON and refuses what is not it', () => {
    const ok = parseBenchResult({ suite: 'feasibility', sha: 'abc123', ref: 'evo/x', cases: [{ id: 'c1', pass: true, score: 1, ms: 3 }], metrics: { accuracy: 0.9 }, ranAt: '2026-11-15T00:00:00Z' });
    expect(ok.ok).toBe(true);
    expect(parseBenchResult({ suite: 'feasibility', sha: 'abc', metrics: { accuracy: 'high' }, ranAt: '2026-11-15T00:00:00Z' }).ok).toBe(false);
    expect(parseBenchResult({ suite: 'feasibility', sha: 'abc', metrics: {}, ranAt: 'yesterday' }).ok).toBe(false);
  });

  it('declares feasibility, planSpeed and mootRequests with their targets and guards', () => {
    expect(EVOLUTION_SUITES.map((s) => s.name)).toEqual(['feasibility', 'planSpeed', 'mootRequests']);
    const f = findSuite('feasibility')!;
    expect(meetsTarget(f, 0.96, null)).toBe(true);
    expect(meetsTarget(f, 0.9, null)).toBe(false);
    const p = findSuite('planSpeed')!;
    expect(meetsTarget(p, 700, null)).toBeNull();
    expect(meetsTarget(p, 700, 1000)).toBe(false);
    expect(meetsTarget(p, 590, 1000)).toBe(true);
    expect(p.guards).toEqual([{ metric: 'reachDelta', direction: 'HIGHER', tolerance: 0.01 }]);
    const m = findSuite('mootRequests')!;
    expect(meetsTarget(m, 1, null)).toBe(true);
    expect(meetsTarget(m, 0.95, null)).toBe(false);
    expect(m.guards.map((g) => g.metric)).toEqual(['falseWithdraw', 'historyLost']);
  });
});

describe('a verified cycle compared alternatives first', () => {
  const facts = (over: Partial<CycleFacts> = {}): CycleFacts => ({
    candidateId: 'imp_winner',
    title: 't',
    deficiency: 'CAPABILITY_BELOW_TARGET',
    problem: 'p',
    goalId: null,
    goalTitle: null,
    origin: 'OPERATOR',
    commissionedByRun: 'opr_1',
    intervention: 'ENGINEERING',
    campaignId: 'fcp_w',
    factory: { status: 'LIVE', prUrl: 'u', mergeSha: 'm', deployed: true, verified: true, changedPaths: [], tests: 'ok' },
    measurement: { metric: 'X', before: 1, after: 2, verdict: 'IMPROVED' },
    decision: 'KEPT',
    decisionReason: 'r',
    decidedAt: '2026-11-12T10:00:00.000Z',
    status: 'RESOLVED',
    goal: { effect: 'IMPROVED', reasons: [] },
    evaluation: { runId: 'opr_2', recordedAt: '2026-11-12T11:00:00.000Z', lesson: 'l' },
    alternatives: { experimentId: 'evx_1', variantsEvaluated: 2, verdict: 'ADOPT', winnerCandidateId: 'imp_winner', winnerCampaignId: 'fcp_w', winnerHeadSha: 'h' },
    ...over,
  });

  it('passes only with two evaluated variants, ADOPT, and the merged change being the selected one', () => {
    expect(verifiedCycle(facts()).verified).toBe(true);
    expect(verifiedCycle(facts()).steps.ALTERNATIVES_COMPARED).toBeNull();
    expect(verifiedCycle(facts({ alternatives: null })).steps.ALTERNATIVES_COMPARED).toMatch(/no experiment/);
    expect(verifiedCycle(facts({ alternatives: { ...facts().alternatives!, variantsEvaluated: 1 } })).steps.ALTERNATIVES_COMPARED).toMatch(/at least two/);
    expect(verifiedCycle(facts({ alternatives: { ...facts().alternatives!, verdict: 'REJECTED_ALL' } })).steps.ALTERNATIVES_COMPARED).toMatch(/REJECTED_ALL/);
    expect(verifiedCycle(facts({ alternatives: { ...facts().alternatives!, winnerCandidateId: 'imp_sibling' } })).steps.ALTERNATIVES_COMPARED).toMatch(/not the variant/);
    expect(verifiedCycle(facts({ alternatives: { ...facts().alternatives!, winnerCampaignId: 'fcp_other' } })).verified).toBe(false);
  });

  it('keeps every earlier step', () => {
    expect(Object.keys(verifiedCycle(facts()).steps)).toEqual([
      'IDENTIFIED_BY_HERMES',
      'COMMISSIONED_FACTORY',
      'ALTERNATIVES_COMPARED',
      'RELEASED_AND_VERIFIED',
      'RESULT_RECEIVED',
      'GOAL_EVALUATED',
    ]);
  });
});
