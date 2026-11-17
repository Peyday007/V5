/**
 * What pressing Start Cash Mode actually authorizes, and the row that says so.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists to remove
 * ---------------------------------------------------------------------------
 *
 * Activation created a mode row, a layer and ten discovery buckets, and nothing
 * a launch could run under. `standingAuthority` refuses every launch on a
 * project with no grant, correctly, so all ten captured ideas parked with
 * `no standing authority exists for this project` recorded in a JSON column no
 * surface reads. The sprint was, in production, a section that could open
 * questions and answer none of them — §24's *waiting nobody can resolve* at a
 * new altitude, and worse than the usual case because the remedy was a form
 * nobody was being shown.
 *
 * The remedy is not another form. **Start Cash Mode is the authorization.** A
 * person deciding to run a cash sprint has decided that Brain may read
 * published sources, research and validate openings, keep the evidence, compare
 * what it finds, calculate from accepted evidence and prepare recommended
 * plans. Asking them to then fill in a research grant is asking twice for one
 * decision, and the second ask is the one that gets left un-answered.
 *
 * ---------------------------------------------------------------------------
 * What it does not authorize, and why that is structural
 * ---------------------------------------------------------------------------
 *
 * Nothing that touches the world. No contact, no purchase, no spending, no
 * accepted terms, no commitment, no publication, no operating an opportunity
 * externally. That is not a promise in this comment: `createGoal` and
 * `ensureGoal` union `ALWAYS_PROHIBITED` into every grant and write
 * `max_external_spend = 0` as a literal, so a grant that permitted any of them
 * cannot be written by this module, by a script, by a screen or by a migration.
 * Every commercial effect is a `COMMERCIAL_ACTION` under a separate grant a
 * person makes deliberately (§30), and this file neither reads nor writes one.
 *
 * ---------------------------------------------------------------------------
 * One grant, decided by the database
 * ---------------------------------------------------------------------------
 *
 * The tick runs every few seconds, on more than one instance, and both halves
 * of a check-then-write can read "there is no grant here". So the arbiter is
 * `idx_russell_goals_one_live_cash_discovery`, a partial unique index, and the
 * loser of the race reads back the winner's row. The seventh time this codebase
 * has needed a compare-and-swap on a value the claimant does not supply.
 */
import {
  authorityNow,
  ensureGoal,
  liveGoalNamed,
  revokeGoal,
  setGoalConcurrency,
  spendTotals,
} from '../../repos/russellAuthority.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { resumeParkedForProject } from '../russell/resumeParked.ts';
import { researchSurfacesOnRecord } from './researchRoom.ts';
import { capacityChangeGate } from './screenMetrics.ts';
import type { RussellGoal } from '../../domain/types.ts';

/**
 * The grant's name, and the identity the unique index is written against.
 *
 * A constant rather than a derived string: the index predicate compares against
 * this exact literal, so a name built per project would make the index match
 * nothing and the one-per-project rule would quietly stop being enforced.
 */
export const CASH_DISCOVERY_AUTHORITY_NAME = 'Cash Mode internal discovery';

/** The work class a research launch is checked against. Unchanged. */
const RESEARCH_WORK = 'RESEARCH';

/**
 * How many of this sprint's missions may be in flight at once.
 *
 * The one limit on it that is real. §24 removed the lifetime quotas because
 * nothing they rationed was scarce — the subscription behind a research mission
 * is already paid for — and left concurrency, which is provider capacity rather
 * than an allowance.
 *
 * **It was two, and its own reasoning was wrong.** That comment said two left a
 * fleet with something "for the validation work those missions create", and one
 * grant governs discovery *and* validation alike — so the number could not
 * reserve anything for anybody. It capped the total, and the queue handed both
 * slots to whatever arrived first. What actually orders the two is
 * `CompilerProfile.launchOrdinal`, which is a different mechanism entirely.
 *
 * Production then measured the cost of the number itself. Two long discovery
 * missions held both slots while twenty-four filed openings waited to be
 * qualified, and the deep dives — correctly ranked first, with a compiled
 * specification and nothing else wrong with them — simply had nowhere to run.
 * Meanwhile the fleet sat **idle**: four eligible Routines, nothing in flight,
 * three hundred and seventeen fires on the first with two refusals.
 *
 * Six, which is bounded by what has actually been observed rather than chosen
 * to sound safe: §22 records a measured operating ceiling of ten concurrent
 * bins on one Routine, and this fleet has four. It is still a ceiling and still
 * refuses the seventh, and it authorizes nothing — every mission it admits
 * passes the same envelope, the same evidence gate and the same three audit
 * roles it did at two.
 */
export const DISCOVERY_CONCURRENCY = 6;

/**
 * The concurrency this sprint's grant should carry: the fleet it actually has,
 * never less than `DISCOVERY_CONCURRENCY`.
 *
 * **Six was a constant, and the fleet grew past it.** It was written when the
 * fleet had four research Routines on one account. Production on 2026-10-20 had
 * research Routines on three Claude accounts — and six live missions held every
 * slot, so a recovered account had nothing it could be handed: a Routine back
 * from quarantine checked in and was told there was no work, while the
 * discovery and qualification it could have run waited for a slot. That is the
 * idleness beside executable work this file's own rule calls a defect, made by a
 * number rather than by a fault.
 *
 * So the ceiling is the count of research surfaces the project has on record
 * (`researchSurfacesOnRecord`), with six as the floor so a fleet that cannot be
 * read, or a small one, keeps the bound it always had. Still provider capacity
 * rather than an allowance: it authorizes nothing, every mission it admits meets
 * the same envelope, gate and audit roles, and the dispatcher's own fleet,
 * account and Routine targets still bound how many sessions are fired.
 *
 * Null when the fleet cannot be read: the caller leaves the grant alone.
 */
export async function discoveryConcurrencyFor(projectId: string): Promise<number | null> {
  const onRecord = await researchSurfacesOnRecord(projectId);
  if (onRecord === null) return null;
  return Math.max(DISCOVERY_CONCURRENCY, onRecord);
}

/**
 * How far the free lane may lift a discovery grant above the surfaces on record.
 *
 * §78 grows a goal's search with the idle fleet, and `discoveryConcurrencyFor`
 * counted the fleet as Claude Routines only. Production, 2026-11-16 21:07Z: the
 * free lane (a GPU billed by the hour, and a free model) had nothing queued
 * while 508 ideas waited in projects whose grant was at its at-once ceiling,
 * 13 slots across them. The lane is research capacity this grant's missions
 * feed, so its measured headroom lifts the ceiling, and the lift is a
 * controller's output (§86), never a typed number:
 *
 * - **grow** only while the grant is full and the lane has measured spare
 *   (`freeLaneSpareSurfaces`: proven room less busy and less already queued,
 *   zero while its answers mostly fail), a few missions per step;
 * - **shrink** while the lane's queue backs up (no spare and work waiting), or
 *   the database is saturated, or Brain's CPU is pinned with work waiting;
 * - **hold** otherwise, and step at most once per `LANE_STEP_MS`, so missions
 *   that have not yet queued their fragments are not counted as idle room.
 *
 * Bounded by `LANE_LIFT_MAX` above the floor. It is concurrency, not money: the
 * grant still writes `max_external_spend = 0`, and the lane's GPU is paid by
 * the hour whether it is fed or not. Fairness and order are unchanged: each
 * project's grant moves by its own reading, and the launch pass still takes the
 * most important idea first (`nextLaunchable`).
 */
export const LANE_LIFT_MAX = 48;
export const LANE_GROW_STEP_MAX = 4;
export const LANE_STEP_MS = 2 * 60_000;
/** Brain's CPU (0-1, `brainCpu`) at which waiting work shrinks the lift rather than holding it. */
export const LANE_CPU_SHRINK = 0.95;

export interface LaneReading {
  /** The lane's spare in surfaces (`freeLaneSpareSurfaces`). */
  spare: number;
  /** Free-lane jobs queued and claimable now. */
  waiting: number;
  /** The lane controller's last pressure reading, or null when this process has none. */
  pressure: { db: boolean; cpu: number } | null;
}

/**
 * The grant's next ceiling from the lane's headroom. Pure.
 *
 * `floor` is the Routine-based ceiling, `current` what the grant carries, `live`
 * the missions holding a slot now.
 */
export function laneAdaptiveCeiling(input: {
  floor: number;
  current: number;
  live: number;
  lane: LaneReading | null;
}): { target: number; why: string } {
  const { floor, lane } = input;
  const max = floor + LANE_LIFT_MAX;
  const current = Math.min(max, Math.max(floor, input.current));
  if (!lane) return { target: floor, why: 'the free lane is not configured or cannot be read: the surfaces on record' };
  const pressed = lane.pressure !== null && (lane.pressure.db || (lane.pressure.cpu >= LANE_CPU_SHRINK && lane.waiting > 0));
  const backlog = lane.spare === 0 && lane.waiting > 0;
  if ((pressed || backlog) && current > floor) {
    const step = Math.max(1, Math.ceil((current - floor) / 4));
    return {
      target: Math.max(floor, current - step),
      why: pressed
        ? `the free lane is under pressure (${lane.pressure!.db ? 'database saturated' : `Brain CPU ${Math.round(lane.pressure!.cpu * 100)}%`}, ${lane.waiting} job(s) waiting)`
        : `the free lane's queue is backing up (${lane.waiting} job(s) waiting, no spare)`,
    };
  }
  if (!pressed && lane.spare > 0 && input.live >= current && current < max) {
    return {
      target: Math.min(max, current + Math.min(LANE_GROW_STEP_MAX, lane.spare)),
      why: `every slot is held and the free lane has ${lane.spare} spare surface(s) with ${lane.waiting} job(s) waiting`,
    };
  }
  return { target: current, why: 'the free lane neither has spare beside a full grant nor is backing up' };
}

const laneSteps = new Map<string, number>();

/** The lane's headroom now; null when there is no lane or it cannot be read. */
async function readLane(nowMs: number): Promise<LaneReading | null> {
  try {
    const { laneConfig } = await import('../cheap/lane.ts');
    if (!laneConfig()) return null;
    const { freeLaneSpareSurfaces, lastControlReading, waitingNow } = await import('../freeLane/capacity.ts');
    const reading = lastControlReading();
    return {
      spare: await freeLaneSpareSurfaces(nowMs),
      waiting: await waitingNow(),
      pressure: reading ? { db: reading.pressure.db, cpu: reading.pressure.cpu } : null,
    };
  } catch {
    return null;
  }
}

/**
 * The ceiling a grant should carry: the Routine floor, lifted by the lane's
 * measured headroom. Null when the fleet cannot be read (the grant is left alone).
 */
export async function adaptiveDiscoveryConcurrency(
  projectId: string,
  goal: Pick<RussellGoal, 'id' | 'maxConcurrent'>,
  nowMs = Date.now(),
): Promise<{ target: number; why: string } | null> {
  const floor = await discoveryConcurrencyFor(projectId);
  if (floor === null) return null;
  const { laneConfig } = await import('../cheap/lane.ts');
  if (!laneConfig()) return laneAdaptiveCeiling({ floor, current: goal.maxConcurrent, live: 0, lane: null });
  const last = laneSteps.get(goal.id) ?? 0;
  if (goal.maxConcurrent >= floor && nowMs - last < LANE_STEP_MS) {
    return { target: Math.min(floor + LANE_LIFT_MAX, goal.maxConcurrent), why: 'held: the lane was read less than two minutes ago' };
  }
  const lane = await readLane(nowMs);
  const { live } = await spendTotals(goal.id, 'MISSION', authorityNow());
  const next = laneAdaptiveCeiling({ floor, current: goal.maxConcurrent, live, lane });
  laneSteps.set(goal.id, nowMs);
  return next;
}

export interface EnsuredAuthority {
  goal: RussellGoal;
  /** True only on the tick that actually wrote it. */
  created: boolean;
}

/**
 * The live discovery grant for one cash project, created if it is absent.
 *
 * Idempotent by the index, so it is safe to call from activation *and* from
 * every tick — which is what reconciles a sprint that was activated before this
 * existed without anybody pressing anything. That is the same distinction
 * `rearmSurfaceDeferredIntents` draws and the fifth time this repository has
 * needed it: a hook fixes one entrance, and rows reach every entrance plus
 * everything already stranded.
 *
 * Returns null when there is no cash mode, which is not a failure: most
 * projects hold no sprint and the tick asks about all of them.
 */
export async function ensureDiscoveryAuthority(
  projectId: string,
): Promise<EnsuredAuthority | null> {
  const mode = await getCashMode(projectId);
  if (!mode) return null;
  // An archived sprint is not running discovery, and a live research grant on a
  // project nobody is working is a widening nobody asked for. Winding down is
  // deliberately not here: §30 keeps delivery, collection and the research that
  // supports an existing obligation working in every state.
  if (mode.state === 'ARCHIVED') return null;

  const { goal, created } = await ensureGoal({
    projectId,
    // Whose sprint this is, and who pressed Start. Both come from the row that
    // person's own action wrote, so the grant names a human who authorized it
    // rather than a process that wanted one.
    ownerUserId: mode.ownerUserId,
    createdByUserId: mode.createdByUserId,
    name: CASH_DISCOVERY_AUTHORITY_NAME,
    allowedWork: [RESEARCH_WORK],
    // `ALWAYS_PROHIBITED` is unioned in by the repository and carries every
    // external effect. These are named again because they are the ones a reader
    // of a cash sprint will look for, and a prohibition that is only implied is
    // one somebody argues about later.
    prohibitions: ['NEW_SPENDING', 'PURCHASE', 'CONTACT_PERSON', 'PUBLISH_EXTERNALLY'],
    // Meaningless under UNCAPPED and written as zero rather than as a large
    // number pretending to be unlimited, which is §24's own correction.
    maxMissions: 0,
    maxFragments: 0,
    maxProbes: 0,
    maxConcurrent: DISCOVERY_CONCURRENCY,
    workPolicy: 'UNCAPPED',
    // No expiry. The sprint's own lifecycle is the bound: archiving revokes
    // this, and a clock that ended it mid-sprint would be the "released by a
    // clock" failure §30 forbids one table along.
    expiresAt: null,
  });

  /*
   * A grant written under an earlier constant keeps its own number, and this
   * is what reaches it.
   *
   * `ensureGoal` is `ON CONFLICT DO NOTHING`, so changing
   * `DISCOVERY_CONCURRENCY` would otherwise reach every sprint started after
   * the change and no sprint already running — which is this repository's own
   * recurring sentence, and the second time tonight it would have applied to a
   * number I had just corrected. The live sprint would have kept two for ever.
   *
   * It is narrow on purpose. Only the grant Brain issues under its own
   * canonical name is touched, only the concurrency, and only to the constant
   * in this file — nothing a person wrote by hand is reconciled to anything,
   * and no other term of the grant moves. Ordering the check by inequality
   * keeps it idempotent: once they agree, no tick writes anything.
   */
  const adaptive = await adaptiveDiscoveryConcurrency(projectId, goal);
  const target = adaptive?.target ?? goal.maxConcurrent;
  /*
   * Raising concurrency is a capacity upgrade, and an upgrade is decided on a
   * fresh production telemetry reading or not at all (TEL-07-1, S-0083). A
   * refused raise leaves the grant as it is; the next tick asks again.
   */
  const gate =
    goal.maxConcurrent !== target
      ? await capacityChangeGate({
          resource: 'CONCURRENCY',
          direction: target > goal.maxConcurrent ? 'INCREASE' : 'DECREASE',
          from: goal.maxConcurrent,
          to: target,
          reason: `discovery grant follows the research surfaces on record and the free lane's headroom: ${adaptive?.why ?? ''}`,
        })
      : null;
  if (gate?.allowed) {
    const from = goal.maxConcurrent;
    if (await setGoalConcurrency(goal.id, target)) {
      await recordCashEvent({
        projectId,
        kind: 'CASH_DISCOVERY_AUTHORIZED',
        actorRef: 'BRAIN',
        summary:
          `How much of this sprint may run at once moved from ${from} to ` +
          `${target}: the research surfaces it has on record, and ${adaptive?.why ?? 'no free-lane reading'}. It is provider capacity rather than an allowance, and ` +
          'nothing about what may be researched, spent or acted on changed.',
        detail: { goalId: goal.id, from, to: target, why: adaptive?.why ?? null, telemetryReadingAt: gate.readingAt, capacityGate: gate.code },
      });
    }
  }

  if (created) {
    await recordCashEvent({
      projectId,
      kind: 'CASH_DISCOVERY_AUTHORIZED',
      actorRef: 'BRAIN',
      summary:
        'Starting Cash Mode authorized Brain to research openings from published sources. ' +
        'Nothing here permits spending, contact, purchase, commitment or publication.',
      detail: {
        goalId: goal.id,
        authorizedByUserId: mode.createdByUserId,
        allowedWork: goal.allowedWork,
        prohibitions: goal.prohibitions,
        maxExternalSpend: 0,
        maxConcurrent: goal.maxConcurrent,
      },
    });
  }
  return { goal, created };
}

/** The live discovery grant, or null. Reading only; creates nothing. */
export async function discoveryAuthority(projectId: string): Promise<RussellGoal | null> {
  return liveGoalNamed(projectId, CASH_DISCOVERY_AUTHORITY_NAME);
}

/**
 * Withdraw it when the sprint is archived.
 *
 * The answering transition for the one state that should not leave a research
 * grant standing. It destroys nothing: the row keeps its id, its terms and its
 * reason, every reservation ever written against it stays, and re-activating
 * the sprint calls `ensureDiscoveryAuthority` again.
 */
export async function withdrawDiscoveryAuthority(input: {
  projectId: string;
  actorUserId: string;
  reason: string;
}): Promise<boolean> {
  const goal = await discoveryAuthority(input.projectId);
  if (!goal) return false;
  return revokeGoal({
    goalId: goal.id,
    actorUserId: input.actorUserId,
    reason: input.reason,
  });
}

export interface ResumedCandidate {
  candidateId: string;
  previousReason: string | null;
}

/**
 * Put back the ideas that parked for want of the grant that now exists.
 *
 * A caller of `resumeParkedForProject` (`../russell/resumeParked.ts`) rather
 * than a second implementation, so there is one rule for what counts as a park
 * on missing authority and one rule for what resumes it — asked here through
 * `discoveryAuthority()` so this stays exactly what it always was: a Cash Mode
 * pass, gated on Cash Mode's own named grant. `resumeParkedForProject` decides
 * eligibility generically (any live grant covering research, not only one with
 * this name), which is a strictly wider condition than "this goal exists" and
 * is therefore already satisfied whenever it does.
 *
 * The previous reason is carried onto a `CASH_DISCOVERY_RESUMED` event before
 * the re-judgment overwrites it, because a park that was real is history worth
 * keeping even once it has been answered — Cash Mode's own activity feed reads
 * this event, so it keeps reporting exactly what it reported before this
 * became a caller of the shared rule rather than a second copy of it.
 */
export async function resumeAuthorityParkedCandidates(input: {
  projectId: string;
  limit?: number;
}): Promise<ResumedCandidate[]> {
  const goal = await discoveryAuthority(input.projectId);
  if (!goal) return [];

  const resumed = await resumeParkedForProject({
    projectId: input.projectId,
    limit: input.limit,
  });

  const out: ResumedCandidate[] = [];
  for (const one of resumed) {
    await recordCashEvent({
      projectId: input.projectId,
      kind: 'CASH_DISCOVERY_RESUMED',
      actorRef: 'BRAIN',
      summary:
        'An idea that had nothing to run under is back in the queue now that starting Cash ' +
        'Mode has authorized internal discovery.',
      detail: { candidateId: one.candidateId, previousReason: one.previousReason, goalId: goal.id },
    });
    out.push({ candidateId: one.candidateId, previousReason: one.previousReason });
  }
  return out;
}
