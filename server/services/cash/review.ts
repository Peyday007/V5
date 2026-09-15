/**
 * The compressed private review.
 *
 * The plan's interaction goal is roughly a hundred underlying decisions and
 * actions becoming about ten daily review items, and it is explicit that ten is
 * an example rather than a quota, a ceiling on opportunities or permission to
 * hide an urgent decision.
 *
 * Three properties make that honest rather than decorative.
 *
 * **Compression is measured, not claimed.** Every group carries the underlying
 * items it stands for, and the result reports both counts. A review that said
 * "10 items" while silently dropping the eleventh would be worse than no
 * compression: this one groups, and what it groups is countable.
 *
 * **Nothing is hidden.** Grouping is by *shared remedy* — the same missing
 * field, the same recommended path, the same blocker — so answering one group
 * releases every underlying item in it. An item with no group of its own is its
 * own group rather than being dropped at the tail of a top-ten list.
 *
 * **The decision nothing can proceed without is never folded.** A project with
 * no live commercial grant has exactly one thing outstanding, and it is named
 * first. §29 records what happens otherwise: a status that contradicts the
 * control beside it teaches a person to stop reading it.
 *
 * It is a projection. It writes nothing, decides nothing, and every sentence in
 * it is composed from a row.
 */
import type {
  CashAuthority,
  CashMode,
  CashNeed,
  CashOpportunity,
} from '../../domain/types.ts';
import type { Placement } from './portfolio.ts';
import type { CashPosition } from './money.ts';

/**
 * What answering one of these actually does.
 *
 * A closed set naming an operation that **already exists** — the grant, closing
 * a need, releasing a commitment, filling a card. A review that grew its own
 * apply endpoint would be a second way to do each of those, and the second one
 * is always the one that forgets a guard.
 *
 * `NOTHING_TO_PRESS` is a real value rather than an omission: an expiring
 * opening is worth putting in front of somebody and is answered by doing the
 * work, not by a control on this screen. Saying so is better than a button that
 * marks it read.
 */
export type ReviewAnswerKind =
  | 'GRANT_AUTHORITY'
  | 'RESOLVE_NEED'
  | 'RELEASE_COMMITMENT'
  | 'RECORD_MONEY'
  | 'FILL_CARD_FIELD'
  | 'NOTHING_TO_PRESS';

export interface ReviewAnswer {
  kind: ReviewAnswerKind;
  /** The rows the answer applies to. Empty for an answer with no target. */
  targets: string[];
  /** The control's words, composed by the server. */
  label: string;
  /**
   * What Brain will read to decide it actually happened.
   *
   * Not a promise that pressing the control worked: the tick re-derives every
   * one of these from rows, so an answer that did not settle its condition
   * leaves the item on the screen rather than disappearing.
   */
  completionCondition: string;
}

export interface ReviewItem {
  key: string;
  title: string;
  /** Why this is worth a person's attention, in one sentence. */
  why: string;
  /** What Brain suggests, and what happens if it is taken. */
  recommendation: string;
  consequence: string;
  urgency: 'URGENT' | 'BLOCKING' | 'WHENEVER';
  /** The rows this stands for. */
  underlying: string[];
  /**
   * Whether one act answers every underlying row, or they merely look alike.
   *
   * The review used to claim the first about every group it made, and it was
   * false for most of them: three cards with no payer are three different
   * buyers and three different lookups, however identical the sentence
   * describing them. A screen that says "answering this releases three" and
   * then releases one teaches a person to stop believing the counts.
   */
  sharedRemedy: boolean;
  /**
   * What the remedy costs, when it is one remedy with a stated cost.
   *
   * Never a sum across a group. Two opportunities blocked on the same tool are
   * one purchase, and adding their expected costs reports twice the price of
   * buying it once — which is the direction that matters, because it makes a
   * cheap unblock look expensive enough to defer.
   */
  costCents: number | null;
  /** Why the cost reads the way it does, when it is not a single figure. */
  costNote: string | null;
  answer: ReviewAnswer;
}

export interface CompressedReview {
  items: ReviewItem[];
  /** How many underlying decisions and actions these items stand for. */
  underlyingCount: number;
  /** A sentence about the compression itself, composed from the two counts. */
  summary: string;
}

export interface ReviewInput {
  mode: CashMode | null;
  authority: CashAuthority | null;
  position: CashPosition;
  placements: Placement[];
  needs: CashNeed[];
  /** The Brain's clock, so a test can ask about an expiry without waiting. */
  now: string;
}

export function compressedReview(input: ReviewInput): CompressedReview {
  const items: ReviewItem[] = [];

  /*
   * 1. The one decision nothing can proceed without.
   *
   * Named first and never folded. A project with a portfolio and no live
   * commercial grant is not "waiting on Brain" — it is waiting on the person
   * reading this, and saying anything else here is the defect §29 records.
   */
  if (input.mode && !input.authority) {
    items.push({
      key: 'AUTHORITY',
      title: 'Decide what Brain may spend here',
      why:
        'There is no standing commercial authority on this account, so nothing can be committed, ' +
        'quoted or collected however good an opening is.',
      recommendation:
        'Approve a standing commercial authority with the ceilings you are comfortable with. ' +
        'It can be withdrawn at any time and withdrawing it keeps every record.',
      consequence:
        'Until it exists, discovery keeps running and every execution step is refused for want ' +
        'of a decision only you can make.',
      urgency: 'BLOCKING',
      underlying: [],
      sharedRemedy: true,
      costCents: null,
      costNote: 'Approving a grant spends nothing. It sets a ceiling.',
      answer: {
        kind: 'GRANT_AUTHORITY',
        targets: [],
        label: 'Approve a standing commercial authority',
        completionCondition: 'A live commercial grant exists on this project.',
      },
    });
  }

  /*
   * 2. Openings that are ready and are waiting on money or capacity.
   *
   * One group, because they share a remedy: release a commitment, settle
   * something, raise a ceiling, or finish something that is running.
   */
  const stalled = input.placements.filter(
    (p) =>
      p.disposition === 'WAIT_FOR_DEPENDENCY' &&
      p.opportunity.state === 'READY' &&
      !p.opportunity.dependsOnId,
  );
  if (stalled.length > 0) {
    items.push({
      key: 'READY_BUT_HELD',
      title: `${stalled.length} ready ${stalled.length === 1 ? 'opening is' : 'openings are'} held by money or capacity`,
      why:
        'Nothing about these is unresolved. They are waiting on deployable cash or on a free ' +
        'execution slot, which are both your decisions rather than findings.',
      recommendation:
        'Settle or release a commitment, add capital, or let something finish. Each of these ' +
        'starts by itself once there is room.',
      consequence: 'Answering this once releases all of them.',
      urgency: 'BLOCKING',
      underlying: stalled.map((p) => p.opportunity.id),
      // Genuinely one remedy: they are all waiting on the same pool of cash
      // and the same set of execution slots, so freeing either releases them.
      sharedRemedy: true,
      costCents: null,
      costNote: null,
      answer: {
        kind: 'RELEASE_COMMITMENT',
        targets: [],
        label: 'Release or settle a commitment',
        completionCondition:
          'Deployable cash covers one of these, or an execution slot comes free.',
      },
    });
  }

  /*
   * 3. Cards with the same load-bearing blank.
   *
   * Grouped by the missing field, and **not** claimed to be one decision. The
   * first version of this said answering the group released every card in it,
   * and that is false wherever the group is three different buyers: one
   * afternoon of the same kind of work is a batch, not one answer. The item
   * now says which it is, so the count on the screen means what it says.
   *
   * The discoverable fields are absent from here entirely — Brain raises a
   * need and researches them (see `reconcileDiscoverableGaps`), because a
   * review filling up with homework Brain could have done is the opposite of
   * compression.
   */
  const byMissing = new Map<string, string[]>();
  for (const placement of input.placements) {
    if (placement.disposition !== 'TEST_A_DECISIVE_UNKNOWN') continue;
    for (const field of placement.missing) {
      if (DISCOVERABLE_FIELDS.has(field)) continue;
      const bucket = byMissing.get(field) ?? [];
      bucket.push(placement.opportunity.id);
      byMissing.set(field, bucket);
    }
  }
  for (const [field, ids] of [...byMissing.entries()].sort((a, b) => b[1].length - a[1].length)) {
    items.push({
      key: `MISSING_${field.toUpperCase()}`,
      title: `${ids.length} card${ids.length === 1 ? '' : 's'} with no ${humanField(field)}`,
      why: `An unknown is not a favourable assumption, so none of these can be tested until the ${humanField(field)} is established.`,
      recommendation: REMEDY[field] ?? `Establish the ${humanField(field)} for each of these.`,
      consequence:
        ids.length === 1
          ? 'It becomes ready to test the moment its answer exists.'
          : `These are ${ids.length} separate answers of the same kind — one sitting, not one ` +
            'decision. Each becomes ready to test the moment its own answer exists.',
      urgency: 'WHENEVER',
      underlying: ids,
      sharedRemedy: ids.length === 1,
      costCents: null,
      costNote: null,
      answer: {
        kind: 'FILL_CARD_FIELD',
        targets: ids,
        label: `Answer the ${humanField(field)} on ${ids.length === 1 ? 'this card' : 'each card'}`,
        completionCondition: `Every one of these cards records a ${humanField(field)}.`,
      },
    });
  }

  /*
   * 4. Needs, grouped by the remedy they recommend.
   *
   * Two opportunities blocked on the same missing tool are one purchase, not
   * two decisions.
   */
  const byPath = new Map<string, CashNeed[]>();
  for (const need of input.needs) {
    if (need.state !== 'OPEN') continue;
    // A question Brain is already researching is not a decision for a person.
    // It is on the screen as work in progress, not as something to answer.
    if (need.candidateId) continue;
    const bucket = byPath.get(need.recommendedPath) ?? [];
    bucket.push(need);
    byPath.set(need.recommendedPath, bucket);
  }
  for (const [path, needs] of byPath) {
    const { cents, note } = remedyCost(needs);
    items.push({
      key: `NEED_${needs[0]!.id}`,
      title:
        needs.length === 1
          ? `Brain needs: ${needs[0]!.blockedAction}`
          : `${needs.length} blocked actions, one remedy`,
      why: needs.map((n) => n.whyItMatters).join(' '),
      recommendation: `${path}${cents === null ? '' : ` (about ${cents} cents)`}. Next step: ${needs[0]!.nextStep}`,
      consequence: `Resolving this unblocks ${needs.length} action${needs.length === 1 ? '' : 's'}. Independent work is running meanwhile.`,
      urgency: 'WHENEVER',
      underlying: needs.map((n) => n.id),
      // These *are* one remedy: they were grouped because they recommend the
      // identical path, which is one tool bought once or one account opened
      // once. That is the case the field exists to distinguish from the one
      // above it.
      sharedRemedy: true,
      costCents: cents,
      costNote: note,
      answer: {
        kind: 'RESOLVE_NEED',
        targets: needs.map((n) => n.id),
        label:
          needs.length === 1
            ? 'Mark this done, and say what you did'
            : `Mark all ${needs.length} done, and say what you did`,
        completionCondition: needs
          .map((n) => n.completionCondition)
          .filter((one): one is string => !!one)
          .join(' ') || 'The recommended path was taken.',
      },
    });
  }

  /*
   * 5. Openings that are about to close.
   *
   * Urgent, and deliberately last in construction and first in the sort: an
   * expiry is the one thing on this screen that gets worse by being read
   * tomorrow.
   */
  const expiring = input.placements.filter(
    (p) =>
      p.disposition !== 'ARCHIVED' &&
      p.opportunity.expiresAt !== null &&
      p.opportunity.expiresAt <= plusDays(input.now, 3),
  );
  if (expiring.length > 0) {
    items.push({
      key: 'EXPIRING',
      title: `${expiring.length} opening${expiring.length === 1 ? '' : 's'} close${expiring.length === 1 ? 's' : ''} within three days`,
      why: expiring
        .map((p) => `"${p.opportunity.title}" ${p.opportunity.expiryReason ?? 'closes'} on ${p.opportunity.expiresAt}`)
        .join('; '),
      recommendation:
        'Take these before the slower pieces. An opening that closes is worth nothing afterwards, ' +
        'however good its economics were.',
      consequence: 'Nothing else in the portfolio gets worse by waiting a day; these do.',
      urgency: 'URGENT',
      underlying: expiring.map((p) => p.opportunity.id),
      sharedRemedy: false,
      costCents: null,
      costNote: null,
      answer: {
        kind: 'NOTHING_TO_PRESS',
        targets: expiring.map((p) => p.opportunity.id),
        label: 'Answered by taking them, not by a control here',
        completionCondition: 'Each of these is executing, declined, or has closed.',
      },
    });
  }

  /*
   * 6. The shortfall.
   *
   * §5 says an account whose deployable cash is negative exposes the funding
   * shortfall and blocks new discretionary commitments. That block is enforced
   * in `commitSpend`; this is the person being told.
   */
  if (input.position.shortfall) {
    items.push({
      key: 'SHORTFALL',
      title: 'Deployable cash is negative',
      why:
        `Available funds minus unpaid commitments, held commitments and reserves is ` +
        `${input.position.deployableCents} cents.`,
      recommendation:
        'Fund the shortfall, release a commitment that is not going to be spent, or let a ' +
        'settlement land. New discretionary commitments are refused until one of those happens.',
      consequence: 'Delivery on work already sold continues regardless.',
      urgency: 'BLOCKING',
      underlying: [],
      sharedRemedy: true,
      costCents: null,
      costNote: null,
      answer: {
        kind: 'RECORD_MONEY',
        targets: [],
        label: 'Record the funding, or release a commitment',
        completionCondition: 'Deployable cash is no longer negative.',
      },
    });
  }

  const ordered = items.sort((a, b) => URGENCY[a.urgency] - URGENCY[b.urgency]);
  const underlyingCount = ordered.reduce((total, item) => total + item.underlying.length, 0);
  return {
    items: ordered,
    underlyingCount,
    summary:
      ordered.length === 0
        ? 'Nothing needs a decision from you. Discovery and delivery carry on without you.'
        : `${ordered.length} thing${ordered.length === 1 ? '' : 's'} to decide, standing for ` +
          `${underlyingCount} underlying item${underlyingCount === 1 ? '' : 's'}. Answering one ` +
          'releases everything grouped under it.',
  };
}

const URGENCY: Record<ReviewItem['urgency'], number> = { URGENT: 0, BLOCKING: 1, WHENEVER: 2 };

/**
 * The card blanks Brain looks up rather than asking about.
 *
 * Kept as a set here rather than read from `evidenceCard`, because this module
 * is a pure projection over rows and taking an opportunity apart to ask about
 * one field would make it depend on the card's shape. Exported so a test holds
 * the two in agreement: two readers of one fact that could drift is how the one
 * nobody reads comes to be wrong, and here the drift would put a question Brain
 * researches back on a person's review, or take one off it that Brain never
 * looks up.
 */
export const DISCOVERABLE_FIELDS = new Set(['payer', 'access', 'buyingEvidence']);

/**
 * What a shared remedy costs, which is not the sum of what it unblocks.
 *
 * Two opportunities blocked on the same small tool are one purchase. Adding
 * their expected costs reported twice the price of buying it once — and the
 * direction matters, because an over-stated cost makes a cheap unblock look
 * expensive enough to defer. Where the group's members declare the same figure
 * it is that figure, once. Where they differ Brain cannot tell whether that is
 * one remedy priced inconsistently or several, so it says the range rather than
 * inventing a total.
 */
function remedyCost(needs: CashNeed[]): { cents: number | null; note: string | null } {
  const stated = needs
    .map((one) => one.expectedCostCents)
    .filter((one): one is number => one !== null && one > 0);
  if (stated.length === 0) return { cents: null, note: null };
  const distinct = [...new Set(stated)].sort((a, b) => a - b);
  if (distinct.length === 1) {
    return {
      cents: distinct[0]!,
      note:
        needs.length === 1
          ? null
          : `One remedy at ${distinct[0]} cents, paid once — not ${needs.length} times.`,
    };
  }
  return {
    cents: distinct[distinct.length - 1]!,
    note:
      `These name different costs — ${distinct.join(' and ')} cents — so this is the largest of ` +
      'them rather than a total. Adding them would assume they are separate purchases, and ' +
      'nothing here knows that.',
  };
}

const REMEDY: Record<string, string> = {
  payer: 'Establish who can approve payment. This is an access question, not a pricing one.',
  access: 'Find a channel that actually reaches them, before writing anything to send.',
  buyingEvidence:
    'Record the request, deadline or conversation that supports each of these, with its source ' +
    'and date. "An industry has this problem" is not evidence that one owner will buy this week.',
  offer: 'Write one outcome and one scope for each.',
  acceptance: 'State what the buyer has to see for it to be accepted.',
  price: 'Quote one price. A missing supplier price is a quoting task, not a discount.',
  delivery: 'Say how the work actually gets done, and what the customer has to provide.',
  fulfillment: 'Name who or what fulfils each of these.',
  exposure: 'State the maximum cash out before the money comes back.',
};

function humanField(field: string): string {
  return (
    {
      payer: 'payer',
      access: 'way to reach the payer',
      buyingEvidence: 'buying evidence',
      offer: 'offer',
      acceptance: 'acceptance condition',
      price: 'price',
      delivery: 'delivery path',
      fulfillment: 'fulfilment owner',
      exposure: 'exposure',
    }[field] ?? field
  );
}

function plusDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * Where the numbers behind the goal come from.
 *
 * The plan's target is a ratio of underlying work to review items. Returning
 * both rather than a percentage is deliberate: a percentage would invite a
 * dashboard reading of a goal that is about whether a person's day is usable.
 */
export function compressionRatio(review: CompressedReview): {
  items: number;
  underlying: number;
} {
  return { items: review.items.length, underlying: review.underlyingCount };
}
