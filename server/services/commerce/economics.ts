/**
 * Whether the money works, derived from readings and withheld where it cannot
 * be.
 *
 * ---------------------------------------------------------------------------
 * A margin is not a fact until its inputs are
 * ---------------------------------------------------------------------------
 *
 * §30 records this correction once already, at the opportunity card: a margin
 * computed against an unknown cost *fails in the direction that makes a piece
 * look worth doing*, which is the shape of error nobody notices because it
 * looks like ambition. Here it is worse, because the number decides whether
 * somebody buys stock. So every derivation below either resolves completely or
 * is withheld naming exactly which input is missing, and there is no branch
 * that treats an absent figure as zero.
 *
 * ---------------------------------------------------------------------------
 * The basis travels with the figure, and the weakest input wins
 * ---------------------------------------------------------------------------
 *
 * The brief asks for assumptions, estimates and measured results to stay
 * apart. A margin built from four published fees and one number somebody
 * guessed is an **assumption**, because the guess is load-bearing — averaging
 * the bases, or reporting the strongest, would describe a figure as better
 * evidenced than its weakest part.
 *
 * ---------------------------------------------------------------------------
 * Pure, for the reason the dispatcher's router is pure
 * ---------------------------------------------------------------------------
 *
 * A function over rows a caller fetched, so "why did Brain say this piece
 * cleared" is answerable afterwards from a recorded input rather than from a
 * re-run against a database that has moved on. Nothing here writes anything.
 */
import { basisOf, commerceSpec, weakestBasis } from '../../domain/commerce.ts';
import type {
  CommerceBasis,
  CommerceEvidence,
  CommerceFinding,
} from '../../domain/types.ts';

/** One resolved input: the figure, where it came from, and what kind it is. */
export interface Resolved {
  kind: CommerceFinding;
  value: number;
  basis: CommerceBasis;
  statement: string;
  evidenceId: string;
  observedAt: string | null;
}

/** A figure Brain derived, or the reason it would not. */
export type Derived =
  | { known: true; minor: number; basis: CommerceBasis; from: readonly CommerceFinding[] }
  | { known: false; missing: readonly CommerceFinding[]; why: string };

export interface Economics {
  /** What each input resolved to, for a reader who wants to argue with it. */
  inputs: Partial<Record<CommerceFinding, Resolved>>;
  /** Which load-bearing inputs nobody has established. The work that remains. */
  unknown: readonly CommerceFinding[];
  /**
   * What one sold unit leaves behind, after everything that scales with it.
   *
   * Advertising and content are deliberately *not* in it: those buy customers
   * rather than units, so folding them in would make the break-even
   * acquisition cost below compare a number against itself.
   */
  contributionPerUnit: Derived;
  /**
   * The most that may be paid to get one order. It is the contribution, which
   * is the whole point of computing the contribution separately.
   */
  breakEvenAcquisition: Derived;
  /** What has to be paid before anything comes back. */
  upfrontCash: Derived;
  /** Days from a buyer paying to the money being usable. */
  daysToUsableCash: { known: true; days: number; basis: CommerceBasis } | { known: false; missing: readonly CommerceFinding[] };
  /**
   * Every assumption the arithmetic rests on that no source stated, in words.
   *
   * §30's rule that a recommendation with no stated uncertainty cannot exist,
   * applied to a calculation: the loss model below is a choice Brain made, and
   * a margin presented without it would be a modelled number wearing the
   * authority of a measured one.
   */
  assumptions: readonly string[];
}

/** The per-unit costs. Each one is subtracted from the price. */
const UNIT_COSTS: readonly CommerceFinding[] = Object.freeze([
  'LANDED_UNIT_COST',
  'SHIPPING_COST',
]);

/** The rates taken off the selling price by somebody else. */
const PRICE_RATES: readonly CommerceFinding[] = Object.freeze([
  'PLATFORM_FEE',
  'PAYMENT_FEE',
  'CREATOR_COMMISSION',
]);

/** The rates at which a shipped unit produces no revenue at all. */
const LOSS_RATES: readonly CommerceFinding[] = Object.freeze([
  'RETURN_RATE',
  'REFUND_RATE',
  'CHARGEBACK_RATE',
]);

/**
 * Everything the contribution needs. Reported as `unknown` when absent, which
 * is what the stage derivation and the ranking both read.
 *
 * The loss rates are in it deliberately. A margin that ignored returns because
 * nobody had established the return rate would be the favourable assumption
 * this module exists to refuse — and on this business model returns are the
 * line most likely to turn a positive margin negative.
 */
export const REQUIRED_FOR_MARGIN: readonly CommerceFinding[] = Object.freeze([
  'SELLING_PRICE',
  ...UNIT_COSTS,
  ...PRICE_RATES,
  ...LOSS_RATES,
]);

const PPM = 1_000_000;

/**
 * Pick one reading per kind: strongest basis first, then most recently
 * observed, then most recently filed.
 *
 * Strongest basis first rather than most recent, because a measured result
 * from last week beats an estimate from yesterday — that is the whole reason
 * for running a test. Among equals the observation date decides, and
 * `created_at` is only the last resort, since it says when Brain filed a
 * reading rather than when the thing was true.
 */
export function resolveInputs(
  evidence: readonly CommerceEvidence[],
): Partial<Record<CommerceFinding, Resolved>> {
  const out: Partial<Record<CommerceFinding, Resolved>> = {};
  for (const row of evidence) {
    const value = figureOf(row);
    if (value === null) continue;
    const candidate: Resolved = {
      kind: row.kind,
      value,
      basis: basisOf(row.origin),
      statement: row.statement,
      evidenceId: row.id,
      observedAt: row.observedAt,
    };
    const held = out[row.kind];
    if (!held || beats(candidate, held, row, evidence)) out[row.kind] = candidate;
  }
  return out;
}

/**
 * The figure a reading carries, read from the column its **kind** declares.
 *
 * Never "whichever column happens to be set". `validateCommerce` refuses a
 * figure in the wrong field at the claim door, but a reading can also arrive
 * from a person or a settled test, and the schema deliberately does not
 * enumerate which kind owns which column — doing that would mean restating the
 * whole vocabulary in a CHECK constraint, in two dialects, where it would
 * drift from `commerceSpec`.
 *
 * So the spec decides here, and a row carrying a figure in a column its kind
 * does not own contributes **nothing** rather than the wrong number. That is
 * the direction that matters: a platform fee of 8 read out of the money column
 * would be silently summed as 8 minor units, and the result would still look
 * like a number.
 */
function figureOf(row: CommerceEvidence): number | null {
  switch (commerceSpec(row.kind).figure) {
    case 'MONEY':
      return row.amountMinor;
    case 'RATE':
      return row.ratePpm;
    case 'DAYS':
      return row.days;
    case 'COUNT':
      return row.countUnits;
    default:
      return null;
  }
}

function beats(
  candidate: Resolved,
  held: Resolved,
  row: CommerceEvidence,
  all: readonly CommerceEvidence[],
): boolean {
  const rank = { ASSUMPTION: 0, ESTIMATE: 1, MEASURED: 2 } as const;
  if (rank[candidate.basis] !== rank[held.basis]) {
    return rank[candidate.basis] > rank[held.basis];
  }
  if (candidate.observedAt !== held.observedAt) {
    // An undated reading never displaces a dated one. §30's rule that an
    // undated signal cannot be told apart from one somebody remembers from
    // March, at the comparison where it would silently decide a price.
    if (!candidate.observedAt) return false;
    if (!held.observedAt) return true;
    return candidate.observedAt > held.observedAt;
  }
  const heldRow = all.find((one) => one.id === held.evidenceId);
  if (!heldRow) return true;
  return row.createdAt > heldRow.createdAt || (row.createdAt === heldRow.createdAt && row.id > heldRow.id);
}

export function readEconomics(evidence: readonly CommerceEvidence[]): Economics {
  const inputs = resolveInputs(evidence);
  const unknown = REQUIRED_FOR_MARGIN.filter((kind) => !inputs[kind]);

  const assumptions = [
    'A returned, refunded or charged-back unit is modelled as producing no revenue and ' +
      'recovering no fee, while its product and shipping cost stay spent. That is the ' +
      'conservative reading; where a supplier restocks returns or a platform refunds its own ' +
      'fee, the real contribution is higher than this figure.',
    'Content and advertising are treated as the cost of acquiring a customer rather than as a ' +
      'cost of a unit, so they are absent from the contribution and are what the break-even ' +
      'acquisition figure is there to be compared against.',
    'Every rate is applied to the selling price as published, before any discount, because no ' +
      'source here established a discount.',
  ];

  const contribution = deriveContribution(inputs);
  return {
    inputs,
    unknown,
    contributionPerUnit: contribution,
    /*
     * The same number, named for the decision it answers.
     *
     * Not a second calculation: the most that may be spent acquiring one order
     * *is* what one order leaves behind, and computing it any other way would
     * be two derivations of one fact that could disagree.
     */
    breakEvenAcquisition: contribution.known
      ? { ...contribution, from: ['SELLING_PRICE'] as const }
      : contribution,
    upfrontCash: deriveUpfront(inputs),
    daysToUsableCash: deriveDays(inputs),
    assumptions,
  };
}

function deriveContribution(inputs: Partial<Record<CommerceFinding, Resolved>>): Derived {
  const missing = REQUIRED_FOR_MARGIN.filter((kind) => !inputs[kind]);
  if (missing.length > 0) {
    return {
      known: false,
      missing,
      why:
        `The contribution is withheld because ${missing.length} of its inputs ` +
        `${missing.length === 1 ? 'is' : 'are'} not established: ${missing.join(', ')}. ` +
        'Computing it from the rest would produce a number that is wrong in the encouraging ' +
        'direction, which is the one direction nobody checks.',
    };
  }

  const price = inputs.SELLING_PRICE!.value;
  const rateSum = PRICE_RATES.reduce((total, kind) => total + inputs[kind]!.value, 0);
  const lossSum = LOSS_RATES.reduce((total, kind) => total + inputs[kind]!.value, 0);
  const unitCost = UNIT_COSTS.reduce((total, kind) => total + inputs[kind]!.value, 0);

  /*
   * A loss rate above 100% is a contradiction in the evidence rather than a
   * number to clamp.
   *
   * Clamping it to 1 would silently produce the most pessimistic contribution
   * the arithmetic allows and report it as derived, which is a made-up figure
   * wearing a citation. Withholding names the disagreement, and the three
   * readings stay on their own rows where somebody can see which sources
   * disagree — §14's rule that a contradiction is classified rather than
   * averaged away.
   */
  if (lossSum > PPM || rateSum > PPM) {
    return {
      known: false,
      missing: lossSum > PPM ? LOSS_RATES : PRICE_RATES,
      why:
        'The established rates sum to more than the whole selling price, which cannot all be ' +
        'true at once. That is a contradiction between sources rather than a very thin ' +
        'margin, so nothing is derived until it is resolved.',
    };
  }

  const kept = PPM - lossSum;
  const netRevenue = Math.round((price * (PPM - rateSum) * kept) / (PPM * PPM));
  const minor = netRevenue - unitCost;

  const basis = weakestBasis(REQUIRED_FOR_MARGIN.map((kind) => inputs[kind]!.basis));
  return {
    known: true,
    minor,
    basis: basis ?? 'ASSUMPTION',
    from: REQUIRED_FOR_MARGIN,
  };
}

/**
 * What leaves the account before anything comes back.
 *
 * The minimum order is in it because on this business model it is the thing
 * that decides whether an opening is reachable at all: a supplier with a
 * 500-unit minimum and a good margin needs five hundred units of capital
 * before it earns one. Content is in it because it is spent before the first
 * sale; advertising is not, because it is spent per order against a
 * break-even that is already derived.
 */
function deriveUpfront(inputs: Partial<Record<CommerceFinding, Resolved>>): Derived {
  const needed: readonly CommerceFinding[] = ['MINIMUM_ORDER', 'LANDED_UNIT_COST', 'CONTENT_COST'];
  const missing = needed.filter((kind) => !inputs[kind]);
  if (missing.length > 0) {
    return {
      known: false,
      missing,
      why:
        `The upfront cash is withheld because ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not established. A figure that left out the ` +
        'minimum order would say a piece is reachable with money it is not reachable with.',
    };
  }
  const minor =
    inputs.MINIMUM_ORDER!.value * inputs.LANDED_UNIT_COST!.value + inputs.CONTENT_COST!.value;
  const basis = weakestBasis(needed.map((kind) => inputs[kind]!.basis));
  return { known: true, minor, basis: basis ?? 'ASSUMPTION', from: needed };
}

function deriveDays(
  inputs: Partial<Record<CommerceFinding, Resolved>>,
): Economics['daysToUsableCash'] {
  const needed: readonly CommerceFinding[] = ['DELIVERY_TIME', 'PAYOUT_DELAY'];
  const missing = needed.filter((kind) => !inputs[kind]);
  if (missing.length > 0) return { known: false, missing };
  const basis = weakestBasis(needed.map((kind) => inputs[kind]!.basis));
  return {
    known: true,
    days: inputs.DELIVERY_TIME!.value + inputs.PAYOUT_DELAY!.value,
    basis: basis ?? 'ASSUMPTION',
  };
}
