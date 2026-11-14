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
import { getWorkstream, recordWorkstreamEvent } from '../../repos/register.ts';
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
import type { ResearchYieldReading } from './researchYield.ts';
import {
  COMMERCIAL_FLOOR,
  EXPLORATION_FLOOR,
  LANE_REMEDIES,
  MIN_PURPOSE_SHARE,
  RESEARCH_PURPOSES,
  SYSTEM_HEALTH_FLOOR,
  decideResearchAllocation,
  binPriorityShift,
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
import { getDb } from '../../db/database.ts';

export interface GoalTickReport {
  goals: number;
  held: { binId: string; goalId: string; reason: HoldReason }[];
  released: { binId: string; goalId: string; why: string }[];
  reprioritized: { binId: string; goalId: string; priority: number }[];
  moved: { goalId: string; from: number | null; to: number; reason: string }[];
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

export interface ResearchApplication {
  /** The decision applied, by its fingerprint. */
  fingerprint: string | null;
  shifts: Record<ResearchPurpose, PriorityShift>;
  belowFloor: ResearchPurpose[];
  /** Goal bins whose priority the step moved off their goal's rank. */
  goalBins: { binId: string; purposes: string[]; shift: PriorityShift }[];
  /** Bins no goal pursues, raised because a purpose they serve is below a protected floor. */
  floorRaised: { binId: string; purposes: string[]; from: number; to: number }[];
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
  // Archived goals are not derived here: they hold nothing and rank nowhere,
  // and there are more of them after every deploy. A hold one left behind is
  // released below, and its owner read directly (tests/goalTickCost.test.ts).
  const snapshot = await assembleGoals({ projectIds: null, includeArchived: false, now: options?.now });
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
  const inForce = await researchInForce(snapshot.goals);
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
  // A bin no goal pursues has no rank to return to, so it is only ever raised,
  // and only while a purpose it serves sits below a protected floor.
  if (application && application.belowFloor.length > 0) {
    const floorPriority = binPriorityForRank(0);
    for (const bin of liveBins) {
      if (owners.has(bin.id) || bin.heldByWorkstreamId || bin.priority >= floorPriority) continue;
      const purposes = binPurposes.get(bin.id) ?? [];
      if (!purposes.some((p) => (application.belowFloor as readonly string[]).includes(p))) continue;
      if (await setLiveBinPriority(bin.id, floorPriority)) application.floorRaised.push({ binId: bin.id, purposes, from: bin.priority, to: floorPriority });
    }
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

  return report;
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
    held: detail.held === true,
    urgentCommercialGoal: typeof floors?.commercial === 'number',
    fingerprint: typeof detail.fingerprint === 'string' ? detail.fingerprint : null,
  };
}

/** The decision in force: the newest recorded on a live goal, unless it was held. */
async function researchInForce(goals: GoalView[]): Promise<{ shares: SharesInForce; fingerprint: string | null } | null> {
  const live = goals.filter((g) => g.lifecycle === 'ACTIVE');
  if (live.length === 0) return null;
  const ports = await productionResearchAllocationPorts();
  const parsed = sharesInForceFrom(await ports.lastDecision(live[0]!.id));
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
 *   * It records one append-only `GOAL_RESEARCH_REALLOCATED` event on every live
 *     goal, carrying the five shares, the floors that held, every reason, the
 *     lane remedies and the capacity verdicts. That is the decision made
 *     visible on the surface that already shows a goal's history (the goal's
 *     events). The research purposes are Brain-wide, so every live goal carries
 *     the same decision; the closed project event vocabulary has no member for
 *     it, and this pass does not widen it.
 *   * A low-actionability lane is given its next remedy (question design, then
 *     evidence sources, then model routing) before any limit is raised for it,
 *     and a remedy already recorded for a lane is passed back as tried.
 *   * A capacity change is only ever recorded as a recommendation naming the
 *     measured constraint and its cost. The pass starts no work, spends
 *     nothing, raises no limit and takes no worker's item. It does not write bin
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
export const RESEARCH_REALLOCATED_EVENT = 'GOAL_RESEARCH_REALLOCATED';

export interface ResearchAllocationReport {
  window: { since: string; until: string };
  shares: Record<ResearchPurpose, number>;
  floors: { exploration: number; systemHealth: number; commercial: number | null; perPurpose: number };
  changed: boolean;
  held: boolean;
  laneActions: AllocationDecision['laneActions'];
  /** Capacity verdicts; an ADD_CAPACITY is a recommendation only. */
  capacity: AllocationDecision['capacity'];
  recordedOn: string[];
  fingerprint: string;
}

export interface ResearchAllocationPorts {
  readYield(window: { since: string; until: string }): Promise<ResearchYieldReading>;
  /** The newest recorded decision's detail on a goal, or null. */
  lastDecision(goalId: string): Promise<Record<string, unknown> | null>;
  recordGoal(goalId: string, summary: string, detail: Record<string, unknown>): Promise<void>;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The measured inputs one window gives the decision. Pure. */
export function allocationInputFrom(
  reading: ResearchYieldReading,
  context: { urgentCommercialGoal: boolean; nearestDeadlineDays: number | null; triedRemedies: Map<string, LaneRemedy[]> },
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
      ...(p === 'TRANSACTION_ROUTES' && context.nearestDeadlineDays !== null ? { nearestDeadlineDays: context.nearestDeadlineDays } : {}),
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
    });
    const attempts = b.completions + b.failures.total;
    bottlenecks.push({
      lane,
      purposes: served,
      resource: b.failures.rateLimited > 0 ? 'MODEL_RATE_LIMIT' : null,
      qualifiedQueued: b.inFlight,
      queueWaitMs: b.queueWait.medianMs,
      measuredMachineLimit: b.failures.rateLimited > 0,
      // Nothing in the window measures quota headroom or the cost of another unit: unknown, never assumed.
      quotaHeadroom: null,
      reliability: attempts > 0 ? b.completions / attempts : null,
      ownedByAnotherWorker: false,
      incrementalCostPerUnit: null,
    });
  }
  return { currentShares, purposes, lanes, bottlenecks, urgentCommercialGoal: context.urgentCommercialGoal };
}

/** What makes two decisions the same: shares to a tenth of a percent, lane remedies and capacity verdicts. */
export function allocationFingerprint(decision: AllocationDecision): string {
  return JSON.stringify({
    shares: RESEARCH_PURPOSES.map((p) => round3(decision.shares[p])),
    lanes: decision.laneActions.map((a) => `${a.lane}:${a.kind}`).sort(),
    capacity: decision.capacity.map((c) => `${c.lane}:${c.kind}:${c.units}`).sort(),
  });
}

/** Remedies already recorded for each lane, from the newest decision: passed back so the next one is tried. */
export function triedRemediesFrom(detail: Record<string, unknown> | null): Map<string, LaneRemedy[]> {
  const out = new Map<string, LaneRemedy[]>();
  const actions = Array.isArray(detail?.laneActions) ? (detail!.laneActions as { lane?: unknown; remedy?: unknown; tried?: unknown }[]) : [];
  for (const a of actions) {
    if (typeof a.lane !== 'string') continue;
    const tried = Array.isArray(a.tried) ? a.tried.filter((r): r is LaneRemedy => (LANE_REMEDIES as readonly string[]).includes(String(r))) : [];
    const now = typeof a.remedy === 'string' && (LANE_REMEDIES as readonly string[]).includes(a.remedy) ? [a.remedy as LaneRemedy] : [];
    out.set(a.lane, [...new Set([...tried, ...now])]);
  }
  return out;
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
  const previous = live.length > 0 ? await ports.lastDecision(live[0]!.id) : null;
  const tried = triedRemediesFrom(previous);
  const reading = await ports.readYield(window);
  const allocationInput = allocationInputFrom(reading, { urgentCommercialGoal, nearestDeadlineDays: deadlines.length ? Math.min(...deadlines) : null, triedRemedies: tried });
  const decision = decideResearchAllocation(allocationInput);
  const observed = normalizeShares(allocationInput.currentShares);
  const fingerprint = allocationFingerprint(decision);
  const floors = {
    exploration: EXPLORATION_FLOOR,
    systemHealth: SYSTEM_HEALTH_FLOOR,
    commercial: urgentCommercialGoal ? COMMERCIAL_FLOOR : null,
    perPurpose: MIN_PURPOSE_SHARE,
  };
  const detail: Record<string, unknown> = {
    fingerprint,
    window,
    shares: Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, round3(decision.shares[p])])),
    // What the window actually gave each purpose: what the goals tick compares the decided shares with.
    observed: Object.fromEntries(RESEARCH_PURPOSES.map((p) => [p, round3(observed[p])])),
    floors,
    held: decision.held,
    changes: decision.changes.map((c) => ({ purpose: c.purpose, from: round3(c.from), to: round3(c.to), reasons: c.reasons })),
    laneActions: decision.laneActions.map((a) => ({ ...a, tried: tried.get(a.lane) ?? [] })),
    capacity: decision.capacity.map((c) => ({ ...c, recommendationOnly: true })),
    bottlenecks: decision.capacity.filter((c) => c.resource !== null).map((c) => ({ lane: c.lane, resource: c.resource })),
    costCountedOnce: reading.costCountedOnce,
    notes: [...decision.notes, ...reading.notes].slice(0, 20),
  };
  const recordedOn: string[] = [];
  for (const goal of live) {
    const last = goal.id === live[0]?.id ? previous : await ports.lastDecision(goal.id);
    if (last && last.fingerprint === fingerprint) continue;
    const summary = decision.held
      ? 'Research allocation held: nothing in the window was measured.'
      : `Research reallocated: ${RESEARCH_PURPOSES.map((p) => `${p} ${(decision.shares[p] * 100).toFixed(1)}%`).join(', ')}`;
    await ports.recordGoal(goal.id, summary.slice(0, 400), detail);
    recordedOn.push(goal.id);
  }
  return {
    window,
    shares: decision.shares,
    floors,
    changed: recordedOn.length > 0,
    held: decision.held,
    laneActions: decision.laneActions,
    capacity: decision.capacity,
    recordedOn,
    fingerprint,
  };
}

/** The production rows: the yield reader, the goal's own event history, and the project event log. */
export async function productionResearchAllocationPorts(): Promise<ResearchAllocationPorts> {
  const { researchYieldByPurpose } = await import('./researchYield.ts');
  const { listWorkstreamEvents } = await import('../../repos/register.ts');
  return {
    readYield: (window) => researchYieldByPurpose(window),
    async lastDecision(goalId) {
      const events = await listWorkstreamEvents(goalId, 200);
      const newest = events.find((e) => e.kind === RESEARCH_REALLOCATED_EVENT);
      return newest ? (newest.detail as Record<string, unknown>) : null;
    },
    async recordGoal(goalId, summary, detail) {
      await recordWorkstreamEvent({ workstreamId: goalId, kind: RESEARCH_REALLOCATED_EVENT, summary, detail, actorRef: 'BRAIN' });
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
