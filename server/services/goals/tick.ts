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
import { getDb } from '../../db/database.ts';
import { getWorkstream, recordWorkstreamEvent } from '../../repos/register.ts';
import {
  allHeldBins,
  resumeGoal,
  holdBinForGoal,
  latestSnapshots,
  recordSnapshot,
  releaseGoalHold,
  restateGoalHold,
  setLiveBinPriority,
} from '../../repos/goals.ts';
import { assembleGoals, type GoalView } from './model.ts';
import { rankGoals } from './priority.ts';
import { reconcilePreparedCapabilitiesIfDue, type CapabilityPassReport } from './capabilityPromotion.ts';
import { reconcileRegisterIfDue, type RegisterPassReport } from './openQuestions.ts';
import { recordDecisionsIfDue } from './decisionRecord.ts';
import { reconcileCalibrationIfDue, type CalibrationPassReport } from './calibration.ts';
import { reconcileFactChangesIfDue, type ReconsiderPassReport } from './reconsider.ts';
import { causeFromJobInputs, diagnoseCostCountedOnce, type CostOnceCause, type JobInputCause, type JobTimeInputs, type LaneCapacityReading, type ResearchYieldReading } from './researchYield.ts';
import {
  APPLICABLE_REMEDIES,
  COMMERCIAL_FLOOR,
  EXPLORATION_FLOOR,
  LANE_REMEDIES,
  REMEDY_LEVERS,
  RESEARCH_REMEDY_APPLIED_EVENT,
  MIN_PURPOSE_SHARE,
  RESEARCH_PURPOSES,
  SYSTEM_HEALTH_FLOOR,
  decideResearchAllocation,
  binPriorityShift,
  enforceFloors,
  normalizeShares,
  purposePriorityShifts,
  purposesBelowFloor,
  type AllocationDecision,
  type AllocationInput,
  type BottleneckMeasurement,
  type LaneMeasurement,
  type LaneRemedy,
  type PurposeMeasurement,
  type PriorityShift,
  type ResearchPurpose,
  type SharesInForce,
} from './researchAllocation.ts';

export interface GoalTickReport {
  goals: number;
  held: { binId: string; goalId: string; reason: HoldReason }[];
  released: { binId: string; goalId: string; why: string }[];
  reprioritized: { binId: string; goalId: string; priority: number }[];
  moved: { goalId: string; from: number | null; to: number; reason: string }[];
  /**
   * Prepared program requirements promoted from measured blockers in cash rows, or
   * demoted when that need vanished (GOV-22-1), at most once a minute.
   */
  capabilities?: CapabilityPassReport[] | { error: string };
  /**
   * The GOV-11 open-questions register checked against the program's source and
   * appended releases, at most every five minutes; an outcome that changed (a
   * release the register has not been re-mapped against, or the re-map that
   * answers it) is recorded as a factory event. Null when the pass was not due.
   */
  register?: RegisterPassReport | { error: string } | null;
  /**
   * The decision-history passes (MEM-32): each plan reading recorded as a
   * decision, predictions judged against results, and a changed fact
   * reconsidering the decisions that rested on it. Each is bounded, a pass not
   * yet due is null, and a failure is reported here rather than thrown.
   */
  memory: {
    decisions: { recorded: number; pending: number } | { error: string };
    calibration: CalibrationPassReport[] | { error: string } | null;
    reconsidered: ReconsiderPassReport | { error: string } | null;
  };
  /**
   * The research allocation across the five purposes (RES-07, RES-15-5), decided
   * from the window's measured yield at most once an hour. Null when the pass was
   * not due; an error is reported here, never thrown into the tick.
   */
  research?: ResearchAllocationReport | { error: string } | null;
  /**
   * The decision in force applied to the work: each purpose's priority step and
   * the bins it moved. Null when no decision is recorded, or it was held.
   */
  researchApplied?: ResearchApplication | null;
}

/** The three decision-history passes, injectable for tests. */
export interface MemoryPasses {
  decisions(): Promise<{ recorded: number; pending: number }>;
  calibration(now: number): Promise<CalibrationPassReport[] | { error: string } | null>;
  reconsider(now: number): Promise<ReconsiderPassReport | { error: string } | null>;
}

const PRODUCTION_MEMORY: MemoryPasses = {
  decisions: () => recordDecisionsIfDue(),
  calibration: (now) => reconcileCalibrationIfDue(now),
  reconsider: (now) => reconcileFactChangesIfDue(now),
};

const failure = (error: unknown): { error: string } => ({ error: error instanceof Error ? error.message.slice(0, 300) : String(error) });

/**
 * Record decisions first, so a reading made since the last tick is a record
 * the reconsideration pass can read; then calibration; then reconsideration.
 * One failing pass never stops the others or the tick.
 */
async function runMemoryPasses(passes: MemoryPasses, now: number): Promise<GoalTickReport['memory']> {
  let decisions: GoalTickReport['memory']['decisions'];
  try {
    decisions = await passes.decisions();
  } catch (error) {
    decisions = failure(error);
  }
  let calibration: GoalTickReport['memory']['calibration'];
  try {
    calibration = await passes.calibration(now);
  } catch (error) {
    calibration = failure(error);
  }
  let reconsidered: GoalTickReport['memory']['reconsidered'];
  try {
    reconsidered = await passes.reconsider(now);
  } catch (error) {
    reconsidered = failure(error);
  }
  return { decisions, calibration, reconsidered };
}

export interface ResearchApplication {
  /** The decision applied, by its fingerprint. */
  fingerprint: string | null;
  shifts: Record<ResearchPurpose, PriorityShift>;
  belowFloor: ResearchPurpose[];
  /** Goal bins whose priority the step moved off their goal's rank. */
  goalBins: { binId: string; purposes: string[]; shift: PriorityShift }[];
  /** Bins no goal pursues, raised because a purpose they serve is below a protected floor. */
  floorRaised: { binId: string; purposes: string[]; from: number; to: number }[];
  /**
   * Queued research items (the free lane's work among them) raised because a
   * purpose they serve is below a protected floor: the claim order is
   * `priority DESC`, so this reserves the next free slots for the floor.
   */
  floorReserved?: { workItemId: string; purposes: string[]; from: number; to: number }[];
  /**
   * Queued items a previous floor raised whose purposes are no longer below a
   * floor, put back to the priority their owner set (or let go, when the item
   * left the queue or its owner moved it since).
   */
  floorRestored?: { workItemId: string; from: number; to: number; restored: boolean }[];
  /**
   * Bins no goal pursues that a previous floor raised, put back to the
   * priority they had once no purpose they served is below a floor — or let
   * go, when the bin left the live states, was moved since, or a goal now
   * pursues it and owns its priority.
   */
  floorRaisedRestored?: { binId: string; from: number; to: number; restored: boolean }[];
  /** Below-floor purposes no live bin and no queued item serves: nothing exists to raise. */
  floorUnserved?: ResearchPurpose[];
  /** What the floor caused to be opened for an unserved purpose, through the owner that opens that purpose's work. */
  floorOpened?: { purpose: ResearchPurpose; via: string; refs: string[] }[];
}

/**
 * What opens work for a purpose below its floor when none exists. Each is an
 * existing owner's entrance, used under its own caps and gates (§10.3): the
 * goal plan pass widens a goal's search (exploration, transaction routes), and
 * the improvement loop detects weaknesses and opens their repair (system
 * health). The tick asks; it opens nothing itself.
 */
export interface FloorOpeners {
  /** Ask the goal plan pass to widen these goals' search on its next pass. Returns the goals asked. */
  widenGoalSearch: (goalIds: string[], why: string) => Promise<string[]>;
  /** Run the improvement loop's detection now. Returns what it opened. */
  openSystemHealth: (why: string) => Promise<string[]>;
}

export const productionFloorOpeners: FloorOpeners = {
  async widenGoalSearch(goalIds, why) {
    const { requestFloorResearch } = await import('./plan.ts');
    for (const id of goalIds) requestFloorResearch(id, why);
    return goalIds;
  },
  async openSystemHealth() {
    const { improvementTick } = await import('../improvement/loop.ts');
    const report = await improvementTick(new Date());
    return report.ran ? report.opened.map((one) => String(one)) : [`not run: ${report.reason}`];
  },
};

/** Which (decision, purpose) pairs this process already asked an opener for, so one decision opens once. */
const floorAsked = new Set<string>();
/** Tests. */
export function forgetFloorOpenings(): void {
  floorAsked.clear();
}

/** Research work types whose queued items a floor reservation may raise. */
const FLOOR_ITEM_TYPES = ['RESEARCH_PLAN', 'RESEARCH_FRAGMENT', 'RESEARCH_VERIFY', 'RESEARCH_SYNTHESIZE', 'RESEARCH_AUDIT'] as const;

/**
 * Below-floor purposes no live bin or queued item serves, split by the opener
 * that can create their work. Pure.
 */
export function floorOpenPlan(belowFloor: readonly ResearchPurpose[], served: ReadonlySet<string>): { unserved: ResearchPurpose[]; goalSearch: ResearchPurpose[]; systemHealth: boolean } {
  const unserved = belowFloor.filter((p) => !served.has(p));
  return {
    unserved,
    goalSearch: unserved.filter((p) => p === 'BROAD_DISCOVERY' || p === 'FORWARD_EXPLORATION' || p === 'TRANSACTION_ROUTES'),
    systemHealth: unserved.includes('SELF_IMPROVEMENT'),
  };
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

/**
 * Whether a recorded pause is one `pause()` (decide.ts) would refuse today on a
 * targeted goal with its deadline ahead — the only pause this tick may undo.
 *
 * It is the exact complement of the test `pause()` applies, so the two can never
 * disagree about who counts as a person: `pause()` accepts an actor whose ref
 * starts with `person:` and refuses every other named actor; this undoes a pause
 * only when it was recorded by a named actor that does not start with `person:`.
 * A pause recorded with no actor at all (NULL or blank `actor_ref`) names nobody,
 * so nothing can say it was a machine's, and it is left alone exactly like a
 * goal with no pause event. Any surface `pause()` accepts therefore has its
 * pauses kept here; one it refuses could not have written a pause to undo.
 * Inline rather than imported because decide.ts does not export its predicate;
 * keep the `person:` prefix identical to `machinePauseRefusal` there.
 */
function isUndoableMachinePause(actorRef: string | null | undefined): actorRef is string {
  if (typeof actorRef !== 'string' || actorRef.trim() === '') return false;
  return !actorRef.startsWith('person:');
}

/**
 * Undo a machine's pause of a targeted goal whose deadline is still ahead.
 *
 * A machine may reduce a targeted goal's allocation; it may not stop the goal.
 * Preventing new machine pauses does not restore one already made, so this
 * reads the rows on every pass: a goal with a target and a future deadline,
 * paused, neither cancelled nor archived, whose latest GOAL_PAUSED event was
 * written by a named actor that is not a person, is resumed (`resumeGoal`, guarded in its own
 * statement) and the resumption recorded. A person's pause stands; an
 * untargeted or past-deadline goal is not touched. No goal is ever created.
 *
 * The production row this answers (docs/ARCHITECTURE-RECORD.md, 2026-11-14): at
 * 06:00Z an operator run committed PAUSE_GOAL on `wst_7b4fcbb5f2384f31b6c3`, the
 * $10K COLLECTED_CASH goal due 2026-12-09, "to conserve capacity while
 * infrastructure pools are congested". It was the only live targeted goal, so at
 * 07:00:30Z r01.goal-02 found none ("no live goal carries a target and a
 * deadline"). Its deadline had not passed and it was neither archived nor
 * untargeted, so the pause was the whole cause. `restoreOwnerDirectedGoals`
 * undoes it for that one listed id only. This pass undoes the same pause for
 * any targeted goal, and decide.ts refuses the next one. A goal that is not
 * live because its deadline passed, it was archived or cancelled, it has no
 * target, or a person paused it stays not live. The probe still fails on it,
 * which is correct (tests/program-ea512f54-repair-goal-02-1-production.test.ts).
 */
export async function resumeMachinePausedTargetedGoals(now: string): Promise<string[]> {
  const db = getDb();
  const candidates = await db.all<{ id: string }>(
    `SELECT id FROM workstreams
      WHERE target_metric IS NOT NULL AND target_amount_cents IS NOT NULL
        AND due_at IS NOT NULL AND due_at > ?
        AND paused_at IS NOT NULL AND cancelled_at IS NULL AND archived_at IS NULL
      ORDER BY id`,
    [now],
  );
  const resumed: string[] = [];
  for (const { id } of candidates) {
    const last = await db.get<{ actor_ref: string | null }>(
      `SELECT actor_ref FROM workstream_events WHERE workstream_id = ? AND kind = 'GOAL_PAUSED' ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    // No pause event, or one that names no actor: nobody can say a machine
    // paused it, so it is left alone. A person's pause stands.
    if (!last || !isUndoableMachinePause(last.actor_ref)) continue;
    if (!(await resumeGoal(id))) continue;
    await recordWorkstreamEvent({
      workstreamId: id,
      kind: 'GOAL_RESUMED',
      summary: `Resumed: paused by ${last.actor_ref}, which is not a person, and a machine may only reduce a targeted goal's allocation, never stop it.`,
      detail: { pausedBy: last.actor_ref },
      actorRef: 'brain:goal-tick',
    });
    resumed.push(id);
  }
  return resumed;
}

export async function advanceGoals(options?: { now?: string; memory?: Partial<MemoryPasses>; floorOpeners?: FloorOpeners }): Promise<GoalTickReport> {
  await resumeMachinePausedTargetedGoals(options?.now ?? new Date().toISOString());
  // Archived goals are not derived here: they hold nothing and rank nowhere,
  // and there are more of them after every deploy. A hold one left behind is
  // released below, and its owner read directly (tests/goalTickCost.test.ts).
  const snapshot = await assembleGoals({ projectIds: null, includeArchived: false, now: options?.now });
  const report: GoalTickReport = {
    goals: snapshot.goals.length,
    held: [],
    released: [],
    reprioritized: [],
    moved: [],
    memory: { decisions: { recorded: 0, pending: 0 }, calibration: null, reconsidered: null },
  };
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
      const archived = goal ? null : await getWorkstream(holder);
      const why = goal
        ? goal.lifecycle === 'ACTIVE'
          ? bin.heldReason === 'WAITING_ON_DEPENDENCY'
            ? 'every goal it depended on has completed'
            : 'the goal was resumed'
          : `the goal is ${goal.lifecycle.toLowerCase()}`
        : archived?.archivedAt
          ? 'the goal is archived'
          : 'the goal holding it is gone';
      report.released.push({ binId: bin.id, goalId: holder, why });
      if (goal || archived) {
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

  // The research allocation is decided (at most hourly) before capacity is
  // handed out, and the newest recorded decision is applied on every pass.
  report.research = await reallocateResearchIfDue({ goals: snapshot.goals, now: options?.now });
  const inForce = await researchInForce();
  const application: ResearchApplication | null = inForce
    ? { fingerprint: inForce.fingerprint, shifts: purposePriorityShifts(inForce.shares), belowFloor: purposesBelowFloor(inForce.shares), goalBins: [], floorRaised: [] }
    : null;
  const liveBins = application ? await liveBinRows() : [];
  const binPurposes: Map<string, string[]> = application ? await (await import('./researchYield.ts')).purposesOfBins(liveBins) : new Map<string, string[]>();
  const shiftOf = (binId: string): PriorityShift => (application ? binPriorityShift(binPurposes.get(binId) ?? [], application.shifts) : 0);

  // Allocation: a workable goal's rank maps to its live bins' priority, and a
  // bin pursued by several goals takes the highest. The research decision in
  // force then steps it one up or down by the purposes the bin serves.
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
  for (const [binId, entry] of target) {
    const shift = shiftOf(binId);
    if (shift === 0) continue;
    entry.priority = Math.min(8, Math.max(0, entry.priority + shift));
    application!.goalBins.push({ binId, purposes: binPurposes.get(binId) ?? [], shift });
  }
  // A bin no goal pursues has no rank to return to, so a floor raise records the
  // priority it had, is bounded by the floor's shortfall, and is put back once
  // the purpose recovers — never a ratchet (the treatment queued items get).
  if (application && application.belowFloor.length > 0) {
    const floorPriority = binPriorityForRank(0);
    application.floorRaised = await raiseOrphanBins({
      liveBins,
      binPurposes,
      owned: new Set(owners.keys()),
      belowFloor: application.belowFloor,
      floorPriority,
      shares: inForce!.shares,
      fingerprint: application.fingerprint,
    });
    await holdFloors(application, {
      liveBins,
      binPurposes,
      floorPriority,
      shares: inForce!.shares,
      activeGoalIds: snapshot.goals.filter((g) => g.lifecycle === 'ACTIVE').map((g) => g.id),
      openers: options?.floorOpeners ?? productionFloorOpeners,
    });
  }
  // Every pass, decision or none: a raise whose purpose is back above its floor is undone.
  const restored = await restoreFloorReservations(application?.belowFloor ?? []);
  const binsRestored = await restoreOrphanBinRaises(application?.belowFloor ?? [], new Set(owners.keys()));
  if (application) {
    application.floorRestored = restored;
    application.floorRaisedRestored = binsRestored;
  }
  report.researchApplied = application;
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
      summary: `${bins.length} bin(s) set to priority ${binPriorityForRank(rank?.rank ?? 99)} for this goal's position ${(rank?.rank ?? 0) + 1} among its owner's goals${application?.goalBins.some((g) => bins.includes(g.binId)) ? ', stepped by the research allocation in force' : ''}.`,
      detail: { bins, rank: rank?.rank ?? null, researchShift: application?.goalBins.filter((g) => bins.includes(g.binId)) ?? [], researchDecision: application?.fingerprint ?? null },
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

  // Readiness from measured blockers: the capability pass applies `priority.ts`'s decisions.
  report.capabilities = await reconcilePreparedCapabilitiesIfDue();
  // The open-questions register kept current with the program's releases (GOV-11).
  report.register = await reconcileRegisterIfDue();
  const now = options?.now ? Date.parse(options.now) : Date.now();
  report.memory = await runMemoryPasses({ ...PRODUCTION_MEMORY, ...(options?.memory ?? {}) }, Number.isFinite(now) ? now : Date.now());

  return report;
}

/**
 * Make a protected floor hold in the running Brain, not only in the recorded
 * shares (RES-07, review F2). Raising bins reaches only bins; this reaches the
 * rest:
 *
 *   1. Queued research items serving a below-floor purpose — the free lane's
 *      work among them — are raised to the floor priority, so the next slot
 *      that claims (`priority DESC`) takes floor work first. Guarded on the
 *      item still being QUEUED and below that priority, in the statement that
 *      changes it; a leased item is never touched (invariant 24).
 *   2. A below-floor purpose that no live bin and no queued item serves has
 *      nothing to raise, so its work is caused to exist: the goal plan pass is
 *      asked to widen the active goals' search (exploration, transaction
 *      routes) and the improvement loop to detect and open system-health
 *      repair. Once per decision and purpose, so a quiet tick does not ask again.
 */
async function holdFloors(
  application: ResearchApplication,
  input: {
    liveBins: { id: string }[];
    binPurposes: Map<string, string[]>;
    floorPriority: number;
    shares: SharesInForce;
    activeGoalIds: string[];
    openers: FloorOpeners;
  },
): Promise<void> {
  const below = application.belowFloor as readonly string[];
  const served = new Set<string>();
  for (const bin of input.liveBins) for (const p of input.binPurposes.get(bin.id) ?? []) if (below.includes(p)) served.add(p);

  application.floorReserved = [];
  const items = await queuedResearchItems();
  const itemPurposes = items.length > 0 ? await (await import('./researchYield.ts')).purposesOfBins(items) : new Map<string, string[]>();
  /*
   * Bounded by the share gap: each floor reserves at most its shortfall's
   * share of the queue (at least one item), counting what an earlier raise
   * still holds, so a reading just under a floor lifts a handful of items and
   * not a whole project's queue. The highest-priority items go first, so the
   * owners' own order is kept among the ones taken.
   */
  const outstanding = await outstandingFloorReservations();
  const budget = floorBudgets(input.shares, items.length);
  const groupOf = (purposes: readonly string[]): FloorGroup | null =>
    (FLOOR_GROUPS.find((g) => budget[g] > 0 && purposes.some((p) => floorGroupPurposes(g).includes(p) && below.includes(p))) ?? null);
  const raised: { workItemId: string; purposes: string[]; from: number; to: number }[] = [];
  const ordered = [...items].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const item of ordered) {
    const purposes = itemPurposes.get(item.id) ?? [];
    if (!purposes.some((p) => below.includes(p))) continue;
    for (const p of purposes) if (below.includes(p)) served.add(p);
    const held = outstanding.get(item.id);
    if (held) {
      const g = groupOf(purposes);
      if (g) budget[g] -= 1;
      continue;
    }
    if (item.priority >= input.floorPriority) continue;
    const g = groupOf(purposes);
    if (!g) continue;
    const changed = await getDb().run(`UPDATE work_items SET priority = ? WHERE id = ? AND state = 'QUEUED' AND priority < ?`, [input.floorPriority, item.id, input.floorPriority]);
    if (Number(changed.changes) > 0) {
      budget[g] -= 1;
      raised.push({ workItemId: item.id, purposes, from: item.priority, to: input.floorPriority });
    }
  }
  application.floorReserved = raised;
  // Each raise is recorded with the priority its owner set, which is what lets a later pass undo it.
  if (raised.length > 0) await recordFloorEvent(FLOOR_RESERVED_EVENT, { fingerprint: application.fingerprint ?? null, items: raised });

  const plan = floorOpenPlan(application.belowFloor, served);
  application.floorUnserved = plan.unserved;
  application.floorOpened = [];
  const key = (p: string) => `${application.fingerprint ?? 'none'}|${p}`;
  const goalSearch = plan.goalSearch.filter((p) => !floorAsked.has(key(p)));
  if (goalSearch.length > 0 && input.activeGoalIds.length > 0) {
    const why = `${goalSearch.join(', ')} below the protected floor with no live work serving it`;
    const refs = await input.openers.widenGoalSearch(input.activeGoalIds, why);
    for (const p of goalSearch) {
      floorAsked.add(key(p));
      application.floorOpened.push({ purpose: p, via: 'goal plan pass: widen search', refs });
    }
  }
  if (plan.systemHealth && !floorAsked.has(key('SELF_IMPROVEMENT'))) {
    floorAsked.add(key('SELF_IMPROVEMENT'));
    try {
      const refs = await input.openers.openSystemHealth('SELF_IMPROVEMENT below the system-health floor with no live work serving it');
      application.floorOpened.push({ purpose: 'SELF_IMPROVEMENT', via: 'improvement loop: detect and open repair', refs });
    } catch (error) {
      application.floorOpened.push({ purpose: 'SELF_IMPROVEMENT', via: 'improvement loop: detect and open repair', refs: [`error: ${String((error as Error).message ?? error).slice(0, 200)}`] });
    }
  }
}

/** Queued research items, with what attribution needs. */
async function queuedResearchItems(): Promise<{ id: string; projectId: string; orchestrationId: string | null; purpose: string | null; priority: number }[]> {
  const rows = await getDb().all<{ id: string; project_id: string; orchestration_id: string | null; purpose: string | null; priority: number | string }>(
    `SELECT w.id, w.project_id, w.orchestration_id, b.purpose, w.priority FROM work_items w LEFT JOIN bins b ON b.id = w.bin_id
      WHERE w.state = 'QUEUED' AND w.work_type IN (${FLOOR_ITEM_TYPES.map(() => '?').join(', ')}) ORDER BY w.id LIMIT 5000`,
    [...FLOOR_ITEM_TYPES],
  );
  return rows.map((r) => ({ id: r.id, projectId: r.project_id, orchestrationId: r.orchestration_id, purpose: r.purpose, priority: Number(r.priority) }));
}

/**
 * A floor raise, and its undoing, as rows (improvement events, the record the
 * research decision itself lives in): a raise names each item's own priority
 * before it, so the raise can be put back whatever process makes the next pass.
 */
export const FLOOR_RESERVED_EVENT = 'RESEARCH_FLOOR_RESERVED';
export const FLOOR_RESTORED_EVENT = 'RESEARCH_FLOOR_RESTORED';
/** How far back an unreturned raise is looked for. A queued research item older than this is not waiting on a floor. */
const FLOOR_RESERVATION_LOOKBACK_MS = 14 * 24 * 60 * 60_000;

type FloorGroup = 'EXPLORATION' | 'SYSTEM_HEALTH' | 'COMMERCIAL';
const FLOOR_GROUPS: readonly FloorGroup[] = ['EXPLORATION', 'SYSTEM_HEALTH', 'COMMERCIAL'];

function floorGroupPurposes(g: FloorGroup): readonly string[] {
  return g === 'EXPLORATION' ? ['BROAD_DISCOVERY', 'FORWARD_EXPLORATION'] : g === 'SYSTEM_HEALTH' ? ['SELF_IMPROVEMENT'] : ['TRANSACTION_ROUTES'];
}

/**
 * How many queued items each floor may hold raised: its shortfall (floor minus
 * what the window actually gave it) as a share of the queue, at least one
 * while it is short, none when it is not. Pure.
 */
export function floorBudgets(f: SharesInForce, queued: number): Record<FloorGroup, number> {
  const shortfall: Record<FloorGroup, number> = {
    EXPLORATION: EXPLORATION_FLOOR - (f.observed.BROAD_DISCOVERY + f.observed.FORWARD_EXPLORATION),
    SYSTEM_HEALTH: SYSTEM_HEALTH_FLOOR - f.observed.SELF_IMPROVEMENT,
    COMMERCIAL: f.urgentCommercialGoal ? COMMERCIAL_FLOOR - f.observed.TRANSACTION_ROUTES : 0,
  };
  const below = new Set(purposesBelowFloor(f));
  const out = { EXPLORATION: 0, SYSTEM_HEALTH: 0, COMMERCIAL: 0 } as Record<FloorGroup, number>;
  for (const g of FLOOR_GROUPS) {
    if (!floorGroupPurposes(g).some((p) => below.has(p as ResearchPurpose))) continue;
    out[g] = Math.max(1, Math.ceil(Math.max(0, shortfall[g]) * Math.max(0, queued)));
  }
  return out;
}

async function recordFloorEvent(kind: string, detail: Record<string, unknown>): Promise<void> {
  const { recordImprovementEvent } = await import('../../repos/improvement.ts');
  await recordImprovementEvent({ candidateId: null, kind, detail });
}

/** Raises not yet undone, by item: the priority it had before and the one it was raised to, and the purposes it served. */
async function outstandingFloorReservations(): Promise<Map<string, { from: number; to: number; purposes: string[] }>> {
  return outstandingRaises('items', 'workItemId');
}

/** Floor raises of bins no goal pursues not yet undone, by bin, read from the same event rows. */
async function outstandingBinRaises(): Promise<Map<string, { from: number; to: number; purposes: string[] }>> {
  return outstandingRaises('bins', 'binId');
}

/**
 * Raises not yet undone, read from the floor events' `items` (queued work) or
 * `bins` (bins no goal pursues) lists. Oldest first, so a raise, its undoing
 * and a later raise of the same row read in the order they happened.
 */
async function outstandingRaises(field: 'items' | 'bins', idKey: 'workItemId' | 'binId'): Promise<Map<string, { from: number; to: number; purposes: string[] }>> {
  const { listImprovementEvents } = await import('../../repos/improvement.ts');
  const since = new Date(Date.now() - FLOOR_RESERVATION_LOOKBACK_MS).toISOString();
  const events = await listImprovementEvents({ kinds: [FLOOR_RESERVED_EVENT, FLOOR_RESTORED_EVENT], since, limit: 5000 });
  const out = new Map<string, { from: number; to: number; purposes: string[] }>();
  for (const e of [...events].reverse()) {
    const list = (e.detail as Record<string, unknown>)[field];
    const rows = Array.isArray(list) ? (list as unknown[]) : [];
    for (const raw of rows) {
      const one = raw as Record<string, unknown>;
      const id = one[idKey];
      if (typeof id !== 'string') continue;
      if (e.kind === FLOOR_RESTORED_EVENT) out.delete(id);
      else if (Number.isFinite(Number(one.from)) && Number.isFinite(Number(one.to)))
        out.set(id, { from: Number(one.from), to: Number(one.to), purposes: Array.isArray(one.purposes) ? one.purposes.map(String) : [] });
    }
  }
  return out;
}

/** The live bin states, as the bin repository's own priority write guards them. */
const LIVE_BIN_STATES_SQL = `('DRAFT', 'READY', 'LEASED', 'NEEDS_HUMAN')`;

/**
 * Raise bins no goal pursues while a purpose they serve is below a protected
 * floor (review F1). Bounded by the floor's shortfall exactly as queued items
 * are (`floorBudgets` over the bins that could serve it, at least one, counting
 * what an earlier raise still holds), highest priority first so the owners'
 * order is kept among those taken. Each raise records the bin's priority
 * before it as an improvement event, so any later pass can put it back.
 */
async function raiseOrphanBins(input: {
  liveBins: { id: string; priority: number; heldByWorkstreamId: string | null }[];
  binPurposes: ReadonlyMap<string, string[]>;
  owned: ReadonlySet<string>;
  belowFloor: readonly string[];
  floorPriority: number;
  shares: SharesInForce;
  fingerprint: string | null;
}): Promise<{ binId: string; purposes: string[]; from: number; to: number }[]> {
  const below = input.belowFloor;
  const candidates = input.liveBins.filter((bin) => {
    if (input.owned.has(bin.id) || bin.heldByWorkstreamId) return false;
    return (input.binPurposes.get(bin.id) ?? []).some((p) => below.includes(p));
  });
  if (candidates.length === 0) return [];
  const outstanding = await outstandingBinRaises();
  const budget = floorBudgets(input.shares, candidates.length);
  const groupOf = (purposes: readonly string[]): FloorGroup | null =>
    (FLOOR_GROUPS.find((g) => budget[g] > 0 && purposes.some((p) => floorGroupPurposes(g).includes(p) && below.includes(p))) ?? null);
  const ordered = [...candidates].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // What an earlier raise still holds counts against the budget before anything new is taken.
  for (const bin of ordered) {
    if (!outstanding.has(bin.id)) continue;
    const g = groupOf(input.binPurposes.get(bin.id) ?? []);
    if (g) budget[g] -= 1;
  }
  const raised: { binId: string; purposes: string[]; from: number; to: number }[] = [];
  for (const bin of ordered) {
    if (outstanding.has(bin.id) || bin.priority >= input.floorPriority) continue;
    const purposes = input.binPurposes.get(bin.id) ?? [];
    const g = groupOf(purposes);
    if (!g) continue;
    const changed = await getDb().run(
      `UPDATE bins SET priority = ?, updated_at = ? WHERE id = ? AND priority < ? AND state IN ${LIVE_BIN_STATES_SQL}`,
      [input.floorPriority, new Date().toISOString(), bin.id, input.floorPriority],
    );
    if (Number(changed.changes) > 0) {
      budget[g] -= 1;
      raised.push({ binId: bin.id, purposes, from: bin.priority, to: input.floorPriority });
    }
  }
  if (raised.length > 0) await recordFloorEvent(FLOOR_RESERVED_EVENT, { fingerprint: input.fingerprint, bins: raised });
  return raised;
}

/**
 * Undo the floor raises of bins no goal pursues whose purposes are no longer
 * below a floor. Guarded in the statement: only a bin still live at exactly
 * the raised priority is put back, so an owner's later change wins. A bin a
 * goal now pursues is let go untouched — its goal's rank owns its priority.
 */
async function restoreOrphanBinRaises(belowFloor: readonly string[], owned: ReadonlySet<string>): Promise<{ binId: string; from: number; to: number; restored: boolean }[]> {
  const outstanding = await outstandingBinRaises();
  const out: { binId: string; from: number; to: number; restored: boolean }[] = [];
  for (const [id, r] of outstanding) {
    if (r.purposes.some((p) => belowFloor.includes(p))) continue;
    if (owned.has(id)) {
      out.push({ binId: id, from: r.to, to: r.from, restored: false });
      continue;
    }
    const changed = await getDb().run(
      `UPDATE bins SET priority = ?, updated_at = ? WHERE id = ? AND priority = ? AND state IN ${LIVE_BIN_STATES_SQL}`,
      [r.from, new Date().toISOString(), id, r.to],
    );
    out.push({ binId: id, from: r.to, to: r.from, restored: Number(changed.changes) > 0 });
  }
  if (out.length > 0) await recordFloorEvent(FLOOR_RESTORED_EVENT, { bins: out });
  return out;
}

/**
 * Undo the floor raises whose purposes are no longer below a floor (review:
 * a raise that is never lowered is a ratchet, and the allocation could push
 * share toward a purpose but never take it back). Guarded in the statement:
 * only an item still QUEUED at exactly the raised priority is put back, so a
 * worker's claim or an owner's own later change wins. An item that left the
 * queue or was moved since is let go, recorded as not restored.
 */
async function restoreFloorReservations(belowFloor: readonly string[]): Promise<{ workItemId: string; from: number; to: number; restored: boolean }[]> {
  const outstanding = await outstandingFloorReservations();
  const out: { workItemId: string; from: number; to: number; restored: boolean }[] = [];
  for (const [id, r] of outstanding) {
    if (r.purposes.some((p) => belowFloor.includes(p))) continue;
    const changed = await getDb().run(`UPDATE work_items SET priority = ? WHERE id = ? AND state = 'QUEUED' AND priority = ?`, [r.from, id, r.to]);
    out.push({ workItemId: id, from: r.to, to: r.from, restored: Number(changed.changes) > 0 });
  }
  if (out.length > 0) await recordFloorEvent(FLOOR_RESTORED_EVENT, { items: out });
  return out;
}

/** The live bins, with what attribution needs. */
async function liveBinRows(): Promise<{ id: string; projectId: string; orchestrationId: string | null; purpose: string | null; priority: number; heldByWorkstreamId: string | null }[]> {
  const rows = await getDb().all<{ id: string; project_id: string; orchestration_id: string | null; purpose: string | null; priority: number | string; held_by_workstream_id: string | null }>(
    `SELECT id, project_id, orchestration_id, purpose, priority, held_by_workstream_id FROM bins
      WHERE state IN ('DRAFT', 'READY', 'LEASED', 'NEEDS_HUMAN') ORDER BY id LIMIT 5000`,
    [],
  );
  return rows.map((r) => ({ id: r.id, projectId: r.project_id, orchestrationId: r.orchestration_id, purpose: r.purpose, priority: Number(r.priority), heldByWorkstreamId: r.held_by_workstream_id }));
}

/** The shares a recorded decision's detail puts in force, or null when it carries none. Pure. */
export function sharesInForceFrom(detail: Record<string, unknown> | null): (SharesInForce & { fingerprint: string | null }) | null {
  if (!detail || typeof detail.shares !== 'object' || detail.shares === null) return null;
  const read = (value: unknown): Record<ResearchPurpose, number> | null => {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (!RESEARCH_PURPOSES.every((p) => typeof v[p] === 'number' && Number.isFinite(v[p] as number))) return null;
    return Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, v[p] as number])) as Record<ResearchPurpose, number>;
  };
  const shares = read(detail.shares);
  const observed = read(detail.observed);
  // A decision recorded before what the window gave each purpose was stored cannot be applied: nothing to compare.
  if (!shares || !observed) return null;
  const floors = detail.floors as { commercial?: unknown } | undefined;
  return {
    shares,
    observed,
    // A decision whose cost was not shown counted once is never applied.
    held: detail.held === true || detail.heldForCost === true,
    urgentCommercialGoal: typeof floors?.commercial === 'number',
    fingerprint: typeof detail.fingerprint === 'string' ? detail.fingerprint : null,
  };
}

/**
 * The decision in force: the newest Brain-wide decision row, unless it was
 * held. It is one row for the whole Brain, so which goals are live, and in
 * which order, cannot change which decision is applied.
 */
async function researchInForce(): Promise<{ shares: SharesInForce; fingerprint: string | null } | null> {
  const ports = await productionResearchAllocationPorts();
  const parsed = sharesInForceFrom((await ports.lastDecision())?.detail ?? null);
  if (!parsed || parsed.held) return null;
  return { shares: parsed, fingerprint: parsed.fingerprint };
}

/* ------------------------------------------------------------------------- */
/* Research allocation across the five purposes (RES-07, RES-15-5)            */
/* ------------------------------------------------------------------------- */

/**
 * The goals tick is the allocation owner, so the research allocation runs here
 * rather than in a new scheduler (§10.3, §20.4). Each pass reads one window of
 * measured yield (`researchYieldByPurpose`: per-lane and per-purpose jobs,
 * claims, useful results and job time, each job's cost counted once), hands it
 * to the pure decision (`decideResearchAllocation`: marginal useful outcome per
 * unit of cost, deadlines and bottlenecks move the shares, floors keep
 * exploration, system health and the urgent commercial goal), and records the
 * decision when it changed.
 *
 * What the pass does with the decision, and what it never does:
 *
 *   * It records each measured window's decision once, as one append-only Brain-wide row
 *     (`RESEARCH_ALLOCATION_DECIDED` in `improvement_events`, the Brain-wide
 *     operations log, with no candidate), carrying the five shares, what the
 *     window gave each, the floors that held, every reason, the lane remedies,
 *     the capacity each lane was measured at and the capacity verdicts. The
 *     purposes are Brain-wide, so the decision is not copied onto every goal:
 *     a goal's own history carries only what the decision did to that goal
 *     (`GOAL_CAPACITY_ALLOCATED` names the bins it stepped and the decision's
 *     fingerprint), and the goals briefing (`briefing.ts`, rendered by Home and
 *     the goals page) shows the decision in force and the capacity it found.
 *   * A low-actionability lane is given its next remedy (question design, then
 *     evidence sources, then model routing) before any limit is raised for it,
 *     and a remedy already recorded for a lane is passed back as tried.
 *   * A capacity change is recorded naming the measured constraint and its
 *     cost. A free-lane lane's ADD_CAPACITY (`free-lane:<model>`, bounded by
 *     the headroom that controller measured) is applied by the §86 free-lane
 *     controller, the one owner of that lane's targets, which reads the newest
 *     decision and raises the model's target once per decision, never past
 *     its own caps (S-0153); any other lane's verdict is a recommendation. The
 *     pass itself starts no work, spends nothing, raises no limit and takes
 *     no worker's item. It does not write bin
 *     priorities itself: the allocation stage is their one writer, and on every
 *     pass it applies the newest recorded decision (`sharesInForceFrom`,
 *     `purposePriorityShifts`) — a goal bin serving an under-served purpose is
 *     stepped up from its rank's priority and one serving an over-served purpose
 *     down, and a bin no goal pursues is raised while a purpose it serves sits
 *     below a protected floor. That is what makes the shares move capacity.
 *
 * An unchanged decision writes nothing, so a quiet hour leaves no rows.
 */
export const RESEARCH_ALLOCATION_EVERY_MS = 60 * 60_000;
/** The consistent window each decision is measured over. */
export const RESEARCH_ALLOCATION_WINDOW_MS = 24 * 60 * 60_000;
/**
 * The per-goal kind earlier passes wrote: the same Brain-wide decision copied
 * onto every live goal. No longer written or read; kept so old rows stay named.
 */
export const RESEARCH_REALLOCATED_EVENT = 'GOAL_RESEARCH_REALLOCATED';
/** The one Brain-wide decision row, in `improvement_events` with no candidate. */
export const RESEARCH_ALLOCATION_DECIDED = 'RESEARCH_ALLOCATION_DECIDED';
/** The lanes whose ADD_CAPACITY verdict the §86 free-lane controller applies (`free-lane:<model>`). */
export const FREE_LANE_PREFIX = 'free-lane:';
/** Who applies a free-lane capacity verdict, as the decision row names it. */
export const FREE_LANE_CONTROLLER = 'free-lane controller (§86)';

export interface ResearchAllocationReport {
  window: { since: string; until: string };
  shares: Record<ResearchPurpose, number>;
  floors: { exploration: number; systemHealth: number; commercial: number | null; perPurpose: number };
  changed: boolean;
  held: boolean;
  laneActions: AllocationDecision['laneActions'];
  /** Capacity verdicts; a free-lane ADD_CAPACITY is applied by that lane's controller, any other is a recommendation. */
  capacity: AllocationDecision['capacity'];
  /** Whether this pass wrote the Brain-wide decision row (once, never per goal). */
  recorded: boolean;
  fingerprint: string;
  /** Remedies this pass applied: each a change to how the live goals' research is asked, recorded with its reference. */
  applied: { lane: string; remedy: LaneRemedy; ref: string }[];
}

/**
 * A remedy actually applied to a lane: a recorded change to its question
 * design, evidence sources or model routing, with a reference to the change
 * itself. This — never a recommendation — is what makes a remedy tried.
 */
export interface AppliedRemedy {
  lane: string;
  remedy: LaneRemedy;
  appliedAt: string;
  /** What was changed: a commit, a configuration id, a prompt version. Required. */
  ref: string;
}

export { RESEARCH_REMEDY_APPLIED_EVENT };

export interface ResearchAllocationPorts {
  readYield(window: { since: string; until: string }): Promise<ResearchYieldReading>;
  /**
   * Remedies recorded as applied on these goals' research. Absent means none is
   * recorded: an unknown is never read as a change made (invariant 39).
   */
  appliedRemedies?(goalIds: string[]): Promise<AppliedRemedy[]>;
  /**
   * Each lane's capacity as it stands now: queued work, its wait, headroom and
   * incremental cost. Absent means unmeasured, and no capacity is added.
   */
  readLaneCapacity?(until: string): Promise<LaneCapacityReading[]>;
  /**
   * Put a remedy in force on these goals' research and record it applied. The
   * record is the switch: the question builders read it (`remediesInForce`).
   * Absent means nothing applies here, and nothing is recorded as applied.
   */
  applyRemedy?(input: { lane: string; remedy: LaneRemedy; ref: string; goalIds: string[] }): Promise<void>;
  /** The newest Brain-wide decision row, or null. */
  lastDecision(): Promise<{ detail: Record<string, unknown>; at: string } | null>;
  /**
   * The newest Brain-wide decision rows, newest first, up to `limit`: the rows
   * probe r01.res-15-5 judges. Each pass diagnoses the measured ones that do
   * not show their cost counted once, from their own recorded numbers
   * (`diagnosePriorCostFailures`). Absent means the history is not read.
   */
  recentDecisions?(limit: number): Promise<{ detail: Record<string, unknown>; at: string }[]>;
  /** Write the Brain-wide decision row: once per measured window (or per changed unmeasured decision), never per goal. */
  recordDecision(summary: string, detail: Record<string, unknown>): Promise<void>;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** What live goals put on one purpose: the nearest deadline its research serves, and the stake its next unit can decide. */
export interface PurposePressure {
  nearestDeadlineDays: number | null;
  /** Remaining target money (minor units) of the goals this purpose's research serves, split by the job time it gave each. Null when no goal with a target is served. */
  decisionValue: number | null;
  /** One line per goal that put pressure here. */
  basis: string[];
}

/**
 * Deadlines and expected decision value per purpose, from the live goals and
 * the research the window actually did for each (RES-07).
 *
 * A goal's deadline bears on every purpose its research served in the window,
 * and its remaining target is the value at stake in that research's decisions,
 * split between those purposes by the job time each received — so a goal's
 * stake is counted once, like a job's cost. A goal no job in the window names
 * still has a deadline and a stake: a goal with a target puts them on
 * TRANSACTION_ROUTES (turning arrangements into transactions is what moves a
 * target), and a goal without one puts its deadline on FORWARD_EXPLORATION
 * (future goal preparation, the same rule `attributePurposes` uses). A goal with
 * no target has no money at stake and adds no decision value: an unknown is
 * never a favourable assumption (invariant 39). Pure.
 */
export function purposePressureFrom(goals: readonly GoalView[], reading: Pick<ResearchYieldReading, 'attributions'>, nowMs: number): Record<ResearchPurpose, PurposePressure> {
  const out = Object.fromEntries(RESEARCH_PURPOSES.map((p): [ResearchPurpose, PurposePressure] => [p, { nearestDeadlineDays: null, decisionValue: null, basis: [] }])) as Record<ResearchPurpose, PurposePressure>;
  const isPurpose = (p: string): p is ResearchPurpose => (RESEARCH_PURPOSES as readonly string[]).includes(p);
  // Job time each goal's research gave each purpose, a multi-purpose job split evenly (as `summarizeResearchYield` splits cost).
  const served = new Map<string, Map<ResearchPurpose, number>>();
  for (const a of reading.attributions) {
    if (!a.goalId) continue;
    const ps = a.purposes.filter(isPurpose);
    if (ps.length === 0) continue;
    const weight = Math.max(1, Number(a.jobMs ?? 0)) / ps.length;
    const m = served.get(a.goalId) ?? new Map<ResearchPurpose, number>();
    for (const p of ps) m.set(p, (m.get(p) ?? 0) + weight);
    served.set(a.goalId, m);
  }
  for (const g of goals) {
    if (g.lifecycle !== 'ACTIVE') continue;
    const due = g.dueAt ? Date.parse(g.dueAt) : NaN;
    const days = Number.isFinite(due) && due > nowMs ? (due - nowMs) / 86_400_000 : null;
    const remaining = g.target && !g.target.achieved && g.target.remainingCents > 0 ? g.target.remainingCents : null;
    if (days === null && remaining === null) continue;
    const measured = served.get(g.id);
    const split: [ResearchPurpose, number][] = measured && measured.size > 0
      ? [...measured]
      : [[g.target ? 'TRANSACTION_ROUTES' : 'FORWARD_EXPLORATION', 1]];
    const total = split.reduce((s, [, w]) => s + w, 0);
    const how = measured && measured.size > 0 ? 'its research in the window served this purpose' : g.target ? 'no job in the window names it; a target is moved by transaction routes' : 'no job in the window names it; a goal without a target is future goal preparation';
    for (const [p, w] of split) {
      const slot = out[p];
      if (days !== null) slot.nearestDeadlineDays = slot.nearestDeadlineDays === null ? days : Math.min(slot.nearestDeadlineDays, days);
      if (remaining !== null) slot.decisionValue = (slot.decisionValue ?? 0) + (remaining * w) / total;
      slot.basis.push(`goal ${g.id}${days !== null ? ` due in ${days.toFixed(1)} day(s)` : ''}${remaining !== null ? `, ${Math.round((remaining * w) / total)} of ${remaining} remaining` : ''}: ${how}`);
    }
  }
  return out;
}

/** The measured inputs one window gives the decision. Pure. */
export function allocationInputFrom(
  reading: ResearchYieldReading,
  context: {
    urgentCommercialGoal: boolean;
    /** Legacy: one deadline for TRANSACTION_ROUTES. `pressure`, when given, replaces it for every purpose. */
    nearestDeadlineDays: number | null;
    triedRemedies: Map<string, LaneRemedy[]>;
    measuringRemedies?: Map<string, LaneRemedy>;
    /** Each purpose's deadline and decision value (`purposePressureFrom`). */
    pressure?: Partial<Record<ResearchPurpose, Pick<PurposePressure, 'nearestDeadlineDays' | 'decisionValue'>>>;
    /** The work waiting on each lane now, its headroom and its cost; a lane absent here is unmeasured. */
    capacity?: ReadonlyMap<string, LaneCapacityReading>;
    /** The remedies a lever can apply; absent means every remedy is waited on. */
    remedyLevers?: readonly LaneRemedy[];
  },
): AllocationInput {
  // The shares in force are where the capacity actually went: each purpose's job time in the window.
  const currentShares: Partial<Record<ResearchPurpose, number>> = {};
  for (const p of RESEARCH_PURPOSES) currentShares[p] = reading.purposes[p]?.jobMs ?? 0;
  const purposes: PurposeMeasurement[] = RESEARCH_PURPOSES.map((p) => {
    const b = reading.purposes[p];
    const ran = !!b && b.submissions + b.completions > 0 && b.jobMs > 0;
    return {
      purpose: p,
      usefulResults: ran ? b!.usefulResults : null,
      // Job time is the cost every job records; it is split once across a job's purposes.
      cost: ran ? b!.jobMs : null,
      ...(context.pressure
        ? {
            ...(context.pressure[p]?.nearestDeadlineDays != null ? { nearestDeadlineDays: context.pressure[p]!.nearestDeadlineDays } : {}),
            ...(context.pressure[p]?.decisionValue != null ? { decisionValue: context.pressure[p]!.decisionValue } : {}),
          }
        : p === 'TRANSACTION_ROUTES' && context.nearestDeadlineDays !== null ? { nearestDeadlineDays: context.nearestDeadlineDays } : {}),
    };
  });
  const lanePurposes = new Map<string, Set<ResearchPurpose>>();
  for (const a of reading.attributions) {
    const set = lanePurposes.get(a.lane) ?? new Set<ResearchPurpose>();
    for (const p of a.purposes) if (p !== 'UNATTRIBUTED') set.add(p);
    lanePurposes.set(a.lane, set);
  }
  const lanes: LaneMeasurement[] = [];
  const bottlenecks: BottleneckMeasurement[] = [];
  for (const [lane, b] of Object.entries(reading.lanes)) {
    const served = [...(lanePurposes.get(lane) ?? [])];
    lanes.push({
      lane,
      purposes: served,
      claims: b.acceptedClaims,
      // An actionable link: a qualified position (buyer, price, fulfilment), an executable offer or a paid transaction.
      actionableLinks: b.qualifiedPositions + b.executableOffers + b.paidTransactions,
      triedRemedies: context.triedRemedies.get(lane) ?? [],
      measuringRemedy: context.measuringRemedies?.get(lane) ?? null,
    });
    const attempts = b.completions + b.failures.total;
    // Waiting work is what is queued now, never the jobs that already started; headroom and cost are read, never assumed.
    const cap = context.capacity?.get(lane) ?? null;
    bottlenecks.push({
      lane,
      purposes: served,
      resource: b.failures.rateLimited > 0 ? 'MODEL_RATE_LIMIT' : null,
      qualifiedQueued: cap ? cap.queued : null,
      queueWaitMs: cap ? cap.queueWaitMs : null,
      measuredMachineLimit: b.failures.rateLimited > 0,
      quotaHeadroom: cap ? cap.quotaHeadroom : null,
      reliability: attempts > 0 ? b.completions / attempts : null,
      ownedByAnotherWorker: false,
      incrementalCostPerUnit: cap ? cap.incrementalCostPerUnit : null,
    });
  }
  return { currentShares, purposes, lanes, bottlenecks, urgentCommercialGoal: context.urgentCommercialGoal, ...(context.remedyLevers ? { remedyLevers: context.remedyLevers } : {}) };
}

/**
 * What makes two decisions the same: shares to a tenth of a percent, lane
 * remedies, capacity verdicts, and whether the decision was held. `held` is
 * part of it because a window that failed the counted-once check is recorded
 * with the observed shares, and the next window that holds can decide those
 * very shares: without `held` the two fingerprints matched, the holding
 * decision was never recorded, and the failing row stayed the newest measured
 * one forever (probe r01.res-15-5).
 */
export function allocationFingerprint(decision: AllocationDecision): string {
  return JSON.stringify({
    held: decision.held === true,
    shares: RESEARCH_PURPOSES.map((p) => round3(decision.shares[p])),
    lanes: decision.laneActions.map((a) => `${a.lane}:${a.kind}`).sort(),
    capacity: decision.capacity.map((c) => `${c.lane}:${c.kind}:${c.units}`).sort(),
  });
}

/**
 * Remedies a recorded decision says were tried on each lane. Only the `tried`
 * list counts — it is built from applied changes (`remediesFromApplied`) — and
 * never the decision's own recommended `remedy`: recommending a change is not
 * making it, and reading it as made let a lane escalate to a limit raise with
 * nothing ever changed.
 */
export function triedRemediesFrom(detail: Record<string, unknown> | null): Map<string, LaneRemedy[]> {
  const out = new Map<string, LaneRemedy[]>();
  const actions = Array.isArray(detail?.laneActions) ? (detail!.laneActions as { lane?: unknown; tried?: unknown }[]) : [];
  for (const a of actions) {
    if (typeof a.lane !== 'string') continue;
    const tried = Array.isArray(a.tried) ? a.tried.filter((r): r is LaneRemedy => (LANE_REMEDIES as readonly string[]).includes(String(r))) : [];
    out.set(a.lane, [...new Set(tried)]);
  }
  return out;
}

/**
 * From applied changes, per lane: the remedies measured over a whole window
 * after they were made (`tried`), and the newest one made inside the window,
 * whose effect is not yet measured (`measuring`). A record without a
 * reference to the change, or with an unreadable time, is not a change. Pure.
 */
export function remediesFromApplied(applied: readonly AppliedRemedy[], window: { since: string }): { tried: Map<string, LaneRemedy[]>; measuring: Map<string, LaneRemedy> } {
  const since = Date.parse(window.since);
  const tried = new Map<string, LaneRemedy[]>();
  const measuring = new Map<string, { remedy: LaneRemedy; at: number }>();
  for (const a of applied) {
    if (!(LANE_REMEDIES as readonly string[]).includes(a.remedy) || typeof a.ref !== 'string' || a.ref.trim() === '') continue;
    const at = Date.parse(a.appliedAt);
    if (!Number.isFinite(at)) continue;
    if (at <= since) {
      const list = tried.get(a.lane) ?? [];
      if (!list.includes(a.remedy)) list.push(a.remedy);
      tried.set(a.lane, list);
    } else {
      const prior = measuring.get(a.lane);
      if (!prior || at > prior.at) measuring.set(a.lane, { remedy: a.remedy, at });
    }
  }
  return { tried, measuring: new Map([...measuring].map(([lane, m]) => [lane, m.remedy])) };
}

/**
 * The remedies a decision recommends that a lever can apply and no record says
 * were applied to that lane yet: what the pass puts in force. A lane already
 * measuring a change, or one whose next remedy has no lever, gets nothing. Pure.
 */
export function remediesToApply(actions: AllocationDecision['laneActions'], applied: readonly AppliedRemedy[]): { lane: string; remedy: LaneRemedy; ref: string }[] {
  const out: { lane: string; remedy: LaneRemedy; ref: string }[] = [];
  for (const a of actions) {
    if (a.kind !== 'CHANGE_QUESTION_DESIGN' && a.kind !== 'CHANGE_EVIDENCE_SOURCES' && a.kind !== 'CHANGE_MODEL_ROUTING') continue;
    const lever = REMEDY_LEVERS[a.remedy];
    if (!lever) continue;
    if (applied.some((one) => one.lane === a.lane && one.remedy === a.remedy && one.ref.trim() !== '')) continue;
    out.push({ lane: a.lane, remedy: a.remedy, ref: lever.ref });
  }
  return out;
}

/** Record that a remedy was applied to a lane, naming the change. The only way a remedy becomes tried. */
export async function recordRemedyApplied(input: { goalId: string; lane: string; remedy: LaneRemedy; ref: string; actorRef: string }): Promise<void> {
  if (!(LANE_REMEDIES as readonly string[]).includes(input.remedy)) throw new Error(`unknown remedy ${input.remedy}`);
  if (input.ref.trim() === '') throw new Error('a remedy applied must name the change it made');
  await recordWorkstreamEvent({
    workstreamId: input.goalId,
    kind: RESEARCH_REMEDY_APPLIED_EVENT,
    summary: `Research remedy applied to ${input.lane}: ${input.remedy}`.slice(0, 400),
    detail: { lane: input.lane, remedy: input.remedy, ref: input.ref },
    actorRef: input.actorRef,
  });
}

/**
 * The reading's cost-counted-once record with a boolean `holds` that is true
 * only when the reading itself says so: a missing, malformed or non-boolean
 * record reads as not holding. Pure.
 */
export function verifiedCostReading(once: unknown): ResearchYieldReading['costCountedOnce'] {
  const o = (once && typeof once === 'object' ? once : {}) as Partial<ResearchYieldReading['costCountedOnce']>;
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  const money = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  return {
    jobs: num(o.jobs),
    totalJobMs: num(o.totalJobMs),
    purposeJobMs: num(o.purposeJobMs),
    totalCostMinor: money(o.totalCostMinor),
    purposeCostMinor: money(o.purposeCostMinor),
    unmeasuredJobs: num(o.unmeasuredJobs),
    ...(o.jobTimeInputs && typeof o.jobTimeInputs === 'object' ? { jobTimeInputs: o.jobTimeInputs } : {}),
    holds: o.holds === true && [o.totalJobMs, o.purposeJobMs].every((n) => typeof n === 'number' && Number.isFinite(n)),
  };
}

/**
 * Whether recorded shares already meet every protected floor (each purpose,
 * exploration together, system health, and commercial while a deadline is
 * open), to the precision the row is recorded at. Pure.
 */
export function sharesMeetFloors(shares: Record<ResearchPurpose, number>, urgentCommercialGoal: boolean): boolean {
  const eps = 1e-3;
  if (RESEARCH_PURPOSES.some((p) => !(shares[p] >= MIN_PURPOSE_SHARE - eps))) return false;
  if (shares.BROAD_DISCOVERY + shares.FORWARD_EXPLORATION < EXPLORATION_FLOOR - eps) return false;
  if (shares.SELF_IMPROVEMENT < SYSTEM_HEALTH_FLOOR - eps) return false;
  if (urgentCommercialGoal && shares.TRANSACTION_ROUTES < COMMERCIAL_FLOOR - eps) return false;
  return true;
}

/**
 * The consistent allocation window a pass's reading ends in: the
 * RESEARCH_ALLOCATION_WINDOW_MS period (a UTC day) containing its `until`.
 * Every pass reads the same 24-hour length of yield; the period is what "one
 * row per window" counts, so hourly passes over one day's yield are one window
 * and the next day's is the next. Null for an unreadable time. Pure.
 */
export function allocationWindowKey(until: string | null): string | null {
  const ms = until === null ? NaN : Date.parse(until);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / RESEARCH_ALLOCATION_WINDOW_MS) * RESEARCH_ALLOCATION_WINDOW_MS).toISOString();
}

/** The allocation window a recorded decision belongs to, or null. Pure. */
export function recordedWindowKey(detail: Record<string, unknown> | null): string | null {
  if (!detail) return null;
  if (typeof detail.windowKey === 'string') return detail.windowKey;
  const w = detail.window as { until?: unknown } | undefined;
  return allocationWindowKey(w && typeof w.until === 'string' ? w.until : null);
}

/** The decision rows probe r01.res-15-5 reads: the newest fifty. */
export const ALLOCATION_AUDIT_ROWS = 50;

/** One recorded decision that does not show its cost counted once, and why, read from that row alone. */
export interface PriorCostFailure {
  at: string;
  fingerprint: string;
  /** The cause read from the row's own recorded numbers (`diagnoseCostCountedOnce`). */
  cause: CostOnceCause;
  /** The cause the row itself recorded, when the code that wrote it recorded one. */
  recordedCause: string | null;
  /**
   * When the row's numbers cannot tell the cause apart (FLAG_DISAGREES or
   * NON_FINITE_JOB_TIME), what the window's job rows show
   * (`causeFromJobInputs`): read from the inputs the row recorded, or from
   * its window's job rows re-read — never inferred from the row's shape. Null
   * when the row's own numbers already show the cause.
   */
  shownByJobs: JobInputCause | null;
  /** The job-time inputs that cause was read from, and where they came from. */
  jobInputs: (JobTimeInputs & { source: 'RECORDED' | 'REREAD' }) | null;
  /** Which recorder wrote it: fingerprints without a leading `held` predate that change. */
  recorder: 'HELD_IN_FINGERPRINT' | 'BEFORE_HELD_IN_FINGERPRINT';
  jobMsGap: number | null;
  costGap: number | null;
  basis: string;
}

/** The window a decision row recorded, as a key and a readable window; null when it recorded none. */
export function recordedWindow(detail: Record<string, unknown> | null): { key: string; since: string; until: string } | null {
  const w = detail?.window as { since?: unknown; until?: unknown } | undefined;
  if (!w || typeof w.since !== 'string' || typeof w.until !== 'string') return null;
  return { key: `${w.since}|${w.until}`, since: w.since, until: w.until };
}

/** How many failing windows one pass re-reads job rows for, earliest first: a bound on the reads, not on what is recorded. */
export const PRIOR_WINDOW_REREADS = 6;

/** Whether a failure's own numbers leave its cause to the job rows. */
const needsJobInputs = (cause: CostOnceCause) => cause === 'FLAG_DISAGREES' || cause === 'NON_FINITE_JOB_TIME';

/**
 * The windows of the failing rows whose cause only their job rows can show
 * and that recorded no job inputs themselves, earliest first, at most `limit`.
 * Pure.
 */
export function priorWindowsToReread(rows: readonly { detail: Record<string, unknown> | null; at: string }[], limit = PRIOR_WINDOW_REREADS): { key: string; since: string; until: string }[] {
  const out = new Map<string, { key: string; since: string; until: string }>();
  for (const row of [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    const d = row.detail;
    if (!d || d.held === true) continue;
    const once = d.costCountedOnce as Record<string, unknown> | undefined;
    if (once && once.holds === true) continue;
    if (!needsJobInputs(diagnoseCostCountedOnce(once).cause)) continue;
    if (once && once.jobTimeInputs && typeof once.jobTimeInputs === 'object') continue;
    const w = recordedWindow(d);
    if (w && !out.has(w.key)) out.set(w.key, w);
    if (out.size >= limit) break;
  }
  return [...out.values()];
}

/**
 * The earliest cause of every recorded counted-once failure, read from the
 * production rows themselves rather than asserted by a repair (RES-15-5).
 * Where a row's own sums cannot tell its cause, the cause is read from its
 * window's job-time inputs — those the row recorded, or `reread` (its window's
 * job rows read again, keyed by `recordedWindow`) — and is NOT_SHOWN when
 * neither is available. Nothing is inferred from the row's shape.
 * Takes the decision rows newest first, keeps the measured ones (`held` is not
 * true — what the probe judges) whose `costCountedOnce.holds` is not true, and
 * diagnoses each from its own numbers. JSON writes NaN and Infinity as `null`,
 * so a non-finite sum reads as NON_FINITE_JOB_TIME; a row with no record at
 * all reads as NOT_RECORDED. Oldest first, so the first entry is the earliest
 * failure on record. Pure.
 */
export function diagnosePriorCostFailures(
  rows: readonly { detail: Record<string, unknown> | null; at: string }[],
  reread: ReadonlyMap<string, JobTimeInputs> = new Map(),
): {
  failures: PriorCostFailure[];
  causes: Partial<Record<CostOnceCause | JobInputCause, number>>;
  earliest: PriorCostFailure | null;
} {
  const failures: PriorCostFailure[] = [];
  for (const row of rows) {
    const d = row.detail;
    if (!d || d.held === true) continue;
    const once = d.costCountedOnce as Record<string, unknown> | undefined;
    if (once && once.holds === true) continue;
    const diagnosis = diagnoseCostCountedOnce(once);
    const fingerprint = typeof d.fingerprint === 'string' ? d.fingerprint : '?';
    let shownByJobs: JobInputCause | null = null;
    let jobInputs: PriorCostFailure['jobInputs'] = null;
    let jobBasis = '';
    if (needsJobInputs(diagnosis.cause)) {
      const recorded = once && once.jobTimeInputs && typeof once.jobTimeInputs === 'object' ? (once.jobTimeInputs as JobTimeInputs) : null;
      const w = recordedWindow(d);
      const again = w ? reread.get(w.key) ?? null : null;
      jobInputs = recorded ? { ...recorded, source: 'RECORDED' } : again ? { ...again, source: 'REREAD' } : null;
      const shown = causeFromJobInputs(jobInputs);
      shownByJobs = shown.cause;
      jobBasis = `; job rows (${jobInputs ? jobInputs.source.toLowerCase() : w ? 'not re-read' : 'no window recorded'}): ${shown.basis}`;
    }
    failures.push({
      at: row.at,
      fingerprint: fingerprint.slice(0, 400),
      cause: diagnosis.cause,
      recordedCause: once && typeof once.cause === 'string' ? once.cause : null,
      shownByJobs,
      jobInputs,
      recorder: fingerprint.startsWith('{"held"') ? 'HELD_IN_FINGERPRINT' : 'BEFORE_HELD_IN_FINGERPRINT',
      jobMsGap: diagnosis.jobMsGap,
      costGap: diagnosis.costGap,
      basis: `${diagnosis.detail}${jobBasis}`,
    });
  }
  failures.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const causes: Partial<Record<CostOnceCause | JobInputCause, number>> = {};
  for (const f of failures) {
    const c = f.shownByJobs && f.shownByJobs !== 'NOT_SHOWN' ? f.shownByJobs : f.cause;
    causes[c] = (causes[c] ?? 0) + 1;
  }
  return { failures, causes, earliest: failures[0] ?? null };
}

/** One allocation pass over the live goals. */
export async function reallocateResearch(input: { goals: GoalView[]; now?: string }, ports: ResearchAllocationPorts): Promise<ResearchAllocationReport> {
  const untilMs = input.now ? Date.parse(input.now) : Date.now();
  const window = { since: new Date(untilMs - RESEARCH_ALLOCATION_WINDOW_MS).toISOString(), until: new Date(untilMs).toISOString() };
  const live = input.goals.filter((g) => g.lifecycle === 'ACTIVE');
  const deadlines = live
    .filter((g) => g.target && g.dueAt && Date.parse(g.dueAt) > untilMs)
    .map((g) => (Date.parse(g.dueAt!) - untilMs) / 86_400_000);
  const urgentCommercialGoal = deadlines.length > 0;
  // The goals whose own deadlines put the commercial floor in force: what the decision means for a goal.
  const deadlineGoals = live.filter((g) => g.target && g.dueAt && Date.parse(g.dueAt) > untilMs).map((g) => g.id);
  const previous = await ports.lastDecision();
  // Tried means a recorded change was made, never that the last decision recommended one.
  const applied = ports.appliedRemedies && live.length > 0 ? await ports.appliedRemedies(live.map((g) => g.id)) : [];
  const { tried, measuring } = remediesFromApplied(applied, window);
  const reading = await ports.readYield(window);
  const pressure = purposePressureFrom(live, reading, untilMs);
  const laneCapacity = ports.readLaneCapacity ? await ports.readLaneCapacity(window.until) : [];
  const capacity = new Map(laneCapacity.map((one) => [one.lane, one]));
  const allocationInput = allocationInputFrom(reading, { urgentCommercialGoal, nearestDeadlineDays: deadlines.length ? Math.min(...deadlines) : null, triedRemedies: tried, measuringRemedies: measuring, pressure, capacity, remedyLevers: APPLICABLE_REMEDIES });
  const decided = decideResearchAllocation(allocationInput);
  const observed = normalizeShares(allocationInput.currentShares);
  // Shares move only on a reading whose cost is shown counted once. A reading
  // that cannot show it moves nothing — the shares in force, no change — and
  // is recorded as what it is: a measured window that failed the counted-once
  // check (`heldForCost`), never as `held`, which means nothing was measured.
  // Recording it as `held` hid a genuine double count from probe r01.res-15-5,
  // which reads only measured decisions; recorded this way it fails the probe.
  // The allocation stage still never applies it (`sharesInForceFrom`).
  // The cause is read from the reading as the reader returned it, before
  // `verifiedCostReading` coerces a non-finite sum to 0 — so the recorded row
  // says which way it failed (a NaN job time, a double count, float drift),
  // and no repair has to assert it.
  const diagnosis = diagnoseCostCountedOnce(reading.costCountedOnce);
  const costCountedOnce = { ...verifiedCostReading(reading.costCountedOnce), cause: diagnosis.cause, jobMsGap: diagnosis.jobMsGap };
  const heldForCost = !costCountedOnce.holds;
  // A held-for-cost row records the shares already in force — the previous
  // decision's, floors restored — never the raw usage: `shares` always means
  // shares Brain decided, so probe r01.res-07 (which reads every row not
  // `held`) never judges usage Brain did not choose. Raw usage stays in `observed`.
  const inForce = sharesInForceFrom(previous?.detail ?? null)?.shares ?? null;
  const decision: AllocationDecision = heldForCost
    ? {
        ...decided,
        shares: inForce && sharesMeetFloors(inForce, urgentCommercialGoal) ? normalizeShares(inForce) : enforceFloors(inForce ?? observed, urgentCommercialGoal),
        changes: [],
        notes: [`Held: the window's cost reading does not show each job's cost counted once (${diagnosis.cause}: ${diagnosis.detail}), so no share moves on it.`, ...decided.notes],
      }
    : decided;
  const fingerprint = allocationFingerprint({ ...decision, held: decision.held || heldForCost });
  const windowKey = allocationWindowKey(window.until);
  const history = ports.recentDecisions ? await ports.recentDecisions(ALLOCATION_AUDIT_ROWS) : previous ? [previous] : [];
  // A failing row written before job inputs were recorded has its window's job
  // rows read again (append-only event rows, so the same window reads the same jobs).
  const reread = new Map<string, JobTimeInputs>();
  for (const w of priorWindowsToReread(history)) {
    const again = (await ports.readYield({ since: w.since, until: w.until })).costCountedOnce.jobTimeInputs;
    if (again) reread.set(w.key, again);
  }
  const prior = diagnosePriorCostFailures(history, reread);
  const audit = { rowsRead: history.length, failing: prior.failures.length, causes: prior.causes, earliest: prior.earliest, failures: prior.failures.slice(-10) };
  const floors = {
    exploration: EXPLORATION_FLOOR,
    systemHealth: SYSTEM_HEALTH_FLOOR,
    commercial: urgentCommercialGoal ? COMMERCIAL_FLOOR : null,
    perPurpose: MIN_PURPOSE_SHARE,
  };
  const detail: Record<string, unknown> = {
    fingerprint,
    window,
    windowKey,
    shares: Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, round3(decision.shares[p])])),
    // What the window actually gave each purpose: what the goals tick compares the decided shares with.
    observed: Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, round3(observed[p])])),
    floors,
    held: decision.held,
    // A measured window whose cost was not shown counted once: nothing moved, and never applied.
    heldForCost,
    changes: decision.changes.map((c) => ({ purpose: c.purpose, from: round3(c.from), to: round3(c.to), reasons: c.reasons })),
    laneActions: decision.laneActions.map((a) => ({
      ...a,
      tried: tried.get(a.lane) ?? [],
      applied: applied.filter((one) => one.lane === a.lane).map((one) => ({ remedy: one.remedy, appliedAt: one.appliedAt, ref: one.ref })),
    })),
    // A free-lane ADD_CAPACITY is applied by the lane's own controller (`freeLane/capacity.ts`
    // `grantsFromDecision`), the one owner of its targets; any other lane's verdict is a recommendation.
    capacity: decision.capacity.map((c) => {
      const applied = c.kind === 'ADD_CAPACITY' && c.lane.startsWith(FREE_LANE_PREFIX);
      return { ...c, recommendationOnly: !applied, ...(applied ? { appliedBy: FREE_LANE_CONTROLLER } : {}) };
    }),
    bottlenecks: decision.capacity.filter((c) => c.resource !== null).map((c) => ({ lane: c.lane, resource: c.resource })),
    // The research capacity each lane was measured at in the window: what the capacity verdicts read.
    laneCapacity: Object.entries(reading.lanes).map(([lane, b]) => ({
      lane,
      utilization: round3(b.utilization),
      inFlight: b.inFlight,
      queueWaitMedianMs: b.queueWait.medianMs,
      // What the capacity verdict read: work waiting now, never the jobs above that already started.
      queuedNow: capacity.get(lane)?.queued ?? null,
      queuedWaitMs: capacity.get(lane)?.queueWaitMs ?? null,
      quotaHeadroom: capacity.get(lane)?.quotaHeadroom ?? null,
      incrementalCostPerUnit: capacity.get(lane)?.incrementalCostPerUnit ?? null,
      capacityBasis: capacity.get(lane)?.basis ?? ['not measured'],
      completions: b.completions,
      failures: b.failures.total,
      rateLimited: b.failures.rateLimited,
    })),
    deadlineGoals,
    // Each purpose's deadline and expected decision value, and the goals that put them there.
    pressure: Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, {
      nearestDeadlineDays: pressure[p].nearestDeadlineDays === null ? null : round3(pressure[p].nearestDeadlineDays!),
      decisionValue: pressure[p].decisionValue === null ? null : Math.round(pressure[p].decisionValue!),
      basis: pressure[p].basis.slice(0, 10),
    }])),
    liveGoals: live.length,
    costCountedOnce,
    // Every recorded counted-once failure the probe still reads, with the cause its own numbers show.
    priorCostFailures: audit,
    notes: [...decision.notes, ...reading.notes].slice(0, 20),
  };
  // One row per measured window (RES-15-5: yield is recorded "over consistent
  // windows"). Recording only on a changed fingerprint left a window whose
  // decision repeated the last one with no row of its own, so the newest
  // measured row could be days old and a failed counted-once row stayed the
  // newest. Now a measured pass — shares decided from yield, or held because
  // its cost was not shown counted once — records its window's decision the
  // first time that window is measured, even when nothing changed. Within a
  // window, a changed decision (a recovered cost reading, a new capacity
  // verdict) is recorded the pass it is measured, and an unchanged one never
  // twice. A pass with nothing measured is recorded only when it differs from
  // the newest row. `changed` means the decision differs from the newest row.
  const changed = !(previous && previous.detail.fingerprint === fingerprint);
  const newWindow = windowKey === null || recordedWindowKey(previous?.detail ?? null) !== windowKey;
  const measuredWindow = !decision.held || heldForCost;
  const recorded = changed || (measuredWindow && newWindow);
  if (recorded) {
    const summary = heldForCost
      ? "Research allocation held: the window's cost reading does not show each job's cost counted once."
      : decision.held
      ? 'Research allocation held: nothing in the window was measured.'
      : `Research reallocated: ${RESEARCH_PURPOSES.map((p) => `${p} ${(decision.shares[p] * 100).toFixed(1)}%`).join(', ')}`;
    await ports.recordDecision(summary.slice(0, 400), { ...detail, summary: summary.slice(0, 400) });
  }
  const toApply = remediesToApply(decision.laneActions, applied);
  const done: ResearchAllocationReport['applied'] = [];
  if (ports.applyRemedy && live.length > 0) {
    for (const one of toApply) {
      await ports.applyRemedy({ ...one, goalIds: live.map((g) => g.id) });
      done.push(one);
    }
  }
  return {
    applied: done,
    window,
    shares: decision.shares,
    floors,
    changed,
    held: decision.held || heldForCost,
    laneActions: decision.laneActions,
    capacity: decision.capacity,
    recorded,
    fingerprint,
  };
}

/** The newest Brain-wide research allocation decision row, or null. */
export async function latestResearchDecision(): Promise<{ detail: Record<string, unknown>; at: string } | null> {
  const { listImprovementEvents } = await import('../../repos/improvement.ts');
  const newest = (await listImprovementEvents({ kinds: [RESEARCH_ALLOCATION_DECIDED], limit: 1 }))[0];
  return newest ? { detail: newest.detail, at: newest.at } : null;
}

/** The production rows: the yield reader, the goals' applied remedies, and the Brain-wide decision row. */
export async function productionResearchAllocationPorts(): Promise<ResearchAllocationPorts> {
  const { researchYieldByPurpose, laneCapacityNow } = await import('./researchYield.ts');
  const { listWorkstreamEvents } = await import('../../repos/register.ts');
  const { recordImprovementEvent } = await import('../../repos/improvement.ts');
  return {
    readYield: (window) => researchYieldByPurpose(window),
    readLaneCapacity: (until) => laneCapacityNow(until),
    lastDecision: () => latestResearchDecision(),
    async recentDecisions(limit) {
      const { listImprovementEvents } = await import('../../repos/improvement.ts');
      return (await listImprovementEvents({ kinds: [RESEARCH_ALLOCATION_DECIDED], limit })).map((e) => ({ detail: e.detail, at: e.at }));
    },
    async appliedRemedies(goalIds) {
      const out: AppliedRemedy[] = [];
      for (const goalId of goalIds) {
        for (const e of await listWorkstreamEvents(goalId, 500)) {
          if (e.kind !== RESEARCH_REMEDY_APPLIED_EVENT) continue;
          const d = e.detail as { lane?: unknown; remedy?: unknown; ref?: unknown };
          if (typeof d.lane !== 'string' || typeof d.remedy !== 'string' || typeof d.ref !== 'string') continue;
          out.push({ lane: d.lane, remedy: d.remedy as LaneRemedy, appliedAt: e.createdAt, ref: d.ref });
        }
      }
      return out;
    },
    async applyRemedy({ lane, remedy, ref, goalIds }) {
      for (const goalId of goalIds) await recordRemedyApplied({ goalId, lane, remedy, ref, actorRef: 'BRAIN' });
    },
    async recordDecision(_summary, detail) {
      await recordImprovementEvent({ candidateId: null, kind: RESEARCH_ALLOCATION_DECIDED, detail });
    },
  };
}

let lastResearchAllocation = 0;

/** At most once an hour, from the goals tick. A failure is reported, never thrown into the tick. */
export async function reallocateResearchIfDue(
  input: { goals: GoalView[]; now?: string },
  ports?: ResearchAllocationPorts,
  clock: { nowMs?: number; force?: boolean } = {},
): Promise<ResearchAllocationReport | { error: string } | null> {
  const nowMs = clock.nowMs ?? Date.now();
  if (!clock.force && nowMs - lastResearchAllocation < RESEARCH_ALLOCATION_EVERY_MS) return null;
  lastResearchAllocation = nowMs;
  try {
    return await reallocateResearch(input, ports ?? (await productionResearchAllocationPorts()));
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}
