/**
 * How much bounded research a project may start right now, derived rather than
 * fixed (OPPORTUNITY-INTELLIGENCE §3.4).
 *
 * `MAX_VALIDATIONS_IN_FLIGHT = 2` and `MAX_OPEN_COMMISSIONS = 3` were fixed
 * numbers standing in for three real facts, and the fixed number was wrong in
 * both directions: two dives while eight surfaces sat idle, and still two when
 * the database was struggling. The three facts are read instead:
 *
 *   * **the person-set grant.** A research mission reserves one of the
 *     standing grant's `AT_ONCE` slots (`researchMissionSlotsFull`'s
 *     arithmetic). The free slots, less one held back so discovery is never
 *     starved by refinement — and never the last one, so a grant with any free
 *     slot can always start something. This is the only ceiling, and it is a
 *     person's: nothing here can exceed it.
 *   * **the surfaces that could run it now.** A dive with nothing to run on
 *     holds a grant slot while no worker exists, which is how production once
 *     closed twenty-four openings with no research run (§47). Counted from the
 *     fleet snapshot with the router's own `surfaceIneligibility`, so this and
 *     the dispatcher cannot disagree about which surfaces exist.
 *   * **the database.** While `db/pressure.ts` reports SHEDDING, no optional
 *     research starts at all (§63). Nothing in flight is touched.
 *
 * The floor: whatever the surface count says, one piece of work may always be
 * in flight while the grant has a free slot. A surface count is a reading of a
 * fleet that can be misconfigured for an hour, and a project whose refinement
 * stopped entirely on such a reading would be the "waiting nobody can resolve"
 * §24 forbids. One at a time is what it did before this existed.
 *
 * No weights, no score: three numbers and a minimum.
 */
import { authorityNow, checkAuthority, spendTotals } from '../../repos/russellAuthority.ts';
import { RESEARCH_WORK_CLASS } from '../russell/launch.ts';
import { databasePressure } from '../../db/pressure.ts';
import { getDb } from '../../db/database.ts';
import { sharedFleetSnapshot } from '../dispatch/candidates.ts';
import { surfaceIneligibility } from '../dispatch/router.ts';

export interface ResearchCapacity {
  /** The grant's `AT_ONCE` ceiling, or null when no grant governs research here. */
  grantMax: number | null;
  /** Mission slots held right now. */
  grantLive: number;
  /** Routable research surfaces for this project right now; null when unreadable. */
  surfaces: number | null;
  shedding: boolean;
  sheddingReason: string | null;
}

export type RoomLimit = 'SHEDDING' | 'NO_GRANT' | 'GRANT' | 'SURFACES' | 'OPERATOR';

export interface ResearchRoom {
  /** How many more may start now. Never negative, never above the grant's free slots. */
  room: number;
  /** In flight plus room: the most that may be running at once right now. */
  cap: number;
  inFlight: number;
  limitedBy: RoomLimit;
  reason: string;
}

/**
 * The room, as a pure function of a reading. Exported so the arithmetic can be
 * argued with — and tested — without a fleet.
 *
 * `inFlight` is this kind of work running now; `unlaunched` is the part of it
 * that has not yet reserved its grant slot (a dive whose idea has not
 * launched), so it is subtracted from the grant's free slots before it is
 * counted again.
 */
export function researchRoomFrom(input: {
  capacity: ResearchCapacity;
  inFlight: number;
  unlaunched: number;
}): ResearchRoom {
  const inFlight = Math.max(0, Math.trunc(input.inFlight));
  const unlaunched = Math.max(0, Math.trunc(input.unlaunched));
  const { capacity } = input;
  const none = (limitedBy: RoomLimit, reason: string): ResearchRoom => ({
    room: 0,
    cap: inFlight,
    inFlight,
    limitedBy,
    reason,
  });
  if (capacity.shedding) {
    return none(
      'SHEDDING',
      `the database is under pressure (${capacity.sheddingReason ?? 'shedding optional work'}), ` +
        'so no optional research starts until it recovers',
    );
  }
  if (capacity.grantMax === null) {
    return none('NO_GRANT', 'no live research grant governs this project');
  }
  const free = Math.max(0, capacity.grantMax - capacity.grantLive - unlaunched);
  if (free === 0) {
    return none(
      'GRANT',
      `every one of the grant's ${capacity.grantMax} at-once slots is held or spoken for`,
    );
  }
  // One held back for discovery, but never the last free slot.
  const grantRoom = free >= 2 ? free - 1 : free;
  const surfaceRoom = Math.max(0, (capacity.surfaces ?? 0) - inFlight);
  // The floor: one may always be in flight while the grant has a free slot.
  const floored = inFlight === 0 ? Math.max(1, surfaceRoom) : surfaceRoom;
  const room = Math.min(grantRoom, floored);
  // Whichever of the two bounds is the tighter one is what limits it.
  const limitedBy: RoomLimit = grantRoom <= floored ? 'GRANT' : 'SURFACES';
  const surfaceWords =
    capacity.surfaces === null ? 'the surface count could not be read' : `${capacity.surfaces} routable research surface(s)`;
  return {
    room,
    cap: inFlight + room,
    inFlight,
    limitedBy,
    reason:
      `${free} free grant slot(s) of ${capacity.grantMax} (one held back for discovery), ` +
      `${surfaceWords}, ${inFlight} in flight`,
  };
}

/** The three readings for one project. Null grant when none governs research. */
export async function researchCapacity(projectId: string): Promise<ResearchCapacity> {
  const pressure = databasePressure();
  const authority = await checkAuthority({ projectId, workClass: RESEARCH_WORK_CLASS });
  let grantMax: number | null = null;
  let grantLive = 0;
  if (authority.ok && authority.goal) {
    grantMax = authority.goal.maxConcurrent;
    grantLive = (await spendTotals(authority.goal.id, 'MISSION', authorityNow())).live;
  }
  return {
    grantMax,
    grantLive,
    surfaces: await routableResearchSurfaces(projectId),
    shedding: pressure.state === 'SHEDDING',
    sheddingReason: pressure.state === 'SHEDDING' ? pressure.reason : null,
  };
}

/**
 * Surfaces the router would consider for this project's research right now.
 *
 * The router's own `surfaceIneligibility`, plus the three per-bin questions a
 * research bin in this project would ask that do not depend on the bin: does
 * its worker serve this project, may it be handed research, and has the
 * provider not asked Brain to wait. Headroom is deliberately not asked — a
 * surface at its target is still capacity, it is just busy.
 *
 * Null when the snapshot cannot be read, which `researchRoomFrom` treats as
 * the floor rather than as plenty: an unknown is never a favourable assumption.
 */
export async function routableResearchSurfaces(projectId: string): Promise<number | null> {
  const nowMs = Date.now();
  const held = surfaceMemo.get(projectId);
  if (held && nowMs >= held.at && nowMs - held.at < SURFACE_REUSE_MS) return held.count;
  const count = await readRoutableResearchSurfaces(projectId);
  surfaceMemo.set(projectId, { at: nowMs, count });
  return count;
}

/**
 * How long one project's surface count may be reused. A fleet snapshot is of
 * the order of a hundred statements, and the room is asked by the dive pass,
 * the resume pass, the commission pass and the operator surface in one tick;
 * a count ten seconds old changes no decision the grant does not already bound.
 */
const SURFACE_REUSE_MS = 10_000;
const surfaceMemo = new Map<string, { at: number; count: number | null }>();

/** Tests, and a write that knows the fleet just changed. */
export function forgetResearchSurfaces(): void {
  surfaceMemo.clear();
  spareMemo.clear();
}

async function readRoutableResearchSurfaces(projectId: string): Promise<number | null> {
  try {
    const snapshot = await sharedFleetSnapshot();
    const now = new Date().toISOString();
    let count = 0;
    for (const candidate of snapshot.candidates) {
      if (surfaceIneligibility(candidate) !== null) continue;
      if (!candidate.servesProjects.includes(projectId)) continue;
      if (Array.isArray(candidate.servesFamilies) && !candidate.servesFamilies.includes('RESEARCH')) continue;
      const waits = [candidate.routine.retryAt, candidate.account.retryAt].filter(
        (at): at is string => typeof at === 'string' && at > now,
      );
      if (waits.length > 0) continue;
      count += 1;
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * Research surfaces this project has on record, whether or not each one can be
 * fired this minute.
 *
 * `routableResearchSurfaces` answers *now*, and moves every time a Routine is
 * quarantined or recovers. This answers what the fleet is sized at: a Routine
 * that is ENABLED, or QUARANTINED and therefore one recovery probe away from
 * work, whose account is not disabled and whose live worker serves this
 * project's research. RETIRED and DISABLED surfaces are not capacity anybody
 * intends to use, so they are not counted.
 *
 * It sizes the discovery grant's concurrency (`discoveryConcurrencyFor`), and
 * the reason it is not the routable count is churn: a grant that followed every
 * quarantine would rewrite itself, and write an event, on every tick a surface
 * flapped. A slot whose surface is briefly down costs nothing — the mission's
 * bin waits READY until a surface can take it.
 *
 * Null when the snapshot cannot be read; the caller then leaves the grant as it
 * is, because an unknown is never a reason to move a number.
 */
export async function researchSurfacesOnRecord(projectId: string): Promise<number | null> {
  try {
    const snapshot = await sharedFleetSnapshot();
    let count = 0;
    for (const candidate of snapshot.candidates) {
      const { routine, account } = candidate;
      if (routine.state !== 'ENABLED' && routine.state !== 'QUARANTINED') continue;
      if (account.state !== 'ENABLED' && account.state !== 'QUARANTINED') continue;
      if (routine.workerId === null || !candidate.workerActive) continue;
      if (!candidate.servesProjects.includes(projectId)) continue;
      if (Array.isArray(candidate.servesFamilies) && !candidate.servesFamilies.includes('RESEARCH')) continue;
      count += 1;
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * An operator's ceiling on cash research, from `BRAIN_CASH_RESEARCH_MAX`.
 *
 * Deep dives and monetization questions on weak openings are low-yield Routine
 * time; this bounds how many of each kind run at once so the Routines go to
 * work that improves every job. Unset means no extra ceiling. It only ever
 * lowers the room — never raises it past the grant.
 */
export function operatorResearchMax(env = process.env): number | null {
  const raw = env['BRAIN_CASH_RESEARCH_MAX']?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

/**
 * Whether the operator has put the Routines on focus: Claude works on what
 * improves every job, and cash finding moves to the free models and feeds.
 *
 * `cheap-lane.yml focus` sets `BRAIN_CASH_RESEARCH_MAX` (with
 * `BRAIN_CLAUDE_DISCOVERY=off`); the ceiling is the owner saying so.
 * `claude-discovery-off` alone stops bulk rounds and keeps a goal's own search. Under focus
 * idle Routine capacity is **never** a reason to start more cash research: an
 * idle Routine is capacity kept for Brain-improvement work, not a gap to fill.
 * Production, 2026-10-31: the idle-fill lift (#385) undid focus within hours and
 * a Routine spent its run hunting buyers for one Pennsylvania farm opening.
 */
export function routineFocus(env = process.env): boolean {
  return operatorResearchMax(env) !== null;
}

/**
 * Idle research surfaces cash research may use: none under focus.
 */
export async function cashSpareSurfaces(projectId: string): Promise<number> {
  if (routineFocus()) return 0;
  return (await spareResearchSurfaces(projectId)) ?? 0;
}

/**
 * The operator's ceiling binds only while capacity is contended.
 *
 * `BRAIN_CASH_RESEARCH_MAX` exists so low-yield dives do not take Routine time
 * from work that improves every job. When surfaces sit idle with nothing
 * waiting to be fired, there is no such work to protect, and holding the
 * ceiling only leaves capacity idle beside eligible research (rule 9).
 * Production, 2026-10-31 21:41Z: the ceiling held cash research at its fixed
 * number while 8 routable research surfaces had 2 activations between them.
 * So the ceiling rises by the measured spare — idle research surfaces less the
 * bins already waiting for one — and falls back the moment work queues up.
 * It never raises the room past the grant; `researchRoomFrom` decided that.
 */
export function applyOperatorMax(room: ResearchRoom, max: number | null, spare = 0): ResearchRoom {
  if (max === null) return room;
  const lift = Math.max(0, Math.trunc(spare));
  const allowed = Math.max(0, max + lift - room.inFlight);
  if (allowed >= room.room) return room;
  return {
    room: allowed,
    cap: room.inFlight + allowed,
    inFlight: room.inFlight,
    limitedBy: 'OPERATOR',
    reason:
      lift > 0
        ? `an operator capped cash research at ${max} at once, raised by ${lift} idle research surface(s)`
        : `an operator capped cash research at ${max} at once, and no research surface is idle`,
  };
}

/**
 * Research surfaces for this project that are idle now, less the bins already
 * waiting to be fired: capacity nothing is going to use unless more work is
 * started. Null when unreadable — the caller then lifts nothing, because an
 * unknown is never a favourable assumption.
 */
export async function spareResearchSurfaces(projectId: string): Promise<number | null> {
  const nowMs = Date.now();
  const held = spareMemo.get(projectId);
  if (held && nowMs >= held.at && nowMs - held.at < SURFACE_REUSE_MS) return held.count;
  let count: number | null = null;
  try {
    const snapshot = await sharedFleetSnapshot();
    const now = new Date(nowMs).toISOString();
    let idle = 0;
    for (const candidate of snapshot.candidates) {
      if (surfaceIneligibility(candidate) !== null) continue;
      if (!candidate.servesProjects.includes(projectId)) continue;
      if (Array.isArray(candidate.servesFamilies) && !candidate.servesFamilies.includes('RESEARCH')) continue;
      const waits = [candidate.routine.retryAt, candidate.account.retryAt].filter(
        (at): at is string => typeof at === 'string' && at > now,
      );
      if (waits.length > 0) continue;
      if ((candidate.routineInFlight ?? 0) > 0) continue;
      idle += 1;
    }
    const waiting = await getDb().get<{ n: number | string }>(
      `SELECT COUNT(DISTINCT b.id) AS n FROM bins b
         JOIN bin_dispatch d ON d.bin_id = b.id AND d.lease_generation = b.lease_generation
        WHERE b.project_id = ? AND b.state = 'READY' AND b.held_by_workstream_id IS NULL
          AND d.state IN ('PENDING', 'SENDING') AND d.next_attempt_at <= ?`,
      [projectId, now],
    );
    count = Math.max(0, idle - Number(waiting?.n ?? 0));
  } catch {
    count = null;
  }
  spareMemo.set(projectId, { at: nowMs, count });
  return count;
}
const spareMemo = new Map<string, { at: number; count: number | null }>();

/** The room for one kind of research in one project. */
export async function researchRoom(input: {
  projectId: string;
  inFlight: number;
  unlaunched: number;
}): Promise<ResearchRoom> {
  const room = researchRoomFrom({
    capacity: await researchCapacity(input.projectId),
    inFlight: input.inFlight,
    unlaunched: input.unlaunched,
  });
  if (room.room <= 0) return room;
  const max = operatorResearchMax();
  if (max === null) return room;
  return applyOperatorMax(room, max, await cashSpareSurfaces(input.projectId));
}
