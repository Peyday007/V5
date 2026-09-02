/**
 * The dispatcher: ready work becomes a running worker, with no model involved.
 *
 * This is the piece Step 10 exists to build, and the thing worth noticing about
 * it is how little it is. It is a `setInterval` that reads two tables and
 * sometimes makes one HTTP request. There is no model here, nothing waiting on
 * a socket, and nothing that has to stay alive for the system to be correct.
 *
 * ---------------------------------------------------------------------------
 * Why an outbox rather than firing at the transition
 * ---------------------------------------------------------------------------
 *
 * The obvious design is to POST to `/fire` at the moment a bin becomes READY.
 * It is wrong for one reason: the transition happens inside a request, and the
 * request can commit and then the process can die before the HTTP call is made.
 * The bin would sit READY forever with nothing coming for it, and nothing in
 * the system would know it had been missed.
 *
 * So the transition writes an *intent* — a durable row saying this bin, at this
 * generation, deserves a worker — and a separate pass turns intents into calls.
 * A crash between the two loses nothing: the intent is still there at boot, and
 * the first tick after a restart redrives it. That is the whole of
 * "dispatch must survive application restart".
 *
 * ---------------------------------------------------------------------------
 * The three passes, and why they are in this order
 * ---------------------------------------------------------------------------
 *
 *   1. **Supersede.** Retire intents for bins that have moved on — leased,
 *      completed, cancelled, or advanced to a newer generation. Doing this
 *      first means the send pass never spends an activation on a bin that no
 *      longer wants one.
 *
 *   2. **Ensure.** Every dispatchable bin gets an intent at its current
 *      generation — READY, or LEASED with a lease that has run out, which is
 *      exactly what the assigner will hand to the next worker who asks.
 *      `ON CONFLICT DO NOTHING` makes this idempotent, so running it every tick
 *      forever creates exactly one row per bin per generation. This is also the
 *      recovery path: a lease that expires advances the generation, and the bin
 *      earns a fresh intent through the same code that gave it its first one.
 *
 *   3. **Send.** Take pending intents whose backoff has elapsed and fire them,
 *      one at a time, up to a burst limit.
 *
 * ---------------------------------------------------------------------------
 * What this deliberately does not do
 * ---------------------------------------------------------------------------
 *
 * It does not decide how many workers the fleet should have, does not model
 * capacity, and does not learn anything. One ready bin is one activation
 * attempt. That is Step 10's job — a correct basic dispatcher — and
 * capacity-aware routing is explicitly Step 11's.
 */
import {
  claimDispatchIntent,
  ensureDispatchIntent,
  getBin,
  isDispatchable,
  listDispatchableBins,
  markDispatchFailed,
  markDispatchSent,
  recordBinEvent,
  supersedeStaleIntents,
} from '../../repos/bins.ts';
import { fireConfig, fireRoutine, isFireConfigured, isRetryable, recordAllowanceObservation, resolveToken } from './fire.ts';
import { fleetSnapshot } from './candidates.ts';
import { routeBin } from './router.ts';
import { markDispatchRoutine } from '../../repos/bins.ts';
import { claimRoutineFireSlot, recordAccountRefusal, recordRoutineFire } from '../../repos/fleet.ts';

/**
 * How often the loop wakes.
 *
 * Ten seconds. Fast enough that a person watching a bin go ready does not
 * wonder whether the system noticed, slow enough that an idle Brain does
 * essentially nothing — two indexed reads that return nothing.
 */
export const DISPATCH_TICK_MS = 10_000;

/**
 * How many activations one tick may start.
 *
 * A burst limit rather than a fleet size. It stops a hundred bins going ready
 * at once from firing a hundred sessions inside ten seconds and colliding with
 * the account's daily allowance in a way nobody could read afterwards. The
 * acceptance ramp measures what the right number is; this is the starting
 * point.
 */
export const DISPATCH_BURST = 5;

export interface TickResult {
  superseded: number;
  intentsCreated: number;
  fired: number;
  failed: number;
  skippedNotConfigured: boolean;
  /** Intents held back because no surface could take them, by refusal. */
  unrouted: Record<string, number>;
  /** Registered Routines whose secret this deployment does not hold. */
  missingSecrets: number;
}

/**
 * One pass. Exported so a test can drive it directly rather than waiting for a
 * timer, and so the acceptance harness can step the dispatcher deliberately.
 */
export async function dispatchTick(
  options: { burst?: number; projectIds?: string[] } = {},
): Promise<TickResult> {
  const result: TickResult = {
    superseded: 0,
    intentsCreated: 0,
    fired: 0,
    failed: 0,
    skippedNotConfigured: false,
    unrouted: {},
    missingSecrets: 0,
  };

  result.superseded = await supersedeStaleIntents();

  // Ensure intent for everything a worker could be given — which is not the
  // same set as "READY". A bin whose worker died is claimable the moment its
  // lease runs out, and `listDispatchableBins` is the assigner's own predicate
  // rather than a second opinion about it. Bounded: a page, not the world.
  //
  // The intent is keyed at the bin's *current* generation, so a takeover that
  // advances the generation supersedes this one through the ordinary path.
  // Bins out of attempts are excluded by the same query, because firing at a
  // bin no worker is allowed to take burns an activation for nothing.
  for (const bin of await listDispatchableBins(200)) {
    if (options.projectIds && !options.projectIds.includes(bin.projectId)) continue;
    if (await ensureDispatchIntent(bin)) result.intentsCreated += 1;
  }

  // Nothing configured is a normal state, not an error: a deployment without a
  // trigger still runs, still accepts workers that arrive by other means, and
  // simply never starts one itself. Saying so once per tick would be noise, so
  // it is reported in the result and left to the caller.
  /*
   * "Configured" now has two answers, and the fleet's is the one that matters.
   *
   * Step 10 asked whether two environment variables were set. Step 11 asks
   * whether any Routine is registered *and* has its secret deployed — and only
   * falls back to the environment when the registry is empty, which is exactly
   * the state a Brain is in between deploying this code and registering its
   * first account. That fallback is what makes this change not a flag day: an
   * unmigrated deployment keeps firing its one Routine until somebody registers
   * it properly.
   */
  const snapshot = await fleetSnapshot();
  result.missingSecrets = snapshot.missingSecrets.length;
  const registryEmpty = snapshot.candidates.length === 0;

  if (registryEmpty && !isFireConfigured()) {
    result.skippedNotConfigured = true;
    return result;
  }

  const burst = Math.max(1, options.burst ?? DISPATCH_BURST);
  const config = fireConfig();

  for (let sent = 0; sent < burst; sent += 1) {
    const intent = await claimDispatchIntent();
    if (!intent) break;

    // Re-read the bin between claiming the intent and firing. The supersede
    // pass ran at the top of this tick, but a worker may have taken the bin in
    // the milliseconds since, and an activation for a bin somebody already
    // holds is a wasted one.
    const bin = await getBin(intent.binId);
    if (!bin || !isDispatchable(bin) || bin.leaseGeneration !== intent.leaseGeneration) {
      await markDispatchFailed(intent.id, {
        kind: 'SUPERSEDED',
        message: 'The bin was taken or moved on before this intent was sent.',
      });
      continue;
    }

    /*
     * Route, then fire. The routing decision is recorded either way — a bin
     * nobody could take is a fact about the fleet worth having, and Step 10
     * learned the hard way that a dispatcher which silently does nothing is
     * indistinguishable from one that is broken.
     */
    const decision = registryEmpty
      ? null
      : routeBin({
          bin,
          candidates: snapshot.candidates,
          fleetPolicy: snapshot.fleetPolicy,
          fleetInFlight: snapshot.fleetInFlight + result.fired,
          now: new Date().toISOString(),
        });

    if (decision && !decision.ok) {
      // Not a failure of this intent: the work is fine and no surface can take
      // it right now. Put it back with the provider's own retry time when there
      // is one, so the fleet resumes by itself rather than needing a nudge.
      result.unrouted[decision.refusal] = (result.unrouted[decision.refusal] ?? 0) + 1;
      await recordBinEvent({
        eventType: 'DISPATCH_UNROUTED',
        binId: intent.binId,
        outcome: decision.refusal,
        reason: decision.reason,
        evidenceClass: decision.refusal === 'ALL_SURFACES_RATE_LIMITED' ? 'PROVIDER_ENFORCED' : 'OPERATOR_POLICY',
        measures: { considered: decision.considered },
      });
      await markDispatchFailed(intent.id, {
        kind: 'UNROUTED',
        message: decision.reason,
        retryAfterMs: decision.retryAt
          ? Math.max(0, Date.parse(decision.retryAt) - Date.now())
          : 60_000,
      });
      // Every intent in this burst faces the same fleet, so walking the rest of
      // them into the same refusal spends nothing but time.
      break;
    }

    const target = decision?.ok
      ? {
          routineId: decision.routine.routineRef,
          token: resolveToken(decision.routine.tokenSecretName) ?? '',
          baseUrl: decision.routine.baseUrl,
          routineVersion: decision.routine.routineVersion,
        }
      : undefined;

    if (decision?.ok) {
      /*
       * Routing decided; now take the slot.
       *
       * `routeBin` is a pure function over a snapshot read once at the top of
       * this tick, so on its own it is arithmetic rather than exclusion. Two
       * dispatchers — two Brain instances, or this burst against another
       * process — can both compute that this Routine has room. The
       * compare-and-swap is what makes exactly one of them right: both name the
       * generation they read, one `UPDATE` matches, the other is refused.
       *
       * A lost claim is an ordinary outcome. The intent goes back with a short
       * backoff and the next tick routes it against a fleet that now includes
       * whatever the winner did.
       */
      const claimed = await claimRoutineFireSlot({
        routineId: decision.routine.id,
        expectedGeneration: decision.routine.fireGeneration,
      });
      if (!claimed) {
        result.unrouted['SLOT_LOST'] = (result.unrouted['SLOT_LOST'] ?? 0) + 1;
        await recordBinEvent({
          eventType: 'DISPATCH_UNROUTED',
          binId: intent.binId,
          accountId: decision.account.id,
          routineId: decision.routine.id,
          outcome: 'SLOT_LOST',
          reason: 'Another dispatcher took this surface\u2019s fire slot first.',
          evidenceClass: 'MEASURED',
        });
        await markDispatchFailed(intent.id, {
          kind: 'UNROUTED',
          message: 'Another dispatcher took this surface\u2019s fire slot first.',
          retryAfterMs: 5_000,
        });
        continue;
      }

      /*
       * Spend the slot in the local snapshot too. The claim protects against
       * other processes; this keeps the *rest of this burst* from routing five
       * activations at a surface whose headroom was measured once before any of
       * them left.
       */
      const spent = snapshot.candidates.find((c) => c.routine.id === decision.routine.id);
      if (spent) {
        spent.routineInFlight += 1;
        spent.routine = { ...spent.routine, fireGeneration: spent.routine.fireGeneration + 1 };
      }
      for (const sibling of snapshot.candidates) {
        if (sibling.account.id === decision.account.id) sibling.accountInFlight += 1;
      }

      await markDispatchRoutine(intent.id, decision.routine.id);
      await recordBinEvent({
        eventType: 'DISPATCH_ROUTED',
        binId: intent.binId,
        accountId: decision.account.id,
        routineId: decision.routine.id,
        outcome: 'SELECTED',
        reason: decision.reason,
        evidenceClass: 'MEASURED',
        measures: { considered: decision.considered },
      });
    }

    const outcome = await fireRoutine(target ? { target } : {});
    if (outcome.ok) {
      await markDispatchSent(intent.id, {
        routineRef: outcome.routineId,
        routineVersion: decision?.ok ? decision.routine.routineVersion : config.routineVersion,
        sessionRef: outcome.sessionRef,
        fireEventId: outcome.fireEventId,
      });
      if (decision?.ok) await recordRoutineFire({ routineId: decision.routine.id, ok: true });
      result.fired += 1;
      continue;
    }

    await recordAllowanceObservation({
      binId: intent.binId,
      kind: outcome.kind,
      retryAfterMs: outcome.retryAfterMs,
      message: outcome.message,
      accountId: decision?.ok ? decision.account.id : null,
      routineId: decision?.ok ? decision.routine.id : null,
    });

    if (decision?.ok) {
      // A refusal is written against the surface that refused, so the next tick
      // routes around it without anything having to remember this one.
      const retryAt = outcome.retryAfterMs
        ? new Date(Date.now() + outcome.retryAfterMs).toISOString()
        : null;
      await recordRoutineFire({
        routineId: decision.routine.id,
        ok: false,
        retryAt,
        rateLimited: outcome.kind === 'RATE_LIMIT',
      });
      if (outcome.kind === 'RATE_LIMIT') {
        await recordAccountRefusal({
          accountId: decision.account.id,
          reason: outcome.message,
          retryAt,
        });
      }
    }

    if (!isRetryable(outcome.kind)) {
      // A wrong token, a deleted routine or a paused one will not be fixed by
      // trying again in five seconds. The intent is failed straight to
      // abandoned by exhausting it, and the reason is kept.
      await markDispatchFailed(intent.id, {
        kind: outcome.kind,
        message: outcome.message,
        retryAfterMs: 24 * 60 * 60 * 1000,
      });
      result.failed += 1;
      // A non-retryable failure applies to every intent, not just this one, so
      // there is no point walking the rest of the burst into the same wall.
      break;
    }

    await markDispatchFailed(intent.id, {
      kind: outcome.kind,
      message: outcome.message,
      retryAfterMs: outcome.retryAfterMs,
    });
    result.failed += 1;
    /*
     * A rate limit used to end the burst, and with one Routine that was right:
     * the account was the fleet, so the next intent would hit the same wall.
     *
     * With a fleet it is wrong. The refusal has just been written against that
     * surface, so the next iteration's routing will skip it and may find a
     * different account with room. The burst only ends when routing itself
     * refuses — which is the branch above, and which happens on the very next
     * intent if there genuinely is nowhere to go.
     */
    if (outcome.kind === 'RATE_LIMIT' && registryEmpty) break;
  }

  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the loop.
 *
 * Idempotent, and it never overlaps itself: a tick that runs long simply means
 * the next one is skipped, which is preferable to two passes racing over the
 * same intents. `unref` so an idle timer cannot hold a process open — the
 * dispatcher is a background convenience, not a reason for the Brain to stay
 * alive.
 */
export function startDispatcher(intervalMs = DISPATCH_TICK_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void dispatchTick()
      .catch(async (error: unknown) => {
        await recordBinEvent({
          eventType: 'DISPATCH_TICK_FAILED',
          outcome: 'ERROR',
          reason: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  }, Math.max(1_000, intervalMs));
  timer.unref?.();
}

export function stopDispatcher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Redrive whatever a restart interrupted.
 *
 * Called once at boot. It does not need to do anything clever, because the
 * outbox already holds the truth: any intent still PENDING is one that was
 * never sent, and the ordinary tick will send it. This exists to say so out
 * loud in the telemetry, so a restart is visible in the record rather than
 * inferred from a gap.
 */
export async function recoverDispatchAtBoot(): Promise<number> {
  // The same set the tick uses. A restart is also the moment when leases that
  // expired while the process was down become claimable, and those bins need
  // an activation just as much as the ones that were merely waiting.
  const dispatchable = await listDispatchableBins(500);
  let created = 0;
  for (const bin of dispatchable) {
    if (await ensureDispatchIntent(bin)) created += 1;
  }
  await recordBinEvent({
    eventType: 'DISPATCH_BOOT_RECOVERY',
    outcome: 'REDRIVEN',
    measures: { dispatchableBins: dispatchable.length, intentsCreated: created },
  });
  return created;
}
