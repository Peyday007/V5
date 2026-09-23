/**
 * The decisions a person makes about a goal, with one writer each.
 *
 * Pause, resume, cancel, reinstate, change the terms, change the objective.
 * The HTTP routes and the terminal both call these, because two writers of one
 * decision is how the guard on one of them goes missing (§46 records it at a
 * rename). Each records an append-only event carrying who decided and what it
 * replaced, and none of them touches a bin directly: what a decision *means*
 * for the work is the goal tick's, derived on its next pass, so a decision and
 * its effect can never disagree about which rule applied.
 *
 * What none of them does, deliberately:
 *
 *   * **Destroy work.** A cancelled goal's bins are held, not cancelled — every
 *     attempt and result is kept, and reinstating continues them.
 *   * **End an obligation.** Cancelling a goal ends Brain's pursuit of it. A
 *     customer obligation or cash committed against it is owed regardless, and
 *     is reported as outstanding rather than released (invariant 40).
 *   * **Retry an effect.** Resuming makes already-authorized work claimable
 *     again; the effects inside it are still Step 6's, keyed by work item, so a
 *     resumed bin whose effect already committed replays rather than repeats,
 *     and an effect recorded `UNCERTAIN` is never automatically resent
 *     (invariant 26). Resume reports how many such effects this project holds,
 *     so the person resuming can see them rather than assume.
 *   * **Rewrite history.** Changing the objective keeps the old words on the
 *     event, and work started under the old objective keeps its links until a
 *     person supersedes them — superseding evidence is a correction with a
 *     reason, never an overwrite (§5, invariant 17).
 */
import { getDb } from '../../db/database.ts';
import type { GoalCommitment } from '../../domain/goals.ts';
import { getWorkstream, listLinks, recordWorkstreamEvent, updateWorkstream } from '../../repos/register.ts';
import { binsHeldBy, cancelGoal, pauseGoal, reinstateGoal, resumeGoal, setGoalTerms } from '../../repos/goals.ts';

export interface DecisionResult {
  ok: boolean;
  /** Why not, in words, when it did not happen. An ordinary outcome. */
  reason: string | null;
  /** What Brain will do because of this, in words. */
  consequence: string;
  /** Effects in this goal's project recorded as UNCERTAIN, never auto-retried. */
  uncertainEffects?: number;
}

async function uncertainEffectsFor(projectId: string | null): Promise<number> {
  if (!projectId) return 0;
  const row = await getDb().get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM idempotency_operations WHERE project_id = ? AND state = 'UNCERTAIN'`,
    [projectId],
  );
  return Number(row?.n ?? 0);
}

export async function pause(goalId: string, reason: string, actorRef: string): Promise<DecisionResult> {
  const moved = await pauseGoal(goalId, reason);
  if (!moved) {
    return { ok: false, reason: 'It is already paused, cancelled or archived.', consequence: 'Nothing changed.' };
  }
  await recordWorkstreamEvent({ workstreamId: goalId, kind: 'GOAL_PAUSED', summary: reason, actorRef });
  return {
    ok: true,
    reason: null,
    consequence:
      'On its next tick Brain holds every live bin this goal pursues. A worker already inside one finishes what it is doing; nothing is cancelled and no attempt is spent.',
  };
}

export async function resume(goalId: string, actorRef: string): Promise<DecisionResult> {
  const goal = await getWorkstream(goalId);
  const moved = await resumeGoal(goalId);
  if (!moved) {
    return { ok: false, reason: 'It is not paused, or it was cancelled — reinstate a cancelled goal instead.', consequence: 'Nothing changed.' };
  }
  const held = await binsHeldBy(goalId);
  const uncertainEffects = await uncertainEffectsFor(goal?.projectId ?? null);
  await recordWorkstreamEvent({
    workstreamId: goalId,
    kind: 'GOAL_RESUMED',
    summary: `Resumed with ${held.length} bin(s) held.`,
    detail: { heldBins: held.map((bin) => bin.id), uncertainEffects },
    actorRef,
  });
  return {
    ok: true,
    reason: null,
    consequence: `On its next tick Brain releases ${held.length} held bin(s) and the dispatcher fires the next free Routine at them; each continues from where it stopped.${
      uncertainEffects
        ? ` ${uncertainEffects} effect(s) in this project are recorded UNCERTAIN — Brain never resends those by itself.`
        : ''
    }`,
    uncertainEffects,
  };
}

export async function cancel(goalId: string, reason: string, actorRef: string): Promise<DecisionResult> {
  const goal = await getWorkstream(goalId);
  const moved = await cancelGoal(goalId, reason);
  if (!moved) {
    return { ok: false, reason: 'It is already cancelled or archived.', consequence: 'Nothing changed.' };
  }
  await recordWorkstreamEvent({ workstreamId: goalId, kind: 'GOAL_CANCELLED', summary: reason, actorRef });
  const owed = goal?.commitment === 'CUSTOMER';
  return {
    ok: true,
    reason: null,
    consequence: `Brain stops pursuing it: its live bins are held on the next tick with every attempt and result kept, and reinstating continues them.${
      owed ? ' It was owed to a customer; that obligation is still outstanding and is shown on the goal until it is settled.' : ''
    }`,
  };
}

export async function reinstate(goalId: string, actorRef: string): Promise<DecisionResult> {
  const moved = await reinstateGoal(goalId);
  if (!moved) return { ok: false, reason: 'It is not cancelled.', consequence: 'Nothing changed.' };
  await recordWorkstreamEvent({ workstreamId: goalId, kind: 'GOAL_REINSTATED', summary: 'Reinstated.', actorRef });
  return {
    ok: true,
    reason: null,
    consequence: 'On its next tick Brain releases the held bins (unless the goal is also paused) and the work continues where it stopped.',
  };
}

export async function setTerms(
  goalId: string,
  terms: { outcome?: string | null; ownerUserId?: string | null; dueAt?: string | null; commitment?: GoalCommitment },
  actorRef: string,
): Promise<DecisionResult> {
  const before = await getWorkstream(goalId);
  if (!before) return { ok: false, reason: 'No such goal.', consequence: 'Nothing changed.' };
  const moved = await setGoalTerms(goalId, terms);
  if (!moved) return { ok: false, reason: 'Nothing to change.', consequence: 'Nothing changed.' };
  await recordWorkstreamEvent({
    workstreamId: goalId,
    kind: 'GOAL_TERMS_SET',
    summary: 'A person set what this goal is for, whose it is, when it is due, or who it is owed to.',
    detail: {
      before: { outcome: before.outcome, ownerUserId: before.ownerUserId, dueAt: before.dueAt, commitment: before.commitment },
      after: terms,
    },
    actorRef,
  });
  return {
    ok: true,
    reason: null,
    consequence: 'Priority is re-derived on the next tick; if this goal moves, the move and the fact that moved it are recorded.',
  };
}

/**
 * A changed objective keeps what it replaced and says what the change leaves
 * standing: every piece of work already linked keeps pursuing, because whether
 * it still serves the new objective is a judgement, and a person makes it by
 * superseding the links that no longer do.
 */
export async function changeObjective(
  goalId: string,
  input: { intent?: string; outcome?: string | null },
  actorRef: string,
): Promise<DecisionResult> {
  const before = await getWorkstream(goalId);
  if (!before) return { ok: false, reason: 'No such goal.', consequence: 'Nothing changed.' };
  if (input.intent === undefined && input.outcome === undefined) {
    return { ok: false, reason: 'Nothing to change.', consequence: 'Nothing changed.' };
  }
  if (input.intent !== undefined) await updateWorkstream(goalId, { intent: input.intent });
  if (input.outcome !== undefined) await setGoalTerms(goalId, { outcome: input.outcome });
  const pursuing = (await listLinks(goalId)).filter((one) => one.relation === 'PURSUES');
  await recordWorkstreamEvent({
    workstreamId: goalId,
    kind: 'GOAL_OBJECTIVE_CHANGED',
    summary: 'The objective changed. What it replaced is kept here.',
    detail: {
      before: { intent: before.intent, outcome: before.outcome },
      after: input,
      stillPursuing: pursuing.map((one) => `${one.kind}:${one.ref}`),
    },
    actorRef,
  });
  return {
    ok: true,
    reason: null,
    consequence: pursuing.length
      ? `${pursuing.length} piece(s) of work were started under the previous objective and keep going. Supersede any link that no longer serves the new one; its row and its history stay.`
      : 'No work was linked yet, so nothing was started under the previous objective.',
  };
}
