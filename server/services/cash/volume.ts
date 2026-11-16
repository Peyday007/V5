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
const ORDER_RATE = new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z-]+\\s+){0,2}?(?:orders|sales|purchases|transactions|jobs|deliveries|bookings|projects|contracts)\\s+(?:a|per|each|every)\\s+(day|week|month|year)\\b`, 'gi');
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
  basis: string;
}

/** Read the deals a market can take inside `windowDays`, or null when no number is stated. */
export function readVolume(text: string, windowDays: number): VolumeReading | null {
  if (!text || !(windowDays > 0)) return null;
  const window = Math.max(1, Math.floor(windowDays));

  // An order rate states the volume directly.
  const rates = [...text.matchAll(ORDER_RATE)].map((m) => ({ n: toInt(m[1]!), per: PERIOD_DAYS[m[2]!.toLowerCase()]! })).filter((one) => one.n > 0);
  if (rates.length > 0) {
    const slowest = rates.map((one) => one.n / one.per).sort((a, b) => a - b)[0]!;
    const deals = Math.floor(slowest * window);
    if (deals >= 1) return { deals, buyers: null, everyDays: null, basis: `about ${Math.round(slowest * 30)} orders a month are stated, so ${deals} in ${window} days` };
  }

  const counts = [...text.matchAll(BUYER_COUNT)]
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
