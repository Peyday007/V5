/**
 * The short evidence card, and the one question it answers.
 *
 * §3's rule is the whole of this module: **mark unsupported facts as unknown.**
 * A missing phone number is an access task and a missing supplier price is a
 * quoting task, and neither may silently become a favourable assumption. So
 * every field reports one of two things — the answer, or the task that would
 * produce it — and `readiness` refuses an opportunity with an unknown in a
 * load-bearing position rather than taking the blank as a yes.
 *
 * Nothing here reads prose, scores confidence, or estimates a close rate. §3 is
 * explicit that a 40% close probability may not be invented; what this returns
 * is which fields are answered, which are not, and what to do about each.
 */
import type { CashOpportunity } from '../../domain/types.ts';

export type CardFieldKey =
  | 'payer'
  | 'access'
  | 'buyingEvidence'
  | 'offer'
  | 'acceptance'
  | 'price'
  | 'delivery'
  | 'fulfillment'
  | 'cashDates'
  | 'economics'
  | 'exposure'
  | 'nextAction';

export interface CardField {
  key: CardFieldKey;
  label: string;
  /** The answer, or null when it is genuinely not known. */
  value: string | null;
  /**
   * What would answer it. Present on every field whether or not it is known,
   * because the remedy is a property of the question rather than of today's
   * blank.
   */
  task: string;
  /**
   * Whether `readiness` refuses without it.
   *
   * A candidate is ready to test when the payer, the offer, the delivery path
   * and the bounded exposure are credible. Everything else is worth knowing and
   * is not what the decision turns on.
   */
  loadBearing: boolean;
  /**
   * Whose question this is.
   *
   * It used to be a boolean called `discoverable`, splitting the twelve into
   * *facts Brain looks up* and *the owner's calls* — and the second half was
   * nine of them: the offer, the acceptance condition, the price, the delivery
   * path, who does the work, the cash dates, the economics, the exposure and
   * the next action. §30 had already corrected the reasoning behind that
   * ("a commercial judgment is not permanently a person's either") and
   * `answers.ts` had already built the machinery to propose them, but the
   * boolean stayed — so `compressedReview` went on turning every one of those
   * blanks into a task, and production showed five *decisions* standing for
   * ninety-eight underlying items while Brain's own screen said it was off
   * researching those same facts.
   *
   * What a price, a cost, a fee, a settlement date, an eligibility rule or a
   * delivery requirement *is* is a fact about the world. Brain researches it.
   * What to offer and what counts as accepted are Brain's to propose and a
   * person's to overrule. Nothing on this card is a person's to supply from
   * nothing, and the things that genuinely are — authorizing capital, accepting
   * a risk the evidence cannot settle, an identity-bearing act, choosing
   * between two qualified openings, permitting an external action — are not
   * card fields at all.
   */
  owner: FieldOwner;
}

/**
 * Who answers a question, which is not the same as who may change the answer.
 *
 * `PERSON_ONLY` is deliberately absent from every card field. A person may
 * overrule any of these at any time — `mayReplace` is that order — and being
 * allowed to answer something is not a reason to be *asked* for it.
 */
export type FieldOwner = 'BRAIN_RESEARCH' | 'BRAIN_PROPOSES' | 'PERSON_ONLY';

export interface CardReadiness {
  ready: boolean;
  /** The load-bearing fields with no answer, in the order they are asked. */
  missing: CardFieldKey[];
  /** A sentence for a person: what is missing, or that nothing is. */
  summary: string;
}

export interface EvidenceCard {
  fields: CardField[];
  readiness: CardReadiness;
}

function money(cents: number | null, currency: string): string | null {
  if (cents === null) return null;
  return `${currency} ${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The card for one opportunity.
 *
 * Total and deterministic over the row: the same opportunity produces the same
 * card, which is what makes "is this ready" a decidable question rather than a
 * judgement that moves between readers.
 */
export function evidenceCard(opportunity: CashOpportunity): EvidenceCard {
  const fields: CardField[] = [
    {
      key: 'payer',
      label: 'Payer',
      value: text(opportunity.payer),
      task: 'Name the person or role who can approve payment.',
      loadBearing: true,
      owner: 'BRAIN_RESEARCH',
    },
    {
      key: 'access',
      label: 'Access',
      value: text(opportunity.reachableChannel),
      task: 'Establish a channel that actually reaches them. This is an access task, not a price.',
      loadBearing: true,
      owner: 'BRAIN_RESEARCH',
    },
    {
      key: 'buyingEvidence',
      label: 'Buying evidence',
      /*
       * The signal **and** the date it was observed, or nothing.
       *
       * §3 asks for the source and the observation date together, and an
       * undated signal is the one shape that cannot be told apart from
       * something somebody remembers from last year. Reporting it as answered
       * would be the silent favourable assumption this whole module refuses:
       * "they asked us" reads as current evidence whether the asking was on
       * Tuesday or in March.
       */
      value:
        text(opportunity.buyingSignal) === null || text(opportunity.signalObservedAt) === null
          ? null
          : `${text(opportunity.buyingSignal)} (observed ${text(opportunity.signalObservedAt)})`,
      task:
        'Record the current request, deadline, prior conversation or confirmed pain, with its ' +
        'source and the date it was observed. A signal with no date is not evidence about now.',
      loadBearing: true,
      owner: 'BRAIN_RESEARCH',
    },
    {
      key: 'offer',
      label: 'Offer',
      value: text(opportunity.offerScope),
      task: 'State one outcome, one scope, and the edges it explicitly excludes.',
      loadBearing: true,
      owner: 'BRAIN_PROPOSES',
    },
    {
      key: 'acceptance',
      label: 'Acceptance condition',
      value: text(opportunity.acceptanceCondition),
      task: 'State what the buyer has to see for this to be accepted.',
      loadBearing: true,
      owner: 'BRAIN_PROPOSES',
    },
    {
      key: 'price',
      label: 'Price',
      value: money(opportunity.priceCents, opportunity.currency),
      task:
        'Quote one price, read from what comparable work is published at. A missing supplier ' +
        'price is a research task, not a discount.',
      loadBearing: true,
      owner: 'BRAIN_RESEARCH',
    },
    {
      key: 'delivery',
      label: 'Delivery',
      value: text(opportunity.deliveryMethod),
      task: 'Say how the work is actually done, and what access and customer inputs it needs.',
      loadBearing: true,
      owner: 'BRAIN_RESEARCH',
    },
    {
      key: 'fulfillment',
      label: 'Who does the work',
      value: text(opportunity.fulfillmentOwner),
      task: 'Name the operator, contractor or tool that fulfils this.',
      loadBearing: true,
      owner: 'BRAIN_RESEARCH',
    },
    {
      key: 'cashDates',
      label: 'Cash dates',
      value: text(opportunity.deadline),
      task:
        'Say when the customer might decide, pay and accept delivery, and when the funds become ' +
        'usable. Check the provider payout schedule rather than assuming a sale clears.',
      loadBearing: false,
      owner: 'BRAIN_RESEARCH',
    },
    {
      key: 'economics',
      label: 'Economics',
      value: text(opportunity.economicsNote),
      task:
        'Payment minus acquisition, delivery, tools, processing and foreseeable rework — ' +
        'including unsuccessful test spend.',
      loadBearing: false,
      owner: 'BRAIN_RESEARCH',
    },
    {
      key: 'exposure',
      label: 'Exposure',
      value: money(opportunity.peakFundingCents, opportunity.currency),
      task: 'State the maximum cash out before the money is usable.',
      loadBearing: true,
      owner: 'BRAIN_RESEARCH',
    },
    {
      key: 'nextAction',
      label: 'Next action',
      value: text(opportunity.nextAction),
      task: 'The cheapest step that produces a buying signal or settles a decisive unknown.',
      loadBearing: false,
      owner: 'BRAIN_PROPOSES',
    },
  ];

  const missing = fields.filter((f) => f.loadBearing && f.value === null).map((f) => f.key);
  return {
    fields,
    readiness: {
      ready: missing.length === 0,
      missing,
      summary:
        missing.length === 0
          ? 'The payer, the offer, the delivery path and the bounded exposure are all answered, ' +
            'so this is ready to test.'
          : `${missing.length} thing${missing.length === 1 ? '' : 's'} on this card ${
              missing.length === 1 ? 'is' : 'are'
            } unknown, and an unknown is not a yes: ` +
            fields
              .filter((f) => missing.includes(f.key))
              .map((f) => f.label.toLowerCase())
              .join(', ') +
            '.',
    },
  };
}

/** The shorthand the portfolio and the routes both use. */
export function readyToTest(opportunity: CashOpportunity): boolean {
  return evidenceCard(opportunity).readiness.ready;
}

/**
 * Whose question any card or engine field is, by key.
 *
 * One table rather than two readers, because the review, the tier and the page
 * all ask it and a rule applied by one of three readers is worse than none.
 *
 * The default is `BRAIN_RESEARCH`, and that is the safe direction here: a field
 * wrongly marked research is a question Brain goes and answers, while one
 * wrongly marked a person's is a question that sits on somebody's screen for
 * ever waiting for them to supply a fact they have no way of knowing. That is
 * the failure this whole distinction was written from.
 */
const FIELD_OWNER: Readonly<Record<string, FieldOwner>> = Object.freeze({
  // The twelve on the short card.
  payer: 'BRAIN_RESEARCH',
  access: 'BRAIN_RESEARCH',
  buyingEvidence: 'BRAIN_RESEARCH',
  offer: 'BRAIN_PROPOSES',
  acceptance: 'BRAIN_PROPOSES',
  price: 'BRAIN_RESEARCH',
  delivery: 'BRAIN_RESEARCH',
  fulfillment: 'BRAIN_RESEARCH',
  cashDates: 'BRAIN_RESEARCH',
  economics: 'BRAIN_RESEARCH',
  exposure: 'BRAIN_RESEARCH',
  nextAction: 'BRAIN_PROPOSES',

  // What a decision turns on, beyond a bounded test.
  revenueRange: 'BRAIN_RESEARCH',
  directCosts: 'BRAIN_RESEARCH',
  requiredCapital: 'BRAIN_PROPOSES',
  timeToFirstCash: 'BRAIN_RESEARCH',
  hours: 'BRAIN_RESEARCH',
  laborNeeds: 'BRAIN_RESEARCH',
  eligibility: 'BRAIN_RESEARCH',
  acquisitionAccess: 'BRAIN_RESEARCH',
  exitEvidence: 'BRAIN_RESEARCH',
  phoneDependency: 'BRAIN_RESEARCH',
  firstSteps: 'BRAIN_PROPOSES',
  bottleneck: 'BRAIN_PROPOSES',
  disqualifiers: 'BRAIN_RESEARCH',
  scalingLever: 'BRAIN_PROPOSES',
  captureMechanism: 'BRAIN_PROPOSES',
  fulfilmentModel: 'BRAIN_PROPOSES',
  confidence: 'BRAIN_PROPOSES',
  recommendation: 'BRAIN_PROPOSES',
});

export function fieldOwner(key: string): FieldOwner {
  return FIELD_OWNER[key] ?? 'BRAIN_RESEARCH';
}
