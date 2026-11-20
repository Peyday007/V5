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
    await q('FRAG_TEXT', "SELECT * FROM research_fragments WHERE orchestration_id IN ('orc_13a10aa965934ebdad5e','orc_9a2e71abe44d4df684a3') LIMIT 2");
    const { ownActionMatches } = await import('../server/services/research/actorScope.ts');
    const rows = await getDb().all<Record<string, unknown>>("SELECT * FROM research_fragments WHERE orchestration_id IN ('orc_13a10aa965934ebdad5e','orc_9a2e71abe44d4df684a3','orc_d5715b032b064be6b34e')");
    for (const r of rows) {
      const prose = Object.entries(r).filter(([k, v]) => typeof v === 'string' && /question|definition|population|criteria|completion/.test(k)).map(([, v]) => v as string).join(' \n');
      const m = ownActionMatches(prose, /\b(?:purchase|buy|pay|contact|email|call|sign|commit|publish|hire|subscribe)\b/i);
      console.log(`MATCH ${r.id} ${JSON.stringify(m)}`);
    }
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
