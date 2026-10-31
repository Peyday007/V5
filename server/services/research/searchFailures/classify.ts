/**
 * Why a search method keeps coming back empty, and what to do about it.
 *
 * "Source unavailable", "searched and nothing suitable exists" and "too many
 * false positives" are different facts with different remedies, and a method
 * that fails repeatedly must not simply be rerun. This module is pure: it reads
 * a method's recorded runs and says which cause explains the recent failures,
 * and whether the method should run, wait until a time, or be revised.
 *
 * It decides about a METHOD only. A subject is never retired by a method
 * failing: `subjectStatus` is always open, and says whether it still has a
 * method that may run or needs a new one.
 */
import type { RunOutcome, SearchMethodRun } from '../../../domain/searchIntelligence.ts';

export const FAILURE_CAUSES = [
  'SOURCE_UNAVAILABLE',
  'NO_SUITABLE_RESULTS',
  'HIGH_FALSE_POSITIVES',
  'STALE',
  'ERROR',
] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number];

/** Consecutive failed runs before the method is treated as failing rather than unlucky. */
export const FAILURE_STREAK = 3;
/** First wait after the streak is reached; doubles per further failure, capped. */
export const BASE_RETRY_MS = 6 * 60 * 60_000;
export const MAX_RETRY_MS = 14 * 24 * 60 * 60_000;
/** A method that has not found anything for this long, and finds nothing now, is stale. */
export const STALE_MS = 60 * 24 * 60 * 60_000;

/** A FOUND run is not a failure; every other outcome is. */
const FAILED: ReadonlySet<RunOutcome> = new Set(['NOTHING_SUITABLE', 'SOURCE_UNAVAILABLE', 'FALSE_POSITIVES', 'ERROR']);

export interface MethodDecision {
  action: 'RUN' | 'PAUSE' | 'REVISE';
  /** Null while the method is not failing. */
  cause: FailureCause | null;
  /** When a paused method may be tried once more; null unless PAUSE. */
  retryAt: string | null;
  failedInARow: number;
  reason: string;
}

function newestFirst(runs: readonly SearchMethodRun[]): SearchMethodRun[] {
  return [...runs].sort((a, b) =>
    a.finishedAt === b.finishedAt ? (a.id < b.id ? 1 : -1) : a.finishedAt < b.finishedAt ? 1 : -1,
  );
}

/** The unbroken run of failures at the newest end. */
export function recentFailures(runs: readonly SearchMethodRun[]): SearchMethodRun[] {
  const out: SearchMethodRun[] = [];
  for (const run of newestFirst(runs)) {
    if (!FAILED.has(run.outcome)) break;
    out.push(run);
  }
  return out;
}

/**
 * The cause that explains a failing streak, or null when it is not a streak yet.
 * One cause must account for the whole streak; a mixed streak is ERROR, because
 * Brain cannot say which fact it is and must not guess one.
 */
export function classifyFailure(runs: readonly SearchMethodRun[], now: string): FailureCause | null {
  const streak = recentFailures(runs);
  if (streak.length < FAILURE_STREAK) return null;
  const outcomes = new Set(streak.map((run) => run.outcome));
  if (outcomes.size !== 1) return 'ERROR';
  const only = streak[0]!.outcome;
  if (only === 'SOURCE_UNAVAILABLE') return 'SOURCE_UNAVAILABLE';
  if (only === 'FALSE_POSITIVES') return 'HIGH_FALSE_POSITIVES';
  if (only === 'ERROR') return 'ERROR';
  const lastFound = newestFirst(runs).find((run) => run.outcome === 'FOUND');
  const quietSince = lastFound ? Date.parse(lastFound.finishedAt) : null;
  if (quietSince !== null && Date.parse(now) - quietSince > STALE_MS) return 'STALE';
  return 'NO_SUITABLE_RESULTS';
}

/** Causes where waiting can help, because the world or the source may change. */
const WAIT: ReadonlySet<FailureCause> = new Set(['SOURCE_UNAVAILABLE', 'NO_SUITABLE_RESULTS', 'ERROR']);

const REMEDY: Record<FailureCause, string> = {
  SOURCE_UNAVAILABLE: 'the source could not be read, which says nothing about whether anything is there',
  NO_SUITABLE_RESULTS: 'it searched and found nothing suitable',
  HIGH_FALSE_POSITIVES: 'what it surfaces is mostly wrong, so rerunning it only repeats the noise; its query or check needs revising',
  STALE: 'it has found nothing for a long time and still finds nothing, so what it assumes may no longer hold; it needs revising',
  ERROR: 'it fails without a single explanation, so it should wait and be looked at',
};

/**
 * What to do with a method now. A failing method is not rerun at once: it waits
 * (with a retry time) when waiting can help, or is flagged for revision when
 * rerunning cannot. Once the retry time passes it may run again, once; a
 * further failure doubles the wait.
 */
export function decideMethod(runs: readonly SearchMethodRun[], now: string): MethodDecision {
  const streak = recentFailures(runs);
  const cause = classifyFailure(runs, now);
  if (!cause) {
    return { action: 'RUN', cause: null, retryAt: null, failedInARow: streak.length, reason: 'not failing repeatedly' };
  }
  if (!WAIT.has(cause)) {
    return { action: 'REVISE', cause, retryAt: null, failedInARow: streak.length, reason: REMEDY[cause] };
  }
  const waits = Math.min(streak.length - FAILURE_STREAK, 30);
  const wait = Math.min(BASE_RETRY_MS * 2 ** waits, MAX_RETRY_MS);
  const retryAt = new Date(Date.parse(streak[0]!.finishedAt) + wait).toISOString();
  if (Date.parse(now) >= Date.parse(retryAt)) {
    return { action: 'RUN', cause, retryAt: null, failedInARow: streak.length, reason: `${REMEDY[cause]}; the wait is over, so it may be tried once more` };
  }
  return { action: 'PAUSE', cause, retryAt, failedInARow: streak.length, reason: REMEDY[cause] };
}

export interface SubjectMethod {
  methodId: string;
  decision: MethodDecision;
}

export interface SubjectStatus {
  /** Always true: a method failing never retires the subject it was looking at. */
  open: true;
  /** Methods that may run now. */
  runnable: string[];
  /** Methods waiting, with when. */
  paused: { methodId: string; retryAt: string }[];
  /** Methods flagged for revision. */
  needRevision: string[];
  /** True when nothing may run and nothing is waiting: the subject needs a new method. */
  needsNewMethod: boolean;
}

/** What is left for a subject once each of its methods has been judged. */
export function subjectStatus(methods: readonly SubjectMethod[]): SubjectStatus {
  const runnable = methods.filter((one) => one.decision.action === 'RUN').map((one) => one.methodId);
  const paused = methods
    .filter((one) => one.decision.action === 'PAUSE' && one.decision.retryAt)
    .map((one) => ({ methodId: one.methodId, retryAt: one.decision.retryAt! }));
  const needRevision = methods.filter((one) => one.decision.action === 'REVISE').map((one) => one.methodId);
  return { open: true, runnable, paused, needRevision, needsNewMethod: runnable.length === 0 && paused.length === 0 };
}
