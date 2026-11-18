/** Throwaway read-only probe (claude/probe-d5): rounds, missions, plan freshness, learning records. SELECT only. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { signalledClaims } from '../server/repos/research.ts';
import { observationExpiry } from '../server/domain/opportunitySignals.ts';
const G = 'wst_7b4fcbb5f2384f31b6c3';
const P = 'prj_22fb4fec295f403a8a22';
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(tag: string, sql: string, args: unknown[] = []): Promise<any[]> {
  try { const rows = await getDb().all(sql, args as any); for (const r of rows) out(tag, r); if (!rows.length) out(tag, 'NONE'); return rows; }
  catch (e) { out('ERR', `${tag} :: ${e instanceof Error ? e.message : e}`); return []; }
}
async function main() {
  await initDatabase();
  const since24 = new Date(Date.now() - 24 * 3600e3).toISOString();
  
  try {
    out('NOW', new Date().toISOString());
    const now = new Date();
    const t0 = Date.now();
    let sig: any[] = [];
    try { sig = await signalledClaims({ projectId: P, limit: 40, staleBefore: new Date(now.getTime() - 30 * 86_400_000).toISOString() }); }
    catch (e) { out('SIGNALLED_ERR', `${Date.now() - t0}ms ${e instanceof Error ? e.message : e}`); }
    out('SIGNALLED', { n: sig.length, ms: Date.now() - t0, oldest: sig[0]?.claim.createdAt ?? null, newest: sig[sig.length - 1]?.claim.createdAt ?? null });
    const reasons: Record<string, number> = {};
    for (const e of sig) {
      const c = e.claim;
      let why = 'WOULD_FILE';
      if (!c.opportunitySignal) why = 'no_signal';
      else if (!c.sourceUrl) why = 'no_url';
      else if (c.claimType === 'NEGATIVE_EXISTENCE') why = 'negative';
      else {
        const timing = observationExpiry({ signal: c.opportunitySignal, closesOn: c.closesOn ?? null, sourceDate: c.sourceDate, freshDays: 30, now });
        if (timing.stale) why = 'stale';
      }
      reasons[why] = (reasons[why] ?? 0) + 1;
      out('SIG_ROW', { id: c.id, at: c.createdAt, sig: c.opportunitySignal, lane: c.evidenceLane, src: c.sourceDate, closes: c.closesOn, why });
    }
    out('SIG_REASONS', reasons);
    // unrestricted page count: how many rows the SQL alone would return (no stale filter), to see if 20 pages x 40 is exhausted
    const t1 = Date.now();
    let sig2: any[] = [];
    try { sig2 = await signalledClaims({ projectId: P, limit: 400, staleBefore: new Date(now.getTime() - 30 * 86_400_000).toISOString() }); } catch (e) { out('SIGNALLED2_ERR', String(e)); }
    out('SIGNALLED_400', { n: sig2.length, ms: Date.now() - t1, newest: sig2[sig2.length - 1]?.claim.createdAt ?? null });
    const r2: Record<string, number> = {};
    for (const e of sig2) { const c = e.claim; const timing = c.opportunitySignal ? observationExpiry({ signal: c.opportunitySignal, closesOn: c.closesOn ?? null, sourceDate: c.sourceDate, freshDays: 30, now }) : { stale: true }; const k = timing.stale ? 'stale' : 'fresh'; r2[k] = (r2[k] ?? 0) + 1; }
    out('SIG400_REASONS', r2);
    await q('CYCLE', `SELECT last_ran_at, substr(COALESCE(last_error,''),1,1500) AS err FROM russell_cycle`);
    await q('CASH_EVENTS_72H', `SELECT kind, COUNT(*) AS n, MAX(created_at) AS last FROM cash_events WHERE project_id = ? AND created_at >= ? GROUP BY kind ORDER BY n DESC LIMIT 25`, [P, new Date(Date.now() - 96 * 3600e3).toISOString()]);
    await q('CASH_EVENT_OPP', `SELECT kind, created_at, substr(summary,1,200) AS s FROM cash_events WHERE project_id = ? AND (kind LIKE '%OPPORTUNITY%' OR kind LIKE '%HARVEST%' OR kind LIKE '%ROUND%') ORDER BY created_at DESC LIMIT 10`, [P]);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
