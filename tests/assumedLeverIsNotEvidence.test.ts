/**
 * Invariant 39, owner's rule (2026-11-20): "uncertainty never silently becomes
 * favorable evidence … An assumed deposit cannot automatically become
 * available working capital. A model-generated likelihood cannot automatically
 * become a real-world probability. … Keep potentially promising but
 * unverified opportunities available for further investigation. Prevent them
 * from being falsely represented as verified executable plans."
 *
 * The defect: the plan reconstruction adopted levers whose basis is
 * ASSUMPTION — a deposit "assumed accepted", a bundle whose close is assumed
 * ×0.5, a retainer, a referral partner's referrals a day, a price's demand
 * response — and the reach computed with those assumptions taken as true
 * became the candidate's reach and decided which plan was adopted (production
 * goal C: 25.3% reconstructed, 8.3% as held, 1.5% on measured campaign rates).
 *
 * Now the reach that ranks a strategy and that adopts and reports a plan is
 * the reading with every assumed move taken away; what the assumptions would
 * add is still reported, labelled as a hypothesis to test.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { MATERIAL_REACH, reconstructPlan, type Reconstruction, type StrategyChange, type VariantReading } from '../server/services/goals/reconstruction.ts';
import { adoptReconstruction, candidateSentence } from '../server/services/goals/plan.ts';
import { scoreOf } from '../server/services/goals/reasoning/directions.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';

/** The moves resting on an unmeasured assumption (a challenge or diagnostic test is no move). */
const assumedMovesOf = (changes: readonly StrategyChange[]) => changes.filter((c) => c.basis === 'ASSUMPTION' && c.dimension !== 'EVIDENCE' && !c.label.startsWith('test:'));

const openings = GOAL_10K_OPENINGS.map((o) => ({ opportunity: { id: o.opportunity.id, title: o.opportunity.title } }));

describe('an assumed lever is not evidence: the $10K goal with only assumption levers to pull', () => {
  // No bought capacity or channel (the ESTIMATE levers) and no exploration: every lift the reconstruction finds rests on an assumption.
  const portfolioInput = { ...GOAL_10K_LIMITS, measuredRates: GOAL_10K_RECORD, worlds: 800, seed: 11 };
  const baseline = evaluateGoalPortfolio({ ...portfolioInput, openings: GOAL_10K_OPENINGS });
  const read = reconstructPlan({ openings: GOAL_10K_OPENINGS, portfolio: portfolioInput, baseline, required: 0.9, levers: [], explore: null });

  it('the reconstruction lifts reach only through assumed moves, and reads the same plan without them', async () => {
    const r = await read;
    const moves = r.best.changes.filter((c) => !c.label.startsWith('test:'));
    expect(moves.length).toBeGreaterThan(0);
    expect(assumedMovesOf(moves)).toHaveLength(moves.length);
    expect(r.best.reach).toBeGreaterThan(r.baseline.reach + MATERIAL_REACH);
    expect(r.established).toBeDefined();
    expect(assumedMovesOf(r.established!.changes)).toEqual([]);
    expect(r.established!.reach).toBeLessThan(r.best.reach - MATERIAL_REACH);
    expect(r.confidence.statement).toMatch(/Without its \d+ assumed move\(s\) it reaches/);
  });

  it('the headline reach is the assumption-free reading, and the assumption-dependent figure is still reported, labelled', async () => {
    const r = await read;
    const { adoption, candidate } = adoptReconstruction({ reconstruction: r, baseline, openings });
    // Not adopted on its assumptions: the plan as held stays the candidate, so the headline is its reach.
    expect(adoption.source).toBe('BASELINE');
    expect(adoption.hypothetical).toBe(true);
    expect(candidate).toBeNull();
    const headline = baseline.best!.reach;
    expect(Math.abs(headline - r.established!.reach)).toBeLessThan(MATERIAL_REACH);
    expect(headline).toBeLessThan(r.best.reach - MATERIAL_REACH);
    // The upside is kept for investigation and said for what it is.
    expect(adoption.upside).toBeDefined();
    expect(adoption.upside!.reach).toBe(r.best.reach);
    expect(adoption.upside!.assumptions.length).toBeGreaterThan(0);
    expect(adoption.upside!.sentence).toMatch(/unmeasured assumption\(s\) hold .* a hypothesis to test by running each one's kill criterion, not evidence/);
    expect(adoption.reason).toContain(adoption.upside!.sentence);
  });
});

/* A reconstruction resting on one estimated move and two assumed ones, as goal C's did. */
const change = (over: Partial<StrategyChange>): StrategyChange => ({ dimension: 'TRANSACTION', label: 'bundle', detail: 'sell a bundle of 10 unit(s) at 10% off; close rate assumed ×0.5 until measured', cost: 0, basis: 'ASSUMPTION', startDay: { low: 0, high: 0 }, ...over });
function variant(over: Partial<VariantReading> = {}): VariantReading {
  return { key: 'as planned', changes: [], reach: 0.083, settledP10: 0, settledP50: 3000, settledP90: 9000, basis: 'COVERAGE', committed: 0, feasible: true, why: null, members: ['Opening o1'], ...over };
}
const leads = change({ dimension: 'ACQUISITION', label: 'marketplace leads', detail: 'buy qualified marketplace leads', cost: 300, basis: 'ESTIMATE' });
const deposit = change({ dimension: 'CASH_TIMING', label: 'deposit', detail: 'ask for a deposit of 30–50% at signing (assumed accepted)' });
const bundle = change({});
function goalC(over: Partial<Reconstruction> = {}): Reconstruction {
  return {
    required: 0.9,
    baseline: variant(),
    diagnosis: [],
    headroom: { reach: 0.6, settledP50: 9000 },
    structural: false,
    challenges: [],
    rounds: [],
    best: variant({ key: 'ACQUISITION:marketplace leads + CASH_TIMING:deposit + TRANSACTION:bundle', reach: 0.253, settledP50: 8000, members: ['Opening o1', 'Opening o2'], changes: [leads, deposit, bundle] }),
    established: variant({ key: 'ACQUISITION:marketplace leads @no-assumptions', reach: 0.124, settledP50: 4200, members: ['Opening o1', 'Opening o2'], changes: [leads] }),
    floor: variant({ reach: 0.015 }),
    requiredReply: null,
    volumePlans: [],
    limitation: null,
    confidence: { basis: 'COVERAGE', measured: [], assumed: [], statement: '' },
    searchBrief: '',
    evaluations: 10,
    exploration: null,
    flags: [],
    ...over,
  } as Reconstruction;
}
const two = [
  { opportunity: { id: 'o1', title: 'Opening o1' } },
  { opportunity: { id: 'o2', title: 'Opening o2' } },
];
const asHeld = { best: { reach: 0.083, settledP50: 3000 } } as unknown as Parameters<typeof adoptReconstruction>[0]['baseline'];

describe('an adopted reconstruction is reported at what holds without its assumptions', () => {
  it('adopts on the established move alone, reports its reach, and labels the assumed upside', () => {
    const { adoption, candidate } = adoptReconstruction({ reconstruction: goalC(), baseline: asHeld, openings: two });
    expect(adoption.source).toBe('RECONSTRUCTED');
    expect(candidate!.reach).toBe(0.124);
    expect(candidate!.settledP50).toBe(4200);
    expect(candidate!.reachBasis).toBe('COVERAGE');
    expect(candidate!.assumedUpside).toMatchObject({ reach: 0.253, settledP50: 8000 });
    expect(candidate!.assumedUpside!.assumptions).toHaveLength(2);
    expect(adoption.reason).toMatch(/^the reconstruction reaches 12\.4% /);
    expect(adoption.reason).toMatch(/if its 2 unmeasured assumption\(s\) hold .* it would reach 25\.3%/);
    const sentence = candidateSentence(candidate, 0.9);
    expect(sentence).toMatch(/reaches the target in 12\.4% of worlds, coverage, not a probability\); if its 2 unmeasured assumption\(s\) hold/);
  });

  it('does not adopt when only the assumptions beat the plan as held', () => {
    const r = goalC({ established: variant({ key: 'ACQUISITION:marketplace leads @no-assumptions', reach: 0.09, settledP50: 3100, changes: [leads] }) });
    const out = adoptReconstruction({ reconstruction: r, baseline: asHeld, openings: two });
    expect(out.candidate).toBeNull();
    expect(out.adoption).toMatchObject({ source: 'BASELINE', hypothetical: true });
    expect(out.adoption.reason).toMatch(/without its 2 assumed move\(s\) the reconstruction \(9%, .*does not beat the plan as held/);
    expect(out.adoption.upside!.reach).toBe(0.253);
  });

  it('an unread assumption-free reading is never the favourable one', () => {
    const out = adoptReconstruction({ reconstruction: goalC({ established: undefined }), baseline: asHeld, openings: two });
    expect(out.candidate).toBeNull();
    expect(out.adoption.hypothetical).toBe(true);
    expect(out.adoption.reason).toMatch(/no reading of the reconstruction without its assumed moves was made/);
  });

  it('a plan whose every move is assumed is a hypothesis, never the plan', () => {
    const r = goalC({ best: variant({ key: 'CASH_TIMING:deposit + TRANSACTION:bundle', reach: 0.253, changes: [deposit, bundle] }), established: variant({ reach: 0.5 }) });
    const out = adoptReconstruction({ reconstruction: r, baseline: asHeld, openings: two });
    expect(out.candidate).toBeNull();
    expect(out.adoption.reason).toMatch(/every change the reconstruction makes rests on an unmeasured assumption/);
  });

  it('a measured lever is not an assumption: the plan is adopted at its own reach', () => {
    const measured = { ...deposit, basis: 'MEASURED' as const };
    const r = goalC({ best: variant({ key: 'CASH_TIMING:deposit', reach: 0.253, settledP50: 8000, changes: [measured] }), established: undefined });
    const { candidate } = adoptReconstruction({ reconstruction: r, baseline: asHeld, openings: two });
    expect(candidate!.reach).toBe(0.253);
    expect(candidate!.assumedUpside).toBeUndefined();
  });
});

describe('an assumption-dependent reach never ranks a direction above one resting on fewer assumptions', () => {
  it('scores a direction by what it holds without its assumed moves', () => {
    // A: 60% only if a deposit and a bundle are accepted; 10% without them. B: 30% on estimates alone.
    const a = variant({ reach: 0.6, changes: [deposit, bundle] });
    const aBare = variant({ reach: 0.1 });
    const aChallenged = variant({ reach: 0.05 });
    const b = variant({ reach: 0.3, changes: [leads] });
    const bChallenged = variant({ reach: 0.2 });
    expect(scoreOf(b, bChallenged, b)).toBeGreaterThan(scoreOf(a, aChallenged, aBare));
    // Unread, the assumed reach counts for nothing.
    expect(scoreOf(a, null)).toBeLessThan(scoreOf(b, null));
    // With no assumption at stake, its reach counts in full.
    expect(scoreOf(b, bChallenged)).toBeCloseTo(0.5 * 0.3 + 0.5 * 0.2, 4);
  });
});
