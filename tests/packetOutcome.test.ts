/**
 * What a judge's verdict means for the packet, asked again when the rows change.
 *
 * Two defects, found together on the Step 10 acceptance packet and fixed
 * together because either one alone still leaves the bin stuck.
 *
 * **D1 — the outcome was derived once and never again.** `outcomeFor` is a pure
 * function of the verdict, whether any fragment is still repairable, and
 * whether a person authorized the packet to record unresolved gaps. Two of
 * those change *after* the verdict by design: the authorization is given
 * afterwards, by a named administrator, to a packet that stopped in order to
 * ask for it. It was evaluated only at `brain_submit_audit`, so the packet
 * stopped at NEEDS_HUMAN saying it needed an authorization, and granting the
 * authorization did nothing whatsoever. A state that says "waiting for a
 * person" and cannot be resolved by that person is not waiting.
 *
 * **D2 — the bin contract accepted only `COMPLETE`.** `COMPLETE_WITH_GAPS` is
 * a terminal state of the same runner, over a packet that filed a real report
 * and was audited by all three roles. Refusing it is the failure Step 10's own
 * plan predicted in advance: "a bin that drains but cannot terminalize because
 * a contract is stricter than the work path can satisfy" — the worker is
 * dispatched at it on every activation, forever, for a packet that is over.
 *
 * The inversions are the point of the file. Neither fix may become a way for a
 * packet to declare itself finished: without the authorization the packet still
 * stops, a repairable fragment still outranks filing, an unreadable document
 * still refuses the bin, and FAILED and CANCELLED still complete nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createWorker } from '../server/repos/identity.ts';
import { createAudit } from '../server/repos/audits.ts';
import { createDocument } from '../server/repos/documents.ts';
import { storeFile } from '../server/services/storage.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  finishPass,
  getOrchestration,
  startPass,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { createBin, getBin } from '../server/repos/bins.ts';
import { evaluateContract } from '../server/services/bins/contracts.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import { authorizeUnresolvedGaps } from '../server/services/research/gapPolicy.ts';
import { createUser } from '../server/repos/identity.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import type { BinManifest, ResearchOrchestration } from '../server/domain/types.ts';

let projectId = '';
let projectSlug = '';
let layerId = '';
let layerSlug = '';
let workerId = '';
let adminId = '';
let adminEmail = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  projectSlug = fixture.project.slug;
  const layers = await listLayers(projectId);
  layerId = layers[0]!.id;
  layerSlug = layers[0]!.slug;
  workerId = (
    await createWorker({
      name: `w-${Math.random().toString(36).slice(2, 8)}`,
      createdByType: 'SYSTEM',
      createdById: 'test',
    })
  ).id;
  adminEmail = `admin-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const admin = await createUser({
    email: adminEmail,
    displayName: 'The operator',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  adminId = admin.id;
});

function manifest(): BinManifest {
  return {
    objective: 'Drain one real research packet.',
    why: 'Step 10 needs one bounded real bin.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [],
    acceptableSources: ['the declared primary law'],
    excludedSources: ['a law-firm summary'],
    evidence: ['a filed report'],
    outputs: ['one document'],
    authorizedActions: ['research the declared question'],
    prohibitedActions: ['any spend beyond the allowance'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the packet is terminal'],
  };
}

/**
 * The shape the live packet was actually in: every fragment ACCEPTED, a report
 * filed with real bytes, all three audit roles in, and a judge who said
 * MORE_RESEARCH.
 */
async function judgedPacket(
  over: {
    verdict?: string;
    blockedFragment?: boolean;
    documentBytes?: string | null;
    withAudit?: boolean;
  } = {},
): Promise<{ orchestrationId: string; binId: string; documentId: string | null }> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a bounded licensing question',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'a bounded licensing question',
    assignment: 'the four things that answer it',
    provider: 'WORKER',
    autoApprove: false,
  });

  const base = {
    orchestrationId: orchestration.id,
    projectId,
    layerId,
    geography: 'Michigan',
    requiredEvidence: [
      { id: 'operative_definition', description: 'the statute', necessity: 'REQUIRED' },
    ],
    acceptableSourceTypes: ['Michigan Occupational Code (MCL) full text'],
    excludedSourceTypes: ['law-firm articles'],
    completionCriteria: ['a quoted primary provision'],
    minIndependentSources: 1,
    maxRepairs: 2,
  } as unknown as Parameters<typeof createFragments>[0][number];

  await createFragments([
    {
      ...base,
      fragmentIndex: 0,
      fragmentKey: 'licence-trigger',
      question: 'What conduct triggers the licence?',
      dependsOn: [],
      attempt: 1,
    },
    {
      ...base,
      fragmentIndex: 1,
      fragmentKey: 'consequences',
      question: 'What follows from doing it unlicensed?',
      dependsOn: [{ key: 'licence-trigger', kind: 'HARD' }],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const at = new Date().toISOString();
  for (const fragment of await currentFragments(orchestration.id)) {
    const blocked = over.blockedFragment === true && fragment.fragmentKey === 'consequences';
    await updateFragment(fragment.id, {
      status: blocked ? 'BLOCKED' : 'ACCEPTED',
      completedAt: at,
      blockedReason: blocked ? 'The pages cited did not support the claims.' : null,
    });
  }

  let documentId: string | null = null;
  if (over.documentBytes !== null) {
    const contents = over.documentBytes ?? '# Monetization Logic v1C\n\nThe filed report.\n';
    const stored = await storeFile({
      projectSlug,
      layerSlug,
      filename: `report-${Math.random().toString(36).slice(2, 8)}.md`,
      contents: Buffer.from(contents),
    });
    const document = await createDocument({
      projectId,
      layerId,
      canonicalName: `Monetization Logic v1C ${Math.random().toString(36).slice(2, 6)}`,
      version: 'v1C',
      versionSort: '000001.003',
      wave: 1,
      documentType: 'EXPANSION',
      status: 'COMPLETE',
      filename: stored.relativePath.split('/').pop()!,
      filesystemPath: stored.relativePath,
      fileSize: stored.size,
      fileHash: stored.hash,
      runId: run.id,
    } as unknown as Parameters<typeof createDocument>[0]);
    documentId = document.id;
  }

  // All three roles, in order, exactly as `earlierAuditRole` reads them.
  // Without these the runner would enqueue the audit rather than reach the
  // verdict, and the test would be measuring a different branch.
  for (const ordinal of [5, 6, 7]) {
    const pass = await startPass({
      orchestrationId: orchestration.id,
      passKey: 'AUDIT',
      ordinal,
      provider: 'WORKER',
      model: workerId,
      prompt: `audit pass ${ordinal}`,
      promptSha256: 'x'.repeat(64),
    });
    await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}' });
  }

  let auditId: string | null = null;
  if (over.withAudit !== false) {
    const audit = await createAudit({
      projectId,
      layerId,
      runId: run.id,
      auditedDocumentId: documentId,
      result: {
        verdict: (over.verdict ?? 'MORE_RESEARCH') as never,
        summary: 'One targeted question remains.',
        confidence: 0.8,
        synthesisRequired: false,
        freezeEligible: false,
      } as never,
      source: 'MODEL',
      mode: 'SINGLE_DOCUMENT',
      provider: 'WORKER',
      model: workerId,
    } as unknown as Parameters<typeof createAudit>[0]);
    auditId = audit.id;
  }

  // The state `brain_submit_audit` leaves behind for this verdict: the judge
  // asked for more, nothing is repairable, and no gap policy is authorized.
  await updateOrchestration(orchestration.id, {
    status: 'NEEDS_HUMAN' as ResearchOrchestration['status'],
    documentId,
    auditId,
    verdict: over.verdict ?? 'MORE_RESEARCH',
  });

  const bin = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title: 'one real research packet',
    objective: 'drain it',
    manifest: manifest(),
    completionContract: 'RESEARCH_PACKET_V1',
    orchestrationId: orchestration.id,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });

  return { orchestrationId: orchestration.id, binId: bin.id, documentId };
}

/* ========================================================================= */

describe('the authorization a packet stopped to ask for actually moves it', () => {
  it('leaves the packet where it is while nobody has authorized anything', async () => {
    // The inversion that matters most: re-deriving must not become a way for
    // the Brain to declare its own way past a verdict it did not like.
    const { orchestrationId } = await judgedPacket();
    const advanced = await advancePacket(orchestrationId);
    expect(advanced.status).toBe('NEEDS_HUMAN');
    expect((await getOrchestration(orchestrationId))!.status).toBe('NEEDS_HUMAN');
    expect((await getOrchestration(orchestrationId))!.unresolvedGapPolicy).not.toBe('RECORD_GAPS');
  });

  it('files the packet once a person authorizes it to record its gaps', async () => {
    // The reproducing case. Before the fix this stayed NEEDS_HUMAN forever:
    // the authorization landed in the row and nothing ever read it again.
    const { orchestrationId } = await judgedPacket();
    await authorizeUnresolvedGaps({
      orchestrationId,
      authorizedBy: { id: adminId, email: adminEmail },
    });

    const advanced = await advancePacket(orchestrationId);
    expect(advanced.status).toBe('COMPLETE_WITH_GAPS');

    const after = (await getOrchestration(orchestrationId))!;
    expect(after.status).toBe('COMPLETE_WITH_GAPS');
    expect(after.completedAt).not.toBeNull();
    // The verdict is untouched. Filing short is not the same as passing, and
    // the audit trail must still say what the judge concluded.
    expect(after.verdict).toBe('MORE_RESEARCH');
  });

  it('is idempotent: advancing again changes nothing', async () => {
    const { orchestrationId } = await judgedPacket();
    await authorizeUnresolvedGaps({
      orchestrationId,
      authorizedBy: { id: adminId, email: adminEmail },
    });
    await advancePacket(orchestrationId);
    const first = (await getOrchestration(orchestrationId))!;
    const again = await advancePacket(orchestrationId);
    const second = (await getOrchestration(orchestrationId))!;
    expect(again.status).toBe('COMPLETE_WITH_GAPS');
    expect(second.completedAt).toBe(first.completedAt);
    expect(again.enqueued).toEqual([]);
  });

  it('prefers a repair it can still attempt over filing short', async () => {
    // Ordering inversion. `outcomeFor` puts repairable ahead of the gap policy
    // on purpose: a run with an attempt left has not run out of research, and
    // authorizing gaps must never short-circuit the attempt.
    const { orchestrationId } = await judgedPacket({ blockedFragment: true });
    await authorizeUnresolvedGaps({
      orchestrationId,
      authorizedBy: { id: adminId, email: adminEmail },
    });
    const advanced = await advancePacket(orchestrationId);
    expect(advanced.status).not.toBe('COMPLETE_WITH_GAPS');
    expect((await getOrchestration(orchestrationId))!.status).not.toBe('COMPLETE_WITH_GAPS');
  });

  it('refuses to derive anything from a verdict this build does not define', async () => {
    // The column is a plain string. An unrecognised value must stop, not fall
    // through to the non-advancing branch and read as a decision.
    const { orchestrationId } = await judgedPacket({ verdict: 'MOSTLY_FINE' });
    await authorizeUnresolvedGaps({
      orchestrationId,
      authorizedBy: { id: adminId, email: adminEmail },
    });
    const advanced = await advancePacket(orchestrationId);
    expect(advanced.status).toBe('NEEDS_HUMAN');
    expect(advanced.waitingOn).toMatch(/verdict/i);
  });

  it('completes outright when the judge advanced it', async () => {
    const { orchestrationId } = await judgedPacket({ verdict: 'PASS' });
    const advanced = await advancePacket(orchestrationId);
    expect(advanced.status).toBe('COMPLETE');
    expect((await getOrchestration(orchestrationId))!.completedAt).not.toBeNull();
  });
});

/* ========================================================================= */

describe('a bin is terminal when its packet filed, not only when it passed', () => {
  async function verdictFor(binId: string) {
    return await evaluateContract((await getBin(binId))!);
  }

  it('accepts a packet that filed with gaps', async () => {
    // The reproducing case for D2. Every other clause of the contract is
    // unchanged and still checked: the document exists, has bytes, an audit
    // judged it, and no work item is open.
    const { orchestrationId, binId } = await judgedPacket();
    await authorizeUnresolvedGaps({
      orchestrationId,
      authorizedBy: { id: adminId, email: adminEmail },
    });
    await advancePacket(orchestrationId);
    expect((await getOrchestration(orchestrationId))!.status).toBe('COMPLETE_WITH_GAPS');

    const verdict = await verdictFor(binId);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.observed['orchestrationStatus']).toBe('COMPLETE_WITH_GAPS');
  });

  it('accepts a packet already sitting at COMPLETE_WITH_GAPS', async () => {
    // D2 on its own, with no dependence on D1: the contract is handed the
    // terminal status directly. Before the fix this refused, and refused to
    // HUMAN, so an unattended fleet had no way to finish the bin at all.
    const { orchestrationId, binId } = await judgedPacket();
    await updateOrchestration(orchestrationId, { status: 'COMPLETE_WITH_GAPS' });
    const verdict = await verdictFor(binId);
    expect(verdict.satisfied).toBe(true);
  });

  it('still refuses a packet waiting for a person', async () => {
    const { binId } = await judgedPacket();
    const verdict = await verdictFor(binId);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.disposition).toBe('HUMAN');
  });

  it('still refuses a packet that filed with gaps but whose report has no bytes', async () => {
    const { orchestrationId, binId } = await judgedPacket({ documentBytes: null });
    await authorizeUnresolvedGaps({
      orchestrationId,
      authorizedBy: { id: adminId, email: adminEmail },
    });
    await updateOrchestration(orchestrationId, { status: 'COMPLETE_WITH_GAPS' });
    const verdict = await verdictFor(binId);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/no document|artifact/i);
  });

  it('still refuses a packet that filed with gaps but was never audited', async () => {
    const { orchestrationId, binId } = await judgedPacket({ withAudit: false });
    await updateOrchestration(orchestrationId, { status: 'COMPLETE_WITH_GAPS' });
    const verdict = await verdictFor(binId);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/audit/i);
  });

  it('still refuses a packet that filed with gaps while a work item is open', async () => {
    const { orchestrationId, binId } = await judgedPacket();
    await updateOrchestration(orchestrationId, { status: 'COMPLETE_WITH_GAPS' });
    await enqueueWork({
      projectId,
      workType: 'SYNTHETIC_ECHO',
      payload: { which: 'still queued' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId,
    });
    const verdict = await verdictFor(binId);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/queued or leased/i);
  });

  it('completes no bin for a packet that failed or was cancelled', async () => {
    for (const status of ['FAILED', 'CANCELLED'] as const) {
      const { orchestrationId, binId } = await judgedPacket();
      await updateOrchestration(orchestrationId, { status });
      const verdict = await verdictFor(binId);
      expect(verdict.satisfied).toBe(false);
      expect(verdict.disposition).toBe('HUMAN');
    }
  });
});
