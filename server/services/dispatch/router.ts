/**
 * Which surface should this bin's activation go to?
 *
 * Step 10 did not ask. `fireRoutine()` read two environment variables and
 * fired, so "routing" was a deployment decision made once. This module is the
 * question that replaces it, and the shape of the answer matters more than the
 * ranking inside it:
 *
 *   - **It is a pure function over rows.** Everything it needs — fleet state,
 *     policy, in-flight counts, refusal windows — is read and passed in, so the
 *     decision can be replayed, explained and tested without a provider, a
 *     clock of its own, or a model.
 *
 *   - **It does not make the claim atomic; the outbox already does.** Two ticks
 *     may both decide "Routine A" for two different intents, and that is fine.
 *     What must not happen is two ticks sending the *same* intent, and that is
 *     prevented where it always was: `claimDispatchIntent` compare-and-swaps on
 *     `state = 'PENDING'`. Routing sits on top of a guarantee it does not have
 *     to re-establish.
 *
 *   - **Every refusal names itself.** A bin that cannot be routed produces a
 *     reason from a closed set rather than a null, because "no Routine was
 *     chosen" has half a dozen causes with completely different remedies —
 *     nothing registered, everything rate-limited, the target is full, no
 *     surface has the capability, the operator paused the fleet.
 *
 * The one thing it deliberately refuses to do is spend a fire it can predict is
 * wasted. Step 10 measured that a routine's fire budget is the scarce resource;
 * firing at a surface whose provider told us to wait, or beyond a target the
 * operator set, spends that resource to be told something the rows already say.
 */
import type { Bin, FleetAccount, FleetPolicy, FleetRoutine } from '../../domain/types.ts';
import { familyOf } from '../bins/routing.ts';

/** Why no Routine was chosen. A closed set, because each one has its own fix. */
export type RoutingRefusal =
  | 'NO_ROUTINES_REGISTERED'
  | 'FLEET_PAUSED'
  | 'FLEET_TARGET_REACHED'
  | 'ALL_SURFACES_INELIGIBLE'
  | 'ALL_SURFACES_RATE_LIMITED'
  | 'NO_CAPABLE_SURFACE'
  | 'NO_SURFACE_SERVES_THIS_FAMILY'
  | 'ACCOUNT_TARGETS_REACHED';

export interface RoutingCandidate {
  routine: FleetRoutine;
  account: FleetAccount;
  /**
   * The workload families the worker this Routine is bound to may be handed, or
   * `null` when the Routine resolves to no worker and the question cannot be
   * answered.
   *
   * **Null is eligible here, and that is deliberate rather than lax.** The fire is
   * not the boundary — `assignNextBin` is, keyed on the authenticated worker — so
   * the cost of firing a surface that turns out to be out of scope is one wasted
   * activation, while the cost of refusing on an unknown is a bin nothing is ever
   * started for. Fail closed where the unknown could record something false; fail
   * open where it could only waste a fire. Known-and-wrong is refused, because
   * that is not an unknown.
   */
  servesFamilies: string[] | null;
  /** In-flight activations attributed to this Routine and its account. */
  routineInFlight: number;
  accountInFlight: number;
  routineTarget: number | null;
  accountTarget: number | null;
}

export interface RoutingInput {
  bin: Bin;
  candidates: RoutingCandidate[];
  fleetPolicy: FleetPolicy | null;
  fleetInFlight: number;
  /** ISO-8601. Passed in rather than read, so a decision is replayable. */
  now: string;
}

export interface RoutingDecision {
  ok: true;
  routine: FleetRoutine;
  account: FleetAccount;
  /** Every candidate considered and what happened to it, for the report. */
  considered: { routineId: string; verdict: string }[];
  reason: string;
}

export interface RoutingRejection {
  ok: false;
  refusal: RoutingRefusal;
  reason: string;
  considered: { routineId: string; verdict: string }[];
  /** When the earliest rate-limited surface says to try again, when known. */
  retryAt: string | null;
}

export type RoutingResult = RoutingDecision | RoutingRejection;

/** States a surface may be routed to. Draining finishes what it holds only. */
function routable(state: string): boolean {
  return state === 'ENABLED';
}

/**
 * Does this surface have what the bin asked for?
 *
 * A bin with no declared requirements is satisfied by any surface, which is
 * every Step 10 bin. Requirements are matched as a subset rather than an
 * equality so a more capable surface is never excluded for being more capable.
 */
/**
 * Does this surface's worker serve the family of work this bin is?
 *
 * Read from `worker_routing` through the snapshot, never from the Routine's own
 * capability tags: a tag says what an operator thinks the surface can *do*, and
 * the family says what its worker may be *handed*. Conflating them would let a
 * Routine declaring `repository` be fired for research simply because nobody had
 * narrowed it.
 */
function servesFamily(candidate: RoutingCandidate, family: string): boolean {
  // Absent and explicitly-null are one answer: the question could not be asked.
  // A snapshot built by a caller that predates this field must not refuse every
  // surface, and a router that threw on it would stop all dispatch.
  if (!Array.isArray(candidate.servesFamilies)) return true;
  return candidate.servesFamilies.includes(family);
}

function capable(routine: FleetRoutine, required: string[]): boolean {
  if (required.length === 0) return true;
  const has = new Set(routine.capabilities);
  return required.every((tag) => has.has(tag));
}

/*
 * Read, not asserted.
 *
 * This used to be `(bin as unknown as { requiredCapabilities?: … })`, which
 * type-checked and routed nothing: `Bin` had no such field, so the cast handed
 * back `undefined` for every bin and every capability requirement silently
 * evaluated to "none". Migration 026 had added the column; the row type, the
 * mapper and the create path had never learned about it, so there was nothing
 * to read. All four are wired now and this is an ordinary field access.
 */
function requiredCapabilities(bin: Bin): string[] {
  return bin.requiredCapabilities;
}

/**
 * Choose a Routine, or say precisely why none was chosen.
 *
 * The ordering is deliberate and is the fairness rule: among surfaces that are
 * eligible at all, prefer the one with the most headroom *relative to its own
 * target*, and break ties on the least recently fired. Absolute headroom would
 * send everything to the biggest account until it filled; relative headroom
 * spreads load in proportion to what each surface was configured to carry, and
 * the recency tiebreak stops two equally idle surfaces from having one of them
 * take every bin because it sorts first.
 */
export function routeBin(input: RoutingInput): RoutingResult {
  const considered: { routineId: string; verdict: string }[] = [];
  const { bin, candidates, fleetPolicy, fleetInFlight, now } = input;

  if (candidates.length === 0) {
    return {
      ok: false,
      refusal: 'NO_ROUTINES_REGISTERED',
      reason:
        'No Routine is registered in the fleet. Register at least one account and Routine; ' +
        'until then Brain can hold work but cannot start a worker for it.',
      considered,
      retryAt: null,
    };
  }

  if (fleetPolicy?.paused) {
    return {
      ok: false,
      refusal: 'FLEET_PAUSED',
      reason: `The fleet is paused by policy version ${fleetPolicy.version} (${fleetPolicy.actor}).`,
      considered,
      retryAt: null,
    };
  }

  // The fleet target is a ceiling on concurrent activations, not on queued
  // work. Reaching it is an ordinary state: the bins stay, and the next tick
  // after something finishes will route them.
  const fleetTarget = fleetPolicy ? effective(fleetPolicy, now) : null;
  if (fleetTarget !== null && fleetInFlight >= fleetTarget) {
    return {
      ok: false,
      refusal: 'FLEET_TARGET_REACHED',
      reason:
        `${fleetInFlight} activations are in flight and the fleet target is ${fleetTarget}. ` +
        'Raise the target to push harder; nothing is lost by waiting.',
      considered,
      retryAt: null,
    };
  }

  const required = requiredCapabilities(bin);
  // From the bin's own columns. One derivation, shared with the assigner, so the
  // fire and the hand-over cannot disagree about what kind of work this is.
  const family = familyOf(bin);
  let sawCapable = false;
  let sawServesFamily = false;
  let sawRateLimited: string | null = null;
  let sawTargetReached = false;

  const eligible: RoutingCandidate[] = [];
  for (const candidate of candidates) {
    const { routine, account } = candidate;

    if (!routable(account.state)) {
      considered.push({ routineId: routine.id, verdict: `account ${account.state}` });
      continue;
    }
    if (!routable(routine.state)) {
      considered.push({ routineId: routine.id, verdict: `routine ${routine.state}` });
      continue;
    }
    /*
     * Whether its worker may be handed this family at all, asked **before**
     * capabilities.
     *
     * Both would refuse, and the order decides which reason a person reads. Scope
     * is the more precise answer and the one with a different remedy: "no surface
     * serves this family" is a routing row somebody has to write, while "lacks a
     * capability" reads as a missing tag on a surface that was otherwise right for
     * the work. Asking capabilities first reported the second for what was always
     * the first.
     *
     * Asked at all so Brain does not spend an activation on a surface the assigner
     * will refuse — which is what stranded a ready bin behind an hourly cron in
     * production: the dispatcher kept choosing the surface it could fire, that
     * surface kept being refused the work, and the only surface that could take it
     * arrived on a schedule nobody had tied to the work.
     */
    if (!servesFamily(candidate, family)) {
      considered.push({ routineId: routine.id, verdict: `does not serve ${family} work` });
      continue;
    }
    sawServesFamily = true;
    if (!capable(routine, required)) {
      considered.push({ routineId: routine.id, verdict: 'lacks a required capability' });
      continue;
    }
    sawCapable = true;

    // A provider that told us to wait is the one input policy may not override.
    // Recorded from a refusal, honoured until it passes.
    const waitUntil = laterOf(routine.retryAt, account.retryAt);
    if (waitUntil && waitUntil > now) {
      considered.push({ routineId: routine.id, verdict: `rate limited until ${waitUntil}` });
      sawRateLimited = earlierOf(sawRateLimited, waitUntil);
      continue;
    }

    if (candidate.routineTarget !== null && candidate.routineInFlight >= candidate.routineTarget) {
      considered.push({
        routineId: routine.id,
        verdict: `routine at target ${candidate.routineInFlight}/${candidate.routineTarget}`,
      });
      sawTargetReached = true;
      continue;
    }
    if (candidate.accountTarget !== null && candidate.accountInFlight >= candidate.accountTarget) {
      considered.push({
        routineId: routine.id,
        verdict: `account at target ${candidate.accountInFlight}/${candidate.accountTarget}`,
      });
      sawTargetReached = true;
      continue;
    }

    eligible.push(candidate);
  }

  if (eligible.length === 0) {
    if (!sawServesFamily) {
      return {
        ok: false,
        refusal: 'NO_SURFACE_SERVES_THIS_FAMILY',
        reason:
          `No enabled Routine is bound to a worker that may be handed ${family} work. That is a ` +
          'routing scope an operator sets, not a capacity problem: register a worker for this ' +
          'family, or widen one whose scope was narrowed too far.',
        considered,
        retryAt: null,
      };
    }
    if (!sawCapable && required.length > 0) {
      return {
        ok: false,
        refusal: 'NO_CAPABLE_SURFACE',
        reason: `No enabled Routine declares every capability this bin requires: ${required.join(', ')}.`,
        considered,
        retryAt: null,
      };
    }
    if (sawRateLimited) {
      return {
        ok: false,
        refusal: 'ALL_SURFACES_RATE_LIMITED',
        reason: `Every eligible surface is rate limited. The earliest returns at ${sawRateLimited}.`,
        considered,
        retryAt: sawRateLimited,
      };
    }
    if (sawTargetReached) {
      return {
        ok: false,
        refusal: 'ACCOUNT_TARGETS_REACHED',
        reason:
          'Every capable surface is at its configured target. Raise an account or Routine ' +
          'target, or wait for an activation to finish.',
        considered,
        retryAt: null,
      };
    }
    return {
      ok: false,
      refusal: 'ALL_SURFACES_INELIGIBLE',
      reason: 'No registered Routine is enabled and reachable for this bin.',
      considered,
      retryAt: null,
    };
  }

  eligible.sort((a, b) => {
    const headroom = relativeHeadroom(b) - relativeHeadroom(a);
    if (Math.abs(headroom) > 1e-9) return headroom;
    // Least recently fired first, so two idle surfaces alternate rather than
    // one of them taking everything because it sorts first.
    const aFired = a.routine.lastFiredAt ?? '';
    const bFired = b.routine.lastFiredAt ?? '';
    if (aFired !== bFired) return aFired < bFired ? -1 : 1;
    return a.routine.id < b.routine.id ? -1 : 1;
  });

  const chosen = eligible[0]!;
  considered.push({ routineId: chosen.routine.id, verdict: 'selected' });
  return {
    ok: true,
    routine: chosen.routine,
    account: chosen.account,
    considered,
    reason:
      `Selected ${chosen.routine.name} on ${chosen.account.name}: ` +
      `${chosen.routineInFlight}/${chosen.routineTarget ?? '∞'} on the Routine, ` +
      `${chosen.accountInFlight}/${chosen.accountTarget ?? '∞'} on the account.`,
  };
}

/**
 * How much room a candidate has, as a fraction of what it was configured for.
 *
 * An unconfigured target is treated as one unit of room rather than infinite,
 * so an unconfigured surface does not starve every configured one — it competes
 * on the recency tiebreak instead.
 */
function relativeHeadroom(candidate: RoutingCandidate): number {
  const target = candidate.routineTarget ?? candidate.accountTarget;
  if (target === null || target <= 0) return 1;
  const used = Math.max(candidate.routineInFlight, candidate.accountInFlight);
  return (target - used) / target;
}

function effective(policy: FleetPolicy, now: string): number {
  if (policy.boostTarget !== null && policy.boostUntil !== null && policy.boostUntil > now) {
    return policy.boostTarget;
  }
  if (
    policy.exploreCeiling !== null &&
    policy.exploreUntil !== null &&
    policy.exploreUntil > now &&
    policy.exploreCeiling > policy.target
  ) {
    return policy.exploreCeiling;
  }
  return policy.target;
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function earlierOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
