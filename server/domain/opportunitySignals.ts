/**
 * What kind of opening a claim establishes, as a closed vocabulary.
 *
 * ---------------------------------------------------------------------------
 * Why this is typed rather than matched
 * ---------------------------------------------------------------------------
 *
 * Deciding whether an accepted claim is a *piece of work* used to be a string
 * comparison: `harvest()` accepted a claim whose `evidence_lane` was the
 * literal `demand_signal`. Fragment planners name their own lanes — the gate
 * counts coverage per declared id, which is the point of a lane — so the two
 * halves were never speaking the same vocabulary. Production wrote seventeen
 * distinct lane ids across 82 claims and `demand_signal` appears zero times.
 * The bridge could not fire, and no amount of correct research was going to
 * make it.
 *
 * Widening the match would have been the wrong repair, because it would make
 * "is this a piece of work" depend on how a planner worded an identifier —
 * model output deciding state, which §8 keeps out. So a claim *declares* a
 * signal from this set, the declaration is validated exactly on submission, and
 * anything outside the set refuses the whole submission rather than being
 * stored and compared against nothing.
 *
 * ---------------------------------------------------------------------------
 * What a signal is, and what it is not
 * ---------------------------------------------------------------------------
 *
 * It says the claim establishes an opening of a named kind. It says nothing
 * about whether the opening is worth taking, what it pays, who the payer is or
 * whether Brain could deliver it — those are the card's unknowns, and a piece
 * arrives with them blank on purpose (§30). It is also **not** a replacement
 * for the evidence lane: lanes carry coverage and remain exactly as they were,
 * because "which question does this answer" and "does this describe an opening"
 * are different questions about one claim.
 *
 * A claim with no signal is ordinary descriptive evidence. That is the common
 * case and it is not a deficiency: most of a good fragment's claims establish
 * the context an opening is read in.
 */
import { OPPORTUNITY_SIGNALS, type CashMechanism, type OpportunitySignal } from './types.ts';

export { OPPORTUNITY_SIGNALS };
export type { OpportunitySignal };

export function isOpportunitySignal(value: unknown): value is OpportunitySignal {
  return typeof value === 'string' && (OPPORTUNITY_SIGNALS as readonly string[]).includes(value);
}

/**
 * The mechanism a piece of the portfolio gets from its own signal.
 *
 * Read from the claim rather than from the bucket that happened to ask the
 * question. A bucket is *where Brain looked*; the signal is *what was found*,
 * and one broad bucket routinely turns up openings of several kinds — the
 * information-asymmetry question produced buyer demand, pricing spreads and a
 * recurring brief in one packet. Taking the mechanism from the bucket would
 * file all of those under one heading that is wrong for most of them.
 */
const MECHANISM: Record<OpportunitySignal, CashMechanism> = {
  ACTIVE_BUYER_DEMAND: 'EXPLICIT_PAID_REQUEST',
  PAID_TASK_OR_CONTRACT: 'EXPLICIT_PAID_REQUEST',
  PRICING_OR_INFORMATION_ASYMMETRY: 'INFORMATION_ASYMMETRY',
  EXPIRING_OPENING: 'TEMPORARY_EXPLOIT',
  SUPPLY_DEMAND_MISMATCH: 'SUPPLY_DEMAND_MISMATCH',
  RESALABLE_ASSET_OPENING: 'RESALE_OR_ASSET',
  RECURRING_OUTSOURCED_WORK: 'PRODUCTIZED_SERVICE',
};

export function mechanismForSignal(signal: OpportunitySignal): CashMechanism {
  return MECHANISM[signal];
}

/** One line per signal, for the prompt that asks a worker to choose one. */
export const SIGNAL_GUIDE: Record<OpportunitySignal, string> = {
  ACTIVE_BUYER_DEMAND:
    'a named buyer has published that they want something and it is open now',
  PAID_TASK_OR_CONTRACT:
    'a specific paid task, bounty, solicitation or contract with a stated payment',
  PRICING_OR_INFORMATION_ASYMMETRY:
    'the same deliverable at two published prices, or a fact somebody is visibly paying to obtain',
  EXPIRING_OPENING:
    'the source states a closing date, an expiry, or a limited remaining quantity',
  SUPPLY_DEMAND_MISMATCH:
    'a published demand and a published available supply that are not connected',
  RESALABLE_ASSET_OPENING:
    'an asset with a published asking price and published evidence of demand above it',
  RECURRING_OUTSOURCED_WORK:
    'one narrow brief commissioned repeatedly as separate custom jobs',
};
