/**
 * Keeping every goal's work moving, on the durable tick, with nobody watching.
 *
 * Almost all of "keep work moving" already exists and this module deliberately
 * does not reimplement any of it: an expired lease is claimable work (§19), an
 * unanswered fire is reopened (§24), a packet's next stage is enqueued by its
 * runner, a campaign's by the factory tick, an answered request is resumed by
 * `resumeAnsweredRequest`. What nothing did was act on the *goal* — so a person
 * who said "not now" had no way to make it true, a goal that could only start
 * once another finished was fired at anyway, and the capacity the fleet has was
 * handed out in whatever order bins happened to be created, whoever's they were
 * and whatever they were for.
 *
 * Three things, each derived from rows on every pass and idempotent by them:
 *
 *   1. **Holds.** A paused or cancelled goal's live bins are held; so are an
 *      active goal's while another goal it depends on is unfinished. A held bin
 *      is neither fired nor handed out (`claimableStateSql`), and it keeps its
 *      lease, attempts, generation and events — a worker already inside it
 *      finishes what it is doing. When the reason stops being true the hold is
 *      released on the next pass, which is the whole of "resume": the work
 *      continues from where it stopped, with no stage button and no new prompt.
 *   2. **Allocation.** Each owner's goals are ranked (`priority.ts`) and their
 *      live bins given the priority that rank maps to, so the dispatcher's and
 *      the assigner's own `ORDER BY priority DESC` hands capacity out in the
 *      order a person's goals say it should go. Ranked within an owner and a
 *      project, so one private operation's priorities never decide how much
 *      capacity another one gets.
 *   3. **History.** A goal whose position moved gets one append-only snapshot
 *      naming the fact that moved it, so "why did this change" is answered
 *      from a row rather than from a re-run.
 *
 * Nothing here starts work, approves anything, spends anything, re-enqueues a
 * failed item or retries an external effect. Releasing a hold makes work that
 * was already authorized claimable again; it never makes new work. And a hold
 * never touches a bin another live goal is pursuing — one person pausing their
 * goal must not stop somebody else's.
 */
import type { Bin } from '../../domain/types.ts';
import { binPriorityForRank, type HoldReason } from '../../domain/goals.ts';
import { recordWorkstreamEvent } from '../../repos/register.ts';
import {
  allHeldBins,
  holdBinForGoal,
  latestSnapshots,
  recordSnapshot,
  releaseGoalHold,
  restateGoalHold,
  setLiveBinPriority,
} from '../../repos/goals.ts';
import { assembleGoals, type GoalView } from './model.ts';
import { rankGoals } from './priority.ts';

export interface GoalTickReport {
  goals: number;
  held: { binId: string; goalId: string; reason: HoldReason }[];
  released: { binId: string; goalId: string; why: string }[];
  reprioritized: { binId: string; goalId: string; priority: number }[];
  moved: { goalId: string; from: number | null; to: number; reason: string }[];
}

const LIVE = new Set(['DRAFT', 'READY', 'LEASED', 'NEEDS_HUMAN']);

function holdReasonFor(goal: GoalView): HoldReason | null {
  if (goal.lifecycle === 'PAUSED') return 'GOAL_PAUSED';
  if (goal.lifecycle === 'CANCELLED') return 'GOAL_CANCELLED';
  if (goal.lifecycle === 'ACTIVE' && goal.dependencies.some((one) => one.met !== true)) {
    return 'WAITING_ON_DEPENDENCY';
  }
  return null;
}

export async function advanceGoals(options?: { now?: string }): Promise<GoalTickReport> {
  const snapshot = await assembleGoals({ projectIds: null, includeArchived: true, now: options?.now });
  const report: GoalTickReport = { goals: snapshot.goals.length, held: [], released: [], reprioritized: [], moved: [] };
  const byId = new Map(snapshot.goals.map((goal) => [goal.id, goal]));

  // Which goals own each live bin. A bin may be pursued by more than one goal,
  // and then it is held only when *every* goal pursuing it wants it held.
  const owners = new Map<string, { bin: Bin; goals: GoalView[] }>();
  for (const [goalId, bins] of snapshot.binsByGoal) {
    const goal = byId.get(goalId);
    if (!goal) continue;
    for (const bin of bins) {
      if (!LIVE.has(bin.state)) continue;
      const entry = owners.get(bin.id);
      if (entry) entry.goals.push(goal);
      else owners.set(bin.id, { bin, goals: [goal] });
    }
  }

  const wanted = new Map<string, { goalId: string; reason: HoldReason }>();
  for (const [binId, { bin, goals }] of owners) {
    const pursuing = goals.filter((goal) => goal.lifecycle !== 'ARCHIVED' && goal.lifecycle !== 'COMPLETE');
    if (pursuing.length === 0) continue;
    const reasons = pursuing.map((goal) => ({ goal, reason: holdReasonFor(goal) }));
    if (reasons.every((one) => one.reason !== null)) {
      // The current holder keeps it if it still wants it, so two goals that
      // both want a shared bin held never trade the hold back and forth.
      const first = reasons.find((one) => one.goal.id === bin.heldByWorkstreamId) ?? reasons[0]!;
      wanted.set(binId, { goalId: first.goal.id, reason: first.reason! });
    }
  }

  // Release every hold whose reason no longer holds. Read from the bins rather
  // than from the goals, so a hold whose goal was archived, reinstated or
  // deleted is still found and released.
  for (const bin of await allHeldBins()) {
    const holder = bin.heldByWorkstreamId!;
    const want = wanted.get(bin.id);
    if (want && want.goalId === holder) {
      await restateGoalHold(bin.id, holder, want.reason);
      continue;
    }
    if (await releaseGoalHold(bin.id, holder)) {
      const goal = byId.get(holder);
      const why = !goal
        ? 'the goal holding it is gone'
        : goal.lifecycle === 'ACTIVE'
          ? bin.heldReason === 'WAITING_ON_DEPENDENCY'
            ? 'every goal it depended on has completed'
            : 'the goal was resumed'
          : `the goal is ${goal.lifecycle.toLowerCase()}`;
      report.released.push({ binId: bin.id, goalId: holder, why });
      if (goal) {
        await recordWorkstreamEvent({
          workstreamId: holder,
          kind: 'GOAL_WORK_RELEASED',
          summary: `Bin ${bin.id} released: ${why}. It continues from where it stopped.`,
          detail: { binId: bin.id, previousHold: bin.heldReason, attempts: `${bin.attemptCount}/${bin.maxAttempts}` },
          actorRef: 'BRAIN',
        });
      }
    }
  }

  for (const [binId, want] of wanted) {
    const entry = owners.get(binId);
    if (!entry || entry.bin.heldByWorkstreamId) continue;
    if (await holdBinForGoal(binId, want.goalId, want.reason)) {
      report.held.push({ binId, goalId: want.goalId, reason: want.reason });
      await recordWorkstreamEvent({
        workstreamId: want.goalId,
        kind: 'GOAL_WORK_HELD',
        summary: `Bin ${binId} held (${want.reason}). Its lease, attempts and results are kept.`,
        detail: { binId, reason: want.reason, state: entry.bin.state },
        actorRef: 'BRAIN',
      });
    }
  }

  // Allocation: a workable goal's rank maps to its live bins' priority, and a
  // bin pursued by several goals takes the highest.
  const ranked = new Map(rankGoals(snapshot.facts).map((one) => [one.id, one]));
  const target = new Map<string, { priority: number; goalId: string }>();
  for (const [binId, { goals }] of owners) {
    if (wanted.has(binId)) continue;
    for (const goal of goals) {
      if (goal.lifecycle !== 'ACTIVE') continue;
      const rank = ranked.get(goal.id);
      if (!rank) continue;
      const priority = binPriorityForRank(rank.rank);
      const current = target.get(binId);
      if (!current || priority > current.priority) target.set(binId, { priority, goalId: goal.id });
    }
  }
  const changedPerGoal = new Map<string, string[]>();
  for (const [binId, { priority, goalId }] of target) {
    if (await setLiveBinPriority(binId, priority)) {
      report.reprioritized.push({ binId, goalId, priority });
      const list = changedPerGoal.get(goalId);
      if (list) list.push(binId);
      else changedPerGoal.set(goalId, [binId]);
    }
  }
  for (const [goalId, bins] of changedPerGoal) {
    const rank = ranked.get(goalId);
    await recordWorkstreamEvent({
      workstreamId: goalId,
      kind: 'GOAL_CAPACITY_ALLOCATED',
      summary: `${bins.length} bin(s) set to priority ${binPriorityForRank(rank?.rank ?? 99)} for this goal's position ${(rank?.rank ?? 0) + 1} among its owner's goals.`,
      detail: { bins, rank: rank?.rank ?? null },
      actorRef: 'BRAIN',
    });
  }

  // History: one snapshot per goal whose position actually moved.
  const previous = await latestSnapshots([...ranked.keys()]);
  for (const rank of ranked.values()) {
    const last = previous.get(rank.id);
    if (last && last.rank === rank.rank) continue;
    const why = rank.belowPrevious
      ? { criterion: rank.belowPrevious.criterion, reason: `below the goal above it because that one: ${rank.belowPrevious.reason}` }
      : rank.aboveNext
        ? { criterion: rank.aboveNext.criterion, reason: `first because ${rank.aboveNext.reason}` }
        : { criterion: 'TIE', reason: 'its owner has no other goal here' };
    await recordSnapshot({
      workstreamId: rank.id,
      ownerKey: rank.ownerKey,
      rank: rank.rank,
      previousRank: last ? last.rank : null,
      criterion: why.criterion,
      reason: why.reason,
    });
    report.moved.push({ goalId: rank.id, from: last ? last.rank : null, to: rank.rank, reason: why.reason });
  }

  return report;
}
