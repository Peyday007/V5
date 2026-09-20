/**
 * What the kernel knows, in the two shapes two different readers need.
 *
 * `capacitySnapshot` is the structured internal answer: every dimension with its
 * evidence class, sample count, confidence, freshness and the ledger ids behind
 * it. `capacityReport` is the concise external one, and the difference between
 * them is not detail — it is that the external report **separates what Brain is
 * doing by itself from what only a person can do**, and never puts an internal
 * code or configuration task in the second list.
 *
 * ---------------------------------------------------------------------------
 * Why the freshness of a claim is reported rather than its recency
 * ---------------------------------------------------------------------------
 *
 * A claim carries `first_observed_at` and `last_verified_at`, and the second
 * moving while the first does not is the whole point of the table: "believed
 * since the 14th, re-checked today" is a stronger statement than either date
 * alone. It also carries the conditions under which it stops being about this
 * system, and `staleAgainst` compares those to the configuration *now* rather
 * than to a clock — so a claim goes stale because the fleet changed, not because
 * time passed. §31 makes the same choice about a shared finding: nothing derives a
 * horizon, because inventing one would be a freshness claim wearing a citation.
 *
 * Both functions read. Neither writes, fires, enqueues or decides anything.
 */
import { DIMENSION_MEANING, type CapacityDimension } from '../../domain/capacity.ts';
import {
  liveClaims,
  liveExperiments,
  recentExperiments,
  type CapacityClaim,
  type CapacityExperiment,
} from '../../repos/capacityKernel.ts';
import { deriveEnvelope, type CapacityEnvelope } from './envelope.ts';
import { diagnose, type Diagnosis } from './diagnose.ts';
import { selectExperiment, type ExperimentProposal } from './experiments.ts';
import { observeCapacity, maxOverlap, type CapacityObservation } from './observe.ts';
import { runningCanaryCount } from '../../repos/capacityKernel.ts';

export interface ClaimFreshness {
  dimension: CapacityDimension;
  meaning: string;
  firstObservedAt: string;
  lastVerifiedAt: string;
  /** True when a condition this claim declared has since happened. */
  stale: boolean;
  /** Which condition, when it has. */
  staleBecause: string | null;
}

export interface CapacitySnapshot {
  takenAt: string;
  windowHours: number;
  /**
   * How complete the measurement itself is.
   *
   * Reported first and separately, because every number below it is worth less
   * than this one: a confident envelope derived from a ledger that recorded
   * nothing is the failure mode §37's self-model exists to prevent, and the honest
   * way to prevent it is to say what could not be read before saying what was.
   */
  measurementHealth: {
    sessionsObserved: number;
    sessionsWithNoRecordedEnd: number;
    validatedCompletions: number;
    providerRefusals: number;
    /** Everything the ledger could not answer, named rather than defaulted. */
    missing: string[];
  };
  envelope: CapacityEnvelope;
  diagnosis: Diagnosis;
  /** The queue as it stands, so a reader can see what the capacity is *for*. */
  backlog: {
    readyNotFired: number;
    firedNotArrived: number;
    leasedLive: number;
    leasedExpired: number;
    needsHuman: number;
    deferredByRefusal: Record<string, number>;
  };
  latencies: CapacityObservation['latencies'];
  /** Derived rates, each with the count it was computed from. */
  rates: {
    attemptsPerValidatedCompletion: number | null;
    validatedCompletionsPerHour: number | null;
    completionRefusalRate: number | null;
    takeoverRate: number | null;
  };
  claims: (CapacityClaim & { meaning: string })[];
  freshness: ClaimFreshness[];
  runningExperiments: CapacityExperiment[];
  recentExperiments: CapacityExperiment[];
  /** What the kernel would do next. Null when nothing is worth running. */
  nextExperiment: ExperimentProposal | null;
  /** Exact external actions. Empty when none is needed. */
  userActions: string[];
  /** Dimensions still unestablished, named. */
  remainingUnknowns: { dimension: CapacityDimension; meaning: string; why: string }[];
}

/**
 * Take the whole reading.
 *
 * `act: false` in spirit: this performs no transition. It calls the same pure
 * derivations the kernel tick calls, so the snapshot a person reads and the model
 * the kernel acts on cannot disagree — the defect `services/fleet/capacity.ts` was
 * written to end, where a page and the dispatcher each derived their own answer to
 * one question.
 */
export async function capacitySnapshot(
  options: { windowHours?: number } = {},
): Promise<CapacitySnapshot> {
  const observation = await observeCapacity({ windowHours: options.windowHours });
  const envelope = deriveEnvelope(observation);
  const diagnosis = diagnose(observation);
  const claims = await liveClaims('FLEET', null);
  const running = await liveExperiments();
  const recent = await recentExperiments(10);

  const next = selectExperiment({
    observation,
    envelope,
    diagnosis,
    claimedDimensions: running.map((one) => one.dimension),
    canaryRunning: (await runningCanaryCount()) > 0,
  });

  const userActions = [
    ...running.filter((one) => one.state === 'NEEDS_USER' && one.userAction).map((one) => one.userAction!),
    ...(next?.authority === 'PERSON' && next.userAction ? [next.userAction] : []),
  ];

  const window = observation.windowHours;
  const completions = observation.validatedCompletions.length;

  return {
    takenAt: observation.takenAt,
    windowHours: window,
    measurementHealth: {
      sessionsObserved: observation.sessions.length,
      sessionsWithNoRecordedEnd: maxOverlap(observation.sessions).droppedUnfinished,
      validatedCompletions: completions,
      providerRefusals: observation.providerRefusals.length,
      missing: observation.missing,
    },
    envelope,
    diagnosis,
    backlog: {
      readyNotFired: observation.stages.readyNotFired,
      firedNotArrived: observation.stages.firedNotArrived,
      leasedLive: observation.stages.leasedLive,
      leasedExpired: observation.stages.leasedExpired,
      needsHuman: observation.stages.needsHuman,
      deferredByRefusal: observation.stages.deferredByRefusal,
    },
    latencies: observation.latencies,
    rates: {
      /*
       * Every one of these is null rather than zero when its denominator is empty.
       *
       * A rate of zero says "this happened no times out of many"; null says
       * "nothing happened to divide by". They read identically on a screen and
       * mean opposite things, and the second is the one that must not be reported
       * as the first — invariant 39 at a division.
       */
      attemptsPerValidatedCompletion: completions > 0 ? observation.attemptsCredited / completions : null,
      /*
       * Null unless something actually ran, and the session count is the guard
       * rather than the window.
       *
       * **The first version guarded only on `window > 0`, and the CLI printed the
       * contradiction on one screen**: `Validated useful throughput: 0.00/h —
       * MEASURED` directly above its own measurement-health line saying *no
       * accepted completion is recorded, so useful throughput is unknown rather
       * than zero*. §29's defect at a division, and the reason the two disagreed
       * is worth keeping: zero completions over a window in which sessions
       * genuinely ran **is** a measurement, and an alarming one. Zero completions
       * over a window in which nothing ran at all is not a measurement of anything.
       * The session count is what separates them.
       */
      validatedCompletionsPerHour:
        window > 0 && observation.sessions.length > 0 ? completions / window : null,
      completionRefusalRate:
        observation.completionRefusals + completions > 0
          ? observation.completionRefusals / (observation.completionRefusals + completions)
          : null,
      takeoverRate: completions > 0 ? observation.takeovers / completions : null,
    },
    claims: claims.map((claim) => ({ ...claim, meaning: DIMENSION_MEANING[claim.dimension] })),
    freshness: claims.map((claim) => freshnessOf(claim, observation)),
    runningExperiments: running,
    recentExperiments: recent,
    nextExperiment: next,
    userActions: [...new Set(userActions)],
    remainingUnknowns: Object.values(envelope.readings)
      .filter((reading) => reading.evidenceClass === 'UNKNOWN')
      .map((reading) => ({
        dimension: reading.dimension,
        meaning: DIMENSION_MEANING[reading.dimension],
        why: reading.explanation,
      })),
  };
}

/**
 * Has a condition this claim declared actually happened?
 *
 * Compared against the configuration *now*, never against a clock. The three
 * conditions checked are the three this kernel's own claims declare and which are
 * readable from a snapshot: the fleet composition, the eligible surface count and
 * the target. A declared condition nothing can observe is reported as not stale
 * rather than as stale — a claim marked stale on a condition Brain cannot check
 * would go stale on every read and stop meaning anything.
 */
function freshnessOf(claim: CapacityClaim, observation: CapacityObservation): ClaimFreshness {
  const current = [
    `routines=${observation.routines.length}`,
    `eligible=${observation.eligibleRoutineIds.length}`,
    `target=${observation.fleetTarget ?? 'none'}`,
    `policy=v${observation.fleetPolicyVersion ?? 0}`,
  ].join(' ');

  /*
   * The policy version is deliberately excluded from the comparison.
   *
   * Every kernel tick that writes or rolls back an explore ceiling bumps it, so
   * including it would mark every claim stale after any experiment — which would
   * be technically defensible and practically useless, since "everything is stale"
   * carries no information. What genuinely makes a capacity claim not about this
   * system is the fleet's *composition* and its ceiling, and those are the two
   * compared.
   */
  const material = (text: string): string =>
    text
      .split(' ')
      .filter((part) => !part.startsWith('policy='))
      .join(' ');

  const stale = claim.configHash !== null && material(claim.configHash) !== material(current);
  return {
    dimension: claim.dimension,
    meaning: DIMENSION_MEANING[claim.dimension],
    firstObservedAt: claim.firstObservedAt,
    lastVerifiedAt: claim.lastVerifiedAt,
    stale,
    staleBecause: stale
      ? `measured against "${material(claim.configHash!)}" and the fleet is now "${material(current)}"`
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* The external report                                                        */
/* -------------------------------------------------------------------------- */

export interface CapacityReport {
  /** Where the fleet is configured and what is in flight. */
  currentConfiguration: { line: string; evidence: string }[];
  /** What has actually been established, with its bound and its label. */
  proven: { label: string; value: string; evidence: string }[];
  mainBottleneck: { stage: string; evidenceFor: string; evidenceAgainst: string };
  /** What Brain is doing by itself. Never contains a task for a person. */
  brainIsDoingNow: string[];
  /**
   * Exact external actions, and nothing else.
   *
   * An internal code or configuration task never appears here: if Brain has the
   * authority, it belongs under `brainIsDoingNow`, and putting it here would ask a
   * person to do something Brain was already doing. Empty is the common and good
   * case, and the renderer says so in words rather than printing an empty heading.
   */
  youNeedToDo: string[];
  nextExperiment: {
    change: string;
    hypothesis: string;
    successEvidence: string;
    stopCondition: string;
    resolves: string;
  } | null;
  /** Every dimension still unestablished. */
  remainingUnknowns: string[];
}

/**
 * The concise report.
 *
 * Composed from the snapshot rather than from a second read, so the two cannot
 * disagree about what the fleet is doing. Every number it prints carries its
 * evidence label, because a figure without one is the thing this whole kernel
 * exists to stop producing.
 */
export function capacityReportFrom(snapshot: CapacitySnapshot): CapacityReport {
  const r = snapshot.envelope.readings;
  const say = (dimension: CapacityDimension): string => {
    const reading = r[dimension];
    if (reading.value === null) return 'UNKNOWN';
    const rounded = Number.isInteger(reading.value) ? String(reading.value) : reading.value.toFixed(2);
    const prefix = reading.bound === 'AT_LEAST' ? '≥' : reading.bound === 'AT_MOST' ? '≤' : '';
    return `${prefix}${rounded} — ${reading.evidenceClass}`;
  };

  const brain: string[] = [];
  for (const experiment of snapshot.runningExperiments) {
    if (experiment.state === 'NEEDS_USER') continue;
    brain.push(
      `${experiment.kind} (${experiment.state}): ${experiment.hypothesis} Stop condition: ${experiment.stopCondition}`,
    );
  }
  if (snapshot.nextExperiment && snapshot.nextExperiment.authority === 'BRAIN') {
    brain.push(`about to start ${snapshot.nextExperiment.kind}: ${snapshot.nextExperiment.resolvesUnknown}`);
  }
  brain.push(
    `recording ${snapshot.claims.length} capacity claim(s) from the ledger on every tick, and ` +
      're-verifying the ones that still hold rather than re-deriving them from scratch.',
  );
  if (snapshot.runningExperiments.some((one) => one.appliedPolicyVersion !== null)) {
    brain.push(
      'watching the stop conditions on the applied change, and rolling the policy back to the ' +
        'recorded version if any of them trips.',
    );
  }

  return {
    currentConfiguration: [
      {
        line: `Routine definitions registered with Brain: ${say('DEFINITION_CAPACITY')}`,
        evidence: r.DEFINITION_CAPACITY.explanation,
      },
      {
        line: `Enabled at once: ${say('ENABLEMENT_CAPACITY')}`,
        evidence: r.ENABLEMENT_CAPACITY.explanation,
      },
      {
        line: `Eligible for work right now: ${say('ELIGIBLE_CAPACITY')}`,
        evidence: r.ELIGIBLE_CAPACITY.explanation,
      },
      {
        line: `Active concurrency observed: ${say('ACTIVE_CONCURRENCY')}`,
        evidence: r.ACTIVE_CONCURRENCY.explanation,
      },
      {
        line:
          `Backlog: ${snapshot.backlog.readyNotFired} ready, ${snapshot.backlog.firedNotArrived} fired and ` +
          `unanswered, ${snapshot.backlog.leasedLive} being worked, ${snapshot.backlog.leasedExpired} on a lapsed lease`,
        evidence: 'counted from the bins and their current-generation dispatch rows.',
      },
    ],
    proven: [
      { label: 'Highest verified definition count', value: say('DEFINITION_CAPACITY'), evidence: r.DEFINITION_CAPACITY.explanation },
      { label: 'Highest verified simultaneous count', value: say('ACTIVE_CONCURRENCY'), evidence: r.ACTIVE_CONCURRENCY.explanation },
      { label: 'Highest verified productive count', value: say('PRODUCTIVE_CONCURRENCY'), evidence: r.PRODUCTIVE_CONCURRENCY.explanation },
      { label: 'Highest verified sustainable count', value: say('SUSTAINABLE_CAPACITY'), evidence: r.SUSTAINABLE_CAPACITY.explanation },
      { label: 'First degraded or refused level', value: say('OBSERVED_FAILURE_POINT'), evidence: r.OBSERVED_FAILURE_POINT.explanation },
      { label: 'Provider-enforced ceiling', value: say('PROVIDER_ENFORCED_CEILING'), evidence: r.PROVIDER_ENFORCED_CEILING.explanation },
      { label: 'Inferred saturation knee', value: say('INFERRED_SATURATION_KNEE'), evidence: r.INFERRED_SATURATION_KNEE.explanation },
      { label: 'Recommended operating target', value: say('RECOMMENDED_OPERATING_TARGET'), evidence: r.RECOMMENDED_OPERATING_TARGET.explanation },
      {
        label: 'Validated useful throughput',
        value:
          snapshot.rates.validatedCompletionsPerHour === null
            ? 'UNKNOWN'
            : `${snapshot.rates.validatedCompletionsPerHour.toFixed(2)}/h — MEASURED`,
        evidence:
          snapshot.rates.validatedCompletionsPerHour === null
            ? `no session ran in the last ${snapshot.windowHours}h, so there is no throughput to ` +
              'report. That is different from a measured zero, which would mean sessions ran and ' +
              'finished nothing.'
            : `${snapshot.measurementHealth.validatedCompletions} distinct bin(s) reached an accepted ` +
              `completion over ${snapshot.windowHours}h, counted per bin rather than per event so a ` +
              'redelivered callback cannot inflate it.',
      },
      {
        label: 'Confidence and freshness',
        value: `${snapshot.claims.length} live claim(s), ${snapshot.freshness.filter((one) => one.stale).length} stale`,
        evidence:
          'a claim is stale when the fleet composition or ceiling it was measured against has changed, ' +
          'never because time has passed.',
      },
    ],
    mainBottleneck: {
      stage: snapshot.diagnosis.bottleneck,
      evidenceFor: snapshot.diagnosis.evidenceFor,
      evidenceAgainst: snapshot.diagnosis.evidenceAgainst,
    },
    brainIsDoingNow: brain,
    youNeedToDo: snapshot.userActions,
    nextExperiment: snapshot.nextExperiment
      ? {
          change:
            snapshot.nextExperiment.factor === null
              ? 'nothing is changed; this observes only'
              : `${snapshot.nextExperiment.factor}: ${String(snapshot.nextExperiment.baselineValue)} → ${String(snapshot.nextExperiment.canaryValue)}`,
          hypothesis: snapshot.nextExperiment.hypothesis,
          successEvidence: snapshot.nextExperiment.successMetric,
          stopCondition: snapshot.nextExperiment.stopCondition,
          resolves: snapshot.nextExperiment.resolvesUnknown,
        }
      : null,
    remainingUnknowns: snapshot.remainingUnknowns.map((one) => `${one.dimension} — ${one.meaning}: ${one.why}`),
  };
}
