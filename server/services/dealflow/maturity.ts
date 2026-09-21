/**
 * How far a deal has actually got, derived from rows on the read path.
 *
 * ---------------------------------------------------------------------------
 * Derived, never stored
 * ---------------------------------------------------------------------------
 *
 * `tier.ts` settled this and the argument does not change: a row is not a
 * decision, a stored stage is stale the moment the evidence it was waiting on
 * arrives, and two readers deriving it separately is how one screen comes to
 * disagree with another. Deriving it also means every deal already in the
 * table is reclassified by deploying a change here, with nothing rewritten.
 *
 * ---------------------------------------------------------------------------
 * The ladder climbs on evidence and stops on an unknown
 * ---------------------------------------------------------------------------
 *
 * Each rung asks one question and the deal stops at the first unanswered one.
 * There is no partial credit and no score, because a deal with a supplier, a
 * price and no idea whether the goods may enter the country is not "most of
 * the way there" — it is one fact away from being worth nothing, and a
 * percentage would say the opposite.
 *
 * ---------------------------------------------------------------------------
 * What Brain can observe, and what it declines to guess
 * ---------------------------------------------------------------------------
 *
 * Everything through `OUTREACH_READY` is derived here. Everything after it is
 * read from the Cash opportunity this deal was promoted into, because those
 * stages record things that happened in the world.
 *
 * `QUOTING` is reported **only** from a recorded `QUOTE_AND_INVOICE` action,
 * and `NEGOTIATING` is never reported at all: there is no commercial action
 * for negotiating, so Brain holds no row that establishes it, and inferring it
 * from a quote having gone out would be a status more precise than the
 * evidence. With no action recorded, a deal being executed reads `ENGAGED` and
 * stays there — Brain saying *somebody is working on this and I do not know
 * how far* rather than inventing a plausible middle. §29's rule: a status that
 * reads more precise than the evidence teaches a person to stop believing it.
 */
import { envelopeFor, type ComplianceEnvelope } from './compliance.ts';
import { landedEconomics, type LandedEconomics } from './economics.ts';
import { commercialPath, structureOptions, type CommercialPath } from './structures.ts';
import type {
  CashOpportunity,
  Deal,
  DealCost,
  DealParty,
  DealRequirement,
  DealStage,
  DealStructureEvidence,
} from '../../domain/types.ts';

export interface DealReading {
  deal: Deal;
  buyer: DealParty;
  supplier: DealParty;
  stage: DealStage;
  /** Why it is at that stage, and never a score. */
  because: string;
  /** The single cheapest thing that would move it, or null when nothing would. */
  nextAction: string | null;
  /** What is actually stopping it, named from the reading rather than guessed. */
  blocker: string | null;
  envelope: ComplianceEnvelope;
  economics: LandedEconomics;
  path: CommercialPath;
  /**
   * The destination the reading was taken against.
   *
   * A deal's destination is the buyer's own country, which is why a buyer with
   * no country reads as an unanswered question rather than as a deal against
   * an unnamed market. §25's rule: not knowing a jurisdiction is an answer.
   */
  destination: string | null;
}

/**
 * What a recorded commercial action says a deal has reached.
 *
 * Keyed on `COMMERCIAL_ACTIONS` — the vocabulary `services/cash/authority.ts`
 * actually holds — and on nothing else. The first version of this keyed on
 * `SEND_QUOTE`, `NEGOTIATE_TERMS` and `SIGN_AGREEMENT`, which are plausible
 * names for things this trade does and are not actions any grant can
 * authorize, so not one of them could ever have been recorded: a branch
 * nothing can reach, which this repository has had to correct too many times
 * to add another on purpose.
 *
 * `NEGOTIATING` is deliberately absent. It is a real stage of this trade and
 * the brief names it, and **Brain holds no row that establishes it** — there
 * is no commercial action for negotiating, and inferring it from a quote
 * having gone out would be a status more precise than the evidence. So it
 * stays in the vocabulary, is never derived, and `DEAL_STAGES` says so.
 *
 * In ascending order, because the reader takes the last match: a deal that has
 * been contacted and quoted is quoting.
 */
const ACTION_STAGE: readonly { action: string; stage: DealStage }[] = Object.freeze([
  { action: 'CONTACT_BUYER', stage: 'ENGAGED' },
  { action: 'QUOTE_AND_INVOICE', stage: 'QUOTING' },
]);

export function readDeal(input: {
  deal: Deal;
  buyer: DealParty;
  supplier: DealParty;
  requirements: readonly DealRequirement[];
  costs: readonly DealCost[];
  structures: readonly DealStructureEvidence[];
  opportunity: CashOpportunity | null;
  /** Commercial action names recorded against this deal's opportunity. */
  actions: readonly string[];
}): DealReading {
  const destination = input.buyer.country;

  /*
   * With no destination there is nothing to read an envelope or a landed cost
   * against, so both are taken against the empty string and both correctly
   * report that nothing is established. That is deliberate rather than a
   * degenerate case: it makes "we do not know where this buyer is" show up as
   * the unanswered question it is, in the same place every other unanswered
   * question shows up.
   */
  const envelope = envelopeFor({
    equipmentClass: input.deal.equipmentClass,
    destination: destination ?? '',
    requirements: input.requirements,
  });
  const economics = landedEconomics({
    equipmentClass: input.deal.equipmentClass,
    destination: destination ?? '',
    costs: input.costs,
  });
  const path = commercialPath(
    structureOptions({
      equipmentClass: input.deal.equipmentClass,
      evidence: input.structures,
    }),
  );

  const pursued = pursuitStage(input.opportunity, input.actions);
  if (pursued) {
    return {
      deal: input.deal,
      buyer: input.buyer,
      supplier: input.supplier,
      stage: pursued.stage,
      because: pursued.because,
      nextAction: pursued.nextAction,
      blocker: input.deal.blockedReason,
      envelope,
      economics,
      path,
      destination,
    };
  }

  const derived = derivedStage({ deal: input.deal, buyer: input.buyer, envelope, economics, path });
  return {
    deal: input.deal,
    buyer: input.buyer,
    supplier: input.supplier,
    stage: input.deal.blockedReason ? 'BLOCKED' : derived.stage,
    because: input.deal.blockedReason
      ? `${input.deal.blockedReason} Before that: ${derived.because}`
      : derived.because,
    nextAction: derived.nextAction,
    blocker: input.deal.blockedReason,
    envelope,
    economics,
    path,
    destination,
  };
}

function pursuitStage(
  opportunity: CashOpportunity | null,
  actions: readonly string[],
): { stage: DealStage; because: string; nextAction: string | null } | null {
  if (!opportunity) return null;

  if (opportunity.state === 'COLLECTED') {
    return {
      stage: 'PAID',
      because: 'The money arrived and was settled against the ledger.',
      nextAction:
        'Record what this taught — why they bought, what the cycle actually was, what the ' +
        'certification and logistics cost — and ask what else this buyer procures.',
    };
  }
  if (opportunity.state === 'DECLINED') {
    return {
      stage: 'LOST',
      because: 'The opportunity was declined.',
      nextAction: 'Record why, so the next deal in this market does not repeat it.',
    };
  }
  if (opportunity.state === 'DELIVERING') {
    return {
      stage: 'CONTRACTING',
      because: 'The opportunity is in delivery, so the commercial terms are settled.',
      nextAction: 'Follow the delivery and the payment milestones.',
    };
  }
  if (opportunity.state === 'EXECUTING') {
    /*
     * The one place a finer stage is reported, and only from a recorded
     * action. The alternative — guessing that an executing deal is probably
     * quoting — is a status more precise than the evidence, which is the
     * defect §29 records at three other surfaces.
     */
    for (let i = ACTION_STAGE.length - 1; i >= 0; i -= 1) {
      const entry = ACTION_STAGE[i]!;
      if (actions.includes(entry.action)) {
        return {
          stage: entry.stage,
          because: `A ${entry.action} action is recorded against this deal.`,
          nextAction: null,
        };
      }
    }
    return {
      stage: 'ENGAGED',
      because:
        'The opportunity is being executed. Nothing recorded says whether a quote has gone ' +
        'out or terms are being negotiated, so Brain does not claim either.',
      nextAction:
        'Record the commercial action when it happens, so the stage stops being coarser than ' +
        'what is actually going on.',
    };
  }

  // READY, EVIDENCE_CARD, DISCOVERED, ARCHIVED — promoted but not yet acted on.
  return null;
}

function derivedStage(input: {
  deal: Deal;
  buyer: DealParty;
  envelope: ComplianceEnvelope;
  economics: LandedEconomics;
  path: CommercialPath;
}): { stage: DealStage; because: string; nextAction: string | null } {
  const { envelope, economics, path } = input;

  if (envelope.verdict === 'BLOCKED') {
    return {
      stage: 'BLOCKED',
      because: envelope.because,
      nextAction:
        'Change the equipment class, the configuration or the destination, or drop this ' +
        'pairing. Nothing researchable turns a prohibition into a yes.',
    };
  }

  if (!input.buyer.country) {
    return {
      stage: 'HYPOTHESIS',
      because:
        'A buyer and a supplier exist for this class, but nothing says which market the buyer ' +
        'is in — so there is no destination to test the goods against. Not knowing a ' +
        'jurisdiction is an answer, and it is this one.',
      nextAction: `Establish which country ${input.buyer.name} operates in.`,
    };
  }

  const hasPrice = economics.components.some(
    (one) => one.component === 'FACTORY_PRICE' && one.amountCents !== null,
  );
  if (!hasPrice) {
    return {
      stage: 'HYPOTHESIS',
      because:
        'A buyer and a supplier exist for this class, and no source has been seen publishing ' +
        'what the equipment costs. Everything downstream is arithmetic over a number nobody ' +
        'has.',
      nextAction: `Establish a published or quoted price for ${input.deal.equipmentClass}.`,
    };
  }

  if (envelope.unestablished.length === envelope.layers.length) {
    return {
      stage: 'DISCOVERED',
      because:
        'Both sides and a price are established, and none of the five compliance layers has ' +
        'been researched for this market. That is the cheapest thing that can still make the ' +
        'whole pairing worthless.',
      nextAction: `Research the compliance envelope for ${input.deal.equipmentClass} into ${input.buyer.country}.`,
    };
  }

  if (envelope.verdict === 'INCOMPLETE') {
    return {
      stage: 'RESEARCHED',
      because: envelope.because,
      nextAction: `Research ${envelope.unestablished.join(', ')} for ${input.buyer.country}.`,
    };
  }

  // The envelope is established. Now the economics.
  if (economics.landedCents === null) {
    return {
      stage: 'QUALIFIED',
      because:
        `The goods can lawfully get there and be used: ${envelope.because} ` +
        `What it costs to land one is not yet answerable. ${economics.because}`,
      nextAction:
        economics.missing.length > 0
          ? `Establish ${economics.missing.join(', ')} for this lane.`
          : 'Reconcile the cost figures onto one currency and one basis, from sources.',
    };
  }

  if (!path.established) {
    return {
      stage: 'QUALIFIED',
      because: `${envelope.because} The landed cost is known. ${path.because}`,
      nextAction: `Research how intermediaries in ${input.deal.equipmentClass} are actually paid.`,
    };
  }

  if (!input.buyer.decisionMaker) {
    return {
      stage: 'COMMERCIAL_PATH',
      because:
        `${path.because} What is missing is somebody to approach: nothing says who decides a ` +
        `purchase at ${input.buyer.name}.`,
      nextAction: `Establish who runs procurement at ${input.buyer.name}, and how they buy.`,
    };
  }

  if (economics.savingCents === null) {
    return {
      stage: 'COMMERCIAL_PATH',
      because:
        'Both sides, the compliance envelope, the landed cost, a commercial path and a ' +
        'decision maker are all established. What the buyer pays today is not, so whether ' +
        'this is worth their while is unknown — and that, rather than our margin, is what ' +
        'decides whether they answer.',
      nextAction: `Establish what ${input.buyer.name} pays for this today, and from whom.`,
    };
  }

  if (economics.savingCents <= 0) {
    return {
      stage: 'BLOCKED',
      because:
        'Everything is established and the buyer pays no more than this today. There is no ' +
        'saving to offer, which is a reason to decline rather than a reason to keep looking ' +
        'for a cheaper version of the same thing.',
      nextAction:
        'Drop this pairing, or find a supplier whose price actually beats what they pay now.',
    };
  }

  return {
    stage: 'OUTREACH_READY',
    because:
      'A real buyer, a real supplier, a lawful path into the market, a landed cost, a saving ' +
      'against what they pay today, a commercial structure this trade actually uses, and a ' +
      'named decision maker. There is nothing left to research before approaching somebody.',
    nextAction:
      'Promote it into the portfolio and approach the decision maker under a structure a ' +
      'person has authorized.',
  };
}

/** The rungs, in order, so a reader can say how far along a stage is. */
export const DERIVED_LADDER: readonly DealStage[] = Object.freeze([
  'SIGNAL',
  'HYPOTHESIS',
  'DISCOVERED',
  'RESEARCHED',
  'QUALIFIED',
  'COMMERCIAL_PATH',
  'OUTREACH_READY',
]);

export function isPursued(stage: DealStage): boolean {
  return !DERIVED_LADDER.includes(stage) && stage !== 'BLOCKED';
}
