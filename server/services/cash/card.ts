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
   * Whether the answer is a fact about the world or a decision of the owner's.
   *
   * Who can approve payment, how to reach them and what they published are
   * facts somebody could look up — so Brain should go and find them rather
   * than putting them on a person's review. What to offer, what to charge, what
   * counts as accepted and who does the work are the owner's calls, and Brain
   * asking for them is the right thing to ask for.
   *
   * The distinction is the review's, and it is what stops a compressed screen
   * filling with questions that were never a person's to answer.
   */
  discoverable: boolean;
}

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
      discoverable: true,
    },
    {
      key: 'access',
      label: 'Access',
      value: text(opportunity.reachableChannel),
      task: 'Establish a channel that actually reaches them. This is an access task, not a price.',
      loadBearing: true,
      discoverable: true,
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
      discoverable: true,
    },
    {
      key: 'offer',
      label: 'Offer',
      value: text(opportunity.offerScope),
      task: 'State one outcome, one scope.',
      loadBearing: true,
      discoverable: false,
    },
    {
      key: 'acceptance',
      label: 'Acceptance condition',
      value: text(opportunity.acceptanceCondition),
      task: 'State what the buyer has to see for this to be accepted.',
      loadBearing: true,
      discoverable: false,
    },
    {
      key: 'price',
      label: 'Price',
      value: money(opportunity.priceCents, opportunity.currency),
      task: 'Quote one price. A missing supplier price is a quoting task, not a discount.',
      loadBearing: true,
      discoverable: false,
    },
    {
      key: 'delivery',
      label: 'Delivery',
      value: text(opportunity.deliveryMethod),
      task: 'Say how the work is actually done, and what access and customer inputs it needs.',
      loadBearing: true,
      discoverable: false,
    },
    {
      key: 'fulfillment',
      label: 'Who does the work',
      value: text(opportunity.fulfillmentOwner),
      task: 'Name the operator, contractor or tool that fulfils this.',
      loadBearing: true,
      discoverable: false,
    },
    {
      key: 'cashDates',
      label: 'Cash dates',
      value: text(opportunity.deadline),
      task:
        'Say when the customer might decide, pay and accept delivery, and when the funds become ' +
        'usable. Check the provider payout schedule rather than assuming a sale clears.',
      loadBearing: false,
      discoverable: false,
    },
    {
      key: 'economics',
      label: 'Economics',
      value: text(opportunity.economicsNote),
      task:
        'Payment minus acquisition, delivery, tools, processing and foreseeable rework — ' +
        'including unsuccessful test spend.',
      loadBearing: false,
      discoverable: false,
    },
    {
      key: 'exposure',
      label: 'Exposure',
      value: money(opportunity.peakFundingCents, opportunity.currency),
      task: 'State the maximum cash out before the money is usable.',
      loadBearing: true,
      discoverable: false,
    },
    {
      key: 'nextAction',
      label: 'Next action',
      value: text(opportunity.nextAction),
      task: 'The cheapest step that produces a buying signal or settles a decisive unknown.',
      loadBearing: false,
      discoverable: false,
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
