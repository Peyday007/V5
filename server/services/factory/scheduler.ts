/**
 * Which unit goes to which worker, and how many lanes to run.
 *
 * A pure function over a snapshot, kept apart from the code that fetches the
 * snapshot — §23's arrangement, for §23's reason: "why did this unit go to that
 * worker" has to be answerable from a recorded input rather than from a re-run
 * against a database that has since moved.
 *
 * Being pure also makes it useless as a safety mechanism, which is the point
 * worth stating plainly. Two schedulers can both correctly decide that a slot is
 * free and a unit is claimable, and both try to take it. Nothing here prevents
 * that and nothing here is supposed to: the exclusion is the compare-and-swap in
 * `claimUnits`, and the loser of that swap is refused rather than retried. This
 * module can under-assign and cannot over-assign.
 *
 * Two things it decides, in order:
 *
 *   1. **How many lanes.** From evidence the factory measured — first-pass
 *      success, contention, provider refusals — never from a number a person
 *      tuned. A person who had to choose a worker count would be doing the
 *      factory's job.
 *   2. **Which worker.** By capability for the role, then by model class, then by
 *      who has the most room. Reviewer assignment additionally *prefers* a
 *      worker that did not implement the work — a preference, because the
 *      authorization is the admission check at claim time and an allocator that
 *      believed its own preference was the guarantee would be the guarantee.
 */
import type {
  FactoryCapability,
  FactoryModelClass,
  FactoryRiskClass,
  FactoryRole,
  FactoryUnitKind,
} from '../../domain/factory.ts';
import { pathsOverlap } from '../../repos/factory.ts';
import { CAPABILITY_FOR_ROLE, type WorkerSlot } from './registry.ts';

/** The recommended operating ceiling, from §23's measured fleet rather than a guess. */
export const MAX_LANE_TARGET = 10;
export const MIN_LANE_TARGET = 1;
export const INITIAL_LANE_TARGET = 3;

export interface SchedulableUnit {
  id: string;
  unitKey: string;
  kind: FactoryUnitKind;
  role: FactoryRole;
  modelClass: FactoryModelClass;
  ownedPaths: string[];
  criticalPath: boolean;
  downstreamCount: number;
  priority: number;
  risk: FactoryRiskClass;
  attempt: number;
  maxAttempts: number;
}

export interface LiveLane {
  unitId: string;
  workerId: string;
  ownedPaths: string[];
}

/** What the factory has measured about itself, as the tuner's only input. */
export interface SchedulerEvidence {
  firstPassSuccessRate: number | null;
  /** Assignments refused this campaign because two units wanted one surface. */
  overlapRefusals: number;
  /** Provider refusals. Backpressure, so the answer is fewer lanes, never fewer attempts. */
  rateLimitedSessions: number;
  maxObservedConcurrency: number;
  mergedUnits: number;
  failedUnits: number;
}

export interface SchedulerSnapshot {
  at: string;
  campaignId: string;
  laneTarget: number;
  /** Units that are claimable right now, in no particular order. */
  candidates: SchedulableUnit[];
  live: LiveLane[];
  slots: WorkerSlot[];
  evidence: SchedulerEvidence;
  /**
   * Sessions that have already implemented something in this campaign, by worker.
   *
   * Used only as a preference when choosing a reviewer. The guarantee is the
   * admission check; this is how the allocator avoids walking into it.
   */
  implementedBy: Record<string, string[]>;
}

export interface Assignment {
  unitId: string;
  workerId: string;
  role: FactoryRole;
  model: string;
  reason: string;
}

export interface Refusal {
  unitId: string | null;
  workerId: string | null;
  reason: string;
}

export interface SchedulerDecision {
  assignments: Assignment[];
  refusals: Refusal[];
  laneTarget: number;
  laneTargetReason: string;
  /** Lanes the decision could have filled but chose not to, and why. */
  idleSlots: number;
}

/**
 * How many lanes to run, from evidence.
 *
 * Ordered so the reasons that should win do win: a provider refusal lowers the
 * target whatever else is true, because running more lanes into a refusing
 * surface converts throughput into refusals. Contention lowers it next, because
 * two lanes fighting over one surface is one lane plus waste. Only a campaign
 * that is merging cleanly and using everything it has is allowed to grow.
 */
export function tuneLaneTarget(
  current: number,
  evidence: SchedulerEvidence,
  demand: number,
  availableSlots: number,
): { target: number; reason: string } {
  const clamp = (value: number): number =>
    Math.max(MIN_LANE_TARGET, Math.min(MAX_LANE_TARGET, value));

  if (evidence.rateLimitedSessions > 0 && current > MIN_LANE_TARGET) {
    return {
      target: clamp(current - 1),
      reason:
        `${evidence.rateLimitedSessions} provider refusal(s) observed: fewer lanes, same ` +
        'evidence bar, no attempt charged.',
    };
  }
  if (evidence.overlapRefusals > Math.max(2, evidence.mergedUnits) && current > MIN_LANE_TARGET) {
    return {
      target: clamp(current - 1),
      reason:
        `${evidence.overlapRefusals} assignment(s) refused for overlapping ownership: the graph ` +
        'is narrower than the lane count.',
    };
  }
  if (
    evidence.firstPassSuccessRate !== null &&
    evidence.firstPassSuccessRate < 0.4 &&
    evidence.mergedUnits >= 3 &&
    current > MIN_LANE_TARGET
  ) {
    return {
      target: clamp(current - 1),
      reason:
        `first-pass success ${(evidence.firstPassSuccessRate * 100).toFixed(0)}% over ` +
        `${evidence.mergedUnits} merges: smaller units before more of them.`,
    };
  }
  if (
    demand > current &&
    availableSlots > current &&
    (evidence.firstPassSuccessRate === null || evidence.firstPassSuccessRate >= 0.6) &&
    evidence.rateLimitedSessions === 0 &&
    current < MAX_LANE_TARGET
  ) {
    return {
      target: clamp(current + 1),
      reason:
        `${demand} independent unit(s) waiting on ${availableSlots} free slot(s) with no ` +
        'refusals: one more lane.',
    };
  }
  return { target: clamp(current), reason: 'unchanged: no evidence to move it' };
}

/**
 * Order the work.
 *
 * Critical path first, then what the most other units are waiting on, then an
 * interface ahead of the implementations behind it, then a test that could
 * expose an architectural error before six lanes build on it, then declared
 * priority. A scheduler that merely took the next row would spend its widest
 * parallelism on leaves and then serialise on the interface nobody wrote.
 */
export function orderCandidates(candidates: SchedulableUnit[]): SchedulableUnit[] {
  const kindRank: Record<FactoryUnitKind, number> = {
    INTERFACE: 0,
    MIGRATION: 1,
    TEST: 2,
    IMPLEMENTATION: 3,
    REPAIR: 3,
    INTEGRATION: 4,
    DOCS: 5,
    REVIEW: 6,
    VERIFICATION: 7,
  };
  return [...candidates].sort((a, b) => {
    if (a.criticalPath !== b.criticalPath) return a.criticalPath ? -1 : 1;
    if (a.downstreamCount !== b.downstreamCount) return b.downstreamCount - a.downstreamCount;
    if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind] - kindRank[b.kind];
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.unitKey.localeCompare(b.unitKey);
  });
}

/**
 * Which model class this unit deserves.
 *
 * The strongest available reasoning for architecture, contract interpretation,
 * integration, hard debugging and final review; a faster one for bounded
 * implementation, mechanical work and routine verification. A repair that has
 * already failed twice is promoted: the third identical attempt by the same
 * class of model is the definition of repeating a failed strategy.
 */
export function modelClassFor(unit: SchedulableUnit): FactoryModelClass {
  if (unit.role === 'ARCHITECT' || unit.role === 'REVIEWER' || unit.role === 'INTEGRATOR') {
    return 'STRONGEST';
  }
  if (unit.risk === 'HIGH' || unit.criticalPath) return 'STRONGEST';
  if (unit.attempt >= 2) return 'STRONGEST';
  return unit.modelClass;
}

function canHold(slot: WorkerSlot, capability: FactoryCapability): boolean {
  return slot.freeSlots > 0 && slot.capabilities.includes(capability);
}

/**
 * Pick a worker for one unit.
 *
 * Exported so the choice is testable on its own: the preference ladder is the
 * part most likely to be argued about, and an argument about it should be
 * settled against a function rather than against a campaign.
 */
export function chooseWorker(
  unit: SchedulableUnit,
  slots: WorkerSlot[],
  options: { preferNotWorkers?: string[] } = {},
): { slot: WorkerSlot; reason: string } | { slot: null; reason: string } {
  const capability = CAPABILITY_FOR_ROLE[unit.role];
  const eligible = slots.filter((slot) => canHold(slot, capability));
  if (eligible.length === 0) {
    return {
      slot: null,
      reason: `no free slot holds ${capability}`,
    };
  }

  const wanted = modelClassFor(unit);
  const avoid = new Set(options.preferNotWorkers ?? []);

  const rank = (slot: WorkerSlot): number => {
    let score = 0;
    // Independence first among preferences: a reviewer that did not implement
    // the work is the assignment most likely to be admitted at claim time.
    if (avoid.has(slot.workerId)) score += 100;
    if (slot.modelClass !== wanted && slot.modelClass !== 'EITHER') score += 10;
    // Spread the load: the worker with the most room goes first, so one worker
    // does not become a queue while another sits idle.
    score -= slot.freeSlots;
    return score;
  };

  const sorted = [...eligible].sort((a, b) => {
    const difference = rank(a) - rank(b);
    return difference !== 0 ? difference : a.name.localeCompare(b.name);
  });
  const chosen = sorted[0];
  if (!chosen) return { slot: null, reason: `no free slot holds ${capability}` };

  const notes: string[] = [`holds ${capability}`];
  notes.push(
    chosen.modelClass === wanted || chosen.modelClass === 'EITHER'
      ? `model class ${wanted}`
      : `model class ${chosen.modelClass} where ${wanted} was preferred`,
  );
  if (avoid.has(chosen.workerId)) {
    notes.push('already implemented here; separation will be decided at claim time');
  }
  return { slot: chosen, reason: notes.join('; ') };
}

/**
 * The decision.
 *
 * Never launches extra lanes onto work that is inherently sequential: a unit
 * whose ownership overlaps something already running is refused with that
 * reason, and the graph — not the lane count — is what decides how wide the
 * campaign can be.
 */
export function decide(snapshot: SchedulerSnapshot): SchedulerDecision {
  const refusals: Refusal[] = [];
  const assignments: Assignment[] = [];

  const availableSlots = snapshot.slots.reduce((sum, slot) => sum + slot.freeSlots, 0);
  const ordered = orderCandidates(snapshot.candidates);

  const tuned = tuneLaneTarget(
    snapshot.laneTarget,
    snapshot.evidence,
    ordered.length,
    availableSlots,
  );

  if (availableSlots === 0) {
    refusals.push({
      unitId: null,
      workerId: null,
      reason:
        snapshot.slots.length === 0
          ? 'NO_HEALTHY_EXECUTION_SURFACE: no worker is registered for this repository.'
          : 'NO_HEALTHY_EXECUTION_SURFACE: every slot is busy, paused, quarantined or deferred.',
    });
    return {
      assignments,
      refusals,
      laneTarget: tuned.target,
      laneTargetReason: tuned.reason,
      idleSlots: 0,
    };
  }

  // A working copy, so the decision accounts for what it has already handed out.
  const slots = snapshot.slots.map((slot) => ({ ...slot }));
  const heldSurfaces = snapshot.live.map((lane) => lane.ownedPaths);
  const lanesInUse = snapshot.live.length;
  const room = Math.max(0, tuned.target - lanesInUse);

  for (const unit of ordered) {
    if (assignments.length >= room) {
      refusals.push({
        unitId: unit.id,
        workerId: null,
        reason: `lane target ${tuned.target} reached (${lanesInUse} already running)`,
      });
      continue;
    }
    if (unit.attempt >= unit.maxAttempts) {
      refusals.push({
        unitId: unit.id,
        workerId: null,
        reason: `attempts exhausted (${unit.attempt}/${unit.maxAttempts})`,
      });
      continue;
    }
    const overlapping = heldSurfaces.some((paths) => pathsOverlap(paths, unit.ownedPaths));
    if (overlapping) {
      refusals.push({
        unitId: unit.id,
        workerId: null,
        reason:
          'mutation surface overlaps work already running; serialised rather than run in parallel',
      });
      continue;
    }

    const chosen = chooseWorker(unit, slots, {
      preferNotWorkers:
        unit.role === 'REVIEWER' || unit.role === 'VERIFIER'
          ? Object.keys(snapshot.implementedBy)
          : [],
    });
    if (!chosen.slot) {
      refusals.push({ unitId: unit.id, workerId: null, reason: chosen.reason });
      continue;
    }

    assignments.push({
      unitId: unit.id,
      workerId: chosen.slot.workerId,
      role: unit.role,
      model: chosen.slot.model,
      reason: chosen.reason,
    });
    chosen.slot.freeSlots -= 1;
    heldSurfaces.push(unit.ownedPaths);
  }

  return {
    assignments,
    refusals,
    laneTarget: tuned.target,
    laneTargetReason: tuned.reason,
    idleSlots: slots.reduce((sum, slot) => sum + slot.freeSlots, 0),
  };
}
