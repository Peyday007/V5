/**
 * Read-only probe (claude/probe-price-answers, round 2): why goal-price research
 * ideas never launch. SELECT and pure reads only; never merged.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

const trim = (r: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}…` : v]));
async function q(label: string, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  try {
    const rows = await getDb().all<Record<string, unknown>>(sql, params as string[]);
    console.log(`${label} ${JSON.stringify(rows.map(trim))}`);
    return rows;
  } catch (e) {
    console.log(`${label} ERROR ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
    return [];
  }
}
async function step(label: string, fn: () => Promise<unknown>): Promise<void> {
  try { console.log(`${label} ${JSON.stringify(await fn())}`); } catch (e) { console.log(`${label} ERROR ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`); }
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    const PN = "SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%' AND candidate_id IS NOT NULL";
    const FRAGS = `SELECT f.id FROM russell_missions m JOIN research_fragments f ON f.orchestration_id = m.orchestration_id WHERE m.candidate_id IN (${PN})`;
    const tagged = await getDb().all<{ id: string; project_id: string; q: string | null; amt: number | null }>(`SELECT c.id, f.project_id, c.structural_qualifier AS q, c.structural_amount_cents AS amt FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id WHERE c.fragment_id IN (${FRAGS}) AND c.accepted = 1 AND c.structural_subject = 'price_per_unit'`);
    console.log(`TAGGED ${JSON.stringify(tagged.map((t) => ({ p: t.project_id.slice(0, 12), q: t.q, amt: t.amt })))}`);
    const { backfillCandidates } = await import('../server/services/industry/expand.ts');
    const ids = new Set(tagged.map((t) => t.id));
    for (const project of [...new Set(tagged.map((t) => t.project_id))]) {
      const pool = await backfillCandidates(project, { unitEconomic: '', constructed: '' });
      const mine = pool.decisions.filter((d) => d.claimId && ids.has(d.claimId));
      console.log(`DRYRUN ${project.slice(0, 12)} buyerTypes=${pool.hasBuyerTypes} read=${pool.unitEconomicRead} decisions=${pool.decisions.length} mine=${JSON.stringify(mine.map((d) => ({ s: d.source, r: d.reason, c: d.candidate ? { k: d.candidate.key, a: d.candidate.amount, b: d.candidate.buyer?.name ?? null } : null })))}`);
    }
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
