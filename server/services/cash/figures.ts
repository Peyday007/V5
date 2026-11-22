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
  /**
   * The figure is stated per something — an hour, a word, a unit, `/mo`.
   *
   * Reported rather than refused: a rate is a real published figure, and only
   * the caller knows whether it wanted one. A card's price or exposure is a
   * total, and a rate read as a total is wrong by however many units there are.
   */
  perUnit: boolean;
  /**
   * The figure is one participant's share of something many buy together: a
   * slot, a spot, a seat, a placement, an ad on a shared piece (`$395 for a
   * slot`, `$250 per spot`). Always also `perUnit`. Never set for a figure
   * stated for a whole run, a campaign or a total.
   */
  perParticipant?: boolean;
  /**
   * The figure is a rate per a measured quantity of the work — a word, a page,
   * a character, a line, an hour, a minute (`$0.04 per word`, `$95/hr`). One
   * purchase is that rate times a quantity the figure itself does not state,
   * so it is never what one purchase costs. Always also `perUnit`.
   */
  perMeasure?: boolean;
  /**
   * The figure is the price of one billing period (`$200 a month`, `$90/mo`,
   * `$1,200 annually`) and of nothing smaller: a whole deal's price for one
   * period, which is what a recurring card's price is (planningReliability
   * round 8). Always also `perUnit`; never set when a further unit follows
   * (`$200 a month per site`).
   */
  perPeriod?: boolean;
}

/** A scale word after a figure, which this module refuses rather than applies. */
const SCALE_WORD = /^\s*(?:thousand|million|billion|trillion|bn|mn|mm|m|k)\b/i;

/** A figure stated as one billing period's price: `a month`, `/mo`, `annually` (and no further unit after it). */
const PER_PERIOD = /^\s*(?:\/\s*(?:mo|mth|month|yr|year|wk|week|qtr|quarter)\b|(?:a|per|each|every)\s+(?:month|year|quarter|week)\b|monthly\b|weekly\b|quarterly\b|annually\b|yearly\b)(?!\s*(?:\/|per\b|each\b|for\s+(?:each|every)\b))/i;

/** A figure stated per something: `per hour`, `an hour`, `/hr`, `a month`. */
const PER_UNIT = /^\s*(?:\/\s*[a-z]|per\b|an?\s+(?:hour|day|week|month|year|minute|word|page|unit|item|piece|seat|user|head)\b|each\b|hourly\b|monthly\b|weekly\b|daily\b|annually\b|yearly\b)/i;

/**
 * A figure stated as one participant's share of a shared purchase (F5,
 * 2026-11-18): `per slot`, `for a spot`, `for each seat`, `a participant`,
 * `per ad`, optionally with an ad word before the unit (`for an ad slot`).
 * "$395 for a slot" states a price per slot exactly as "$395 per slot" does,
 * and was refused as no per-unit figure. A run, a campaign or a mailing is
 * never a participant's unit, so a whole-run total never matches.
 */
const PER_PARTICIPANT = /^\s*(?:per|for\s+(?:a|an|one|each)|an?|each)\s+(?:(?:ad|advert|advertis(?:ing|ement)|advertiser|listing|postcard|mailer|shared)\s+)?(?:slot|spot|seat|participant|placement|ad|advertiser)s?\b(?!\s+(?:click|impression|view|lead|call|run|campaign|mailing))/i;

/**
 * A figure stated per a measured quantity of the work (production 2026-11-20,
 * WriterAccess: "$0.04 per word" and "$449 per month" answered one population's
 * price question and were read as one per-purchase price range). A billing
 * period (`a month`) or a purchased item (`per piece`) is not a measure.
 */
const PER_MEASURE = /^\s*(?:\/\s*|per\s+|an?\s+|each\s+|for\s+(?:each|every|one|a|an)\s+)(?:(?:\d[\d,]*|one|a|hundred|thousand)\s+)?(?:words?|characters?|chars?|pages?|lines?|hours?|hrs?|minutes?|mins?)\b|^\s*hourly\b/i;

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
    } else if (tail.length === 1 && !cleaned.slice(0, last).includes(cleaned[last]!)) {
      // One decimal is tenths: `$963.6` is $963.60, written as a number prints
      // it (planningReliability round 2, 2026-11-21). It was refused as a stray
      // decimal, so a card's direct cost of `$963.6` read as nobody having
      // established the cost, and a priced, costed opening failed ECONOMICS. A
      // separator of the same kind earlier (`1.2.3`) is still a version number.
      whole = cleaned.slice(0, last);
      minor = `${tail}0`;
    } else if (tail.length === 3 && /^0+$/.test(cleaned.slice(0, cleaned.search(/[.,]/)))) {
      // `$0.259` is a fraction of a cent, never 259 thousands-grouped: no
      // grouped number starts with a zero group. Production filed USPS's
      // "$0.259 per piece" as a $259 price (2026-11-18). Refused, not rounded.
      return null;
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
      // Shorthand is refused rather than expanded, and so is a spelled-out
      // scale: `$1,200 million` is not USD 1,200.
      if (/^[kKmMbB]/.test(after) && !/\s/.test(after)) continue;
      const rest = text.slice(match.index + match[0].length);
      if (SCALE_WORD.test(rest)) continue;
      // A space-grouped number (`$12 000`) would be returned truncated: refuse it.
      if (/^ \d{3}(?!\d)/.test(rest)) continue;
      // A symbol glued to a letter belongs to another currency: `C$`, `A$`,
      // `HK$` and `NT$` all end in `$`, and reading them as dollars is the
      // unknown read as the favourable assumption. `US$` is its own marker.
      const before = text.slice(Math.max(0, match.index - 1), match.index);
      if (/^\p{L}$/u.test(before) && !/^[A-Z]{3}$/i.test(match[0].trim().slice(0, 3))) continue;
      const cents = amountOf(raw);
      if (cents === null || seen.has(cents)) continue;
      seen.add(cents);
      const perParticipant = PER_PARTICIPANT.test(rest);
      const perMeasure = PER_MEASURE.test(rest);
      const perPeriod = !perParticipant && !perMeasure && PER_PERIOD.test(rest);
      found.push({ cents, currency: code, text: match[0].trim(), perUnit: perParticipant || perMeasure || perPeriod || PER_UNIT.test(rest), ...(perParticipant ? { perParticipant } : {}), ...(perMeasure ? { perMeasure } : {}), ...(perPeriod ? { perPeriod } : {}) });
    }
  }
  return found.sort((a, b) => a.cents - b.cents);
}

/**
 * Sub-cent rates `text` states per something (`$0.259 per piece`), in whole
 * currency units (0.259), smallest first.
 *
 * `readMoneyFigures` refuses `$0.259` because its minor units are integer cents
 * and a card's price is never a fraction of one; that refusal stays. A supply
 * rate is legitimately quoted in tenths of a cent (USPS EDDM postage), and only
 * the caller filing a per-unit cost asks for it here: the figure must be marked
 * with this currency, start with a zero whole part, carry three or four
 * decimals, and be stated per something — anything else is not read.
 */
export function readSubCentRates(text: string, currency: string): number[] {
  const code = currency.toUpperCase();
  const out = new Set<number>();
  for (const marker of [code, ...(SYMBOLS[code] ?? [])]) {
    const mark = escape(marker);
    const boundary = /^[A-Z]{3}$/.test(marker) ? '\\b' : '';
    for (const match of text.matchAll(new RegExp(`${boundary}${mark}${boundary}\\s?(0\\.\\d{3,4})(?![\\d.,]\\d)`, 'gi'))) {
      const before = text.slice(Math.max(0, match.index - 1), match.index);
      if (/^\p{L}$/u.test(before) && !/^[A-Z]{3}$/i.test(match[0].trim().slice(0, 3))) continue;
      if (!PER_UNIT.test(text.slice(match.index + match[0].length))) continue;
      const value = Number(match[1]);
      if (value > 0) out.add(value);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Format minor units the way the card does, so one figure reads one way. */
export function formatMoney(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A number of days a source states, or null.
 *
 * Deliberately narrow, and its failure mode is fixed at **missing** a duration
 * rather than inventing one — this file's own contract, at the other unit. It
 * reads a stated count of days, weeks or months and nothing else: no "a couple
 * of", no "next quarter", no arithmetic on a date. A payment term nobody
 * publishes stays unknown.
 */
export function readDays(text: string): number | null {
  const match = /(\d{1,4})(?:\s*[-–]\s*\d{1,4})?\s*(day|business day|week|month)s?\b/i.exec(
    text,
  );
  if (!match) return null;
  const count = Number.parseInt(match[1] as string, 10);
  if (!Number.isFinite(count) || count <= 0 || count > 3_650) return null;
  const unit = (match[2] as string).toLowerCase();
  if (unit === 'week') return count * 7;
  if (unit === 'month') return count * 30;
  return count;
}
