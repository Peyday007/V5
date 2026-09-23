/**
 * The vocabulary of learning from outcomes, as closed sets.
 *
 * Every value here is a word a row may carry and a reader may branch on, so
 * each set is closed and matched exactly — §8's rule, at the one place a loose
 * word would be most expensive: a lesson somebody later acts on.
 *
 * ---------------------------------------------------------------------------
 * An outcome is not a lesson, and a lesson is not a rule
 * ---------------------------------------------------------------------------
 *
 * `outcome_records` holds what was observed, one attempt at a time. Whether
 * several of them amount to anything is decided in
 * `services/learning/lessons.ts`, on every read, with the sample beside it —
 * and only a lesson that clears its own floor is allowed to change a decision.
 * One result is reported as an anecdote and changes nothing, however vivid.
 */

/**
 * The approaches Brain can learn about. An approach is a way Brain does a kind
 * of work, and it is the unit a lesson is scoped to: a deep dive failing tells
 * Brain something about deep dives and nothing about factory campaigns.
 *
 * One today, deliberately. An approach belongs here only once something
 * observes its outcomes *and* some decision reads the lessons — an approach
 * that is recorded and never consulted is the stored-and-displayed shape this
 * module exists to end. Adding one is a reviewed change with both halves.
 */
export const APPROACHES = ['CASH_DEEP_DIVE'] as const;
export type Approach = (typeof APPROACHES)[number];

/**
 * What a goal counts as success, which is not always money.
 *
 * A commercial goal is measured in payment and obligations; a research goal in
 * whether the question got an answer that stands; a software goal in whether a
 * change landed and passed its own checks; a creative goal in whether a person
 * accepted the work. Forcing every project into a revenue measure would report
 * research and creative work as permanent failures, which is a measurement
 * choosing its own conclusion.
 */
export const GOAL_KINDS = ['COMMERCIAL', 'RESEARCH', 'SOFTWARE', 'CREATIVE'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export const OUTCOME_RESULTS = [
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  /** The approach never touched the subject. Evidence about conditions only. */
  'NOT_ATTEMPTED',
  'ONGOING',
  'UNKNOWN',
] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];

/**
 * What kind of fact a figure is. The whole point of the separation is that
 * these are never summed, averaged or compared as if they were one thing.
 */
export const EVIDENCE_CLASSES = [
  /** The difference between two timestamps Brain recorded, or a count of rows. */
  'MEASURED',
  /** Brain's own projection, carrying its basis. */
  'ESTIMATE',
  /** What a worker said about its own work. Stored, never decisive. */
  'WORKER_CLAIM',
  /** A view somebody formed — a judge's verdict, a person's call. */
  'JUDGMENT',
  /** Nothing records it. Never zero, never omitted. */
  'UNKNOWN',
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const OUTCOME_METRICS = [
  'ELAPSED_MS',
  'RESEARCH_PASSES',
  'DIRECT_COST_CENTS',
  'HUMAN_MINUTES',
  'HUMAN_DECISIONS_WAITING',
  'REWORK_COUNT',
  'ERROR_COUNT',
  'ACCEPTED',
  'DEMAND_RESPONSES',
  'PAYMENT_RECEIVED_CENTS',
  'OBLIGATIONS_OPEN_CENTS',
] as const;
export type OutcomeMetric = (typeof OUTCOME_METRICS)[number];

export interface OutcomeMeasure {
  metric: OutcomeMetric;
  /** Null exactly when the class is UNKNOWN. */
  value: number | null;
  unit: 'ms' | 'count' | 'cents' | 'minutes' | 'boolean';
  evidence: EvidenceClass;
  /** Where the figure came from, or — for an unknown — what would measure it. */
  source: string;
}

/**
 * Why an attempt ended as it did, as a class. The words stay beside it on the
 * row; the class is what lets two attempts be recognised as the same failure
 * without reading prose.
 */
export const BLOCKER_CLASSES = [
  /** The plan fell outside the approval envelope and waited for a person. */
  'PLAN_OUTSIDE_ENVELOPE',
  /** The named envelope could not be applied to the packet. */
  'ENVELOPE_UNAVAILABLE',
  /** Parked for a person for any other reason. */
  'WAITING_ON_PERSON',
  /** Launched and never advanced within the stall window. */
  'STALLED',
  /** Refused before launching (a parked candidate). */
  'NOT_LAUNCHED',
  /** Research ran and did not establish what the goal needed. */
  'EVIDENCE_INSUFFICIENT',
  'OTHER',
] as const;
export type BlockerClass = (typeof BLOCKER_CLASSES)[number];

/** Decisions a lesson is allowed to change. Adding one is a reviewed change. */
export const LEARNING_DECISIONS = [
  /** How many deep dives to launch, and whether to probe instead. */
  'CASH_DEEP_DIVE_LAUNCH',
  /** Which never-dived opening goes first. */
  'CASH_DEEP_DIVE_ORDER',
] as const;
export type LearningDecision = (typeof LEARNING_DECISIONS)[number];

/** Facts a live goal depends on, rechecked on the tick. */
export const WATCH_FACTS = [
  /** Whether the research grant a sprint runs under is live. */
  'RESEARCH_GRANT',
  /** How many execution surfaces could run work right now. */
  'HEALTHY_SURFACES',
  /** Whether the lesson currently changing a decision still holds. */
  'ACTIVE_LESSON',
] as const;
export type WatchFact = (typeof WATCH_FACTS)[number];

export const CAPABILITY_ROUTES = ['IMPLEMENT', 'CONNECT_SERVICE', 'PERSON', 'DECLINE'] as const;
export type CapabilityRoute = (typeof CAPABILITY_ROUTES)[number];

/**
 * The floors, stated once.
 *
 * `PATTERN_FLOOR` is independent observations — observations whose subjects
 * did not come out of one source, one packet or one afternoon's worth of the
 * same finding. Two dives launched in the same minute from the same discovery
 * packet about the same market are one observation twice (§14's rule about
 * sources that are really one source, applied to outcomes).
 *
 * `STREAK_FLOOR` is consecutive attempts failing *before any work was done*.
 * Three is small on purpose: an approach that has not touched its subject three
 * times in a row is not being tested, it is being paid for, and the change it
 * licenses is small too — one probe instead of full slots, never a stop.
 *
 * `RECURRENCE_FLOOR` is how often one blocker must stop worthwhile work before
 * Brain proposes changing a capability rather than waiting it out.
 */
export const PATTERN_FLOOR = 2;
export const STREAK_FLOOR = 3;
export const RECURRENCE_FLOOR = 3;

const APPROACH_SET: ReadonlySet<string> = new Set(APPROACHES);
const RESULT_SET: ReadonlySet<string> = new Set(OUTCOME_RESULTS);
const EVIDENCE_SET: ReadonlySet<string> = new Set(EVIDENCE_CLASSES);
const METRIC_SET: ReadonlySet<string> = new Set(OUTCOME_METRICS);
const BLOCKER_SET: ReadonlySet<string> = new Set(BLOCKER_CLASSES);
const ROUTE_SET: ReadonlySet<string> = new Set(CAPABILITY_ROUTES);

export function isApproach(value: string): value is Approach {
  return APPROACH_SET.has(value);
}
export function isOutcomeResult(value: string): value is OutcomeResult {
  return RESULT_SET.has(value);
}
export function isBlockerClass(value: string): value is BlockerClass {
  return BLOCKER_SET.has(value);
}
export function isCapabilityRoute(value: string): value is CapabilityRoute {
  return ROUTE_SET.has(value);
}

/**
 * A measure is refused rather than repaired: an UNKNOWN carrying a value, or a
 * figure carrying no class, is exactly the confusion the table exists to keep
 * out.
 */
export function validateMeasure(measure: OutcomeMeasure): string | null {
  if (!METRIC_SET.has(measure.metric)) return `unknown metric ${measure.metric}`;
  if (!EVIDENCE_SET.has(measure.evidence)) return `unknown evidence class ${measure.evidence}`;
  if (measure.evidence === 'UNKNOWN' && measure.value !== null) {
    return `${measure.metric} is UNKNOWN and still carries a value`;
  }
  if (measure.evidence !== 'UNKNOWN' && measure.value === null) {
    return `${measure.metric} is ${measure.evidence} and carries no value`;
  }
  if (!measure.source.trim()) return `${measure.metric} names no source`;
  return null;
}

/** Declared rather than inferred, so a reader never has to guess. */
export const GOAL_OF: Readonly<Record<Approach, { goal: GoalKind; success: string }>> =
  Object.freeze({
    CASH_DEEP_DIVE: {
      goal: 'RESEARCH',
      success:
        'The deep dive established from published sources who pays for this opening ' +
        '(the piece reached at least the CANDIDATE tier).',
    },
  });
