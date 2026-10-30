/**
 * Seed the public sources, check their robots.txt, print the report.
 *
 *   npx tsx server/services/collect/report/cli.ts [report|seed|robots]
 *
 * `seed` only inserts rows. `robots` fetches each publisher's robots.txt with
 * plain code, records the answer, and never works around a refusal. `report`
 * reads rows and prints. Run inside the deployed container, which has the
 * network the sources need.
 */
import { closeDatabase, initDatabase } from '../../../db/database.ts';
import { seedSources } from '../seeds/index.ts';
import { recordRobotsChecks } from '../seeds/robots.ts';
import { buildReport, renderReport } from './index.ts';

async function main(): Promise<void> {
  await initDatabase();
  const cmd = process.argv[2] ?? 'report';
  if (cmd === 'seed') {
    const rows = await seedSources();
    console.log(`seeded ${rows.length} source(s): ${rows.map((r) => `${r.slug}(${r.robotsStatus})`).join(', ')}`);
  } else if (cmd === 'robots') {
    const checks = await recordRobotsChecks(async (url) => {
      const res = await fetch(url, { headers: { 'user-agent': 'brain-feed/1.0' }, signal: AbortSignal.timeout(15_000) });
      return { status: res.status, body: await res.text() };
    });
    for (const c of checks) console.log(`${c.slug}: ${c.status} - ${c.note}`);
  } else {
    console.log(renderReport(await buildReport('tests/fixtures/collect-baseline/baseline.json')));
  }
  await closeDatabase();
  console.log('COLLECT: OK');
}

main().catch((error) => { console.error(`COLLECT: FAILED ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
