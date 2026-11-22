/**
 * How many deals the market can actually take inside a window — read from
 * what research established, never assumed.
 *
 * A play sold repeatedly is not worth its price once, and it is not worth its
 * price times however many buyers a plan would like to ask either. What it is
 * worth inside a window is bounded by two facts about the world: how many
 * buyers of that kind exist and can be reached, and how often each one buys.
 * Both are research questions (`buyerVolume` on the card), and until research
 * has stated them the plan treats the volume as unknown — a swept range and a
 * missing link of its chain — rather than as a number.
 *
 * The reader is deliberately narrow and conservative, like `figures.ts`:
 *
 *   * a count is a whole number stated beside a word for a buyer ("3,400
 *     property management firms"), never a money figure or a percentage, and
 *     the smallest such count is taken;
 *   * an order rate is a number of orders, sales or jobs stated per week,
 *     month or year;
 *   * a rate multiplies by a count only when the text says each counted unit
 *     does that rate: the units are the subject of the rate ("35 pharmacies
 *     ship 20 deliveries a week"), or it is distributed over them ("20 a week
 *     from each of 35 pharmacies", "20 a week per pharmacy across 35
 *     pharmacies"). A rate stated over a population ("700 a week across 35
 *     pharmacies"), a collective subject ("together", "combined", "in
 *     total") or a rate belonging to someone else ("35 pharmacies use a
 *     courier making 20 a week") is a total and is never multiplied;
 *   * a frequency word (weekly, monthly, quarterly, yearly) or "N times a
 *     month" says how often one buyer buys, and with none stated each buyer is
 *     credited one purchase in the window — never more.
 *
 * Its failure mode is missing a volume, never inventing one: shorthand like
 * "thousands of buyers" states no number and reads as unknown.
 */

const BUYER_WORDS =
  'buyers|businesses|companies|firms|customers|clients|households|homeowners|stores|shops|retailers|restaurants|practices|offices|owners|landlords|managers|agencies|contractors|organizations|organisations|members|accounts|venues|schools|clinics|dealers|dealerships|properties|operators|brokers|sellers|merchants|hotels|salons|studios|nonprofits|charities|teams|users|subscribers|employers|carriers|farms|wineries|breweries|builders|fleets|hospitals|pharmacies|gyms|churches|associations|shippers|distributors|manufacturers|wholesalers|vendors|families|parents|drivers|freelancers|creators|authors|publishers|photographers|realtors|agents|lawyers|attorneys|dentists|physicians|therapists|coaches|boards|homeowners|tenants';

const COUNT = '(\\d{1,3}(?:,\\d{3})+|\\d+)';
const BUYER_COUNT = new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z-]+\\s+){0,4}?(?:${BUYER_WORDS})\\b`, 'gi');
const RATE_NOUNS = 'orders|sales|purchases|transactions|jobs|deliveries|bookings|projects|contracts';
const PER = '(?:a|per|each|every)';
const PERIODS = '(day|week|month|year)';
/** "<count> [≤2 words] <orders> a/per <period>": a stated rate; group 1 the count, 2 the period. */
const RATE_PHRASE = `(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z-]+\\s+){0,2}?(?:${RATE_NOUNS})\\s+${PER}\\s+${PERIODS}\\b`;
const ORDER_RATE = new RegExp(RATE_PHRASE, 'gi');

/*
 * The forms in which a rate is stated per counted unit. Each is narrow on
 * purpose: a phrasing none of them recognizes keeps the conservative reading
 * (the rate as a total), because a multiplier the text does not state would
 * invent volume.
 */
const ADVERBS = 'each|typically|usually|currently|regularly|routinely|already|now|also|normally|generally|collectively|together|jointly|combined|between them';
const APPROX = '(?:about|around|roughly|approximately|nearly|some|an average of|on average)';
/**
 * Units as the subject of the rate: "35 independent pharmacies [in the
 * county] [each] ship [about] 20 deliveries a week [each]". Groups: 1 the
 * unit count, 2 an adverb, 3 the verb, 4 the rate count, 5 the period, 6 a
 * trailing qualifier.
 */
const SUBJECT_RATE = new RegExp(
  `(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z-]+\\s+){0,4}?(?:${BUYER_WORDS})` +
    `(?:\\s+(?:in|within|on|of|around|near|throughout|listed|registered|licensed)\\s+(?:[A-Za-z-]+\\s+){0,1}?[A-Za-z-]+)?` +
    `\\s+(?:(${ADVERBS})\\s+)?([A-Za-z-]+)\\s+(?:${APPROX}\\s+)?${COUNT}\\s+(?:[A-Za-z-]+\\s+){0,2}?(?:${RATE_NOUNS})\\s+${PER}\\s+${PERIODS}\\b` +
    `(\\s+(?:each|apiece|between them|in total|combined|together|altogether|in all|overall))?`,
  'gi',
);
/** Words that, standing where the verb is, make the subject's rate ambiguous or someone else's. */
const NOT_A_VERB = /^(?:and|or|but|plus|with|without|of|to|for|from|in|at|on|by|across|among|between|over|under|than|that|which|who|whose|where|while|whereas|are|is|were|was|be|been|use|using|hire|hiring|share|sharing|need|want|via|through|per|up|vs|versus|like|including)$/i;
const COLLECTIVE = /^(?:collectively|together|jointly|combined|between them|in total|altogether|in all|overall)$/i;
/** A rate distributed over named units: "20 deliveries a week from each of (the) 35 pharmacies". */
const EACH_OF_RATE = new RegExp(
  `${RATE_PHRASE}\\s+(?:(?:at|from|for|in|by|to|with)\\s+)?each\\s+of\\s+(?:the\\s+|their\\s+|its\\s+|our\\s+|these\\s+|those\\s+)?${COUNT}\\s+(?:[A-Za-z-]+\\s+){0,4}?(?:${BUYER_WORDS})\\b`,
  'gi',
);
/** A rate per unit, with the period after or before the unit: "20 deliveries a week per pharmacy", "20 deliveries per pharmacy a week". */
const PER_UNIT_AFTER = new RegExp(`${RATE_PHRASE}\\s+(?:per|from each|at each|for each|in each)\\s+([A-Za-z-]+)`, 'gi');
const PER_UNIT_BEFORE = new RegExp(
  `(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z-]+\\s+){0,2}?(?:${RATE_NOUNS})\\s+(?:per|from each|at each|for each|in each)\\s+([A-Za-z-]+)\\s+${PER}\\s+${PERIODS}\\b`,
  'gi',
);
const TIMES = /(\d+)\s*(?:times|x)\s+(?:a|per|each|every)\s+(week|month|quarter|year)\b/i;
const PERIOD_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, quarter: 91, year: 365 };
const WORD_DAYS: Array<[RegExp, number]> = [
  [/\b(daily|every day|each day)\b/i, 1],
  [/\b(weekly|every week|each week|per week)\b/i, 7],
  [/\b(fortnightly|biweekly|every two weeks)\b/i, 14],
  [/\b(monthly|every month|each month|per month)\b/i, 30],
  [/\b(quarterly|every quarter|each quarter)\b/i, 91],
  [/\b(yearly|annually|annual|every year|each year|per year)\b/i, 365],
];

function toInt(text: string): number {
  return Number.parseInt(text.replace(/,/g, ''), 10);
}

export interface VolumeReading {
  /** Deals the market can take inside the window. */
  deals: number;
  /** Reachable buyers, when one was stated. */
  buyers: number | null;
  /** Days between purchases by one buyer, when stated. */
  everyDays: number | null;
  /**
   * What the deals were read from: BUYERS — a count of buyers (times how often
   * each buys), so the deals are also every prospect the market holds; ORDERS —
   * an order rate, which says how many deals are made, not how many prospects
   * could be asked.
   */
  counted: 'BUYERS' | 'ORDERS';
  basis: string;
}

/** Words that name a buyer by what they own or run: "boat owners" own boats, "fleet operators" run fleets. */
const HOLDER_WORDS = /\b([a-z]{3,})\s+(?:owners?|operators?|managers?|proprietors?|holders?|keepers?)\b/gi;

/**
 * The things a payer is named for holding, as count words: a payer of "Recreational
 * boat owners" is one buyer per boat, so "3,400 boats are registered" counts buyers
 * exactly as "3,400 boat owners" would. Only the noun directly before the holder
 * word is taken (never an adjective further out), singular and plural. Pure.
 */
export function payerHeldWords(payer: string | null | undefined): string[] {
  if (!payer) return [];
  const out = new Set<string>();
  for (const m of payer.matchAll(HOLDER_WORDS)) {
    const w = m[1]!.toLowerCase();
    if (/^(?:the|and|for|with|small|large|local|independent|business|property|home)$/.test(w)) continue;
    const one = w.endsWith('s') ? w.slice(0, -1) : w;
    out.add(one);
    out.add(/(?:s|x|ch|sh)$/.test(one) ? `${one}es` : `${one}s`);
  }
  return [...out];
}

/** Plural nouns an industry can end on that name what is sold or done, never who buys it. */
const NOT_A_BUYER_NOUN = /^(?:services|products|goods|supplies|parts|materials|sales|rentals|repairs|events|items|units|orders|jobs|projects|equipment|industries|sectors|markets|trades|works|systems|solutions|tools|devices|vehicles|cars|trucks|machines|programs|programmes)$/;

/**
 * The buyer an opening's industry names, as count words (planningReliability
 * round 5): an opening filed under "golf courses" sells to golf courses, so "210
 * member courses are listed in the directory" counts its buyers exactly as "210
 * golf course owners" would, and "900 member washes" counts car washes. Before,
 * only a fixed list of buyer nouns and the payer's holder noun counted, so a
 * market research had sized in the industry's own noun read as unsized and its
 * volume link stayed open on a question already answered. Only the industry's
 * last word is taken, only when it is a plural noun, and never a word for what
 * is sold or done ("auto parts", "event rentals"). Singular and plural. Pure.
 */
export function industryBuyerWords(industry: string | null | undefined): string[] {
  if (!industry) return [];
  const words = industry.replace(/\([^)]*\)/g, ' ').toLowerCase().match(/[a-z]+/g) ?? [];
  const last = words[words.length - 1];
  if (!last || last.length < 4 || !last.endsWith('s') || last.endsWith('ss') || NOT_A_BUYER_NOUN.test(last)) return [];
  const one = /(?:sh|ch|x|ss)es$/.test(last) ? last.slice(0, -2) : last.slice(0, -1);
  return [one, last];
}

interface StatedRate {
  /** Orders a day across everything the rate covers. */
  perDay: number;
  /** The counted units the rate was multiplied by, or null for a rate stated as a total. */
  units: number | null;
  /** The rate one unit does, and its period, for the basis. */
  each: number;
  period: string;
}

/** The sentence around a position: the text between the nearest sentence breaks. */
function sentenceAt(text: string, at: number): { start: number; text: string } {
  const before = text.slice(0, at);
  const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('; '), before.lastIndexOf('! '), before.lastIndexOf('? '), before.lastIndexOf('\n')) + 1;
  const rest = text.slice(at).search(/[.;!?](?:\s|$)|\n/);
  return { start, text: text.slice(start, rest < 0 ? text.length : at + rest) };
}

/** Every rate the text states, multiplied by a count only where each counted unit is said to do it. */
function readRates(text: string): StatedRate[] {
  // Keyed by where the rate's own count stands, so a rate read per unit replaces its plain reading.
  const byPosition = new Map<number, StatedRate>();
  const put = (at: number, rate: StatedRate) => {
    if (rate.each > 0 && rate.perDay > 0) byPosition.set(at, rate);
  };
  const plain = (n: number, period: string, units: number | null): StatedRate => ({
    perDay: (n * (units ?? 1)) / PERIOD_DAYS[period]!,
    units,
    each: n,
    period,
  });

  for (const m of text.matchAll(ORDER_RATE)) put(m.index ?? 0, plain(toInt(m[1]!), m[2]!.toLowerCase(), null));

  // A rate per unit, with no count of units stated in its sentence, is one unit's rate: never a total over guessed units.
  const perUnit = (m: RegExpMatchArray, n: number, period: string, unitWord: string) => {
    if (/^(?:day|week|month|quarter|year)s?$/i.test(unitWord)) return;
    const at = m.index ?? 0;
    const sentence = sentenceAt(text, at);
    const counts = [...sentence.text.matchAll(BUYER_COUNT)]
      .filter((c) => sentence.start + (c.index ?? 0) !== at)
      .map((c) => toInt(c[1]!))
      .filter((c) => c > 0 && c < 50_000_000);
    put(at, plain(n, period, counts.length > 0 ? Math.min(...counts) : null));
  };
  for (const m of text.matchAll(PER_UNIT_AFTER)) perUnit(m, toInt(m[1]!), m[2]!.toLowerCase(), m[3]!);
  for (const m of text.matchAll(PER_UNIT_BEFORE)) perUnit(m, toInt(m[1]!), m[3]!.toLowerCase(), m[2]!);

  for (const m of text.matchAll(EACH_OF_RATE)) put(m.index ?? 0, plain(toInt(m[1]!), m[2]!.toLowerCase(), toInt(m[3]!)));

  for (const m of text.matchAll(SUBJECT_RATE)) {
    const [, unitText, adverb, verb, rateText, period, trailing] = m;
    if (NOT_A_VERB.test(verb!) || (adverb && COLLECTIVE.test(adverb)) || (trailing && COLLECTIVE.test(trailing.trim()))) continue;
    const units = toInt(unitText!);
    if (!(units > 0 && units < 50_000_000)) continue;
    // Nothing after the rate's count holds a digit, so its last occurrence is the rate's own position.
    const rateAt = (m.index ?? 0) + m[0]!.lastIndexOf(rateText!);
    put(rateAt, plain(toInt(rateText!), period!.toLowerCase(), units));
  }
  return [...byPosition.values()];
}

/** Read the deals a market can take inside `windowDays`, or null when no number is stated. */
export function readVolume(text: string, windowDays: number, payer: string | null = null, industry: string | null = null): VolumeReading | null {
  if (!text || !(windowDays > 0)) return null;
  const held = [...new Set([...payerHeldWords(payer), ...industryBuyerWords(industry)])].filter((w) => !new RegExp(`(?:^|\\|)${w}(?:\\||$)`).test(BUYER_WORDS));
  const buyerCount = held.length === 0 ? BUYER_COUNT : new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z-]+\\s+){0,4}?(?:${BUYER_WORDS}|${held.join('|')})\\b`, 'gi');
  const window = Math.max(1, Math.floor(windowDays));

  // An order rate states the volume directly; the slowest one stated is taken.
  const rates = readRates(text);
  if (rates.length > 0) {
    const slowest = rates.sort((a, b) => a.perDay - b.perDay)[0]!;
    const deals = Math.floor(slowest.perDay * window);
    if (deals >= 1) {
      const monthly = Math.round(slowest.perDay * 30);
      return slowest.units === null
        ? { deals, buyers: null, everyDays: null, counted: 'ORDERS', basis: `about ${monthly} orders a month are stated, so ${deals} in ${window} days` }
        : {
            deals,
            buyers: slowest.units,
            everyDays: null,
            counted: 'ORDERS',
            basis: `${slowest.units} units each doing ${slowest.each} a ${slowest.period} are stated, about ${monthly} orders a month, so ${deals} in ${window} days`,
          };
    }
  }

  const counts = [...text.matchAll(buyerCount)]
    .filter((m) => !/^\s*%/.test(text.slice((m.index ?? 0) + m[1]!.length)))
    .map((m) => toInt(m[1]!))
    .filter((n) => n > 0 && n < 50_000_000);
  if (counts.length === 0) return null;
  const buyers = Math.min(...counts);

  let everyDays: number | null = null;
  const times = TIMES.exec(text);
  if (times) everyDays = PERIOD_DAYS[times[2]!.toLowerCase()]! / Math.max(1, toInt(times[1]!));
  else for (const [pattern, days] of WORD_DAYS) if (pattern.test(text)) { everyDays = days; break; }
  const purchases = everyDays === null ? 1 : Math.max(1, Math.floor(window / everyDays));
  return {
    deals: buyers * purchases,
    buyers,
    everyDays,
    counted: 'BUYERS',
    basis:
      everyDays === null
        ? `${buyers} reachable buyers are stated and no repeat purchase is, so one purchase each`
        : `${buyers} reachable buyers, each buying about every ${Math.round(everyDays)} days, so ${purchases} purchase(s) each in ${window} days`,
  };
}

/**
 * A physical or counted quantity a record states, with its unit normalized —
 * the numeric extraction ALGO-16-1 item 2 names, kept beside `readVolume`
 * because both read numbers out of prose and share its rule: a quantity counts
 * only when a unit stands next to it, and a bare number is not read.
 *
 * Mass normalizes to kilograms, volume to litres, area to acres, time to
 * hours; anything counted (bales, units, loads, …) keeps its own singular unit,
 * because two different things counted are not one quantity. A US "ton" is the
 * short ton (907.18474 kg) and a "tonne" the metric one; the text that was read
 * travels with the value so a reader can check which was meant.
 */
export interface QuantityReading {
  value: number;
  unit: string;
  normalizedValue: number;
  normalizedUnit: 'kg' | 'l' | 'acre' | 'hour' | string;
  text: string;
}

const QUANTITY_UNITS: Record<string, { unit: string; factor: number }> = {
  kg: { unit: 'kg', factor: 1 }, kgs: { unit: 'kg', factor: 1 }, kilogram: { unit: 'kg', factor: 1 }, kilograms: { unit: 'kg', factor: 1 },
  lb: { unit: 'kg', factor: 0.45359237 }, lbs: { unit: 'kg', factor: 0.45359237 }, pound: { unit: 'kg', factor: 0.45359237 }, pounds: { unit: 'kg', factor: 0.45359237 },
  tonne: { unit: 'kg', factor: 1000 }, tonnes: { unit: 'kg', factor: 1000 }, ton: { unit: 'kg', factor: 907.18474 }, tons: { unit: 'kg', factor: 907.18474 },
  l: { unit: 'l', factor: 1 }, litre: { unit: 'l', factor: 1 }, litres: { unit: 'l', factor: 1 }, liter: { unit: 'l', factor: 1 }, liters: { unit: 'l', factor: 1 },
  gallon: { unit: 'l', factor: 3.785411784 }, gallons: { unit: 'l', factor: 3.785411784 }, gal: { unit: 'l', factor: 3.785411784 },
  acre: { unit: 'acre', factor: 1 }, acres: { unit: 'acre', factor: 1 }, hectare: { unit: 'acre', factor: 2.4710538 }, hectares: { unit: 'acre', factor: 2.4710538 }, ha: { unit: 'acre', factor: 2.4710538 },
  hour: { unit: 'hour', factor: 1 }, hours: { unit: 'hour', factor: 1 }, hrs: { unit: 'hour', factor: 1 },
};

const COUNTED = 'units?|items?|pieces?|pallets?|loads?|truckloads?|bales?|head|crates?|boxes|cases?|bushels?|cords?|seats?|licen[cs]es?|copies|sets?|bags?|rolls?|sheets?|panels?|vehicles?|trucks?|machines?';
const QUANTITY = new RegExp(
  `(?<![$£€¥\\d.,])(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)\\s*(${Object.keys(QUANTITY_UNITS).join('|')}|${COUNTED})\\b(?!\\s*%)`,
  'gi',
);

function singular(word: string): string {
  const w = word.toLowerCase();
  if (w === 'head' || w === 'copies') return w === 'copies' ? 'copy' : 'head';
  if (w === 'boxes') return 'box';
  if (w.endsWith('ces') && w !== 'pieces') return w.replace(/ces$/, 'ce');
  return w.replace(/s$/, '');
}

/** Every unit-bearing quantity in the text, normalized; empty when none is stated. */
export function readQuantities(text: string): QuantityReading[] {
  if (!text) return [];
  const out: QuantityReading[] = [];
  for (const match of text.matchAll(QUANTITY)) {
    const value = Number(match[1]!.replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    const raw = match[2]!.toLowerCase();
    const known = QUANTITY_UNITS[raw];
    const unit = known ? raw : singular(raw);
    out.push({
      value,
      unit,
      normalizedValue: known ? Math.round(value * known.factor * 1000) / 1000 : value,
      normalizedUnit: known ? known.unit : unit,
      text: match[0]!,
    });
  }
  return out;
}
