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
  /**
   * What this activity is for the downside, when it is a control rather than a
   * source of the target: an independent channel, a diversified counterparty,
   * reserve capacity, a faster cash cycle, a contingency. Open vocabulary — the
   * kind is a label, and its effect is measured by removing it from the same
   * worlds, never read from the label.
   */
  safeguard?: string;
  /** What its samples rest on. Absent means nobody said, which is not evidence. */
  evidence?: ActivityEvidence;
}

/** The evidence behind an activity's samples, so a probability can be judged and not assumed. */
export interface ActivityEvidence {
  /** Independent real observations the samples were built from (not the number of draws). */
  sampleSize: number;
  /** When the newest observation was made (ISO-8601), for changing conditions. */
  observedAt?: string;
  /** Oldest age, in days, at which the observations still describe today's market. */
  validForDays?: number;
  /** True when the samples include the bad tail (a lost buyer, a failed supplier), not only typical outcomes. */
  tailCovered?: boolean;
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
  /** The instant the evidence is judged against (ISO-8601); defaults to now. */
  asOf?: string;
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
  /** Added without moving any field above: what the best combination's confidence is entitled to say. */
  uncertainty?: PortfolioUncertainty;
}

export interface SafeguardEffect {
  key: string;
  safeguard: string;
  /** Reach with the safeguard minus reach without it, over the identical worlds. */
  reachGain: number;
  /** Change in the mean of the worst tenth of worlds (settled cash), with it minus without it. */
  tailGain: number;
  /** Change in the tenth percentile of settled cash. */
  p10Gain: number;
  /** Change in the share of worlds that ran short of capital (negative is better). */
  capitalShortChange: number;
  /** False when the combination without it is not feasible, so no like-for-like comparison exists. */
  comparable: boolean;
}

export interface ValidationIssue {
  key: string;
  problem: 'SAMPLES_NOT_EVIDENCED' | 'SAMPLE_SIZE_UNDECLARED' | 'SAMPLE_TOO_SMALL' | 'EVIDENCE_STALE' | 'TAIL_NOT_COVERED';
  detail: string;
}

export interface PortfolioUncertainty {
  /** CALIBRATED: every member's inputs pass; otherwise the share of worlds is coverage, not probability. */
  status: 'CALIBRATED' | 'CALIBRATION_UNAVAILABLE';
  /** Reach of the best combination in the simulated worlds. */
  reach: number;
  /** The strongest defensible interval for the chance of reaching the target; null when calibration is unavailable. */
  range: { low: number; high: number; level: number; effectiveSamples: number } | null;
  /** True only when calibrated evidence puts the lower bound at or above 0.9. */
  meets90: boolean;
  /** Plain statement of what may and may not be claimed. */
  statement: string;
  /** Inputs that are a validation problem — never read as favourable. */
  validation: ValidationIssue[];
  safeguards: SafeguardEffect[];
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

function evaluate(problem: PortfolioProblem, members: number[], picks: number[][], worlds: number, capture?: { settled?: Float64Array }): PortfolioReading {
  const keys = members.map((m) => problem.activities[m]!.key);
  const refusal = refuse(problem, members);
  const justified = members.every((m) => problem.activities[m]!.justified);
  if (refusal) return { keys, reach: 0, settledP10: 0, settledP50: 0, settledP90: 0, capitalShort: 0, overSpend: 0, feasible: false, infeasibleBecause: refusal, basis: justified ? 'PROBABILITY' : 'COVERAGE' };
  const ordered = [...members].sort((a, b) => (problem.activities[a]!.startDay ?? 0) - (problem.activities[b]!.startDay ?? 0));
  const settled = new Float64Array(worlds);
  let reached = 0;
  let short = 0;
  let over = 0;
  const pending: Array<{ day: number; cash: number }> = [];
  for (let i = 0; i < worlds; i++) {
    let capital = problem.startingCapital ?? Infinity;
    let total = 0;
    let wasShort = false;
    let spent = 0;
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
      const day = start + act.days[s]!;
      // Capital comes back with the cash it earned.
      const cash = act.cash[s]!;
      spent += act.spend?.[s] ?? 0;
      pending.push({ day, cash: cash + need });
      if (day <= problem.deadlineDays) total += cash;
    }
    settled[i] = total;
    const overCeiling = problem.spendCeiling !== undefined && spent > problem.spendCeiling + 1e-9;
    if (overCeiling) over += 1;
    if (total >= problem.target && !overCeiling) reached += 1;
    if (wasShort) short += 1;
  }
  if (capture) capture.settled = settled;
  const sorted = Array.from(settled).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(worlds - 1, Math.floor(p * worlds))]!;
  return { keys, reach: reached / worlds, settledP10: q(0.1), settledP50: q(0.5), settledP90: q(0.9), capitalShort: short / worlds, overSpend: over / worlds, feasible: true, infeasibleBecause: null, basis: justified ? 'PROBABILITY' : 'COVERAGE' };
}

function better(a: PortfolioReading, b: PortfolioReading): number {
  return Number(b.feasible) - Number(a.feasible) || b.reach - a.reach || b.settledP50 - a.settledP50 || a.keys.length - b.keys.length;
}

export const MIN_EVIDENCE_SAMPLES = 30;
const CONFIDENCE_LEVEL = 0.95;
const CLAIM_THRESHOLD = 0.9;

function wilson(successes: number, n: number, z = 1.96): { low: number; high: number } {
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function tailMean(settled: Float64Array): number {
  const sorted = Array.from(settled).sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(sorted.length * 0.1));
  let sum = 0;
  for (let i = 0; i < k; i++) sum += sorted[i]!;
  return sum / k;
}

/** Judge what the best combination's confidence may say, and measure each control on the same worlds. */
function assess(problem: PortfolioProblem, best: PortfolioReading, picks: number[][], worlds: number): PortfolioUncertainty {
  const index = new Map(problem.activities.map((a, i) => [a.key, i]));
  const members = best.keys.map((k) => index.get(k)!);
  const asOf = Date.parse(problem.asOf ?? new Date().toISOString());
  const validation: ValidationIssue[] = [];
  for (const m of members) {
    const act = problem.activities[m]!;
    if (!act.justified) {
      validation.push({ key: act.key, problem: 'SAMPLES_NOT_EVIDENCED', detail: 'its samples do not rest on evidence; they are an assumption, so the share of worlds is coverage and never a probability' });
      continue;
    }
    const ev = act.evidence;
    if (!ev || !Number.isFinite(ev.sampleSize) || ev.sampleSize <= 0) {
      validation.push({ key: act.key, problem: 'SAMPLE_SIZE_UNDECLARED', detail: 'marked as evidenced but no count of real observations is declared' });
      continue;
    }
    if (ev.sampleSize < MIN_EVIDENCE_SAMPLES) validation.push({ key: act.key, problem: 'SAMPLE_TOO_SMALL', detail: `${ev.sampleSize} observations; at least ${MIN_EVIDENCE_SAMPLES} are needed before a probability is read from them` });
    if (ev.observedAt !== undefined && ev.validForDays !== undefined) {
      const age = (asOf - Date.parse(ev.observedAt)) / 86_400_000;
      if (!(age <= ev.validForDays)) validation.push({ key: act.key, problem: 'EVIDENCE_STALE', detail: `newest observation is ${Number.isFinite(age) ? Math.round(age) + ' days old' : 'undated'}; it describes conditions for ${ev.validForDays} days` });
    }
    if (ev.tailCovered !== true) validation.push({ key: act.key, problem: 'TAIL_NOT_COVERED', detail: 'the samples are not shown to include the bad tail, so tail risk is unaccounted for' });
  }

  const full = new Float64Array(0);
  const capFull: { settled?: Float64Array } = {};
  evaluate(problem, members, picks, worlds, capFull);
  const fullTail = tailMean(capFull.settled ?? full);
  const safeguards: SafeguardEffect[] = [];
  for (const m of members) {
    const act = problem.activities[m]!;
    if (!act.safeguard) continue;
    const rest = members.filter((x) => x !== m);
    if (rest.length === 0) {
      safeguards.push({ key: act.key, safeguard: act.safeguard, reachGain: 0, tailGain: 0, p10Gain: 0, capitalShortChange: 0, comparable: false });
      continue;
    }
    const cap: { settled?: Float64Array } = {};
    const without = evaluate(problem, rest, picks, worlds, cap);
    if (!without.feasible) {
      safeguards.push({ key: act.key, safeguard: act.safeguard, reachGain: 0, tailGain: 0, p10Gain: 0, capitalShortChange: 0, comparable: false });
      continue;
    }
    safeguards.push({
      key: act.key,
      safeguard: act.safeguard,
      reachGain: round(best.reach - without.reach),
      tailGain: round(fullTail - tailMean(cap.settled!)),
      p10Gain: round(best.settledP10 - without.settledP10),
      capitalShortChange: round(best.capitalShort - without.capitalShort),
      comparable: true,
    });
  }

  if (validation.length > 0) {
    const keys = [...new Set(validation.map((v) => v.key))].join(', ');
    return {
      status: 'CALIBRATION_UNAVAILABLE',
      reach: best.reach,
      range: null,
      meets90: false,
      statement: `Calibration is unavailable: inputs for ${keys} fail validation. ${round(best.reach * 100)}% of simulated worlds reach the target, which is coverage of the assumptions made and not a probability; no 90% claim is made.`,
      validation,
      safeguards,
    };
  }
  const effective = Math.max(1, Math.floor(Math.min(...members.map((m) => problem.activities[m]!.evidence!.sampleSize))));
  const { low, high } = wilson(Math.round(best.reach * effective), effective);
  const meets90 = low >= CLAIM_THRESHOLD;
  return {
    status: 'CALIBRATED',
    reach: best.reach,
    range: { low: round(low), high: round(high), level: CONFIDENCE_LEVEL, effectiveSamples: effective },
    meets90,
    statement: meets90
      ? `Calibrated: the chance of reaching the target is between ${round(low * 100)}% and ${round(high * 100)}% (${CONFIDENCE_LEVEL * 100}% interval, limited by ${effective} observations); the lower bound clears 90%.`
      : `Calibrated, but 90% is not claimed: the strongest defensible chance of reaching the target is ${round(low * 100)}%–${round(high * 100)}% (${CONFIDENCE_LEVEL * 100}% interval, limited by ${effective} observations).`,
    validation,
    safeguards,
  };
}

/** Find the combination most likely to reach the target, with every alternative ranked. */
export function optimizePortfolio(problem: PortfolioProblem): PortfolioResult {
  const worlds = problem.worlds ?? DEFAULT_WORLDS;
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
  const result: PortfolioResult = { best, ranked: ranked.slice(0, 8), singles, refused, searched: readings.length };
  if (best) result.uncertainty = assess(problem, best, picks, worlds);
  return result;
}
