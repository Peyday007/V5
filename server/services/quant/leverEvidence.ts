/**
 * What the project's rows already say about each lever's parts (S-0103, COM-13-2).
 *
 * Construction composes every lever onto a design and the trace reads each
 * part through `reconstruct`. Until this module, every lever part was built as
 * bare bounds — nothing ever handed `reconstruct` an observation of buyer
 * prepayment willingness, refund obligations, when prepaid funds are usable, a
 * supplier's capacity, failure rate or payment terms, AI labor's cost or
 * throughput, or the days a buyer takes to settle. So `verifyPrepayment` could
 * never read ESTABLISHED on a production arrangement and the question
 * construction asks research ("establish what share of these buyers will
 * prepay…") had no consumer: an answer could not change the reading.
 *
 * The answers arrive where every other researched fact arrives: an EVIDENCE
 * card fact resting on a gated claim, on the opening that research filed, and
 * the opening's own published payment terms. This module reads those rows —
 * the same rows `quant/knowledge.ts` reads for days to cash and cost shares —
 * into observations about the payer they were measured on, one list per lever
 * part. Construction marks each one `broad` unless its payer is the
 * arrangement's own, exactly as it does for published prices, so another
 * buyer's terms bound a part and never establish it.
 *
 * A sentence is read only when it names the part's own words, and a figure is
 * taken only in the unit the part is measured in. What no sentence states
 * stays a bound: a question, never an assumption (invariant 39).
 *
 * Pure: it reads only what it is given and writes nothing. No store,
 * scheduler or authority of its own.
 */
import type { CashCardFact, CashOpportunity } from '../../domain/types.ts';
import type { Observation, ObservationValue } from '../../domain/quant.ts';
import { readMoneyFigures } from '../cash/figures.ts';

/** The lever parts this reader can fill, keyed as `lever.part`. */
export const LEVER_PARTS = [
  'prepayment.willingness',
  'prepayment.refundShare',
  'prepayment.usableDays',
  'fulfilment.capacity',
  'fulfilment.failureRate',
  'fulfilment.paymentDays',
  'aiLabor.costPerTransaction',
  'aiLabor.throughput',
  'settlementDays',
] as const;
export type LeverPart = (typeof LEVER_PARTS)[number];

export type LeverEvidence = Record<LeverPart, Observation[]>;

export function emptyLeverEvidence(): LeverEvidence {
  return Object.fromEntries(LEVER_PARTS.map((one) => [one, []])) as unknown as LeverEvidence;
}

const norm = (text: string | null | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ── the words each part is stated in ──────────────────────────────────────────

const PREPAY = /\b(?:pre-?pa(?:y|ys|id|ying|yment|yments)|deposits?|up-?front|in advance|advance payments?|paid before|pay(?:s|ing)? before|retainers?)\b/i;
const POPULATION = /\b(?:buyers?|customers?|clients?|purchasers?|orders?|bookings?|guests?|accounts?|households?|businesses|companies|members?)\b/i;
const REQUIRED = /\b(?:requires?d?|required|mandatory|must (?:pay|be paid)|due (?:up-?front|in advance|before|at booking|on booking)|payable (?:up-?front|in advance|at booking)|collected (?:up-?front|in advance|at booking)|paid in full (?:up-?front|in advance|at booking))\b/i;
const REFUND = /\b(?:refund(?:s|ed|able|ing)?|charge-?backs?|cancell?ations?|cancell?ed|returns?|returned|money back)\b/i;
const NO_REFUND = /\b(?:non-?refundable|no refunds?|not refundable|refunds? (?:are|is) not (?:given|offered|available))\b/i;
const FUNDS = /\b(?:payouts?|paid out|funds?|deposits?|money|cash|proceeds|settle(?:s|d|ment)?|clears?|cleared|available|usable|released?|disburse(?:d|ment)?|transfers?)\b/i;
const USABLE = /\b(?:available|usable|released?|paid out|payouts?|clears?|cleared|disburse(?:d|ment)?|settle(?:s|d|ment)?|transferred|land(?:s|ed)? in)\b/i;
const INSTANT = /\b(?:instant(?:ly)?|same[- ]day|immediately|on receipt|at once)\b/i;
const SUPPLIER = /\b(?:suppliers?|sub-?contractors?|contractors?|vendors?|wholesalers?|manufacturers?|carriers?|fulfil(?:l)?ers?|fulfil(?:l)?ment partners?|crews?|providers?|partners?|factories|factory|workshops?)\b/i;
const PAY_TERM = /\b(?:net\s?\d{1,3}|paid|pay(?:s|ing|ment|ments)?|invoices?|invoiced|terms?|remit(?:ted|tance)?|settle(?:s|d|ment)?)\b/i;
const FAILURE = /\b(?:fail(?:s|ed|ure|ures)?|defects?|defective|late|missed|no-?shows?|rejects?|rejected|re-?work|complaints?|errors?|cancell?ations?|cancell?ed)\b/i;
const CAPACITY = /\b(?:capacity|can (?:take|handle|deliver|produce|fulfil(?:l)?|process|run)|takes? on|handles?|delivers?|produces?|processes?|runs?|ships?|output|throughput|up to)\b/i;
const AI = /\b(?:AI|A\.I\.|automated|automation|language model|LLM|model|agent|bot|machine)\b/;
const BUYER_SETTLES = /\b(?:buyers?|customers?|clients?|payers?|purchasers?)\b|\bnet\s?\d{1,3}\b|\binvoice/i;

const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)(?:\s*(?:-|–|to)\s*(\d{1,3}(?:\.\d+)?)\s*(?:%|percent))?|(\d{1,3}(?:\.\d+)?)\s*(?:-|–|to)\s*(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)/gi;
const OUT_OF = /\b(\d{1,7})\s+(?:of|out of|in)\s+(?:every\s+)?(\d{1,7})\b/i;
const NET = /\bnet\s?(\d{1,3})\b/i;
const DAYS = /(\d{1,4})(?:\s*(?:-|–|to)\s*(\d{1,4}))?\s*(business day|working day|day|week|month)s?\b/i;
const PER_PERIOD = /(\d[\d,]*(?:\.\d+)?)\s*(?:[a-z-]+\s+){0,3}?(?:per|a|an|each|every)\s+(hour|day|week|month|year)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.;!?])\s+|\n+/).map((one) => one.trim()).filter(Boolean);
}

/** Every percentage in a sentence, as shares. Over 100% is not a share and is dropped. */
function shares(sentence: string): number[] {
  const out: number[] = [];
  for (const m of sentence.matchAll(PERCENT)) {
    const values = m[1] !== undefined ? [m[1], m[2]] : [m[3], m[4]];
    for (const raw of values) {
      if (raw === undefined) continue;
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 0 && v <= 100) out.push(Math.round(v * 1e4) / 1e6);
    }
  }
  return out;
}

/**
 * Several figures become one range spanning them: the reader never picks the
 * convenient one. `exact` marks a single published term (net 30, paid out in
 * two days): it describes that case exactly rather than sampling a rate.
 */
function spanOf(values: number[], exact = false): ObservationValue | null {
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? { kind: 'POINT', value: low, ...(exact ? { exact: true } : {}) } : { kind: 'RANGE', low, high };
}

function days(sentence: string): number[] {
  const out: number[] = [];
  const net = NET.exec(sentence);
  if (net) out.push(Number(net[1]));
  const m = DAYS.exec(sentence);
  if (m) {
    const unit = m[3]!.toLowerCase();
    const factor = unit === 'week' ? 7 : unit === 'month' ? 30 : 1;
    out.push(Number(m[1]) * factor);
    if (m[2]) out.push(Number(m[2]) * factor);
  }
  return out.filter((v) => Number.isFinite(v) && v >= 0 && v <= 3650);
}

/** A count per period, converted to the arrangement's period. */
function perPeriod(sentence: string, periodDays: number): number[] {
  const m = PER_PERIOD.exec(sentence);
  if (!m) return [];
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return [];
  const unitDays = { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2]!.toLowerCase() as 'hour' | 'day' | 'week' | 'month' | 'year'];
  return [Math.round((n * periodDays) / unitDays)];
}

// ── one sentence, read for each part ──────────────────────────────────────────

/**
 * What one sentence states about each lever part, in the part's own unit.
 * Exported so a reader can check exactly what a sentence was taken to say.
 */
export function readLeverSentence(sentence: string, currency: string, periodDays: number): Partial<Record<LeverPart, ObservationValue>> {
  const out: Partial<Record<LeverPart, ObservationValue>> = {};
  const pct = shares(sentence);
  const supplier = SUPPLIER.test(sentence);
  const ai = AI.test(sentence);

  // Prepayment willingness: a share of a population who prepay, a count of them, or terms that require it of every buyer.
  if (PREPAY.test(sentence) && !REFUND.test(sentence) && !supplier) {
    const outOf = OUT_OF.exec(sentence);
    if (outOf && POPULATION.test(sentence) && Number(outOf[1]) <= Number(outOf[2]) && Number(outOf[2]) > 0) {
      out['prepayment.willingness'] = { kind: 'COUNT', successes: Number(outOf[1]), trials: Number(outOf[2]) };
    } else if (pct.length > 0 && POPULATION.test(sentence) && /\bof\b/i.test(sentence)) {
      out['prepayment.willingness'] = spanOf(pct)!;
    } else if (REQUIRED.test(sentence)) {
      // Published terms that require payment before fulfilment: every buyer who buys has prepaid.
      out['prepayment.willingness'] = { kind: 'POINT', value: 1, exact: true };
    }
  }

  // Refund obligations: a refund share, or terms that rule refunds out.
  if (NO_REFUND.test(sentence)) out['prepayment.refundShare'] = { kind: 'POINT', value: 0, exact: true };
  else if (REFUND.test(sentence) && !supplier) {
    const outOf = OUT_OF.exec(sentence);
    if (outOf && Number(outOf[1]) <= Number(outOf[2]) && Number(outOf[2]) > 0) out['prepayment.refundShare'] = { kind: 'COUNT', successes: Number(outOf[1]), trials: Number(outOf[2]) };
    else if (pct.length > 0) out['prepayment.refundShare'] = spanOf(pct)!;
  }

  // When received money is usable.
  if (FUNDS.test(sentence) && USABLE.test(sentence) && !supplier) {
    if (INSTANT.test(sentence)) out['prepayment.usableDays'] = { kind: 'POINT', value: 0, exact: true };
    else {
      const d = days(sentence);
      if (d.length > 0 && !PAY_TERM.test(sentence.replace(USABLE, ''))) out['prepayment.usableDays'] = spanOf(d, true)!;
      else if (d.length > 0 && /\b(?:payouts?|paid out|available|usable|released?|clears?|cleared)\b/i.test(sentence)) out['prepayment.usableDays'] = spanOf(d, true)!;
    }
  }

  if (supplier) {
    // What the supplier must be paid, and when.
    if (PAY_TERM.test(sentence)) {
      if (/\b(?:on|at|upon) (?:delivery|completion|order)\b/i.test(sentence) && days(sentence).length === 0) out['fulfilment.paymentDays'] = { kind: 'POINT', value: 0, exact: true };
      else {
        const d = days(sentence);
        if (d.length > 0) out['fulfilment.paymentDays'] = spanOf(d, true)!;
      }
    }
    if (FAILURE.test(sentence) && pct.length > 0) out['fulfilment.failureRate'] = spanOf(pct)!;
    if (CAPACITY.test(sentence) && !ai) {
      const cap = perPeriod(sentence, periodDays);
      if (cap.length > 0) out['fulfilment.capacity'] = spanOf(cap)!;
    }
  }

  if (ai && !supplier) {
    const money = readMoneyFigures(sentence, currency).filter((one) => one.perUnit || /\bper (?:task|item|transaction|job|order|document|request|run|call|unit)\b/i.test(sentence));
    if (money.length > 0) out['aiLabor.costPerTransaction'] = spanOf(money.map((one) => one.cents / 100))!;
    if (CAPACITY.test(sentence)) {
      const cap = perPeriod(sentence, periodDays);
      if (cap.length > 0) out['aiLabor.throughput'] = spanOf(cap)!;
    }
  }

  // When a buyer who did not prepay has paid.
  if (!supplier && BUYER_SETTLES.test(sentence) && PAY_TERM.test(sentence) && !PREPAY.test(sentence)) {
    if (/\b(?:on|at|upon) (?:delivery|completion|checkout|purchase|booking|the time of service)\b/i.test(sentence) && days(sentence).length === 0) out.settlementDays = { kind: 'POINT', value: 0, exact: true };
    else {
      const d = days(sentence);
      if (d.length > 0) out.settlementDays = spanOf(d, true)!;
    }
  }
  return out;
}

// ── the rows ───────────────────────────────────────────────────────────────────

export interface LeverEvidenceInput {
  opportunities: readonly CashOpportunity[];
  /** EVIDENCE card facts; a RECOMMENDATION or a PERSON's figure is not an observation of the world. */
  facts: readonly CashCardFact[];
  sources?: ReadonlyMap<string, { sourceUrl: string | null; sourcePublisher: string | null; sourceDate: string | null }>;
  currency: string;
  /** The arrangement's period in days, which counts per period are converted to. */
  periodDays: number;
}

function lineageFor(url: string | null | undefined, fallback: string): string[] {
  if (!url) return [fallback];
  try {
    const u = new URL(url);
    return [`url:${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`];
  } catch {
    return [`url:${url}`];
  }
}

/**
 * Every observation the project's rows hold about each lever part, about the
 * payer it was measured on. A fact on a duplicate, or one priced in another
 * currency where the part is money, is not read.
 */
export function leverEvidenceFrom(input: LeverEvidenceInput): LeverEvidence {
  const out = emptyLeverEvidence();
  const byId = new Map(input.opportunities.map((one) => [one.id, one]));
  const add = (
    part: LeverPart,
    value: ObservationValue,
    opportunity: CashOpportunity,
    id: string,
    lineage: string[],
    source: Observation['source'],
    observedAt: string | null,
    measures: string,
  ) => {
    out[part].push({
      id: `${id}:${part}`,
      value,
      context: { payer: norm(opportunity.payer), industry: norm(opportunity.industry) },
      lineage,
      source,
      observedAt,
      measures,
    });
  };
  for (const fact of input.facts) {
    if (fact.kind !== 'EVIDENCE') continue;
    const opportunity = byId.get(fact.opportunityId);
    if (!opportunity || opportunity.duplicateOfId || !opportunity.payer) continue;
    const src = fact.claimId ? input.sources?.get(fact.claimId) : undefined;
    const observedAt = src?.sourceDate && !Number.isNaN(Date.parse(src.sourceDate)) ? new Date(Date.parse(src.sourceDate)).toISOString() : fact.createdAt;
    const source: Observation['source'] = fact.claimId ? { kind: 'CLAIM', ref: fact.claimId, note: src?.sourcePublisher ?? undefined } : { kind: 'CARD_FACT', ref: fact.id };
    const lineage = lineageFor(src?.sourceUrl, `fact:${fact.id}`);
    const seen = new Set<LeverPart>();
    for (const sentence of sentences(fact.value)) {
      const read = readLeverSentence(sentence, opportunity.currency === input.currency ? input.currency : '___', input.periodDays);
      for (const [part, value] of Object.entries(read) as Array<[LeverPart, ObservationValue]>) {
        // One fact is one observation of a part: its sentences are one source, not several.
        if (seen.has(part)) continue;
        seen.add(part);
        add(part, value, opportunity, `fact:${fact.id}`, lineage, source, observedAt, `${fact.field} on "${opportunity.title.slice(0, 60)}": ${sentence.slice(0, 120)}`);
      }
    }
  }
  // The opening's own published payment terms, from the claim that filed it.
  for (const opportunity of input.opportunities) {
    if (opportunity.duplicateOfId || !opportunity.payer || !opportunity.paymentTerms) continue;
    const ref = opportunity.sourceClaimId;
    const src = ref ? input.sources?.get(ref) : undefined;
    const source: Observation['source'] = ref ? { kind: 'CLAIM', ref } : { kind: 'CASH_OPPORTUNITY', ref: opportunity.id };
    const lineage = lineageFor(src?.sourceUrl, ref ? `claim:${ref}` : `opp:${opportunity.id}`);
    const seen = new Set<LeverPart>();
    for (const sentence of sentences(opportunity.paymentTerms)) {
      for (const [part, value] of Object.entries(readLeverSentence(sentence, input.currency, input.periodDays)) as Array<[LeverPart, ObservationValue]>) {
        if (seen.has(part)) continue;
        seen.add(part);
        add(part, value, opportunity, `terms:${opportunity.id}`, lineage, source, opportunity.signalObservedAt ?? opportunity.createdAt ?? null, `payment terms on "${opportunity.title.slice(0, 60)}": ${sentence.slice(0, 120)}`);
      }
    }
  }
  // Two rows resting on one published page are one observation.
  for (const part of LEVER_PARTS) {
    const kept = new Map<string, Observation>();
    for (const one of out[part]) {
      const key = `${one.context['payer']}|${one.lineage.join(',')}`;
      if (!kept.has(key)) kept.set(key, one);
    }
    out[part] = [...kept.values()];
  }
  return out;
}
