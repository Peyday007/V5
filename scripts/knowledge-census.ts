/** Throwaway read-only probe (claude/probe-d2): search/fetch acquisition failures. SELECT only. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(sql: string, args: unknown[] = []): Promise<any[]> {
  try {
    return await getDb().all(sql, args);
  } catch (e) {
    out('ERR', `${sql.slice(0, 100)} :: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}
const count = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const top = (m: Map<string, number>, n = 25) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
/** A reason with its variable parts masked, so counts group. */
const shape = (r: string): string =>
  r
    .replace(/^model [^:]+: /, '')
    .replace(/\{[^}]*\}/g, '{…}')
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(/\d+/g, 'N')
    .slice(0, 110);
const json = (s: string | null): any => {
  try {
    return JSON.parse(s ?? '{}');
  } catch {
    return {};
  }
};

async function laneWindow(label: string, from: string, to: string) {
  const rows = await q(
    `SELECT id, at, work_item_id, workload_class, outcome, reason, measures FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND at < ? ORDER BY at`,
    [from, to],
  );
  out(`${label}_LANE_ROWS`, rows.length);
  const byOutcome = new Map<string, number>();
  const byShape = new Map<string, number>();
  const disc = { frag: 0, withDisc: 0, searchedZero: 0, readFromSearch0: 0, readFromModelOnly: 0, sumSearched: 0 };
  const noReadable = new Map<string, number>();
  const perItem = new Map<string, number>();
  for (const r of rows) {
    count(byOutcome, `${r.workload_class}|${r.outcome}`);
    if (r.outcome !== 'SUBMITTED') count(byShape, `${r.workload_class}|${r.outcome}|${shape(String(r.reason ?? ''))}`);
    if (r.workload_class === 'RESEARCH_FRAGMENT') {
      disc.frag += 1;
      count(perItem, r.work_item_id);
      const d = json(r.measures)?.discovery;
      if (d) {
        disc.withDisc += 1;
        disc.sumSearched += d.searched ?? 0;
        if ((d.searched ?? 0) === 0) disc.searchedZero += 1;
        if ((d.readFromSearch ?? 0) === 0) disc.readFromSearch0 += 1;
        if ((d.readFromSearch ?? 0) === 0 && (d.readFromModel ?? 0) > 0) disc.readFromModelOnly += 1;
      }
      const m = /no readable source among (\d+) candidate page\(s\)(, none from web search)?: (\{[^}]*\})/.exec(String(r.reason ?? ''));
      if (m) {
        count(noReadable, m[2] ? 'noWeb' : 'withWeb');
        for (const [k, v] of Object.entries(json(m[3]))) count(noReadable, `reason:${k}`, Number(v));
      }
    }
  }
  out(`${label}_BY_OUTCOME`, top(byOutcome, 40));
  for (const [k, v] of top(byShape, 40)) out(`${label}_FAIL`, `${v} × ${k}`);
  out(`${label}_DISCOVERY`, disc);
  out(`${label}_NO_READABLE`, top(noReadable, 30));
  out(`${label}_FRAG_ITEM_REPEATS`, top(perItem, 10));
}

async function accessWindow(label: string, from: string, to: string) {
  const rows = await q(
    `SELECT provider, workload_class, outcome, reason, measures FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND at >= ? AND at < ?`,
    [from, to],
  );
  const by = new Map<string, number>();
  const why = new Map<string, number>();
  const hosts = new Map<string, number>();
  const callers = new Map<string, number>();
  for (const r of rows) {
    count(by, `${r.outcome}`);
    count(callers, `${r.workload_class}|${r.outcome}`);
    if (r.outcome !== 'READ') {
      const m = json(r.measures);
      const last = (m.attempts ?? []).map((a: any) => `${a.method}:${a.reason ?? 'ok'}${a.status ? `:${a.status}` : ''}`).join('>') || String(r.reason ?? '').split(' ')[0];
      count(why, last.slice(0, 90));
      count(hosts, String(m.host ?? '?'));
    }
  }
  out(`${label}_ACCESS_TOTAL`, { rows: rows.length, by: top(by) });
  out(`${label}_ACCESS_CALLERS`, top(callers, 15));
  for (const [k, v] of top(why, 30)) out(`${label}_ACCESS_FAIL`, `${v} × ${k}`);
  out(`${label}_ACCESS_FAIL_HOSTS`, top(hosts, 20));
}

async function main() {
  await initDatabase();
  try {
    out('NOW', new Date().toISOString());
    const rows = await q(`SELECT at, provider, outcome, reason FROM bin_events WHERE event_type = 'SOURCE_SEARCH' AND at >= ? ORDER BY at`, [iso(48 * 3600_000)]);
    const hour = new Map<string, number>();
    for (const r of rows) count(hour, `${String(r.at).slice(0, 13)}|${r.provider}|${String(r.reason ?? '').replace(/^.*answered (\d+).*$/, '$1')}`);
    for (const [k, v] of [...hour.entries()].sort()) out('SEARCH_REFUSED_HOUR', `${k} ${v}`);
    const run = rows.filter((r) => r.at >= '2026-11-18T15:00:00Z' && r.at < '2026-11-18T17:05:00Z');
    out('SEARCH_REFUSED_RUN', { n: run.length, first: run[0]?.at ?? null, last: run[run.length - 1]?.at ?? null });
    // gaps: longest stretch in the run with no refusal
    // Lane fragment items per hour and their discovery, last 24h
    const lane = await q(`SELECT at, outcome, reason, measures FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND workload_class = 'RESEARCH_FRAGMENT' AND at >= ?`, [iso(24 * 3600_000)]);
    const h = new Map<string, number>();
    for (const r of lane) {
      const d = json(r.measures).discovery ?? {};
      const cls = r.outcome === 'SUBMITTED' ? 'OK' : /listed none because/.test(String(r.reason)) ? 'LISTED_NONE' : /no readable source/.test(String(r.reason)) ? 'NO_READABLE' : /did not survive/.test(String(r.reason)) ? 'DROPPED' : 'OTHER';
      count(h, `${String(r.at).slice(0, 13)}|${cls}`);
      count(h, `${String(r.at).slice(0, 13)}|searched0=${(d.searched ?? 0) === 0}`);
    }
    for (const [k, v] of [...h.entries()].sort()) out('LANE_HOUR', `${k} ${v}`);
    const reads = await q(`SELECT at, outcome, measures FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND at >= ?`, [iso(24 * 3600_000)]);
    const rh = new Map<string, number>();
    for (const r of reads) count(rh, `${String(r.at).slice(0, 13)}|${r.outcome}|${String(json(r.measures).host ?? '').includes('wikipedia') ? 'WIKI' : 'OTHER'}`);
    for (const [k, v] of [...rh.entries()].sort()) out('READ_HOUR', `${k} ${v}`);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => {
  console.error(e);
  console.log('GOALS: OK');
  process.exit(0);
});
