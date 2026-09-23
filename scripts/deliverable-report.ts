/**
 * What deliverables exist, where each got to, and whether its files still open.
 *
 * Read-only. Every line resolves to a row: the deliverable, each version with
 * its status, reason, size and sha-256, every check item, the reviewer's
 * verdict and independence tier, and the conversation message that delivered
 * it. With `--verify` it also reads each version's bytes back out of the
 * configured store, re-hashes them against the row and opens them with jszip
 * (and mammoth for a document) — which is the proof that a delivered file
 * opens after the worker session that built it has ended, taken from the
 * store the link serves rather than from anything a worker kept.
 *
 * Usage:  node --import tsx scripts/deliverable-report.ts [--project prj_…] [--deliverable dlv_…] [--verify]
 */
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';
import { getStorage, initStorage } from '../server/services/storage/index.ts';
import { listProjects } from '../server/repos/projects.ts';
import { getDeliverable, listDeliverablesForProject, listFindings, listVersions } from '../server/repos/deliverables.ts';
import type { Deliverable } from '../server/domain/deliverables.ts';

function flag(name: string): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1] ?? null;
}

function trim(value: string | null | undefined, width = 110): string {
  if (!value) return '—';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

async function report(d: Deliverable, verify: boolean): Promise<void> {
  console.log(`\n${d.id}  "${d.title}"  project=${d.projectId}`);
  console.log(`  kind=${d.kind} format=${d.format} requested=${d.requestedFormat ?? '—'} state=${d.state} builds=${d.buildCount} reviews=${d.reviewCount}`);
  console.log(`  conversation=${d.conversationId ?? '—'} asked-in=${d.requestedMessageId ?? '—'}`);
  console.log(`  reason: ${trim(d.stateReason)}`);
  console.log(`  current=${d.currentVersionId ?? '— (nothing has passed yet)'}  pending-correction=${trim(d.pendingCorrection, 80)}`);
  for (const need of d.needs) console.log(`  need: ${need.capability} — ${trim(need.detail)}`);
  console.log(`  required contents: ${d.spec.requiredContents.map((r, i) => `${i}. ${trim(r, 60)}`).join(' | ')}`);
  for (const v of await listVersions(d.id)) {
    const marker = v.id === d.currentVersionId ? '*' : ' ';
    console.log(`  ${marker}v${v.versionNumber} ${v.status} reason=${v.reason} ${v.filename} ${v.byteSize}B sha256=${v.fileHash.slice(0, 16)}… build=${v.buildBinId}`);
    if (v.reasonDetail) console.log(`      because: ${trim(v.reasonDetail)}`);
    console.log(`      key=${v.storageKey}`);
    console.log(`      cited claims=${v.citedClaimIds.length} readers=${v.checkReport.readers.join(', ')} measures=${JSON.stringify(v.checkReport.measures)}`);
    for (const item of v.checkReport.items) console.log(`      ${item.passed ? 'PASS' : 'FAIL'} ${item.code}: ${trim(item.detail, 100)}`);
    if (v.reviewReport) {
      console.log(`      review ${v.reviewReport.verdict} by ${v.reviewerSessionRef ?? '—'} (${v.reviewIndependence ?? '—'}) bin=${v.reviewBinId}: ${trim(v.reviewReport.summary)}`);
      for (const f of v.reviewReport.findings) console.log(`        ${f.severity} ${trim(f.about, 40)}: ${trim(f.statement, 90)}`);
    }
    console.log(`      announced=${v.announcedAt ?? '—'} message=${v.announcedMessageId ?? '—'}`);
    if (verify) {
      try {
        const bytes = await getStorage().get(v.storageKey);
        const hash = createHash('sha256').update(bytes).digest('hex');
        const zip = await JSZip.loadAsync(bytes);
        let words = '';
        if (d.format === 'DOCX') {
          const mammoth = (await import('mammoth')).default;
          words = ` words=${(await mammoth.extractRawText({ buffer: bytes })).value.split(/\s+/).filter(Boolean).length}`;
        }
        console.log(`      VERIFY ${hash === v.fileHash ? 'OK' : 'HASH MISMATCH'} bytes=${bytes.length} parts=${Object.keys(zip.files).length}${words}`);
      } catch (error) {
        console.log(`      VERIFY FAILED ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const findings = await listFindings(d.id);
  const open = findings.filter((f) => !f.resolvedByVersionId);
  console.log(`  findings=${findings.length} open=${open.length}`);
  for (const f of findings) console.log(`    ${f.resolvedByVersionId ? 'resolved' : 'open    '} ${f.stage} ${f.severity} ${f.code}: ${trim(f.message, 90)}`);
}

async function main(): Promise<void> {
  await initDatabase();
  await initStorage();
  const verify = process.argv.includes('--verify');
  const only = flag('deliverable');
  const project = flag('project');
  let count = 0;
  if (only) {
    const d = await getDeliverable(only);
    if (d) {
      await report(d, verify);
      count = 1;
    } else console.log(`No deliverable ${only}.`);
  } else {
    for (const p of await listProjects()) {
      if (project && p.id !== project) continue;
      for (const d of await listDeliverablesForProject(p.id)) {
        await report(d, verify);
        count += 1;
      }
    }
  }
  console.log(`\nDELIVERABLE-REPORT: OK deliverables=${count}`);
}

main()
  .catch((error) => {
    const pooler = describePoolerRefusal(error);
    console.error('DELIVERABLE-REPORT: FAILED', pooler ?? error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
