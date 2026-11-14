/**
 * Evidence synthesis: what several observations, measured in several
 * populations, say about one target population.
 *
 * Four steps, in order, each one a refusal before it is a calculation:
 *
 *   1. **Staleness.** An observation older than the quantity's freshness
 *      window is excluded with its age.
 *   2. **Transfer.** Its context is compared with the target's. A mismatch on a
 *      dimension the quantity declares material excludes it — unless a declared
 *      adjustment, with its own source, bridges that exact difference, in which
 *      case the value is shifted and the adjustment's own width is added to its
 *      uncertainty. A material dimension the source does not state cannot be
 *      assumed to match. A mismatch on an immaterial dimension is kept and
 *      discounted.
 *   3. **Shared data.** Observations whose lineages intersect are one
 *      observation counted twice; the group keeps its most informative member
 *      and the rest are reported as collapsed, never silently dropped.
 *   4. **Pooling.** A random-effects (DerSimonian–Laird) combination on the
 *      quantity's natural scale — logit for a share, log for a positive
 *      magnitude — with a floor on between-population spread that depends on
 *      how far the evidence had to travel. The predictive distribution for the
 *      target is the pooled mean's uncertainty *plus* that spread: a new
 *      population is not the average population.
 *
 * Nothing averages percentages as numbers, and nothing here invents a value.
 * The few conventions it uses — what one unsized published rate is worth, the
 * reading error of one published figure, the spread floor per tier — are named
 * constants, so a reader can see exactly what was assumed about the evidence.
 */
import type { ExcludedObservation, Observation, QuantityKind, QuantityNode, TransferAdjustment } from '../../domain/quant.ts';

/**
 * A published rate with no stated sample says where the rate is and nothing
 * about how precisely anybody measured it. It is read with this many events'
 * worth of information — log-odds variance 1/4, about ±65% on the odds — so it
 * locates the rate without pretending to a precision the source never stated.
 * And precision a source never stated cannot make a probability: an estimate
 * resting only on unsized rates is bounds, never a distribution (`allUnsized`).
 *
 * Reviewed 2026-11-01. The first value was ten events (±37% on the odds),
 * which let three unsized published rates pool into a distribution as narrow
 * as one measured on a few dozen contacts — sampled evidence nobody observed.
 * Counting it as trials instead would make a rare rate (0.45%) say nothing and
 * a common one say a lot, which is the scale talking rather than the evidence.
 */
export const UNSIZED_RATE_EVENTS = 4;
/** One published figure for a magnitude is read with this log-scale reading error (≈ ±10%). */
export const POINT_LOG_SD = 0.1;
/** Each immaterial difference halves an observation's weight… roughly: weight × 0.7. */
export const IMMATERIAL_DISCOUNT = 0.7;
/**
 * The smallest between-population spread, on the pooling scale, assumed when
 * evidence crosses populations: a comparable population differs by at least
 * ~30%, a broad economic figure by at least ~120%.
 */
export const SPREAD_FLOOR = { DIRECT: 0, COMPARABLE: 0.3, MECHANISM: 0.8 } as const;
/**
 * Selection on published demand rates (Q2-11, 2026-11-14). Vendors, agencies
 * and case studies publish the conversion figures that flatter them, and a
 * benchmark page reports the campaigns somebody chose to write up. A published
 * reply or close rate is therefore read as between 0.7 and 1.0 of itself — its
 * centre moved down about 15% and that width added to its uncertainty. A
 * convention, not a measurement: it stays until this Brain's own outcomes
 * against published figures (`quant/forecast.ts`) measure the gap. Brain's own
 * measured rates are not discounted.
 */
export const PUBLISHED_RATE_SELECTION = { factorLow: 0.7, factorHigh: 1.0 } as const;
const Z90 = 1.6448536;

export type Scale = 'LOGIT' | 'LOG' | 'IDENTITY';

export function scaleFor(kind: QuantityKind): Scale {
  return kind === 'RATE' ? 'LOGIT' : kind === 'POSITIVE' ? 'LOG' : 'IDENTITY';
}

const clampRate = (p: number) => Math.min(0.999, Math.max(0.001, p));

export function toScale(scale: Scale, x: number): number {
  if (scale === 'LOGIT') {
    const p = clampRate(x);
    return Math.log(p / (1 - p));
  }
  if (scale === 'LOG') return Math.log(Math.max(x, 1e-9));
  return x;
}

export function fromScale(scale: Scale, y: number): number {
  if (scale === 'LOGIT') return 1 / (1 + Math.exp(-y));
  if (scale === 'LOG') return Math.exp(y);
  return y;
}

/** One observation on the pooling scale. */
export interface Scaled {
  obs: Observation;
  y: number;
  v: number;
  /** How far it travelled: 0 direct, else the number of discounted differences + 1. */
  distance: number;
  adjusted: string[];
  /** A rate whose source stated no sample: location, not precision. */
  unsized?: boolean;
  /**
   * The between-population spread an unsized published range implies, as a
   * standard deviation on the pooling scale (Q2-5). "Closes 10–25%" says how
   * far the rate varies between the populations its source saw — never how
   * precisely one of them was measured — so it floors τ, not the variance.
   */
  spread?: number;
}

/**
 * Whether every observation kept is an unsized published rate. Such evidence
 * locates a rate and bounds it; it cannot justify a probability distribution,
 * because the precision that distribution would claim was never measured.
 */
export function allUnsized(items: readonly Scaled[]): boolean {
  return items.length > 0 && items.every((one) => one.unsized);
}

/** An observation's centre and sampling variance on the pooling scale. */
export function onScale(obs: Observation, kind: QuantityKind): { y: number; v: number; unsized?: boolean; spread?: number } | null {
  const scale = scaleFor(kind);
  const value = obs.value;
  if (value.kind === 'COUNT') {
    if (kind !== 'RATE' || !(value.trials > 0) || value.successes < 0 || value.successes > value.trials) return null;
    const p = (value.successes + 0.5) / (value.trials + 1);
    return { y: toScale(scale, p), v: 1 / ((value.trials + 1) * p * (1 - p)) };
  }
  if (value.kind === 'POINT') {
    if (!Number.isFinite(value.value)) return null;
    if (kind === 'RATE') {
      if (value.value < 0 || value.value > 1) return null;
      const p = clampRate(value.value);
      // A ratio of two published amounts about one case: reading error only.
      if (value.exact) return { y: toScale(scale, p), v: POINT_LOG_SD ** 2 };
      const sized = !!(value.sampleSize && value.sampleSize > 0);
      const information = sized ? value.sampleSize! * p * (1 - p) : UNSIZED_RATE_EVENTS;
      return { y: toScale(scale, p), v: 1 / information, unsized: !sized };
    }
    if (kind === 'POSITIVE') {
      if (value.value <= 0) return null;
      return { y: Math.log(value.value), v: POINT_LOG_SD ** 2 };
    }
    return { y: value.value, v: (Math.max(Math.abs(value.value), 1e-6) * POINT_LOG_SD) ** 2 };
  }
  if (!(value.high >= value.low) || !Number.isFinite(value.low)) return null;
  if (kind === 'POSITIVE' && value.low <= 0) return null;
  if (kind === 'RATE' && (value.low < 0 || value.high > 1)) return null;
  const lo = toScale(scale, value.low);
  const hi = toScale(scale, value.high);
  const sd = Math.max((hi - lo) / (2 * Z90), scale === 'IDENTITY' ? 1e-6 : POINT_LOG_SD);
  /*
   * A published range of a RATE with no stated sample (Q2-5, 2026-11-14) is
   * the spread between the populations it summarises, not sampling precision:
   * read as precision, "closes 10–25%" was worth ~57 trials and could justify
   * a distribution on its own. Its centre carries what an unsized rate carries,
   * it is unsized for `allUnsized`, and its width becomes a floor on τ.
   */
  if (kind === 'RATE') return { y: (lo + hi) / 2, v: 1 / UNSIZED_RATE_EVENTS, unsized: true, spread: sd };
  return { y: (lo + hi) / 2, v: sd * sd };
}

export interface Classified {
  direct: Scaled[];
  comparable: Scaled[];
  broad: Scaled[];
  excluded: ExcludedObservation[];
}

/** Sort every observation into the route it can serve, or exclude it with the reason. */
export function classify(node: QuantityNode, now: Date): Classified {
  const out: Classified = { direct: [], comparable: [], broad: [], excluded: [] };
  const target = node.context ?? {};
  const material = new Set(node.material ?? []);
  const scale = scaleFor(node.kind);
  for (const obs of node.observations ?? []) {
    if (node.freshDays && obs.observedAt) {
      const age = (now.getTime() - Date.parse(obs.observedAt)) / 86_400_000;
      if (age > node.freshDays) {
        out.excluded.push({ id: obs.id, reason: `stale: observed ${Math.round(age)} days ago, older than the ${node.freshDays}-day window` });
        continue;
      }
    }
    const base = onScale(obs, node.kind);
    if (!base) {
      out.excluded.push({ id: obs.id, reason: `its value cannot describe a ${node.kind.toLowerCase()} quantity` });
      continue;
    }
    if (obs.broad) {
      out.broad.push({ obs, y: base.y, v: base.v, distance: 99, adjusted: [], unsized: base.unsized, spread: base.spread });
      continue;
    }
    let { y, v } = base;
    let immaterial = 0;
    const adjusted: string[] = [];
    let refusal: string | null = null;
    if (obs.published && node.kind === 'RATE') {
      // Selection: a published demand rate is shifted down and widened, never taken at face value.
      const shifted = adjust(scale, y, { dimension: 'selection', from: 'PUBLISHED', to: 'MEASURED', factorLow: PUBLISHED_RATE_SELECTION.factorLow, factorHigh: PUBLISHED_RATE_SELECTION.factorHigh, source: { kind: 'OTHER', ref: 'quant:published-rate-selection' } });
      y = shifted.y;
      v += shifted.v;
      adjusted.push(`published-rate selection ×${PUBLISHED_RATE_SELECTION.factorLow}–${PUBLISHED_RATE_SELECTION.factorHigh}`);
    }
    for (const [dimension, want] of Object.entries(target)) {
      const has = obs.context[dimension];
      if (has === want) continue;
      if (material.has(dimension)) {
        if (has === undefined) {
          refusal = `does not state its ${dimension}, which matters here (target: ${want}) and cannot be assumed to match`;
          break;
        }
        const bridge = findAdjustment(node.adjustments ?? [], dimension, has, want);
        if (!bridge) {
          refusal = `measures a different ${dimension} (${has}, target ${want}) and no adjustment with its own source bridges that difference`;
          break;
        }
        const shifted = adjust(scale, y, bridge);
        y = shifted.y;
        v += shifted.v;
        adjusted.push(`${dimension}: ${has}→${want} ×${bridge.factorLow}–${bridge.factorHigh}`);
      } else {
        immaterial += 1;
      }
    }
    if (refusal) {
      out.excluded.push({ id: obs.id, reason: refusal });
      continue;
    }
    if (immaterial > 0) v = v / IMMATERIAL_DISCOUNT ** immaterial;
    const distance = immaterial + adjusted.length;
    const scaled = { obs, y, v, distance: distance === 0 ? 0 : distance + 1, adjusted, unsized: base.unsized, spread: base.spread };
    if (distance === 0) out.direct.push(scaled);
    else out.comparable.push(scaled);
  }
  return out;
}

function findAdjustment(list: TransferAdjustment[], dimension: string, from: string, to: string): TransferAdjustment | null {
  return list.find((one) => one.dimension === dimension && one.from === from && one.to === to) ?? null;
}

/** Shift a centre by a factor range on the natural scale, and add the range's own width. */
function adjust(scale: Scale, y: number, bridge: TransferAdjustment): { y: number; v: number } {
  const x = fromScale(scale, y);
  const lo = toScale(scale, x * bridge.factorLow);
  const hi = toScale(scale, x * bridge.factorHigh);
  const sd = Math.abs(hi - lo) / (2 * Z90);
  return { y: (lo + hi) / 2, v: sd * sd };
}

/**
 * Collapse observations that share upstream data. Union-find over lineage
 * ids; each group keeps the member with the smallest variance.
 */
export function collapseLineage(items: Scaled[]): { kept: Scaled[]; collapsed: string[][] } {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  items.forEach((item, i) => {
    for (const id of item.obs.lineage) {
      const seen = owner.get(id);
      if (seen === undefined) owner.set(id, i);
      else parent[find(i)] = find(seen);
    }
  });
  const groups = new Map<number, Scaled[]>();
  items.forEach((item, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), item]));
  const kept: Scaled[] = [];
  const collapsed: string[][] = [];
  for (const group of groups.values()) {
    const best = [...group].sort((a, b) => a.v - b.v || a.distance - b.distance)[0]!;
    kept.push(best);
    if (group.length > 1) collapsed.push(group.map((one) => one.obs.id));
  }
  return { kept, collapsed };
}

export interface Pooled {
  mean: number;
  /** Standard error of the pooled mean. */
  se: number;
  /** Between-population spread, as a standard deviation on the scale. */
  tau: number;
  /** Predictive standard deviation for the target: √(se² + τ²). */
  sd: number;
  effective: number;
  /** Independent populations pooled. */
  k: number;
}

/**
 * Random-effects pooling with a floor on the between-population spread. An
 * item's own `spread` (an unsized published range) also floors τ.
 */
export function pool(items: Array<{ y: number; v: number; spread?: number }>, tauFloor: number): Pooled | null {
  if (items.length === 0) return null;
  let tau2 = Math.max(tauFloor * tauFloor, ...items.map((one) => (one.spread ?? 0) ** 2));
  if (items.length >= 2) {
    const w = items.map((one) => 1 / one.v);
    const sw = w.reduce((a, b) => a + b, 0);
    const fixed = items.reduce((sum, one, i) => sum + w[i]! * one.y, 0) / sw;
    const q = items.reduce((sum, one, i) => sum + w[i]! * (one.y - fixed) ** 2, 0);
    const c = sw - w.reduce((a, b) => a + b * b, 0) / sw;
    if (c > 0) tau2 = Math.max(tau2, (q - (items.length - 1)) / c);
  }
  const ws = items.map((one) => 1 / (one.v + tau2));
  const sws = ws.reduce((a, b) => a + b, 0);
  const mean = items.reduce((sum, one, i) => sum + ws[i]! * one.y, 0) / sws;
  const se = Math.sqrt(1 / sws);
  const effective = sws * sws / ws.reduce((a, b) => a + b * b, 0);
  return { mean, se, tau: Math.sqrt(tau2), sd: Math.sqrt(se * se + tau2), effective, k: items.length };
}

/** Two observations this far apart, beyond their joint sampling error at 99%, are a contradiction. */
export const CONTEST_Z = 2.576;
/** …and only when they also differ by at least this factor on the natural scale (odds for a rate). */
export const CONTEST_FACTOR = 2;

/**
 * Whether sized observations of one quantity contradict each other (L-1,
 * 2026-11-14): some pair whose difference on the pooling scale exceeds both
 * 2.576 joint standard errors and a factor of two. "$8K" and "$45K" for one
 * quantity are not two measurements of one number to be averaged into a
 * confident interval; they are a contradiction to surface. Unsized rates are
 * not tested: they never claimed a precision to contradict.
 */
export function contestOf(items: readonly Scaled[]): { ids: string[]; reason: string; spread: number } | null {
  const sized = items.filter((one) => !one.unsized);
  let worst: { a: Scaled; b: Scaled; gap: number } | null = null;
  for (let i = 0; i < sized.length; i++) {
    for (let j = i + 1; j < sized.length; j++) {
      const a = sized[i]!;
      const b = sized[j]!;
      const gap = Math.abs(a.y - b.y);
      if (gap > CONTEST_Z * Math.sqrt(a.v + b.v) && gap >= Math.log(CONTEST_FACTOR) && (!worst || gap > worst.gap)) worst = { a, b, gap };
    }
  }
  if (!worst) return null;
  const ys = sized.map((one) => one.y);
  return {
    ids: [worst.a.obs.id, worst.b.obs.id],
    reason: `${worst.a.obs.id} and ${worst.b.obs.id} disagree by ${Math.exp(worst.gap).toFixed(1)}× on the ${'pooling'} scale, far beyond their own sampling error`,
    spread: (Math.max(...ys) - Math.min(...ys)) / 2,
  };
}

/**
 * The quantile of Student's t with `df` degrees of freedom at probability `p`.
 * Exact for one and two degrees of freedom; the Cornish–Fisher expansion in
 * 1/df (Abramowitz & Stegun 26.7.5) beyond, which is within 0.1% of the table
 * for df ≥ 3 at the quantiles a plan reads.
 */
export function studentT(p: number, df: number, z: number): number {
  if (!(df > 0) || !Number.isFinite(df) || df > 1e6) return z;
  const u = Math.min(1 - 1e-12, Math.max(1e-12, p));
  if (df === 1) return Math.tan(Math.PI * (u - 0.5));
  if (df === 2) return (2 * u - 1) / Math.sqrt(2 * u * (1 - u));
  const z2 = z * z;
  const g1 = (z2 * z + z) / 4;
  const g2 = (5 * z2 * z2 * z + 16 * z2 * z + 3 * z) / 96;
  const g3 = (3 * z2 * z2 * z2 * z + 19 * z2 * z2 * z + 17 * z2 * z - 15 * z) / 384;
  const g4 = (79 * z2 * z2 * z2 * z2 * z + 776 * z2 * z2 * z2 * z + 1482 * z2 * z2 * z - 1920 * z2 * z - 945 * z) / 92160;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3 + g4 / df ** 4;
}

/** Combine two independent estimates of one quantity by inverse variance. */
export function combine(a: { mean: number; sd: number }, b: { mean: number; sd: number }): { mean: number; sd: number } {
  const wa = 1 / (a.sd * a.sd);
  const wb = 1 / (b.sd * b.sd);
  return { mean: (wa * a.mean + wb * b.mean) / (wa + wb), sd: Math.sqrt(1 / (wa + wb)) };
}
