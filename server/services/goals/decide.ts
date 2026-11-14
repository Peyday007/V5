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
import type { GoalTarget, Workstream, WorkstreamLink, WorkstreamPurpose } from '../../domain/register.ts';
import { createWorkstream, getWorkstream, linkWorkstream, listLinks, recordWorkstreamEvent, updateWorkstream } from '../../repos/register.ts';
import { binsHeldBy, cancelGoal, pauseGoal, reinstateGoal, resumeGoal, setGoalTerms } from '../../repos/goals.ts';
import { getProject } from '../../repos/projects.ts';
import { readObjective, type ObjectiveReading } from '../industry/construction/intent.ts';
import { liveTargetOn, setTarget, sharedLedgerReason } from './target.ts';


/** An `unread` entry about a money figure the objective reader could not place (review F4). */
const UNPLACED_MONEY = /could not place|a second amount|a rate, not a total|a range, not one figure|a second (?:capital|per-week|before-proof)/;
export interface DecisionResult {
  ok: boolean;
  /** Why not, in words, when it did not happen. An ordinary outcome. */
  reason: string | null;
  /** What Brain will do because of this, in words. */
  consequence: string;
  /** Effects in this goal's project recorded as UNCERTAIN, never auto-retried. */
  uncertainEffects?: number;
}

/** A target stated as figures rather than words: the terminal's METRIC-AMOUNT-CURRENCY spec. */
export interface ExplicitTarget {
  metric: string;
  amountCents: number;
  currency: string;
  capitalCeilingCents?: number | null;
  hoursCeiling?: number | null;
  capitalBeforeProofCents?: number | null;
  capitalPerWeekCents?: number | null;
}

export type CreateGoalResult =
  | { ok: true; goal: Workstream; reading: ObjectiveReading; target: GoalTarget | null; consequence: string }
  | { ok: false; reason: string; reading: ObjectiveReading };

const toCents = (major: number | null): number | null => (major === null ? null : Math.round(major * 100));

/**
 * The one writer of a new goal from a person's objective (G-2). The HTTP route,
 * the operator's `brain_operator_create_goal` and `npm run goals -- create`
 * all call this, so a goal stated in words and a goal stated as a spec are made
 * the same way: the register row, its terms (the due date), and — for a cash
 * objective — its target on the project's ledger.
 *
 * The words are read by `readObjective`, the construction's own reader, and
 * anything the caller states explicitly (`dueAt`, `target`) wins over the words.
 * A cash objective the words do not fully state — no currency, no deadline — is
 * refused with what was missing, before anything is written; so is one whose
 * ledger another live goal already counts (G-7). An objective that is not about
 * a sum of money is never refused: it becomes a goal measured by its delivered
 * work, its words as the intent.
 */
export async function createGoal(input: {
  projectId: string;
  objective: string;
  title?: string;
  purpose?: WorkstreamPurpose;
  dueAt?: string;
  target?: ExplicitTarget;
  resources?: string | null;
  actorRef: string;
  userId: string | null;
  now?: Date;
}): Promise<CreateGoalResult> {
  const now = input.now ?? new Date();
  const objective = input.objective.replace(/\s+/g, ' ').trim();
  const reading = readObjective(objective, now);
  if (!objective) return { ok: false, reason: 'State the objective in words.', reading };
  if (!(await getProject(input.projectId))) return { ok: false, reason: 'No project with that id.', reading };

  const dueAt = input.dueAt ?? reading.deadline ?? undefined;
  if (dueAt !== undefined && !Number.isFinite(Date.parse(dueAt))) return { ok: false, reason: 'The due date must be a date.', reading };
  let target: (ExplicitTarget & { amountCents: number }) | null = input.target ?? null;
  if (!target && reading.kind === 'CASH') {
    const missing = [
      ...(reading.currency ? [] : ['the currency']),
      ...(dueAt ? [] : ['a deadline ("within 30 days", "by 2026-12-31")']),
    ];
    if (missing.length) {
      return { ok: false, reason: `This reads as a cash objective, but the words do not state ${missing.join(' or ')}; nothing was created.${reading.unread.length ? ` Unread: ${reading.unread.join('; ')}.` : ''}`, reading };
    }
    // A money figure the reader could not place may be a limit the owner set; a goal created without it
    // would plan as if no ceiling existed (invariant 38; review F4). Ask for it to be restated instead.
    const unplacedMoney = reading.unread.filter((one) => UNPLACED_MONEY.test(one));
    if (unplacedMoney.length) {
      return { ok: false, reason: `These money figures could not be read as the amount or a limit: ${unplacedMoney.join('; ')}. Restate them (for example "with at most $3,000 of capital", "$375 a week"); nothing was created.`, reading };
    }
    target = {
      metric: reading.metric ?? 'SETTLED_CASH',
      amountCents: toCents(reading.amount)!,
      currency: reading.currency!,
      capitalCeilingCents: toCents(reading.capitalCeiling),
      hoursCeiling: reading.hoursCeiling === null ? null : Math.round(reading.hoursCeiling),
      capitalBeforeProofCents: toCents(reading.beforeProof),
      capitalPerWeekCents: toCents(reading.capitalPerWeek),
    };
  }
  if (target) {
    if (!dueAt) return { ok: false, reason: 'A goal with a target needs a deadline: with none there is no window to count money in.', reading };
    const other = await liveTargetOn(input.projectId, target.currency, null, target.metric);
    if (other) return { ok: false, reason: sharedLedgerReason(other, target.currency), reading };
  }

  const goal = await createWorkstream({
    projectId: input.projectId,
    title: (input.title ?? objective).slice(0, 160),
    intent: objective,
    purpose: input.purpose ?? (target ? 'REVENUE_DIRECT' : 'LONG_TERM'),
    createdByUserId: input.userId,
  });
  await recordWorkstreamEvent({
    workstreamId: goal.id,
    kind: 'WORKSTREAM_OPENED',
    summary: `Created from the objective in words: ${objective.slice(0, 200)}`,
    detail: { reading },
    actorRef: input.actorRef,
  });
  const outcome = target ? `${target.metric} of at least ${target.amountCents / 100} ${target.currency}, verified on the ledger` : undefined;
  if (dueAt || outcome || input.userId) {
    await setTerms(goal.id, { outcome, dueAt: dueAt ? new Date(dueAt).toISOString() : undefined, ownerUserId: input.userId ?? undefined }, input.actorRef);
  }
  let set: GoalTarget | null = null;
  if (target) {
    const result = await setTarget({
      goal: (await getWorkstream(goal.id))!,
      metric: target.metric,
      amountCents: target.amountCents,
      currency: target.currency,
      projectId: input.projectId,
      capitalCeilingCents: target.capitalCeilingCents ?? null,
      hoursCeiling: target.hoursCeiling ?? null,
      resources: input.resources ?? null,
      capitalBeforeProofCents: target.capitalBeforeProofCents ?? null,
      capitalPerWeekCents: target.capitalPerWeekCents ?? null,
      now,
    });
    if (!result.ok) {
      // Refused after the row was written (a second writer got there first): the goal is cancelled with the reason, not left half-made.
      await cancel(goal.id, `The target was refused: ${result.reason}`, input.actorRef);
      return { ok: false, reason: result.reason, reading };
    }
    set = result.target;
    await recordWorkstreamEvent({
      workstreamId: goal.id,
      kind: 'GOAL_TARGET_SET',
      summary: `Target: ${target.metric} ${target.amountCents / 100} ${target.currency}${set.capitalCeilingCents !== null ? `, at most ${set.capitalCeilingCents / 100} tied up` : ''}${set.hoursCeiling !== null ? `, at most ${set.hoursCeiling} hours` : ''}. Counted from now.`,
      actorRef: input.actorRef,
    });
  }
  return {
    ok: true,
    goal: (await getWorkstream(goal.id))!,
    reading,
    target: set,
    consequence: set
      ? `The goal counts ${set.metric} on this project's ${set.currency} ledger from ${set.setAt}; the goal tick plans and searches for it on its next pass.`
      : 'The goal has no figure: it is measured by the work linked to it, and its words are its intent.',
  };
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

/**
 * Declare that this goal cannot finish before another one does — the one writer
 * of that decision. The cycle rule walks what the other goal depends on,
 * transitively, over live DEPENDS_ON links, and refuses when it reaches this
 * goal: goals waiting on each other would hold each other's bins for ever.
 * A refusal writes nothing. Authorization stays with the caller.
 */
export async function setDependency(
  goalId: string,
  otherGoalId: string,
  by: { actorRef: string; userId: string },
): Promise<DecisionResult & { link?: WorkstreamLink }> {
  if (otherGoalId === goalId) {
    return { ok: false, reason: 'A goal cannot depend on itself.', consequence: 'Nothing changed.' };
  }
  const goal = await getWorkstream(goalId);
  if (!goal) return { ok: false, reason: 'No such goal.', consequence: 'Nothing changed.' };
  const other = await getWorkstream(otherGoalId);
  if (!other) return { ok: false, reason: 'No such goal to depend on.', consequence: 'Nothing changed.' };

  const seen = new Set<string>();
  const queue = [other.id];
  while (queue.length) {
    const next = queue.shift()!;
    if (next === goal.id) {
      return { ok: false, reason: 'That would make the two goals wait on each other for ever.', consequence: 'Nothing changed.' };
    }
    if (seen.has(next)) continue;
    seen.add(next);
    for (const link of await listLinks(next)) {
      if (link.kind === 'WORKSTREAM' && link.relation === 'DEPENDS_ON') queue.push(link.ref);
    }
  }

  const link = await linkWorkstream({
    workstreamId: goal.id,
    kind: 'WORKSTREAM',
    ref: other.id,
    relation: 'DEPENDS_ON',
    label: other.title,
    recordedBy: 'PERSON',
    recordedByUserId: by.userId,
  });
  await recordWorkstreamEvent({
    workstreamId: goal.id,
    kind: 'GOAL_DEPENDENCY_SET',
    summary: `Waits on "${other.title}" until it completes.`,
    detail: { dependsOn: other.id, linkId: link.id },
    actorRef: by.actorRef,
  });
  return {
    ok: true,
    reason: null,
    consequence:
      'Until that goal completes, Brain holds this goal’s live bins so capacity goes to work that can move; it releases them on the first tick after the other goal completes.',
    link,
  };
}
