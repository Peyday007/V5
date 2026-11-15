/**
 * What evidence says about an arrangement's levers (S-0103, COM-13-2).
 *
 * Construction composes every lever's parts — buyer willingness to prepay,
 * refund obligations, when prepaid money is usable, when a supplier must be
 * paid, when buyers settle, supplier capacity and failure, AI-labor cost and
 * throughput, the days it takes to acquire buyers, and the repeat rate. Until
 * this module those parts were bare bounds: nothing read an observation into
 * them, so prepayment could never be verified on a production arrangement and
 * the research question construction asks about it had no consumer.
 *
 * This reads the rows that already hold such evidence — no store of its own:
 *
 *   * a gated card fact (kind EVIDENCE, resting on a claim) and a researched
 *     opening's own payment terms are statements about *that opening's payer*:
 *     one buyer's terms are one buyer observed prepaying or not, so willingness
 *     is a count of openings, never a quoted figure;
 *   * an accepted, sourced research claim — where a constructed round's answer
 *     lands — is a statement about whichever buyers it names. It is evidence
 *     about an arrangement's buyers when it names them, and broad evidence
 *     (bounds, never a distribution) when it does not.
 *
 * Every figure is read only from a sentence that names its own quantity's
 * words, so a payout delay is never read as a supplier's terms. A rate with no
 * stated sample stays unsized, and `reconstruct` refuses to make a
 * distribution of unsized rates alone. Nothing here is assumed: a part no
 * sentence speaks to keeps its bounds and stays a question (invariant 39).
 *
 * Pure and plain data, so it crosses the evaluator pool's thread boundary.
 */
import type { Observation } from '../../domain/quant.ts';

type SourceRef = Observation['source'];

export const LEVER_PARTS = [
  'prepayWillingness',
  'refundShare',
  'usableDays',
  'settlementDays',
  'supplierPaymentDays',
  'supplierFailureRate',
  'supplierCapacity',
  'aiThroughput',
  'aiCost',
  'daysToAcquire',
  'repeatRate',
] as const;
export type LeverPart = (typeof LEVER_PARTS)[number];

/** One researched statement, with who it is about. */
export interface LeverStatement {
  id: string;
  text: string;
  /** The normalised payer it is about, or null when the statement names none (a claim). */
  payer: string | null;
  industry: string | null;
  /** The opening it belongs to, when it is an opening's own term. */
  opportunityId: string | null;
  lineage: string[];
  source: SourceRef;
  observedAt?: string | null;
}

/** An observation about a lever part, with what decides whom it is about. */
export interface LeverObservation {
  part: LeverPart;
  obs: Observation;
  /** Normalised payer, when the statement is an opening's; null for a claim (decided by what it names). */
  payer: string | null;
  /** Lower-cased statement, for a claim: whether it names the arrangement's buyers. */
  text: string;
}

export type LeverEvidence = Record<LeverPart, LeverObservation[]>;

export function emptyLeverEvidence(): LeverEvidence {
  return Object.fromEntries(LEVER_PARTS.map((p) => [p, []])) as unknown as LeverEvidence;
}

const norm = (text: string | null | undefined) => (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

const WORDS = {
  prepay: /\b(?:prepa(?:y|ys|id|ying|yment|yments)|pre-pa(?:y|id|yment)|up[- ]?front|in advance|advance payment|deposits?|retainers?|pre-?orders?|paid before|pays? before|payment before)\b/i,
  postpay: /\b(?:net[- ]?\d{1,3}|on delivery|upon (?:delivery|completion|receipt of (?:goods|work))|after (?:delivery|completion)|on completion|in arrears|invoiced? (?:after|on completion|monthly|on delivery))\b/i,
  negated: /\b(?:no|not|never|without|refuse[sd]?|won't|will not|do not|does not|don't|doesn't)\b[^.;]{0,30}\b(?:prepa|up[- ]?front|in advance|deposit|retainer)/i,
  refund: /\b(?:refund(?:s|ed|able)?|chargebacks?|money[- ]back|cancell?ation(?:s)?)\b/i,
  noRefund: /\b(?:non[- ]?refundable|no refunds?|refunds? (?:are|is) not (?:given|offered|available|issued))\b/i,
  usable: /\b(?:payouts?|paid out|funds? (?:are |become |becomes )?(?:available|usable|released)|clears?|cleared|clearing|settles?|settled|disburse(?:d|ment)?|available (?:to withdraw|for withdrawal|balance))\b/i,
  settle: /\b(?:net[- ]?\d{1,3}|paid within|pays? within|payment (?:is )?(?:due|within|terms?)|invoices? (?:are )?(?:paid|due)|days? after (?:delivery|invoice|completion)|payment on delivery)\b/i,
  supplier: /\b(?:suppliers?|vendors?|contractors?|subcontractors?|freelancers?|wholesalers?|manufacturers?|fulfil(?:l)?ers?|fulfil(?:l)?ment (?:partner|provider|house|centre|center)s?|laundr(?:y|ies)|printers?|makers?)\b/i,
  pay: /\b(?:pa(?:y|ys|id|yment|yments)|invoice[sd]?|terms?)\b/i,
  failure: /\b(?:fail(?:s|ed|ure|ures)?|defects?|defective|late|delays?|delayed|cancell?ed|no[- ]shows?|missed|rework|returns? rate|errors?)\b/i,
  capacity: /\b(?:capacity|can (?:handle|process|fulfil(?:l)?|produce|deliver|ship|complete)|handles?|processes|produces|ships|delivers|completes)\b/i,
  ai: /\b(?:ai|a\.i\.|llms?|language models?|models?|gpt\S*|claude|automation|automated|agents?|api calls?|inference|tokens?)\b/i,
  acquire: /\b(?:sales cycles?|to close|time to (?:first )?(?:sale|customer|close|sign)|lead times? to (?:sign|close)|takes? [^.;]{0,30}to (?:sign|close|acquire|convert|win)|days? to (?:acquire|close|sign|convert))\b/i,
  repeat: /\b(?:repeat (?:customers?|buyers?|purchases?|business|orders?|rate)|re-?orders?|re-?purchase|returning (?:customers?|buyers?|clients?)|retention|renew(?:al|als|s|ed)?|buy again|come back)\b/i,
};

const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)/gi;
const OF_COUNT = /\b(\d{1,6})\s+(?:of|out of|in)\s+(?:the\s+)?(\d{1,7})\b/i;
const SAMPLE = /\b(?:n\s*=\s*|sample of\s+|survey(?:ed)? of\s+|(?:across|of|from)\s+)(\d{2,7})\s*(?:buyers|customers|clients|respondents|businesses|companies|orders|merchants|firms|people|deals)?\b/i;
const PER_PERIOD = /(\d[\d,]*(?:\.\d+)?)\s*(?:[a-z-]+\s+){0,3}?(?:per|a|each|\/)\s*(hour|day|week|month|year)\b/i;
const MONEY = /(?:\$|usd\s?|us\$)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:usd|dollars)\b/i;
const PER_UNIT = /\b(?:per|a|each|\/)\s*(?:task|transaction|job|request|order|item|deliverable|document|page|call|run|unit|piece|report|lead|customer)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.;!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** Days a sentence states: "30 days", "2–3 weeks", "net 30", "same day". */
export function readDays(sentence: string): Observation['value'] | null {
  const net = /\bnet[- ]?(\d{1,3})\b/i.exec(sentence);
  if (net) {
    const d = Number.parseInt(net[1]!, 10);
    if (d > 0) return { kind: 'POINT', value: d };
  }
  if (/\b(?:same[- ]day|instant(?:ly)?|immediately|within (?:a|one|24) hours?)\b/i.test(sentence)) return { kind: 'RANGE', low: 0.1, high: 1 };
  const m = /(\d{1,4}(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d{1,4}(?:\.\d+)?))?\s*(?:business |working |calendar )?(day|week|month)s?\b/i.exec(sentence);
  if (!m) return null;
  const factor = m[3]!.toLowerCase() === 'week' ? 7 : m[3]!.toLowerCase() === 'month' ? 30 : 1;
  const low = Number(m[1]) * factor;
  const high = (m[2] ? Number(m[2]) : Number(m[1])) * factor;
  if (!(low > 0) || high < low || high > 3650) return null;
  return low === high ? { kind: 'POINT', value: low } : { kind: 'RANGE', low, high };
}

/**
 * A share a sentence states, with its sample when it says one: "12 of 40
 * buyers", "30% (n=200)", "30%". A figure over 100% is not a share. Several
 * figures become one range spanning them — the reader never picks one.
 */
export function readShare(sentence: string): Observation['value'] | null {
  const count = OF_COUNT.exec(sentence);
  if (count) {
    const successes = Number(count[1]);
    const trials = Number(count[2]);
    if (trials > 0 && successes <= trials) return { kind: 'COUNT', successes, trials };
  }
  const figures = [...sentence.matchAll(PERCENT)].map((m) => Number(m[1])).filter((v) => Number.isFinite(v) && v >= 0 && v <= 100).map((v) => v / 100);
  if (figures.length === 0) return null;
  const sample = SAMPLE.exec(sentence);
  const sampleSize = sample ? Number(sample[1]) : undefined;
  const low = Math.min(...figures);
  const high = Math.max(...figures);
  if (low === high) return sampleSize ? { kind: 'POINT', value: low, sampleSize } : { kind: 'POINT', value: low };
  return { kind: 'RANGE', low: Math.max(low, 1e-4), high: Math.min(high, 1 - 1e-4) };
}

/** Transactions a sentence states per period, scaled to the arrangement's period in days. */
export function readPerPeriod(sentence: string, periodDays: number): Observation['value'] | null {
  const m = PER_PERIOD.exec(sentence);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  const per = { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2]!.toLowerCase() as 'hour' | 'day' | 'week' | 'month' | 'year'];
  if (!(n > 0) || !per) return null;
  // Working hours, not round-the-clock: an hourly rate is read as an eight-hour day.
  const perDay = m[2]!.toLowerCase() === 'hour' ? n * 8 : n / per;
  return { kind: 'POINT', value: perDay * Math.max(1, periodDays) };
}

/** Money a sentence states per unit of work, in the arrangement's currency (USD figures only for USD). */
export function readUnitCost(sentence: string, currency: string): Observation['value'] | null {
  if (currency.toUpperCase() !== 'USD' || !PER_UNIT.test(sentence)) return null;
  const m = MONEY.exec(sentence);
  if (!m) return null;
  const v = Number((m[1] ?? m[2])!.replace(/,/g, ''));
  return v > 0 ? { kind: 'POINT', value: v } : null;
}

/**
 * Whether an opening's own statement says its payer prepays (true), pays
 * after delivery (false), or neither (null).
 */
export function prepaysIn(text: string): boolean | null {
  let prepays = false;
  let after = false;
  for (const s of sentences(text)) {
    if (WORDS.prepay.test(s) && !WORDS.negated.test(s)) prepays = true;
    else if (WORDS.postpay.test(s) || (WORDS.prepay.test(s) && WORDS.negated.test(s))) after = true;
  }
  return prepays ? true : after ? false : null;
}

/**
 * Read every lever part's observations from researched statements. An
 * opening's statements are counted per opening for willingness (one buyer,
 * one trial); every other part is read sentence by sentence.
 */
export function leverObservations(statements: readonly LeverStatement[], options: { periodDays: number; currency: string }): LeverEvidence {
  const out = emptyLeverEvidence();
  const push = (part: LeverPart, st: LeverStatement, value: Observation['value'], measures: string, suffix = '') => {
    out[part].push({
      part,
      payer: st.payer,
      text: norm(st.text),
      obs: {
        id: `lever:${part}:${st.id}${suffix}`,
        value,
        context: { payer: st.payer ?? 'unstated', industry: norm(st.industry), arrangement: 'held' },
        lineage: st.lineage,
        source: st.source,
        observedAt: st.observedAt ?? null,
        measures: `${measures}: "${st.text.slice(0, 80)}"`,
      },
    });
  };
  // Willingness from openings: each opening whose terms say how its payer pays is one buyer observed.
  const byOpening = new Map<string, LeverStatement[]>();
  for (const st of statements) if (st.opportunityId) byOpening.set(st.opportunityId, [...(byOpening.get(st.opportunityId) ?? []), st]);
  for (const [opportunityId, group] of byOpening) {
    const verdicts = group.map((st) => ({ st, v: prepaysIn(st.text) })).filter((one) => one.v !== null);
    if (verdicts.length === 0) continue;
    const prepays = verdicts.some((one) => one.v === true);
    const first = verdicts[0]!.st;
    const lineage = [...new Set(verdicts.flatMap((one) => one.st.lineage))];
    push('prepayWillingness', { ...first, id: `opp:${opportunityId}`, lineage }, { kind: 'COUNT', successes: prepays ? 1 : 0, trials: 1 }, prepays ? 'this payer was observed prepaying' : 'this payer was observed paying after delivery');
  }
  for (const st of statements) {
    sentences(st.text).forEach((s, i) => {
      const at = `#${i}`;
      const supplier = WORDS.supplier.test(s);
      const ai = WORDS.ai.test(s);
      // A claim's share of buyers who prepay: "12 of 40 hotels pay a deposit".
      if (!st.opportunityId && WORDS.prepay.test(s) && !WORDS.negated.test(s)) {
        const share = readShare(s);
        if (share) push('prepayWillingness', st, share, 'share of buyers who prepay', at);
      }
      if (WORDS.noRefund.test(s)) push('refundShare', st, { kind: 'POINT', value: 0, exact: true }, 'prepaid money stated non-refundable by its terms', at);
      else if (WORDS.refund.test(s)) {
        const share = readShare(s);
        if (share) push('refundShare', st, share, 'share of prepaid money refunded', at);
      }
      const days = readDays(s);
      if (days) {
        if (supplier && WORDS.pay.test(s)) push('supplierPaymentDays', st, days, 'days until the supplier must be paid', at);
        else if (WORDS.usable.test(s)) push('usableDays', st, days, 'days until paid money is usable', at);
        else if (WORDS.settle.test(s) || WORDS.postpay.test(s)) push('settlementDays', st, days, 'days until a buyer has paid', at);
        if (WORDS.acquire.test(s)) push('daysToAcquire', st, days, 'days to acquire buyers', at);
      }
      if (supplier && WORDS.failure.test(s)) {
        const share = readShare(s);
        if (share) push('supplierFailureRate', st, share, 'share of supplier deliveries that fail', at);
      }
      if (WORDS.capacity.test(s) || ai) {
        const perPeriod = readPerPeriod(s, options.periodDays);
        if (perPeriod) {
          if (supplier) push('supplierCapacity', st, perPeriod, 'supplier capacity per period', at);
          else if (ai) push('aiThroughput', st, perPeriod, 'AI-labor throughput per period', at);
        }
      }
      if (ai && !supplier) {
        const cost = readUnitCost(s, options.currency);
        if (cost) push('aiCost', st, cost, 'AI-labor cost per transaction', at);
      }
      if (WORDS.repeat.test(s)) {
        const share = readShare(s);
        if (share) push('repeatRate', st, share, 'share of buyers who buy again', at);
      }
    });
  }
  return out;
}

/**
 * The part construction composes for one lever quantity of one arrangement:
 * its bounds, and every observation that bears on it. An observation is about
 * these buyers when it is their own opening's term, or a claim that names
 * them; anything else is broad — it bounds, and never becomes a distribution.
 */
export function leverPart(
  evidence: readonly LeverObservation[] | undefined,
  target: { payer: string; industry: string | null; arrangement: string },
  bounds: { min: number; max: number },
): { min: number; max: number; context?: Record<string, string>; material?: string[]; observations?: Observation[] } {
  if (!evidence || evidence.length === 0) return { ...bounds };
  const payer = norm(target.payer);
  const about = (one: LeverObservation) => (one.payer !== null ? one.payer === payer : payer.length >= 4 && one.text.includes(payer));
  return {
    ...bounds,
    context: { payer, industry: norm(target.industry), arrangement: target.arrangement },
    material: [],
    observations: evidence.map((one) => ({ ...one.obs, context: { ...one.obs.context, payer: one.payer ?? (about(one) ? payer : 'unstated') }, broad: !about(one) })),
  };
}
