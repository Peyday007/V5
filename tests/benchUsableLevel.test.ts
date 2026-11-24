import { describe, expect, it } from 'vitest';
import { gradeUsable, type ObservedPlan } from '../bench/planningReliability/grade.ts';
import { usableLines, diffResults } from '../bench/diff.ts';
import type { PlanningCase } from '../bench/planningReliability/case.ts';

const plan = (over: Partial<ObservedPlan>): ObservedPlan => ({
  stance: 'NO_PLAN', status: 'CANDIDATE_ONLY', verdict: 'NEEDS_EVIDENCE', infeasible: null, broken: [], members: [], missing: { route: ['CONVERSION'] }, named: ['CONVERSION'],
  collectAfterDeadline: false, scope: { industry: null, recurring: null, hoursPerWeek: null }, targetCents: 100_000, gate: null, ...over,
});
const want = { id: 'x', objective: 'Collect $1,000 within 21 days.', openings: [], expect: { verdict: 'EXECUTABLE_PLAN' } } as unknown as PlanningCase;

/** The owner-usable level (2026-11-24): a plan the owner could start, whatever the planner labels it. */
describe('gradeUsable', () => {
  it('judges a plan whose only open link is the close rate by its steps, never by the planner\'s label', () => {
    // A hand-built observation carries no steps, so the chain cannot be judged: it never passes on links alone.
    const g = gradeUsable(want, plan({}), { pass: false, failures: ['UNJUSTIFIED_REFUSAL'] });
    expect(g.pass).toBe(false);
    expect(g.detail).toContain('NOT_OBSERVED');
  });
  it('fails a plan with any other link open, a broken limit, an infeasibility or a critical class', () => {
    expect(gradeUsable(want, plan({ missing: { route: ['CONVERSION', 'MARKET_VOLUME'] } }), { pass: false, failures: [] }).pass).toBe(false);
    expect(gradeUsable(want, plan({ broken: ['CAPITAL'] }), { pass: false, failures: [] }).pass).toBe(false);
    expect(gradeUsable(want, plan({ infeasible: ['TARGET'] }), { pass: false, failures: [] }).pass).toBe(false);
    expect(gradeUsable(want, plan({}), { pass: false, failures: ['UNSOUND_ECONOMICS'] }).pass).toBe(false);
    expect(gradeUsable(want, plan({ missing: {} }), { pass: false, failures: [] }).pass).toBe(false);
  });
  it('leaves a no-plan case to the verdict level', () => {
    const noPlan = { ...want, expect: { verdict: 'NO_PLAN' } } as unknown as PlanningCase;
    expect(gradeUsable(noPlan, plan({}), { pass: true, failures: [] }).pass).toBe(true);
    expect(gradeUsable(noPlan, plan({}), { pass: false, failures: ['FALSE_EXECUTABLE'] }).pass).toBe(false);
  });
});

describe('the diff report’s owner-usable block', () => {
  const run = (sha: string, usable: boolean[]) => ({ suite: 'planningReliability', sha, ref: sha, ranAt: '', metrics: {}, cases: usable.map((u, i) => ({ id: `c${i}`, pass: false, score: 0, ms: 0, usable: { pass: u } })) });
  it('prints counts, the net change and who recovered or regressed, and rejects a lost plan', () => {
    const d = diffResults(run('a', [false, true, false]), run('b', [true, false, false]));
    expect(usableLines(d)[0]).toContain('1/3 → 1/3 (+0.0 pp) · recovered 1 · regressed 1');
    expect(d.verdict).toBe('REJECT');
  });
});
