/**
 * Suite `feasibility`: does Brain's plan machinery treat a hypothetical answer
 * to a constraint as if it were available? (docs/evolution/DESIGN.md)
 *
 * Metrics (all over the cases run, public and hidden):
 *   accuracy    — share of cases judged correctly (primary, higher is better)
 *   falseAccept — share of REFUSE cases the machinery accepted: a hypothetical
 *                 treated as available
 *   falseRefuse — share of ACCEPT cases (negative controls) it refused: a valid
 *                 opening refused
 *   cases       — how many ran
 *   accuracy.<CLASS> — the same per class, so a variant's trade between classes is visible
 */
import { HIDDEN_PREFIX, type CaseResult, type Suite, type SuiteOptions, type SuiteOutcome } from '../types.ts';
import { CASE_CLASSES, caseProblem, type FeasibilityCase, type Verdict } from './case.ts';
import { PUBLIC_CASES } from './cases.ts';
import { judge } from './judge.ts';

interface Row {
  id: string;
  hidden: boolean;
  klass: string;
  expect: Verdict | null;
  observed: Verdict | null;
  pass: boolean;
  ms: number;
  detail: string;
}

export async function runFeasibility(options: SuiteOptions = {}): Promise<SuiteOutcome> {
  const all: Array<{ value: unknown; hidden: boolean }> = [
    ...PUBLIC_CASES.map((value) => ({ value, hidden: false })),
    ...(options.extraCases ?? []).map((value) => ({ value, hidden: true })),
  ];
  const rows: Row[] = [];
  for (const [i, { value, hidden }] of all.entries()) {
    const problem = caseProblem(value);
    const rawId = value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : `case-${i + 1}`;
    const id = hidden ? `${HIDDEN_PREFIX}${rawId}` : rawId;
    if (problem) {
      rows.push({ id, hidden, klass: 'MALFORMED', expect: null, observed: null, pass: false, ms: 0, detail: `malformed: ${problem}` });
      continue;
    }
    const c = value as FeasibilityCase;
    const started = performance.now();
    let observed: Verdict | null = null;
    let detail: string;
    try {
      const judged = await judge(c, options.worlds !== undefined ? { worlds: options.worlds } : {});
      observed = judged.observed;
      detail = judged.detail;
    } catch (error) {
      detail = `error: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
    }
    const ms = Math.round((performance.now() - started) * 10) / 10;
    rows.push({ id, hidden, klass: c.class, expect: c.expect, observed, pass: observed === c.expect, ms, detail });
    options.log?.(`${observed === c.expect ? 'pass' : 'FAIL'} ${id}${hidden ? '' : ` — expected ${c.expect}, observed ${observed ?? 'ERROR'}: ${detail}`}`);
  }
  const cases: CaseResult[] = rows.map((r) => ({ id: r.id, pass: r.pass, score: r.pass ? 1 : 0, ms: r.ms }));
  const share = (xs: Row[], f: (r: Row) => boolean) => (xs.length ? xs.filter(f).length / xs.length : 0);
  const refuse = rows.filter((r) => r.expect === 'REFUSE');
  const accept = rows.filter((r) => r.expect === 'ACCEPT');
  const metrics: Record<string, number> = {
    accuracy: share(rows, (r) => r.pass),
    falseAccept: share(refuse, (r) => r.observed === 'ACCEPT'),
    falseRefuse: share(accept, (r) => r.observed === 'REFUSE'),
    cases: rows.length,
    errors: rows.filter((r) => r.observed === null).length,
  };
  for (const klass of CASE_CLASSES) {
    const xs = rows.filter((r) => r.klass === klass);
    if (xs.length) metrics[`accuracy.${klass}`] = share(xs, (r) => r.pass);
  }
  const failed = rows.filter((r) => !r.pass);
  const summary = [
    `feasibility: ${rows.length - failed.length}/${rows.length} correct · accuracy ${metrics['accuracy']!.toFixed(3)} · falseAccept ${metrics['falseAccept']!.toFixed(3)} (${refuse.length} REFUSE cases) · falseRefuse ${metrics['falseRefuse']!.toFixed(3)} (${accept.length} controls)`,
    // Hidden cases are named by id only: their content never reaches a log.
    ...failed.map((r) => `  FAIL ${r.id}${r.hidden ? '' : ` [${r.klass}] expected ${r.expect}, observed ${r.observed ?? 'ERROR'} — ${r.detail}`}`),
  ];
  return { cases, metrics, summary };
}

export const feasibility: Suite = {
  name: 'feasibility',
  primary: { metric: 'accuracy', direction: 'higher' },
  run: runFeasibility,
};
