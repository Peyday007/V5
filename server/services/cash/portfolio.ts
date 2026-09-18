/**
 * The assembled cash plan.
 *
 * Two derivations live here and both are on the read path, because a row is not
 * a decision: a stored disposition is stale the moment the dependency it was
 * waiting on settles, and a stored rank is stale the moment a deadline passes.
 *
 * ---------------------------------------------------------------------------
 * No invented probability, anywhere
 * ---------------------------------------------------------------------------
 *
 * §3 is explicit: do not invent a 40% close probability. So the ranking here is
 * **lexicographic over observable facts** rather than a weighted score. A
 * weighted score needs weights, weights are a judgement nobody made, and the
 * resulting number reads like a measurement. A lexicographic order needs only
 * the plan's own list of criteria, in the plan's own sequence, and every step
 * of it resolves to a column.
 *
 * And an unknown never helps. A missing exposure sorts *last* on exposure and a
 * missing contribution counts as zero, because §3's rule is that an unsupported
 * fact is unknown rather than favourable — a ranking that let a blank float to
 * the top would be exactly the silent favourable assumption the card refuses.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is a concurrency cap on how many pieces may be *assembled*
 * ---------------------------------------------------------------------------
 *
 * The plan is emphatic that stacking is the point and that the screen's focus
 * is not a limit of one. `maxConcurrent` bounds how many may be **executing**,
 * which is real fulfilment capacity, and it changes a piece's disposition from
 * "run in parallel" to "wait" rather than removing it from the portfolio.
 */
import { evidenceCard } from './card.ts';
import { tierRank, type CashTier, type TierReading } from './tier.ts';
import type { CashDisposition, CashOpportunity } from '../../domain/types.ts';

/** The states in which an opportunity is occupying real fulfilment capacity. */
const IN_FLIGHT = new Set(['EXECUTING', 'DELIVERING']);

/**
 * What a piece reads as when the caller supplied no tier for it.
 *
 * The weakest one, deliberately. A caller that forgot to compose a tier must
 * not have its pieces treated as qualified by default — deny by default, at a
 * projection.
 */
const UNREAD_TIER: TierReading = Object.freeze({
  tier: 'SIGNAL' as const,
  establishes: 'something was recorded here',
  doesNotEstablish: 'anything about it, because no reading was composed',
  toAdvance: [],
  answered: 0,
  required: 0,
  summary: 'Nothing has been read about this piece yet.',
});

export interface Placement {
  opportunity: CashOpportunity;
  disposition: CashDisposition;
  /** What decided it, naming the thing being waited on when something is. */
  because: string;
  /** The load-bearing card fields still unknown, if any. */
  missing: string[];
  /**
   * Whether this is evidence, a capture thesis, a qualified opportunity or
   * something ready to test — and what is still open before the next one.
   *
   * Passed in rather than derived here because it reads the engine card, which
   * needs the recorded facts; `cashView` composes those once for the whole
   * project. Everything that shows a piece to a person reads this one answer,
   * which is what stops the page, the review and the ranking disagreeing about
   * whether something is an opportunity at all.
   */
  tier: TierReading;
}

export interface PortfolioInput {
  opportunities: CashOpportunity[];
  /** The tier reading per opportunity id, composed once by the caller. */
  tiers: Record<string, TierReading>;
  /** Cash that may actually be committed, in cents. Negative is a shortfall. */
  deployableCents: number;
  /** How many may execute at once, from the live commercial grant. */
  maxConcurrent: number;
  /** Whether new discovery is allowed — the cash mode's own state. */
  discoveryOpen: boolean;
}

/**
 * Where each piece stands, and what each one is waiting for.
 *
 * Every answer names something: another opportunity, the funding, the capacity,
 * or the unknown on the card. "Waiting" with nothing named is the state §24
 * calls stuck rather than waiting, and it is not one of the answers here.
 */
export function placements(input: PortfolioInput): Placement[] {
  const byId = new Map(input.opportunities.map((o) => [o.id, o]));
  const inFlight = input.opportunities.filter((o) => IN_FLIGHT.has(o.state));
  const headroom = Math.max(0, input.maxConcurrent - inFlight.length);

  // Ready pieces compete for the headroom in rank order, so which of them is
  // told to wait is a property of the ranking rather than of insertion order.
  const ranked = rank(input.opportunities, input.tiers);
  const startable = new Set<string>();
  let remaining = headroom;
  for (const candidate of ranked) {
    if (candidate.state !== 'READY') continue;
    if (remaining <= 0) break;
    startable.add(candidate.id);
    remaining -= 1;
  }

  return ranked.map((opportunity) => {
    const card = evidenceCard(opportunity);
    const missing = card.readiness.missing.map(String);
    const tier = input.tiers[opportunity.id] ?? UNREAD_TIER;

    if (opportunity.state === 'ARCHIVED') {
      return {
        opportunity,
        disposition: 'ARCHIVED' as const,
        because: opportunity.archivedReason ?? 'This was stopped.',
        missing,
        tier,
      };
    }
    if (opportunity.state === 'DECLINED') {
      return {
        opportunity,
        disposition: 'ARCHIVED' as const,
        because:
          opportunity.declinedReason ??
          'This owner passed on it. It can be offered privately to somebody else.',
        missing,
        tier,
      };
    }

    if (IN_FLIGHT.has(opportunity.state) || opportunity.state === 'COLLECTED') {
      return {
        opportunity,
        disposition: 'EXECUTE_NOW' as const,
        because:
          opportunity.state === 'COLLECTED'
            ? 'The money is in. What is left is recording the settlement and the contribution.'
            : 'This is already under way.',
        missing,
        tier,
      };
    }

    const blocker = dependencyBlocker(opportunity, byId);
    if (blocker) {
      return {
        opportunity,
        disposition: 'WAIT_FOR_DEPENDENCY' as const,
        because: blocker,
        missing,
        tier,
      };
    }

    if (!card.readiness.ready) {
      return {
        opportunity,
        disposition: 'TEST_A_DECISIVE_UNKNOWN' as const,
        /*
         * The tier's sentence below qualified, and the card's above it.
         *
         * A piece with no capture thesis is not a test waiting on an unknown;
         * it is evidence, and saying "four things on this card are unknown"
         * about a published price list invites somebody to go and fill them in
         * — which is the homework this whole correction exists to stop
         * handing out. The disposition vocabulary is closed and is stored
         * nowhere, so what changes is the sentence rather than the enum.
         */
        because:
          tier.tier === 'SIGNAL' || tier.tier === 'CANDIDATE'
            ? tier.summary
            : card.readiness.summary,
        missing,
        tier,
      };
    }

    // Ready. The only things that can hold it now are money and capacity, and
    // both name themselves.
    const needed = opportunity.peakFundingCents ?? 0;
    if (needed > input.deployableCents) {
      return {
        opportunity,
        disposition: 'WAIT_FOR_DEPENDENCY' as const,
        because:
          `This needs ${needed} cents before the money comes back and ${input.deployableCents} ` +
          'is deployable, so it waits on cash rather than on evidence.',
        missing,
        tier,
      };
    }
    if (!startable.has(opportunity.id)) {
      return {
        opportunity,
        disposition: 'WAIT_FOR_DEPENDENCY' as const,
        because:
          `${inFlight.length} of ${input.maxConcurrent} execution slots are taken, so this waits ` +
          'on fulfilment capacity. Nothing about the opportunity itself is unresolved.',
        missing,
        tier,
      };
    }
    return {
      opportunity,
      disposition: inFlight.length > 0 ? ('RUN_IN_PARALLEL' as const) : ('EXECUTE_NOW' as const),
      because:
        inFlight.length > 0
          ? 'Nothing this depends on is in flight, and there is capacity for it alongside what ' +
            'is already running.'
          : input.discoveryOpen
            ? 'Payer, offer, delivery and exposure are all answered, and nothing is in its way.'
            : 'Payer, offer, delivery and exposure are all answered. Discovery is wound down; ' +
              'this piece is already in the portfolio and keeps running.',
      missing,
      tier,
    };
  });
}

function dependencyBlocker(
  opportunity: CashOpportunity,
  byId: Map<string, CashOpportunity>,
): string | null {
  if (!opportunity.dependsOnId) return null;
  const parent = byId.get(opportunity.dependsOnId);
  if (!parent) {
    return 'This names a dependency that is not in this portfolio, so nothing can say whether it is settled.';
  }
  if (parent.state === 'COLLECTED') return null;
  if (parent.state === 'ARCHIVED' || parent.state === 'DECLINED') {
    return `"${parent.title}" is ${parent.state.toLowerCase()}, so the funding this waited on is not coming.`;
  }
  return `This waits on "${parent.title}", which has not collected yet.`;
}

/**
 * The plan's five criteria, in the plan's order, as a lexicographic sort.
 *
 * 1. buying evidence and reach;
 * 2. credible time to usable cash;
 * 3. conservative contribution;
 * 4. cash required before settlement, then human effort;
 * 5. expiry.
 *
 * Deterministic to the last comparison — `createdAt` then `id` — so two reads of
 * an unchanged portfolio produce the same order. A ranking that shuffled
 * equivalents would make "why did this move" unanswerable.
 */
export function rank(
  opportunities: CashOpportunity[],
  tiers: Record<string, TierReading> = {},
): CashOpportunity[] {
  const tierOf = (o: CashOpportunity): CashTier => tiers[o.id]?.tier ?? 'SIGNAL';
  return [...opportunities].sort((a, b) => {
    /*
     * How far it has actually got, first.
     *
     * Ahead of every other criterion because the criteria below are about
     * *which* opportunity to take, and a signal is not one: ranking a vendor's
     * published price list against a qualified opening on time-to-cash is
     * comparing two different kinds of thing and letting the one with fewer
     * facts on it win whenever a blank happens to sort well.
     */
    const stage = tierRank(tierOf(b)) - tierRank(tierOf(a));
    if (stage !== 0) return stage;

    /*
     * Among qualified pieces, what an hour of somebody's time is worth here.
     *
     * §30 asks for manual gig work not to rank among the best merely because
     * it pays, and refuses a hard-coded automation percentage. This is the
     * honest form of that: contribution divided by the hours comparable work
     * is published as taking. Work that a person does by hand carries its
     * hours and falls; work that software or a subcontractor does carries few
     * and rises. Nothing is read from anybody's prose, no automation is
     * scored, and an unknown never helps — a missing contribution is zero and
     * missing hours make this incomparable, so both sort last.
     */
    const perHour = contributionPerHour(b) - contributionPerHour(a);
    if (perHour !== 0) return perHour;

    const evidence = evidenceStrength(b) - evidenceStrength(a);
    if (evidence !== 0) return evidence;

    const timing = compareDates(a.deadline, b.deadline);
    if (timing !== 0) return timing;

    const contribution = conservativeContribution(b) - conservativeContribution(a);
    if (contribution !== 0) return contribution;

    const exposure = worstIfUnknown(a.peakFundingCents) - worstIfUnknown(b.peakFundingCents);
    if (exposure !== 0) return exposure;

    const effort = worstIfUnknown(a.humanHours) - worstIfUnknown(b.humanHours);
    if (effort !== 0) return effort;

    const expiry = compareDates(a.expiresAt, b.expiresAt);
    if (expiry !== 0) return expiry;

    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Two observable facts, never a judgement about how convincing they are. */
function evidenceStrength(o: CashOpportunity): number {
  let strength = 0;
  if ((o.buyingSignal ?? '').trim() && (o.signalObservedAt ?? '').trim()) strength += 1;
  if ((o.reachableChannel ?? '').trim()) strength += 1;
  return strength;
}

/**
 * Price minus the cash that has to go out first — and zero when **either** is
 * unknown.
 *
 * The second half is the one that matters and it was wrong first: treating an
 * unknown exposure as zero makes the contribution come out as the whole price,
 * so a piece nobody had costed ranked *above* an identically priced one
 * somebody had. That is the silent favourable assumption §3 forbids, arriving
 * through the ranking rather than through the card — a blank cannot be the
 * reason something rises.
 */
function conservativeContribution(o: CashOpportunity): number {
  if (o.priceCents === null || o.peakFundingCents === null) return 0;
  return o.priceCents - o.peakFundingCents;
}

/** Sooner first; a missing date sorts last rather than first. */
function compareDates(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * Contribution per published hour, and zero wherever either side is unknown.
 *
 * Zero rather than a small number, so a piece with no hours recorded cannot
 * out-rank one that has them: an unknown is never the reason something rises.
 */
function contributionPerHour(o: CashOpportunity): number {
  const contribution = conservativeContribution(o);
  if (contribution <= 0) return 0;
  if (o.humanHours === null || o.humanHours <= 0) return 0;
  return contribution / o.humanHours;
}

/** An unknown number is the worst value, never the best. */
function worstIfUnknown(value: number | null): number {
  return value === null ? Number.MAX_SAFE_INTEGER : value;
}

export interface AssembledPlan {
  placements: Placement[];
  /**
   * How many pieces are at each tier, for the one line a first screen shows.
   *
   * Counted from the same placements the rest of the page renders, so the
   * summary and the list can never disagree — §29's rule that a status
   * contradicting the control beside it is worse than no status.
   */
  byTier: Record<CashTier, number>;
  /**
   * The few worth putting in front of a person, in rank order.
   *
   * Qualified first, and where there are none, the candidates closest to it —
   * which is the honest answer to "show me the best" on a sprint that has not
   * qualified anything yet. It is never filled up with signals: a page that
   * pads a best-opportunities section with raw market evidence is the defect
   * this whole correction is about.
   */
  best: Placement[];
  /** True when `best` holds candidates rather than qualified openings. */
  bestAreNearlyQualified: boolean;
  /** The pieces a person should act on now, in rank order. */
  executeNow: Placement[];
  /** What is waiting, and on what. */
  waiting: Placement[];
  /** Total conservative contribution of everything not archived, in cents. */
  combinedContributionCents: number;
  /** Peak funding of everything that would be running at once, in cents. */
  peakFundingCents: number;
}

/**
 * The whole portfolio, assembled rather than ranked and handed back.
 *
 * §2 asks for this in as many words: do not stop at ranking ideas and asking
 * the user to choose one. The combined contribution is the arithmetic sum of
 * what the live pieces would produce — an illustration built from quoted
 * prices, kept apart from the bank balance, and never added to it.
 */
export const BEST_SHOWN = 5;

export function assemble(input: PortfolioInput): AssembledPlan {
  const all = placements(input);
  const live = all.filter((p) => p.disposition !== 'ARCHIVED');

  const byTier: Record<CashTier, number> = {
    SIGNAL: 0,
    CANDIDATE: 0,
    QUALIFIED: 0,
    READY_TO_TEST: 0,
  };
  for (const placement of live) byTier[placement.tier.tier] += 1;

  const qualified = live.filter(
    (p) => p.tier.tier === 'QUALIFIED' || p.tier.tier === 'READY_TO_TEST',
  );
  /*
   * Nearly qualified is a count, not a feeling: the candidates with the fewest
   * questions left. `answered` and `required` are both counts of rows, so the
   * ordering is a measurement rather than a view about which looks promising.
   */
  const nearly = live
    .filter((p) => p.tier.tier === 'CANDIDATE')
    .sort((a, b) => a.tier.toAdvance.length - b.tier.toAdvance.length);
  const best = qualified.length > 0 ? qualified : nearly;

  return {
    placements: all,
    byTier,
    best: best.slice(0, BEST_SHOWN),
    bestAreNearlyQualified: qualified.length === 0 && nearly.length > 0,
    executeNow: live.filter(
      (p) => p.disposition === 'EXECUTE_NOW' || p.disposition === 'RUN_IN_PARALLEL',
    ),
    waiting: live.filter(
      (p) => p.disposition === 'WAIT_FOR_DEPENDENCY' || p.disposition === 'TEST_A_DECISIVE_UNKNOWN',
    ),
    combinedContributionCents: live.reduce(
      (total, p) => total + conservativeContribution(p.opportunity),
      0,
    ),
    peakFundingCents: live
      .filter((p) => p.disposition === 'EXECUTE_NOW' || p.disposition === 'RUN_IN_PARALLEL')
      .reduce((total, p) => total + (p.opportunity.peakFundingCents ?? 0), 0),
  };
}
