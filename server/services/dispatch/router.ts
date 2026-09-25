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
import type { AllowanceReport, Bin, FleetAccount, FleetPolicy, FleetRoutine } from '../../domain/types.ts';
import { familyOf, repositoryIdOf } from '../bins/routing.ts';

/** Why no Routine was chosen. A closed set, because each one has its own fix. */
export type RoutingRefusal =
  | 'NO_ROUTINES_REGISTERED'
  | 'FLEET_PAUSED'
  | 'FLEET_TARGET_REACHED'
  | 'ALL_SURFACES_INELIGIBLE'
  | 'ALL_SURFACES_RATE_LIMITED'
  | 'NO_CAPABLE_SURFACE'
  | 'NO_SURFACE_SERVES_THIS_FAMILY'
  | 'NO_SURFACE_SERVES_THIS_REPOSITORY'
  | 'NO_SURFACE_SERVES_THIS_PROJECT'
  | 'PINNED_SURFACE_UNAVAILABLE'
  | 'ACCOUNT_TARGETS_REACHED';

/**
 * What kind of wait each refusal is — and there is no third kind.
 *
 * It lives here, beside the union it classifies, because two modules act on it:
 * the loop decides how long to defer, and the re-arm decides which deferred
 * intents a fleet write could have made routable. A rule applied by one of two
 * readers is worse than none, and this codebase has paid for that three times.
 *
 *   * `CAPACITY` — resolves by itself: an activation finishes, a rate limit
 *     lapses, a paused fleet is un-paused.
 *   * `OPERATOR` — resolves when somebody changes the fleet: registers a
 *     Routine, fixes a secret, lifts a quarantine, onboards a repository.
 *
 * Nothing here exhausts. Routing answers "can any surface take this now", which
 * is never a decision about whether the work may happen — those live in
 * `decideRepository`, `services/bins/routing.ts` and
 * `services/identity/policy.ts`, none of which produces a `RoutingRefusal`.
 *
 * A `Record` keyed by the union rather than a set, so a refusal added later is a
 * compile error until somebody classifies it. Two `Set`s that had to be total
 * between them were not, and that is exactly how `NO_ROUTINES_REGISTERED` and
 * `ALL_SURFACES_INELIGIBLE` ended up exhausting a campaign's dispatch attempts
 * against conditions a person was on their way to fixing.
 */
export type RefusalWait = 'CAPACITY' | 'OPERATOR';

export const REFUSAL_WAIT: Record<RoutingRefusal, RefusalWait> = {
  FLEET_TARGET_REACHED: 'CAPACITY',
  ACCOUNT_TARGETS_REACHED: 'CAPACITY',
  ALL_SURFACES_RATE_LIMITED: 'CAPACITY',
  FLEET_PAUSED: 'CAPACITY',
  NO_SURFACE_SERVES_THIS_FAMILY: 'OPERATOR',
  NO_SURFACE_SERVES_THIS_REPOSITORY: 'OPERATOR',
  // Answered by granting a worker the project, binding a Routine to that
  // worker, or registering a surface for it — all of them operator writes, none
  // of them anything a clock resolves.
  NO_SURFACE_SERVES_THIS_PROJECT: 'OPERATOR',
  NO_CAPABLE_SURFACE: 'OPERATOR',
  NO_ROUTINES_REGISTERED: 'OPERATOR',
  ALL_SURFACES_INELIGIBLE: 'OPERATOR',
  /*
   * A pinned surface that is not a candidate is registered-but-secretless, or
   * not registered at all, or quarantined — every one of them an operator write
   * away, and none of them something a clock resolves.
   */
  PINNED_SURFACE_UNAVAILABLE: 'OPERATOR',
};

/** Would an operator's next write make this decision different? */
export function waitsForOperator(refusal: RoutingRefusal): boolean {
  return REFUSAL_WAIT[refusal] === 'OPERATOR';
}

/**
 * Is this refusal about the whole fleet, or about this one bin?
 *
 * The dispatcher walks a burst of intents and used to `break` on **any**
 * refusal, justified as *"every intent in this burst faces the same fleet"*.
 * That is true of exactly three of them and false of the rest, and the
 * difference matters the moment a Brain runs more than one kind of work: a
 * `FACTORY` bin whose surfaces are all at target would end the burst, so the
 * research bins behind it were not even considered — and the reverse. One
 * unroutable bin must never stop eligible ones, which is the whole point of
 * having a pool.
 *
 * Fleet-wide means the answer cannot differ for the next intent: nothing is
 * registered, the operator paused everything, or the fleet-level ceiling is
 * reached. Everything else is computed against **this bin's** candidate set —
 * its project, its family, its repository, its capabilities, its pin — or
 * against targets that differ per account, so the next intent genuinely gets a
 * different decision.
 *
 * A `Record` again rather than a set, so a refusal added later is a compile
 * error until somebody says which kind it is.
 */
export const REFUSAL_SCOPE: Record<RoutingRefusal, 'FLEET' | 'BIN'> = {
  NO_ROUTINES_REGISTERED: 'FLEET',
  FLEET_PAUSED: 'FLEET',
  FLEET_TARGET_REACHED: 'FLEET',
  ALL_SURFACES_INELIGIBLE: 'FLEET',
  // Per-bin: the candidate set is filtered by the bin's own scope before any of
  // these is reached, so another bin may still find a surface.
  ALL_SURFACES_RATE_LIMITED: 'BIN',
  ACCOUNT_TARGETS_REACHED: 'BIN',
  NO_CAPABLE_SURFACE: 'BIN',
  NO_SURFACE_SERVES_THIS_FAMILY: 'BIN',
  NO_SURFACE_SERVES_THIS_REPOSITORY: 'BIN',
  NO_SURFACE_SERVES_THIS_PROJECT: 'BIN',
  PINNED_SURFACE_UNAVAILABLE: 'BIN',
};

/**
 * Does this refusal apply to every intent in the burst, or only to this one?
 *
 * `ALL_SURFACES_INELIGIBLE` is FLEET rather than BIN on purpose: it is returned
 * only when no candidate got past its own **state**, which is a fact about the
 * fleet and not about the bin that happened to ask.
 */
export function refusalEndsBurst(refusal: RoutingRefusal): boolean {
  return REFUSAL_SCOPE[refusal] === 'FLEET';
}

/**
 * The refusals a fleet write could have answered, derived rather than restated.
 *
 * This is the set `rearmSurfaceDeferredIntents` filters `bin_dispatch` by. It is
 * computed from the table above so the two can never drift — which they did the
 * moment a refusal was added: the loop deferred on it and the re-arm did not
 * know the word, so the intent waited out a wall nobody could shorten.
 */
export const OPERATOR_RESOLVED_ROUTING_REFUSALS: readonly RoutingRefusal[] = (
  Object.keys(REFUSAL_WAIT) as RoutingRefusal[]
).filter(waitsForOperator);

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
  /**
   * The repository ids the worker this Routine is bound to may be handed, or
   * `null` when it has no explicit routing row and the question cannot be asked.
   *
   * **I wrote that this dimension belongs at admission and not at the fire, and
   * that was wrong. The correction is recorded rather than quietly applied.**
   * The reasoning was §27's: Brain cannot tell which surface has *arrived*,
   * because `worker_sessions` is keyed by a per-connector credential, so a
   * repository check on an arriving worker is a guess. All of that is still true
   * — and none of it is about this. Choosing which Routine to *fire* is Brain's
   * own decision over rows Brain wrote: `fleet_routines.worker_id` names the
   * worker, and that worker's `worker_routing` row names its repositories. There
   * is no unknown here to fail open on.
   *
   * The cost of leaving it out was not theoretical either. Two onboarded
   * repositories share one family, so without this the router picks between their
   * surfaces on headroom alone: onboarding A registers a surface Brain will
   * happily fire for B's bin, which the assigner then refuses with
   * `REPOSITORY_NOT_AUTHORIZED` — an activation spent, an attempt charged, and
   * B's own surface never tried.
   *
   * Null stays eligible, exactly as `servesFamilies` does, and for the same
   * reason: a worker with no explicit row has an unknown scope rather than an
   * empty one. It also cannot reach here, because the derived default serves no
   * repository family at all.
   */
  servesRepositories: string[] | null;
  /**
   * The projects the worker this Routine is bound to holds a live membership
   * on. Empty when it is bound to no worker, or to one that is a member of
   * nothing.
   *
   * **This dimension fails closed, and it is the only one here that does.** The
   * two above treat an unanswerable question as eligible, on the rule this
   * module states in full: fail closed where the unknown could record something
   * false, fail open where it could only waste a fire. Project is where that
   * second clause stops being true.
   *
   * With one worker per private project — which is what invariant 41 requires
   * of four private operations — a router blind to the project picks between
   * four surfaces on headroom alone, and three of the four cannot be handed the
   * bin. The assigner refuses them correctly, so nothing false is recorded and
   * no bin attempt is spent; what is spent is an activation each time, and a
   * 30-minute in-flight window before the intent can be re-armed. That is not
   * the occasional waste the fail-open rule trades for. It is the common case.
   *
   * It is also not an unknown. `fleet_routines.worker_id` names the worker and
   * `project_memberships` says what that worker may be handed — both rows Brain
   * wrote, neither supplied by any caller. This is the same correction §27
   * already records for repositories, at the dimension that correction did not
   * reach.
   */
  servesProjects: string[];
  /**
   * Whether the worker this Routine is bound to can authenticate at all.
   *
   * A DISABLED worker is refused at every door (`authenticate.ts`), and unlike
   * an archived one it keeps its memberships — disabling is reversible — so
   * `servesProjects` alone does not take it out of routing. Without this the
   * router fired at a surface whose session was certain to be refused, an
   * activation each time out of a fixed allowance, until three unanswered fires
   * quarantined it. `false` for a Routine bound to no worker, a disabled or
   * archived one, or one whose row cannot be read.
   */
  workerActive: boolean;
  /** In-flight activations attributed to this Routine and its account. */
  routineInFlight: number;
  accountInFlight: number;
  routineTarget: number | null;
  accountTarget: number | null;
  /** A person's timestamped gauge reading, never a measured provider balance. */
  allowanceReport?: AllowanceReport | null;
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
 * Why this surface could take no work at all right now, or null when it could.
 *
 * The bin-independent half of routing, and the one definition of it. The
 * router asks it first for every candidate; `services/fleet/capacity.ts` asks
 * it to decide whether a surface counts as eligible capacity. Two copies were
 * the defect: the capacity reading used "is a routing candidate" — which is
 * only "its secret is deployed" — so a QUARANTINED surface with an old proof
 * read HEALTHY, and a disabled account, a disabled worker and an archived one
 * all read as capacity the router would never fire. A rule applied by one of
 * two readers is worse than none.
 *
 * Rate limits and targets are deliberately not here: they are waits rather
 * than ineligibility, and the capacity reading reports them as WAITING.
 */
export function surfaceIneligibility(candidate: RoutingCandidate): string | null {
  const { routine, account } = candidate;
  if (!routable(account.state)) return `account ${account.state}`;
  if (!routable(routine.state)) return `routine ${routine.state}`;
  if (routine.workerId === null) return 'bound to no worker';
  if (!candidate.workerActive) return 'bound worker is disabled or archived';
  if (candidate.servesProjects.length === 0) return 'bound worker holds no project membership';
  return null;
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

/**
 * Does this surface's worker serve the repository this bin's work is a change to?
 *
 * Asked only of a bin that names one, and answered only from an explicit routing
 * row — the same two conditions the assigner applies, so the fire and the
 * hand-over cannot disagree about which surface this work is for.
 */
function servesRepository(candidate: RoutingCandidate, repository: string | null): boolean {
  if (repository === null) return true;
  if (!Array.isArray(candidate.servesRepositories)) return true;
  return candidate.servesRepositories.includes(repository);
}

/**
 * May this surface's worker be handed work in this bin's project at all?
 *
 * The authorization comes from `project_memberships` through the snapshot, and
 * from nothing the caller sent — not a body field, not an id in a path, not an
 * eligible-scope list. `routeBin` stays a pure function over rows somebody else
 * read, which is what keeps a decision replayable.
 *
 * Absence is refused rather than waved through, unlike `servesFamily` and
 * `servesRepository` above. A snapshot that cannot say which projects a surface
 * serves cannot be used to pick one, and the field is required on
 * `RoutingCandidate` precisely so omitting it is a compile error rather than a
 * fleet that silently goes back to firing at random.
 */
function servesProject(candidate: RoutingCandidate, projectId: string): boolean {
  if (!Array.isArray(candidate.servesProjects)) return false;
  return candidate.servesProjects.includes(projectId);
}

/**
 * Whether this surface is *in scope* for this bin — project, family,
 * repository, capabilities and pin — ignoring health, cooldowns and targets.
 *
 * The same four predicates `routeBin` asks, in its order, so a reader listing
 * "the accounts that could take this work" (Build's allocation card) cannot
 * disagree with the fire about which accounts those are.
 */
export function servesBinScope(candidate: RoutingCandidate, bin: Bin): boolean {
  if (bin.pinnedRoutineId && candidate.routine.id !== bin.pinnedRoutineId) return false;
  return servesProject(candidate, bin.projectId) &&
    servesFamily(candidate, familyOf(bin)) &&
    servesRepository(candidate, repositoryIdOf(bin)) &&
    capable(candidate.routine, requiredCapabilities(bin));
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
 * target*, and break ties on the least recently fired. When *every* eligible
 * account has a recent gauge report, prefer the higher reported remaining
 * percentage first. Missing or old reports never become an invented zero.
 * Absolute headroom would
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
  const repository = repositoryIdOf(bin);
  /*
   * The pin, read from the bin's own column and applied before anything else.
   *
   * Narrowing only: it removes candidates and never adds one, so a pinned bin
   * is judged by exactly the same checks the unpinned one would have faced —
   * just against a candidate list of one. See `067_routine_pin.sql` for why a
   * pool cannot be verified without it.
   */
  const pinned = bin.pinnedRoutineId;
  let sawPinned = false;
  let sawRoutable = false;
  let sawCapable = false;
  let sawServesProject = false;
  let sawServesFamily = false;
  let sawServesRepository = false;
  let sawRateLimited: string | null = null;
  let sawTargetReached = false;

  const eligible: RoutingCandidate[] = [];
  for (const candidate of candidates) {
    const { routine, account } = candidate;

    if (pinned && routine.id !== pinned) {
      // Deliberately not pushed onto `considered`: a pinned bin has one
      // candidate by construction, and listing every surface it is not would
      // bury the one line that matters in a fleet of any size.
      continue;
    }
    sawPinned = true;

    if (!routable(account.state)) {
      considered.push({ routineId: routine.id, verdict: `account ${account.state}` });
      continue;
    }
    if (!routable(routine.state)) {
      considered.push({ routineId: routine.id, verdict: `routine ${routine.state}` });
      continue;
    }
    /*
     * A Routine whose bound worker cannot authenticate is out of routing for
     * the same reason a quarantined one is: whatever arrives will be refused.
     * Asked here, beside the states, so a fleet where that is the only reason
     * reports ALL_SURFACES_INELIGIBLE rather than a scope an operator does not
     * need to touch. A Routine bound to no worker is left to the project check
     * below, which already names it.
     */
    if (routine.workerId !== null && !candidate.workerActive) {
      considered.push({ routineId: routine.id, verdict: 'bound worker is disabled or archived' });
      continue;
    }
    sawRoutable = true;
    /*
     * The project first, because it is the outermost question and the one whose
     * answer is an authorization rather than a preference.
     *
     * `services/bins/routing.ts` orders its dimensions project, family,
     * repository, capabilities, scope — and the assigner applies them in that
     * order. The fire asks the same questions in the same order so the two
     * cannot report different reasons for the same refusal, which is the whole
     * argument for one routing decision with three readers.
     */
    if (!servesProject(candidate, bin.projectId)) {
      considered.push({ routineId: routine.id, verdict: 'serves no work in this project' });
      continue;
    }
    sawServesProject = true;
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
    /*
     * And whether its worker may be handed *this repository's* work, asked
     * immediately after the family and before capabilities, for the identical
     * reason: it is the more precise answer and it has its own remedy. "No
     * surface serves this repository" is one onboarding away; "lacks a
     * capability" sends a person to look at a Routine's tags.
     */
    if (!servesRepository(candidate, repository)) {
      considered.push({ routineId: routine.id, verdict: `not authorized for ${repository}` });
      continue;
    }
    sawServesRepository = true;
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
    /*
     * The pin first of all, because a pinned bin whose surface is not even a
     * candidate never reached any other question — and the remedy is its own:
     * the Routine is unregistered, or its deployment secret is not present, so
     * `fleetSnapshot` left it out before the router saw anything.
     */
    if (pinned && !sawPinned) {
      return {
        ok: false,
        refusal: 'PINNED_SURFACE_UNAVAILABLE',
        reason:
          `This bin may only be fired at Routine ${pinned}, and that Routine is not a routing ` +
          'candidate: it is not registered, or its deployment secret is not present in this ' +
          'deployment. Register it or set the secret; nothing is lost by waiting, and no ' +
          'other surface will be tried for it.',
        considered,
        retryAt: null,
      };
    }
    /*
     * Asked first, because a surface that never got past its own state was never
     * asked any of the questions below — and the flags they set stay false, so
     * whichever check comes first claims a fleet that is merely switched off.
     * A fully quarantined fleet reported `NO_SURFACE_SERVES_THIS_FAMILY`, which
     * sends an operator to write a routing row when the answer is `fleet
     * set-state`. §23's own rule about naming the right refusal, applied to the
     * one condition that bypasses every test it names.
     */
    if (!sawRoutable) {
      return {
        ok: false,
        refusal: 'ALL_SURFACES_INELIGIBLE',
        reason:
          'Every registered Routine or its account is disabled, draining or quarantined, or is ' +
          'bound to a worker that is disabled or archived, so none of them was asked whether it ' +
          'could take this work. Fix the surface and put it back with `fleet set-state` (or ' +
          're-enable the worker); the recorded reason on each says what took it out.',
        considered,
        retryAt: null,
      };
    }
    if (!sawServesProject) {
      return {
        ok: false,
        refusal: 'NO_SURFACE_SERVES_THIS_PROJECT',
        reason:
          'No enabled Routine is bound to a worker holding a live membership on this bin\'s ' +
          'project. That is an authorization an operator grants, not a capacity problem: give a ' +
          'worker the project with `npm run admin -- access grant`, and bind a Routine to it ' +
          'with `fleet bind-worker` — a Routine bound to no worker serves no project at all. ' +
          'The work waits and is put back by that write.',
        considered,
        retryAt: null,
      };
    }
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
    if (!sawServesRepository && repository !== null) {
      return {
        ok: false,
        refusal: 'NO_SURFACE_SERVES_THIS_REPOSITORY',
        reason:
          `No enabled Routine is bound to a worker authorized for ${repository}. That is a ` +
          'routing scope an operator sets by onboarding this repository, not a capacity ' +
          'problem — and it is deliberately not answered by a surface registered for a ' +
          'different repository.',
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

  const comparableAllowance = eligible.every((one) =>
    freshAllowancePercent(one.allowanceReport, now) !== null,
  );
  eligible.sort((a, b) => {
    if (comparableAllowance) {
      const remaining = freshAllowancePercent(b.allowanceReport, now)! -
        freshAllowancePercent(a.allowanceReport, now)!;
      if (remaining !== 0) return remaining;
    }
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
      `${chosen.accountInFlight}/${chosen.accountTarget ?? '∞'} on the account.` +
      (comparableAllowance
        ? ` Compared fresh person-reported balances; ${chosen.account.name} reported ` +
          `${freshAllowancePercent(chosen.allowanceReport, now)}% remaining.`
        : ' Remaining allowance was not compared, because not every eligible account has a ' +
          'person-reported reading from the last six hours; chose on measured headroom.'),
  };
}

/** A report informs ranking for six hours. It cannot establish provider usage. */
export const ALLOWANCE_REPORT_MAX_AGE_MS = 6 * 60 * 60_000;

export function freshAllowancePercent(
  report: AllowanceReport | null | undefined,
  now: string,
): number | null {
  if (!report || !Number.isInteger(report.remainingPercent) ||
      report.remainingPercent < 0 || report.remainingPercent > 100) return null;
  const age = Date.parse(now) - Date.parse(report.reportedAt);
  return Number.isFinite(age) && age >= 0 && age <= ALLOWANCE_REPORT_MAX_AGE_MS
    ? report.remainingPercent : null;
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
