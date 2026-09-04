/**
 * Who is here, and what can actually run — in plain words, at the caller's
 * level of authority.
 *
 * Two things are being answered at once and they must not be conflated. **Who**
 * is people: the collaborators on a project and what each may do. **What can
 * run** is machinery: the accounts, Routines and workers that carry the work.
 * A person reading this screen wants both, and the second one is where the
 * disclosure risk lives.
 *
 * Three rules hold the whole file up.
 *
 * **Nothing here is ever a secret.** Not a bearer value, not a session id, not
 * a credential digest, not a token secret's *value*. `fleet_routines` stores
 * the deployment secret's **name** and a digest taken once at registration, and
 * neither reaches this projection — the name because it is an operational
 * detail an attacker would find useful and a person would not, the digest
 * because a digest of a live credential is still a fact about that credential.
 * What a person needs is whether a surface is configured, and that is a
 * boolean.
 *
 * **The level decides what exists, not merely what is rendered.** An ordinary
 * member does not get a filtered copy of the operator's answer; they get a
 * different answer, built from fewer queries. A field removed in the client is
 * a field that was still sent, and §22's reasoning about tool lists applies
 * unchanged: filtering a response is not an access control.
 *
 * **Aggregate counts are disclosures too.** "3 accounts, 2 quarantined" tells
 * somebody the shape of a fleet they may not see. So a non-administrator gets a
 * coarse health word for the *project's* capacity and no totals at all —
 * §24's rule that hidden nodes, edges and counts must not leak.
 */
import { listAccounts, listRoutines, currentPolicy, effectiveTarget } from '../../repos/fleet.ts';
import { listMembershipsForProject } from '../../repos/identity.ts';
import { getUser, getWorker } from '../../repos/identity.ts';
import { decideProjectAccess } from '../identity/policy.ts';
import type { FleetState, Principal, ProjectRole } from '../../domain/types.ts';

/**
 * How much of the machinery this caller may be told about.
 *
 * Derived from the same policy decision every other route uses, never from a
 * parameter — a caller that could name its own level is a caller that could
 * raise it.
 */
export type WhoDepth = 'OPERATOR' | 'COLLABORATOR' | 'NONE';

export interface Person {
  /** The user id. Safe: it is the same id every other project surface uses. */
  id: string;
  name: string;
  /**
   * Shown only to somebody who administers the project. An email is a contact
   * detail, and a viewer does not need one to know who a collaborator is.
   */
  email: string | null;
  role: ProjectRole | null;
  roleLabel: string;
  /** True for the person reading. Lets the interface say "you". */
  isYou: boolean;
  active: boolean;
}

/**
 * One place work can run.
 *
 * A *surface*, not a subscription: an account holds an allowance and a Routine
 * is a fire surface, and §23 is explicit that multiplying one by the other is
 * arithmetic on a fiction. So capacity is reported as a target and a state,
 * never as a computed throughput.
 */
export interface Surface {
  id: string;
  name: string;
  accountName: string;
  state: FleetState;
  /** The word a person reads. One mapping, tested. */
  health: string;
  /** Why it is in that state, when a reason was recorded. */
  reason: string | null;
  /** How many bins the operator currently wants it carrying. */
  target: number | null;
  /** Whether a deployment secret is configured. Never the name or the value. */
  configured: boolean;
  /** Which worker identity it is bound to, by name. Never a credential. */
  boundWorker: string | null;
  fires: number;
  refusals: number;
  /** Times it was fired and nobody turned up. A health signal, not a scold. */
  noShows: number;
  lastFiredAt: string | null;
  lastCheckInAt: string | null;
}

export interface WhoView {
  depth: WhoDepth;
  people: Person[];
  /** Present only at OPERATOR depth. Null is "you are not told", by design. */
  surfaces: Surface[] | null;
  /**
   * The one sentence a collaborator gets instead of the fleet: whether work can
   * run right now. Coarse on purpose — it discloses capability, not topology.
   */
  capacity: 'READY' | 'LIMITED' | 'NONE' | 'UNKNOWN';
  capacityExplanation: string;
}

const ROLE_LABELS: Record<ProjectRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Administrator',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

/** Plain words for a fleet state. The enum is not product copy. */
export function plainFleetState(state: FleetState): string {
  switch (state) {
    case 'ENABLED':
      return 'Healthy';
    case 'DRAINING':
      return 'Finishing what it has';
    case 'UNAVAILABLE':
      return 'Unavailable';
    case 'QUARANTINED':
      return 'Held back';
    case 'RETIRED':
      return 'Retired';
    default:
      return state;
  }
}

/**
 * Whether this caller administers the project.
 *
 * `ADMIN` access is the level `decideProjectAccess` already refuses to a worker
 * outright, which is the property that matters here: a machine must never reach
 * the screen describing the machines.
 */
function depthFor(principal: Principal | null, projectId: string): WhoDepth {
  if (!principal || principal.type !== 'HUMAN') return 'NONE';
  if (decideProjectAccess(principal, projectId, 'ADMIN').allowed) return 'OPERATOR';
  if (decideProjectAccess(principal, projectId, 'READ').allowed) return 'COLLABORATOR';
  return 'NONE';
}

/**
 * Who is on this project, and what can run.
 *
 * Returns `null` for a caller with no read access, which the route turns into
 * the same 404 a missing project gives. A distinguishable refusal here would
 * let somebody enumerate projects by watching which id changed the answer.
 */
export async function whoForProject(input: {
  principal: Principal | null;
  projectId: string;
}): Promise<WhoView | null> {
  const depth = depthFor(input.principal, input.projectId);
  if (depth === 'NONE') return null;

  const memberships = await listMembershipsForProject(input.projectId);
  const people: Person[] = [];
  for (const membership of memberships) {
    // Workers are machinery and belong under surfaces, not under people. A
    // machine listed as a collaborator is the category error §22 spent a
    // section on.
    if (membership.principalType !== 'HUMAN') continue;
    const user = await getUser(membership.principalId);
    if (!user) continue;
    people.push({
      id: user.id,
      name: user.displayName || user.email,
      email: depth === 'OPERATOR' ? user.email : null,
      role: membership.role,
      roleLabel: membership.role ? ROLE_LABELS[membership.role] : 'No role',
      isYou: user.id === input.principal?.id,
      active: membership.active && !user.disabled,
    });
  }

  /*
   * The person reading is on the list, always.
   *
   * A Brain administrator reaches a project through `isBrainAdmin` rather than
   * through a membership row, so the first version of this screen told the one
   * person looking at it that nobody was on the project — while they were on
   * it. Their access is real; it simply comes from somewhere else, and the
   * label says which.
   */
  if (input.principal && !people.some((person) => person.id === input.principal!.id)) {
    people.unshift({
      id: input.principal.id,
      name: input.principal.displayName || input.principal.handle,
      email: depth === 'OPERATOR' ? input.principal.handle : null,
      role: null,
      roleLabel: input.principal.isBrainAdmin ? 'Brain administrator' : 'Has access',
      isYou: true,
      active: true,
    });
  }

  if (depth !== 'OPERATOR') {
    // A coarse answer, built from a query that returns no topology. The
    // collaborator learns whether work can run, which is what they need to
    // read a Work screen honestly, and nothing about how many places it could.
    const routines = await listRoutines();
    const healthy = routines.filter((routine) => routine.state === 'ENABLED').length;
    return {
      depth,
      people,
      surfaces: null,
      capacity: healthy > 0 ? 'READY' : routines.length > 0 ? 'LIMITED' : 'NONE',
      capacityExplanation:
        healthy > 0
          ? 'Work can run right now.'
          : routines.length > 0
            ? 'Nothing is able to pick work up at the moment. It will resume by itself when a surface recovers.'
            : 'Nothing is set up to run work yet.',
    };
  }

  const now = new Date().toISOString();
  const [accounts, routines, policy] = await Promise.all([
    listAccounts(),
    listRoutines(),
    currentPolicy('FLEET', null),
  ]);
  const accountName = new Map(accounts.map((account) => [account.id, account.name]));

  const surfaces: Surface[] = [];
  for (const routine of routines) {
    const worker = routine.workerId ? await getWorker(routine.workerId) : null;
    const routinePolicy = await currentPolicy('ROUTINE', routine.id);
    surfaces.push({
      id: routine.id,
      name: routine.name,
      accountName: accountName.get(routine.accountId) ?? 'an unregistered account',
      state: routine.state,
      health: plainFleetState(routine.state),
      reason: routine.stateReason,
      target: effectiveTarget(routinePolicy ?? policy ?? null, now).target,
      // A boolean, deliberately. Whether a secret is configured is operational;
      // its name is a hint about the deployment and its digest is a fact about
      // a live credential.
      configured: routine.tokenDigest !== null,
      boundWorker: worker ? worker.name : null,
      fires: routine.totalFires,
      refusals: routine.totalRefusals,
      noShows: routine.consecutiveNoShows,
      lastFiredAt: routine.lastFiredAt,
      lastCheckInAt: routine.lastCheckInAt,
    });
  }

  const healthy = surfaces.filter((surface) => surface.state === 'ENABLED').length;
  return {
    depth,
    people,
    surfaces,
    capacity: healthy > 0 ? 'READY' : surfaces.length > 0 ? 'LIMITED' : 'NONE',
    capacityExplanation:
      healthy > 0
        ? `${healthy} of ${surfaces.length} ${surfaces.length === 1 ? 'surface is' : 'surfaces are'} healthy.`
        : surfaces.length > 0
          ? 'No surface is currently able to take work.'
          : 'No execution surface is registered.',
  };
}
