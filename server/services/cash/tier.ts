/**
 * Where a piece of the portfolio actually stands: a signal, a candidate, a
 * qualified opportunity, or something ready to test.
 *
 * ---------------------------------------------------------------------------
 * What was wrong
 * ---------------------------------------------------------------------------
 *
 * `harvest` promotes an accepted claim carrying an `opportunity_signal` into a
 * `cash_opportunities` row, and the page then called every one of those an
 * *opening*. In production that put thirty-one of them in front of a person as
 * current work, and what most of them actually held was market evidence:
 * Rev and GoTranscript's published transcription prices, WriterAccess and
 * Verblio's published rates, Adobe Stock and Depositphotos subscription
 * tiers, FIFA and Coachella resale *asking* prices, historical sneaker and
 * trading-card spreads, domain appraisals above an asking price, a generic
 * bug-bounty programme, auction-access brokers, generic Freelancer listings,
 * and specialised long-cycle government solicitations.
 *
 * Every one of those is a real, gated, well-sourced finding. **None of them
 * says anybody would pay us.** A vendor's published selling price is what that
 * vendor charges; an asking price is not a completed sale; an appraisal is not
 * a buyer; a historical spread is not accessible arbitrage; a marketplace page
 * is not a specific paid opening; a bounty programme is not a solvable bounty;
 * access to an auction is infrastructure rather than profit; a procurement
 * notice is not short cash until eligibility, scope, fulfilment and payment
 * timing are understood; and a job listing is not, by itself, a business.
 *
 * ---------------------------------------------------------------------------
 * The distinction is type-aware, and it is not a keyword filter
 * ---------------------------------------------------------------------------
 *
 * Every one of those examples is a *regression case* rather than the boundary.
 * A list of forbidden phrases would have caught the ten that were measured and
 * nothing else, and §27 records what happens to a closed list that has to be
 * complete over ordinary English: four widenings, each adding the one word the
 * last production message was declined for.
 *
 * So the rule is keyed on something Brain already stores as a closed
 * vocabulary: `opportunity_signal`, chosen by a worker that read the source.
 * Each of the seven says exactly what its evidence establishes and what it does
 * **not**, and what must additionally be answered before the thing it points
 * at could be acted on. A pricing asymmetry needs present acquisition access
 * and an after-fee exit before it is arbitrage; a resalable asset needs the
 * same; repeated outsourced work needs a model that serves the next customer
 * too. None of that reads a word of anybody's prose.
 *
 * ---------------------------------------------------------------------------
 * It is derived, so it reaches what is already written
 * ---------------------------------------------------------------------------
 *
 * Nothing here is stored, for `placements`' own reason: a row is not a
 * decision, and a stored tier is stale the moment the fact it was waiting on
 * arrives. Deriving it also means the thirty-one records that already exist are
 * reclassified by deploying this, with nothing deleted, nothing duplicated,
 * nothing rewritten and every claim, source, packet and event exactly where it
 * was.
 *
 * And it never invents an answer. A requirement with no answer is a requirement
 * with no answer — §30's rule that an unknown is never a favourable assumption,
 * applied to the question of whether something is an opportunity at all.
 */
import type { EngineCard, EngineCardEntry } from './engineCard.ts';
import type { CashOpportunity, OpportunitySignal } from '../../domain/types.ts';
import type { CardFieldKey } from './card.ts';
import type { EngineFieldKey } from './engineCard.ts';
import { fieldOwner, type CardReadiness, type FieldOwner } from './card.ts';

export const CASH_TIERS = ['SIGNAL', 'CANDIDATE', 'QUALIFIED', 'READY_TO_TEST'] as const;
export type CashTier = (typeof CASH_TIERS)[number];

export type QualificationKey = CardFieldKey | EngineFieldKey;

/**
 * The one question that separates evidence from a piece of work.
 *
 * Not "is there money here" — the signal already establishes that somebody,
 * somewhere, is paying for something. It is **how would we be paid**: what we
 * supply, to whom, in exchange for what. A signal with no answer to it is a
 * fact about a market, and a fact about a market is not a thing to do.
 */
export const CAPTURE_KEY: QualificationKey = 'captureMechanism';

/**
 * What every qualified opportunity has to answer, whatever kind it is.
 *
 * This is the plan's own list, in its own order: who pays, what they pay us
 * for, how we reach them, how it is acquired and fulfilled, what the fulfilment
 * model is, what human work remains, whether calling is required, what the
 * revenue is, what it costs, the maximum exposure, when the money arrives, what
 * would make it ineligible, what would kill it, how confident any of it is, and
 * whether Brain would do it.
 *
 * The margin is deliberately absent: `derivedEconomics` computes it from the
 * revenue and the costs and withholds it when either is missing, so requiring
 * both is requiring the margin without asking anybody to state one.
 */
export const UNIVERSAL_QUALIFICATION: readonly QualificationKey[] = Object.freeze([
  'payer',
  'offer',
  'access',
  'delivery',
  'fulfillment',
  'fulfilmentModel',
  'laborNeeds',
  'phoneDependency',
  'revenueRange',
  'directCosts',
  'requiredCapital',
  'timeToFirstCash',
  'eligibility',
  'disqualifiers',
  'confidence',
  'recommendation',
]);

/**
 * What one kind of evidence establishes, what it does not, and what closes the
 * gap.
 *
 * `alsoRequires` is where the rejection rules live, and each entry is the
 * general form of a measured example rather than the example itself.
 */
export interface SignalMeaning {
  /** What this evidence proves on its own. Always true of it. */
  establishes: string;
  /** What a reader might take it for, and it is not. */
  doesNotEstablish: string;
  /** Beyond the universal set, what this kind needs before it is qualified. */
  alsoRequires: readonly QualificationKey[];
}

export const SIGNAL_MEANING: Readonly<Record<OpportunitySignal, SignalMeaning>> = Object.freeze({
  ACTIVE_BUYER_DEMAND: {
    establishes: 'a named buyer published that they want something, on a date',
    doesNotEstablish:
      'that they would buy it from us, at a price we would accept, through a route we have',
    alsoRequires: [],
  },
  PAID_TASK_OR_CONTRACT: {
    establishes: 'a specific paid task, bounty, solicitation or listing exists with a payment',
    doesNotEstablish:
      'that we are eligible for it, that we could deliver it profitably, or that the ' +
      'machinery would still be there for the next one. A listing is a listing: on its own ' +
      'it is employment rather than a business',
    // A job that pays is not an opportunity unless something about it repeats.
    // §30's rule about manual gig work, expressed as a question rather than as
    // a score: what would make the second one cheaper or serve somebody else.
    alsoRequires: ['scalingLever'],
  },
  PRICING_OR_INFORMATION_ASYMMETRY: {
    establishes: 'the same deliverable is published at two different prices, on those dates',
    doesNotEstablish:
      'that we can buy at the lower one now, or sell at the higher one after fees. A vendor ' +
      'publishing a price is evidence of what that vendor charges, and nothing about what ' +
      'anybody would pay us',
    alsoRequires: ['acquisitionAccess', 'exitEvidence'],
  },
  EXPIRING_OPENING: {
    establishes: 'the source states a closing date, an expiry or a limited remaining quantity',
    doesNotEstablish:
      'that the thing expiring is worth taking, or that it could be taken in the time left',
    alsoRequires: [],
  },
  SUPPLY_DEMAND_MISMATCH: {
    establishes: 'a published demand and a published available supply are not connected',
    doesNotEstablish:
      'that connecting them is permitted, or that either side would pay the connector',
    alsoRequires: ['acquisitionAccess'],
  },
  RESALABLE_ASSET_OPENING: {
    establishes: 'an asset has a published asking price, and something published suggests demand',
    doesNotEstablish:
      'that anything has actually sold at the higher figure, that we can acquire it now, or ' +
      'what is left after fees. An asking price is not a sale and an appraisal is not a buyer',
    alsoRequires: ['acquisitionAccess', 'exitEvidence'],
  },
  RECURRING_OUTSOURCED_WORK: {
    establishes: 'one narrow brief is commissioned repeatedly as separate custom jobs',
    doesNotEstablish:
      'that we could fulfil it at a margin, or that the same machinery would serve the next ' +
      'customer rather than being one job done by hand each time',
    alsoRequires: ['scalingLever'],
  },
});

/**
 * The default reading for a piece with no signal on it.
 *
 * Every row written before `opportunity_signal` existed carries null, and so
 * does anything a person captured by hand. Unknown provenance is not a licence:
 * it takes the universal set and claims nothing specific about what its
 * evidence proves.
 */
const UNSIGNALLED: SignalMeaning = Object.freeze({
  establishes: 'something worth looking at was recorded here',
  doesNotEstablish: 'what kind of opening it is, because nothing recorded which',
  alsoRequires: [],
});

export interface TierRequirement {
  key: QualificationKey;
  label: string;
  /** What would answer it. */
  task: string;
  /** Whose question it is. A researchable blank is never a person's task. */
  owner: FieldOwner;
}

export interface TierReading {
  tier: CashTier;
  /** What the underlying evidence proves, and what it does not. */
  establishes: string;
  doesNotEstablish: string;
  /** Everything still unanswered before the next tier, in the order asked. */
  toAdvance: TierRequirement[];
  /** How much of this tier's requirement set is answered, for a progress count. */
  answered: number;
  required: number;
  /** One sentence a person reads, composed from the counts and the tier. */
  summary: string;
}

/** The whole requirement set for one piece, universal plus its own kind's. */
export function qualificationKeys(signal: OpportunitySignal | null): QualificationKey[] {
  const meaning = signal ? SIGNAL_MEANING[signal] : UNSIGNALLED;
  const out = [...UNIVERSAL_QUALIFICATION];
  for (const key of meaning.alsoRequires) if (!out.includes(key)) out.push(key);
  return out;
}

/**
 * Where this piece stands, from its own row and its own card.
 *
 * Pure and total: the same opportunity and the same card produce the same
 * reading, which is what makes "is this an opportunity" a decidable question
 * rather than a judgement that moves between readers — and what lets the page,
 * the review and the ranking all use one answer instead of three.
 *
 * A piece that is already executing, delivering or collected keeps whatever
 * tier its evidence earns; the state column says what is happening to it, and
 * the two are different questions. Nothing here moves a state.
 */
export function cashTier(input: {
  opportunity: CashOpportunity;
  card: EngineCard;
  /**
   * The short card's own reading: whether a bounded test could be run, and
   * which load-bearing fields are blank if not.
   *
   * Passed rather than recomputed so the tier and `markReady` refuse on
   * exactly the same set — a second `evidenceCard` call here would be a second
   * reader of one fact, and the two would disagree the first time the column
   * and the recorded answer differed.
   */
  readiness: CardReadiness;
}): TierReading {
  const signal = input.opportunity.opportunitySignal ?? null;
  const meaning = signal ? SIGNAL_MEANING[signal] : UNSIGNALLED;

  const byKey = new Map<string, EngineCardEntry>(input.card.entries.map((one) => [one.key, one]));
  const answered = (key: QualificationKey): boolean => {
    const entry = byKey.get(key);
    return Boolean(entry && entry.value !== null);
  };
  const requirement = (key: QualificationKey): TierRequirement => {
    const entry = byKey.get(key);
    return {
      key,
      label: entry?.label ?? key,
      task: entry?.task ?? `Establish the ${key}.`,
      owner: fieldOwner(key),
    };
  };

  const captured = answered(CAPTURE_KEY);
  const keys = qualificationKeys(signal);
  const open = keys.filter((key) => !answered(key));
  const answeredCount = keys.length - open.length;

  if (!captured) {
    return {
      tier: 'SIGNAL',
      establishes: meaning.establishes,
      doesNotEstablish: meaning.doesNotEstablish,
      toAdvance: [requirement(CAPTURE_KEY)],
      answered: answeredCount,
      required: keys.length,
      summary:
        `This is evidence, not work: it establishes ${meaning.establishes}, and not ` +
        `${meaning.doesNotEstablish}. Brain is still working out how we would be paid from it.`,
    };
  }

  if (open.length > 0) {
    return {
      tier: 'CANDIDATE',
      establishes: meaning.establishes,
      doesNotEstablish: meaning.doesNotEstablish,
      toAdvance: open.map(requirement),
      answered: answeredCount,
      required: keys.length,
      summary:
        `Brain can say how this would make money, and ${open.length} thing` +
        `${open.length === 1 ? '' : 's'} still ${open.length === 1 ? 'needs' : 'need'} ` +
        'establishing before it could be acted on.',
    };
  }

  if (!input.readiness.ready) {
    /*
     * Qualified, and the short card still has a load-bearing blank.
     *
     * The two sets overlap and are not the same set: `evidenceCard` asks what a
     * *bounded test* turns on — an acceptance condition, a quoted price, a
     * dated signal, a bounded exposure — and the qualification set asks what a
     * *decision* turns on. A piece can answer everything about the business and
     * still not have a price quoted for the one test in front of it.
     */
    return {
      tier: 'QUALIFIED',
      establishes: meaning.establishes,
      doesNotEstablish: meaning.doesNotEstablish,
      /*
       * The short card's load-bearing blanks, and not every unanswered field.
       *
       * At this tier everything the decision turns on is answered, so the
       * remaining nulls are a mixture of what a *test* still needs and what is
       * merely nice to know. Listing both would tell somebody a qualified
       * opening is further from a test than it is.
       */
      toAdvance: (input.readiness.missing as QualificationKey[]).map(requirement),
      answered: answeredCount,
      required: keys.length,
      summary:
        'The execution thesis is supported. What is left is the short card a bounded test ' +
        'runs against.',
    };
  }

  return {
    tier: 'READY_TO_TEST',
    establishes: meaning.establishes,
    doesNotEstablish: meaning.doesNotEstablish,
    toAdvance: [],
    answered: answeredCount,
    required: keys.length,
    summary:
      'Everything a bounded test turns on is answered. What remains is a decision only a ' +
      'person can make.',
  };
}

/** Strongest first, so a caller can sort or compare without restating the order. */
export function tierRank(tier: CashTier): number {
  return CASH_TIERS.indexOf(tier);
}
