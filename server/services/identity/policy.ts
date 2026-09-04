/**
 * The authorization decision, in one place.
 *
 * Every protected operation ends up here, and nothing else is allowed to decide
 * whether a principal may do something. Scattering `if (role === 'ADMIN')`
 * through route handlers is how authorization becomes untestable: the rules stop
 * being a thing you can read and become a thing you have to go looking for.
 *
 * Three properties this module is built to have:
 *
 *   * **Deny by default.** Every function returns a denial unless something
 *     positively permits. A null principal, an unknown project, an unrecognised
 *     requirement — all refusals.
 *   * **No inference from the caller.** Decisions read the principal assembled
 *     by authentication from server-held rows, and the resource's own project
 *     lineage. Nothing the caller sent about itself is an input.
 *   * **The same refusal for absent and forbidden.** A project a principal may
 *     not see must be indistinguishable from one that does not exist, or the
 *     404/403 difference becomes a way to enumerate the Brain.
 */
import type {
  DenialReason,
  Principal,
  ProjectMembership,
  ProjectRole,
  WorkerScope,
} from '../../domain/types.ts';
import { PROJECT_ROLES } from '../../domain/types.ts';

/**
 * What an operation needs, in the coarsest terms that are still true.
 *
 * READ  — see the project and what is in it.
 * WRITE — change project state: import, run, audit, freeze, reconcile.
 * ADMIN — change who may do the above, or the project's own settings.
 */
export type AccessLevel = 'READ' | 'WRITE' | 'ADMIN';

/** The minimum role each level needs. Read once, here, and nowhere else. */
const MINIMUM_ROLE: Record<AccessLevel, ProjectRole> = {
  READ: 'VIEWER',
  WRITE: 'MEMBER',
  ADMIN: 'ADMIN',
};

export interface Decision {
  allowed: boolean;
  reason: DenialReason | null;
  /** Which membership permitted it, for the audit. Null when denied. */
  membership: ProjectMembership | null;
}

const DENY = (reason: DenialReason): Decision => ({ allowed: false, reason, membership: null });
const ALLOW = (membership: ProjectMembership | null): Decision => ({
  allowed: true,
  reason: null,
  membership,
});

/**
 * Is `role` at least `minimum` in the authority ordering?
 *
 * `PROJECT_ROLES` is declared strongest-first, so this is an index comparison
 * and adding a role means editing that one array.
 */
export function roleAtLeast(role: ProjectRole | null, minimum: ProjectRole): boolean {
  if (!role) return false;
  const held = PROJECT_ROLES.indexOf(role);
  const needed = PROJECT_ROLES.indexOf(minimum);
  return held !== -1 && needed !== -1 && held <= needed;
}

function membershipFor(principal: Principal, projectId: string): ProjectMembership | null {
  return principal.memberships.find((m) => m.projectId === projectId && m.active) ?? null;
}

/**
 * May this principal reach this project at this level?
 *
 * A Brain administrator reaches every project. That is a deliberate grant and
 * not an oversight: somebody has to be able to repair a project whose only
 * owner left, and the alternative — an administrator who can grant themselves
 * access but not use it — is the same power with an extra step and a worse
 * audit trail. Every such access is recorded as having been made by an
 * administrator rather than by a member.
 *
 * A worker is never a Brain administrator, whatever else it holds.
 */
export function decideProjectAccess(
  principal: Principal | null,
  projectId: string,
  level: AccessLevel,
  requiredScope?: WorkerScope,
): Decision {
  if (!principal) return DENY('NO_CREDENTIALS');

  if (principal.type === 'HUMAN') {
    if (principal.isBrainAdmin) return ALLOW(membershipFor(principal, projectId));
    const membership = membershipFor(principal, projectId);
    if (!membership) return DENY('NOT_A_MEMBER');
    if (!roleAtLeast(membership.role, MINIMUM_ROLE[level])) return DENY('INSUFFICIENT_ROLE');
    return ALLOW(membership);
  }

  // Workers.
  //
  // A worker administers nothing, ever. Project administration is changing who
  // may do what, and a machine credential that could widen its own access is a
  // machine credential whose theft is unbounded.
  if (level === 'ADMIN') return DENY('INSUFFICIENT_ROLE');

  const membership = membershipFor(principal, projectId);
  if (!membership) return DENY('NOT_A_MEMBER');

  // Reading requires the base scope; anything else requires the operation to
  // have named the scope it needs. An unnamed write is refused rather than
  // waved through on the strength of membership — membership says *which*
  // project, scopes say *what*.
  const needed: WorkerScope | null =
    requiredScope ?? (level === 'READ' ? 'project:read' : null);
  if (!needed) return DENY('MISSING_SCOPE');
  if (!membership.scopes.includes(needed)) return DENY('MISSING_SCOPE');
  return ALLOW(membership);
}

/** Brain-wide administration: users, workers, credentials, provider connections. */
export function decideBrainAdmin(principal: Principal | null): Decision {
  if (!principal) return DENY('NO_CREDENTIALS');
  if (principal.type !== 'HUMAN') return DENY('NOT_BRAIN_ADMIN');
  if (!principal.isBrainAdmin) return DENY('NOT_BRAIN_ADMIN');
  return ALLOW(null);
}

/**
 * The projects this principal may see, out of the ones that exist.
 *
 * Used to filter a listing rather than to refuse it: a person with access to
 * one project of five should be shown one, not told that four are forbidden.
 * The count itself is information.
 */
export function visibleProjectIds(principal: Principal | null, all: string[]): string[] {
  if (!principal) return [];
  if (principal.type === 'HUMAN' && principal.isBrainAdmin) return [...all];
  const mine = new Set(principal.memberships.filter((m) => m.active).map((m) => m.projectId));
  return all.filter((id) => mine.has(id));
}

// ---------------------------------------------------------------------------
// What each route needs
// ---------------------------------------------------------------------------

/**
 * The default: reading is READ, everything else is WRITE.
 *
 * Defaults matter more than the exceptions here. A route added next year with
 * nobody remembering to classify it lands on WRITE if it mutates and READ if it
 * does not, which is the safe side of both mistakes. The exceptions below only
 * ever tighten that.
 */
export function defaultLevelFor(method: string): AccessLevel {
  return method === 'GET' || method === 'HEAD' ? 'READ' : 'WRITE';
}

interface Override {
  /** Matched against the full path with ids replaced by `:id`. */
  pattern: RegExp;
  method?: string;
  level?: AccessLevel;
  /** The scope a worker must hold. Absent means a worker cannot do this at all. */
  scope?: WorkerScope;
}

/**
 * The operations whose default is not right.
 *
 * Two kinds of entry: things that need ADMIN rather than WRITE because they
 * change who can do what or change the project itself, and the handful of
 * operations a worker is expected to perform, which name the scope that permits
 * them. Everything not listed keeps the default, and a worker keeps being
 * refused for anything that is not a read.
 */
const OVERRIDES: Override[] = [
  // Changing the project's own definition, and its membership.
  { pattern: /^\/api\/projects\/[^/]+$/, method: 'PATCH', level: 'ADMIN' },
  { pattern: /^\/api\/projects\/[^/]+\/members/, level: 'ADMIN' },

  // Reads a worker is expected to do.
  { pattern: /^\/api\/documents\/[^/]+\/(file|text|extraction|findings|ingestion)$/, method: 'GET', level: 'READ', scope: 'documents:read' },
  { pattern: /^\/api\/documents\/chunks\/[^/]+$/, method: 'GET', level: 'READ', scope: 'documents:read' },
  { pattern: /^\/api\/research(\/|$)/, method: 'GET', level: 'READ', scope: 'research:read' },
  { pattern: /^\/api\/projects\/[^/]+\/research$/, method: 'GET', level: 'READ', scope: 'research:read' },
  { pattern: /^\/api\/layers\/[^/]+\/research$/, method: 'GET', level: 'READ', scope: 'research:read' },

  // Writes a worker is expected to do. Every one of these is an existing route
  // that means what the scope says; no scope is wired to a route invented for
  // it, and no scope reserved for a later step appears here at all.
  { pattern: /^\/api\/runs\/[^/]+\/complete$/, method: 'POST', level: 'WRITE', scope: 'work:complete' },
  { pattern: /^\/api\/runs\/[^/]+\/fail$/, method: 'POST', level: 'WRITE', scope: 'blockers:report' },
  { pattern: /^\/api\/layers\/[^/]+\/research$/, method: 'POST', level: 'WRITE', scope: 'research:propose' },
  { pattern: /^\/api\/research\/[^/]+\/review$/, method: 'POST', level: 'WRITE', scope: 'research:propose' },

  // ---------------------------------------------------------------------
  // Step 5 — the distributed queue
  // ---------------------------------------------------------------------
  //
  // Creating and cancelling work is ADMIN, and names no worker scope, so a
  // worker is refused outright however many scopes it holds. A worker may only
  // take work that already exists and report what happened to it.
  //
  // The claim, heartbeat, completion and failure routes address a work item
  // rather than a project, so their project is resolved from the item's own row
  // before this requirement is applied — a worker cannot reach another
  // project's item by guessing its id, because the resolver authorizes the
  // project the row actually belongs to.
  { pattern: /^\/api\/projects\/[^/]+\/work$/, method: 'POST', level: 'ADMIN' },
  { pattern: /^\/api\/work\/[^/]+\/cancel$/, method: 'POST', level: 'ADMIN' },
  { pattern: /^\/api\/projects\/[^/]+\/work(\/|$)/, method: 'GET', level: 'READ', scope: 'queue:read' },
  { pattern: /^\/api\/work\/claim$/, method: 'POST', level: 'WRITE', scope: 'queue:claim' },
  { pattern: /^\/api\/work\/[^/]+\/heartbeat$/, method: 'POST', level: 'WRITE', scope: 'queue:heartbeat' },
  { pattern: /^\/api\/work\/[^/]+\/(complete|fail|release)$/, method: 'POST', level: 'WRITE', scope: 'queue:complete' },
  { pattern: /^\/api\/work\/[^/]+$/, method: 'GET', level: 'READ', scope: 'queue:read' },

  // ---------------------------------------------------------------------
  // Step 6 — effects
  // ---------------------------------------------------------------------
  //
  // Committing an effect is what a worker holding a lease is for, so it names
  // the completion scope. Resolving an uncertain one is a judgement about the
  // outside world and is ADMIN with no worker scope at all: a worker may record
  // that something is unknown, and may never decide what it means.
  { pattern: /^\/api\/work\/[^/]+\/effect$/, method: 'POST', level: 'WRITE', scope: 'queue:complete' },
  { pattern: /^\/api\/operations\/[^/]+\/resolve$/, method: 'POST', level: 'ADMIN' },
  { pattern: /^\/api\/operations\/[^/]+$/, method: 'GET', level: 'ADMIN' },
  { pattern: /^\/api\/projects\/[^/]+\/operations$/, method: 'GET', level: 'ADMIN' },

  // ---------------------------------------------------------------------
  // Step 12A — Russell
  // ---------------------------------------------------------------------
  //
  // Two POSTs here are reads that need a body, and the default method rule
  // would make them writes. Asking a person for write access to find out
  // whether Russell would need to research something is backwards: the whole
  // point of the coverage answer is to be consulted *before* anything is
  // spent, and opening a conversation about a project changes nothing in it.
  //
  // Answering an open decision is genuinely a write and is deliberately left
  // to the default, because it moves work.
  { pattern: /^\/api\/russell\/projects\/[^/]+\/coverage$/, method: 'POST', level: 'READ' },
  { pattern: /^\/api\/russell\/conversations$/, method: 'POST', level: 'READ' },
];

export interface Requirement {
  level: AccessLevel;
  scope?: WorkerScope;
}

export function requirementFor(method: string, path: string): Requirement {
  for (const override of OVERRIDES) {
    if (override.method && override.method !== method) continue;
    if (!override.pattern.test(path)) continue;
    const requirement: Requirement = { level: override.level ?? defaultLevelFor(method) };
    if (override.scope) requirement.scope = override.scope;
    return requirement;
  }
  return { level: defaultLevelFor(method) };
}
