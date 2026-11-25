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

/**
 * An industry the words *confine* the work to, not one they merely mention:
 * "in a single industry the owner names: commercial cleaning", "only in
 * commercial cleaning", "in the commercial cleaning industry only". Pure. A
 * goal's industry binds that goal only (§105); this reads it, it excludes
 * nothing anywhere else.
 */
export function readRequiredIndustry(text: string): string | null {
  const patterns = [
    /\b(?:industry|sector|market|niche)\s+(?:(?:that\s+)?(?:the\s+owner|I|we)\s+(?:names?|chooses?|picks?|specif(?:y|ies))\s*)?:\s*([a-z][a-z\- ]{2,60}?)\s*(?=[,.;!]|$)/i,
    /\b(?:only|solely|exclusively|strictly)\s+(?:in|within)\s+(?:the\s+)?([a-z][a-z\- ]{2,60}?)(?:\s+(?:industry|sector|market|business|space))?\s*(?=[,.;!]|$|\s+(?:and|with|within|in|by|using)\b)/i,
    /\b(?:in|within)\s+(?:the\s+)?([a-z][a-z\- ]{2,60}?)\s+(?:industry|sector|market|business|space)\s+(?:only|alone|exclusively)\b/i,
    /\b(?:in|within)\s+(?:the\s+)?([a-z][a-z\- ]{2,60}?)\s+only\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    const phrase = m?.[1]?.trim().replace(/\s+(?:industry|sector|market|business|space)$/i, '').toLowerCase();
    if (phrase && !/^(?:(?:a|an|the|one|single)\b|\d)/.test(phrase) && !/\b(?:days?|weeks?|months?|years?|hours?|revenue|cash|capital)\b/.test(phrase)) return phrase;
  }
  return null;
}

/** The industry phrase: what the words confine the work to, else what follows "enter", "start", "get into", "build a … company". */
export function readIndustry(text: string): string | null {
  const required = readRequiredIndustry(text);
  if (required) return required;
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
  /**
   * Whole days when the deadline was stated as a span ("within 30 days", "in
   * 4 weeks") rather than a date: for a cash goal that span is a commercial
   * execution window that starts when execution is authorized (§119), never a
   * date computed from the moment the words were read. Null for a date.
   */
  windowDays?: number | null;
  /** Major units: the most the plan may tie up. */
  capitalCeiling: number | null;
  hoursCeiling: number | null;
  /** Major units: the most tied up before the first customer payment. */
  beforeProof: number | null;
  /** Major units: the most newly tied up in any week. */
  capitalPerWeek: number | null;
  /**
   * MONTHLY when the amount is a recurring monthly figure ("$5,000 a month in
   * recurring revenue", "$5k MRR"): the amount is then the monthly run-rate to
   * reach by the deadline, not a total. Null for a one-off total.
   */
  recurring: 'MONTHLY' | null;
  /** A limit on the owner's hours per week ("no more than 10 hours a week"); `hoursCeiling` is it over the window. */
  hoursPerWeek: number | null;
  /** The one industry the words confine the work to (`readRequiredIndustry`), or null. */
  industry: string | null;
  /**
   * An up-front capital limit the words state without a figure ("using little
   * up-front capital"). Never `capitalCeiling` or `beforeProof`, which are only
   * figures somebody said: this is the low ceiling the plan assumes in their
   * place on what is tied up before money comes in, flagged as an assumption
   * wherever it is read (`goalScope`).
   */
  capitalAssumed: { amount: number; phrase: string; basis: string } | null;
  /**
   * What the person says they have besides money and a number of hours, verbatim:
   * equipment ("a pickup truck") and time stated without a figure ("my weekends are
   * free"). Never turned into an hours limit — no figure was said (invariant 39).
   */
  resources: string[];
  /** The constraint phrases, verbatim. */
  constraints: string[];
  /** Phrases the reader saw and could not interpret, and required fields it could not find. */
  unread: string[];
  /** A place the words name, set only by a second reading (`objectiveAssist.ts`) that found it verbatim in them. */
  location?: string | null;
  /**
   * Set when a model read the words a second time because this reader left a
   * money figure unplaced, read no amount, or found no deadline: which fields
   * came from that reading (each checked against the words), which it proposed
   * and were refused, and which model answered. Absent when the reader alone decided.
   */
  assisted?: { model: string; fields: string[]; rejected: string[] } | null;
}

type TokenRole = 'AMOUNT' | 'CAPITAL' | 'BEFORE_PROOF' | 'PER_WEEK' | 'RANGE' | 'DEADLINE' | 'MADE';

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
const LIMIT = String.raw`(?:at most|no more than|not more than|up to|under|less than|below|a maximum of|maximum of|max(?:imum)?|only|just|about|around|roughly|approximately|maybe|close to|nearly|almost)`;
/** The verbs of "turn $1,000 into $10,000". */
const GROW = String.raw`(?:turn|turning|grow|growing|convert|converting|multiply|multiplying|compound|compounding)`;
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, eighteen: 18, twenty: 20, thirty: 30, forty: 40,
  'forty-five': 45, fifty: 50, sixty: 60, ninety: 90,
};
const NUMBER_WORD_SRC = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_SRC = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
/** "About", "around", "roughly": an approximate figure is the figure; the word changes nothing the reader places. */
const APPROX_SRC = String.raw`(?:about|around|roughly|approximately|approx\.?|maybe|say|some)`;
/**
 * A count in words or digits, including the vague ones: "a couple of weeks" is
 * two, "a few"/"several" three. A vague count is read at its low end, so a
 * vague deadline is never read later than the words allow.
 */
const COUNT_SRC = String.raw`\d+(?:\.\d+)?|(?:a\s+)?couple(?:\s+of)?|(?:a\s+)?few|several|${NUMBER_WORD_SRC}`;
function countOf(raw: string): number | null {
  const s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^\d/.test(s)) return Number(s);
  if (/couple/.test(s)) return 2;
  if (/few|several/.test(s)) return 3;
  return NUMBER_WORDS[s] ?? null;
}
/** A figure per month: "a month", "per month", "/mo", "monthly". */
const PER_MONTH_SRC = String.raw`(?:(?:per|a|each|every)\s+month|\/\s?mo(?:nth)?\b|a\s+mo\b|monthly\b)`;
/** What follows a per-month figure that says it is money coming in, not money going out. */
const INCOME_AFTER_SRC = String.raw`(?:(?:in|of)\s+)?(?:(?:new|net|gross|steady|passive|extra|side|reliable|consistent|recurring|monthly|take-home)\s+)*(?:revenue|income|profit|cash(?:\s+flow)?|sales|earnings)\b|(?:coming|rolling|flowing)\s+in\b|on\s+a\s+(?:recurring|regular|monthly|steady|consistent)\s+basis\b|(?:recurring|consistently|reliably|steadily|ongoing|every\s+month)\b`;

function moneyTokens(text: string): MoneyToken[] {
  const re = new RegExp(
    String.raw`(?<![\w.])(?:(US\$|\$|€|£|USD|EUR|GBP)\s?)?(${NUMBER_SRC})(?:\s?(${SUFFIX_SRC.replace(/\\b$/, '')})\b)?(?:\s?(${CODE_SRC.replace(/\\b$/, '')})\b)?`,
    'gi',
  );
  const out: MoneyToken[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [match, symbol, digits, suffix, code] = m;
    // "$1,500-ish", "$2k ish": an approximate figure is the figure, and the token keeps the word with it.
    const ish = /^\s?-?\s?ish\b/i.exec(text.slice(m.index + match!.length));
    const raw = ish ? match! + ish[0] : match!;
    if (ish) re.lastIndex = m.index + raw.length;
    const base = Number(digits!.replace(/,/g, ''));
    const value = suffix ? base * (MAGNITUDE[suffix.toLowerCase()] ?? 1) : base;
    const currency = symbol ? CURRENCY_OF[symbol.toLowerCase()] ?? null : code ? CURRENCY_OF[code.toLowerCase()] ?? null : null;
    out.push({ start: m.index, end: m.index + raw.length, raw: raw.trim(), value, currency, marked: Boolean(symbol || suffix || code), role: null });
  }
  return out;
}

/**
 * Every figure the words state, with the currency each names: money tokens at
 * their full value ("$5k" is 5,000) and counts written as words ("ten hours").
 * What a second reader of the same words may cite; anything not here was not said.
 */
export function statedFigures(text: string): { value: number; currency: string | null }[] {
  const t = text.replace(/\s+/g, ' ');
  const out = moneyTokens(t).map((m) => ({ value: m.value, currency: m.currency }));
  for (const m of t.matchAll(new RegExp(String.raw`\b(${NUMBER_WORD_SRC})\b`, 'gi'))) {
    const word = m[1]!.toLowerCase();
    if (word !== 'a' && word !== 'an') out.push({ value: NUMBER_WORDS[word]!, currency: null });
  }
  return out;
}

/** Whether the words state a figure per month ("a month", "/mo", "monthly", "MRR"). */
export function statesMonthlyRate(text: string): boolean {
  return new RegExp(String.raw`${PER_MONTH_SRC}|\bMRR\b|\bmonthly\b`, 'i').test(text);
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

type Period = 'week' | 'month' | 'quarter' | 'year';
/** The last second of the current calendar period, or of the one `ahead` periods later. Weeks end on Sunday. */
function periodEnd(now: Date, period: Period, ahead: number): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (period === 'week') {
    const toSunday = (7 - now.getUTCDay()) % 7 + 7 * ahead;
    return new Date(Date.UTC(y, m, now.getUTCDate() + toSunday, 23, 59, 59));
  }
  if (period === 'month') return new Date(Date.UTC(y, m + 1 + ahead, 0, 23, 59, 59));
  if (period === 'quarter') return new Date(Date.UTC(y, Math.floor(m / 3) * 3 + 3 + 3 * ahead, 0, 23, 59, 59));
  return new Date(Date.UTC(y + ahead, 11, 31, 23, 59, 59));
}

/** The next occurrence after `now` of a date computed per year. */
function nextOf(now: Date, on: (year: number) => Date | null): Date | null {
  for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const at = on(year);
    if (at && at.getTime() > now.getTime()) return at;
  }
  return null;
}

const SEASON_START: Record<string, number> = { spring: 2, summer: 5, fall: 8, autumn: 8, winter: 11 };
/** "By spring" is before the season begins; "by the end of summer" is its last day. Meteorological seasons. */
function seasonAt(now: Date, name: string, end: boolean): Date | null {
  const first = SEASON_START[name]!;
  return nextOf(now, (year) => (end ? new Date(Date.UTC(year, first + 3, 0, 23, 59, 59)) : new Date(Date.UTC(year, first, 1) - 1000)));
}

const HOLIDAY_SRC = String.raw`christmas(?:\s+eve)?|xmas|new\s+year'?s?(?:\s+(?:eve|day))?|thanksgiving|halloween|valentine'?s(?:\s+day)?|fourth\s+of\s+july|independence\s+day|labou?r\s+day|memorial\s+day|tax\s+day`;
/** The nth (1-based; -1 the last) weekday `dow` of a month. */
function nthWeekday(year: number, month: number, dow: number, nth: number): Date {
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return endOfDay(year, month, 1 + ((dow - first + 7) % 7) + 7 * (nth - 1))!;
  }
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  return endOfDay(year, month, lastDay.getUTCDate() - ((lastDay.getUTCDay() - dow + 7) % 7))!;
}
/** A holiday's day, end of day; "before" it is the day before. */
function holidayAt(now: Date, raw: string, before: boolean, fromYear: number | null = null): Date | null {
  const h = raw.toLowerCase().replace(/\s+/g, ' ');
  const day = (year: number): Date | null => {
    if (/eve$/.test(h) && /christmas/.test(h)) return endOfDay(year, 11, 24);
    if (/christmas|xmas/.test(h)) return endOfDay(year, 11, 25);
    if (/new year/.test(h)) return /day$/.test(h) ? endOfDay(year + 1, 0, 1) : endOfDay(year, 11, 31);
    if (/thanksgiving/.test(h)) return nthWeekday(year, 10, 4, 4);
    if (/halloween/.test(h)) return endOfDay(year, 9, 31);
    if (/valentine/.test(h)) return endOfDay(year, 1, 14);
    if (/july|independence/.test(h)) return endOfDay(year, 6, 4);
    if (/labou?r/.test(h)) return nthWeekday(year, 8, 1, 1);
    if (/memorial/.test(h)) return nthWeekday(year, 4, 1, -1);
    if (/tax/.test(h)) return endOfDay(year, 3, 15);
    return null;
  };
  const on = (year: number) => {
    const at = day(year);
    return at && before ? new Date(at.getTime() - 86_400_000) : at;
  };
  if (fromYear !== null) return on(fromYear);
  return nextOf(now, on);
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** "Tomorrow", "tonight", "the weekend" (Sunday) or the next named weekday, end of day. */
function dayAt(now: Date, word: string): Date | null {
  const today = (plus: number) => endOfDay(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + plus) ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + plus, 23, 59, 59));
  if (word === 'tonight') return today(0);
  if (word === 'tomorrow') return today(1);
  const dow = word === 'weekend' ? 0 : WEEKDAYS.indexOf(word.slice(0, 3));
  const ahead = (dow - now.getUTCDay() + 7) % 7;
  return today(ahead);
}

interface ObjectiveDetail {
  reading: ObjectiveReading;
  amountSpan: { start: number; end: number } | null;
  /**
   * Every other figure the words say is to be made: a second statement of the amount (a goal's title and
   * intent both carry it) and a figure per period ("$5,000 a month in recurring revenue"). Never capital.
   */
  madeSpans: { start: number; end: number }[];
}

/** Words with which an owner states money of their own: what they have, put in, spend or budget. */
const OWNER_MONEY = /\b(?:I|we)(?:'ve|'ll|'d| have| will| can| could| am| are)?\b[^.;!?]{0,40}\b(?:have|has|got|put|putting|invest|investing|spend|spending|afford|willing|budget|bankroll|start(?:ing)? with)\b|\b(?:budget|capital|bankroll|to (?:invest|spend|start|put in))\b/i;

/** The sentence (or clause between strong stops) that holds a span. Pure. */
function sentenceAround(text: string, start: number, end: number): string {
  const from = Math.max(text.lastIndexOf('.', start - 1), text.lastIndexOf(';', start - 1), text.lastIndexOf('!', start - 1), text.lastIndexOf('?', start - 1)) + 1;
  const stops = ['.', ';', '!', '?'].map((c) => text.indexOf(c, end)).filter((i) => i >= 0);
  const to = stops.length ? Math.min(...stops) : text.length;
  return text.slice(from, to);
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
  let windowDays: number | null = null;
  const deadlineSeen = (start: number, end: number, at: Date | null, phrase: string) => {
    consumed.push({ start, end, text: phrase });
    for (const t of tokensIn({ start, end })) t.role = 'DEADLINE';
    if (!at) return unread.push(`"${phrase}": a deadline the reader could not place`);
    if (deadline) return unread.push(`"${phrase}": a second deadline`);
    if (at.getTime() <= now.getTime()) return unread.push(`"${phrase}": a deadline already past`);
    deadline = at;
  };
  const spanAt = (n: number, unit: string): Date | null => {
    if (unit === 'hour' || unit === 'hr') return new Date(now.getTime() + n * 3_600_000);
    if (unit === 'day') return new Date(now.getTime() + n * 86_400_000);
    if (unit === 'week') return new Date(now.getTime() + n * 7 * 86_400_000);
    return Number.isInteger(n) ? addCalendar(now, unit as 'month' | 'year', n) : null;
  };
  /** A span ("within 30 days", "four months from now"): the first one read is also the execution window (§119). */
  const spanSeen = (start: number, end: number, n: number | null, unitRaw: string, phrase: string) => {
    const unit = unitRaw.toLowerCase().replace(/s$/, '');
    const first = deadline === null;
    deadlineSeen(start, end, n === null ? null : spanAt(n, unit), phrase);
    if (first && deadline !== null && unit !== 'hour' && unit !== 'hr') windowDays = Math.max(1, Math.round(((deadline as Date).getTime() - now.getTime()) / 86_400_000));
  };
  // "within 30 days", "in a couple of weeks", "over the next few months", "in about six weeks".
  const relative = new RegExp(String.raw`\b(?:in|within|inside(?:\s+of)?|over|during)\s+(?:the\s+)?(?:next\s+|coming\s+|first\s+)?(?:${APPROX_SRC}\s+)?(${COUNT_SRC})\s+(hours?|hrs?|days?|weeks?|months?|years?)\b`, 'gi');
  for (const m of text.matchAll(relative)) {
    // "can put in 10 hours this week" is the person's time, not a deadline: the hours reader (step 3) takes it.
    if (/\bhours?|hrs?\b/i.test(m[2]!) && /\b(?:put|putting|spend|spending|give|giving|work|working)\s*$/i.test(text.slice(Math.max(0, m.index! - 12), m.index!))) continue;
    spanSeen(m.index!, m.index! + m[0].length, countOf(m[1]!), m[2]!, m[0]);
  }
  // "four months from now", "by about six weeks from today", "3 months out from now".
  const fromNow = new RegExp(String.raw`(?:\b(?:by|in|within|before)\s+)?(?:${APPROX_SRC}\s+)?\b(${COUNT_SRC})\s+(days?|weeks?|months?|years?)\s+(?:out\s+)?from\s+(?:now|today)\b`, 'gi');
  for (const m of text.matchAll(fromNow)) {
    if (overlaps({ start: m.index!, end: m.index! + m[0].length }, consumed)) continue;
    spanSeen(m.index!, m.index! + m[0].length, countOf(m[1]!), m[2]!, m[0]);
  }
  for (const m of text.matchAll(/\bby\s+(\d{4})-(\d{2})-(\d{2})\b/gi)) {
    deadlineSeen(m.index!, m.index! + m[0].length, endOfDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])), m[0]);
  }
  for (const m of text.matchAll(/\bby\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/gi)) {
    deadlineSeen(m.index!, m.index! + m[0].length, endOfDay(Number(m[3]), Number(m[1]) - 1, Number(m[2])), m[0]);
  }
  // "by end of next month", "before the end of the quarter", "end of this week": the last day of that calendar period.
  const endOfPeriod = new RegExp(String.raw`(?:\b(?:by|before|until|till|til|at|for)\s+)?(?:${APPROX_SRC}\s+)?(?:the\s+)?\bend\s+of\s+(?:the\s+|this\s+|(next)\s+)?(week|month|quarter|year)\b`, 'gi');
  for (const m of text.matchAll(endOfPeriod)) {
    deadlineSeen(m.index!, m.index! + m[0].length, periodEnd(now, m[2]!.toLowerCase() as Period, m[1] ? 1 : 0), m[0]);
  }
  // "by next month", "by next week": before that period begins — the end of the current one, never later than the words allow.
  for (const m of text.matchAll(/\b(?:by|before)\s+next\s+(week|month|quarter|year)\b/gi)) {
    if (overlaps({ start: m.index!, end: m.index! + m[0].length }, consumed)) continue;
    deadlineSeen(m.index!, m.index! + m[0].length, periodEnd(now, m[1]!.toLowerCase() as Period, 0), m[0]);
  }
  // "by mid-January", "before early March", "by the beginning of April", "by January".
  const partOfMonth = new RegExp(String.raw`\b(?:by|before|until|till|around)\s+(?:${APPROX_SRC}\s+)?(?:the\s+)?(?:(early|mid|middle\s+of|late|(?:start|beginning)\s+of)[\s-]*(?:the\s+month\s+of\s+)?)?(${MONTH_SRC})\b(?!\.?\s+\d{1,2}(?:st|nd|rd|th)?\b)(?:,?\s+(\d{4}))?`, 'gi');
  for (const m of text.matchAll(partOfMonth)) {
    if (overlaps({ start: m.index!, end: m.index! + m[0].length }, consumed)) continue;
    // "may" is also a verb: only a capitalised or qualified "May" is the month.
    if (/^may$/i.test(m[2]!) && !m[1] && m[2] !== 'May') continue;
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    const part = (m[1] ?? '').toLowerCase();
    const day = /^early/.test(part) ? 10 : /^mid/.test(part) ? 15 : /^late/.test(part) ? 20 : 0;
    const on = (year: number) => (day ? endOfDay(year, month, day) : new Date(Date.UTC(year, month, 1) - 1000));
    let at = on(m[3] ? Number(m[3]) : now.getUTCFullYear());
    if (at && !m[3] && at.getTime() <= now.getTime()) at = on(now.getUTCFullYear() + 1);
    deadlineSeen(m.index!, m.index! + m[0].length, at, m[0]);
  }
  // "by spring", "before the end of summer": the season's first or last day (meteorological seasons).
  const season = new RegExp(String.raw`\b(?:by|before|until|till)\s+(?:${APPROX_SRC}\s+)?(?:the\s+)?(?:(start|beginning|end)\s+of\s+(?:the\s+)?)?(?:this\s+|next\s+)?(spring|summer|fall|autumn|winter)\b`, 'gi');
  for (const m of text.matchAll(season)) {
    if (overlaps({ start: m.index!, end: m.index! + m[0].length }, consumed)) continue;
    deadlineSeen(m.index!, m.index! + m[0].length, seasonAt(now, m[2]!.toLowerCase(), (m[1] ?? '').toLowerCase() === 'end'), m[0]);
  }
  // "before Christmas", "by Thanksgiving", "for New Year's".
  const holiday = new RegExp(String.raw`\b(by|before|until|till|for)\s+(?:${APPROX_SRC}\s+)?(?:the\s+)?(${HOLIDAY_SRC})(?![\w'])(?:,?\s+(?:(this|next)\s+year|(\d{4})))?`, 'gi');
  for (const m of text.matchAll(holiday)) {
    if (overlaps({ start: m.index!, end: m.index! + m[0].length }, consumed)) continue;
    // "before Thanksgiving next year": that year's, never this year's.
    const fromYear = m[4] ? Number(m[4]) : m[3]?.toLowerCase() === 'next' ? now.getUTCFullYear() + 1 : null;
    deadlineSeen(m.index!, m.index! + m[0].length, holidayAt(now, m[2]!, m[1]!.toLowerCase() === 'before', fromYear), m[0]);
  }
  // "by the 15th of February", "before the 3rd of March 2027".
  const dayOfMonth = new RegExp(String.raw`\b(?:by|before|until|till|on)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_SRC})\b(?:,?\s+(\d{4}))?`, 'gi');
  for (const m of text.matchAll(dayOfMonth)) {
    if (overlaps({ start: m.index!, end: m.index! + m[0].length }, consumed)) continue;
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    const day = Number(m[1]);
    let at = endOfDay(m[3] ? Number(m[3]) : now.getUTCFullYear(), month, day);
    if (at && !m[3] && at.getTime() <= now.getTime()) at = endOfDay(now.getUTCFullYear() + 1, month, day);
    deadlineSeen(m.index!, m.index! + m[0].length, at, m[0]);
  }
  // "by Friday", "before this Thursday", "by tomorrow", "by the weekend": the next such day, end of day.
  for (const m of text.matchAll(/\b(?:by|before|until)\s+(?:this\s+|next\s+|the\s+)?(tomorrow|tonight|weekend|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/gi)) {
    if (overlaps({ start: m.index!, end: m.index! + m[0].length }, consumed)) continue;
    deadlineSeen(m.index!, m.index! + m[0].length, dayAt(now, m[1]!.toLowerCase()), m[0]);
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
  // "this week": the seven days from now. "by (the) end of March": the last day of the next March.
  for (const m of text.matchAll(/\b(?:this|within the|in the next)\s+week\b/gi)) {
    if (!overlaps({ start: m.index!, end: m.index! + m[0].length }, consumed) && deadline === null) deadlineSeen(m.index!, m.index! + m[0].length, new Date(now.getTime() + 7 * 86_400_000), m[0]);
  }
  // "make $500 this month": the end of this month, quarter or year, when nothing else set a deadline.
  for (const m of text.matchAll(/\b(?:(?:by|before|within|during|in)\s+)?this\s+(month|quarter|year)\b/gi)) {
    if (!overlaps({ start: m.index!, end: m.index! + m[0].length }, consumed) && deadline === null) deadlineSeen(m.index!, m.index! + m[0].length, periodEnd(now, m[1]!.toLowerCase() as Period, 0), m[0]);
  }
  const endOfMonthName = /\bby\s+(?:the\s+)?end\s+of\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:,?\s+(\d{4}))?/gi;
  for (const m of text.matchAll(endOfMonthName)) {
    if (overlaps({ start: m.index!, end: m.index! + m[0].length }, consumed)) continue;
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    let year = m[2] ? Number(m[2]) : now.getUTCFullYear();
    let at = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59));
    if (!m[2] && at.getTime() <= now.getTime()) at = new Date(Date.UTC(++year, month + 1, 0, 23, 59, 59));
    deadlineSeen(m.index!, m.index! + m[0].length, at, m[0]);
  }
  // Anything else that looks like a deadline and was not read is named, never guessed.
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

  // 3. Hours a person will put in. A rate ("10 hours a week") is a per-week limit, bounded over a stated window only (below).
  let hoursCeiling: number | null = null;
  const hourPatterns = [
    new RegExp(String.raw`(?:\b${LIMIT}\s+)?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s+of\s+(?:(?:my|our|own|total)\s+)*(?:time|work|effort|labou?r)\b(?!\s+(?:per|a|each|every)\s+(?:day|week|month))`, 'gi'),
    new RegExp(String.raw`\b(?:put|putting|spend|spending|give it|work)\s+in\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)(?:\s+(?:this|that)\s+week)?(?!\s+(?:of\s+\w+\s+)?(?:per|a|each|every)\s+(?:day|week|month))`, 'gi'),
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
  // "Zero hours of my time", "without spending any of my own hours": a limit of nothing, never no limit (invariant 39).
  if (hoursCeiling === null) {
    const none = /\b(?:I'm not|I am not|I won't be|I will not be)\s+doing\s+(?:any\s+(?:of\s+)?)?(?:the\s+)?work\b|\b(?:don't|do not|won't|will not)\s+(?:want to\s+)?(?:put in|spend|give it)\s+any\s+(?:hours|time)\b|\b(?:zero|no)\s+(?:hours?|time)\s+(?:of\s+)?(?:my|our|owner)\b|\bwithout\s+(?:spending\s+|using\s+)?any\s+(?:of\s+)?(?:my|our)\s+(?:own\s+)?(?:hours|time)\b/i.exec(text);
    if (none) {
      hoursCeiling = 0;
      constraintSpans.push({ start: none.index, end: none.index + none[0].length, text: none[0] });
    }
  }
  /*
   * An hours rate ("no more than 10 hours a week of owner time") is a limit per
   * week. With a deadline it also bounds the window's total — the per-week
   * figure times the weeks left — which is what the plan's hours check reads
   * (`hoursCeiling`); the per-week figure is kept as stated (`hoursPerWeek`).
   * With no deadline there is no window to bound, so it stays unread.
   */
  let hoursPerWeek: number | null = null;
  // "just a few hours a week": a vague rate, read at its low end (2), as every vague count is.
  const fewHours = /\b(?:a\s+)?(?:few|couple(?:\s+of)?)\s+(?:hours?|hrs?)\s+(?:a|per|each|every)\s+week\b/i.exec(text);
  if (fewHours && hoursCeiling === null && deadline !== null) {
    hoursPerWeek = 2;
    hoursCeiling = Math.round((2 * ((deadline as Date).getTime() - now.getTime())) / (7 * 86_400_000));
    constraintSpans.push({ start: fewHours.index, end: fewHours.index + fewHours[0].length, text: fewHours[0] });
  }
  const PER_WEEK: Record<string, number> = { day: 7, week: 1, month: 7 / 30 };
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:(?:of\s+\w+\s+)?(?:per|a|each|every)\s+|\/\s?)(day|week|wk|month)\b/gi)) {
    const span = { start: m.index!, end: m.index! + m[0].length, text: m[0] };
    if (overlaps(span, consumed)) continue;
    consumed.push(span);
    constraintSpans.push(span);
    for (const t of tokensIn(span)) t.role = 'DEADLINE';
    const window = deadline as Date | null;
    if (window === null) {
      unread.push(`"${m[0]}": an hours rate, not a total`);
    } else if (hoursPerWeek !== null || hoursCeiling !== null) {
      unread.push(`"${m[0]}": a second hours limit`);
    } else {
      hoursPerWeek = Math.round(Number(m[1]) * PER_WEEK[m[2]!.toLowerCase().replace(/^wk$/, 'week')]! * 100) / 100;
      hoursCeiling = Math.round((hoursPerWeek * (window.getTime() - now.getTime())) / (7 * 86_400_000));
    }
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
    { role: 'CAPITAL', re: new RegExp(String.raw`\b(?:I|we)\s+(?:only\s+)?(?:have|has|got|own|can (?:spend|invest|put in|afford|spare))\s+(?:${LIMIT}\s+)?${MP}(?!\s*(?:${PER_MONTH_SRC}|(?:per|a)\s+(?:week|year)|coming in|in (?:income|revenue|sales)))`, 'gi') },
    // "…, have $100", "Got about $1,500.": the same, with the person left unsaid at the start of a clause.
    { role: 'CAPITAL', re: new RegExp(String.raw`(?:^|[.;,:!]\s*|\b(?:and|but)\s+)(?:only\s+)?(?:have|got)\s+(?:${LIMIT}\s+)?${MP}(?!\s*(?:${PER_MONTH_SRC}|(?:per|a)\s+(?:week|year)|coming in|in (?:income|revenue|sales)))`, 'gi') },
    // "I've got $1,000", "we have got about $500": money the person has is the most the plan may use.
    { role: 'CAPITAL', re: new RegExp(String.raw`\b(?:I|we)(?:'ve|\s+have)\s+(?:only\s+)?got\s+(?:${LIMIT}\s+)?${MP}(?!\s*(?:${PER_MONTH_SRC}|(?:per|a)\s+(?:week|year)|coming in|in (?:income|revenue|sales)))`, 'gi') },
    // "I've got 10k to invest", "$1,000 to start", "I can put up to $500 into it", "I'll put in $10k".
    { role: 'CAPITAL', re: new RegExp(String.raw`\b(?:I|we)(?:'ve|'ll| have| will)?\s+(?:only\s+)?(?:got|have|put(?:\s+in)?|invest|spend)\s+(?:${LIMIT}\s+)?${MP}(?=\s+(?:to (?:invest|spend|start|work with|put in)|into (?:it|this)|in(?:to)? (?:the business|it))\b)`, 'gi') },
    { role: 'CAPITAL', re: new RegExp(String.raw`\b(?:put|invest|spend)\s+(?:${LIMIT}\s+)?${MP}\s+into\s+(?:it|this|the business)\b`, 'gi') },
    { role: 'CAPITAL', re: new RegExp(String.raw`${MP}\s+to\s+(?:start|invest|spend|work with)\b`, 'gi') },
    { role: 'CAPITAL', re: new RegExp(String.raw`\bwith\s+(?:${LIMIT}\s+)?(?:an?\s+)?${MP}(?!\s*(?:in|of)\s+(?:revenue|sales|profit|income))`, 'gi') },
    { role: 'CAPITAL', re: new RegExp(String.raw`\b(?:using|use)\s+(?:${LIMIT}\s+)?(?:an?\s+)?${MP}(?!\s*(?:in|of|a|per)\s+(?:revenue|sales|profit|income|month|week|year))`, 'gi') },
    // "Turn $1,000 into $10,000": the first figure is the stake the plan may use; the second is the amount (step 5).
    { role: 'CAPITAL', re: new RegExp(String.raw`\b${GROW}\s+${MP}(?=\s+into\s)`, 'gi') },
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

  // 4b. A price the person states for the offer ("at $300/month", "for $150 each", "$1,500/mo retainers")
  // is what one sale brings in, never the amount or a limit: it is kept as a constraint, read by nothing else.
  for (const t of tokens) {
    if (t.role !== null || !t.marked) continue;
    const before = text.slice(Math.max(0, t.start - 20), t.start);
    const after = text.slice(t.end, t.end + 40);
    // "Aiming for $12,000" is the goal, not a price.
    const goalFor = /\b(?:aim(?:s|ing)?|shoot(?:s|ing)?|hop(?:e|es|ing)|looking|going|gunning)\s+for\s+$/i.test(before);
    const priced = (/\b(?:at|for|charging|charge|priced at)\s+$/i.test(before) && !goalFor) || /^\s*(?:\/\s?(?:mo(?:nth)?|each)\s+)?(?:each\b|retainers?\b|per\s+(?:client|customer|sale|deal|unit|job|order|lead|listing|door)\b)/i.test(after);
    if (!priced) continue;
    t.role = 'MADE';
    constraintSpans.push({ start: t.start, end: t.end, text: `price ${t.raw}` });
  }

  // 5. The amount: a figure the words say is to be brought in.
  // Every person of the verb: "a business that collects $50,000" names the amount as surely as "collect $50,000".
  const verbBefore = /\b(?:want|wants|need|needs|builds?|building|get|gets|getting|grow(?:s|ing)? to|generates?|generating|makes?|making|earns?|earning|collects?|collecting|nets?|netting|brings? in|bringing in|clears?|clearing|gross(?:es)?|grossing|produces?|producing|reach(?:es)?|reaching|hits?|gets? to|books?|banks?|pulls? in|realizes?|realises?|profits?|creates?|pays?(?:\s+(?:me|us))?|paying(?:\s+(?:me|us))?|take home|taking home|replac(?:e|es|ing)(?:\s+(?:my|our))?|(?:like|want|need|love|hope)\s+to\s+have|aim(?:s|ing)?\s+for|shoot(?:s|ing)?\s+for|hop(?:e|es|ing)\s+for|looking\s+for|(?:goal|target|aim)\s+(?:is|of)|(?:income|revenue|earnings|profit)\s+of)\s+(?:(?:me|us|it|them|this|that|my business|the business)\s+)?(?:(?:to|up to)\s+)?(?:(?:me|us|at least|over|more than|about|around|roughly|approximately|maybe|some|close to|nearly|almost|just over|an? (?:extra|additional)|another|a minimum of|minimum of|a total of)\s+)*$/i;
  const nounAfter = /^\s*(?:(?:(?:in|of)\s+)?(?:(?:settled|collected|net|gross|new|recurring|monthly|total|customer|client)\s+)*(?:revenue|sales|profit|income|cash flow|cash|payments|invoices|billings?|bookings|fees|commissions|deposits)\b|collected\b|(?:a|per)\s+month\s+recurring\b|\/\s?mo(?:nth)?\s+recurring\b|MRR\b)/i;
  let amountToken: MoneyToken | null = null;
  let recurring: ObjectiveReading['recurring'] = null;
  for (const t of tokens) {
    if (t.role !== null || !t.marked) continue;
    const before = text.slice(Math.max(0, t.start - 60), t.start);
    const after = text.slice(t.end);
    const beforeDeadline = consumed.some((s) => s.start >= t.end && /^\s*$/.test(text.slice(t.end, s.start)) && /^(?:in|within|inside|over|during|by|before|until|till)\b/i.test(s.text));
    // The figure a stake is turned into: the stake's own phrase (step 4) ends right before "into".
    const turnedInto = constraintSpans.some((s) => new RegExp(String.raw`^${GROW}\s`, 'i').test(s.text) && /^\s+into\s+$/i.test(text.slice(s.end, t.start)));
    // "$5,000 a month in recurring revenue", "$5k MRR", "$5,000 in monthly recurring revenue": a monthly run-rate is the amount.
    const statedRecurring =
      /^\s*(?:(?:per|a|each|every)\s+month|\/\s?mo(?:nth)?)\s+recurring\b/i.test(after) ||
      /^\s*(?:(?:per|a|each|every)\s+month|\/\s?mo(?:nth)?)\s+(?:(?:in|of)\s+)?(?:(?:new|net|gross|monthly)\s+)*(?:recurring|subscription|retainer)\s+(?:revenue|income|sales|billings?)\b/i.test(after) ||
      /^\s*(?:(?:in|of)\s+)?(?:(?:new|net|gross)\s+)*(?:monthly\s+recurring\s+(?:revenue|income|sales)|MRR)\b/i.test(after) ||
      // "$5k a month coming in", "$3,000/mo in steady income", "$2,000 monthly on a recurring basis": the words after the rate say it is income.
      new RegExp(String.raw`^\s*${PER_MONTH_SRC}\s*(?:${INCOME_AFTER_SRC})`, 'i').test(after) ||
      // "$2.5k coming in monthly", "$1,000 in monthly income".
      /^\s*(?:(?:coming|rolling|flowing)\s+in\s+(?:monthly|every\s+month|each\s+month|(?:a|per)\s+month)|(?:in|of)\s+monthly\s+(?:income|revenue|profit|cash\s+flow))\b/i.test(after);
    /*
     * "Get to $4,000 a month within 60 days", "reach $6,000 a month": a per-month figure the
     * sentence's own verb says is to be brought in, with no other amount, is a monthly run-rate.
     * The owner's ordinary phrasing (2026-11-24 investigation: 12 of 40 fresh requests were
     * refused or read without an amount) — a rate with no such verb stays unread below.
     */
    const ranRate = !amountToken && verbBefore.test(before) && new RegExp(String.raw`^\s*${PER_MONTH_SRC}(?!\s+(?:of|in|on)\s+(?:capital|budget|spend|costs?|expenses?|ads))`, 'i').test(after);
    /*
     * "Replace my $60k salary", "replace my $4,000 a month salary": a salary to replace is a
     * monthly run-rate. With no period stated a salary is annual by ordinary usage, so it is a
     * twelfth a month — but only from a figure no month's pay is (12,000 and up); a smaller
     * one with no period is named unread, never guessed.
     */
    if (!amountToken && /\breplac(?:e|es|ing)(?:\s+(?:my|our))?\s+(?:\S+\s+){0,2}$/i.test(before) && /^\s*(?:(?:a|per)\s+year\s+|\/\s?y(?:ea)?r\s+|annual\s+|yearly\s+)?(?:salary|income|paycheck|pay|wages?)\b/i.test(after)) {
      const annual = /^\s*(?:(?:a|per)\s+year|\/\s?y(?:ea)?r|annual|yearly)\b/i.test(after) || t.value >= 12_000;
      if (!annual) {
        t.role = 'MADE';
        unread.push(`"${t.raw}": a salary with no period`);
        continue;
      }
      t.role = 'AMOUNT';
      amountToken = { ...t, value: Math.round(t.value / 12) };
      recurring = 'MONTHLY';
      continue;
    }
    const monthlyRecurring = statedRecurring || ranRate;
    if (!(verbBefore.test(before) || nounAfter.test(after) || beforeDeadline || turnedInto || statedRecurring)) {
      /*
       * A figure the owner says they have, put in, spend or budget is the capital limit, whatever
       * the phrase around it (2026-11-25: "I can put $1,500 in", "I've got $2,000", "$10,000 I'm
       * willing to put in", "I'll put up $25,000" were each refused at goal creation). Read from
       * its own sentence's words, and only when no other phrase already set the limit.
       */
      const sentence = sentenceAround(text, t.start, t.end);
      if (figures.CAPITAL.length === 0 && OWNER_MONEY.test(sentence) && !/\b(?:a|per|each|every)\s+(?:week|month|year)\b/i.test(text.slice(t.end, t.end + 16))) {
        t.role = 'CAPITAL';
        figures.CAPITAL.push(t);
        constraintSpans.push({ start: t.start, end: t.end, text: sentence.trim().slice(0, 160) });
        continue;
      }
      unread.push(`"${t.raw}": a figure the reader could not place`);
      continue;
    }
    if (monthlyRecurring && !amountToken) {
      t.role = 'AMOUNT';
      amountToken = t;
      recurring = 'MONTHLY';
      continue;
    }
    if (/^\s*(?:(?:in|of)\s+\w+\s+)?(?:per|a|each|every)\s+(?:day|week|month|year)\b/i.test(after)) {
      t.role = 'MADE';
      unread.push(`"${t.raw}${after.match(/^\s*(?:(?:in|of)\s+\w+\s+)?(?:per|a|each|every)\s+(?:day|week|month|year)/i)![0]}": a rate, not a total`);
      continue;
    }
    if (amountToken) {
      t.role = 'MADE';
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
  // A bare figure ("collect 12k") takes the currency every other figure in the same words names, when they all name one.
  const named = [...new Set(tokens.map((t) => t.currency).filter((c): c is string => !!c))];
  const currency = amountToken?.currency ?? (named.length === 1 ? named[0]! : null);
  if (kind === 'CASH') {
    if (!currency) unread.push(`currency: "${amountToken!.raw}" names no currency`);
    if (!deadline) unread.push('deadline: none stated');
  }
  const at = deadline as Date | null;
  const capitalCeiling = single(figures.CAPITAL, 'capital limit');
  return {
    reading: {
      text,
      kind,
      metric: kind === 'CASH' ? (/\b(?:profit|net|netting|contribution)\b/i.test(text) ? 'CONTRIBUTION' : 'SETTLED_CASH') : null,
      amount: amountToken?.value ?? null,
      currency,
      deadline: at ? at.toISOString() : null,
      deadlineHours: at ? Math.round((at.getTime() - now.getTime()) / 3_600_000) : null,
      windowDays,
      capitalCeiling,
      hoursCeiling,
      beforeProof: single(figures.BEFORE_PROOF, 'before-proof limit'),
      capitalPerWeek: single(figures.PER_WEEK, 'per-week limit'),
      recurring,
      hoursPerWeek,
      industry: readRequiredIndustry(text),
      capitalAssumed: capitalCeiling === null && amountToken ? assumedLittleCapital(text, amountToken.value) : null,
      resources: readResources(text),
      constraints: constraintSpans.sort((a, b) => a.start - b.start).map((s) => s.text),
      unread,
    },
    amountSpan: amountToken ? { start: amountToken.start, end: amountToken.end } : null,
    madeSpans: tokens.filter((t) => t.role === 'MADE').map((t) => ({ start: t.start, end: t.end })),
  };
}

const TIME_OF_WEEK = String.raw`(?:weekends?|evenings?|nights?|mornings?|afternoons?|saturdays?|sundays?|weekdays?)`;
/**
 * What the person has besides money and hours, in their own words: "I've got a
 * pickup truck", "my weekends are free", "I have $3,000 and weekends". Pure.
 */
export function readResources(text: string): string[] {
  const out: string[] = [];
  const add = (phrase: string) => {
    const p = phrase.trim().replace(/[.,;!]+$/, '');
    if (p && !out.some((o) => o.toLowerCase() === p.toLowerCase())) out.push(p);
  };
  const possession = /\b(?:I|we)(?:'ve|\s+have)?\s+(?:also\s+)?(?:got|have|own)\s+((?:an?|my|our|two|three|four|\d+)\s+[a-z][a-z\- ]{1,40}?)(?=\s*(?:[,.;!]|\band\b|\bbut\b|\bthat\b|\bwhich\b|$))/gi;
  for (const m of text.matchAll(possession)) {
    if (/\b(?:money|capital|budget|cash|dollars?|bucks|savings|hours?|hrs?|time|deadline|goal|idea|job)\b/i.test(m[1]!)) continue;
    add(m[1]!);
  }
  const free = new RegExp(String.raw`\b(?:my\s+|our\s+)?${TIME_OF_WEEK}\s+(?:are|is)\s+(?:free|open|available)\b|\b(?:free|available|open)\s+(?:on\s+|in\s+the\s+)?${TIME_OF_WEEK}\b|\b${TIME_OF_WEEK}\s+(?:free|off|open)\b|\b(?:and|plus|with)\s+(?:my\s+)?${TIME_OF_WEEK}(?=\s*(?:[,.;!]|$))`, 'gi');
  for (const m of text.matchAll(free)) add(m[0].replace(/^(?:and|plus|with)\s+/i, ''));
  return out;
}

/**
 * The share of the amount a capital limit stated without a figure ("little
 * up-front capital") is assumed to allow: a tenth — $1,000 on a $10,000 goal.
 * A low ceiling, because an unstated limit read as no limit is an unknown read
 * favourably (invariant 39): the owner said *little*, and the plan must not
 * buy an $8,000 lot on that word. It is an assumption, never a figure anybody
 * set, so it is carried apart from `capitalCeiling`, applied as the limit on
 * what is tied up before money comes in ("up-front"), and only ever narrows
 * what the plan works (spending is still the commercial authority's, `spending.ts`).
 */
export const LITTLE_CAPITAL_SHARE = 0.1;
const LITTLE_CAPITAL = /\b(?:very\s+)?(?:little|minimal|minimum|low|small|modest|limited|not much|hardly any)\s+(?:amounts?\s+of\s+)?(?:(?:up-?front|upfront|starting|initial|start-?up|seed|own|working)\s+)*(?:capital|money|cash|investment|funding|budget|outlay)\b/i;

/**
 * "No up-front capital", "zero starting money", "without any investment": a
 * limit of nothing before money comes in, never no limit (metamorphic P6b,
 * 2026-11-20: such a goal was planned as if money were unlimited and read
 * 0.898 against 0.434 for the same goal with $1,000).
 */
const NO_CAPITAL = /\b(?:no|zero|without(?:\s+any)?|nothing\s+in)\s+(?:(?:up-?front|upfront|starting|initial|start-?up|seed|own|working)\s+)*(?:capital|money|cash|investment|funding|outlay)\b|\b(?:don't|do not|can't|cannot|won't|will not)\s+(?:have|want to (?:spend|put in|invest)|spend|invest|put in)\s+(?:any(?:thing)?|a (?:dime|cent|penny))(?:\s+(?:money|cash|capital))?\b|\b(?:don't|do not|can't|cannot)\s+have\s+(?:any\s+|the\s+|spare\s+)?(?:money|cash|capital)\b|\bI've got no money\b/i;

export function assumedLittleCapital(text: string, amount: number): ObjectiveReading['capitalAssumed'] {
  const none = NO_CAPITAL.exec(text);
  if (none && amount > 0) return { amount: 0, phrase: none[0], basis: `"${none[0]}": nothing may be tied up before money comes in` };
  // "a couple hundred bucks", "a few hundred dollars": read at its low end, as every vague count is.
  const vague = /\b(?:a\s+)?(couple(?:\s+of)?|few)\s+(hundred|thousand)\s+(?:bucks|dollars|usd)\b/i.exec(text);
  if (vague && amount > 0) {
    const figure = 2 * (vague[2]!.toLowerCase() === 'hundred' ? 100 : 1000);
    return { amount: figure, phrase: vague[0], basis: `"${vague[0]}" states no figure; read at its low end, ${figure}` };
  }
  const m = LITTLE_CAPITAL.exec(text);
  if (!m || !(amount > 0)) return null;
  const figure = Math.max(1, Math.round(amount * LITTLE_CAPITAL_SHARE));
  return { amount: figure, phrase: m[0], basis: `"${m[0]}" states no figure; assumed ${LITTLE_CAPITAL_SHARE * 100}% of the ${amount.toLocaleString('en-US')} to be made` };
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
  // The amount, a repeat of it, and any figure to bring in per period are money to make, never money to spend.
  let rest = text;
  for (const span of [objective.amountSpan, ...objective.madeSpans]) {
    if (span) rest = `${rest.slice(0, span.start)}${' '.repeat(span.end - span.start)}${rest.slice(span.end)}`;
  }
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
