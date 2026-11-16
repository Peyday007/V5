/**
 * Suite `mootRequests`: does Brain put a person-request in front of the owner that nobody can
 * act on any more? (§111; deficiency class RECURRING_OPERATIONAL_FAILURE on the Russell loop.)
 *
 * A scenario suite: each case drives the real loop and repositories of the code under test
 * through a race — a mission leaving NEEDS_HUMAN around a person's answer — and the harness
 * reads the end state from the rows (`scenario.ts`).
 *
 * Metrics (over every case run, public and hidden):
 *   accuracy      — share of cases whose every request ended as required (primary, higher is better)
 *   mootOpen      — moot cards left OPEN in front of the person, summed over cases
 *   mootAnswered  — moot answers left ANSWERED (never applied, never settled), summed
 *   mootLeft      — share of requests required to settle that did not (OPEN or ANSWERED)
 *   falseWithdraw — share of requests required to stay OPEN or be carried out that were WITHDRAWN:
 *                   a real decision taken away from the person (a guard: a fix may not buy
 *                   fewer moot cards by withdrawing live ones)
 *   historyLost   — requests whose row disappeared (invariant 5; a guard)
 *   cases, errors
 *   accuracy.<CLASS> — the same per class
 */
// First: the bench's process environment (a data root of its own, the loop's boot grace held).
import '../env.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HIDDEN_PREFIX, type CaseResult, type Suite, type SuiteOptions, type SuiteOutcome } from '../types.ts';
import { CASE_CLASSES, caseProblem, type Expectation, type MootCase } from './case.ts';
import { PUBLIC_CASES } from './cases.ts';
import { buildTemplate, closeScenarioDatabase, runScenario, type Template } from './scenario.ts';

interface Row {
  id: string;
  hidden: boolean;
  klass: string;
  pass: boolean;
  ms: number;
  detail: string;
  expect: Record<string, Expectation>;
  states: Record<string, string> | null;
  mootOpen: number;
  mootAnswered: number;
}

export function meets(want: Expectation, state: string): boolean {
  if (want === 'SETTLED') return state === 'WITHDRAWN' || state === 'RESUMED';
  return state === want;
}

export async function runMootRequests(options: SuiteOptions = {}): Promise<SuiteOutcome> {
  const all: Array<{ value: unknown; hidden: boolean }> = [
    ...PUBLIC_CASES.map((value) => ({ value, hidden: false })),
    ...(options.extraCases ?? []).map((value) => ({ value, hidden: true })),
  ];
  const dir = fs.mkdtempSync(path.join(process.env['BRAIN_DATA_DIR'] ?? os.tmpdir(), 'moot-'));
  const rows: Row[] = [];
  let template: Template | null = null;
  let templateError: string | null = null;
  try {
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
        rows.push({ id, hidden, klass: 'MALFORMED', pass: false, ms: 0, detail: `malformed: ${problem}`, expect: {}, states: null, mootOpen: 0, mootAnswered: 0 });
        continue;
      }
      const c = value as MootCase;
      const started = performance.now();
      let states: Record<string, string> | null = null;
      let mootOpen = 0;
      let mootAnswered = 0;
      let detail: string;
      if (!template) {
        detail = templateError ?? 'no template database';
      } else {
        try {
          const outcome = await runScenario(c, template, dir, i);
          states = outcome.states;
          mootOpen = outcome.mootOpen;
          mootAnswered = outcome.mootAnswered;
          detail = Object.entries(c.expect).map(([name, want]) => `${name} ${want}→${outcome.states[name] ?? 'GONE'}`).join(', ');
        } catch (error) {
          detail = `error: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
        }
      }
      const pass = states !== null && Object.entries(c.expect).every(([name, want]) => meets(want, states![name] ?? 'GONE'));
      const ms = Math.round((performance.now() - started) * 10) / 10;
      rows.push({ id, hidden, klass: c.class, pass, ms, detail, expect: c.expect, states, mootOpen, mootAnswered });
      options.log?.(`${pass ? 'pass' : 'FAIL'} ${id}${hidden ? '' : ` — ${detail}`}`);
    }
  } finally {
    await closeScenarioDatabase().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const cases: CaseResult[] = rows.map((r) => ({ id: r.id, pass: r.pass, score: r.pass ? 1 : 0, ms: r.ms }));
  const expectations = rows.flatMap((r) => Object.entries(r.expect).map(([name, want]) => ({ want, state: r.states ? (r.states[name] ?? 'GONE') : null })));
  const toSettle = expectations.filter((e) => e.want === 'WITHDRAWN' || e.want === 'SETTLED');
  const toKeep = expectations.filter((e) => e.want === 'OPEN' || e.want === 'RESUMED');
  const share = (n: number, d: number) => (d ? n / d : 0);
  const metrics: Record<string, number> = {
    accuracy: share(rows.filter((r) => r.pass).length, rows.length),
    mootOpen: rows.reduce((n, r) => n + r.mootOpen, 0),
    mootAnswered: rows.reduce((n, r) => n + r.mootAnswered, 0),
    mootLeft: share(toSettle.filter((e) => e.state === 'OPEN' || e.state === 'ANSWERED').length, toSettle.length),
    falseWithdraw: share(toKeep.filter((e) => e.state === 'WITHDRAWN').length, toKeep.length),
    historyLost: expectations.filter((e) => e.state === 'GONE').length,
    cases: rows.length,
    errors: rows.filter((r) => r.states === null).length,
  };
  for (const klass of CASE_CLASSES) {
    const xs = rows.filter((r) => r.klass === klass);
    if (xs.length) metrics[`accuracy.${klass}`] = share(xs.filter((r) => r.pass).length, xs.length);
  }
  const failed = rows.filter((r) => !r.pass);
  const summary = [
    `mootRequests: ${rows.length - failed.length}/${rows.length} correct · accuracy ${metrics['accuracy']!.toFixed(3)} · mootOpen ${metrics['mootOpen']} · ` +
      `mootLeft ${metrics['mootLeft']!.toFixed(3)} (${toSettle.length} to settle) · falseWithdraw ${metrics['falseWithdraw']!.toFixed(3)} (${toKeep.length} controls)`,
    // Hidden cases are named by id only: their content never reaches a log.
    ...failed.map((r) => `  FAIL ${r.id}${r.hidden ? '' : ` [${r.klass}] ${r.detail}`}`),
  ];
  return { cases, metrics, summary };
}

export const mootRequests: Suite = {
  name: 'mootRequests',
  primary: { metric: 'accuracy', direction: 'higher' },
  run: runMootRequests,
};
