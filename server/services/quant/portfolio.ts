/**
 * Several activities toward one target, under the constraints they share.
 *
 * Individual readings cannot be summed. Two openings that each need the
 * owner's whole week cannot both run; money one returns on day 6 can fund one
 * that starts on day 8 and not one that starts on day 3; two openings exposed
 * to the same market shock fail together, so their combined chance is not the
 * product of their chances. This module evaluates a *combination* world by
 * world:
 *
 *   * every activity's settled cash and days-to-cash are drawn jointly from its
 *     own samples, with activities sharing a risk group drawn through a common
 *     factor (a Gaussian copula with the declared correlation);
 *   * capacity resources (hours, a vehicle, a licence slot) are checked per
 *     combination — over capacity, the combination is infeasible, not trimmed;
 *   * capital is recycled in start order: an activity may start only if the
 *     starting capital plus cash already settled by its start day covers what
 *     it ties up, otherwise it does not run in that world;
 *   * only cash that settles by the deadline counts toward the target.
 *
 * Search is exhaustive over subsets up to `EXHAUSTIVE_LIMIT` activities and
 * greedy beyond it. The answer is a share of worlds; it is a probability only
 * when every activity's samples rest on evidence (`justified`), and the result
 * says which.
 */
import { inverseNormal, makeRng, normalCdf } from '../scenario/random.ts';
import { capitalTurnover } from './deadline.ts';

export interface Activity {
  key: string;
  label: string;
  /** Cash it settles, per world (major units). Paired with `days`. */
  cash: number[];
  /** Days from start until that cash is usable, per world. */
  days: number[];
  /** True when its samples rest on evidence and may be read as probabilities. */
  justified: boolean;
  /** Capacity used: resource → amount (hours, units). */
  uses?: Record<string, number>;
  /** Money it ties up at its start. */
  capital?: number;
  /** The day it starts. */
  startDay?: number;
  /** A shared risk: activities in one group move together. */
  riskGroup?: string;
  /** Keys it cannot run alongside (one market, one buyer, one slot). */
  excludes?: string[];
  /**
   * Money it pays out in each world, paired with `cash` by index (what it buys
   * to fulfil, what it pays a subcontractor, what it spends to reach buyers).
   * Read against the problem's `spendCeiling`, because a spending limit binds on
   * the combination in one world, never on an activity's average.
   */
  spend?: number[];
}

export interface PortfolioProblem {
  activities: Activity[];
  target: number;
  deadlineDays: number;
  /** Capacity per resource. A resource no activity names is ignored. */
  capacity?: Record<string, number>;
  startingCapital?: number;
  /** Correlation within a risk group, 0–0.95. */
  riskCorrelation?: Record<string, number>;
  /** Total money the combination may pay out in one world. A world over it does not reach the target. */
  spendCeiling?: number;
  worlds?: number;
  seed?: number;
  /** What the combination is chosen for; REACH when unstated. */
  objective?: PortfolioObjective;
}

export interface PortfolioReading {
  keys: string[];
  /** Share of worlds reaching the target by the deadline. */
  reach: number;
  settledP10: number;
  settledP50: number;
  settledP90: number;
  /** Share of worlds in which some member could not start for want of capital. */
  capitalShort: number;
  /** Share of worlds whose combined spending broke the spending ceiling (0 when there is none). */
  overSpend: number;
  /**
   * Risk-adjusted collectible contribution (MONEY-13-4): the mean, over every
   * world, of cash settled by the deadline less what the combination paid out
   * in that world. A world where a member never started or its cash settled
   * late contributes nothing for it, so the collection risk is in the mean.
   */
  riskAdjustedContribution: number;
  /**
   * That contribution per unit of capital tied up per day of the cycle
   * (`capitalTurnover` in `deadline.ts`): the mean capital the members that
   * started tied up, over the mean days until the last of them settled.
   */
  capitalTurnover: number | null;
  feasible: boolean;
  /** Why it cannot run at all, when it cannot. */
  infeasibleBecause: string | null;
  basis: 'PROBABILITY' | 'COVERAGE';
}

export interface PortfolioResult {
  best: PortfolioReading | null;
  /** The best few, then every single activity, for comparison. */
  ranked: PortfolioReading[];
  singles: PortfolioReading[];
  /** Combinations refused before any world was drawn. */
  refused: Array<{ keys: string[]; reason: string }>;
  searched: number;
}

export const EXHAUSTIVE_LIMIT = 12;
const DEFAULT_WORLDS = 2_000;

function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/** Each activity's sample index per world, drawn once so every combination sees the same worlds. */
function drawWorlds(problem: PortfolioProblem, worlds: number): number[][] {
  const seed = problem.seed ?? 20261031;
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
  return problem.activities.map((activity) => {
    const n = activity.cash.length;
    if (n === 0 || activity.days.length !== n) throw new Error(`Activity "${activity.key}" needs paired cash and days samples.`);
    if (activity.spend && activity.spend.length !== n) throw new Error(`Activity "${activity.key}" needs spend samples paired with its cash samples.`);
    // Rank worlds by cash so a bad shared shock means low cash for every member.
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
}

function refuse(problem: PortfolioProblem, members: number[]): string | null {
  const acts = members.map((m) => problem.activities[m]!);
  const keys = new Set(acts.map((one) => one.key));
  for (const one of acts) {
    const clash = (one.excludes ?? []).find((other) => keys.has(other));
    if (clash) return `"${one.key}" and "${clash}" cannot run together`;
  }
  const used = new Map<string, number>();
  for (const one of acts) for (const [r, amount] of Object.entries(one.uses ?? {})) used.set(r, (used.get(r) ?? 0) + amount);
  for (const [r, amount] of used) {
    const cap = problem.capacity?.[r];
    if (cap !== undefined && amount > cap + 1e-9) return `needs ${round(amount)} ${r} and only ${round(cap)} is available`;
  }
  return null;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

function evaluate(problem: PortfolioProblem, members: number[], picks: number[][], worlds: number): PortfolioReading {
  const keys = members.map((m) => problem.activities[m]!.key);
  const refusal = refuse(problem, members);
  const justified = members.every((m) => problem.activities[m]!.justified);
  if (refusal) return { keys, reach: 0, settledP10: 0, settledP50: 0, settledP90: 0, capitalShort: 0, overSpend: 0, riskAdjustedContribution: 0, capitalTurnover: null, feasible: false, infeasibleBecause: refusal, basis: justified ? 'PROBABILITY' : 'COVERAGE' };
  const ordered = [...members].sort((a, b) => (problem.activities[a]!.startDay ?? 0) - (problem.activities[b]!.startDay ?? 0));
  const settled = new Float64Array(worlds);
  let reached = 0;
  let short = 0;
  let over = 0;
  let contributionSum = 0;
  let capitalSum = 0;
  let cycleSum = 0;
  const pending: Array<{ day: number; cash: number }> = [];
  for (let i = 0; i < worlds; i++) {
    let capital = problem.startingCapital ?? Infinity;
    let total = 0;
    let wasShort = false;
    let spent = 0;
    let tiedUp = 0;
    let lastDay = 0;
    pending.length = 0;
    for (const m of ordered) {
      const act = problem.activities[m]!;
      const s = picks[m]![i]!;
      const start = act.startDay ?? 0;
      const need = act.capital ?? 0;
      // Cash settled by this start day returns to the pool, once.
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
      tiedUp += need;
      const day = start + act.days[s]!;
      if (day > lastDay) lastDay = day;
      // Capital comes back with the cash it earned.
      const cash = act.cash[s]!;
      spent += act.spend?.[s] ?? 0;
      pending.push({ day, cash: cash + need });
      if (day <= problem.deadlineDays) total += cash;
    }
    settled[i] = total;
    contributionSum += total - spent;
    capitalSum += tiedUp;
    cycleSum += lastDay;
    const overCeiling = problem.spendCeiling !== undefined && spent > problem.spendCeiling + 1e-9;
    if (overCeiling) over += 1;
    if (total >= problem.target && !overCeiling) reached += 1;
    if (wasShort) short += 1;
  }
  const sorted = Array.from(settled).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(worlds - 1, Math.floor(p * worlds))]!;
  return { keys, reach: reached / worlds, settledP10: q(0.1), settledP50: q(0.5), settledP90: q(0.9), capitalShort: short / worlds, overSpend: over / worlds, riskAdjustedContribution: contributionSum / worlds, capitalTurnover: capitalTurnover(contributionSum / worlds, capitalSum / worlds, cycleSum / worlds), feasible: true, infeasibleBecause: null, basis: justified ? 'PROBABILITY' : 'COVERAGE' };
}

/**
 * What a combination is chosen for. REACH is a goal's own objective — the share
 * of worlds that settle the target by the deadline — and is the default; a
 * caller optimizing money velocity or collectible margin names TURNOVER or
 * CONTRIBUTION. Whatever leads, the other money measures break its ties in
 * place of gross settled cash, so between combinations that reach the target
 * equally the one leaving more collectible margin, then turning capital faster,
 * is chosen (MONEY-13-4: "Optimize capital turnover and risk-adjusted
 * collectible contribution for the particular objective, not an automatic
 * requirement to retain all cash"). Nothing here ranks by retained cash.
 */
export type PortfolioObjective = 'REACH' | 'CONTRIBUTION' | 'TURNOVER';

const EPS = 1e-9;
const desc = (a: number, b: number) => (Math.abs(b - a) <= EPS * Math.max(1, Math.abs(a), Math.abs(b)) ? 0 : b - a);
const turnoverOf = (r: PortfolioReading) => r.capitalTurnover ?? -Infinity;
const byTurnover = (a: PortfolioReading, b: PortfolioReading) => {
  const ta = turnoverOf(a);
  const tb = turnoverOf(b);
  return ta === tb ? 0 : desc(ta, tb);
};

export function comparer(objective: PortfolioObjective = 'REACH'): (a: PortfolioReading, b: PortfolioReading) => number {
  const reach = (a: PortfolioReading, b: PortfolioReading) => desc(a.reach, b.reach);
  const contribution = (a: PortfolioReading, b: PortfolioReading) => desc(a.riskAdjustedContribution, b.riskAdjustedContribution);
  const order =
    objective === 'TURNOVER' ? [byTurnover, contribution, reach] : objective === 'CONTRIBUTION' ? [contribution, byTurnover, reach] : [reach, contribution, byTurnover];
  return (a, b) => {
    const f = Number(b.feasible) - Number(a.feasible);
    if (f) return f;
    for (const one of order) {
      const d = one(a, b);
      if (d) return d;
    }
    return b.settledP50 - a.settledP50 || a.keys.length - b.keys.length;
  };
}

/** Find the combination most likely to reach the target, with every alternative ranked. */
export function optimizePortfolio(problem: PortfolioProblem): PortfolioResult {
  const worlds = problem.worlds ?? DEFAULT_WORLDS;
  const better = comparer(problem.objective);
  const n = problem.activities.length;
  if (n === 0) return { best: null, ranked: [], singles: [], refused: [], searched: 0 };
  const picks = drawWorlds(problem, worlds);
  const readings: PortfolioReading[] = [];
  const refused: PortfolioResult['refused'] = [];
  const record = (members: number[]) => {
    const reading = evaluate(problem, members, picks, worlds);
    if (!reading.feasible) refused.push({ keys: reading.keys, reason: reading.infeasibleBecause! });
    readings.push(reading);
    return reading;
  };
  const singles = problem.activities.map((_, i) => record([i]));
  if (n <= EXHAUSTIVE_LIMIT) {
    for (let mask = 1; mask < 1 << n; mask++) {
      const members: number[] = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) members.push(i);
      if (members.length > 1) record(members);
    }
  } else {
    // Greedy: keep adding the activity that most improves the reading.
    let current: number[] = [];
    let currentReading: PortfolioReading | null = null;
    for (;;) {
      let bestNext: { members: number[]; reading: PortfolioReading } | null = null;
      for (let i = 0; i < n; i++) {
        if (current.includes(i)) continue;
        const members = [...current, i];
        const reading = record(members);
        if (!bestNext || better(reading, bestNext.reading) < 0) bestNext = { members, reading };
      }
      if (!bestNext || (currentReading && better(bestNext.reading, currentReading) >= 0)) break;
      current = bestNext.members;
      currentReading = bestNext.reading;
    }
  }
  const ranked = [...readings].sort(better);
  const best = ranked.find((one) => one.feasible) ?? null;
  return { best, ranked: ranked.slice(0, 8), singles, refused, searched: readings.length };
}
