/**
 * The planningReliability adaptation format (bench/planningReliability/case.ts): an ordered
 * list of changes applied to one world after the first plan is read, each followed by a
 * re-read. These are the format's own rules, read without a database:
 *
 *  - `changedObjective` is the one-change special case, and every existing case and
 *    hidden set keeps loading and grading exactly as before;
 *  - a malformed change is refused with its position, never skipped;
 *  - `caseAtStep` states the case as it stands after k changes, in the shape the grader
 *    already judges.
 */
import { describe, expect, it } from 'vitest';
import { caseAtStep, caseProblem, CHANGE_KINDS, changeSteps, type ChangeStep, type PlanningCase, type WorldChange } from '../bench/planningReliability/case.ts';
import { PUBLIC_CASES } from '../bench/planningReliability/cases.ts';

const base: PlanningCase = {
  id: 'adapt-unit',
  heldOut: false,
  description: 'unit',
  dimensions: { capital: 'none', target: 'small', deadline: 'long', industry: 'credit unions', mechanism: 'EXPLICIT_PAID_REQUEST', autonomy: 'unlimited', missingEvidence: 'none', contradictoryEvidence: false, objectiveChanged: true },
  objective: 'Generate $2,000 within 30 days.',
  openings: [
    { key: 'a', title: 'A', mechanism: 'EXPLICIT_PAID_REQUEST', industry: 'credit unions', price: 2500, cost: 50, daysToCash: 7, performer: 'BRAIN', agreements: [2500] },
    { key: 'b', title: 'B', mechanism: 'EXPLICIT_PAID_REQUEST', industry: 'credit unions', price: 2500, cost: 50, daysToCash: 7, performer: 'BRAIN', agreements: [2500] },
  ],
  expect: { verdict: 'EXECUTABLE_PLAN' },
};
const withChanges = (changes: ChangeStep[], over: Partial<PlanningCase> = {}): PlanningCase => ({ ...base, changes, ...over });

const ONE_OF_EACH: WorldChange[] = [
  { kind: 'OBJECTIVE', objective: 'Generate $2,200 within 30 days.' },
  { kind: 'TARGET', amount: 2400 },
  { kind: 'DEADLINE', days: 20 },
  { kind: 'CAPITAL', capital: 500 },
  { kind: 'CONSTRAINT', constraint: 'OWNER_HOURS', limit: 10 },
  { kind: 'CONSTRAINT', constraint: 'CAPITAL', limit: null },
  { kind: 'BUYER_UNAVAILABLE', opening: 'b', reason: 'The credit union chose another vendor.' },
  { kind: 'SUPPLIER_COST', opening: 'a', cost: 900 },
  { kind: 'DAYS_TO_CASH', opening: 'a', days: 12 },
  { kind: 'CONTRADICTING_EVIDENCE', opening: 'a', field: 'price', value: 250 },
];

describe('the adaptation format', () => {
  it('states every change kind, and a case using each of them is well formed and survives JSON', () => {
    expect(new Set(ONE_OF_EACH.map((c) => c.kind))).toEqual(new Set(CHANGE_KINDS));
    const c = withChanges(ONE_OF_EACH.map((change) => ({ change })), { expectInitial: { verdict: 'EXECUTABLE_PLAN' } });
    expect(caseProblem(c)).toBeNull();
    expect(caseProblem(JSON.parse(JSON.stringify(c)))).toBeNull();
  });

  it('reads changedObjective as exactly one OBJECTIVE change, and a case with neither as none', () => {
    expect(changeSteps({ changedObjective: 'Earn $1,500 a month within 45 days.' })).toEqual([{ change: { kind: 'OBJECTIVE', objective: 'Earn $1,500 a month within 45 days.' } }]);
    expect(changeSteps({})).toEqual([]);
    for (const c of PUBLIC_CASES) expect(changeSteps(c).length).toBe(c.changedObjective ? 1 : 0);
  });

  it('keeps every public case well formed, and grades a changedObjective case on the same case as before', () => {
    for (const c of PUBLIC_CASES) expect(caseProblem(c), c.id).toBeNull();
    for (const c of PUBLIC_CASES.filter((one) => one.changedObjective)) {
      const at = caseAtStep(c, 1)!;
      expect(at.changedObjective).toBe(c.changedObjective);
      expect(at.expect).toEqual(c.expect);
      expect(at.openings).toEqual(c.openings);
      // The first reading of a changedObjective case was never graded, and still is not.
      expect(caseAtStep(c, 0)).toBeNull();
    }
    for (const c of PUBLIC_CASES.filter((one) => !one.changedObjective)) expect(caseAtStep(c, 0)!.expect).toEqual(c.expect);
  });

  it('refuses a malformed change with its position, rather than skipping it', () => {
    const bad = (change: unknown) => caseProblem(withChanges([{ change: change as WorldChange }]));
    expect(bad({ kind: 'WEATHER' })).toMatch(/change 1: unknown change kind WEATHER/);
    expect(bad({ kind: 'TARGET', amount: 0 })).toMatch(/positive amount/);
    expect(bad({ kind: 'DEADLINE', days: 2.5 })).toMatch(/whole number/);
    expect(bad({ kind: 'CAPITAL', capital: -1 })).toMatch(/capital/);
    expect(bad({ kind: 'CONSTRAINT', constraint: 'TARGET', limit: 3 })).toMatch(/CAPITAL or OWNER_HOURS/);
    expect(bad({ kind: 'CONSTRAINT', constraint: 'CAPITAL' })).toMatch(/limit/);
    expect(bad({ kind: 'BUYER_UNAVAILABLE', opening: 'zzz' })).toMatch(/opening zzz/);
    expect(bad({ kind: 'SUPPLIER_COST', opening: 'a' })).toMatch(/cost/);
    expect(bad({ kind: 'DAYS_TO_CASH', opening: 'a', days: 0 })).toMatch(/days/);
    expect(bad({ kind: 'CONTRADICTING_EVIDENCE', opening: 'a', field: 'volume', value: 3 })).toMatch(/price/);
    expect(bad({ kind: 'OBJECTIVE', objective: ' ' })).toMatch(/words/);
    expect(caseProblem(withChanges([]))).toMatch(/non-empty/);
    expect(caseProblem(withChanges([{ change: { kind: 'TARGET', amount: 1 } }], { changedObjective: 'Generate $1 within 3 days.' }))).toMatch(/both given/);
    expect(caseProblem(withChanges([{ change: { kind: 'TARGET', amount: 1 }, expect: { verdict: 'EXECUTABLE_PLAN' } }]))).toMatch(/is the last/);
    expect(caseProblem(withChanges([{ change: { kind: 'TARGET', amount: 1 }, expect: { verdict: 'NO_PLAN' } }, { change: { kind: 'TARGET', amount: 2 } }]))).toMatch(/change 1: a NO_PLAN rubric names no blocker/);
    expect(caseProblem({ ...base, expectInitial: { verdict: 'EXECUTABLE_PLAN' } })).toMatch(/without changes/);
  });

  it('states the case after k changes: the words, the openings’ evidence and that step’s rubric', () => {
    const middle = { verdict: 'NO_PLAN' as const, blocker: { kind: 'MISSING_EVIDENCE' as const, links: ['ECONOMICS' as const] } };
    const c = withChanges(
      [
        { change: { kind: 'SUPPLIER_COST', opening: 'a', cost: 3000 }, expect: middle },
        { change: { kind: 'BUYER_UNAVAILABLE', opening: 'b' } },
        { change: { kind: 'TARGET', amount: 2400 } },
        { change: { kind: 'DAYS_TO_CASH', opening: 'a', days: 40 } },
        { change: { kind: 'CONTRADICTING_EVIDENCE', opening: 'a', field: 'price', value: 250 } },
        { change: { kind: 'OBJECTIVE', objective: 'Generate $1,000 net within 60 days.' } },
      ],
      { expectInitial: { verdict: 'EXECUTABLE_PLAN', mustNotUse: [] } },
    );
    // Before any change: the case as written, graded on expectInitial, with no change in force.
    const s0 = caseAtStep(c, 0)!;
    expect(s0).toMatchObject({ objective: base.objective, openings: base.openings, expect: { verdict: 'EXECUTABLE_PLAN' } });
    expect(s0.changedObjective).toBeUndefined();
    expect(s0.changes).toBeUndefined();
    // An opening change rewrites only that fixture, and is no objective change.
    const s1 = caseAtStep(c, 1)!;
    expect(s1.openings.find((o) => o.key === 'a')!.cost).toBe(3000);
    expect(s1.openings.find((o) => o.key === 'b')!.cost).toBe(50);
    expect(s1.expect).toEqual(middle);
    expect(s1.changedObjective).toBeUndefined();
    // Ungraded middle steps.
    expect(caseAtStep(c, 2)).toBeNull();
    expect(caseAtStep(c, 3)).toBeNull();
    // The final step: every change so far is in force, the gone buyer may not be used, the moved target was replaced by the restated words.
    const s6 = caseAtStep(c, 6)!;
    expect(s6.openings.find((o) => o.key === 'a')).toMatchObject({ cost: 3000, daysToCash: 40, priceContradiction: 250 });
    expect(s6.expect.mustNotUse).toEqual(['b']);
    expect(s6.changedObjective).toBe('Generate $1,000 net within 60 days.');
    expect(s6.expect.targetAfterChange).toBeUndefined();
    // The case itself is never mutated.
    expect(base.openings[0]!.cost).toBe(50);
    expect(caseAtStep(c, 7)).toBeNull();
  });

  it('holds a reading after a target change to the new target, and a goal change marks the objective changed', () => {
    const c = withChanges([{ change: { kind: 'TARGET', amount: 2400 }, expect: { verdict: 'EXECUTABLE_PLAN' } }, { change: { kind: 'CAPITAL', capital: 100 } }]);
    expect(caseAtStep(c, 1)!.expect.targetAfterChange).toBe(2400);
    expect(caseAtStep(c, 1)!.changedObjective).toBe(base.objective);
    // A rubric's own target wins over the one the change implies.
    const own = withChanges([{ change: { kind: 'TARGET', amount: 2400 } }], { expect: { verdict: 'EXECUTABLE_PLAN', targetAfterChange: 2401 } });
    expect(caseAtStep(own, 1)!.expect.targetAfterChange).toBe(2401);
  });
});
