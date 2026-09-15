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

export interface ReviewItem {
  key: string;
  title: string;
  /** Why this is worth a person's attention, in one sentence. */
  why: string;
  /** What Brain suggests, and what happens if it is taken. */
  recommendation: string;
  consequence: string;
  urgency: 'URGENT' | 'BLOCKING' | 'WHENEVER';
  /** The rows this stands for. Answering the group releases all of them. */
  underlying: string[];
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
    });
  }

  /*
   * 3. Cards with the same load-bearing blank.
   *
   * Grouped by the missing field rather than by opportunity, because that is
   * the shared remedy: one afternoon establishing payers answers every card
   * missing a payer. This is where most of the compression actually comes from.
   */
  const byMissing = new Map<string, string[]>();
  for (const placement of input.placements) {
    if (placement.disposition !== 'TEST_A_DECISIVE_UNKNOWN') continue;
    for (const field of placement.missing) {
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
      consequence: 'Each one becomes ready to test the moment its answer exists.',
      urgency: 'WHENEVER',
      underlying: ids,
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
    const bucket = byPath.get(need.recommendedPath) ?? [];
    bucket.push(need);
    byPath.set(need.recommendedPath, bucket);
  }
  for (const [path, needs] of byPath) {
    const cost = needs.reduce((total, n) => total + (n.expectedCostCents ?? 0), 0);
    items.push({
      key: `NEED_${needs[0]!.id}`,
      title:
        needs.length === 1
          ? `Brain needs: ${needs[0]!.blockedAction}`
          : `${needs.length} blocked actions, one remedy`,
      why: needs.map((n) => n.whyItMatters).join(' '),
      recommendation: `${path}${cost > 0 ? ` (about ${cost} cents)` : ''}. Next step: ${needs[0]!.nextStep}`,
      consequence: `Resolving this unblocks ${needs.length} action${needs.length === 1 ? '' : 's'}. Independent work is running meanwhile.`,
      urgency: 'WHENEVER',
      underlying: needs.map((n) => n.id),
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
