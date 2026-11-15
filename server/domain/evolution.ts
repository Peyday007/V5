/**
 * Brain improves itself by comparing alternatives (§111). Pure: no rows, no clock.
 *
 * §87 gave one weakness one approach and judged it once, after release. An
 * experiment builds the same deficiency several materially different ways,
 * scores every variant and the production baseline on a declared benchmark
 * suite the implementing agents cannot see all of, and adopts only the variant
 * that beats the baseline beyond the suite's noise without regressing a guard.
 *
 *   validateApproaches  ≥2 approaches, distinct by a structural signature
 *                       (approach type + mechanism words + owner paths)
 *   selectVariant       ADOPT one, REJECTED_ALL, or INSUFFICIENT — with the
 *                       ranking and the reason for every variant
 *   approachScore       UCB over (approach type × capability class); a type
 *                       below its win rate after `RETIRE_AFTER_TRIALS` retires
 *   experimentYield     the loop's own metric: adoptions per experiment and
 *                       hours from identification to adoption
 */

/* ------------------------------------------------------------------------- */
/* Approaches                                                                 */
/* ------------------------------------------------------------------------- */

export const APPROACH_TYPES = [
  'ALGORITHM_REPLACEMENT',
  'MODEL_CHANGE',
  'WORK_DIVISION',
  'APPROXIMATION',
  'REASONING_STRATEGY',
  'RETRIEVAL',
  'FEEDBACK_LOOP',
  'REMOVE_WORK',
  'SPECIALIZED_TOOL',
  'EVALUATION_MACHINERY',
  'PARAMETER',
  'OTHER',
] as const;
export type ApproachType = (typeof APPROACH_TYPES)[number];

export interface Approach {
  label: string;
  approachType: ApproachType;
  /** The mechanism, in words: what this variant changes and why it should work. */
  approach: string;
  /** Repository paths this approach changes; the variant's mutation scope. */
  ownerPaths: string[];
}

/** At most this many variants per experiment: each is a whole Factory objective. */
export const MAX_VARIANTS = 4;
/** Two approaches of one type sharing this share of mechanism words are one approach. */
export const SAME_TYPE_OVERLAP = 0.5;
/** Two approaches of different types on the same paths sharing this share of words are one approach relabelled. */
export const CROSS_TYPE_OVERLAP = 0.8;

const STOP = new Set([
  'about', 'after', 'again', 'also', 'among', 'because', 'before', 'being', 'between', 'both', 'brain', 'brains',
  'change', 'changes', 'code', 'does', 'each', 'every', 'from', 'have', 'into', 'its', 'make', 'more', 'most',
  'only', 'other', 'over', 'same', 'should', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'under', 'using', 'very', 'what', 'when', 'where', 'which', 'while', 'will',
  'with', 'within', 'without', 'would', 'your', 'instead', 'rather', 'approach', 'variant', 'files', 'file',
]);

/** The mechanism words of an approach: content words, stemmed crudely, deduplicated, sorted. */
export function mechanismWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => w.replace(/(ings|ing|ers|er|es|ed|s)$/, ''))
    .filter((w) => w.length >= 3);
  return [...new Set(words)].sort();
}

function normalPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((p) => p.trim().replace(/^\.\//, '')).filter(Boolean))].sort();
}

/** The structural signature two approaches are compared by. Stable across case, order and spacing. */
export function approachSignature(a: Pick<Approach, 'approachType' | 'approach' | 'ownerPaths'>): string {
  return `${a.approachType}|${mechanismWords(a.approach).join(' ')}|${normalPaths(a.ownerPaths).join(',')}`;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = new Set(a);
  const inter = b.filter((w) => sa.has(w)).length;
  return inter / (sa.size + new Set(b).size - inter);
}

export type ApproachValidation =
  | { ok: true; approaches: (Approach & { signature: string })[] }
  | { ok: false; reason: string };

/**
 * At least two approaches, each materially different from every other — the same rule
 * `reviewDecision` applies to options, made structural: an approach is its type, the
 * words of its mechanism and the files it changes, and two that share most of those are
 * one approach under two labels.
 */
export function validateApproaches(input: readonly Approach[]): ApproachValidation {
  if (input.length < 2) return { ok: false, reason: 'an experiment needs at least two materially different approaches' };
  if (input.length > MAX_VARIANTS) return { ok: false, reason: `at most ${MAX_VARIANTS} approaches per experiment (each is a whole Factory objective)` };
  const labels = new Set<string>();
  const out: (Approach & { signature: string })[] = [];
  for (const [i, a] of input.entries()) {
    const label = a.label.trim();
    if (!/^[A-Za-z0-9 _.-]{1,40}$/.test(label)) return { ok: false, reason: `approach ${i}: label must be 1-40 letters, digits, spaces, _ . or -` };
    if (labels.has(label.toLowerCase())) return { ok: false, reason: `approach ${i}: label "${label}" is used twice` };
    labels.add(label.toLowerCase());
    if (!(APPROACH_TYPES as readonly string[]).includes(a.approachType)) return { ok: false, reason: `approach ${i}: approach_type must be one of ${APPROACH_TYPES.join(', ')}` };
    if (a.approach.trim().length < 40) return { ok: false, reason: `approach ${i}: describe the mechanism (40+ characters): what changes and why it should work` };
    if (mechanismWords(a.approach).length < 4) return { ok: false, reason: `approach ${i}: the mechanism names too few concrete words to tell it apart from another` };
    if (a.ownerPaths.length > 8) return { ok: false, reason: `approach ${i}: owner_paths names at most 8 files or globs` };
    out.push({ ...a, label, ownerPaths: normalPaths(a.ownerPaths), approach: a.approach.trim(), signature: approachSignature(a) });
  }
  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      const a = out[i]!;
      const b = out[j]!;
      if (a.signature === b.signature) return { ok: false, reason: `"${a.label}" and "${b.label}" are the same approach (identical signature)` };
      const overlap = jaccard(mechanismWords(a.approach), mechanismWords(b.approach));
      if (a.approachType === b.approachType && overlap >= SAME_TYPE_OVERLAP) {
        return {
          ok: false,
          reason: `"${a.label}" and "${b.label}" are both ${a.approachType} and share ${Math.round(overlap * 100)}% of their mechanism words: a near-duplicate, not an alternative. Change the mechanism or the approach type.`,
        };
      }
      if (overlap >= CROSS_TYPE_OVERLAP && normalPaths(a.ownerPaths).join(',') === normalPaths(b.ownerPaths).join(',')) {
        return {
          ok: false,
          reason: `"${a.label}" and "${b.label}" change the same files with ${Math.round(overlap * 100)}% of the same mechanism words: one approach under two types.`,
        };
      }
    }
  }
  return { ok: true, approaches: out };
}

/* ------------------------------------------------------------------------- */
/* Benchmark suites and results                                               */
/* ------------------------------------------------------------------------- */

export type Direction = 'HIGHER' | 'LOWER';

export interface Guard {
  metric: string;
  /** Which way is better for this metric. */
  direction: Direction;
  /** The largest regression against the baseline allowed, in the metric's own units. */
  tolerance: number;
}

export interface BenchSuite {
  name: string;
  /** What kind of capability it measures; approach statistics are kept per class. */
  capabilityClass: string;
  description: string;
  primaryMetric: string;
  direction: Direction;
  /** An absolute target, or a factor of the first production baseline ever recorded. */
  target: number | { baselineFactor: number };
  /** A difference no larger than this is noise: absolute units, or relative to the baseline value. */
  noise: { absolute: number } | { relative: number };
  guards: Guard[];
}

export interface BenchCase {
  id: string;
  pass: boolean;
  score: number;
  ms: number;
}

/** The JSON shape workstream B's runners emit and the evaluator records. */
export interface BenchResult {
  suite: string;
  sha: string;
  ref: string | null;
  cases: BenchCase[];
  metrics: Record<string, number>;
  ranAt: string;
  /** True when the run included the hidden cases. */
  hidden?: boolean;
  /** A cause the run itself can state (e.g. which stage dominates), with the files that own it. */
  cause?: string | null;
  ownerPaths?: string[];
}

const SHA_LIKE = /^[A-Za-z0-9._/-]{1,100}$/;

/** Read a result an evaluator sent; refuse anything that is not the shared shape. */
export function parseBenchResult(value: unknown): { ok: true; result: BenchResult } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'the result must be a JSON object' };
  const v = value as Record<string, unknown>;
  if (typeof v['suite'] !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(v['suite'])) return { ok: false, reason: 'suite must be a suite name' };
  if (typeof v['sha'] !== 'string' || !SHA_LIKE.test(v['sha'])) return { ok: false, reason: 'sha must be a commit sha or ref' };
  if (v['ref'] !== undefined && v['ref'] !== null && (typeof v['ref'] !== 'string' || !SHA_LIKE.test(v['ref']))) return { ok: false, reason: 'ref must be a branch or ref name' };
  if (!v['metrics'] || typeof v['metrics'] !== 'object' || Array.isArray(v['metrics'])) return { ok: false, reason: 'metrics must be an object of numbers' };
  const metrics: Record<string, number> = {};
  for (const [k, n] of Object.entries(v['metrics'] as Record<string, unknown>)) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, reason: `metric ${k} must be a finite number` };
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(k)) return { ok: false, reason: `metric name ${k} is not allowed` };
    metrics[k] = n;
  }
  const rawCases = v['cases'] ?? [];
  if (!Array.isArray(rawCases)) return { ok: false, reason: 'cases must be an array' };
  if (rawCases.length > 5000) return { ok: false, reason: 'at most 5000 cases per result' };
  const cases: BenchCase[] = [];
  for (const c of rawCases as unknown[]) {
    const r = (c ?? {}) as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || typeof r['pass'] !== 'boolean') return { ok: false, reason: 'every case needs an id and pass' };
    cases.push({ id: r['id'].slice(0, 200), pass: r['pass'], score: Number(r['score'] ?? (r['pass'] ? 1 : 0)), ms: Number(r['ms'] ?? 0) });
  }
  const ranAt = typeof v['ranAt'] === 'string' && !Number.isNaN(Date.parse(v['ranAt'])) ? new Date(v['ranAt']).toISOString() : null;
  if (!ranAt) return { ok: false, reason: 'ranAt must be an ISO time' };
  const cause = typeof v['cause'] === 'string' && v['cause'].trim() ? v['cause'].trim().slice(0, 1000) : null;
  const ownerPaths = Array.isArray(v['ownerPaths']) ? (v['ownerPaths'] as unknown[]).filter((p): p is string => typeof p === 'string' && SHA_LIKE.test(p)).slice(0, 8) : [];
  return {
    ok: true,
    result: { suite: v['suite'], sha: v['sha'], ref: (v['ref'] as string | null | undefined) ?? null, cases, metrics, ranAt, hidden: v['hidden'] === true, cause, ownerPaths },
  };
}

/** How much better `value` is than `base` in the suite's direction (negative is worse). */
export function improvement(direction: Direction, base: number, value: number): number {
  return direction === 'HIGHER' ? value - base : base - value;
}

/** The noise bound of a suite, at this baseline value. */
export function noiseBound(suite: Pick<BenchSuite, 'noise'>, base: number): number {
  return 'absolute' in suite.noise ? Math.abs(suite.noise.absolute) : Math.abs(suite.noise.relative * base);
}

/** The target value, given the first production baseline ever recorded for the suite. */
export function targetValue(suite: Pick<BenchSuite, 'target'>, firstBaseline: number | null): number | null {
  if (typeof suite.target === 'number') return suite.target;
  return firstBaseline === null ? null : firstBaseline * suite.target.baselineFactor;
}

/** Whether a value meets the suite's target (null when the target cannot be resolved yet). */
export function meetsTarget(suite: Pick<BenchSuite, 'target' | 'direction'>, value: number, firstBaseline: number | null): boolean | null {
  const target = targetValue(suite, firstBaseline);
  if (target === null) return null;
  return suite.direction === 'HIGHER' ? value >= target : value <= target;
}

/* ------------------------------------------------------------------------- */
/* Selection                                                                  */
/* ------------------------------------------------------------------------- */

export interface VariantScore {
  id: string;
  metrics: Record<string, number> | null;
  /** Lines the variant's diff changes; ties go to the smaller diff. */
  linesChanged: number | null;
}

export interface Ranked {
  id: string;
  primary: number | null;
  /** Improvement over the baseline on the primary metric, in its units (positive is better). */
  improvement: number | null;
  /** The improvement relative to the baseline value. */
  lift: number | null;
  beatsNoise: boolean;
  guardFailures: string[];
  qualifies: boolean;
  linesChanged: number | null;
  reason: string;
}

export type Verdict = 'ADOPT' | 'REJECTED_ALL' | 'INSUFFICIENT';

export interface Selection {
  verdict: Verdict;
  winner: string | null;
  ranking: Ranked[];
  noise: number | null;
  rationale: string;
}

/**
 * The variant to adopt: the best that beats the baseline beyond the suite's noise on the
 * primary metric and regresses no guard past its tolerance. Variants whose improvements
 * are within noise of the best are tied, and a tie goes to the smaller diff. None
 * qualifying is REJECTED_ALL (the next attempt changes method, invariant 16); fewer than
 * two scored variants, or no baseline, is INSUFFICIENT.
 */
export function selectVariant(baseline: Record<string, number> | null, variants: readonly VariantScore[], suite: BenchSuite): Selection {
  const base = baseline?.[suite.primaryMetric];
  if (baseline === null || base === undefined || !Number.isFinite(base)) {
    return { verdict: 'INSUFFICIENT', winner: null, ranking: [], noise: null, rationale: `no baseline ${suite.primaryMetric} on suite ${suite.name}` };
  }
  const noise = noiseBound(suite, base);
  const ranking: Ranked[] = variants.map((v) => {
    const value = v.metrics?.[suite.primaryMetric];
    if (!v.metrics || value === undefined || !Number.isFinite(value)) {
      return { id: v.id, primary: null, improvement: null, lift: null, beatsNoise: false, guardFailures: [], qualifies: false, linesChanged: v.linesChanged, reason: `no ${suite.primaryMetric} result` };
    }
    const gain = improvement(suite.direction, base, value);
    const lift = base === 0 ? gain : gain / Math.abs(base);
    const beatsNoise = gain > noise;
    const guardFailures: string[] = [];
    for (const g of suite.guards) {
      const b = baseline[g.metric];
      const x = v.metrics[g.metric];
      if (b === undefined || x === undefined) {
        guardFailures.push(`${g.metric}: not measured`);
        continue;
      }
      const regression = -improvement(g.direction, b, x);
      if (regression > g.tolerance) guardFailures.push(`${g.metric}: ${b} → ${x} regresses ${round(regression)} > tolerance ${g.tolerance}`);
    }
    const qualifies = beatsNoise && guardFailures.length === 0;
    const reason = !beatsNoise
      ? `${suite.primaryMetric} ${base} → ${value}: ${gain > 0 ? `+${round(gain)} is within noise ${round(noise)}` : `no improvement (${round(gain)})`}`
      : guardFailures.length
        ? `${suite.primaryMetric} improved ${round(gain)} but a guard regressed: ${guardFailures.join('; ')}`
        : `${suite.primaryMetric} ${base} → ${value}: improved ${round(gain)} beyond noise ${round(noise)}, no guard regressed`;
    return { id: v.id, primary: value, improvement: gain, lift, beatsNoise, guardFailures, qualifies, linesChanged: v.linesChanged, reason };
  });
  ranking.sort((a, b) => (b.improvement ?? -Infinity) - (a.improvement ?? -Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const scored = ranking.filter((r) => r.primary !== null).length;
  if (scored < 2) {
    return { verdict: 'INSUFFICIENT', winner: null, ranking, noise, rationale: `${scored} variant(s) scored on ${suite.name}; a comparison needs at least two` };
  }
  const qualifying = ranking.filter((r) => r.qualifies);
  if (qualifying.length === 0) {
    return { verdict: 'REJECTED_ALL', winner: null, ranking, noise, rationale: `no variant beat the baseline ${suite.primaryMetric} ${base} beyond noise ${round(noise)} without a guard regression; the next attempt changes method` };
  }
  const best = qualifying[0]!;
  const tied = qualifying.filter((r) => (best.improvement ?? 0) - (r.improvement ?? 0) <= noise);
  const lines = (r: Ranked) => (r.linesChanged === null ? Number.POSITIVE_INFINITY : r.linesChanged);
  const winner = [...tied].sort((a, b) => lines(a) - lines(b) || (b.improvement ?? 0) - (a.improvement ?? 0) || (a.id < b.id ? -1 : 1))[0]!;
  const tie = tied.length > 1 ? ` (tied within noise with ${tied.filter((t) => t.id !== winner.id).map((t) => t.id).join(', ')}; the smaller diff wins)` : '';
  return { verdict: 'ADOPT', winner: winner.id, ranking, noise, rationale: `${winner.id}: ${winner.reason}${tie}` };
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/* ------------------------------------------------------------------------- */
/* Learning which approach types work                                         */
/* ------------------------------------------------------------------------- */

export interface ApproachStat {
  approachType: string;
  capabilityClass: string;
  trials: number;
  wins: number;
  totalLift: number;
  retiredAt: string | null;
}

/** A type is judged only after this many trials in a class. */
export const RETIRE_AFTER_TRIALS = 5;
/** And retired when it wins less often than this. */
export const RETIRE_BELOW_WIN_RATE = 0.15;

/**
 * Upper confidence bound of an approach type in a capability class — the shape
 * `reasoning/learning.ts` uses for reasoning methods: mean lift, a win bonus, and an
 * exploration term over every trial in the class. An untried type is explored first.
 */
export function approachScore(stat: Pick<ApproachStat, 'trials' | 'wins' | 'totalLift'> | null, totalTrials: number): number {
  if (!stat || stat.trials <= 0) return Number.POSITIVE_INFINITY;
  const mean = stat.totalLift / stat.trials;
  const won = stat.wins / stat.trials;
  return mean + 0.5 * won + 0.3 * Math.sqrt(Math.log(Math.max(2, totalTrials)) / stat.trials);
}

/** Whether a type has had enough trials in a class and wins too rarely to keep trying. */
export function shouldRetire(stat: Pick<ApproachStat, 'trials' | 'wins'>): boolean {
  return stat.trials >= RETIRE_AFTER_TRIALS && stat.wins / stat.trials < RETIRE_BELOW_WIN_RATE;
}

/** Every approach type ranked for a capability class: the best bound first, retired types last. */
export function rankApproachTypes(stats: readonly ApproachStat[], capabilityClass: string): { approachType: ApproachType; score: number; trials: number; wins: number; retired: boolean }[] {
  const inClass = stats.filter((s) => s.capabilityClass === capabilityClass);
  const total = inClass.reduce((n, s) => n + s.trials, 0);
  return APPROACH_TYPES.map((t) => {
    const s = inClass.find((x) => x.approachType === t) ?? null;
    const retired = Boolean(s?.retiredAt) || (s ? shouldRetire(s) : false);
    return { approachType: t, score: approachScore(s, total), trials: s?.trials ?? 0, wins: s?.wins ?? 0, retired };
  }).sort((a, b) => Number(a.retired) - Number(b.retired) || b.score - a.score || (a.approachType < b.approachType ? -1 : 1));
}

/* ------------------------------------------------------------------------- */
/* The loop's own metric                                                      */
/* ------------------------------------------------------------------------- */

export interface ExperimentSummary {
  createdAt: string;
  /** When the deficiency was first identified (its register row), when known. */
  identifiedAt?: string | null;
  decidedAt: string | null;
  verdict: Verdict | null;
}

/** Adopted improvements per experiment, and hours from identification to adoption. */
export function experimentYield(experiments: readonly ExperimentSummary[]): {
  experiments: number;
  decided: number;
  adopted: number;
  rejectedAll: number;
  adoptedPerExperiment: number | null;
  medianHoursToAdoption: number | null;
} {
  const decided = experiments.filter((e) => e.verdict !== null);
  const adopted = decided.filter((e) => e.verdict === 'ADOPT');
  const hours = adopted
    .filter((e) => e.decidedAt)
    .map((e) => (Date.parse(e.decidedAt!) - Date.parse(e.identifiedAt ?? e.createdAt)) / 3_600_000)
    .filter((h) => Number.isFinite(h))
    .sort((a, b) => a - b);
  const median = hours.length === 0 ? null : hours.length % 2 ? hours[(hours.length - 1) / 2]! : (hours[hours.length / 2 - 1]! + hours[hours.length / 2]!) / 2;
  return {
    experiments: experiments.length,
    decided: decided.length,
    adopted: adopted.length,
    rejectedAll: decided.filter((e) => e.verdict === 'REJECTED_ALL').length,
    adoptedPerExperiment: decided.length ? Math.round((adopted.length / decided.length) * 1000) / 1000 : null,
    medianHoursToAdoption: median === null ? null : Math.round(median * 10) / 10,
  };
}
