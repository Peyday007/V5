/**
 * Grading an adaptation case (`changes`, case.ts): every graded reading of the world —
 * before the first change when `expectInitial` is given, after each change whose step
 * carries a rubric, and after the last against the case's own `expect` — is judged by the
 * one grader (`grade`, `observe`) on the case as it stood at that step (`caseAtStep`). The
 * case passes only when every graded reading does: re-planning correctly after one change
 * does not excuse a wrong plan after another.
 *
 * A case without changes, or with the one `changedObjective`, grades exactly as `grade`
 * alone does on its final reading.
 */
import type { PlanReading } from '../../server/services/goals/plan.ts';
import { caseAtStep, changeSteps, type PlanningCase } from './case.ts';
import { grade, observe, type FailureClass, type Grade, type ObservedPlan } from './grade.ts';

export interface StepGrade {
  /** 0: before any change; k: after change k. */
  step: number;
  /** The change applied before this reading (`kind`), or null for the first reading. */
  change: string | null;
  observed: ObservedPlan;
  grade: Grade;
}

export interface AdaptationGrade extends Grade {
  steps: StepGrade[];
  /** The final reading's observation (what a single-reading row reports as `observed`). */
  final: ObservedPlan;
}

export function gradeAdaptation(c: PlanningCase, readings: readonly PlanReading[], keyOf: (opportunityId: string) => string): AdaptationGrade {
  const steps = changeSteps(c);
  if (readings.length !== steps.length + 1) throw new Error(`${readings.length} reading(s) for ${steps.length} change(s)`);
  const graded: StepGrade[] = [];
  for (const [k, reading] of readings.entries()) {
    const at = caseAtStep(c, k);
    if (!at) continue;
    const observed = observe(reading, keyOf);
    graded.push({ step: k, change: k === 0 ? null : steps[k - 1]!.change.kind, observed, grade: grade(at, observed) });
  }
  const final = graded[graded.length - 1]!;
  const failed = graded.filter((g) => !g.grade.pass);
  const label = (g: StepGrade) => (steps.length ? `${g.step === 0 ? 'before any change' : `after change ${g.step} (${g.change})`}: ` : '');
  if (!failed.length) return { pass: true, outcome: final.grade.outcome, failures: [], detail: graded.map((g) => `${label(g)}${g.grade.detail}`).join(' | '), steps: graded, final: final.observed };
  return {
    pass: false,
    outcome: null,
    failures: [...new Set<FailureClass>(failed.flatMap((g) => g.grade.failures))],
    detail: failed.map((g) => `${label(g)}${g.grade.detail}`).join(' | '),
    steps: graded,
    final: final.observed,
  };
}
