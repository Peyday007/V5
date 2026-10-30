/**
 * A source judged on what came out of it, not on how much it returned.
 *
 * `feed_pulls` says what a pull cost and found; the portfolio says which of
 * those leads became openings and how far they got. This joins the two by the
 * one link both sides hold - the address of the page - and reports counts.
 * It decides nothing and writes nothing, and a figure nobody measured stays
 * null rather than becoming zero.
 */
import type { CollectFailureCause } from '../../../domain/collect.ts';
import type { SourceMetricsReading } from '../../../repos/collectMetrics.ts';

export interface ShortlistedLead {
  source: string;
  /** Canonical key of the lead's page (see openingSourceKey). */
  urlKey: string | null;
}

export interface OpeningOutcome {
  /** Canonical key of the page the opening's claim came from. */
  urlKey: string | null;
  /** A gated claim stands behind it. */
  verified: boolean;
  /** CANDIDATE or above: a payer and a capture path are known. */
  useful: boolean;
  qualified: boolean;
}

export interface SourceYieldRow {
  source: string;
  method: string | null;
  pulls: number;
  collected: number;
  newRecords: number;
  /** duplicates / collected; null when no pull measured duplicates. */
  duplicateRate: number | null;
  relevant: number;
  signals: number;
  shortlisted: number;
  openings: number;
  verified: number;
  useful: number;
  qualified: number;
  /** Shortlisted leads that no opening was ever filed from. A count of misses, not a model's opinion. */
  shortlistedNoOpening: number;
  claudeJobs: number;
  cheapCalls: number;
  failuresByCause: Partial<Record<CollectFailureCause, number>>;
  /** Pulls that failed for a reason other than "the source had nothing". */
  failedPulls: number;
  /** failedPulls / pulls. */
  failureRate: number | null;
}

/** Pulls that found nothing are not failures; an unreachable source is. */
const NOT_A_FAILURE: readonly CollectFailureCause[] = ['NO_MATCHING_RECORDS'];

export function joinSourceYield(
  pulls: readonly SourceMetricsReading[],
  leads: readonly ShortlistedLead[],
  openings: readonly OpeningOutcome[],
): SourceYieldRow[] {
  const byKey = new Map<string, OpeningOutcome[]>();
  for (const o of openings) {
    if (!o.urlKey) continue;
    byKey.set(o.urlKey, [...(byKey.get(o.urlKey) ?? []), o]);
  }
  const sources = new Set<string>([...pulls.map((p) => p.source), ...leads.map((l) => l.source)]);
  const rows: SourceYieldRow[] = [];
  for (const source of sources) {
    const p = pulls.find((one) => one.source === source);
    let shortlisted = 0, noOpening = 0, opened = 0, verified = 0, useful = 0, qualified = 0;
    const seen = new Set<string>();
    for (const lead of leads) {
      if (lead.source !== source) continue;
      shortlisted += 1;
      const hits = lead.urlKey ? byKey.get(lead.urlKey) : undefined;
      if (!hits || hits.length === 0) { noOpening += 1; continue; }
      // One page is one opening however many leads point at it.
      if (seen.has(lead.urlKey!)) continue;
      seen.add(lead.urlKey!);
      for (const o of hits) {
        opened += 1;
        if (o.verified) verified += 1;
        if (o.useful) useful += 1;
        if (o.qualified) qualified += 1;
      }
    }
    const failures = p?.failuresByCause ?? {};
    let failedPulls = 0;
    for (const [cause, count] of Object.entries(failures)) {
      if (!NOT_A_FAILURE.includes(cause as CollectFailureCause)) failedPulls += count ?? 0;
    }
    const pullCount = p?.pulls ?? 0;
    rows.push({
      source,
      method: p?.method ?? null,
      pulls: pullCount,
      collected: p?.fetched ?? 0,
      newRecords: p?.inserted ?? 0,
      duplicateRate: p && p.fetched > 0 ? p.duplicates / p.fetched : null,
      relevant: p?.relevant ?? 0,
      signals: p?.signals ?? 0,
      shortlisted,
      openings: opened,
      verified,
      useful,
      qualified,
      shortlistedNoOpening: noOpening,
      claudeJobs: p?.claudeJobs ?? 0,
      cheapCalls: p?.cheapCalls ?? 0,
      failuresByCause: failures,
      failedPulls,
      failureRate: pullCount > 0 ? failedPulls / pullCount : null,
    });
  }
  // Downstream yield first; volume is only the last tiebreak.
  return rows.sort(
    (a, b) => b.qualified - a.qualified || b.useful - a.useful || b.verified - a.verified ||
      b.openings - a.openings || b.collected - a.collected || a.source.localeCompare(b.source),
  );
}
