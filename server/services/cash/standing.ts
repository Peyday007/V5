/**
 * Standing: one explained answer per opportunity (OPPORTUNITY-INTELLIGENCE §3.1).
 *
 * The state is stored, the tier, the placement and the dive refusal are each
 * derived somewhere else, and none of them alone answers the question a person
 * asks about a piece: *is this moving, and if not, on what?* `standingFor`
 * composes them into one of five answers —
 *
 *   * `ADVANCING` — something is being done about it now, and what;
 *   * `WAITING` — named facts, a slot or cash stand in its way;
 *   * `DORMANT` — stopped, with the conditions that would reopen it;
 *   * `NOT_WORTH_PURSUING` — stopped, with nothing that could reopen it;
 *   * `DONE` — the money is in.
 *
 * — with a sentence the server composes, as placement already does. Every
 * input is a row or a reading of rows, and **nothing about standing is stored
 * as state**: `recordStandingChanges` appends a `CASH_OPPORTUNITY_STANDING`
 * event only when the kind or the blocker set changed, so the events are the
 * per-opportunity history the brief asks for and the answer itself is always
 * re-derived. That is the monetization movement pattern (`monetization/movement.ts`)
 * applied to opportunities.
 *
 * Reconsideration is not readiness. Nothing here moves a state, and a standing
 * of ADVANCING is a description of where a piece is, never permission for it
 * to be anywhere else.
 */
import { getDb } from '../../db/database.ts';
import { cashNow, getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { listNeeds, listOpportunities } from '../../repos/cashPortfolio.ts';
import { reopenConditionsForProject } from '../../repos/cashReconsideration.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { serializeCash } from '../../repos/cashLock.ts';
import { parseJson } from '../../repos/util.ts';
import { blockerKindOf, formatBlockerKey } from '../../domain/types.ts';
import type {
  BlockerKey,
  CashCardFact,
  CashEventRow,
  CashNeed,
  CashOpportunity,
  CashReopenCondition,
  DormantCause,
  Standing,
  StandingWait,
} from '../../domain/types.ts';
import { evidenceCard } from './card.ts';
import { cashEngineCard } from './engineCard.ts';
import { cashTier } from './tier.ts';
import { assemble } from './portfolio.ts';
import { sprintCanRefine, whyNotDiving } from './validation.ts';
import { cashPosition } from './money.ts';
import { authorityFor } from './opportunities.ts';
import type { Placement } from './portfolio.ts';
import type { DiveRefusal } from './validation.ts';
import type { TierReading } from './tier.ts';

export const STANDING_EVENT = 'CASH_OPPORTUNITY_STANDING';

/**
 * Whether the sprint can start a deep dive right now, as one reading.
 *
 * `FREE` and `FULL` are capacity; `CLOSED` is the sprint itself not starting
 * dives (wound down, or no research grant), with the reason. Unknown when the
 * caller did not read it, which is read as FREE — the placement and dive
 * refusal are still honest, and a piece is never told it waits on a slot
 * nobody counted.
 */
export type DiveRoom =
  | { kind: 'FREE' }
  | { kind: 'FULL'; inFlight: number; cap: number }
  | { kind: 'CLOSED'; reason: string };

export interface StandingInput {
  opportunity: CashOpportunity;
  tier: TierReading;
  /** The piece's placement, where one was composed. */
  placement: Pick<Placement, 'disposition' | 'because' | 'missing' | 'waitsOn'> | null;
  /** `whyNotDiving`, for a piece in DISCOVERED or EVIDENCE_CARD. */
  dive: DiveRefusal | null;
  /** This piece's OPEN needs. */
  needs: readonly CashNeed[];
  /** Every reopen condition this piece holds, triggered ones included. */
  reopenConditions: readonly CashReopenCondition[];
  diveRoom?: DiveRoom;
}

/** States in which the commercial questions are still being asked. */
const EVALUATING = new Set(['DISCOVERED', 'EVIDENCE_CARD']);
/** The tiers at which a piece is a person's work rather than Brain's. */
const WORKABLE = new Set(['QUALIFIED', 'READY_TO_TEST']);
/**
 * Blocker kinds that are Brain's own research. A need keyed by one of these is
 * Brain establishing something, not something standing in Brain's way, so it
 * does not by itself make a piece WAITING.
 */
const RESEARCH_KINDS = new Set(['FIELD', 'EVIDENCE']);

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

/**
 * One piece's standing, from rows. Pure and total.
 *
 * The order is the order in which the facts dominate: a finished piece is
 * done; a stopped piece is dormant or not worth pursuing; a duplicate defers to
 * its survivor; a derived dead end (disqualified, both dives spent, closed) is
 * dormant; a named blocker outside Brain's own research makes it wait; and only
 * then does the placement say what is happening.
 */
export function standingFor(input: StandingInput): Standing {
  const { opportunity, tier, placement, dive } = input;
  const live = input.reopenConditions.filter((one) => one.triggeredAt === null);
  const triggered = input.reopenConditions.some((one) => one.triggeredAt !== null);

  if (opportunity.state === 'COLLECTED') {
    return {
      kind: 'DONE',
      outcome: opportunity.outcome,
      because: opportunity.outcome
        ? `The money is in. ${opportunity.outcome}`
        : 'The money is in and the delivery is done.',
    };
  }

  if (opportunity.state === 'ARCHIVED' || opportunity.state === 'DECLINED') {
    const cause: DormantCause = opportunity.state;
    const reason =
      cause === 'ARCHIVED'
        ? (opportunity.archivedReason ?? 'This was stopped.')
        : (opportunity.declinedReason ?? 'This owner passed on it.');
    return dormancy({ cause, reason, live, triggered, personsDecision: true });
  }

  if (opportunity.duplicateOfId && EVALUATING.has(opportunity.state)) {
    return {
      kind: 'NOT_WORTH_PURSUING',
      cause: 'DUPLICATE',
      because:
        `This is a second record of ${opportunity.duplicateOfId}; that one is pursued instead. ` +
        'It is released by itself if that record is archived.',
    };
  }

  if (EVALUATING.has(opportunity.state) && !WORKABLE.has(tier.tier) && dive) {
    if (dive.kind === 'DISQUALIFIED') {
      return dormancy({
        cause: 'DISQUALIFIED',
        reason: `A published fact rules it out: ${dive.reason}`,
        live,
        triggered,
        personsDecision: false,
      });
    }
    if (dive.kind === 'EPOCH_SPENT') {
      return dormancy({
        cause: 'ROUNDS_SPENT',
        reason:
          `The bounded deep dives this epoch are spent (${dive.rounds}/${dive.cap}) and it is ` +
          `still ${tier.tier.toLowerCase()}.`,
        live,
        triggered,
        personsDecision: false,
      });
    }
    if (dive.kind === 'STAGE_ONE_FAILED') {
      // A failed screen ends its epoch: the epoch's dives are spent on it, and
      // no full dive was. The reopen conditions say what would change that.
      return dormancy({
        cause: 'ROUNDS_SPENT',
        reason:
          'Its first-stage screen found no published source naming who would pay, so no full ' +
          'deep dive was spent on it.',
        live,
        triggered,
        personsDecision: false,
      });
    }
    if (dive.kind === 'EXPIRED') {
      return dormancy({
        cause: 'EXPIRED',
        reason: `It closed on ${dive.at}.`,
        live,
        triggered,
        personsDecision: false,
      });
    }
  }

  const blocking = sortedUnique(
    input.needs
      .filter((need) => need.state === 'OPEN' && need.blockerKey !== null)
      .map((need) => need.blockerKey as BlockerKey)
      .filter((key) => !RESEARCH_KINDS.has(blockerKindOf(key))),
  );
  if (blocking.length > 0) {
    return {
      kind: 'WAITING',
      on: blocking,
      because:
        blocking.length === 1
          ? `This is waiting on ${blocking[0]}, which nothing on this piece can supply by itself.`
          : `This is waiting on ${blocking.join(', ')}, none of which this piece can supply by itself.`,
    };
  }

  const reconsidered = opportunity.reconsiderRequestedAt
    ? ` A change asked for it to be looked at again on ${opportunity.reconsiderRequestedAt}.`
    : '';

  if (opportunity.state === 'EXECUTING' || opportunity.state === 'DELIVERING') {
    return {
      kind: 'ADVANCING',
      stage: opportunity.state,
      doing:
        opportunity.state === 'EXECUTING'
          ? 'The transaction is being pursued under the standing grant.'
          : 'What was agreed is being delivered.',
      next: opportunity.nextAction ?? 'Delivery, then collection and settlement.',
      because: 'This is already under way.' + reconsidered,
    };
  }

  switch (placement?.disposition) {
    case 'EXECUTE_NOW':
    case 'RUN_IN_PARALLEL':
      return {
        kind: 'ADVANCING',
        stage: opportunity.state,
        doing: 'Nothing is in its way; it can be started now.',
        next: opportunity.nextAction ?? 'Begin execution with a recorded first action.',
        because: placement.because + reconsidered,
      };
    case 'WAIT_FOR_DEPENDENCY': {
      const on: StandingWait[] =
        placement.waitsOn === 'DEPENDENCY' && opportunity.dependsOnId
          ? [formatBlockerKey('DEPENDENCY', opportunity.dependsOnId)]
          : placement.waitsOn === 'CASH'
            ? ['CASH']
            : ['SLOT'];
      return { kind: 'WAITING', on, because: placement.because };
    }
    case 'TEST_A_DECISIVE_UNKNOWN': {
      const on = sortedUnique(
        placement.missing.map((field) => formatBlockerKey('FIELD', field) as StandingWait),
      );
      return {
        kind: 'WAITING',
        on: on.length > 0 ? on : ['PERSON'],
        because: placement.because,
      };
    }
    default:
      break;
  }

  // Being qualified, or evidence: what the deep dive says.
  const stage = tier.tier;
  switch (dive?.kind) {
    case 'IN_FLIGHT':
      return {
        kind: 'ADVANCING',
        stage,
        doing: `A bounded deep dive is running (${dive.state}).`,
        next: 'Its answers land on the card; the tier is re-derived from them.',
        because: tier.summary + reconsidered,
      };
    case 'AWAITING_PERSON':
      return {
        kind: 'WAITING',
        on: ['PERSON'],
        because: 'Its deep dive stopped at a decision only a person can make.',
      };
    case 'NOTHING_PUBLISHED_TO_ASK_ABOUT':
      return {
        kind: 'WAITING',
        on: ['PERSON'],
        because:
          'Nothing published names a buying signal for it, so there is nothing for a deep dive ' +
          'to ask about. What moves it is a person filling in the card.',
      };
    case 'ELIGIBLE': {
      const room = input.diveRoom ?? { kind: 'FREE' as const };
      if (room.kind === 'FULL') {
        return {
          kind: 'WAITING',
          on: ['SLOT'],
          because:
            `It is eligible for a deep dive and all ${room.cap} dive slots are taken ` +
            `(${room.inFlight} in flight). Nothing about the piece itself is unresolved.`,
        };
      }
      if (room.kind === 'CLOSED') {
        return {
          kind: 'WAITING',
          on: ['PERSON'],
          because: `It is eligible for a deep dive, and the sprint is not starting any: ${room.reason}`,
        };
      }
      return {
        kind: 'ADVANCING',
        stage,
        doing: 'It is queued for the next bounded deep dive.',
        next: 'The dive asks who pays, what it costs and what would rule it out.',
        because: tier.summary + reconsidered,
      };
    }
    default:
      return {
        kind: 'ADVANCING',
        stage,
        doing: 'Brain is establishing what is still open on its card.',
        next:
          tier.toAdvance.length > 0
            ? `Next: ${tier.toAdvance[0]!.label}.`
            : 'Re-derive the tier from what was established.',
        because: tier.summary + reconsidered,
      };
  }
}

function dormancy(input: {
  cause: DormantCause;
  reason: string;
  live: readonly CashReopenCondition[];
  triggered: boolean;
  /** Whether stopping it was a person's decision (archive, decline). */
  personsDecision: boolean;
}): Standing {
  const reopenWhen = sortedUnique(input.live.map((one) => one.blockerKey));
  if (reopenWhen.length === 0 && !input.triggered) {
    return {
      kind: 'NOT_WORTH_PURSUING',
      cause: input.cause,
      because: `${input.reason} Nothing was named that would reopen it.`,
    };
  }
  const watching =
    reopenWhen.length > 0 ? ` It reopens for consideration when ${reopenWhen.join(', ')} changes.` : '';
  const requested = input.triggered
    ? input.personsDecision
      ? ' A condition named for it has changed, and whether to reconsider it is a person’s decision.'
      : ' A condition named for it has changed, and Brain re-evaluates it.'
    : '';
  return {
    kind: 'DORMANT',
    cause: input.cause,
    reopenWhen,
    reconsiderationRequested: input.triggered,
    because: `${input.reason}${watching}${requested}`,
  };
}

/**
 * The set a standing is compared by: its kind and what it waits on or would
 * reopen on. Two readings with the same signature are the same standing, and a
 * reworded sentence alone is not a change worth a history row.
 */
export function standingSignature(standing: Standing): string {
  const blockers =
    standing.kind === 'WAITING'
      ? standing.on
      : standing.kind === 'DORMANT'
        ? standing.reopenWhen
        : [];
  return `${standing.kind}|${sortedUnique(blockers as readonly string[]).join(',')}`;
}

/* --------------------------------------------------------------------------
 * The pass
 * ------------------------------------------------------------------------ */

/**
 * Everything `standingFor` needs for every piece in a project, read once.
 *
 * The same composition `cashView` performs — card facts read once, the tier per
 * piece, the placement — plus the open needs, the reopen conditions, the deep
 * dive's own refusal and the sprint's dive room.
 */
export async function projectStandings(
  projectId: string,
): Promise<Map<string, { opportunity: CashOpportunity; standing: Standing }>> {
  const out = new Map<string, { opportunity: CashOpportunity; standing: Standing }>();
  const { mode, authority } = await authorityFor(projectId);
  if (!mode) return out;

  const opportunities = await listOpportunities({ projectId });
  const facts = new Map<string, CashCardFact[]>();
  for (const fact of await cardFactsForProject(projectId)) {
    facts.set(fact.opportunityId, [...(facts.get(fact.opportunityId) ?? []), fact]);
  }
  const tiers: Record<string, TierReading> = {};
  for (const opportunity of opportunities) {
    tiers[opportunity.id] = cashTier({
      opportunity,
      card: cashEngineCard({ opportunity, facts: facts.get(opportunity.id) ?? [] }),
      readiness: evidenceCard(opportunity).readiness,
    });
  }

  const needs = new Map<string, CashNeed[]>();
  for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
    if (!need.opportunityId) continue;
    needs.set(need.opportunityId, [...(needs.get(need.opportunityId) ?? []), need]);
  }
  const conditions = new Map<string, CashReopenCondition[]>();
  for (const condition of await reopenConditionsForProject(projectId)) {
    conditions.set(condition.opportunityId, [
      ...(conditions.get(condition.opportunityId) ?? []),
      condition,
    ]);
  }
  const dives: Record<string, DiveRefusal> = {};
  for (const opportunity of opportunities) {
    if (!EVALUATING.has(opportunity.state)) continue;
    dives[opportunity.id] = await whyNotDiving(opportunity);
  }
  const sprint = await sprintCanRefine(projectId);
  const diveRoom: DiveRoom =
    sprint.kind === 'SLOTS_TAKEN'
      ? { kind: 'FULL', inFlight: sprint.inFlight, cap: sprint.cap }
      : sprint.kind === 'READY'
        ? { kind: 'FREE' }
        : {
            kind: 'CLOSED',
            reason:
              sprint.kind === 'WOUND_DOWN'
                ? sprint.reason
                : sprint.kind === 'NO_RESEARCH_AUTHORITY'
                  ? 'no research authority is live for this project'
                  : 'Cash Mode is not active here',
          };

  const position = await cashPosition({ projectId, currency: mode.currency });
  const plan = assemble({
    opportunities,
    tiers,
    deployableCents: position.deployableCents,
    maxConcurrent: authority?.maxConcurrent ?? 0,
    discoveryOpen: mode.state === 'ACTIVE',
    standingInputs: Object.fromEntries(
      opportunities.map((one) => [
        one.id,
        {
          dive: dives[one.id] ?? null,
          needs: needs.get(one.id) ?? [],
          reopenConditions: conditions.get(one.id) ?? [],
        },
      ]),
    ),
    diveRoom,
  });
  for (const placement of plan.placements) {
    out.set(placement.opportunity.id, {
      opportunity: placement.opportunity,
      standing: placement.standing,
    });
  }
  return out;
}

/**
 * The latest standing event per opportunity in one project.
 *
 * Two events for one piece can share a millisecond, and ids are random, so the
 * tiebreak is insertion order (`rowid`, which `dialect.ts` reads as `seq`).
 */
async function latestStandingEvents(projectId: string): Promise<Map<string, CashEventRow>> {
  const rows = await getDb().all<CashEventRow>(
    `SELECT e.* FROM cash_events e
      WHERE e.project_id = ? AND e.kind = ? AND e.opportunity_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM cash_events n
           WHERE n.opportunity_id = e.opportunity_id AND n.kind = e.kind
             AND (n.created_at > e.created_at OR (n.created_at = e.created_at AND n.rowid > e.rowid)))`,
    [projectId, STANDING_EVENT],
  );
  const out = new Map<string, CashEventRow>();
  for (const row of rows) if (row.opportunity_id) out.set(row.opportunity_id, row);
  return out;
}

export interface StandingChange {
  opportunityId: string;
  from: string | null;
  to: string;
  standing: Standing;
}

/**
 * Append a standing event for every piece whose standing changed, and only
 * those.
 *
 * Idempotent on replay: a second pass over unchanged rows compares equal and
 * writes nothing. The comparison and the writes run under the project's cash
 * lock, so two passes racing produce one event per change rather than two.
 * Nothing else is written — no state moves, no flag is set.
 */
export async function recordStandingChanges(projectId: string): Promise<StandingChange[]> {
  const mode = await getCashMode(projectId);
  if (!mode) return [];
  const standings = await projectStandings(projectId);
  if (standings.size === 0) return [];
  return serializeCash(projectId, mode.currency, async () => {
    const latest = await latestStandingEvents(projectId);
    const changes: StandingChange[] = [];
    for (const [opportunityId, { standing }] of standings) {
      const signature = standingSignature(standing);
      const previous = latest.get(opportunityId);
      const before = previous
        ? String(parseJson<Record<string, unknown>>(previous.detail, {})['signature'] ?? '')
        : null;
      if (before === signature) continue;
      await recordCashEvent({
        projectId,
        opportunityId,
        kind: STANDING_EVENT,
        actorRef: 'BRAIN',
        summary: `Standing: ${standing.kind.toLowerCase().replace(/_/g, ' ')}. ${standing.because}`,
        detail: {
          signature,
          previous: before,
          standing,
          derivedAt: cashNow(),
        },
      });
      changes.push({ opportunityId, from: before, to: signature, standing });
    }
    return changes;
  });
}
