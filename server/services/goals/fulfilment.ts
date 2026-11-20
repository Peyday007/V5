/**
 * The fulfilment lever (§99 FULFILMENT): whether evidence shows a cheaper way
 * to fulfil an opening, read by the reconstruction's operators
 * (`reconstruction.ts` `buildOperators`) and the multidirectional seeds
 * (`reasoning/directions.ts`). Pure.
 */
import type { ModelInput, ModelledOpportunity } from '../cash/goalScenario.ts';
import { DISTRIBUTION_PROVENANCES } from '../../domain/scenario.ts';

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

function knownMid(input: ModelInput): number | null {
  if (input.value !== null) return input.value;
  if (input.inferred) return input.inferred.p50;
  if (input.low !== null && input.high !== null) return (input.low + input.high) / 2;
  return input.low ?? input.high ?? null;
}

/**
 * How an opening is fulfilled is a decision, not a given (owner, 2026-11-20:
 * "alternative fulfillment", "supplier terms" are restructurings Brain must
 * consider, each with "a defensible mechanism", and "this is not permission to
 * invent favorable assumptions").
 *
 * Production, 2026-11-20 (goal $5K/mo): moving direct cost to the bottom of
 * its range lifted reach from 0% to 78.3%, and no operator could change how an
 * opening is fulfilled. A cheaper route is taken only where the opening's own
 * cost evidence shows one: a DIRECT-tier estimate (this deliverable, these
 * buyers), justified as a distribution, whose observed fulfilment costs span
 * enough that engaging a supplier from their cheaper half lowers the cost the
 * plan carries to at most `FULFILMENT_SAVING` of it. The re-costed input is
 * that cheaper half of the same observations — still evidence, still drawn as
 * a distribution — so the move is an ESTIMATE and counts toward the
 * assumption-free reading. A cost known only from other populations or
 * mechanisms (COMPARABLE, COMPONENT, MECHANISM) is at most an ASSUMPTION, never
 * the headline (invariant 39); a cost nobody evidenced is no route at all,
 * only the question that would find one.
 */
/** Direct cost at or above this share of the price is worth re-routing. */
export const FULFILMENT_COST_SHARE = 0.2;
/** A route is cheaper only when it carries at most this multiple of the cost the plan holds. */
export const FULFILMENT_SAVING = 0.8;
/** Observations needed before the cheaper half of them names a route. */
export const FULFILMENT_MIN_OBSERVATIONS = 4;

export interface FulfilmentReading {
  /** The re-costed direct cost, or null when nothing evidences a cheaper route. */
  cost: ModelInput | null;
  /** The cost is this deliverable's own evidence (ESTIMATE); otherwise it rests on other populations (ASSUMPTION). */
  evidenced: boolean;
  /** The route to engage, in words. */
  route: string;
  /** The evidence the route rests on, in words. */
  evidence: string;
  /** The cost the plan holds now (middle), and the route's range. */
  from: number;
  to: { low: number; high: number } | null;
  /** What would establish (or refute) a cheaper route for these buyers. */
  question: string;
}

const quantile = (sorted: readonly number[], q: number): number => {
  if (sorted.length === 0) return 0;
  const at = q * (sorted.length - 1);
  const i = Math.floor(at);
  const a = sorted[i]!;
  const b = sorted[Math.min(sorted.length - 1, i + 1)]!;
  return a + (at - i) * (b - a);
};

/** A source in words a person may read: no "word:123" shapes (`internalKeyIn`). */
function sourceWords(src: ModelInput['source']): string {
  if (!src) return 'no named source';
  const text = src.kind === 'CLAIM' ? `accepted claim ${src.ref}` : src.kind === 'URL' ? src.ref : src.note ?? `${src.kind.toLowerCase().replace(/_/g, ' ')} evidence`;
  return text.replace(/([a-z][a-z-]*):(\d)/gi, '$1 $2').slice(0, 160);
}

/**
 * Whether evidence shows a cheaper way to fulfil this opening, and what it
 * would cost. Null when the opening is agreed, already re-routed, unpriced or
 * its direct cost is too small a share of its price to matter. Pure.
 */
export function fulfilmentRoute(o: ModelledOpportunity): FulfilmentReading | null {
  if (o.agreedValue > 0 || o.fulfilment) return null;
  const price = knownMid(o.price);
  const from = knownMid(o.directCost);
  if (price === null || !(price > 0) || from === null || !(from > 0) || from / price < FULFILMENT_COST_SHARE) return null;
  const deliverable = (o.opportunity.offerScope ?? o.opportunity.title).slice(0, 80);
  const buyers = (o.opportunity.payer ?? 'its buyers').slice(0, 60);
  const question = `Who fulfils "${deliverable}" for ${buyers}, and at what published cost per deal (the plan holds about ${money(from)})?`;
  const inf = o.directCost.inferred;
  const none: FulfilmentReading = { cost: null, evidenced: false, route: '', evidence: o.directCost.note.slice(0, 160), from, to: null, question };
  if (!inf || inf.tier === 'UNKNOWN' || inf.tier === 'ASSUMED') return none;
  const d = o.directCost.distribution;
  const evidenced =
    inf.tier === 'DIRECT' && inf.justified && !inf.contested && DISTRIBUTION_PROVENANCES.includes(o.directCost.provenance) && d?.kind === 'EMPIRICAL' && d.values.length >= FULFILMENT_MIN_OBSERVATIONS;
  const src = sourceWords(o.directCost.source);
  if (evidenced && d?.kind === 'EMPIRICAL') {
    const values = [...d.values].sort((a, b) => a - b);
    const median = quantile(values, 0.5);
    const cheaper = values.filter((v) => v <= median + 1e-9);
    const p50 = quantile(cheaper, 0.5);
    if (cheaper.length === 0 || p50 > from * FULFILMENT_SAVING) return none;
    const to = { low: cheaper[0]!, high: cheaper[cheaper.length - 1]! };
    const route = `a supplier at the cheaper half of ${inf.observations} observed fulfilment costs`;
    const evidence = `${inf.observations} DIRECT observation(s) of what fulfilling it costs (${src})`;
    return {
      cost: {
        value: null,
        low: to.low,
        high: to.high,
        provenance: o.directCost.provenance,
        source: o.directCost.source,
        note: `fulfilled through ${route}: ${money(to.low)}–${money(to.high)} a deal, from ${evidence}`,
        distribution: { kind: 'EMPIRICAL', values: cheaper },
        inferred: { ...inf, p10: quantile(cheaper, 0.1), p50, p90: quantile(cheaper, 0.9) },
      },
      evidenced: true,
      route,
      evidence,
      from,
      to,
      question,
    };
  }
  // Another population's or mechanism's figure: a hypothesis about a route, never evidence of one.
  const low = inf.p10;
  const high = inf.p50;
  if (!(high > 0) || (low + high) / 2 > from * FULFILMENT_SAVING) return { ...none, evidence: `${inf.tier} estimate (${src})` };
  return {
    cost: {
      value: null,
      low,
      high,
      provenance: 'ASSUMPTION',
      source: o.directCost.source,
      note: `assumed: a supplier at ${money(low)}–${money(high)} a deal, carried from a ${inf.tier} estimate (${src}), which is not evidence about these buyers`,
      distribution: undefined,
      inferred: undefined,
    },
    evidenced: false,
    route: `a supplier at the cheaper end of a ${inf.tier.toLowerCase()} estimate from other populations`,
    evidence: `a ${inf.tier} estimate from ${inf.observations} observation(s) (${src})`,
    from,
    to: { low, high },
    question,
  };
}
