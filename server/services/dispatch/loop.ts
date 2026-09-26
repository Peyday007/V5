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
  markDispatchDeferred,
  markDispatchFailed,
  markDispatchSent,
  rearmSurfaceDeferredIntents,
  recordBinEvent,
  supersedeStaleIntents,
  reopenNoShowDispatches,
} from '../../repos/bins.ts';
import {
  fireConfig,
  fireRoutine,
  isFireConfigured,
  isRetryable,
  OPERATOR_RESOLVED_FIRE_FAILURES,
  recordAllowanceObservation,
  resolveToken,
} from './fire.ts';
import { fleetSnapshot, IN_FLIGHT_WINDOW_MS } from './candidates.ts';
import { shouldQuarantine } from './scaler.ts';
import { routeBin } from './router.ts';
import { OPERATOR_RESOLVED_ROUTING_REFUSALS, refusalEndsBurst, waitsForOperator } from './router.ts';
import { markDispatchRoutine } from '../../repos/bins.ts';
import {
  claimRoutineFireSlot,
  countRoutines,
  getRoutine,
  recordAccountRefusal,
  recordRoutineFire,
  setRoutineState,
  unansweredFiresByRoutine,
} from '../../repos/fleet.ts';

/*
 * How a routing refusal is classified now lives in `router.ts`, beside the union
 * it classifies, because the re-arm reads the same table to decide which
 * deferred intents a fleet write could have answered. See `REFUSAL_WAIT`.
 */

/**
 * Everything a write to the fleet could have answered, from both vocabularies.
 *
 * Two lists meet here and neither belongs to the other: a *routing* refusal is a
 * decision Brain made before firing, and a *fire* failure is what the provider
 * said when it did. Both are recorded in the same `last_error_kind` column, and
 * both include conditions an operator fixes — so the re-arm's filter is the
 * union, composed once, from the two modules that own the words.
 *
 * Composed rather than restated, because the last time this was a hand-written
 * list it silently fell behind the router: a refusal the loop deferred on was a
 * word the filter had never heard of, and the intent waited out a wall no write
 * could shorten.
 */
export const OPERATOR_RESOLVED_KINDS: readonly string[] = [
  ...OPERATOR_RESOLVED_ROUTING_REFUSALS,
  ...OPERATOR_RESOLVED_FIRE_FAILURES,
];

/** Ten minutes, because the re-arm is what ends this wait rather than the clock. */
const SCOPE_DEFER_MS = 10 * 60_000;

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
  /**
   * Intents whose surface-specific backoff was put back because the fleet changed.
   *
   * Its own number rather than folded into `superseded`, because the two answer
   * different questions: one says an intent stopped being about the bin's current
   * generation, this says an intent stopped being blocked.
   */
  rearmed: number;
  /** Fires nobody answered, put back in the queue or given up on. */
  reopenedNoShows: number;
  abandonedNoShows: number;
  /** Surfaces taken out of routing this tick for not answering their fires. */
  quarantinedForNoShow: string[];
  intentsCreated: number;
  fired: number;
  failed: number;
  skippedNotConfigured: boolean;
  /**
   * Intents put back because the fleet had no room, keeping their attempts.
   *
   * Counted separately from `unrouted` on purpose: `unrouted` says a routing
   * decision refused, and this says what was then done about it. A deferral
   * that showed up only as a refusal would look identical to the abandonment
   * it replaced.
   */
  deferred: number;
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
    rearmed: 0,
    reopenedNoShows: 0,
    abandonedNoShows: 0,
    quarantinedForNoShow: [],
    intentsCreated: 0,
    fired: 0,
    failed: 0,
    skippedNotConfigured: false,
    deferred: 0,
    unrouted: {},
    missingSecrets: 0,
  };

  result.superseded = await supersedeStaleIntents();

  /*
   * Settle any finished delivery probe before the snapshot, so a surface that
   * has just proven it can push is routable in this same tick — and one that
   * has just failed is not. A failure here never stops dispatch: a probe that
   * cannot be settled now is asked again next tick.
   */
  try {
    const { settleDeliveryProofs } = await import('./deliveryProof.ts');
    await settleDeliveryProofs();
    // Real deliveries already in the ledger prove their surfaces, once per process.
    const { backfillDeliveryEvidenceOnce } = await import('./deliveryEvidence.ts');
    await backfillDeliveryEvidenceOnce();
  } catch (error) {
    console.warn('[dispatch] delivery proof settlement failed:', (error as Error).message);
  }

  /*
   * The fleet, read once. Above the re-arm rather than below it, because the
   * re-arm now asks a routing question and must ask it against the same numbers
   * the fire will be decided on.
   */
  const snapshot = await fleetSnapshot();
  result.missingSecrets = snapshot.missingSecrets.length;

  /*
   * And put back anything deferred on a condition the fleet has since changed —
   * **only the work that condition was actually about.**
   *
   * Before routing, because this decides what there is to route. See
   * `rearmSurfaceDeferredIntents`: a backoff is a timestamp and the condition it
   * stands for — one Routine's token, its state, its capabilities, and now the
   * scope of the worker behind it — can stop being true long before the timestamp
   * lapses.
   *
   * The predicate is `routeBin` itself, so this is a recheck rather than a guess:
   * the fleet's state, the workload family the surfaces serve and the
   * capabilities they declare are asked again, and an intent is put back only
   * when the answer is no longer a scope refusal. Registering a factory surface
   * therefore wakes factory work and leaves a research packet nothing serves
   * exactly where it was.
   *
   * The repository is not one of the dimensions here, and that is the fire
   * router's rule rather than an omission: §27 settles the repository at
   * admission, where being wrong records something false, and leaves the fire
   * free to be wrong at the cost of one activation.
   */
  result.rearmed = await rearmSurfaceDeferredIntents({
    kinds: OPERATOR_RESOLVED_KINDS,
    routesNow: async (bin) => {
      const decision = routeBin({
        bin,
        candidates: snapshot.candidates,
        fleetPolicy: snapshot.fleetPolicy,
        fleetInFlight: snapshot.fleetInFlight,
        now: new Date().toISOString(),
      });
      return decision.ok || !waitsForOperator(decision.refusal);
    },
  });

  /*
   * Put back a fire nobody answered.
   *
   * Before `ensureDispatchIntent`, because that is the call this rescues: an
   * intent is one row per (bin, generation) and it is `ON CONFLICT DO NOTHING`,
   * so once a fire has been `SENT` there is no second intent to be had at that
   * generation — and the generation only moves when a worker takes a lease. A
   * session that never arrives therefore leaves the bin with nothing that could
   * ever come for it, which is the exact state the comment at the top of this
   * file says the design exists to avoid.
   *
   * Claimable rather than READY, which is the same distinction the `for` loop
   * below already draws in its own comment: the costlier shape is a worker that
   * *did* arrive and whose session then ended mid-stage, because that bin is
   * `LEASED` for ever after and this read used to skip it.
   *
   * The window is `IN_FLIGHT_WINDOW_MS` and it is passed rather than re-stated,
   * because `inFlightByRoutine` owns that number: a dispatch stops being
   * counted as an activation and becomes reopenable at the same instant, so
   * this can never race a fire Brain still believes is running.
   */
  const reopened = await reopenNoShowDispatches(IN_FLIGHT_WINDOW_MS, 50);
  for (const entry of reopened) {
    if (entry.outcome === 'REOPENED') result.reopenedNoShows += 1;
    else result.abandonedNoShows += 1;
  }

  /*
   * And a surface that has stopped answering stops being chosen.
   *
   * `shouldQuarantine` has stated this fleet's rule since Step 11 — repeated
   * no-shows take a surface out of routing, because a session that starts and
   * never arrives is a permission or connector fault that will repeat for ever
   * at one activation each — and its only caller in the repository was
   * `fleet scale-advice`, which prints a line. **A mechanism nothing calls is
   * not a mechanism**, and no surface has ever been quarantined for not
   * answering.
   *
   * Wiring it up as it stood would not have helped, and that is the half only a
   * pool shows: its input was `fleet_routines.consecutive_no_shows`, which an
   * arrival clears for every Routine bound to the same worker. A Factory pool
   * is exactly that arrangement, so one dead account's counter is reset by its
   * healthy siblings and it is fired at for ever. `unansweredFiresByRoutine`
   * is the per-surface fact instead, derived from the ledger rows the reopen
   * above has just written.
   *
   * Only no-shows are decided here. A fire the provider *refused* for a reason
   * that is not a rate limit is quarantined immediately, at the fire, further
   * down this function — so `consecutiveFailures` is deliberately passed as
   * zero rather than re-deciding a question that branch has already answered.
   *
   * The answering transition is `fleet set-state`, and it is reachable without
   * touching the database — §24's rule that an escalation needs one.
   */
  const unanswered = await unansweredFiresByRoutine();
  for (const [routineId, count] of unanswered) {
    const verdict = shouldQuarantine({ consecutiveNoShows: count, consecutiveFailures: 0 });
    if (!verdict.quarantine) continue;
    const routine = await getRoutine(routineId);
    // Guarded on the state that was read, so two ticks produce one move and the
    // loser is an ordinary outcome rather than an error.
    if (!routine || routine.state !== 'ENABLED') continue;
    const moved = await setRoutineState({
      routineId,
      from: 'ENABLED',
      to: 'QUARANTINED',
      reason: verdict.reason,
    });
    if (moved) result.quarantinedForNoShow.push(routineId);
  }

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
  /*
   * Empty means *no Routine row at all*, not "no candidate". The snapshot leaves
   * out every Routine whose secret is not deployed, so a registry whose secrets
   * were all rotated away read as empty, and every bin — any person's, any
   * project's — was fired at the environment Routine with no router, no
   * eligibility, no scope and no fire slot. A registered fleet with nothing
   * routable waits; it never falls back.
   */
  const registryEmpty =
    snapshot.candidates.length === 0 &&
    snapshot.missingSecrets.length === 0 &&
    (await countRoutines()) === 0;

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
        projectId: bin.projectId,
        workloadClass: bin.workloadClass,
        outcome: decision.refusal,
        reason: decision.reason,
        evidenceClass: decision.refusal === 'ALL_SURFACES_RATE_LIMITED' ? 'PROVIDER_ENFORCED' : 'OPERATOR_POLICY',
        measures: { considered: decision.considered },
      });
      /*
       * An unrouted intent waits. It never fails.
       *
       * The comment above already said this is "not a failure of this intent" —
       * and then called `markDispatchFailed`, which spends an attempt and
       * abandons at five. `attempt_count` is incremented at *claim*, so five
       * ticks of a busy fleet exhausted the budget without a single activation
       * having been tried. The frozen acceptance message died that way on
       * 2026-09-04, and a factory planning stage died the same way against a
       * repository nobody had onboarded yet. `REFUSAL_WAIT` is why there is no
       * longer a branch here that can do it a third time.
       */
      const retryAfterMs = decision.retryAt
        ? Math.max(0, Date.parse(decision.retryAt) - Date.now())
        : null;
      /*
       * Every routing refusal is a wait; which kind decides only how long.
       *
       * A capacity wait is measured in the provider's own retry time or the
       * default; an operator wait is measured in however long a person takes. So
       * the second one backs off further and is put back by the write rather
       * than by the clock — polling a scope that only an operator can change is
       * a fire nobody asked for.
       */
      await markDispatchDeferred(intent.id, {
        refusal: decision.refusal,
        message: decision.reason,
        retryAfterMs: waitsForOperator(decision.refusal)
          ? (retryAfterMs ?? SCOPE_DEFER_MS)
          : retryAfterMs,
      });
      result.deferred += 1;
      /*
       * Only a *fleet-wide* refusal ends the burst.
       *
       * This used to `break` on every one of them, justified as "every intent in
       * this burst faces the same fleet". That holds for three refusals —
       * nothing registered, the operator paused everything, the fleet ceiling is
       * reached — and for none of the others, because the candidate list is
       * filtered by **this bin's** project, family, repository, capabilities and
       * pin before any of them is reached, and targets differ per account.
       *
       * The cost of getting it wrong is the thing a pool exists to prevent: one
       * FACTORY bin whose surfaces are all busy ended the tick, so the research
       * bins behind it were never considered — and the reverse. `refusalEndsBurst`
       * is the classification, beside the union it classifies, for the reason
       * `REFUSAL_WAIT` is.
       */
      if (refusalEndsBurst(decision.refusal)) break;
      continue;
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
          projectId: bin.projectId,
          workloadClass: bin.workloadClass,
          accountId: decision.account.id,
          routineId: decision.routine.id,
          outcome: 'SLOT_LOST',
          reason: 'Another dispatcher took this surface\u2019s fire slot first.',
          evidenceClass: 'MEASURED',
        });
        // Losing the race is §23's ordinary outcome, not misconduct. It cost
        // an attempt until now, which is the same defect one branch over.
        await markDispatchDeferred(intent.id, {
          refusal: 'SLOT_LOST',
          message: 'Another dispatcher took this surface’s fire slot first.',
          retryAfterMs: 5_000,
        });
        result.deferred += 1;
        /*
         * And stop routing the rest of this burst against the generation it
         * just lost. The snapshot is read once per tick, so without this every
         * later intent in the burst chose the same surface from the same stale
         * row and lost the same race — measured with two ticks over eight
         * bins and four idle accounts: the losing tick deferred all five of
         * its intents and fired none. The winner has just fired this surface,
         * so it carries one more activation than this snapshot knew about.
         */
        const lost = snapshot.candidates.find((c) => c.routine.id === decision.routine.id);
        const current = lost ? await getRoutine(lost.routine.id) : null;
        if (lost && current) {
          lost.routine = { ...lost.routine, fireGeneration: current.fireGeneration, lastFiredAt: current.lastFiredAt };
          lost.routineInFlight += 1;
          for (const sibling of snapshot.candidates) {
            if (sibling.account.id === decision.account.id) sibling.accountInFlight += 1;
          }
        }
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
        /*
         * The generation *and* the fire time.
         *
         * The generation keeps the next iteration's claim honest. `lastFiredAt`
         * is what keeps the next iteration's *choice* honest, and leaving it
         * stale was a real gap: `relativeHeadroom` returns the same number for
         * two surfaces with no configured target, so the whole decision falls to
         * the least-recently-fired tiebreak — which, read once at the top of the
         * tick, named the same surface for every iteration. A burst of four
         * across two idle accounts went four-nil instead of two-two.
         *
         * Observed in production before it was reasoned about: with no account
         * targets set, one batch went entirely to one account and the next
         * batch entirely to the other, alternating per tick rather than
         * spreading within one.
         *
         * Account targets bound this and were the right fix for the ceiling.
         * They are not a fix for the fairness, because a fleet may legitimately
         * run with no targets at all.
         */
        spent.routine = {
          ...spent.routine,
          fireGeneration: spent.routine.fireGeneration + 1,
          lastFiredAt: new Date().toISOString(),
        };
      }
      for (const sibling of snapshot.candidates) {
        if (sibling.account.id === decision.account.id) sibling.accountInFlight += 1;
      }

      await markDispatchRoutine(intent.id, decision.routine.id);
      await recordBinEvent({
        eventType: 'DISPATCH_ROUTED',
        binId: intent.binId,
        projectId: bin.projectId,
        workloadClass: bin.workloadClass,
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
        // Who this activation was for. Taken from the bin this tick re-read and
        // the decision this tick acted on, so the ledger row says what the
        // dispatcher knew at the moment it fired rather than what a later query
        // can reconstruct — see `markDispatchSent`.
        projectId: bin.projectId,
        workloadClass: bin.workloadClass,
        accountId: decision?.ok ? decision.account.id : null,
        routineId: decision?.ok ? decision.routine.id : null,
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
      projectId: bin.projectId,
      workloadClass: bin.workloadClass,
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
      /*
       * A wrong token, a deleted routine or a paused one will not be fixed by
       * trying again in five seconds — but it is a fact about **that surface**,
       * not about the fleet, and treating it as fleet-wide is the same mistake
       * the RATE_LIMIT branch below already records having made.
       *
       * **This was measured, not reasoned about.** In production one Routine was
       * registered under a deployment secret that did not authorize it, so every
       * fire to it returned `AUTH 401 "Token is not authorized for this routine"`.
       * Eighteen of them. Each one ended the whole burst here, so Brain never
       * tried the healthy Routine beside it — and because `recordRoutineFire`
       * only advances a counter that nothing acts on, the bad surface was picked
       * again on the very next tick, for ever. A factory bin sat `READY` with a
       * dispatch `PENDING` and nothing in the fleet out of action.
       *
       * So: the surface is quarantined by name, immediately, because an
       * unauthorized token is not transient and retrying cannot change it. That
       * is the same rule `fleet_routines` already applies to a Routine whose
       * secret is *absent* — left out of routing and reported, rather than
       * spending a fire discovering it — and this is the identical fact
       * discovered at fire time. It is not a tuning decision, which is why it is
       * here and not a proposal in `scaler.ts`. `fleet set-state` is the
       * answering transition once the secret is fixed.
       *
       * And the burst continues, because the next routing decision is a
       * different one. The intent's backoff is short for the same reason: the
       * thing that refused has just been taken out of routing, so trying again
       * is not trying the same thing again.
       */
      const surfaceSpecific = decision?.ok === true && outcome.kind !== 'NOT_CONFIGURED';
      if (surfaceSpecific && decision?.ok) {
        await setRoutineState({
          routineId: decision.routine.id,
          from: decision.routine.state,
          to: 'QUARANTINED',
          reason:
            `The provider refused a fire with ${outcome.kind}: ${outcome.message.slice(0, 200)}. ` +
            'Retrying cannot change an unauthorized or missing routine, so this surface is out ' +
            'of routing until its deployment secret is corrected and it is enabled again.',
        });
      }
      await markDispatchFailed(intent.id, {
        kind: outcome.kind,
        message: outcome.message,
        /*
         * No wait at all for a surface's own refusal, and that is the
         * difference between failover and a queue of thirty-second walls.
         *
         * The comment above says the backoff is short "because the thing that
         * refused has just been taken out of routing". Thirty seconds was not
         * short, it was arbitrary: there is nothing to wait *for*. The surface
         * is quarantined in the statement above, so the very next routing
         * decision for this intent is a different surface, and with a pool of
         * five stale tokens the old value made a bin wait two and a half
         * minutes to discover something Brain already knew.
         *
         * It cannot spin. Reaching here at all requires a surface Brain chose,
         * and every arrival here removes one from routing, so the sequence is
         * bounded by the fleet — and ends at `ALL_SURFACES_INELIGIBLE`, which
         * is fleet-wide and stops the burst. The `burst` counter bounds it
         * again either way.
         */
        retryAfterMs: surfaceSpecific ? 0 : 24 * 60 * 60 * 1000,
        /*
         * The bin is not charged for a surface's refusal.
         *
         * The Routine has just been quarantined two statements above, so it is
         * out of routing and the next decision is a different surface. Charging
         * the bin would mean a pool of five accounts can retire a perfectly good
         * bin with five stale tokens — §23's "a refusal is not misconduct", one
         * row along, about the bin rather than the surface.
         *
         * `NOT_CONFIGURED` still charges: it means there is no trigger at all,
         * which is not a fact about a surface Brain chose.
         */
        refundAttempt: surfaceSpecific,
      });
      result.failed += 1;
      if (surfaceSpecific) continue;
      // Nothing was routed, or there is no trigger at all: that genuinely
      // applies to every intent, so there is no point walking the rest of the
      // burst into the same wall.
      break;
    }

    await markDispatchFailed(intent.id, {
      kind: outcome.kind,
      message: outcome.message,
      retryAfterMs: outcome.retryAfterMs,
      /*
       * A retryable refusal from a surface Brain chose — a rate limit, a 5xx, a
       * network error. The refusal is recorded against that Routine and the next
       * routing decision skips it, so the bin has lost nothing but time and must
       * not lose an attempt as well.
       */
      refundAttempt: decision?.ok === true,
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
