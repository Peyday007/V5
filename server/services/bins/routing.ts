/**
 * Which work a worker may be handed, decided from rows the worker does not own.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * `assignNextBin` offered the oldest ready bin in the caller's projects and
 * asked one question about it — is this session independent enough to review.
 * Everything else was a *fire*-time decision: `requiredCapabilities` chose which
 * Routine Brain started, and §27 argued at length that it could not also gate the
 * assignment, because Brain cannot tell which surface has turned up.
 *
 * **That argument was about the wrong subject, and the correction is recorded
 * rather than quietly applied.** It is true that Brain cannot identify the
 * arriving *Routine* — `worker_sessions` is keyed by the credential and the
 * credential is per-connector. It is not true that Brain cannot identify the
 * arriving *worker*: the worker id comes from the authenticated principal, which
 * is the one thing on the request built entirely from rows the server owns. A
 * boundary keyed on the worker is therefore enforceable at assignment, and the
 * dilemma §27 recorded — fail closed and stop all work, or fail open and waste a
 * fire — was a property of guessing the Routine and not of gating at all.
 *
 * Production showed what the missing boundary costs. One worker identity served
 * every surface in the fleet, and that identity held membership on the research
 * project — so a session started to implement a software repository checked in,
 * was offered the oldest ready bin, and claimed a Step 12A research item. Project
 * scoping was present and did nothing, because with one worker there was nothing
 * for it to separate. **A scope that cannot distinguish the callers it is meant to
 * separate is not a scope.**
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 *
 * A bin is handed over only when **every** dimension matches, and each one is
 * read from a row rather than from anything the caller sent:
 *
 *   1. **project** — the bin's `project_id` against the worker's active
 *      memberships carrying `queue:claim`. Unchanged; `assignNextBin` already
 *      scopes its candidate query by it.
 *   2. **workload family** — derived from the bin's own `workload_class`, against
 *      the families this worker may serve.
 *   3. **repository** — for a family whose work is a change to a repository, the
 *      remote on the bin's manifest against the repositories this worker may act
 *      on. A repository family with no repository named is refused.
 *   4. **capabilities** — the bin's `requiredCapabilities` against the worker's
 *      declared routing capabilities, when the worker has declared any.
 *   5. **authorization scope** — the membership scopes the family needs.
 *   6. **independence** — the existing lineage floor, unchanged, still asked
 *      before the lease so a refusal costs no attempt.
 *
 * ---------------------------------------------------------------------------
 * Deny by default, where the default can mean something
 * ---------------------------------------------------------------------------
 *
 * An explicit `worker_routing` row is **exhaustive**: the families it lists are
 * the only families that worker may be handed, and the repositories it lists are
 * the only repositories. That is what makes a worker registered for software work
 * unable to claim research, which is the separation this module exists for.
 *
 * A worker with **no** row serves the families its *scopes* already imply, and
 * **no repository family at all**. Two alternatives were considered and are worth
 * saying out loud:
 *
 *   - *No row means nothing.* Strictly deny-by-default, and it would have
 *     stopped every live worker the moment it deployed, until somebody wrote rows
 *     for identities a migration cannot name. A control that halts the system it
 *     protects gets turned off.
 *   - *No row means everything.* The boundary becomes opt-in, which is exactly
 *     the state that produced the defect: the separation exists in a table nobody
 *     filled in.
 *
 * So the default is deny for the dimension that was actually crossed — repository
 * work is never implicit — and derived from existing rows for the rest. Nothing
 * halts, and no worker gains reach it did not already have.
 */
import type { Bin, Principal, WorkItemRow, WorkerScope } from '../../domain/types.ts';

/**
 * The families Brain routes by.
 *
 * Deliberately coarse. The question a boundary has to answer is *what kind of
 * thing is this worker for*, and a family per bin kind would be a second copy of
 * the bin vocabulary that drifts from it.
 */
export const WORKLOAD_FAMILIES = ['RESEARCH', 'FACTORY', 'GENERAL'] as const;
export type WorkloadFamily = (typeof WORKLOAD_FAMILIES)[number];

/** The families whose work is a change to a repository. */
export const REPOSITORY_FAMILIES: readonly WorkloadFamily[] = ['FACTORY'];

/**
 * The family of a bin, from the bin's own columns.
 *
 * `workload_class` is set by whatever created the bin and is never supplied by a
 * caller, which is why it is the input. The bin *kind* and the completion
 * contract are read as well, because a class can be absent on a row written
 * before it existed and a family that guessed in that case would be guessing
 * about the one thing it must not.
 */
export function familyOf(
  bin: Partial<Pick<Bin, 'kind' | 'workloadClass' | 'completionContract' | 'manifest'>>,
): WorkloadFamily {
  /*
   * A bin whose manifest names a repository is repository work, whatever its
   * class says — and this is the load-bearing half rather than a belt-and-braces
   * one. The other signals are *labels* applied by whatever created the bin; the
   * repository block is the work itself. A factory bin written before
   * `workload_class` existed, or by a path that forgot to set it, would otherwise
   * classify as general work and be handed to a research surface, which is the
   * exact crossing this module exists to prevent.
   */
  if (typeof bin.manifest?.repository?.remote === 'string' && bin.manifest.repository.remote.length > 0) {
    return 'FACTORY';
  }
  /*
   * Absent is absent. These columns are nullable and a synthetic row may carry
   * none of them, so a missing signal contributes nothing rather than throwing —
   * a family that crashed the router would stop every dispatch, and a family that
   * guessed would be worse than either.
   */
  const signals = [bin.workloadClass, bin.kind, bin.completionContract].filter(
    (signal): signal is string => typeof signal === 'string' && signal.length > 0,
  );
  if (signals.some((signal) => signal.startsWith('FACTORY'))) return 'FACTORY';
  if (
    signals.some(
      (signal) =>
        signal.startsWith('RESEARCH') ||
        signal.startsWith('RUSSELL') ||
        signal.startsWith('SURFACE_PROBE'),
    )
  ) {
    return 'RESEARCH';
  }
  return 'GENERAL';
}

/** The workload classes a family covers, for scoping a candidate query. */
export function classesForFamilies(families: readonly WorkloadFamily[]): {
  prefixes: string[];
  allowsNull: boolean;
} {
  const prefixes: string[] = [];
  if (families.includes('FACTORY')) prefixes.push('FACTORY');
  if (families.includes('RESEARCH')) prefixes.push('RESEARCH', 'RUSSELL', 'SURFACE_PROBE');
  // A row with no class is GENERAL, so only a GENERAL worker may be offered one.
  return { prefixes, allowsNull: families.includes('GENERAL') };
}

/** What a worker may be handed. An explicit row is exhaustive. */
export interface WorkerRouting {
  workerId: string;
  families: WorkloadFamily[];
  /** Repository ids — the envelope's own identifiers, never a remote URL. */
  repositories: string[];
  capabilities: string[];
  reason: string;
  explicit: boolean;
}

/**
 * The families a worker with no explicit row serves.
 *
 * Read from the membership scopes it already holds, so this grants nothing new:
 * a worker that may write research serves research, a worker that may only claim
 * serves general work, and **no** scope implies a repository family.
 */
export function derivedFamilies(principal: Principal): WorkloadFamily[] {
  return derivedFamiliesFrom(principal.memberships);
}

/**
 * The same rule, over a membership list rather than a principal.
 *
 * One function with two callers rather than two functions with one rule, because
 * the fire router reads memberships straight from the repository (it has no
 * principal — nobody has authenticated) and a second copy of this would be a rule
 * applied by one of two readers, which is worse than none: the two would disagree
 * about the same worker and the disagreement would look like a routing bug.
 */
export function derivedFamiliesFrom(
  memberships: ReadonlyArray<{ active: boolean; scopes: readonly string[] }>,
): WorkloadFamily[] {
  const scopes = new Set<string>();
  for (const membership of memberships) {
    if (!membership.active) continue;
    for (const scope of membership.scopes) scopes.add(scope);
  }
  const families: WorkloadFamily[] = ['GENERAL'];
  if (scopes.has('research:write')) families.unshift('RESEARCH');
  return families;
}

export type RoutingRefusal =
  | 'PROJECT_OUT_OF_SCOPE'
  | 'FAMILY_NOT_SERVED'
  | 'REPOSITORY_NOT_AUTHORIZED'
  | 'REPOSITORY_NOT_NAMED'
  | 'CAPABILITY_NOT_DECLARED'
  | 'SCOPE_MISSING';

export interface RoutingDecision {
  ok: boolean;
  refusal?: RoutingRefusal;
  family: WorkloadFamily;
  reason?: string;
}

/** The repository a bin's work is a change to, as an owner/name id. */
export function repositoryIdOf(bin: Pick<Bin, 'manifest'>): string | null {
  const remote = bin.manifest.repository?.remote;
  if (typeof remote !== 'string' || remote.length === 0) return null;
  /*
   * Normalised the same way the repository envelope normalises a grant, because
   * the two are compared against each other: a trailing slash, a `.git` suffix and
   * the case of the host are all the same repository, and an id that disagreed
   * about any of them would authorize by spelling.
   */
  const trimmed = remote.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  const match = /github\.com[/:]([^/]+)\/([^/]+)$/.exec(trimmed);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/**
 * The whole decision, in one pure function over a snapshot.
 *
 * Pure on purpose, for `router.ts`'s reason: "why was this worker refused this
 * bin" has to be answerable afterwards from recorded inputs rather than from a
 * re-run against a database that has moved. Being pure also means it is not the
 * exclusion — the compare-and-swap in `assignNextBin` is — so this can refuse
 * work that was already taken and can never hand the same bin to two workers.
 */
export function decideBinRouting(input: {
  bin: Bin;
  principal: Principal;
  routing: WorkerRouting;
}): RoutingDecision {
  const family = familyOf(input.bin);

  const membership = input.principal.memberships.find(
    (candidate) => candidate.active && candidate.projectId === input.bin.projectId,
  );
  if (!membership) {
    return {
      ok: false,
      refusal: 'PROJECT_OUT_OF_SCOPE',
      family,
      reason: 'This worker holds no active membership on the project that owns this bin.',
    };
  }
  const scopes = membership.scopes as WorkerScope[];
  if (!scopes.includes('queue:claim')) {
    return {
      ok: false,
      refusal: 'SCOPE_MISSING',
      family,
      reason: 'This worker may not claim work on that project.',
    };
  }

  if (!input.routing.families.includes(family)) {
    return {
      ok: false,
      refusal: 'FAMILY_NOT_SERVED',
      family,
      reason:
        `This worker serves [${input.routing.families.join(', ')}] and this is ${family} work. ` +
        (input.routing.explicit
          ? 'Its routing row lists the families it may be handed, and that list is exhaustive.'
          : 'It has no routing row, so it serves what its scopes imply and no repository work.'),
    };
  }

  if (REPOSITORY_FAMILIES.includes(family)) {
    const repository = repositoryIdOf(input.bin);
    if (!repository) {
      return {
        ok: false,
        refusal: 'REPOSITORY_NOT_NAMED',
        family,
        reason:
          'This is repository work whose manifest names no repository, so there is nothing to ' +
          'authorize it against.',
      };
    }
    if (!input.routing.repositories.includes(repository)) {
      return {
        ok: false,
        refusal: 'REPOSITORY_NOT_AUTHORIZED',
        family,
        reason: `This worker is not authorized for ${repository}.`,
      };
    }
  }

  /*
   * Capabilities, asked only of a worker that declared some.
   *
   * A worker with no declared capabilities is not asserting that it has none —
   * the column is how an operator *narrows* a surface, and reading silence as a
   * denial would refuse every worker registered before this existed. A worker
   * that has declared them is held to them exactly.
   */
  if (input.routing.capabilities.length > 0) {
    const missing = input.bin.requiredCapabilities.filter(
      (capability) => !input.routing.capabilities.includes(capability),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        refusal: 'CAPABILITY_NOT_DECLARED',
        family,
        reason: `This worker does not declare ${missing.join(', ')}, which this bin needs.`,
      };
    }
  }

  return { ok: true, family };
}

/**
 * The family of a queue work item, from its work type.
 *
 * The queue is the other entrance to the same separation. A bin carries a
 * manifest; a work item carries only a type, so that is what is read — and
 * nothing at the item level is repository work, because repository work is
 * described by a bin's manifest and never by a queue row. So the honest
 * mapping is research prefixes to RESEARCH and everything else to GENERAL.
 */
export function familyOfWorkType(workType: string): WorkloadFamily {
  if (workType.startsWith('RESEARCH') || workType.startsWith('RUSSELL')) return 'RESEARCH';
  return 'GENERAL';
}

/**
 * The same boundary, as a `claimWork` admission hook.
 *
 * `assignNextBin` is not the only way a worker reaches research work: the Step 5
 * queue hands out `RESEARCH_AUDIT` and `RESEARCH_FRAGMENT` items directly, at
 * the MCP tool, the HTTP route and the bin drain. A guard on the bin alone would
 * leave a worker registered for one repository able to claim a Step 12A audit
 * role by asking the queue for it instead — and that is the crossing this whole
 * boundary exists to stop, one layer down.
 *
 * It refuses *before* the compare-and-swap like every other admission hook, so a
 * refused worker spends no attempt, no lease and no generation.
 */
export function workloadAdmission(routing: WorkerRouting) {
  return async (item: WorkItemRow): Promise<{ ok: boolean; reason?: string }> => {
    const family = familyOfWorkType(item.work_type);
    if (routing.families.includes(family)) return { ok: true };
    return {
      ok: false,
      reason:
        `this worker serves [${routing.families.join(', ') || 'nothing'}] and ` +
        `${item.work_type} is ${family} work`,
    };
  };
}

/**
 * Ask every admission rule, in order, and stop at the first refusal.
 *
 * Scope before independence, for the reason the bin path gives: a worker that
 * may not be handed this class of work at all should be refused for that, and
 * told that, rather than being told something about an audit role it was never
 * eligible to hold.
 */
export function allAdmissions(
  hooks: ReadonlyArray<(item: WorkItemRow) => Promise<{ ok: boolean; reason?: string }>>,
) {
  return async (item: WorkItemRow): Promise<{ ok: boolean; reason?: string }> => {
    for (const hook of hooks) {
      const verdict = await hook(item);
      if (!verdict.ok) return verdict;
    }
    return { ok: true };
  };
}
