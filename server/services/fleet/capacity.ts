/**
 * How much research capacity this Brain actually has, from one definition.
 *
 * ---------------------------------------------------------------------------
 * The defect this file exists for
 * ---------------------------------------------------------------------------
 *
 * The Cash page reported `1 / 4 HEALTHY` while `fleet show` — reading the
 * dispatcher's own snapshot at the same instant — reported *"candidates 7
 * considered, 4 eligible now"*. Neither number was wrong and neither was about
 * the other:
 *
 *   * `cashReadiness` counted **accounts**, one row each, and asked whether any
 *     Routine under an account had ever fired. Production has four research
 *     Routines — `Brain Research A`, `1-B`, `1-C`, `1-D` — and all four sit
 *     under the *same* account, so four surfaces read as one. Beside it,
 *     `friend-2` held a single quarantined Routine and read as a second
 *     account, unavailable.
 *   * The dispatcher counts **Routines**, because a Routine is the thing it
 *     fires. §23 states the distinction in its own first sentence — *an account
 *     is not a Routine* — and then says a second Routine under one account
 *     doubles how fast Brain can start sessions. Measuring capacity in accounts
 *     is the arithmetic-on-a-fiction that section already corrected once.
 *
 * And the denominator was a constant, `REQUIRED_CAPACITY_ACCOUNTS = 4`, written
 * when the intended topology was four people with one account each. It was
 * never a measurement of anything, and a screen showing `1 / 4` invites a
 * reader to conclude three quarters of the fleet is broken.
 *
 * ---------------------------------------------------------------------------
 * What replaces it
 * ---------------------------------------------------------------------------
 *
 * One source: `fleetSnapshot()`, the same impure read `services/dispatch/loop.ts`
 * performs every tick. A surface that is a `candidate` is a surface the
 * dispatcher would consider; a surface under `missingSecrets` is one it
 * deliberately skips. Nothing here re-derives either, so the page and the
 * dispatcher cannot disagree about which surfaces exist.
 *
 * Three readings come out of it, and they are **labelled as three readings
 * rather than collapsed into one number**, because they are genuinely different
 * facts with different remedies:
 *
 *   * `eligibleNow` — the dispatcher would fire it this instant. This is
 *     `fleet show`'s "eligible now", to the row.
 *   * `proven` — a session Brain fired has arrived on it, been handed a bin and
 *     finished one. §32's rule: registered-with-a-secret is CONFIGURED, and
 *     calling that HEALTHY is the claim §23 refuses.
 *   * `target` — a number an operator configured. A target, never a capability
 *     and never an authorization gate. It is reported beside the others and
 *     labelled, rather than used as a denominator that implies failure.
 *
 * It reads and writes nothing. No fire, no enqueue, no registration, no
 * credential is touched by asking this question — which is what makes it safe
 * to put behind a page anybody may open.
 */
import { fleetSnapshot } from '../dispatch/candidates.ts';
import { effectiveTarget, listAccounts, sessionsForRoutine } from '../../repos/fleet.ts';
import { getBin, listDispatchesForBin } from '../../repos/bins.ts';
import { proveSurface } from '../dispatch/surfaceProof.ts';
import { surfaceIneligibility } from '../dispatch/router.ts';
import { nowIso } from '../../repos/util.ts';
import type { Bin, BinDispatch, FleetAccount, FleetRoutine } from '../../domain/types.ts';

/**
 * What a surface is, in the four words a person can act on.
 *
 * `HEALTHY` and `CONFIGURING` are both eligible: the dispatcher would fire
 * either. The difference is whether anything has come back, and it is kept
 * because the remedies differ — a CONFIGURING surface needs one bounded probe,
 * and a HEALTHY one needs nothing.
 */
export type SurfaceHealth = 'HEALTHY' | 'CONFIGURING' | 'WAITING' | 'UNAVAILABLE';

export interface SurfaceReading {
  routineId: string;
  /** The display label. Never the trigger ref and never the secret's name. */
  name: string;
  accountId: string;
  accountName: string;
  health: SurfaceHealth;
  /**
   * Has a fire to this surface ever arrived and finished a piece of work?
   *
   * `proveSurface`'s four-row chain, reported as its own fact rather than only
   * through `HEALTHY` — which is *eligible **and** proven*, so it collapses two
   * questions with different remedies into one word. A surface that ran real
   * work and whose deployment secret has since been removed reads `WAITING`,
   * correctly, and a reader could not tell it from one that has never run at
   * all: *we could not tell* reading the same as *we checked*, which this file
   * refuses everywhere else.
   *
   * It is history, and history does not stop having happened, so nothing here
   * can lower it. It is deliberately at the top level rather than in `detail`:
   * it names no Routine, no account, no credential and no identifier, and
   * whether a connection has actually run is exactly what §32 says its owner is
   * owed.
   */
  proven: boolean;
  /** Why it is not HEALTHY, with the remedy in it. Absent when it is. */
  because?: string;
  /** Operator depth only; see `CapacityReading.diagnostics`. */
  detail?: {
    routineRef: string;
    secretName: string;
    secretPresent: boolean;
    workerId: string | null;
    state: string;
    accountState: string;
    totalFires: number;
    totalRefusals: number;
    /**
     * Fires at this surface that nobody answered, since it last answered.
     *
     * Derived per surface rather than read from
     * `fleet_routines.consecutive_no_shows`, which is the number every screen
     * used to print under this heading and which cannot express a pool: an
     * arrival clears it for **every** Routine bound to the same worker, so in a
     * fleet of several Claude accounts on one identity a dead surface reads 0
     * because its healthy siblings keep answering. It is also 1 on a perfectly
     * healthy surface whose worker is still booting, since it is advanced
     * optimistically on each successful fire.
     *
     * The same function the dispatcher quarantines on, so a screen cannot
     * disagree with the decision it is describing.
     */
    unansweredFires: number;
    /** The provider's own words for a quarantine, when there are any. */
    stateReason: string | null;
    lastArrivalAt: string | null;
    lastCompletedBinId: string | null;
    retiredOrHistorical: boolean;
  };
}

export interface CapacityReading {
  /**
   * The dispatcher's own answer to "could this be fired right now".
   *
   * Taken from `fleetSnapshot().candidates` rather than recomputed, so this is
   * the number `fleet show` prints and the number the loop acts on.
   */
  eligibleNow: number;
  /** Of those, how many have a completed fire→arrive→assign→finish chain. */
  proven: number;
  /** Registered, but something an operator must do is outstanding. */
  waiting: number;
  /** Registered and not routable at all: quarantined, paused, unbound. */
  unavailable: number;
  /**
   * The concurrency target somebody configured, or null when nobody has.
   *
   * A target. It is not a count of anything that exists and it gates nothing —
   * §32 removed the last count on this surface that did.
   */
  target: number | null;
  /** One line per surface, in the order a person reads them. */
  surfaces: SurfaceReading[];
  /**
   * Surfaces kept for their history and deliberately out of active dispatch.
   *
   * Separated rather than dropped: a retired Routine is a fact about this fleet
   * and deleting it from the screen would make the history unreadable, while
   * mixing it into the live list would make a person think something is broken.
   */
  historical: SurfaceReading[];
}

/** Is this surface one the dispatcher would fire this instant? */
function rateLimited(routine: FleetRoutine, account: FleetAccount, now: string): boolean {
  return (
    (routine.retryAt !== null && routine.retryAt > now) ||
    (account.retryAt !== null && account.retryAt > now)
  );
}

/**
 * Has a fire to this Routine ever come back and finished something?
 *
 * The four-row chain of `proveSurface`, assembled exactly as
 * `fleet verify-surface` assembles it, because two readers of one proof would
 * eventually disagree about whether a surface works.
 */
async function provenChain(routine: FleetRoutine): Promise<{
  proven: boolean;
  lastArrivalAt: string | null;
  lastCompletedBinId: string | null;
}> {
  if (!routine.workerId) return { proven: false, lastArrivalAt: null, lastCompletedBinId: null };
  const sessions = await sessionsForRoutine(routine.id, 20);
  const bins = new Map<string, Bin | null>();
  const dispatches = new Map<string, readonly BinDispatch[]>();
  for (const session of sessions) {
    if (!bins.has(session.binId)) bins.set(session.binId, await getBin(session.binId));
    if (!dispatches.has(session.binId)) {
      dispatches.set(session.binId, await listDispatchesForBin(session.binId));
    }
  }
  const proof = proveSurface({
    boundWorkerId: routine.workerId,
    routineRef: routine.routineRef,
    sessions,
    bins,
    dispatches,
  });
  return {
    proven: proof.chain !== null,
    lastArrivalAt: sessions[0]?.observedAt ?? null,
    lastCompletedBinId: proof.chain?.binId ?? null,
  };
}

/**
 * Every surface, classified once.
 *
 * `includeVerification` is false everywhere a person reads. The two
 * `verify-hosted-account-*` accounts expect the sentinel `VERIFY_HOSTED_NEVER_SET`,
 * which is never deployed, so they are already skipped by the dispatcher — and
 * they are excluded here by `fleet_accounts.kind` rather than by comparing a
 * name against a prefix, which is what migration 066 is for.
 */
/**
 * Why a surface is out of routing, in words, from the same verdict the router
 * recorded. The recorded reason on the row wins where there is one, because it
 * is the provider's or the operator's own words for what took it out.
 */
function unavailableBecause(
  routine: FleetRoutine,
  account: FleetAccount,
  verdict: string,
): string {
  if (routine.workerId === null) {
    return 'it is registered to no worker identity, so nothing could be handed to it.';
  }
  if (account.state !== 'ENABLED') {
    return (
      account.stateReason ??
      `its account is ${account.state.toLowerCase()}, so it is out of routing.`
    );
  }
  if (routine.state !== 'ENABLED') {
    return (
      routine.stateReason ??
      `it is ${routine.state.toLowerCase()}, so it is out of routing.`
    );
  }
  if (verdict === 'bound worker is disabled or archived') {
    return (
      'the worker identity it is bound to is disabled or archived, so any session it started ' +
      'would be refused at sign-in. Brain does not fire it.'
    );
  }
  return (
    'the worker identity it is bound to holds no project membership, so nothing could be ' +
    'handed to it. Brain does not fire it.'
  );
}

export async function capacityReading(
  options: { includeVerification?: boolean } = {},
): Promise<CapacityReading> {
  const now = nowIso();
  const snapshot = await fleetSnapshot(new Date(now));
  const accounts = await listAccounts();
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  /*
   * A routing candidate is only a Routine whose secret is deployed. Whether it
   * is *eligible* is `surfaceIneligibility`, the same function the router asks
   * first — so a quarantined surface, a disabled account and a worker that
   * cannot authenticate are out of this count for exactly the reason they are
   * out of routing, and a surface's old proof cannot make it read HEALTHY
   * while Brain would not fire it.
   */
  const candidateById = new Map(snapshot.candidates.map((one) => [one.routine.id, one]));
  const missingSecretIds = new Set(snapshot.missingSecrets.map((one) => one.routineId));

  const keep = (account: FleetAccount | undefined): boolean =>
    Boolean(account) && (options.includeVerification === true || account!.kind === 'CAPACITY');

  const live: SurfaceReading[] = [];
  const historical: SurfaceReading[] = [];

  /*
   * Every Routine the fleet holds, including the ones the snapshot skipped.
   *
   * `fleetSnapshot` drops a Routine with no deployed secret from `candidates`
   * on purpose — spending a fire to discover it is missing is exactly what §23
   * says not to do — so reading only `candidates` would make a surface waiting
   * on its administrator *vanish* rather than read as waiting. That is the one
   * thing this page must not do: the whole point of it is to name the one
   * outstanding action.
   */
  const { listRoutines, unansweredFiresByRoutine } = await import('../../repos/fleet.ts');
  const unanswered = await unansweredFiresByRoutine();
  for (const routine of await listRoutines()) {
    const account = accountById.get(routine.accountId);
    if (!keep(account)) continue;
    const owner = account!;

    const secretPresent = !missingSecretIds.has(routine.id);
    const candidate = candidateById.get(routine.id);
    const ineligible = candidate ? surfaceIneligibility(candidate) : 'not a routing candidate';
    const chain = await provenChain(routine);

    let health: SurfaceHealth;
    let because: string | undefined;
    if (routine.state === 'RETIRED' || owner.state === 'RETIRED') {
      health = 'UNAVAILABLE';
      because = routine.stateReason ?? 'kept for its history and out of active dispatch';
    } else if (!secretPresent) {
      health = 'WAITING';
      because =
        'its trigger credential is not in this deployment yet, so Brain will not spend a fire ' +
        'finding that out. A Brain administrator sets it and nothing else here has to be redone.';
    } else if (ineligible !== null) {
      health = 'UNAVAILABLE';
      because = unavailableBecause(routine, owner, ineligible);
    } else if (rateLimited(routine, owner, now)) {
      health = 'WAITING';
      because = 'the provider asked Brain to wait before firing this again.';
    } else if (chain.proven) {
      health = 'HEALTHY';
    } else {
      health = 'CONFIGURING';
      because =
        'Brain would fire this now, and no session it fired has yet arrived and finished a ' +
        'piece of work here — so it is configured rather than proven.';
    }

    const reading: SurfaceReading = {
      routineId: routine.id,
      name: routine.name,
      accountId: owner.id,
      accountName: owner.name,
      health,
      proven: chain.proven,
      ...(because ? { because } : {}),
      detail: {
        routineRef: routine.routineRef,
        secretName: routine.tokenSecretName,
        secretPresent,
        workerId: routine.workerId,
        state: routine.state,
        accountState: owner.state,
        totalFires: routine.totalFires,
        totalRefusals: routine.totalRefusals,
        unansweredFires: unanswered.get(routine.id) ?? 0,
        stateReason: routine.stateReason,
        lastArrivalAt: chain.lastArrivalAt,
        lastCompletedBinId: chain.lastCompletedBinId,
        retiredOrHistorical: routine.state === 'RETIRED',
      },
    };

    if (routine.state === 'RETIRED') historical.push(reading);
    else live.push(reading);
  }

  const fleetTarget = snapshot.fleetPolicy
    ? effectiveTarget(snapshot.fleetPolicy, now).target
    : null;

  return {
    eligibleNow: live.filter((one) => one.health === 'HEALTHY' || one.health === 'CONFIGURING')
      .length,
    proven: live.filter((one) => one.health === 'HEALTHY').length,
    waiting: live.filter((one) => one.health === 'WAITING').length,
    unavailable: live.filter((one) => one.health === 'UNAVAILABLE').length,
    target: fleetTarget,
    surfaces: live,
    historical,
  };
}

/**
 * The same reading with every operator-depth field removed.
 *
 * Raw worker ids, trigger refs, secret names, fire counters and a provider's
 * own refusal text are what an administrator needs to fix a surface and are
 * noise — and, in the secret's case, information — to everybody else. §29's
 * rule that technical detail is what a caller is *owed* rather than what it
 * asks for, applied by dropping the fields rather than by asking a screen not
 * to render them.
 */
export function withoutDiagnostics(reading: CapacityReading): CapacityReading {
  const strip = (one: SurfaceReading): SurfaceReading => {
    const { detail: _detail, ...rest } = one;
    return rest;
  };
  return {
    ...reading,
    surfaces: reading.surfaces.map(strip),
    historical: reading.historical.map(strip),
  };
}
