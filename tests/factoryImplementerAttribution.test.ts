/**
 * A finished bin still says who took it.
 *
 * Production, 2026-09-30: every unit of six campaigns was taken by a session
 * that had been fired for some other bin, so no `worker_sessions` row named
 * it, `finishBin` cleared `bins.worker_id`, and each unit was recorded as
 * `unknown-worker`. Brain's own assignment event named the worker the whole
 * time.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createWorker } from '../server/repos/identity.ts';
import { assignNextBin, createBin, finishBin, getBin, leaseCredentialFor, leaseWorkerFor } from '../server/repos/bins.ts';
import { binIdentity } from '../server/services/factory/remote.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

function manifest(): BinManifest {
  return {
    objective: 'Prove a finished bin keeps its implementer.',
    why: 'An unknown implementer blocks every independent review.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [{ key: 'unit-1', establishes: 'one value', input: 'a value', transform: 'sha256', dependsOn: [] }],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['a stored value'],
    outputs: ['one unit result'],
    authorizedActions: ['submit unit results'],
    prohibitedActions: ['anything with an external effect'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the declared unit has a verified result'],
  };
}

describe('the implementer of a finished bin', () => {
  it('is read from the assignment event when nothing else names it', async () => {
    const worker = await createWorker({
      name: 'attribution-worker',
      displayName: 'attribution-worker',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const created = await createBin({
      projectId,
      kind: 'DETERMINISTIC_CHECK',
      title: 'A unit taken by a session fired for another bin',
      objective: 'Implement one unit',
      completionContract: 'DETERMINISTIC_UNITS_V1',
      manifest: manifest(),
      workloadClass: 'RUSSELL_TURN',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    // No session reported and no dispatch for this bin: the production case.
    const assigned = await assignNextBin({
      workerId: worker.id,
      projectIds: [projectId],
      credentialId: 'oat_the_connector_that_took_it',
    });
    expect(assigned!.bin.id).toBe(created.id);
    const leased = (await getBin(created.id))!;
    await finishBin(
      { binId: leased.id, leaseId: leased.leaseId!, leaseGeneration: leased.leaseGeneration, workerId: worker.id },
      { state: 'COMPLETE', reason: 'done' },
    );

    const finished = (await getBin(created.id))!;
    expect(finished.workerId).toBeNull();
    expect(await leaseWorkerFor(finished.id, finished.leaseGeneration)).toBe(worker.id);
    // Finishing advanced the generation; the connector is still the one that held it.
    expect(finished.leaseGeneration).toBeGreaterThan(leased.leaseGeneration);
    expect(await leaseCredentialFor(finished.id, finished.leaseGeneration)).toBe('oat_the_connector_that_took_it');
    const who = await binIdentity(finished);
    expect(who.workerId).toBe(worker.id);
    expect(who.credentialId).toBe('oat_the_connector_that_took_it');
    // The session is not invented: nobody reported one and Brain fired none.
    expect(who.sessionId).toBeNull();
  });
});
