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
    // 1. The GPU run window, and the last 24h.
    await laneWindow('RUN', '2026-11-18T15:00:00Z', '2026-11-18T17:05:00Z');
    await laneWindow('D1', iso(24 * 3600_000), new Date().toISOString());
    await accessWindow('RUN', '2026-11-18T15:00:00Z', '2026-11-18T17:05:00Z');
    await accessWindow('D1', iso(24 * 3600_000), new Date().toISOString());

    // 2. Repeats: one work item failing the same way again and again (§15).
    const bb = await q(
      `SELECT at, work_item_id, workload_class, outcome, substr(reason, 1, 220) AS reason, measures FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND (reason LIKE '%bug bounty%' OR reason LIKE '%Better Business%' OR reason LIKE '%queueing theory%') ORDER BY at`,
      [iso(24 * 3600_000)],
    );
    const items = [...new Set(bb.map((r) => r.work_item_id))];
    out('OFFTOPIC_ROWS', bb.length);
    for (const r of bb) out('OFFTOPIC', { at: r.at, item: r.work_item_id, o: r.outcome, reason: r.reason, disc: json(r.measures).discovery ?? null });
    for (const id of items.slice(0, 8)) {
      const w = (await q(`SELECT id, work_type, state, attempt_count, max_attempts, fragment_id, orchestration_id, created_at, updated_at, completed_at, failure_category, substr(result_summary,1,200) AS rs FROM work_items WHERE id = ?`, [id]))[0];
      out('OFFTOPIC_ITEM', w ?? id);
      if (w?.fragment_id) {
        const f = (await q(`SELECT id, status, attempt, repair_strategy, substr(repair_reason,1,200) AS repair_reason, substr(question, 1, 700) AS question, substr(blocked_reason, 1, 300) AS blocked, parent_fragment_id, updated_at FROM research_fragments WHERE id = ?`, [w.fragment_id]))[0];
        out('OFFTOPIC_FRAGMENT', f ?? w.fragment_id);
        const o = (await q(`SELECT id, project_id, status, title FROM research_orchestrations WHERE id = ?`, [w.orchestration_id]))[0];
        out('OFFTOPIC_ORCH', o ?? w.orchestration_id);
        const sib = await q(`SELECT id, work_type, state, attempt_count, created_at FROM work_items WHERE fragment_id = ? ORDER BY created_at`, [w.fragment_id]);
        out('OFFTOPIC_FRAGMENT_ITEMS', sib);
      }
    }
    // Pages read for those items (what search handed the model).
    for (const id of items.slice(0, 3)) {
      const reads = await q(
        `SELECT at, outcome, substr(reason, 1, 200) AS reason FROM bin_events WHERE event_type = 'SOURCE_ACCESS' AND work_item_id = ? ORDER BY at LIMIT 20`,
        [id],
      );
      out('OFFTOPIC_READS_BY_ITEM', { id, n: reads.length, reads });
    }

    // 3. Items read more than N times by the lane in 24h, with how many distinct reasons.
    const reps = await q(
      `SELECT work_item_id, COUNT(*) AS n, SUM(CASE WHEN outcome = 'SUBMITTED' THEN 1 ELSE 0 END) AS ok, MIN(at) AS first, MAX(at) AS last FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND workload_class = 'RESEARCH_FRAGMENT' AND at >= ? GROUP BY work_item_id ORDER BY n DESC LIMIT 12`,
      [iso(24 * 3600_000)],
    );
    out('REPEATED_ITEMS', reps);

    // 4. WORK_FAULTED: fragments blocked "finished without recording anything", 7 days.
    const since7 = iso(7 * 24 * 3600_000);
    const faulted = await q(
      `SELECT id, orchestration_id, updated_at, substr(blocked_reason, 1, 60) AS br FROM research_fragments WHERE status = 'BLOCKED' AND blocked_reason LIKE 'A % work item for this fragment finished without recording%' AND updated_at >= ?`,
      [since7],
    );
    out('FAULTED_FRAGMENTS_7D', faulted.length);
    const what = new Map<string, number>();
    const day = new Map<string, number>();
    for (const f of faulted) {
      count(what, String(f.br).replace(/^A /, '').replace(/ work item.*/, ''));
      count(day, String(f.updated_at).slice(0, 10));
    }
    out('FAULTED_BY_WHAT', top(what));
    out('FAULTED_BY_DAY', top(day, 10));
    const evs = await q(
      `SELECT COUNT(*) AS n FROM project_events WHERE event_type = 'RESEARCH_FRAGMENT_REJECTED' AND created_at >= ? AND payload LIKE '%finished without recording%'`,
      [since7],
    );
    out('FAULTED_EVENTS_7D', evs);
    // The last lane reason on each faulted fragment's items: is it acquisition?
    const cls = new Map<string, number>();
    const clsWhat = new Map<string, number>();
    let joined = 0;
    const ids = faulted.map((f) => f.id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const marks = chunk.map(() => '?').join(',');
      const rows = await q(
        `SELECT w.fragment_id AS fid, w.work_type AS wt, e.at AS at, e.outcome AS outcome, e.reason AS reason FROM bin_events e JOIN work_items w ON w.id = e.work_item_id WHERE e.event_type = 'FREE_LANE_ITEM' AND w.fragment_id IN (${marks})`,
        chunk,
      );
      const last = new Map<string, any>();
      for (const r of rows) {
        if (r.outcome === 'SUBMITTED') continue;
        const k = `${r.fid}|${r.wt}`;
        const prev = last.get(r.fid);
        if (!prev || prev.at < r.at) last.set(r.fid, r);
        void k;
      }
      for (const r of last.values()) {
        joined += 1;
        const s = String(r.reason ?? '');
        const c = /no readable source/.test(s)
          ? /none from web search/.test(s)
            ? 'ACQ_NO_READABLE_NO_WEB'
            : 'ACQ_NO_READABLE'
          : /listed no claims because/.test(s)
            ? 'MODEL_NO_CLAIMS(sources off-topic?)'
            : /did not survive/.test(s)
              ? 'CHECKS_DROPPED'
              : /lease is no longer current|not current/.test(s)
                ? 'LEASE_LOST'
                : /model call failed|no JSON/.test(s)
                  ? 'MODEL_PROVIDER'
                  : /refused/.test(s)
                    ? 'SUBMIT_REFUSED'
                    : 'OTHER:' + shape(s).slice(0, 50);
        count(cls, c);
        count(clsWhat, `${r.wt}|${c}`);
      }
    }
    out('FAULTED_WITH_LANE_ROWS', joined);
    out('FAULTED_LAST_LANE_REASON', top(cls, 30));
    out('FAULTED_LAST_LANE_REASON_BY_TYPE', top(clsWhat, 30));
    // work items that ended FAILED (attempts exhausted), 7d, by type and failure category
    out(
      'ITEMS_FAILED_7D',
      await q(
        `SELECT work_type, state, failure_category, COUNT(*) AS n FROM work_items WHERE updated_at >= ? AND state IN ('FAILED', 'DEAD', 'CANCELLED') GROUP BY work_type, state, failure_category ORDER BY n DESC LIMIT 25`,
        [since7],
      ),
    );
    // Lane fragments by day: share whose failure is acquisition
    const dayRows = await q(
      `SELECT substr(at, 1, 10) AS d, outcome, CASE WHEN reason LIKE '%no readable source%none from web search%' THEN 'NO_READABLE_NO_WEB' WHEN reason LIKE '%no readable source%' THEN 'NO_READABLE' WHEN reason LIKE '%listed no claims%' THEN 'NO_CLAIMS' WHEN outcome = 'SUBMITTED' THEN 'OK' ELSE 'OTHER' END AS c, COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND workload_class = 'RESEARCH_FRAGMENT' AND at >= ? GROUP BY substr(at, 1, 10), outcome, CASE WHEN reason LIKE '%no readable source%none from web search%' THEN 'NO_READABLE_NO_WEB' WHEN reason LIKE '%no readable source%' THEN 'NO_READABLE' WHEN reason LIKE '%listed no claims%' THEN 'NO_CLAIMS' WHEN outcome = 'SUBMITTED' THEN 'OK' ELSE 'OTHER' END ORDER BY 1`,
      [since7],
    );
    for (const r of dayRows) out('LANE_FRAG_DAY', r);
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
