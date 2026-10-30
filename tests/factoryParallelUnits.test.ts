/**
 * Independent units are separately claimable, and implemented work does not wait
 * for its siblings before it is integrated.
 *
 * Production, 2026-10-30: four live campaigns each read "1 unit(s) with the
 * fleet", because the hosted tick put every ready unit into one FACTORY_UNITS
 * bin, a bin holds one lease, and so one session did all of them in sequence
 * while every other surface waited. These pin the replacement: one bin per
 * ready unit, never two for the same unit, a dependent unit held until what it
 * depends on is integrated, and integration starting while other units are
 * still with workers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import {
  addDependency,
  approveChangeRequest,
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  getUnitByKey,
  promoteReadyUnits,
} from '../server/repos/factory.ts';
import { assignNextBin, finishBin, listBins, putBinUnitResult } from '../server/repos/bins.ts';
import { declaredBranchFor, unitKeysOfBin } from '../server/services/factory/remote.ts';
import { tickRemoteCampaign } from '../server/services/factory/remoteLoop.ts';

const REPO = 'https://github.com/Peyday007/oakwood-junk-removal';
const BASE = 'a'.repeat(40);

let fixture: TestProject;
let realFetch: typeof globalThis.fetch;
let campaignId = '';

interface ForgeScript {
  branches?: Record<string, string>;
  compares?: Record<string, { files: string[]; status: string }>;
}

function stubForge(script: ForgeScript): void {
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const branch = /\/git\/ref\/heads\/(.+)$/.exec(url);
    if (branch) {
      const sha = script.branches?.[decodeURIComponent(branch[1] ?? '')];
      return sha ? json({ object: { sha } }) : json({ message: 'Not Found' }, 404);
    }
    const compare = /\/compare\/(.+)\.\.\.(.+)$/.exec(url);
    if (compare) {
      const key = `${decodeURIComponent(compare[1] ?? '')}...${decodeURIComponent(compare[2] ?? '')}`;
      const answer = script.compares?.[key];
      if (!answer) return json({ message: 'Not Found' }, 404);
      return json({
        status: answer.status,
        ahead_by: 1,
        base_commit: { sha: decodeURIComponent(compare[1] ?? '') },
        files: answer.files.map((filename) => ({ filename })),
      });
    }
    return json({ message: 'Not Found' }, 404);
  }) as typeof globalThis.fetch;
}

async function unit(key: string, paths: string[]): Promise<string> {
  const { unit: row } = await ensureUnit({
    campaignId,
    unitKey: key,
    kind: 'IMPLEMENTATION',
    role: 'IMPLEMENTER',
    title: key,
    objective: `Implement ${key} inside its own paths and nothing else.`,
    acceptance: [`${key} works`],
    ownedPaths: paths,
    requiredContext: [],
    verification: ['npm test'],
    expectedArtifact: 'code',
    risk: 'LOW',
    criticalPath: false,
    priority: 5,
    modelClass: 'FAST',
  });
  return row.id;
}

async function unitBins() {
  return (await listBins({ projectId: fixture.project.id })).filter(
    (bin) => bin.kind === 'FACTORY_UNITS' && bin.factoryCampaignId === campaignId,
  );
}

beforeEach(async () => {
  realFetch = globalThis.fetch;
  fixture = await freshProject();
  const approver = await createUser({
    email: `approver-${Math.random().toString(36).slice(2)}@example.test`,
    displayName: 'An approver',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `parallel-${Date.now()}`,
    objective: 'Three changes, two of them independent.',
    expectedOutcome: 'All three land.',
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: 'it works', verification: 'npm test', mandatory: true }],
    repository: REPO,
    repositoryRoot: '',
    baseBranch: 'main',
    baseSha: BASE,
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: ['**'],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'revert',
    verificationCommands: ['npm test'],
  });
  await approveChangeRequest({ changeRequestId: changeRequest.id, via: 'PERSON', userId: approver.id, authorityId: null });
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: BASE,
    laneTarget: 1,
    laneTargetReason: 'test',
    executionMode: 'REMOTE',
  });
  campaignId = campaign.id;
  await unit('alpha', ['src/alpha.ts']);
  await unit('beta', ['src/beta.ts', 'server/db/migrations/**']);
  const gamma = await unit('gamma', ['src/gamma.ts']);
  const alpha = (await getUnitByKey(campaignId, 'alpha'))!.id;
  await addDependency(campaignId, gamma, alpha, 'imports alpha');
  await promoteReadyUnits(campaignId);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await teardown();
});

describe('independent units are separately claimable', () => {
  it('hands each ready unit its own bin, and never a second bin for the same unit', async () => {
    stubForge({});
    const first = await tickRemoteCampaign(campaignId);
    const bins = await unitBins();
    expect(bins).toHaveLength(2);
    expect(bins.map((bin) => unitKeysOfBin(bin)).sort()).toEqual([['alpha'], ['beta']]);
    expect(first.created.filter((entry) => entry.startsWith('units:'))).toHaveLength(2);

    // A dependent unit is not handed out before what it depends on is integrated.
    expect((await getUnitByKey(campaignId, 'gamma'))?.state).toBe('BLOCKED');

    await tickRemoteCampaign(campaignId);
    expect(await unitBins()).toHaveLength(2);
  });

  it('tells a unit that owns migrations to take the next number, and only that unit', async () => {
    // Two campaigns reserved numbers for each other and both were refused for
    // a numbering gap; the instruction is what a unit reads before choosing.
    stubForge({});
    await tickRemoteCampaign(campaignId);
    const bins = await unitBins();
    const text = (key: string) =>
      bins.find((bin) => unitKeysOfBin(bin).includes(key))!.manifest.units!.map((u) => u.establishes).join('\n');
    expect(text('beta')).toContain('Never skip a number');
    expect(text('alpha')).not.toContain('Never skip a number');
  });

  it('lets two workers hold the two units at once', async () => {
    stubForge({});
    await tickRemoteCampaign(campaignId);
    const one = (await createWorker({ name: 'w1', createdByType: 'SYSTEM', createdById: 't' })).id;
    const two = (await createWorker({ name: 'w2', createdByType: 'SYSTEM', createdById: 't' })).id;
    const a = await assignNextBin({ workerId: one, projectIds: [fixture.project.id] });
    const b = await assignNextBin({ workerId: two, projectIds: [fixture.project.id] });
    expect(a?.bin.kind).toBe('FACTORY_UNITS');
    expect(b?.bin.kind).toBe('FACTORY_UNITS');
    expect(a!.bin.id).not.toBe(b!.bin.id);
  });

  it('starts integration of a finished unit while its sibling is still with a worker', async () => {
    stubForge({});
    await tickRemoteCampaign(campaignId);
    const workerId = (await createWorker({ name: 'w', createdByType: 'SYSTEM', createdById: 't' })).id;
    const bins = await unitBins();
    const alphaBin = bins.find((bin) => unitKeysOfBin(bin).includes('alpha'))!;
    let assigned = await assignNextBin({ workerId, projectIds: [fixture.project.id] });
    while (assigned && assigned.bin.id !== alphaBin.id) {
      // The other unit's bin stays with a worker; take the next one.
      assigned = await assignNextBin({ workerId, projectIds: [fixture.project.id] });
    }
    expect(assigned?.bin.id).toBe(alphaBin.id);
    const branch = declaredBranchFor(alphaBin, 'alpha')!;
    const head = 'c'.repeat(40);
    stubForge({
      branches: { [branch]: head },
      compares: { [`${BASE}...${head}`]: { files: ['src/alpha.ts'], status: 'ahead' } },
    });
    await putBinUnitResult({
      binId: alphaBin.id,
      unitKey: 'alpha',
      value: JSON.stringify({
        unitKey: 'alpha',
        outcome: 'IMPLEMENTED',
        branch,
        headSha: head,
        filesChanged: ['src/alpha.ts'],
        commands: [{ command: 'npm test', exitCode: 0 }],
        summary: 'alpha',
      }),
      contentHash: 'h-alpha',
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });
    expect(
      await finishBin(
        { binId: alphaBin.id, leaseId: assigned!.leaseId, leaseGeneration: assigned!.leaseGeneration, workerId },
        { state: 'COMPLETE', reason: 'implemented' },
      ),
    ).toBe('OK');

    const tick = await tickRemoteCampaign(campaignId);
    expect((await getUnitByKey(campaignId, 'alpha'))?.state).toBe('IMPLEMENTED');
    expect((await getUnitByKey(campaignId, 'beta'))?.state).toBe('READY');
    expect(tick.created.some((entry) => entry.startsWith('integrate:'))).toBe(true);
    // And beta was not handed out a second time beside its live bin.
    expect(tick.created.some((entry) => entry.startsWith('units:'))).toBe(false);
  });
});
