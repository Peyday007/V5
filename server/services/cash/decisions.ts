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
import { getWorkstream, listWorkstreams } from '../../repos/register.ts';
import { readTarget } from '../goals/target.ts';
import { screenFactsWithHistory } from './worthResearching.ts';

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


/** Openings nobody has taken yet: the ones a decision is about. Committed work is never decided over. */
const DECIDABLE_STATES = ['DISCOVERED', 'EVIDENCE_CARD', 'READY'] as const;

async function limitsOfGoal(goalId: string, now: string): Promise<ScreenLimits | null> {
  const goal = await getWorkstream(goalId);
  if (!goal || !goal.target) return null;
  const reading = await readTarget(goal, new Date(now));
  if (!reading || reading.achieved) return null;
  return {
    metric: reading.metric,
    daysLeft: reading.daysLeft,
    capitalCeilingCents: reading.capitalCeilingCents,
    capitalBeforeProofCents: reading.capitalBeforeProofCents,
  };
}

export interface DecisionPass {
  goals: number;
  recorded: number;
  unchanged: number;
  recomputed: number;
  released: number;
  deferred: number;
}

/**
 * The producer: for every live goal with a target, decide every untaken
 * opening under its limits, then recompute whatever a reconsideration flagged.
 * Derived from rows each pass; a pair is decided once per distinct change, so a
 * pass over an unchanged project records nothing. Never touches committed
 * work or a person's own archive or decline.
 */
export async function runDecisionPass(projectId: string, options: { now?: string } = {}): Promise<DecisionPass> {
  const now = options.now ?? nowIso();
  const out: DecisionPass = { goals: 0, recorded: 0, unchanged: 0, recomputed: 0, released: 0, deferred: 0 };
  const openings = await listOpportunities({ projectId, states: [...DECIDABLE_STATES] });
  for (const goal of await listWorkstreams({ projectIds: [projectId] })) {
    if (goal.projectId !== projectId || !goal.target) continue;
    const limits = await limitsOfGoal(goal.id, now);
    if (!limits) continue;
    out.goals += 1;
    const changeRef = limitsChangeRef(goal.id, limits);
    for (const opening of openings) {
      const result = await decideOpportunity({
        projectId,
        opportunityId: opening.id,
        goalId: goal.id,
        facts: await screenFactsWithHistory(opening),
        limits,
        changeRef,
        evidenceIds: opening.sourceClaimId ? [opening.sourceClaimId] : [],
        now,
      });
      if (result.status === 'RECORDED') out.recorded += 1;
      else out.unchanged += 1;
    }
  }
  const flagged = await recomputeFlaggedDecisions(
    projectId,
    {
      limitsFor: (goalId) => limitsOfGoal(goalId, now),
      factsFor: async (opportunityId) => {
        const opening = await getOpportunity(opportunityId);
        if (!opening) return null;
        return { facts: await screenFactsWithHistory(opening), evidenceIds: opening.sourceClaimId ? [opening.sourceClaimId] : [] };
      },
    },
    { now },
  );
  out.recomputed = flagged.recomputed;
  out.released = flagged.released;
  out.deferred = flagged.deferred;
  return out;
}
