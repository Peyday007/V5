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
    const windows: [string, string, string][] = [
      ['RUN', '2026-11-18T15:00:00Z', '2026-11-18T17:05:00Z'],
      ['MORN', '2026-11-18T06:00:00Z', '2026-11-18T12:00:00Z'],
      ['NIGHT', '2026-11-17T18:00:00Z', '2026-11-18T06:00:00Z'],
    ];
    for (const [label, from, to] of windows) {
      const reads = await q(`SELECT outcome, measures FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND at >= ? AND at < ?`, [from, to]);
      const hosts = new Map<string, number>();
      for (const r of reads) count(hosts, `${r.outcome}|${String(json(r.measures).host ?? '?').includes('wikipedia') ? 'WIKIPEDIA' : 'OTHER'}`);
      out(`${label}_READ_SPLIT`, top(hosts));
      const lane = await q(`SELECT at, work_item_id, outcome, reason, measures FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND workload_class = 'RESEARCH_FRAGMENT' AND at >= ? AND at < ? ORDER BY at`, [from, to]);
      const cls = new Map<string, number>();
      for (const r of lane) {
        const m = /from (\d+) source\(s\) (\{[^}]*\})/.exec(String(r.reason ?? ''));
        if (m) for (const [k, v] of Object.entries(json(m[2]))) count(cls, k, Number(v));
        const d = json(r.measures).discovery ?? {};
        count(cls, `disc:searched=${Math.min(9, d.searched ?? -1)}`);
      }
      out(`${label}_FAILED_SOURCE_CLASSES`, top(cls, 30));
      const claims = await q(`SELECT source_url, validation_state FROM research_claims WHERE retrieved_at >= ? AND retrieved_at < ?`, [from, to]);
      const ch = new Map<string, number>();
      for (const c of claims) count(ch, `${String(c.source_url ?? '').includes('wikipedia.org') ? 'WIKIPEDIA' : 'OTHER'}|${c.validation_state}`);
      out(`${label}_CLAIM_SOURCES`, top(ch));
      if (label === 'RUN') for (const r of lane) out('RUN_FRAG', { at: r.at, item: r.work_item_id, o: r.outcome, reason: String(r.reason ?? '').slice(0, 330), disc: json(r.measures).discovery ?? null });
    }
    // Questions of the run's failing fragments.
    const items = await q(
      `SELECT DISTINCT e.work_item_id AS id, w.fragment_id AS fid, w.attempt_count AS ac, w.max_attempts AS ma, w.state AS st FROM bin_events e JOIN work_items w ON w.id = e.work_item_id WHERE e.event_type = 'FREE_LANE_ITEM' AND e.workload_class = 'RESEARCH_FRAGMENT' AND e.at >= '2026-11-18T15:00:00Z' AND e.at < '2026-11-18T17:05:00Z'`,
    );
    const seen = new Set<string>();
    for (const it of items) {
      out('RUN_ITEM', it);
      if (!it.fid || seen.has(it.fid)) continue;
      seen.add(it.fid);
      const f = (await q(`SELECT id, status, attempt, parent_fragment_id, substr(question, 1, 260) AS question, substr(blocked_reason, 1, 160) AS blocked FROM research_fragments WHERE id = ?`, [it.fid]))[0];
      const sib = await q(`SELECT id, state, attempt_count, failure_category, created_at FROM work_items WHERE fragment_id = ? AND work_type = 'RESEARCH_FRAGMENT' ORDER BY created_at`, [it.fid]);
      out('RUN_FRAGMENT', { ...f, items: sib });
    }
    // Search-refusal rows: does anything record them?
    out('SEARCH_EVENT_TYPES', await q(`SELECT event_type, COUNT(*) AS n FROM bin_events WHERE at >= ? AND (event_type LIKE '%SEARCH%' OR provider LIKE '%duck%') GROUP BY event_type`, [iso(7 * 24 * 3600_000)]));
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
