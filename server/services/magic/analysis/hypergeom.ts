/**
 * Exact hypergeometric arithmetic on BigInt rationals.
 *
 * Nothing here uses floating point until the very last step, where a rational
 * is rounded for display. Overlapping categories are handled by partitioning
 * the library into cells by category membership and counting draws cell by
 * cell, so a card that is both ramp and draw is one card with one chance of
 * being drawn — never two chances added together.
 */
import type { LabelledNumber } from '../../../domain/magicTypes.ts';

export interface Rational {
  num: bigint;
  den: bigint;
}

const binomCache = new Map<string, bigint>();

export function choose(n: number, k: number): bigint {
  if (k < 0 || k > n || n < 0) return 0n;
  if (k === 0 || k === n) return 1n;
  const kk = Math.min(k, n - k);
  const key = `${n}:${kk}`;
  const hit = binomCache.get(key);
  if (hit !== undefined) return hit;
  let result = 1n;
  for (let i = 1; i <= kk; i++) result = (result * BigInt(n - kk + i)) / BigInt(i);
  binomCache.set(key, result);
  return result;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new Error('Zero denominator.');
  const g = gcd(num, den) || 1n;
  return { num: num / g, den: den / g };
}

export function toNumber(r: Rational): number {
  const scale = 10n ** 18n;
  const scaled = (r.num * scale) / r.den;
  return Number(scaled) / 1e18;
}

/** P(exactly x of the K special cards among n drawn from N). */
export function pExactly(N: number, K: number, n: number, x: number): Rational {
  checkArgs(N, K, n);
  return rational(choose(K, x) * choose(N - K, n - x), choose(N, n));
}

/** P(at least `k` of the K special cards among n drawn from N). */
export function pAtLeast(N: number, K: number, n: number, k = 1): Rational {
  checkArgs(N, K, n);
  const total = choose(N, n);
  let below = 0n;
  for (let x = 0; x < k; x++) below += choose(K, x) * choose(N - K, n - x);
  return rational(total - below, total);
}

/** P(at least one) = 1 - C(N-K, n) / C(N, n). */
export function pAtLeastOne(N: number, K: number, n: number): Rational {
  return pAtLeast(N, K, n, 1);
}

function checkArgs(N: number, K: number, n: number): void {
  if (![N, K, n].every(Number.isInteger) || N < 0 || K < 0 || n < 0 || K > N || n > N) {
    throw new Error(`Invalid hypergeometric arguments N=${N} K=${K} n=${n}.`);
  }
}

/** The exact distribution of the number of special cards drawn. */
export function pmf(N: number, K: number, n: number): Rational[] {
  const out: Rational[] = [];
  for (let x = 0; x <= Math.min(K, n); x++) out.push(pExactly(N, K, n, x));
  return out;
}

/** A library card's category membership (each name is a category). */
export interface CategoryCard {
  categories: string[];
  quantity: number;
}

/**
 * Exact P(every required category is represented among the n cards drawn),
 * with `minimum[c]` cards needed from category c (default 1). A card belonging
 * to two categories counts toward both but is still only one drawn card.
 */
export function pJointAtLeast(
  library: CategoryCard[],
  n: number,
  required: Record<string, number>,
): Rational {
  const names = Object.keys(required);
  const total = library.reduce((s, c) => s + c.quantity, 0);
  if (n > total || n < 0) throw new Error('Cannot draw more cards than the library holds.');
  // Cells: cards with identical membership over the required categories.
  const cells = new Map<string, { size: number; member: number[] }>();
  for (const card of library) {
    const member = names.map((name) => (card.categories.includes(name) ? 1 : 0));
    const key = member.join('');
    const cell = cells.get(key) ?? { size: 0, member };
    cell.size += card.quantity;
    cells.set(key, cell);
  }
  // State: drawn count, capped progress toward each requirement.
  const caps = names.map((name) => required[name] ?? 1);
  let states = new Map<string, bigint>();
  states.set(`0|${caps.map(() => 0).join(',')}`, 1n);
  for (const cell of cells.values()) {
    const next = new Map<string, bigint>();
    for (const [key, ways] of states) {
      const [drawnText, progressText] = key.split('|') as [string, string];
      const drawn = Number(drawnText);
      const progress = progressText.split(',').map(Number);
      for (let take = 0; take <= Math.min(cell.size, n - drawn); take++) {
        const w = ways * choose(cell.size, take);
        const np = progress.map((p, i) => Math.min(caps[i] ?? 1, p + (cell.member[i] ? take : 0)));
        const nk = `${drawn + take}|${np.join(',')}`;
        next.set(nk, (next.get(nk) ?? 0n) + w);
      }
    }
    states = next;
  }
  let good = 0n;
  for (const [key, ways] of states) {
    const [drawnText, progressText] = key.split('|') as [string, string];
    if (Number(drawnText) !== n) continue;
    const progress = progressText.split(',').map(Number);
    if (progress.every((p, i) => p >= (caps[i] ?? 1))) good += ways;
  }
  return rational(good, choose(total, n));
}

/** P(at least k cards drawn from the union of the categories) — a card in two is one card. */
export function pAtLeastFromUnion(library: CategoryCard[], n: number, categories: string[], k = 1): Rational {
  const total = library.reduce((s, c) => s + c.quantity, 0);
  const union = library
    .filter((c) => c.categories.some((x) => categories.includes(x)))
    .reduce((s, c) => s + c.quantity, 0);
  return pAtLeast(total, union, n, k);
}

export function labelExact(r: Rational, note?: string): LabelledNumber & { exact: { num: string; den: string } } {
  return {
    value: toNumber(r),
    label: 'EXACT_PROBABILITY',
    ...(note ? { note } : {}),
    exact: { num: r.num.toString(), den: r.den.toString() },
  };
}
