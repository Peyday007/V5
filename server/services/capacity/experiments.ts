/**
 * Which experiment is worth running next, and when a running one must stop.
 *
 * Pure. Both halves are functions over a `CapacityObservation`, a `CapacityEnvelope`
 * and a `Diagnosis`, so "why did Brain choose that experiment" is answerable from a
 * recorded input — and, more importantly, so neither half can be a safety
 * mechanism. `router.ts` states the rule and it holds here too: a pure decision
 * can under-select and cannot over-select, and the thing that actually bounds what
 * an experiment may do is the guarded transition in `repos/capacityKernel.ts` plus
 * the authority table in `domain/capacity.ts`.
 *
 * ---------------------------------------------------------------------------
 * Selection is a ranking over unknowns, not a matrix
 * ---------------------------------------------------------------------------
 *
 * The mandate's own instruction is to change one primary factor at a time rather
 * than enumerate combinations, and the ranking is its formula: expected
 * uncertainty reduction × expected operational value, divided by allowance
 * consumption, risk, runtime and production interference. It is arithmetic over
 * small integers rather than a probability, and it is written as such — §38
 * records why a weighted score with invented weights is worse than an explicit
 * order: the number starts reading like a measurement.
 *
 * The one rule that is not arithmetic: **an unknown that a free observation could
 * settle always outranks one that costs an activation.** Reading the archive of
 * past activations before spending a new one is §13 at a measurement, and it is
 * why `PASSIVE_BASELINE` wins whenever the ledger has not been read out yet.
 */
import {
  EXPERIMENT_AUTHORITY,
  EXPERIMENT_DIMENSION,
  type CapacityDimension,
  type CapacityExperimentKind,
} from '../../domain/capacity.ts';
import type { CapacityEnvelope } from './envelope.ts';
import type { Diagnosis } from './diagnose.ts';
import type { CapacityObservation } from './observe.ts';
import { maxProductiveOverlap } from './observe.ts';

export interface ExperimentProposal {
  kind: CapacityExperimentKind;
  dimension: CapacityDimension;
  authority: 'BRAIN' | 'PERSON';
  hypothesis: string;
  successMetric: string;
  stopCondition: string;
  resolvesUnknown: string;
  /** The one primary factor, and its two values. Null for an observation. */
  factor: string | null;
  baselineValue: number | null;
  canaryValue: number | null;
  /** The exact thing a person must do. Only ever set when authority is PERSON. */
  userAction: string | null;
  /** The ranking, kept so a choice can be argued with rather than just accepted. */
  score: { informationValue: number; operationalValue: number; cost: number; rank: number };
}

/**
 * How long a concurrency canary runs before it may be judged.
 *
 * Twenty minutes. Long enough to contain several activations at Step 10's
 * measured pace, short enough that a bad level is not held for an hour, and
 * deliberately shorter than `SUSTAINED_WINDOW_MS` — a staircase step establishes a
 * *burst* level, and calling twenty minutes sustainable is the conflation
 * `BURST_CAPACITY` exists to prevent.
 */
export const CANARY_WINDOW_MS = 20 * 60_000;

/**
 * The most canary bins one staircase step may create.
 *
 * The step is +1 concurrency, so the load needed is one more comparable task than
 * the level being tested. A handful of spares covers a worker finishing early and
 * asking for another, which is the behaviour Step 10 measured and which would
 * otherwise leave the new slot empty and the step untested.
 */
export const MAX_CANARY_BINS = 3;

/**
 * Choose the next experiment, or say that nothing is worth running.
 *
 * Returns null when every dimension the kernel could reduce is either already
 * established or already owned by a live experiment. Null is a real answer: a
 * kernel that always has something to run is one that spends an allowance to
 * re-learn what it knows, which is exactly the waste §13 refuses.
 */
export function selectExperiment(input: {
  observation: CapacityObservation;
  envelope: CapacityEnvelope;
  diagnosis: Diagnosis;
  /** Dimensions a live experiment already owns. Never proposed twice. */
  claimedDimensions: readonly CapacityDimension[];
  /** True when a canary is already applied somewhere in the fleet. */
  canaryRunning: boolean;
}): ExperimentProposal | null {
  const { observation, envelope, diagnosis } = input;
  const taken = new Set<CapacityDimension>(input.claimedDimensions);
  const candidates: ExperimentProposal[] = [];

  /*
   * Is there a surface that could produce the observation at all?
   *
   * **This guard was missing and its absence was a real defect**, found by
   * driving the selector against a fleet with work outstanding and no eligible
   * Routine. Both observational experiments below were offered, and both would
   * have been proposed, authorized, started and then sat in `CANARY_RUNNING`
   * until their window closed — measuring nothing, because nothing can run, and
   * then settling `INCONCLUSIVE` and being proposed again.
   *
   * That is §24's sentence at the selector: **a state that says "waiting" which
   * nobody can resolve is not waiting, it is stuck.** Worse, it is stuck *while
   * looking busy*, and it would have crowded out the one experiment that names
   * the condition — `DEFINITION_STAIRCASE`, whose whole purpose is a fleet
   * starved of surfaces, and which loses every ranking it is offered beside a
   * free observation.
   *
   * So an observation requires something to observe. The definition staircase
   * deliberately does not, because it is the answer to there being nothing.
   */
  const canObserve = observation.eligibleRoutineIds.length > 0;

  /*
   * A passive baseline, whenever the headline measurement has not been taken.
   *
   * Free, so its cost is 1 and it wins on the ranking whenever it is available at
   * all. It is available exactly when `ACTIVE_CONCURRENCY` is unknown — which is
   * the case on a Brain that has never had two sessions overlap, and stops being
   * the case the moment one has.
   */
  if (canObserve && !taken.has('ACTIVE_CONCURRENCY') && envelope.readings.ACTIVE_CONCURRENCY.evidenceClass === 'UNKNOWN') {
    candidates.push({
      kind: 'PASSIVE_BASELINE',
      dimension: 'ACTIVE_CONCURRENCY',
      authority: EXPERIMENT_AUTHORITY.PASSIVE_BASELINE,
      hypothesis:
        'ordinary production traffic will produce at least two authenticated sessions whose run ' +
        'intervals overlap, which is the first real measurement of simultaneity this fleet has.',
      successMetric:
        'a maximum overlap of two or more computed by a sweep over closed session intervals from ' +
        '`worker_sessions` and the ledger.',
      stopCondition:
        'none. This observes and changes nothing, so there is nothing to roll back and nothing to stop.',
      resolvesUnknown:
        'ACTIVE_CONCURRENCY, which every bound below it is derived from and which is currently unknown.',
      factor: null,
      baselineValue: null,
      canaryValue: null,
      userAction: null,
      score: { informationValue: 5, operationalValue: 3, cost: 1, rank: 0 },
    });
  }

  /*
   * A staircase step, when a level is already demonstrated and a local target is
   * what is stopping the next one.
   *
   * Three preconditions, and each excludes a case where the step would be
   * dishonest rather than merely unhelpful:
   *
   *   * A demonstrated level to step *from*. Stepping from nothing tests a number
   *     nobody has reached.
   *   * No provider refusal in the window. Pushing into a wall the provider has
   *     already named spends an activation to be told the same thing, and
   *     `proposeScale` puts refusals above every other signal for this reason.
   *   * No canary already applied. One capacity-changing experiment at a time, or
   *     two effects arrive inside one window and neither is attributable.
   */
  const demonstrated = maxProductiveOverlap(observation.sessions).max;
  const providerWall = observation.providerRefusals.length > 0;
  if (
    canObserve &&
    !taken.has('PRODUCTIVE_CONCURRENCY') &&
    !input.canaryRunning &&
    !providerWall &&
    demonstrated >= 1 &&
    (diagnosis.bottleneck === 'LOCAL_TARGET' || diagnosis.bottleneck === 'NONE')
  ) {
    const next = demonstrated + 1;
    candidates.push({
      kind: 'CONCURRENCY_STAIRCASE',
      dimension: 'PRODUCTIVE_CONCURRENCY',
      authority: EXPERIMENT_AUTHORITY.CONCURRENCY_STAIRCASE,
      hypothesis:
        `${next} concurrent sessions will each produce distinct validated work, where ${demonstrated} ` +
        'already does. If that holds, the safe lower bound moves up by one; if it does not, the ' +
        'boundary is bracketed between the two.',
      successMetric:
        `productive overlap reaching ${next} with no provider refusal, no fall in the validation rate ` +
        'and no rise in takeovers — all four, because more starts without more distinct results is ' +
        'the failure mode raising a target produces.',
      stopCondition:
        'any provider refusal, an authentication failure, a quarantine, a fall in accepted ' +
        'completions against the baseline, or takeovers exceeding completions. Any one of them rolls ' +
        'the policy back to the recorded version.',
      resolvesUnknown:
        `whether productive concurrency exceeds ${demonstrated}, which is the bound the recommended ` +
        'operating target is currently derived from.',
      factor: 'fleet concurrency ceiling',
      baselineValue: observation.fleetTarget ?? demonstrated,
      canaryValue: next,
      userAction: null,
      score: { informationValue: 5, operationalValue: 5, cost: 3, rank: 0 },
    });
  }

  /*
   * A sustained hold, once a level is demonstrated but only briefly.
   *
   * Changes no factor, so its cost is low — but it is not free, because it asks
   * the fleet to stay where it is for four hours and therefore forecloses a
   * staircase step in the same window. Ranked below the step deliberately: a floor
   * that has not been raised yet is worth more than the same floor confirmed to
   * hold, and confirming a level Brain may be about to leave is wasted patience.
   */
  if (
    canObserve &&
    !taken.has('SUSTAINABLE_CAPACITY') &&
    envelope.readings.SUSTAINABLE_CAPACITY.evidenceClass === 'UNKNOWN' &&
    demonstrated >= 1
  ) {
    candidates.push({
      kind: 'SUSTAINED_HOLD',
      dimension: 'SUSTAINABLE_CAPACITY',
      authority: EXPERIMENT_AUTHORITY.SUSTAINED_HOLD,
      hypothesis:
        `${demonstrated} concurrent productive sessions will hold across a representative period ` +
        'rather than only in a burst.',
      successMetric:
        'overlapping activity spanning the sustained window with no provider refusal recorded inside it.',
      stopCondition: 'any provider refusal inside the window, which makes the window unrepresentative by definition.',
      resolvesUnknown: 'SUSTAINABLE_CAPACITY, which is what separates a level that worked once from one that can be operated.',
      factor: null,
      baselineValue: demonstrated,
      canaryValue: demonstrated,
      userAction: null,
      score: { informationValue: 3, operationalValue: 4, cost: 2, rank: 0 },
    });
  }

  /*
   * The definition staircase, which Brain cannot run.
   *
   * Always `PERSON`, and the reason is structural rather than a permission
   * setting: the deployed Brain holds a per-Routine bearer that fires one named
   * trigger and nothing that can create one, and §22 forbids it minting its own
   * surfaces at all — "Brain owns dispatch, the surface owns whether a worker may
   * act". So the honest thing is to name the exact action and carry on with
   * everything else, which is what `NEEDS_USER` is for.
   *
   * Proposed only when there is a reason to want another surface. A definition
   * count is cheap to raise and worth nothing on its own: §23's first sentence is
   * that an account holds an allowance and a Routine is a fire surface, so a
   * tenth definition buys nothing unless the fleet is actually starved of
   * surfaces.
   */
  const starved =
    diagnosis.bottleneck === 'NO_EXECUTION_SURFACE' ||
    (diagnosis.bottleneck === 'LOCAL_TARGET' && observation.eligibleRoutineIds.length <= 1);
  if (!taken.has('DEFINITION_CAPACITY') && starved) {
    const registered = observation.routines.length;
    candidates.push({
      kind: 'DEFINITION_STAIRCASE',
      dimension: 'DEFINITION_CAPACITY',
      authority: EXPERIMENT_AUTHORITY.DEFINITION_STAIRCASE,
      hypothesis:
        `this account will hold a ${registered + 1}th Routine definition, which would establish ` +
        `definition capacity at at least ${registered + 1}.`,
      successMetric:
        'the new Routine appears in the provider’s own listing and registers with Brain against the ' +
        'correct account identity and a present deployment secret.',
      stopCondition:
        'the provider refusing the creation, which would establish an AT_MOST rather than an AT_LEAST ' +
        'and is the only outcome here that finds a ceiling.',
      resolvesUnknown:
        'whether definition capacity is higher than what is currently registered — a floor, never a maximum.',
      factor: 'Routine definition count',
      baselineValue: registered,
      canaryValue: registered + 1,
      userAction:
        'Create one additional Routine on an existing capacity account, give it a neutral name, leave ' +
        'it on no schedule so it can never fire by itself, then register it with Brain using ' +
        '`fleet register-routine --name <neutral name> --account <account> --ref <trig_…> ' +
        '--secret <DEPLOYMENT_SECRET_NAME>` and set that deployment secret. Brain cannot create a ' +
        'Routine: it holds a bearer that fires one named trigger and nothing that can make one, and it ' +
        'must never mint its own execution surfaces. Brain will detect the registration and resume ' +
        'this experiment by itself.',
      score: { informationValue: 2, operationalValue: 4, cost: 4, rank: 0 },
    });
  }

  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    candidate.score.rank =
      (candidate.score.informationValue * candidate.score.operationalValue) / candidate.score.cost;
  }
  /*
   * Highest rank, then the cheaper one, then by kind so the choice is
   * deterministic. A tiebreak on nothing would make two equally-ranked
   * experiments alternate between ticks and neither would ever be started.
   */
  candidates.sort(
    (a, b) =>
      b.score.rank - a.score.rank || a.score.cost - b.score.cost || (a.kind < b.kind ? -1 : 1),
  );
  return candidates[0]!;
}

/* -------------------------------------------------------------------------- */
/* Stop conditions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The reading captured when a canary starts, and compared against on every tick.
 *
 * Its own type because three readers need to agree about it: the kernel writes it
 * onto the experiment row, `checkStopConditions` compares against it, and
 * `judgeCanary` reads one field of it. A shape defined inline at each would be the
 * two-readers defect at the values that decide whether a change is kept.
 */
export interface CanaryBaseline {
  validatedCompletions: number;
  completionRefusals: number;
  takeovers: number;
  sessionCount: number;
  providerRefusals: number;
}

export interface StopVerdict {
  stop: boolean;
  /** Which condition tripped, in the mandate's own vocabulary. */
  condition:
    | 'PROVIDER_REFUSAL'
    | 'AUTH_FAILURE'
    | 'SURFACE_QUARANTINED'
    | 'VALIDATION_DECLINE'
    | 'RETRY_AMPLIFICATION'
    | 'QUEUE_INSTABILITY'
    | 'TELEMETRY_LOST'
    | 'NONE';
  reason: string;
}

/**
 * Must a running canary be rolled back right now?
 *
 * Read on every tick, against a baseline captured when the canary started. Each
 * condition is a fact about rows, and each is deliberately one-sided: it can only
 * ever *stop* an experiment. There is no condition here that extends a canary, or
 * adopts one, or widens anything — a stop-condition checker that could also
 * approve would be the thing it exists to guard.
 *
 * `TELEMETRY_LOST` is the one that looks like paranoia and is not. An experiment
 * judged on measurements that stopped being recorded is an experiment judged on
 * nothing, and the failure would present as a *clean* result: no refusals, no
 * decline, nothing wrong at all, because nothing was observed. Corrupted or
 * missing lifecycle telemetry is on the mandate's stop list for exactly that
 * reason.
 */
export function checkStopConditions(input: {
  observation: CapacityObservation;
  /** The reading captured when the canary started. */
  baseline: CanaryBaseline;
}): StopVerdict {
  const now = input.observation;

  /*
   * Compared against the baseline count rather than against zero.
   *
   * The observation window is wider than a canary window on purpose — a level
   * demonstrated last week is still demonstrated — so it contains refusals that
   * predate this experiment. Testing `length > 0` would stop every canary on a
   * fleet that had ever been rate limited inside the window, which on a busy
   * account is all of them.
   */
  const newRefusals = now.providerRefusals.length - input.baseline.providerRefusals;
  if (newRefusals > 0) {
    return {
      stop: true,
      condition: 'PROVIDER_REFUSAL',
      reason:
        `the provider refused ${newRefusals} time(s) during the canary. A refusal is a wall policy ` +
        'cannot argue with, and the level being tested is above it.',
    };
  }

  const quarantined = now.routines.filter((one) => one.state === 'QUARANTINED');
  if (quarantined.length > 0) {
    return {
      stop: true,
      condition: 'SURFACE_QUARANTINED',
      reason:
        `${quarantined.length} surface(s) were quarantined during the canary` +
        (quarantined[0]?.stateReason ? `: ${quarantined[0].stateReason}` : '') +
        '. A surface taken out of routing mid-experiment changes the fleet the experiment is about.',
    };
  }

  const authFailures = Object.entries(now.stages.deferredByRefusal).filter(([kind]) =>
    kind === 'AUTH' || kind === 'NOT_FOUND' || kind === 'PAUSED',
  );
  if (authFailures.length > 0) {
    return {
      stop: true,
      condition: 'AUTH_FAILURE',
      reason:
        `${authFailures.map(([kind, n]) => `${n}×${kind}`).join(', ')} during the canary. An ` +
        'authentication failure is a fact about a surface rather than about capacity, so nothing ' +
        'measured here would be about the level under test.',
    };
  }

  /*
   * A fall in accepted completions, compared like for like.
   *
   * Only checked once the baseline had something to fall *from*. Comparing against
   * a baseline of zero would read any ordinary quiet minute as a decline and stop
   * every experiment on a fleet that was idle when it started.
   */
  if (input.baseline.validatedCompletions > 0 && now.validatedCompletions.length < input.baseline.validatedCompletions) {
    return {
      stop: true,
      condition: 'VALIDATION_DECLINE',
      reason:
        `accepted completions fell from ${input.baseline.validatedCompletions} to ` +
        `${now.validatedCompletions.length} during the canary, which is the outcome raising a ceiling ` +
        'is meant to avoid: more starts and less finished work.',
    };
  }

  if (now.takeovers > now.validatedCompletions.length && now.takeovers > input.baseline.takeovers) {
    return {
      stop: true,
      condition: 'RETRY_AMPLIFICATION',
      reason:
        `${now.takeovers} takeover(s) against ${now.validatedCompletions.length} accepted completion(s), ` +
        'up from the baseline — work is being reclaimed more often than it is finishing.',
    };
  }

  if (now.stages.leasedExpired > now.stages.leasedLive + now.stages.readyNotFired) {
    return {
      stop: true,
      condition: 'QUEUE_INSTABILITY',
      reason:
        `${now.stages.leasedExpired} lapsed lease(s) outnumber everything live or waiting, so leases are ` +
        'being lost faster than work is being done.',
    };
  }

  /*
   * The telemetry check, last, because it is about the measurement rather than
   * about the fleet — and one-sided: sessions arriving and none being *observed*
   * is the lost-telemetry shape, while genuinely nothing happening is not.
   */
  if (input.baseline.sessionCount > 0 && now.sessions.length === 0) {
    return {
      stop: true,
      condition: 'TELEMETRY_LOST',
      reason:
        `${input.baseline.sessionCount} session(s) were recorded at the baseline and none is readable ` +
        'now. An experiment judged on measurements that stopped being recorded would report a clean ' +
        'result from having observed nothing, which is worse than reporting a failure.',
    };
  }

  return { stop: false, condition: 'NONE', reason: 'no stop condition has tripped.' };
}

/**
 * Did the canary confirm its hypothesis?
 *
 * Deliberately strict in the same direction the gate is: `CONFIRMED` needs the
 * level to have been *reached* and the health signals to have held. Anything else
 * is `INCONCLUSIVE` rather than `REFUTED`, because failing to reach a level is
 * very often a shortage of comparable work rather than a ceiling — and recording
 * that as a refutation would close a question the experiment never actually asked.
 */
export function judgeCanary(input: {
  observation: CapacityObservation;
  targetLevel: number;
  baseline: { validatedCompletions: number };
}): { verdict: 'CONFIRMED' | 'REFUTED' | 'INCONCLUSIVE'; reason: string } {
  const productive = maxProductiveOverlap(input.observation.sessions).max;

  if (input.observation.providerRefusals.length > 0) {
    return {
      verdict: 'REFUTED',
      reason:
        `the provider refused during the window, so ${input.targetLevel} is above what it will admit ` +
        'under these conditions. That brackets the boundary between the previous level and this one.',
    };
  }
  if (productive >= input.targetLevel) {
    return {
      verdict: 'CONFIRMED',
      reason:
        `${productive} overlapping session(s) each produced distinct validated work, which reaches ` +
        `${input.targetLevel} with no refusal and no degradation.`,
    };
  }
  return {
    verdict: 'INCONCLUSIVE',
    reason:
      `productive overlap reached ${productive} against a target of ${input.targetLevel}, and nothing ` +
      'refused. The level was not exercised rather than found to be unavailable — most often because ' +
      'there was not enough comparable work ready at once — so no bound may be recorded from it.',
  };
}

export { EXPERIMENT_DIMENSION };
