/**
 * CHAL-33, review finding F1: the challenge of a plan is read by the running
 * Brain, not only attached to it. `optimizePortfolio` — the one optimizer the
 * goal portfolio and the plan acceptance read (`goals/portfolio.ts`,
 * `goals/plan.ts`, which accept on `assurance.claimsAtLeast90` and turn
 * `assurance.researchNeeds` into named work) — now:
 *
 *  - adopts the challenge's recommended independent substitute when the plan
 *    it ranked best rides on a blocking shared dependency, recomputed on the
 *    same worlds and never with an inflated figure;
 *  - withdraws a 90% claim the challenge holds, naming the assumption, the
 *    test and the safer structure in the reason the plan reader shows;
 *  - turns the challenge's improvements and tests into research needs;
 *  - leaves a minor reversible plan untouched by the heavy review.
 */
import { describe, expect, it } from 'vitest';
import {
  ADOPTION_REACH_TOLERANCE,
  adoptionFrom,
  applyChallengeToAssurance,
  assess,
  optimizePortfolio,
  type Activity,
  type PortfolioProblem,
} from '../server/services/quant/portfolio.ts';
import { challengePlan } from '../server/services/quant/challenge.ts';

const act = (key: string, over: Partial<Activity> = {}): Activity => ({
  key, label: key, cash: [60], days: [2], justified: true, capital: 1, evidence: { sampleSize: 30 }, ...over,
});

/** Two cheap wedges that both ride on one supplier, and an independent one that costs more capital. */
function sharedSupplier(withSubstitute: boolean): PortfolioProblem {
  return {
    target: 100, deadlineDays: 10, startingCapital: 100, worlds: 500,
    resourceFailure: { 'supplier-x': 0, 'supplier-y': 0 },
    activities: [
      act('w1', { needs: ['supplier-x'] }),
      act('w2', { needs: ['supplier-x'] }),
      ...(withSubstitute ? [act('solo', { cash: [100], capital: 50, needs: ['supplier-y'] })] : []),
    ],
  };
}

describe('the optimizer adopts the challenge\'s repair of a correlated plan', () => {
  it('replaces the member riding on the shared supplier with the independent substitute, recomputed, and keeps the original readable', () => {
    const problem = sharedSupplier(true);
    const r = optimizePortfolio(problem);
    // Without the challenge the cheaper shared pair wins the tie on reach; the challenge replaces it.
    expect(r.adoption).toBeDefined();
    const a = r.adoption!;
    expect(a.kind).toBe('INDEPENDENT_SUBSTITUTE');
    expect(a.exposure).toBe('RESOURCE:supplier-x');
    expect(a.from.keys.sort()).toEqual(['w1', 'w2']);
    expect(r.best!.keys).toContain('solo');
    expect(r.best!.keys).toEqual(a.to.keys);
    // The finding that replaced it names the assumption, the test and the safer structure.
    expect(a.because.assumption).toContain('supplier-x');
    expect(a.because.test).toContain('reach falls');
    expect(a.because.saferStructure).toContain('solo');
    expect(a.original.findings.some((f) => f.mode === 'SHARED_DEPENDENCY' && f.severity === 'BLOCKING')).toBe(true);
    // The original stays an alternative; nothing is discarded.
    expect(r.ranked.some((one) => one.keys.slice().sort().join('|') === 'w1|w2')).toBe(true);
    // The figure is assess() of the adopted plan — recomputed, never raised.
    expect(r.assurance!.range).toEqual(assess(problem, r.best!).range);
    expect(r.best!.reach).toBeGreaterThanOrEqual(a.from.reach - ADOPTION_REACH_TOLERANCE);
    // The adopted plan is challenged in turn, and it no longer shares the supplier.
    expect(r.assurance!.challenge!.exposures.some((e) => e.id === 'supplier-x')).toBe(false);
    expect(r.assurance!.reason).toContain('the challenge replaced');
  });

  it('adopts nothing that gives up reach, needs something that does not exist, or answers no blocking finding', () => {
    const problem = sharedSupplier(true);
    const r = optimizePortfolio({ ...problem, challenge: false });
    const summary = challengePlan(problem, r);
    const read = (keys: string[]) => optimizePortfolio({ ...problem, activities: problem.activities.filter((a) => keys.includes(a.key)), challenge: false }).ranked.find((one) => one.keys.length === keys.length) ?? null;
    expect(adoptionFrom(summary, r.best!, read)).not.toBeNull();
    const worse = (keys: string[]) => { const one = read(keys); return one ? { ...one, reach: one.reach - 0.01 } : null; };
    expect(adoptionFrom(summary, r.best!, worse)).toBeNull();
    const needing = { ...summary, proposals: summary.proposals.map((p) => ({ ...p, requires: ['an independent supplier must exist'] })) };
    expect(adoptionFrom(needing, r.best!, read)).toBeNull();
    const minor = { ...summary, findings: summary.findings.map((f) => ({ ...f, severity: 'MATERIAL' as const })) };
    expect(adoptionFrom(minor, r.best!, read)).toBeNull();
  });
});

describe('the challenge binds the assurance the plan acceptance reads', () => {
  it('withdraws a 90% claim a blocking shared dependency holds, says why, and sends the test to research', () => {
    const problem = sharedSupplier(false);
    const r = optimizePortfolio(problem);
    // Evidence alone would claim 90%: the lower bound clears it.
    expect(assess(problem, r.best!).claimsAtLeast90).toBe(true);
    // The challenge holds it: the plan rides on one supplier that, if it fails, takes reach to zero.
    expect(r.adoption).toBeUndefined();
    expect(r.assurance!.claimsAtLeast90).toBe(false);
    expect(r.assurance!.status).toBe('RANGE');
    expect(r.assurance!.reason).toContain('holds the plan');
    expect(r.assurance!.reason).toContain('supplier-x');
    expect(r.assurance!.reason).toMatch(/test: .*safer: /);
    expect(r.assurance!.researchNeeds!.some((n) => n.startsWith('test RESOURCE:supplier-x'))).toBe(true);
    // Never raised: the range is still assess()'s own.
    expect(r.assurance!.range).toEqual(assess(problem, r.best!).range);
  });

  it('a challenge that failed or refused withdraws the claim; one that passes changes nothing', () => {
    const problem: PortfolioProblem = { target: 100, deadlineDays: 10, worlds: 300, activities: [act('only', { cash: [200], evidence: { sampleSize: 100_000 } })] };
    const r = optimizePortfolio({ ...problem, challenge: false });
    const passing = challengePlan(problem, r);
    expect(passing.verdict).toBe('PASS');
    const a = { ...r.assurance! };
    applyChallengeToAssurance(a, passing);
    expect(a.claimsAtLeast90).toBe(r.assurance!.claimsAtLeast90);
    expect(a.reason).toBe(r.assurance!.reason);
    const failed = { ...passing, verdict: 'CHALLENGE_FAILED' as const, error: 'boom' };
    const b = { ...r.assurance! };
    applyChallengeToAssurance(b, failed);
    expect(b.claimsAtLeast90).toBe(false);
    expect(b.reason).toContain('could not run');
  });

  it('turns improvements into research and plan work when evidence cannot justify 90%', () => {
    const problem: PortfolioProblem = { ...sharedSupplier(false), activities: sharedSupplier(false).activities.map((a) => ({ ...a, evidence: {} })) };
    const r = optimizePortfolio(problem);
    const c = r.assurance!.challenge!;
    expect(c.verdict).toBe('IMPROVE_PLAN_AND_EVIDENCE');
    expect(c.improvements.length).toBeGreaterThan(0);
    for (const one of c.improvements) {
      const bare = one.replace(/^(research|evidence|plan): /, '');
      expect(r.assurance!.researchNeeds!.some((n) => n === one || n === bare)).toBe(true);
    }
  });
});

describe('a minor reversible action is not held up by the heavy review', () => {
  it('a tiny confident reversible plan keeps its claim and reason, and its step proceeds now', () => {
    const problem: PortfolioProblem = { target: 100, deadlineDays: 10, worlds: 300, activities: [act('only', { cash: [200], evidence: { sampleSize: 100_000 } })] };
    const bare = optimizePortfolio({ ...problem, challenge: false });
    const r = optimizePortfolio(problem);
    expect(r.assurance!.challenge!.scrutiny.tier).toBe('BASIC_INVARIANTS');
    expect(r.assurance!.challenge!.proceedNow).toEqual(['only']);
    expect(r.adoption).toBeUndefined();
    expect(r.assurance!.claimsAtLeast90).toBe(bare.assurance!.claimsAtLeast90);
    expect(r.assurance!.claimsAtLeast90).toBe(true);
    expect(r.assurance!.reason).toBe(bare.assurance!.reason);
    expect(r.assurance!.researchNeeds).toEqual(bare.assurance!.researchNeeds);
  });
});
