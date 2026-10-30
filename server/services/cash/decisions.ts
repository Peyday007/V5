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
