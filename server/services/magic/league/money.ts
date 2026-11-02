// Integer-cent arithmetic for the league's weekly allowance. No floats cross this boundary.
export const WEEKLY_ALLOWANCE_CENTS = 1000;

export type PriceStatus = 'CONFIRMED' | 'ESTIMATE';

export interface PricedPrinting {
  readonly printingId: string;
  readonly cents: number | null;
  readonly status: PriceStatus;
}

/** Parse "9.99" / "$10" into cents. Anything that is not an exact dollar figure is refused. */
export function parseCents(text: string): number | null {
  const m = /^\$?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  return Number(m[1]) * 100 + Number(frac);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export type Eligibility =
  | { readonly ok: true; readonly totalCents: number }
  | { readonly ok: false; readonly reason: 'UNPRICED' | 'ESTIMATE_PRICE' | 'OVER_ALLOWANCE'; readonly detail: string; readonly totalCents: number | null };

/**
 * May this set of singles be approved for the week? Unknown prices and ESTIMATE prices
 * (a Scryfall figure is not a verified market price) are refused rather than assumed.
 * Exactly the allowance is allowed; one cent over is not.
 */
export function approveSingles(items: readonly PricedPrinting[], allowanceCents = WEEKLY_ALLOWANCE_CENTS): Eligibility {
  let total = 0;
  for (const it of items) {
    if (it.cents === null || !Number.isInteger(it.cents) || it.cents < 0) {
      return { ok: false, reason: 'UNPRICED', detail: `No price for printing ${it.printingId}.`, totalCents: null };
    }
    total += it.cents;
  }
  const est = items.find((i) => i.status !== 'CONFIRMED');
  if (est) {
    return { ok: false, reason: 'ESTIMATE_PRICE', detail: `Price for ${est.printingId} is an estimate, not a verified market price.`, totalCents: total };
  }
  if (total > allowanceCents) {
    return { ok: false, reason: 'OVER_ALLOWANCE', detail: `${formatCents(total)} exceeds ${formatCents(allowanceCents)}.`, totalCents: total };
  }
  return { ok: true, totalCents: total };
}
