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
 * A published rate with no stated sample carries this many events' worth of
 * information: its log-odds variance is 1/10, about ±37% on the odds, whatever
 * the rate. Counting it as ten *trials* instead would make a rare rate (0.45%)
 * say nothing at all and a common one say a lot, which is the scale talking
 * rather than the evidence.
 */
export const UNSIZED_RATE_EVENTS = 10;
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
}

/** An observation's centre and sampling variance on the pooling scale. */
export function onScale(obs: Observation, kind: QuantityKind): { y: number; v: number } | null {
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
      const information = value.sampleSize && value.sampleSize > 0 ? value.sampleSize * p * (1 - p) : UNSIZED_RATE_EVENTS;
      return { y: toScale(scale, p), v: 1 / information };
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
      out.broad.push({ obs, y: base.y, v: base.v, distance: 99, adjusted: [] });
      continue;
    }
    let { y, v } = base;
    let immaterial = 0;
    const adjusted: string[] = [];
    let refusal: string | null = null;
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
    const scaled = { obs, y, v, distance: distance === 0 ? 0 : distance + 1, adjusted };
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
}

/** Random-effects pooling with a floor on the between-population spread. */
export function pool(items: Array<{ y: number; v: number }>, tauFloor: number): Pooled | null {
  if (items.length === 0) return null;
  let tau2 = tauFloor * tauFloor;
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
  return { mean, se, tau: Math.sqrt(tau2), sd: Math.sqrt(se * se + tau2), effective };
}

/** Combine two independent estimates of one quantity by inverse variance. */
export function combine(a: { mean: number; sd: number }, b: { mean: number; sd: number }): { mean: number; sd: number } {
  const wa = 1 / (a.sd * a.sd);
  const wb = 1 / (b.sd * b.sd);
  return { mean: (wa * a.mean + wb * b.mean) / (wa + wb), sd: Math.sqrt(1 / (wa + wb)) };
}
