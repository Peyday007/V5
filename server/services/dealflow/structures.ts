/**
 * The ways we could be paid, and what each one would require of us.
 *
 * ---------------------------------------------------------------------------
 * No structure is universally best, so nothing here ranks them
 * ---------------------------------------------------------------------------
 *
 * The brief is explicit about it and the code has to be too: there is no
 * score, no weight and no "recommended" flag in this module. A weighted
 * ranking would need weights nobody set, and the resulting order would read
 * like a measurement — §38's rule, at the question of how to get paid.
 *
 * What this does instead is answer, per structure, three things that are facts
 * rather than opinions: what it requires *of our balance sheet*, what has to
 * be true before it is available at all, and whether any source has been seen
 * saying this trade actually uses it. A person picks from that.
 *
 * ---------------------------------------------------------------------------
 * The capital class is the point
 * ---------------------------------------------------------------------------
 *
 * §13 of the brief: separate transaction value from our required capital, and
 * ask how to participate without funding the asset. `CAPITAL_CLASS` is that
 * question answered once per structure, in code, from the structure's own
 * mechanics rather than from a figure — because the figure depends on the deal
 * and the mechanics do not. A referral commission requires nothing of us
 * whether the trailer costs forty thousand dollars or four hundred thousand; a
 * trading-company markup requires the whole landed cost either way.
 *
 * ---------------------------------------------------------------------------
 * A rate is never parsed
 * ---------------------------------------------------------------------------
 *
 * `rateNote` stays the source's own words. A source saying "agents typically
 * take three to five per cent" is not a rate Brain may turn into a number and
 * multiply by a transaction value: doing that would convert somebody else's
 * range into our revenue and present it as arithmetic. §30's invented figure
 * wearing a citation, at the number a person would most want to believe.
 */
import { COMMERCIAL_STRUCTURES } from '../../domain/dealflow.ts';
import { equipmentKey } from '../../domain/dealflow.ts';
import type { CommercialStructure, DealStructureEvidence } from '../../domain/types.ts';

/**
 * What a structure requires of our own money.
 *
 * Four classes, and the boundary that matters is between the first two and the
 * last two: `NONE` and `WORKING_ONLY` are structures a small operation can
 * execute on a transaction of any size, and the other two are not.
 */
export const CAPITAL_CLASSES = [
  /** We fund nothing. The money moves between buyer and supplier. */
  'NONE',
  /** We fund our own time and small expenses — inspection travel, documents. */
  'WORKING_ONLY',
  /** We fund part of the goods, usually against a deposit or a bank instrument. */
  'PARTIAL_GOODS',
  /** We buy the goods and resell them. The whole landed cost is ours until paid. */
  'FULL_GOODS',
] as const;
export type CapitalClass = (typeof CAPITAL_CLASSES)[number];

export interface StructureProfile {
  structure: CommercialStructure;
  capitalClass: CapitalClass;
  /** What we would actually be doing. */
  what: string;
  /** What has to be true for this to be available at all. */
  requires: string;
  /** What normally has to happen before the money reaches us. */
  paidWhen: string;
}

/**
 * The thirteen, each answered once.
 *
 * A `Record` over the whole union, so a structure added later is a compile
 * error until somebody says what it costs us — which is the one question this
 * module exists to answer and the one nobody should be able to skip.
 */
export const STRUCTURE_PROFILE: Readonly<Record<CommercialStructure, StructureProfile>> =
  Object.freeze({
    REFERRAL_COMMISSION: {
      structure: 'REFERRAL_COMMISSION',
      capitalClass: 'NONE',
      what: 'Introduce the buyer to the supplier and take a fee on what follows.',
      requires: 'A supplier willing to pay for introductions, and a written basis for the fee.',
      paidWhen: 'Usually after the supplier is paid, which makes the supplier the credit risk.',
    },
    SALES_REPRESENTATION: {
      structure: 'SALES_REPRESENTATION',
      capitalClass: 'WORKING_ONLY',
      what: 'Represent the supplier in a territory and sell on their behalf.',
      requires: 'An appointment from the supplier, usually with a territory and a term.',
      paidWhen: 'On the supplier receiving payment, often staged with the buyer instalments.',
    },
    SOURCING_FEE: {
      structure: 'SOURCING_FEE',
      capitalClass: 'WORKING_ONLY',
      what: 'Find and qualify a supplier for a buyer who already knows what they want.',
      requires: 'A buyer who will engage us before we approach suppliers on their behalf.',
      paidWhen: 'Often part on engagement and part on order, which is why it reaches cash early.',
    },
    PROCUREMENT_FEE: {
      structure: 'PROCUREMENT_FEE',
      capitalClass: 'WORKING_ONLY',
      what: 'Run the purchase for the buyer: specification, suppliers, terms, follow-through.',
      requires: 'A buyer prepared to give a mandate, which usually means a named decision maker.',
      paidWhen: 'Staged against the milestones of the purchase itself.',
    },
    BROKER_COMMISSION: {
      structure: 'BROKER_COMMISSION',
      capitalClass: 'NONE',
      what: 'Bring both sides together and take a commission from one of them.',
      requires: 'Both sides willing to transact with our involvement acknowledged in writing.',
      paidWhen: 'On completion, and the commission is the first thing squeezed when it is not.',
    },
    BUYER_SIDE_REPRESENTATION: {
      structure: 'BUYER_SIDE_REPRESENTATION',
      capitalClass: 'WORKING_ONLY',
      what: 'Act for the buyer throughout: specification, inspection, acceptance.',
      requires: 'A mandate from the buyer, and no fee from the supplier — the two conflict.',
      paidWhen: 'On the buyer’s own schedule, which is usually slower and more reliable.',
    },
    SUPPLIER_SIDE_REPRESENTATION: {
      structure: 'SUPPLIER_SIDE_REPRESENTATION',
      capitalClass: 'WORKING_ONLY',
      what: 'Act for the supplier into a market they cannot reach themselves.',
      requires: 'A supplier with export capability and no existing coverage in that market.',
      paidWhen: 'On the supplier being paid, which for an export sale can be months.',
    },
    TRADING_COMPANY_MARKUP: {
      structure: 'TRADING_COMPANY_MARKUP',
      capitalClass: 'FULL_GOODS',
      what: 'Buy from the supplier and sell to the buyer, taking the spread.',
      requires: 'Capital or financing for the whole landed cost, and the risk that goes with it.',
      paidWhen:
        'When the buyer pays us, after we have already paid the supplier — so the working ' +
        'capital is out for the length of the shipment.',
    },
    LOGISTICS_COORDINATION_FEE: {
      structure: 'LOGISTICS_COORDINATION_FEE',
      capitalClass: 'WORKING_ONLY',
      what: 'Coordinate freight, customs and delivery as a paid service.',
      requires: 'A deal that is happening anyway, and a party who would rather not run it.',
      paidWhen: 'Against the shipment milestones, which makes it one of the faster fees.',
    },
    INSPECTION_COORDINATION: {
      structure: 'INSPECTION_COORDINATION',
      capitalClass: 'WORKING_ONLY',
      what: 'Arrange and manage pre-shipment inspection and quality sign-off.',
      requires: 'A buyer who does not trust an unseen factory, which is most first-time buyers.',
      paidWhen: 'On inspection, so it is cash before the goods ship.',
    },
    SPARE_PARTS_SUPPLY: {
      structure: 'SPARE_PARTS_SUPPLY',
      capitalClass: 'PARTIAL_GOODS',
      what: 'Supply the consumables and parts the equipment needs afterwards.',
      requires: 'Equipment already in service, so it follows a deal rather than starting one.',
      paidWhen: 'Per order, repeatedly, which is why it matters more than its size suggests.',
    },
    AFTER_SALES_COORDINATION: {
      structure: 'AFTER_SALES_COORDINATION',
      capitalClass: 'WORKING_ONLY',
      what: 'Run warranty, service and parts logistics between the two sides.',
      requires: 'A supplier without a service presence in the destination.',
      paidWhen: 'On a retainer or per incident, and it is the route to a standing relationship.',
    },
    RECURRING_PROCUREMENT: {
      structure: 'RECURRING_PROCUREMENT',
      capitalClass: 'WORKING_ONLY',
      what: 'Hold a standing mandate to buy a category on the buyer’s behalf.',
      requires: 'A delivered transaction first. Nobody hands this to a stranger.',
      paidWhen: 'Per purchase under the mandate, which is the point of it.',
    },
  });

export interface StructureOption {
  profile: StructureProfile;
  /** Sources seen saying this trade uses it. Empty is honest, not a refusal. */
  evidence: DealStructureEvidence[];
  /**
   * Whether any source has been seen on it for this class.
   *
   * The only thing separating the options, and it is a fact rather than a
   * judgement: it says *somebody published that this happens here*, and says
   * nothing about whether it is the right choice.
   */
  attested: boolean;
  /** The source's own words about what it pays. Never parsed into a rate. */
  rateNotes: string[];
}

/**
 * Every structure, with the evidence found for it against this class.
 *
 * All thirteen are returned, always — the attested ones are not a shortlist
 * and the unattested ones are not refused. A structure nobody has published
 * about in this trade may still be the right one, and hiding it would make the
 * absence of research look like a judgement about the structure.
 */
export function structureOptions(input: {
  equipmentClass: string;
  evidence: readonly DealStructureEvidence[];
}): StructureOption[] {
  const key = equipmentKey(input.equipmentClass);
  const mine = input.evidence.filter((one) => one.equipmentKey === key);
  return COMMERCIAL_STRUCTURES.map((structure) => {
    const evidence = mine.filter((one) => one.structure === structure);
    return {
      profile: STRUCTURE_PROFILE[structure],
      evidence,
      attested: evidence.length > 0,
      rateNotes: evidence
        .map((one) => one.rateNote)
        .filter((one): one is string => typeof one === 'string' && one.trim() !== ''),
    };
  });
}

/**
 * Whether a commercial path exists at all, and what it would require of us.
 *
 * "A path exists" means: at least one structure has been *attested* for this
 * class by a source. That bar is deliberately about evidence rather than
 * plausibility — every structure is plausible, which is exactly why
 * plausibility cannot be the test.
 */
export interface CommercialPath {
  /** At least one structure attested for this class. */
  established: boolean;
  /** The attested ones, in the table's own order. Never ranked. */
  attested: StructureOption[];
  /**
   * The lightest capital class among the attested structures.
   *
   * Reported because it answers the brief's own question — can we participate
   * without funding the asset — and it is a lookup over a constant rather than
   * a preference. Null when nothing is attested.
   */
  lightestCapitalClass: CapitalClass | null;
  because: string;
}

const CLASS_ORDER: readonly CapitalClass[] = Object.freeze([
  'NONE',
  'WORKING_ONLY',
  'PARTIAL_GOODS',
  'FULL_GOODS',
]);

export function commercialPath(options: readonly StructureOption[]): CommercialPath {
  const attested = options.filter((one) => one.attested);
  if (attested.length === 0) {
    return {
      established: false,
      attested: [],
      lightestCapitalClass: null,
      because:
        'No source has been seen saying how this trade actually pays an intermediary. Every ' +
        'one of the thirteen structures is possible here, which is exactly why possibility ' +
        'is not the test — until something is attested, the commercial path is a guess.',
    };
  }

  const lightest =
    CLASS_ORDER.find((cls) => attested.some((one) => one.profile.capitalClass === cls)) ?? null;

  return {
    established: true,
    attested,
    lightestCapitalClass: lightest,
    because:
      `${attested.length} structure${attested.length === 1 ? '' : 's'} attested for this class ` +
      `by a source. The lightest of them requires ${describeCapital(lightest)} — which is the ` +
      'question that decides whether the size of the transaction is a problem for us.',
  };
}

export function describeCapital(cls: CapitalClass | null): string {
  if (cls === null) return 'an unknown amount of our own capital';
  if (cls === 'NONE') return 'none of our own capital';
  if (cls === 'WORKING_ONLY') return 'only our own time and small expenses';
  if (cls === 'PARTIAL_GOODS') return 'funding part of the goods';
  return 'funding the whole landed cost until the buyer pays';
}
