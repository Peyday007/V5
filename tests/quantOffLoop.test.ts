/**
 * §109 (2026-11-13/14): the quant engine held the server's event loop — stalls
 * of 8–24 s, ~20 s of every minute's CPU in `reconstruct.ts`/`inverseNormal`
 * and the portfolio evaluator — and every database socket, health check and
 * MCP call behind it timed out. Earlier fixes moved one caller each off the
 * loop. The class is closed two ways, and both are held here:
 *
 *  - the engine is cheaper at the root, reading exactly what it read before:
 *    the portfolio evaluator reuses the state of a combination's prefix (one
 *    member's work per world for each greedy candidate), and reconstruction
 *    draws each key's normals once;
 *  - the pure computations a plan read runs — the portfolio evaluation, the
 *    variable sweep and now the construction pass — run on the evaluator
 *    pool's threads, and the server's loop is never held while they do.
 */
import { describe, expect, it } from 'vitest';
import { inverseNormal, makeRng, normalCdf } from '../server/services/scenario/random.ts';
import { compareReadings, optimizePortfolio, type Activity, type PortfolioProblem, type PortfolioReading } from '../server/services/quant/portfolio.ts';
import { capitalTurnover } from '../server/services/quant/deadline.ts';
import { reconstruct } from '../server/services/quant/reconstruct.ts';
import { composeArrangement } from '../server/services/quant/mechanism.ts';
import { composeConstruction, type ConstructionJob } from '../server/services/cash/construct.ts';
import { targetProperties, type GoalLimits } from '../server/services/cash/properties.ts';
import { openEvaluator } from '../server/services/goals/reasoning/evaluatorPool.ts';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';

/* ---------------------------------------------------------------------------
 * The evaluator as it was before the prefix reuse, verbatim in its arithmetic:
 * the reference every optimized reading must equal exactly.
 * ------------------------------------------------------------------------- */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}
function referenceWorlds(problem: PortfolioProblem, worlds: number) {
  const seed = problem.seed ?? 20261031;
  const down = new Map<string, Uint8Array>();
  for (const id of [...new Set(problem.activities.flatMap((one) => one.needs ?? []))].sort()) {
    const p = problem.resourceFailure![id]!;
    const rng = makeRng(seed, seedOf(`resource:${id}`));
    const out = new Uint8Array(worlds);
    for (let i = 0; i < worlds; i++) out[i] = rng() < p ? 1 : 0;
    down.set(id, out);
  }
  const groups = new Map<string, Float64Array>();
  const factor = (group: string) => {
    let g = groups.get(group);
    if (!g) {
      const rng = makeRng(seed, seedOf(`group:${group}`));
      g = new Float64Array(worlds);
      for (let i = 0; i < worlds; i++) g[i] = inverseNormal(rng());
      groups.set(group, g);
    }
    return g;
  };
  const picks = problem.activities.map((activity) => {
    const n = activity.cash.length;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => activity.cash[a]! - activity.cash[b]!);
    const rng = makeRng(seed, seedOf(`activity:${activity.key}`));
    const rho = activity.riskGroup ? Math.min(0.95, Math.max(0, problem.riskCorrelation?.[activity.riskGroup] ?? 0.5)) : 0;
    const g = activity.riskGroup ? factor(activity.riskGroup) : null;
    const out = new Array<number>(worlds);
    for (let i = 0; i < worlds; i++) {
      const e = inverseNormal(rng());
      const z = g ? Math.sqrt(rho) * g[i]! + Math.sqrt(1 - rho) * e : e;
      out[i] = order[Math.min(n - 1, Math.floor(normalCdf(z) * n))]!;
    }
    return out;
  });
  return { picks, down };
}
function referenceEvaluate(problem: PortfolioProblem, members: number[], drawn: ReturnType<typeof referenceWorlds>, worlds: number): PortfolioReading {
  const { picks, down } = drawn;
  const keys = members.map((m) => problem.activities[m]!.key);
  const justified = members.every((m) => problem.activities[m]!.justified);
  const refusal = ((): string | null => {
    const acts = members.map((m) => problem.activities[m]!);
    const keySet = new Set(acts.map((one) => one.key));
    for (const one of acts) {
      const clash = (one.excludes ?? []).find((other) => keySet.has(other));
      if (clash) return `"${one.key}" and "${clash}" cannot run together`;
    }
    const round = (x: number) => Math.round(x * 100) / 100;
    const used = new Map<string, number>();
    for (const one of acts) for (const [r, amount] of Object.entries(one.uses ?? {})) used.set(r, (used.get(r) ?? 0) + amount);
    for (const [r, amount] of used) {
      const cap = problem.capacity?.[r];
      if (cap !== undefined && amount > cap + 1e-9) return `needs ${round(amount)} ${r} and only ${round(cap)} is available`;
    }
    return null;
  })();
  if (refusal) return { keys, reach: 0, settledP10: 0, settledP50: 0, settledP90: 0, capitalShort: 0, overSpend: 0, contribution: 0, capitalTurnover: 0, feasible: false, infeasibleBecause: refusal, basis: justified ? 'PROBABILITY' : 'COVERAGE' };
  const ordered = [...members].sort((a, b) => (problem.activities[a]!.startDay ?? 0) - (problem.activities[b]!.startDay ?? 0));
  const settled = new Float64Array(worlds);
  let reached = 0, short = 0, over = 0, contributed = 0, tied = 0, cycled = 0;
  const pending: Array<{ day: number; cash: number }> = [];
  for (let i = 0; i < worlds; i++) {
    let capital = problem.startingCapital ?? Infinity;
    let total = 0, wasShort = false, spent = 0, held = 0, lastDay = 0;
    pending.length = 0;
    for (const m of ordered) {
      const act = problem.activities[m]!;
      const s = picks[m]![i]!;
      const start = act.startDay ?? 0;
      const need = act.capital ?? 0;
      for (let p = pending.length - 1; p >= 0; p--) {
        if (pending[p]!.day <= start) {
          capital += pending[p]!.cash;
          pending.splice(p, 1);
        }
      }
      if (need > capital + 1e-9) {
        wasShort = true;
        continue;
      }
      capital -= need;
      held += need;
      if ((act.needs ?? []).some((id) => down.get(id)![i] === 1)) continue;
      const day = start + act.days[s]!;
      if (day > lastDay) lastDay = day;
      const cash = act.cash[s]!;
      spent += act.spend?.[s] ?? 0;
      pending.push({ day, cash: cash + need });
      if (day <= problem.deadlineDays) total += cash;
    }
    settled[i] = total;
    contributed += total - spent;
    tied += held;
    cycled += lastDay;
    const overCeiling = problem.spendCeiling !== undefined && spent > problem.spendCeiling + 1e-9;
    if (overCeiling) over += 1;
    if (total >= problem.target && !overCeiling) reached += 1;
    if (wasShort) short += 1;
  }
  const sorted = Array.from(settled).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(worlds - 1, Math.floor(p * worlds))]!;
  const contribution = contributed / worlds;
  const turnover = capitalTurnover(contribution, tied / worlds, cycled / worlds) ?? 0;
  return { keys, reach: reached / worlds, settledP10: q(0.1), settledP50: q(0.5), settledP90: q(0.9), capitalShort: short / worlds, overSpend: over / worlds, contribution, capitalTurnover: turnover, feasible: true, infeasibleBecause: null, basis: justified ? 'PROBABILITY' : 'COVERAGE' };
}
/** The greedy search as it was: every candidate evaluated from scratch. */
function referenceGreedy(problem: PortfolioProblem): { readings: PortfolioReading[]; best: PortfolioReading | null } {
  const worlds = problem.worlds ?? 2_000;
  const n = problem.activities.length;
  const drawn = referenceWorlds(problem, worlds);
  const readings: PortfolioReading[] = [];
  const record = (members: number[]) => {
    const r = referenceEvaluate(problem, members, drawn, worlds);
    readings.push(r);
    return r;
  };
  problem.activities.forEach((_, i) => record([i]));
  let current: number[] = [];
  let currentReading: PortfolioReading | null = null;
  for (;;) {
    let bestNext: { members: number[]; reading: PortfolioReading } | null = null;
    for (let i = 0; i < n; i++) {
      if (current.includes(i)) continue;
      const members = [...current, i];
      const reading = record(members);
      if (!bestNext || compareReadings(reading, bestNext.reading) < 0) bestNext = { members, reading };
    }
    if (!bestNext || (currentReading && compareReadings(bestNext.reading, currentReading) >= 0)) break;
    current = bestNext.members;
    currentReading = bestNext.reading;
  }
  const ranked = [...readings].sort(compareReadings);
  return { readings: ranked, best: ranked.find((one) => one.feasible) ?? null };
}

/** A problem shaped like a goal's: many openings, shared outreach, capital recycled, days and spend per world. */
function problemOf(seed: number, n: number, opts: { staggered: boolean; capital: number | null; needs: boolean }): PortfolioProblem {
  const rng = makeRng(seed, 1);
  const samples = 64;
  const activities: Activity[] = Array.from({ length: n }, (_, a) => {
    const cash = Array.from({ length: samples }, () => Math.round(rng() * 4_000));
    const days = Array.from({ length: samples }, () => Math.floor(rng() * 40));
    const spend = Array.from({ length: samples }, () => Math.round(rng() * 300));
    return {
      key: `o${a}`,
      label: `o${a}`,
      cash,
      days,
      spend,
      justified: a % 3 !== 0,
      capital: Math.round(rng() * 900),
      startDay: opts.staggered ? Math.floor(rng() * 20) : 0,
      ...(a % 2 === 0 ? { uses: { outreach: 0.25 }, riskGroup: 'shared-outreach' } : {}),
      ...(opts.needs && a % 4 === 1 ? { needs: [a % 8 === 1 ? 'platform' : 'supplier'] } : {}),
      ...(a % 5 === 0 && a + 1 < n ? { excludes: [`o${a + 1}`] } : {}),
    };
  });
  return {
    activities,
    target: 12_000,
    deadlineDays: 30,
    capacity: { outreach: 1 },
    ...(opts.capital !== null ? { startingCapital: opts.capital } : {}),
    spendCeiling: 2_500,
    riskCorrelation: { 'shared-outreach': 0.4 },
    resourceFailure: { platform: 0.1, supplier: 0.2 },
    worlds: 400,
    seed,
  };
}

describe('the portfolio evaluator reads exactly what it read before', () => {
  for (const [label, opts] of [
    ['one start day, capital recycled', { staggered: false, capital: 1_500, needs: true }],
    ['staggered starts (the prefix is rebuilt when a member starts earlier)', { staggered: true, capital: 2_000, needs: true }],
    ['no capital limit and no shared resources', { staggered: false, capital: null, needs: false }],
  ] as const) {
    it(`greedy search, ${label}`, () => {
      const problem = problemOf(label.length * 7919, 24, opts);
      const reference = referenceGreedy(problem);
      const result = optimizePortfolio(problem);
      expect(result.searched).toBe(reference.readings.length);
      expect(result.best).toEqual(reference.best);
      expect(result.ranked).toEqual(reference.readings.slice(0, 8));
    });
  }

  it('exhaustive search over a small portfolio', () => {
    const problem = problemOf(4242, 9, { staggered: true, capital: 1_200, needs: true });
    const worlds = problem.worlds!;
    const drawn = referenceWorlds(problem, worlds);
    const readings: PortfolioReading[] = [];
    for (let mask = 1; mask < 1 << 9; mask++) {
      const members: number[] = [];
      for (let i = 0; i < 9; i++) if (mask & (1 << i)) members.push(i);
      readings.push(referenceEvaluate(problem, members, drawn, worlds));
    }
    const ranked = readings.sort(compareReadings);
    const result = optimizePortfolio(problem);
    expect(result.best).toEqual(ranked.find((one) => one.feasible) ?? null);
    expect(result.ranked).toEqual(ranked.slice(0, 8));
  });

  it('a large greedy portfolio costs one member per world per candidate, not the whole combination', () => {
    // 60 openings: the shape that took ~30 s per evaluation in the 2026-11-14 reading (Postgres suite 43570017131's timed-out plan read).
    const problem = { ...problemOf(99, 60, { staggered: false, capital: 3_000, needs: true }), worlds: 2_000 };
    const started = performance.now();
    const result = optimizePortfolio(problem);
    const ms = performance.now() - started;
    expect(result.searched).toBeGreaterThan(300);
    // Generous for a contended CI runner; the from-scratch search is several times this.
    expect(ms).toBeLessThan(5_000);
  });
});

describe('reconstruction draws each key once', () => {
  it('reads the same estimates whether the draws are fresh or held', () => {
    const now = new Date('2026-11-14T00:00:00Z');
    const composed = composeArrangement({
      key: 'a',
      label: 'buyers',
      period: '30 days',
      currency: 'USD',
      demand: { buyers: { min: 0, max: 10_000 }, needRate: { min: 0, max: 4 }, reach: { min: 0, max: 1 }, conversion: { min: 0, max: 1 } },
      value: { min: 0, max: 10_000, observations: [1, 2, 3].map((i) => ({ id: `o${i}`, value: { kind: 'POINT' as const, value: 300 * i }, context: { payer: 'p' }, lineage: [`o${i}`], source: { kind: 'CASH_OPPORTUNITY' as const, ref: `o${i}` }, measures: 'price' })), context: { payer: 'p' }, material: [] },
      capture: { kind: 'COMMISSION', rate: { min: 0.05, max: 0.2 } },
      cost: { min: 0, max: 100 },
    } as Parameters<typeof composeArrangement>[0]);
    const first = reconstruct(composed.graph, composed.contribution, now).estimates;
    const second = reconstruct(composed.graph, composed.contribution, now).estimates;
    expect(second).toEqual(first);
  });
});

/** How long the loop was held, at worst, while `work` ran. */
async function worstStall<T>(work: () => Promise<T>): Promise<{ value: T; worst: number }> {
  let last = performance.now();
  let worst = 0;
  const tick = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last);
    last = t;
  }, 1);
  try {
    const value = await work();
    return { value, worst: Math.max(worst, performance.now() - last) };
  } finally {
    clearInterval(tick);
  }
}

function constructionJob(): ConstructionJob {
  const limits: GoalLimits = { daysLeft: 30, remainingCents: 1_000_000, capitalCeilingCents: 50_000, capitalBeforeProofCents: null, bestReachCents: null };
  const now = new Date('2026-11-14T00:00:00Z');
  const p = (name: string, from: 'INDUSTRY_MAP' | 'OPENING' = 'INDUSTRY_MAP') => ({ name, claimId: null, from, ref: `ref:${name}` });
  const priced = Array.from({ length: 30 }, (_, i) => ({
    id: `opp:${i}`,
    value: { kind: 'POINT' as const, value: 150 + 40 * i },
    context: { payer: `buyer ${i % 6}`, industry: 'services', arrangement: 'held' },
    lineage: [`opp:${i}`],
    source: { kind: 'CASH_OPPORTUNITY' as const, ref: `o${i}` },
    measures: 'a price',
  }));
  return {
    sectors: ['services', 'logistics', 'retail'].map((s) => ({
      name: s,
      demand: Array.from({ length: 6 }, (_, i) => p(`buyer ${i}`)),
      needs: [p(`${s} scheduling`), p(`${s} paperwork`)],
      supply: [p(`${s} contractors`)],
    })),
    opportunities: [],
    precedent: [],
    capability: { name: 'spreadsheets, documents', claimId: null, from: 'CAPABILITY', ref: 'deliverables' },
    priced,
    tiedUp: [],
    input: { projectId: 'p', currency: 'USD', delivers: ['spreadsheets', 'documents'], capitalCeilingCents: 50_000, daysLeft: 30, limits, now },
    limits,
    targets: targetProperties(limits).map((one) => one.property),
    exclusions: [],
    now,
  };
}

describe('the plan read\'s quant work runs beside the server\'s loop, never on it', () => {
  it('the construction pass runs on a pool thread, reads the same as inline, and never holds the loop', async () => {
    const job = constructionJob();
    const inline = await composeConstruction(job);
    expect(inline.length).toBeGreaterThan(50);
    const pool = openEvaluator(1);
    try {
      // The thread boots once (it loads the TypeScript loader); what is measured is the work.
      await pool.construct!(constructionJob());
      const { value, worst } = await worstStall(() => pool.construct!(job));
      expect(value).toEqual(inline);
      expect(worst).toBeLessThan(100);
    } finally {
      await pool.close();
    }
  }, 120_000);

  it('with no thread, the construction pass hands the loop back between designs', async () => {
    await composeConstruction(constructionJob(), 25);
    const { value, worst } = await worstStall(() => composeConstruction(constructionJob(), 25));
    expect(value.length).toBeGreaterThan(50);
    // The bound the repository's other loop tests use: a design is milliseconds, the pass is seconds.
    expect(worst).toBeLessThan(150);
  }, 120_000);

  it('a goal\'s portfolio evaluation on the pool never holds the loop', async () => {
    const input = { ...GOAL_10K_LIMITS, measuredRates: GOAL_10K_RECORD, seed: 11, openings: GOAL_10K_OPENINGS, worlds: 2_000 };
    const pool = openEvaluator(1);
    try {
      await pool.evaluate({ ...input, worlds: 200 });
      const { value, worst } = await worstStall(() => pool.evaluate(input));
      expect(value.best).toEqual(evaluateGoalPortfolio(input).best);
      expect(worst).toBeLessThan(100);
    } finally {
      await pool.close();
    }
  }, 120_000);
});
