/**
 * What one proposition currently is, derived entirely from rows.
 *
 * ---------------------------------------------------------------------------
 * The stage is derived, and there is no stage column
 * ---------------------------------------------------------------------------
 *
 * Evidence about a proposition arrives asynchronously from several missions, a
 * settled test, and occasionally a person. A stored stage would be stale the
 * moment any of those landed, and the two readers of it would disagree — which
 * is the defect this repository has recorded at a column, a status line, a
 * review card and a projection. §38's rule 3, unchanged.
 *
 * ---------------------------------------------------------------------------
 * Attention is counted against, never for
 * ---------------------------------------------------------------------------
 *
 * The brief's sharpest instruction on this subject is to distinguish attention
 * from buying behaviour, and the only way to do that structurally is to make
 * them different kinds and then never let one satisfy the other's test. A
 * proposition with nine attention readings and no purchase reading does not
 * advance, and `wouldChange` says so in words — *somebody is shown to have
 * bought this* — rather than reporting a large number that reads like success.
 *
 * ---------------------------------------------------------------------------
 * Lexicographic, never a score
 * ---------------------------------------------------------------------------
 *
 * The rank is an ordered comparison over observable facts, in the brief's own
 * priority. There is no weighted score, because a score needs weights, weights
 * are a judgement nobody made, and the resulting number reads like a
 * measurement — `portfolio.ts` settled this for openings and nothing about
 * products changes the argument.
 */
import { readEconomics, type Economics } from './economics.ts';
import type {
  CommerceBasis,
  CommerceChannel,
  CommerceEvidence,
  CommerceFinding,
  CommerceProposition,
  CommerceRound,
  CommerceStage,
  CommerceTest,
} from '../../domain/types.ts';

export interface Reading {
  proposition: CommerceProposition;
  channel: CommerceChannel | null;
  stage: CommerceStage;
  economics: Economics;
  /** Readings that show somebody bought, which is the only kind that counts. */
  purchases: readonly CommerceEvidence[];
  /** Readings that show attention and not buying. Counted against, not for. */
  attention: readonly CommerceEvidence[];
  /** The channel forbids this outright, where a source says so. */
  prohibited: readonly CommerceEvidence[];
  /** What the channel requires before anything may be sold. */
  eligibility: readonly CommerceEvidence[];
  supply: readonly CommerceEvidence[];
  competition: readonly CommerceEvidence[];
  test: CommerceTest | null;
  /** Rounds asked about this proposition, live and settled. */
  rounds: readonly CommerceRound[];
  /** Live rounds, so a reader can tell "nothing known" from "being asked". */
  asking: readonly CommerceRound[];
  /**
   * What the next thing to establish is, and who it belongs to.
   *
   * §33's `owner` correction: a fact about the world is Brain's to research
   * and never a form for a person to fill in, and a screen that asks somebody
   * to attest to Brain's own work is the defect that correction removed.
   */
  next: NextStep;
  /**
   * What would move this piece up or down the ranking, in words.
   *
   * The brief asks for it explicitly, and it is the half of a ranking that is
   * actually useful: an order with no stated sensitivity is a number somebody
   * either believes or ignores.
   */
  wouldChange: readonly string[];
  /** The comparison key. Lower sorts first. Never shown as a score. */
  rank: readonly number[];
}

export interface NextStep {
  what: string;
  owner: 'BRAIN_RESEARCH' | 'BRAIN_PROPOSES' | 'PERSON_ONLY';
  /** Null while nothing blocks it. A sentence naming the blocker otherwise. */
  blockedBy: string | null;
}

export interface ReadingInput {
  proposition: CommerceProposition;
  channel: CommerceChannel | null;
  evidence: readonly CommerceEvidence[];
  channelEvidence: readonly CommerceEvidence[];
  test: CommerceTest | null;
  rounds: readonly CommerceRound[];
}

const OF_KIND = (rows: readonly CommerceEvidence[], ...kinds: CommerceFinding[]) =>
  rows.filter((one) => kinds.includes(one.kind));

export function read(input: ReadingInput): Reading {
  const { proposition } = input;

  /*
   * A channel's readings apply to everything sold on it.
   *
   * The platform's commission, its payout delay and its eligibility rules are
   * facts about the channel rather than about any one product, so they are
   * established once per channel and read by every proposition on it. A
   * proposition's own reading wins where both exist, which `resolveInputs`
   * decides by basis and date — a measured fee beats a published one.
   */
  const evidence = [...input.channelEvidence, ...input.evidence];
  const economics = readEconomics(evidence);

  const purchases = OF_KIND(evidence, 'PURCHASE_EVIDENCE');
  const attention = OF_KIND(evidence, 'ATTENTION_EVIDENCE');
  const prohibited = OF_KIND(evidence, 'PROHIBITED_PRODUCT');
  const eligibility = OF_KIND(evidence, 'PLATFORM_ELIGIBILITY', 'FULFILMENT_REQUIREMENT');
  const supply = OF_KIND(evidence, 'SUPPLIER_AVAILABLE', 'SUPPLIER_RELIABILITY', 'DELIVERY_TIME', 'RETURN_TERMS');
  const competition = OF_KIND(evidence, 'COMPETING_OFFER', 'SATURATION', 'CREATOR_ACTIVITY');
  const asking = input.rounds.filter((one) => one.state === 'OPEN');

  const supplierKnown = proposition.supplier !== null || supply.some((one) => one.kind === 'SUPPLIER_AVAILABLE');
  const marginKnown = economics.contributionPerUnit.known;
  const offerReady = marginKnown && supplierKnown && purchases.length > 0;

  const stage = deriveStage({
    proposition,
    purchases,
    supplierKnown,
    marginKnown,
    offerReady,
    test: input.test,
  });

  const next = deriveNext({
    stage,
    proposition,
    purchases,
    attention,
    prohibited,
    supplierKnown,
    economics,
    test: input.test,
    asking,
  });

  return {
    proposition,
    channel: input.channel,
    stage,
    economics,
    purchases,
    attention,
    prohibited,
    eligibility,
    supply,
    competition,
    test: input.test,
    rounds: input.rounds,
    asking,
    next,
    wouldChange: deriveWouldChange({ economics, purchases, attention, prohibited, supplierKnown, competition }),
    rank: rankKey({ proposition, economics, purchases, attention, prohibited, supplierKnown, competition, stage }),
  };
}

function deriveStage(input: {
  proposition: CommerceProposition;
  purchases: readonly CommerceEvidence[];
  supplierKnown: boolean;
  marginKnown: boolean;
  offerReady: boolean;
  test: CommerceTest | null;
}): CommerceStage {
  if (input.proposition.retiredAt) return 'RETIRED';
  const test = input.test;
  if (test?.state === 'SETTLED') return 'SETTLED';
  if (test?.state === 'RUNNING') return 'FULFILLING';
  if (test?.state === 'AUTHORIZED') return 'TEST_RUNNING';
  /*
   * A blocked test does not advance the stage, and that is deliberate.
   *
   * The proposition has not got further than it was; what has happened is that
   * Brain established precisely what is missing. Reporting BLOCKED as a stage
   * beyond OFFER_READY would make an obstacle look like progress, which is the
   * kind of encouraging reading §29 removed from the briefing.
   */
  if (input.offerReady) return 'OFFER_READY';
  if (input.marginKnown) return 'ECONOMICS_ESTABLISHED';
  if (input.supplierKnown) return 'SUPPLIER_VALIDATED';
  if (input.purchases.length > 0) return 'PRODUCT_CANDIDATE';
  return 'DEMAND_SIGNAL';
}

function deriveNext(input: {
  stage: CommerceStage;
  proposition: CommerceProposition;
  purchases: readonly CommerceEvidence[];
  attention: readonly CommerceEvidence[];
  prohibited: readonly CommerceEvidence[];
  supplierKnown: boolean;
  economics: Economics;
  test: CommerceTest | null;
  asking: readonly CommerceRound[];
}): NextStep {
  if (input.proposition.retiredAt) {
    return {
      what: 'Nothing. A person retired this, and the reason is on the row.',
      owner: 'PERSON_ONLY',
      blockedBy: null,
    };
  }

  /*
   * A prohibition outranks everything, including a good margin.
   *
   * A channel that publishes that this category may not be sold has settled
   * the question, and continuing to research the economics of something that
   * may not be sold there is exactly the waste §13 exists to stop.
   */
  if (input.prohibited.length > 0) {
    return {
      what:
        'Retire this, or establish that the prohibition does not cover it. The channel ' +
        'publishes that this may not be sold, which settles the question until somebody ' +
        'reads the rule and decides it reads otherwise.',
      owner: 'PERSON_ONLY',
      blockedBy: null,
    };
  }

  if (input.test?.state === 'BLOCKED') {
    return {
      what:
        'Everything Brain can prepare for the bounded test is prepared. What is missing is ' +
        `outside it: ${input.test.blockerDetail ?? input.test.blockerKind}.`,
      owner: 'PERSON_ONLY',
      blockedBy: input.test.blockerKind,
    };
  }

  if (input.purchases.length === 0) {
    const live = input.asking.some((one) => one.purpose === 'PRODUCTS');
    return {
      what:
        input.attention.length > 0
          ? 'Establish that somebody actually bought this. Brain holds attention readings and ' +
            'no purchase reading, and attention is not demand — that is what this whole ' +
            'distinction is for.'
          : 'Establish that somebody actually bought this, from a published source with a date.',
      owner: 'BRAIN_RESEARCH',
      blockedBy: live ? null : null,
    };
  }

  if (!input.supplierKnown) {
    return {
      what:
        'Establish who would actually supply this, what they publish about stock, lead time, ' +
        'tracking and returns, and whether they will ship to the buyer directly.',
      owner: 'BRAIN_RESEARCH',
      blockedBy: null,
    };
  }

  if (!input.economics.contributionPerUnit.known) {
    const missing = input.economics.unknown;
    return {
      what:
        `Establish ${missing.slice(0, 4).join(', ')}` +
        (missing.length > 4 ? ` and ${missing.length - 4} more` : '') +
        '. Until every one of them is established the contribution is withheld rather than ' +
        'estimated, because a margin computed past an unknown is wrong in the encouraging ' +
        'direction.',
      owner: 'BRAIN_RESEARCH',
      blockedBy: null,
    };
  }

  if (!input.test) {
    return {
      what:
        'Run one bounded sales test against a ceiling you set, and measure what the estimates ' +
        'above only predict. Brain prepares it and stops: spending is a commercial action a ' +
        'person grants.',
      owner: 'PERSON_ONLY',
      blockedBy: null,
    };
  }

  return {
    what: 'The bounded test is what happens next, and its own row says where it has got to.',
    owner: 'BRAIN_PROPOSES',
    blockedBy: null,
  };
}

function deriveWouldChange(input: {
  economics: Economics;
  purchases: readonly CommerceEvidence[];
  attention: readonly CommerceEvidence[];
  prohibited: readonly CommerceEvidence[];
  supplierKnown: boolean;
  competition: readonly CommerceEvidence[];
}): string[] {
  const out: string[] = [];
  if (input.prohibited.length > 0) {
    out.push('A source establishing that the prohibition does not cover this would revive it.');
  }
  if (input.purchases.length === 0) {
    out.push(
      input.attention.length > 0
        ? `One published purchase would move this above every piece that still has only ` +
          `attention behind it. It currently has ${input.attention.length} attention reading` +
          `${input.attention.length === 1 ? '' : 's'} and none.`
        : 'One published purchase, dated, would move this up.',
    );
  }
  const margin = input.economics.contributionPerUnit;
  if (!margin.known) {
    out.push(
      `Establishing ${margin.missing.slice(0, 3).join(', ')} would let the contribution be ` +
        'derived at all, which is what separates a candidate from a piece worth testing.',
    );
  } else {
    out.push(
      margin.minor > 0
        ? `A higher landed cost, a higher return rate or a lower price would take the ` +
          `contribution below zero; it currently clears by ${margin.minor} minor units on a ` +
          `${margin.basis.toLowerCase()} basis.`
        : 'The contribution is at or below zero, so a lower landed cost, a lower return rate ' +
          'or a higher achievable price is what would revive it.',
    );
  }
  if (!input.supplierKnown) {
    out.push('A named supplier that publishes stock and lead time would move this up.');
  }
  const saturation = input.competition.find((one) => one.kind === 'SATURATION');
  if (saturation?.countUnits !== null && saturation?.countUnits !== undefined) {
    out.push(
      `Saturation is established at ${saturation.countUnits} sellers; a source establishing ` +
        'more would move this down.',
    );
  }
  if (margin.known && margin.basis !== 'MEASURED') {
    out.push(
      `Every figure here is an ${margin.basis.toLowerCase()}. One settled bounded test would ` +
        'replace the load-bearing ones with measurements, and it is the only thing that can.',
    );
  }
  return out;
}

/**
 * The comparison, in the brief's own priority order.
 *
 * Each element is a small integer and lower sorts first. Written as an array
 * rather than a composite number so that a reader can see which rule decided
 * a position — and so that adding a rule is an append rather than a rescaling
 * of everything above it.
 */
function rankKey(input: {
  proposition: CommerceProposition;
  economics: Economics;
  purchases: readonly CommerceEvidence[];
  attention: readonly CommerceEvidence[];
  prohibited: readonly CommerceEvidence[];
  supplierKnown: boolean;
  competition: readonly CommerceEvidence[];
  stage: CommerceStage;
}): number[] {
  const margin = input.economics.contributionPerUnit;
  return [
    // 1. Anything the channel forbids, or a person retired, goes last.
    input.prohibited.length > 0 || input.proposition.retiredAt ? 1 : 0,
    // 2. Somebody is shown to have bought. Attention alone never satisfies it.
    input.purchases.length > 0 ? 0 : 1,
    // 3. The contribution is derivable and positive.
    margin.known && margin.minor > 0 ? 0 : margin.known ? 2 : 1,
    // 4. Somebody would actually supply it.
    input.supplierKnown ? 0 : 1,
    /*
     * 5. How much is still unknown.
     *
     * Ascending, so a blank can never be the reason something rises. §30
     * records the opposite: `conservativeContribution` treated an unknown
     * exposure as zero, so an uncosted piece outranked an identically priced
     * costed one — the card refused the blank and the ranking rewarded it.
     */
    input.economics.unknown.length,
    /*
     * 6. Measured beats estimated beats assumed, at equal everything else.
     */
    margin.known ? basisRank(margin.basis) : 3,
    // 7. Oldest first, so every proposition gets a turn rather than the same
    //    ones sitting at the back of the queue on an accident of ordering.
    Date.parse(input.proposition.createdAt) || 0,
  ];
}

function basisRank(basis: CommerceBasis): number {
  if (basis === 'MEASURED') return 0;
  if (basis === 'ESTIMATE') return 1;
  return 2;
}

/** Ascending over the key, element by element. */
export function byRank(a: Reading, b: Reading): number {
  for (let index = 0; index < Math.max(a.rank.length, b.rank.length); index += 1) {
    const left = a.rank[index] ?? 0;
    const right = b.rank[index] ?? 0;
    if (left !== right) return left - right;
  }
  return a.proposition.id < b.proposition.id ? -1 : 1;
}
