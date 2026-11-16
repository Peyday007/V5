/**
 * The mootRequests benchmark (§111): a scenario suite. Each case drives the real Russell loop
 * and repositories through a mission leaving NEEDS_HUMAN around a person's answer, and the
 * harness reads the end state from the rows itself. It must score the code that fixed the
 * moot-answer defect (a loop hand-mutated to re-ask every failed resume scored 6/18 when the suite
 * was built), carry controls so a fix that withdraws
 * live decisions is caught, take hidden cases in the same shape (reported by id only), and be
 * scored by the evaluator's own copy of `bench/`, never the variant's.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CASE_CLASSES, caseProblem, type MootCase } from '../bench/mootRequests/case.ts';
import { PUBLIC_CASES } from '../bench/mootRequests/cases.ts';
import { meets, runMootRequests } from '../bench/mootRequests/index.ts';

describe('the public cases', () => {
  it('are well formed, uniquely named, cover every class, and carry controls', () => {
    for (const c of PUBLIC_CASES) expect(caseProblem(c), c.id).toBeNull();
    expect(new Set(PUBLIC_CASES.map((c) => c.id)).size).toBe(PUBLIC_CASES.length);
    for (const klass of CASE_CLASSES) expect(PUBLIC_CASES.some((c) => c.class === klass), klass).toBe(true);
    // A variant that withdraws every card, or never withdraws one, cannot score both halves.
    const wants = PUBLIC_CASES.flatMap((c) => Object.values(c.expect));
    expect(wants.filter((w) => w === 'OPEN' || w === 'RESUMED').length).toBeGreaterThanOrEqual(5);
    expect(wants.filter((w) => w === 'WITHDRAWN' || w === 'SETTLED').length).toBeGreaterThanOrEqual(10);
  });

  it('refuses a malformed case with a reason', () => {
    expect(caseProblem({ id: 'x', class: 'NOPE', steps: [{ do: 'tick' }], expect: { r1: 'OPEN' } })).toMatch(/class/);
    expect(caseProblem({ id: 'x', class: 'STILL_WAITING', steps: [{ do: 'answer', request: 'r1', choice: 'STOP' }], expect: { r1: 'OPEN' } })).toMatch(/no step asked/);
    expect(caseProblem({ id: 'x', class: 'STILL_WAITING', steps: [{ do: 'ask', request: 'r1', mission: 'm9' }], expect: { r1: 'OPEN' } })).toMatch(/no step parked/);
    expect(caseProblem({ id: 'x', class: 'STILL_WAITING', steps: [{ do: 'ask', request: 'r1', mission: null }], expect: { r2: 'OPEN' } })).toMatch(/no step asked/);
    expect(caseProblem({ id: 'x', class: 'STILL_WAITING', steps: [{ do: 'rm -rf' }], expect: {} })).not.toBeNull();
  });

  it('reads SETTLED as withdrawn or carried out, and nothing else', () => {
    expect(meets('SETTLED', 'WITHDRAWN')).toBe(true);
    expect(meets('SETTLED', 'RESUMED')).toBe(true);
    expect(meets('SETTLED', 'OPEN')).toBe(false);
    expect(meets('SETTLED', 'ANSWERED')).toBe(false);
    expect(meets('OPEN', 'GONE')).toBe(false);
  });
});

describe('a run on this code', () => {
  it('scores every public scenario, takes hidden cases by id only, and fails a malformed one without crashing', async () => {
    const hidden: MootCase = {
      id: 'prod-shape-1',
      class: 'LEFT_BEFORE_RESUME',
      note: 'SECRET-CONTENT-NEVER-LOGGED',
      steps: [
        { do: 'park', mission: 'm1' },
        { do: 'ask', request: 'r1', mission: 'm1' },
        { do: 'answer', request: 'r1', choice: 'APPROVE_PLAN' },
        { do: 'move', mission: 'm1', to: 'FAILED' },
        { do: 'tick' },
      ],
      expect: { r1: 'SETTLED' },
    };
    const lines: string[] = [];
    const outcome = await runMootRequests({ extraCases: [hidden, { id: 'broken' }], log: (line) => lines.push(line) });
    const byId = new Map(outcome.cases.map((c) => [c.id, c]));
    for (const c of PUBLIC_CASES) expect(byId.get(c.id)?.pass, c.id).toBe(true);
    expect(byId.get('hidden:prod-shape-1')?.pass).toBe(true);
    expect(byId.get('hidden:broken')?.pass).toBe(false);
    expect(outcome.metrics).toMatchObject({ mootOpen: 0, mootAnswered: 0, mootLeft: 0, falseWithdraw: 0, historyLost: 0, cases: PUBLIC_CASES.length + 2 });
    expect(outcome.metrics['accuracy']).toBeCloseTo((PUBLIC_CASES.length + 1) / (PUBLIC_CASES.length + 2));
    const printed = [...lines, ...outcome.summary].join('\n');
    expect(printed).toContain('hidden:broken');
    expect(printed).not.toContain('SECRET-CONTENT-NEVER-LOGGED');
    expect(outcome.summary[0]).toMatch(/^mootRequests: /);
  }, 180_000);
});

describe('the evaluator scores it with its own harness', () => {
  it('copies bench/ over every tree it runs, and passes the suite summary line to its log', () => {
    const workflow = readFileSync(new URL('../.github/workflows/evolution-eval.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('rm -rf "$wt/bench" && cp -R bench "$wt/bench"');
    expect(workflow).toMatch(/grep -E '\^\([^)]*mootRequests[^)]*\): /);
  });
});
