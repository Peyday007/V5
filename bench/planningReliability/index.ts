/**
 * Suite `planningReliability` (docs/COMPLETION-SPEC.md): does Brain's real planner
 * reach a correct planning result — a defensible executable plan, or a justified
 * conclusion that none is established — across unfamiliar objectives?
 *
 * A scenario suite: each case files its openings on a database of its own, makes a
 * goal from the owner's words, reads `readGoalPlan`, and the grader (`grade.ts`)
 * judges the reading against the case's rubric in code.
 *
 * Cases run serially in this process, or — with `workers` above 1 — on a bounded pool
 * of child processes (`pool.ts`), each case still on its own copy of the one migrated
 * template, so the verdicts cannot depend on which (`tests/benchLoop.test.ts`).
 *
 * Metrics (over every case run, public and hidden):
 *   accuracy          — passed ÷ cases run (primary, higher is better; target 0.90)
 *   wilsonLow/High    — the Wilson 95% interval of that proportion over its denominator
 *   criticalFailures  — cases failed with a critical class (a guard: tolerance 0)
 *   passed, cases, errors
 *   accuracy.familiar / accuracy.heldOut — the split
 *   failures.<CLASS>  — cases failed with each class
 *   e2e.passed, e2e.accuracy, e2e.wilsonLow/High — the end-to-end level (§3a): a
 *                       correct verdict AND a complete, AI-executable plan (or a
 *                       no-plan conclusion that says what would resolve it), over
 *                       the same denominator; reported beside `accuracy`, never in it
 *   e2e.passedBarFieldGaps — cases that pass the end-to-end level, or fail it only on fields the
 *                       planner's output does not carry (STEP_FIELD_ABSENT)
 *   e2e.failures.<CLASS> — cases failed with each end-to-end class
 * Each case also carries its verdict, failure classes, whether one is critical and —
 * for a public case only — the grader's reason; the result's `timing` carries the
 * template, case and total wall-clock milliseconds and the worker count.
 */
// First: the bench's process environment (a data root of its own, the loop's boot grace held).
import '../env.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wilson } from '../../server/services/cash/goalScenario.ts';
import { HIDDEN_PREFIX, type CaseResult, type Suite, type SuiteOptions, type SuiteOutcome } from '../types.ts';
import { gradeAdaptation } from './adaptation.ts';
import { caseProblem, type PlanningCase } from './case.ts';
import { PUBLIC_CASES } from './cases.ts';
import { CRITICAL, E2E_FAILURE_CLASSES, FAILURE_CLASSES, grade, observe, type E2EFailureClass, type FailureClass } from './grade.ts';
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
  /** The end-to-end level (§3a), beside the verdict level above; absent on a row that never reached the grader. */
  e2e?: { pass: boolean; failures: E2EFailureClass[]; gaps: string[]; detail: string };
  usable?: { pass: boolean; detail: string };
}

export interface PlanningOutcome extends SuiteOutcome {
  rows: PlanningRow[];
}

/** One case's place in the run: its position (which names its database) and whether it is hidden. */
export interface CaseJob {
  index: number;
  value: unknown;
  hidden: boolean;
}

/** The id a case is reported under: hidden cases carry the prefix. */
export function caseId(job: CaseJob): string {
  const v = job.value;
  const rawId = v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : `case-${job.index + 1}`;
  return job.hidden ? `${HIDDEN_PREFIX}${rawId}` : rawId;
}

/**
 * Puts one case through the planner on its own copy of the template and grades it. The
 * serial runner and every pool worker (`pool.ts`) call exactly this, so a parallel run
 * cannot judge a case differently from a serial one.
 */
export async function runCase(job: CaseJob, template: Template | null, templateError: string | null, dir: string): Promise<PlanningRow> {
  const { value, hidden, index } = job;
  const id = caseId(job);
  const problem = caseProblem(value);
  if (problem) return { id, hidden, heldOut: hidden, expect: null, observed: null, pass: false, outcome: null, failures: [], ms: 0, detail: `malformed: ${problem}` };
  const c = value as PlanningCase;
  const started = performance.now();
  let row: PlanningRow;
  if (!template) {
    row = { id, hidden, heldOut: hidden || c.heldOut, expect: c.expect.verdict, observed: null, pass: false, outcome: null, failures: [], ms: 0, detail: templateError ?? 'no template database' };
  } else {
    try {
      const world = await runWorld(c, template, dir, index);
      // Every graded reading of the world: before and after each change (adaptation.ts); a case with no changes grades its one reading.
      const g = gradeAdaptation(c, world.readings, world.keyOf);
      row = { id, hidden, heldOut: hidden || c.heldOut, expect: c.expect.verdict, observed: g.final.stance, pass: g.pass, outcome: g.outcome, failures: g.failures, ms: 0, detail: g.detail, e2e: g.e2e, ...(g.usable ? { usable: g.usable } : {}) };
    } catch (error) {
      row = { id, hidden, heldOut: hidden || c.heldOut, expect: c.expect.verdict, observed: null, pass: false, outcome: null, failures: [], ms: 0, detail: `error: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
    }
  }
  row.ms = Math.round(performance.now() - started);
  return row;
}

/** The selection a run makes: public cases, then the extra (hidden) ones; `only` narrows it by reported id, then `shard` takes its share. */
export function selectJobs(options: SuiteOptions): CaseJob[] {
  const all: CaseJob[] = [
    ...PUBLIC_CASES.map((value) => ({ value: value as unknown, hidden: false })),
    ...(options.extraCases ?? []).map((value) => ({ value, hidden: true })),
  ].map((j, index) => ({ ...j, index }));
  const selected = options.only ? all.filter((j) => options.only!.includes(caseId(j))) : all;
  const shard = options.shard;
  if (!shard) return selected;
  if (selected.some((j) => j.hidden)) throw new Error('a sharded run takes public cases only');
  return selected.filter((_, k) => k % shard.of === shard.index - 1);
}

/** `i/N` → a shard, refusing anything that is not 1 ≤ i ≤ N. */
export function parseShard(raw: string): { index: number; of: number } {
  const m = /^(\d+)\/(\d+)$/.exec(raw.trim());
  const index = Number(m?.[1]);
  const of = Number(m?.[2]);
  if (!m || !Number.isInteger(index) || !Number.isInteger(of) || of < 1 || index < 1 || index > of) {
    throw new Error(`--shard must be i/N with 1 ≤ i ≤ N, not "${raw}"`);
  }
  return { index, of };
}

export async function runPlanningReliability(options: SuiteOptions = {}): Promise<PlanningOutcome> {
  const jobs = selectJobs(options);
  const dir = fs.mkdtempSync(path.join(process.env['BRAIN_DATA_DIR'] ?? os.tmpdir(), 'planning-'));
  const t0 = performance.now();
  let template: Template | null = null;
  let templateError: string | null = null;
  try {
    await proveDeliverables();
    template = await buildTemplate(dir);
  } catch (error) {
    templateError = `template: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
  }
  const templateMs = Math.round(performance.now() - t0);
  const logRow = (row: PlanningRow) =>
    options.log?.(
      `${row.pass ? 'pass' : 'FAIL'} ${row.id}${row.hidden ? '' : ` — expected ${row.expect}, observed ${row.observed ?? 'ERROR'}${row.failures.length ? ` [${row.failures.join(', ')}]` : ''}: ${row.detail}`} · e2e ${row.e2e?.pass ? 'pass' : `FAIL [${(row.e2e?.failures ?? ['NOT_OBSERVED']).join(', ')}]`} (${row.ms} ms)`,
    );
  const workers = Math.max(1, Math.min(options.workers ?? 1, jobs.length));
  const t1 = performance.now();
  let rows: PlanningRow[];
  if (workers > 1 && template) {
    // Each worker is its own process: its own database handle and its own module memos.
    await closeWorldDatabase();
    const { runPool } = await import('./pool.ts');
    rows = await runPool(jobs, { template, dir, workers, onRow: logRow });
  } else {
    rows = [];
    try {
      for (const job of jobs) {
        const row = await runCase(job, template, templateError, dir);
        rows.push(row);
        logRow(row);
      }
    } finally {
      await closeWorldDatabase();
    }
  }
  const casesMs = Math.round(performance.now() - t1);
  // The template and every case's database are spent once graded (≈200 MB a full run).
  fs.rmSync(dir, { recursive: true, force: true });
  return summarise(rows, { templateMs, casesMs, totalMs: Math.round(performance.now() - t0), workers });
}

/** Rows to the shared result: metrics, per-case verdicts and the summary lines. Pure over the rows. */
export function summarise(rows: PlanningRow[], timing?: Record<string, number>): PlanningOutcome {
  const cases: CaseResult[] = rows.map((r) => ({
    id: r.id,
    pass: r.pass,
    score: r.pass ? 1 : 0,
    ms: r.ms,
    verdict: r.pass ? (r.outcome ?? 'PASS') : r.observed === null ? 'ERROR' : r.failures.join('+') || 'FAIL',
    failures: r.failures,
    critical: r.failures.some((f) => CRITICAL.has(f)),
    // A hidden case's grader detail describes its rubric: only its verdict leaves the run.
    ...(r.hidden ? {} : { reason: r.detail }),
    // The end-to-end level, by class only for a hidden case (its detail names the rubric's links).
    e2e: r.e2e ? { pass: r.e2e.pass, failures: r.e2e.failures, gaps: r.e2e.gaps, ...(r.hidden ? {} : { reason: r.e2e.detail }) } : { pass: false, failures: ['NOT_OBSERVED'], gaps: [] },
    // The owner-usable level; its detail only for a public case.
    usable: { pass: !!r.usable?.pass, ...(r.hidden || !r.usable ? {} : { reason: r.usable.detail }) },
  }));
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
  // The end-to-end level, over the same denominator: a row that never reached the grader fails it.
  const e2eOf = (r: PlanningRow) => r.e2e ?? { pass: false, failures: ['NOT_OBSERVED'] as E2EFailureClass[], gaps: [], detail: '' };
  const e2ePassed = rows.filter((r) => e2eOf(r).pass).length;
  const e2eInterval = wilson(e2ePassed, rows.length);
  metrics['e2e.passed'] = e2ePassed;
  metrics['e2e.accuracy'] = rows.length ? e2ePassed / rows.length : 0;
  metrics['e2e.wilsonLow'] = rows.length ? e2eInterval.low : 0;
  metrics['e2e.wilsonHigh'] = rows.length ? e2eInterval.high : 0;
  // The owner-usable level (gradeUsable): a plan the owner could start, whatever the planner labels it.
  const usablePassed = rows.filter((r) => r.usable?.pass).length;
  const usableInterval = wilson(usablePassed, rows.length);
  metrics['usable.passed'] = usablePassed;
  metrics['usable.accuracy'] = rows.length ? usablePassed / rows.length : 0;
  metrics['usable.wilsonLow'] = rows.length ? usableInterval.low : 0;
  metrics['usable.wilsonHigh'] = rows.length ? usableInterval.high : 0;
  metrics['e2e.passedBarFieldGaps'] = rows.filter((r) => r.pass && e2eOf(r).failures.every((f) => f === 'STEP_FIELD_ABSENT')).length;
  for (const klass of E2E_FAILURE_CLASSES) metrics[`e2e.failures.${klass}`] = rows.filter((r) => e2eOf(r).failures.includes(klass)).length;
  const gaps = [...new Set(rows.flatMap((r) => e2eOf(r).gaps))].sort();
  const failed = rows.filter((r) => !r.pass);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const e2eClasses = E2E_FAILURE_CLASSES.filter((k) => metrics[`e2e.failures.${k}`]! > 0).map((k) => `${k} ${metrics[`e2e.failures.${k}`]}`);
  const summary = [
    `planningReliability: ${passed}/${rows.length} correct · accuracy ${pct(metrics['accuracy']!)} (Wilson 95% ${pct(metrics['wilsonLow']!)}–${pct(metrics['wilsonHigh']!)}) · critical ${metrics['criticalFailures']} · errors ${metrics['errors']}` +
      (timing?.['totalMs'] !== undefined ? ` · ${(timing['totalMs'] / 1000).toFixed(1)} s on ${timing['workers'] ?? 1} worker(s)` : ''),
    `planningReliability end-to-end: ${e2ePassed}/${rows.length} complete · ${pct(metrics['e2e.accuracy']!)} (Wilson 95% ${pct(metrics['e2e.wilsonLow']!)}–${pct(metrics['e2e.wilsonHigh']!)}) · ${metrics['e2e.passedBarFieldGaps']} pass bar absent fields` +
      (e2eClasses.length ? ` · ${e2eClasses.join(', ')}` : '') +
      (gaps.length ? ` · fields absent: ${gaps.join(', ')}` : ''),
    // Hidden cases are named by id only: their content never reaches a log.
    ...failed.map((r) => `  FAIL ${r.id}${r.hidden ? '' : ` [${r.failures.join(', ') || 'ERROR'}] expected ${r.expect}, observed ${r.observed ?? 'ERROR'} — ${r.detail}`}`),
    ...rows
      .filter((r) => r.pass && !e2eOf(r).pass)
      .map((r) => `  E2E ${r.id} [${e2eOf(r).failures.join(', ')}]${r.hidden ? '' : ` — ${e2eOf(r).detail}`}`),
  ];
  // The owner-usable level's line follows the verdict and end-to-end lines, so their positions are unchanged.
  summary.push(`planningReliability owner-usable: ${usablePassed}/${rows.length} startable plans · ${pct(metrics['usable.accuracy']!)} (Wilson 95% ${pct(metrics['usable.wilsonLow']!)}–${pct(metrics['usable.wilsonHigh']!)})`);
  return { cases, metrics, summary, rows, ...(timing ? { timing } : {}) };
}

export const planningReliability: Suite = {
  name: 'planningReliability',
  primary: { metric: 'accuracy', direction: 'higher' },
  run: runPlanningReliability,
};
