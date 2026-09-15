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
import { cashPosition, explainEntries } from './money.ts';
import { assemble } from './portfolio.ts';
import { compressedReview } from './review.ts';
import { authorityFor } from './opportunities.ts';
import type { CashCommitment, CashEvent, CashMode, CashNeed } from '../../domain/types.ts';
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
  };
  myCash: {
    position: CashPosition;
    entries: { entry: ReturnType<typeof explainEntries>[number]['entry']; effect: string }[];
    commitments: CashCommitment[];
  };
  myCurrentWork: AssembledPlan & {
    /** The load-bearing blanks per opportunity, so a card renders without a second call. */
    cards: Record<string, { ready: boolean; missing: string[]; summary: string }>;
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
    },
    myCash: {
      position,
      entries: explainEntries(
        await listMoneyEntries({ projectId: input.projectId, currency, limit: 50 }),
      ),
      commitments: await listCommitments(input.projectId),
    },
    myCurrentWork: { ...plan, cards },
    whatBrainHasDone: await listCashEvents(input.projectId, 40),
    whatBrainNeeds: needs,
    decisionsForMe: compressedReview({
      mode,
      authority,
      position,
      placements: plan.placements,
      needs,
      now,
    }),
  };
}
