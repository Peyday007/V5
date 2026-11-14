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
   * Its spend is paid from the buyer's own prepayment (§99 prepaid
   * fulfilment): it still leaves the cash kept, but it does not count against
   * the spending ceiling, which limits the owner's money only.
   */
  ceilingExempt?: boolean;
  /**
   * Part of its cash that arrives earlier than the rest (a deposit at signing),
   * paired with `cash` by index: `cash` is then the balance, at `days`.
   */
  early?: { cash: number[]; days: number[] };
  /** Deals it closes per sample, paired with `cash`: the units a market cap counts. */
  deals?: number[];
  /**
   * The market its deals come from. Activities naming one market share it: in
   * a world their deals together never exceed the market's volume, drawn once
   * (`marketVolume`, paired with `cash`), and each member is cut in proportion.
   */
  market?: string;
  marketVolume?: number[];
  /** It may start only once some member's cash has settled by its start day (first proof). */
  requiresProof?: boolean;
  /**
   * The same activity's samples when a gate (a purchase made after proof)
   * has opened in the world: read instead of `cash`/`days`/`spend`/`deals`.
   */
  gated?: { gate: string; cash: number[]; days: number[]; spend?: number[]; deals?: number[]; early?: { cash: number[]; days: number[] } };
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
  /**
   * What reaching the target means. `SETTLED` (the default, for callers whose
   * target is gross receipts): cash settled by the deadline. `KEPT` (a goal's
   * cash target, §99): settled cash less everything the combination paid out
   * — its direct costs, buyer-funded or not, and `fixedCost`.
   */
  reachOn?: 'SETTLED' | 'KEPT';
  /** Money already committed outside the activities (capacity or channels bought before proof); it leaves the cash kept in every world. */
  fixedCost?: number;
  /**
   * Purchases made only after proof (§99 Q-7): in a world, a gate opens at
   * `day` only if some cash has settled by then and the capital left covers
   * its first `tranche`; then `cost` is paid, and activities naming it read
   * their `gated` samples. A gate no member names is never bought.
   */
  gates?: Array<{ id: string; day: number; tranche: number; cost: number }>;
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
  /** Median cash kept (settled less paid out) across worlds. */
  keptP50?: number;
  /** Median deals closed across worlds, when members state their deals. */
  dealsP50?: number;
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
    for (const [name, xs] of [['early', activity.early?.cash], ['deals', activity.deals], ['market volume', activity.marketVolume], ['gated', activity.gated?.cash]] as const) {
      if (xs && xs.length !== n) throw new Error(`Activity "${activity.key}" needs ${name} samples paired with its cash samples.`);
    }
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
  settled: number[];
  /** Share of worlds in which no resource any member needs has failed. */
  allNeedsUp: number;
}

function evaluateWorlds(problem: PortfolioProblem, members: number[], drawn: Worlds, worlds: number): WorldsReading {
  const { picks, down } = drawn;
  const keys = members.map((m) => problem.activities[m]!.key);
  const refusal = refuse(problem, members);
  const justified = members.every((m) => problem.activities[m]!.justified);
  if (refusal) return { reading: { keys, reach: 0, settledP10: 0, settledP50: 0, settledP90: 0, capitalShort: 0, overSpend: 0, contribution: 0, capitalTurnover: 0, feasible: false, infeasibleBecause: refusal, basis: justified ? 'PROBABILITY' : 'COVERAGE' }, settled: [], allNeedsUp: 0 };
  const memberNeeds = [...new Set(members.flatMap((m) => problem.activities[m]!.needs ?? []))];
  let allUp = 0;
  const onKept = problem.reachOn === 'KEPT';
  // A cost committed outside the activities leaves the cash kept; gross receipts are a different target.
  const fixedCost = onKept ? Math.max(0, problem.fixedCost ?? 0) : 0;
  // Gates a member names are bought in start order with the members; one nobody names is not bought.
  const named = new Set(members.flatMap((m) => (problem.activities[m]!.gated ? [problem.activities[m]!.gated!.gate] : [])));
  const gates = (problem.gates ?? []).filter((g) => named.has(g.id));
  type Gate = (typeof gates)[number];
  type Entry = { m: number; gate: null; start: number } | { m: -1; gate: Gate; start: number };
  const ordered: Entry[] = [
    ...members.map((m): Entry => ({ m, gate: null, start: problem.activities[m]!.startDay ?? 0 })),
    ...gates.map((gate): Entry => ({ m: -1, gate, start: gate.day })),
  ].sort((a, b) => a.start - b.start || (a.gate ? 1 : 0) - (b.gate ? 1 : 0));
  // Members drawing on one market cap their deals together, world by world.
  const markets = new Map<string, number[]>();
  for (const m of members) {
    const key = problem.activities[m]!.market;
    if (key) markets.set(key, [...(markets.get(key) ?? []), m]);
  }
  const grouped = [...markets.values()].filter((g) => g.length > 1);
  const anyDeals = members.some((m) => problem.activities[m]!.deals);
  const settled = new Float64Array(worlds);
  const keptAt = new Float64Array(worlds);
  const dealsAt = new Float64Array(worlds);
  const scale = new Float64Array(problem.activities.length).fill(1);
  const gateOpen = new Map<string, boolean>();
  let reached = 0;
  let short = 0;
  let over = 0;
  let contributed = 0;
  let tied = 0;
  let cycled = 0;
  const pending: Array<{ day: number; cash: number; back: number }> = [];
  type Arrays = { cash: number[]; days: number[]; spend?: number[]; deals?: number[]; early?: { cash: number[]; days: number[] } };
  const arraysOf = (act: Activity, open: boolean): Arrays => (open && act.gated ? act.gated : act);
  /** What one member brings in one world from one set of its samples. */
  const contribution = (act: Activity, a: Arrays, s: number, start: number, f: number) => {
    const day = start + a.days[s]!;
    const cash = a.cash[s]! * f;
    const early = a.early ? { day: start + a.early.days[s]!, cash: a.early.cash[s]! * f } : null;
    const inTime = (day <= problem.deadlineDays ? cash : 0) + (early && early.day <= problem.deadlineDays ? early.cash : 0);
    const spend = (a.spend?.[s] ?? 0) * f;
    return { day, cash, early, inTime, spend, ceiling: act.ceilingExempt ? 0 : spend, deals: (a.deals?.[s] ?? 0) * f };
  };
  const undecided: Array<{ act: Activity; s: number; start: number; f: number; gate: string }> = [];
  for (let i = 0; i < worlds; i++) {
    let capital = problem.startingCapital ?? Infinity;
    let total = 0;
    let wasShort = false;
    let spent = 0;
    let ceilingSpent = 0;
    let deals = 0;
    let held = 0;
    let lastDay = 0;
    let proof = 0;
    pending.length = 0;
    undecided.length = 0;
    gateOpen.clear();
    if (memberNeeds.every((id) => down.get(id)![i] === 0)) allUp += 1;
    // One market's members together sell at most what the market takes in this world (one draw), each cut in proportion.
    for (const g of grouped) {
      const volume = problem.activities[g[0]!]!.marketVolume?.[picks[g[0]!]![i]!];
      let sum = 0;
      for (const m of g) sum += problem.activities[m]!.deals?.[picks[m]![i]!] ?? 0;
      const f = volume !== undefined && sum > volume ? Math.max(0, volume) / sum : 1;
      for (const m of g) scale[m] = f;
    }
    for (const entry of ordered) {
      const start = entry.start;
      // Cash settled by this start day returns to the pool, once.
      for (let p = pending.length - 1; p >= 0; p--) {
        if (pending[p]!.day <= start) {
          capital += pending[p]!.cash + pending[p]!.back;
          proof += pending[p]!.cash;
          pending.splice(p, 1);
        }
      }
      if (entry.gate) {
        // A purchase after proof: some cash has come back, and what is left covers its first tranche.
        const g = entry.gate;
        const open = proof >= 1 && g.tranche <= capital + 1e-9;
        gateOpen.set(g.id, open);
        if (open) {
          capital -= g.tranche;
          spent += g.cost;
          ceilingSpent += g.cost;
        }
        continue;
      }
      const m = entry.m;
      const act = problem.activities[m]!;
      const s = picks[m]![i]!;
      const need = act.capital ?? 0;
      if (act.requiresProof && proof < 1) continue;
      if (need > capital + 1e-9) {
        wasShort = true;
        continue;
      }
      capital -= need;
      held += need;
      // A needed resource is down in this world: nothing settles, and the capital tied up is not recovered.
      if ((act.needs ?? []).some((id) => down.get(id)![i] === 1)) continue;
      const f = scale[m]!;
      const gate = act.gated?.gate;
      if (gate !== undefined && !gateOpen.has(gate)) undecided.push({ act, s, start, f, gate });
      // The hot path reads the samples in place: one combination is read over every world, hundreds of times a plan.
      const a = arraysOf(act, gate !== undefined && gateOpen.get(gate) === true);
      const day = start + a.days[s]!;
      const cash = a.cash[s]! * f;
      if (day > lastDay) lastDay = day;
      const spend = a.spend ? a.spend[s]! * f : 0;
      spent += spend;
      if (!act.ceilingExempt) ceilingSpent += spend;
      if (a.deals) deals += a.deals[s]! * f;
      // Capital comes back with the cash it earned.
      pending.push({ day, cash, back: need });
      if (day <= problem.deadlineDays) total += cash;
      if (a.early) {
        const earlyDay = start + a.early.days[s]!;
        const earlyCash = a.early.cash[s]! * f;
        pending.push({ day: earlyDay, cash: earlyCash, back: 0 });
        if (earlyDay <= problem.deadlineDays) total += earlyCash;
      }
    }
    // A member that started before its gate sold on the capacity it had; once the gate opened, on the capacity bought.
    for (const u of undecided) {
      if (!gateOpen.get(u.gate)) continue;
      const before = contribution(u.act, arraysOf(u.act, false), u.s, u.start, u.f);
      const after = contribution(u.act, arraysOf(u.act, true), u.s, u.start, u.f);
      total += after.inTime - before.inTime;
      spent += after.spend - before.spend;
      ceilingSpent += after.ceiling - before.ceiling;
      deals += after.deals - before.deals;
      if (after.day > lastDay) lastDay = after.day;
    }
    settled[i] = total;
    const keep = total - spent - fixedCost;
    keptAt[i] = keep;
    dealsAt[i] = deals;
    contributed += keep;
    tied += held;
    cycled += lastDay;
    const overCeiling = problem.spendCeiling !== undefined && ceilingSpent > problem.spendCeiling + 1e-9;
    if (overCeiling) over += 1;
    if ((onKept ? keep : total) >= problem.target && !overCeiling) reached += 1;
    if (wasShort) short += 1;
  }
  // Typed sorts are numeric and in place: no comparator call per pair.
  const sorted = Array.from(settled.sort());
  const q = (p: number) => sorted[Math.min(worlds - 1, Math.floor(p * worlds))]!;
  const median = (xs: Float64Array) => xs.sort()[Math.min(worlds - 1, Math.floor(0.5 * worlds))]!;
  const meanKept = contributed / worlds;
  const turnover = capitalTurnover(meanKept, tied / worlds, cycled / worlds) ?? 0;
  return {
    reading: {
      keys,
      reach: reached / worlds,
      settledP10: q(0.1),
      settledP50: q(0.5),
      settledP90: q(0.9),
      capitalShort: short / worlds,
      overSpend: over / worlds,
      keptP50: median(keptAt),
      ...(anyDeals ? { dealsP50: median(dealsAt) } : {}),
      contribution: meanKept,
      capitalTurnover: turnover,
      feasible: true,
      infeasibleBecause: null,
      basis: justified ? 'PROBABILITY' : 'COVERAGE',
    },
    settled: sorted,
    allNeedsUp: allUp / worlds,
  };
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
    if (guard.daysFactor?.activities.includes(one.key)) {
      const k = Math.min(1, Math.max(0, guard.daysFactor!.factor));
      next = { ...next, days: one.days.map((d) => d * k), ...(one.early ? { early: { cash: one.early.cash, days: one.early.days.map((d) => d * k) } } : {}) };
    }
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
