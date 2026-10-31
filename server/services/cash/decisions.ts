/**
 * The decision record, written from the deterministic screen.
 *
 * The screen (`screen.ts`) answers REJECT, HOLD or CLEAR from one goal's own
 * limits; this turns that into one current REJECT / HOLD / PRIORITIZE per
 * opportunity per goal, with the reason, the binding limit, the missing facts
 * and what would reopen it. It is recomputed only for a distinct change — a
 * changed goal limit, new evidence, a date passing — and a person's archive or
 * decline is never overwritten.
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
import { nowIso } from '../../repos/util.ts';
import { getOpportunity, listOpportunities } from '../../repos/cashPortfolio.ts';
import { liveGoalLimits, screenFactsFor } from './worthResearching.ts';

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

export interface DecideOpeningsPass {
  goals: number;
  considered: number;
  recorded: number;
  unchanged: number;
  byVerdict: Record<DecisionVerdict, number>;
  recompute: { recomputed: number; released: number; deferred: number };
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
  };
  const goals = await liveGoalLimits(projectId, now);
  out.goals = goals.length;
  if (goals.length > 0) {
    const limit = options.limit ?? 500;
    const openings = await listOpportunities({ projectId, states: [...DECIDABLE_STATES] });
    for (const opening of openings) {
      if (out.considered >= limit) break;
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
