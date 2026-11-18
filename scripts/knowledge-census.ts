/** Throwaway read-only probe (claude/probe-d1): leases, renewals, expiries, reclaims. SELECT only. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
const G = 'wst_7b4fcbb5f2384f31b6c3';
const A = '2026-11-18T15:00:00Z';
const B = '2026-11-18T17:10:00Z';
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(sql: string, args: unknown[] = []): Promise<any[]> {
  try { return await getDb().all(sql, args); } catch (e) { out('ERR', `${sql.slice(0, 100)} :: ${e instanceof Error ? e.message : e}`); return []; }
}
const ms = (a: string | null, b: string | null) => (a && b ? Date.parse(b) - Date.parse(a) : null);
const tally = (m: Map<string, any>, k: string, f: (x: any) => void, init: () => any) => { const v = m.get(k) ?? init(); f(v); m.set(k, v); };
async function main() {
  await initDatabase();
  try {
    out('NOW', new Date().toISOString());
    // 1. Leases claimed in the window, per work type / worker / outcome.
    const leases = await q(`SELECT l.work_item_id, l.lease_generation, l.worker_id, l.claimed_at, l.expires_at, l.last_heartbeat_at, l.heartbeat_count, l.ended_at, l.outcome, substr(l.detail,1,160) AS detail, l.attempt_number,
        w.work_type, w.state, w.attempt_count, w.max_attempts, w.orchestration_id, wk.name AS worker
      FROM work_leases l JOIN work_items w ON w.id = l.work_item_id LEFT JOIN workers wk ON wk.id = l.worker_id
      WHERE l.claimed_at >= ? AND l.claimed_at < ? ORDER BY l.claimed_at LIMIT 20000`, [A, B]);
    out('LEASES_N', leases.length);
    const agg = new Map<string, any>();
    for (const l of leases) {
      const key = `${l.worker}|${l.work_type}`;
      tally(agg, key, (v) => {
        v.claims += 1; v[`out_${l.outcome ?? 'OPEN'}`] = (v[`out_${l.outcome ?? 'OPEN'}`] ?? 0) + 1;
        if (Number(l.heartbeat_count) > 0) v.renewed += 1;
        v.hb += Number(l.heartbeat_count ?? 0);
        if (Number(l.lease_generation) > 1) v.reclaimGen += 1;
        const d = ms(l.claimed_at, l.ended_at); if (d !== null) { v.dur.push(Math.round(d / 1000)); }
        const leaseLen = ms(l.claimed_at, l.expires_at); if (leaseLen !== null) v.leaseLen.add(Math.round(leaseLen / 60000));
        if (l.ended_at && l.expires_at && l.ended_at > l.expires_at) v.endedAfterExpiry += 1;
      }, () => ({ claims: 0, renewed: 0, hb: 0, reclaimGen: 0, endedAfterExpiry: 0, dur: [] as number[], leaseLen: new Set<number>() }));
    }
    for (const [k, v] of agg) { const d = v.dur.sort((a: number, b: number) => a - b); out('LEASE_AGG', { k, ...v, dur: undefined, leaseLenMin: [...v.leaseLen], durN: d.length, durMed: d[Math.floor(d.length / 2)] ?? null, durP90: d[Math.floor(d.length * 0.9)] ?? null, durMax: d[d.length - 1] ?? null }); }
    const det = new Map<string, number>();
    for (const l of leases) { const k = `${l.work_type}|${l.outcome}|${String(l.detail ?? '').slice(0, 90)}`; det.set(k, (det.get(k) ?? 0) + 1); }
    for (const [k, n] of [...det].sort((a, b) => b[1] - a[1]).slice(0, 60)) out('LEASE_DETAIL', { k, n });
    // Leases on items the same item was later re-leased (generation chains)
    for (const r of await q(`SELECT w.work_type, l.outcome, COUNT(*) AS n FROM work_leases l JOIN work_items w ON w.id = l.work_item_id WHERE l.ended_at >= ? AND l.ended_at < ? AND l.outcome = 'EXPIRED' GROUP BY w.work_type, l.outcome`, [A, B])) out('EXPIRED_ENDED_IN_WINDOW', r);
    // 2. Free-lane item outcomes in window.
    const evs = await q(`SELECT e.at, e.outcome, substr(e.reason,1,220) AS reason, e.work_item_id, w.work_type, e.worker_id FROM bin_events e LEFT JOIN work_items w ON w.id = e.work_item_id WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at >= ? AND e.at < ? ORDER BY e.at LIMIT 20000`, [A, B]);
    out('FLI_N', evs.length);
    const ev = new Map<string, number>();
    for (const e of evs) { const r = String(e.reason ?? '').replace(/wki_[0-9a-f]+/g, 'wki_*').replace(/\d+/g, 'N').slice(0, 130); const k = `${e.work_type}|${e.outcome}|${r}`; ev.set(k, (ev.get(k) ?? 0) + 1); }
    for (const [k, n] of [...ev].sort((a, b) => b[1] - a[1]).slice(0, 80)) out('FLI', { k, n });
    for (const e of evs.filter((x: any) => /no longer current|FENCE|lease/i.test(x.reason ?? '')).slice(0, 40)) out('FLI_LEASE', e);
    // For lease-refused items: their lease history.
    const refused = [...new Set(evs.filter((x: any) => /no longer current|FENCE|lease/i.test(x.reason ?? '')).map((x: any) => x.work_item_id))].slice(0, 30);
    for (const id of refused) for (const l of await q(`SELECT l.work_item_id, l.lease_generation, wk.name AS worker, l.claimed_at, l.expires_at, l.heartbeat_count, l.ended_at, l.outcome, substr(l.detail,1,120) AS detail FROM work_leases l LEFT JOIN workers wk ON wk.id = l.worker_id WHERE l.work_item_id = ? ORDER BY l.lease_generation`, [id])) out('REFUSED_HIST', l);
    // 3. Stuck: LEASED with expired lease now.
    const now = new Date().toISOString();
    for (const r of await q(`SELECT work_type, CASE WHEN attempt_count >= max_attempts THEN 'EXHAUSTED' ELSE 'RECLAIMABLE' END AS k, COUNT(*) AS n, MIN(lease_expires_at) AS oldest FROM work_items WHERE state = 'LEASED' AND lease_expires_at <= ? GROUP BY work_type, CASE WHEN attempt_count >= max_attempts THEN 'EXHAUSTED' ELSE 'RECLAIMABLE' END`, [now])) out('STUCK_EXPIRED_LEASED', r);
    for (const r of await q(`SELECT id, work_type, attempt_count, max_attempts, lease_expires_at, orchestration_id, project_id FROM work_items WHERE state = 'LEASED' AND lease_expires_at <= ? ORDER BY lease_expires_at LIMIT 15`, [now])) out('STUCK_ROW', r);
    for (const r of await q(`SELECT work_type, state, failure_category, COUNT(*) AS n FROM work_items WHERE updated_at >= ? AND updated_at < ? GROUP BY work_type, state, failure_category ORDER BY n DESC LIMIT 60`, [A, B])) out('ITEMS_UPDATED', r);
    for (const r of await q(`SELECT work_type, failure_category, COUNT(*) AS n FROM work_items WHERE state = 'FAILED' AND updated_at >= ? GROUP BY work_type, failure_category`, ['2026-11-18T00:00:00Z'])) out('FAILED_TODAY', r);
    // 4. Never-claimed packets.
    for (const o of await q(`SELECT id, project_id, status, current_pass, goal_id, goal_packet_key, auto_approve, approved_at, created_at, updated_at, provider, model FROM research_orchestrations WHERE id LIKE 'orc_83fa%' OR id LIKE 'orc_f96e%'`)) {
      out('ORC', o);
      for (const w of await q(`SELECT id, work_type, state, priority, available_at, attempt_count, max_attempts, lease_generation, target_worker_id, required_scopes, bin_id, bundle_key, failure_category, created_at, updated_at, substr(payload,1,300) AS payload FROM work_items WHERE orchestration_id = ? ORDER BY created_at`, [o.id])) out('ORC_ITEM', w);
      for (const b of await q(`SELECT id, status, worker_id, lease_expires_at, created_at FROM bins WHERE orchestration_id = ? ORDER BY created_at`, [o.id])) out('ORC_BIN', b);
      for (const e of await q(`SELECT at, event_type, outcome, substr(reason,1,200) AS reason FROM bin_events WHERE orchestration_id = ? ORDER BY at DESC LIMIT 15`, [o.id])) out('ORC_EV', e);
    }
    // 5. Goal's research items: what's queued/claimable now and why not.
    const orcs = await q(`SELECT id, status, project_id, goal_packet_key, created_at FROM research_orchestrations WHERE goal_id = ? ORDER BY created_at DESC LIMIT 60`, [G]);
    out('GOAL_ORCS_N', orcs.length);
    for (const o of orcs.slice(0, 25)) out('GOAL_ORC', o);
    for (const r of await q(`SELECT w.work_type, w.state, CASE WHEN w.available_at > ? THEN 'FUTURE' ELSE 'NOW' END AS avail, CASE WHEN w.attempt_count >= w.max_attempts THEN 'SPENT' ELSE 'OK' END AS att, (w.target_worker_id IS NOT NULL) AS targeted, COUNT(*) AS n, MIN(w.created_at) AS oldest
        FROM work_items w JOIN research_orchestrations o ON o.id = w.orchestration_id WHERE o.goal_id = ? GROUP BY w.work_type, w.state, CASE WHEN w.available_at > ? THEN 'FUTURE' ELSE 'NOW' END, CASE WHEN w.attempt_count >= w.max_attempts THEN 'SPENT' ELSE 'OK' END, (w.target_worker_id IS NOT NULL)`, [now, G, now])) out('GOAL_ITEMS', r);
    for (const r of await q(`SELECT w.id, w.work_type, w.state, w.priority, w.available_at, w.attempt_count, w.max_attempts, w.target_worker_id, w.required_scopes, w.created_at, w.orchestration_id, o.status AS orc_status, (SELECT COUNT(*) FROM work_leases l WHERE l.work_item_id = w.id) AS leases
        FROM work_items w JOIN research_orchestrations o ON o.id = w.orchestration_id WHERE o.goal_id = ? AND w.state = 'QUEUED' ORDER BY w.created_at LIMIT 40`, [G])) out('GOAL_QUEUED', r);
    // Queued items anywhere never leased, older than 1h, per type
    for (const r of await q(`SELECT w.work_type, w.project_id, COUNT(*) AS n, MIN(w.created_at) AS oldest FROM work_items w WHERE w.state = 'QUEUED' AND w.created_at < ? AND w.lease_generation = 0 GROUP BY w.work_type, w.project_id ORDER BY n DESC LIMIT 30`, [new Date(Date.now() - 3600_000).toISOString()])) out('NEVER_LEASED_QUEUED', r);
    for (const r of await q(`SELECT id, name, worker_type, status FROM workers WHERE name LIKE '%free%' OR name LIKE '%lane%' OR name LIKE '%runpod%' OR name LIKE '%gpu%'`)) out('WORKER', r);
  } finally {
    await closeDatabase();
  }
  console.log('GOALS: OK');
}
main().catch((e) => { console.error(e); process.exit(1); });
