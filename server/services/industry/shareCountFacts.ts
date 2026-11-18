/**
 * A close rate and a buyer count, read from a constructed round's claim only
 * where the wording leaves no doubt (R3, 2026-11-18, goal
 * wst_7b4fcbb5f2384f31b6c3: every constructed arrangement read its close rate
 * and "deals the market can take" as UNKNOWN, because no fact fed the demand
 * side's `conversion` or `buyers`).
 *
 * The plan reads two construction facts for them (`constructionObservations`,
 * cash/construct.ts): `account_win_rate` as `conversion`, "share of reached
 * buyers who agree", and `accounts_reachable` as `buyers`, "buyers who have
 * the need" (quant/mechanism.ts). So exactly two wordings file:
 *
 *   * a share of buyers approached or offered who bought — "18% of the
 *     businesses contacted signed", "a close rate of 12%";
 *   * a count of buyers of the round's own type in a stated market — "There
 *     are 3,400 dental practices in Texas".
 *
 * Everything else is refused, naming why: a share of buyers who had already
 * bought ("20% of households who signed … had never considered solar") is not
 * a close rate; a reply rate is not one either; a percentage change in a price
 * or cost is no rate of buyers at all; a count of things installed or sold, or
 * of buyers over a period ("120 new installations in six months"), is a
 * market's throughput, not how many buyers it holds. A claim stating two
 * percentages is refused as ambiguous rather than guessed at. Nothing is
 * multiplied, divided or converted: the figure filed is the figure stated,
 * a percentage as its share of one. Pure.
 */
export type ShareCountFact = { key: 'account_win_rate' | 'accounts_reachable'; low: number; high: number; measures: string };
/** A fact, a refusal naming why, or null when the claim states neither a percentage nor a count of these buyers. */
export type ShareCountReading = ShareCountFact | { refused: string } | null;

const N = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`;
const PCT = String.raw`\s*(?:%|percent\b|per cent\b)`;
const RANGE_PCT = String.raw`${N}(?:${PCT})?(?:\s*(?:-|–|to)\s*${N})?${PCT}`;
/** Every percentage figure a sentence states ("12%-18%" is two; "12-18%" is one). */
const PERCENT_FIGURES = new RegExp(String.raw`\d(?:[\d,]*\d)?(?:\.\d+)?${PCT}`, 'gi');
const PERCENT = new RegExp(String.raw`\d${PCT}`, 'i');
const PRICE_CHANGE = /\b(?:reduc\w*|sav(?:e|es|ed|ing|ings)|discount\w*|cheaper|lower\w*|increas\w*|rais(?:e|es|ed|ing)|drove\s+costs?\s+down|markup|margins?|cost\s+(?:reduction|decline)s?|price\s+(?:reduction|drop|cut|rise)s?|cut\w*|off\b)/i;
const REPLY_RATE = /\b(?:reply|response|open|click(?:-through)?)\s+rates?\b|\b(?:replied|responded|opened|clicked)\b/i;
/** "a close rate of 12%", "a 12–18% win rate", "closing rate was about 15 percent": groups 1–2 or 3–4. */
const CLOSE_RATE = new RegExp(
  String.raw`\b(?:close|closing|win)\s+rates?\s+(?:of|was|is|were|are|at|averag\w*|around|about|near(?:ly)?|reached|ran|runs)?\s*(?:about|around|roughly|approximately|nearly|~)?\s*${RANGE_PCT}` +
    String.raw`|${RANGE_PCT}\s+(?:close|closing|win)\s+rates?\b`,
  'i',
);
const APPROACHED = String.raw`(?:contacted|approached|pitched|offered\b[^.;]{0,40}?|canvassed|visited|called|emailed|quoted|solicited|cold-?called)`;
const BOUGHT = String.raw`(?:signed(?:\s+up)?|bought|purchased|enrolled|subscribed|contracted|converted|became\s+(?:paying\s+)?(?:customers|clients)|agreed\s+to\s+(?:buy|purchase|sign)|placed\s+an?\s+order)`;
/** "18% of the businesses contacted signed", "12 percent of those approached bought": groups 1–2. */
const SHARE_OF_APPROACHED = new RegExp(
  String.raw`${RANGE_PCT}\s+of\s+(?:the\s+|those\s+|all\s+)?(?:[a-z][\w'-]*\s+){0,3}?(?:who\s+were\s+|that\s+were\s+|we\s+)?${APPROACHED}[^.;]{0,60}?\b${BOUGHT}\b`,
  'i',
);
/** A share whose population is those who already bought: "of households who signed", "of signers", "of customers". */
const SHARE_OF_BUYERS = /\bof\s+(?:the\s+|those\s+|all\s+)?(?:(?:[a-z][\w'-]*\s+){0,3}(?:who|that)\s+(?:had\s+|have\s+)?(?:signed|bought|purchased|enrolled|installed|subscribed)|signers|signees|buyers|customers|clients|subscribers|participants|enrollees|purchasers)\b/i;

const MONEY = /[$€£]\s?\d|\b\d[\d,.]*\s*(?:dollars?|usd|eur|gbp)\b/i;
const MONTHLY = /\b(?:per|a|each|every)\s+month\b|\bmonthly\b|\/\s*month\b/i;
/** Wording that makes a count a flow of acts, not a population: "120 new", "signed up", "installed". */
const FLOW = /\b(?:new|signed|joined|enrolled|installed|bought|purchased|served|added|acquired|won|completed|sold|converted)\b/i;
const BOUND = /\b(?:over|more\s+than|at\s+least|up\s+to|fewer\s+than|less\s+than|under|nearly|almost)\s*$/i;
const TIME = /^(?:just\s+|only\s+|the\s+(?:first|last|past|next)\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an)\s+(?:days?|weeks?|months?|years?|quarters?)\b|^(?:19|20)\d\d\b|^(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
/** A stated market: a proper name ("Texas", "the United States", "the Detroit metro area"). */
const MARKET = /^(?:the\s+)?[A-Z][\w.'-]*/;
const QUALIFIER = String.raw`(?:about|around|roughly|approximately|some|an\s+estimated)?`;
/** "In Texas, there are …", "Texas has …", "Michigan is home to …": the market stated before the count. */
const MARKET_BEFORE = [
  new RegExp(String.raw`\b(?:in|across)\s+(.*?)\s*,?\s*(?:there\s+(?:are|were)|is\s+home\s+to|has|had)\s*${QUALIFIER}\s*$`, 'i'),
  new RegExp(String.raw`(?:^|[,;]\s*)((?:the\s+)?[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)*)\s+(?:has|had|is\s+home\s+to|counts|contains)\s*${QUALIFIER}\s*$`),
];
const STOP = /^(?:in|across|throughout|within|of|with|that|who|which|and|or|for|to|at|on|are|is|were|was|operate|operating|exist)$/i;

function num(text: string): number {
  return Number(text.replace(/,/g, ''));
}

/** A word as one of its kind: "businesses" is "business", "practices" is "practice", "agencies" is "agency". */
export function singular(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z'-]/g, '');
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (/ss$/.test(w)) return w;
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** The noun a buyer type's name counts: its last word ("Local service businesses" counts businesses). */
function headOf(buyerName: string): string | null {
  const words = buyerName.toLowerCase().replace(/\([^)]*\)/g, ' ').match(/[a-z][a-z'-]*/g);
  const last = words?.[words.length - 1];
  return last && last.length >= 3 ? singular(last) : null;
}

function readShare(sentence: string): ShareCountReading {
  if (PRICE_CHANGE.test(sentence)) return { refused: 'it states a percentage change in a price or cost, which is no share of buyers and not a close rate' };
  const close = CLOSE_RATE.exec(sentence);
  const approached = close ? null : SHARE_OF_APPROACHED.exec(sentence);
  const match = close ?? approached;
  if (match) {
    // A range is one figure; another percentage elsewhere leaves which one is the close rate a guess.
    const all = sentence.match(PERCENT_FIGURES)?.length ?? 0;
    const own = match[0].match(PERCENT_FIGURES)?.length ?? 0;
    if (all > own) return { refused: 'it states more than one percentage, so which one is a close rate is ambiguous' };
    const lowText = close ? (close[1] ?? close[3]) : approached![1];
    const highText = close ? (close[1] !== undefined ? close[2] : close[4]) : approached![2];
    const low = num(lowText!);
    const high = highText ? num(highText) : low;
    if (!(low > 0) || !(high >= low) || high > 100) return { refused: 'its percentage is not a share between nothing and the whole' };
    return { key: 'account_win_rate', low: low / 100, high: high / 100, measures: close ? 'the close rate published for these buyers' : 'the share of these buyers approached who bought, as published' };
  }
  if (REPLY_RATE.test(sentence)) return { refused: 'it states a reply or response rate, which is not a share of approached buyers who bought' };
  if (SHARE_OF_BUYERS.test(sentence)) return { refused: 'it states a share of buyers who had already bought, not of buyers approached: not a close rate' };
  if (/\bconversion\s+rates?\b/i.test(sentence)) return { refused: 'it states a conversion rate without saying it is of buyers approached, so it may be a site visitor’s, not a close rate' };
  return { refused: 'it states a percentage that is no share of buyers approached or offered who bought' };
}

function readCount(sentence: string, buyerName: string): ShareCountReading {
  const head = headOf(buyerName);
  if (!head) return null;
  const count = new RegExp(String.raw`(^|[^$€£\d.,%-])${N}((?:\s+[A-Za-z][\w'-]*){1,4})`, 'g');
  let other: string | null = null;
  for (let m = count.exec(sentence); m; m = count.exec(sentence)) {
    const words = m[3]!.trim().split(/\s+/);
    const cut = words.findIndex((w) => STOP.test(w));
    const phrase = cut >= 0 ? words.slice(0, cut) : words;
    const at = phrase.findIndex((w) => singular(w) === head);
    if (at < 0) {
      if (!/^(?:19|20)\d\d$/.test(m[2]!) && phrase.length > 0) other ??= phrase.join(' ').toLowerCase();
      continue;
    }
    const figure = num(m[2]!);
    const before = sentence.slice(0, m.index + m[1]!.length);
    const after = `${words.slice(at + 1).join(' ')}${sentence.slice(m.index + m[0].length)}`.trim();
    if (BOUND.test(before)) return { refused: 'it states a bound on these buyers’ number, not a count of them' };
    if (phrase.slice(0, at).some((w) => FLOW.test(w)) || FLOW.test(after.slice(0, 40))) return { refused: 'it counts buyers who acted (signed, bought, were served), not how many a market holds' };
    const inAfter = /\b(?:in|across|throughout|within)\s+(.*)$/i.exec(after);
    const where = inAfter ? inAfter[1]!.trim() : (MARKET_BEFORE.map((re) => re.exec(before)).find(Boolean)?.[1]?.trim() ?? null);
    if (where === null) return { refused: 'it states a count of these buyers but no market it counts them in' };
    if (TIME.test(where)) return { refused: 'it counts these buyers over a period, which is a flow, not how many a market holds' };
    if (!MARKET.test(where)) return { refused: 'it states a count of these buyers but names no market it counts them in' };
    if (!Number.isInteger(figure) || !(figure >= 1) || figure > 100_000_000) return { refused: 'its count of buyers is not a plausible whole number' };
    return { key: 'accounts_reachable', low: figure, high: figure, measures: `how many ${phrase[at]!.toLowerCase()} the stated market holds, as published` };
  }
  if (other !== null && !MONTHLY.test(sentence)) {
    return { refused: `it counts "${other}", not buyers of this type in a market (a market’s installs, units or deals are no buyer count)` };
  }
  return null;
}

/**
 * The close rate or buyer count a claim states unambiguously about the buyers
 * `buyerName` names, a refusal naming why it is neither, or null when it
 * states no percentage and no count (a per-buyer monthly volume, a price or
 * prose: other readers' business).
 */
export function readShareOrCount(text: string, buyerName: string): ShareCountReading {
  const sentence = text.replace(/\s+/g, ' ').trim();
  if (PERCENT.test(sentence)) return readShare(sentence);
  if (MONEY.test(sentence)) return null;
  return readCount(sentence, buyerName);
}
