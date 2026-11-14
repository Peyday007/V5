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
 *   * a resource an activity needs (a platform, a supplier) is drawn up or down
 *     once per world, so every activity that needs it fails in the same
 *     worlds; streams sharing a resource are never summed at their best case.
 *     `quant/graph.ts` reads shared-resource streams through this evaluator,
 *     so there is one treatment of shared capacity, risk and failure.
 *
 * Search is exhaustive over subsets up to `EXHAUSTIVE_LIMIT` activities and
 * greedy beyond it. The answer is a share of worlds; it is a probability only
 * when every activity's samples rest on evidence (`justified`), and the result
 * says which.
 */
import { inverseNormal, makeRng, normalCdf } from '../scenario/random.ts';
import { capitalTurnover, objectiveScore, type RouteObjective } from './deadline.ts';

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
   * Resources it cannot run without (a platform, a supplier, a licence). In a
   * world where any of them has failed it settles nothing and the capital it
   * tied up does not come back. Each needs a failure probability in the
   * problem's `resourceFailure`; one without is refused, never assumed reliable.
   * Activities needing the same resource fail together in the same worlds.
   */
  needs?: string[];
  /**
   * Money it pays out in each world, paired with `cash` by index (what it buys
   * to fulfil, what it pays a subcontractor, what it spends to reach buyers).
   * Read against the problem's `spendCeiling`, because a spending limit binds on
   * the combination in one world, never on an activity's average.
   */
  spend?: number[];
  /**
   * What the samples rest on. Absent means nothing is stated, which is never read
   * as favourable: a probability claim needs a stated sample size.
   */
  evidence?: {
    /** Independent real observations behind the samples (not the number of simulated draws). */
    sampleSize?: number;
    /** True when conditions have changed since the observations, so they may not transfer. */
    conditionsChanged?: boolean;
    /**
     * The market's own historical record, acquired from research and outcomes
     * (`quant/history.ts`, CAUSAL-14-7): bid/win counts, transaction counts,
     * actual prices. Its bids are real outcomes of the behavioural rate, so
     * when no sample is otherwise stated they are the sample; what it lacks is
     * a research need, never a favourable assumption.
     */
    history?: {
      sampleSize?: number;
      winRate?: { wins: number; bids: number };
      marketTransactions?: number;
      priceObservations: number;
      sources: string[];
      researchNeeds: string[];
    };
  };
}

/** A control whose effect on the downside is measured, not asserted. */
export interface Safeguard {
  key: string;
  kind: 'INDEPENDENT_CHANNEL' | 'DIVERSIFIED_COUNTERPARTY' | 'RESERVE_CAPACITY' | 'FASTER_CASH_CYCLE' | 'CONTINGENCY';
  /** Members of a risk group stop sharing its shock (independent channel, diversified counterparty). */
  decorrelate?: string[];
  /** Added capacity per resource (reserve capacity). */
  capacityBonus?: Record<string, number>;
  /** Multiplies days-to-cash of the named activities, 0 < f <= 1 (faster cash cycle). */
  daysFactor?: { activities: string[]; factor: number };
  /** Added starting capital held back for contingency. */
  capitalBonus?: number;
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
  /** Probability, for the period, that a resource some activity `needs` fails. */
  resourceFailure?: Record<string, number>;
  /** Controls to quantify against the best combination, over the same worlds. */
  safeguards?: Safeguard[];
  worlds?: number;
  seed?: number;
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
   * Risk-adjusted collectible contribution: the mean over every world of the
   * cash its members settle by the deadline less everything they paid out —
   * a world where a member never started or its cash landed late contributes
   * what it actually collected, so the risk is in the average, not beside it.
   * Gross settled cash (the percentiles above) is kept distinct from it.
   */
  contribution: number;
  /** That contribution per unit of capital tied up per day of cycle (`capitalTurnover`). */
  capitalTurnover: number;
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
  /** What the best combination's number may be called. Added alongside, never replacing, the readings. */
  assurance?: Assurance;
  /** Measured change to the downside from each safeguard, on the identical worlds. Present when safeguards were given. */
  safeguardEffects?: SafeguardEffect[];
}

export interface SafeguardEffect {
  key: string;
  kind: Safeguard['kind'];
  reachBefore: number;
  reachAfter: number;
  /** Change in the share of worlds reaching the target (positive helps). */
  reachChange: number;
  /** Change in the tenth-percentile settled cash: the bad-world outcome. */
  downsideChange: number;
  capitalShortChange: number;
}

export type AssuranceStatus = 'CLAIMS_AT_LEAST_90' | 'RANGE' | 'CALIBRATION_UNAVAILABLE';

export interface Assurance {
  status: AssuranceStatus;
  /** The strongest defensible range for reaching the target; null when calibration is unavailable. */
  range: { low: number; high: number } | null;
  /** True only when status is CLAIMS_AT_LEAST_90. */
  claimsAtLeast90: boolean;
  /** Share of simulated worlds reaching the target. Coverage of scenarios; not a probability unless status says so. */
  coverage: number | null;
  /** Inputs that make the figure a validation problem, never a favourable assumption. */
  validationProblems: string[];
  /** Tail: what the tenth-percentile world settles, against the target. */
  tailSettledP10: number | null;
  /**
   * The historical market data each member's figure used (CAUSAL-14-7): where
   * its sample came from, the bid/win record and transaction counts acquired,
   * and the sources. Empty when no member carried any history.
   */
  history?: Array<{
    key: string;
    sampleFrom: 'STATED' | 'HISTORY' | 'NONE';
    sampleSize: number | null;
    winRate: { wins: number; bids: number; rate: number } | null;
    marketTransactions: number | null;
    priceObservations: number;
    sources: string[];
  }>;
  /** Historical data a member still needs before its figure is calibrated: targeted research, not an assumption. */
  researchNeeds?: string[];
  reason: string;
}

/**
 * The sample behind one activity's figure. A stated sample (the observations
 * its inputs were reconstructed from) stands; where none is stated, the bids
 * of the market's acquired bid/win history are real outcomes of the very rate
 * the figure rests on and are the sample. An absent sample is never read as a large one.
 */
export function effectiveSample(one: Activity): { size: number | undefined; from: 'STATED' | 'HISTORY' | 'NONE' } {
  // A sample is a count of real observations: an infinite or non-numeric one
  // is no sample at all, and would collapse the interval to a certainty.
  const stated = one.evidence?.sampleSize;
  if (stated !== undefined && Number.isFinite(stated)) return { size: stated, from: 'STATED' };
  const fromHistory = one.evidence?.history?.sampleSize;
  if (fromHistory !== undefined && Number.isFinite(fromHistory) && fromHistory > 0) return { size: fromHistory, from: 'HISTORY' };
  return { size: undefined, from: 'NONE' };
}

export const MIN_EVIDENCE_SAMPLE = 20;
/** One-sided 95% normal quantile, used for the lower bound of a claim. */
const Z95 = 1.6449;
export const CLAIM_THRESHOLD = 0.9;

export const EXHAUSTIVE_LIMIT = 12;
const DEFAULT_WORLDS = 2_000;

function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/**
 * Every world, drawn once so every combination sees the same worlds: each
 * activity's sample index, and which needed resources are down. A resource is
 * drawn once per world, so every activity needing it fails in the same world.
 */
interface Worlds {
  picks: number[][];
  /** Resource → 1 in the worlds where it has failed. */
  down: Map<string, Uint8Array>;
}

/** Resources some activity needs whose failure probability is absent or impossible. */
export function missingResourceFailure(problem: PortfolioProblem): string[] {
  const needed = [...new Set(problem.activities.flatMap((one) => one.needs ?? []))];
  return needed.filter((id) => {
    const p = problem.resourceFailure?.[id];
    return p === undefined || !(p >= 0 && p <= 1);
  });
}

function drawOutages(problem: PortfolioProblem, worlds: number): Map<string, Uint8Array> {
  const seed = problem.seed ?? 20261031;
  const missing = missingResourceFailure(problem);
  if (missing.length > 0) throw new Error(`No failure probability is stated for ${missing.join(', ')}.`);
  const down = new Map<string, Uint8Array>();
  for (const id of [...new Set(problem.activities.flatMap((one) => one.needs ?? []))].sort()) {
    const p = problem.resourceFailure![id]!;
    const rng = makeRng(seed, seedOf(`resource:${id}`));
    const out = new Uint8Array(worlds);
    for (let i = 0; i < worlds; i++) out[i] = rng() < p ? 1 : 0;
    down.set(id, out);
  }
  return down;
}

function drawWorlds(problem: PortfolioProblem, worlds: number): Worlds {
  return { picks: drawPicks(problem, worlds), down: drawOutages(problem, worlds) };
}

function drawPicks(problem: PortfolioProblem, worlds: number): number[][] {
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

function evaluate(problem: PortfolioProblem, members: number[], drawn: Worlds, worlds: number): PortfolioReading {
  return evaluateWorlds(problem, members, drawn, worlds).reading;
}

interface WorldsReading {
  reading: PortfolioReading;
  /** Settled cash per world, ascending. Empty when the combination cannot run. */
  settled: Float64Array;
  /** Share of worlds in which no resource any member needs has failed. */
  allNeedsUp: number;
}

/*
 * The evaluator below is the quant engine's inner loop. The optimizer calls it
 * once per combination it reads — hundreds of combinations on a 40-opening
 * goal, each over every world — and in production it was most of the ~20 s of
 * CPU a minute that held the server's event loop (§109, 2026-11-13/14; a
 * 63-opening portfolio took ~30 s to evaluate once).
 *
 * Two things make it cheap without changing a single reading:
 *
 *  - Everything a world reads that does not change between worlds (each
 *    member's samples, start, capital, the outage vectors of what it needs) is
 *    resolved once, and the per-world state lives in typed arrays rather than
 *    an object per member per world.
 *  - A combination is its members in start order, and the state of every world
 *    after a prefix of them does not depend on what comes after. So the state
 *    after the prefix is held (`Prefix`), and a combination that only appends
 *    one member to it costs one member per world, not all of them. The greedy
 *    search reads exactly such combinations: every candidate is the current
 *    combination plus one, and members usually share a start day.
 *
 * Every world runs the same arithmetic in the same order as before, through the
 * one `turn`/`lastTurn` pair, whether the prefix was held or rebuilt.
 */

/** One member resolved for the world loop. */
interface Plan {
  start: number;
  need: number;
  days: number[];
  cash: number[];
  spend: number[] | null;
  /** Outage vectors of the resources it needs. */
  downs: Uint8Array[];
  pick: number[];
}

function planOf(problem: PortfolioProblem, drawn: Worlds, m: number): Plan {
  const act = problem.activities[m]!;
  return {
    start: act.startDay ?? 0,
    need: act.capital ?? 0,
    days: act.days,
    cash: act.cash,
    spend: act.spend ?? null,
    downs: (act.needs ?? []).map((id) => drawn.down.get(id)!),
    pick: drawn.picks[m]!,
  };
}

/**
 * Every world's state after some members have run, in start order: the money
 * in the pool, cash settled by the deadline, spending, capital tied up, the
 * last settle day, whether a member could not start, whether every resource a
 * member needs is up, and the cash not yet back in the pool (in the order it
 * was earned, `width` slots per world).
 */
interface Prefix {
  /** The members it ran, in start order. */
  members: number[];
  maxStart: number;
  capital: Float64Array;
  total: Float64Array;
  spent: Float64Array;
  held: Float64Array;
  lastDay: Float64Array;
  short: Uint8Array;
  up: Uint8Array;
  pending: Int32Array;
  /** The earliest day of any cash still pending, so a member starting before it need not look. */
  firstPending: Float64Array;
  width: number;
  pendingDay: Float64Array;
  pendingCash: Float64Array;
}

function emptyPrefix(problem: PortfolioProblem, worlds: number): Prefix {
  const capital = new Float64Array(worlds);
  capital.fill(problem.startingCapital ?? Infinity);
  const firstPending = new Float64Array(worlds);
  firstPending.fill(Infinity);
  const up = new Uint8Array(worlds);
  up.fill(1);
  return {
    members: [],
    maxStart: -Infinity,
    capital,
    total: new Float64Array(worlds),
    spent: new Float64Array(worlds),
    held: new Float64Array(worlds),
    lastDay: new Float64Array(worlds),
    short: new Uint8Array(worlds),
    up,
    pending: new Int32Array(worlds),
    firstPending,
    width: 0,
    pendingDay: new Float64Array(0),
    pendingCash: new Float64Array(0),
  };
}

/** Whether a resource `plan` needs is down in world `i`. */
function anyDown(plan: Plan, i: number): boolean {
  for (let r = 0; r < plan.downs.length; r++) if (plan.downs[r]![i] === 1) return true;
  return false;
}

/** Append one member to every world of `prefix`, in place: the member's turn, with the pool recycled and the pending cash kept. */
function turn(prefix: Prefix, plan: Plan, m: number, worlds: number, deadline: number): void {
  const k = prefix.members.length + 1;
  if (k > prefix.width) {
    const width = Math.max(4, prefix.width * 2, k);
    const day = new Float64Array(worlds * width);
    const cash = new Float64Array(worlds * width);
    for (let i = 0; i < worlds; i++) {
      for (let p = 0; p < prefix.pending[i]!; p++) {
        day[i * width + p] = prefix.pendingDay[i * prefix.width + p]!;
        cash[i * width + p] = prefix.pendingCash[i * prefix.width + p]!;
      }
    }
    prefix.width = width;
    prefix.pendingDay = day;
    prefix.pendingCash = cash;
  }
  const { start, need } = plan;
  const w = prefix.width;
  for (let i = 0; i < worlds; i++) {
    if (plan.downs.length > 0 && anyDown(plan, i)) prefix.up[i] = 0;
    let capital = prefix.capital[i]!;
    let pending = prefix.pending[i]!;
    const base = i * w;
    // Cash settled by this start day returns to the pool, once (newest first, as it always was summed).
    if (pending > 0 && prefix.firstPending[i]! <= start) {
      for (let p = pending - 1; p >= 0; p--) if (prefix.pendingDay[base + p]! <= start) capital += prefix.pendingCash[base + p]!;
      let kept = 0;
      let first = Infinity;
      for (let p = 0; p < pending; p++) {
        const d = prefix.pendingDay[base + p]!;
        if (d <= start) continue;
        prefix.pendingDay[base + kept] = d;
        prefix.pendingCash[base + kept] = prefix.pendingCash[base + p]!;
        if (d < first) first = d;
        kept += 1;
      }
      pending = kept;
      prefix.firstPending[i] = first;
    }
    if (need > capital + 1e-9) {
      prefix.short[i] = 1;
      prefix.capital[i] = capital;
      prefix.pending[i] = pending;
      continue;
    }
    capital -= need;
    prefix.held[i] = prefix.held[i]! + need;
    prefix.capital[i] = capital;
    // A needed resource is down in this world: nothing settles, and the capital tied up is not recovered.
    if (plan.downs.length > 0 && anyDown(plan, i)) {
      prefix.pending[i] = pending;
      continue;
    }
    const s = plan.pick[i]!;
    const day = start + plan.days[s]!;
    if (day > prefix.lastDay[i]!) prefix.lastDay[i] = day;
    // Capital comes back with the cash it earned.
    const cash = plan.cash[s]!;
    prefix.spent[i] = prefix.spent[i]! + (plan.spend ? (plan.spend[s] ?? 0) : 0);
    prefix.pendingDay[base + pending] = day;
    prefix.pendingCash[base + pending] = cash + need;
    if (day < prefix.firstPending[i]!) prefix.firstPending[i] = day;
    prefix.pending[i] = pending + 1;
    if (day <= deadline) prefix.total[i] = prefix.total[i]! + cash;
  }
  prefix.members.push(m);
  if (start > prefix.maxStart) prefix.maxStart = start;
}

/** The members in the order a combination runs them: by start day, ties kept in the order given. */
function startOrder(problem: PortfolioProblem, members: number[]): number[] {
  return [...members].sort((a, b) => (problem.activities[a]!.startDay ?? 0) - (problem.activities[b]!.startDay ?? 0));
}

function buildPrefix(problem: PortfolioProblem, ordered: number[], drawn: Worlds, worlds: number): Prefix {
  const prefix = emptyPrefix(problem, worlds);
  for (const m of ordered) turn(prefix, planOf(problem, drawn, m), m, worlds, problem.deadlineDays);
  return prefix;
}

/**
 * Read a combination that runs `prefix`'s members and then `last` (or nothing
 * more when `last` is null): the last member's turn needs nothing kept after
 * it, so it reads the prefix without changing it.
 */
function readAfter(problem: PortfolioProblem, members: number[], prefix: Prefix, last: Plan | null, worlds: number): WorldsReading {
  const keys = members.map((m) => problem.activities[m]!.key);
  const justified = members.every((m) => problem.activities[m]!.justified);
  const deadline = problem.deadlineDays;
  const settled = new Float64Array(worlds);
  let allUp = 0;
  let reached = 0;
  let short = 0;
  let over = 0;
  let contributed = 0;
  let tied = 0;
  let cycled = 0;
  const w = prefix.width;
  for (let i = 0; i < worlds; i++) {
    let total = prefix.total[i]!;
    let spent = prefix.spent[i]!;
    let held = prefix.held[i]!;
    let lastDay = prefix.lastDay[i]!;
    let wasShort = prefix.short[i] === 1;
    let up = prefix.up[i] === 1;
    if (last) {
      const failed = last.downs.length > 0 && anyDown(last, i);
      if (failed) up = false;
      let capital = prefix.capital[i]!;
      const pending = prefix.pending[i]!;
      if (pending > 0 && prefix.firstPending[i]! <= last.start) {
        const base = i * w;
        for (let p = pending - 1; p >= 0; p--) if (prefix.pendingDay[base + p]! <= last.start) capital += prefix.pendingCash[base + p]!;
      }
      if (last.need > capital + 1e-9) {
        wasShort = true;
      } else {
        held += last.need;
        if (!failed) {
          const s = last.pick[i]!;
          const day = last.start + last.days[s]!;
          if (day > lastDay) lastDay = day;
          const cash = last.cash[s]!;
          spent += last.spend ? (last.spend[s] ?? 0) : 0;
          if (day <= deadline) total += cash;
        }
      }
    }
    if (up) allUp += 1;
    settled[i] = total;
    contributed += total - spent;
    tied += held;
    cycled += lastDay;
    const overCeiling = problem.spendCeiling !== undefined && spent > problem.spendCeiling + 1e-9;
    if (overCeiling) over += 1;
    if (total >= problem.target && !overCeiling) reached += 1;
    if (wasShort) short += 1;
  }
  // A typed array sorts numerically in place, without a comparator call per comparison.
  const sorted = settled.sort();
  const q = (p: number) => sorted[Math.min(worlds - 1, Math.floor(p * worlds))]!;
  const contribution = contributed / worlds;
  const turnover = capitalTurnover(contribution, tied / worlds, cycled / worlds) ?? 0;
  return {
    reading: { keys, reach: reached / worlds, settledP10: q(0.1), settledP50: q(0.5), settledP90: q(0.9), capitalShort: short / worlds, overSpend: over / worlds, contribution, capitalTurnover: turnover, feasible: true, infeasibleBecause: null, basis: justified ? 'PROBABILITY' : 'COVERAGE' },
    settled: sorted,
    allNeedsUp: allUp / worlds,
  };
}

function refusedReading(problem: PortfolioProblem, members: number[], refusal: string): WorldsReading {
  const keys = members.map((m) => problem.activities[m]!.key);
  const justified = members.every((m) => problem.activities[m]!.justified);
  return { reading: { keys, reach: 0, settledP10: 0, settledP50: 0, settledP90: 0, capitalShort: 0, overSpend: 0, contribution: 0, capitalTurnover: 0, feasible: false, infeasibleBecause: refusal, basis: justified ? 'PROBABILITY' : 'COVERAGE' }, settled: new Float64Array(0), allNeedsUp: 0 };
}

function evaluateWorlds(problem: PortfolioProblem, members: number[], drawn: Worlds, worlds: number): WorldsReading {
  const refusal = refuse(problem, members);
  if (refusal) return refusedReading(problem, members, refusal);
  const ordered = startOrder(problem, members);
  const last = ordered.pop();
  const prefix = buildPrefix(problem, ordered, drawn, worlds);
  return readAfter(problem, members, prefix, last === undefined ? null : planOf(problem, drawn, last), worlds);
}

/**
 * `current` (in the order the search added it, whose start-ordered state
 * `prefix` holds) plus `extra`, read from the held prefix when `extra` runs
 * last in start order — the same reading `evaluateWorlds` gives, for one
 * member's work per world.
 */
function evaluateExtending(problem: PortfolioProblem, prefix: Prefix, current: number[], extra: number, drawn: Worlds, worlds: number): WorldsReading {
  const members = [...current, extra];
  const refusal = refuse(problem, members);
  if (refusal) return refusedReading(problem, members, refusal);
  if ((problem.activities[extra]!.startDay ?? 0) < prefix.maxStart) return evaluateWorlds(problem, members, drawn, worlds);
  return readAfter(problem, members, prefix, planOf(problem, drawn, extra), worlds);
}


export interface CombinationReading extends PortfolioReading {
  /** Mean settled cash across worlds. */
  settledMean: number;
  /** Share of worlds in which every resource some member needs is up. */
  allNeedsUp: number;
  /** Share of worlds settling at or below `atOrBelow`, when it was asked for. */
  shareAtOrBelow: number | null;
  worlds: number;
}

/**
 * Evaluate every activity of the problem running together, over the same
 * drawn worlds the optimizer uses — the one evaluator for shared capacity,
 * shared risk and shared resource failure. Refuses a needed resource with no
 * stated failure probability rather than assuming it reliable.
 */
export function evaluateCombination(problem: PortfolioProblem, atOrBelow?: number): CombinationReading | { missing: string[] } {
  const missing = missingResourceFailure(problem);
  if (missing.length > 0) return { missing };
  const worlds = problem.worlds ?? DEFAULT_WORLDS;
  const members = problem.activities.map((_, i) => i);
  const { reading, settled, allNeedsUp } = evaluateWorlds(problem, members, drawWorlds(problem, worlds), worlds);
  const settledMean = settled.length ? settled.reduce((sum, x) => sum + x, 0) / settled.length : 0;
  const shareAtOrBelow = atOrBelow === undefined || !settled.length ? null : settled.filter((x) => x <= atOrBelow + 1e-9).length / settled.length;
  return { ...reading, settledMean, allNeedsUp, shareAtOrBelow, worlds };
}

/**
 * The objective a tie on reach is broken by (MONEY-13-4: "optimize capital
 * turnover and risk-adjusted collectible contribution for the particular
 * objective"). Combinations that reach the target equally often are told
 * apart by how fast they turn the capital they tie up; combinations that never
 * reach it, by how much collectible contribution they bring toward it.
 */
export function tieObjective(reach: number): RouteObjective {
  return reach > 0 ? 'TURNOVER' : 'CONTRIBUTION';
}

function scoreOf(r: PortfolioReading, objective: RouteObjective): number {
  return objectiveScore({ capitalTurnover: r.capitalTurnover, riskAdjustedContribution: r.contribution }, objective) ?? -Infinity;
}

export function compareReadings(a: PortfolioReading, b: PortfolioReading): number {
  if (a.feasible !== b.feasible) return Number(b.feasible) - Number(a.feasible);
  if (a.reach !== b.reach) return b.reach - a.reach;
  const objective = tieObjective(a.reach);
  return scoreOf(b, objective) - scoreOf(a, objective) || b.settledP50 - a.settledP50 || a.keys.length - b.keys.length;
}

const better = compareReadings;

/** Find the combination most likely to reach the target, with every alternative ranked. */
export function optimizePortfolio(problem: PortfolioProblem): PortfolioResult {
  const worlds = problem.worlds ?? DEFAULT_WORLDS;
  const n = problem.activities.length;
  if (n === 0) return { best: null, ranked: [], singles: [], refused: [], searched: 0 };
  const missing = missingResourceFailure(problem);
  if (missing.length > 0) throw new Error(`No failure probability is stated for ${missing.join(', ')}.`);
  const picks = drawWorlds(problem, worlds);
  const readings: PortfolioReading[] = [];
  const refused: PortfolioResult['refused'] = [];
  const keep = (reading: PortfolioReading) => {
    if (!reading.feasible) refused.push({ keys: reading.keys, reason: reading.infeasibleBecause! });
    readings.push(reading);
    return reading;
  };
  const record = (members: number[]) => keep(evaluate(problem, members, picks, worlds));
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
    // Every world's state after `current`, so each candidate costs one member per world (see `Prefix`).
    let prefix = emptyPrefix(problem, worlds);
    for (;;) {
      let bestNext: { members: number[]; reading: PortfolioReading } | null = null;
      for (let i = 0; i < n; i++) {
        if (current.includes(i)) continue;
        const reading = keep(evaluateExtending(problem, prefix, current, i, picks, worlds).reading);
        if (!bestNext || better(reading, bestNext.reading) < 0) bestNext = { members: [...current, i], reading };
      }
      if (!bestNext || (currentReading && better(bestNext.reading, currentReading) >= 0)) break;
      current = bestNext.members;
      currentReading = bestNext.reading;
      const added = current[current.length - 1]!;
      if ((problem.activities[added]!.startDay ?? 0) >= prefix.maxStart) turn(prefix, planOf(problem, picks, added), added, worlds, problem.deadlineDays);
      else prefix = buildPrefix(problem, startOrder(problem, current), picks, worlds);
    }
  }
  const ranked = [...readings].sort(better);
  const best = ranked.find((one) => one.feasible) ?? null;
  const result: PortfolioResult = { best, ranked: ranked.slice(0, 8), singles, refused, searched: readings.length, assurance: assess(problem, best) };
  if (best && problem.safeguards?.length) {
    const members = best.keys.map((k) => problem.activities.findIndex((a) => a.key === k));
    result.safeguardEffects = problem.safeguards.map((guard) => {
      const after = withSafeguard(problem, guard, members, worlds, picks);
      return {
        key: guard.key,
        kind: guard.kind,
        reachBefore: best.reach,
        reachAfter: after.reach,
        reachChange: after.reach - best.reach,
        downsideChange: after.settledP10 - best.settledP10,
        capitalShortChange: after.capitalShort - best.capitalShort,
      };
    });
  }
  return result;
}

/**
 * What the best combination's figure may be called. A probability is claimed only
 * when every member's samples rest on evidence with a stated sample size and
 * unchanged conditions; the range widens with the smallest sample behind any
 * member (the weakest link bounds the claim); at least 90% is claimed only when
 * the lower bound clears it. Otherwise the answer is a range, or that
 * calibration is unavailable. An input without evidence is a validation problem
 * and is never read as favourable.
 */
export function assess(problem: PortfolioProblem, best: PortfolioReading | null): Assurance {
  if (!best) {
    return { status: 'CALIBRATION_UNAVAILABLE', range: null, claimsAtLeast90: false, coverage: null, validationProblems: ['no feasible combination'], tailSettledP10: null, history: [], researchNeeds: [], reason: 'no feasible combination exists, so there is nothing to calibrate' };
  }
  const members = problem.activities.filter((one) => best.keys.includes(one.key));
  const problems: string[] = [];
  const samples = new Map(members.map((one) => [one.key, effectiveSample(one)]));
  for (const one of members) {
    const sample = samples.get(one.key)!;
    if (!one.justified) problems.push(`"${one.key}": samples are not evidence-backed (invented or unvalidated inputs)`);
    else if (sample.size === undefined || !(sample.size >= MIN_EVIDENCE_SAMPLE)) {
      problems.push(`"${one.key}": sample size ${sample.size === undefined ? 'is not stated and no bid/win history was acquired' : `${sample.size} is under ${MIN_EVIDENCE_SAMPLE}${sample.from === 'HISTORY' ? ' (from acquired bid/win history)' : ''}`}`);
    }
    if (one.evidence?.conditionsChanged) problems.push(`"${one.key}": conditions changed since its observations, so they may not transfer`);
  }
  const history = members
    .filter((one) => one.evidence?.history)
    .map((one) => {
      const h = one.evidence!.history!;
      const sample = samples.get(one.key)!;
      return {
        key: one.key,
        sampleFrom: sample.from,
        sampleSize: sample.size ?? null,
        winRate: h.winRate && h.winRate.bids > 0 ? { ...h.winRate, rate: h.winRate.wins / h.winRate.bids } : null,
        marketTransactions: h.marketTransactions ?? null,
        priceObservations: h.priceObservations,
        sources: h.sources,
      };
    });
  const researchNeeds = [
    ...new Set(
      members.flatMap((one) => {
        if (samples.get(one.key)!.from === 'STATED' && one.justified) return [];
        const needs = one.evidence?.history?.researchNeeds ?? [];
        return needs.length > 0 || one.evidence?.history ? needs : [`"${one.key}": acquire the market's historical record (transaction counts, actual prices and spreads, bid/win rates)`];
      }),
    ),
  ];
  const base = { coverage: best.reach, tailSettledP10: best.settledP10, validationProblems: problems, history, researchNeeds };
  if (problems.length > 0) {
    return { ...base, status: 'CALIBRATION_UNAVAILABLE', range: null, claimsAtLeast90: false, reason: `calibration is unavailable: ${problems.length} input(s) fail validation; the ${round(best.reach * 100)}% is share of scenarios covered, not a probability` };
  }
  const nMin = Math.min(...members.map((one) => samples.get(one.key)!.size!));
  // Wilson interval on the weakest sample: unlike the normal interval it never collapses to zero width at 0% or 100%.
  const z2 = Z95 * Z95;
  const centre = (best.reach + z2 / (2 * nMin)) / (1 + z2 / nMin);
  const half = (Z95 * Math.sqrt((best.reach * (1 - best.reach)) / nMin + z2 / (4 * nMin * nMin))) / (1 + z2 / nMin);
  const low = Math.max(0, centre - half);
  const high = Math.min(1, centre + half);
  const claims = low >= CLAIM_THRESHOLD;
  return {
    ...base,
    status: claims ? 'CLAIMS_AT_LEAST_90' : 'RANGE',
    range: { low, high },
    claimsAtLeast90: claims,
    reason: claims
      ? `calibrated evidence (smallest sample ${nMin}) puts the lower bound at ${round(low * 100)}%, above ${CLAIM_THRESHOLD * 100}%`
      : `strongest defensible range is ${round(low * 100)}%–${round(high * 100)}% (smallest sample ${nMin}); the lower bound does not reach ${CLAIM_THRESHOLD * 100}%`,
  };
}

/** Re-evaluates `members` with a safeguard applied, over the very same drawn worlds. */
function withSafeguard(problem: PortfolioProblem, guard: Safeguard, members: number[], worlds: number, picks: Worlds): PortfolioReading {
  const activities = problem.activities.map((one) => {
    let next = one;
    if (guard.decorrelate?.includes(one.key) && one.riskGroup) next = { ...next, riskGroup: undefined };
    if (guard.daysFactor?.activities.includes(one.key)) next = { ...next, days: one.days.map((d) => d * Math.min(1, Math.max(0, guard.daysFactor!.factor))) };
    return next;
  });
  const capacity = { ...(problem.capacity ?? {}) };
  for (const [r, extra] of Object.entries(guard.capacityBonus ?? {})) capacity[r] = (capacity[r] ?? 0) + extra;
  const startingCapital = problem.startingCapital === undefined ? undefined : problem.startingCapital + (guard.capitalBonus ?? 0);
  const adjusted: PortfolioProblem = { ...problem, activities, capacity, startingCapital };
  // Decorrelating changes how worlds are drawn, so redraw only then; every other safeguard reuses the same picks.
  const usePicks = guard.decorrelate?.length ? { picks: drawPicks(adjusted, worlds), down: picks.down } : picks;
  return evaluate(adjusted, members, usePicks, worlds);
}
