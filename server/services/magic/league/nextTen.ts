import { approveSingles, type PricedPrinting } from './money.ts';

export interface Swap { readonly add: string; readonly cut: string; readonly price: PricedPrinting; readonly gain: number }
export interface RankedSwap extends Swap { readonly gainPerDollar: number | null; readonly priceFlag: 'VERIFIED' | 'ESTIMATE' | 'UNPRICED'; readonly approvable: boolean; readonly reason: string }

export function rankSwaps(swaps: readonly Swap[], allowanceCents = 1000): RankedSwap[] {
  const out = swaps.map((s): RankedSwap => {
    const el = approveSingles([s.price], allowanceCents);
    const cents = s.price.cents;
    return {
      ...s,
      gainPerDollar: cents && cents > 0 ? (s.gain * 100) / cents : null,
      priceFlag: cents === null ? 'UNPRICED' : s.price.status === 'CONFIRMED' ? 'VERIFIED' : 'ESTIMATE',
      approvable: el.ok,
      reason: el.ok ? 'Within allowance at a verified price.' : el.detail,
    };
  });
  return out.sort((a, b) => (b.gainPerDollar ?? -1) - (a.gainPerDollar ?? -1) || a.add.localeCompare(b.add));
}
