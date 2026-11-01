/**
 * Seeded Monte Carlo. Same seed, same options, same output — it draws only from
 * `makeRng`, never `Math.random` or the clock. Every figure is a MODEL_ESTIMATE
 * with a Wilson 95% interval, and the result states the runs, the mulligan
 * policy and the draw rules it used.
 */
import { makeRng } from '../../scenario/random.ts';
import type { LabelledNumber } from '../../../domain/magicTypes.ts';

export interface SimCard {
  name: string;
  isLand: boolean;
  /** Mana this card adds when it is a mana source (ramp or land). */
  manaProduced?: number;
  isRamp?: boolean;
  isDraw?: boolean;
}

export interface MulliganPolicy {
  /** London mulligan: keep a 7 with lands in [minLands, maxLands]; else go down, never below `floor`. */
  minLands: number;
  maxLands: number;
  floor: number;
}

export interface SimOptions {
  runs: number;
  seed: number;
  turns: number;
  onThePlay: boolean;
  mulligan: MulliganPolicy;
}

export const DEFAULT_MULLIGAN: MulliganPolicy = { minLands: 2, maxLands: 5, floor: 4 };

export interface Interval {
  value: number;
  low: number;
  high: number;
}

export function wilson(successes: number, runs: number, z = 1.96): Interval {
  if (runs === 0) return { value: 0, low: 0, high: 1 };
  const p = successes / runs;
  const denom = 1 + (z * z) / runs;
  const centre = (p + (z * z) / (2 * runs)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / runs + (z * z) / (4 * runs * runs))) / denom;
  return { value: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface SimResult {
  runs: number;
  seed: number;
  assumptions: string[];
  mulliganPolicy: MulliganPolicy;
  drawRules: string;
  /** P(at least `target` lands on battlefield-equivalent by turn), per turn. */
  landDrops: { turn: number; atLeast: number; estimate: LabelledNumber & { low: number; high: number } }[];
  /** P(at least one ramp source drawn by turn). */
  rampByTurn: { turn: number; estimate: LabelledNumber & { low: number; high: number } }[];
  /** P(keeping a seven without a mulligan). */
  keepSeven: LabelledNumber & { low: number; high: number };
  meanMulligans: LabelledNumber;
}

function labelled(i: Interval, note: string): LabelledNumber & { low: number; high: number } {
  return { value: i.value, low: i.low, high: i.high, label: 'MODEL_ESTIMATE', note };
}

export function simulate(library: SimCard[], options: SimOptions): SimResult {
  const { runs, seed, turns, onThePlay, mulligan } = options;
  const n = library.length;
  if (n < 7) throw new Error('Library too small to simulate.');
  const landTarget = (turn: number) => Math.min(turn, 5);
  const landHits = Array.from({ length: turns }, () => 0);
  const rampHits = Array.from({ length: turns }, () => 0);
  let keptSeven = 0;
  let mulliganTotal = 0;
  for (let r = 0; r < runs; r++) {
    const rng = makeRng(seed, r);
    // Fisher-Yates over indices.
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    // Mulligan policy over the top-7 of repeated reshuffles is approximated by
    // re-drawing a fresh seven from the same shuffle's next cards (London: draw
    // seven, bottom `m`, which only changes which seven are kept).
    let offset = 0;
    let mulls = 0;
    for (;;) {
      const hand = order.slice(offset, offset + 7);
      const lands = hand.filter((i) => library[i]!.isLand).length;
      const ok = lands >= mulligan.minLands && lands <= mulligan.maxLands;
      if (ok || 7 - mulls <= mulligan.floor) break;
      mulls++;
      offset += 7;
      if (offset + 7 > n) break;
    }
    if (mulls === 0) keptSeven++;
    mulliganTotal += mulls;
    const handStart = offset;
    for (let t = 1; t <= turns; t++) {
      const seen = 7 + (onThePlay ? t - 1 : t);
      const cards = order.slice(handStart, handStart + Math.min(seen, n - handStart));
      const landCount = cards.filter((i) => library[i]!.isLand).length;
      if (landCount >= landTarget(t)) landHits[t - 1]!++;
      if (cards.some((i) => library[i]!.isRamp)) rampHits[t - 1]!++;
    }
  }
  return {
    runs,
    seed,
    assumptions: [
      'Library only; the commander is in the command zone and never drawn.',
      'A land drop is counted when enough lands have been seen, ignoring sequencing and tapped lands.',
      'Mulligan decisions use land count only.',
    ],
    mulliganPolicy: mulligan,
    drawRules: onThePlay ? 'On the play: no draw on turn 1.' : 'On the draw: draw on turn 1.',
    landDrops: landHits.map((h, i) => ({
      turn: i + 1,
      atLeast: landTarget(i + 1),
      estimate: labelled(wilson(h, runs), `Seen at least ${landTarget(i + 1)} lands by turn ${i + 1}.`),
    })),
    rampByTurn: rampHits.map((h, i) => ({
      turn: i + 1,
      estimate: labelled(wilson(h, runs), `At least one ramp source seen by turn ${i + 1}.`),
    })),
    keepSeven: labelled(wilson(keptSeven, runs), 'Opening seven passes the land-count keep policy.'),
    meanMulligans: { value: mulliganTotal / runs, label: 'MODEL_ESTIMATE', note: 'Average mulligans taken.' },
  };
}
