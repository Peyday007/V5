/**
 * What a search method has actually done, computed from its run rows.
 *
 * Pure: it takes runs and reads nothing. The numbers are counts and sums of
 * recorded facts; none is a score. Trust is fed by precision among results a
 * reader judged, and never by how many candidates a method surfaced: a method
 * that surfaces a thousand unjudged items has earned exactly as much as one
 * that surfaced none.
 */
import type { SearchMethodRun } from '../../../domain/searchIntelligence.ts';

export interface MethodMetrics {
  methodId: string;
  runs: number;
  /** Items the method surfaced as candidates. Volume: informational only. */
  relevant: number;
  /** Surfaced items a reader confirmed. */
  verified: number;
  /** Surfaced items a reader rejected. */
  falsePositives: number;
  /** Examined items that were already known; null where nothing records it. */
  duplicates: number | null;
  /** Total wall time of the runs, in milliseconds. */
  searchTimeMs: number;
  /** Wall time spent by code and the free lane, which cost no Claude allowance. */
  computeMs: number;
  /** Runs that consumed a Claude activation. */
  aiJobsConsumed: number;
  /** Runs that code or the cheap lane did instead of Claude. */
  aiJobsAvoided: number;
  /** Runs per outcome, so "unavailable" and "nothing suitable" stay apart. */
  outcomes: Record<SearchMethodRun['outcome'], number>;
  /** Opportunities that went on to qualify; null when no downstream reading exists. */
  validatedOpportunities: number | null;
  /** Downstream outcome counts when known (e.g. cash tiers); null when unknown. */
  downstream: { useful: number; qualified: number } | null;
}

export interface MethodTrustInput {
  /** Items a reader judged: confirmed plus rejected. */
  judged: number;
  /** confirmed / judged; null below the sample floor, never a guess. */
  precision: number | null;
  /** Whether enough was judged for precision to mean anything. */
  sufficient: boolean;
}

/** Judged results needed before precision is a number rather than "not yet". */
export const MIN_JUDGED_FOR_TRUST = 8;

const ms = (from: string, to: string): number => {
  const d = Date.parse(to) - Date.parse(from);
  return Number.isFinite(d) && d > 0 ? d : 0;
};

export function computeMethodMetrics(
  methodId: string,
  runs: readonly SearchMethodRun[],
  extra: { duplicates?: number | null; downstream?: { useful: number; qualified: number } | null } = {},
): MethodMetrics {
  const outcomes: MethodMetrics['outcomes'] = { FOUND: 0, NOTHING_SUITABLE: 0, SOURCE_UNAVAILABLE: 0, FALSE_POSITIVES: 0, ERROR: 0 };
  const out: MethodMetrics = {
    methodId,
    runs: 0,
    relevant: 0,
    verified: 0,
    falsePositives: 0,
    duplicates: extra.duplicates ?? null,
    searchTimeMs: 0,
    computeMs: 0,
    aiJobsConsumed: 0,
    aiJobsAvoided: 0,
    outcomes,
    validatedOpportunities: extra.downstream ? extra.downstream.qualified : null,
    downstream: extra.downstream ?? null,
  };
  for (const run of runs) {
    if (run.methodId !== methodId) continue;
    out.runs += 1;
    out.relevant += run.surfaced;
    out.verified += run.confirmed;
    out.falsePositives += run.rejected;
    const took = ms(run.startedAt, run.finishedAt);
    out.searchTimeMs += took;
    outcomes[run.outcome] += 1;
    if (run.executor === 'CLAUDE') out.aiJobsConsumed += 1;
    else {
      out.aiJobsAvoided += 1;
      out.computeMs += took;
    }
  }
  return out;
}

/**
 * The only numbers trust may read. Surfaced count, run count and time are
 * deliberately absent: volume alone never raises trust.
 */
export function trustInput(metrics: Pick<MethodMetrics, 'verified' | 'falsePositives'>): MethodTrustInput {
  const judged = metrics.verified + metrics.falsePositives;
  const sufficient = judged >= MIN_JUDGED_FOR_TRUST;
  return { judged, precision: sufficient ? metrics.verified / judged : null, sufficient };
}
