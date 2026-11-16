/**
 * The feasibility benchmark (docs/evolution/DESIGN.md, workstream B): it runs
 * offline on the real plan machinery, reads the same verdicts every time, emits
 * the result JSON the experiment core records, carries negative controls so
 * over-refusal is measured, and reports hidden cases by id only.
 */
import { describe, expect, it } from 'vitest';
import { runBench } from '../bench/run.ts';
import { CASE_CLASSES, caseProblem } from '../bench/feasibility/case.ts';
import { PUBLIC_CASES } from '../bench/feasibility/cases.ts';
import { runFeasibility } from '../bench/feasibility/index.ts';

describe('the public cases', () => {
  it('are at least thirty, well formed, uniquely named and cover every class', () => {
    expect(PUBLIC_CASES.length).toBeGreaterThanOrEqual(30);
    for (const c of PUBLIC_CASES) expect(caseProblem(c), c.id).toBeNull();
    expect(new Set(PUBLIC_CASES.map((c) => c.id)).size).toBe(PUBLIC_CASES.length);
    for (const klass of CASE_CLASSES) expect(PUBLIC_CASES.some((c) => c.class === klass), klass).toBe(true);
  });

  it('include negative controls, so a variant that refuses everything is caught', () => {
    const controls = PUBLIC_CASES.filter((c) => c.expect === 'ACCEPT');
    expect(controls.length).toBeGreaterThanOrEqual(10);
    // Controls spread across the judgements a variant could tighten.
    const kinds = new Set(controls.map((c) => c.judgement.kind));
    for (const kind of ['portfolio.leading', 'pathway.executable', 'prepayment', 'engine.admitted'] as const) expect(kinds.has(kind), kind).toBe(true);
  });
});

describe('a run', () => {
  it('is deterministic: the same verdicts and metrics twice', async () => {
    const strip = (o: Awaited<ReturnType<typeof runFeasibility>>) => ({ cases: o.cases.map(({ id, pass, score }) => ({ id, pass, score })), metrics: o.metrics });
    const a = await runFeasibility();
    const b = await runFeasibility();
    expect(strip(b)).toEqual(strip(a));
    expect(a.metrics['errors']).toBe(0);
    // A refuse-everything or accept-everything variant could not score this.
    expect(a.metrics['falseRefuse']).toBeLessThan(1);
    expect(a.metrics['accuracy']).toBeGreaterThan(0.5);
  }, 60_000);

  it('emits the shared result contract, with hidden cases prefixed and malformed ones failed', async () => {
    const [first] = PUBLIC_CASES;
    const hidden = [{ ...first!, id: 'secret-1' }, { id: 'broken', class: 'NOT_A_CLASS' }];
    const lines: string[] = [];
    const { result, summary } = await runBench('feasibility', { extraCases: hidden, ref: 'test', log: (line) => lines.push(line) });
    expect(Object.keys(result).sort()).toEqual(['cases', 'metrics', 'ranAt', 'ref', 'sha', 'suite']);
    expect(result.suite).toBe('feasibility');
    expect(result.ref).toBe('test');
    expect(typeof result.sha).toBe('string');
    expect(Number.isNaN(Date.parse(result.ranAt))).toBe(false);
    for (const c of result.cases) {
      expect(Object.keys(c).sort()).toEqual(['id', 'ms', 'pass', 'score']);
      expect(typeof c.pass).toBe('boolean');
      expect(typeof c.score).toBe('number');
      expect(typeof c.ms).toBe('number');
    }
    for (const name of ['accuracy', 'falseAccept', 'falseRefuse', 'cases']) expect(typeof result.metrics[name]).toBe('number');
    expect(result.metrics['cases']).toBe(PUBLIC_CASES.length + 2);
    const secret = result.cases.find((c) => c.id === 'hidden:secret-1');
    expect(secret?.pass).toBe(result.cases.find((c) => c.id === first!.id)?.pass);
    expect(result.cases.find((c) => c.id === 'hidden:broken')?.pass).toBe(false);
    // A hidden case's content never reaches a log: only its id.
    const printed = [...lines, ...summary].join('\n');
    expect(printed).not.toContain(first!.description);
    expect(printed).toContain('hidden:secret-1');
  }, 60_000);
});
