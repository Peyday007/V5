/**
 * Why an arrangement is attractive, as opposed to what industry it is in (§82).
 *
 * A local shared mailer is a good example of what this module exists to
 * generalise, and a bad template. What makes it work is not postcards: each
 * buyer pays a small, understandable price; several independent buyers fund one
 * shared run, so its fixed cost is divided; they pay before the run is bought;
 * the run happens only once enough have committed; it repeats with a fresh
 * group; and the money arrives within days. Every one of those is a property of
 * the *transaction design*, and each can be produced in markets that have
 * nothing to do with mail.
 *
 * So an arrangement Brain constructs carries a design — independent choices of
 * who fulfils, who pays, how buyers are aggregated, when money moves, who bears
 * the risk and what makes it recur — and its properties are *derived* from that
 * design by fixed rules. Three things follow, and they are the whole point:
 *
 *   * **Reverse construction.** The goal's own limits say which properties it
 *     needs (little time → short time to cash; little money before the first
 *     payment → nothing at risk before buyers pay; a remainder far beyond any
 *     single deal → repeatable volume). Designs are chosen *for* those
 *     properties, and the map is then searched — or the world is asked — for
 *     buyers, needs and supply that fit the design.
 *   * **A property is a hypothesis with its evidence named.** Prepayment needs
 *     evidence buyers of this kind prepay; a shared run needs a real fixed cost
 *     and a realistic minimum participation; repeatability needs evidence of
 *     repeat buying. Each property names the decomposition parts that would
 *     establish it, and those parts become the research question. A property
 *     that nothing has established is never treated as true.
 *   * **Failure is structural, not optimistic.** `stressDesign` asks what each
 *     design loses when buyers do not show, presales fail, payment is late,
 *     refunds are owed or supply falls short — worst case on bounds, because an
 *     unknown is never a favourable assumption. A design survives a tight
 *     money limit only when its downside is capped *by construction* (a
 *     threshold presale spends nothing until enough have prepaid), never by
 *     assuming the buyers will come.
 *
 * Nothing here names a business, a sector or a price. It is a closed design
 * vocabulary and the rules over it; which combinations exist is decided by
 * coherence rules, and which are worth asking about by the goal.
 */
import type { CashMechanism } from '../../domain/types.ts';

/** The ways an arranger is paid, and what each needs to exist first. */
export const STRUCTURES = {
  PRODUCE: {
    label: 'Brain produces it and charges a fee',
    capture: 'FEE',
    needsSupply: false,
    needsDeliverable: true,
    capital: 'NONE',
    alreadyHeldAs: ['PRODUCTIZED_SERVICE', 'CAPABILITY_ARBITRAGE'],
  },
  BROKER: {
    label: 'connect the buyer with a supplier for a commission',
    capture: 'COMMISSION',
    needsSupply: true,
    needsDeliverable: false,
    capital: 'NONE',
    alreadyHeldAs: ['SUPPLY_DEMAND_MISMATCH', 'INFORMATION_ASYMMETRY'],
  },
  REFERRAL: {
    label: 'send qualified buyers to a supplier who pays per referral',
    capture: 'FEE',
    needsSupply: true,
    needsDeliverable: false,
    capital: 'NONE',
    alreadyHeldAs: [],
  },
  SUBCONTRACT: {
    label: 'own the buyer, pay a supplier to deliver, and keep the margin',
    capture: 'MARGIN',
    needsSupply: true,
    needsDeliverable: false,
    capital: 'PER_DEAL',
    alreadyHeldAs: ['SUBCONTRACTED_FULFILMENT'],
  },
  POOL: {
    label: 'pool several buyers’ purchases with one supplier and keep part of the volume discount',
    capture: 'MARGIN',
    needsSupply: true,
    needsDeliverable: false,
    capital: 'PER_DEAL',
    alreadyHeldAs: ['JIGSAW_COMBINATION'],
  },
} as const satisfies Record<string, { label: string; capture: 'FEE' | 'COMMISSION' | 'MARGIN'; needsSupply: boolean; needsDeliverable: boolean; capital: 'NONE' | 'PER_DEAL'; alreadyHeldAs: readonly CashMechanism[] }>;
export type Structure = keyof typeof STRUCTURES;
export const STRUCTURE_KEYS = Object.keys(STRUCTURES) as Structure[];

/** When the buyer's money moves. */
export const FUNDING = ['ON_DELIVERY', 'PREPAID', 'THRESHOLD_PRESALE'] as const;
export type Funding = (typeof FUNDING)[number];
/** Whether one buyer is served at a time or several share one fulfilment. */
export const AGGREGATION = ['SINGLE', 'POOLED_BUYERS'] as const;
export type Aggregation = (typeof AGGREGATION)[number];
/** What makes the purchase happen again. */
export const REPEAT = ['ONE_OFF', 'RECURRING_COHORT', 'SUBSCRIPTION'] as const;
export type Repeat = (typeof REPEAT)[number];

export interface Design {
  base: Structure;
  funding: Funding;
  aggregation: Aggregation;
  repeat: Repeat;
}

/** Facts read off a design rather than chosen: who pays, who fulfils, who carries the loss. */
export function designFacts(d: Design): { payer: 'BUYER' | 'SUPPLIER'; fulfiller: 'BRAIN' | 'SUPPLIER'; riskBearer: 'ARRANGER' | 'SUPPLIER' | 'NOBODY_BEFORE_COMMITMENT' } {
  const def = STRUCTURES[d.base];
  const payer = d.base === 'REFERRAL' ? 'SUPPLIER' : 'BUYER';
  const fulfiller = def.needsSupply ? 'SUPPLIER' : 'BRAIN';
  const riskBearer =
    d.funding === 'THRESHOLD_PRESALE' ? 'NOBODY_BEFORE_COMMITMENT' : def.capture === 'MARGIN' || d.aggregation === 'POOLED_BUYERS' ? 'ARRANGER' : 'SUPPLIER';
  return { payer, fulfiller, riskBearer };
}

/** The design each structure had before designs existed; keeps their keys and history. */
export function defaultDesign(base: Structure): Design {
  return { base, funding: 'ON_DELIVERY', aggregation: base === 'POOL' ? 'POOLED_BUYERS' : 'SINGLE', repeat: 'ONE_OFF' };
}

export function isDefaultDesign(d: Design): boolean {
  const base = defaultDesign(d.base);
  return d.funding === base.funding && d.aggregation === base.aggregation && d.repeat === base.repeat;
}

/**
 * Whether a design makes sense at all. Rules, not a list: each refuses a
 * combination that cannot exist rather than one somebody disliked.
 */
export function coherent(d: Design): boolean {
  // A supplier paying per referral pays after the referral; the buyer pays the
  // supplier, not the arranger, so neither prepayment nor a presale runs through us.
  if (d.base === 'REFERRAL' && (d.funding !== 'ON_DELIVERY' || d.aggregation !== 'SINGLE')) return false;
  // Pooling purchases is pooled by definition.
  if (d.base === 'POOL' && d.aggregation !== 'POOLED_BUYERS') return false;
  // A threshold is a number of participants: it needs more than one buyer.
  if (d.funding === 'THRESHOLD_PRESALE' && d.aggregation !== 'POOLED_BUYERS') return false;
  // A commission is taken from a sale the supplier makes; the buyer's money goes to the supplier.
  if (d.base === 'BROKER' && d.funding === 'PREPAID') return false;
  return true;
}

/** Every coherent design, defaults first so a capped generator keeps the old arrangements. */
export function allDesigns(bases: readonly Structure[]): Design[] {
  const out: Design[] = bases.map(defaultDesign);
  for (const base of bases) {
    for (const funding of FUNDING) {
      for (const aggregation of AGGREGATION) {
        for (const repeat of REPEAT) {
          const d: Design = { base, funding, aggregation, repeat };
          if (!coherent(d) || isDefaultDesign(d)) continue;
          out.push(d);
        }
      }
    }
  }
  return out;
}

export function designKey(d: Design): string {
  return `${d.base}/${d.funding}/${d.aggregation}/${d.repeat}`;
}

/** Decomposition parts beyond the core ones a design adds, each a thing research must establish. */
export const DESIGN_PART_ASK: Record<string, string> = {
  fixed_cost: 'the fixed cost of one shared run of the work (what it costs whether one buyer or many take part), with a published figure',
  min_participants: 'how many buyers must join one shared run before it pays for itself, and how many comparable shared or group purchases actually attract',
  prepay_share: 'whether buyers of this kind are published as paying before delivery (deposits, presales, prepaid packages), and what share do',
  repeat_rate: 'whether these buyers buy this again, how often, and whether a fresh group of buyers can be found for each new run',
  days_to_cash: 'how many days from agreement to money the arranger can use (payment terms, payout timing)',
  refund_terms: 'what is refunded if the run does not happen, and whether comparable sellers publish such terms',
};

export interface PropertyRule {
  label: string;
  /** Why the property makes money easier or safer. */
  why: string;
  holds: (d: Design) => boolean;
  /** The parts that must be established before the property may be relied on. */
  needs: string[];
}

/** The economic properties a design can have, derived and never declared. */
export const PROPERTIES = {
  SHARED_FIXED_COST: {
    label: 'several buyers share one fixed cost',
    why: 'each buyer pays a fraction of a cost none would pay alone, so the price is affordable and the margin grows with each extra buyer',
    holds: (d: Design) => d.aggregation === 'POOLED_BUYERS',
    needs: ['fixed_cost', 'min_participants'],
  },
  AFFORDABLE_UNIT_PRICE: {
    label: 'a small price per buyer',
    why: 'a buyer can say yes without a budget process, which shortens the sale',
    holds: (d: Design) => d.aggregation === 'POOLED_BUYERS' || d.repeat === 'SUBSCRIPTION',
    needs: ['value'],
  },
  PREPAID_FULFILMENT: {
    label: 'buyers pay before the work is bought',
    why: 'the buyers fund the fulfilment, so it needs no capital of ours',
    holds: (d: Design) => d.funding === 'PREPAID' || d.funding === 'THRESHOLD_PRESALE',
    needs: ['prepay_share'],
  },
  NO_CAPITAL_AT_RISK: {
    label: 'nothing of ours is spent before buyers have committed',
    why: 'a failed sale costs nothing but the effort of asking',
    holds: (d: Design) => d.funding === 'THRESHOLD_PRESALE' || (STRUCTURES[d.base].capital === 'NONE' && d.aggregation === 'SINGLE'),
    needs: [],
  },
  SHORT_TIME_TO_CASH: {
    label: 'money arrives within days of agreement',
    why: 'cash lands inside a short deadline and can fund the next round',
    holds: (d: Design) => d.funding !== 'ON_DELIVERY' || d.base === 'PRODUCE' || d.base === 'REFERRAL',
    needs: ['days_to_cash'],
  },
  LOW_BUYER_RISK: {
    label: 'the buyer risks little',
    why: 'a refundable presale or a supplier-paid fee removes the reason to say no',
    holds: (d: Design) => d.funding === 'THRESHOLD_PRESALE' || designFacts(d).payer === 'SUPPLIER',
    needs: ['refund_terms'],
  },
  LOW_MARGINAL_COST: {
    label: 'one more buyer costs little to serve',
    why: 'contribution per extra sale is close to its price',
    holds: (d: Design) => designFacts(d).fulfiller === 'BRAIN' || d.aggregation === 'POOLED_BUYERS',
    needs: ['cost'],
  },
  REPEATABLE: {
    label: 'it sells again',
    why: 'one working process produces many deals instead of one',
    holds: (d: Design) => d.repeat !== 'ONE_OFF',
    needs: ['repeat_rate', 'buyers'],
  },
  REUSABLE_INFRASTRUCTURE: {
    label: 'each new group reuses what the first one built',
    why: 'the second run costs less to set up than the first, so later runs carry more margin',
    holds: (d: Design) => d.repeat === 'RECURRING_COHORT' && d.aggregation === 'POOLED_BUYERS',
    needs: ['repeat_rate', 'fixed_cost'],
  },
  RECURRING_REVENUE: {
    label: 'the same buyer pays every period',
    why: 'revenue compounds without a new sale each time',
    holds: (d: Design) => d.repeat === 'SUBSCRIPTION',
    needs: ['repeat_rate'],
  },
} as const satisfies Record<string, PropertyRule>;
export type EconomicProperty = keyof typeof PROPERTIES;
export const PROPERTY_KEYS = Object.keys(PROPERTIES) as EconomicProperty[];

export function propertiesOf(d: Design): EconomicProperty[] {
  return PROPERTY_KEYS.filter((key) => PROPERTIES[key].holds(d));
}

/** The parts a design's properties need established, beyond the ones every arrangement asks. */
export function designParts(d: Design): string[] {
  const parts = new Set<string>();
  for (const key of propertiesOf(d)) for (const part of PROPERTIES[key].needs) parts.add(part);
  return [...parts];
}

/** What the goal's limits are, as this module reads them. */
export interface GoalLimits {
  daysLeft: number | null;
  remainingCents: number;
  capitalCeilingCents: number | null;
  /** Money the owner allows to be tied up before the first customer payment. */
  capitalBeforeProofCents: number | null;
  /** The most the openings held could bring, in cents; null when nothing was modelled. */
  bestReachCents: number | null;
}

/**
 * Reverse construction's starting point: which properties the goal needs, each
 * with the limit it was read from. Read from the goal's own numbers; no
 * threshold here is a target somebody invented — each compares two of the
 * goal's figures with each other.
 */
export function targetProperties(limits: GoalLimits): { property: EconomicProperty; because: string }[] {
  const out: { property: EconomicProperty; because: string }[] = [];
  const preIncome = limits.capitalBeforeProofCents ?? limits.capitalCeilingCents;
  if (preIncome !== null && preIncome < limits.remainingCents) {
    out.push({ property: 'NO_CAPITAL_AT_RISK', because: `only ${preIncome / 100} may be tied up before money comes in, against ${limits.remainingCents / 100} still to collect` });
    out.push({ property: 'PREPAID_FULFILMENT', because: 'buyers must fund the fulfilment, since the goal cannot' });
  }
  if (limits.daysLeft !== null) {
    out.push({ property: 'SHORT_TIME_TO_CASH', because: `cash must settle within the ${limits.daysLeft} day(s) left` });
  }
  if (limits.bestReachCents === null || limits.bestReachCents < limits.remainingCents) {
    out.push({ property: 'REPEATABLE', because: limits.bestReachCents === null ? 'nothing held yet reaches the goal, so one process must produce many deals' : `the openings held reach ${Math.round(limits.bestReachCents / 100)} of ${limits.remainingCents / 100}, so one process must produce many deals` });
    out.push({ property: 'SHARED_FIXED_COST', because: 'dividing a fixed cost across many buyers is how many small sales add up to the remainder' });
  }
  return out;
}

/** The failure modes every design is stressed under. */
export const FAILURES = ['FEWER_BUYERS', 'FAILED_PRESALE', 'DELAYED_PAYMENT', 'REFUNDS', 'SUPPLIER_SHORTFALL'] as const;
export type Failure = (typeof FAILURES)[number];

export interface StressReading {
  /** SAFE: worst case spends nothing of ours by construction. BOUNDED: worst case is known and fits. UNKNOWN: worst case rests on a part nobody established. EXCEEDS: worst case is known and does not fit. */
  exposure: 'SAFE' | 'BOUNDED' | 'UNKNOWN' | 'EXCEEDS';
  /** The worst-case money of ours at risk before buyers pay, in cents, when it is known. */
  worstCaseCents: number | null;
  failures: { failure: Failure; effect: string }[];
}

/**
 * What each design loses when things go wrong, on bounds rather than hopes.
 *
 * `atRiskCents` is the worst-case known figure for the money a run or a deal
 * ties up (the fixed cost of a shared run, or what supply is paid per deal),
 * or null when nothing has established it. A known figure larger than the
 * goal's pre-income allowance with no structural cap EXCEEDS; an unknown one is
 * UNKNOWN — which is a question, never a pass.
 */
export function stressDesign(d: Design, input: { atRiskCents: number | null; limitCents: number | null }): StressReading {
  const facts = designFacts(d);
  const needsMoney = STRUCTURES[d.base].capital !== 'NONE' || d.aggregation === 'POOLED_BUYERS';
  const threshold = d.funding === 'THRESHOLD_PRESALE';
  const prepaid = d.funding === 'PREPAID';
  const failures: StressReading['failures'] = [
    {
      failure: 'FEWER_BUYERS',
      effect: threshold
        ? 'the run is not bought and every buyer is refunded; nothing of ours is spent'
        : d.aggregation === 'POOLED_BUYERS'
          ? 'the fixed cost is spread over fewer buyers; below the minimum the run loses money'
          : 'fewer deals; each deal still stands on its own',
    },
    {
      failure: 'FAILED_PRESALE',
      effect: threshold || prepaid ? 'without prepayment there is no fulfilment to fund, so nothing is bought' : 'not applicable: nothing is presold',
    },
    {
      failure: 'DELAYED_PAYMENT',
      effect: threshold || prepaid ? 'cash is held before the work, so lateness cannot strand it' : 'cash may land after the deadline, and money already paid to supply waits with it',
    },
    {
      failure: 'REFUNDS',
      effect: threshold ? 'refunds are owed only before the run is bought, from money still held' : facts.payer === 'SUPPLIER' ? 'the buyer paid nothing to us; a supplier may claw back a fee' : 'refunds come out of money already spent on fulfilment',
    },
    {
      failure: 'SUPPLIER_SHORTFALL',
      effect: facts.fulfiller === 'BRAIN' ? 'not applicable: Brain fulfils it' : prepaid || threshold ? 'buyers who prepaid must be refunded or served by another supplier' : 'deals cannot be delivered; nothing is owed back',
    },
  ];
  if (!needsMoney || threshold) return { exposure: 'SAFE', worstCaseCents: 0, failures };
  // Prepaid in full covers the run only if buyers do prepay — an unknown share is worst case zero.
  if (input.atRiskCents === null) return { exposure: 'UNKNOWN', worstCaseCents: null, failures };
  const limit = input.limitCents;
  return {
    exposure: limit !== null && input.atRiskCents > limit ? 'EXCEEDS' : 'BOUNDED',
    worstCaseCents: input.atRiskCents,
    failures,
  };
}

/** One sentence describing a design's choices, in a researcher's words. */
export function describeDesign(d: Design): string {
  const facts = designFacts(d);
  const parts: string[] = [STRUCTURES[d.base].label];
  if (d.aggregation === 'POOLED_BUYERS' && d.base !== 'POOL') parts.push('with several buyers sharing one fulfilment run');
  if (d.funding === 'PREPAID') parts.push('paid in advance by each buyer');
  if (d.funding === 'THRESHOLD_PRESALE') parts.push('presold to buyers and bought only once enough have prepaid, refunded otherwise');
  if (d.repeat === 'RECURRING_COHORT') parts.push('repeated with a fresh group of buyers each run');
  if (d.repeat === 'SUBSCRIPTION') parts.push('renewed by the same buyers every period');
  if (facts.payer === 'SUPPLIER') parts.push('free to the buyer');
  return parts.join(', ');
}
