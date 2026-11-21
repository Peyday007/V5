/**
 * Suite `planningReliability` (docs/COMPLETION-SPEC.md): does Brain's real planner
 * reach a correct planning result — a defensible executable plan, or a justified
 * conclusion that none is established — across unfamiliar objectives?
 *
 * A scenario suite: each case files its openings on a database of its own, makes a
 * goal from the owner's words, reads `readGoalPlan`, and the grader (`grade.ts`)
 * judges the reading against the case's rubric in code.
 *
 * Metrics (over every case run, public and hidden):
 *   accuracy          — passed ÷ cases run (primary, higher is better; target 0.90)
 *   wilsonLow/High    — the Wilson 95% interval of that proportion over its denominator
 *   criticalFailures  — cases failed with a critical class (a guard: tolerance 0)
 *   passed, cases, errors
 *   accuracy.familiar / accuracy.heldOut — the split
 *   failures.<CLASS>  — cases failed with each class
 */
// First: the bench's process environment (a data root of its own, the loop's boot grace held).
import '../env.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wilson } from '../../server/services/cash/goalScenario.ts';
import { HIDDEN_PREFIX, type CaseResult, type Suite, type SuiteOptions, type SuiteOutcome } from '../types.ts';
import { caseProblem, type PlanningCase } from './case.ts';
import { PUBLIC_CASES } from './cases.ts';
import { CRITICAL, FAILURE_CLASSES, grade, observe, type FailureClass } from './grade.ts';
import { buildTemplate, closeWorldDatabase, proveDeliverables, runWorld, type Template } from './world.ts';

export interface PlanningRow {
  id: string;
  hidden: boolean;
  heldOut: boolean;
  expect: string | null;
  observed: string | null;
  pass: boolean;
  outcome: string | null;
  failures: FailureClass[];
  ms: number;
  detail: string;
}

export interface PlanningOutcome extends SuiteOutcome {
  rows: PlanningRow[];
}

export async function runPlanningReliability(options: SuiteOptions & { only?: string[] } = {}): Promise<PlanningOutcome> {
  const publicCases = options.only ? PUBLIC_CASES.filter((c) => options.only!.includes(c.id)) : PUBLIC_CASES;
  const all: Array<{ value: unknown; hidden: boolean }> = [
    ...publicCases.map((value) => ({ value, hidden: false })),
    ...(options.extraCases ?? []).map((value) => ({ value, hidden: true })),
  ];
  const dir = fs.mkdtempSync(path.join(process.env['BRAIN_DATA_DIR'] ?? os.tmpdir(), 'planning-'));
  const rows: PlanningRow[] = [];
  let template: Template | null = null;
  let templateError: string | null = null;
  try {
    await proveDeliverables();
    template = await buildTemplate(dir);
  } catch (error) {
    templateError = `template: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
  }
  try {
    for (const [i, { value, hidden }] of all.entries()) {
      const rawId = value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : `case-${i + 1}`;
      const id = hidden ? `${HIDDEN_PREFIX}${rawId}` : rawId;
      const problem = caseProblem(value);
      if (problem) {
        rows.push({ id, hidden, heldOut: hidden, expect: null, observed: null, pass: false, outcome: null, failures: [], ms: 0, detail: `malformed: ${problem}` });
        continue;
      }
      const c = value as PlanningCase;
      const started = performance.now();
      let row: PlanningRow;
      if (!template) {
        row = { id, hidden, heldOut: hidden || c.heldOut, expect: c.expect.verdict, observed: null, pass: false, outcome: null, failures: [], ms: 0, detail: templateError ?? 'no template database' };
      } else {
        try {
          const world = await runWorld(c, template, dir, i);
          const observed = observe(world.reading, world.keyOf);
          const g = grade(c, observed);
          row = { id, hidden, heldOut: hidden || c.heldOut, expect: c.expect.verdict, observed: observed.stance, pass: g.pass, outcome: g.outcome, failures: g.failures, ms: 0, detail: g.detail };
        } catch (error) {
          row = { id, hidden, heldOut: hidden || c.heldOut, expect: c.expect.verdict, observed: null, pass: false, outcome: null, failures: [], ms: 0, detail: `error: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
        }
      }
      row.ms = Math.round(performance.now() - started);
      rows.push(row);
      options.log?.(`${row.pass ? 'pass' : 'FAIL'} ${id}${hidden ? '' : ` — expected ${row.expect}, observed ${row.observed ?? 'ERROR'}${row.failures.length ? ` [${row.failures.join(', ')}]` : ''}: ${row.detail}`}`);
    }
  } finally {
    await closeWorldDatabase();
  }
  const cases: CaseResult[] = rows.map((r) => ({ id: r.id, pass: r.pass, score: r.pass ? 1 : 0, ms: r.ms }));
  const passed = rows.filter((r) => r.pass).length;
  const interval = wilson(passed, rows.length);
  const share = (xs: PlanningRow[]) => (xs.length ? xs.filter((r) => r.pass).length / xs.length : 0);
  const metrics: Record<string, number> = {
    accuracy: rows.length ? passed / rows.length : 0,
    wilsonLow: rows.length ? interval.low : 0,
    wilsonHigh: rows.length ? interval.high : 0,
    passed,
    cases: rows.length,
    criticalFailures: rows.filter((r) => r.failures.some((f) => CRITICAL.has(f))).length,
    errors: rows.filter((r) => !r.pass && r.observed === null).length,
  };
  const familiar = rows.filter((r) => !r.heldOut);
  const heldOut = rows.filter((r) => r.heldOut);
  if (familiar.length) metrics['accuracy.familiar'] = share(familiar);
  if (heldOut.length) metrics['accuracy.heldOut'] = share(heldOut);
  for (const klass of FAILURE_CLASSES) metrics[`failures.${klass}`] = rows.filter((r) => r.failures.includes(klass)).length;
  const failed = rows.filter((r) => !r.pass);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const summary = [
    `planningReliability: ${passed}/${rows.length} correct · accuracy ${pct(metrics['accuracy']!)} (Wilson 95% ${pct(metrics['wilsonLow']!)}–${pct(metrics['wilsonHigh']!)}) · critical ${metrics['criticalFailures']} · errors ${metrics['errors']}`,
    // Hidden cases are named by id only: their content never reaches a log.
    ...failed.map((r) => `  FAIL ${r.id}${r.hidden ? '' : ` [${r.failures.join(', ') || 'ERROR'}] expected ${r.expect}, observed ${r.observed ?? 'ERROR'} — ${r.detail}`}`),
  ];
  return { cases, metrics, summary, rows };
}

export const planningReliability: Suite = {
  name: 'planningReliability',
  primary: { metric: 'accuracy', direction: 'higher' },
  run: runPlanningReliability,
};
