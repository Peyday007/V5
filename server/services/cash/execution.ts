/**
 * An opportunity, compiled backwards from settled cash into ordered actions.
 *
 * `portfolio.ts` says *which* pieces to work on and `card.ts` says what is still
 * unknown about one. Neither says what anybody actually does on Monday, and the
 * gap showed as the one output a cash sprint exists to produce being absent:
 * a plan that reads "start a company" or "call 100 businesses" is not an
 * instruction, it is a genre.
 *
 * Three rules shape everything below, and each is one this file could most
 * easily have broken.
 *
 * **Every step names a real actor.** `Actor` is a closed set and there is no
 * member meaning "the user" or "somebody". A step nobody can be assigned is a
 * step that does not get done, and the failure is silent because the plan still
 * reads complete. `PERSON` is deliberately the narrowest of the four: it is an
 * approval or a signature, never labour, because the four account owners are
 * not staff and a plan that quietly rosters them is a forecast resting on
 * people who never agreed to it.
 *
 * **Nothing here forecasts.** The three ranges are arithmetic over figures
 * somebody published — `priceCents`, `peakFundingCents`, `humanHours` — and
 * every one of them is withheld, naming what is missing, when an input is
 * absent. §30 settles this twice over: a margin against an unknown cost fails
 * in the direction that makes a piece look worth doing, and unpriced effort
 * stays unpriced rather than being multiplied by a rate nobody set. A range
 * derived and explained afterwards is the invented judgment `figures.ts` exists
 * to refuse.
 *
 * **It is derived on the read path and stored nowhere.** A row is not a
 * decision: the moment a need is answered or a dependency settles, a stored
 * plan is a stale plan, and two readers deriving it separately is how one
 * screen comes to disagree with another. It writes nothing, performs nothing,
 * and authorizes nothing — the authority check, the commitment ceiling and the
 * recorded `cash_actions` row are all exactly where they were.
 */
import type { CashNeed, CashOpportunity } from '../../domain/types.ts';

/**
 * Who does a thing.
 *
 * Closed, and short. The absent member is the important one: there is no
 * `USER`, no `SOMEBODY` and no `TEAM`, so a step that cannot be given to one of
 * these four cannot be written at all.
 */
export const CASH_ACTORS = ['BRAIN', 'OPERATOR', 'VENDOR', 'PERSON'] as const;
export type CashActor = (typeof CASH_ACTORS)[number];

export interface ExecutionStep {
  /** Stable within one opportunity, so a reader can refer to a step. */
  key: string;
  /** What is done, in the imperative, naming the thing rather than the goal. */
  action: string;
  actor: CashActor;
  /**
   * What proves it happened.
   *
   * Required, and it is the half that makes a step checkable rather than
   * reportable. "Contacted the buyer" is a claim; "the sent message, with its
   * timestamp and recipient" is a row somebody can look at. §27's rule about a
   * worker's summary never being evidence, at the scale of one task.
   */
  artifact: string;
  /** Step keys that must be finished first. Empty means it can start now. */
  dependsOn: string[];
  /**
   * True when this step performs an effect on the world.
   *
   * Contacting a buyer, publishing, buying, invoicing and moving money are all
   * `COMMERCIAL_ACTIONS` and all refused without a live grant. Marking it here
   * is what lets a reader see the boundary in the plan rather than discovering
   * it when a step is refused.
   */
  external: boolean;
}

/** One arithmetic outcome, and the assumptions it rests on. */
export interface CashRange {
  /** Null when an input is missing. The reason is in `withheld`. */
  conservativeCents: number | null;
  baseCents: number | null;
  upsideCents: number | null;
  /** Named, so a reader can disagree with the arithmetic rather than the number. */
  assumptions: string[];
  /** What was missing, when anything was. Empty means the range is complete. */
  withheld: string[];
}

export interface ExecutionPath {
  opportunityId: string;
  /** In dependency order, so a reader can work straight down the list. */
  steps: ExecutionStep[];
  range: CashRange;
  /** The cheapest thing that would settle the biggest doubt, or null. */
  fastestDecisiveTest: string | null;
  /** When to stop, from the opportunity's own recorded rule. */
  killThreshold: string | null;
  /** When to do more of it, derived from the same rule's absence or presence. */
  scaleThreshold: string | null;
  /** Steps this Brain can complete on its own authority today. */
  autonomous: string[];
  /** Steps needing a person, and why each one does. */
  needsAPerson: { key: string; because: string }[];
  /** What stops the path being executable at all, if anything. */
  blockedBy: string[];
}

/**
 * How many sales the ranges assume.
 *
 * One, three and five, and the reason they are constants rather than a model is
 * that Brain has no funnel measurement for an opportunity it has never run.
 * Naming them in `assumptions` is what makes them arguable; deriving them from
 * a conversion rate nobody measured would make them look like findings.
 */
const SALES = Object.freeze({ conservative: 1, base: 3, upside: 5 });

function rangeFor(o: CashOpportunity): CashRange {
  const withheld: string[] = [];
  if (o.priceCents === null) withheld.push('the price per sale is not established');
  if (o.peakFundingCents === null) withheld.push('the maximum capital exposure is not established');

  const assumptions: string[] = [];
  if (withheld.length === 0) {
    assumptions.push(
      `${SALES.conservative}, ${SALES.base} and ${SALES.upside} sales respectively — a stated ` +
        'count rather than a measured conversion rate, because this opportunity has never run',
    );
    assumptions.push('the published price is collected in full, once per sale');
    assumptions.push('capital exposure is spent once, not per sale');
    if (o.humanHours !== null) {
      /*
       * Reported beside the money and never inside it. §30 again: multiplying
       * hours by a rate nobody set is the same defect as a margin against an
       * unknown cost, one step along.
       */
      assumptions.push(
        `${o.humanHours} hour(s) of human effort are excluded from these figures, because no ` +
          'rate has been set for them',
      );
    }
    if (o.paymentTerms) assumptions.push(`payment terms as recorded: ${o.paymentTerms}`);
  }

  if (withheld.length > 0 || o.priceCents === null || o.peakFundingCents === null) {
    return { conservativeCents: null, baseCents: null, upsideCents: null, assumptions, withheld };
  }
  const price = o.priceCents;
  const exposure = o.peakFundingCents;
  return {
    conservativeCents: price * SALES.conservative - exposure,
    baseCents: price * SALES.base - exposure,
    upsideCents: price * SALES.upside - exposure,
    assumptions,
    withheld,
  };
}

/**
 * The steps, built backwards from collected cash.
 *
 * Backwards is not a flourish. Building forwards from "find customers" is how a
 * plan acquires steps that feel like progress and settle nothing; starting at
 * *the money is in the account* and asking what had to be true immediately
 * before produces the settlement mechanism, then the delivery, then the sale,
 * then the approach, then the asset — and each one earns its place by being
 * required rather than by being conventional.
 *
 * A field that is unknown does not remove its step; it makes the step's
 * prerequisite explicit. A plan that silently omitted "agree how you get paid"
 * because nobody had written down the payment terms would read as shorter and
 * be wrong.
 */
function stepsFor(o: CashOpportunity): ExecutionStep[] {
  const steps: ExecutionStep[] = [];

  steps.push({
    key: 'offer',
    action: o.offerScope
      ? `Write the offer as one page: ${o.offerScope}`
      : 'Write the offer as one page, naming what is included and what is explicitly excluded',
    actor: 'BRAIN',
    artifact: 'the offer document, with its scope and exclusions',
    dependsOn: [],
    external: false,
  });

  steps.push({
    key: 'target-list',
    action: o.payer
      ? `Build the target list of buyers matching: ${o.payer}`
      : 'Build the target list once the payer is established',
    actor: 'BRAIN',
    artifact: 'the list, each row carrying the published source it came from and its date',
    dependsOn: [],
    external: false,
  });

  steps.push({
    key: 'evidence-pack',
    action: 'Assemble the evidence pack: the buying signal, its source and its date',
    actor: 'BRAIN',
    artifact: 'the pack, every claim resolving to a URL and a passage',
    dependsOn: ['target-list'],
    external: false,
  });

  if (o.requiredInputs) {
    steps.push({
      key: 'inputs',
      action: `Obtain what delivery requires: ${o.requiredInputs}`,
      actor: 'VENDOR',
      artifact: 'each input present and usable, named individually',
      dependsOn: ['offer'],
      external: false,
    });
  }

  steps.push({
    key: 'settlement',
    action: o.paymentTerms
      ? `Set up how the money arrives: ${o.paymentTerms}`
      : 'Establish how the money arrives, and confirm it can receive a payment before selling',
    actor: 'PERSON',
    artifact: 'a settlement route that has accepted a test payment',
    dependsOn: [],
    external: false,
  });

  /*
   * The first step that touches the world, and it is deliberately the fifth
   * rather than the first. Everything above is reversible and costs nothing; a
   * plan whose opening move is contacting somebody has spent its credibility
   * before it knows whether the offer is right.
   */
  steps.push({
    key: 'approach',
    action: o.reachableChannel
      ? `Approach the buyers through: ${o.reachableChannel}`
      : 'Approach the buyers, once a reachable channel is established',
    actor: 'OPERATOR',
    artifact: 'the sent messages, with recipients and timestamps',
    dependsOn: ['offer', 'target-list', 'evidence-pack', 'settlement'],
    external: true,
  });

  steps.push({
    key: 'agree',
    action: o.acceptanceCondition
      ? `Get agreement on: ${o.acceptanceCondition}`
      : 'Get written agreement on scope and price before any delivery',
    actor: 'OPERATOR',
    artifact: "the buyer's written acceptance, naming scope and price",
    dependsOn: ['approach'],
    external: true,
  });

  steps.push({
    key: 'deliver',
    action: o.deliveryMethod
      ? `Deliver by: ${o.deliveryMethod}`
      : 'Deliver, by a method recorded before the first sale',
    actor: o.fulfillmentOwner?.toLowerCase().includes('brain') ? 'BRAIN' : 'VENDOR',
    artifact: 'the delivered work, and the buyer acknowledging receipt',
    dependsOn: ['agree'],
    external: true,
  });

  steps.push({
    key: 'collect',
    action: 'Invoice and collect',
    actor: 'PERSON',
    artifact: 'a settlement record with a verifiable payment reference',
    dependsOn: ['deliver', 'settlement'],
    external: true,
  });

  return steps;
}

/**
 * Compile one opportunity into the instruction somebody can act on.
 *
 * `needs` are passed in rather than read, so this stays a pure function over
 * rows the caller already has — the same property that makes `router.ts`
 * answerable after the fact, and the same reason it is useless as a control:
 * nothing here decides whether anything may happen.
 */
export function executionPath(o: CashOpportunity, needs: readonly CashNeed[] = []): ExecutionPath {
  const steps = stepsFor(o);
  const range = rangeFor(o);

  const blockedBy: string[] = [];
  for (const need of needs) {
    if (need.opportunityId === o.id && need.state === 'OPEN') {
      blockedBy.push(`${need.blockedAction}: ${need.nextStep}`);
    }
  }
  if (o.requiredCapabilities.length > 0 && o.state === 'DISCOVERED') {
    blockedBy.push('the evidence card is not complete, so nothing here is authorized yet');
  }

  const needsAPerson = steps
    .filter((step) => step.actor === 'PERSON' || step.external)
    .map((step) => ({
      key: step.key,
      because:
        step.actor === 'PERSON'
          ? 'a decision or a signature, which no machine holds authority for'
          : 'an effect on the world, refused without a live commercial grant',
    }));

  return {
    opportunityId: o.id,
    steps,
    range,
    /*
     * The decisive test is the *cheapest* thing that would move the most, and
     * the honest answer is often that everything load-bearing is already known.
     * Null rather than a manufactured suggestion.
     */
    fastestDecisiveTest:
      o.payer === null
        ? 'Establish who exactly pays, before anything else is built'
        : o.priceCents === null
          ? 'Establish what this actually sells for, from a published price'
          : o.buyingSignal === null
            ? 'Find one dated, published instance of somebody asking to buy this'
            : null,
    killThreshold: o.stopRule,
    /*
     * Derived from the same rule rather than invented beside it. An opportunity
     * with no recorded stop rule has no scale rule either, and saying so is
     * better than offering a threshold nobody set.
     */
    scaleThreshold: o.stopRule
      ? 'Repeat once the first sale has settled and the stop rule has not triggered'
      : null,
    autonomous: steps.filter((s) => s.actor === 'BRAIN' && !s.external).map((s) => s.key),
    needsAPerson,
    blockedBy,
  };
}
