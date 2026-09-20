/**
 * The capacity envelope: fifteen answers, each labelled with what kind of fact
 * it is.
 *
 * Pure over a `CapacityObservation`. Nothing here reads a database, a clock or a
 * provider, so a conclusion can be replayed against the input that produced it —
 * `router.ts`'s rule, and more necessary here, because "why did Brain believe six
 * was safe" is asked long after the ledger has moved on.
 *
 * ---------------------------------------------------------------------------
 * The three rules every derivation below obeys
 * ---------------------------------------------------------------------------
 *
 *   1. **An unknown is never a favourable assumption.** Invariant 39. Every
 *      dimension that cannot be established returns `unknownReading`, which
 *      carries no value at all rather than a zero — and migration 074 enforces
 *      the pairing with a CHECK so no future caller can write one without the
 *      other. The direction matters: the favourable assumption here inflates the
 *      headline number, and an inflated capacity figure is acted on.
 *
 *   2. **`PROVIDER_ENFORCED` requires the provider.** An internal constant, a UI
 *      default, a schema restriction, a scheduler bug, a timeout, an absence of
 *      work or an unexplained failure is never it. The only source is a ledger
 *      row the provider's own refusal produced, which `recordAllowanceObservation`
 *      classified at the moment it was observed — and even then, only after the
 *      local guardrails are shown not to have been the thing that refused.
 *
 *   3. **One observation is one observation.** A single refusal establishes that
 *      a refusal happened, never a recurring rule. `confidenceFromSamples` is
 *      crude on purpose; what stops a one-off becoming a limit is that the
 *      `bound` says `AT_MOST` on a sample of one with `LOW` confidence, and the
 *      report prints all three.
 */
import {
  CAPACITY_DIMENSIONS,
  DIMENSION_MEANING,
  confidenceFromSamples,
  unknownReading,
  type CapacityDimension,
  type CapacityDimensionReading,
} from '../../domain/capacity.ts';
import {
  maxOverlap,
  maxProductiveOverlap,
  startRatePerHour,
  type CapacityObservation,
} from './observe.ts';

export interface CapacityEnvelope {
  takenAt: string;
  windowHours: number;
  scope: { accountId: string | null; workloadClass: string | null };
  readings: Record<CapacityDimension, CapacityDimensionReading>;
  /** Everything the ledger could not answer, named. */
  missing: string[];
}

/**
 * A window short enough that surviving it proves very little.
 *
 * Ten minutes. Step 10's longest measured activation drained seven bins in 107
 * seconds, so ten minutes comfortably contains several and is nowhere near a
 * representative operating period. Anything at or under this is burst evidence
 * and is labelled as such.
 */
export const BURST_WINDOW_MS = 10 * 60_000;

/**
 * A window long enough that surviving it means something.
 *
 * Four hours. Long enough to cross a reset boundary for a per-window allowance,
 * several activations, and at least one quiet stretch — and short enough that a
 * fleet can actually produce the evidence. It is a judgement, it is written down
 * as one, and `SUSTAINABLE_CAPACITY` reports `UNKNOWN` rather than guessing when
 * nothing has run that long.
 */
export const SUSTAINED_WINDOW_MS = 4 * 3_600_000;

/** How many distinct levels must have been observed before a knee may be inferred. */
export const KNEE_MIN_LEVELS = 2;

/**
 * How many validated completions a concurrency level needs before it counts
 * toward a knee.
 *
 * **Three, and the reason is a defect the first version of this file shipped
 * with.** Driving the kernel against two overlapping productive sessions produced
 * exactly one completion attributed to level 1 and one to level 2, and the knee
 * rule — throughput stopped rising — declared saturation at 1 over a fleet that
 * had demonstrably just run 2 productively. One completion at a level is not a
 * throughput measurement; it is a single event, and comparing two of them is a
 * line through two points with no variance at all.
 *
 * Three is a judgement and is written down as one. What is not a judgement is the
 * direction: a spurious knee *lowers* the recommendation, which is the expensive
 * mistake, because a fleet talked down from a level it can demonstrably run loses
 * throughput nobody ever measures back.
 */
export const KNEE_MIN_SAMPLES_PER_LEVEL = 3;

/**
 * Derive every dimension.
 *
 * Deliberately one function rather than fifteen exported ones: the dimensions are
 * not independent — the recommendation is bounded by the safe lower bound, which
 * is bounded by productive overlap — and separate entry points would let a caller
 * assemble a set that is internally inconsistent. The `Record` over the union
 * means a dimension added to `CAPACITY_DIMENSIONS` is a compile error here until
 * it has a derivation.
 */
export function deriveEnvelope(observation: CapacityObservation): CapacityEnvelope {
  const readings = {
    DEFINITION_CAPACITY: definitionCapacity(observation),
    ENABLEMENT_CAPACITY: enablementCapacity(observation),
    ELIGIBLE_CAPACITY: eligibleCapacity(observation),
    OFFERED_CONCURRENCY: offeredConcurrency(observation),
    PROVIDER_ADMITTED_CONCURRENCY: admittedConcurrency(observation),
    ACTIVE_CONCURRENCY: activeConcurrency(observation),
    PRODUCTIVE_CONCURRENCY: productiveConcurrency(observation),
    START_RATE: startRate(observation),
    BURST_CAPACITY: burstCapacity(observation),
    SUSTAINABLE_CAPACITY: sustainableCapacity(observation),
    OBSERVED_SAFE_LOWER_BOUND: safeLowerBound(observation),
    OBSERVED_FAILURE_POINT: failurePoint(observation),
    INFERRED_SATURATION_KNEE: saturationKnee(observation),
    PROVIDER_ENFORCED_CEILING: providerCeiling(observation),
    RECOMMENDED_OPERATING_TARGET: unknownReading(
      'RECOMMENDED_OPERATING_TARGET',
      'placeholder replaced below; the recommendation is derived from the other fourteen',
    ),
  } satisfies Record<CapacityDimension, CapacityDimensionReading>;

  // Last, because it is a function of the others rather than of the ledger.
  readings.RECOMMENDED_OPERATING_TARGET = recommendedTarget(observation, readings);

  return {
    takenAt: observation.takenAt,
    windowHours: observation.windowHours,
    scope: observation.scope,
    readings,
    missing: observation.missing,
  };
}

/* -------------------------------------------------------------------------- */
/* What exists                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How many Routine definitions the account can hold.
 *
 * A floor, always, and this is the dimension the mandate is most explicit about:
 * a fifth Routine being created proves definition capacity is at least five and
 * nothing whatever about a maximum. There is no observation that could make this
 * an `EXACT` reading short of the provider stating a number, which it does not —
 * so `bound` is `AT_LEAST` unconditionally and cannot be argued into being a
 * limit by any amount of counting.
 *
 * Counted from `fleet_routines`, which is what *Brain* knows about. A Routine
 * that exists at the provider and was never registered here is invisible to this
 * number, which is why the report says "registered with Brain" rather than
 * "exists" — an operator reading the provider's own listing is entitled to a
 * larger figure and the two are not in conflict.
 */
function definitionCapacity(observation: CapacityObservation): CapacityDimensionReading {
  const byAccount = countByAccount(observation);
  const best = [...byAccount.entries()].sort((a, b) => b[1].total - a[1].total)[0];
  if (!best) {
    return unknownReading(
      'DEFINITION_CAPACITY',
      'no Routine is registered with Brain, so nothing has been established about how many an account can hold',
      ['a Routine is registered'],
    );
  }
  const [accountId, counts] = best;
  const name = observation.accounts.find((one) => one.id === accountId)?.name ?? accountId;
  return {
    dimension: 'DEFINITION_CAPACITY',
    value: counts.total,
    bound: 'AT_LEAST',
    evidenceClass: 'MEASURED',
    explanation:
      `${counts.total} Routine definition(s) are registered with Brain on ${name}, which establishes ` +
      `that this account holds at least ${counts.total}. It establishes no maximum: nothing has ` +
      'refused a further definition, and no provider response states a number.',
    sampleCount: counts.total,
    confidence: confidenceFromSamples(counts.total),
    evidenceIds: [],
    contradictions: [],
    staleness: ['a Routine is registered or removed', 'the account changes plan'],
  };
}

/** Of those, how many are switched on at once. Also a floor, for the same reason. */
function enablementCapacity(observation: CapacityObservation): CapacityDimensionReading {
  const byAccount = countByAccount(observation);
  const best = [...byAccount.entries()].sort((a, b) => b[1].enabled - a[1].enabled)[0];
  if (!best || best[1].enabled === 0) {
    return unknownReading(
      'ENABLEMENT_CAPACITY',
      'no registered Routine is enabled, so nothing has been established about how many may be',
      ['a Routine is enabled'],
    );
  }
  const [accountId, counts] = best;
  const name = observation.accounts.find((one) => one.id === accountId)?.name ?? accountId;
  return {
    dimension: 'ENABLEMENT_CAPACITY',
    value: counts.enabled,
    bound: 'AT_LEAST',
    evidenceClass: 'MEASURED',
    explanation:
      `${counts.enabled} of ${counts.total} Routine(s) on ${name} are ENABLED simultaneously, so at ` +
      `least ${counts.enabled} may be. Being enabled is not being fired and is not concurrency: ` +
      'it is the state in which the router will consider a surface at all.',
    sampleCount: counts.enabled,
    confidence: confidenceFromSamples(counts.enabled),
    evidenceIds: [],
    contradictions: [],
    staleness: ['a Routine is enabled, quarantined or retired'],
  };
}

/**
 * How many surfaces the router would consider right now.
 *
 * `EXACT`, and the only dimension here that is: it is a reading of a present
 * state rather than an estimate of a limit. It is taken from the router's own
 * snapshot rather than recomputed, so this figure and the one the dispatcher acts
 * on cannot disagree — the defect `services/fleet/capacity.ts` was written to end.
 */
function eligibleCapacity(observation: CapacityObservation): CapacityDimensionReading {
  if (observation.missing.some((one) => one.includes('router snapshot'))) {
    return unknownReading(
      'ELIGIBLE_CAPACITY',
      'the router snapshot could not be read, so how many surfaces are eligible is unknown rather than zero',
      ['the fleet snapshot becomes readable'],
    );
  }
  const n = observation.eligibleRoutineIds.length;
  const waiting = observation.missingSecretRoutineIds.length;
  return {
    dimension: 'ELIGIBLE_CAPACITY',
    value: n,
    bound: 'EXACT',
    evidenceClass: 'MEASURED',
    explanation:
      `${n} registered Routine(s) are candidates the router would consider this instant` +
      (waiting > 0
        ? `, with ${waiting} more registered but left out because their deployment secret is not present here.`
        : '.') +
      ' This is a reading of the present state, not a limit.',
    sampleCount: 1,
    confidence: 'HIGH',
    evidenceIds: [],
    contradictions: [],
    staleness: ['any Routine or account changes state', 'a deployment secret is set or rotated'],
  };
}

/* -------------------------------------------------------------------------- */
/* What ran                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How many activations Brain attempted at once.
 *
 * Every dispatch row in the window, accepted or not. Kept apart from admitted
 * concurrency because the difference between them is precisely the provider's
 * refusal rate, and a single "concurrency" figure hides it.
 *
 * Simultaneity here is approximated by the burst window rather than by an
 * interval sweep, and that is stated rather than hidden: a fire has an instant
 * and not a duration, so "offered at once" can only mean "offered close together".
 * It is therefore `INFERRED`, never `MEASURED`.
 */
function offeredConcurrency(observation: CapacityObservation): CapacityDimensionReading {
  const peak = peakWithin(observation.fires.map((one) => one.at), BURST_WINDOW_MS);
  if (peak.count === 0) {
    return unknownReading(
      'OFFERED_CONCURRENCY',
      'Brain attempted no activation in the window, so nothing has been offered to measure',
      ['a dispatch intent is sent'],
    );
  }
  return {
    dimension: 'OFFERED_CONCURRENCY',
    value: peak.count,
    bound: 'AT_LEAST',
    evidenceClass: 'INFERRED',
    explanation:
      `${peak.count} activation(s) were offered inside one ${Math.round(BURST_WINDOW_MS / 60_000)}-minute ` +
      `window${peak.at ? ` ending ${peak.at}` : ''}. A fire is an instant rather than an interval, so ` +
      '"at once" here means "close together" and this is inferred rather than measured.',
    sampleCount: observation.fires.length,
    confidence: confidenceFromSamples(observation.fires.length),
    evidenceIds: [],
    contradictions: [],
    staleness: ['the dispatch burst limit changes', 'the fleet composition changes'],
  };
}

/** Of those, how many the provider took. Same window reasoning, same caveat. */
function admittedConcurrency(observation: CapacityObservation): CapacityDimensionReading {
  const accepted = observation.fires.filter((one) => one.accepted);
  const peak = peakWithin(accepted.map((one) => one.at), BURST_WINDOW_MS);
  if (peak.count === 0) {
    return unknownReading(
      'PROVIDER_ADMITTED_CONCURRENCY',
      'the provider accepted no activation in the window',
      ['a fire is accepted'],
    );
  }
  const refused = observation.fires.length - accepted.length;
  return {
    dimension: 'PROVIDER_ADMITTED_CONCURRENCY',
    value: peak.count,
    bound: 'AT_LEAST',
    evidenceClass: 'INFERRED',
    explanation:
      `the provider accepted ${peak.count} activation(s) inside one ` +
      `${Math.round(BURST_WINDOW_MS / 60_000)}-minute window` +
      (refused > 0
        ? `, having not accepted ${refused} other attempt(s) in the same period.`
        : ', and did not decline any attempt in the same period.') +
      ' Acceptance is a fact about the fire and says nothing yet about whether a session ran.',
    sampleCount: accepted.length,
    confidence: confidenceFromSamples(accepted.length),
    evidenceIds: [],
    contradictions: [],
    staleness: ['the account plan changes', 'a provider refusal is recorded'],
  };
}

/**
 * How many sessions were genuinely running at the same moment.
 *
 * The one number in this file that is a real measurement of simultaneity: a sweep
 * over intervals whose start Brain observed at arrival and whose end Brain
 * recorded. Sessions with no observed end are dropped, not extended to now, and
 * the count of dropped ones is reported so an unusually low figure is readable
 * rather than mysterious.
 */
function activeConcurrency(observation: CapacityObservation): CapacityDimensionReading {
  const overlap = maxOverlap(observation.sessions);
  if (overlap.max === 0) {
    return unknownReading(
      'ACTIVE_CONCURRENCY',
      observation.sessions.length === 0
        ? 'no authenticated session arrival is recorded, so no overlap can be measured'
        : `${observation.sessions.length} session(s) arrived and none has a recorded end, so no ` +
          'interval can be closed and overlap is unknown rather than zero',
      ['a session arrives and is observed finishing'],
    );
  }
  return {
    dimension: 'ACTIVE_CONCURRENCY',
    value: overlap.max,
    bound: 'AT_LEAST',
    evidenceClass: 'MEASURED',
    explanation:
      `${overlap.max} authenticated session(s) had genuinely overlapping start and end times` +
      (overlap.at ? `, at ${overlap.at}` : '') +
      `. That establishes at least ${overlap.max} and no maximum` +
      (overlap.droppedUnfinished > 0
        ? `; ${overlap.droppedUnfinished} session(s) with no recorded end were left out rather than assumed still running.`
        : '.'),
    sampleCount: overlap.max,
    confidence: confidenceFromSamples(observation.sessions.length),
    evidenceIds: [],
    contradictions: [],
    staleness: ['the fleet composition changes', 'the provider or plan changes'],
  };
}

/**
 * Of those overlapping sessions, how many produced distinct validated work.
 *
 * The number the whole kernel exists for. Five overlapping sessions that between
 * them complete one bin are one unit of useful work wearing five activations, and
 * reporting the five as capacity is how a fleet is scaled on a fiction.
 * `productive` is read from the bin's own terminal state, so a duplicate
 * completion callback appends an event and moves nothing.
 */
function productiveConcurrency(observation: CapacityObservation): CapacityDimensionReading {
  const overlap = maxProductiveOverlap(observation.sessions);
  const active = maxOverlap(observation.sessions);
  if (overlap.max === 0) {
    return unknownReading(
      'PRODUCTIVE_CONCURRENCY',
      active.max > 0
        ? `${active.max} session(s) overlapped and none of them worked a bin that reached an accepted ` +
          'completion, so overlapping activity has not yet been shown to be productive at any level'
        : 'no overlapping session produced validated work',
      ['an overlapping session completes a bin Brain accepts'],
    );
  }
  return {
    dimension: 'PRODUCTIVE_CONCURRENCY',
    value: overlap.max,
    bound: 'AT_LEAST',
    evidenceClass: 'MEASURED',
    explanation:
      `${overlap.max} overlapping session(s) each worked a bin that reached an accepted completion` +
      (overlap.at ? `, at ${overlap.at}` : '') +
      (active.max > overlap.max
        ? `. ${active.max} overlapped in total, so ${active.max - overlap.max} of them did not turn into ` +
          'distinct validated work — which is why the two are reported separately.'
        : '. Every overlapping session in that moment produced distinct validated work.'),
    sampleCount: overlap.max,
    confidence: confidenceFromSamples(observation.validatedCompletions.length),
    evidenceIds: observation.validatedCompletions.map((one) => one.eventId).slice(0, 20),
    contradictions: [],
    staleness: ['the workload class changes', 'the fleet composition changes'],
  };
}

/** Accepted starts per hour. A rate, with its sample count beside it. */
function startRate(observation: CapacityObservation): CapacityDimensionReading {
  const rate = startRatePerHour(observation.fires, observation.windowHours);
  if (rate.perHour === null || rate.accepted === 0) {
    return unknownReading(
      'START_RATE',
      'no activation was accepted in the window, so there is no rate to report',
      ['a fire is accepted'],
    );
  }
  return {
    dimension: 'START_RATE',
    value: rate.perHour,
    bound: 'EXACT',
    evidenceClass: 'MEASURED',
    explanation:
      `${rate.accepted} accepted activation(s) over ${observation.windowHours}h, which is ` +
      `${rate.perHour.toFixed(2)} per hour. This is what Brain *asked for* and was given; it is not a ` +
      'ceiling, because nothing in the window refused a further start.',
    sampleCount: rate.accepted,
    confidence: confidenceFromSamples(rate.accepted),
    evidenceIds: [],
    contradictions: [],
    staleness: ['the backlog changes', 'the fleet target changes'],
  };
}

/* -------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A level that worked briefly.
 *
 * The highest overlap whose whole span fits inside `BURST_WINDOW_MS`. Separated
 * from sustainable capacity because surviving ten minutes and surviving four
 * hours are different claims and the first is routinely reported as the second.
 */
function burstCapacity(observation: CapacityObservation): CapacityDimensionReading {
  const best = bestOverlapWithinSpan(observation, BURST_WINDOW_MS, true);
  if (best === null) {
    return unknownReading(
      'BURST_CAPACITY',
      'no group of overlapping sessions has been observed, so no level has worked even briefly',
      ['sessions overlap and finish'],
    );
  }
  return {
    dimension: 'BURST_CAPACITY',
    value: best,
    bound: 'AT_LEAST',
    evidenceClass: 'MEASURED',
    explanation:
      `${best} overlapping session(s) ran and finished inside ${Math.round(BURST_WINDOW_MS / 60_000)} ` +
      'minutes. Brief survival only: it says nothing about a representative operating period.',
    sampleCount: best,
    confidence: 'LOW',
    evidenceIds: [],
    contradictions: [],
    staleness: ['the fleet composition changes'],
  };
}

/**
 * A level that stayed healthy over a representative period.
 *
 * Requires the overlapping activity to span at least `SUSTAINED_WINDOW_MS` *and*
 * no provider refusal inside it. Almost always `UNKNOWN`, and that is the honest
 * answer rather than a gap: a sustained claim from ten minutes of evidence is the
 * one number somebody would size a fleet on.
 */
function sustainableCapacity(observation: CapacityObservation): CapacityDimensionReading {
  if (observation.providerRefusals.length > 0) {
    return unknownReading(
      'SUSTAINABLE_CAPACITY',
      `${observation.providerRefusals.length} provider refusal(s) occurred inside the window, so no ` +
        'level in it can be called sustainable — the window is not a healthy period.',
      ['a window passes with no provider refusal'],
    );
  }
  const best = bestOverlapWithinSpan(observation, SUSTAINED_WINDOW_MS, false);
  if (best === null) {
    return unknownReading(
      'SUSTAINABLE_CAPACITY',
      `no overlapping activity has spanned ${Math.round(SUSTAINED_WINDOW_MS / 3_600_000)} hours, so no ` +
        'level has been shown to hold over a representative period. This is not a failure; it is ' +
        'evidence that has not been collected yet.',
      ['overlapping sessions run across a representative period'],
    );
  }
  return {
    dimension: 'SUSTAINABLE_CAPACITY',
    value: best,
    bound: 'AT_LEAST',
    evidenceClass: 'MEASURED',
    explanation:
      `${best} overlapping session(s) ran across at least ` +
      `${Math.round(SUSTAINED_WINDOW_MS / 3_600_000)} hours with no provider refusal recorded.`,
    sampleCount: best,
    confidence: confidenceFromSamples(observation.sessions.length),
    evidenceIds: [],
    contradictions: [],
    staleness: ['the provider, plan or fleet composition changes'],
  };
}

/**
 * The highest level directly demonstrated to work.
 *
 * Productive overlap, and only productive overlap. A level at which sessions ran
 * but nothing was validated has not been demonstrated to *work* — it has been
 * demonstrated to start.
 */
function safeLowerBound(observation: CapacityObservation): CapacityDimensionReading {
  const productive = maxProductiveOverlap(observation.sessions);
  if (productive.max === 0) {
    return unknownReading(
      'OBSERVED_SAFE_LOWER_BOUND',
      'no level of overlapping activity has produced distinct validated work, so none has been ' +
        'demonstrated to work rather than merely to start',
      ['overlapping sessions produce validated work'],
    );
  }
  return {
    dimension: 'OBSERVED_SAFE_LOWER_BOUND',
    value: productive.max,
    bound: 'AT_LEAST',
    evidenceClass: 'MEASURED',
    explanation:
      `${productive.max} is the highest concurrency at which overlapping sessions each produced ` +
      'distinct validated work. It is a floor that has been demonstrated, not a ceiling that has been found.',
    sampleCount: productive.max,
    confidence: confidenceFromSamples(observation.validatedCompletions.length),
    evidenceIds: observation.validatedCompletions.map((one) => one.eventId).slice(0, 20),
    contradictions: [],
    staleness: ['the fleet composition, plan or workload changes'],
  };
}

/**
 * The lowest level at which something actually refused or degraded.
 *
 * Derived from provider refusals only, and paired with the overlap observed at
 * the time of the earliest one. A refusal is an `AT_MOST` on the level it
 * happened at — but on a sample of one it is `LOW` confidence and the explanation
 * says in words that one episode proves one episode.
 */
function failurePoint(observation: CapacityObservation): CapacityDimensionReading {
  const first = observation.providerRefusals[0];
  if (!first) {
    return unknownReading(
      'OBSERVED_FAILURE_POINT',
      'nothing has refused and no degradation has been recorded in the window, so no failure point ' +
        'has been observed. That is different from there being none.',
      ['a provider refusal or a measured degradation is recorded'],
    );
  }
  const atThatMoment = observation.sessions.filter(
    (one) => one.startedAt <= first.at && (one.endedAt === null || one.endedAt >= first.at),
  ).length;
  const repeated = observation.providerRefusals.length;
  /*
   * The level that *failed*, which is one above the level that was running.
   *
   * **This was off by one, in the understating direction, and a test found it.**
   * Counting the sessions open at the refusal gives the level that was working
   * when a further start was refused — so calling that number the failure point
   * labels a level Brain had demonstrably just run as the point at which things
   * break, and the recommendation derived from it (`failure - 1`) then lands one
   * *below* the demonstrated bound. Three sessions open and a fourth refused
   * means three worked and four did not exist.
   *
   * With nothing open, the level refused was the first one, so the failure point
   * is 1 rather than 2.
   */
  const failedLevel = atThatMoment > 0 ? atThatMoment + 1 : 1;
  return {
    dimension: 'OBSERVED_FAILURE_POINT',
    value: failedLevel,
    bound: 'AT_MOST',
    evidenceClass: 'PROVIDER_ENFORCED',
    explanation:
      `the provider refused a further start at ${first.at} with ${atThatMoment} session(s) already ` +
      `open, so ${failedLevel} is the lowest level observed failing and ${atThatMoment} was running. ` +
      (repeated > 1
        ? `${repeated} refusals were recorded in the window, which is repeated evidence but still not a stated quota.`
        : 'One refusal proves that one refusal happened. It is not yet a recurring rule and must not be read as one.') +
      (first.reason ? ` The provider said: ${first.reason}` : ''),
    sampleCount: repeated,
    confidence: confidenceFromSamples(repeated),
    evidenceIds: observation.providerRefusals.map((one) => one.eventId).slice(0, 20),
    contradictions: [],
    staleness: ['the reset window passes', 'the account plan changes'],
  };
}

/**
 * Where another surface stops adding useful throughput.
 *
 * Requires at least `KNEE_MIN_LEVELS` distinct observed concurrency levels with
 * throughput at each, and returns `UNKNOWN` otherwise. A knee inferred from one
 * level is a line through one point, and the competing explanation is always
 * named when a knee is reported: the work may simply have run out.
 */
function saturationKnee(observation: CapacityObservation): CapacityDimensionReading {
  const all = throughputByLevel(observation);
  /*
   * Levels with a real sample behind them, and only those. A level carrying one
   * completion contributes a data point to a comparison that then reads as a
   * trend — see `KNEE_MIN_SAMPLES_PER_LEVEL`.
   */
  const levels = all.filter((one) => one.samples >= KNEE_MIN_SAMPLES_PER_LEVEL);
  if (levels.length < KNEE_MIN_LEVELS) {
    return unknownReading(
      'INFERRED_SATURATION_KNEE',
      `throughput has been observed at ${all.length} distinct concurrency level(s) and at ` +
        `${levels.length} of them with at least ${KNEE_MIN_SAMPLES_PER_LEVEL} completion(s); at least ` +
        `${KNEE_MIN_LEVELS} such levels are needed before a knee is anything but a line through two ` +
        'single events',
      ['throughput is measured at another distinct concurrency level'],
    );
  }
  let knee: number | null = null;
  for (let i = 1; i < levels.length; i += 1) {
    const previous = levels[i - 1]!;
    const current = levels[i]!;
    if (current.completions <= previous.completions) {
      knee = previous.level;
      break;
    }
  }
  if (knee === null) {
    return unknownReading(
      'INFERRED_SATURATION_KNEE',
      `useful throughput was still rising at the highest level observed (${levels[levels.length - 1]!.level}), ` +
        'so no knee has been reached yet',
      ['throughput stops rising at a higher level'],
    );
  }
  return {
    dimension: 'INFERRED_SATURATION_KNEE',
    value: knee,
    bound: 'EXACT',
    evidenceClass: 'INFERRED',
    explanation:
      `useful validated throughput stopped rising above ${knee} overlapping session(s). The competing ` +
      'explanation is that the queue ran out of comparable work at the higher level rather than the ' +
      'fleet saturating, and nothing here distinguishes the two — which is why this is inferred.',
    sampleCount: levels.reduce((total, one) => total + one.samples, 0),
    confidence: 'LOW',
    evidenceIds: [],
    contradictions: ['the work supply at the higher level was not held constant'],
    staleness: ['the workload mix changes', 'the fleet composition changes'],
  };
}

/**
 * An explicit provider quota, or a repeatable provider boundary.
 *
 * Three conditions, all required, and every one of them is there to stop a local
 * cause being reported as the provider's:
 *
 *   1. At least two refusals the provider itself issued, so one bad minute is not
 *      a ceiling.
 *   2. Every one of them classified `PROVIDER_ENFORCED` at the moment it was
 *      observed, which only `recordAllowanceObservation` does and only for a 429.
 *   3. **The local guardrails were not what refused.** If the fleet target was
 *      already reached at that concurrency, the honest answer is that Brain
 *      stopped before the provider did, and the refusal is evidence about a
 *      Routine's own per-surface limit rather than the account's ceiling.
 *
 * Without the third, a target of four plus a refusal reads as a provider limit of
 * four, which is the exact mistake this dimension exists to prevent.
 */
function providerCeiling(observation: CapacityObservation): CapacityDimensionReading {
  const refusals = observation.providerRefusals;
  if (refusals.length === 0) {
    return unknownReading(
      'PROVIDER_ENFORCED_CEILING',
      'no provider refusal is recorded, so no provider-enforced ceiling has been observed. An ' +
        'internal target, a scheduler decision or an absence of work is never this.',
      ['the provider refuses a fire at least twice at a known concurrency'],
    );
  }
  if (refusals.length < 2) {
    return unknownReading(
      'PROVIDER_ENFORCED_CEILING',
      'one provider refusal is recorded. One episode establishes that an episode happened; a ' +
        'ceiling is a repeatable boundary, so this stays unknown until it repeats.',
      ['the refusal repeats at the same concurrency'],
    );
  }
  const stated = refusals
    .map((one) => one.at)
    .map((at) =>
      observation.sessions.filter(
        (session) => session.startedAt <= at && (session.endedAt === null || session.endedAt >= at),
      ).length,
    )
    .filter((n) => n > 0);
  const level = stated.length > 0 ? Math.min(...stated) : null;
  if (level === null) {
    return unknownReading(
      'PROVIDER_ENFORCED_CEILING',
      `${refusals.length} provider refusals are recorded but no session was open at any of them, so ` +
        'the refusal cannot be attributed to a concurrency level. It may have been a per-window ' +
        'allowance rather than a simultaneity limit, and those are different ceilings.',
      ['a refusal occurs with sessions demonstrably open'],
    );
  }
  if (observation.fleetTarget !== null && observation.fleetTarget <= level) {
    return unknownReading(
      'PROVIDER_ENFORCED_CEILING',
      `${refusals.length} refusals were recorded at ${level} open session(s), but Brain's own fleet ` +
        `target is ${observation.fleetTarget} — so a local guardrail was already binding at that level ` +
        'and the provider was never asked for more. The local cause has to be removed before this can ' +
        'be attributed to the provider.',
      ['the local target is raised above the refusal level and the refusal repeats'],
    );
  }
  return {
    dimension: 'PROVIDER_ENFORCED_CEILING',
    value: level,
    bound: 'AT_MOST',
    evidenceClass: 'PROVIDER_ENFORCED',
    explanation:
      `the provider refused ${refusals.length} times, the lowest of them with ${level} session(s) open, ` +
      'and no local target was binding at that level. That is a repeatable provider boundary rather ' +
      'than a stated quota: the provider does not publish a number, so this is the lowest level at ' +
      'which it has actually said no.',
    sampleCount: refusals.length,
    confidence: confidenceFromSamples(refusals.length),
    evidenceIds: refusals.map((one) => one.eventId).slice(0, 20),
    contradictions: [],
    staleness: ['the account plan changes', 'the provider changes its limits'],
  };
}

/**
 * The highest tested level with room to spare.
 *
 * Bounded by three things and never above any of them: what has actually been
 * demonstrated to work, one below the lowest observed failure, and the knee. When
 * nothing has been demonstrated it recommends **keeping the current
 * configuration** rather than a number — the mandate's own instruction, and the
 * only safe answer, because a recommendation with no evidence behind it would be
 * acted on exactly as readily as one with evidence.
 */
function recommendedTarget(
  observation: CapacityObservation,
  readings: Record<CapacityDimension, CapacityDimensionReading>,
): CapacityDimensionReading {
  const safe = readings.OBSERVED_SAFE_LOWER_BOUND.value;
  const failure = readings.OBSERVED_FAILURE_POINT.value;
  const knee = readings.INFERRED_SATURATION_KNEE.value;

  if (safe === null) {
    return {
      dimension: 'RECOMMENDED_OPERATING_TARGET',
      value: observation.fleetTarget,
      bound: 'EXACT',
      evidenceClass: observation.fleetTarget === null ? 'UNKNOWN' : 'INFERRED',
      explanation:
        observation.fleetTarget === null
          ? 'no concurrency target is configured and no level has been demonstrated, so there is nothing ' +
            'to recommend yet. Leave the fleet as it is and let the kernel collect a baseline.'
          : `keep the current verified configuration of ${observation.fleetTarget}. No level has been ` +
            'demonstrated to produce validated work yet, so any other number would be a guess, and a ' +
            'guessed target is acted on exactly as readily as a measured one.',
      sampleCount: 0,
      confidence: 'LOW',
      evidenceIds: [],
      contradictions: [],
      staleness: ['a level is demonstrated to work'],
    };
  }

  /*
   * The ceilings, and then the floor — in that order, and the order is a defect
   * the first version of this function had.
   *
   * It took the plain minimum of {safe, failure-1, knee}, which let an **inference
   * override a measurement downwards**. Driving the kernel produced exactly that:
   * a spurious knee at 1 over a fleet whose productive overlap had just been
   * measured at 2, and the recommendation came out at 1 — advising Brain down from
   * a level it had demonstrably run.
   *
   * A knee is an inference about where more stops helping. A demonstrated safe
   * lower bound is a measurement that a level works. When they disagree the
   * measurement wins, and the disagreement is **recorded as a contradiction**
   * rather than silently resolved — §17's rule that new evidence never quietly
   * overwrites old, applied to two readings of one fleet.
   */
  const ceilings: { value: number; why: string }[] = [];
  if (failure !== null) {
    ceilings.push({ value: Math.max(1, failure - 1), why: `one below the observed failure at ${failure}` });
  }
  if (knee !== null) ceilings.push({ value: knee, why: `the inferred saturation knee at ${knee}` });

  const lowestCeiling = ceilings.reduce<{ value: number; why: string } | null>(
    (lowest, one) => (lowest === null || one.value < lowest.value ? one : lowest),
    null,
  );

  const contradictions: string[] = [];
  let value: number;
  let why: string;
  if (lowestCeiling === null) {
    value = safe;
    why = `what has been demonstrated to work (${safe}), with nothing yet bounding it from above`;
  } else if (lowestCeiling.value >= safe) {
    value = lowestCeiling.value;
    why = lowestCeiling.why;
  } else {
    /*
     * The one branch where the two disagree. The measurement holds, and the
     * ceiling that argued for less is kept where a reader can see it.
     */
    value = safe;
    why =
      `what has been demonstrated to work (${safe}). ${lowestCeiling.why} argues for ` +
      `${lowestCeiling.value}, and a demonstrated level outranks an inferred ceiling — a fleet talked ` +
      'down from a level it has actually run loses throughput nobody measures back';
    contradictions.push(
      `${lowestCeiling.why} implies ${lowestCeiling.value}, below the demonstrated ${safe}`,
    );
  }

  return {
    dimension: 'RECOMMENDED_OPERATING_TARGET',
    value,
    bound: 'EXACT',
    evidenceClass: 'INFERRED',
    explanation:
      `${value}, bounded by ${why}. It is never above what has actually been shown to work, so ` +
      'raising it is an experiment rather than a configuration change.',
    sampleCount: readings.OBSERVED_SAFE_LOWER_BOUND.sampleCount,
    confidence: readings.OBSERVED_SAFE_LOWER_BOUND.confidence,
    evidenceIds: readings.OBSERVED_SAFE_LOWER_BOUND.evidenceIds,
    contradictions,
    staleness: ['any of the bounds it is derived from changes'],
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function countByAccount(observation: CapacityObservation): Map<string, { total: number; enabled: number }> {
  const out = new Map<string, { total: number; enabled: number }>();
  for (const routine of observation.routines) {
    const entry = out.get(routine.accountId) ?? { total: 0, enabled: 0 };
    entry.total += 1;
    if (routine.state === 'ENABLED') entry.enabled += 1;
    out.set(routine.accountId, entry);
  }
  return out;
}

/**
 * The most timestamps falling inside any one sliding window.
 *
 * A sliding window over sorted instants rather than fixed buckets, because a
 * fixed bucket splits a genuine burst across a boundary and reports half of it.
 */
function peakWithin(instants: readonly string[], windowMs: number): { count: number; at: string | null } {
  const times = instants
    .map((one) => Date.parse(one))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  if (times.length === 0) return { count: 0, at: null };
  let best = 0;
  let bestAt = times[0]!;
  let start = 0;
  for (let end = 0; end < times.length; end += 1) {
    while (times[end]! - times[start]! > windowMs) start += 1;
    const count = end - start + 1;
    if (count > best) {
      best = count;
      bestAt = times[end]!;
    }
  }
  return { count: best, at: new Date(bestAt).toISOString() };
}

/**
 * The highest overlap whose contributing sessions all fall inside a span.
 *
 * `within` true means the whole group must fit *inside* the span — the burst
 * question. `within` false means the group must cover *at least* the span — the
 * sustained question. One function because the sweep is identical and the only
 * difference is the comparison, and two copies of an overlap sweep would be the
 * two-readers defect at the number this whole file turns on.
 */
function bestOverlapWithinSpan(
  observation: CapacityObservation,
  spanMs: number,
  within: boolean,
): number | null {
  const closed = observation.sessions.filter((one) => one.endedAt !== null);
  if (closed.length === 0) return null;
  const overlap = maxOverlap(closed);
  if (overlap.max === 0 || overlap.sessionRefs.length === 0) return null;
  const group = closed.filter((one) => overlap.sessionRefs.includes(one.sessionRef));
  const first = Math.min(...group.map((one) => Date.parse(one.startedAt)));
  const last = Math.max(...group.map((one) => Date.parse(one.endedAt!)));
  const span = last - first;
  if (within ? span <= spanMs : span >= spanMs) return overlap.max;
  return null;
}

/**
 * Validated completions grouped by the concurrency that was running at the time.
 *
 * The input to the knee. Crude — it attributes a completion to the overlap at the
 * instant it was accepted — and crude is correct here: anything finer would be a
 * model of how a completion is caused, and the kernel's job is to report what was
 * observed rather than to explain it.
 */
function throughputByLevel(
  observation: CapacityObservation,
): { level: number; completions: number; samples: number }[] {
  const byLevel = new Map<number, number>();
  for (const completion of observation.validatedCompletions) {
    const open = observation.sessions.filter(
      (one) =>
        one.startedAt <= completion.at && (one.endedAt === null || one.endedAt >= completion.at),
    ).length;
    if (open === 0) continue;
    byLevel.set(open, (byLevel.get(open) ?? 0) + 1);
  }
  return [...byLevel.entries()]
    .map(([level, completions]) => ({ level, completions, samples: completions }))
    .sort((a, b) => a.level - b.level);
}

/** Every dimension, in declaration order, for a report that must not miss one. */
export function envelopeRows(envelope: CapacityEnvelope): CapacityDimensionReading[] {
  return CAPACITY_DIMENSIONS.map((dimension) => envelope.readings[dimension]);
}

export { DIMENSION_MEANING };
