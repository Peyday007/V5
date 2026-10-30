/**
 * Campaigns conflict by the files their units really own, not by the ceiling
 * their scopes were approved under.
 *
 * A broad declared scope such as `tests/**` is shared by nearly everything, so
 * comparing declared scopes serialized unrelated campaigns. Admission now
 * compares against the ownedPaths of other live campaigns' unintegrated units,
 * and the tick defers one unit — never its siblings — when its files collide
 * with a unit another live campaign in the same repository is holding.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  approveChangeRequest,
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  getUnitByKey,
  promoteReadyUnits,
} from '../server/repos/factory.ts';
import { setAdmissionPolicy } from '../server/repos/factoryLine.ts';
import { listBins } from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import { admitQueued, queueObjective } from '../server/services/factory/line.ts';
import { tickRemoteCampaign } from '../server/services/factory/remoteLoop.ts';
import { unitKeysOfBin } from '../server/services/factory/remote.ts';

const REPO = 'https://github.com/Peyday007/oakwood-junk-removal';
const BASE = 'a'.repeat(40);

let fixture: TestProject;
let realFetch: typeof globalThis.fetch;
let adminId = '';

beforeEach(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
  fixture = await freshProject();
  adminId = (
    await createUser({
      email: `cross-${Math.random().toString(36).slice(2, 10)}@test.local`,
      displayName: 'The approver',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    })
  ).id;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await teardown();
});

async function objective(label: string, scope: string[], repository = 'not-a-forge-remote') {
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `cross-${label}-${Math.random().toString(36).slice(2)}`,
    objective: `Objective ${label}`,
    expectedOutcome: `Outcome ${label}`,
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: `${label} holds`, verification: 'npm test', mandatory: true }],
    repository,
    repositoryRoot: '',
    baseBranch: 'production',
    baseSha: BASE,
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: scope,
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'revert',
    verificationCommands: ['npm test'],
  });
  return changeRequest;
}

async function unit(campaignId: string, key: string, paths: string[]) {
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
  return row;
}

async function setState(unitId: string, state: string) {
  if (state === 'LEASED') {
    await getDb().run(
      `UPDATE factory_work_units SET state = 'LEASED', lease_id = 'lease-x', lease_worker_id = 'worker-x',
         lease_expires_at = '2999-01-01T00:00:00.000Z' WHERE id = ?`,
      [unitId],
    );
    return;
  }
  await getDb().run(
    `UPDATE factory_work_units SET state = ?, lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL WHERE id = ?`,
    [state, unitId],
  );
}

describe('admission compares units, not declared ceilings', () => {
  it('admits objectives whose scopes share tests/** but whose live units own disjoint files, and holds the one that overlaps', async () => {
    await setAdmissionPolicy({ maxActive: 5, actor: 'test', reason: 'room' });
    const a = await objective('a', ['tests/**']);
    const b = await objective('b', ['tests/**']);
    await queueObjective({ changeRequestId: a.id, userId: adminId, priority: 1 });
    await queueObjective({ changeRequestId: b.id, userId: adminId, priority: 2 });

    // Neither has units yet, so neither blocks the other.
    const first = await admitQueued();
    expect(first.admitted.map((one) => one.changeRequestId)).toEqual([a.id, b.id]);
    const [campaignA, campaignB] = first.admitted.map((one) => one.campaignId) as [string, string];
    await unit(campaignA, 'a-unit', ['tests/a.test.ts']);
    await unit(campaignB, 'b-unit', ['docs/b.md']);

    const c = await objective('c', ['tests/**']);
    const d = await objective('d', ['src/**']);
    await queueObjective({ changeRequestId: c.id, userId: adminId, priority: 3 });
    await queueObjective({ changeRequestId: d.id, userId: adminId, priority: 4 });
    const second = await admitQueued();
    const held = second.skipped.find((one) => one.reason.includes(campaignA));
    expect(held).toBeTruthy();
    expect(second.admitted.map((one) => one.changeRequestId)).toEqual([d.id]);

    // Once A's unit is integrated it owns nothing, and C starts.
    await setState((await getUnitByKey(campaignA, 'a-unit'))!.id, 'INTEGRATED');
    expect((await admitQueued()).admitted.map((one) => one.changeRequestId)).toEqual([c.id]);
  });
});

describe('the tick defers a unit that collides with another campaign, and only that unit', () => {
  async function campaign(label: string) {
    const request = await objective(label, ['**'], REPO);
    await approveChangeRequest({ changeRequestId: request.id, via: 'PERSON', userId: adminId, authorityId: null });
    const { campaign: row } = await ensureCampaign({
      changeRequestId: request.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 1,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });
    return row.id;
  }
  async function binKeys(campaignId: string) {
    return (await listBins({ projectId: fixture.project.id }))
      .filter((bin) => bin.kind === 'FACTORY_UNITS' && bin.factoryCampaignId === campaignId)
      .flatMap((bin) => unitKeysOfBin(bin))
      .sort();
  }

  for (const holding of ['LEASED', 'IMPLEMENTED'] as const) {
    it(`gives no bin to a READY unit overlapping a ${holding} unit elsewhere, names it, and hands it out once that unit is INTEGRATED`, async () => {
      const mine = await campaign(`mine-${holding}`);
      const theirs = await campaign(`theirs-${holding}`);
      const held = await unit(theirs, 'their-unit', ['src/shared.ts']);
      await setState(held.id, holding);
      await unit(mine, 'clash', ['src/shared.ts']);
      await unit(mine, 'free', ['src/free.ts']);
      await promoteReadyUnits(mine);

      const tick = await tickRemoteCampaign(mine);
      expect(await binKeys(mine)).toEqual(['free']);
      const note = tick.notes.find((one) => one.includes('clash deferred'));
      expect(note).toContain('their-unit');
      expect(note).toContain(theirs);

      await tickRemoteCampaign(mine);
      expect(await binKeys(mine)).toEqual(['free']);

      await setState(held.id, 'INTEGRATED');
      await tickRemoteCampaign(mine);
      expect(await binKeys(mine)).toEqual(['clash', 'free']);
    });
  }

  it('is not held by a campaign in another repository', async () => {
    const mine = await campaign('same');
    const request = await objective('elsewhere', ['**'], 'https://github.com/Peyday007/another-repo');
    await approveChangeRequest({ changeRequestId: request.id, via: 'PERSON', userId: adminId, authorityId: null });
    const { campaign: other } = await ensureCampaign({
      changeRequestId: request.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 1,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });
    await setState((await unit(other.id, 'theirs', ['src/shared.ts'])).id, 'LEASED');
    await unit(mine, 'clash', ['src/shared.ts']);
    await promoteReadyUnits(mine);
    await tickRemoteCampaign(mine);
    expect(await binKeys(mine)).toEqual(['clash']);
  });
});
