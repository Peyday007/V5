/**
 * Two campaigns conflict by the files their units really own, not by the scope
 * their objectives were allowed to touch.
 *
 * Queued admission: broad declared scopes such as `tests/**` do not serialize
 * campaigns whose units are disjoint; a live, unintegrated unit that owns an
 * overlapping path holds the objective, naming the campaign. The tick: only the
 * colliding unit is deferred, its siblings keep going, and it gets its bin once
 * the other unit is INTEGRATED.
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
import { listBins } from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import { admitQueued, queueObjective } from '../server/services/factory/line.ts';
import { setAdmissionPolicy } from '../server/repos/factoryLine.ts';
import { unitKeysOfBin } from '../server/services/factory/remote.ts';
import { HOLD_ESCALATION_MS, tickRemoteCampaign } from '../server/services/factory/remoteLoop.ts';
import { listFactoryEvents } from '../server/repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from '../server/services/factory/metrics.ts';

const REPO = 'https://github.com/Peyday007/oakwood-junk-removal';
const BASE = 'a'.repeat(40);

let fixture: TestProject;
let adminId = '';
let seq = 0;

async function objective(scope: string[]) {
  seq += 1;
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `cross-${seq}-${Date.now()}`,
    objective: `Objective ${seq}`,
    expectedOutcome: 'It lands.',
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: 'it works', verification: 'npm test', mandatory: true }],
    repository: REPO,
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
  await approveChangeRequest({ changeRequestId: changeRequest.id, via: 'PERSON', userId: adminId, authorityId: null });
  return changeRequest;
}

async function campaignFor(changeRequestId: string): Promise<string> {
  const { campaign } = await ensureCampaign({
    changeRequestId,
    projectId: fixture.project.id,
    baseSha: BASE,
    laneTarget: 1,
    laneTargetReason: 'test',
    executionMode: 'REMOTE',
  });
  return campaign.id;
}

async function unit(campaignId: string, key: string, paths: string[]): Promise<string> {
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

async function setState(unitId: string, state: string) {
  // The table's CHECK ties a lease to the LEASED state, so move both together.
  if (state === 'LEASED') {
    await getDb().run(
      `UPDATE factory_work_units SET state = 'LEASED', lease_id = ?, lease_worker_id = ?, lease_expires_at = ? WHERE id = ?`,
      ['lease-test', 'worker-test', new Date(Date.now() + 3_600_000).toISOString(), unitId],
    );
    return;
  }
  await getDb().run(
    `UPDATE factory_work_units SET state = ?, lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL WHERE id = ?`,
    [state, unitId],
  );
}

async function unitBinKeys(campaignId: string): Promise<string[]> {
  return (await listBins({ projectId: fixture.project.id }))
    .filter((bin) => bin.kind === 'FACTORY_UNITS' && bin.factoryCampaignId === campaignId)
    .flatMap((bin) => unitKeysOfBin(bin))
    .sort();
}

beforeEach(async () => {
  fixture = await freshProject();
  adminId = (
    await createUser({
      email: `cross-${Math.random().toString(36).slice(2)}@example.test`,
      displayName: 'Admin',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
      createdByType: 'SYSTEM',
      createdById: 't',
    })
  ).id;
});

afterEach(async () => {
  await teardown();
});

describe('queued admission compares real unit ownership', () => {
  it('admits broad-scope objectives while no live unit owns a path, and holds one that overlaps a live unit, naming the campaign', async () => {
    const first = await objective(['tests/**']);
    const second = await objective(['tests/**']);
    await queueObjective({ changeRequestId: first.id, userId: adminId, priority: 1 });
    await queueObjective({ changeRequestId: second.id, userId: adminId, priority: 2 });
    await setAdmissionPolicy({ maxActive: 4, actor: 'test', reason: 'room' });
    // Campaigns with no units yet own nothing, so identical broad scopes do not serialize.
    const open = await admitQueued();
    expect(open.admitted.map((one) => one.changeRequestId)).toEqual([first.id, second.id]);

    const started = open.admitted[0]!;
    const owning = await unit(started.campaignId, 'edit-a', ['tests/a.test.ts']);

    const clash = await objective(['tests/**']);
    const disjoint = await objective(['client/src/elsewhere.tsx']);
    await queueObjective({ changeRequestId: clash.id, userId: adminId, priority: 3 });
    await queueObjective({ changeRequestId: disjoint.id, userId: adminId, priority: 4 });

    const pass = await admitQueued();
    expect(pass.admitted.map((one) => one.changeRequestId)).toEqual([disjoint.id]);
    expect(pass.skipped.find((one) => one.reason.includes('overlaps'))?.reason).toContain(started.campaignId);

    await setState(owning, 'INTEGRATED');
    expect((await admitQueued()).admitted.map((one) => one.changeRequestId)).toEqual([clash.id]);
  });
});

describe('the tick defers only the colliding unit', () => {
  it('holds a unit that overlaps another campaign’s LEASED unit, keeps its sibling going, and releases it once INTEGRATED', async () => {
    const other = await campaignFor((await objective(['**'])).id);
    const otherUnit = await unit(other, 'theirs', ['src/shared.ts']);
    await promoteReadyUnits(other);
    await setState(otherUnit, 'LEASED');

    const mine = await campaignFor((await objective(['**'])).id);
    await unit(mine, 'collides', ['src/shared.ts']);
    await unit(mine, 'free', ['src/free.ts']);
    await promoteReadyUnits(mine);

    const tick = await tickRemoteCampaign(mine);
    expect(await unitBinKeys(mine)).toEqual(['free']);
    expect(tick.notes.join('\n')).toContain(`collides waits for theirs of campaign ${other}`);
    expect((await getUnitByKey(mine, 'collides'))?.state).toBe('READY');

    await setState(otherUnit, 'IMPLEMENTED');
    await tickRemoteCampaign(mine);
    expect(await unitBinKeys(mine)).toEqual(['free']);

    await setState(otherUnit, 'INTEGRATED');
    await tickRemoteCampaign(mine);
    expect(await unitBinKeys(mine)).toEqual(['collides', 'free']);
  });

  it('does not defer for a unit that owns nothing in common', async () => {
    const other = await campaignFor((await objective(['**'])).id);
    const otherUnit = await unit(other, 'theirs', ['src/shared.ts']);
    await promoteReadyUnits(other);
    await setState(otherUnit, 'LEASED');

    const mine = await campaignFor((await objective(['**'])).id);
    await unit(mine, 'alone', ['src/alone.ts']);
    await promoteReadyUnits(mine);
    await tickRemoteCampaign(mine);
    expect(await unitBinKeys(mine)).toEqual(['alone']);
  });
});

describe('a hold that lasts is an escalation, not only a note', () => {
  const heldRows = (campaignId: string, kind: string) => listFactoryEvents(campaignId, { kinds: [kind], limit: 100 });

  it('records when the wait began once, and escalates once past the bound, naming the holder and its state', async () => {
    const other = await campaignFor((await objective(['**'])).id);
    const otherUnit = await unit(other, 'theirs', ['src/shared.ts']);
    await promoteReadyUnits(other);
    await setState(otherUnit, 'IMPLEMENTED');
    // The holding campaign cannot move by itself.
    await getDb().run(`UPDATE factory_campaigns SET state = 'BLOCKED' WHERE id = ?`, [other]);

    const mine = await campaignFor((await objective(['**'])).id);
    await unit(mine, 'collides', ['src/shared.ts']);
    await promoteReadyUnits(mine);

    const first = await tickRemoteCampaign(mine);
    await tickRemoteCampaign(mine);
    expect(await heldRows(mine, FACTORY_EVENT_KINDS.unitHeldByOtherCampaign)).toHaveLength(1);
    expect(await heldRows(mine, FACTORY_EVENT_KINDS.unitHoldEscalated)).toHaveLength(0);
    expect(first.notes.join('\n')).not.toContain('nothing releases it');

    // The wait began longer ago than the bound.
    await getDb().run(
      `UPDATE factory_events SET at = ? WHERE campaign_id = ? AND kind = ?`,
      [new Date(Date.now() - HOLD_ESCALATION_MS - 60_000).toISOString(), mine, FACTORY_EVENT_KINDS.unitHeldByOtherCampaign],
    );
    const escalated = await tickRemoteCampaign(mine);
    const text = escalated.notes.join('\n');
    expect(text).toContain(`collides waits for theirs of campaign ${other} (campaign BLOCKED)`);
    expect(text).toContain('nothing releases it by itself');
    const rows = await heldRows(mine, FACTORY_EVENT_KINDS.unitHoldEscalated);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ holderCampaignId: other, holderCampaignState: 'BLOCKED', holderUnitKey: 'theirs' });

    // Asked again, it is still said but the escalation is not written twice.
    const again = await tickRemoteCampaign(mine);
    expect(again.notes.join('\n')).toContain('nothing releases it by itself');
    expect(await heldRows(mine, FACTORY_EVENT_KINDS.unitHoldEscalated)).toHaveLength(1);
    expect(await unitBinKeys(mine)).toEqual([]);

    // Nothing was released by time: only the holder finishing frees the unit.
    await setState(otherUnit, 'INTEGRATED');
    await tickRemoteCampaign(mine);
    expect(await unitBinKeys(mine)).toEqual(['collides']);
  });
});
