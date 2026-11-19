/**
 * The free lane's accepted facts are read from the submission's own record.
 *
 * The lane completes its items with `brain_complete_work` and no `result_ref`
 * (worker.ts `complete`), so `work_items.result_ref` is NULL for every lane
 * item. The pass id a submission produced is on its `idempotency_operations`
 * row (`research.claims` → the pass `brain_submit_claims` recorded).
 * Production, 2026-11-19 07:50Z: reading only the work item's column measured
 * model-interpretation at 0 accepted facts/h while 127 claims those items wrote
 * in the window had been gate-accepted, and `gateGrowth` held every free model
 * at its proven 2 slots with 16 items waiting.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, finishPass, insertClaims, startPass } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { perReplicaGain, stageCapacity } from '../server/services/freeLane/stageCapacity.ts';

let projectId = '';
let layerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
});

afterEach(async () => {
  await teardown();
});

async function laneFragmentSubmitted(): Promise<void> {
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
  const orchestration = await createOrchestration({
    projectId, layerId, runId: run.id, title: 'q', assignment: 'a', provider: 'WORKER', autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId, geography: 'United States',
      requiredEvidence: [{ id: 'demand_signal', description: 'a posting', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['the marketplace'], excludedSourceTypes: [], completionCriteria: ['one posting'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'f', question: 'Who pays?', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  const pass = await startPass({
    orchestrationId: orchestration.id, fragmentId: fragment!.id, passKey: 'TARGETED', ordinal: 2,
    provider: 'WORKER', prompt: 'q', promptSha256: 'x'.repeat(64),
  });
  await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}', parsed: {} });
  const claim = (n: number, accepted: boolean) => ({
    orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: pass.id, passKey: 'TARGETED',
    claim: `Claim ${n}.`, sourceUrl: `https://example.test/${n}`, sourceTitle: 't', sourcePublisher: 'p', sourceDate: '2026-11-01',
    evidenceExcerpt: `Claim ${n}.`, evidenceLocator: 'body', evidenceLane: 'demand_signal', retrievedAt: '2026-11-01T00:00:00.000Z',
    confidence: 0.9, validationState: 'SOURCED', validationDetail: null, sourced: true, accepted, claimType: 'SOURCED_FACT',
    contentHash: String(n).repeat(64).slice(0, 64),
  });
  await insertClaims([claim(1, true), claim(2, true), claim(3, false)] as never);

  // The lane's item: completed without a result_ref, as worker.ts completes it.
  const item = await enqueueWork({
    projectId, workType: 'RESEARCH_FRAGMENT', payload: { orchestrationId: orchestration.id },
    createdByType: 'SYSTEM', requiredScopes: ['queue:claim'], orchestrationId: orchestration.id,
  });
  const now = new Date().toISOString();
  await getDb().run(
    `UPDATE work_items SET state = 'SUCCEEDED', result_ref = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, item.id],
  );
  // The submission's own record carries the pass id.
  await getDb().run(
    `INSERT INTO idempotency_operations
       (id, scope_hash, key_fingerprint, namespace, project_id, created_by_type, work_item_id, request_fingerprint,
        state, result_ref, reserved_at, completed_at, created_at, updated_at)
     VALUES ('idop_claims', 'scope', 'fp', 'research.claims', ?, 'WORKER', ?, 'req', 'SUCCEEDED', ?, ?, ?, ?, ?)`,
    [projectId, item.id, pass.id, now, now, now, now],
  );
  await recordBinEvent({
    eventType: 'FREE_LANE_ITEM', outcome: 'SUBMITTED', reason: 'model auto', workItemId: item.id,
    projectId, workloadClass: 'RESEARCH_FRAGMENT', durationMs: 600_000,
  });
}

describe('model-interpretation facts from a lane item completed without result_ref', () => {
  it('counts the gate-accepted claims its submission wrote, so the measured gain is not 0', async () => {
    await laneFragmentSubmitted();
    // Another fragment item waits, so the stage has backlog for a replica to serve.
    await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', payload: {}, createdByType: 'SYSTEM', requiredScopes: ['queue:claim'] });

    const report = await stageCapacity({ hours: 2, now: Date.now() + 1000 });
    const stage = report.stages.find((s) => s.stage === 'model-interpretation')!;
    expect(stage.accepted).toBe(1);
    expect(stage.uniqueUsableFacts).toEqual({ measured: true, value: 2 });

    const gain = perReplicaGain(stage, report.windowHours, 0);
    expect(gain.measured).toBe(true);
    if (gain.measured) expect(gain.value.acceptedFactsPerHour).toBeGreaterThan(0);

    // A verification item's pass records verdicts, not claims: still counted once, at its producer.
    const verify = report.stages.find((s) => s.stage === 'evidence-verification')!;
    expect(verify.uniqueUsableFacts).toEqual({ measured: true, value: 0 });
  });
});
