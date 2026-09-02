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

/** Why no Routine was chosen. A closed set, because each one has its own fix. */
export type RoutingRefusal =
  | 'NO_ROUTINES_REGISTERED'
  | 'FLEET_PAUSED'
  | 'FLEET_TARGET_REACHED'
  | 'ALL_SURFACES_INELIGIBLE'
  | 'ALL_SURFACES_RATE_LIMITED'
  | 'NO_CAPABLE_SURFACE'
  | 'ACCOUNT_TARGETS_REACHED';

export interface RoutingCandidate {
  routine: FleetRoutine;
  account: FleetAccount;
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
function capable(routine: FleetRoutine, required: string[]): boolean {
  if (required.length === 0) return true;
  const has = new Set(routine.capabilities);
  return required.every((tag) => has.has(tag));
}

function requiredCapabilities(bin: Bin): string[] {
  const raw = (bin as unknown as { requiredCapabilities?: string[] | null }).requiredCapabilities;
  return Array.isArray(raw) ? raw : [];
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
  let sawCapable = false;
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
