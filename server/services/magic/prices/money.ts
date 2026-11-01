/**
 * USD in integer cents. A price is never a float: 9.99, 10.00 and 10.01 must
 * land on three different integers, and anything that is not a plain decimal
 * amount is refused rather than coerced.
 */
export const WEEKLY_ALLOWANCE_CENTS = 1000;

/** "9.99", "$10", "10.00" -> cents; null when not an exact USD amount. */
export function parseUsdToCents(input: string | number): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) return null;
    const c = Math.round(input * 100);
    return Math.abs(c / 100 - input) < 1e-9 ? c : null;
  }
  const m = /^\s*\$?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  return Number(m[1]) * 100 + Number(frac);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
