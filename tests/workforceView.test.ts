/**
 * The workforce card is a reading of rows the dispatcher already writes, and
 * it attributes work to the account whose Routine Brain fired for it.
 *
 * Driven through the real dispatch tick and the real assigner, with only the
 * Routine's HTTP fire simulated, so the attribution is read from the same
 * `bin_dispatch` and `bin_events` rows production writes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration, updateOrchestration } from '../server/repos/research.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { createAccount, createRoutine, bindRoutineWorker } from '../server/repos/fleet.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { assignNextBin, createBin, finishBin } from '../server/repos/bins.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import { resetNetworkBlockCache } from '../server/services/dispatch/candidates.ts';
import { workforceView } from '../server/services/fleet/workforce.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let layerId = '';
let workerId = '';
let accountName = '';
const realFetch = globalThis.fetch;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
  accountName = `crew-${Math.random().toString(36).slice(2, 8)}`;
  const account = await createAccount({ provider: 'anthropic', name: accountName });
  const worker = await createWorker({
    name: `crew-worker-${Math.random().toString(36).slice(2, 8)}`,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  workerId = worker.id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:claim', 'research:write'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: `trig_crew_${Math.random().toString(36).slice(2, 8)}`,
    name: 'crew-routine',
    tokenSecretName: 'CREW_TEST_SECRET',
  });
  await bindRoutineWorker(routine.id, worker.id);
  process.env['CREW_TEST_SECRET'] = 'not-a-real-token';
  resetNetworkBlockCache();
  let fires = 0;
  globalThis.fetch = (async () => {
    fires += 1;
    return new Response(JSON.stringify({ claude_code_session_id: `cse_crew_${fires}` }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['CREW_TEST_SECRET'];
});

function manifest(): BinManifest {
  return {
    objective: 'Research a packet',
    why: 'A research bin.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['claims'],
    outputs: ['a filed report'],
    authorizedActions: ['research'],
    prohibitedActions: ['any spend'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the packet is filed'],
  };
}

async function readyBin(title: string): Promise<string> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'q',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title,
    assignment: 'research it',
    provider: 'WORKER',
    autoApprove: false,
  });
  await updateOrchestration(orchestration.id, { status: 'RESEARCHING' });
  const bin = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title,
    objective: 'research it',
    manifest: manifest(),
    completionContract: 'RESEARCH_PACKET_V1',
    orchestrationId: orchestration.id,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: 5,
  });
  await enqueueWork({
    projectId,
    workType: 'RESEARCH_AUDIT',
    orchestrationId: orchestration.id,
    availableAt: new Date(Date.now() - 60_000).toISOString(),
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  return bin.id;
}

const card = (view: Awaited<ReturnType<typeof workforceView>>) =>
  view.accounts.find((one) => one.name === accountName)!;

describe('the workforce card', () => {
  it('shows a fired, taken job on the account whose Routine was fired, and counts its completion', async () => {
    const binId = await readyBin('An audit worth doing');
    const tick = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(tick.fired).toBe(1);

    const assigned = (await assignNextBin({ workerId, projectIds: [projectId] }))!;
    expect(assigned.bin.id).toBe(binId);

    const working = card(await workforceView({ mayRead: () => true }));
    expect(working.status).toBe('WORKING');
    expect(working.last24h.started).toBe(1);
    expect(working.last24h.assigned).toBe(1);
    expect(working.current.map((job) => job.title)).toEqual(['An audit worth doing']);

    expect(
      await finishBin(
        { binId, leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, workerId },
        { state: 'COMPLETE', reason: 'done' },
      ),
    ).toBe('OK');
    const done = card(await workforceView({ mayRead: () => true }));
    expect(done.last24h.completed).toBe(1);
    expect(done.current).toEqual([]);
    expect(done.lastWorkAt).not.toBeNull();
  });

  it('names no job a reader may not read, and still counts it', async () => {
    await readyBin('A private operation’s question');
    await dispatchTick({ burst: 4, projectIds: [projectId] });
    await assignNextBin({ workerId, projectIds: [projectId] });

    const hidden = card(await workforceView({ mayRead: () => false }));
    expect(hidden.current).toHaveLength(1);
    expect(hidden.current[0]!.title).toBeNull();
    expect(hidden.current[0]!.binId).toBeNull();
    expect(JSON.stringify(hidden)).not.toContain('private operation');
  });

  it('reports an account idle while work it may take waits', async () => {
    await readyBin('Waiting work');
    const idle = card(await workforceView({ mayRead: () => true }));
    expect(idle.status).toBe('IDLE_WITH_WORK');
    expect(idle.nextQueued?.title).toBe('Waiting work');
  });
});
