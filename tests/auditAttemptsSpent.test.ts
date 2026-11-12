/**
 * An audit that ran out of attempts gets a new round, bounded (§88).
 *
 * Production, 2026-11-06 10:42Z (`packets parks`): twenty packets Brain had
 * already decided to file (RECORD_GAPS) sat at NEEDS_HUMAN for up to a day.
 * Their audit items had spent every attempt during the night's outages, so
 * each resume found the same dead items and parked again, and the answered
 * card was never reopened. These pin that a spent audit opens a fresh round a
 * bounded number of times, and that the sweep re-advances the packets already
 * parked that way.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, getOrchestration, updateFragment, updateOrchestration } from '../server/repos/research.ts';
import { cancelWork, enqueueWork, listWorkItemsForOrchestration } from '../server/repos/workQueue.ts';
import {
  advancePacket,
  auditReopensSoFar,
  faultedOutReason,
  MAX_AUDIT_REOPENS,
  MAX_ITEMS_PER_TARGET,
} from '../server/services/research/packetRunner.ts';
import { refileDecidedParks, ROUTINE_DECISION_GRACE_MS } from '../server/services/russell/routineDecisions.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});

/** A filed packet Brain decided to file, whose PRIMARY audit items all spent their attempts. */
async function spentAuditPacket(): Promise<string> {
  const layer = await fixture.layerByName('World Model');
  const document = await addDocument(fixture, 'World Model', 'v1B', { contents: 'What the packet found, filed.' });
  const run = await createRun({ projectId: fixture.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p' });
  const orchestration = await createOrchestration({
    projectId: fixture.project.id, layerId: layer.id, runId: run.id, title: 'A packet', assignment: 'a question', provider: 'WORKER', autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId: fixture.project.id, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'f',
      question: 'What does the record say?', requiredEvidence: [{ id: 'official_source', description: 'the office', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['official'], excludedSourceTypes: [], completionCriteria: ['a quote'], minIndependentSources: 1,
      maxRepairs: 2, dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  for (const fragment of await currentFragments(orchestration.id)) {
    await updateFragment(fragment.id, { status: 'ACCEPTED', completedAt: new Date().toISOString() });
  }
  await spendPrimaries(orchestration.id, MAX_ITEMS_PER_TARGET);
  await updateOrchestration(orchestration.id, {
    status: 'NEEDS_HUMAN',
    documentId: document.id,
    failureReason: faultedOutReason('primary audit'),
    completedAt: new Date().toISOString(),
  });
  await getDb().run("UPDATE research_orchestrations SET unresolved_gap_policy = 'RECORD_GAPS' WHERE id = ?", [orchestration.id]);
  return orchestration.id;
}

/** Spend every queued PRIMARY audit item, adding new ones until there are `count`. */
async function spendPrimaries(orchestrationId: string, count: number): Promise<void> {
  const primaries = async () =>
    (await listWorkItemsForOrchestration(orchestrationId)).filter((i) => i.workType === 'RESEARCH_AUDIT' && i.payload['role'] === 'PRIMARY');
  while ((await primaries()).length < count) {
    await enqueueWork({
      projectId: fixture.project.id, workType: 'RESEARCH_AUDIT', payload: { role: 'PRIMARY' }, createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'], orchestrationId,
    });
  }
  for (const item of await primaries()) {
    if (item.state === 'QUEUED' || item.state === 'LEASED') await cancelWork(item.id, 'This item has spent all 2 of its attempts');
    await getDb().run('UPDATE work_items SET attempt_count = max_attempts WHERE id = ?', [item.id]);
  }
}

describe('an audit that ran out of attempts', () => {
  it('opens a new round and queues a fresh PRIMARY, instead of parking on the dead items', async () => {
    const id = await spentAuditPacket();
    const result = await advancePacket(id);
    expect(result.status).toBe('AUDITING');
    expect(result.enqueued.map((e) => e.workType)).toEqual(['RESEARCH_AUDIT']);
    expect(await auditReopensSoFar((await getOrchestration(id))!)).toBe(1);
    expect((await getOrchestration(id))!.failureReason).toBeNull();
  });

  it('parks for a person once the reopen bound is spent, as before', async () => {
    const id = await spentAuditPacket();
    for (let round = 1; round <= MAX_AUDIT_REOPENS; round += 1) {
      expect((await advancePacket(id)).status).toBe('AUDITING');
      // The new round's own items run out too.
      const items = (await listWorkItemsForOrchestration(id)).filter((i) => i.workType === 'RESEARCH_AUDIT' && i.state === 'QUEUED');
      expect(items).toHaveLength(1);
      await getDb().run("UPDATE work_items SET state = 'FAILED', failure_category = 'ATTEMPTS_EXHAUSTED', attempt_count = max_attempts WHERE id = ?", [items[0]!.id]);
      // Fill the round to its replacement cap so only a reopen could continue it.
      for (let n = 1; n < MAX_ITEMS_PER_TARGET; n += 1) {
        const extra = await enqueueWork({
          projectId: fixture.project.id, workType: 'RESEARCH_AUDIT', payload: { role: 'PRIMARY' }, createdByType: 'SYSTEM',
          requiredScopes: ['queue:claim'], orchestrationId: id,
        });
        await getDb().run("UPDATE work_items SET state = 'FAILED', failure_category = 'ATTEMPTS_EXHAUSTED', attempt_count = max_attempts WHERE id = ?", [extra.id]);
      }
    }
    expect((await advancePacket(id)).status).toBe('NEEDS_HUMAN');
    expect(await auditReopensSoFar((await getOrchestration(id))!)).toBe(MAX_AUDIT_REOPENS);
  });

  it('is swept back to work when Brain had already decided to file it, once its grace has passed', async () => {
    const id = await spentAuditPacket();
    expect(await refileDecidedParks()).toEqual([]); // still inside the grace period
    const old = new Date(Date.now() - ROUTINE_DECISION_GRACE_MS - 60_000).toISOString();
    await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [old, id]);
    expect(await refileDecidedParks()).toEqual([{ orchestrationId: id, status: 'AUDITING' }]);
  });
});
