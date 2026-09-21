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

  // Withdrawing a shared finding, or declaring how long it is good for.
  //
  // A finding belongs to the project that produced it, so the decision is
  // stated at the level every other change to what a project owns already
  // carries. A project consuming the finding disagrees by recording a
  // contradiction, which is the path that already exists; it does not get to
  // withdraw somebody else's evidence.
  { pattern: /^\/api\/russell\/shared-findings\/[^/]+\/(revoke|horizon)$/, method: 'POST', level: 'ADMIN' },

  // Connecting a site is a membership grant, so it is stated at the level every
  // other membership change already carries rather than inherited from the
  // method. `/api/projects/:id/members` is ADMIN above for the identical
  // reason: it changes who may reach the project, which is a different kind of
  // act from changing what the project contains.
  //
  // No `scope` on any of them, which is what makes a worker principal unable to
  // do this at all — a machine that could issue itself a site credential is
  // precisely what §22 was protecting against. The routes refuse a worker by
  // type as well; this is the same answer said in the module that decides.
  { pattern: /^\/api\/russell\/projects\/[^/]+\/sites\/[^/]+\/(connect|disconnect)$/, method: 'POST', level: 'ADMIN' },

  // Inviting a person **is** a membership grant, so it is stated at the level
  // `/api/projects/:id/members` already carries rather than inherited from the
  // method — and the reading is ADMIN too, because a pending invitation names
  // somebody's email address, which is operator-depth information about who is
  // being let into a project.
  //
  // No `scope` on any of them, which is what makes a worker principal unable to
  // reach this at all: `decideProjectAccess` refuses a worker `ADMIN` outright,
  // and the routes refuse one by type as well. A machine that could invite people
  // would be creating principals nobody asked for.
  //
  // `/api/invitations/preview` and `/api/invitations/accept` are deliberately
  // absent: they are addressed by no project, their authority is the invitation
  // token itself, and they are the two entries on the guard's unauthenticated
  // allowlist.
  { pattern: /^\/api\/russell\/projects\/[^/]+\/invitations/, level: 'ADMIN' },

  // Onboarding a repository is a membership grant plus a routing scope plus an
  // invitation, so it is the same authority as connecting a site and carries the
  // same level. A worker principal is refused by type in the handler as well: a
  // machine that could register itself for repository work is precisely what §22
  // was protecting against.
  { pattern: /^\/api\/projects\/[^/]+\/factory\/repositories\/[^/]+\/onboard$/, method: 'POST', level: 'ADMIN' },
  { pattern: /^\/api\/russell\/projects\/[^/]+\/sites/, method: 'GET', level: 'READ' },

  // ---------------------------------------------------------------------
  // Step 12C — a connected site
  // ---------------------------------------------------------------------
  //
  // Two writes and they name one scope, because the connector does one job.
  // Registering records is a project write; issuing the one typed command is a
  // project write. Neither is ADMIN and neither has a second scope, so a stolen
  // site credential reaches exactly this and nothing beside it.
  //
  // The reads are deliberately absent from this list. A worker reading a
  // project already needs `project:read` by default, which is the correct
  // requirement here and is one fewer entry that could drift.
  {
    pattern: /^\/api\/projects\/[^/]+\/connect\/[^/]+\/records$/,
    method: 'POST',
    level: 'WRITE',
    scope: 'external:sync',
  },
  {
    pattern: /^\/api\/projects\/[^/]+\/connect\/[^/]+\/records\/[^/]+\/commands$/,
    method: 'POST',
    level: 'WRITE',
    scope: 'external:sync',
  },

  // ---------------------------------------------------------------------
  // Cash Mode (§30)
  // ---------------------------------------------------------------------
  //
  // Two decisions are ADMIN and everything else takes the default, and the
  // split is the same one membership already draws: turning the section on and
  // saying what Brain may spend are decisions *about* the operation, while
  // filling in a card or recording a payment is work *inside* it.
  //
  // **No entry here names a worker scope, and that is the design.** An ADMIN
  // route refuses a worker by level; an unnamed write refuses one by
  // `MISSING_SCOPE`. So no machine credential reaches any cash route however
  // its membership is configured — §22's rule that a worker cannot create its
  // own work, applied where the work would cost somebody money. Every handler
  // additionally calls `requirePerson`, which refuses by principal *type*: two
  // independent guards, because a guard on one entrance is not a guard.
  //
  // The reads are deliberately absent, so they take the default READ. A worker
  // is still refused there by `requirePerson`; leaving them out is one fewer
  // entry that could drift.
  { pattern: /^\/api\/projects\/[^/]+\/cash\/mode$/, method: 'POST', level: 'ADMIN' },
  { pattern: /^\/api\/projects\/[^/]+\/cash\/authority/, level: 'ADMIN' },

  // ---------------------------------------------------------------------
  // The industry kernel's map (§38)
  // ---------------------------------------------------------------------
  //
  // Seeding a subject and retiring one are ADMIN, for the split above: both
  // are decisions *about* what the operation looks at rather than work inside
  // it, and `SEED` is the one node origin Brain itself may never write — a
  // machine that could name its own subjects would be deciding what the
  // economy is. Reading the map is deliberately absent and takes the default
  // READ, so every member of the project can see where Brain is looking.
  { pattern: /^\/api\/projects\/[^/]+\/cash\/industries/, method: 'POST', level: 'ADMIN' },
  { pattern: /^\/api\/projects\/[^/]+\/cash\/industries/, method: 'PATCH', level: 'ADMIN' },

  // ---------------------------------------------------------------------
  // The labor kernel (§41)
  // ---------------------------------------------------------------------
  //
  // Naming a workflow, naming a task, recording who produces one and retiring
  // any of them are ADMIN, for the split the section above already draws:
  // these are decisions *about* how the operation is run rather than work
  // inside it, and "who does this" is the shape of decision a membership
  // change already carries. `SEED` is the one task origin Brain itself may
  // never write.
  //
  // **No entry here names a worker scope, and that is the design.** An ADMIN
  // route refuses a worker by level; every handler additionally calls
  // `requirePerson`, which refuses one by principal *type*. A machine that
  // could decide a person is unnecessary — or that one is — is precisely what
  // §22's split exists to prevent.
  //
  // Reading is deliberately absent and takes the default READ, so every member
  // of the project can see who does the work here and why.
  { pattern: /^\/api\/projects\/[^/]+\/labor\//, method: 'POST', level: 'ADMIN' },
  { pattern: /^\/api\/projects\/[^/]+\/labor\//, method: 'PATCH', level: 'ADMIN' },
  // The manufacturing kernel's programme (§39)
  // ---------------------------------------------------------------------
  //
  // Every write is ADMIN, which is a wider sweep than the two sections above
  // and is deliberate rather than lazy. There are four writes here and each one
  // is a decision *about* the programme rather than work inside it: starting
  // it, moving its lifecycle, naming a category to look at, and — the one that
  // matters — recording that this company holds a capability.
  //
  // That last one is why the split is drawn here rather than at WRITE. Every
  // readiness answer, every capability gap and the whole question of what to
  // build next turns on which capabilities are held; a capability marked held
  // that is not is the error with a factory on the end of it. It is the one
  // fact in this kernel that research may never establish, so it must not be
  // reachable by anything less than the level a membership change already
  // carries.
  //
  // **No entry here names a worker scope, and that is the design.** An ADMIN
  // route refuses a worker by level, so no machine credential reaches any
  // manufacturing write however its membership is configured — §22's rule at
  // the surface that decides what gets built. Every handler additionally calls
  // `requirePerson`, which refuses by principal *type*: two independent guards,
  // because a guard on one entrance is not a guard.
  //
  // Reading the programme is deliberately absent and takes the default READ, so
  // every member of the project can see the ladder, what is missing and where
  // Brain is looking.
  { pattern: /^\/api\/projects\/[^/]+\/manufacturing/, method: 'POST', level: 'ADMIN' },
  { pattern: /^\/api\/projects\/[^/]+\/manufacturing/, method: 'PATCH', level: 'ADMIN' },
  // The cross-border dealflow kernel
  // ---------------------------------------------------------------------
  //
  // The same split, one kernel along. Seeding a party, retiring one and
  // recording what an attempt taught are ADMIN: the first two decide who the
  // market is — and `SEED` is the one party origin Brain itself may never
  // write — while an observation is the one fact in that kernel no source
  // publishes, so it is somebody's account of an attempt they made and
  // `recorded_by` carries their id.
  //
  // Reading is deliberately absent and takes the default READ, so every member
  // can see both sides of the map, every deal and how far it has got. No entry
  // names a worker scope, for the reason above: a worker is refused at the
  // ADMIN routes by level, at the reads by `requirePerson`, and at everything
  // by principal type.
  { pattern: /^\/api\/projects\/[^/]+\/cash\/dealflow/, method: 'POST', level: 'ADMIN' },
  { pattern: /^\/api\/projects\/[^/]+\/cash\/dealflow/, method: 'PATCH', level: 'ADMIN' },
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
