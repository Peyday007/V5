/**
 * Campaigns collide on the files their units own, not on the scopes they were
 * allowed to touch.
 *
 * A broad declared scope such as `tests/**` is a ceiling. Held against another
 * campaign's scope it serialized objectives whose plans touch different files.
 * Admission now compares a queued objective with the unfinished units other
 * live campaigns own, and the tick defers only the unit whose files another
 * campaign's unit is holding — its siblings keep going.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
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
import { admitQueued, queueObjective } from '../server/services/factory/line.ts';
import { unitKeysOfBin } from '../server/services/factory/remote.ts';
import { tickRemoteCampaign } from '../server/services/factory/remoteLoop.ts';

const REPO = 'https://github.com/Peyday007/oakwood-junk-removal';
const BASE = 'a'.repeat(40);

let fixture: TestProject;
let adminId = '';
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  realFetch = globalThis.fetch;
  // The forge is never reached by these ticks; anything asked of it is not found.
  globalThis.fetch = (async () => new Response('{"message":"Not Found"}', { status: 404 })) as typeof globalThis.fetch;
  fixture = await freshProject();
  adminId = (await createUser({
    email: `cross-${Math.random().toString(36).slice(2, 10)}@test.local`,
    displayName: 'The approver',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  })).id;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await teardown();
});

async function request(label: string, scope: string[], repository = REPO) {
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `cross-${label}-${Math.random().toString(36).slice(2)}`,
    objective: `Objective ${label}`,
    expectedOutcome: `Outcome ${label}`,
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: `${label} holds`, verification: 'npm test', mandatory: true }],
    repository,
    repositoryRoot: '',
    baseBranch: 'main',
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

async function campaign(label: string, scope: string[], repository = REPO) {
  const cr = await request(label, scope, repository);
  await approveChangeRequest({ changeRequestId: cr.id, via: 'PERSON', userId: adminId, authorityId: null });
  const { campaign: row } = await ensureCampaign({
    changeRequestId: cr.id, projectId: fixture.project.id, baseSha: BASE, laneTarget: 1,
    laneTargetReason: 'test', executionMode: 'REMOTE',
  });
  return row.id;
}

async function unit(campaignId: string, key: string, paths: string[]): Promise<string> {
  const { unit: row } = await ensureUnit({
    campaignId, unitKey: key, kind: 'IMPLEMENTATION', role: 'IMPLEMENTER', title: key,
    objective: `Implement ${key}.`, acceptance: [`${key} works`], ownedPaths: paths, requiredContext: [],
    verification: ['npm test'], expectedArtifact: 'code', risk: 'LOW', criticalPath: false, priority: 5, modelClass: 'FAST',
  });
  await promoteReadyUnits(campaignId);
  return row.id;
}

/** Move a unit to a state, keeping the schema's rule that a lease exists only while LEASED. */
const setState = (id: string, state: string) =>
  state === 'LEASED'
    ? getDb().run(
        `UPDATE factory_work_units SET state = 'LEASED', lease_id = 'fls_test', lease_worker_id = 'wkr_test',
           lease_expires_at = '2999-01-01T00:00:00.000Z' WHERE id = ?`,
        [id],
      )
    : getDb().run(
        'UPDATE factory_work_units SET state = ?, lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL WHERE id = ?',
        [state, id],
      );

async function queue(label: string, scope: string[], priority: number) {
  const cr = await request(label, scope, 'not-a-forge-remote');
  await queueObjective({ changeRequestId: cr.id, userId: adminId, priority });
  return cr.id;
}

describe('admission compares files, not declared scopes', () => {
  it('admits two objectives that both may touch tests/** when the live units own disjoint files', async () => {
    const live = await campaign('live', ['server/**', 'tests/**'], 'not-a-forge-remote');
    await unit(live, 'l1', ['server/live.ts']);
    await setAdmissionPolicy({ maxActive: 4, actor: 'test', reason: 'room' });
    const a = await queue('qa', ['tests/**'], 1);
    const b = await queue('qb', ['tests/**'], 2);
    const pass = await admitQueued();
    expect(pass.admitted.map((one) => one.changeRequestId)).toEqual([a, b]);
    expect(pass.skipped).toEqual([]);
  });

  it('holds one whose scope overlaps a live, unintegrated unit, naming that campaign, until it is integrated', async () => {
    const live = await campaign('live2', ['**'], 'not-a-forge-remote');
    const owned = await unit(live, 'l1', ['server/shared/thing.ts']);
    await setAdmissionPolicy({ maxActive: 4, actor: 'test', reason: 'room' });
    const clash = await queue('clash', ['server/shared/**'], 1);
    const held = await admitQueued();
    expect(held.admitted).toEqual([]);
    expect(held.skipped[0]?.reason).toContain(live);
    expect(held.skipped[0]?.reason).toContain('l1');
    await setState(owned, 'INTEGRATED');
    expect((await admitQueued()).admitted.map((one) => one.changeRequestId)).toEqual([clash]);
  });

  it('lets a live campaign with no units yet block nothing', async () => {
    await campaign('planning', ['server/shared/**'], 'not-a-forge-remote');
    await setAdmissionPolicy({ maxActive: 4, actor: 'test', reason: 'room' });
    const next = await queue('next', ['server/shared/**'], 1);
    expect((await admitQueued()).admitted.map((one) => one.changeRequestId)).toEqual([next]);
  });

  it('does not compare across repositories', async () => {
    const live = await campaign('other-repo', ['**'], 'git@example.test:other/repo.git');
    await unit(live, 'l1', ['server/shared/thing.ts']);
    await setAdmissionPolicy({ maxActive: 4, actor: 'test', reason: 'room' });
    const next = await queue('here', ['server/shared/**'], 1);
    expect((await admitQueued()).admitted.map((one) => one.changeRequestId)).toEqual([next]);
  });
});

describe('the tick defers the unit, not the campaign', () => {
  async function unitBins(campaignId: string) {
    return (await listBins({ projectId: fixture.project.id })).filter(
      (bin) => bin.kind === 'FACTORY_UNITS' && bin.factoryCampaignId === campaignId,
    );
  }

  it.each(['LEASED', 'IMPLEMENTED'])('gives no bin to a unit whose files a %s unit of another campaign holds', async (held) => {
    const other = await campaign('holder', ['**']);
    const holder = await unit(other, 'h1', ['src/x.ts']);
    await setState(holder, held);
    const mine = await campaign('waiter', ['**']);
    await unit(mine, 'blocked', ['src/x.ts', 'src/x.test.ts']);
    await unit(mine, 'free', ['src/y.ts']);

    const first = await tickRemoteCampaign(mine);
    const bins = await unitBins(mine);
    expect(bins.map((bin) => unitKeysOfBin(bin))).toEqual([['free']]);
    expect(first.notes.join('\n')).toMatch(new RegExp(`blocked waits for h1 of campaign ${other}`));
    expect((await getUnitByKey(mine, 'blocked'))?.state).toBe('READY');

    await setState(holder, 'INTEGRATED');
    await tickRemoteCampaign(mine);
    expect((await unitBins(mine)).map((bin) => unitKeysOfBin(bin)).sort()).toEqual([['blocked'], ['free']]);
  });

  it('also waits for a ready unit another campaign has already put with the fleet', async () => {
    const first = await campaign('first', ['**']);
    await unit(first, 'f1', ['src/shared.ts']);
    await tickRemoteCampaign(first);
    expect((await unitBins(first)).map((bin) => unitKeysOfBin(bin))).toEqual([['f1']]);

    const second = await campaign('second', ['**']);
    await unit(second, 's1', ['src/shared.ts']);
    const report = await tickRemoteCampaign(second);
    expect(await unitBins(second)).toEqual([]);
    expect(report.notes.join('\n')).toMatch(new RegExp(`s1 waits for f1 of campaign ${first}`));
  });

  it('never defers a unit for a campaign of its own, or for a different repository', async () => {
    const mine = await campaign('solo', ['**']);
    const sibling = await unit(mine, 'a', ['src/a.ts']);
    await setState(sibling, 'LEASED');
    await unit(mine, 'b', ['src/a.ts']);
    const elsewhere = await campaign('elsewhere', ['**'], 'git@example.test:other/repo.git');
    const theirs = await unit(elsewhere, 'e1', ['src/b.ts']);
    await setState(theirs, 'LEASED');
    await unit(mine, 'c', ['src/b.ts']);
    await tickRemoteCampaign(mine);
    expect((await unitBins(mine)).map((bin) => unitKeysOfBin(bin)).sort()).toEqual([['b'], ['c']]);
  });
});
