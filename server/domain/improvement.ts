/**
 * Brain improving itself: the decisions, pure (§87).
 *
 * Owner's order, 2026-11-03: Claude routines devote their capacity to making
 * Brain better at every future job, and research about Brain's methods must
 * become tested engineering, not only prompt guidance (`methodRules.ts` keeps
 * the prompt half). Everything here is a function of rows the caller read, so
 * "why did Brain pick this", "why did it say it worked" and "why did it stop"
 * are answerable from the inputs alone.
 *
 * The responsibility model, which this file names and does not rebuild:
 *
 *   FREE_LANE      commercial research and evidence (`services/freeLane`, §85)
 *   CLAUDE_ROUTINE research and design of improvements to Brain itself — a
 *                  research goal in `brain-architecture`, whose bins
 *                  `binPurpose.ts` already marks BRAIN_IMPROVEMENT (§84)
 *   FACTORY        implementation, tests, merge, deploy and verification of an
 *                  approved change to Brain's own repository (§27, §58)
 *   BRAIN          noticing, choosing, measuring, deciding, continuing
 */

/* ------------------------------------------------------------------------- */
/* The scoreboard's metrics                                                   */
/* ------------------------------------------------------------------------- */

export const METRIC_KEYS = [
  'FREE_LANE_PASS_RATE',
  'FREE_LANE_FRAGMENT_PASS_RATE',
  'ACCEPTED_CLAIM_RATE',
  'RESEARCH_JOB_SUCCESS_RATE',
  'CONSTRUCTED_ROUND_YIELD',
  'READY_OPPORTUNITIES_PER_DAY',
  'OBJECTIVE_HOURS_MEDIAN',
  'OWNER_INTERVENTIONS_PER_DAY',
  'AUTO_RECOVERY_RATE',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type MetricShape = 'RATE' | 'PER_DAY' | 'HOURS';

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  shape: MetricShape;
  /** Whether a larger value is better. */
  higherIsBetter: boolean;
  numerator: string;
  denominator: string;
  /** Below this many units (denominator, events or samples) a reading says INSUFFICIENT_DATA. */
  minSample: number;
}

export const METRICS: Record<MetricKey, MetricDefinition> = {
  FREE_LANE_PASS_RATE: {
    key: 'FREE_LANE_PASS_RATE',
    label: 'Free-lane research pass rate',
    shape: 'RATE',
    higherIsBetter: true,
    numerator: 'FREE_LANE_ITEM events with outcome SUBMITTED (Brain accepted the submission)',
    denominator: 'FREE_LANE_ITEM events SUBMITTED + FAILED_RETRYABLE (provider releases excluded and reported separately)',
    minSample: 30,
  },
  FREE_LANE_FRAGMENT_PASS_RATE: {
    key: 'FREE_LANE_FRAGMENT_PASS_RATE',
    label: 'Free-lane fragment pass rate',
    shape: 'RATE',
    higherIsBetter: true,
    numerator: 'RESEARCH_FRAGMENT free-lane items SUBMITTED',
    denominator: 'RESEARCH_FRAGMENT free-lane items SUBMITTED + FAILED_RETRYABLE',
    minSample: 30,
  },
  ACCEPTED_CLAIM_RATE: {
    key: 'ACCEPTED_CLAIM_RATE',
    label: 'Accepted research claims',
    shape: 'RATE',
    higherIsBetter: true,
    numerator: 'research_claims created in the window with accepted = 1',
    denominator: 'research_claims created in the window',
    minSample: 30,
  },
  RESEARCH_JOB_SUCCESS_RATE: {
    key: 'RESEARCH_JOB_SUCCESS_RATE',
    label: 'Research jobs completed successfully',
    shape: 'RATE',
    higherIsBetter: true,
    numerator: 'packets that settled COMPLETE or COMPLETE_WITH_GAPS in the window',
    denominator: 'packets that settled in the window (COMPLETE, COMPLETE_WITH_GAPS, FAILED, NEEDS_HUMAN); CANCELLED is reported beside it, not counted as a failure',
    minSample: 8,
  },
  CONSTRUCTED_ROUND_YIELD: {
    key: 'CONSTRUCTED_ROUND_YIELD',
    label: 'Openings produced from construction',
    shape: 'RATE',
    higherIsBetter: true,
    numerator: 'constructed rounds (bucket …-mx-…) settled in the window that found at least one opening',
    denominator: 'constructed rounds settled (HARVESTED or ABANDONED) in the window',
    minSample: 8,
  },
  READY_OPPORTUNITIES_PER_DAY: {
    key: 'READY_OPPORTUNITIES_PER_DAY',
    label: 'Strong actionable opportunities per day',
    shape: 'PER_DAY',
    higherIsBetter: true,
    numerator: 'CASH_OPPORTUNITY_READY cash events in the window',
    denominator: 'days in the window',
    minSample: 5,
  },
  OBJECTIVE_HOURS_MEDIAN: {
    key: 'OBJECTIVE_HOURS_MEDIAN',
    label: 'Hours from starting an objective to its delivered result',
    shape: 'HOURS',
    higherIsBetter: false,
    numerator: 'median of completed_at − created_at over packets completed in the window',
    denominator: 'packets completed in the window',
    minSample: 8,
  },
  OWNER_INTERVENTIONS_PER_DAY: {
    key: 'OWNER_INTERVENTIONS_PER_DAY',
    label: 'Failures that required owner intervention, per day',
    shape: 'PER_DAY',
    higherIsBetter: false,
    numerator: 'Needs-You requests opened plus packets that settled NEEDS_HUMAN in the window',
    denominator: 'days in the window',
    minSample: 5,
  },
  AUTO_RECOVERY_RATE: {
    key: 'AUTO_RECOVERY_RATE',
    label: 'Failures recovered automatically',
    shape: 'RATE',
    higherIsBetter: true,
    numerator: 'work items that failed at least once and then completed, settled in the window',
    denominator: 'work items that failed at least once and settled (completed, failed or dead-lettered) in the window',
    minSample: 20,
  },
};

/** One metric over one window, counted from rows. */
export interface MetricReading {
  key: MetricKey;
  from: string;
  to: string;
  /** The value: a fraction for RATE, events per day for PER_DAY, hours for HOURS. Null when nothing was counted. */
  value: number | null;
  numerator: number;
  denominator: number;
  /** INSUFFICIENT_DATA below the metric's minimum sample; never a guess. */
  status: 'MEASURED' | 'INSUFFICIENT_DATA';
  /** Conditions outside Brain's control that moved in the window, e.g. provider error share. */
  context?: Record<string, number>;
}

export function reading(
  key: MetricKey,
  from: string,
  to: string,
  numerator: number,
  denominator: number,
  value?: number | null,
  context?: Record<string, number>,
): MetricReading {
  const def = METRICS[key];
  const days = Math.max(1 / 24, (Date.parse(to) - Date.parse(from)) / 86_400_000);
  let computed: number | null;
  if (value !== undefined) computed = value;
  else if (def.shape === 'RATE') computed = denominator > 0 ? numerator / denominator : null;
  else if (def.shape === 'PER_DAY') computed = numerator / days;
  else computed = null;
  const sample = def.shape === 'PER_DAY' ? numerator : denominator;
  return {
    key,
    from,
    to,
    value: computed === null ? null : Number(computed.toFixed(4)),
    numerator,
    denominator: def.shape === 'PER_DAY' ? Number(days.toFixed(3)) : denominator,
    status: computed !== null && sample >= def.minSample ? 'MEASURED' : 'INSUFFICIENT_DATA',
    ...(context ? { context } : {}),
  };
}

/* ------------------------------------------------------------------------- */
/* Before and after                                                           */
/* ------------------------------------------------------------------------- */

export type Verdict = 'IMPROVED' | 'REGRESSED' | 'NO_CHANGE' | 'INSUFFICIENT_DATA';

export interface Comparison {
  metric: MetricKey;
  verdict: Verdict;
  baseline: number | null;
  after: number | null;
  /** The test statistic used, or why none could be computed. */
  basis: string;
}

/** How far provider conditions may move between windows before a comparison is withheld. */
export const PROVIDER_SHIFT_LIMIT = 0.2;
/** How far the workload may move (ratio of denominators) before a comparison is withheld. */
export const WORKLOAD_SHIFT_LIMIT = 4;

/**
 * Compare a reading after a change with the baseline before it.
 *
 * A rate is judged by a two-proportion z-test at |z| ≥ 1.96; a per-day count by
 * the Poisson rate test on the two counts; median hours by a ±25% band with the
 * minimum sample on both sides. Anything under a metric's minimum sample, a
 * workload that moved more than fourfold, or a provider error share that moved
 * more than twenty points is INSUFFICIENT_DATA: the difference might be the
 * world's, not the change's, and Brain says so instead of claiming it.
 */
export function compare(before: MetricReading, after: MetricReading): Comparison {
  const def = METRICS[before.key];
  const base = { metric: before.key, baseline: before.value, after: after.value };
  if (before.status !== 'MEASURED' || after.status !== 'MEASURED' || before.value === null || after.value === null) {
    return { ...base, verdict: 'INSUFFICIENT_DATA', basis: 'below the minimum sample on one side' };
  }
  const providerBefore = before.context?.['providerErrorShare'];
  const providerAfter = after.context?.['providerErrorShare'];
  if (providerBefore !== undefined && providerAfter !== undefined && Math.abs(providerAfter - providerBefore) > PROVIDER_SHIFT_LIMIT) {
    return {
      ...base,
      verdict: 'INSUFFICIENT_DATA',
      basis: `provider error share moved ${providerBefore.toFixed(2)} → ${providerAfter.toFixed(2)}; the difference may be the provider's`,
    };
  }
  if (def.shape === 'RATE') {
    const ratio = Math.max(before.denominator, after.denominator) / Math.max(1, Math.min(before.denominator, after.denominator));
    if (ratio > WORKLOAD_SHIFT_LIMIT) {
      return { ...base, verdict: 'INSUFFICIENT_DATA', basis: `workload moved ${ratio.toFixed(1)}×; not comparable` };
    }
    const p1 = before.numerator / before.denominator;
    const p2 = after.numerator / after.denominator;
    const pooled = (before.numerator + after.numerator) / (before.denominator + after.denominator);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / before.denominator + 1 / after.denominator));
    const z = se > 0 ? (p2 - p1) / se : 0;
    return { ...base, verdict: judge(z, def.higherIsBetter), basis: `two-proportion z = ${z.toFixed(2)}` };
  }
  if (def.shape === 'PER_DAY') {
    const days1 = before.denominator;
    const days2 = after.denominator;
    const n1 = before.numerator;
    const n2 = after.numerator;
    // Conditional binomial test of two Poisson counts, normal approximation.
    const share = days2 / (days1 + days2);
    const total = n1 + n2;
    const se = Math.sqrt(total * share * (1 - share));
    const z = se > 0 ? (n2 - total * share) / se : 0;
    return { ...base, verdict: judge(z, def.higherIsBetter), basis: `Poisson rate z = ${z.toFixed(2)}` };
  }
  const change = (after.value - before.value) / Math.max(before.value, 1e-9);
  const z = Math.abs(change) >= 0.25 ? Math.sign(change) * 2 : 0;
  return { ...base, verdict: judge(z, def.higherIsBetter), basis: `median moved ${(change * 100).toFixed(0)}% (±25% band)` };
}

function judge(z: number, higherIsBetter: boolean): Verdict {
  if (Math.abs(z) < 1.96) return 'NO_CHANGE';
  return (z > 0) === higherIsBetter ? 'IMPROVED' : 'REGRESSED';
}

/* ------------------------------------------------------------------------- */
/* Weaknesses                                                                 */
/* ------------------------------------------------------------------------- */

/** How a free-lane failure reads, from the reason the lane recorded on its event. */
export const FREE_LANE_FAILURE_CLASSES = [
  'NO_READABLE_SOURCE',
  'CITATION_DROPPED',
  'SUBMISSION_REFUSED',
  'PROVIDER_EXHAUSTED',
  'NO_USABLE_ANSWER',
  'OTHER',
] as const;
export type FreeLaneFailureClass = (typeof FREE_LANE_FAILURE_CLASSES)[number];

export function classifyFreeLaneFailure(reason: string | null): FreeLaneFailureClass {
  const text = reason ?? '';
  if (/no readable source/i.test(text)) return 'NO_READABLE_SOURCE';
  if (/did not survive Brain's own checks|cited sentences not found|no citation and no verbatim quote|unquoted, uncited/i.test(text)) {
    return 'CITATION_DROPPED';
  }
  if (/\brefused\b/i.test(text)) return 'SUBMISSION_REFUSED';
  if (/model call failed|cheap lane HTTP|timed? ?out/i.test(text)) return 'PROVIDER_EXHAUSTED';
  if (/no usable JSON|no JSON|returned no/i.test(text)) return 'NO_USABLE_ANSWER';
  return 'OTHER';
}

/** How a research claim's rejection reads, from `research_claims.rejection_reason`. */
export function classifyClaimRejection(reason: string | null): string {
  const text = reason ?? '';
  if (!text.trim()) return 'NO_REASON_RECORDED';
  if (/scope does not match/i.test(text)) return 'SCOPE_MISMATCH';
  if (/assumption|no stated inputs/i.test(text)) return 'UNSTATED_INFERENCE';
  if (/not (found|present) in|does not (appear|contain)|quote|excerpt/i.test(text)) return 'QUOTE_NOT_IN_SOURCE';
  if (/source|unsourced|no url/i.test(text)) return 'SOURCE_PROBLEM';
  if (/absence|does not show that no/i.test(text)) return 'ABSENCE_UNPROVEN';
  return 'OTHER';
}

export type WeaknessScope = 'GENERAL' | 'LANE' | 'LOCAL';
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * A weakness, as a detector observed it. Keyed by what is weak, never by one
 * job, so the same failure across a thousand jobs is one candidate.
 */
export interface Weakness {
  key: string;
  kind: string;
  title: string;
  problem: string;
  metric: MetricKey;
  downstreamMetric: MetricKey | null;
  ownerComponent: string;
  /** Files a fix may touch; the Factory objective's mutation scope. */
  mutationScope: string[];
  frequency: number;
  denominator: number;
  scope: WeaknessScope;
  severity: Severity;
  /** Words a relevant method claim would share (rule 13: the archive first). */
  researchQuestion: string;
  /** Sample reasons, verbatim from rows, never a payload or a credential. */
  samples: string[];
  /** The diagnosis Brain can already state from the rows, when it can. */
  knownCause: string | null;
}

/** A weakness becomes a candidate at this many occurrences and this share of the work it touches. */
export const WEAKNESS_MIN_COUNT = 15;
export const WEAKNESS_MIN_SHARE = 0.1;
/** The recent window a weakness must still show in, and the work it must hold to judge that. */
export const RECENT_WINDOW_HOURS = 6;
export const RECENT_MIN_ATTEMPTS = 10;
/** The verdict compares with the period right before delivery, so an earlier fix is not credited to this one. */
export const BEFORE_WINDOW_HOURS = 12;

export interface FailureCount {
  cls: string;
  n: number;
  samples: string[];
}

/** What each free-lane failure class means, who owns its fix, and what it unblocks. */
const FREE_LANE_TEMPLATES: Record<FreeLaneFailureClass, {
  title: string;
  problem: string;
  owner: string;
  scope: string[];
  question: string;
  cause: string | null;
}> = {
  NO_READABLE_SOURCE: {
    title: 'Free-lane fragments end with no readable source',
    problem:
      'The free lane names candidate pages Brain cannot open (DNS failure, connect timeout, 404, empty), ' +
      'so the fragment fails before any claim is extracted and its attempt is spent.',
    owner: 'server/services/freeLane/worker.ts',
    scope: ['server/services/freeLane/**', 'tests/freeLane*.test.ts'],
    question: 'How do research agents find readable primary sources when candidate pages are unreachable or dead links?',
    cause: 'Candidate URLs come from the model\'s recall plus two Wikipedia titles; nothing remembers which hosts Brain cannot reach.',
  },
  CITATION_DROPPED: {
    title: 'Free-lane claims are dropped by Brain\'s own citation checks',
    problem:
      'The model offers claims whose cited sentence numbers or quotes are not in the page Brain fetched, ' +
      'so every claim is dropped before submission.',
    owner: 'server/services/freeLane/worker.ts',
    scope: ['server/services/freeLane/**', 'tests/freeLane*.test.ts'],
    question: 'How should an extraction step make a language model cite exact sentences from a provided document reliably?',
    cause: 'Sentence numbering or the citation parser disagrees with how models cite.',
  },
  SUBMISSION_REFUSED: {
    title: 'Free-lane submissions are refused by Brain\'s tools',
    problem: 'Submissions reach the gate or a tool and are refused twice (schema, lane id, lease or gate), spending the attempt.',
    owner: 'server/services/freeLane/worker.ts',
    scope: ['server/services/freeLane/**', 'tests/freeLane*.test.ts'],
    question: 'How do agent frameworks repair tool-call validation errors so a second attempt succeeds?',
    cause: null,
  },
  PROVIDER_EXHAUSTED: {
    title: 'Free-lane items fail after repeated provider errors',
    problem: 'A free model\'s provider answered 429/503 three times for one item, so the item failed although the work was never attempted.',
    owner: 'server/services/freeLane/worker.ts',
    scope: ['server/services/freeLane/**', 'tests/freeLane*.test.ts'],
    question: 'How should a worker pool back off and reroute when free model providers rate-limit?',
    cause: 'Provider failures count toward a third strike that spends the item\'s attempt budget.',
  },
  NO_USABLE_ANSWER: {
    title: 'Free models return no usable answer',
    problem: 'The model\'s reply has no parseable JSON for the step, so nothing is submitted.',
    owner: 'server/services/freeLane/worker.ts',
    scope: ['server/services/freeLane/**', 'tests/freeLane*.test.ts'],
    question: 'How do structured-output prompts and parsers recover usable JSON from small models?',
    cause: null,
  },
  OTHER: {
    title: 'Free-lane items fail for an unclassified reason',
    problem: 'Free-lane items fail with reasons no class above covers.',
    owner: 'server/services/freeLane/worker.ts',
    scope: ['server/services/freeLane/**', 'tests/freeLane*.test.ts'],
    question: 'How should an automated research worker classify and recover from its own failures?',
    cause: null,
  },
};

/**
 * Weaknesses from the free lane's own failures (24 h). A class becomes a
 * candidate when it is both frequent and a real share of the work, so a
 * handful of odd failures never generates engineering.
 */
export function freeLaneWeaknesses(
  failures: FailureCount[],
  attempts: number,
  /** The same counts over the recent window: a class that stopped happening is not engineered again. */
  recent?: { failures: FailureCount[]; attempts: number },
): Weakness[] {
  const out: Weakness[] = [];
  for (const failure of failures) {
    const cls = failure.cls as FreeLaneFailureClass;
    const template = FREE_LANE_TEMPLATES[cls];
    if (!template || cls === 'OTHER') continue;
    if (failure.n < WEAKNESS_MIN_COUNT || attempts <= 0 || failure.n / attempts < WEAKNESS_MIN_SHARE) continue;
    if (recent) {
      // Production, 2026-11-03: 246 citation drops in a day, most of them before
      // the fix that shipped at 17:20Z. A weakness must still be happening now.
      const now = recent.failures.find((f) => f.cls === failure.cls)?.n ?? 0;
      if (recent.attempts < RECENT_MIN_ATTEMPTS || now / recent.attempts < WEAKNESS_MIN_SHARE) continue;
    }
    out.push({
      key: `FREE_LANE:${cls}`,
      kind: 'FREE_LANE_FAILURE',
      title: template.title,
      problem: template.problem,
      metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
      downstreamMetric: 'ACCEPTED_CLAIM_RATE',
      ownerComponent: template.owner,
      mutationScope: template.scope,
      frequency: failure.n,
      denominator: attempts,
      scope: 'GENERAL',
      severity: failure.n / attempts >= 0.25 ? 'HIGH' : 'MEDIUM',
      researchQuestion: template.question,
      samples: failure.samples.slice(0, 5),
      knownCause: template.cause,
    });
  }
  return out;
}

/** Weaknesses from claims Brain's gate rejected (7 days, every worker). */
export function claimRejectionWeaknesses(rejections: FailureCount[], claims: number): Weakness[] {
  const out: Weakness[] = [];
  for (const rejection of rejections) {
    if (rejection.cls === 'OTHER' || rejection.cls === 'NO_REASON_RECORDED') continue;
    if (rejection.n < WEAKNESS_MIN_COUNT * 2 || claims <= 0 || rejection.n / claims < WEAKNESS_MIN_SHARE) continue;
    out.push({
      key: `CLAIMS:${rejection.cls}`,
      kind: 'CLAIM_REJECTION',
      title: `Research claims rejected for ${rejection.cls.toLowerCase().replace(/_/g, ' ')}`,
      problem:
        `${rejection.n} of ${claims} claims submitted in seven days were rejected as ${rejection.cls}; ` +
        'a worker brief or extraction step that prevented this class would raise accepted research across every packet.',
      metric: 'ACCEPTED_CLAIM_RATE',
      downstreamMetric: 'RESEARCH_JOB_SUCCESS_RATE',
      ownerComponent: 'server/services/research/prompts.ts',
      mutationScope: ['server/services/research/prompts.ts', 'server/services/freeLane/worker.ts', 'tests/researchPrompts*.test.ts', 'tests/freeLane*.test.ts'],
      frequency: rejection.n,
      denominator: claims,
      scope: 'GENERAL',
      severity: rejection.n / claims >= 0.25 ? 'HIGH' : 'MEDIUM',
      researchQuestion: `How can research workers avoid claims rejected for ${rejection.cls.toLowerCase().replace(/_/g, ' ')}?`,
      samples: rejection.samples.slice(0, 5),
      knownCause: null,
    });
  }
  return out;
}

/** Weaknesses from packets that ended needing a person (7 days). */
export function packetWeaknesses(causes: FailureCount[], settled: number): Weakness[] {
  const out: Weakness[] = [];
  for (const cause of causes) {
    if (cause.n < 5 || settled <= 0 || cause.n / settled < WEAKNESS_MIN_SHARE) continue;
    out.push({
      key: `PACKETS:${cause.cls}`,
      kind: 'PACKET_STALL',
      title: `Research packets end ${cause.cls.toLowerCase().replace(/_/g, ' ')}`,
      problem: `${cause.n} of ${settled} packets settled in seven days ended ${cause.cls}, which needs a person or wastes the packet.`,
      metric: 'RESEARCH_JOB_SUCCESS_RATE',
      downstreamMetric: 'OWNER_INTERVENTIONS_PER_DAY',
      ownerComponent: 'server/services/research/orchestrator.ts',
      mutationScope: ['server/services/research/**', 'tests/research*.test.ts'],
      frequency: cause.n,
      denominator: settled,
      scope: 'GENERAL',
      severity: 'MEDIUM',
      researchQuestion: 'How do research pipelines recover blocked sub-questions without a person?',
      samples: cause.samples.slice(0, 5),
      knownCause: null,
    });
  }
  return out;
}

/**
 * Weaknesses from what reached the owner (7 days): a kind of Needs-You request
 * raised often is work Brain could not finish by itself, which rule 11 says it
 * should. The cause is not in the rows, so this goes to method research first.
 */
export function ownerInterventionWeaknesses(causes: FailureCount[], total: number): Weakness[] {
  const out: Weakness[] = [];
  for (const cause of causes) {
    if (cause.n < WEAKNESS_MIN_COUNT || total <= 0 || cause.n / total < WEAKNESS_MIN_SHARE) continue;
    out.push({
      key: `OWNER:${cause.cls}`,
      kind: 'OWNER_INTERVENTION',
      title: `Brain asks the owner for ${cause.cls.toLowerCase().replace(/_/g, ' ')}`,
      problem:
        `${cause.n} of ${total} Needs-You requests in seven days asked for ${cause.cls.toLowerCase().replace(/_/g, ' ')}; ` +
        'each one stops work until a person answers, and rule 11 says Brain decides what it can.',
      metric: 'OWNER_INTERVENTIONS_PER_DAY',
      downstreamMetric: 'RESEARCH_JOB_SUCCESS_RATE',
      ownerComponent: 'server/services/russell/',
      mutationScope: ['server/services/russell/**', 'server/services/research/**', 'tests/russell*.test.ts', 'tests/research*.test.ts'],
      frequency: cause.n,
      denominator: total,
      scope: 'GENERAL',
      severity: cause.n / total >= 0.25 ? 'HIGH' : 'MEDIUM',
      researchQuestion: `How do autonomous agent systems resolve "${cause.cls.toLowerCase().replace(/_/g, ' ')}" decisions without escalating to a person, and when must they escalate?`,
      samples: cause.samples.slice(0, 5),
      knownCause: null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Ranking                                                                    */
/* ------------------------------------------------------------------------- */

export interface RankInput {
  id: string;
  scope: WeaknessScope;
  severity: Severity;
  frequency: number;
  denominator: number;
  /** Whether fixing this unlocks a downstream stage (a pass rate feeding packets). */
  unlocks: boolean;
  /** Whether a similar correction already shipped (a KEPT candidate on the same key family). */
  similarShipped: boolean;
  createdAt: string;
}

/**
 * Order candidates by expected general impact.
 *
 * Ordinal on purpose: how many jobs a weakness touches (scope), how often
 * (frequency, on a log scale so one huge count cannot hide every other), how
 * bad (severity), and whether it unlocks the next stage. A similar correction
 * already shipped halves the expectation. No probability is invented; the
 * reasons are returned beside the order so a reader sees why.
 */
export function rankCandidates<T extends RankInput>(candidates: T[]): Array<T & { rank: number; why: string }> {
  const scopeWeight: Record<WeaknessScope, number> = { GENERAL: 3, LANE: 2, LOCAL: 1 };
  const severityWeight: Record<Severity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const scored = candidates.map((c) => {
    const share = c.denominator > 0 ? c.frequency / c.denominator : 0;
    let score = scopeWeight[c.scope] * severityWeight[c.severity] * Math.log2(2 + c.frequency) * (0.5 + share);
    if (c.unlocks) score *= 1.5;
    if (c.similarShipped) score *= 0.5;
    const why =
      `${c.scope.toLowerCase()} scope, ${c.severity.toLowerCase()} severity, ${c.frequency} occurrence(s)` +
      (c.denominator > 0 ? ` (${Math.round(share * 100)}% of ${c.denominator})` : '') +
      (c.unlocks ? ', unlocks the next stage' : '') +
      (c.similarShipped ? ', a similar fix already shipped' : '');
    return { c, score, why };
  });
  scored.sort((a, b) => b.score - a.score || a.c.createdAt.localeCompare(b.c.createdAt) || a.c.id.localeCompare(b.c.id));
  return scored.map((s, index) => ({ ...s.c, rank: index + 1, why: s.why }));
}

/* ------------------------------------------------------------------------- */
/* The stage, derived                                                         */
/* ------------------------------------------------------------------------- */

export const STAGES = [
  'DIAGNOSE',
  'RESEARCHING',
  'ENGINEER',
  'ENGINEERING',
  'MEASURING',
  'DECIDE',
  'CLOSED',
] as const;
export type Stage = (typeof STAGES)[number];

/** Who does the next step (the responsibility model). */
export type Owner = 'CLAUDE_ROUTINE' | 'FACTORY' | 'BRAIN' | 'FREE_LANE';

export interface StageInput {
  decision: string | null;
  researchGoalId: string | null;
  /** The research goal's packets: null when no goal; otherwise whether one settled and how. */
  research: { settled: boolean; acceptedClaims: number; status: string | null } | null;
  /** Relevant accepted method claims already in the archive (rule 13). */
  archiveClaims: number;
  knownCause: string | null;
  changeRequestId: string | null;
  /** The Factory outcome state, from `objectiveOutcome`. */
  factory: { state: string; detail: string } | null;
  deliveredAt: string | null;
  /** Whether the measurement window after delivery has closed. */
  windowClosed: boolean;
}

/** Relevant archive claims at which Brain skips new research and engineers from what it holds. */
export const ARCHIVE_ENOUGH = 3;

export function deriveStage(input: StageInput): { stage: Stage; owner: Owner; next: string } {
  if (input.decision) return { stage: 'CLOSED', owner: 'BRAIN', next: `decided ${input.decision}` };
  if (input.deliveredAt) {
    return input.windowClosed
      ? { stage: 'DECIDE', owner: 'BRAIN', next: 'compare the reading after delivery with the baseline' }
      : { stage: 'MEASURING', owner: 'BRAIN', next: 'wait for the measurement window to close' };
  }
  if (input.changeRequestId) {
    return { stage: 'ENGINEERING', owner: 'FACTORY', next: input.factory ? `${input.factory.state}: ${input.factory.detail}` : 'campaign starting' };
  }
  if (input.researchGoalId && input.research && !input.research.settled) {
    return { stage: 'RESEARCHING', owner: 'CLAUDE_ROUTINE', next: 'the method research packet is running' };
  }
  if (input.researchGoalId || input.archiveClaims >= ARCHIVE_ENOUGH || input.knownCause) {
    return { stage: 'ENGINEER', owner: 'FACTORY', next: 'submit the engineering objective' };
  }
  return { stage: 'DIAGNOSE', owner: 'CLAUDE_ROUTINE', next: 'open method research in brain-architecture' };
}

/* ------------------------------------------------------------------------- */
/* Dependencies of a material change                                          */
/* ------------------------------------------------------------------------- */

/**
 * The questions a material workflow change answers before it goes live (§87).
 *
 * §85 is the case it exists for: Claude routines were restricted to Brain work
 * before the free lane could do the research taken from them, and nothing
 * asked. A change that cannot answer every question here does not ship.
 */
export interface DependencyCheck {
  /** What currently depends on the capability being changed. */
  dependents: string[];
  /** Work this change displaces from where it runs now, or none. */
  displacedWork: string;
  /** Who owns the displaced work afterward. */
  newOwner: string;
  /** Measured evidence the new owner can do it (a reading, not a hope). */
  replacementEvidence: string;
  /** Who consumes the output downstream, and the gate it must pass. */
  downstreamAcceptance: string;
  /** The next stage that may become the bottleneck, and the metric watched for it. */
  newBottleneck: string;
  /** The production reading that confirms the overall objective still advances. */
  productionConfirmation: string;
}

export const DEPENDENCY_QUESTIONS: Record<keyof DependencyCheck, string> = {
  dependents: 'What currently depends on this capability?',
  displacedWork: 'What work will be displaced?',
  newOwner: 'Who will own that work afterward?',
  replacementEvidence: 'Can the replacement actually perform it (measured)?',
  downstreamAcceptance: 'Will the output be accepted downstream, and by which gate?',
  newBottleneck: 'What new bottleneck could the change expose?',
  productionConfirmation: 'How will production confirm the overall objective still advances?',
};

export function checkDependencies(check: Partial<DependencyCheck>): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const key of Object.keys(DEPENDENCY_QUESTIONS) as (keyof DependencyCheck)[]) {
    const value = check[key];
    const empty = Array.isArray(value) ? value.length === 0 : typeof value !== 'string' || value.trim().length < 3;
    if (empty) missing.push(DEPENDENCY_QUESTIONS[key]);
  }
  return { complete: missing.length === 0, missing };
}

/** The dependency check for an improvement, from what the weakness already names. */
export function dependencyCheckFor(weakness: Pick<Weakness, 'ownerComponent' | 'metric' | 'downstreamMetric' | 'kind'>, displaced: Record<string, number>): DependencyCheck {
  const queued = Object.entries(displaced).map(([type, n]) => `${type}:${n}`).join(', ') || 'none queued';
  return {
    dependents: [
      `${weakness.ownerComponent} (its callers and every job routed through it)`,
      weakness.kind === 'FREE_LANE_FAILURE' ? 'every PLAY_RESEARCH and GRUNT packet (§85)' : 'every research packet',
    ],
    displacedWork: 'None: the change improves the owner in place and moves no work between lanes.',
    newOwner: `Unchanged: ${weakness.ownerComponent} keeps the work (queued now: ${queued}).`,
    replacementEvidence: 'Not applicable: no lane changes; the measured pass rate before and after is the evidence.',
    downstreamAcceptance:
      'The evidence gate, verification and audit (§12, §85) judge every submission exactly as before; no bar is lowered.',
    newBottleneck: weakness.downstreamMetric
      ? `${METRICS[weakness.downstreamMetric].label} — more submissions may expose the next stage.`
      : 'None identified beyond the metric itself.',
    productionConfirmation:
      `${METRICS[weakness.metric].label} after delivery against the recorded baseline` +
      (weakness.downstreamMetric ? `, and ${METRICS[weakness.downstreamMetric].label} must not regress.` : '.'),
  };
}

/* ------------------------------------------------------------------------- */
/* The decision after measurement                                             */
/* ------------------------------------------------------------------------- */

/** Hours after delivery before the after-reading is taken, and the longest it waits for data. */
export const MEASURE_WINDOW_HOURS = 12;
export const MEASURE_MAX_HOURS = 7 * 24;
/** A failed change is reverted once; a weakness is engineered at most this many times. */
export const MAX_ATTEMPTS = 3;

export type Decision = 'KEPT' | 'KEPT_NO_EFFECT' | 'REVERTED' | 'REJECTED' | 'COMBINED' | 'HELD';

export function decideAfterMeasurement(input: {
  primary: Comparison;
  downstream: Comparison | null;
  hoursSinceDelivery: number;
}): { decision: Decision | null; reason: string; revert: boolean } {
  const { primary, downstream } = input;
  if (downstream && downstream.verdict === 'REGRESSED') {
    return {
      decision: 'REVERTED',
      reason: `${METRICS[downstream.metric].label} regressed (${downstream.basis}); a local gain must not break the larger workflow.`,
      revert: true,
    };
  }
  if (primary.verdict === 'REGRESSED') {
    return { decision: 'REVERTED', reason: `${METRICS[primary.metric].label} regressed (${primary.basis}).`, revert: true };
  }
  if (primary.verdict === 'IMPROVED') {
    return { decision: 'KEPT', reason: `${METRICS[primary.metric].label} improved (${primary.basis}).`, revert: false };
  }
  if (primary.verdict === 'NO_CHANGE') {
    return {
      decision: 'KEPT_NO_EFFECT',
      reason: `No measurable change in ${METRICS[primary.metric].label} (${primary.basis}); kept as harmless, and the weakness stays eligible for a different strategy.`,
      revert: false,
    };
  }
  if (input.hoursSinceDelivery >= MEASURE_MAX_HOURS) {
    return {
      decision: 'HELD',
      reason: `INSUFFICIENT DATA after ${Math.round(input.hoursSinceDelivery)} h (${primary.basis}); held until the workload returns.`,
      revert: false,
    };
  }
  return { decision: null, reason: `INSUFFICIENT DATA so far (${primary.basis}); still measuring.`, revert: false };
}

/* ------------------------------------------------------------------------- */
/* Quiet monitoring                                                           */
/* ------------------------------------------------------------------------- */

export const IDLE_ALERT_HOURS = 24;
export const STALL_ALERT_HOURS = 48;

export interface AlertInput {
  now: string;
  /** Last time a BRAIN_IMPROVEMENT bin was leased or completed, or null if never. */
  lastImprovementWorkAt: string | null;
  /** Open candidates whose next step is a worker's (research or engineering). */
  actionableCandidates: number;
  /** Last improvement event that moved a candidate (a stage change or a decision). */
  lastProgressAt: string | null;
  openCandidates: number;
}

export interface Alert {
  condition: 'IDLE_24H' | 'STALLED_48H';
  /** Stable for one episode, so the same condition is raised once. */
  episode: string;
  message: string;
}

/**
 * The two alerts the owner asked for, and nothing else. Normal operation,
 * research starting, a PR, a recovered failure — none of those is an alert.
 */
export function alertsDue(input: AlertInput): Alert[] {
  const now = Date.parse(input.now);
  const out: Alert[] = [];
  const idleSince = input.lastImprovementWorkAt ? Date.parse(input.lastImprovementWorkAt) : null;
  if (input.actionableCandidates > 0 && idleSince !== null && now - idleSince >= IDLE_ALERT_HOURS * 3_600_000) {
    out.push({
      condition: 'IDLE_24H',
      episode: input.lastImprovementWorkAt!,
      message:
        `No Claude routine has taken Brain-improvement work for ${Math.round((now - idleSince) / 3_600_000)} h ` +
        `while ${input.actionableCandidates} improvement(s) are ready for one.`,
    });
  }
  const stalledSince = input.lastProgressAt ? Date.parse(input.lastProgressAt) : null;
  if (input.openCandidates > 0 && stalledSince !== null && now - stalledSince >= STALL_ALERT_HOURS * 3_600_000) {
    out.push({
      condition: 'STALLED_48H',
      episode: input.lastProgressAt!,
      message:
        `No improvement has moved for ${Math.round((now - stalledSince) / 3_600_000)} h ` +
        `with ${input.openCandidates} open; the improvement process is stuck.`,
    });
  }
  return out;
}
