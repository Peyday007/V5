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
    // A. accepted claims (24h) by fragment status and block cause, and whether each reached anything downstream.
    await q('ACC_BLOCKED_CAUSE', `SELECT f.status, COALESCE(f.block_cause,'-') AS cause, COUNT(*) AS n,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM cash_card_facts x WHERE x.claim_id = c.id) OR EXISTS (SELECT 1 FROM construction_facts y WHERE y.source_claim_id = c.id) OR EXISTS (SELECT 1 FROM cash_opportunities o WHERE o.source_claim_id = c.id) THEN 1 ELSE 0 END) AS used,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM shared_findings s WHERE s.claim_id = c.id AND s.state = 'ACTIVE') THEN 1 ELSE 0 END) AS finding
       FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id WHERE c.accepted = 1 AND c.created_at >= ? GROUP BY f.status, COALESCE(f.block_cause,'-') ORDER BY n DESC`, [D24]);
    await q('ACC_BLOCKED_ORCH', `SELECT o.status AS ostatus, f.block_cause AS cause, COUNT(*) AS n FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id JOIN research_orchestrations o ON o.id = c.orchestration_id
       WHERE c.accepted = 1 AND f.status = 'BLOCKED' AND c.created_at >= ? GROUP BY o.status, f.block_cause ORDER BY n DESC`, [D24]);
    await q('MOSTLY_REJ_SAMPLE', `SELECT f.id, f.orchestration_id, SUBSTR(f.question,1,160) AS q, f.geography, SUBSTR(f.blocked_reason,1,260) AS br,
        (SELECT COUNT(*) FROM research_claims c WHERE c.fragment_id = f.id AND c.accepted = 1) AS acc, (SELECT COUNT(*) FROM research_claims c WHERE c.fragment_id = f.id) AS n, f.updated_at
       FROM research_fragments f WHERE f.status = 'BLOCKED' AND f.block_cause = 'MOSTLY_REJECTED' AND f.updated_at >= ? ORDER BY f.updated_at DESC LIMIT 25`, [D24]);
    await q('MOSTLY_REJ_REASONS', `SELECT SUBSTR(COALESCE(c.rejection_reason,'(null)'),1,60) AS head, COUNT(*) AS n FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id
       WHERE f.status = 'BLOCKED' AND f.block_cause = 'MOSTLY_REJECTED' AND f.updated_at >= ? AND c.accepted = 0 GROUP BY SUBSTR(COALESCE(c.rejection_reason,'(null)'),1,60) ORDER BY n DESC LIMIT 25`, [D24]);
    // B. 21 unexplained rejections on BLOCKED fragments.
    await q('NOREASON', `SELECT f.id, f.block_cause, f.updated_at, SUBSTR(f.blocked_reason,1,200) AS br, COUNT(c.id) AS n, MIN(c.created_at) AS c0 FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id
       WHERE c.accepted = 0 AND c.rejection_reason IS NULL AND c.created_at >= ? GROUP BY f.id, f.block_cause, f.updated_at, f.blocked_reason`, [D24]);
    // C. Scope refusals: placeholder market and UNKNOWN geography, with what was judged.
    await q('SCOPE_ANY', `SELECT c.id, c.fragment_id, SUBSTR(c.claim,1,220) AS claim, SUBSTR(c.source_url,1,120) AS url, SUBSTR(c.scope_match,1,400) AS sm, SUBSTR(f.question,1,200) AS q, f.geography
       FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id WHERE c.rejection_reason LIKE 'Scope does not match on geography (mismatch vs "the market%' AND c.created_at >= ? LIMIT 10`, [D24]);
    await q('SCOPE_UNK', `SELECT c.id, c.fragment_id, SUBSTR(c.claim,1,220) AS claim, SUBSTR(c.source_url,1,120) AS url, SUBSTR(c.scope_match,1,400) AS sm, f.geography
       FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id WHERE c.rejection_reason LIKE 'Scope does not match on geography (unknown%' AND c.created_at >= ? ORDER BY c.created_at DESC LIMIT 12`, [D24]);
    await q('SCOPE_MIS_PA', `SELECT c.id, SUBSTR(c.claim,1,200) AS claim, SUBSTR(c.source_url,1,100) AS url, SUBSTR(c.scope_match,1,300) AS sm
       FROM research_claims c WHERE c.rejection_reason LIKE 'Scope does not match on geography (mismatch vs "Pennsylvania")%' AND c.created_at >= ? ORDER BY c.created_at DESC LIMIT 8`, [D24]);
    await q('UNREAD_REJ', `SELECT c.id, c.fragment_id, c.retrieval_state, SUBSTR(c.source_url,1,120) AS url, SUBSTR(c.rejection_reason,1,200) AS why, SUBSTR(c.scope_match,1,200) AS sm FROM research_claims c
       WHERE c.accepted = 0 AND (c.rejection_reason LIKE '%unreadable%' OR c.rejection_reason LIKE '%could not be read%' OR c.rejection_reason LIKE '%network error%' OR c.rejection_reason LIKE '%could not be fetched%' OR c.rejection_reason LIKE '%UNREADABLE%') AND c.created_at >= ? LIMIT 20`, [new Date(Date.now() - 7 * 86_400_000).toISOString()]);
    await q('UNREAD_REJ7', `SELECT COUNT(*) AS n FROM research_claims c WHERE c.accepted = 0 AND c.retrieval_state = 'RETRIEVED' AND (c.rejection_reason LIKE '%unreadable%' OR c.rejection_reason LIKE '%network error%' OR c.rejection_reason LIKE '%could not be fetched%' OR c.rejection_reason LIKE '%could not be opened%' OR c.rejection_reason LIKE '%UNREADABLE%' OR c.rejection_reason LIKE '%not load%') AND c.created_at >= ?`, [new Date(Date.now() - 7 * 86_400_000).toISOString()]);
    // D. 7-day picture of fragment outcomes by block cause.
    await q('BLOCK7', `SELECT COALESCE(block_cause,'-') AS cause, COUNT(*) AS n FROM research_fragments WHERE status = 'BLOCKED' AND updated_at >= ? GROUP BY COALESCE(block_cause,'-') ORDER BY n DESC`, [new Date(Date.now() - 7 * 86_400_000).toISOString()]);
    await q('BLOCK24', `SELECT COALESCE(block_cause,'-') AS cause, COUNT(*) AS n FROM research_fragments WHERE status = 'BLOCKED' AND updated_at >= ? GROUP BY COALESCE(block_cause,'-') ORDER BY n DESC`, [D24]);
    // E. Mostly-rejected with the placeholder market.
    await q('ANYMKT_FRAGS', `SELECT f.status, f.block_cause, COUNT(*) AS n FROM research_fragments f WHERE f.geography = 'the market this question names' AND f.updated_at >= ? GROUP BY f.status, f.block_cause`, [new Date(Date.now() - 7 * 86_400_000).toISOString()]);
    await q('ANYMKT_CLAIMS', `SELECT c.accepted, SUBSTR(COALESCE(c.rejection_reason,'(null)'),1,70) AS head, COUNT(*) AS n FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id WHERE f.geography = 'the market this question names' AND c.created_at >= ? GROUP BY c.accepted, SUBSTR(COALESCE(c.rejection_reason,'(null)'),1,70) ORDER BY n DESC LIMIT 15`, [new Date(Date.now() - 7 * 86_400_000).toISOString()]);
    await q('ROUND_COLS', `SELECT * FROM cash_discovery_rounds WHERE bucket_id LIKE ? ORDER BY opened_at DESC LIMIT 1`, [`goal-${G}%`]);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
