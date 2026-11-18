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
    const now = new Date().toISOString();
    const { freeLaneAdmits } = await import('../server/services/freeLane/worker.ts');
    const P = 'prj_22fb4fec295f403a8a22';
    // Goal's rounds and their packets
    const rounds = await q(`SELECT r.id, r.bucket_id, r.round, r.state, r.opened_at, r.candidate_id, m.id AS mission_id, m.orchestration_id FROM cash_discovery_rounds r LEFT JOIN russell_missions m ON m.candidate_id = r.candidate_id WHERE r.bucket_id LIKE ? ORDER BY r.opened_at DESC LIMIT 400`, [`goal-${G}%`]);
    out('ROUNDS_N', rounds.length);
    const rs = new Map<string, number>(); for (const r of rounds) { const k = `${r.state}|${r.orchestration_id ? 'packet' : 'nopacket'}`; rs.set(k, (rs.get(k) ?? 0) + 1); }
    out('ROUNDS_BY', Object.fromEntries(rs));
    for (const r of rounds.filter((x: any) => x.state === 'OPEN')) out('OPEN_ROUND', r);
    const orcIds = [...new Set(rounds.map((r: any) => r.orchestration_id).filter(Boolean))] as string[];
    const items: any[] = [];
    for (let i = 0; i < orcIds.length; i += 100) {
      const chunk = orcIds.slice(i, i + 100);
      items.push(...await q(`SELECT w.id, w.work_type, w.state, w.priority, w.available_at, w.attempt_count, w.max_attempts, w.lease_generation, w.lease_expires_at, w.target_worker_id, w.bin_id, w.orchestration_id, w.project_id, w.created_at, w.updated_at, w.failure_category FROM work_items w WHERE w.orchestration_id IN (${chunk.map(() => '?').join(',')})`, chunk));
    }
    out('GOAL_ITEMS_N', items.length);
    const by = new Map<string, number>();
    for (const w of items) { const k = `${w.work_type}|${w.state}|${w.failure_category ?? ''}|${w.attempt_count >= w.max_attempts ? 'SPENT' : 'ok'}|${w.lease_generation > 0 ? 'leased-before' : 'never-leased'}`; by.set(k, (by.get(k) ?? 0) + 1); }
    for (const [k, n] of [...by].sort((a, b) => b[1] - a[1])) out('GOAL_ITEMS_BY', { k, n });
    for (const w of items.filter((x: any) => x.state === 'QUEUED' || (x.state === 'LEASED' && x.lease_expires_at <= now))) {
      const purpose = (await q(`SELECT b.id, b.purpose, b.kind FROM bins b WHERE b.orchestration_id = ? ORDER BY b.created_at DESC LIMIT 1`, [w.orchestration_id]))[0] ?? null;
      let admits: unknown = null; try { admits = await freeLaneAdmits(w); } catch (e) { admits = `ERR ${e instanceof Error ? e.message : e}`; }
      out('GOAL_WAITING', { ...w, bin: purpose, freeLaneAdmits: admits, claimableNow: (w.state === 'QUEUED' ? w.available_at <= now : true) && w.attempt_count < w.max_attempts, waitedMin: Math.round((Date.now() - Date.parse(w.available_at)) / 60000) });
    }
    // Lease history of goal items in the window
    const gl = new Map<string, number>();
    for (let i = 0; i < orcIds.length; i += 100) {
      const chunk = orcIds.slice(i, i + 100);
      for (const r of await q(`SELECT w.work_type, l.outcome, COUNT(*) AS n FROM work_leases l JOIN work_items w ON w.id = l.work_item_id WHERE l.claimed_at >= ? AND w.orchestration_id IN (${chunk.map(() => '?').join(',')}) GROUP BY w.work_type, l.outcome`, [A, ...chunk])) { const k = `${r.work_type}|${r.outcome}`; gl.set(k, (gl.get(k) ?? 0) + Number(r.n)); }
    }
    out('GOAL_LEASES_SINCE_15', Object.fromEntries(gl));
    // Global invariant: QUEUED but spent (never claimable again)
    for (const r of await q(`SELECT work_type, COUNT(*) AS n, MIN(updated_at) AS oldest FROM work_items WHERE state = 'QUEUED' AND attempt_count >= max_attempts GROUP BY work_type`)) out('QUEUED_SPENT', r);
    for (const r of await q(`SELECT id, work_type, project_id, orchestration_id, attempt_count, max_attempts, updated_at FROM work_items WHERE state = 'QUEUED' AND attempt_count >= max_attempts ORDER BY updated_at DESC LIMIT 10`)) out('QUEUED_SPENT_ROW', r);
    for (const r of await q(`SELECT work_type, COUNT(*) AS n, MIN(available_at) AS soonest FROM work_items WHERE state = 'QUEUED' AND available_at > ? GROUP BY work_type`, [now])) out('QUEUED_FUTURE', r);
    // All currently claimable research items with admission verdict
    for (const w of await q(`SELECT id, work_type, priority, available_at, attempt_count, max_attempts, bin_id, orchestration_id, project_id, target_worker_id FROM work_items WHERE state = 'QUEUED' AND available_at <= ? AND attempt_count < max_attempts AND work_type LIKE 'RESEARCH_%' ORDER BY available_at LIMIT 40`, [now])) {
      const purpose = (await q(`SELECT b.id, b.purpose FROM bins b WHERE b.orchestration_id = ? ORDER BY b.created_at DESC LIMIT 1`, [w.orchestration_id]))[0] ?? null;
      let admits: unknown = null; try { admits = await freeLaneAdmits(w); } catch (e) { admits = `ERR ${e instanceof Error ? e.message : e}`; }
      const orc = (await q(`SELECT status, goal_id, auto_approve, approved_at FROM research_orchestrations WHERE id = ?`, [w.orchestration_id]))[0] ?? null;
      const proj = (await q(`SELECT slug, purpose FROM projects WHERE id = ?`, [w.project_id]))[0] ?? null;
      out('CLAIMABLE_NOW', { ...w, bin: purpose, freeLaneAdmits: admits, orc, proj, waitedMin: Math.round((Date.now() - Date.parse(w.available_at)) / 60000) });
    }
    // The two never-claimed packets: their fragments
    for (const id of ['wki_18aecae3f91c4efab785', 'wki_d714f56d387842e2a9c6']) {
      const w = (await q(`SELECT id, fragment_id, orchestration_id, bin_id, project_id, correlation_id, created_by_type, created_by_id FROM work_items WHERE id = ?`, [id]))[0];
      out('NC_ITEM', w);
      if (w?.fragment_id) for (const f of await q(`SELECT id, status, fragment_index, queued_at, substr(question,1,200) AS question, blocked_reason FROM research_fragments WHERE id = ?`, [w.fragment_id])) out('NC_FRAG', f);
      for (const b of await q(`SELECT id, purpose, kind, title, created_at FROM bins WHERE orchestration_id = ? ORDER BY created_at DESC LIMIT 3`, [w?.orchestration_id])) out('NC_BIN', b);
      for (const m of await q(`SELECT id, candidate_id, state, created_at FROM russell_missions WHERE orchestration_id = ?`, [w?.orchestration_id])) out('NC_MISSION', m);
      try { out('NC_ADMITS', await freeLaneAdmits(w)); } catch (e) { out('NC_ADMITS_ERR', String(e)); }
      for (const e of await q(`SELECT created_at, event_type, entity_type, substr(payload,1,300) AS payload FROM project_events WHERE entity_id IN (?, ?) ORDER BY created_at DESC LIMIT 8`, [w?.orchestration_id, id])) out('NC_EVENT', e);
    }
    for (const r of await q(`SELECT slug, purpose FROM projects WHERE id = ?`, [P])) out('PROJECT', r);
    // Audits waiting now: what has been claiming audits (last 30 min decisions)
    for (const r of await q(`SELECT e.outcome, substr(e.reason,1,60) AS reason, COUNT(*) AS n FROM bin_events e JOIN work_items w ON w.id = e.work_item_id WHERE e.event_type = 'FREE_LANE_ITEM' AND w.work_type = 'RESEARCH_AUDIT' AND e.at >= ? GROUP BY e.outcome, substr(e.reason,1,60)`, ['2026-11-18T12:00:00Z'])) out('AUDIT_FLI_SINCE_12', r);
  } finally {
    await closeDatabase();
  }
  console.log('GOALS: OK');
}
main().catch((e) => { console.error(e); process.exit(1); });
