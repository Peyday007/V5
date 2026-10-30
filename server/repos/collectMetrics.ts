/**
 * What a pull measured, stored beside the pull in feed_pulls (additive columns).
 * Counts and times only - a source is judged on downstream yield, never volume,
 * and nothing here turns them into a score.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { CollectFailureCause, FeedPullMetrics, SourceKind } from '../domain/collect.ts';

export async function recordPullMetrics(source: string, ok: boolean, m: FeedPullMetrics, error: string | null = null, at?: string): Promise<void> {
  await getDb().run(
    `INSERT INTO feed_pulls
       (id, source, ok, fetched, inserted, error, created_at, method, duplicates, relevant, signals,
        failure_cause, wall_ms, bytes, memory_bytes, cheap_calls, claude_jobs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId('fdp'), source, ok ? 1 : 0, m.fetched, m.inserted, error, at ?? nowIso(), m.method, m.duplicates, m.relevant,
      m.signals, m.failureCause, m.wallMs, m.bytes, m.memoryBytes, m.cheapCalls, m.claudeJobs],
  );
}

export interface SourceMetricsReading {
  source: string;
  pulls: number;
  fetched: number;
  inserted: number;
  duplicates: number;
  relevant: number;
  signals: number;
  claudeJobs: number;
  cheapCalls: number;
  failuresByCause: Partial<Record<CollectFailureCause, number>>;
  method: SourceKind | null;
}

const n = (v: number | string | null | undefined): number => Number(v ?? 0);

/** Sums over the pulls recorded for each source; an unmeasured column counts as zero measured, not as an estimate. */
export async function readSourceMetrics(): Promise<SourceMetricsReading[]> {
  const db = getDb();
  const rows = await db.all<Record<string, number | string | null>>(
    `SELECT source, COUNT(*) AS pulls, SUM(fetched) AS fetched, SUM(inserted) AS inserted,
            SUM(duplicates) AS duplicates, SUM(relevant) AS relevant, SUM(signals) AS signals,
            SUM(claude_jobs) AS claude_jobs, SUM(cheap_calls) AS cheap_calls, MAX(method) AS method
       FROM feed_pulls GROUP BY source ORDER BY source`,
  );
  const failures = await db.all<{ source: string; failure_cause: string; c: number | string }>(
    `SELECT source, failure_cause, COUNT(*) AS c FROM feed_pulls WHERE failure_cause IS NOT NULL GROUP BY source, failure_cause`,
  );
  return rows.map((r) => {
    const by: Partial<Record<CollectFailureCause, number>> = {};
    for (const f of failures) if (f.source === r.source) by[f.failure_cause as CollectFailureCause] = n(f.c);
    return {
      source: String(r.source), pulls: n(r.pulls), fetched: n(r.fetched), inserted: n(r.inserted),
      duplicates: n(r.duplicates), relevant: n(r.relevant), signals: n(r.signals), claudeJobs: n(r.claude_jobs),
      cheapCalls: n(r.cheap_calls), failuresByCause: by, method: (r.method as SourceKind | null) ?? null,
    };
  });
}
