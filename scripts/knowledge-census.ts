/** Read-only probe (Surge B, 2026-11-20): claims refused on geography scope. SELECT only. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
const out = (k: string, v: unknown) => console.log(`${k} ${JSON.stringify(v)}`);
async function main(): Promise<void> {
  await initDatabase();
  const db = getDb();
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const safe = async (k: string, sql: string, p: unknown[] = []) => { try { out(k, await db.all(sql, p)); } catch (e) { out(k, { error: (e as Error).message }); } };
  const base = `FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id WHERE c.accepted = 0 AND c.rejection_reason LIKE 'Scope does not match on geography%' AND c.created_at > ?`;
  await safe('GEO_BY_FRAGMENT_GEOGRAPHY', `SELECT f.geography AS fg, COUNT(*) AS n ${base} GROUP BY f.geography ORDER BY n DESC LIMIT 15`, [since]);
  await safe('GEO_SCOPE_JSON_SAMPLE', `SELECT substr(c.scope_match, 1, 400) AS scope, substr(c.claim, 1, 220) AS claim, substr(f.question, 1, 260) AS question, f.geography AS fg, f.fragment_key AS fk, c.source_url AS url ${base} ORDER BY c.created_at DESC LIMIT 25`, [since]);
  await safe('GEO_BY_FRAGMENT_KEY', `SELECT f.fragment_key AS fk, COUNT(*) AS n ${base} GROUP BY f.fragment_key ORDER BY n DESC LIMIT 15`, [since]);
  await safe('ALL_REJECTIONS_48H', `SELECT substr(c.rejection_reason, 1, 60) AS why, COUNT(*) AS n FROM research_claims c WHERE c.accepted = 0 AND c.created_at > ? GROUP BY substr(c.rejection_reason, 1, 60) ORDER BY n DESC LIMIT 15`, [since]);
  console.log('CENSUS: OK');
  await closeDatabase();
  process.exit(0);
}
main().catch((e) => { console.log('PROBE FAILED', (e as Error).message); process.exit(0); });
