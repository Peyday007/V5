/**
 * A stranded Factory bin is resolved by why it is stranded (`factory/stranded.ts`).
 *
 * Confirmed failure, production 2026-11-24: the review bin of campaign
 * fcp_03a8a0ad was refused at admission by every reviewer for review
 * independence, its intent was re-armed on the clock until the ceiling, and the
 * Factory pool then read "executable work beside free surfaces: a fault" for
 * days with nothing acting on it. These tests pin both resolutions: an
 * unreviewable review is cancelled with its cause and the campaign blocked as
 * NO_ELIGIBLE_REVIEWER, so the line stops counting it as executable; any other
 * stranded intent is renewed (once a day) so the router can place it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The one Factory surface the fleet holds: free, enabled, bound to an active
 * worker, and serving whichever projects `fleet.servesProjects` names — the
 * fixture's own by default, so the dispatcher's router would place its bins.
 */
const fleet = vi.hoisted(() => ({ servesProjects: [] as string[] }));
vi.mock('../server/services/dispatch/candidates.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/dispatch/candidates.ts')>();
  const snapshot = async () => ({
    candidates: [
      {
        routine: {
          id: 'rtn_line_idle',
          name: 'Factory surface',
          routineRef: 'trig_line_idle',
          capabilities: ['repository'],
          state: 'ENABLED',
          workerId: 'wkr_line_idle',
          retryAt: null,
        },
        account: { name: 'Factory account', state: 'ENABLED', retryAt: null },
        workerActive: true,
        servesProjects: fleet.servesProjects,
        servesFamilies: null,
        routineInFlight: 0,
        routineTarget: 1,
        accountInFlight: 0,
        accountTarget: 1,
      },
    ],
    fleetPolicy: null,
    fleetInFlight: 0,
    factoryInFlight: 0,
    missingSecrets: [],
  });
  return { ...actual, fleetSnapshot: snapshot, sharedFleetSnapshot: snapshot };
});
vi.mock('../server/services/dispatch/router.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/dispatch/router.ts')>();
  return { ...actual, surfaceIneligibility: () => null };
});

import { freshProject, teardown, type TestProject } from './helpers.ts';
import { ensureChangeRequest, patchCampaign } from '../server/repos/factory.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  admitQueued,
  IDLE_REPORT_AFTER_MS,
  LINE_EVENT_KINDS,
  observeIdle,
  queueObjective,
  readLine,
  resetIdleObservation,
} from '../server/services/factory/line.ts';
import { listFactoryEvents } from '../server/repos/factoryFleet.ts';
import {
  createBin,
  ensureDispatchIntent,
  getBin,
  listDispatchesForBin,
  markDispatchDeferred,
} from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import { STRANDED_REARM_CEILING } from '../server/services/dispatch/rearm.ts';

let fixture: TestProject;
let adminId = '';

beforeEach(async () => {
  fixture = await freshProject();
  fleet.servesProjects = [fixture.project.id];
  resetIdleObservation();
  const admin = await createUser({
    email: `line-idle-${Math.random().toString(36).slice(2, 10)}@test.local`,
    displayName: 'The approver',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  adminId = admin.id;
});

afterEach(async () => {
  await teardown();
});

/** One working campaign with one READY stage bin, as the recorded reading had. */
async function campaignWithReadyStage(kind = 'FACTORY_PLAN'): Promise<string> {
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `line-idle-${Math.random().toString(36).slice(2)}`,
    objective: 'Objective idle',
    expectedOutcome: 'Outcome idle',
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: 'idle holds', verification: 'npm test', mandatory: true }],
    repository: 'not-a-forge-remote',
    baseBranch: 'production',
    baseSha: 'a'.repeat(40),
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: ['server/line-idle/**'],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'discard the branch',
    verificationCommands: [],
  });
  await queueObjective({ changeRequestId: changeRequest.id, userId: adminId, priority: 1 });
  const campaignId = (await admitQueued()).admitted[0]!.campaignId;
  await patchCampaign(campaignId, { state: 'EXECUTING' });
  // Admission may have made a first stage bin already; the reading is about one.
  await getDb().run(`DELETE FROM bins WHERE factory_campaign_id = ?`, [campaignId]);
  const bin = await createBin({
    projectId: fixture.project.id,
    kind,
    title: 'plan',
    objective: 'Plan the stage.',
    manifest: {
      objective: 'Plan the stage.',
      why: 'line idle test',
      lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'plan', establishes: 'a plan', input: '{}', transform: 'FACTORY_PLAN', dependsOn: [] }],
      acceptableSources: [],
      excludedSources: [],
      evidence: ['a plan'],
      outputs: ['one plan'],
      authorizedActions: ['plan'],
      prohibitedActions: ['anything else'],
      budgetUnits: null,
      retry: { maxAttempts: 2, backoffSeconds: 60 },
      stoppingConditions: ['a plan'],
    },
    completionContract: 'FACTORY_PLAN_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    factoryCampaignId: campaignId,
  });
  return bin.id;
}

async function intentFor(binId: string, set: string, params: unknown[]): Promise<void> {
  const bin = (await getBin(binId))!;
  await ensureDispatchIntent(bin);
  const intent = (await listDispatchesForBin(binId)).at(-1)!;
  await getDb().run(`UPDATE bin_dispatch SET ${set} WHERE id = ?`, [...params, intent.id] as never[]);
}

import { resolveStrandedFactoryBins } from '../server/services/factory/stranded.ts';
import { getCampaign } from '../server/repos/factory.ts';
import { recordBinEvent } from '../server/repos/bins.ts';

async function campaignOf(binId: string): Promise<string> {
  return (await getBin(binId))!.factoryCampaignId!;
}

const INDEPENDENCE =
  'Part of this campaign was implemented by a session Brain could not record, and this reviewer arrives on the ' +
  'same connector (or on one Brain cannot name), so it could be that very session. Nothing is recorded.';

describe('a stranded Factory bin is resolved, not reported for ever', () => {
  it('cancels an unreviewable review, blocks its campaign as NO_ELIGIBLE_REVIEWER, and the line stops reading idle', async () => {
    const binId = await campaignWithReadyStage('FACTORY_REVIEW');
    await intentFor(binId, `state = 'ABANDONED', last_error_kind = 'NO_SHOW', max_attempts = ?, updated_at = ?`, [
      STRANDED_REARM_CEILING,
      new Date(Date.now() - 24 * 3_600_000).toISOString(),
    ]);
    const bin = (await getBin(binId))!;
    for (let i = 0; i < 4; i += 1) {
      await recordBinEvent({
        eventType: 'BIN_ASSIGNMENT_REFUSED',
        binId,
        projectId: bin.projectId,
        leaseGeneration: bin.leaseGeneration,
        outcome: 'REFUSED_BY_ADMISSION',
        reason: INDEPENDENCE,
      });
    }
    const resolved = await resolveStrandedFactoryBins();
    expect(resolved.map((r) => r.action)).toContain('BLOCKED_NO_ELIGIBLE_REVIEWER');
    const after = (await getBin(binId))!;
    expect(after.state).toBe('CANCELLED');
    expect(after.terminalReason).toMatch(/No eligible reviewer/);
    const campaign = (await getCampaign(await campaignOf(binId)))!;
    expect(campaign.state).toBe('BLOCKED');
    expect(campaign.blockerKind).toBe('NO_ELIGIBLE_REVIEWER');

    const line = await readLine();
    expect(line.executable.readyBins).toBe(0);
    expect(line.unexplainedIdle).toBe(false);
  });

  it('renews any other stranded intent once, and not again within the day', async () => {
    const binId = await campaignWithReadyStage();
    await intentFor(binId, `state = 'ABANDONED', last_error_kind = 'NO_SHOW', max_attempts = ?, updated_at = ?`, [
      STRANDED_REARM_CEILING,
      new Date(Date.now() - 24 * 3_600_000).toISOString(),
    ]);
    const first = await resolveStrandedFactoryBins();
    expect(first.find((r) => r.binId === binId)?.action).toBe('RENEWED');
    const intent = (await listDispatchesForBin(binId)).at(-1)!;
    expect(intent.state).toBe('PENDING');
    expect(intent.maxAttempts).toBeGreaterThan(STRANDED_REARM_CEILING);
    expect((await getBin(binId))!.state).toBe('READY');

    // Spent again at once: the next resolution waits a day rather than looping.
    await getDb().run(`UPDATE bin_dispatch SET state = 'SUPERSEDED' WHERE id = ?`, [intent.id]);
    const second = await resolveStrandedFactoryBins();
    expect(second.find((r) => r.binId === binId)?.action).toBe('WAITING_RENEWAL');
  });

  it('does not cancel a review whose refusals were not all about independence', async () => {
    const binId = await campaignWithReadyStage('FACTORY_REVIEW');
    await intentFor(binId, `state = 'ABANDONED', last_error_kind = 'NO_SHOW', max_attempts = ?, updated_at = ?`, [
      STRANDED_REARM_CEILING,
      new Date(Date.now() - 24 * 3_600_000).toISOString(),
    ]);
    const bin = (await getBin(binId))!;
    for (const reason of [INDEPENDENCE, INDEPENDENCE, 'The surface is busy.']) {
      await recordBinEvent({ eventType: 'BIN_ASSIGNMENT_REFUSED', binId, projectId: bin.projectId, leaseGeneration: bin.leaseGeneration, outcome: 'REFUSED_BY_ADMISSION', reason });
    }
    const resolved = await resolveStrandedFactoryBins();
    expect(resolved.find((r) => r.binId === binId)?.action).toBe('RENEWED');
    expect((await getBin(binId))!.state).toBe('READY');
  });
});
