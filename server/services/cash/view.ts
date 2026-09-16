/**
 * One person's private Cash section, derived in one place.
 *
 * §29's rule applied to a new surface: one projection answers every screen.
 * Progress, the money, the portfolio, what Brain did and what it needs all come
 * from here, so two surfaces cannot infer two different answers about the same
 * sprint — which is exactly what happens when a page composes its own summary.
 *
 * **Other people's operations do not appear, and they cannot.** Every read here
 * is bounded to one project in the query. The privacy boundary is the project
 * membership `decideProjectAccess` already enforces at the route, and a caller
 * who may not read the project gets the same 404 a missing one gives, in the
 * same words — so the *existence* of somebody else's sprint is not an oracle
 * either.
 *
 * It writes nothing.
 */
import { cashNow, listCashEvents } from '../../repos/cashMode.ts';
import { listMoneyEntries } from '../../repos/cashLedger.ts';
import { listCommitments } from '../../repos/cashAuthority.ts';
import { listNeeds, listOpportunities } from '../../repos/cashPortfolio.ts';
import { describeAuthority } from './authority.ts';
import { evidenceCard } from './card.ts';
import { assessResearch } from './answers.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { cashPosition, explainEntries } from './money.ts';
import { assemble } from './portfolio.ts';
import { executionPath, type ExecutionPath } from './execution.ts';
import { compressedReview } from './review.ts';
import { authorityFor } from './opportunities.ts';
import type {
  CashCardFact,
  CashCommitment,
  CashEvent,
  CashMode,
  CashNeed,
} from '../../domain/types.ts';
import type { AssembledPlan } from './portfolio.ts';
import type { CashPosition } from './money.ts';
import type { CompressedReview } from './review.ts';

export interface CashView {
  /** Null when the section has never been activated here. */
  mode: CashMode | null;
  /**
   * What the sprint is trying to produce and how long the outlook is. A
   * planning view; nothing reads `horizonDays` as an eligibility gate.
   */
  objective: string | null;
  /** Whether a *new* opportunity may be captured right now, and why not. */
  discovery: { open: boolean; reason: string };
  /** The commercial grant, as sentences the server composed. */
  authority: {
    exists: boolean;
    id: string | null;
    lines: string[];
    maxConcurrent: number;
    /** Held and spent so far, with no denominator where there is no ceiling. */
    heldCents: number;
    /**
     * The actions this grant actually permits.
     *
     * Sent so the screen that asks "what did you do" offers the things this
     * person authorized rather than the whole vocabulary — a control offering
     * an action the grant refuses is one that teaches somebody the refusal is
     * arbitrary. It decides nothing: `checkCommercialAuthority` is still asked
     * server-side about whatever arrives.
     */
    allowedActions: string[];
  };
  myCash: {
    position: CashPosition;
    entries: { entry: ReturnType<typeof explainEntries>[number]['entry']; effect: string }[];
    commitments: CashCommitment[];
  };
  myCurrentWork: AssembledPlan & {
    /**
     * The compiled instruction for each live piece, in dependency order.
     *
     * Sent with the plan rather than fetched per card, because a reader
     * deciding what to do today is asking about all of them at once, and
     * because it is derived — a second call would re-derive it against rows
     * that may already have moved.
     */
    executionPaths: ExecutionPath[];
    /** The load-bearing blanks per opportunity, so a card renders without a second call. */
    cards: Record<string, { ready: boolean; missing: string[]; summary: string }>;
    /**
     * Where each answered field came from, per opportunity.
     *
     * Sent so a screen can tell a published source from Brain's own proposal.
     * A card that rendered the two alike would have told somebody a guess was
     * checked, which is the one thing this section may not do — and the
     * distinction has to travel rather than be re-derived, because a client
     * deriving it would be a second opinion about one card.
     */
    provenance: Record<string, CashCardFact[]>;
  };
  whatBrainHasDone: CashEvent[];
  whatBrainNeeds: CashNeed[];
  decisionsForMe: CompressedReview;
}

export async function cashView(input: {
  projectId: string;
  now?: string;
}): Promise<CashView> {
  const now = input.now ?? cashNow();
  const { mode, authority } = await authorityFor(input.projectId);

  const opportunities = await listOpportunities({ projectId: input.projectId });
  /*
   * The **sprint's** currency, not the grant's.
   *
   * A grant can be withdrawn and replaced while the money history stays, so
   * taking the label from the grant would make the figures change currency when
   * a person changed their mind about a ceiling. The sprint is what the money
   * belongs to, and it is pinned at activation.
   */
  const currency = mode?.currency ?? 'USD';
  const position = await cashPosition({ projectId: input.projectId, currency });

  const plan = assemble({
    opportunities,
    deployableCents: position.deployableCents,
    // With no grant there is no authorized concurrency, which is the honest
    // answer rather than a default: the portfolio still assembles and every
    // ready piece reads as waiting on the one decision nobody has made.
    maxConcurrent: authority?.maxConcurrent ?? 0,
    discoveryOpen: mode?.state === 'ACTIVE',
  });

  const needs = await listNeeds({ projectId: input.projectId, states: ['OPEN'] });
  /*
   * Which needs the research is not going to answer on its own.
   *
   * A projection: it re-reads the missions and writes nothing, so the read path
   * says what is true now rather than what the last tick happened to record. A
   * need whose research is merely running stays out of the review, because that
   * is work in progress rather than a decision.
   */
  const stalled = (await assessResearch(input.projectId))
    .filter((one) => one.state !== 'ANSWERED' && one.state !== 'RUNNING')
    .map((one) => one.need.id);

  const provenance: CashView['myCurrentWork']['provenance'] = {};
  for (const fact of await cardFactsForProject(input.projectId)) {
    provenance[fact.opportunityId] = [...(provenance[fact.opportunityId] ?? []), fact];
  }

  const cards: CashView['myCurrentWork']['cards'] = {};
  for (const opportunity of opportunities) {
    const card = evidenceCard(opportunity);
    cards[opportunity.id] = {
      ready: card.readiness.ready,
      missing: card.readiness.missing.map(String),
      summary: card.readiness.summary,
    };
  }

  const discovery =
    mode === null
      ? {
          open: false,
          reason:
            'Cash Mode has not been activated for this project. Activating it is what starts ' +
            'discovery; it spends nothing by itself.',
        }
      : mode.state === 'ACTIVE'
        ? { open: true, reason: 'Cash Mode is active.' }
        : {
            open: false,
            reason:
              `Cash Mode is ${mode.state.toLowerCase().replace('_', ' ')} here, so no new ` +
              'discovery starts. Everything already in the portfolio keeps running.',
          };

  /*
   * The instruction for each piece that is actually being worked on, compiled
   * backwards from settled cash.
   *
   * Only the live ones. An execution path for an archived piece is a page
   * nobody reads, and for a piece still gathering evidence it would be a plan
   * built on blanks — `executionPath` would name every one of them, which is
   * honest and still not what a reader of *current work* is asking for.
   *
   * Derived here rather than stored, for `placements`' own reason: the moment a
   * need is answered or a price is established, a stored plan is a stale plan.
   */
  const executionPaths: ExecutionPath[] = [...plan.executeNow, ...plan.waiting].map((placement) =>
    executionPath(placement.opportunity, needs),
  );

  return {
    mode,
    objective: mode?.objective ?? null,
    discovery,
    authority: {
      exists: authority !== null,
      id: authority?.id ?? null,
      lines: authority ? describeAuthority(authority) : [],
      maxConcurrent: authority?.maxConcurrent ?? 0,
      heldCents: position.heldCommitmentsCents,
      allowedActions: authority?.allowedActions ?? [],
    },
    myCash: {
      position,
      entries: explainEntries(
        await listMoneyEntries({ projectId: input.projectId, currency, limit: 50 }),
      ),
      commitments: await listCommitments(input.projectId),
    },
    myCurrentWork: { ...plan, cards, provenance, executionPaths },
    whatBrainHasDone: await listCashEvents(input.projectId, 40),
    whatBrainNeeds: needs,
    decisionsForMe: compressedReview({
      mode,
      stalled,
      authority,
      position,
      placements: plan.placements,
      needs,
      now,
    }),
  };
}
