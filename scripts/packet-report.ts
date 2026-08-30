/**
 * `npm run report:packet` — one packet's authoritative rows, and nothing else.
 *
 * Read-only, on purpose and by construction: it opens the database, prints what
 * is there, and closes it. It creates no work, advances nothing, writes nothing
 * and takes no decision. Point it at a packet whenever you need to know what
 * the Brain actually holds rather than what a report said an hour ago.
 *
 *   npm run report:packet -- --orchestration orc_xxx
 *
 * It exists because the alternative is worse. Monitoring a live packet from
 * outside means either a connector (which is not always attached) or a person
 * relaying screenshots (which is the thing the worker architecture is supposed
 * to have removed). This runs where `verify-hosted.ts` and
 * `authorize-gap-policy.ts` run — inside the container, through
 * `flyctl ssh console`, from a workflow — so the answer comes from the rows.
 *
 * No credential is read, printed or required. Nothing here names a connection
 * string, a bucket key or a token: it reports what a project contains, never
 * where it is kept.
 */
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getDocument } from '../server/repos/documents.ts';
import { listAuditsByProject } from '../server/repos/audits.ts';
import {
  acceptedClaims,
  currentFragments,
  getOrchestration,
  listClaims,
  listPasses,
} from '../server/repos/research.ts';
import { listCoverage, listRequirements } from '../server/repos/reconciliation.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { readObject } from '../server/services/storage.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

/** One line, never wrapped, never a wall of JSON. */
function trim(value: string | null | undefined, width = 96): string {
  if (!value) return '—';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

async function main(): Promise<void> {
  if (!process.env['BRAIN_DATABASE_POOL_SIZE']) process.env['BRAIN_DATABASE_POOL_SIZE'] = '2';
  await initDatabase();

  const orchestrationId = flag('orchestration');
  if (!orchestrationId) {
    console.error('Usage: --orchestration orc_xxx');
    process.exitCode = 1;
    return;
  }

  const packet = await getOrchestration(orchestrationId);
  if (!packet) {
    console.error(`No orchestration ${orchestrationId}.`);
    process.exitCode = 1;
    return;
  }

  console.log('PACKET');
  console.log(`  id          ${packet.id}`);
  console.log(`  title       ${trim(packet.title)}`);
  console.log(`  status      ${packet.status}   pass ${packet.currentPass ?? '—'}`);
  console.log(`  gap policy  ${packet.unresolvedGapPolicy ?? 'not authorized'}` +
    (packet.unresolvedGapPolicy
      ? ` — by ${packet.unresolvedGapAuthorizedBy ?? '?'} at ${packet.unresolvedGapAuthorizedAt ?? '?'}`
      : ''));
  console.log(`  document    ${packet.documentId ?? '—'}`);
  console.log(`  audit       ${packet.auditId ?? '—'}   verdict ${packet.verdict ?? '—'}`);
  console.log(`  completed   ${packet.completedAt ?? '—'}`);
  console.log(`  failure     ${trim(packet.failureReason)}`);

  const fragments = await currentFragments(packet.id);
  console.log('');
  console.log(`FRAGMENTS (${fragments.length})`);
  for (const fragment of fragments) {
    console.log(
      `  ${fragment.fragmentKey.padEnd(28)} ${fragment.status.padEnd(11)}` +
        ` attempt ${fragment.attempt}/${fragment.maxRepairs}` +
        ` deps [${fragment.dependsOn.join(', ')}]` +
        ` reqs ${fragment.requirementIds.length}` +
        ` integrity ${fragment.integrityVerdict ?? '—'}` +
        ` sufficiency ${fragment.sufficiencyVerdict ?? '—'}`,
    );
    if (fragment.blockedReason) console.log(`      because   ${trim(fragment.blockedReason)}`);
  }

  const requirements = await listRequirements(packet.id);
  const coverage = await listCoverage(packet.id);
  const byRequirement = new Map(coverage.map((entry) => [entry.requirementId, entry]));
  console.log('');
  console.log(`REQUIREMENTS (${requirements.length})`);
  for (const requirement of requirements) {
    const entry = byRequirement.get(requirement.id);
    console.log(
      `  ${requirement.requirementKey.padEnd(28)} ${requirement.necessity.padEnd(10)}` +
        ` ${requirement.kind.padEnd(12)} coverage ${(entry?.status ?? 'no row').padEnd(22)}` +
        ` note ${entry?.userOverride ? 'yes' : 'no'}`,
    );
  }

  const items = (await listWorkItems(packet.projectId, { limit: 400 })).filter(
    (item) => item.orchestrationId === packet.id,
  );
  const live = items.filter((item) => item.state === 'QUEUED' || item.state === 'LEASED');
  console.log('');
  console.log(`WORK ITEMS (${items.length})`);
  const counted = new Map<string, number>();
  for (const item of items) {
    const key = `${item.workType} ${item.state}`;
    counted.set(key, (counted.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...counted].sort()) console.log(`  ${key.padEnd(34)} ${count}`);
  console.log(`  claimable now                      ${live.length}`);
  for (const item of live) {
    console.log(
      `      ${item.workType} ${item.id} ${item.state}` +
        ` attempt ${item.attemptCount}/${item.maxAttempts}` +
        (item.workerId ? ` held by ${item.workerId}` : ''),
    );
  }

  const claims = await listClaims(packet.id);
  const accepted = await acceptedClaims(packet.id);
  const passes = await listPasses(packet.id);
  const audits = (await listAuditsByProject(packet.projectId)).filter(
    (audit) => audit.runId === packet.runId,
  );
  console.log('');
  console.log('EVIDENCE');
  console.log(`  claims      ${claims.length} stored, ${accepted.length} accepted`);
  console.log(`  passes      ${passes.length}`);
  for (const pass of passes.filter((entry) => entry.passKey === 'AUDIT')) {
    console.log(`      audit role ordinal ${pass.ordinal} ${pass.status} ${pass.completedAt ?? ''}`);
  }
  console.log(`  audits      ${audits.length}`);
  for (const audit of audits) console.log(`      ${audit.id} ${audit.verdict} ${audit.gaps.length} gap(s)`);

  // The canonical artifact, proven by reading it back out of the configured
  // store rather than by trusting the row that points at it.
  let documentBytes = 0;
  let canonicalName = '—';
  if (packet.documentId) {
    const document = await getDocument(packet.documentId);
    canonicalName = document?.canonicalName ?? '—';
    if (document?.storageKey) {
      try {
        documentBytes = (await readObject(document.storageKey)).length;
      } catch (error) {
        console.log(`  document    unreadable: ${(error as Error).message}`);
      }
    }
    console.log(`  document    ${canonicalName} — ${documentBytes} byte(s)`);
  }

  const synth = items.filter((item) => item.workType === 'RESEARCH_SYNTHESIZE');
  console.log('');
  console.log(
    `PACKET-REPORT: OK status=${packet.status} claimable=${live.length}` +
      ` synth=${synth.length} audits=${audits.length} bytes=${documentBytes}`,
  );
}

main()
  .catch((error) => {
    console.error('PACKET-REPORT: FAILED', error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
