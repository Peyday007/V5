/**
 * What collection actually did, read from rows.
 *
 * Every figure is a sum over `feed_pulls` (which the pull recorded) or a count
 * over `feed_items`. A column nothing measured is reported as `null`, never
 * zero. "Records that did not go to Claude" is a count of stored records no
 * shortlist took: a count of records, not a cost estimate. The baseline is the
 * stored one from the unchanged pipeline, shown beside the live figures.
 */
import fs from 'node:fs';
import { getDb } from '../../../db/database.ts';
import { readSourceMetrics, type SourceMetricsReading } from '../../../repos/collectMetrics.ts';
import { listCollectSources } from '../../../repos/collectSources.ts';

export interface BaselineFile {
  workload: string;
  counts: Record<string, number>;
  rates: Record<string, number | null>;
}

export interface SourceReportRow extends SourceMetricsReading {
  wallMs: number | null;
  bytes: number | null;
  shortlisted: number;
  recordsNotSentToClaude: number;
  duplicateRate: number | null;
  failureRate: number | null;
  robots: string | null;
}

export interface CollectionReport {
  sources: SourceReportRow[];
  registered: number;
  active: number;
  totals: {
    pulls: number;
    failedPulls: number;
    fetched: number;
    inserted: number;
    duplicates: number;
    signals: number;
    claudeJobs: number;
    cheapCalls: number;
    recordsNotSentToClaude: number;
    wallMs: number | null;
    duplicateRate: number | null;
    failureRate: number | null;
    recordsPerMinute: number | null;
  };
  /** The slowest measured source, or the source failing most; null when nothing was measured. */
  bottleneck: string | null;
  baseline: BaselineFile | null;
}

const num = (v: unknown): number => Number(v ?? 0);

export function loadBaseline(file: string): BaselineFile | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as BaselineFile;
  } catch {
    return null;
  }
}

export async function buildReport(baselineFile?: string): Promise<CollectionReport> {
  const db = getDb();
  const metrics = await readSourceMetrics();
  const pulls = await db.all<{ source: string; failed: number | string; wall: number | string | null; bytes: number | string | null; measured: number | string }>(
    `SELECT source, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, SUM(wall_ms) AS wall, SUM(bytes) AS bytes,
            SUM(CASE WHEN wall_ms IS NOT NULL THEN 1 ELSE 0 END) AS measured
       FROM feed_pulls GROUP BY source`,
  );
  const items = await db.all<{ source: string; stored: number | string; shortlisted: number | string }>(
    `SELECT source, COUNT(*) AS stored, SUM(CASE WHEN shortlisted_round_id IS NOT NULL THEN 1 ELSE 0 END) AS shortlisted
       FROM feed_items GROUP BY source`,
  );
  const registered = await listCollectSources(null);
  const robots = new Map(registered.map((s) => [s.slug, s.robotsStatus]));
  const rows: SourceReportRow[] = metrics.map((m) => {
    const p = pulls.find((x) => x.source === m.source);
    const i = items.find((x) => x.source === m.source);
    const measured = num(p?.measured) > 0;
    const stored = num(i?.stored);
    const shortlisted = num(i?.shortlisted);
    return {
      ...m,
      wallMs: measured ? num(p?.wall) : null,
      bytes: p?.bytes == null ? null : num(p.bytes),
      shortlisted,
      recordsNotSentToClaude: stored - shortlisted,
      duplicateRate: m.fetched > 0 ? m.duplicates / m.fetched : null,
      failureRate: m.pulls > 0 ? num(p?.failed) / m.pulls : null,
      robots: robots.get(m.source) ?? null,
    };
  });
  const sum = (f: (r: SourceReportRow) => number): number => rows.reduce((s, r) => s + f(r), 0);
  const failedPulls = rows.reduce((s, r) => s + Math.round((r.failureRate ?? 0) * r.pulls), 0);
  const measuredWall = rows.filter((r) => r.wallMs !== null);
  const wallMs = measuredWall.length ? measuredWall.reduce((s, r) => s + (r.wallMs ?? 0), 0) : null;
  const fetched = sum((r) => r.fetched);
  const slowest = [...measuredWall].sort((a, b) => (b.wallMs ?? 0) - (a.wallMs ?? 0))[0];
  const flakiest = [...rows].filter((r) => (r.failureRate ?? 0) > 0).sort((a, b) => (b.failureRate ?? 0) - (a.failureRate ?? 0))[0];
  return {
    sources: rows,
    registered: registered.length,
    active: registered.filter((s) => s.enabled && s.robotsStatus === 'ALLOWED').length,
    totals: {
      pulls: sum((r) => r.pulls),
      failedPulls,
      fetched,
      inserted: sum((r) => r.inserted),
      duplicates: sum((r) => r.duplicates),
      signals: sum((r) => r.signals),
      claudeJobs: sum((r) => r.claudeJobs),
      cheapCalls: sum((r) => r.cheapCalls),
      recordsNotSentToClaude: sum((r) => r.recordsNotSentToClaude),
      wallMs,
      duplicateRate: fetched > 0 ? sum((r) => r.duplicates) / fetched : null,
      failureRate: sum((r) => r.pulls) > 0 ? failedPulls / sum((r) => r.pulls) : null,
      recordsPerMinute: wallMs && wallMs > 0 ? Math.round((fetched / wallMs) * 60_000) : null,
    },
    bottleneck: slowest
      ? `${slowest.source}: ${slowest.wallMs} ms of measured pull time`
      : flakiest ? `${flakiest.source}: ${Math.round((flakiest.failureRate ?? 0) * 100)}% of pulls failed` : null,
    baseline: baselineFile ? loadBaseline(baselineFile) : null,
  };
}

const fmt = (v: number | null, digits = 3): string => (v === null ? 'not measured' : Number.isInteger(v) ? String(v) : v.toFixed(digits));

export function renderReport(r: CollectionReport): string {
  const t = r.totals;
  const lines = [
    `COLLECTION REPORT (read from rows; "not measured" means no pull recorded it)`,
    `sources registered ${r.registered}, active (enabled and robots ALLOWED) ${r.active}`,
    `pulls ${t.pulls}, failed ${t.failedPulls} (failure rate ${fmt(t.failureRate)})`,
    `records fetched ${t.fetched}, newly stored ${t.inserted}, duplicates ${t.duplicates} (duplicate rate ${fmt(t.duplicateRate)})`,
    `signals ${t.signals}, cheap-lane calls ${t.cheapCalls}, Claude jobs consumed ${t.claudeJobs}`,
    `records never sent to Claude (stored, not shortlisted; a count, not a cost) ${t.recordsNotSentToClaude}`,
    `measured pull time ${fmt(t.wallMs)} ms, records/minute ${fmt(t.recordsPerMinute)}`,
    `bottleneck: ${r.bottleneck ?? 'not measured'}`,
    '',
    'per source:',
    ...r.sources.map((s) =>
      `  ${s.source} [${s.method ?? 'n/a'}, robots ${s.robots ?? 'n/a'}] pulls ${s.pulls} fetched ${s.fetched} new ${s.inserted} dup ${fmt(s.duplicateRate)} ` +
      `signals ${s.signals} shortlisted ${s.shortlisted} failures ${JSON.stringify(s.failuresByCause)} wall ${fmt(s.wallMs)} ms`),
  ];
  if (r.baseline) {
    const b = r.baseline;
    lines.push('', `stored baseline (${b.workload}, fixture workload, not production): ` +
      `fetched ${b.counts['fetched']}, inserted ${b.counts['inserted']}, duplicate rate ${b.rates['duplicateRate']}, ` +
      `failure rate ${b.rates['failureRate']}, signals ${b.counts['detectorSignals']}, cheap calls ${b.counts['cheapCalls']}, Claude jobs ${b.counts['claudeJobs']}`);
  } else lines.push('', 'stored baseline: not found in this image (tests/ is not shipped); see docs/COLLECTION-BASELINE.md');
  return lines.join('\n');
}
