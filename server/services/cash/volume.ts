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
 *     the smallest such count is taken; the payer's own head noun is such a
 *     word ("260 exhibitors" for a payer of "Expo exhibitors"), and a stated
 *     share of the counted who buy ("60% rent their booth") narrows it;
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
const RATE_NOUNS = 'orders|sales|purchases|transactions|jobs|deliveries|bookings|projects|contracts|renewals';
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
const TIMES = /(?:(\d+)\s*(?:times|x)|\b(once|twice))\s+(?:a|per|each|every)\s+(week|month|quarter|year)\b/i;
/** Words saying a cycle's purchases fall due spread through it rather than together. */
const SPREAD = /\b(?:evenly|spread|staggered|uniformly|rolling|throughout the (?:year|month|quarter)|through the (?:year|month|quarter)|across the (?:year|month|quarter)|year-round)\b/i;
/** A frequency stated as a floor: "at least once a year", "no less than twice a year", "once a year or more". */
const MINIMUM_FREQUENCY =
  /\b(?:at least|no less than|not less than|(?:a )?minimum of)\s+(?:(?:\d+\s*(?:times|x)|once|twice)\s+(?:a|per|each|every)\s+(?:week|month|quarter|year)|daily|weekly|monthly|quarterly|yearly|annually)\b|\b(?:(?:\d+\s*(?:times|x)|once|twice)\s+(?:a|per|each|every)\s+(?:week|month|quarter|year)|daily|weekly|monthly|quarterly|yearly|annually)\s+or\s+more\b/i;
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
const HOLDER_WORDS = /\b((?:[a-z-]{3,}\s+){0,2}[a-z]{3,})\s+(?:owners?|operators?|managers?|proprietors?|holders?|keepers?)\b/gi;

/**
 * The things a payer is named for holding, as count words: a payer of "Recreational
 * boat owners" is one buyer per boat, so "3,400 boats are registered" counts buyers
 * exactly as "3,400 boat owners" would. The nouns of the compound before the
 * holder word are each taken (planningReliability round 9): a payer of "Ski area
 * revenue managers" is one buyer per ski area, and "Warehouse facility
 * managers" one per warehouse, so "470 ski areas" and "220 warehouses" count
 * them; before, only "revenue" and "facility" (pluralized "facilitys") were
 * read, and a market research had sized stayed unsized. Never more than the
 * three words before the holder word, never a stop word or a size adjective,
 * singular and plural. Pure.
 */
export function payerHeldWords(payer: string | null | undefined): string[] {
  if (!payer) return [];
  const out = new Set<string>();
  for (const m of payer.matchAll(HOLDER_WORDS)) {
    const words = m[1]!.toLowerCase().split(/\s+/);
    for (const [i, w] of words.entries()) {
      if (/^(?:the|and|or|of|at|in|to|for|with|who|that|small|large|local|independent|business|property|home)$/.test(w)) continue;
      // Further out than the head, an adjective ("recreational", "licensed") describes the buyer and never counts it.
      if (i < words.length - 1 && /(?:al|ive|ous|ful|ent|ed|ing|ary)$/.test(w)) continue;
      const one = w.endsWith('s') ? w.slice(0, -1) : w;
      out.add(one);
      out.add(/(?:s|x|ch|sh)$/.test(one) ? `${one}es` : /[^aeiou]y$/.test(one) ? `${one.slice(0, -1)}ies` : `${one}s`);
    }
  }
  return [...out];
}

/**
 * The payer's own head noun, as count words (planningReliability hv3-20,
 * 2026-11-22): a payer of "Expo exhibitors" is counted by "260 confirmed
 * exhibitors" exactly as a payer of "stores" is by "100 stores". The head is
 * the last word before the payer's first qualifier ("Contractors renting
 * mini-excavators" is contractors, never mini-excavators), singular and
 * plural. Pure.
 */
export function payerNounWords(payer: string | null | undefined): string[] {
  if (!payer) return [];
  const head = payer.split(/\s+(?:and|or|who|that|which|with|without|in|of|for|on|at|across|from|by|to|renting|running|using|buying|selling|needing|seeking|looking|operating|owning|managing)\b/i)[0]!.trim();
  const word = head.split(/\s+/).pop()?.toLowerCase().replace(/[^a-z-]/g, '') ?? '';
  // The same refusal as `industryBuyerWords`: a word for what is sold or done never counts buyers.
  if (word.length < 4 || !/^[a-z][a-z-]*s$/.test(word) || word.endsWith('ss') || NOT_A_BUYER_NOUN.test(word)) return [];
  const one = word.replace(/(?:ies)$/, 'y').replace(/(?<=(?:s|x|ch|sh))es$/, '').replace(/s$/, '');
  return [...new Set([word, one])];
}

/**
 * A stated share of the counted buyers who buy this ("the organiser reports 60%
 * rent their booth rather than own one"): the smallest such share narrows the
 * count, because a count of a population is not a count of its buyers. A share
 * of something else — a discount, a margin, a fee, an impression share, growth —
 * is not one, and a share the text does not state is never assumed. Reading
 * fewer buyers than exist is this reader's failure mode; reading more is not.
 */
const BUYING_SHARE = /(?<![\d.])(\d{1,2}(?:\.\d+)?)\s*%\s+(?:of\s+(?:them|these|those)\s+)?(?!(?:off|discount|margin|markup|commission|fees?|tax|vat|impression|share|growth|more|less|fewer|higher|lower|increase|decrease|of|in|on|at|to|for|per|a|an|the|and|or)\b)([a-z]+)/gi;

function buyingShare(text: string): number | null {
  const shares = [...text.matchAll(BUYING_SHARE)].map((m) => Number(m[1]) / 100).filter((s) => s > 0 && s < 1);
  return shares.length ? Math.min(...shares) : null;
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
  const held = [...new Set([...payerHeldWords(payer), ...payerNounWords(payer), ...industryBuyerWords(industry)])].filter((w) => !new RegExp(`(?:^|\\|)${w}(?:\\||$)`).test(BUYER_WORDS));
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
  const counted = Math.min(...counts);
  const share = buyingShare(text);
  const buyers = share === null ? counted : Math.floor(counted * share);
  if (buyers < 1) return null;
  const of = share === null ? '' : ` (${Math.round(share * 100)}% of ${counted} stated to buy)`;

  let everyDays: number | null = null;
  const times = TIMES.exec(text);
  if (times) {
    const n = times[1] ? toInt(times[1]) : /^twice$/i.test(times[2]!) ? 2 : 1;
    everyDays = PERIOD_DAYS[times[3]!.toLowerCase()]! / Math.max(1, n);
  } else for (const [pattern, days] of WORD_DAYS) if (pattern.test(text)) { everyDays = days; break; }
  /*
   * A buyer whose purchases research says fall due spread through its cycle
   * buys inside a shorter window only when its own date falls there
   * (planningReliability round 9): 480 buyers renewing once a year "evenly
   * through the year" make about 480 × 30 / 365 = 39 purchases in a 30-day
   * window, never 480. Before, every buyer was credited one purchase whatever
   * its cycle, so a market whose due dates were stated as spread read as twelve
   * times what a month holds. A cycle stated without its timing ("each renews
   * yearly") keeps one purchase each: whether a buyer can be sold to before its
   * date is not something the text says, and the share is never guessed.
   *
   * A frequency stated as a floor ("at least once a year", "once a year or
   * more") makes the cycle the longest a buyer goes between purchases, so
   * buyers × window ÷ cycle is the fewest purchases that fall due, never the
   * most (planningReliability round 10). A floor cannot cap the market; the
   * cycle then counts as one stated without its timing.
   */
  if (everyDays !== null && everyDays > window && SPREAD.test(text) && !MINIMUM_FREQUENCY.test(text)) {
    const due = Math.max(1, Math.floor((buyers * window) / everyDays));
    return {
      deals: due,
      buyers,
      everyDays,
      counted: 'BUYERS',
      basis: `${buyers} reachable buyers${of}, each buying about every ${Math.round(everyDays)} days, so about ${due} purchase(s) fall due in ${window} days`,
    };
  }
  const purchases = everyDays === null ? 1 : Math.max(1, Math.floor(window / everyDays));
  return {
    deals: buyers * purchases,
    buyers,
    everyDays,
    counted: 'BUYERS',
    basis:
      everyDays === null
        ? `${buyers} reachable buyers${of} are stated and no repeat purchase is, so one purchase each`
        : `${buyers} reachable buyers${of}, each buying about every ${Math.round(everyDays)} days, so ${purchases} purchase(s) each in ${window} days`,
  };
}

/**
 * The words a volume can count a measured rate's own trials in, by the unit the
 * rate was measured on. A bid answers a solicitation, so a tender's win rate
 * per bid applies to the RFQs, RFPs and tenders posted; a quote answers a quote
 * request; a booking rate per click applies to clicks, and a paid rate per
 * visitor to visitors. A unit not listed here (contacts, members) is already a
 * buyer word, or is not a count a volume states.
 */
const TRIAL_WORDS: Array<[RegExp, string]> = [
  [/^(?:bids?|tenders?)$/, 'bids|tenders|RFQs|RFPs|RFTs|solicitations|requests for quotes|requests for proposals|requests for tender|invitations to bid|bid opportunities'],
  [/^(?:quotes?|quotations?|estimates?)$/, 'quote requests|requests for quotes|RFQs|estimate requests'],
  [/^proposals?$/, 'RFPs|requests for proposals|proposal requests'],
  [/^clicks?$/, 'clicks'],
  [/^visitors?$/, 'visitors|visits'],
];
const SPAN_DAYS: Record<string, number> = { day: 1, week: 7, fortnight: 14, month: 30, quarter: 91, year: 365 };
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const SPAN = new RegExp(`\\b(?:this|next|in|during|over|for)\\s+(?:the\\s+)?(?:(day|week|fortnight|month|quarter|year)|(${MONTHS}))\\b`, 'i');
const SENTENCE_RATE = new RegExp(`^[^.;]*?\\b${PER}\\s+(day|week|month|quarter|year)\\b`, 'i');

/**
 * The prospects a measured rate applies to, when research stated the volume in
 * the rate's own trial unit (planningReliability round 6): "60 inspection RFQs
 * a month" for a win rate per bid, "9,000 forecast clicks this November" for a
 * booking rate per click. Each trial is one chance at a deal, so the count is
 * read as prospects (BUYERS), never as deals — the measured rate still decides
 * how many of them pay, and `prospectsAsked` still bounds it. A count stated
 * per period is a rate over the window; a count stated for a named span (a
 * month, "this week") longer than the window is cut to the window's share of
 * it, never stretched; a count with no span is the window's. Null when the
 * unit has no trial words or the text states no such count. Pure.
 */
export function readTrialVolume(text: string, windowDays: number, unit: string): VolumeReading | null {
  if (!text || !(windowDays > 0)) return null;
  const words = TRIAL_WORDS.find(([pattern]) => pattern.test(unit.toLowerCase()))?.[1];
  if (!words) return null;
  const window = Math.max(1, Math.floor(windowDays));
  const pattern = new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z-]+\\s+){0,5}?(?:${words})\\b(?!\\s*%)(?:\\s+${PER}\\s+(day|week|month|quarter|year)\\b)?`, 'gi');
  let best: VolumeReading | null = null;
  for (const m of text.matchAll(pattern)) {
    const count = toInt(m[1]!);
    if (!(count > 0 && count < 50_000_000)) continue;
    let prospects: number;
    let basis: string;
    // A period stated after the count in its own sentence ("12 tenders are posted each week") is a rate too.
    const rate = m[2] ?? SENTENCE_RATE.exec(text.slice((m.index ?? 0) + m[0]!.length))?.[1];
    if (rate) {
      const period = rate.toLowerCase();
      prospects = Math.floor((count * window) / PERIOD_DAYS[period]!);
      basis = `${count} ${unit} opportunities a ${period} are stated, so ${prospects} in ${window} days, each one trial of the measured rate`;
    } else {
      const named = SPAN.exec(sentenceAt(text, m.index ?? 0).text);
      const days = named ? (named[1] ? SPAN_DAYS[named[1].toLowerCase()]! : 30) : null;
      const cut = days !== null && window < days;
      prospects = cut ? Math.floor((count * window) / days) : count;
      basis = cut
        ? `${count} ${unit} are stated over about ${days} days, so ${prospects} in ${window} days, each one trial of the measured rate`
        : `${count} ${unit} are stated for the window, each one trial of the measured rate`;
    }
    if (prospects < 1) continue;
    if (!best || prospects < best.deals) best = { deals: prospects, buyers: prospects, everyDays: null, counted: 'BUYERS', basis };
  }
  return best ?? (/^(?:bids?|tenders?)$/i.test(unit) ? readSolicitorVolume(text, window, unit) : null);
}

/** A verb by which a buyer puts its own work out to bid: it tenders it, bids it out, issues an RFQ for it. */
const SOLICITS = '(?:re-?)?tenders?|(?:re-?)?bids?\\s+(?:[a-z-]+\\s+){0,4}?out|puts?\\s+(?:[a-z-]+\\s+){0,4}?(?:out\\s+)?(?:to|for)\\s+(?:bid|bids|tender)|issues?\\s+(?:an?\\s+)?(?:RFQ|RFP|RFT|tender|invitation\\s+to\\s+bid)s?|solicits?\\s+bids';
const SOLICITOR_RATE = new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+((?:[A-Za-z-]+\\s+){1,6}?)(?:${SOLICITS})\\b[^.;\\d]*?\\b${PER}\\s+(week|month|quarter|year)\\b`, 'gi');

/**
 * Tenders counted by who issues them (planningReliability round 8): "140
 * communities tender their contract each year" states 140 solicitations a
 * year exactly as "140 tenders a year" does — each counted buyer puts its own
 * work out to bid once a period, and every one of those is a trial of a win
 * rate per bid. Read only for a rate measured per bid or tender, only when the
 * count is the subject of a soliciting verb with a stated period, and only as
 * a rate over the window: a once-a-year tender inside a 120-day window is a
 * third of the buyers, never all of them. Null otherwise. Pure.
 */
function readSolicitorVolume(text: string, window: number, unit: string): VolumeReading | null {
  let best: VolumeReading | null = null;
  for (const m of text.matchAll(SOLICITOR_RATE)) {
    const count = toInt(m[1]!);
    if (!(count > 0 && count < 50_000_000)) continue;
    // A count of tenders is the plain reading's; here the subject is who issues them.
    if (/\b(?:bids?|tenders?|RFQs?|RFPs?|solicitations?)\s*$/i.test(m[2]!)) continue;
    const period = m[3]!.toLowerCase();
    const prospects = Math.floor((count * window) / PERIOD_DAYS[period]!);
    if (prospects < 1) continue;
    const basis = `${count} buyers each putting the work out to bid once a ${period} are stated, so ${prospects} ${unit} opportunities in ${window} days, each one trial of the measured rate`;
    if (!best || prospects < best.deals) best = { deals: prospects, buyers: prospects, everyDays: null, counted: 'BUYERS', basis };
  }
  return best;
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
