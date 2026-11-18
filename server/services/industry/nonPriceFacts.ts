/**
 * The non-price figures a constructed round's claim can file (R2, production
 * runpod-report 44238718584, 2026-11-18, goal wst_7b4fcbb5f2384f31b6c3): all
 * 13 accepted claims in three hours "reached no opening", stored 0, in_plan 0,
 * though many were the quantities the plan lists as unknown — Solarize's
 * "120 new residential installations in just six months", "20% of households
 * who signed … had never previously considered installing solar".
 *
 * A fact is filed only under a key the plan reads. The arrangement plan
 * (`constructionObservations` → `composeArrangement`, cash/construct.ts) reads
 * three construction fact keys: `price_per_unit` (value), `contractor_rate_per_unit`
 * (a margin design's supply cost) and `account_units_per_month` (the demand
 * side's `need_rate`: what ONE of these buyers buys a month). It reads none
 * for a reply rate or the deals a market takes, so a claim stating one of those
 * is refused with that named — never filed under a key nobody reads, and never
 * under one that means something else. A close rate and a count of buyers in
 * a market are not volumes either: this reader refuses them, and
 * `shareCountFacts.ts` (R3) files the unambiguous ones as `account_win_rate`
 * and `accounts_reachable`, which the plan reads as `conversion` and `buyers`.
 *
 * So the one non-price kind this files is a per-buyer monthly volume, read
 * conservatively: a count stated per month, in a sentence that says it is what
 * each (or a typical, or the average) buyer buys. A total across a market over
 * a period ("120 installations in six months") is not what one buyer buys —
 * dividing it by anything would invent the buyer count — and is refused.
 * Nothing here multiplies, divides or converts a period: the figure filed is
 * the figure stated. A money figure is never a volume, and a percentage is
 * never one either; a percentage change in price or cost is not a close rate.
 * Pure.
 */
export type NonPriceFact = { key: 'account_units_per_month'; low: number; high: number; measures: string };
export type NonPriceReading = NonPriceFact | { refused: string };

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`;
const MONTHLY = String.raw`(?:per|a|each|every)\s+month\b|monthly\b|\/\s*month\b`;
/** A count, optionally a range, then up to four words naming what is counted, then a monthly period. */
const MONTHLY_COUNT = new RegExp(String.raw`(^|[^$€£\d.,])${NUMBER}(?:\s*(?:-|–|to)\s*${NUMBER})?\s+((?:[a-z][a-z'-]*\s+){0,3}[a-z][a-z'-]*)\s+(?:${MONTHLY})`, 'i');
/** Wording that makes the count one buyer's: each / every / a typical / the average / on average / per customer. */
const PER_BUYER = /\b(?:each|every|a typical|the typical|the average|an average|on average|per (?:customer|client|account|buyer|business|household|home|location|store|practice|firm|company|member|subscriber))\b/i;
/** A count over a stated period that is not a month: a total, not a rate per buyer. */
const OTHER_PERIOD = /\b(?:in|over|within|during|across)\s+(?:just\s+|only\s+|the\s+(?:first|last|past)\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|eighteen|a)\s+(?:days?|weeks?|months?|years?|quarters?)\b|\b(?:per|a|each|every)\s+(?:day|week|quarter|year)\b|\b(?:annually|yearly|weekly|daily)\b/i;
const PERCENT = /\d(?:\.\d+)?\s*(?:%|percent\b|per cent\b)/i;
/** A percentage of a price or a cost moving: a reduction, a saving, a discount. Never a close rate. */
const PRICE_CHANGE = /\b(?:reduc\w*|sav(?:e|es|ed|ing|ings)|discount\w*|cheaper|lower\w*|drove\s+costs?\s+down|cost\s+(?:reduction|decline)s?|price\s+(?:reduction|drop|cut)s?|cut\w*|off\b)/i;
/** A percentage that states who agreed among those approached: what a close or reply rate is. */
const APPROACHED_RATE = /\b(?:close|closing|conversion|win|response|reply|acceptance|sign-?up|take-?up|uptake)\s+rates?\b|\bof\s+(?:the\s+)?(?:prospects|leads|those\s+(?:contacted|approached|pitched|reached|surveyed)|(?:\w+\s+){0,2}(?:contacted|approached|pitched|reached|emailed|called))\b[^.]*\b(?:signed|bought|purchased|converted|enrolled|agreed|replied|responded|accepted)\b/i;

/** A figure as written: "1,200" is 1200. */
function num(text: string): number {
  return Number(text.replace(/,/g, ''));
}

/**
 * The non-price fact a claim states unambiguously, or why it is refused. Only
 * `account_units_per_month` is ever returned; every other reading is a refusal
 * naming what the claim states and why the plan has no fact for it.
 */
export function readNonPriceFact(text: string): NonPriceReading {
  const sentence = text.replace(/\s+/g, ' ').trim();
  if (PERCENT.test(sentence)) {
    if (PRICE_CHANGE.test(sentence)) return { refused: 'it states a percentage change in a price or cost, which is not a close rate and no figure the plan reads' };
    if (APPROACHED_RATE.test(sentence)) return { refused: 'it states a reply or close rate, which is no volume: a reply rate has no fact the plan reads, and a close rate is filed only as a stated share of buyers approached who bought (shareCountFacts.ts)' };
    return { refused: 'it states a percentage that is no share of buyers approached who agreed, and no figure the plan reads' };
  }
  const match = MONTHLY_COUNT.exec(sentence);
  if (!match) {
    if (OTHER_PERIOD.test(sentence) && /\d/.test(sentence)) return { refused: 'it states a count over a period that is not one buyer’s month: a total across the market, and the plan reads no fact for the deals a market takes' };
    if (/\d/.test(sentence)) return { refused: 'it states a count with no period, which is no volume per buyer per month' };
    return { refused: 'it states no figure' };
  }
  if (!PER_BUYER.test(sentence)) return { refused: 'it states a monthly count without saying it is one buyer’s, so it may be the whole market’s, and the plan reads per-buyer volume only' };
  const what = match[4]!.toLowerCase();
  if (/\b(?:dollars?|usd|cents?|euros?|pounds?)\b/.test(what)) return { refused: 'its monthly figure is money, not a count' };
  const low = num(match[2]!);
  const high = match[3] ? num(match[3]) : low;
  if (!(low > 0) || !(high >= low) || high > 100_000) return { refused: 'its monthly count is not a plausible positive figure' };
  return { key: 'account_units_per_month', low, high, measures: `${what} one of these buyers buys a month, as published` };
}
