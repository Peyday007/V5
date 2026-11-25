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
 *     credited one purchase in the window — never more;
 *   * a rate whose subject is "each" in the clause after a count ("2,400 movers
 *     are licensed; each buys 10 leads a month") is that count's per-unit
 *     rate, and a vague per-unit count ("several applications a week") is read
 *     at its low end, 2, and the basis says so;
 *   * a transaction count over a trailing span ("2,300 sales in the last 12
 *     months") is the market's purchase rate, shared among its sellers;
 *   * the supply side is never a buyer: sellers, vendors, the count a sales
 *     figure is spread "across", units "offering the same service" or
 *     "competing", and a count of results, pages, followers or listings.
 *
 * Its failure mode is missing a volume, never inventing one: shorthand like
 * "thousands of buyers" states no number and reads as unknown.
 */

const BUYER_WORDS =
  'buyers|businesses|companies|firms|customers|clients|households|homeowners|stores|shops|retailers|restaurants|practices|offices|owners|landlords|managers|agencies|contractors|organizations|organisations|members|accounts|venues|schools|clinics|dealers|dealerships|properties|operators|brokers|merchants|hotels|salons|studios|nonprofits|charities|teams|users|subscribers|employers|carriers|farms|wineries|breweries|builders|fleets|hospitals|pharmacies|gyms|churches|associations|shippers|distributors|manufacturers|wholesalers|families|parents|drivers|freelancers|creators|authors|publishers|photographers|realtors|agents|lawyers|attorneys|dentists|physicians|therapists|coaches|boards|homeowners|tenants|establishments|advertisers|producers|facilities|investors|communities|brokerages|proprietors|advisors|advisers|planners|consultants|founders|shoppers|consumers';

const COUNT = '(\\d{1,3}(?:,\\d{3})+|\\d+)';
// The words between a count and what it counts may carry an ampersand or an apostrophe:
// "12 B&B owners" and "40 children's clinics" count buyers as "12 inn owners" does (round 13).
// A compound buyer noun may list its kinds with commas: "6,800 roofing, landscaping and plumbing businesses"
// counts businesses (2026-11-24 investigation: 19 of 30 published-style market sizes read as unsized without it).
const BETWEEN = "(?:[A-Za-z&'’-]+,?\\s+){0,7}?";
const BUYER_COUNT = new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+${BETWEEN}(?:${BUYER_WORDS})\\b`, 'gi');
/** A count, then in the same sentence "each buys / pays / orders …": the counted units are buyers. */
const EACH_BUYS = new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,5}?[A-Za-z&'’-]+\\b[^.;!?]{0,120}[;,]\\s*(?:and\\s+)?(?:they\\s+)?each(?:\\s+one)?\\s+(?:buys?|pays?|purchases?|orders?|subscribes?|signs?|needs?)\\b`, 'i');
const RATE_NOUNS = 'orders|sales|purchases|transactions|jobs|deliveries|bookings|projects|contracts|renewals|entries|registrations|applications|filings|enrolments|enrollments|leads';
/** A vague count of a per-unit rate, read at its low end (2); never a count of buyers. */
const VAGUE = 'several|a few|a couple of|a couple|multiple|a handful of';
/** A rate's count: a stated number, or (only in per-unit forms) a vague one. Group 1. */
const RATE_COUNT = `(\\d{1,3}(?:,\\d{3})+|\\d+|${VAGUE})`;
function rateCount(text: string): number {
  return /^\d/.test(text) ? toInt(text) : 2;
}
const PER = '(?:a|per|each|every)';
const PERIODS = '(day|week|month|year)';
/** "<count> [≤2 words] <orders> a/per <period>": a stated rate; group 1 the count, 2 the period. */
const RATE_PHRASE = `(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,2}?(?:${RATE_NOUNS})\\s+${PER}\\s+${PERIODS}\\b`;
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
const subjectRate = (buyerWords: string) =>
  new RegExp(
    `(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,4}?(?:${buyerWords})` +
      `(?:\\s+(?:in|within|on|of|around|near|throughout|listed|registered|licensed)\\s+(?:[A-Za-z&'’-]+\\s+){0,1}?[A-Za-z-]+)?` +
      `\\s+(?:(${ADVERBS})\\s+)?([A-Za-z-]+)\\s+(?:${APPROX}\\s+)?${RATE_COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,2}?(?:${RATE_NOUNS})\\s+${PER}\\s+${PERIODS}\\b` +
      `(\\s+(?:each|apiece|between them|in total|combined|together|altogether|in all|overall))?`,
    'gi',
  );
/**
 * "each" as the subject of a rate, in the clause after a count: "2,400 movers
 * are licensed; each buys about 10 leads a month", "...and they each file
 * several applications a week". Groups: 1 the verb, 2 the rate count, 3 the
 * period. The units are the nearest buyer count stated before it.
 */
const EACH_SUBJECT = new RegExp(
  `(?:^|[.;:,]\\s+|\\b(?:and|but)\\s+)(?:they\\s+)?(?:each|every\\s+one)(?:\\s+(?:one|of\\s+them))?\\s+(?:(?:typically|usually|regularly|routinely|normally|generally|currently|also)\\s+)?` +
    `([A-Za-z-]+)\\s+(?:${APPROX}\\s+)?${RATE_COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,2}?(?:${RATE_NOUNS})\\s+${PER}\\s+${PERIODS}\\b`,
  'gi',
);
/**
 * A transaction count over a trailing span: "2,300 sales of comparable
 * workbooks in the last 12 months". The market's purchases in that span,
 * never a count of buyers. Groups: 1 the count, 2 the span's length, 3 its unit.
 */
const SPAN_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, six: 6, nine: 9, twelve: 12, eighteen: 18, 'twenty-four': 24 };
const SPAN_TOTAL = new RegExp(
  `(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,2}?(?:${RATE_NOUNS})(?:\\s+of(?:\\s+[A-Za-z&'’-]+){1,6}?)?\\s+(?:in|over|during|within)\\s+(?:the\\s+)?(?:last|past|previous|prior|trailing|latest)\\s+(?:(\\d+|${Object.keys(SPAN_NUMBERS).join('|')})\\s+)?(day|week|month|quarter|year)s?\\b`,
  'gi',
);
/** Words that, standing where the verb is, make the subject's rate ambiguous or someone else's. */
const NOT_A_VERB = /^(?:and|or|but|plus|with|without|of|to|for|from|in|at|on|by|across|among|between|over|under|than|that|which|who|whose|where|while|whereas|are|is|were|was|be|been|use|using|hire|hiring|share|sharing|need|want|via|through|per|up|vs|versus|like|including)$/i;
const COLLECTIVE = /^(?:collectively|together|jointly|combined|between them|in total|altogether|in all|overall)$/i;
/** A rate distributed over named units: "20 deliveries a week from each of (the) 35 pharmacies". */
const EACH_OF_RATE = new RegExp(
  `${RATE_PHRASE}\\s+(?:(?:at|from|for|in|by|to|with)\\s+)?each\\s+of\\s+(?:the\\s+|their\\s+|its\\s+|our\\s+|these\\s+|those\\s+)?${COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,4}?(?:${BUYER_WORDS})\\b`,
  'gi',
);
/** A rate per unit, with the period after or before the unit: "20 deliveries a week per pharmacy", "20 deliveries per pharmacy a week". */
const PER_UNIT_AFTER = new RegExp(`${RATE_PHRASE}\\s+(?:per|from each|at each|for each|in each)\\s+([A-Za-z-]+)`, 'gi');
const PER_UNIT_BEFORE = new RegExp(
  `(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,2}?(?:${RATE_NOUNS})\\s+(?:per|from each|at each|for each|in each)\\s+([A-Za-z-]+)\\s+${PER}\\s+${PERIODS}\\b`,
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
const HOLDER_WORDS = /\b((?:[a-z-]{3,}\s+){0,2}[a-z]{3,})\s+(?:owners?|operators?|managers?|proprietors?|holders?|keepers?|buyers?|purchasers?)\b/gi;

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
 * singular and plural.
 *
 * A buyer named for what it buys is held the same way (planningReliability
 * round 12): a payer of "Used-boat buyers" is one buyer per boat being bought,
 * so "1,100 used boats are under accepted offers" counts them exactly as
 * "1,100 boat owners" would count a payer of boat owners. Before, only the
 * head "buyers" counted, and a market research had sized in the thing bought
 * read as unsized. Pure.
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
  /*
   * A parenthesis lists the payer's kinds, never its head (decisive-10 d03,
   * 2026-11-25): "Michigan local governments (cities, townships, counties)"
   * is counted by "nearly 200 Michigan local governments" — before, the head
   * was read as "counties)", so a market research had sized read as unsized.
   * The head is read outside the parenthesis and each listed kind is a head of
   * its own.
   */
  const inner = [...payer.matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1]!.split(/,|\s+(?:and|or)\s+/));
  const outer = payer.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (inner.length > 0) return [...new Set([outer, ...inner].flatMap((part) => payerNounWords(part.trim())))];
  const head = payer.split(/\s+(?:and|or|who|that|which|with|without|in|of|for|on|at|across|from|by|to|renting|running|using|buying|selling|needing|seeking|looking|operating|owning|managing|entering|filing|submitting|ordering|hiring|booking)\b/i)[0]!.trim();
  const word = head.split(/\s+/).pop()?.toLowerCase().replace(/[^a-z-]/g, '') ?? '';
  // The same refusal as `industryBuyerWords`: a word for what is sold or done never counts buyers.
  if (word.length < 4 || !/^[a-z][a-z-]*s$/.test(word) || word.endsWith('ss') || NOT_A_BUYER_NOUN.test(word)) return [];
  const one = word.replace(/(?:ies)$/, 'y').replace(/(?<=(?:s|x|ch|sh))es$/, '').replace(/s$/, '');
  return [...new Set([word, one])];
}

/**
 * The head noun of every kind of buyer a payer lists, as count words (planner residuals,
 * 2026-11-25): a payer of "Small contractors, landscapers and cleaners" is counted by "900
 * landscapers" as much as by "900 contractors", and a payer of "Workers and residents at
 * warehouses, auto shops and apartment laundries" — reached one site at a time — by "2,000
 * warehouses". Before, only the payer's first head counted ("Small contractors,
 * landscapers" ended on "landscapers"; "Workers and residents …" on "workers"), so a market
 * sized in another listed kind read as unsized. Each listed segment is cut at its first
 * qualifier exactly as `payerNounWords` cuts the whole ("Contractors renting
 * mini-excavators" is still contractors), and the same refusals apply. Pure.
 */
export function payerListWords(payer: string | null | undefined): string[] {
  if (!payer) return [];
  const out = new Set<string>();
  for (const segment of payer.split(/\s*,\s*|\s+(?:and|or|plus|&|at)\s+/i)) {
    if (!segment.trim()) continue;
    for (const w of payerNounWords(segment)) out.add(w);
  }
  return [...out];
}

/**
 * The payer's content words, singular, for judging whether a licensed or registered
 * population is the payer's: "Assisted-living and memory-care communities in metro
 * Detroit" yields assisted-living, memory-care, communitie(s)→community… Words that name no
 * kind of buyer — places, sizes, connectives — never match. Pure.
 */
const NOT_A_KIND = /^(?:the|and|for|with|without|that|who|which|their|them|they|from|into|over|under|small|large|local|independent|metro|area|areas|region|regional|national|nationally|state|county|counties|city|cities|town|towns|north|south|east|west|new|active|other|some|many|most|more|than|such|like|each|every|about|around|needing|seeking|looking|wanting|using|people|individuals)$/;
function singularOf(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:s|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}
function kindWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const [i, raw] of (text.match(/[A-Za-z][A-Za-z-]{3,}/g) ?? []).entries()) {
    // A capitalized word past the first names a place or an agency ("Detroit", "FMCSA"), never a kind of buyer.
    if (i > 0 && /^[A-Z]/.test(raw)) continue;
    const w = raw.toLowerCase();
    if (NOT_A_KIND.test(w)) continue;
    out.add(singularOf(w));
  }
  return out;
}

/**
 * The largest count a reader takes. A consumer platform's buyers are counted in hundreds of
 * millions ("200 million monthly shoppers"), so the bound sits above every real buyer
 * population and below the figures that are not counts at all.
 */
const MAX_COUNT = 1_000_000_000;

/** A licence, registration or operating authority: what a licensed population is counted in. */
const HELD_LICENCE_NOUNS = 'licen[cs]es|registrations|authorities|permits|certifications|certificates|charters';
const LICENCE_SINGULAR = /^(?:licen[cs]e|registration|authority|permit|certification|certificate|charter)$/;
/** A sentence naming a licensing or registering act or record. */
const LICENSING_ACT = /\b(?:licen[cs](?:e|es|ed|ing|ee|ees)|regist(?:ry|ries|er|ers|ered|ration|rations)|permit(?:s|ted)?|authorit(?:y|ies)|certif(?:y|ies|ied|ication|ications)|charter(?:s|ed)?|accredit(?:s|ed|ation)?|grants?|issues?|issued)\b/i;

/**
 * A population an authority licenses or registers, counted as the payer when it is the
 * payer (planner residuals, 2026-11-25). "LARA licenses about 420 assisted-living and adult
 * foster care homes" counts a payer of assisted-living communities; "the contractor registry
 * holds over 40,000 active licenses" counts a payer of contractors, one licence to a
 * holder; "FMCSA grants about 4,000 new for-hire motor carrier authorities every month,
 * most to fleets of one to five trucks" is a flow of new holders, so a payer of small
 * fleets with that authority gains 4,000 new buyers a month. The licensed noun phrase (or,
 * for a count of licences themselves, the sentence naming their holder) must share a kind
 * word with the payer: a licensed population that is not the payer — the sellers'
 * licences, a count of permits for something else — never counts. Each licence is one
 * holder, which a holder of several only overstates, so the count is read as stated and the
 * smallest such count is taken, as with every count. Returns the count and, for a flow, its
 * period's length in days. Pure.
 */
const LICENSED_COUNT = new RegExp(
  `(?<![$£€\\d.,])${COUNT}\\s+((?:[A-Za-z&'’-]+,?\\s+){0,7}?)([A-Za-z-]{3,}s)\\b((?:\\s+[A-Za-z-]+){0,3}?\\s+(?:a|per|each|every)\\s+(day|week|month|quarter|year)\\b)?`,
  'gi',
);
interface LicensedPopulation {
  n: number;
  flowDays: number | null;
  basis: string;
  /** Where the count's phrase stands, so a flow's own period is not read as a purchase frequency. */
  at: number;
  end: number;
}
function licensedPopulations(text: string, payer: string | null): LicensedPopulation[] {
  if (!payer) return [];
  const payerKinds = kindWords(payer);
  if (payerKinds.size === 0) return [];
  const out: LicensedPopulation[] = [];
  for (const m of text.matchAll(LICENSED_COUNT)) {
    const at = m.index ?? 0;
    if (/^\s*%/.test(text.slice(at + m[1]!.length))) continue;
    const sentence = sentenceAt(text, at);
    if (!LICENSING_ACT.test(sentence.text)) continue;
    const head = m[3]!.toLowerCase();
    if (!/s$/.test(head) || NOT_A_BUYER_NOUN.test(head) || MEASURE_NOUNS.test(head)) continue;
    const between = m[2]!.split(/[\s,]+/).filter(Boolean);
    if (between.some((w) => MEASURE_NOUNS.test(w))) continue;
    const end = at + m[0]!.length;
    if (SUPPLYING_AFTER.test(text.slice(end))) continue;
    if (SPREAD_ACROSS_BEFORE.test(text.slice(sentence.start, at))) continue;
    const isLicence = new RegExp(`^(?:${HELD_LICENCE_NOUNS})$`, 'i').test(head);
    // The licensed noun phrase itself must be the payer's kind; a count of licences takes its holder from the sentence.
    const phrase = isLicence ? sentence.text : `${m[2]!} ${head}`;
    // Shared with the payer, never through a word for the licence itself.
    const shared = [...kindWords(phrase)].filter((w) => payerKinds.has(w) && !LICENCE_SINGULAR.test(w));
    if (shared.length === 0) continue;
    // Licensed holders are licensed for something: a phrase with no licensing word near it is a count of something else.
    if (!isLicence && !LICENSING_ACT.test(text.slice(Math.max(sentence.start, at - 60), end + 40))) continue;
    const n = toInt(m[1]!);
    if (!(n > 0 && n < MAX_COUNT)) continue;
    const period = m[5]?.toLowerCase();
    out.push({
      n,
      flowDays: period ? PERIOD_DAYS[period]! : null,
      at,
      end,
      basis: `${n} ${isLicence ? `${head} held by the payer's kind (${shared.join(', ')})` : `licensed or registered ${head}`}${period ? ` newly granted a ${period}` : ''}`,
    });
  }
  return out;
}

/** Head nouns that name a business by what it does: "moving companies", "roofing contractors". */
const TRADE_HEAD = /^(?:companies|company|firms|firm|businesses|business|contractors|services|operators|shops|outfits|crews)$/i;

/**
 * The agent noun of the trade a payer is named for (volume reader, 2026-11-23):
 * a payer of "Licensed local moving companies" is counted by "2,400 licensed
 * movers" exactly as by "2,400 moving companies", and "roofing contractors" by
 * "roofers". Only a word in -ing standing directly before a business head
 * noun is taken, as its stem plus -er, singular and plural. Pure.
 */
export function payerAgentWords(payer: string | null | undefined): string[] {
  if (!payer) return [];
  const words = payer.toLowerCase().match(/[a-z-]+/g) ?? [];
  const out = new Set<string>();
  for (const [i, w] of words.entries()) {
    const next = words[i + 1];
    if (!next || !TRADE_HEAD.test(next) || !/^[a-z]{3,}ing$/.test(w)) continue;
    const agent = `${w.slice(0, -3)}er`;
    out.add(agent);
    out.add(`${agent}s`);
  }
  return [...out];
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
  /** The vague word a per-unit count was read from at its low end, when it was one. */
  vague?: string;
}

/** Words between a count and its buyer word that say the count is of something else: results, pages, followers. */
const MEASURE_NOUNS = /^(?:results?|pages?|webpages?|websites?|sites?|followers?|views?|impressions?|searches|queries|hits|posts?|likes?|reviews?|listings?|ads|adverts?|mentions?|downloads?|visits?|visitors?|clicks?|keywords?|links?|backlinks?|profiles?|articles?|ratings?)$/i;
/** After a count: the counted units sell what is sold, or compete with it — the supply side. */
const SUPPLYING_AFTER = /^\s+(?:(?:that|who|which)\s+)?(?:already\s+|also\s+|now\s+)?(?:(?:offer|sell|provide|supply|list|advertise|market)(?:s|ing)?\s+(?:the|this|that|these|those|similar|comparable|competing|equivalent|such|identical|it|them)\b|compet(?:e|es|ing)\b)/i;
/** Before a count, in its sentence: a transaction count spread "across" the units — they are its sellers. */
const SPREAD_ACROSS_BEFORE = /\b(?:sales|orders|purchases|transactions|sold)\b[^.;]*\b(?:across|among|between|from|by|split between|shared by)\s+(?:the\s+|its\s+|their\s+)?(?:about\s+|around\s+|some\s+|roughly\s+)?$/i;

/**
 * Every buyer count the text states, with where it stands. A count is refused
 * when the words before its buyer word name a measure that is not a buyer
 * ("2,100,000 results for local movers", "40,000 LinkedIn followers of
 * companies"), when the units supply what is sold ("40 agencies offering the
 * service", "12 vendors selling comparable kits"), or when a transaction count
 * is spread across them ("2,300 sales across 40 shops"): those are sellers,
 * and a seller is never a buyer.
 */
function buyerCounts(text: string, pattern: RegExp): Array<{ at: number; n: number }> {
  const out: Array<{ at: number; n: number }> = [];
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    const end = at + m[0]!.length;
    if (/^\s*%/.test(text.slice(at + m[1]!.length))) continue;
    const between = m[0]!.split(/\s+/).slice(1, -1);
    if (between.some((w) => MEASURE_NOUNS.test(w))) continue;
    if (SUPPLYING_AFTER.test(text.slice(end))) continue;
    const sentence = sentenceAt(text, at);
    if (SPREAD_ACROSS_BEFORE.test(text.slice(sentence.start, at))) continue;
    const n = toInt(m[1]!);
    if (n > 0 && n < MAX_BUYERS) out.push({ at, n });
  }
  return out;
}

/**
 * The most buyers one count may state. A consumer marketplace publishes its buyers
 * in the tens of millions ("96 million active buyers"); before, a cap of 50 million
 * read such a count as no count, and the market as unsized (2026-11-24
 * investigation, r38). A rate's own counts keep their tighter bound.
 */
const MAX_BUYERS = 2_000_000_000;

/** The sentence around a position: the text between the nearest sentence breaks. */
function sentenceAt(text: string, at: number): { start: number; text: string } {
  const before = text.slice(0, at);
  const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('; '), before.lastIndexOf('! '), before.lastIndexOf('? '), before.lastIndexOf('\n')) + 1;
  const rest = text.slice(at).search(/[.;!?](?:\s|$)|\n/);
  return { start, text: text.slice(start, rest < 0 ? text.length : at + rest) };
}

/** Every rate the text states, multiplied by a count only where each counted unit is said to do it. */
function readRates(text: string, buyerWords: string, buyerCount: RegExp): StatedRate[] {
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
    const counts = buyerCounts(sentence.text, buyerCount)
      .filter((c) => sentence.start + c.at !== at)
      .map((c) => c.n);
    put(at, plain(n, period, counts.length > 0 ? Math.min(...counts) : null));
  };
  for (const m of text.matchAll(PER_UNIT_AFTER)) perUnit(m, toInt(m[1]!), m[2]!.toLowerCase(), m[3]!);
  for (const m of text.matchAll(PER_UNIT_BEFORE)) perUnit(m, toInt(m[1]!), m[3]!.toLowerCase(), m[2]!);

  for (const m of text.matchAll(EACH_OF_RATE)) put(m.index ?? 0, plain(toInt(m[1]!), m[2]!.toLowerCase(), toInt(m[3]!)));

  // A transaction count over a trailing span is the market's rate: "2,300 sales in the last 12 months".
  for (const m of text.matchAll(SPAN_TOTAL)) {
    const length = m[2] ? (/^\d/.test(m[2]) ? toInt(m[2]) : SPAN_NUMBERS[m[2].toLowerCase()]!) : 1;
    const days = length * PERIOD_DAYS[m[3]!.toLowerCase()]!;
    const n = toInt(m[1]!);
    if (n > 0 && days > 0) byPosition.set(m.index ?? 0, { perDay: n / days, units: null, each: n, period: `${length} ${m[3]!.toLowerCase()}${length === 1 ? '' : 's'}` });
  }

  const vagueRate = (rateText: string, period: string, units: number | null): StatedRate => {
    const rate = plain(rateCount(rateText), period, units);
    return /^\d/.test(rateText) ? rate : { ...rate, vague: rateText.toLowerCase() };
  };

  // "each" as the subject in the clause after a count: that count's per-unit rate.
  const counted = buyerCounts(text, buyerCount);
  for (const m of text.matchAll(EACH_SUBJECT)) {
    const [, verb, rateText, period] = m;
    if (NOT_A_VERB.test(verb!)) continue;
    const at = m.index ?? 0;
    const before = counted.filter((c) => c.at < at);
    const units = before.length > 0 ? before[before.length - 1]!.n : null;
    const rateAt = at + m[0]!.lastIndexOf(rateText!);
    put(rateAt, vagueRate(rateText!, period!.toLowerCase(), units));
  }

  for (const m of text.matchAll(subjectRate(buyerWords))) {
    const [, unitText, adverb, verb, rateText, period, trailing] = m;
    if (NOT_A_VERB.test(verb!) || (adverb && COLLECTIVE.test(adverb)) || (trailing && COLLECTIVE.test(trailing.trim()))) continue;
    const units = toInt(unitText!);
    if (!(units > 0 && units < 50_000_000)) continue;
    // Nothing after the rate's count holds a digit, so its last occurrence is the rate's own position.
    const rateAt = (m.index ?? 0) + m[0]!.lastIndexOf(rateText!);
    put(rateAt, vagueRate(rateText!, period!.toLowerCase(), units));
  }
  return [...byPosition.values()];
}

/**
 * A published count in the form the readers below take (2026-11-24 investigation): "5 million
 * sellers" read as 2 buyers (the "2" of a later "2 million"), so a market of millions was judged
 * too small to reach a $1,200 target; "U.S." and "501(c)(3)" cut the noun phrase a count
 * belongs to. Pure; every figure keeps its value.
 */
function publishedCount(text: string): string {
  const scale: Record<string, number> = { billion: 1_000_000_000, million: 1_000_000, thousand: 1_000, b: 1_000_000_000, m: 1_000_000, k: 1_000 };
  return text
    .replace(/(\d+(?:\.\d+)?)\s*(billion|million|thousand)\b/gi, (_, n: string, unit: string) =>
      Math.round(Number(n) * scale[unit.toLowerCase()]!).toLocaleString('en-US'))
    // A published shorthand: "96.5M active buyers", "1.2B users", "40k members" (r38).
    .replace(/(?<![$£€\w.,])(\d+(?:\.\d+)?)(M|B|k|K)\b/g, (_, n: string, unit: string) =>
      Math.round(Number(n) * scale[unit.toLowerCase()]!).toLocaleString('en-US'))
    // "monthly active users" says how often they use the platform, never how often each buys.
    .replace(/\b(?:daily|weekly|monthly|yearly|annual)\s+(active|unique)\b/gi, '$1')
    .replace(/\bU\.S\.(?=\s)/g, 'US')
    .replace(/\b501\s*\(c\)\s*\(\d{1,2}\)/gi, 'tax-exempt')
    .replace(/\((?:[a-z0-9]{1,3})\)/gi, '');
}

/** Plural nouns that are never a population of buyers, as a pattern's alternatives. */
const NOT_BUYERS_LIST = `${NOT_A_BUYER_NOUN.source.replace(/^\^\(\?:|\)\$$/g, '')}|${RATE_NOUNS}|sellers|vendors|suppliers|providers|competitors|results|pages|followers|views|listings|posts|ads|visits|visitors|clicks|downloads|reviews|years|months|weeks|days|hours|dollars|times|miles`;
/**
 * A plural noun that names who holds a licence or enters a market — a person or an
 * organisation ("notaries", "carriers", "electricians", "agencies", "LLCs") — never
 * a thing registered to somebody ("2,100 kayaks are registered" counts kayak owners
 * only for a payer of kayak owners, `payerHeldWords`), nor what is sold, done or measured.
 */
const POPULATION_NOUN = `(?!(?:${NOT_BUYERS_LIST})\\b)(?:[A-Za-z&'’-]*(?:ers|ors|ists|ants|ents|ies|ians|ees|ives)|LLCs|LLPs|corporations|entities|startups|ventures)`;
const LICENSING = 'licensed|licenced|registered|certified|commissioned|accredited|permitted|bonded|chartered|credentialed|board-certified|practicing|practising';
// A licence names its holder; a registration may be a thing's (a boat's, a vehicle's), so it is not one.
const LICENCE_NOUNS = 'licenses|licences|permits|authorities|certifications|charters|commissions|credentials|endorsements';
const LICENSED_COUNTS: readonly RegExp[] = [
  // "12,400 licensed notaries", "3,100 licensed residential builders"
  new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,2}?(?:${LICENSING})\\s+(?:[A-Za-z&'’-]+\\s+){0,3}?${POPULATION_NOUN}\\b`, 'gi'),
  // "12,000 notaries (are) commissioned in Ohio", "3,000 carriers are registered"
  new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,3}?${POPULATION_NOUN}\\s+(?:(?:are|were|is)\\s+)?(?:currently\\s+|now\\s+|actively\\s+)?(?:${LICENSING})\\b`, 'gi'),
  // "6,500 active liquor licences": one holder per licence
  new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,4}?(?:${LICENCE_NOUNS})\\b`, 'gi'),
];
const CREATED = 'granted|issued|formed|registered|licensed|licenced|filed|opened|incorporated|founded|launched|started|created|certified|commissioned|approved|admitted|added|chartered|permitted|established|born|enrolled|join|joins|joined|sign up|signs up|signed up|arrive|arrives';
const CADENCE = `(?:every|each|a|per)\\s+(day|week|month|quarter|year)`;
// A flow is of entrants, or of the licences that admit them (one holder each).
const ENTRANT = `(?:${POPULATION_NOUN}|${LICENCE_NOUNS})`;
const NEW_THINGS = `new(?:ly\\s+[a-z-]+)?\\s+(?:[A-Za-z&'’-]+\\s+){0,4}?(${ENTRANT})\\b`;
const FLOWS: readonly RegExp[] = [
  // "4,000 new authorities (are granted) every month", "4,000 authorities are granted every month"
  new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+(?:${NEW_THINGS}|(?:[A-Za-z&'’-]+\\s+){0,4}?(${ENTRANT})\\s+(?:are|were|is|get|gets)\\s+(?:newly\\s+)?(?:${CREATED})\\b)[^.;!?\\d]{0,60}?\\b${CADENCE}\\b`, 'gi'),
  // "each month, about 1,500 new LLCs are formed"
  new RegExp(`\\b${CADENCE},?\\s+(?:(?:about|around|roughly|some|over|nearly|approximately|more than)\\s+)?${COUNT}\\s+${NEW_THINGS}`, 'gi'),
];

/** The buyers a stated flow of new entrants brings inside the window, the smallest flow taken; null when none is stated. */
function readFlow(text: string, window: number): VolumeReading | null {
  let best: VolumeReading | null = null;
  for (const [i, pattern] of FLOWS.entries()) {
    for (const m of text.matchAll(pattern)) {
      const [count, noun, period] = i === 0 ? [m[1]!, m[2] ?? m[3]!, m[4]!] : [m[2]!, m[3]!, m[1]!];
      const at = (m.index ?? 0) + m[0]!.indexOf(count);
      if (SUPPLYING_AFTER.test(text.slice((m.index ?? 0) + m[0]!.length))) continue;
      if (SPREAD_ACROSS_BEFORE.test(text.slice(sentenceAt(text, at).start, at))) continue;
      const n = toInt(count);
      const days = PERIOD_DAYS[period.toLowerCase()]!;
      const buyers = Math.floor((n * window) / days);
      if (!(n > 0 && n < MAX_BUYERS) || buyers < 1) continue;
      if (best && best.deals <= buyers) continue;
      best = {
        deals: buyers,
        buyers,
        everyDays: null,
        counted: 'BUYERS',
        basis: `${n} new ${noun.toLowerCase()} a ${period.toLowerCase()} are stated, so ${buyers} arrive as buyers in ${window} days, one purchase each`,
      };
    }
  }
  return best;
}

/** Read the deals a market can take inside `windowDays`, or null when no number is stated. */
export function readVolume(raw: string, windowDays: number, payer: string | null = null, industry: string | null = null): VolumeReading | null {
  if (!raw || !(windowDays > 0)) return null;
  const text = publishedCount(raw);
  const held = [...new Set([...payerHeldWords(payer), ...payerNounWords(payer), ...payerListWords(payer), ...payerAgentWords(payer), ...industryBuyerWords(industry)])].filter((w) => !new RegExp(`(?:^|\\|)${w}(?:\\||$)`).test(BUYER_WORDS));
  const buyerWords = held.length === 0 ? BUYER_WORDS : `${BUYER_WORDS}|${held.join('|')}`;
  const buyerCount = held.length === 0 ? BUYER_COUNT : new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+${BETWEEN}(?:${buyerWords})\\b`, 'gi');
  const window = Math.max(1, Math.floor(windowDays));

  // An order rate states the volume directly; the slowest one stated is taken.
  const rates = readRates(text, buyerWords, buyerCount);
  if (rates.length > 0) {
    const slowest = rates.sort((a, b) => a.perDay - b.perDay)[0]!;
    const deals = Math.floor(slowest.perDay * window);
    if (deals >= 1) {
      const monthly = Math.round(slowest.perDay * 30);
      const vague = slowest.vague ? ` ("${slowest.vague}" read at its low end, ${slowest.each})` : '';
      return slowest.units === null
        ? { deals, buyers: null, everyDays: null, counted: 'ORDERS', basis: `about ${monthly} orders a month are stated${vague}, so ${deals} in ${window} days` }
        : {
            deals,
            buyers: slowest.units,
            everyDays: null,
            counted: 'ORDERS',
            basis: `${slowest.units} units each doing ${slowest.each} a ${slowest.period} are stated${vague}, about ${monthly} orders a month, so ${deals} in ${window} days`,
          };
    }
  }

  /*
   * A flow of new entrants ("about 4,000 new authorities are granted every month",
   * "1,500 new LLCs are formed each month") is a population of buyers who arrive
   * through the window: N × window ÷ period of them, each a buyer once. Before, a
   * flow read as no count at all, or as a stock of buyers each buying on the
   * flow's cadence (2026-11-24 investigation: licence flows read as unsized).
   */
  const flow = readFlow(text, window);
  if (flow) return flow;

  let counts = buyerCounts(text, buyerCount).map((c) => c.n);
  /*
   * A count of licensed, registered or certified entities ("12,400 licensed
   * notaries in the state", "3,000 carriers are registered", "6,500 active liquor
   * licences") counts the holders of the licence, one buyer each, whatever the
   * noun: a register is a published buyer population (2026-11-24 investigation).
   * Read only when no buyer word counted anything, so every reading the
   * vocabulary already made is unchanged; the supply side is still refused.
   */
  /*
   * With a payer named, a register counts only when it shares the payer's kind
   * (merge of the two licence readers, 2026-11-25): "5,000 food-truck permits"
   * is not a market of dental office managers. Without a payer the register is
   * read as before.
   */
  const payerKinds = payer ? kindWords(payer) : null;
  const ofPayer = (at: number): boolean => {
    if (!payerKinds || payerKinds.size === 0) return true;
    const near = kindWords(text.slice(at, at + 100).replace(/^\S+\s*/, 'x '));
    return [...near].some((w) => payerKinds.has(w));
  };
  if (counts.length === 0) counts = [...LICENSED_COUNTS].flatMap((pattern) => buyerCounts(text, pattern)).filter((c) => ofPayer(c.at)).map((c) => c.n);
  /*
   * A count whose own sentence goes on to say each of them buys ("About 800 active Detroit
   * investors are listed on BiggerPockets; each buys one") counts buyers whatever its noun:
   * the text itself names them as buyers. Before, only a noun from the buyer vocabulary or the
   * payer's own words counted, so an evidenced market of "investors" or "facilities" read as
   * unsized and left MARKET_VOLUME open (2026-11-24 investigation: 3 of 10 fresh requests).
   */
  /*
   * A population an authority licenses or registers counts the payer when it is the payer's
   * kind, and a flow of new licences per period is that many new buyers each period, so the
   * window holds the flow's share of them — never the stock of every holder.
   */
  const licensed = licensedPopulations(text, payer).map((p) => ({
    ...p,
    n: p.flowDays === null ? p.n : Math.floor((p.n * window) / p.flowDays),
  })).filter((p) => p.n >= 1);
  const stated = counts;
  counts = [...counts, ...licensed.map((p) => p.n)];
  if (counts.length === 0) {
    const each = EACH_BUYS.exec(text);
    if (each) counts = [toInt(each[1]!)];
  }
  if (counts.length === 0) return null;
  const counted = Math.min(...counts);
  const share = buyingShare(text);
  const buyers = share === null ? counted : Math.floor(counted * share);
  if (buyers < 1) return null;
  const from = stated.includes(counted) ? undefined : licensed.find((p) => p.n === counted);
  const of = (share === null ? '' : ` (${Math.round(share * 100)}% of ${counted} stated to buy)`) + (from ? ` (${from.basis}${from.flowDays === null ? '' : `, ${counted} in ${window} days`})` : '');

  // A flow's own period ("4,000 new authorities every month") says how often buyers arrive, never how often one buys.
  // Nor does a frequency naming the counted population ("200 million monthly shoppers" are counted over a month, not buying monthly).
  const cadence = (from && from.flowDays !== null ? text.slice(0, from.at) + text.slice(from.end) : text).replace(
    new RegExp(`\\b(?:daily|weekly|monthly|yearly|annual)\\s+(?:active\\s+|unique\\s+)?(?=(?:${buyerWords})\\b)`, 'gi'),
    '',
  );
  let everyDays: number | null = null;
  const times = TIMES.exec(cadence);
  if (times) {
    const n = times[1] ? toInt(times[1]) : /^twice$/i.test(times[2]!) ? 2 : 1;
    everyDays = PERIOD_DAYS[times[3]!.toLowerCase()]! / Math.max(1, n);
  } else for (const [pattern, days] of WORD_DAYS) if (pattern.test(cadence)) { everyDays = days; break; }
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
  const pattern = new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,5}?(?:${words})\\b(?!\\s*%)(?:\\s+${PER}\\s+(day|week|month|quarter|year)\\b)?`, 'gi');
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
  if (best) return best;
  if (!/^(?:bids?|tenders?)$/i.test(unit)) return null;
  return readPostedWorkVolume(text, window, unit) ?? readSolicitorVolume(text, window, unit);
}

/** The work a buyer puts out to bid, counted by what is awarded rather than by the solicitation. */
const POSTED_WORK = 'contracts|jobs|projects|work orders|routes';
/** Words saying the counted work is open to bidders now, not work already won or done. */
const OPEN_TO_BID = /\b(?:posted|advertised|published|out\s+(?:to|for)\s+(?:bid|bids|tender)|open\s+(?:to|for)\s+(?:bid|bids|bidding|tender)|up\s+for\s+(?:bid|bids|tender)|(?:put|going)\s+out\s+to\s+(?:bid|tender)|on\s+(?:a|the)\s+(?:[a-z-]+\s+){0,3}?bid\s+board|for\s+award|to\s+be\s+awarded|being\s+(?:bid|tendered))\b/i;
/** Words saying the counted work was already won, lost or done: a record, never an open trial. */
const CLOSED_WORK = /\b(?:won|lost|awarded\s+(?:to|us)|completed|delivered|signed|held|ran|finished)\b/i;

/**
 * Solicitations counted by the work they award (planningReliability round 12):
 * "45 plowing contracts are posted on the regional bid board for award" states
 * 45 chances to bid exactly as "45 RFQs" does — each contract open to bidders
 * is one trial of a win rate measured per bid. Read only for a rate measured
 * per bid or tender, and only when the count's own sentence says the work is
 * open to bidders (posted, out to bid, for award) and never that it was won or
 * done; a period after the count is a rate over the window, a named span
 * longer than the window is cut to the window's share, exactly as a trial
 * count is (`readTrialVolume`). Null otherwise. Pure.
 */
function readPostedWorkVolume(text: string, window: number, unit: string): VolumeReading | null {
  const pattern = new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+(?:[A-Za-z&'’-]+\\s+){0,5}?(?:${POSTED_WORK})\\b(?!\\s*%)(?:\\s+${PER}\\s+(day|week|month|quarter|year)\\b)?`, 'gi');
  let best: VolumeReading | null = null;
  for (const m of text.matchAll(pattern)) {
    const count = toInt(m[1]!);
    if (!(count > 0 && count < 50_000_000)) continue;
    const sentence = sentenceAt(text, m.index ?? 0);
    const after = sentence.text.slice((m.index ?? 0) - sentence.start);
    if (!OPEN_TO_BID.test(after) || CLOSED_WORK.test(after)) continue;
    const rate = m[2] ?? SENTENCE_RATE.exec(text.slice((m.index ?? 0) + m[0]!.length))?.[1];
    let prospects: number;
    let basis: string;
    if (rate) {
      const period = rate.toLowerCase();
      prospects = Math.floor((count * window) / PERIOD_DAYS[period]!);
      basis = `${count} pieces of work put out to bid a ${period} are stated, so ${prospects} ${unit} opportunities in ${window} days, each one trial of the measured rate`;
    } else {
      const named = SPAN.exec(sentence.text);
      const days = named ? (named[1] ? SPAN_DAYS[named[1].toLowerCase()]! : 30) : null;
      const cut = days !== null && window < days;
      prospects = cut ? Math.floor((count * window) / days) : count;
      basis = cut
        ? `${count} pieces of work open to bid are stated over about ${days} days, so ${prospects} ${unit} opportunities in ${window} days, each one trial of the measured rate`
        : `${count} pieces of work open to bid are stated for the window, each one trial of the measured rate`;
    }
    if (prospects < 1) continue;
    if (!best || prospects < best.deals) best = { deals: prospects, buyers: prospects, everyDays: null, counted: 'BUYERS', basis };
  }
  return best;
}

/** A verb by which a buyer puts its own work out to bid: it tenders it, bids it out, issues an RFQ for it. */
const SOLICITS = '(?:re-?)?tenders?|(?:re-?)?bids?\\s+(?:[a-z-]+\\s+){0,4}?out|puts?\\s+(?:[a-z-]+\\s+){0,4}?(?:out\\s+)?(?:to|for)\\s+(?:bid|bids|tender)|issues?\\s+(?:an?\\s+)?(?:RFQ|RFP|RFT|tender|invitation\\s+to\\s+bid)s?|solicits?\\s+bids';
const SOLICITOR_RATE = new RegExp(`(?<![$£€\\d.,])${COUNT}\\s+((?:[A-Za-z&'’-]+\\s+){1,6}?)(?:${SOLICITS})\\b[^.;\\d]*?\\b${PER}\\s+(week|month|quarter|year)\\b`, 'gi');

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
