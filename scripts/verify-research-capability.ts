/**
 * `npm run verify:capability` — does a packet show the restored capability?
 *
 * Read-only, like `packet-report.ts`, and for the same reason: the question is
 * what the Brain actually holds, and the only honest answer comes from its own
 * rows. It creates no work, advances nothing, approves nothing and takes no
 * decision. Point it at a packet and it prints a pass/fail line per clause of
 * the capability contract, then exits non-zero if any clause failed.
 *
 *   npm run verify:capability -- --orchestration orc_xxx
 *
 * This is the acceptance instrument for a *fresh* packet. It must never be run
 * against `orc_f4850ad197474c22b5ea` as though passing there would mean
 * anything: that packet was researched by the engine before the correction, so
 * it is the control, not the experiment. The clauses below are written so that
 * it would fail several of them, which is the point.
 *
 * No credential is read, printed or required.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import {
  citableClaims,
  citableClaimCoverage,
  acceptedClaims,
  currentFragments,
  getOrchestration,
  listClaims,
  listFragments,
} from '../server/repos/research.ts';
import { listCoverage, listRequirements } from '../server/repos/reconciliation.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { getDocument } from '../server/repos/documents.ts';
import { objectExists, readObject, storageKeyOf } from '../server/services/storage.ts';
import { initStorage } from '../server/services/storage/index.ts';
import { dependencyKeys } from '../server/domain/dependencies.ts';
import { evaluateCapability } from '../server/services/research/capabilityCheck.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  if (!process.env['BRAIN_DATABASE_POOL_SIZE']) process.env['BRAIN_DATABASE_POOL_SIZE'] = '2';
  await initDatabase();
  // The store as well as the database — a report that opens one and not the
  // other reads every document as missing, which is indistinguishable from the
  // §18 failure it would then be reported as.
  await initStorage();

  const id = flag('orchestration');
  if (!id) {
    console.error('Usage: npm run verify:capability -- --orchestration orc_xxx');
    process.exitCode = 2;
    return;
  }

  const orchestration = await getOrchestration(id);
  if (!orchestration) {
    console.error(`No such orchestration: ${id}`);
    process.exitCode = 2;
    return;
  }

  const fragments = await currentFragments(id);
  const attempts = await listFragments(id);
  const claims = await listClaims(id);
  const citable = await citableClaims(id);
  const accepted = await acceptedClaims(id);
  const coverage = await citableClaimCoverage(id);
  const requirements = await listRequirements(id);
  const requirementCoverage = await listCoverage(id);
  const items = (await listWorkItems(orchestration.projectId, { limit: 500 })).filter(
    (item) => item.orchestrationId === id,
  );
  const live = items.filter((item) => item.state === 'QUEUED' || item.state === 'LEASED');

  console.log(`\nPacket ${id} — ${orchestration.status}`);
  console.log(`  fragments ${fragments.length} current / ${attempts.length} attempts`);
  console.log(`  claims ${claims.length} submitted / ${citable.length} citable / ${accepted.length} from accepted fragments`);
  console.log(`  requirements ${requirements.length}, work items ${items.length} (${live.length} live)\n`);

  const document = orchestration.documentId ? await getDocument(orchestration.documentId) : null;
  const key = storageKeyOf(document);
  const documentText =
    document && key && (await objectExists(key)) ? (await readObject(key)).toString('utf8') : null;

  const clauses = evaluateCapability({
    orchestration,
    fragments,
    attempts,
    claims,
    citable,
    accepted,
    coverage,
    requirements,
    requirementCoverage,
    items,
    documentText,
  });
  const typed = fragments.flatMap((fragment) => fragment.dependsOn);

  // --- Report -------------------------------------------------------------
  console.log('CAPABILITY ACCEPTANCE');
  let failed = 0;
  let vacuous = 0;
  for (const clause of clauses) {
    if (!clause.ok) failed += 1;
    else if (clause.vacuous) vacuous += 1;
    // Three states, not two. A clause the packet gave nothing to judge has not
    // passed, and printing it as PASS is how an instrument flatters what it
    // measures.
    const mark = !clause.ok ? 'FAIL' : clause.vacuous ? 'N/EX' : 'PASS';
    console.log(`  ${mark}  ${clause.id.padEnd(4)} ${clause.what}`);
    console.log(`              ${clause.detail}`);
  }
  const passed = clauses.length - failed - vacuous;
  console.log(
    `\n${passed}/${clauses.length} clauses passed` +
      (vacuous > 0 ? `, ${vacuous} not exercised by this packet` : '') +
      (failed > 0 ? `, ${failed} failed. The packet does not meet the capability contract.` : '.'),
  );
  // Fragment keys, so a reader can see the breadth rather than infer it.
  console.log(`\nFragments: ${fragments.map((f) => `${f.fragmentKey}:${f.status}`).join(', ')}`);
  if (typed.length > 0) {
    console.log(`Dependencies: ${fragments
      .filter((f) => f.dependsOn.length > 0)
      .map((f) => `${f.fragmentKey}<-${dependencyKeys(f.dependsOn).join('+')}`)
      .join(', ')}`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  })
  .finally(() => closeDatabase());
