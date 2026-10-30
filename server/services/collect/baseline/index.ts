/**
 * The baseline: the feeds pipeline as it is today, run over a stored workload.
 *
 * Nothing here changes how collection behaves. It drives the real
 * `pullDueFeeds`, `runDetectors` and `screenFeedLeads` with a fake fetcher and a
 * counting completer, and reports only what it counted or timed. The counts are
 * deterministic for a given workload, so a later pipeline can be compared to
 * them exactly; the timings are this machine's and are labelled so. Nothing is
 * estimated: a figure the harness cannot observe is `null`.
 */
import { getDb } from '../../../db/database.ts';
import { pullDueFeeds, screenFeedLeads, type Fetcher } from '../../feeds/run.ts';
import { runDetectors } from '../../feeds/detectors.ts';
import type { FeedSource } from '../../feeds/sources.ts';
import type { Completer, LaneConfig } from '../../cheap/lane.ts';

export interface WorkloadItem {
  externalId: string;
  title: string;
  organization: string | null;
}

export interface WorkloadSource {
  id: string;
  items: WorkloadItem[];
  /** A source that always fails, to measure the failure rate. */
  broken?: boolean;
}

export interface BaselineWorkload {
  name: string;
  sources: WorkloadSource[];
}

const FAMILY_TITLES = ['Data Analyst', 'Analytics Engineer', 'BI Developer', 'Data Scientist', 'Reporting Analyst'];

/**
 * A deterministic workload: `companies` employers each posting three distinct
 * data roles (one of them on both sources under different ids, so cross-source
 * duplicates exist), plus `filler` unrelated single postings.
 */
export function buildWorkload(companies: number, filler: number): BaselineWorkload {
  const remoteok: WorkloadItem[] = [];
  const remotive: WorkloadItem[] = [];
  for (let c = 0; c < companies; c++) {
    const org = `Company ${c} Inc`;
    for (let t = 0; t < 3; t++) remoteok.push({ externalId: `ro-${c}-${t}`, title: FAMILY_TITLES[t]!, organization: org });
    remotive.push({ externalId: `rv-${c}-0`, title: FAMILY_TITLES[0]!, organization: org.toUpperCase() });
  }
  for (let f = 0; f < filler; f++) {
    remoteok.push({ externalId: `ro-f-${f}`, title: `Warehouse Picker ${f}`, organization: `Filler ${f} LLC` });
  }
  return {
    name: `companies=${companies},filler=${filler}`,
    sources: [{ id: 'remoteok', items: remoteok }, { id: 'remotive', items: remotive }, { id: 'broken-feed', items: [], broken: true }],
  };
}

export interface BaselineReading {
  workload: string;
  /** Deterministic for a workload: compare these exactly. */
  counts: {
    pulls: number;
    failedPulls: number;
    fetched: number;
    inserted: number;
    duplicates: number;
    detectorSignals: number;
    cheapCalls: number;
    screened: number;
    claudeJobs: number;
  };
  /** Derived from the counts. */
  rates: { duplicateRate: number | null; failureRate: number | null };
  /** This machine's timings on this run; never compared across machines. */
  timing: { collectMs: number; interpretMs: number; recordsPerMinute: number | null; heapDeltaBytes: number };
}

const SCREEN_ANSWER = '{"verdict":"KEEP","window":"SHORT","deliverable":"DATASET","need":"a reporting dataset","payer":"the company","reason":"asks for it"}';
const LANE: LaneConfig = { url: 'http://baseline.test/v1', key: null, models: ['m1', 'm2'], dailyBudget: 1_000_000, timeoutMs: 1000 };

async function count(table: string): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(row?.n ?? 0);
}

/** Run the unchanged pipeline over the workload: pull, pull again, detect, screen. */
export async function measureBaseline(workload: BaselineWorkload, now: Date = new Date()): Promise<BaselineReading> {
  const intervalMs = 3_600_000;
  const sources: FeedSource[] = workload.sources.map((s) => ({
    id: s.id,
    label: s.id,
    url: `https://baseline.test/${s.id}`,
    intervalMs,
    parse: (body) =>
      (body as WorkloadItem[]).map((one) => ({
        externalId: one.externalId,
        url: `https://baseline.test/${s.id}/${one.externalId}`,
        title: one.title,
        body: null,
        organization: one.organization,
        publishedAt: new Date(now.getTime() - 86_400_000).toISOString(),
      })),
  }));
  const bodyFor = new Map(workload.sources.map((s) => [`https://baseline.test/${s.id}`, s]));
  const fetcher: Fetcher = async (url) => {
    const source = bodyFor.get(url);
    if (!source || source.broken) throw new Error('HTTP 503');
    return source.items;
  };

  const jobsBefore = (await count('work_items')) + (await count('russell_candidates'));
  const heapBefore = process.memoryUsage().heapUsed;

  const t0 = Date.now();
  const first = await pullDueFeeds({ now, sources, fetcher });
  // The same bodies delivered again an interval later: everything is a duplicate.
  const second = await pullDueFeeds({ now: new Date(now.getTime() + intervalMs + 1), sources, fetcher });
  const collectMs = Date.now() - t0;

  const pulls = [...first, ...second];
  const fetchedRow = await getDb().get<{ f: number | string | null }>('SELECT SUM(fetched) AS f FROM feed_pulls');
  const fetched = Number(fetchedRow?.f ?? 0);
  const inserted = pulls.reduce((sum, p) => sum + p.inserted, 0);
  const failedPulls = pulls.filter((p) => p.error !== null).length;

  const t1 = Date.now();
  const reports = await runDetectors({ now });
  let cheapCalls = 0;
  const completer: Completer = async () => {
    cheapCalls += 1;
    return SCREEN_ANSWER;
  };
  const screened = await screenFeedLeads({ now, config: LANE, completer });
  const interpretMs = Date.now() - t1;

  const jobsAfter = (await count('work_items')) + (await count('russell_candidates'));
  return {
    workload: workload.name,
    counts: {
      pulls: pulls.length,
      failedPulls,
      fetched,
      inserted,
      duplicates: fetched - inserted,
      detectorSignals: reports.reduce((sum, r) => sum + r.signals, 0),
      cheapCalls,
      screened,
      claudeJobs: jobsAfter - jobsBefore,
    },
    rates: {
      duplicateRate: fetched > 0 ? (fetched - inserted) / fetched : null,
      failureRate: pulls.length > 0 ? failedPulls / pulls.length : null,
    },
    timing: {
      collectMs,
      interpretMs,
      recordsPerMinute: collectMs > 0 ? Math.round((fetched / collectMs) * 60_000) : null,
      heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    },
  };
}
