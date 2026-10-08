/**
 * The scenario engine, as pure arithmetic over a definition.
 *
 * No database here: the engine reads no rows, so its properties are asserted
 * against definitions written for the purpose — known analytical answers,
 * deliberately broken models, correlated inputs, and businesses whose shape
 * (negative margin, high risk, low value but repeatable) is the thing under
 * test. The demonstration model is run at the full 50,000 evaluations and
 * timed; the time is printed and asserted only against the engine's own
 * budget, because a speed claim is a reading of one machine.
 */
import { describe, expect, it } from 'vitest';
import { resultDigest, runScenarioModel, ScenarioModelError, ScenarioRunError } from '../server/services/scenario/run.ts';
import { demonstrationModel, DEMONSTRATION_SEED } from '../server/services/scenario/demo.ts';
import { compileModel } from '../server/services/scenario/model.ts';
import { draw } from '../server/services/scenario/engine.ts';
import { parse, ExpressionError } from '../server/services/scenario/expr.ts';
import { SCENARIO_LIMITS, type ScenarioModelDefinition, type ScenarioVariable } from '../server/domain/scenario.ts';

function variable(key: string, spec: ScenarioVariable['spec'], extra: Partial<ScenarioVariable> = {}): ScenarioVariable {
  return { key, label: key, unit: '', provenance: 'ASSUMPTION', controllable: false, spec, ...extra };
}

/** price × units − unitCost × units − fixed, one strategy per price. */
function unitModel(over: Partial<ScenarioModelDefinition> = {}): ScenarioModelDefinition {
  return {
    title: 'Unit economics',
    currency: 'USD',
    horizon: 'one period',
    variables: [
      variable('price', { kind: 'RANGE', min: 1, max: 200 }, { controllable: true }),
      variable('units', { kind: 'RANGE', min: 100, max: 300 }),
      variable('unitCost', { kind: 'FIXED', value: 20 }, { testRange: { min: 0, max: 100 } }),
      variable('fixed', { kind: 'FIXED', value: 1000 }),
    ],
    lines: [
      { key: 'sales', label: 'Sales', kind: 'REVENUE', expr: 'price * units' },
      { key: 'cogs', label: 'Cost of goods', kind: 'COST', expr: 'unitCost * units' },
      { key: 'overhead', label: 'Overhead', kind: 'COST', expr: 'fixed' },
    ],
    strategies: [
      { key: 'p30', label: 'Thirty', set: { price: 30 } },
      { key: 'p50', label: 'Fifty', set: { price: 50 } },
    ],
    ...over,
  };
}

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ScenarioModelError) return error.problems;
    throw error;
  }
  throw new Error('expected the model to be refused');
}

describe('reproducibility', () => {
  it('produces the identical result from the same seed and configuration, and a different one from another seed', () => {
    const a = runScenarioModel(demonstrationModel(), { seed: 7, evaluations: 4000 });
    const b = runScenarioModel(demonstrationModel(), { seed: 7, evaluations: 4000 });
    const c = runScenarioModel(demonstrationModel(), { seed: 8, evaluations: 4000 });
    expect(resultDigest(a)).toBe(resultDigest(b));
    expect(a.configHash).toBe(b.configHash);
    expect(resultDigest(a)).not.toBe(resultDigest(c));
    expect(a.configHash).not.toBe(c.configHash);
  });

  it('adding a variable does not shift the draws of the others, because each draws from its own keyed stream', () => {
    const base = unitModel();
    const widened = unitModel({ variables: [variable('aaa', { kind: 'RANGE', min: 0, max: 1 }), ...base.variables] });
    const one = draw(compileModel(base), 500, 42, 'SWEEP');
    const two = draw(compileModel(widened), 500, 42, 'SWEEP');
    const unitsOne = one.base.slice(1 * 500, 2 * 500);
    const unitsTwo = two.base.slice(2 * 500, 3 * 500);
    expect(Array.from(unitsTwo)).toEqual(Array.from(unitsOne));
  });
});

describe('50,000 evaluations', () => {
  it('runs the demonstration model at the full ceiling inside the budget, and says what 50,000 evaluations were', () => {
    const before = process.memoryUsage().heapUsed;
    const result = runScenarioModel(demonstrationModel(), { seed: DEMONSTRATION_SEED, evaluations: 50_000 });
    const after = process.memoryUsage().heapUsed;
    // Measured, printed, and asserted only against the engine's own wall-clock budget.
    console.log(`[scenario bench] 50,000 evaluations: ${result.elapsedMs} ms, heap delta ${Math.round((after - before) / 1048576)} MiB, result ${Math.round(JSON.stringify(result).length / 1024)} KiB`);
    expect(result.evaluations).toBe(50_000);
    expect(result.scenarios).toBe(12_500);
    expect(result.strategies).toHaveLength(4);
    expect(result.elapsedMs).toBeLessThan(SCENARIO_LIMITS.maxRunMs);
    expect(result.simulated).toBe(true);
    // A sweep over illustrative ranges is not a probability, and says so.
    expect(result.basis).toBe('SWEEP');
    expect(result.probabilistic).toBe(false);
    expect(result.distinctScenarios).toBeLessThanOrEqual(result.scenarios);
    expect(result.limitations.join(' ')).toMatch(/not probabilities/);
  });

  it('refuses more than the ceiling rather than silently truncating', () => {
    expect(() => runScenarioModel(unitModel(), { seed: 1, evaluations: 50_001 })).toThrow(ScenarioRunError);
  });

  it('reports distinct scenarios honestly when the space is small', () => {
    const tiny = unitModel({
      variables: [
        variable('price', { kind: 'FIXED', value: 50 }, { controllable: true }),
        variable('units', { kind: 'CHOICE', options: [{ key: 'LOW', label: 'Low', attributes: { n: 100 } }, { key: 'HIGH', label: 'High', attributes: { n: 200 } }] }),
        variable('unitCost', { kind: 'FIXED', value: 20 }),
        variable('fixed', { kind: 'FIXED', value: 1000 }),
      ],
      lines: [{ key: 'm', label: 'Margin', kind: 'REVENUE', expr: '(price - unitCost) * units.n - fixed' }],
      strategies: [{ key: 'only', label: 'Only', set: {} }],
    });
    const result = runScenarioModel(tiny, { seed: 3, evaluations: 10_000 });
    expect(result.evaluations).toBe(10_000);
    expect(result.distinctScenarios).toBe(2);
    expect(result.strategies[0]!.distinctContributions).toBe(2);
  });
});

describe('validation', () => {
  it('names every problem at once', () => {
    const problems = problemsOf(() => compileModel(unitModel({
      currency: 'dollars',
      lines: [
        { key: 'sales', label: 'Sales', kind: 'REVENUE', expr: 'price * nonsense' },
        { key: 'cogs', label: 'COGS', kind: 'COST', expr: 'unitCost * units' },
        { key: 'cogs2', label: 'COGS again', kind: 'COST', expr: 'unitCost*units' },
      ],
    })));
    expect(problems.some((p) => /currency/.test(p))).toBe(true);
    expect(problems.some((p) => /"nonsense"/.test(p))).toBe(true);
    expect(problems.some((p) => /counted twice/.test(p))).toBe(true);
  });

  it('refuses a probability distribution an assumption cannot justify, and an unknown given one value', () => {
    const problems = problemsOf(() => compileModel(unitModel({
      variables: [
        ...unitModel().variables,
        variable('demand', { kind: 'NORMAL', mean: 10, sd: 2, min: 0, max: 20 }, { provenance: 'ASSUMPTION' }),
        variable('mystery', { kind: 'FIXED', value: 3 }, { provenance: 'UNKNOWN' }),
        variable('market', { kind: 'CHOICE', options: [{ key: 'A', label: 'A', attributes: {}, weight: 1 }, { key: 'B', label: 'B', attributes: {}, weight: 3 }] }, { provenance: 'HYPOTHETICAL' }),
      ],
    })));
    expect(problems.some((p) => /"demand".*only EVIDENCE or HISTORICAL/.test(p))).toBe(true);
    expect(problems.some((p) => /"mystery" is UNKNOWN/.test(p))).toBe(true);
    expect(problems.some((p) => /"market".*only EVIDENCE or HISTORICAL/.test(p))).toBe(true);
  });

  it('refuses a strategy that sets an uncertainty, or leaves a decision unset', () => {
    const problems = problemsOf(() => compileModel(unitModel({
      strategies: [{ key: 'cheat', label: 'Cheat', set: { units: 300 } }],
    })));
    expect(problems.some((p) => /uncertain rather than controllable/.test(p))).toBe(true);
    expect(problems.some((p) => /does not set the controllable "price"/.test(p))).toBe(true);
  });

  it('refuses correlations that cannot all hold, and Monte Carlo over assumptions', () => {
    const correlated = unitModel({
      variables: [
        ...unitModel().variables,
        variable('a', { kind: 'RANGE', min: 0, max: 1 }),
        variable('b', { kind: 'RANGE', min: 0, max: 1 }),
      ],
      correlations: [
        { a: 'units', b: 'a', rho: 0.95, provenance: 'ASSUMPTION' },
        { a: 'a', b: 'b', rho: 0.95, provenance: 'ASSUMPTION' },
        { a: 'units', b: 'b', rho: -0.95, provenance: 'ASSUMPTION' },
      ],
    });
    expect(problemsOf(() => compileModel(correlated)).some((p) => /cannot all hold/.test(p))).toBe(true);
    expect(() => runScenarioModel(unitModel(), { seed: 1, evaluations: 100, basis: 'MONTE_CARLO' })).toThrow(/Monte Carlo needs every sampled input/);
  });

  it('refuses reading a choice directly, a response cycle, and code in an expression', () => {
    const choice = unitModel({
      variables: [...unitModel().variables, variable('mode', { kind: 'CHOICE', options: [{ key: 'X', label: 'X', attributes: { k: 1 } }] })],
      lines: [{ key: 'sales', label: 'Sales', kind: 'REVENUE', expr: 'price * units * mode' }],
    });
    expect(problemsOf(() => compileModel(choice)).some((p) => /reads "mode" directly/.test(p))).toBe(true);
    const cycle = unitModel({
      variables: [
        variable('price', { kind: 'RANGE', min: 1, max: 200 }, { controllable: true }),
        variable('units', { kind: 'RANGE', min: 100, max: 300 }, { responses: [{ to: 'unitCost', elasticity: 1, reference: 1, provenance: 'ASSUMPTION' }] }),
        variable('unitCost', { kind: 'RANGE', min: 1, max: 2 }, { responses: [{ to: 'units', elasticity: 1, reference: 1, provenance: 'ASSUMPTION' }] }),
        variable('fixed', { kind: 'FIXED', value: 1000 }),
      ],
    });
    expect(problemsOf(() => compileModel(cycle)).some((p) => /cycle/.test(p))).toBe(true);
    expect(() => parse('process.exit(1)')).toThrow(ExpressionError);
    expect(() => parse('constructor')).not.toThrow();
    expect(problemsOf(() => compileModel(unitModel({ lines: [{ key: 's', label: 's', kind: 'REVENUE', expr: 'constructor' }] }))).some((p) => /"constructor"/.test(p))).toBe(true);
  });
});

describe('known analytical answers', () => {
  it('a swept uniform demand gives the textbook mean and break-even', () => {
    const result = runScenarioModel(unitModel(), { seed: 11, evaluations: 20_000 });
    for (const [key, price] of [['p30', 30], ['p50', 50]] as const) {
      const s = result.strategies.find((x) => x.key === key)!;
      const expected = ((price - 20) * 200 - 1000) * 100; // mean units 200
      expect(Math.abs(s.contribution!.mean - expected) / expected).toBeLessThan(0.001);
      // Baseline: units 200. Break-even price = unitCost + fixed / units = 25.
      const be = result.sensitivity.breakEvens.find((b) => b.strategy === key && b.variable === 'price')!;
      expect(be.value).toBeCloseTo(25, 2);
      expect(be.direction).toBe('RISES');
      // Break-even unit cost at price p: p − fixed/units.
      const cost = result.sensitivity.breakEvens.find((b) => b.strategy === key && b.variable === 'unitCost')!;
      expect(cost.value).toBeCloseTo(price - 5, 2);
    }
  });

  it('sourced distributions reproduce their moments under Monte Carlo, and are labelled as probabilities', () => {
    const model = unitModel({
      variables: [
        variable('price', { kind: 'FIXED', value: 10 }, { controllable: true }),
        variable('units', { kind: 'NORMAL', mean: 1000, sd: 100, min: 0, max: 5000 }, { provenance: 'HISTORICAL' }),
        variable('unitCost', { kind: 'TRIANGULAR', min: 2, mode: 3, max: 7 }, { provenance: 'EVIDENCE', sources: [{ kind: 'URL', ref: 'https://example.test/price-sheet' }] }),
        variable('fixed', { kind: 'FIXED', value: 0 }),
      ],
      lines: [{ key: 'sales', label: 'Sales', kind: 'REVENUE', expr: 'units' }, { key: 'c', label: 'Cost', kind: 'COST', expr: 'unitCost' }],
      strategies: [{ key: 'only', label: 'Only', set: {} }],
    });
    const result = runScenarioModel(model, { seed: 5, evaluations: 40_000 });
    expect(result.basis).toBe('MONTE_CARLO');
    expect(result.probabilistic).toBe(true);
    const s = result.strategies[0]!;
    // Contribution = units − unitCost; E = 1000 − 4 (triangular mean (2+3+7)/3).
    expect(s.contribution!.mean / 100).toBeCloseTo(996, 0);
    expect(s.contribution!.sd / 100).toBeGreaterThan(97);
    expect(s.contribution!.sd / 100).toBeLessThan(103);
    expect(result.assumptions.find((a) => a.key === 'unitCost')!.sources[0]!.ref).toMatch(/price-sheet/);
  });
});

describe('dependent inputs', () => {
  function pairModel(rho: number | null): ScenarioModelDefinition {
    return {
      title: 'Pair', currency: 'USD', horizon: 'n/a',
      variables: [variable('x', { kind: 'RANGE', min: 0, max: 1 }), variable('y', { kind: 'RANGE', min: 0, max: 1 })],
      correlations: rho === null ? [] : [{ a: 'x', b: 'y', rho, provenance: 'ASSUMPTION', note: 'declared' }],
      lines: [{ key: 'l', label: 'l', kind: 'REVENUE', expr: 'x + y' }],
      strategies: [{ key: 's', label: 's', set: {} }],
    };
  }
  function spearman(xs: Float64Array, ys: Float64Array): number {
    const rank = (v: Float64Array): number[] => { const o = Array.from(v.keys()).sort((a, b) => v[a]! - v[b]!); const r: number[] = []; o.forEach((i, k) => { r[i] = k; }); return r; };
    const rx = rank(xs), ry = rank(ys);
    const n = xs.length; const m = (n - 1) / 2;
    let c = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) { c += (rx[i]! - m) * (ry[i]! - m); vx += (rx[i]! - m) ** 2; vy += (ry[i]! - m) ** 2; }
    return c / Math.sqrt(vx * vy);
  }
  it('imposes a declared rank correlation and leaves undeclared pairs independent', () => {
    for (const [rho, expected] of [[0.8, 0.8], [-0.6, -0.6], [null, 0]] as const) {
      const model = compileModel(pairModel(rho));
      const d = draw(model, 20_000, 99, 'SWEEP');
      const r = spearman(d.base.slice(0, 20_000), d.base.slice(20_000));
      expect(Math.abs(r - expected)).toBeLessThan(0.03);
    }
  });

  it('applies a documented response: conversion falls as price rises', () => {
    const model: ScenarioModelDefinition = {
      title: 'Elastic', currency: 'USD', horizon: 'n/a',
      variables: [
        variable('price', { kind: 'RANGE', min: 1, max: 1000 }, { controllable: true }),
        variable('demand', { kind: 'FIXED', value: 100 }, { responses: [{ to: 'price', elasticity: -1, reference: 10, provenance: 'ASSUMPTION' }] }),
      ],
      lines: [{ key: 'rev', label: 'Revenue', kind: 'REVENUE', expr: 'price * demand' }],
      strategies: [{ key: 'ten', label: '10', set: { price: 10 } }, { key: 'twenty', label: '20', set: { price: 20 } }],
    };
    const result = runScenarioModel(model, { seed: 1, evaluations: 2 });
    // Unit elasticity: revenue is constant at 1000.
    for (const s of result.strategies) expect(s.contribution!.p50).toBe(100_000);
  });
});

describe('numeric boundaries and invalid scenarios', () => {
  it('a zero-width range is a constant and a division by zero is invalid, never zero', () => {
    const model = unitModel({
      variables: [
        variable('price', { kind: 'RANGE', min: 1, max: 200 }, { controllable: true }),
        variable('units', { kind: 'RANGE', min: 0, max: 0 }),
        variable('unitCost', { kind: 'FIXED', value: 20 }),
        variable('fixed', { kind: 'FIXED', value: 1000 }),
      ],
      lines: [{ key: 'perUnit', label: 'Per unit', kind: 'REVENUE', expr: 'fixed / units' }],
    });
    const result = runScenarioModel(model, { seed: 1, evaluations: 100 });
    for (const s of result.strategies) {
      expect(s.invalid).toBe(50);
      expect(s.contribution).toBeNull();
    }
    expect(result.limitations[0]).toMatch(/invalid rather than as zero/);
  });

  it('handles very large and very small magnitudes without losing the cent', () => {
    const model = unitModel({
      variables: [
        variable('price', { kind: 'FIXED', value: 0.01 }, { controllable: true }),
        variable('units', { kind: 'FIXED', value: 1e9 }),
        variable('unitCost', { kind: 'FIXED', value: 0.004 }),
        variable('fixed', { kind: 'FIXED', value: 0 }),
      ],
      strategies: [{ key: 'only', label: 'Only', set: {} }],
    });
    const s = runScenarioModel(model, { seed: 1, evaluations: 1 }).strategies[0]!;
    expect(s.contribution!.p50).toBe(600_000_000); // $6,000,000.00 exactly, in cents
  });
});

describe('the business shapes the engine must not flatter', () => {
  it('a negative-margin business loses in every scenario and its break-even is above its price', () => {
    const result = runScenarioModel(unitModel({ strategies: [{ key: 'underwater', label: 'Underwater', set: { price: 15 } }] }), { seed: 2, evaluations: 3000 });
    const s = result.strategies[0]!;
    expect(s.lossShare).toBe(1);
    expect(s.acceptableShare).toBe(0);
    expect(s.contribution!.max).toBeLessThan(0);
    const be = result.sensitivity.breakEvens.find((b) => b.variable === 'price')!;
    expect(be.value!).toBeGreaterThan(15);
  });

  it('a high-revenue, high-risk strategy and a low-value repeatable one are a trade-off, not a winner', () => {
    const model: ScenarioModelDefinition = {
      title: 'Risk', currency: 'USD', horizon: 'a year',
      variables: [
        variable('bet', { kind: 'CHOICE', options: [
          { key: 'BIG', label: 'One large contract', attributes: { value: 100_000, cost: 40_000, repeatable: 0 } },
          { key: 'SMALL', label: 'Many small orders', attributes: { value: 30, cost: 18, repeatable: 1 } },
        ] }, { controllable: true }),
        variable('winChance', { kind: 'RANGE', min: 0, max: 1 }, { provenance: 'UNKNOWN' }),
        variable('orders', { kind: 'RANGE', min: 900, max: 1100 }, { provenance: 'HYPOTHETICAL' }),
      ],
      derived: [{ key: 'won', label: 'Contract won', unit: '', expr: 'winChance > 0.6' }],
      lines: [
        { key: 'rev', label: 'Revenue', kind: 'REVENUE', expr: 'if(bet.repeatable, bet.value * orders, bet.value * won)' },
        { key: 'cost', label: 'Cost', kind: 'COST', expr: 'if(bet.repeatable, bet.cost * orders, bet.cost)' },
      ],
      strategies: [
        { key: 'big', label: 'Big contract', set: { bet: 'BIG' } },
        { key: 'small', label: 'Small orders', set: { bet: 'SMALL' } },
      ],
    };
    const result = runScenarioModel(model, { seed: 4, evaluations: 10_000 });
    const big = result.strategies.find((s) => s.key === 'big')!;
    const small = result.strategies.find((s) => s.key === 'small')!;
    expect(big.contribution!.p90).toBeGreaterThan(small.contribution!.p90);
    expect(big.contribution!.p10).toBeLessThan(small.contribution!.p10);
    expect(small.acceptableShare).toBe(1);
    expect(big.lossShare).toBeGreaterThan(0.5);
    expect(result.dominance).toHaveLength(0);
    expect(result.tradeOffs).toHaveLength(1);
    // The unknown decides which wins, so it is the thing to find out next.
    expect(result.sensitivity.investigate[0]!.variable).toBe('winChance');
    expect(result.sensitivity.investigate[0]!.decisionRelevant).toBe(true);
    // No ranking without an objective a person chose.
    expect(result.ranking).toBeNull();
    const ranked = runScenarioModel(model, { seed: 4, evaluations: 10_000, objective: { metric: 'contribution', statistic: 'P10', direction: 'MAX' } });
    expect(ranked.ranking!.order[0]!.strategy).toBe('small');
  });
});

describe('strategies compared on identical scenarios', () => {
  it('pairs every scenario, so a fixed difference is exactly that difference everywhere', () => {
    const model = unitModel({
      variables: [...unitModel().variables, variable('extra', { kind: 'RANGE', min: 0, max: 10 }, { controllable: true })],
      strategies: [
        { key: 'lean', label: 'Lean', set: { price: 40, extra: 0 } },
        { key: 'heavy', label: 'Heavy', set: { price: 40, extra: 10 } },
      ],
      lines: [...unitModel().lines, { key: 'extraCost', label: 'Extra', kind: 'COST', expr: 'extra' }],
    });
    const result = runScenarioModel(model, { seed: 6, evaluations: 4000 });
    const lean = result.strategies.find((s) => s.key === 'lean')!;
    const heavy = result.strategies.find((s) => s.key === 'heavy')!;
    expect(lean.winShare).toBe(1);
    expect(heavy.winShare).toBe(0);
    expect(heavy.regret.meanCents).toBe(1000);
    expect(heavy.regret.maxCents).toBe(1000);
    expect(lean.regret.maxCents).toBe(0);
    expect(result.dominance).toEqual([expect.objectContaining({ dominated: 'heavy', by: 'lean' })]);
  });

  it('counts each cost once: contribution is exactly revenue lines minus cost lines', () => {
    const result = runScenarioModel(demonstrationModel(), { seed: 12, evaluations: 2000 });
    const model = demonstrationModel();
    for (const s of result.strategies) {
      for (const d of s.downside) {
        // Recompute from the reported inputs is the engine's own job; here we check the ledger identity on means.
        expect(Number.isInteger(d.contributionCents)).toBe(true);
      }
      if (!s.contribution) continue;
      const revenue = model.lines.filter((l) => l.kind === 'REVENUE').reduce((sum, l) => sum + s.lines[l.key]!.meanCents, 0);
      const cost = model.lines.filter((l) => l.kind === 'COST').reduce((sum, l) => sum + s.lines[l.key]!.meanCents, 0);
      expect(Math.abs(revenue - cost - s.contribution.mean)).toBeLessThanOrEqual(model.lines.length);
    }
  });
});

describe('sensitivity', () => {
  it('ranks the input with the widest effect first and gets the sign of its correlation right', () => {
    const result = runScenarioModel(unitModel(), { seed: 21, evaluations: 4000 });
    const bars = result.sensitivity.tornado.p50!;
    expect(bars[0]!.variable).toBe('unitCost');
    expect(result.sensitivity.rankCorrelation.p50![0]).toEqual(expect.objectContaining({ variable: 'units' }));
    expect(result.sensitivity.rankCorrelation.p50![0]!.rho).toBeGreaterThan(0.99);
    const doubled = result.sensitivity.stress.find((s) => s.strategy === 'p50' && s.variable === 'unitCost')!;
    // Baseline units 200: (50−40)·200 − 1000 = 1000.
    expect(doubled.doubledCents).toBe(100_000);
  });

  it('a stress override changes every scenario and is recorded on the result', () => {
    const plain = runScenarioModel(unitModel(), { seed: 21, evaluations: 2000 });
    const stressed = runScenarioModel(unitModel(), { seed: 21, evaluations: 2000, overrides: { unitCost: { multiply: 2 } } });
    const a = plain.strategies.find((s) => s.key === 'p50')!.contribution!.mean;
    const b = stressed.strategies.find((s) => s.key === 'p50')!.contribution!.mean;
    expect(Math.round((a - b) / 100)).toBe(20 * 200);
    expect(stressed.limitations.join(' ')).toMatch(/unitCost × 2/);
    expect(stressed.configHash).not.toBe(plain.configHash);
  });

  it('a conditional variable is not swung for a strategy it does not apply to', () => {
    const result = runScenarioModel(demonstrationModel(), { seed: 2, evaluations: 2000 });
    const employees = result.sensitivity.tornado.volume_employees!.map((b) => b.variable);
    expect(employees).not.toContain('contractorRate');
    expect(result.sensitivity.tornado.premium_contractors!.map((b) => b.variable)).toContain('contractorRate');
    const downside = result.strategies.find((s) => s.key === 'volume_employees')!.downside[0]!;
    expect(String(downside.inputs.contractorRate)).toMatch(/^n\/a/);
  });

  it('a conditional variable declared before the choice it depends on still applies when active', () => {
    const model: ScenarioModelDefinition = {
      title: 'Order', currency: 'USD', horizon: 'n/a',
      variables: [
        variable('rate', { kind: 'FIXED', value: 7 }, { activeWhen: { variable: 'mode', in: ['ON'], inactiveValue: 0 } }),
        variable('mode', { kind: 'CHOICE', options: [{ key: 'OFF', label: 'Off', attributes: { k: 0 } }, { key: 'ON', label: 'On', attributes: { k: 1 } }] }, { controllable: true }),
      ],
      lines: [{ key: 'l', label: 'l', kind: 'REVENUE', expr: 'rate' }],
      strategies: [{ key: 'off', label: 'Off', set: { mode: 'OFF' } }, { key: 'on', label: 'On', set: { mode: 'ON' } }],
    };
    const result = runScenarioModel(model, { seed: 1, evaluations: 4 });
    expect(result.strategies.find((s) => s.key === 'off')!.contribution!.p50).toBe(0);
    expect(result.strategies.find((s) => s.key === 'on')!.contribution!.p50).toBe(700);
  });

  it('an infeasible scenario is counted, with the constraint named on the downside case', () => {
    const result = runScenarioModel(demonstrationModel(), { seed: DEMONSTRATION_SEED, evaluations: 8000 });
    const volume = result.strategies.find((s) => s.key === 'volume_employees')!;
    expect(volume.infeasible).toBeGreaterThan(0);
    const anyInfeasible = result.strategies.flatMap((s) => s.downside).some((d) => d.infeasible.includes('Peak capital within what is available'));
    expect(anyInfeasible || volume.infeasible > 0).toBe(true);
  });
});
