/**
 * The vocabulary of a capacity claim.
 *
 * ---------------------------------------------------------------------------
 * Why fifteen dimensions and not one number
 * ---------------------------------------------------------------------------
 *
 * "How many Routines can we run?" has at least fifteen different true answers,
 * and the ones that get conflated are the ones that cost something:
 *
 *   * A Routine **definition** existing is not a Routine being **enabled**, and
 *     neither is a Routine being **eligible** — §23 already separates an account
 *     from a Routine for exactly this reason and then warns that arithmetic which
 *     ignores the distinction is arithmetic on a fiction.
 *   * A fire Brain **offered** is not a fire the provider **admitted**, and an
 *     admitted fire is not a session that **overlapped** another one. Step 10's
 *     rung 20 finished twenty bins from thirteen activations, so counting
 *     activations as concurrency overstates it by nearly half.
 *   * And overlapping sessions are not **productive** concurrency. Five sessions
 *     that overlap and produce one validated result are one unit of useful work
 *     wearing five activations, which is the measurement this whole kernel exists
 *     to stop being reported as five.
 *
 * So there is no aggregate here, no rollup, no percentage and no `isComplete`.
 * §29 records what happens the moment one exists: every reader uses it and the
 * parts it was made of become decoration.
 *
 * ---------------------------------------------------------------------------
 * Bound is the honesty requirement
 * ---------------------------------------------------------------------------
 *
 * Every claim carries whether it is a floor, a ceiling or an exact reading.
 * Creating a fifth Routine establishes definition capacity **AT_LEAST** five and
 * says nothing whatever about a maximum; a provider refusal at six establishes an
 * **AT_MOST**; the number of Routines currently enabled is an **EXACT** reading of
 * a present fact rather than a limit at all. One integer cannot carry that
 * difference, and without it "we created a fifth" becomes "the limit is five" by
 * the time it reaches a report.
 */

/** The four-value evidence vocabulary the ledger and `fleet/view.ts` already use. */
export type CapacityEvidenceClass = 'MEASURED' | 'INFERRED' | 'UNKNOWN' | 'PROVIDER_ENFORCED';

/** Whether a number is a floor, a ceiling, or the thing itself. */
export type CapacityBound = 'AT_LEAST' | 'AT_MOST' | 'EXACT';

export type CapacityConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * The fifteen dimensions, in the order a person reads them: what exists, what is
 * switched on, what could take work, what was attempted, what was accepted, what
 * actually ran, what actually produced something — then the rates, the bounds and
 * finally the recommendation.
 */
export const CAPACITY_DIMENSIONS = [
  /** Routine definitions the account can hold. */
  'DEFINITION_CAPACITY',
  /** Definitions that may be enabled at once. */
  'ENABLEMENT_CAPACITY',
  /** Enabled surfaces the router would actually consider. */
  'ELIGIBLE_CAPACITY',
  /** Activations Brain attempted to start. */
  'OFFERED_CONCURRENCY',
  /** Activations the provider accepted. */
  'PROVIDER_ADMITTED_CONCURRENCY',
  /** Sessions whose start/end intervals genuinely overlapped. */
  'ACTIVE_CONCURRENCY',
  /** Of those, the ones that produced distinct validated work. */
  'PRODUCTIVE_CONCURRENCY',
  /** Accepted starts per account per hour. */
  'START_RATE',
  /** A level that worked briefly. */
  'BURST_CAPACITY',
  /** A level that stayed healthy over a representative period. */
  'SUSTAINABLE_CAPACITY',
  /** The highest level directly demonstrated to work. */
  'OBSERVED_SAFE_LOWER_BOUND',
  /** The lowest level at which a constraint or real degradation appeared. */
  'OBSERVED_FAILURE_POINT',
  /** Where more surfaces stop adding material useful throughput. */
  'INFERRED_SATURATION_KNEE',
  /** An explicit provider quota or a repeatable provider boundary. Usually UNKNOWN. */
  'PROVIDER_ENFORCED_CEILING',
  /** The highest tested level with suitable headroom. */
  'RECOMMENDED_OPERATING_TARGET',
] as const;

export type CapacityDimension = (typeof CAPACITY_DIMENSIONS)[number];

const DIMENSION_SET: ReadonlySet<string> = new Set<string>(CAPACITY_DIMENSIONS);

export function isCapacityDimension(value: string): value is CapacityDimension {
  return DIMENSION_SET.has(value);
}

/**
 * What each dimension means, in one sentence a person reads.
 *
 * Here rather than composed at the point of display, because two surfaces
 * describing one dimension differently is how the quieter of the two stops being
 * believed — the defect §29 records at a status line and §33 at a card.
 */
export const DIMENSION_MEANING: Record<CapacityDimension, string> = {
  DEFINITION_CAPACITY: 'how many Routine definitions this account can hold',
  ENABLEMENT_CAPACITY: 'how many of those definitions may be enabled at the same time',
  ELIGIBLE_CAPACITY: 'how many enabled surfaces the router would consider for work right now',
  OFFERED_CONCURRENCY: 'how many activations Brain tried to start at once',
  PROVIDER_ADMITTED_CONCURRENCY: 'how many of those the provider accepted at once',
  ACTIVE_CONCURRENCY: 'how many sessions were genuinely running at the same moment',
  PRODUCTIVE_CONCURRENCY: 'how many of those overlapping sessions produced distinct validated work',
  START_RATE: 'accepted activations per hour on this account',
  BURST_CAPACITY: 'a level that worked for a short while',
  SUSTAINABLE_CAPACITY: 'a level that stayed healthy over a representative period',
  OBSERVED_SAFE_LOWER_BOUND: 'the highest level Brain has directly demonstrated working',
  OBSERVED_FAILURE_POINT: 'the lowest level at which something actually refused or degraded',
  INFERRED_SATURATION_KNEE: 'where adding another surface stops adding useful throughput',
  PROVIDER_ENFORCED_CEILING: 'a limit the provider itself stated or repeatably imposed',
  RECOMMENDED_OPERATING_TARGET: 'the highest tested level with room to spare',
};

/**
 * A single reading. The live half of a claim.
 *
 * `value === null` is only ever paired with `UNKNOWN`, and that pairing is
 * enforced by a CHECK constraint in migration 074 rather than by a convention.
 * Zero is a reading; UNKNOWN is the absence of one; they must never be the same
 * thing, which is invariant 39 at a number.
 */
export interface CapacityDimensionReading {
  dimension: CapacityDimension;
  value: number | null;
  bound: CapacityBound;
  evidenceClass: CapacityEvidenceClass;
  /** One sentence. Never an enum and never a template with a hole in it. */
  explanation: string;
  /** How many independent observations this rests on. Zero for an UNKNOWN. */
  sampleCount: number;
  confidence: CapacityConfidence;
  /** `bin_events.id` values. Pointers into the ledger, never copies of it. */
  evidenceIds: string[];
  /** Readings that argue against this one, kept rather than dropped. */
  contradictions: string[];
  /** What would make this stop being about this system. */
  staleness: string[];
}

/**
 * A number nobody has established. Its own constructor so no caller has to
 * remember that an unknown carries no value, no samples and no confidence.
 */
export function unknownReading(
  dimension: CapacityDimension,
  explanation: string,
  staleness: string[] = [],
): CapacityDimensionReading {
  return {
    dimension,
    value: null,
    bound: 'EXACT',
    evidenceClass: 'UNKNOWN',
    explanation,
    sampleCount: 0,
    confidence: 'LOW',
    evidenceIds: [],
    contradictions: [],
    staleness,
  };
}

/**
 * Confidence from the sample count, in one place.
 *
 * Deliberately crude and deliberately not a probability. §38 refuses a weighted
 * score for the same reason: weights are a judgement nobody made, and the number
 * then reads like a measurement. Three thresholds over a count are obviously a
 * rule of thumb, which is what they are.
 */
export function confidenceFromSamples(samples: number): CapacityConfidence {
  if (samples >= 10) return 'HIGH';
  if (samples >= 3) return 'MEDIUM';
  return 'LOW';
}

/* -------------------------------------------------------------------------- */
/* Experiments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The experiments this kernel knows how to run.
 *
 * A closed set, and small on purpose. The mandate's own instruction is to change
 * one primary factor at a time rather than enumerate a matrix, and §27 records
 * four separate widenings of a closed list that each added the one word the last
 * production message had been refused for — so the failure mode here is fixed at
 * *missing an experiment*, which costs a reading, rather than at inventing one,
 * which costs an activation and a conclusion.
 */
export const CAPACITY_EXPERIMENT_KINDS = [
  /**
   * Watch what production does and conclude nothing else. Spends nothing, needs
   * no authority, and is the correct answer whenever the archive of past
   * activations has not been read out yet — §13's rule at a measurement.
   */
  'PASSIVE_BASELINE',
  /**
   * One more Routine definition on an existing account. Brain cannot do this:
   * the deployed Brain holds a per-Routine bearer for *firing* a named trigger
   * and nothing that can create one, and §22 forbids it minting its own
   * surfaces. So this is always `NEEDS_USER`, and its whole value is that the
   * answer it asks for is precise.
   */
  'DEFINITION_STAIRCASE',
  /**
   * Raise the concurrency ceiling by exactly one above the highest level already
   * demonstrated, with isolated canary work to fill it, for a bounded window.
   * Brain's own, because the instrument is `fleet_policy.explore_ceiling` — a
   * row, append-only, with the previous version still there to revert to.
   */
  'CONCURRENCY_STAIRCASE',
  /**
   * Hold the current level and find out whether it survives a representative
   * period. Changes no factor at all, which is why it is the only way
   * `SUSTAINABLE_CAPACITY` ever stops being UNKNOWN.
   */
  'SUSTAINED_HOLD',
] as const;

export type CapacityExperimentKind = (typeof CAPACITY_EXPERIMENT_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set<string>(CAPACITY_EXPERIMENT_KINDS);

export function isCapacityExperimentKind(value: string): value is CapacityExperimentKind {
  return KIND_SET.has(value);
}

export type CapacityExperimentState =
  | 'PROPOSED'
  | 'AUTHORIZED'
  | 'CANARY_RUNNING'
  | 'EVALUATING'
  | 'ADOPTED'
  | 'ROLLED_BACK'
  | 'ABANDONED'
  | 'NEEDS_USER';

export type CapacityExperimentVerdict = 'CONFIRMED' | 'REFUTED' | 'INCONCLUSIVE' | 'STOPPED';

/**
 * Who may start each kind, and there is no third answer.
 *
 * `BRAIN` means every effect it has is a row Brain already owns: a
 * `fleet_policy` version and some isolated canary bins. `PERSON` means it needs
 * an action outside Brain's reach, and Brain's whole job then is to name that
 * action exactly and carry on with everything else.
 *
 * A `Record` over the union rather than a list, so an experiment added later is a
 * compile error until somebody says which it is. Two sets that had to be total
 * between them were not, twice, in `router.ts`.
 */
export const EXPERIMENT_AUTHORITY: Record<CapacityExperimentKind, 'BRAIN' | 'PERSON'> = {
  PASSIVE_BASELINE: 'BRAIN',
  SUSTAINED_HOLD: 'BRAIN',
  CONCURRENCY_STAIRCASE: 'BRAIN',
  DEFINITION_STAIRCASE: 'PERSON',
};

/** Which dimension each kind is trying to reduce the uncertainty in. */
export const EXPERIMENT_DIMENSION: Record<CapacityExperimentKind, CapacityDimension> = {
  PASSIVE_BASELINE: 'ACTIVE_CONCURRENCY',
  SUSTAINED_HOLD: 'SUSTAINABLE_CAPACITY',
  CONCURRENCY_STAIRCASE: 'PRODUCTIVE_CONCURRENCY',
  DEFINITION_STAIRCASE: 'DEFINITION_CAPACITY',
};

/**
 * The workload class isolated canary load carries.
 *
 * Its own class so that canary work can never be counted as validated useful
 * throughput, and so a capacity reading can be taken with the workload held
 * constant — §29's rule that a batch of shorter work must not read as a capacity
 * improvement.
 *
 * **The `SURFACE_PROBE` prefix is load-bearing rather than decorative, and the
 * obvious name would have made this bin unroutable.** `familyOf` reads the
 * prefix, so a class called `CAPACITY_CANARY_V1` resolves to the `GENERAL`
 * family — and `classesForFamilies(['GENERAL'])` scopes the candidate query to
 * classes beginning `GENERAL`, which that name does not. The bin would have been
 * READY, the surfaces eligible, every row correct, and the assigner would have
 * answered `NO_READY_BINS` on the one column nobody was looking at. That is
 * verbatim the defect §37 records about the capability kernel's extraction bin,
 * and it is repeated here because a canary that cannot be handed out measures a
 * queue rather than a fleet. `SURFACE_PROBE…` is what `createProbeBin` already
 * uses, resolves to `RESEARCH`, matches a prefix the query really scopes by, and
 * reaches no repository.
 */
export const CANARY_WORKLOAD_CLASS = 'SURFACE_PROBE_CAPACITY_CANARY_V1';
