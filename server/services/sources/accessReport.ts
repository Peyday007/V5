/**
 * What the source-access layer changed, measured from rows (`admin sources show`)
 * and by re-reading Brain's own failed URLs both ways (`admin sources compare`).
 *
 * Every figure is counted. "Before" is what DIRECT alone produced on the same
 * read (each SOURCE_ACCESS event carries its DIRECT attempt), or the free lane's
 * own events from before the layer existed; "after" is the layer's result.
 */
import { getDb } from '../../db/database.ts';
import { browserMcpUrl } from './browserMcp.ts';
import { learnFrom, readSource, type AccessAttempt } from './access.ts';
import { fetchForWorker } from './fetchForWorker.ts';

export interface AccessWindow {
  reads: number;
  readable: number;
  directReadable: number;
  byMethod: Record<string, number>;
  msPerReadDirect: number | null;
  msPerReadFallback: number | null;
  failingHosts: { host: string; failures: number; reasons: Record<string, number> }[];
  learned: Record<string, string>;
}

interface Row {
  provider: string | null;
  outcome: string | null;
  measures: string | null;
  duration_ms: number | string | null;
}

/** The SOURCE_ACCESS reading over a window. Pure over rows. */
export function summarizeAccess(rows: Row[]): AccessWindow {
  const byMethod: Record<string, number> = {};
  let readable = 0;
  let directReadable = 0;
  const directMs: number[] = [];
  const fallbackMs: number[] = [];
  const hosts = new Map<string, { failures: number; reasons: Record<string, number> }>();
  for (const row of rows) {
    let m: { host?: string; attempts?: AccessAttempt[] } = {};
    try {
      m = JSON.parse(row.measures ?? '{}') as typeof m;
    } catch {
      // unreadable measures count as a read with no detail
    }
    const ok = row.outcome === 'READ';
    const ms = Number(row.duration_ms ?? 0);
    if (ok) {
      readable += 1;
      byMethod[row.provider ?? '?'] = (byMethod[row.provider ?? '?'] ?? 0) + 1;
      (row.provider === 'DIRECT' ? directMs : fallbackMs).push(ms);
    } else if (m.host) {
      const entry = hosts.get(m.host) ?? { failures: 0, reasons: {} };
      entry.failures += 1;
      const last = (m.attempts ?? []).map((a) => `${a.method}:${a.reason ?? 'ok'}${a.status ? `:${a.status}` : ''}`).join('>') || 'none';
      entry.reasons[last] = (entry.reasons[last] ?? 0) + 1;
      hosts.set(m.host, entry);
    }
    if ((m.attempts ?? []).some((a) => a.method === 'DIRECT' && a.readable)) directReadable += 1;
  }
  const mean = (xs: number[]): number | null => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    reads: rows.length,
    readable,
    directReadable,
    byMethod,
    msPerReadDirect: mean(directMs),
    msPerReadFallback: mean(fallbackMs),
    failingHosts: [...hosts]
      .map(([host, e]) => ({ host, ...e }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, 15),
    learned: Object.fromEntries(learnFrom(rows)),
  };
}

export async function accessWindow(since: string, until: string): Promise<AccessWindow> {
  const rows = await getDb().all<Row>(
    `SELECT provider, outcome, measures, duration_ms FROM bin_events
      WHERE event_type = 'SOURCE_ACCESS' AND at >= ? AND at < ? ORDER BY at DESC LIMIT 20000`,
    [since, until],
  );
  return summarizeAccess(rows);
}

export interface LaneWindow {
  fragmentsSubmitted: number;
  fragmentsFailed: number;
  noReadableSource: number;
  verifySubmitted: number;
  synthesesSubmitted: number;
  claimsSubmitted: number;
  claimsAccepted: number;
  msPerSubmittedFragment: number | null;
}

/** The free lane's research outcomes over a window, from its own rows. */
export async function laneWindow(since: string, until: string): Promise<LaneWindow> {
  const db = getDb();
  const rows = await db.all<{ workload_class: string | null; outcome: string; n: number | string; ms: number | string | null; unread: number | string }>(
    `SELECT workload_class, outcome, COUNT(*) AS n, SUM(duration_ms) AS ms,
            SUM(CASE WHEN reason LIKE '%no readable source%' THEN 1 ELSE 0 END) AS unread
       FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND at < ?
      GROUP BY workload_class, outcome`,
    [since, until],
  );
  const pick = (type: string, outcome: string) => rows.find((r) => r.workload_class === type && r.outcome === outcome);
  const freeWorkers = "(SELECT k.id FROM workers k WHERE k.name IN ('free-lane-a', 'free-lane-b'))";
  const claims = await db.get<{ total: number | string; accepted: number | string }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(c.accepted), 0) AS accepted FROM research_claims c
      JOIN research_passes p ON p.id = c.pass_id
     WHERE p.executor_worker_id IN ${freeWorkers} AND c.created_at >= ? AND c.created_at < ?`,
    [since, until],
  );
  const submitted = pick('RESEARCH_FRAGMENT', 'SUBMITTED');
  const n = Number(submitted?.n ?? 0);
  return {
    fragmentsSubmitted: n,
    fragmentsFailed: Number(pick('RESEARCH_FRAGMENT', 'FAILED_RETRYABLE')?.n ?? 0),
    noReadableSource: rows.reduce((acc, r) => acc + Number(r.unread ?? 0), 0),
    verifySubmitted: Number(pick('RESEARCH_VERIFY', 'SUBMITTED')?.n ?? 0),
    synthesesSubmitted: Number(pick('RESEARCH_SYNTHESIZE', 'SUBMITTED')?.n ?? 0),
    claimsSubmitted: Number(claims?.total ?? 0),
    claimsAccepted: Number(claims?.accepted ?? 0),
    msPerSubmittedFragment: n > 0 ? Math.round(Number(submitted?.ms ?? 0) / n) : null,
  };
}

/** Brain's own recently failed source URLs: reads DIRECT could not open, then claims left unretrieved. */
export async function failedUrlSample(limit: number): Promise<string[]> {
  const db = getDb();
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const urls = new Set<string>();
  const events = await db.all<{ measures: string | null }>(
    `SELECT measures FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND at >= ? ORDER BY at DESC LIMIT 3000`,
    [since],
  );
  for (const e of events) {
    try {
      const m = JSON.parse(e.measures ?? '{}') as { url?: string; attempts?: AccessAttempt[] };
      const direct = (m.attempts ?? []).find((a) => a.method === 'DIRECT');
      if (m.url && direct && !direct.readable) urls.add(m.url);
    } catch {
      // skip
    }
    if (urls.size >= limit) break;
  }
  if (urls.size < limit) {
    const claims = await db.all<{ source_url: string }>(
      `SELECT source_url FROM research_claims WHERE retrieval_state <> 'RETRIEVED' AND source_url IS NOT NULL
        AND created_at >= ? ORDER BY created_at DESC LIMIT 400`,
      [since],
    );
    for (const c of claims) {
      urls.add(c.source_url);
      if (urls.size >= limit) break;
    }
  }
  return [...urls].slice(0, limit);
}

export interface CompareRow {
  url: string;
  before: string;
  beforeMs: number;
  after: string;
  afterMs: number;
  method: string;
  improved: boolean;
}

/** Re-read each URL with DIRECT alone and with the whole layer, here and now. */
export async function compareReaders(urls: string[]): Promise<{ rows: CompareRow[]; rssBeforeMb: number; rssAfterMb: number; browser: boolean }> {
  const rssBeforeMb = Math.round(process.memoryUsage().rss / 1e6);
  const rows: CompareRow[] = [];
  for (const url of urls) {
    const t0 = Date.now();
    const before = await fetchForWorker(url);
    const beforeMs = Date.now() - t0;
    const t1 = Date.now();
    const after = await readSource(url, { caller: 'compare', record: async () => undefined });
    const afterMs = Date.now() - t1;
    const usable = (r: typeof before): boolean => r.readable && r.text.trim().length > 200;
    rows.push({
      url,
      before: before.readable ? `READ ${before.totalChars}` : `${before.reason}${before.status ? ` ${before.status}` : ''}`,
      beforeMs,
      after: after.readable ? `READ ${after.totalChars}` : `${after.reason}${after.status ? ` ${after.status}` : ''}`,
      afterMs,
      method: after.attempts.map((a) => `${a.method}:${a.readable ? 'ok' : a.reason}`).join('>'),
      improved: usable(after) && !usable(before),
    });
  }
  return { rows, rssBeforeMb, rssAfterMb: Math.round(process.memoryUsage().rss / 1e6), browser: Boolean(browserMcpUrl()) };
}
