/**
 * What the operator wants, read from their own words (§92).
 *
 * The reading is by matching, never by a model deciding what somebody meant —
 * the discipline `operatingModel.ts` and `cash/exclusions.ts` keep. Each thing
 * read is recorded as a requirement with its kind:
 *
 *   * HARD — the operator cannot do otherwise (money they do not have; the
 *     standing rule that the owner does no physical work);
 *   * PREFERENCE — what they would like (speed, scale, control, a sequence).
 *
 * A preference is never treated as an absolute requirement. Where two pull
 * against each other — quick cash against a capital-heavy durable company —
 * the conflict is named with the way it can be reconciled (in sequence, in
 * parallel, or by a different operating structure), and the strategy search is
 * what decides whether it actually can be.
 *
 * Overrides are how a person replans: a changed capital range, urgency, risk
 * tolerance, desired control or ambition replaces what the words said, and the
 * whole construction is derived again from it.
 */
import { CONTROL_TARGETS, type ControlTarget } from '../../../domain/construction.ts';

export type Urgency = 'IMMEDIATE' | 'SOON' | 'PATIENT';
export type RiskTolerance = 'LOW' | 'MEDIUM' | 'HIGH';
export type CapitalAppetite = 'LIGHT' | 'HEAVY';
export type SequenceStep = 'BROKER' | 'SUBCONTRACT' | 'FULFILMENT' | 'ASSETS' | 'RECRUIT' | 'COORDINATE';

export interface IntentRequirement {
  id: string;
  statement: string;
  kind: 'HARD' | 'PREFERENCE';
  from: 'OPERATOR' | 'STANDING_RULE' | 'OVERRIDE';
}

export interface IntentConflict {
  between: [string, string];
  why: string;
  reconcile: 'SEQUENCE' | 'PARALLEL' | 'STRUCTURE';
}

export interface OperatorIntent {
  text: string;
  /** The industry phrase as the operator wrote it, e.g. "last-mile logistics". */
  industry: string | null;
  geography: string | null;
  /** Dollars. Null when the words name no amount. */
  capital: { low: number; high: number } | null;
  urgency: Urgency | null;
  /** The day by which the first collected dollar is wanted, derived from urgency. */
  firstCashWithinDays: number | null;
  durable: boolean;
  scale: 'LARGE' | 'MODEST' | null;
  control: ControlTarget[];
  riskTolerance: RiskTolerance | null;
  capitalAppetite: CapitalAppetite | null;
  sequence: SequenceStep[];
  /** What the operator says they already have. */
  assets: string[];
  /** The operator said, in their own words, that they will not do the physical work. */
  statedNoPhysicalWork: boolean;
  requirements: IntentRequirement[];
  conflicts: IntentConflict[];
}

export interface IntentOverrides {
  capital?: { low: number; high: number };
  urgency?: Urgency;
  riskTolerance?: RiskTolerance;
  control?: ControlTarget[];
  scale?: 'LARGE' | 'MODEST';
  capitalAppetite?: CapitalAppetite;
  durable?: boolean;
  industry?: string;
  geography?: string;
}

const URGENCY_DAYS: Record<Urgency, number> = { IMMEDIATE: 30, SOON: 90, PATIENT: 365 };

function amount(raw: string, suffix: string | undefined): number {
  const n = Number(raw.replace(/,/g, ''));
  const s = (suffix ?? '').toLowerCase();
  if (s === 'k' || s === 'thousand') return n * 1_000;
  if (s === 'm' || s === 'million' || s === 'mm') return n * 1_000_000;
  return n;
}

const MONEY = String.raw`\$?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|mm|thousand|million)?\b`;

/** Every amount of money the words name, ranges kept together. */
export function readCapital(text: string): { low: number; high: number } | null {
  const range = new RegExp(`${MONEY}\\s*(?:-|–|—|to|and)\\s*${MONEY}(?:\\s*(?:dollars|usd))?`, 'i');
  const r = range.exec(text);
  const moneyish = (m: RegExpExecArray, a: number) =>
    /\$/.test(m[0]) || /\b(k|m|thousand|million)\b/i.test(m[0]) || /dollars|usd/i.test(text.slice(m.index, m.index + m[0].length + 9)) || a >= 1_000;
  if (r) {
    // "10k-30k" or "$10,000-$30,000": a suffix on the second side applies to a bare first side.
    const hi = amount(r[3]!, r[4]);
    const lo = amount(r[1]!, r[2] ?? r[4]);
    if (moneyish(r, hi) && hi > 0) return { low: Math.min(lo, hi), high: Math.max(lo, hi) };
  }
  const single = new RegExp(MONEY, 'gi');
  for (let m = single.exec(text); m; m = single.exec(text)) {
    const a = amount(m[1]!, m[2]);
    const near = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20);
    if (moneyish(m, a) && /\$|have|available|capital|budget|invest|dollars|usd|save|savings/i.test(near) && a >= 100) return { low: a, high: a };
  }
  return null;
}

/** The industry phrase: what follows "enter", "start", "get into", "build a … company". */
export function readIndustry(text: string): string | null {
  const m =
    /\b(?:enter|entering|get into|getting into|break into|start in|go into|start an?|build an?|launch an?)\s+(?:the\s+)?([a-z][a-z\- ]{2,60}?)(?=\s+(?:in|around|across|near|business|company|industry|market|space|sector|and|with|,|\.|$)|[,.]|$)/i.exec(text);
  if (!m) return null;
  const phrase = m[1]!.trim().replace(/\s+(?:business|company|industry|market|space|sector)$/i, '');
  if (/^(?:revenue|cash|money|capital|significant|large|durable)/i.test(phrase)) return null;
  return phrase || null;
}

export function readGeography(text: string): string | null {
  const m = /\bin\s+((?:Metro\s+|Greater\s+|Downtown\s+)?[A-Z][A-Za-z.]+(?:[\s-][A-Z][A-Za-z.]+){0,3})/.exec(text);
  return m ? m[1]!.trim().replace(/\.+$/, '') : null;
}

function has(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

/* --------------------------------------------------------------------------
 * An objective, read from a person's words (G-2).
 *
 * "Generate $10,000 within 30 days using at most $3,000 in starting capital"
 * is four numbers: the amount to bring in, the currency, the deadline and the
 * money the plan may tie up. The reader tells them apart by the words around
 * each figure — a figure after "generate", "make", "earn" or before "in
 * revenue" is the amount; a figure inside "at most … of capital", "a … budget",
 * "I have …" or "with …" is capital — and never by position or size. Whatever
 * it cannot place is left null and named in `unread`, because a guessed target
 * is a target nobody set.
 * ------------------------------------------------------------------------ */

export interface ObjectiveReading {
  text: string;
  /** CASH when the words name an amount of money to bring in; everything else is OTHER. */
  kind: 'CASH' | 'OTHER';
  /** The figure a cash objective is measured by: settled cash, or contribution when the words say profit. */
  metric: 'SETTLED_CASH' | 'CONTRIBUTION' | null;
  /** Major units (dollars), or null. */
  amount: number | null;
  currency: string | null;
  /** ISO-8601 UTC, or null when the words name none it can read. */
  deadline: string | null;
  deadlineHours: number | null;
  /** Major units: the most the plan may tie up. */
  capitalCeiling: number | null;
  hoursCeiling: number | null;
  /** Major units: the most tied up before the first customer payment. */
  beforeProof: number | null;
  /** Major units: the most newly tied up in any week. */
  capitalPerWeek: number | null;
  /** The constraint phrases, verbatim. */
  constraints: string[];
  /** Phrases the reader saw and could not interpret, and required fields it could not find. */
  unread: string[];
}

type TokenRole = 'AMOUNT' | 'CAPITAL' | 'BEFORE_PROOF' | 'PER_WEEK' | 'RANGE' | 'DEADLINE';

interface MoneyToken {
  start: number;
  end: number;
  raw: string;
  value: number;
  currency: string | null;
  /** Carries a currency or a magnitude suffix, so it reads as money rather than a count. */
  marked: boolean;
  role: TokenRole | null;
}

const CURRENCY_OF: Record<string, string> = {
  $: 'USD', us$: 'USD', usd: 'USD', dollar: 'USD', dollars: 'USD', bucks: 'USD',
  '€': 'EUR', eur: 'EUR', euro: 'EUR', euros: 'EUR',
  '£': 'GBP', gbp: 'GBP', pound: 'GBP', pounds: 'GBP',
};
const MAGNITUDE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, bn: 1e9, billion: 1e9 };

const NUMBER_SRC = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const SUFFIX_SRC = String.raw`(?:k|m|mm|bn|thousand|million|billion)\b`;
const CODE_SRC = String.raw`(?:usd|eur|gbp|dollars?|euros?|pounds?|bucks)\b`;
/** One figure with whatever marks it as money, for embedding in a phrase. */
const MP = String.raw`(?:US\$|\$|€|£|USD\s?|EUR\s?|GBP\s?)?\s?${NUMBER_SRC}(?:\s?${SUFFIX_SRC})?(?:\s?${CODE_SRC})?`;
const LIMIT = String.raw`(?:at most|no more than|not more than|up to|under|less than|below|a maximum of|maximum of|max(?:imum)?|only|just|about|around|roughly)`;
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, eighteen: 18, twenty: 20, thirty: 30, forty: 40,
  'forty-five': 45, fifty: 50, sixty: 60, ninety: 90,
};
const NUMBER_WORD_SRC = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function moneyTokens(text: string): MoneyToken[] {
  const re = new RegExp(
    String.raw`(?<![\w.])(?:(US\$|\$|€|£|USD|EUR|GBP)\s?)?(${NUMBER_SRC})(?:\s?(${SUFFIX_SRC.replace(/\\b$/, '')})\b)?(?:\s?(${CODE_SRC.replace(/\\b$/, '')})\b)?`,
    'gi',
  );
  const out: MoneyToken[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [raw, symbol, digits, suffix, code] = m;
    const base = Number(digits!.replace(/,/g, ''));
    const value = suffix ? base * (MAGNITUDE[suffix.toLowerCase()] ?? 1) : base;
    const currency = symbol ? CURRENCY_OF[symbol.toLowerCase()] ?? null : code ? CURRENCY_OF[code.toLowerCase()] ?? null : null;
    out.push({ start: m.index, end: m.index + raw!.length, raw: raw!.trim(), value, currency, marked: Boolean(symbol || suffix || code), role: null });
  }
  return out;
}

interface Span {
  start: number;
  end: number;
  text: string;
}

function overlaps(a: { start: number; end: number }, spans: readonly { start: number; end: number }[]): boolean {
  return spans.some((s) => a.start < s.end && s.start < a.end);
}

function addCalendar(now: Date, unit: 'month' | 'year', n: number): Date {
  const d = new Date(now.getTime());
  if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return d;
}

function endOfDay(year: number, monthIndex: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, monthIndex, day, 23, 59, 59));
  return d.getUTCMonth() === monthIndex && d.getUTCDate() === day ? d : null;
}

interface ObjectiveDetail {
  reading: ObjectiveReading;
  amountSpan: { start: number; end: number } | null;
}

function readObjectiveDetail(input: string, now: Date): ObjectiveDetail {
  const text = input.replace(/\s+/g, ' ').trim();
  const tokens = moneyTokens(text);
  const unread: string[] = [];
  const constraintSpans: Span[] = [];
  const consumed: Span[] = [];
  const tokensIn = (s: { start: number; end: number }) => tokens.filter((t) => t.role === null && t.start >= s.start && t.end <= s.end);

  // 1. The deadline. The first phrase that names one decides it; a second is named, never merged.
  let deadline: Date | null = null;
  const deadlineSeen = (start: number, end: number, at: Date | null, phrase: string) => {
    consumed.push({ start, end, text: phrase });
    for (const t of tokensIn({ start, end })) t.role = 'DEADLINE';
    if (!at) return unread.push(`"${phrase}": a deadline the reader could not place`);
    if (deadline) return unread.push(`"${phrase}": a second deadline`);
    if (at.getTime() <= now.getTime()) return unread.push(`"${phrase}": a deadline already past`);
    deadline = at;
  };
  const relative = new RegExp(String.raw`\b(?:in|within|inside(?:\s+of)?|over|during)\s+(?:the\s+)?(?:next\s+|coming\s+|first\s+)?(\d+(?:\.\d+)?|${NUMBER_WORD_SRC})\s+(hours?|hrs?|days?|weeks?|months?|years?)\b`, 'gi');
  for (const m of text.matchAll(relative)) {
    const n = /^\d/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!.toLowerCase()]!;
    const unit = m[2]!.toLowerCase().replace(/s$/, '');
    let at: Date | null = null;
    if (unit === 'hour' || unit === 'hr') at = new Date(now.getTime() + n * 3_600_000);
    else if (unit === 'day') at = new Date(now.getTime() + n * 86_400_000);
    else if (unit === 'week') at = new Date(now.getTime() + n * 7 * 86_400_000);
    else if (Number.isInteger(n)) at = addCalendar(now, unit as 'month' | 'year', n);
    deadlineSeen(m.index!, m.index! + m[0].length, at, m[0]);
  }
  for (const m of text.matchAll(/\bby\s+(\d{4})-(\d{2})-(\d{2})\b/gi)) {
    deadlineSeen(m.index!, m.index! + m[0].length, endOfDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])), m[0]);
  }
  for (const m of text.matchAll(/\bby\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/gi)) {
    deadlineSeen(m.index!, m.index! + m[0].length, endOfDay(Number(m[3]), Number(m[1]) - 1, Number(m[2])), m[0]);
  }
  for (const m of text.matchAll(/\bby\s+(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)?(year|month)\b/gi)) {
    const y = now.getUTCFullYear();
    const at = m[1]!.toLowerCase() === 'year' ? endOfDay(y, 11, 31) : new Date(Date.UTC(y, now.getUTCMonth() + 1, 0, 23, 59, 59));
    deadlineSeen(m.index!, m.index! + m[0].length, at, m[0]);
  }
  const monthDay = /\bby\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi;
  for (const m of text.matchAll(monthDay)) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    const day = Number(m[2]);
    let at = endOfDay(m[3] ? Number(m[3]) : now.getUTCFullYear(), month, day);
    // "by March 3" with no year is the next March 3; a stated year is never moved.
    if (at && !m[3] && at.getTime() <= now.getTime()) at = endOfDay(now.getUTCFullYear() + 1, month, day);
    deadlineSeen(m.index!, m.index! + m[0].length, at, m[0]);
  }
  for (const m of text.matchAll(/\bby\s+(?:tomorrow|tonight|next\s+\w+|this\s+\w+|(?:mon|tues|wednes|thurs|fri|satur|sun)day|the\s+end\s+of\s+(?:the\s+|this\s+|next\s+)?(?:week|quarter|summer|winter|spring|fall))\b/gi)) {
    if (!overlaps({ start: m.index!, end: m.index! + m[0].length }, consumed)) deadlineSeen(m.index!, m.index! + m[0].length, null, m[0]);
  }
  if (!deadline) {
    for (const m of text.matchAll(/\b(asap|as soon as possible|quickly|fast|soon|right away|immediately)\b/gi)) unread.push(`"${m[0]}": not a deadline`);
  }

  // 2. Ranges: "$10,000-$30,000" is neither an amount nor a ceiling the reader may pick a side of.
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    if (a.role || b.role) continue;
    if (/^\s*(?:-|–|—|to)\s*$/i.test(text.slice(a.end, b.start)) && (a.marked || b.marked)) {
      a.role = 'RANGE';
      b.role = 'RANGE';
      unread.push(`"${text.slice(a.start, b.end)}": a range, not one figure`);
    }
  }

  // 3. Hours a person will put in. A rate ("10 hours a week") is kept as a constraint, never multiplied out.
  let hoursCeiling: number | null = null;
  const hourPatterns = [
    new RegExp(String.raw`(?:\b${LIMIT}\s+)?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s+of\s+(?:(?:my|our|own|total)\s+)*(?:time|work|effort|labou?r)\b(?!\s+(?:per|a|each|every)\s+(?:day|week|month))`, 'gi'),
    new RegExp(String.raw`\b(?:at most|no more than|not more than|up to|only|a maximum of|max(?:imum)?)\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b(?!\s+(?:of\s+\w+\s+)?(?:per|a|each|every)\s+(?:day|week|month))`, 'gi'),
  ];
  for (const re of hourPatterns) {
    for (const m of text.matchAll(re)) {
      const span = { start: m.index!, end: m.index! + m[0].length, text: m[0] };
      if (overlaps(span, consumed)) continue;
      consumed.push(span);
      constraintSpans.push(span);
      for (const t of tokensIn(span)) t.role = 'DEADLINE';
      if (hoursCeiling === null) hoursCeiling = Number(m[1]);
      else unread.push(`"${m[0]}": a second hours limit`);
    }
  }
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s+(?:of\s+\w+\s+)?(?:per|a|each|every)\s+(?:day|week|month)\b/gi)) {
    const span = { start: m.index!, end: m.index! + m[0].length, text: m[0] };
    if (overlaps(span, consumed)) continue;
    consumed.push(span);
    constraintSpans.push(span);
    for (const t of tokensIn(span)) t.role = 'DEADLINE';
    unread.push(`"${m[0]}": an hours rate, not a total`);
  }

  // 4. Money the plan may use: before proof, per week, then the overall ceiling.
  const spend = String.raw`(?:spend|spending|invest|investing|risk|risking|tie up|tying up|commit|committing|put in|putting in)`;
  const moneyPhrases: { role: TokenRole; re: RegExp }[] = [
    { role: 'BEFORE_PROOF', re: new RegExp(String.raw`(?:\b(?:${spend}|using|use|with)\s+)?(?:${LIMIT}\s+)?${MP}\s+(?:(?:of\s+)?(?:capital|cash|money)\s+)?before\s+(?:the\s+)?(?:first|any|a)\s+(?:sale|payment|customer|dollar|revenue|proof|order)s?\b`, 'gi') },
    { role: 'PER_WEEK', re: new RegExp(String.raw`\b${spend}\s+(?:${LIMIT}\s+)?${MP}\s+(?:(?:of\s+)?(?:capital|cash|money)\s+)?(?:per|a|each|every)\s+week\b`, 'gi') },
    { role: 'PER_WEEK', re: new RegExp(String.raw`(?:${LIMIT}\s+)?${MP}\s+(?:of\s+)?(?:capital|budget)\s+(?:per|a|each|every)\s+week\b`, 'gi') },
    { role: 'CAPITAL', re: new RegExp(String.raw`(?:\b(?:using|use|with|${spend}|on|from)\s+)?(?:${LIMIT}\s+)?(?:an?\s+)?${MP}\s+(?:(?:of|in|as|for)\s+)?(?:(?:my|our|own|the|total|starting|start-up|startup|seed|initial|upfront|up-front|working)\s+)*(?:capital|budget|investment|funding|funds|cash to (?:invest|spend)|money to (?:invest|spend))\b`, 'gi') },
    { role: 'CAPITAL', re: new RegExp(String.raw`\b(?:budget|capital|investment|funding|bankroll)\s+(?:(?:of|is|is only|at)\s+)?(?:${LIMIT}\s+)?${MP}`, 'gi') },
    { role: 'CAPITAL', re: new RegExp(String.raw`\b${spend}\s+(?:${LIMIT}\s+)?${MP}`, 'gi') },
    { role: 'CAPITAL', re: new RegExp(String.raw`\b(?:I|we)\s+(?:only\s+)?(?:have|has|got|own|can (?:spend|invest|put in|afford))\s+(?:${LIMIT}\s+)?${MP}`, 'gi') },
    { role: 'CAPITAL', re: new RegExp(String.raw`\bwith\s+(?:${LIMIT}\s+)?(?:an?\s+)?${MP}(?!\s*(?:in|of)\s+(?:revenue|sales|profit|income))`, 'gi') },
  ];
  const figures: Record<'CAPITAL' | 'BEFORE_PROOF' | 'PER_WEEK', MoneyToken[]> = { CAPITAL: [], BEFORE_PROOF: [], PER_WEEK: [] };
  for (const { role, re } of moneyPhrases) {
    for (const m of text.matchAll(re)) {
      const span = { start: m.index!, end: m.index! + m[0].length, text: m[0].trim() };
      // A bare count ("with 3 helpers") is money only where the phrase itself says capital or budget.
      const explicit = /\b(?:capital|budget|investment|funding|funds|bankroll)\b/i.test(m[0]);
      const inside = tokensIn(span).filter((t) => t.marked || explicit);
      if (inside.length === 0) continue;
      for (const t of inside) t.role = role;
      figures[role as 'CAPITAL'].push(...inside);
      if (!overlaps(span, constraintSpans)) constraintSpans.push(span);
    }
  }
  const single = (list: MoneyToken[], label: string): number | null => {
    for (const extra of list.slice(1)) unread.push(`"${extra.raw}": a second ${label}`);
    return list[0]?.value ?? null;
  };

  // 5. The amount: a figure the words say is to be brought in.
  const verbBefore = /\b(?:generate|generating|make|making|earn|earning|collect|collecting|net|netting|bring in|bringing in|clear|clearing|gross|grossing|produce|producing|reach|reaching|hit|get to|book|bank|pull in|realize|realise|profit|create)\s+(?:(?:at least|over|more than|about|around|roughly|approximately|an? (?:extra|additional)|another|a minimum of|minimum of|a total of)\s+)*$/i;
  const nounAfter = /^\s*(?:(?:in|of)\s+)?(?:(?:settled|collected|net|gross|new|recurring|monthly|total)\s+)*(?:revenue|sales|profit|income|cash flow|cash|payments)\b/i;
  let amountToken: MoneyToken | null = null;
  for (const t of tokens) {
    if (t.role !== null || !t.marked) continue;
    const before = text.slice(Math.max(0, t.start - 60), t.start);
    const after = text.slice(t.end);
    const beforeDeadline = consumed.some((s) => s.start >= t.end && /^\s*$/.test(text.slice(t.end, s.start)) && /^(?:in|within|inside|over|during|by)\b/i.test(s.text));
    if (!(verbBefore.test(before) || nounAfter.test(after) || beforeDeadline)) {
      unread.push(`"${t.raw}": a figure the reader could not place`);
      continue;
    }
    if (/^\s*(?:(?:in|of)\s+\w+\s+)?(?:per|a|each|every)\s+(?:day|week|month|year)\b/i.test(after)) {
      unread.push(`"${t.raw}${after.match(/^\s*(?:(?:in|of)\s+\w+\s+)?(?:per|a|each|every)\s+(?:day|week|month|year)/i)![0]}": a rate, not a total`);
      continue;
    }
    if (amountToken) {
      unread.push(`"${t.raw}": a second amount`);
      continue;
    }
    t.role = 'AMOUNT';
    amountToken = t;
  }

  // 6. Other constraints, verbatim: what the person said must or must not happen.
  for (const m of text.matchAll(/\b(?:without|never|must not|must|do not|don't|cannot|can't|no physical|not (?:personally|myself)|only (?:using|use|through|with|via|in))\b[^.;,]*/gi)) {
    const span = { start: m.index!, end: m.index! + m[0].length, text: m[0].trim() };
    if (!overlaps(span, constraintSpans)) constraintSpans.push(span);
  }

  const kind = amountToken ? 'CASH' : 'OTHER';
  const currency = amountToken?.currency ?? null;
  if (kind === 'CASH') {
    if (!currency) unread.push(`currency: "${amountToken!.raw}" names no currency`);
    if (!deadline) unread.push('deadline: none stated');
  }
  const at = deadline as Date | null;
  return {
    reading: {
      text,
      kind,
      metric: kind === 'CASH' ? (/\b(?:profit|net|netting|contribution)\b/i.test(text) ? 'CONTRIBUTION' : 'SETTLED_CASH') : null,
      amount: amountToken?.value ?? null,
      currency,
      deadline: at ? at.toISOString() : null,
      deadlineHours: at ? Math.round((at.getTime() - now.getTime()) / 3_600_000) : null,
      capitalCeiling: single(figures.CAPITAL, 'capital limit'),
      hoursCeiling,
      beforeProof: single(figures.BEFORE_PROOF, 'before-proof limit'),
      capitalPerWeek: single(figures.PER_WEEK, 'per-week limit'),
      constraints: constraintSpans.sort((a, b) => a.start - b.start).map((s) => s.text),
      unread,
    },
    amountSpan: amountToken ? { start: amountToken.start, end: amountToken.end } : null,
  };
}

/**
 * Read an objective from a person's words. Pure: `now` anchors "in 30 days".
 * Nothing is guessed — a field the words do not state is null, and a phrase the
 * reader saw and could not interpret is named in `unread`.
 */
export function readObjective(text: string, now: Date = new Date()): ObjectiveReading {
  return readObjectiveDetail(text, now).reading;
}

/**
 * The operator's capital, read by the same reader as an objective: a stated
 * ceiling wins, and otherwise the figure an objective names as its *amount* is
 * blanked out before the older capital reading runs, so "make $10,000" is never
 * read as $10,000 to spend.
 */
function capitalFromWords(text: string, objective: ObjectiveDetail): { low: number; high: number } | null {
  const ceiling = objective.reading.capitalCeiling;
  if (ceiling !== null) return { low: ceiling, high: ceiling };
  const span = objective.amountSpan;
  const rest = span ? `${text.slice(0, span.start)}${' '.repeat(span.end - span.start)}${text.slice(span.end)}` : text;
  return readCapital(rest);
}

/** Read the operator's words, then apply a person's overrides. Pure. */
export function interpretIntent(text: string, overrides: IntentOverrides = {}): OperatorIntent {
  const t = text.replace(/\s+/g, ' ').trim();
  const requirements: IntentRequirement[] = [];
  const conflicts: IntentConflict[] = [];

  const industry = overrides.industry ?? readIndustry(t);
  const geography = overrides.geography ?? readGeography(t);
  const objective = readObjectiveDetail(t, new Date());
  const capital = overrides.capital ?? capitalFromWords(t, objective);

  let urgency: Urgency | null = null;
  if (has(t, /\b(immediate(?:ly)?|right away|this (?:week|month)|asap|quick(?:ly)?|fast|rapid(?:ly)?|soon as possible|generating revenue quickly|cash flow now)\b/i)) urgency = 'IMMEDIATE';
  else if (has(t, /\b(soon|within (?:a|one|two|three|\d+) (?:month|months|quarter))\b/i)) urgency = 'SOON';
  else if (has(t, /\b(no rush|patient|long[- ]term only|over (?:several|many) years)\b/i)) urgency = 'PATIENT';
  // A stated deadline is an urgency the words gave in days, not a mood to infer from.
  const deadlineDays = objective.reading.deadlineHours !== null ? Math.max(1, Math.ceil(objective.reading.deadlineHours / 24)) : null;
  if (!urgency && deadlineDays !== null) urgency = deadlineDays <= URGENCY_DAYS.IMMEDIATE ? 'IMMEDIATE' : deadlineDays <= URGENCY_DAYS.SOON ? 'SOON' : 'PATIENT';
  if (overrides.urgency) urgency = overrides.urgency;

  const durable = overrides.durable ?? has(t, /\b(eventually|durable|enterprise|significant|large|big|major|long[- ]term|build toward|empire|scale)\b/i);
  let scale: 'LARGE' | 'MODEST' | null = has(t, /\b(large|significant|big|major|durable enterprise|empire|national)\b/i) ? 'LARGE' : has(t, /\b(small|side|lifestyle|modest)\b/i) ? 'MODEST' : null;
  if (overrides.scale) scale = overrides.scale;

  const control = new Set<ControlTarget>();
  if (has(t, /\b(bottleneck|chokepoint|valuable parts|control (?:over|of) (?:valuable|key|the)|own the valuable)\b/i)) control.add('CHOKEPOINTS');
  if (has(t, /\bcontrol(?:ling)? (?:the )?fulfil+ment|own (?:the )?fulfil+ment|operate (?:our|my) own\b/i)) control.add('FULFILMENT');
  if (has(t, /\b(own|control)\w* (?:the )?(?:customers?|demand|accounts|relationships)\b/i)) control.add('DEMAND');
  if (has(t, /\b(own|control)\w* (?:the )?(?:supply|capacity|drivers|network)\b/i)) control.add('SUPPLY');
  if (has(t, /\bcapital[- ]heavy|own (?:the )?(?:assets|fleet|equipment|trucks|vans|warehouses?)\b/i)) control.add('ASSETS');
  if (has(t, /\bcontracts?\b/i) && has(t, /\b(control|own|hold)\b/i)) control.add('CONTRACTS');
  if (control.size === 0 && has(t, /\bcontrol\b/i)) control.add('CHOKEPOINTS');
  const controlList = overrides.control ? [...new Set(overrides.control.filter((c) => (CONTROL_TARGETS as readonly string[]).includes(c)))] : [...control];

  let capitalAppetite: CapitalAppetite | null = has(t, /\bcapital[- ]heavy|asset[- ]heavy|own the (?:assets|fleet)\b/i) ? 'HEAVY' : has(t, /\b(capital[- ]light|asset[- ]light|lean|without (?:much|big) (?:capital|investment))\b/i) ? 'LIGHT' : null;
  if (overrides.capitalAppetite) capitalAppetite = overrides.capitalAppetite;

  let riskTolerance: RiskTolerance | null = has(t, /\b(low risk|safe|can'?t afford to lose|conservative|minimi[sz]e risk)\b/i) ? 'LOW' : has(t, /\b(aggressive|high risk|bet big|all in)\b/i) ? 'HIGH' : null;
  if (overrides.riskTolerance) riskTolerance = overrides.riskTolerance;

  const sequence: SequenceStep[] = [];
  const seq = /\b(?:begin|start)\w* (?:with|by|as) ([^.;]+?),? (?:then|and then|before|later|gradually|eventually)\b([^.;]*)/i.exec(t);
  if (seq) {
    const step = (s: string): SequenceStep | null =>
      /broker/i.test(s) ? 'BROKER' : /subcontract/i.test(s) ? 'SUBCONTRACT' : /recruit/i.test(s) ? 'RECRUIT' : /coordinat|dispatch/i.test(s) ? 'COORDINATE' : /fulfil+ment|operat|deliver/i.test(s) ? 'FULFILMENT' : /asset|fleet|own/i.test(s) ? 'ASSETS' : null;
    for (const part of [seq[1]!, seq[2]!]) {
      const s = step(part);
      if (s && !sequence.includes(s)) sequence.push(s);
    }
  }

  const assets: string[] = [];
  for (const m of t.matchAll(/\bI (?:have|own|already have) (?:an? |two |three |\d+ )?((?!\$|\d)[a-z][a-z \-]{2,40}?)(?=[,.;]| and | but |$)/gi)) {
    const a = m[1]!.trim();
    if (!/\b(dollars|money|capital|budget)\b/i.test(a)) assets.push(a);
  }

  const statedNoPhysicalWork = has(t, /\bwithout (?:me )?personally\b|\bnot (?:personally|myself)\b|\bI (?:don'?t|do not|won'?t|will not) (?:want to )?(?:drive|deliver|do (?:the )?(?:physical|deliveries|work))|\bno physical work\b|\bwithout (?:making|doing) (?:the )?deliveries\b/i);

  // The requirements, each with its kind.
  if (capital) {
    requirements.push({
      id: 'capital',
      statement: capital.low === capital.high ? `At most $${capital.high.toLocaleString('en-US')} of the operator's money is committed.` : `Between $${capital.low.toLocaleString('en-US')} and $${capital.high.toLocaleString('en-US')} is available; only the lower figure is certain, and nothing above the upper is committed.`,
      kind: 'HARD',
      from: overrides.capital ? 'OVERRIDE' : 'OPERATOR',
    });
  }
  requirements.push({
    id: 'no_physical_work',
    statement: statedNoPhysicalWork
      ? 'The operator does no physical work (stated, and Brain’s standing rule): independent operators or employees managed by a hired manager do it.'
      : 'Brain’s standing rule: the owner does no physical work; independent operators or employees managed by a hired manager do it.',
    kind: 'HARD',
    from: statedNoPhysicalWork ? 'OPERATOR' : 'STANDING_RULE',
  });
  const firstCashWithinDays = overrides.urgency ? URGENCY_DAYS[overrides.urgency] : deadlineDays ?? (urgency ? URGENCY_DAYS[urgency] : null);
  if (urgency) requirements.push({ id: 'urgency', statement: `First collected cash within about ${firstCashWithinDays ?? URGENCY_DAYS[urgency]} days.`, kind: 'PREFERENCE', from: overrides.urgency ? 'OVERRIDE' : 'OPERATOR' });
  if (durable || scale === 'LARGE') requirements.push({ id: 'durable', statement: 'Build toward a significant, durable company rather than a one-off income.', kind: 'PREFERENCE', from: overrides.durable !== undefined || overrides.scale ? 'OVERRIDE' : 'OPERATOR' });
  if (controlList.length) requirements.push({ id: 'control', statement: `Control over: ${controlList.join(', ').toLowerCase()}.`, kind: 'PREFERENCE', from: overrides.control ? 'OVERRIDE' : 'OPERATOR' });
  if (capitalAppetite) requirements.push({ id: 'capital_appetite', statement: capitalAppetite === 'HEAVY' ? 'Willing to own capital-heavy assets.' : 'Prefers to stay capital-light.', kind: 'PREFERENCE', from: overrides.capitalAppetite ? 'OVERRIDE' : 'OPERATOR' });
  if (riskTolerance) requirements.push({ id: 'risk', statement: `Risk tolerance ${riskTolerance.toLowerCase()}.`, kind: 'PREFERENCE', from: overrides.riskTolerance ? 'OVERRIDE' : 'OPERATOR' });
  if (sequence.length) requirements.push({ id: 'sequence', statement: `Preferred order: ${sequence.join(' → ').toLowerCase()}.`, kind: 'PREFERENCE', from: 'OPERATOR' });

  // Conflicts, and how each could be reconciled.
  const has_ = (id: string) => requirements.some((r) => r.id === id);
  if (urgency === 'IMMEDIATE' && (has_('durable') || controlList.length > 0)) {
    conflicts.push({ between: ['urgency', has_('durable') ? 'durable' : 'control'], why: 'the business that collects cash fastest is rarely the one that holds valuable control', reconcile: 'SEQUENCE' });
  }
  if (capitalAppetite === 'HEAVY' && capital && capital.high < 100_000) {
    conflicts.push({ between: ['capital_appetite', 'capital'], why: `owning heavy assets on $${capital.high.toLocaleString('en-US')} leaves little for working capital and reserves`, reconcile: 'STRUCTURE' });
  }
  if (capitalAppetite === 'HEAVY' && urgency === 'IMMEDIATE') {
    conflicts.push({ between: ['capital_appetite', 'urgency'], why: 'acquiring and insuring assets delays the first collected dollar', reconcile: 'PARALLEL' });
  }
  if (riskTolerance === 'LOW' && controlList.includes('ASSETS')) {
    conflicts.push({ between: ['risk', 'control'], why: 'owned assets put the operator’s money at risk before buyers commit', reconcile: 'SEQUENCE' });
  }

  return {
    text: t,
    industry,
    geography,
    capital,
    urgency,
    firstCashWithinDays,
    durable,
    scale,
    control: controlList,
    riskTolerance,
    capitalAppetite,
    sequence,
    assets,
    statedNoPhysicalWork,
    requirements,
    conflicts,
  };
}
