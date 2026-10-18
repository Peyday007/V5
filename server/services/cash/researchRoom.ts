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

export type RoomLimit = 'SHEDDING' | 'NO_GRANT' | 'GRANT' | 'SURFACES';

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

/** The room for one kind of research in one project. */
export async function researchRoom(input: {
  projectId: string;
  inFlight: number;
  unlaunched: number;
}): Promise<ResearchRoom> {
  return researchRoomFrom({
    capacity: await researchCapacity(input.projectId),
    inFlight: input.inFlight,
    unlaunched: input.unlaunched,
  });
}
