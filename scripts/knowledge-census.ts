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
    const T = '2026-11-18T17:50:00Z';
    const leases = await q(`SELECT l.work_item_id, l.lease_generation, l.claimed_at, l.expires_at, l.last_heartbeat_at, l.heartbeat_count, l.ended_at, l.outcome, substr(l.detail,1,100) AS detail, w.work_type, wk.name AS worker
      FROM work_leases l JOIN work_items w ON w.id = l.work_item_id LEFT JOIN workers wk ON wk.id = l.worker_id WHERE l.claimed_at >= ? ORDER BY l.claimed_at LIMIT 20000`, [T]);
    out('LEASES_N', leases.length);
    const agg = new Map<string, any>();
    for (const l of leases) {
      const k = `${l.worker}|${l.work_type}`;
      const v = agg.get(k) ?? { claims: 0, hbPos: 0, hbTotal: 0, expired: 0, open: 0, succeeded: 0, failed: 0, released: 0, cancelled: 0, heldOver20: 0, heldOver20Succeeded: 0, maxHeldS: 0 };
      v.claims += 1; const hb = Number(l.heartbeat_count ?? 0); if (hb > 0) v.hbPos += 1; v.hbTotal += hb;
      const o = l.outcome ?? 'OPEN';
      if (o === 'EXPIRED') v.expired += 1; else if (o === 'OPEN') v.open += 1; else if (o === 'SUCCEEDED') v.succeeded += 1; else if (o === 'FAILED') v.failed += 1; else if (o === 'RELEASED') v.released += 1; else v.cancelled += 1;
      const end = l.ended_at ? Date.parse(l.ended_at) : Date.now(); const held = (end - Date.parse(l.claimed_at)) / 1000;
      if (held > 1200) { v.heldOver20 += 1; if (o === 'SUCCEEDED') v.heldOver20Succeeded += 1; }
      v.maxHeldS = Math.max(v.maxHeldS, Math.round(held));
      agg.set(k, v);
    }
    for (const [k, v] of agg) out('LEASE_AGG', { k, ...v });
    for (const l of leases.filter((x: any) => x.work_type === 'RESEARCH_AUDIT' || Number(x.heartbeat_count) > 0 || x.outcome === 'EXPIRED')) out('LEASE_ROW', { ...l, heldS: Math.round(((l.ended_at ? Date.parse(l.ended_at) : Date.now()) - Date.parse(l.claimed_at)) / 1000) });
    const evs = await q(`SELECT e.at, e.outcome, substr(e.reason,1,160) AS reason, e.work_item_id, w.work_type, e.duration_ms FROM bin_events e LEFT JOIN work_items w ON w.id = e.work_item_id WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at >= ? ORDER BY e.at`, [T]);
    out('FLI_N', evs.length);
    const ev = new Map<string, number>();
    for (const e of evs) { const r = String(e.reason ?? '').replace(/\d+/g, 'N').slice(0, 110); const k = `${e.work_type}|${e.outcome}|${r}`; ev.set(k, (ev.get(k) ?? 0) + 1); }
    for (const [k, n] of [...ev].sort((a, b) => b[1] - a[1]).slice(0, 50)) out('FLI', { k, n });
    out('LEASE_REFUSALS', evs.filter((e: any) => /lease is (no longer current|not current)/i.test(e.reason ?? '')).length);
    for (const e of evs.filter((x: any) => x.work_type === 'RESEARCH_AUDIT')) out('AUDIT_EVENT', e);
    // Accepted claims: created after T, and accepted claims on fragments accepted/completed after T
    for (const r of await q(`SELECT accepted, COUNT(*) AS n FROM research_claims WHERE created_at >= ? GROUP BY accepted`, [T])) out('CLAIMS_CREATED_SINCE', r);
    for (const r of await q(`SELECT COUNT(*) AS n, COUNT(DISTINCT c.fragment_id) AS frags FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id WHERE c.accepted = 1 AND (f.accepted_at >= ? OR f.completed_at >= ?)`, [T, T])) out('ACCEPTED_CLAIMS_FRAG_JUDGED_SINCE', r);
    for (const r of await q(`SELECT f.status, COUNT(*) AS n FROM research_fragments f WHERE f.completed_at >= ? OR f.accepted_at >= ? GROUP BY f.status`, [T, T])) out('FRAGMENTS_JUDGED_SINCE', r);
    for (const r of await q(`SELECT work_type, state, COUNT(*) AS n FROM work_items WHERE completed_at >= ? GROUP BY work_type, state`, [T])) out('ITEMS_COMPLETED_SINCE', r);
    for (const r of await q(`SELECT work_type, CASE WHEN attempt_count >= max_attempts THEN 'EXHAUSTED' ELSE 'RECLAIMABLE' END AS k, COUNT(*) AS n FROM work_items WHERE state = 'LEASED' AND lease_expires_at <= ? GROUP BY work_type, CASE WHEN attempt_count >= max_attempts THEN 'EXHAUSTED' ELSE 'RECLAIMABLE' END`, [new Date().toISOString()])) out('STUCK_EXPIRED_LEASED', r);
  } finally {
    await closeDatabase();
  }
  console.log('GOALS: OK');
}
main().catch((e) => { console.error(e); process.exit(1); });
