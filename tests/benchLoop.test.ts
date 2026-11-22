/**
 * The fast development loop (`npm run loop`; docs/COMPLETION-SPEC.md §6): the baseline diff
 * that is its feedback, and the parallel case runner that makes it fast.
 *
 *  - The diff names every case IMPROVED, REGRESSED, UNCHANGED, NEW or REMOVED with its
 *    verdict, rejects on a regression, a new critical failure (even on a case that was
 *    already failing) or a vanished case, and never prints a hidden case's reason.
 *  - A parallel run judges every case exactly as the serial run does: the pool only moves
 *    cases between processes, each still on its own copy of the one template database.
 */
import { describe, expect, it } from 'vitest';
import { diffResults, formatDiff, LEVEL_A } from '../bench/diff.ts';
import { CRITICAL } from '../bench/planningReliability/grade.ts';
import { runPlanningReliability, selectJobs, summarise, type PlanningRow } from '../bench/planningReliability/index.ts';
import { defaultWorkers } from '../bench/planningReliability/pool.ts';
import type { BenchResult, CaseResult } from '../bench/types.ts';

const result = (cases: CaseResult[], sha = 'base'): BenchResult => ({
  suite: 'planningReliability',
  sha,
  ref: sha,
  cases,
  metrics: { passed: cases.filter((c) => c.pass).length, cases: cases.length },
  ranAt: '2026-11-22T00:00:00.000Z',
});
const ok = (id: string, verdict = 'EXECUTABLE_PLAN_CORRECT'): CaseResult => ({ id, pass: true, score: 1, ms: 1, verdict, failures: [], critical: false, reason: `${id} fine` });
const bad = (id: string, failures: string[], reason = `${id} wrong`): CaseResult => ({
  id, pass: false, score: 0, ms: 1, verdict: failures.join('+'), failures, critical: failures.some((f) => CRITICAL.has(f as never)), reason,
});

describe('the baseline diff', () => {
  it('names each case improved, regressed or unchanged, with its verdict and reason', () => {
    const before = result([bad('a', ['UNJUSTIFIED_REFUSAL']), ok('b'), ok('c'), bad('d', ['UNJUSTIFIED_REFUSAL'])]);
    const after = result([ok('a'), bad('b', ['UNJUSTIFIED_REFUSAL'], 'names CONVERSION, not FULFILMENT'), ok('c'), bad('d', ['UNJUSTIFIED_REFUSAL'])], 'cand');
    const d = diffResults(before, after, CRITICAL);
    expect(Object.fromEntries(d.cases.map((c) => [c.id, c.change]))).toEqual({ a: 'IMPROVED', b: 'REGRESSED', c: 'UNCHANGED', d: 'UNCHANGED' });
    expect(d.verdict).toBe('REJECT');
    expect(d.reasons).toEqual(['1 case(s) regressed: b']);
    const text = formatDiff(d).join('\n');
    expect(text).toMatch(/REGRESSED b {2}EXECUTABLE_PLAN_CORRECT → UNJUSTIFIED_REFUSAL — names CONVERSION, not FULFILMENT/);
    expect(text).toMatch(/IMPROVED {2}a {2}UNJUSTIFIED_REFUSAL → EXECUTABLE_PLAN_CORRECT/);
    expect(text).toMatch(/UNCHANGED c {2}EXECUTABLE_PLAN_CORRECT/);
  });

  it('passes a run with gains and no regression', () => {
    const d = diffResults(result([bad('a', ['UNJUSTIFIED_REFUSAL']), ok('b')]), result([ok('a'), ok('b')]), CRITICAL);
    expect(d).toMatchObject({ verdict: 'PASS', reasons: [] });
  });

  it('rejects a new critical failure on a case that was already failing', () => {
    const d = diffResults(result([bad('a', ['UNJUSTIFIED_REFUSAL'])]), result([bad('a', ['FALSE_EXECUTABLE', 'UNSOUND_ECONOMICS'])]), CRITICAL);
    expect(d.cases[0]).toMatchObject({ change: 'UNCHANGED', newCritical: ['FALSE_EXECUTABLE', 'UNSOUND_ECONOMICS'] });
    expect(d.verdict).toBe('REJECT');
    expect(d.reasons[0]).toMatch(/new critical failure/);
    // The same critical failure it already had is not new.
    expect(diffResults(result([bad('a', ['FALSE_EXECUTABLE'])]), result([bad('a', ['FALSE_EXECUTABLE'])]), CRITICAL).verdict).toBe('PASS');
  });

  it('rejects a baseline case that did not run, and reports a new one', () => {
    const d = diffResults(result([ok('a'), ok('b')]), result([ok('a'), bad('n', ['FALSE_EXECUTABLE'])]), CRITICAL);
    expect(d.cases.map((c) => `${c.id}:${c.change}`)).toEqual(['a:UNCHANGED', 'n:NEW', 'b:REMOVED']);
    expect(d.reasons).toEqual(['1 new critical failure(s): n [FALSE_EXECUTABLE]', '1 baseline case(s) did not run: b']);
  });

  it('never prints a hidden case\'s reason, and says it is level A feedback', () => {
    const rows: PlanningRow[] = [
      { id: 'hidden:h1', hidden: true, heldOut: true, expect: 'NO_PLAN', observed: 'EXECUTABLE', pass: false, outcome: null, failures: ['FALSE_EXECUTABLE'], ms: 5, detail: 'SECRET rubric text' },
      { id: 'p1', hidden: false, heldOut: false, expect: 'NO_PLAN', observed: 'NO_PLAN', pass: true, outcome: 'NO_PLAN_JUSTIFIED_CORRECT', failures: [], ms: 5, detail: 'names FULFILMENT' },
    ];
    const s = summarise(rows, { totalMs: 10, workers: 2 });
    expect(s.cases[0]).toMatchObject({ id: 'hidden:h1', verdict: 'FALSE_EXECUTABLE', critical: true });
    expect(s.cases[0]).not.toHaveProperty('reason');
    expect(s.cases[1]).toMatchObject({ verdict: 'NO_PLAN_JUSTIFIED_CORRECT', reason: 'names FULFILMENT' });
    const d = diffResults(result([ok('hidden:h1'), ok('p1')]), { ...result(s.cases), metrics: s.metrics }, CRITICAL);
    expect(formatDiff(d).join('\n')).not.toMatch(/SECRET/);
    expect(JSON.stringify(s.summary)).not.toMatch(/SECRET/);
    expect(LEVEL_A).toMatch(/not production verification/);
  });
});

describe('the parallel runner', () => {
  it('sizes its pool by cores and available memory, at least one worker', () => {
    expect(defaultWorkers({ BRAIN_BENCH_WORKERS: '2' })).toBe(2);
    expect(defaultWorkers({})).toBeGreaterThanOrEqual(1);
    expect(selectJobs({ only: ['ho-07-translation-owner-hours-exceeded'] }).map((j) => j.index)).toEqual([
      selectJobs({}).findIndex((j) => (j.value as { id: string }).id === 'ho-07-translation-owner-hours-exceeded'),
    ]);
  });

  it('gives exactly the serial verdicts, in the cases\' own order', { timeout: 300_000 }, async () => {
    const only = ['fam-04-out-of-reach-target', 'ho-07-translation-owner-hours-exceeded', 'fam-03-cleaning-no-fulfiller'];
    const verdicts = (rows: PlanningRow[]) => rows.map(({ ms: _ms, ...rest }) => rest);
    const serial = await runPlanningReliability({ only, workers: 1 });
    const parallel = await runPlanningReliability({ only, workers: 2 });
    expect(serial.rows.map((r) => r.id)).toEqual(selectJobs({ only }).map((j) => (j.value as { id: string }).id));
    expect(verdicts(parallel.rows)).toEqual(verdicts(serial.rows));
    expect(parallel.metrics).toEqual(serial.metrics);
    expect(parallel.timing).toMatchObject({ workers: 2 });
    expect(serial.rows.every((r) => r.observed !== null)).toBe(true);
  });
});
