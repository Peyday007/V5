/**
 * Recursive reconstruction: one hard quantity becomes a graph of simpler ones.
 *
 * `reconstruct(graph, target)` climbs the evidence ladder for the target and
 * stops at the first rung that is *enough* — the node's own sufficiency width —
 * so an answer that is already established is never re-derived from parts
 * (§79's first rule: the shortest defensible route). When a rung is not
 * enough it climbs:
 *
 *   DIRECT      pooled evidence about this exact population
 *   COMPARABLE  plus transferred evidence, discounted, adjusted or refused
 *   COMPONENT   the node's formula over child nodes, each resolved on its own
 *               ladder (recursively, memoized, depth- and node-bounded, cycles
 *               refused), with their samples propagated through the formula
 *               under any declared correlations; combined with the pooled
 *               evidence by inverse variance when the two routes share no data
 *   MECHANISM   broad economic evidence only: bounds, never a distribution
 *   ASSUMED     a person's stated range: bounds, never a distribution
 *   UNKNOWN     physical bounds, or nothing
 *
 * When no rung is enough the most precise one wins, and the trace says which
 * routes were tried and why each stopped. A child is never resolved unless its
 * parent needed it, so `notNeeded` lists exactly the research the graph
 * declared and the estimate did not have to pay for.
 *
 * Pure: no rows, no clock except the `now` passed in, and every random draw is
 * a function of the node's key, so a reconstruction reproduces exactly.
 */
import { compile, identifiers, parse } from '../scenario/expr.ts';
import { cholesky, inverseNormal, makeRng, normalCdf } from '../scenario/random.ts';
import { DISTRIBUTION_TIERS, QUANT_LIMITS, type Estimate, type EvidenceTier, type QuantGraph, type QuantityNode, type Reconstruction } from '../../domain/quant.ts';
import type { SourceRef } from '../../domain/scenario.ts';
import { allUnsized, classify, collapseLineage, combine, contestOf, fromScale, pool, scaleFor, SPREAD_FLOOR, studentT, toScale, type Pooled, type Scale, type Scaled } from './pool.ts';

export class ReconstructionError extends Error {}

/** Independent comparable populations needed before transferred evidence may be a distribution. */
export const MIN_COMPARABLE_POPULATIONS = 2;

const Q = { p05: -1.6448536, p10: -1.2815516, p50: 0, p90: 1.2815516, p95: 1.6448536 };

function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

function bound(node: QuantityNode, x: number): number {
  let out = x;
  if (node.kind === 'RATE') out = Math.min(1, Math.max(0, out));
  if (node.min !== undefined) out = Math.max(node.min, out);
  if (node.max !== undefined) out = Math.min(node.max, out);
  return out;
}

/*
 * Every draw a reconstruction makes is a function of a node's key and a stream
 * number alone (that is what makes a reconstruction reproduce exactly), so the
 * standard-normal draws behind a key are the same in every reconstruction that
 * names it. The construction pass reconstructs hundreds of arrangements whose
 * nodes share keys (`a_value`, `a_buyers`, …), and every plan read repeated
 * them: 4,000 `inverseNormal` calls per node per route, a top source of the
 * main thread's CPU in production (§109, 2026-11-13/14). They are drawn once
 * per (key, stream) and read thereafter — the same numbers in the same order.
 */
const NORMALS_MAX = 512;
const normals = new Map<string, Float64Array>();
function standardNormals(key: string, stream: number): Float64Array {
  const id = `${stream}\u0000${key}`;
  const held = normals.get(id);
  if (held && held.length === QUANT_LIMITS.samples) return held;
  const rng = makeRng(seedOf(key), stream);
  const zs = new Float64Array(QUANT_LIMITS.samples);
  for (let i = 0; i < zs.length; i++) zs[i] = inverseNormal(rng());
  if (normals.size >= NORMALS_MAX) normals.delete(normals.keys().next().value!);
  normals.set(id, zs);
  return zs;
}

/** A normal on the pooling scale, as an estimate with quantiles and samples. */
function fromNormal(node: QuantityNode, scale: Scale, mean: number, sd: number): Pick<Estimate, 'mean' | 'sd' | 'p05' | 'p10' | 'p50' | 'p90' | 'p95' | 'samples'> {
  const at = (z: number) => bound(node, fromScale(scale, mean + z * sd));
  const zs = standardNormals(node.key, 7);
  const samples = new Array<number>(QUANT_LIMITS.samples);
  for (let i = 0; i < samples.length; i++) samples[i] = at(zs[i]!);
  return { mean, sd, p05: at(Q.p05), p10: at(Q.p10), p50: at(Q.p50), p90: at(Q.p90), p95: at(Q.p95), samples };
}

/*
 * Few populations (Q2-11, 2026-11-14). The pooled mean of two or three studies
 * is uncertain by more than a normal says: its standard error is itself an
 * estimate from k studies. The predictive draw is read Hartung–Knapp style —
 * the mean's error on Student's t with k − 1 degrees of freedom, plus the
 * between-population spread τ (floored per tier) as a normal — so three
 * comparables put p90 at ~1.9 standard errors from the centre, not 1.28. One
 * observation is a sampled rate, read on its own sampling error as before.
 */
function fromPooled(node: QuantityNode, scale: Scale, pooled: Pooled): Pick<Estimate, 'mean' | 'sd' | 'p05' | 'p10' | 'p50' | 'p90' | 'p95' | 'samples'> {
  if (pooled.k < 2) return fromNormal(node, scale, pooled.mean, pooled.sd);
  const df = pooled.k - 1;
  const z1 = standardNormals(node.key, 7);
  const z2 = standardNormals(node.key, 9);
  const onScale = new Float64Array(QUANT_LIMITS.samples);
  for (let i = 0; i < onScale.length; i++) onScale[i] = pooled.mean + pooled.se * studentT(normalCdf(z1[i]!), df, z1[i]!) + pooled.tau * z2[i]!;
  const sorted = Float64Array.from(onScale).sort();
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
  // A robust spread on the scale (half the 16–84% width): a t with one degree of freedom has no variance.
  const sd = (at(0.8413) - at(0.1587)) / 2;
  const samples = new Array<number>(onScale.length);
  for (let i = 0; i < samples.length; i++) samples[i] = bound(node, fromScale(scale, onScale[i]!));
  const q = (p: number) => bound(node, fromScale(scale, at(p)));
  return { mean: pooled.mean, sd, p05: q(0.05), p10: q(0.1), p50: q(0.5), p90: q(0.9), p95: q(0.95), samples };
}

/**
 * The evidence behind an estimate in units a plan can compare (Q2-1/Q2-2):
 * independent populations, those with a stated sample, and the sample its
 * predictive distribution is worth in events — p(1−p)/Var(p) for a rate, read
 * by the delta method from the predictive spread on the logit scale (a robust
 * spread: a t with few degrees of freedom has no variance). So three
 * comparables of 200 each are worth what their spread allows (τ ≥ 0.3 caps
 * transferred evidence near 70 events, and the t on three studies lower),
 * never the number of studies and never 600 contacts as if they were one
 * population. A magnitude counts one event per independent measured case.
 */
function evidenceOf(kind: QuantityNode['kind'], kept: readonly Scaled[], p50: number, sdOnScale: number, justified: boolean): Pick<Estimate, 'populations' | 'sizedPopulations' | 'events'> {
  const populations = kept.length;
  const sizedPopulations = kept.filter((one) => !one.unsized).length;
  let events = sizedPopulations;
  if (kind === 'RATE') {
    const p = Math.min(0.999, Math.max(0.001, p50));
    events = sdOnScale > 0 ? Math.round(1 / (p * (1 - p) * sdOnScale * sdOnScale)) : 0;
  }
  return { populations, sizedPopulations, events: justified ? events : 0 };
}

/**
 * A pooled set whose sized members contradict each other (L-1): the spread
 * between them becomes the between-population spread, so the interval is as
 * wide as the disagreement rather than as tight as the pooled mean.
 */
function contested(items: readonly Scaled[], pooled: Pooled): { pooled: Pooled; contest: { ids: string[]; reason: string } | null } {
  const contest = contestOf(items);
  if (!contest) return { pooled, contest: null };
  const tau = Math.max(pooled.tau, contest.spread);
  return { pooled: { ...pooled, tau, sd: Math.sqrt(pooled.se * pooled.se + tau * tau) }, contest: { ids: contest.ids, reason: contest.reason } };
}

function quantile(sorted: number[], p: number): number {
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[at]!;
}

/** Whether the estimate is precise enough to stop climbing. */
export function sufficient(node: QuantityNode, est: Pick<Estimate, 'p10' | 'p90'>): boolean {
  if (node.kind === 'POSITIVE') {
    const limit = node.sufficientWidth ?? QUANT_LIMITS.positiveWidth;
    return est.p10 > 0 && est.p90 / est.p10 <= limit;
  }
  const limit = node.sufficientWidth ?? (node.kind === 'RATE' ? QUANT_LIMITS.rateWidth : 0);
  return est.p90 - est.p10 <= limit;
}

/** How wide an estimate is, comparably across routes: the predictive sd on the pooling scale. */
function width(est: Pick<Estimate, 'sd'>): number {
  return est.sd;
}

interface Context {
  graph: Map<string, QuantityNode>;
  memo: Map<string, Estimate>;
  stack: Set<string>;
  now: Date;
  visited: number;
  correlations: QuantGraph['correlations'];
}

function blank(node: QuantityNode, tier: EvidenceTier): Estimate {
  return {
    key: node.key,
    label: node.label,
    unit: node.unit,
    kind: node.kind,
    tier,
    scale: scaleFor(node.kind),
    mean: 0,
    sd: 0,
    p05: 0,
    p10: 0,
    p50: 0,
    p90: 0,
    p95: 0,
    effectiveSample: 0,
    heterogeneity: 0,
    distributionJustified: false,
    sources: [],
    used: [],
    excluded: [],
    collapsed: [],
    children: [],
    trace: [],
    samples: [],
  };
}

function sourcesOf(items: Scaled[]): SourceRef[] {
  return items.map((one) => one.obs.source);
}

function resolve(ctx: Context, key: string, depth: number): Estimate {
  const memo = ctx.memo.get(key);
  if (memo) return memo;
  const node = ctx.graph.get(key);
  if (!node) throw new ReconstructionError(`The graph refers to "${key}", which no node defines.`);
  if (ctx.stack.has(key)) throw new ReconstructionError(`"${key}" is defined in terms of itself (${[...ctx.stack, key].join(' → ')}).`);
  if (depth > QUANT_LIMITS.maxDepth) throw new ReconstructionError(`Reconstruction went deeper than ${QUANT_LIMITS.maxDepth} levels at "${key}".`);
  ctx.visited += 1;
  if (ctx.visited > QUANT_LIMITS.maxNodes) throw new ReconstructionError(`Reconstruction visited more than ${QUANT_LIMITS.maxNodes} quantities.`);
  ctx.stack.add(key);
  try {
    const est = climb(ctx, node, depth);
    ctx.memo.set(key, est);
    return est;
  } finally {
    ctx.stack.delete(key);
  }
}

function climb(ctx: Context, node: QuantityNode, depth: number): Estimate {
  const scale = scaleFor(node.kind);
  const sorted = classify(node, ctx.now);
  const trace: string[] = [];
  const candidates: Estimate[] = [];

  // DIRECT
  const direct = collapseLineage(sorted.direct);
  if (direct.kept.length > 0) {
    const read = contested(direct.kept, pool(direct.kept, SPREAD_FLOOR.DIRECT)!);
    const pooled = read.pooled;
    const drawn = fromPooled(node, scale, pooled);
    // A rate nobody stated a sample for locates the answer and bounds it; a contradiction is bounds too.
    const justified = !allUnsized(direct.kept) && !read.contest;
    const est: Estimate = {
      ...blank(node, 'DIRECT'),
      ...drawn,
      effectiveSample: pooled.effective,
      heterogeneity: pooled.tau,
      distributionJustified: justified,
      sources: sourcesOf(direct.kept),
      used: direct.kept.map((one) => one.obs.id),
      collapsed: direct.collapsed,
      ...evidenceOf(node.kind, direct.kept, drawn.p50, drawn.sd, justified),
      ...(read.contest ? { contested: read.contest } : {}),
    };
    if (read.contest) trace.push(`DIRECT: CONTESTED — ${read.contest.reason}; widened to the spread between them and reported as bounds, never as a probability.`);
    candidates.push(est);
    if (!est.distributionJustified) trace.push('DIRECT: every observation is a published rate with no stated sample, so it locates the answer but cannot justify a distribution: bounds only.');
    if (sufficient(node, est) && est.distributionJustified) {
      trace.push(`DIRECT: ${direct.kept.length} independent observation(s) of this exact population are enough (p10 ${fmt(est.p10)}, p90 ${fmt(est.p90)}); nothing further was reconstructed.`);
      return finish(est, sorted, trace);
    }
    trace.push(`DIRECT: ${direct.kept.length} observation(s), not precise enough alone (p10 ${fmt(est.p10)}, p90 ${fmt(est.p90)}).`);
  } else {
    trace.push('DIRECT: no observation of this exact population.');
  }

  // COMPARABLE — pooled together with any direct evidence, spread floored for travel.
  const pooledSet = collapseLineage([...sorted.direct, ...sorted.comparable]);
  const comparableUsed = pooledSet.kept.some((one) => one.distance > 0);
  if (sorted.comparable.length > 0) {
    const read = contested(pooledSet.kept, pool(pooledSet.kept, comparableUsed ? SPREAD_FLOOR.COMPARABLE : SPREAD_FLOOR.DIRECT)!);
    const pooled = read.pooled;
    const drawn = fromPooled(node, scale, pooled);
    // One other population is an anecdote, not a pattern: with no direct
    // evidence beside it, a lone comparable bounds the answer and never
    // becomes a distribution.
    const justified = (pooledSet.kept.length >= MIN_COMPARABLE_POPULATIONS || pooledSet.kept.some((one) => one.distance === 0)) && !allUnsized(pooledSet.kept) && !read.contest;
    const est: Estimate = {
      ...blank(node, 'COMPARABLE'),
      ...drawn,
      effectiveSample: pooled.effective,
      heterogeneity: pooled.tau,
      distributionJustified: justified,
      sources: sourcesOf(pooledSet.kept),
      used: pooledSet.kept.map((one) => one.obs.id),
      collapsed: pooledSet.collapsed,
      ...evidenceOf(node.kind, pooledSet.kept, drawn.p50, drawn.sd, justified),
      ...(read.contest ? { contested: read.contest } : {}),
    };
    if (read.contest) trace.push(`COMPARABLE: CONTESTED — ${read.contest.reason}; widened to the spread between them and reported as bounds, never as a probability.`);
    candidates.push(est);
    const adjusted = pooledSet.kept.filter((one) => one.adjusted.length > 0).map((one) => `${one.obs.id} (${one.adjusted.join('; ')})`);
    trace.push(
      `COMPARABLE: ${pooledSet.kept.length} independent observation(s) after transfer, spread between populations ${fmt(pooled.tau)} on the ${scale.toLowerCase()} scale${adjusted.length ? `; adjusted: ${adjusted.join(', ')}` : ''}.`,
    );
    if (!est.distributionJustified) {
      trace.push(
        allUnsized(pooledSet.kept)
          ? 'COMPARABLE: only published rates with no stated sample: they locate the answer but cannot justify a distribution, so bounds only.'
          : 'COMPARABLE: a single comparable population with no direct evidence beside it: bounds only.',
      );
    }
    if (sufficient(node, est) && est.distributionJustified) return finish(est, sorted, trace);
  } else {
    trace.push('COMPARABLE: no transferable observation of a comparable population.');
  }

  // COMPONENT
  if (node.formula) {
    const names = [...identifiers(parse(node.formula))];
    const children = names.map((name) => resolve(ctx, name, depth + 1));
    const missing = children.filter((child) => child.tier === 'UNKNOWN' && child.samples.length === 0);
    if (missing.length > 0) {
      trace.push(`COMPONENT: cannot rebuild — ${missing.map((one) => one.key).join(', ')} has no evidence and no bounds.`);
    } else {
      const samples = propagate(ctx, node, names, children);
      const onScale = new Float64Array(samples.length);
      for (let i = 0; i < samples.length; i++) onScale[i] = toScale(scale, samples[i]!);
      let sum = 0;
      for (let i = 0; i < onScale.length; i++) sum += onScale[i]!;
      const mean = sum / onScale.length;
      let squares = 0;
      for (let i = 0; i < onScale.length; i++) squares += (onScale[i]! - mean) ** 2;
      const sd = Math.sqrt(squares / Math.max(1, onScale.length - 1));
      // A typed array sorts numerically without a comparator call per comparison.
      const sortedSamples = Float64Array.from(samples).sort() as unknown as number[];
      const justified = children.every((child) => child.distributionJustified);
      const weakest = children.reduce<EvidenceTier>((w, child) => (tierRank(child.tier) > tierRank(w) ? child.tier : w), 'DIRECT');
      let est: Estimate = {
        ...blank(node, 'COMPONENT'),
        mean,
        sd,
        p05: quantile(sortedSamples, 0.05),
        p10: quantile(sortedSamples, 0.1),
        p50: quantile(sortedSamples, 0.5),
        p90: quantile(sortedSamples, 0.9),
        p95: quantile(sortedSamples, 0.95),
        samples,
        effectiveSample: Math.min(...children.map((child) => child.effectiveSample || 0)),
        distributionJustified: justified,
        // A rebuilt quantity is as well evidenced as its weakest part.
        populations: Math.min(...children.map((child) => child.populations ?? 0)),
        sizedPopulations: Math.min(...children.map((child) => child.sizedPopulations ?? 0)),
        events: justified ? Math.min(...children.map((child) => child.events ?? 0)) : 0,
        ...(children.some((child) => child.contested) ? { contested: children.find((child) => child.contested)!.contested! } : {}),
        sources: children.flatMap((child) => child.sources),
        used: children.flatMap((child) => child.used),
        children: names,
      };
      const loose = children.filter((child) => !child.distributionJustified).map((child) => `${child.key} (${child.tier.toLowerCase()})`);
      trace.push(`COMPONENT: rebuilt as ${node.formula} from ${names.join(', ')}${loose.length ? `; known only as bounds: ${loose.join(', ')}` : `; every part rests on evidence (weakest: ${weakest.toLowerCase()})`}.`);
      // Independent routes to one quantity sharpen each other; routes that share data do not.
      const best = candidates.sort((a, b) => width(a) - width(b))[0];
      if (best && justified) {
        const shared = best.used.some((id) => est.used.includes(id));
        if (!shared) {
          const both = combine({ mean: best.mean, sd: best.sd }, { mean: est.mean, sd: est.sd });
          // One draw serves the quantiles and the samples (it was drawn twice, identically).
          const drawn = fromNormal(node, scale, both.mean, both.sd);
          est = { ...est, ...drawn, samples: drawn.samples, sources: [...best.sources, ...est.sources], used: [...best.used, ...est.used] };
          trace.push(`COMPONENT: combined with the ${best.tier} evidence, which shares no data with the parts.`);
        }
      }
      candidates.push(est);
      if (sufficient(node, est) && justified) return finish(est, sorted, trace);
    }
  }

  // The most precise route that ran, if it ran at all.
  const evidential = candidates.filter((one) => DISTRIBUTION_TIERS.includes(one.tier) && one.distributionJustified);
  if (evidential.length > 0) {
    const best = evidential.sort((a, b) => width(a) - width(b))[0]!;
    trace.push(`Not as precise as wanted; the most precise route was ${best.tier}.`);
    return finish(best, sorted, trace);
  }

  const weakComponent = candidates
    .filter((one) => one.tier === 'DIRECT' || one.tier === 'COMPONENT' || one.tier === 'COMPARABLE')
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))[0];
  if (weakComponent) {
    trace.push(
      weakComponent.tier === 'DIRECT'
        ? 'Only unsized published rates of this population answer it; reported as bounds, never as a probability.'
        : weakComponent.tier === 'COMPARABLE'
          ? 'Only one comparable population, or only unsized rates, answer it; reported as bounds, never as a probability.'
          : 'Rebuilt from parts some of which rest on broad evidence, an assumption or bounds alone; reported as bounds, never as a probability.',
    );
    return finish(weakComponent, sorted, trace);
  }

  // MECHANISM — broad evidence: bounds only.
  const broad = collapseLineage(sorted.broad);
  if (broad.kept.length > 0) {
    const pooled = pool(broad.kept, SPREAD_FLOOR.MECHANISM)!;
    const est: Estimate = {
      ...blank(node, 'MECHANISM'),
      populations: broad.kept.length,
      sizedPopulations: broad.kept.filter((one) => !one.unsized).length,
      events: 0,
      ...fromNormal(node, scale, pooled.mean, pooled.sd),
      effectiveSample: pooled.effective,
      heterogeneity: pooled.tau,
      distributionJustified: false,
      sources: sourcesOf(broad.kept),
      used: broad.kept.map((one) => one.obs.id),
      collapsed: broad.collapsed,
    };
    trace.push(`MECHANISM: only broad economic evidence (${broad.kept.length} independent); reported as bounds, never as a probability.`);
    return finish(est, sorted, trace);
  }
  if (node.assumed) {
    const est: Estimate = { ...blank(node, 'ASSUMED'), ...uniform(node, node.assumed.low, node.assumed.high), sources: [node.assumed.source] };
    trace.push(`ASSUMED: nothing establishes it; a person's range ${fmt(node.assumed.low)}–${fmt(node.assumed.high)} is used as bounds.`);
    return finish(est, sorted, trace);
  }
  const lo = node.kind === 'RATE' ? (node.min ?? 0) : node.min;
  const hi = node.kind === 'RATE' ? (node.max ?? 1) : node.max;
  const est = blank(node, 'UNKNOWN');
  if (lo !== undefined && hi !== undefined) Object.assign(est, uniform(node, lo, hi));
  trace.push(lo !== undefined && hi !== undefined ? `UNKNOWN: only its physical bounds ${fmt(lo)}–${fmt(hi)}.` : 'UNKNOWN: no evidence and no bounds.');
  return finish(est, sorted, trace);
}

function uniform(node: QuantityNode, lo: number, hi: number): Pick<Estimate, 'p05' | 'p10' | 'p50' | 'p90' | 'p95' | 'samples' | 'mean' | 'sd'> {
  const rng = makeRng(seedOf(node.key), 11);
  const samples = new Array<number>(QUANT_LIMITS.samples);
  for (let i = 0; i < samples.length; i++) samples[i] = lo + (hi - lo) * rng();
  const at = (p: number) => lo + (hi - lo) * p;
  const scale = scaleFor(node.kind);
  const m = toScale(scale, at(0.5));
  return { mean: m, sd: Math.abs(toScale(scale, at(0.9)) - toScale(scale, at(0.1))) / 2.563, p05: at(0.05), p10: at(0.1), p50: at(0.5), p90: at(0.9), p95: at(0.95), samples };
}

function finish(est: Estimate, sorted: ReturnType<typeof classify>, trace: string[]): Estimate {
  return { ...est, excluded: sorted.excluded, trace: [...trace, ...sorted.excluded.map((one) => `excluded ${one.id}: ${one.reason}`)] };
}

function tierRank(tier: EvidenceTier): number {
  return ['DIRECT', 'COMPARABLE', 'COMPONENT', 'MECHANISM', 'ASSUMED', 'UNKNOWN'].indexOf(tier);
}

/** Push the children's samples through the formula, honouring declared correlations. */
function propagate(ctx: Context, node: QuantityNode, names: string[], children: Estimate[]): number[] {
  const fn = compile(parse(node.formula!), (name) => names.indexOf(name));
  const n = QUANT_LIMITS.samples;
  const k = names.length;
  const matrix: number[][] = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
  for (const c of ctx.correlations ?? []) {
    const a = names.indexOf(c.a);
    const b = names.indexOf(c.b);
    if (a >= 0 && b >= 0 && a !== b) {
      matrix[a]![b] = c.rho;
      matrix[b]![a] = c.rho;
    }
  }
  const factor = cholesky(matrix);
  if (!factor) throw new ReconstructionError(`The correlations declared among ${names.join(', ')} cannot all hold at once.`);
  // A child a declared correlation touches is drawn through the copula; the rest keep their worlds.
  const remixed = names.map((_, j) => matrix[j]!.some((rho, m) => m !== j && rho !== 0));
  // Only a child read through the copula is read by quantile, so only its samples are sorted.
  const sortedChildren = children.map((child, j) => (remixed[j] || child.samples.length !== QUANT_LIMITS.samples ? Float64Array.from(child.samples).sort() : null));
  /*
   * World i draws each child's quantile from a stream keyed by the CHILD, not
   * by this node. One quantity used by two formulas (orders feeding both
   * revenue and cost; one response rate feeding three product lines) is then
   * at the same quantile in world i of both, so sums and pairs built from it
   * keep their dependence. Keyed by the parent, every formula drew its own
   * copy of a shared quantity independently, which manufactured
   * diversification that does not exist (2026-11-02, the $10K plan).
   */
  const streams = children.map((child) => standardNormals(child.key, 3));
  const env = new Float64Array(k);
  const z = new Float64Array(k);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) z[j] = streams[j]![i]!;
    for (let j = 0; j < k; j++) {
      // Uncorrelated child with world-aligned samples: take its own world i, so a
      // quantity shared at any depth carries one value per world across the graph.
      const own = children[j]!.samples;
      if (!remixed[j] && own.length === n) {
        env[j] = own[i]!;
        continue;
      }
      let sum = 0;
      for (let m = 0; m <= j; m++) sum += factor[j]![m]! * z[m]!;
      const s = sortedChildren[j]!;
      env[j] = s[Math.min(s.length - 1, Math.floor(normalCdf(sum) * s.length))]!;
    }
    const value = fn(env);
    out[i] = bound(node, Number.isFinite(value) ? value : 0);
  }
  return out;
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  return a !== 0 && a < 1 ? x.toFixed(3) : a < 100 ? x.toFixed(1) : String(Math.round(x));
}

/** Reconstruct one quantity. Throws `ReconstructionError` with the reason. */
export function reconstruct(graph: QuantGraph, target: string, now: Date = new Date()): Reconstruction {
  const started = Date.now();
  const byKey = new Map<string, QuantityNode>();
  for (const node of graph.nodes) {
    if (byKey.has(node.key)) throw new ReconstructionError(`Two nodes are both called "${node.key}".`);
    if (!/^[a-z][a-z0-9_]*$/.test(node.key)) throw new ReconstructionError(`"${node.key}" is not a usable name: lower case, digits and underscores, starting with a letter.`);
    byKey.set(node.key, node);
  }
  const ctx: Context = { graph: byKey, memo: new Map(), stack: new Set(), now, visited: 0, correlations: graph.correlations };
  resolve(ctx, target, 0);
  const estimates = Object.fromEntries(ctx.memo);
  return { target, estimates, notNeeded: graph.nodes.map((one) => one.key).filter((one) => !ctx.memo.has(one)), visited: ctx.visited, elapsedMs: Date.now() - started };
}
