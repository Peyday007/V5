/**
 * The factory as a production line: the step between campaigns, and the fault
 * that says it stopped.
 *
 * The defect this exists for was measured in production on 2026-09-26. Stage to
 * stage movement was Brain's own, but nothing started the next objective once a
 * campaign finished or blocked — a Claude reminder did, forty-five minutes at a
 * time. These tests pin the four properties that make the continuation safe:
 * a person's approval is what puts work in the line; a campaign that cannot move
 * does not hold a slot; two passes racing start one campaign; and executable work
 * beside free capacity with nothing running is reported as a fault.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  ensureCampaign,
  ensureChangeRequest,
  getCampaignByChangeRequest,
  patchCampaign,
} from '../server/repos/factory.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  currentAdmissionPolicy,
  DEFAULT_MAX_ACTIVE,
  listQueueEntries,
  setAdmissionPolicy,
  withdrawQueueEntry,
} from '../server/repos/factoryLine.ts';
import {
  admitQueued,
  LineError,
  observeIdle,
  queueObjective,
  readLine,
  resetIdleObservation,
  IDLE_REPORT_AFTER_MS,
  LINE_EVENT_KINDS,
  type LineReading,
} from '../server/services/factory/line.ts';
import { listFactoryEvents } from '../server/repos/factoryFleet.ts';
import { createBin } from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';

let fixture: TestProject;
let adminId = '';

beforeEach(async () => {
  fixture = await freshProject();
  resetIdleObservation();
  const admin = await createUser({
    email: `line-${Math.random().toString(36).slice(2, 10)}@test.local`,
    displayName: 'The approver',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  adminId = admin.id;
});

afterEach(async () => {
  await teardown();
});

/** A remote objective the forge cannot parse, so no network is ever asked. */
async function objective(label: string, conditions = true) {
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `line-${label}-${Math.random().toString(36).slice(2)}`,
    objective: `Objective ${label}`,
    expectedOutcome: `Outcome ${label}`,
    nonGoals: [],
    acceptanceConditions: conditions
      ? [{ id: 'A01', statement: `${label} holds`, verification: 'npm test', mandatory: true }]
      : [],
    repository: 'not-a-forge-remote',
    baseBranch: 'production',
    baseSha: 'a'.repeat(40),
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: ['server/**'],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'discard the branch',
    verificationCommands: [],
  });
  return changeRequest;
}

describe('queueing is a person approving in advance', () => {
  it('approves the objective as the person who queued it and starts nothing yet', async () => {
    const request = await objective('one');
    const outcome = await queueObjective({ changeRequestId: request.id, userId: adminId, priority: 10 });
    expect(outcome.created).toBe(true);
    expect(outcome.entry.state).toBe('QUEUED');
    expect(await getCampaignByChangeRequest(request.id)).toBeNull();
    const again = await queueObjective({ changeRequestId: request.id, userId: adminId, priority: 1 });
    expect(again.created).toBe(false);
    expect(again.entry.priority).toBe(10);
  });

  it('refuses an objective whose success is undefined, exactly as approving it would', async () => {
    const request = await objective('no-conditions', false);
    await expect(queueObjective({ changeRequestId: request.id, userId: adminId, priority: 1 })).rejects.toThrow(
      /no acceptance conditions/,
    );
    expect(await listQueueEntries()).toHaveLength(0);
  });

  it('refuses an objective that already has a campaign, rather than starting it twice', async () => {
    const request = await objective('started');
    await queueObjective({ changeRequestId: request.id, userId: adminId, priority: 1 }).catch(() => undefined);
    await ensureCampaign({
      changeRequestId: request.id,
      projectId: fixture.project.id,
      baseSha: request.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
      executionMode: 'REMOTE',
    });
    const other = await objective('started-2');
    await ensureCampaign({
      changeRequestId: other.id,
      projectId: fixture.project.id,
      baseSha: other.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
      executionMode: 'REMOTE',
    });
    await expect(queueObjective({ changeRequestId: other.id, userId: adminId, priority: 1 })).rejects.toBeInstanceOf(
      LineError,
    );
  });
});

describe('admission starts the next objective when a slot frees', () => {
  it('starts one at a time by default, in priority order', async () => {
    expect((await currentAdmissionPolicy()).maxActive).toBe(DEFAULT_MAX_ACTIVE);
    const low = await objective('low');
    const high = await objective('high');
    await queueObjective({ changeRequestId: low.id, userId: adminId, priority: 50 });
    await queueObjective({ changeRequestId: high.id, userId: adminId, priority: 5 });

    const first = await admitQueued();
    expect(first.admitted.map((one) => one.changeRequestId)).toEqual([high.id]);
    const again = await admitQueued();
    expect(again.admitted).toHaveLength(0);
    expect(await getCampaignByChangeRequest(low.id)).toBeNull();
  });

  it('frees the slot when the working campaign blocks, so one parked objective does not idle the line', async () => {
    const a = await objective('a');
    const b = await objective('b');
    await queueObjective({ changeRequestId: a.id, userId: adminId, priority: 1 });
    await queueObjective({ changeRequestId: b.id, userId: adminId, priority: 2 });
    const first = await admitQueued();
    const started = first.admitted[0]!;
    await patchCampaign(started.campaignId, {
      state: 'BLOCKED',
      blockerKind: 'UNIT_EXHAUSTED_ATTEMPTS',
      blockerDetail: 'waiting for a person',
    });
    const second = await admitQueued();
    expect(second.admitted.map((one) => one.changeRequestId)).toEqual([b.id]);
  });

  it('frees the slot when a campaign completes with a pull request waiting for its merge', async () => {
    const a = await objective('done');
    const b = await objective('next');
    await queueObjective({ changeRequestId: a.id, userId: adminId, priority: 1 });
    await queueObjective({ changeRequestId: b.id, userId: adminId, priority: 2 });
    const first = await admitQueued();
    await patchCampaign(first.admitted[0]!.campaignId, { state: 'COMPLETE', prUrl: 'https://example.invalid/pr/1' });
    const second = await admitQueued();
    expect(second.admitted.map((one) => one.changeRequestId)).toEqual([b.id]);
  });

  it('honours a raised limit, and a limit of zero turns the line off', async () => {
    const requests = [await objective('p1'), await objective('p2'), await objective('p3')];
    for (const [i, request] of requests.entries()) {
      await queueObjective({ changeRequestId: request.id, userId: adminId, priority: i });
    }
    await setAdmissionPolicy({ maxActive: 0, actor: 'test', reason: 'off' });
    expect((await admitQueued()).admitted).toHaveLength(0);
    await setAdmissionPolicy({ maxActive: 2, actor: 'test', reason: 'two at once' });
    expect((await admitQueued()).admitted).toHaveLength(2);
    expect((await admitQueued()).admitted).toHaveLength(0);
  });

  it('starts exactly one campaign when two passes race for the same entry', async () => {
    const request = await objective('race');
    await queueObjective({ changeRequestId: request.id, userId: adminId, priority: 1 });
    await setAdmissionPolicy({ maxActive: 5, actor: 'test', reason: 'room for a race' });
    const [x, y] = await Promise.all([admitQueued(), admitQueued()]);
    expect(x.admitted.length + y.admitted.length).toBe(1);
    const events = await listFactoryEvents(null, { kinds: [LINE_EVENT_KINDS.admitted] });
    expect(events).toHaveLength(1);
  });

  it('never starts a withdrawn objective', async () => {
    const request = await objective('withdrawn');
    await queueObjective({ changeRequestId: request.id, userId: adminId, priority: 1 });
    expect(await withdrawQueueEntry({ changeRequestId: request.id, reason: 'not now' })).toBe(true);
    expect((await admitQueued()).admitted).toHaveLength(0);
  });
});

describe('unexplained idle is a fault with a start and an end', () => {
  function reading(idle: boolean): LineReading {
    return {
      at: new Date().toISOString(),
      policy: { id: null, maxActive: 1, actor: 'default', reason: '', createdAt: null },
      auto: true,
      executable: { queued: idle ? 1 : 0, readyBins: 0, total: idle ? 1 : 0 },
      active: { leasedBins: 0, arriving: 0, workingCampaigns: 0 },
      capacity: { freeSurfaces: 1, surfaces: [] },
      unexplainedIdle: idle,
      because: idle ? 'idle' : 'moving',
      campaigns: [],
      queue: [],
    };
  }

  it('does not report a tick boundary, reports idle that lasts, and closes it when work resumes', async () => {
    const t0 = new Date('2026-09-26T03:00:00Z');
    expect(await observeIdle(reading(true), t0)).toBeNull();
    const later = new Date(t0.getTime() + IDLE_REPORT_AFTER_MS + 1000);
    expect(await observeIdle(reading(true), later)).toBe('STARTED');
    expect(await observeIdle(reading(true), new Date(later.getTime() + 60_000))).toBeNull();
    expect(await observeIdle(reading(false), new Date(later.getTime() + 120_000))).toBe('ENDED');
    const kinds = (await listFactoryEvents(null, {
      kinds: [LINE_EVENT_KINDS.idleStarted, LINE_EVENT_KINDS.idleEnded],
    })).map((event) => event.kind);
    expect(kinds).toEqual([LINE_EVENT_KINDS.idleStarted, LINE_EVENT_KINDS.idleEnded]);
  });

  it('reads a queued objective with no surface as waiting on capacity, not as a fault', async () => {
    const request = await objective('no-surface');
    await queueObjective({ changeRequestId: request.id, userId: adminId, priority: 1 });
    const line = await readLine();
    expect(line.executable.total).toBe(1);
    expect(line.capacity.freeSurfaces).toBe(0);
    expect(line.unexplainedIdle).toBe(false);
    expect(line.because).toMatch(/no Factory surface is free/);
  });
});

/** A factory stage bin for a campaign, in a chosen state. */
async function stageBin(campaignId: string, state: 'READY' | 'NEEDS_HUMAN') {
  const bin = await createBin({
    projectId: fixture.project.id,
    kind: 'FACTORY_UNITS',
    title: 'units',
    objective: 'Do the stage.',
    manifest: {
      objective: 'Do the stage.',
      why: 'line test',
      lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'u1', establishes: 'a result', input: '{}', transform: 'FACTORY_UNITS', dependsOn: [] }],
      acceptableSources: [],
      excludedSources: [],
      evidence: ['a result'],
      outputs: ['one result'],
      authorizedActions: ['do the stage'],
      prohibitedActions: ['anything else'],
      budgetUnits: null,
      retry: { maxAttempts: 2, backoffSeconds: 60 },
      stoppingConditions: ['a result per unit'],
    },
    completionContract: 'FACTORY_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    factoryCampaignId: campaignId,
  });
  if (state === 'NEEDS_HUMAN') {
    await getDb().run(`UPDATE bins SET state = 'NEEDS_HUMAN' WHERE id = ?`, [bin.id]);
  }
  return bin.id;
}

describe('a stage parked on a person holds no slot', () => {
  it('frees the slot when the campaign still reads EXECUTING but its only stage bin needs a person', async () => {
    const a = await objective('parked');
    const b = await objective('behind-parked');
    await queueObjective({ changeRequestId: a.id, userId: adminId, priority: 1 });
    await queueObjective({ changeRequestId: b.id, userId: adminId, priority: 2 });
    const first = await admitQueued();
    const campaignId = first.admitted[0]!.campaignId;
    await patchCampaign(campaignId, { state: 'EXECUTING' });
    await stageBin(campaignId, 'READY');
    expect((await admitQueued()).admitted).toHaveLength(0);

    await getDb().run(`UPDATE bins SET state = 'NEEDS_HUMAN' WHERE factory_campaign_id = ?`, [campaignId]);
    const second = await admitQueued();
    expect(second.admitted.map((one) => one.changeRequestId)).toEqual([b.id]);

    const line = await readLine();
    const parked = line.campaigns.find((row) => row.campaign.id === campaignId)!;
    expect(parked.working).toBe(false);
    expect(parked.blocked?.wait).toBe('PERSON');
    expect(parked.blocked?.kind).toBe('STAGE_BIN_NEEDS_HUMAN');
  });

  it('classifies a surface wait as automatic and an exhausted unit as needing a person', async () => {
    const a = await objective('surface-wait');
    const b = await objective('exhausted');
    await queueObjective({ changeRequestId: a.id, userId: adminId, priority: 1 });
    await queueObjective({ changeRequestId: b.id, userId: adminId, priority: 2 });
    await setAdmissionPolicy({ maxActive: 2, actor: 'test', reason: 'two' });
    const started = (await admitQueued()).admitted;
    await patchCampaign(started[0]!.campaignId, {
      state: 'BLOCKED',
      blockerKind: 'NO_HEALTHY_EXECUTION_SURFACE',
      blockerDetail: 'no surface',
    });
    await patchCampaign(started[1]!.campaignId, {
      state: 'BLOCKED',
      blockerKind: 'UNIT_EXHAUSTED_ATTEMPTS',
      blockerDetail: 'out of attempts',
    });
    const line = await readLine();
    const byId = new Map(line.campaigns.map((row) => [row.campaign.id, row]));
    expect(byId.get(started[0]!.campaignId)!.blocked?.wait).toBe('AUTOMATIC');
    expect(byId.get(started[1]!.campaignId)!.blocked?.wait).toBe('PERSON');
  });
});

describe('a project reads its own line and nobody else\'s', () => {
  it('leaves another project\'s campaigns and queue out of a project-scoped reading', async () => {
    const mine = await objective('mine');
    await queueObjective({ changeRequestId: mine.id, userId: adminId, priority: 1 });
    const other = await createProject({ slug: `other-${Math.random().toString(36).slice(2, 8)}`, name: 'Other' });
    const line = await readLine(new Date(), { projectId: other.id });
    expect(line.queue).toHaveLength(0);
    expect(line.campaigns).toHaveLength(0);
    const own = await readLine(new Date(), { projectId: fixture.project.id });
    expect(own.queue.map((row) => row.entry.changeRequestId)).toEqual([mine.id]);
  });
});
