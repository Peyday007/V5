/**
 * The bulk benchmark: the registry-driven pipeline over thousands of fixture
 * records, compared with the stored baseline.
 *
 * Sources are built from registry rows (`sourceFromRow`), so the named parsers,
 * dedupe and failure classification run exactly as in production. Bodies are
 * served by a fake fetcher; the free-model lane is a counting completer. Counts
 * are deterministic for a workload and are asserted. Timings and memory are this
 * machine's and are reported, never compared. A figure the harness cannot
 * observe is `null`; nothing is estimated.
 */
import { getDb } from '../../../db/database.ts';
import { pullDueFeeds, screenFeedLeads, type Fetcher } from '../../feeds/run.ts';
import { runDetectors } from '../../feeds/detectors.ts';
import { sourceFromRow, type SourceRow } from '../../feeds/sources.ts';
import type { Completer, LaneConfig } from '../../cheap/lane.ts';

const FAMILY = ['Data Analyst', 'Analytics Engineer', 'BI Developer', 'Data Scientist', 'Reporting Analyst'];
const HOUR = 3_600_000;

export interface BulkWorkload {
  name: string;
  /** Employers who post three distinct data roles on remoteok (and one copy on remotive). */
  companies: number;
  /** Unrelated single postings on remoteok. */
  filler: number;
  /** Fraction (per mille) of records that are new on the incremental pull. */
  incrementalPerMille: number;
}

export interface BulkReading {
  workload: string;
  records: number;
  counts: {
    pulls: number;
    failedPulls: number;
    fetched: number;
    inserted: number;
    duplicates: number;
    detectorSignals: number;
    /** Records the detector actually read; runDetectors caps its read at 5,000. */
    detectorRecordsRead: number;
    cheapCalls: number;
    screened: number;
    ruleCoveredScreened: number;
    claudeJobs: number;
    incrementalFetched: number;
    incrementalInserted: number;
  };
  rates: { duplicateRate: number | null; failureRate: number | null; incrementalNewRate: number | null };
  timing: { collectMs: number; interpretMs: number; recordsPerMinute: number | null; incrementalMs: number; heapDeltaBytes: number };
  /** Which phase took longer: the one honest statement about the bottleneck. */
  bottleneck: 'collect' | 'interpret';
}

const row = (id: string, parserId: string): SourceRow => ({
  id, label: id, kind: 'JSON_API', url: `https://bulk.test/${id}`, parserId, intervalHours: 1,
  robots: { status: 'ALLOWED_PUBLIC_API', checkedAt: '2026-10-30', note: 'fixture' }, ownerProjectId: null,
});

const SCREEN_ANSWER = '{"verdict":"KEEP","window":"SHORT","deliverable":"DATASET","need":"a reporting dataset","payer":"the company","reason":"asks for it"}';
const LANE: LaneConfig = { url: 'http://bulk.test/v1', key: null, models: ['m1', 'm2'], dailyBudget: 10_000_000, timeoutMs: 1000 };

async function count(sql: string): Promise<number> {
  const r = await getDb().get<{ n: number | string | null }>(sql);
  return Number(r?.n ?? 0);
}

/** Bodies in the sources' real wire formats (RemoteOK array; Remotive `{jobs}`). */
export function bulkBodies(w: BulkWorkload, now: Date, extra = 0): { remoteok: unknown[]; remotive: { jobs: unknown[] } } {
  const date = new Date(now.getTime() - 86_400_000).toISOString();
  const remoteok: unknown[] = [{ legal: 'notice' }];
  const jobs: unknown[] = [];
  for (let c = 0; c < w.companies; c++) {
    for (let t = 0; t < 3; t++) remoteok.push({ id: `ro-${c}-${t}`, position: FAMILY[t], company: `Company ${c} Inc`, url: `https://remoteok.com/j/ro-${c}-${t}`, date });
    jobs.push({ id: `rv-${c}`, title: FAMILY[0], company_name: `COMPANY ${c} INC`, url: `https://remotive.com/j/rv-${c}`, publication_date: date });
  }
  for (let f = 0; f < w.filler + extra; f++) remoteok.push({ id: `ro-f-${f}`, position: `Warehouse Picker ${f}`, company: `Filler ${f} LLC`, url: `https://remoteok.com/j/ro-f-${f}`, date });
  return { remoteok, remotive: { jobs } };
}

export async function measureBulk(w: BulkWorkload, now: Date = new Date()): Promise<BulkReading> {
  const sources = [sourceFromRow(row('remoteok', 'remoteok')), sourceFromRow(row('remotive', 'remotive')), sourceFromRow(row('broken-feed', 'remotive'))];
  let bodies = bulkBodies(w, now);
  const fetcher: Fetcher = async (url) => {
    if (url.endsWith('/remoteok')) return bodies.remoteok;
    if (url.endsWith('/remotive')) return bodies.remotive;
    throw new Error('HTTP 503');
  };
  const jobsBefore = (await count('SELECT COUNT(*) AS n FROM work_items')) + (await count('SELECT COUNT(*) AS n FROM russell_candidates'));
  const heapBefore = process.memoryUsage().heapUsed;

  const t0 = Date.now();
  const first = await pullDueFeeds({ now, sources, fetcher });
  const collectMs = Date.now() - t0;

  const t1 = Date.now();
  const reports = await runDetectors({ now });
  let cheapCalls = 0;
  const completer: Completer = async () => { cheapCalls += 1; return SCREEN_ANSWER; };
  const screened = await screenFeedLeads({ now, config: LANE, completer });
  const interpretMs = Date.now() - t1;
  const ruleCoveredScreened = await count(
    `SELECT COUNT(DISTINCT r.subject_id) AS n FROM cheap_results r JOIN feed_item_coverage c ON c.item_id = r.subject_id WHERE r.kind = 'SCREEN_LEAD'`,
  );

  // The same bodies an interval later plus a small number of new records: what an incremental pull costs.
  const extra = Math.max(1, Math.round(((w.companies * 4 + w.filler) * w.incrementalPerMille) / 1000));
  bodies = bulkBodies(w, now, extra);
  const t2 = Date.now();
  const second = await pullDueFeeds({ now: new Date(now.getTime() + HOUR + 1), sources, fetcher });
  const incrementalMs = Date.now() - t2;

  const fetchedOf = async (): Promise<number> => count('SELECT SUM(fetched) AS n FROM feed_pulls');
  const pulls = [...first, ...second];
  const failedPulls = pulls.filter((p) => p.outcome === 'SOURCE_UNREACHABLE').length;
  const inserted = pulls.reduce((s, p) => s + p.inserted, 0);
  const fetched = await fetchedOf();
  const incrementalInserted = second.reduce((s, p) => s + p.inserted, 0);
  const incrementalFetched = bodies.remoteok.length - 1 + bodies.remotive.jobs.length;
  const jobsAfter = (await count('SELECT COUNT(*) AS n FROM work_items')) + (await count('SELECT COUNT(*) AS n FROM russell_candidates'));
  const initialRecords = w.companies * 4 + w.filler;

  return {
    workload: w.name,
    records: initialRecords,
    counts: {
      pulls: pulls.length,
      failedPulls,
      fetched,
      inserted,
      duplicates: fetched - inserted,
      detectorSignals: reports.reduce((s, r) => s + r.signals, 0),
      detectorRecordsRead: reports.reduce((s, r) => s + r.records, 0),
      cheapCalls,
      screened,
      ruleCoveredScreened,
      claudeJobs: jobsAfter - jobsBefore,
      incrementalFetched,
      incrementalInserted,
    },
    rates: {
      duplicateRate: fetched > 0 ? (fetched - inserted) / fetched : null,
      failureRate: pulls.length > 0 ? failedPulls / pulls.length : null,
      incrementalNewRate: incrementalFetched > 0 ? incrementalInserted / incrementalFetched : null,
    },
    timing: {
      collectMs,
      interpretMs,
      recordsPerMinute: collectMs > 0 ? Math.round((initialRecords / collectMs) * 60_000) : null,
      incrementalMs,
      heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    },
    bottleneck: collectMs >= interpretMs ? 'collect' : 'interpret',
  };
}

export interface BaselineComparison {
  baselineWorkload: string;
  /** Per figure: the stored baseline value, this run's value, on the baseline's own small workload. */
  rows: { figure: string; baseline: number | null; now: number | null }[];
}

/** Compare a reading taken on the baseline's workload with the stored baseline. Only measured figures. */
export function compareToBaseline(
  stored: { workload: string; counts: Record<string, number>; rates: Record<string, number | null> },
  now: { counts: Record<string, number>; rates: Record<string, number | null> },
): BaselineComparison {
  const figures = ['pulls', 'failedPulls', 'fetched', 'inserted', 'duplicates', 'detectorSignals', 'cheapCalls', 'screened', 'claudeJobs'];
  return {
    baselineWorkload: stored.workload,
    rows: [
      ...figures.map((f) => ({ figure: f, baseline: stored.counts[f] ?? null, now: now.counts[f] ?? null })),
      { figure: 'duplicateRate', baseline: stored.rates['duplicateRate'] ?? null, now: now.rates['duplicateRate'] ?? null },
      { figure: 'failureRate', baseline: stored.rates['failureRate'] ?? null, now: now.rates['failureRate'] ?? null },
    ],
  };
}
