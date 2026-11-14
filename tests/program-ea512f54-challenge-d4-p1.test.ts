/**
 * CHAL-33: independent challenge scaled by consequence. A challenger names the
 * assumption, the test and a safer structure; shared exposure is detected and
 * repaired on the same worlds without inflating the probability; a minor
 * reversible action skips the heavy review.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRUTINY,
  challenge,
  challengePlan,
  detectSharedExposure,
  scrutinyFor,
  stepsOfPlan,
  type ActivityFacts,
  type ChallengeInput,
  type ScrutinyInput,
} from '../server/services/quant/challenge.ts';
import { assess, optimizePortfolio, readWithSafeguard, type Activity, type PortfolioProblem } from '../server/services/quant/portfolio.ts';

const act = (key: string, over: Partial<Activity> = {}): Activity => ({
  key, label: key, cash: [60], days: [2], justified: true, capital: 10, evidence: { sampleSize: 30 }, ...over,
});

/** Three attractive wedges that all ride on one supplier, and one large wedge that does not. */
function multiWedge(): { problem: PortfolioProblem; planned: PortfolioProblem } {
  const wedges = ['w1', 'w2', 'w3'].map((k) => act(k, { needs: ['supplier-x'] }));
  const independent = act('solo', { cash: [100], needs: ['supplier-y'] });
  const base = { target: 100, deadlineDays: 10, startingCapital: 100, worlds: 2000, resourceFailure: { 'supplier-x': 0.2, 'supplier-y': 0.2 } };
  return { planned: { ...base, activities: wedges }, problem: { ...base, activities: [...wedges, independent] } };
}

const heavy: ScrutinyInput = { potentialLoss: 5000, reference: 10000, irreversible: true, modelUncertainty: 0.4, correlatedExposure: 0.9, decisionImpact: 0.6 };
const minor: ScrutinyInput = { potentialLoss: 20, reference: 10000, irreversible: false, modelUncertainty: 0.1, correlatedExposure: 0.1, decisionImpact: 0.01 };

function input(over: Partial<ChallengeInput> = {}): ChallengeInput {
  const { problem, planned } = multiWedge();
  return { problem, result: optimizePortfolio(planned), action: heavy, producedBy: { model: 'brain-portfolio', dataSource: 'research:run-1' }, now: '2026-11-14T00:00:00Z', ...over };
}

describe('scrutinyFor: depth follows consequence, from numbers only', () => {
  it('a small reversible action gets basic invariants only', () => {
    expect(scrutinyFor(minor).tier).toBe('BASIC_INVARIANTS');
  });

  it('a large irreversible obligation gets the deep review', () => {
    const s = scrutinyFor(heavy);
    expect(s.tier).toBe('DEEP');
    expect(s.because.length).toBeGreaterThan(0);
  });

  it('a portfolio-wide assumption is deep even when the immediate loss is small', () => {
    expect(scrutinyFor({ ...minor, portfolioWide: true }).tier).toBe('DEEP');
  });

  it('each factor alone moves the tier', () => {
    expect(scrutinyFor({ ...minor, irreversible: true }).tier).toBe('STANDARD');
    expect(scrutinyFor({ ...minor, irreversible: true, potentialLoss: 600 }).tier).toBe('DEEP');
    expect(scrutinyFor({ ...minor, correlatedExposure: 0.6 }).tier).toBe('DEEP');
    expect(scrutinyFor({ ...minor, decisionImpact: 0.3 }).tier).toBe('STANDARD');
    expect(scrutinyFor({ ...minor, modelUncertainty: 0.9, potentialLoss: 500 }).tier).toBe('DEEP');
    expect(scrutinyFor({ ...minor, potentialLoss: 3000 }).tier).toBe('DEEP');
  });

  it('an unknown number is read as the worse case, never as zero', () => {
    expect(scrutinyFor({ ...minor, potentialLoss: Number.NaN }).tier).toBe('DEEP');
    expect(scrutinyFor({ ...minor, reference: 0 }).tier).toBe('DEEP');
    expect(scrutinyFor({ ...minor, modelUncertainty: Number.NaN }).tier).not.toBe('BASIC_INVARIANTS');
  });

  it('thresholds are numbers a caller may tighten', () => {
    expect(scrutinyFor(minor, { ...DEFAULT_SCRUTINY, basicLossShare: 0.001 }).tier).toBe('STANDARD');
  });
});

describe('acceptance: a multi-wedge plan with a correlated supplier dependency', () => {
  it('the apparently attractive plan rides on one supplier', () => {
    const { planned } = multiWedge();
    const r = optimizePortfolio(planned);
    expect(r.best!.keys.length).toBeGreaterThanOrEqual(2);
    expect(r.best!.reach).toBeGreaterThan(0.7);
  });

  it('detects the shared exposure, quantifies its joint failure and proposes a defensible repair recomputed on the same worlds', () => {
    const { problem, planned } = multiWedge();
    const best = optimizePortfolio(planned).best!;
    const report = detectSharedExposure(problem, best);
    const shared = report.exposures.find((e) => e.kind === 'RESOURCE' && e.id === 'supplier-x')!;
    expect(shared).toBeDefined();
    expect(shared.members.length).toBe(best.keys.length);
    expect(shared.failureProbability).toBe(0.2);
    expect(shared.reachIfItFails).toBe(0);
    expect(shared.reachAsPlanned).toBe(best.reach);

    const rec = report.recommended!;
    expect(rec).not.toBeNull();
    expect(rec.defensible).toBe(true);
    expect(rec.kind).toBe('INDEPENDENT_SUBSTITUTE');
    expect(rec.keys).toContain('solo');
    expect(rec.reachIfItFails).toBeGreaterThan(0.7);
    expect(rec.reading.reach).toBeGreaterThan(best.reach);

    // A reduction in commitment is also proposed, and its capital is visible.
    const reduced = report.proposals.find((p) => p.kind === 'REDUCED_COMMITMENT')!;
    expect(reduced.capitalAfter).toBeLessThan(reduced.capitalBefore);
  });

  it('refrains from inflating the probability: the figure is assess() of the recomputed plan, and coverage is not a 90% claim', () => {
    const { problem, planned } = multiWedge();
    const report = detectSharedExposure(problem, optimizePortfolio(planned).best!);
    for (const p of report.proposals) {
      expect(p.assurance).toEqual(assess(problem, p.reading));
      if (p.assurance.range) expect(p.assurance.range.low).toBeLessThan(p.reading.reach);
    }
    const rec = report.recommended!;
    expect(rec.reading.reach).toBeGreaterThan(0.9);
    expect(rec.assurance.claimsAtLeast90).toBe(false);
  });

  it('the deep challenge reports the shared dependency with the assumption, the test and the safer structure', () => {
    const r = challenge(input());
    expect(r.scrutiny.tier).toBe('DEEP');
    expect(r.ran).toContain('CORRELATED_STRESS');
    const f = r.findings.find((x) => x.mode === 'SHARED_DEPENDENCY')!;
    expect(f.subject).toBe('RESOURCE:supplier-x');
    expect(f.assumption).toContain('supplier-x');
    expect(f.test).toContain('reach falls');
    expect(f.saferStructure).toContain('solo');
    expect(f.measured!.reachAfter).toBe(0);
    expect(f.severity).toBe('BLOCKING');
  });

  it('where evidence cannot justify 90%, the answer is plan and evidence improvements, not the target declared met', () => {
    const r = challenge(input());
    expect(r.verdict).toBe('IMPROVE_PLAN_AND_EVIDENCE');
    expect(r.kinds.CALIBRATED_PROBABILITY?.claimsAtLeast90 ?? false).toBe(false);
    expect(r.improvements.some((i) => i.startsWith('plan:') && i.includes('solo'))).toBe(true);
    expect(r.findings.some((f) => f.mode === 'UNCALIBRATED_TARGET')).toBe(true);
  });
});

describe('a minor reversible action is not held up by the heavy review', () => {
  it('runs invariants only and passes on the same plan the deep review flags', () => {
    const r = challenge(input({ action: minor }));
    expect(r.scrutiny.tier).toBe('BASIC_INVARIANTS');
    expect(r.ran).toEqual(['INVARIANT_CHECK']);
    expect(r.exposure).toBeNull();
    expect(r.findings).toEqual([]);
    expect(r.improvements).toEqual([]);
    expect(r.verdict).toBe('PASS');
  });

  it('is still refused when a basic invariant fails', () => {
    const base = input({ action: minor });
    const broken = { ...base.problem, activities: base.problem.activities.map((a, i) => (i === 0 ? { ...a, days: [-1] } : a)) };
    const r = challenge({ ...base, problem: broken });
    expect(r.verdict).toBe('REFUSE');
    expect(r.findings[0]!.mode).toBe('INVARIANT');
  });
});

describe('every finding names the assumption, the test and a safer structure', () => {
  it('no finding is a bare "insufficient confidence"', () => {
    const r = challenge(input());
    expect(r.findings.length).toBeGreaterThan(5);
    for (const f of r.findings) {
      expect(f.assumption.trim().length).toBeGreaterThan(10);
      expect(f.test.trim().length).toBeGreaterThan(10);
      expect(f.saferStructure.trim().length).toBeGreaterThan(10);
      expect(`${f.assumption} ${f.test} ${f.saferStructure}`.toLowerCase()).not.toMatch(/^insufficient confidence\.?$/);
    }
  });

  it('covers the S-0476 failure modes when nothing is known, and drops them as facts arrive', () => {
    const unknown = new Set(challenge(input({ action: { ...heavy, correlatedExposure: 0, irreversible: false, potentialLoss: 1000, decisionImpact: 0.2 } })).findings.map((f) => f.mode));
    for (const mode of ['SURVIVORSHIP_BIAS', 'STALE_PRICES', 'POSTED_VS_PAID_PRICE', 'UNREACHABLE_BUYERS', 'SUPPLIER_CONSTRAINT', 'UNACCOUNTED_OBLIGATIONS', 'FAVOURABLE_CONVERSION', 'CASH_TIMING', 'REFUNDS', 'LEGAL_COUNTERPARTY'] as const) {
      expect(unknown.has(mode), mode).toBe(true);
    }
    const known: ActivityFacts = { priceObservedAt: '2026-11-10T00:00:00Z', priceKind: 'PAID', buyersReached: true, supplierCapacity: { available: 10, needed: 5 }, obligationsAccounted: true, conversion: { rate: 0.3, attempts: 50 }, payoutHoldDays: 0, refundRate: 0, counterpartyReviewed: true };
    const facts = Object.fromEntries(['w1', 'w2', 'w3', 'solo'].map((k) => [k, known]));
    const modes = new Set(challenge(input({ facts, action: { ...heavy, correlatedExposure: 0, irreversible: false, potentialLoss: 1000, decisionImpact: 0.2 } })).findings.map((f) => f.mode));
    for (const mode of ['STALE_PRICES', 'POSTED_VS_PAID_PRICE', 'UNREACHABLE_BUYERS', 'SUPPLIER_CONSTRAINT', 'UNACCOUNTED_OBLIGATIONS', 'FAVOURABLE_CONVERSION', 'CASH_TIMING', 'REFUNDS', 'LEGAL_COUNTERPARTY'] as const) {
      expect(modes.has(mode), mode).toBe(false);
    }
  });

  it('stale prices and regime change are named from the record', () => {
    const { problem } = multiWedge();
    const changed = { ...problem, activities: problem.activities.map((a) => ({ ...a, evidence: { sampleSize: 30, conditionsChanged: true } })) };
    const facts = { w1: { priceObservedAt: '2026-01-01T00:00:00Z' } };
    const r = challenge(input({ problem: changed, facts }));
    expect(r.findings.find((f) => f.mode === 'STALE_PRICES' && f.subject === 'w1')!.assumption).toContain('days ago');
    expect(r.findings.some((f) => f.mode === 'REGIME_CHANGE')).toBe(true);
  });

  it('a thin sample is named as unrepresentative data', () => {
    const { problem } = multiWedge();
    const thin = { ...problem, activities: problem.activities.map((a) => ({ ...a, evidence: { sampleSize: 5 } })) };
    const f = challenge(input({ problem: thin })).findings.find((x) => x.mode === 'UNREPRESENTATIVE_DATA')!;
    expect(f.assumption).toContain('5 observation');
    expect(f.test).toContain('20');
  });

  it('counterfactuals are measured, not asserted', () => {
    const tight: PortfolioProblem = { target: 110, deadlineDays: 10, worlds: 300, activities: [act('a'), act('b')] };
    const r = challenge(input({ problem: tight, result: optimizePortfolio(tight) }));
    const s = r.findings.find((f) => f.method === 'COUNTERFACTUAL');
    expect(s).toBeDefined();
    expect(s!.measured!.reachAfter).toBeLessThan(s!.measured!.reachBefore);
  });
});

describe('a model agreeing with itself is not independent validation', () => {
  it('refuses a check by the producing model or over the producing data', () => {
    const r = challenge(input({
      checks: [
        { method: 'INDEPENDENT_MODEL', by: 'brain-portfolio', dataSource: 'research:run-2', agrees: true },
        { method: 'HELD_OUT_EVIDENCE', by: 'other-model', dataSource: 'research:run-1', agrees: true },
      ],
    }));
    expect(r.independentValidation.counted).toEqual([]);
    expect(r.independentValidation.refusedAsSelfAgreement.length).toBe(2);
    expect(r.findings.some((f) => f.mode === 'SELF_AGREEMENT')).toBe(true);
  });

  it('counts a genuinely independent check, and a disagreeing one becomes a finding', () => {
    const agree = challenge(input({ checks: [{ method: 'PRODUCTION_HISTORY', by: 'ledger', dataSource: 'ledger:outcomes', agrees: true }] }));
    expect(agree.independentValidation.counted.length).toBe(1);
    expect(agree.findings.some((f) => f.mode === 'SELF_AGREEMENT')).toBe(false);
    const disagree = challenge(input({ checks: [{ method: 'INDEPENDENT_MODEL', by: 'other-model', dataSource: 'research:run-9', agrees: false, reach: 0.4 }] }));
    expect(disagree.independentValidation.disagreeing.length).toBe(1);
    expect(disagree.findings.find((f) => f.mode === 'SELF_AGREEMENT')!.assumption).toContain('disagrees');
  });

  it('`ran` names a counted independent check and never a refused one', () => {
    const refused = challenge(input({
      checks: [
        { method: 'INDEPENDENT_MODEL', by: 'brain-portfolio', dataSource: 'research:run-2', agrees: true },
        { method: 'HELD_OUT_EVIDENCE', by: 'other-model', dataSource: 'research:run-1', agrees: true },
      ],
    }));
    expect(refused.ran).not.toContain('INDEPENDENT_MODEL');
    expect(refused.ran).not.toContain('HELD_OUT_EVIDENCE');

    const counted = challenge(input({ checks: [{ method: 'INDEPENDENT_MODEL', by: 'other-model', dataSource: 'research:run-9', agrees: true }] }));
    expect(counted.independentValidation.counted.length).toBe(1);
    expect(counted.ran).toContain('INDEPENDENT_MODEL');

    const mixed = challenge(input({
      checks: [
        { method: 'PRODUCTION_HISTORY', by: 'ledger', dataSource: 'ledger:outcomes', agrees: true },
        { method: 'INDEPENDENT_MODEL', by: 'brain-portfolio', dataSource: 'research:run-1', agrees: true },
      ],
    }));
    expect(mixed.ran).toContain('PRODUCTION_HISTORY');
    expect(mixed.ran).not.toContain('INDEPENDENT_MODEL');
    expect(new Set(mixed.ran).size).toBe(mixed.ran.length);
  });
});

describe('four kinds of figure stay four', () => {
  it('scenario, calibrated probability, accepted plan and actual result are separate fields', () => {
    const r = challenge(input({ accepted: { by: 'owner', at: '2026-11-14T00:00:00Z' }, actual: { settled: 120, at: '2026-11-20T00:00:00Z', source: 'ledger:1' } }));
    expect(r.kinds.CALCULATED_SCENARIO.coverage).toBeGreaterThan(0.7);
    expect(r.kinds.CALIBRATED_PROBABILITY?.status).toBe('RANGE');
    expect(r.kinds.CALIBRATED_PROBABILITY!.range!.low).toBeLessThan(r.kinds.CALCULATED_SCENARIO.coverage!);
    expect(r.kinds.ACCEPTED_PLAN!.by).toBe('owner');
    expect(r.kinds.ACTUAL_RESULT!.settled).toBe(120);
  });

  it('nothing is accepted or actual until it is', () => {
    const r = challenge(input());
    expect(r.kinds.ACCEPTED_PLAN).toBeNull();
    expect(r.kinds.ACTUAL_RESULT).toBeNull();
  });

  it('uncalibrated inputs give no probability at all, only coverage', () => {
    const { problem, planned } = multiWedge();
    const uncal = { ...planned, activities: planned.activities.map((a) => ({ ...a, justified: false })) };
    const r = challenge(input({ problem: { ...problem, activities: problem.activities.map((a) => ({ ...a, justified: false })) }, result: optimizePortfolio(uncal) }));
    expect(r.kinds.CALIBRATED_PROBABILITY).toBeNull();
    expect(r.kinds.CALCULATED_SCENARIO.coverage).not.toBeNull();
    expect(r.verdict).toBe('IMPROVE_PLAN_AND_EVIDENCE');
  });
});

describe('no category, industry or example is a whitelist', () => {
  it('renaming every activity and dependency changes nothing but the names', () => {
    const rename = (s: string) => s.replace('w', 'catering-').replace('solo', 'software-licence').replace('supplier-', 'vendor-');
    const { problem, planned } = multiWedge();
    const mv = (p: PortfolioProblem): PortfolioProblem => ({
      ...p,
      resourceFailure: Object.fromEntries(Object.entries(p.resourceFailure!).map(([k, v]) => [rename(k), v])),
      activities: p.activities.map((a) => ({ ...a, key: rename(a.key), label: rename(a.key), needs: a.needs?.map(rename) })),
    });
    const a = challenge(input());
    const b = challenge(input({ problem: mv(problem), result: optimizePortfolio(mv(planned)) }));
    expect(b.scrutiny.tier).toBe(a.scrutiny.tier);
    expect(b.verdict).toBe(a.verdict);
    expect(b.findings.map((f) => f.mode).sort()).toEqual(a.findings.map((f) => f.mode).sort());
    expect(b.exposure!.recommended!.kind).toBe(a.exposure!.recommended!.kind);
  });
});

describe('readWithSafeguard: the one re-evaluation, exported', () => {
  it('matches the optimizer\'s own safeguard effect on the same worlds', () => {
    const p: PortfolioProblem = {
      target: 100, deadlineDays: 10, worlds: 500, riskCorrelation: { g: 0.9 },
      activities: [act('a', { riskGroup: 'g', cash: [0, 60, 60, 60] , days: [2, 2, 2, 2] }), act('b', { riskGroup: 'g', cash: [0, 60, 60, 60], days: [2, 2, 2, 2] })],
      safeguards: [{ key: 'ind', kind: 'INDEPENDENT_CHANNEL', decorrelate: ['b'] }],
    };
    const r = optimizePortfolio(p);
    const { before, after } = readWithSafeguard(p, r.best!.keys, p.safeguards![0]!);
    expect(before.reach).toBe(r.best!.reach);
    expect(after.reach).toBe(r.safeguardEffects![0]!.reachAfter);
  });

  it('refuses an unknown activity and an unstated resource failure', () => {
    const { problem } = multiWedge();
    expect(() => readWithSafeguard(problem, ['nope'], { key: 'x', kind: 'CONTINGENCY' })).toThrow('No activity');
    expect(() => readWithSafeguard({ ...problem, resourceFailure: {} }, ['w1'], { key: 'x', kind: 'CONTINGENCY' })).toThrow('No failure probability');
  });
});

describe('the running Brain challenges its own plans: optimizePortfolio carries the report on its assurance', () => {
  it('a multi-wedge plan riding on one supplier is challenged deep, from the plan alone, with no caller-supplied action', () => {
    const { planned } = multiWedge();
    const r = optimizePortfolio(planned);
    const c = r.assurance!.challenge!;
    expect(c).toBeDefined();
    expect(c.action.portfolioWide).toBe(true);
    expect(c.action.correlatedExposure).toBe(1);
    expect(c.scrutiny.tier).toBe('DEEP');
    expect(c.ran).toContain('CORRELATED_STRESS');
    const f = c.findings.find((x) => x.mode === 'SHARED_DEPENDENCY' && x.subject === 'RESOURCE:supplier-x')!;
    expect(f.assumption).toContain('supplier-x');
    expect(f.test).toContain('reach falls');
    expect(f.saferStructure.length).toBeGreaterThan(0);
    expect(c.exposures.find((e) => e.id === 'supplier-x')!.reachIfItFails).toBe(0);
    // The optimizer's own report is not independent validation.
    expect(c.findings.some((x) => x.mode === 'SELF_AGREEMENT')).toBe(true);
    // Coverage is not a 90% claim: the verdict asks for a better plan and evidence.
    expect(c.kinds.CALIBRATED_PROBABILITY?.claimsAtLeast90 ?? false).toBe(false);
    expect(c.verdict).toBe('IMPROVE_PLAN_AND_EVIDENCE');
  });

  it('when an independent substitute is in the problem, the plan read proposes it, recomputed, without inflating its probability', () => {
    const { problem } = multiWedge();
    // Force the shared-supplier wedges to be the recommendation, as an attractive plan would be, while the substitute stays available.
    const r = optimizePortfolio({ ...problem, activities: problem.activities.map((a) => (a.key === 'solo' ? { ...a, cash: [40] } : a)) });
    const c = r.assurance!.challenge!;
    expect(r.best!.keys.filter((k) => k !== 'solo').length).toBeGreaterThanOrEqual(2);
    expect(c.exposures.some((e) => e.id === 'supplier-x')).toBe(true);
    expect(c.proposals.length).toBeGreaterThan(0);
    for (const p of c.proposals) if (p.assurance.range) expect(p.assurance.range.low).toBeLessThan(p.reach);
    expect(c.proposals.every((p) => !p.assurance.claimsAtLeast90 || (p.assurance.range?.low ?? 0) >= 0.9)).toBe(true);
    expect(c.kinds.CALCULATED_SCENARIO.coverage).toBe(r.best!.reach);
  });

  it('a single small reversible step is not held up by the heavy review', () => {
    const r = optimizePortfolio({ target: 1000, deadlineDays: 10, worlds: 300, activities: [act('probe', { cash: [5], capital: 1 })] });
    const c = r.assurance!.challenge!;
    expect(c.action.portfolioWide).toBe(false);
    expect(c.scrutiny.tier).not.toBe('DEEP');
  });

  it('a tiny confident reversible step gets basic invariants only', () => {
    const r = optimizePortfolio({
      target: 100, deadlineDays: 10, worlds: 300,
      activities: [act('only', { cash: [200], capital: 1, evidence: { sampleSize: 100_000 } })],
    });
    const c = r.assurance!.challenge!;
    expect(c.scrutiny.tier).toBe('BASIC_INVARIANTS');
    expect(c.ran).toEqual(['INVARIANT_CHECK']);
    expect(c.verdict).toBe('PASS');
  });

  it('travels through serialization and a worker\'s structured clone, the way the plan read and its rows carry it', () => {
    const { planned } = multiWedge();
    const r = optimizePortfolio(planned);
    const json = JSON.parse(JSON.stringify(r));
    expect(json.assurance.challenge.verdict).toBe('IMPROVE_PLAN_AND_EVIDENCE');
    const cloned = structuredClone(r);
    expect(cloned.assurance!.challenge!.scrutiny.tier).toBe('DEEP');
    // Read twice, the same report.
    expect(r.assurance!.challenge).toBe(r.assurance!.challenge);
  });

  it('a caller may add facts and an independent check, and the optimizer\'s own check is refused as self-agreement', () => {
    const { planned } = multiWedge();
    const r = optimizePortfolio({
      ...planned,
      challenge: {
        checks: [
          { method: 'INDEPENDENT_MODEL', by: 'quant/portfolio optimizePortfolio', dataSource: 'x', agrees: true },
          { method: 'PRODUCTION_HISTORY', by: 'settlements', dataSource: 'ledger', agrees: true },
        ],
      },
    });
    const c = r.assurance!.challenge!;
    expect(c.independentValidation).toEqual({ counted: 1, refusedAsSelfAgreement: 1, disagreeing: 0 });
  });

  it('a challenge that cannot run is recorded as failed, never as a pass', () => {
    const { planned } = multiWedge();
    const r = optimizePortfolio(planned);
    // A problem the challenge cannot read (its resource failure probabilities withdrawn after optimizing).
    const broken = challengePlan({ ...planned, resourceFailure: {} }, r);
    expect(['CHALLENGE_FAILED', 'REFUSE']).toContain(broken.verdict);
    expect(broken.verdict).not.toBe('PASS');
  });

  it('a caller reading only the ranking may opt out, and nothing is attached', () => {
    const { planned } = multiWedge();
    expect(optimizePortfolio({ ...planned, challenge: false }).assurance!.challenge).toBeUndefined();
  });
});

describe('the plan\'s own steps are derived and gated on the tier each one earns (no caller-built ScrutinyInput)', () => {
  /** Three small reversible probes riding on one supplier, and an irreversible capacity purchase bought after proof. */
  function gatedPlan(): PortfolioProblem {
    const probes = ['p1', 'p2', 'p3'].map((k) =>
      act(k, {
        cash: [40], days: [2], capital: 1, needs: ['supplier-x'],
        gated: { gate: 'capacity', cash: [120], days: [6] },
      }),
    );
    return {
      target: 1000, deadlineDays: 10, startingCapital: 2000, worlds: 500,
      resourceFailure: { 'supplier-x': 0.2 },
      gates: [{ id: 'capacity', day: 3, tranche: 100, cost: 800 }],
      activities: probes,
    };
  }

  it('derives one step per member start and per gate purchase, each from the plan\'s numbers', () => {
    const r = optimizePortfolio(gatedPlan());
    const c = r.assurance!.challenge!;
    const keys = c.steps.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(r.best!.keys));
    const gate = c.steps.find((s) => s.key === 'gate:capacity')!;
    expect(gate.kind).toBe('GATE_PURCHASE');
    expect(gate.afterProof).toBe(true);
    expect(gate.action.irreversible).toBe(true);
    expect(gate.action.potentialLoss).toBe(800);
    expect(gate.members.sort()).toEqual([...r.best!.keys].sort());
    const probe = c.steps.find((s) => s.key === r.best!.keys[0])!;
    expect(probe.kind).toBe('START');
    expect(probe.action).toMatchObject({ potentialLoss: 1, reference: 1000, irreversible: false, portfolioWide: false });
    expect(stepsOfPlan(gatedPlan(), r)).toEqual(c.steps.map(({ scrutiny: _s, mayProceed: _m, heldBy: _h, ...step }) => step));
  });

  it('the plan as a whole is under deep review, yet a small reversible probe proceeds while the irreversible purchase is held', () => {
    const r = optimizePortfolio(gatedPlan());
    const c = r.assurance!.challenge!;
    expect(c.scrutiny.tier).toBe('DEEP');
    const gate = c.steps.find((s) => s.key === 'gate:capacity')!;
    expect(gate.scrutiny.tier).toBe('DEEP');
    expect(gate.mayProceed).toBe(false);
    expect(gate.heldBy.some((h) => h.includes('independent check'))).toBe(true);
    expect(c.proceedNow).not.toContain('gate:capacity');
    // Each probe shares supplier-x, but puts one unit of the plan's 803 at stake on it: basic invariants, and it proceeds.
    for (const k of r.best!.keys) {
      const s = c.steps.find((x) => x.key === k)!;
      expect(s.action.correlatedExposure).toBeLessThan(DEFAULT_SCRUTINY.basicExposure);
      expect(s.scrutiny.tier).toBe('BASIC_INVARIANTS');
      expect(s.mayProceed).toBe(true);
    }
    expect(c.proceedNow.sort()).toEqual([...r.best!.keys].sort());
  });

  it('a minor reversible step with nothing shared is cleared on basic invariants inside a deep-reviewed plan', () => {
    const big = act('big', { cash: [900], capital: 600, needs: ['supplier-y'], evidence: { sampleSize: 10_000 } });
    const tiny = act('tiny', { cash: [150], capital: 1, evidence: { sampleSize: 10_000 } });
    const r = optimizePortfolio({ target: 1000, deadlineDays: 10, startingCapital: 1000, worlds: 400, resourceFailure: { 'supplier-y': 0.05 }, activities: [big, tiny] });
    const c = r.assurance!.challenge!;
    expect(r.best!.keys.sort()).toEqual(['big', 'tiny']);
    expect(c.scrutiny.tier).toBe('DEEP');
    const t = c.steps.find((s) => s.key === 'tiny')!;
    expect(t.scrutiny.tier).toBe('BASIC_INVARIANTS');
    expect(t.mayProceed).toBe(true);
    expect(c.proceedNow).toContain('tiny');
    const b = c.steps.find((s) => s.key === 'big')!;
    expect(b.scrutiny.tier).toBe('DEEP');
    expect(b.mayProceed).toBe(false);
  });

  it('an independent agreeing check clears a deep step that has no blocking finding; a disagreeing one holds it', () => {
    const big = act('big', { cash: [1500], capital: 600, evidence: { sampleSize: 10_000 } });
    const tiny = act('tiny', { cash: [150], capital: 1, evidence: { sampleSize: 10_000 } });
    const base: PortfolioProblem = { target: 1000, deadlineDays: 10, startingCapital: 1000, worlds: 400, activities: [big, tiny] };
    const facts: Record<string, ActivityFacts> = Object.fromEntries(['big', 'tiny'].map((k) => [k, { priceObservedAt: '2026-11-10T00:00:00Z', priceKind: 'PAID', buyersReached: true, obligationsAccounted: true, conversion: { rate: 0.5, attempts: 100 }, payoutHoldDays: 0, refundRate: 0, counterpartyReviewed: true } as ActivityFacts]));
    const agreeing = optimizePortfolio({ ...base, challenge: { facts, now: '2026-11-14T00:00:00Z', checks: [{ method: 'PRODUCTION_HISTORY', by: 'settlements', dataSource: 'ledger', agrees: true }] } });
    const bOk = agreeing.assurance!.challenge!.steps.find((s) => s.key === 'big')!;
    expect(bOk.scrutiny.tier).toBe('DEEP');
    expect(bOk.heldBy).toEqual([]);
    expect(bOk.mayProceed).toBe(true);
    const disagreeing = optimizePortfolio({ ...base, challenge: { facts, now: '2026-11-14T00:00:00Z', checks: [{ method: 'PRODUCTION_HISTORY', by: 'settlements', dataSource: 'ledger', agrees: false }] } });
    expect(disagreeing.assurance!.challenge!.steps.find((s) => s.key === 'big')!.mayProceed).toBe(false);
  });

  it('a failed invariant or a failed challenge holds every step, the basic ones included', () => {
    const r = optimizePortfolio(gatedPlan());
    const broken = challengePlan({ ...gatedPlan(), resourceFailure: {} }, r);
    expect(broken.steps.length).toBeGreaterThan(0);
    expect(broken.steps.every((s) => !s.mayProceed)).toBe(true);
    expect(broken.proceedNow).toEqual([]);
  });

  it('a tier is a threshold over numbers: tightening the thresholds moves a step out of basic review', () => {
    const r = optimizePortfolio({ target: 100, deadlineDays: 10, worlds: 300, activities: [act('only', { cash: [200], capital: 1, evidence: { sampleSize: 100_000 } })] });
    expect(r.assurance!.challenge!.proceedNow).toEqual(['only']);
    const strict = challengePlan({ target: 100, deadlineDays: 10, worlds: 300, activities: [act('only', { cash: [200], capital: 1, evidence: { sampleSize: 100_000 } })] }, r, { thresholds: { ...DEFAULT_SCRUTINY, basicLossShare: 0 } });
    expect(strict.steps[0]!.scrutiny.tier).not.toBe('BASIC_INVARIANTS');
  });
});
