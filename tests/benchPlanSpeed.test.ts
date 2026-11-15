/**
 * The plan-speed benchmark's shape (docs/evolution/DESIGN.md, workstream B),
 * at a reduced world count with exploration off so it stays fast: it times the frozen $10K-shaped
 * reconstruction offline, reads one plan on every run, and emits the shared
 * result JSON. Its timings are BASELINE.md's business, not this file's.
 */
import { describe, expect, it } from 'vitest';
import { runBench } from '../bench/run.ts';
import { GOAL_10K_PLAN } from '../bench/planSpeed/fixture.ts';

describe('planSpeed', () => {
  it('is the $10K goal\'s shape: 11 found openings, 12 constructed, $3,000, 24 days', () => {
    expect(GOAL_10K_PLAN.openings.filter((o) => !o.constructed)).toHaveLength(11);
    expect(GOAL_10K_PLAN.openings.filter((o) => o.constructed)).toHaveLength(12);
  });

  it('times the reconstruction, reads the same plan on each run, and emits the contract', async () => {
    const { result } = await runBench('planSpeed', { worlds: 150, runs: 2, quick: true, ref: 'test', extraCases: [{ id: 'small', openings: GOAL_10K_PLAN.openings.slice(0, 4) }, { id: 'broken' }] });
    expect(result.suite).toBe('planSpeed');
    expect(Object.keys(result).sort()).toEqual(['cases', 'metrics', 'ranAt', 'ref', 'sha', 'suite']);
    expect(result.cases.map((c) => c.id)).toEqual(['goal10k-23', 'hidden:small', 'hidden:broken']);
    for (const c of result.cases) expect(Object.keys(c).sort()).toEqual(['id', 'ms', 'pass', 'score']);
    expect(result.cases[2]!.pass).toBe(false);
    for (const name of ['p50ms', 'minms', 'bestReach', 'reachDelta', 'deterministic']) expect(typeof result.metrics[name]).toBe('number');
    expect(result.metrics['minms']!).toBeGreaterThan(0);
    expect(result.metrics['minms']!).toBeLessThanOrEqual(result.metrics['p50ms']!);
    expect(result.metrics['deterministic']).toBe(1);
    expect(result.metrics['bestReach']!).toBeGreaterThanOrEqual(0);
    expect(result.metrics['bestReach']!).toBeLessThanOrEqual(1);
  }, 120_000);
});
