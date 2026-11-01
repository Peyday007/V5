/**
 * Colored-source castability, exact under a stated model.
 *
 * Model: by turn t you have seen `7 + t - 1` cards on the play (`+ t` on the
 * draw) of the 99-card library — no mulligans, no ramp — and a spell is
 * castable when the seen lands include at least `cmc` lands and, for each color
 * in its cost, at least that many sources of the color. Only lands that enter
 * untapped are counted when `untappedOnly` is set, which is the conservative
 * reading for casting on curve. The command zone is never in the library.
 */
import { choose, rational, toNumber, type Rational } from './hypergeom.ts';
import type { LabelledNumber } from '../../../domain/magicTypes.ts';

export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G';
const COLORS: ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

export interface LandInfo {
  quantity: number;
  /** Colors this land can produce. */
  produces: ManaColor[];
  entersTapped?: boolean;
}

export function parseCost(manaCost: string): { generic: number; pips: Partial<Record<ManaColor, number>>; cmc: number } {
  const pips: Partial<Record<ManaColor, number>> = {};
  let generic = 0;
  let cmc = 0;
  for (const m of manaCost.matchAll(/\{([^}]+)\}/g)) {
    const sym = m[1] ?? '';
    if (/^\d+$/.test(sym)) {
      generic += Number(sym);
      cmc += Number(sym);
    } else if (sym === 'X') {
      // X contributes 0 to the minimum cost.
    } else if (/^[WUBRG]$/.test(sym)) {
      pips[sym as ManaColor] = (pips[sym as ManaColor] ?? 0) + 1;
      cmc += 1;
    } else if (/^[WUBRG]\/[WUBRG]$/.test(sym)) {
      // Hybrid: counted as generic here; the first color is a lower bound only.
      generic += 1;
      cmc += 1;
    } else {
      generic += 1;
      cmc += 1;
    }
  }
  return { generic, pips, cmc };
}

export function cardsSeen(turn: number, onThePlay: boolean): number {
  return 7 + (onThePlay ? turn - 1 : turn);
}

/**
 * Exact probability a spell with `manaCost` is castable on `turn`.
 * `librarySize` is the library (99 in Commander), `nonLand` is everything else.
 */
export function pCastable(
  manaCost: string,
  lands: LandInfo[],
  librarySize: number,
  turn: number,
  onThePlay = true,
  untappedOnly = true,
): LabelledNumber & { exact: { num: string; den: string }; model: string } {
  const { pips, cmc } = parseCost(manaCost);
  const need = COLORS.filter((c) => (pips[c] ?? 0) > 0);
  const n = cardsSeen(turn, onThePlay);
  const usable = lands.filter((l) => !(untappedOnly && l.entersTapped));
  const landTotal = usable.reduce((s, l) => s + l.quantity, 0);
  const other = librarySize - landTotal;
  if (n > librarySize) throw new Error('More cards seen than the library holds.');
  // Cells of usable lands by the set of needed colors they produce.
  const cells = new Map<string, { size: number; member: number[] }>();
  for (const l of usable) {
    const member = need.map((c) => (l.produces.includes(c) ? 1 : 0));
    const key = member.join('');
    const cell = cells.get(key) ?? { size: 0, member };
    cell.size += l.quantity;
    cells.set(key, cell);
  }
  const caps = need.map((c) => pips[c] ?? 0);
  // State: drawn so far | lands so far (capped at cmc) | per-color progress (capped).
  let states = new Map<string, bigint>();
  states.set(`0|0|${caps.map(() => 0).join(',')}`, 1n);
  const apply = (size: number, member: number[] | null, isLand: boolean) => {
    const next = new Map<string, bigint>();
    for (const [key, ways] of states) {
      const [d, l, p] = key.split('|') as [string, string, string];
      const drawn = Number(d);
      const landsSoFar = Number(l);
      const progress = p === '' ? [] : p.split(',').map(Number);
      for (let take = 0; take <= Math.min(size, n - drawn); take++) {
        const w = ways * choose(size, take);
        const nl = isLand ? Math.min(cmc, landsSoFar + take) : landsSoFar;
        const np = progress.map((x, i) => Math.min(caps[i] ?? 0, x + (member && member[i] ? take : 0)));
        const nk = `${drawn + take}|${nl}|${np.join(',')}`;
        next.set(nk, (next.get(nk) ?? 0n) + w);
      }
    }
    states = next;
  };
  for (const cell of cells.values()) apply(cell.size, cell.member, true);
  apply(other, null, false);
  let good = 0n;
  for (const [key, ways] of states) {
    const [d, l, p] = key.split('|') as [string, string, string];
    if (Number(d) !== n) continue;
    const progress = p === '' ? [] : p.split(',').map(Number);
    if (Number(l) >= cmc && progress.every((x, i) => x >= (caps[i] ?? 0))) good += ways;
  }
  const r: Rational = rational(good, choose(librarySize, n));
  return {
    value: toNumber(r),
    label: 'EXACT_PROBABILITY',
    note: `Seen ${n} cards by turn ${turn} (${onThePlay ? 'on the play' : 'on the draw'}); needs ${cmc} ${untappedOnly ? 'untapped ' : ''}lands with the colored sources of ${manaCost}. Ignores ramp and mulligans.`,
    exact: { num: r.num.toString(), den: r.den.toString() },
    model: 'lands-only, no mulligan',
  };
}
