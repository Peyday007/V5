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
    const { ownActionMatches } = await import('../server/services/research/actorScope.ts');
    const { APPROVAL_ENVELOPES } = await import('../server/services/research/approvalEnvelope.ts');
    const rows = await getDb().all<Record<string, unknown>>("SELECT f.*, o.created_at AS orc_at, o.failure_reason FROM research_fragments f JOIN research_orchestrations o ON o.id = f.orchestration_id WHERE f.orchestration_id IN ('orc_84201256765147ee99d1','orc_dfc07997624240d898b3','orc_9734dd122b3048d792fb','orc_35442e9601f2463aaf39')");
    for (const r of rows) {
      const crit = (() => { try { return (JSON.parse(String(r.completion_criteria ?? '[]')) as string[]).join(' '); } catch { return String(r.completion_criteria ?? ''); } })();
      const prose = [r.question, r.definitions, r.population, crit].filter(Boolean).join(' \n');
      for (const [name, env] of Object.entries(APPROVAL_ENVELOPES)) {
        const m = ownActionMatches(prose, (env as { forbiddenActions: RegExp }).forbiddenActions);
        if (m.length) console.log(`MATCH ${r.orchestration_id} ${r.orc_at} ${name} ${JSON.stringify(m).slice(0, 700)}`);
      }
      console.log(`WHY ${r.orchestration_id} ${r.orc_at} ${String(r.failure_reason ?? '').slice(0, 300)}`);
    }
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
