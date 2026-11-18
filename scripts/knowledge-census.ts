/** Throwaway read-only probe (claude/probe-d3): research acceptance and claim storage. SELECT only. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
const G = 'wst_7b4fcbb5f2384f31b6c3';
const W0 = '2026-11-18T14:55:00Z';
const W1 = '2026-11-18T17:10:00Z';
const D24 = new Date(Date.now() - 24 * 3_600_000).toISOString();
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(tag: string, sql: string, args: unknown[] = []): Promise<any[]> {
  try { const rows = await getDb().all(sql, args); for (const r of rows) out(tag, r); if (rows.length === 0) out(tag, 'NONE'); return rows; }
  catch (e) { out('ERR', `${tag} :: ${e instanceof Error ? e.message : e}`); return []; }
}
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
async function main(): Promise<void> {
  await initDatabase();
  try {
    // 1. Every non-SUBMITTED free-lane item in the GPU window, full reason.
    await q('FLI', `SELECT at, outcome, workload_class, work_item_id, SUBSTR(reason, 1, 700) AS reason FROM bin_events
       WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND at <= ? AND reason NOT LIKE '%lease is no longer current%' ORDER BY at`, [W0, W1]);
    // 2. Fragments touched by the free lane in window, with status and verdicts.
    const frs = await q('FRAG', `SELECT DISTINCT f.id, f.status, f.attempt, f.integrity_verdict, f.sufficiency_verdict, f.block_cause, SUBSTR(f.blocked_reason,1,400) AS blocked, f.completed_at, f.updated_at, f.orchestration_id, SUBSTR(f.question,1,140) AS q,
        (SELECT COUNT(*) FROM research_claims c WHERE c.fragment_id = f.id) AS claims,
        (SELECT COUNT(*) FROM research_claims c WHERE c.fragment_id = f.id AND c.accepted = 1) AS acc
       FROM bin_events e JOIN work_items w ON w.id = e.work_item_id JOIN research_fragments f ON f.id = w.fragment_id
       WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at >= ? AND e.at <= ?`, [W0, W1]);
    const fids = frs.map((f) => f.id);
    if (fids.length) {
      await q('FCLAIM', `SELECT id, fragment_id, accepted, validation_state, sourced, retrieval_state, evidence_lane, derived, contradiction_state, created_at, SUBSTR(source_url,1,120) AS url, SUBSTR(rejection_reason,1,350) AS why, SUBSTR(claim,1,140) AS claim
         FROM research_claims WHERE fragment_id IN (${marks(fids.length)}) ORDER BY created_at`, fids);
      await q('FWORK', `SELECT id, work_type, state, attempt_count, fragment_id, failure_category, SUBSTR(result_summary,1,300) AS summary, created_at, completed_at FROM work_items WHERE fragment_id IN (${marks(fids.length)}) ORDER BY created_at`, fids);
      await q('FDECL', `SELECT id, SUBSTR(required_evidence,1,700) AS lanes, min_independent_sources, timeframe FROM research_fragments WHERE id IN (${marks(fids.length)})`, fids);
    }
    // 3. All claims created in the GPU window, any path.
    await q('WCLAIMSUM', `SELECT accepted, validation_state, retrieval_state, SUBSTR(COALESCE(rejection_reason,'(null)'),1,40) AS code, COUNT(*) AS n FROM research_claims WHERE created_at >= ? AND created_at <= ? GROUP BY accepted, validation_state, retrieval_state, SUBSTR(COALESCE(rejection_reason,'(null)'),1,40) ORDER BY n DESC`, [W0, W1]);
    // 4. 24h: rejection reasons by leading text, all claims.
    await q('R24', `SELECT accepted, validation_state, SUBSTR(COALESCE(rejection_reason,'(null)'),1,70) AS head, COUNT(*) AS n FROM research_claims WHERE created_at >= ? GROUP BY accepted, validation_state, SUBSTR(COALESCE(rejection_reason,'(null)'),1,70) ORDER BY n DESC LIMIT 60`, [D24]);
    // 5. Goal orchestrations.
    const orch = (await q('GORCH', `SELECT DISTINCT m.orchestration_id AS oid, r.state, r.opened_at FROM cash_discovery_rounds r JOIN russell_missions m ON m.candidate_id = r.candidate_id
       WHERE r.bucket_id LIKE ? AND m.orchestration_id IS NOT NULL AND r.opened_at >= ? ORDER BY r.opened_at DESC LIMIT 60`, [`goal-${G}%`, '2026-11-16T00:00:00Z'])).map((r) => r.oid);
    if (orch.length) {
      await q('GO_STATUS', `SELECT id, status, SUBSTR(COALESCE(failure_reason,''),1,200) AS fr, created_at, completed_at, failed_at FROM research_orchestrations WHERE id IN (${marks(orch.length)})`, orch);
      await q('GF', `SELECT id, orchestration_id, status, attempt, integrity_verdict, sufficiency_verdict, block_cause, SUBSTR(blocked_reason,1,300) AS blocked, created_at, updated_at,
          (SELECT COUNT(*) FROM research_claims c WHERE c.fragment_id = f.id) AS claims, (SELECT COUNT(*) FROM research_claims c WHERE c.fragment_id = f.id AND c.accepted = 1) AS acc
         FROM research_fragments f WHERE orchestration_id IN (${marks(orch.length)}) ORDER BY updated_at DESC LIMIT 80`, orch);
      await q('GC24', `SELECT accepted, validation_state, retrieval_state, SUBSTR(COALESCE(rejection_reason,'(null)'),1,300) AS why, evidence_lane, fragment_id, id, created_at FROM research_claims WHERE orchestration_id IN (${marks(orch.length)}) AND created_at >= ? ORDER BY created_at DESC LIMIT 120`, [...orch, D24]);
      await q('GW', `SELECT work_type, state, failure_category, COUNT(*) AS n FROM work_items WHERE orchestration_id IN (${marks(orch.length)}) AND created_at >= ? GROUP BY work_type, state, failure_category`, [...orch, D24]);
    }
    // 6. Storage integrity.
    await q('INV_ACC_NOT_SOURCED', `SELECT validation_state, sourced, retrieval_state, COUNT(*) AS n FROM research_claims WHERE accepted = 1 AND (validation_state <> 'SOURCED' OR sourced <> 1) GROUP BY validation_state, sourced, retrieval_state`);
    await q('INV_ACC_BY_FSTATUS', `SELECT f.status, COUNT(*) AS n FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id WHERE c.accepted = 1 AND c.created_at >= ? GROUP BY f.status`, [D24]);
    await q('INV_ACC_NO_FRAG', `SELECT COUNT(*) AS n FROM research_claims WHERE accepted = 1 AND fragment_id IS NULL AND created_at >= ?`, [D24]);
    await q('INV_ACC_WITH_REASON', `SELECT SUBSTR(rejection_reason,1,80) AS r, COUNT(*) AS n FROM research_claims WHERE accepted = 1 AND rejection_reason IS NOT NULL GROUP BY SUBSTR(rejection_reason,1,80) ORDER BY n DESC LIMIT 10`);
    await q('INV_REJ_NO_REASON_JUDGED', `SELECT f.status, COUNT(*) AS n FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id WHERE c.accepted = 0 AND c.rejection_reason IS NULL AND c.created_at >= ? GROUP BY f.status`, [D24]);
    await q('FSTATUS_24', `SELECT status, COUNT(*) AS n, MIN(updated_at) AS oldest FROM research_fragments WHERE updated_at >= ? GROUP BY status`, [D24]);
    await q('FSTUCK', `SELECT f.status, COUNT(*) AS n, MIN(f.updated_at) AS oldest_update FROM research_fragments f JOIN research_orchestrations o ON o.id = f.orchestration_id
       WHERE f.status IN ('RUNNING','VALIDATING','QUEUED','PLANNED') AND o.status NOT IN ('COMPLETE','COMPLETE_WITH_GAPS','FAILED','CANCELLED') GROUP BY f.status`);
    await q('FSTUCK_NOWORK', `SELECT f.id, f.status, f.updated_at, o.status AS ostatus FROM research_fragments f JOIN research_orchestrations o ON o.id = f.orchestration_id
       WHERE f.status IN ('RUNNING','VALIDATING') AND f.updated_at < ? AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.fragment_id = f.id AND w.state IN ('QUEUED','LEASED')) ORDER BY f.updated_at DESC LIMIT 30`, [new Date(Date.now() - 2 * 3_600_000).toISOString()]);
    await q('FSTATUSES_ALL', `SELECT status, COUNT(*) AS n FROM research_fragments GROUP BY status`);
    await q('FRAG_CLAIMS_UNJUDGED', `SELECT f.status, COUNT(DISTINCT f.id) AS frags, COUNT(c.id) AS claims FROM research_fragments f JOIN research_claims c ON c.fragment_id = f.id
       WHERE c.accepted = 0 AND c.rejection_reason IS NULL AND c.created_at >= ? GROUP BY f.status`, [D24]);
    await q('AUDIT_WORK_FRAG_STATE', `SELECT f.status AS fstatus, w.state, COUNT(*) AS n FROM work_items w JOIN research_fragments f ON f.id = w.fragment_id WHERE w.work_type = 'RESEARCH_AUDIT' AND w.created_at >= ? GROUP BY f.status, w.state`, [D24]);
    // 7. The two named accepted claims, end to end.
    for (const id of ['clm_1468e302%', 'clm_9cf1f15c%']) {
      const c = await q('NAMED', `SELECT id, orchestration_id, fragment_id, pass_id, pass_key, job_id, accepted, validation_state, validation_detail, sourced, retrieval_state, evidence_lane, contradiction_state, rejection_reason, SUBSTR(source_url,1,160) AS url, SUBSTR(evidence_excerpt,1,200) AS ex, evidence_locator, source_date, retrieved_at, content_hash, created_at, SUBSTR(claim,1,200) AS claim, requirement_ids, derived, derived_from FROM research_claims WHERE id LIKE ?`, [id]);
      for (const row of c) {
        await q('NAMED_FRAG', `SELECT id, status, attempt, integrity_verdict, sufficiency_verdict, completed_at, accepted_at, SUBSTR(verdict_detail,1,300) AS vd FROM research_fragments WHERE id = ?`, [row.fragment_id]);
        await q('NAMED_PASS', `SELECT id, pass_key, status, provider, model, executor_worker_id, started_at, completed_at FROM research_passes WHERE id = ?`, [row.pass_id]);
        await q('NAMED_ORCH', `SELECT id, status, project_id, created_at, completed_at FROM research_orchestrations WHERE id = ?`, [row.orchestration_id]);
        await q('NAMED_ROUND', `SELECT r.id, r.bucket_id, r.state, r.opened_at, r.closed_at, m.id AS mission, m.status AS mstatus FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id WHERE m.orchestration_id = ?`, [row.orchestration_id]);
        await q('NAMED_DUPS', `SELECT id, accepted, fragment_id, created_at FROM research_claims WHERE content_hash = ? ORDER BY created_at`, [row.content_hash]);
        await q('NAMED_USE', `SELECT 'construction' AS k, id, fact_key AS f, status FROM construction_facts WHERE source_claim_id = ? UNION ALL SELECT 'card', id, field, '' FROM cash_card_facts WHERE claim_id = ? UNION ALL SELECT 'finding', id, state, '' FROM shared_findings WHERE claim_id = ?`, [row.id, row.id, row.id]);
        await q('NAMED_WORK', `SELECT id, work_type, state, attempt_count, failure_category, created_at, completed_at FROM work_items WHERE fragment_id = ? ORDER BY created_at`, [row.fragment_id]);
      }
    }
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
