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
import { describeLane, laneIds } from '../server/domain/evidenceLanes.ts';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { getDocument } from '../server/repos/documents.ts';
import { listAuditsByProject } from '../server/repos/audits.ts';
import {
  acceptedClaims,
  currentFragments,
  getOrchestration,
  listClaims,
  listClaimsForFragment,
  listPasses,
} from '../server/repos/research.ts';
import { listCoverage, listRequirements } from '../server/repos/reconciliation.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { objectExists, objectSize, readObject, storageKeyOf } from '../server/services/storage.ts';
import { getStorage, initStorage } from '../server/services/storage/index.ts';
import { getCurrentExtractionRun } from '../server/repos/extraction.ts';
import { listDocuments } from '../server/repos/documents.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

/** Break a long reason into readable lines, keeping every word of it. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (line.length + word.length + 1 > width && line.length > 0) {
      lines.push(line);
      line = '';
    }
    line = line.length > 0 ? `${line} ${word}` : word;
  }
  if (line.length > 0) lines.push(line);
  return lines;
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

  /**
   * And the store. Leaving this out is what made the first version of this
   * report lie, and it lied in the worst available direction.
   *
   * `getStorage()` falls back to a local provider when nothing has been
   * initialised — deliberately, for unit tests that never boot. A script that
   * opens the database and then reads documents therefore looks on the
   * machine's own disk while the bytes are in the bucket, and reports every
   * document in the project as missing. That reads exactly like the §18
   * failure it is not: rows saying SUPABASE, a store answering `local`, and
   * nothing found. `verify-hosted.ts` calls both, and so must this.
   *
   * `initStorage` verifies with a real operation, so reaching the next line is
   * itself the proof that the configured store answers.
   */
  await initStorage();

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
  // How this packet's plan is authorized, and by whom. A packet that approves
  // itself against limits nobody can name would be the worst thing in this
  // report to have to take on trust.
  console.log(
    `  approval    ${packet.approvalEnvelopeId ?? 'a person'}` +
      (packet.approvalEnvelopeId
        ? ` — authorized by ${packet.approvalEnvelopeAuthorizedBy ?? '?'} at ${packet.approvalEnvelopeAuthorizedAt ?? '?'}`
        : ''),
  );
  console.log(`  document    ${packet.documentId ?? '—'}`);
  console.log(`  audit       ${packet.auditId ?? '—'}   verdict ${packet.verdict ?? '—'}`);
  console.log(`  completed   ${packet.completedAt ?? '—'}`);
  /*
   * In full, wrapped, never trimmed.
   *
   * This was `trim(...)` at 96 characters like every other line, and on the
   * first automatic approval refusal it printed
   * `… fragment "licence-trigger" accepts …` and stopped — the exact sentence a
   * person is being escalated to read. A failure reason is the one field in
   * this report whose whole value is the part that does not fit on a line.
   */
  if (packet.failureReason) {
    console.log('  failure');
    for (const line of wrap(packet.failureReason, 92)) console.log(`      ${line}`);
  } else {
    console.log('  failure     —');
  }

  const fragments = await currentFragments(packet.id);
  console.log('');
  console.log(`FRAGMENTS (${fragments.length})`);
  for (const fragment of fragments) {
    console.log(
      `  ${fragment.fragmentKey.padEnd(28)} ${fragment.status.padEnd(11)}` +
        ` attempt ${fragment.attempt}/${fragment.maxRepairs}` +
        // Through `dependencyKeys`, because a dependency is an object with a
        // key and a kind. Joining the objects printed `[object Object]`, which
        // is exactly the field a reader checks when asking why a fragment has
        // not started.
        ` deps [${fragment.dependsOn.map((d) => `${d.key}:${d.kind}`).join(', ')}]` +
        ` reqs ${fragment.requirementIds.length}` +
        ` integrity ${fragment.integrityVerdict ?? '—'}` +
        ` sufficiency ${fragment.sufficiencyVerdict ?? '—'}`,
    );
    /**
     * The lanes, and how the claims are tagged against them.
     *
     * A fragment can hold accepted, sourced, verified, in-scope claims and
     * still fail its coverage check on a missing `evidence_lane` — which is
     * how the first fresh acceptance packet spent ten research attempts and
     * produced no document. Nothing in this report could see it: the fragment
     * line said `sufficiency INSUFFICIENT` and the claims all looked fine.
     *
     * So the two things that decide coverage are printed side by side: which
     * lanes the fragment declared, and what its accepted claims actually claim
     * to fill. `untagged` is the number this exists to make visible.
     */
    const mine = await listClaimsForFragment(fragment.id);
    const accepted = mine.filter((claim) => claim.accepted);
    const tally = new Map<string, number>();
    for (const claim of accepted) {
      const key = claim.evidenceLane ?? '(untagged)';
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    console.log(
      `      lanes     declared [${laneIds(fragment.requiredEvidence).join(', ')}]` +
        `  claims ${mine.length} (${accepted.length} accepted)` +
        `  untagged ${accepted.filter((claim) => !claim.evidenceLane).length}`,
    );
    if (tally.size > 0) {
      console.log(
        `      tagged    ${[...tally.entries()].map(([lane, n]) => `${lane}×${n}`).join(', ')}`,
      );
    }
    /**
     * Why the rejected claims were rejected, grouped.
     *
     * A fragment reading `integrity PASS` with nothing accepted is not a
     * contradiction — integrity is about the claims that survived, and it is
     * vacuously true when none did — but it means the fragment line alone
     * cannot tell "the evidence was good and unlabelled" from "every claim was
     * refused". Those need completely different responses, and the first fresh
     * acceptance packet looked like the first and may be the second.
     */
    const refused = mine.filter((claim) => !claim.accepted && claim.rejectionReason);
    if (refused.length > 0) {
      const reasons = new Map<string, number>();
      for (const claim of refused) {
        const key = trim(claim.rejectionReason, 72);
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
      for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
        console.log(`      rejected  ${String(n).padStart(3)} × ${reason}`);
      }
    }
    // And the lanes as declared, in full — they are matched by exact string, so
    // their exact text is the contract a worker has to reproduce.
    // Both halves, always: the id coverage counts by and the question it is
    // asking. A report that printed only one of them could not tell a reader
    // whether a lane was empty because nothing was found or because nothing
    // was tagged with the right key.
    // What this fragment says it may and may not cite. The evidence gate and
    // the approval envelope are both applied against these exact strings, so a
    // report that omits them cannot explain either verdict.
    console.log(
      `      sources   accepts [${fragment.acceptableSourceTypes.join(' | ')}]` +
        (fragment.excludedSourceTypes.length > 0
          ? `  excludes [${fragment.excludedSourceTypes.join(' | ')}]`
          : ''),
    );
    console.log(`      bar       min independent sources ${fragment.minIndependentSources}`);
    for (const lane of fragment.requiredEvidence) console.log(`      lane      ${describeLane(lane)}`);
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
  //
  // Resolved through `storageKeyOf`, which is what every reader in the app
  // uses: it prefers `storage_key` and falls back to `filesystem_path`, so a
  // row written before the storage abstraction still resolves. Reading
  // `storage_key` directly — which this did at first — reports a document as
  // missing that the Brain itself can serve perfectly well.
  let documentBytes = 0;
  let canonicalName = '—';
  if (packet.documentId) {
    const document = await getDocument(packet.documentId);
    canonicalName = document?.canonicalName ?? '—';
    const key = storageKeyOf(document);
    console.log(`  document    ${canonicalName} — id ${packet.documentId}`);
    console.log(`              version ${document?.version ?? '—'} · status ${document?.status ?? '—'} · type ${document?.documentType ?? '—'}`);
    // The two fields that tell "written somewhere else" apart from "never
    // written". `storage_provider` is recorded per document at write time
    // rather than inferred from configuration, so a row saying `local` on a
    // cloud-mode Brain means the bytes went to a machine disk that does not
    // survive a restart — which is a different fault, with a different fix,
    // from a key that never received an object at all. `file_size` is what the
    // writer believed it had written.
    console.log(`              storage_provider ${document?.storageProvider ?? '—'} · file_size ${document?.fileSize ?? '—'}`);
    console.log(`              storage_key     ${document?.storageKey ?? '—'}`);
    console.log(`              filesystem_path ${document?.filesystemPath ?? '—'}`);
    console.log(`              resolved key    ${key ?? '—'}`);
    console.log(`              superseded_by   ${document?.supersededByDocumentId ?? '—'}`);
    if (key) {
      console.log(`              exists          ${await objectExists(key)}`);
      const size = await objectSize(key);
      console.log(`              head size       ${size ?? '—'}`);
      try {
        documentBytes = (await readObject(key)).length;
      } catch (error) {
        console.log(`              READ FAILED     ${(error as Error).message}`);
      }
    }
    console.log(`              read bytes      ${documentBytes}`);

    // What the auditor actually read. The audit works from extracted blocks
    // rather than raw bytes, so a passing audit says nothing about whether the
    // file is still there — and that difference is exactly what has to be
    // visible when a packet is being closed.
    const extraction = await getCurrentExtractionRun(packet.documentId);
    console.log(
      `              extraction      ${extraction?.status ?? 'none'}` +
        (extraction ? ` · ${extraction.characterCount ?? 0} char(s) · ${extraction.pagesReadable ?? 0}/${extraction.pagesExpected ?? 0} page(s)` : ''),
    );
  }

  /**
   * Every document in the project, and whether its bytes are actually there.
   *
   * The summary is the diagnosis. One document missing out of many is a write
   * that failed for that document. *Every* document missing is not a document
   * problem at all — it means the rows and the store disagree about where the
   * bytes live, which is the §18 failure: a Brain writing research somewhere
   * nobody else can see it while reporting itself cloud-backed.
   */
  const documents = await listDocuments(packet.projectId);
  if (documents.length > 0) {
    const sized = await Promise.all(
      documents.map(async (document) => {
        const key = storageKeyOf(document);
        return { document, key, size: key ? await objectSize(key) : null };
      }),
    );
    const present = sized.filter((entry) => entry.size !== null);
    const missing = sized.filter((entry) => entry.size === null);
    console.log('');
    console.log(
      `PROJECT DOCUMENTS (${documents.length}) — ${present.length} with bytes, ${missing.length} missing`,
    );
    console.log(`  store       ${getStorage().kind} · ${getStorage().describe()}`);
    for (const entry of sized.slice(0, 40)) {
      console.log(
        `  ${(entry.document.canonicalName ?? entry.document.id).slice(0, 40).padEnd(42)}` +
          ` ${(entry.document.version ?? '—').padEnd(6)}` +
          ` ${(entry.document.storageProvider ?? '—').padEnd(9)}` +
          ` file_size ${String(entry.document.fileSize ?? '—').padEnd(8)}` +
          ` bytes ${entry.size ?? 'MISSING'}`,
      );
    }
    if (sized.length > 40) console.log(`  … and ${sized.length - 40} more`);
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
