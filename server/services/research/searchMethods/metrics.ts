/**
 * What a search method has actually earned, from its recorded runs.
 *
 * Precision is confirmed over verified (confirmed + rejected). Volume is
 * reported and never used to rank: a method that surfaces a great deal and is
 * mostly wrong is worth less than one that surfaces little and is right.
 * Nothing verified means precision is unknown, and unknown never ranks above a
 * measured value.
 */
import type { SearchMethodRun } from '../../../domain/searchIntelligence.ts';

export interface MethodMetrics {
  runs: number;
  examined: number;
  surfaced: number;
  confirmed: number;
  rejected: number;
  /** confirmed + rejected: results a person or a check actually judged. */
  verified: number;
  /** confirmed / verified, or null when nothing has been verified. */
  precision: number | null;
  /** Runs per outcome, so "source unavailable" never reads as "nothing exists". */
  outcomes: Record<string, number>;
}

export function methodMetrics(runs: readonly SearchMethodRun[]): MethodMetrics {
  const m: MethodMetrics = {
    runs: runs.length, examined: 0, surfaced: 0, confirmed: 0, rejected: 0, verified: 0, precision: null, outcomes: {},
  };
  for (const run of runs) {
    m.examined += run.examined;
    m.surfaced += run.surfaced;
    m.confirmed += run.confirmed;
    m.rejected += run.rejected;
    m.outcomes[run.outcome] = (m.outcomes[run.outcome] ?? 0) + 1;
  }
  m.verified = m.confirmed + m.rejected;
  m.precision = m.verified > 0 ? m.confirmed / m.verified : null;
  return m;
}

export interface Rankable {
  id: string;
  metrics: MethodMetrics;
}

/** Precision first (unknown last), then how many results back it, then id. Volume plays no part. */
export function rankByPrecision<T extends Rankable>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const pa = a.metrics.precision;
    const pb = b.metrics.precision;
    if (pa === null && pb !== null) return 1;
    if (pb === null && pa !== null) return -1;
    if (pa !== null && pb !== null && pa !== pb) return pb - pa;
    if (a.metrics.verified !== b.metrics.verified) return b.metrics.verified - a.metrics.verified;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
