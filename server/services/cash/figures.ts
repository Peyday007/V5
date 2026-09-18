/**
 * A money figure **read from a source**, never derived from one.
 *
 * `proposeTerms` may quote what a published request actually says it pays, and
 * may not produce a number from anything else. That is the whole of the rule
 * §30 records: a price derived from nothing is a guess with an explanation
 * attached, and the explanation is what makes it dangerous rather than what
 * makes it safe. So this module reads, and it is built so that its failure mode
 * is **missing a figure** rather than inventing one:
 *
 *   * A figure counts only when the text marks it with *this* currency — the
 *     ISO code on either side of it, or the symbol this currency actually uses.
 *     A bare `1,200` is not a price, because nothing in the sentence says what
 *     it is denominated in, and reading the sprint's currency into it would be
 *     the unknown-as-favourable-assumption invariant 39 forbids.
 *   * No `k`, `m` or `bn` shorthand. `1.2k` is 1,200 to a reader and 1.2 to a
 *     parser, and the two are not the same claim.
 *   * A percentage is not a price, whatever currency stands beside it.
 *   * Nothing here decides what a figure *means*. A published budget, a ceiling
 *     and a paid rate all read identically, and saying which is a judgement
 *     `proposeTerms` states as an assumption rather than one this resolves.
 */

/** The symbol each currency this Brain has met is written with. */
const SYMBOLS: Record<string, string[]> = {
  USD: ['$', 'US$'],
  EUR: ['€'],
  GBP: ['£'],
  CAD: ['C$', 'CA$'],
  AUD: ['A$', 'AU$'],
  NZD: ['NZ$'],
  JPY: ['¥'],
};

export interface MoneyFigure {
  /** The amount, in minor units of `currency`. */
  cents: number;
  currency: string;
  /** Exactly the text it was read from, so a reader can check it. */
  text: string;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse the digits of one match.
 *
 * A group of three digits after a separator is a thousands group; two digits
 * after a final `.` or `,` are minor units. `1.234,56` and `1,234.56` are the
 * same amount written by two conventions, and both are read.
 */
function amountOf(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '');
  if (!/^\d[\d.,]*$/.test(cleaned)) return null;

  const last = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
  let whole = cleaned;
  let minor = '00';
  if (last !== -1) {
    const tail = cleaned.slice(last + 1);
    if (tail.length === 2) {
      whole = cleaned.slice(0, last);
      minor = tail;
    } else if (tail.length !== 3) {
      // Neither a thousands group nor minor units. Two separators of different
      // kinds, a stray decimal, a version number: not a figure worth guessing.
      return null;
    }
  }
  const digits = whole.replace(/[.,]/g, '');
  if (digits.length === 0 || !/^\d+$/.test(digits)) return null;
  const cents = Number(digits) * 100 + Number(minor);
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Every figure in `text` that is marked as being in `currency`.
 *
 * Deduplicated by amount, in the order they appear, because the same figure
 * repeated in one paragraph is one figure — the duplicate-source rule §14
 * applies to a number quoted twice exactly as it applies to a press release
 * carried by three wires.
 */
export function readMoneyFigures(text: string, currency: string): MoneyFigure[] {
  const code = currency.toUpperCase();
  const markers = [code, ...(SYMBOLS[code] ?? [])];
  const number = '\\d[\\d.,]*\\d|\\d';
  const patterns = markers.flatMap((marker) => {
    const mark = escape(marker);
    // Symbols bind tight; a code needs a word boundary so `USDT` is not `USD`.
    const boundary = /^[A-Z]{3}$/.test(marker) ? '\\b' : '';
    return [
      new RegExp(`${boundary}${mark}${boundary}\\s?(${number})`, 'gi'),
      new RegExp(`(${number})\\s?${boundary}${mark}${boundary}`, 'gi'),
    ];
  });

  const found: MoneyFigure[] = [];
  const seen = new Set<number>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      if (raw === undefined) continue;
      // A percentage is not a price.
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 1);
      if (after === '%') continue;
      // Shorthand is refused rather than expanded.
      if (/^[kKmMbB]/.test(after) && !/\s/.test(after)) continue;
      const cents = amountOf(raw);
      if (cents === null || seen.has(cents)) continue;
      seen.add(cents);
      found.push({ cents, currency: code, text: match[0].trim() });
    }
  }
  return found.sort((a, b) => a.cents - b.cents);
}

/** Format minor units the way the card does, so one figure reads one way. */
export function formatMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
