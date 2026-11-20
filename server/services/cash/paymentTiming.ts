/**
 * When a buyer pays relative to delivery, read only from what a row or a
 * source states — never assumed (invariant 39).
 *
 * Production, 2026-11-15 (goal wst_7b4fcbb5f2384f31b6c3, revision 842bb7c):
 * the reconstruction's `capital:prepaid-fulfilment` lever told the plan that
 * "the buyer pays in full before the supplier is paid" for a constructed
 * arrangement whose buyers — state technical utility services bureaus — were
 * known only from a sourced claim that one of them issued an RFP. A public
 * award is paid after it is won and the work is delivered, in arrears; the
 * same plan already said so of every award opening it held. The arrangement
 * had lost that, because a constructed opening carried no terms at all, and
 * the lever read "no terms" as "may be prepaid": an $881,310 direct cost left
 * the $3,000 capital limit and the plan read 46.7% on it.
 *
 * Three readings, and only a stated one is ever favourable:
 *   PREPAID — the terms or the evidence say money arrives before delivery
 *             (in full, or a deposit / at-order share of it);
 *   ARREARS — they say it arrives after delivery or acceptance, or the money
 *             is won by competing for an award (RFP, tender, grant …), which
 *             is paid on the award's completion;
 *   UNKNOWN — nothing stated decides it. A question, not a prepayment.
 * Where evidence says both, ARREARS holds: a conflicting term is never read
 * in the plan's favour.
 *
 * Pure, and imported by both construction and the goal model, so it sits
 * beneath both rather than inside either (construct.ts → goalScenario.ts
 * would be an import cycle).
 */

/** Words that name money won by competing for an award: a bid, a tender, a solicitation, a grant. */
export const COMPETITIVE_AWARD = /\b(rfp|rfq|rfi|rfx|tender|solicitation|bids?|bidding|grants?|cooperative agreements?|procurement|sam\.gov|notice of funding|funding opportunity|nofo)\b/i;
/** The whole price is paid before the work is delivered. */
export const PREPAID_TERMS = /\b(pre-?paid|prepay(?:ment)?|up-?front|in advance|paid (?:at|on) (?:order|booking|checkout)|before (?:work|delivery|fulfil+ment) (?:starts|begins)?)/i;
/** A share of the price is paid before delivery: a deposit, a retainer, a payment at order or signing. */
export const PART_BEFORE_DELIVERY = /\b(deposits?|retainers?|(?:at|on) (?:order|booking|checkout|signing))\b/i;
/** Payment falls due only once the work is delivered or accepted. */
export const AFTER_DELIVERY_TERMS = /\b(net\s*\d{1,3}|(?:on|upon|after) (?:delivery|completion|acceptance|receipt of (?:the )?(?:goods|work|deliverable))|in arrears|due on receipt)\b/i;

export type PaymentTiming = 'PREPAID' | 'ARREARS' | 'UNKNOWN';

export interface PaymentTimingReading {
  timing: PaymentTiming;
  /** What stated it, or why nothing did. */
  basis: string;
  /**
   * For PREPAID: the share of the price stated to arrive before delivery — 1
   * for the whole price, a stated deposit's share, or null when a deposit or
   * retainer is stated with no share (a question, never read as the whole
   * price: invariant 39). Absent on a reading that is not PREPAID.
   */
  share?: number | null;
}

/** A stated share of the price paid before delivery: "50% deposit", "a deposit of 30%", "25% up front", "40% paid before delivery". */
const SHARE_BEFORE_DELIVERY =
  /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)\s*(?:of the (?:price|total|fee|order|contract)\s*)?(?:is\s*)?(?:paid\s*)?(?:as an?\s*)?(?:deposits?|retainers?|up-?front|in advance|pre-?paid|prepayment|before (?:work|delivery|fulfil+ment)|(?:at|on) (?:order|booking|checkout|signing))|(?:deposits?|retainers?|prepayments?|up-?front payments?)\s+(?:of\s+)?(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)/i;

/**
 * How much of the price a stated text says arrives before delivery: a stated
 * percentage, the whole price when only full prepayment is stated (no
 * deposit, no balance on delivery), or null when a part is stated without its
 * share, or a payment at signing or order nobody says is the whole price.
 * Read only for a text already read as PREPAID. Pure.
 */
export function statedPrepaidShare(text: string): number | null {
  const m = SHARE_BEFORE_DELIVERY.exec(text);
  if (m) {
    const pct = Number(m[1] ?? m[2]);
    if (Number.isFinite(pct) && pct > 0 && pct <= 100) return pct / 100;
  }
  // The whole price: full prepayment stated, and no deposit, retainer or balance after delivery beside it.
  if (PREPAID_TERMS.test(text) && !PART_ONLY.test(text) && !AFTER_DELIVERY_TERMS.test(text)) return 1;
  return null;
}

/** Words that name only a part of the price paid ahead: a deposit or a retainer ("paid at checkout" is the whole price). */
const PART_ONLY = /\b(deposits?|retainers?|balance)\b/i;

const UNKNOWN_READING: PaymentTimingReading = { timing: 'UNKNOWN', basis: 'no payment terms are stated' };

/**
 * What one stated text says about when the buyer pays. `award` lets a text
 * that names an RFP, tender or grant read as ARREARS — true for a source's or
 * an opening's description, false for a terms field read on its own.
 */
export function timingOfText(text: string | null | undefined, basis: string, award = true): PaymentTimingReading {
  const t = (text ?? '').trim();
  if (!t) return UNKNOWN_READING;
  const after = AFTER_DELIVERY_TERMS.exec(t);
  const awarded = award ? COMPETITIVE_AWARD.exec(t) : null;
  const before = PREPAID_TERMS.exec(t) ?? PART_BEFORE_DELIVERY.exec(t);
  // A text naming an award is paid on the award's completion whatever else it says. Otherwise any money stated
  // before delivery — in full, or a deposit with the balance on delivery — shows these buyers pay ahead of the work.
  if (awarded) return { timing: 'ARREARS', basis: `${basis} names a competitive award ("${awarded[0]}"): paid after it is won and the work delivered` };
  if (before) return { timing: 'PREPAID', basis: `${basis} states payment before delivery ("${before[0]}")`, share: statedPrepaidShare(t) };
  if (after) return { timing: 'ARREARS', basis: `${basis} states payment after delivery ("${after[0]}")` };
  return UNKNOWN_READING;
}

/** Several readings of one buyer population as one: ARREARS if any says so, PREPAID only if one does and none says otherwise. */
export function combineTimings(readings: readonly PaymentTimingReading[]): PaymentTimingReading {
  return readings.find((one) => one.timing === 'ARREARS') ?? readings.find((one) => one.timing === 'PREPAID') ?? UNKNOWN_READING;
}

/** The fields of an opening its payment timing is read from. */
export interface TimingFields {
  title: string;
  source?: string | null;
  buyingSignal?: string | null;
  paymentTerms?: string | null;
}

/**
 * An opening's own stated timing: its payment terms first, then whether it is
 * won by award (title, source, signal — the words `isCompetitiveAward` reads).
 */
export function openingTiming(o: TimingFields, basis: string): PaymentTimingReading {
  const terms = timingOfText(o.paymentTerms, `${basis} terms`, false);
  if (terms.timing !== 'UNKNOWN') return terms;
  const words = [o.title, o.source, o.buyingSignal].filter(Boolean).join(' ');
  const awarded = COMPETITIVE_AWARD.exec(words);
  return awarded ? { timing: 'ARREARS', basis: `${basis} is won by competitive award ("${awarded[0]}"): paid after it is won and the work delivered` } : UNKNOWN_READING;
}

/**
 * A modelled opening's timing, as the reconstruction's financing lever reads
 * it: its stated terms (a constructed arrangement's are inherited from its
 * buyers' evidence), then whether it is a competitive award.
 */
export function modelledTiming(one: { opportunity: TimingFields & { id: string; paymentTerms?: string | null }; competitiveAward: boolean }): PaymentTimingReading {
  const terms = timingOfText(one.opportunity.paymentTerms, `"${one.opportunity.title.slice(0, 60)}"`, false);
  if (terms.timing !== 'UNKNOWN') return terms;
  if (one.competitiveAward) return { timing: 'ARREARS', basis: `"${one.opportunity.title.slice(0, 60)}" is a competitive award: paid after it is won and the work delivered` };
  return { timing: 'UNKNOWN', basis: `"${one.opportunity.title.slice(0, 60)}" states no payment terms` };
}
