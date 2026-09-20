/**
 * Is the Factory a pool, or is it one surface and some rows?
 *
 * ---------------------------------------------------------------------------
 * Why `verify-surface` is not enough
 * ---------------------------------------------------------------------------
 *
 * `proveSurface` asks the right question about one Routine and it asks it well:
 * four rows Brain wrote itself — fired, arrived as the bound worker, assigned,
 * completed. What it cannot do is answer the question an operator actually has
 * once there is more than one account, which is *are all of them like that*.
 *
 * Running it per `--ref` and reading the answers by eye is not the same thing,
 * for two reasons that are the whole argument for this module:
 *
 *   1. **Nothing says what the expected set is.** A pool with one surface
 *      missing looks exactly like a pool with one fewer account, and an operator
 *      who forgot to register the fourth Routine gets four green answers to
 *      three questions. The expected set has to be derived from rows — every
 *      Routine bound to a worker authorized for this repository — and reported
 *      whole.
 *
 *   2. **A probe cannot reach a named surface without help.** Several Factory
 *      Routines bound to one logical worker have identical project, family,
 *      repository and capability scope, so an ordinary probe bin goes to
 *      whichever has the most headroom. Firing repeatedly and hoping each
 *      surface eventually takes one is a sampling strategy, and it can report a
 *      pool proven while a member of it has never run anything. `bins.
 *      pinned_routine_id` is the answer, and this module is what uses it.
 *
 * ---------------------------------------------------------------------------
 * What it refuses to do
 * ---------------------------------------------------------------------------
 *
 * It reads. It does not register a surface, mint a credential, lift a
 * quarantine, widen a scope or relax a check to make a verdict come out green —
 * §29's rule that reading a state is not the same act as clearing it. The one
 * thing it may *write*, and only when a caller asks for it, is a bounded probe
 * bin per unproven surface, through `createProbeBin`, which forbids every
 * repository operation in its own manifest.
 *
 * The decision is a pure function over a snapshot for `router.ts`'s reason: "why
 * did this pool fail" has to be answerable afterwards from a recorded input
 * rather than from a re-run against a database that has moved.
 */
import type { Bin, BinDispatch, FleetAccount, FleetRoutine } from '../../domain/types.ts';
import type { WorkerSession } from '../../repos/fleet.ts';
import { proveSurface, type SurfaceChain } from './surfaceProof.ts';

/** What a surface is, once every row about it has been read. */
export interface PoolSurfaceInput {
  routine: FleetRoutine;
  account: FleetAccount;
  /** The worker `fleet_routines.worker_id` names, resolved. */
  worker: { id: string; name: string; archived: boolean } | null;
  /** That worker's explicit routing row, or null when it has none. */
  routing: { families: string[]; repositories: string[]; capabilities: string[] } | null;
  /** Whether this deployment actually holds the secret the row names. */
  secretPresent: boolean;
  /** Live memberships of the bound worker, for the project dimension. */
  projects: string[];
  /** In-flight activations attributed to this Routine, and to its account. */
  routineInFlight: number;
  accountInFlight: number;
  routineTarget: number | null;
  accountTarget: number | null;
  /** Arrivals attributed to this Routine, newest first. */
  sessions: readonly WorkerSession[];
  bins: ReadonlyMap<string, Bin | null>;
  dispatches: ReadonlyMap<string, readonly BinDispatch[]>;
}

export type PoolVerdict = 'PROVEN' | 'UNPROVEN' | 'FAULT';

export interface PoolSurface {
  routineId: string;
  routineRef: string;
  routineName: string;
  accountName: string;
  /** The worker this surface is bound to, by name, or null. */
  boundWorker: string | null;
  /** Whether the bound worker is the one the pool is supposed to be. */
  authenticatesAsExpected: boolean;
  /** Could a bin be routed here right now, and if not, why not. */
  eligible: boolean;
  ineligibleBecause: string[];
  /** Room against the tighter of the two targets, as used/limit. */
  headroom: { used: number; limit: number | null };
  /** When the provider said to try again, if it did. */
  cooldownUntil: string | null;
  /** The most recent fire and what became of it. */
  lastFiredAt: string | null;
  lastOutcome: string;
  /** The four-row chain, when it is closed. */
  chain: SurfaceChain | null;
  verdict: PoolVerdict;
  problems: string[];
}

export interface PoolReport {
  /** The logical worker every surface in this pool must authenticate as. */
  expectedWorkerName: string;
  repository: string;
  surfaces: PoolSurface[];
  /** True only when every expected surface closed its own chain. */
  ok: boolean;
  /** One sentence per thing that stops this being a pool. */
  problems: string[];
  /**
   * One sentence per thing a reader is owed that is **not** a failure.
   *
   * These used to live in `problems`, which made them invisible exactly when
   * they mattered: `ok` never counted them, so the only run that printed them
   * was one that had already failed for some other reason. A caveat you see
   * only after something else went wrong is not a caveat, and it also made the
   * refusal line over-count — "2 problem(s)" over one problem and one note.
   */
  notes: string[];
}

export interface PoolInput {
  expectedWorker: { id: string; name: string };
  repository: string;
  surfaces: PoolSurfaceInput[];
}

/**
 * Judge the pool, from rows somebody else read.
 *
 * A surface is `PROVEN` only with a closed chain **and** no fault; `FAULT` when
 * an arrival on it authenticated as a different worker, which is the failure the
 * whole exercise exists to catch and is never merely a missing proof; and
 * `UNPROVEN` otherwise, which is the ordinary state of a surface nothing has
 * been sent to yet.
 */
export function judgePool(input: PoolInput): PoolReport {
  const surfaces: PoolSurface[] = input.surfaces.map((surface) =>
    judgeSurface(surface, input.expectedWorker, input.repository),
  );

  const problems: string[] = [];
  if (surfaces.length === 0) {
    problems.push(
      `No registered Routine is bound to a worker authorized for ${input.repository}, so there is ` +
        'no pool to verify. Onboard the repository and register one Routine per Claude account.',
    );
  }
  const notes: string[] = [];
  if (surfaces.length === 1) {
    /*
     * Said rather than counted as a failure. One surface is a working Factory
     * and a complete answer to "can this run at all"; it is not a pool, and a
     * command that reported a pool verified over a single account would be
     * exactly the rounding-up §23 refuses everywhere else.
     *
     * So it is a note rather than a problem: it must be printed on the green
     * run, which is the only run where somebody could otherwise read
     * "VERIFIED" as "pooled".
     */
    notes.push(
      'Only one surface is registered for this repository, so nothing here is pooled: there is ' +
        'no second account to run in parallel with, and no failover. That is a complete ' +
        'single-surface Factory and it is reported as one.',
    );
  }
  for (const surface of surfaces) {
    if (surface.verdict !== 'PROVEN') {
      problems.push(`${surface.routineName} (${surface.accountName}): ${surface.problems.join('; ')}`);
    }
  }

  return {
    expectedWorkerName: input.expectedWorker.name,
    repository: input.repository,
    surfaces,
    // Every expected surface, or none of it. A pool with one member unproven is
    // a pool that will hand work to something nothing has ever run on.
    ok: surfaces.length > 0 && surfaces.every((surface) => surface.verdict === 'PROVEN'),
    problems,
    notes,
  };
}

function judgeSurface(
  input: PoolSurfaceInput,
  expected: { id: string; name: string },
  repository: string,
): PoolSurface {
  const problems: string[] = [];
  const ineligible: string[] = [];

  const boundWorker = input.worker?.name ?? null;
  const authenticatesAsExpected = input.routine.workerId === expected.id;
  if (!input.routine.workerId) {
    problems.push('bound to no worker, so nothing about its identity can be verified');
  } else if (!authenticatesAsExpected) {
    problems.push(
      `bound to ${boundWorker ?? input.routine.workerId} rather than ${expected.name} — ` +
        'a pool is one logical worker on several surfaces, and this one is a different identity',
    );
  }
  if (input.worker?.archived) problems.push('the bound worker is archived');

  // Eligibility, in the same order and from the same rows the fire router uses,
  // so this reports what would actually happen rather than a second opinion.
  if (input.account.state !== 'ENABLED') ineligible.push(`account ${input.account.state}`);
  if (input.routine.state !== 'ENABLED') {
    ineligible.push(
      `routine ${input.routine.state}` +
        (input.routine.stateReason ? `: ${input.routine.stateReason}` : ''),
    );
  }
  if (!input.secretPresent) ineligible.push(`the deployment has no secret named ${input.routine.tokenSecretName}`);
  if (input.projects.length === 0) ineligible.push('its worker holds no live project membership');
  if (!input.routing) {
    ineligible.push('its worker has no routing row, so it may never be handed repository work');
  } else {
    if (!input.routing.families.includes('FACTORY')) ineligible.push('its worker does not serve FACTORY work');
    if (!input.routing.repositories.includes(repository)) {
      ineligible.push(`its worker is not authorized for ${repository}`);
    }
    /*
     * A Factory surface that also serves research is not a separated identity
     * however its connector is named, and every routing boundary downstream
     * would pass while separating nothing. `verify-surface` already refuses this
     * for one Routine; a pool has to refuse it for each.
     */
    const alsoServes = input.routing.families.filter((family) => family !== 'FACTORY');
    if (alsoServes.length > 0) {
      problems.push(
        `its worker also serves [${alsoServes.join(',')}] — a Factory identity must not be handed research work`,
      );
    }
  }
  for (const tag of ['repository', 'repository-write']) {
    if (!input.routine.capabilities.includes(tag)) ineligible.push(`does not declare ${tag}`);
  }

  const limit =
    input.routineTarget ?? input.accountTarget ?? null;
  const used = Math.max(input.routineInFlight, input.accountInFlight);
  if (limit !== null && used >= limit) ineligible.push(`at target ${used}/${limit}`);
  const cooldownUntil = laterOf(input.routine.retryAt, input.account.retryAt);

  const proof = proveSurface({
    boundWorkerId: input.routine.workerId ?? '',
    routineRef: input.routine.routineRef,
    sessions: input.sessions,
    bins: input.bins,
    dispatches: input.dispatches,
  });
  // A foreign arrival is a fault rather than a missing proof, and it is reported
  // even when the chain happens to be closed by some other session.
  const fault = proof.foreignWorkerIds.length > 0 || !authenticatesAsExpected;
  problems.push(...proof.problems.filter((problem) => !problems.includes(problem)));

  const verdict: PoolVerdict = fault ? 'FAULT' : proof.chain ? 'PROVEN' : 'UNPROVEN';
  if (verdict === 'PROVEN') problems.length = 0;

  return {
    routineId: input.routine.id,
    routineRef: input.routine.routineRef,
    routineName: input.routine.name,
    accountName: input.account.name,
    boundWorker,
    authenticatesAsExpected,
    eligible: ineligible.length === 0,
    ineligibleBecause: ineligible,
    headroom: { used, limit },
    cooldownUntil,
    lastFiredAt: input.routine.lastFiredAt,
    lastOutcome: lastOutcomeOf(input.routine),
    chain: proof.chain,
    verdict,
    problems,
  };
}

/**
 * What became of the most recent fire, in one phrase.
 *
 * Read from the counters the dispatcher maintains rather than from a log line,
 * and deliberately vague where the rows are: `fleet_routines` records totals and
 * a quarantine reason, not a per-fire outcome, so this says what those totals
 * support and no more. A phrase that implied a per-fire record would be a figure
 * that was never measured.
 */
/**
 * What happened the last time Brain fired this surface, in a person's words.
 *
 * Exported because the Fleet view needs the identical sentence: two readers
 * composing their own account of one row is how the terminal and the screen
 * come to disagree about the same surface, which is the defect §29 records
 * about a status that contradicts the control beside it.
 */
export function lastOutcomeOf(routine: FleetRoutine): string {
  if (routine.totalFires === 0) return 'never fired';
  if (routine.state === 'QUARANTINED') {
    return `quarantined${routine.stateReason ? `: ${routine.stateReason.slice(0, 120)}` : ''}`;
  }
  if (routine.consecutiveNoShows > 0) {
    return `${routine.consecutiveNoShows} consecutive fire(s) with nobody arriving`;
  }
  return `${routine.totalFires} fired, ${routine.totalRefusals} refused, last at ${routine.lastFiredAt ?? 'unknown'}`;
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/* ------------------------------------------------------------------------ */
/* The impure half                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Read every row the judgment needs, once.
 *
 * Kept below the pure function rather than in a module of its own because there
 * is one reader and one caller; splitting it would be two files to keep in step
 * for no property gained. What it must not become is a second place that decides
 * anything — everything here fetches, and `judgePool` alone judges.
 *
 * The **expected set** is derived rather than configured: every registered
 * Routine whose bound worker is the named logical worker. A Routine bound to
 * something else is not in the pool and is not silently dropped either — it is
 * reported by `verifyFactoryPool` below, because a surface that was *meant* to be
 * in the pool and is bound elsewhere is the exact mistake a second connector name
 * invites, and a set that quietly excluded it would hide it.
 */
export async function readFactoryPool(input: {
  workerName: string;
  repository: string;
  now?: Date;
}): Promise<PoolInput & { boundElsewhere: { routineRef: string; accountName: string; workerId: string }[] }> {
  const { getWorkerByName, getWorker, getWorkerRouting, listMembershipsForPrincipal } = await import(
    '../../repos/identity.ts'
  );
  const { listAccounts, listRoutines, currentPolicy, effectiveTarget, sessionsForRoutine } =
    await import('../../repos/fleet.ts');
  const { getBin, listDispatchesForBin } = await import('../../repos/bins.ts');
  const { inFlightByRoutine } = await import('./candidates.ts');
  const { resolveToken } = await import('./fire.ts');

  const expectedWorker = await getWorkerByName(input.workerName);
  if (!expectedWorker) {
    throw new Error(
      `No worker named ${input.workerName} exists, so there is no logical Factory identity to ` +
        'verify a pool against. Onboard the repository first.',
    );
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const [accounts, routines, perRoutine] = await Promise.all([
    listAccounts(),
    listRoutines(),
    inFlightByRoutine(now.getTime()),
  ]);
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  const perAccount = new Map<string, number>();
  for (const routine of routines) {
    const n = perRoutine.get(routine.id) ?? 0;
    perAccount.set(routine.accountId, (perAccount.get(routine.accountId) ?? 0) + n);
  }

  const surfaces: PoolSurfaceInput[] = [];
  const boundElsewhere: { routineRef: string; accountName: string; workerId: string }[] = [];

  for (const routine of routines) {
    const account = accountById.get(routine.accountId);
    if (!account) continue;
    if (routine.workerId !== expectedWorker.id) {
      /*
       * Reported only when it looks like it was meant to be a Factory surface.
       * Every research Routine in a Brain is bound elsewhere and listing all of
       * them would bury the one that matters.
       */
      const looksFactory = routine.capabilities.includes('repository');
      if (looksFactory && routine.workerId) {
        boundElsewhere.push({
          routineRef: routine.routineRef,
          accountName: account.name,
          workerId: routine.workerId,
        });
      }
      continue;
    }

    const worker = await getWorker(routine.workerId);
    const routing = await getWorkerRouting(routine.workerId);
    const memberships = await listMembershipsForPrincipal('WORKER', routine.workerId);
    const [routinePolicy, accountPolicy] = await Promise.all([
      currentPolicy('ROUTINE', routine.id),
      currentPolicy('ACCOUNT', account.id),
    ]);

    const sessions = await sessionsForRoutine(routine.id, 20);
    const bins = new Map<string, Bin | null>();
    const dispatches = new Map<string, readonly BinDispatch[]>();
    for (const session of sessions) {
      if (!bins.has(session.binId)) bins.set(session.binId, await getBin(session.binId));
      if (!dispatches.has(session.binId)) {
        dispatches.set(session.binId, await listDispatchesForBin(session.binId));
      }
    }

    surfaces.push({
      routine,
      account,
      worker: worker ? { id: worker.id, name: worker.name, archived: worker.archived } : null,
      routing: routing
        ? {
            families: routing.families,
            repositories: routing.repositories,
            capabilities: routing.capabilities,
          }
        : null,
      secretPresent: Boolean(resolveToken(routine.tokenSecretName)),
      projects: memberships.filter((membership) => membership.active).map((m) => m.projectId),
      routineInFlight: perRoutine.get(routine.id) ?? 0,
      accountInFlight: perAccount.get(account.id) ?? 0,
      routineTarget: routinePolicy ? effectiveTarget(routinePolicy, nowIso).target : null,
      accountTarget: accountPolicy ? effectiveTarget(accountPolicy, nowIso).target : null,
      sessions,
      bins,
      dispatches,
    });
  }

  return {
    expectedWorker: { id: expectedWorker.id, name: expectedWorker.name },
    repository: input.repository,
    surfaces,
    boundElsewhere,
  };
}

/** Read the rows and judge them, which is what every caller actually wants. */
export async function verifyFactoryPool(input: {
  workerName: string;
  repository: string;
  now?: Date;
}): Promise<PoolReport & { boundElsewhere: { routineRef: string; accountName: string; workerId: string }[] }> {
  const read = await readFactoryPool(input);
  const report = judgePool(read);
  for (const stray of read.boundElsewhere) {
    report.problems.push(
      `${stray.routineRef} on ${stray.accountName} declares a repository capability but is bound to ` +
        `${stray.workerId} rather than ${report.expectedWorkerName}. If it is meant to be part of this ` +
        'pool its connector was authorized as the wrong identity; `fleet repoint-worker` corrects the ' +
        'row, and the connector itself has to be reconnected against the right worker.',
    );
  }
  return {
    ...report,
    // A surface that should be in the pool and is not cannot leave the verdict green.
    ok: report.ok && read.boundElsewhere.length === 0,
    boundElsewhere: read.boundElsewhere,
  };
}
