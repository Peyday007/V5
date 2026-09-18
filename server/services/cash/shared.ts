/**
 * What every member of this Brain may read about the shared frontier.
 *
 * ---------------------------------------------------------------------------
 * Why this is a second projection rather than a filter over the first
 * ---------------------------------------------------------------------------
 *
 * `cashView` is the owner's view and answers *my money, my current work, what
 * Brain needs, decisions for me*. Handing it to everybody and stripping fields
 * on the way out is the shape of mistake this repository has already paid for
 * at three other boundaries: a `.filter()` one refactor away from a disclosure,
 * and a payload whose safety depends on somebody remembering that a new field
 * is private. §29 says it about search — a read that fetches broadly and
 * filters afterwards is one forgotten line from leaking — and the same is true
 * one level down about a field.
 *
 * So the shared view is **built from the columns it names**, and a field added
 * to `cash_opportunities` next month is absent from it until somebody writes it
 * in. The failure mode is a missing fact rather than a leaked one.
 *
 * ---------------------------------------------------------------------------
 * Where the line is, and why it is there
 * ---------------------------------------------------------------------------
 *
 * Shared, because it is evidence about the world or the machine's own progress:
 *
 *   * that an opportunity exists, what it is and what kind of opening it is;
 *   * the accepted claim it came from, its publisher's own dated signal, and
 *     the packet, fragment and round that established it — so a member can
 *     resolve any of it to a passage exactly as §10 requires;
 *   * how far qualification has got, counted, and which fields are still blank
 *     *by name* rather than by value;
 *   * whether it is available, being qualified, claimed or already executing —
 *     which is the one fact another member needs in order not to duplicate the
 *     work, and is why a taken opportunity is redacted rather than hidden;
 *   * where the research is up to, and what capabilities Brain is missing;
 *   * activity, aggregated by kind.
 *
 * Private to the job's owner, because it is somebody's execution or somebody's
 * money:
 *
 *   * every commercial term's **value** — the payer, the offer, the price, the
 *     acceptance condition, the delivery path, the terms;
 *   * every money figure, the ledger, the position, the forecast;
 *   * the commercial grant, its ceilings and what has been spent against it;
 *   * the next action, the notes, the outcome, the stop rule;
 *   * the decisions review, which is a list of things for one person to answer.
 *
 * The buying signal is on the shared side and the price is not, and that pair
 * is the rule in one line: *a signal is what a publisher said, and a price is
 * what this operation would charge.*
 *
 * ---------------------------------------------------------------------------
 * Aggregate activity, rather than prose
 * ---------------------------------------------------------------------------
 *
 * `cash_events.summary` is free text composed by whatever wrote the event, and
 * `detail` is an untyped bag. Deciding per sentence whether one of them names
 * money would be a filter over prose, which is the thing this file refuses to
 * be. So shared activity is what the plan actually asks for — *non-sensitive
 * aggregate activity* — a count per kind and the most recent timestamp for
 * each. No free text crosses at all.
 *
 * It writes nothing, enqueues nothing and moves no state.
 */
import { listCashEvents } from '../../repos/cashMode.ts';
import { listNeeds, listOpportunities } from '../../repos/cashPortfolio.ts';
import { evidenceCard } from './card.ts';
import { cashEngineCard } from './engineCard.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { CASH_TIERS, cashTier, type CashTier, type TierReading } from './tier.ts';
import { chooseBest, rank } from './portfolio.ts';
import { cashRoadmap, type CashRoadmap } from './roadmap.ts';
import { authorityFor } from './opportunities.ts';
import type {
  CashMechanism,
  CashMode,
  CashOpportunity,
  CashOpportunityState,
  OpportunityValidationState,
} from '../../domain/types.ts';

/**
 * Whether somebody else is already on this, in the fewest words that answer it.
 *
 * Derived from the opportunity's own state and from nothing about who owns it.
 * A member must be able to see that a piece is taken — otherwise two of them
 * research the same opening — and must not be able to see whose job it is or
 * what they are doing, which is the *minimal redacted state* the boundary asks
 * for rather than hiding its existence.
 */
export type SharedAvailability =
  | 'OPEN'
  | 'BEING_QUALIFIED'
  | 'CLAIMED'
  | 'IN_EXECUTION'
  | 'DELIVERED'
  | 'CLOSED';

function availabilityOf(state: CashOpportunityState): SharedAvailability {
  switch (state) {
    case 'DISCOVERED':
      return 'OPEN';
    case 'EVIDENCE_CARD':
      return 'BEING_QUALIFIED';
    case 'READY':
      return 'CLAIMED';
    case 'EXECUTING':
      return 'IN_EXECUTION';
    case 'DELIVERING':
    case 'COLLECTED':
      return 'DELIVERED';
    default:
      return 'CLOSED';
  }
}

/**
 * Why a piece is where it is, in words that cannot mention money.
 *
 * `placements()` answers the same question for the owner and is deliberately
 * **not** reused here, which is a correction worth recording rather than a
 * preference. Its money branch composes a sentence out of `deployableCents`, so
 * a shared caller would either have been handed the real balance or — as the
 * first version of this file did — handed a zero, which is worse: the page
 * would have stated, in Brain's own voice, that a qualified piece was waiting on
 * cash the operation might well have. A false figure is a worse leak than a true
 * one, because nobody can tell it is wrong.
 *
 * And a *disposition* is a recommendation to the job's owner rather than a fact
 * about the frontier, so the shared view carries none at all. What crosses is
 * where the piece is and what is holding it, and every branch below is derived
 * from the piece's own state, its dependency and its card.
 */
function sharedBecause(
  opportunity: CashOpportunity,
  byId: Map<string, CashOpportunity>,
  card: ReturnType<typeof evidenceCard>,
): string {
  if (opportunity.state === 'ARCHIVED') {
    return opportunity.archivedReason ?? 'This was stopped.';
  }
  if (opportunity.state === 'DECLINED') {
    return 'Somebody passed on this. It can be offered to somebody else.';
  }
  if (opportunity.state === 'COLLECTED') return 'The money for this is in.';
  if (opportunity.state === 'EXECUTING' || opportunity.state === 'DELIVERING') {
    return 'This is already under way.';
  }
  if (opportunity.dependsOnId) {
    const parent = byId.get(opportunity.dependsOnId);
    if (!parent) {
      return 'This names a dependency that is not in this portfolio, so nothing can say whether it is settled.';
    }
    if (parent.state !== 'COLLECTED') {
      return parent.state === 'ARCHIVED' || parent.state === 'DECLINED'
        ? `"${parent.title}" is ${parent.state.toLowerCase()}, so what this waited on is not coming.`
        : `This waits on "${parent.title}", which has not collected yet.`;
    }
  }
  if (!card.readiness.ready) return card.readiness.summary;
  return 'Every load-bearing question about this is answered. What happens to it next is a decision for whoever takes it on.';
}

export interface SharedOpportunity {
  id: string;
  title: string;
  mechanism: CashMechanism;
  industry: string | null;
  state: CashOpportunityState;
  availability: SharedAvailability;
  /**
   * What is holding it, in a sentence that cannot name a figure.
   *
   * See `sharedBecause`. The owner's `disposition` is deliberately absent: it is
   * a recommendation to whoever owns the job rather than a fact about the
   * frontier, and composing it needs the deployable balance.
   */
  because: string;
  validationState: OpportunityValidationState | null;
  /**
   * The publisher's own dated signal, and the claim it resolves to.
   *
   * Shared because it is accepted evidence: the claim carries the source URL,
   * the publisher and the passage, so a member can check it rather than take
   * Brain's word for it. That is §10 at a new reader.
   */
  buyingSignal: string | null;
  signalObservedAt: string | null;
  sourceClaimId: string | null;
  orchestrationId: string | null;
  fragmentId: string | null;
  discoveryRoundId: string | null;
  /** When the opening itself stops being an opening, if it does. */
  expiresAt: string | null;
  deadline: string | null;
  /**
   * How far qualification has got.
   *
   * `missing` names the fields that are still blank. The names are facts about
   * the machine's progress; the values are the job's, and none of them crosses.
   */
  qualification: { ready: boolean; missing: string[]; summary: string };
  /**
   * Where this piece stands: a signal, a candidate, a qualified opening, or
   * something ready to test.
   *
   * **This is not a widening of the boundary**, and it is worth saying why
   * rather than leaving it to be re-argued. A `TierReading` is `tier`, what the
   * underlying evidence establishes and does not establish, the requirements
   * still open as `{ key, label, task, owner }`, and two counts. Every one of
   * those is a *name* or a *count*; not one is the value of a commercial term.
   * It is exactly the "how far qualification has got, counted, and which fields
   * are still blank **by name** rather than by value" this file's own header
   * already declares shared — and `qualification.missing` has carried the same
   * kind of fact since the first version.
   *
   * It is here because the tier is what separates *evidence Brain found* from
   * *work somebody could do*, and a member reading the frontier without it is
   * reading thirty-one records with no way to tell those two apart. That is the
   * distinction §33 built `tier.ts` for; withholding it from the shared page
   * would leave the shared page with the defect that module exists to fix.
   */
  tier: TierReading;
}

/**
 * The shared frontier itself, without the envelope that says how it was asked for.
 *
 * Split out from `SharedCashView` so that the **owner's** view can carry the
 * identical block (`CashView.frontier`), produced by the identical function.
 * The two roles' shared sections then render from one object built by one
 * server derivation rather than from two shapes a client had to reconcile —
 * which is this repository's own recurring rule about two readers of one fact,
 * applied to a page instead of to a row.
 *
 * It is the narrow projection in both cases, so embedding it in the owner's
 * payload widens nothing: everything in here was already leaving the server for
 * every member of this Brain.
 */
export interface SharedFrontier {
  /** The sprint itself, minus anything a person decided about spending. */
  mode: {
    projectId: string;
    state: CashMode['state'];
    currency: string;
    activatedAt: string;
    objective: string;
  } | null;
  discovery: { open: boolean; reason: string };
  /**
   * Whether a commercial grant exists at all, and nothing about it.
   *
   * Shared because it is the reason nothing in the portfolio is executing, and
   * a member looking at thirty-one open pieces is owed that answer. Its
   * ceilings, its actions, what has been committed and what has been spent are
   * all the owner's.
   */
  commercialGrant: 'PRESENT' | 'ABSENT';
  opportunities: SharedOpportunity[];
  /**
   * How many pieces are at each tier.
   *
   * Counted from the same `opportunities` the page renders, so the summary and
   * the list can never disagree — §29's rule, and the same reason
   * `AssembledPlan.byTier` is counted from its own placements rather than
   * queried separately.
   */
  byTier: Record<CashTier, number>;
  /**
   * How many pieces are in each raw state.
   *
   * Beside `counts` rather than instead of it, because the two answer different
   * questions. `counts` is keyed on **availability**, which deliberately
   * collapses `DELIVERING` and `COLLECTED` into one word so that a member
   * cannot read how far somebody else's job has got. That collapse is right for
   * *is this taken* and wrong for *how many are executing*, and a page that
   * used one for the other would report a different number than it did before
   * without anybody choosing to change it.
   *
   * The state itself already crosses, uncollapsed, on every `SharedOpportunity`
   * — so counting them adds no fact, it only saves every reader deriving the
   * same tally and eventually deriving it differently.
   */
  byState: Record<CashOpportunityState, number>;
  counts: {
    total: number;
    open: number;
    beingQualified: number;
    claimed: number;
    inExecution: number;
    delivered: number;
    closed: number;
  };
  /** Where the research is up to. Counted from rows by `roadmap.ts`. */
  roadmap: CashRoadmap;
  /** Capability gaps, without what answering one would cost. */
  needs: {
    id: string;
    blockedAction: string;
    whyItMatters: string;
    recommendedPath: string;
    nextStep: string;
    occurrence: number;
  }[];
  /**
   * The few worth putting in front of somebody, in rank order, and whether they
   * are qualified or only the closest to it.
   *
   * Chosen by `chooseBest`, which is the **same function** the owner's
   * `assemble` uses, over the same tiers derived by the same `cashTier`. So the
   * two pages name the same openings as best, and a reader comparing them is
   * not comparing two rules. Nothing about the choice consults a balance: it
   * reads the tier and nothing else.
   */
  best: SharedOpportunity[];
  bestAreNearlyQualified: boolean;
  /** Brain's own activity, counted. No free text and no detail bag. */
  activity: { kind: string; count: number; mostRecentAt: string }[];
}

export type SharedCashView = { scope: 'SHARED' } & SharedFrontier;

export async function sharedCashView(input: { projectId: string }): Promise<SharedCashView> {
  return { scope: 'SHARED', ...(await sharedFrontier(input)) };
}

export async function sharedFrontier(input: { projectId: string }): Promise<SharedFrontier> {
  const { mode, authority } = await authorityFor(input.projectId);
  const opportunities = await listOpportunities({ projectId: input.projectId });
  const byId = new Map(opportunities.map((one) => [one.id, one]));

  /*
   * The recorded facts, read once, exactly as `cashView` reads them.
   *
   * The tier is derived from the engine card, and the engine card is composed
   * from these rows. Deriving it here rather than accepting a tier from
   * anywhere else is what keeps the two pages' answer to "is this an
   * opportunity" one answer — the whole reason `tier.ts` is a pure function
   * over a row and its card. **None of the values read here crosses**: what
   * leaves this function is the `TierReading`, which is names and counts.
   */
  const facts = new Map<string, Awaited<ReturnType<typeof cardFactsForProject>>>();
  for (const fact of await cardFactsForProject(input.projectId)) {
    facts.set(fact.opportunityId, [...(facts.get(fact.opportunityId) ?? []), fact]);
  }

  /*
   * The owner's own ranking, which is money-free: `rank` orders on buying
   * evidence, time to cash, conservative contribution, funding *required*,
   * effort and expiry — all properties of the piece rather than of the account.
   * So the two screens agree about which openings matter most without the
   * shared one being told what is in the bank.
   */
  const shared: SharedOpportunity[] = rank(opportunities).map((opportunity: CashOpportunity) => {
    const card = evidenceCard(opportunity);
    const tier = cashTier({
      opportunity,
      card: cashEngineCard({ opportunity, facts: facts.get(opportunity.id) ?? [] }),
      readiness: card.readiness,
    });
    return {
      id: opportunity.id,
      title: opportunity.title,
      mechanism: opportunity.mechanism,
      industry: opportunity.industry,
      state: opportunity.state,
      availability: availabilityOf(opportunity.state),
      because: sharedBecause(opportunity, byId, card),
      validationState: opportunity.validationState,
      buyingSignal: opportunity.buyingSignal,
      signalObservedAt: opportunity.signalObservedAt,
      sourceClaimId: opportunity.sourceClaimId,
      orchestrationId: opportunity.orchestrationId,
      fragmentId: opportunity.fragmentId,
      discoveryRoundId: opportunity.discoveryRoundId,
      expiresAt: opportunity.expiresAt,
      deadline: opportunity.deadline,
      qualification: {
        ready: card.readiness.ready,
        missing: card.readiness.missing.map(String),
        summary: card.readiness.summary,
      },
      tier,
    };
  });

  const count = (which: SharedAvailability): number =>
    shared.filter((one) => one.availability === which).length;

  const activity = new Map<string, { count: number; mostRecentAt: string }>();
  for (const event of await listCashEvents(input.projectId, 200)) {
    const seen = activity.get(event.kind);
    if (!seen) activity.set(event.kind, { count: 1, mostRecentAt: event.createdAt });
    else {
      seen.count += 1;
      if (event.createdAt > seen.mostRecentAt) seen.mostRecentAt = event.createdAt;
    }
  }

  const needs = await listNeeds({ projectId: input.projectId, states: ['OPEN'] });

  const discovery =
    mode === null
      ? {
          open: false,
          reason:
            'Cash Mode has not been activated. Activating it is what starts discovery; it ' +
            'spends nothing by itself.',
        }
      : mode.state === 'ACTIVE'
        ? { open: true, reason: 'Cash Mode is active.' }
        : {
            open: false,
            reason:
              `Cash Mode is ${mode.state.toLowerCase().replace('_', ' ')}, so no new discovery ` +
              'starts. Everything already in the portfolio keeps running.',
          };

  return {
    mode: mode
      ? {
          projectId: mode.projectId,
          state: mode.state,
          currency: mode.currency,
          activatedAt: mode.activatedAt,
          objective: mode.objective,
        }
      : null,
    discovery,
    commercialGrant: authority !== null ? 'PRESENT' : 'ABSENT',
    opportunities: shared,
    ...chooseBest(
      shared.filter((one) => one.state !== 'ARCHIVED' && one.state !== 'DECLINED'),
      (one) => one.tier,
    ),
    byState: shared.reduce(
      (out, one) => ({ ...out, [one.state]: (out[one.state] ?? 0) + 1 }),
      {
        DISCOVERED: 0,
        EVIDENCE_CARD: 0,
        READY: 0,
        EXECUTING: 0,
        DELIVERING: 0,
        COLLECTED: 0,
        DECLINED: 0,
        ARCHIVED: 0,
      } as Record<CashOpportunityState, number>,
    ),
    byTier: CASH_TIERS.reduce(
      (out, which) => ({ ...out, [which]: shared.filter((one) => one.tier.tier === which).length }),
      {} as Record<CashTier, number>,
    ),
    counts: {
      total: shared.length,
      open: count('OPEN'),
      beingQualified: count('BEING_QUALIFIED'),
      claimed: count('CLAIMED'),
      inExecution: count('IN_EXECUTION'),
      delivered: count('DELIVERED'),
      closed: count('CLOSED'),
    },
    roadmap: await cashRoadmap(input.projectId),
    needs: needs.map((need) => ({
      id: need.id,
      blockedAction: need.blockedAction,
      whyItMatters: need.whyItMatters,
      recommendedPath: need.recommendedPath,
      nextStep: need.nextStep,
      occurrence: need.occurrence,
    })),
    activity: [...activity.entries()]
      .map(([kind, one]) => ({ kind, count: one.count, mostRecentAt: one.mostRecentAt }))
      .sort((a, b) => (a.mostRecentAt < b.mostRecentAt ? 1 : -1)),
  };
}
