/**
 * A render bin that ran out of attempts says what stopped it.
 *
 * Production, one week to 2026-11-19: seven of eleven DESIGN_RENDER bins went
 * NEEDS_HUMAN reading only "No render was submitted, so Brain still has no
 * picture of what it built" — while every worker that handed one back had said
 * why (no browser, a product that would not start). The person deciding got
 * nothing, and the improvement loop could not tell a missing capability from a
 * defective command. These tests reproduce that class through the real lease,
 * release and reconcile paths, and check by inversion that no gate moved.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createWorker } from '../server/repos/identity.ts';
import {
  assignNextBin,
  createBin,
  getBin,
  putBinUnitResult,
  releaseBin,
  type BinProof,
} from '../server/repos/bins.ts';
import { evaluateContract, hashUnitValue } from '../server/services/bins/contracts.ts';
import { reconcileBins } from '../server/services/bins/service.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let workerId = '';

const BLOCKER =
  'BLOCKED: no Chromium binary on this surface (playwright could not find a browser), so ' +
  'nothing could be captured.';
const NO_RENDER = 'No render was submitted, so Brain still has no picture of what it built.';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  workerId = (
    await createWorker({
      name: `w-${Math.random().toString(36).slice(2, 8)}`,
      createdByType: 'SYSTEM',
      createdById: 'test',
    })
  ).id;
});

function manifest(): BinManifest {
  return {
    objective: 'Render the product and submit what it looks like.',
    why: 'Brain has no picture of what it built.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [],
    acceptableSources: ['the running product'],
    excludedSources: ['a description of the product'],
    evidence: ['captures'],
    outputs: ['one design_render unit result'],
    authorizedActions: ['driving a browser against it'],
    prohibitedActions: ['changing any file in the repository'],
    budgetUnits: 1,
    retry: { maxAttempts: 1, backoffSeconds: 120 },
    stoppingConditions: ['the submission has been made'],
  };
}

async function renderBin(maxAttempts = 2): Promise<string> {
  const bin = await createBin({
    projectId,
    kind: 'DESIGN_RENDER',
    title: 'Render the product',
    objective: 'Render the product and submit what it looks like.',
    manifest: manifest(),
    completionContract: 'DESIGN_RENDER_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts,
  });
  return bin.id;
}

async function lease(binId: string): Promise<BinProof> {
  const assigned = (await assignNextBin({ workerId, projectIds: [projectId] }))!;
  expect(assigned.bin.id).toBe(binId);
  return { binId, leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, workerId };
}

async function submit(proof: BinProof, value: string): Promise<void> {
  await putBinUnitResult({
    binId: proof.binId,
    unitKey: 'design_render',
    value,
    contentHash: hashUnitValue(value),
    leaseId: proof.leaseId,
    leaseGeneration: proof.leaseGeneration,
    submittedBy: workerId,
  });
}

describe('DESIGN_RENDER_V1 with no render submitted', () => {
  it('stays RETRY and carries the worker’s recorded blocker into the reason', async () => {
    const binId = await renderBin();
    const proof = await lease(binId);
    expect(await releaseBin(proof, BLOCKER)).toBe('OK');

    const verdict = await evaluateContract((await getBin(binId))!);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.disposition).toBe('RETRY');
    expect(verdict.reasons[0]).toBe(NO_RENDER);
    expect(verdict.reasons.join(' ')).toContain(BLOCKER);
    expect(verdict.observed['workerBlocker']).toBe(BLOCKER);
  });

  it('names the most recent blocker when several attempts reported one', async () => {
    const binId = await renderBin(3);
    expect(await releaseBin(await lease(binId), 'BLOCKED: the product would not start.')).toBe('OK');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await releaseBin(await lease(binId), BLOCKER)).toBe('OK');

    const verdict = await evaluateContract((await getBin(binId))!);
    expect(verdict.reasons.join(' ')).toContain(BLOCKER);
    expect(verdict.reasons.join(' ')).not.toContain('would not start');
  });

  it('is unchanged from before when no worker recorded a blocker', async () => {
    const binId = await renderBin();
    expect(await releaseBin(await lease(binId), null)).toBe('OK');

    const verdict = await evaluateContract((await getBin(binId))!);
    expect(verdict.disposition).toBe('RETRY');
    expect(verdict.reasons).toEqual([NO_RENDER]);
    expect(verdict.observed).toEqual({ unitsSubmitted: 0, hasRender: false });
  });

  it('puts the blocker into the NEEDS_HUMAN escalation once attempts run out', async () => {
    const binId = await renderBin(1);
    expect(await releaseBin(await lease(binId), BLOCKER)).toBe('OK');

    await reconcileBins();
    const after = (await getBin(binId))!;
    expect(after.state).toBe('NEEDS_HUMAN');
    expect(after.terminalReason).toContain('without satisfying DESIGN_RENDER_V1');
    expect(after.terminalReason).toContain(BLOCKER);
  });
});

describe('DESIGN_RENDER_V1 gates are not lowered', () => {
  it('still refuses an empty captures array, blocker or not', async () => {
    const binId = await renderBin();
    const proof = await lease(binId);
    await submit(proof, JSON.stringify({ revision: 'abc', treeDirty: false, captures: [] }));

    const verdict = await evaluateContract((await getBin(binId))!);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.disposition).toBe('RETRY');
    expect(verdict.observed['captures']).toBe(0);
  });

  it('still satisfies a non-empty captures array', async () => {
    const binId = await renderBin();
    const proof = await lease(binId);
    await submit(
      proof,
      JSON.stringify({ revision: 'abc', treeDirty: false, captures: [{ surface: 'home', width: 1280 }] }),
    );

    const verdict = await evaluateContract((await getBin(binId))!);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.disposition).toBe('SATISFIED');
    expect(verdict.observed['captures']).toBe(1);
  });
});
