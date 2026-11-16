/**
 * The decision record, written from the deterministic screen.
 *
 * The screen (`screen.ts`) answers REJECT, HOLD or CLEAR from one goal's own
 * limits; this turns that into one current REJECT / HOLD / PRIORITIZE per
 * opportunity per goal, with the reason, the binding limit, the missing facts
 * and what would reopen it. It is recomputed only for a distinct change — a
 * changed goal limit, new evidence, a date passing — and a person's archive or
 * decline is never overwritten.
 *
 * This module owns which opening gets decided, and in what order. That makes
 * it the owner of "an opening closing soon went unpursued"
 * (ORIGINATED:MISSED_OPPORTUNITY:CLOSING), even when a gap report names
 * `lifecycle.ts`. `lifecycle.ts` turns the cash section on and winds it down.
 * It never reads, orders or decides an opening, so changing it could not get a
 * closing opening decided. The deadline order (`decisionOrder`) lives here,
 * beside the cap it competes for, and nothing else orders openings.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import {
  clearRecomputeRequest,
  currentDecision,
  decisionsAwaitingRecompute,
  recordDecision,
} from '../../repos/cashDecisions.ts';
import { reopenConditionFor, type CashDecision, type DecisionVerdict } from '../../domain/cashDecisions.ts';
import { screenOpportunity, type ScreenFacts, type ScreenLimits } from './screen.ts';
import { nowIso, parseJson } from '../../repos/util.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { getOpportunity, listOpportunities } from '../../repos/cashPortfolio.ts';
import { closingInstant, liveGoalLimits, screenFactsFor } from './worthResearching.ts';

/** States a person chose. Nothing here decides over them. */
const PERSON_STATES: ReadonlySet<string> = new Set(['ARCHIVED', 'DECLINED']);

export type DecideResult =
  | { status: 'RECORDED'; decision: CashDecision }
  | { status: 'UNCHANGED'; reason: 'SAME_CHANGE' }
  | { status: 'PERSON_DECIDED' }
  | { status: 'NO_SUCH_OPPORTUNITY' };

/** A deterministic ref for the goal's limits, so a changed limit is a distinct change. */
export function limitsChangeRef(goalId: string, limits: ScreenLimits): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([limits.metric, limits.daysLeft, limits.capitalCeilingCents, limits.capitalBeforeProofCents]))
    .digest('hex')
    .slice(0, 16);
  return `LIMITS:${goalId}@${digest}`;
}

/**
 * Decide one opportunity under one goal and make it current.
 *
 * `changeRef` must name the distinct change being decided for; the same ref
 * decides a pair once. `evidenceIds` are the ids the facts were read from.
 */
export async function decideOpportunity(input: {
  projectId: string;
  opportunityId: string;
  goalId: string;
  facts: ScreenFacts;
  limits: ScreenLimits;
  changeRef: string;
  evidenceIds?: string[];
  now?: string;
}): Promise<DecideResult> {
  const now = input.now ?? nowIso();
  const piece = await getDb().get<{ state: string }>(
    'SELECT state FROM cash_opportunities WHERE id = ? AND project_id = ?',
    [input.opportunityId, input.projectId],
  );
  if (!piece) return { status: 'NO_SUCH_OPPORTUNITY' };
  if (PERSON_STATES.has(piece.state)) return { status: 'PERSON_DECIDED' };

  const screen = screenOpportunity(input.facts, input.limits, now);
  let verdict: DecisionVerdict;
  let reason: string;
  let bindingConstraint: string | null = null;
  let missing: string[] = [];
  let detail = screen.detail;
  if (screen.verdict === 'REJECT') {
    verdict = 'REJECT';
    reason = screen.reason;
    bindingConstraint = screen.limit;
  } else if (screen.verdict === 'HOLD') {
    verdict = 'HOLD';
    reason = screen.reason;
    missing = screen.missing;
    if (screen.question) detail = `${detail}. ${screen.question}`;
  } else {
    verdict = 'PRIORITIZE';
    reason = 'CLEAR';
  }

  const recorded = await recordDecision({
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    goalId: input.goalId,
    verdict,
    reason,
    detail,
    bindingConstraint,
    missingFacts: missing,
    evidenceIds: input.evidenceIds ?? [],
    reopenCondition: reopenConditionFor(reason),
    changeRef: input.changeRef,
    at: now,
  });
  if (!recorded) return { status: 'UNCHANGED', reason: 'SAME_CHANGE' };
  return { status: 'RECORDED', decision: (await currentDecision(input.opportunityId, input.goalId))! };
}

export interface RecomputeLoaders {
  /** The goal's limits now, or null when the goal no longer has a readable target. */
  limitsFor(goalId: string): Promise<ScreenLimits | null>;
  /** The facts about this opportunity now, or null when they cannot be read. */
  factsFor(opportunityId: string): Promise<{ facts: ScreenFacts; evidenceIds?: string[] } | null>;
}

/**
 * Recompute every current decision a reconsideration flagged, once per change.
 * A decision whose inputs cannot be read stays flagged for the next pass; one
 * that produces nothing new is released.
 */
export async function recomputeFlaggedDecisions(
  projectId: string,
  loaders: RecomputeLoaders,
  options: { now?: string } = {},
): Promise<{ recomputed: number; released: number; deferred: number }> {
  const out = { recomputed: 0, released: 0, deferred: 0 };
  for (const flagged of await decisionsAwaitingRecompute(projectId)) {
    const limits = await loaders.limitsFor(flagged.goalId);
    const facts = await loaders.factsFor(flagged.opportunityId);
    if (!limits || !facts || !flagged.recomputeChangeRef) {
      out.deferred += 1;
      continue;
    }
    const result = await decideOpportunity({
      projectId,
      opportunityId: flagged.opportunityId,
      goalId: flagged.goalId,
      facts: facts.facts,
      limits,
      changeRef: flagged.recomputeChangeRef,
      ...(facts.evidenceIds ? { evidenceIds: facts.evidenceIds } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    if (result.status === 'RECORDED') {
      out.recomputed += 1;
    } else {
      await clearRecomputeRequest(flagged.id);
      out.released += 1;
    }
  }
  return out;
}


/**
 * The one decision a reader tells when a piece has several, one per goal.
 *
 * It mirrors the research gate: a piece is rejected only when every goal that
 * decided it rejected it, because an opening that serves one goal is worth
 * pursuing. Otherwise a PRIORITIZE under any goal wins over a HOLD, and the
 * earliest decision breaks a tie. Pure.
 */
export function standingDecision(decisions: readonly CashDecision[]): CashDecision | null {
  const current = decisions.filter((one) => one.isCurrent);
  if (current.length === 0) return null;
  if (current.every((one) => one.verdict === 'REJECT')) return current[0]!;
  return current.find((one) => one.verdict === 'PRIORITIZE') ?? current.find((one) => one.verdict === 'HOLD') ?? current[0]!;
}


/** Openings the screen still has a say over: not yet worked, not decided by a person. */
const DECIDABLE_STATES = ['DISCOVERED', 'EVIDENCE_CARD', 'READY'] as const;

/** A ref for what the opening's own row establishes, so new facts are a distinct change. */
export function factsChangeRef(facts: ScreenFacts): string {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16);
}

/**
 * How many goal-opening pairs one production decision pass considers
 * (`operate.ts` calls `decideOpenings` without a `limit`). Exported so the
 * failure-class test drives the cap production runs, not an artificial one.
 */
export const DECISION_PASS_LIMIT = 500;

/**
 * The row that a decision pass reached its cap and left decidable openings for
 * a later tick. Without it nobody could say whether the production cap ever
 * binds (review finding R3-F2): `pastCap` lived only in a tick's return value.
 * Recorded when the counts change, so an unchanged backlog writes nothing new.
 */
export const DECISION_CAP_EVENT = 'CASH_DECISION_CAP_REACHED';

/** Most dated openings left past the cap that one cap row names. */
const CAP_EVENT_SAMPLE = 20;

/** Every this-many-th place in `decisionOrder` is reserved for an undated opening while any remain. */
export const UNDATED_RESERVED_EVERY = 4;

/**
 * The order `decideOpenings` walks decidable openings in, before its cap:
 * Earliest Deadline First (§90, the `diveOrder` precedent in validation.ts).
 *
 * Production, 2026-11-16 (ORIGINATED:MISSED_OPPORTUNITY:CLOSING): openings
 * closing within five days (the PRPA RFP 26-152-P, JPFans closing 2026-11-20)
 * stayed unpursued. The producer walked `listOpportunities` newest first and
 * stopped at `limit` goal-opening pairs, with every unchanged pair still using
 * up the cap, so an older opening with a recorded close a few days away sat
 * past the cap on every tick. It never got a decision, and the lifecycle had
 * nothing to PRIORITIZE it on before its window ended.
 *
 * Openings with a recorded close still in the future are taken earliest
 * first. Undated openings, unreadable dates and closes already passed are
 * taken in the order they arrived (newest first, as `listOpportunities`
 * returns them). No gate, verdict rule, limit or evidence bar moves: only
 * which openings take the capped slots first. Pure and stable.
 *
 * Pure EDF would let enough dated openings starve every undated one, new
 * ones included: the old starvation turned the other way round (review
 * finding F2). So the undated openings get a reserved share of the order
 * (temporal isolation, the remedy Buttazzo gives for EDF under overload):
 * every `UNDATED_RESERVED_EVERY`-th place goes to the next undated opening
 * while any remain. Under any cap of k openings, at least
 * floor(k / UNDATED_RESERVED_EVERY) undated openings are decided in arrival
 * order, and the dated ones still get the rest, earliest close first. When
 * one of the two queues runs out, the other fills the remaining places.
 */
export function decisionOrder<T extends { expiresAt: string | null }>(openings: readonly T[], now: string): T[] {
  const at = Date.parse(now);
  const deadline = (opening: T): number | null => {
    const closes = closingInstant(opening.expiresAt);
    return closes !== null && closes > at ? closes : null;
  };
  const ranked = openings.map((opening, index) => ({ opening, index, closes: deadline(opening) }));
  const dated = ranked
    .filter((one): one is { opening: T; index: number; closes: number } => one.closes !== null)
    .sort((a, b) => a.closes - b.closes || a.index - b.index)
    .map((one) => one.opening);
  const undated = ranked.filter((one) => one.closes === null).map((one) => one.opening);
  return reserveUndated(dated, undated, UNDATED_RESERVED_EVERY);
}

/**
 * Merge an earliest-deadline-first queue with an undated one, giving every
 * `every`-th place to the next undated item while any remain (temporal
 * isolation, the remedy Buttazzo gives for EDF under overload). When one queue
 * runs out the other fills the rest. Both queues keep their own order. Pure.
 * Shared by `decisionOrder` and the READY contact order in operate.ts, so the
 * reservation that fixed review finding F2 cannot be lost one step downstream.
 */
export function reserveUndated<T>(dated: readonly T[], undated: readonly T[], every: number): T[] {
  const period = Math.max(1, Math.trunc(every));
  const out: T[] = [];
  let d = 0;
  let u = 0;
  while (d < dated.length || u < undated.length) {
    const reserved = (out.length + 1) % period === 0;
    if (u < undated.length && (reserved || d >= dated.length)) out.push(undated[u++]!);
    else out.push(dated[d++]!);
  }
  return out;
}

export interface DecideOpeningsPass {
  goals: number;
  considered: number;
  recorded: number;
  unchanged: number;
  byVerdict: Record<DecisionVerdict, number>;
  recompute: { recomputed: number; released: number; deferred: number };
  /**
   * Decidable openings the cap left for a later tick, by whether they carry a
   * future close. What the reservation in `decisionOrder` bounds, counted on
   * every pass, so starvation on either side shows up in the record.
   */
  pastCap: { dated: number; undated: number };
}

/**
 * Record that the cap bound, unless the latest cap row already says the same
 * thing (same cap, same counts left on each side). A production reading of
 * whether the cap binds, and which dated openings it left, rather than an
 * inference from a test's artificial cap.
 */
async function recordCapReached(
  projectId: string,
  reading: { limit: number; considered: number; decidable: number; pastCap: { dated: number; undated: number }; datedLeft: { id: string; expiresAt: string | null }[] },
): Promise<void> {
  const last = await getDb().get<{ detail: string | null }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [projectId, DECISION_CAP_EVENT],
  );
  if (last) {
    const prior = parseJson<{ limit?: unknown; pastCap?: { dated?: unknown; undated?: unknown } }>(last.detail, {});
    if (prior.limit === reading.limit && prior.pastCap?.dated === reading.pastCap.dated && prior.pastCap?.undated === reading.pastCap.undated) return;
  }
  await recordCashEvent({
    projectId,
    kind: DECISION_CAP_EVENT,
    actorRef: 'BRAIN',
    summary: `The decision pass reached its cap of ${reading.limit} goal-opening pairs and left ${reading.pastCap.dated} dated and ${reading.pastCap.undated} undated openings for a later tick.`,
    detail: { ...reading, pastCap: { ...reading.pastCap } },
  });
}

/**
 * The producer: every decidable opening, under every live goal with a target,
 * gets one current REJECT / HOLD / PRIORITIZE from the deterministic screen.
 *
 * Run on each Cash Mode tick. Idempotent: the change ref is the goal's limits
 * plus the opening's own facts, so an unchanged pair is a no-op and a changed
 * limit or a new fact is decided again. Then whatever `reconsider.ts` flagged
 * is recomputed from the same two readers. Code only; no model is asked.
 */
export async function decideOpenings(
  projectId: string,
  options: { now?: string; limit?: number } = {},
): Promise<DecideOpeningsPass> {
  const now = options.now ?? nowIso();
  const out: DecideOpeningsPass = {
    goals: 0,
    considered: 0,
    recorded: 0,
    unchanged: 0,
    byVerdict: { REJECT: 0, HOLD: 0, PRIORITIZE: 0 },
    recompute: { recomputed: 0, released: 0, deferred: 0 },
    pastCap: { dated: 0, undated: 0 },
  };
  const goals = await liveGoalLimits(projectId, now);
  out.goals = goals.length;
  if (goals.length > 0) {
    const limit = options.limit ?? DECISION_PASS_LIMIT;
    const openings = decisionOrder(await listOpportunities({ projectId, states: [...DECIDABLE_STATES] }), now);
    const at = Date.parse(now);
    const datedLeft: { id: string; expiresAt: string | null }[] = [];
    for (const [position, opening] of openings.entries()) {
      if (out.considered >= limit) {
        for (const left of openings.slice(position)) {
          const closes = closingInstant(left.expiresAt);
          if (closes !== null && closes > at) {
            out.pastCap.dated += 1;
            if (datedLeft.length < CAP_EVENT_SAMPLE) datedLeft.push({ id: left.id, expiresAt: left.expiresAt });
          } else out.pastCap.undated += 1;
        }
        await recordCapReached(projectId, { limit, considered: out.considered, decidable: openings.length, pastCap: out.pastCap, datedLeft });
        break;
      }
      // Each decision is synchronous work; the event loop is handed back between openings (§90, 2026-11-06 stalls).
      await new Promise<void>((resolve) => setImmediate(resolve));
      const facts = screenFactsFor(opening);
      const factsRef = factsChangeRef(facts);
      for (const goal of goals) {
        out.considered += 1;
        const result = await decideOpportunity({
          projectId,
          opportunityId: opening.id,
          goalId: goal.goalId,
          facts,
          limits: goal.limits,
          changeRef: `${limitsChangeRef(goal.goalId, goal.limits)}|F:${factsRef}`,
          ...(opening.sourceClaimId ? { evidenceIds: [opening.sourceClaimId] } : {}),
          now,
        });
        if (result.status === 'RECORDED') {
          out.recorded += 1;
          out.byVerdict[result.decision.verdict] += 1;
        } else {
          out.unchanged += 1;
        }
      }
    }
  }
  const limitsByGoal = new Map(goals.map((one) => [one.goalId, one.limits]));
  out.recompute = await recomputeFlaggedDecisions(
    projectId,
    {
      limitsFor: async (goalId) => limitsByGoal.get(goalId) ?? null,
      factsFor: async (opportunityId) => {
        const opening = await getOpportunity(opportunityId);
        if (!opening) return null;
        return { facts: screenFactsFor(opening), ...(opening.sourceClaimId ? { evidenceIds: [opening.sourceClaimId] } : {}) };
      },
    },
    { now },
  );
  return out;
}
