/**
 * The whole journey, once, from a person's objective to a worker holding the
 * first stage — through the setup being missing in the middle of it.
 *
 * Every piece of this is tested somewhere else. What is not tested anywhere else
 * is that the pieces *join*, and joining is where this feature failed: a
 * campaign submitted before its repository had a worker planned a stage, spent
 * its dispatch attempts on a refusal that was never about the work, abandoned
 * them, and was still sitting there — unexecutable and un-restartable — after
 * the operator had done everything Brain asked of them.
 *
 * So this is one continuous run, and it asserts the sequence rather than the
 * parts:
 *
 *   1. an authorized objective is approved and plans a stage;
 *   2. the stage cannot be given to anybody, and is **deferred** rather than
 *      failed — its attempts intact, its blocker legible, no lease held;
 *   3. the campaign says so, in a sentence with a remedy in it;
 *   4. the Build surface says which half of the setup is missing, and how much
 *      work is already waiting on it;
 *   5. the authorized action is taken — one call, the same one the button
 *      makes — and a surface is registered;
 *   6. **nobody prompts anything**: the next ordinary tick reconsiders the work,
 *      fires it, and the campaign's blocker goes away;
 *   7. the worker that arrives is handed that stage through the ordinary
 *      check-in, because it is the worker that repository is scoped to.
 *
 * The forge and the fire endpoint are stubbed. Everything else — routing,
 * admission, the dispatcher, the remote loop — is the production path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser, createWorker, setWorkerRouting } from '../server/repos/identity.ts';
import { listMembershipsForPrincipal } from '../server/repos/identity.ts';
import {
  approveChangeRequest,
  ensureCampaign,
  ensureChangeRequest,
  getCampaign,
} from '../server/repos/factory.ts';
import { getBin, getDispatch, listBins, listDispatchesForBin } from '../server/repos/bins.ts';
import { bindRoutineWorker, createAccount, createRoutine } from '../server/repos/fleet.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import { tickRemoteCampaign } from '../server/services/factory/remoteLoop.ts';
import { listRepositoryGrants } from '../server/services/factory/repositoryEnvelope.ts';
import {
  FACTORY_ROUTING_CAPABILITIES,
  onboardRepository,
  repositoryOnboarding,
} from '../server/services/factory/onboard.ts';
import { checkIn } from '../server/services/bins/service.ts';
import type { Principal, User } from '../server/domain/types.ts';

const GRANT = () => listRepositoryGrants()[0]!;
const BASE = 'c'.repeat(40);
const FIRE_SECRET = 'ON_DEMAND_FIRE_SECRET';

let fixture: TestProject;
let actor: User;
let realFetch: typeof globalThis.fetch;
let fires = 0;

beforeEach(async () => {
  fixture = await freshProject();
  fires = 0;
  realFetch = globalThis.fetch;
  process.env['BRAIN_FORGE_API_BASE'] = 'https://forge.test';
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/fire')) {
      fires += 1;
      return json({ claude_code_session_id: `cse_${fires}` });
    }
    if (/\/git\/ref\/heads\//.test(url)) return json({ object: { sha: BASE } });
    if (url.includes('/pulls?')) return json([]);
    if (url.includes('/check-runs')) return json({ check_runs: [] });
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return json({ default_branch: 'main' });
    return json({ message: 'Not Found' }, 404);
  }) as typeof globalThis.fetch;

  actor = await createUser({
    email: `owner-${Math.random().toString(36).slice(2)}@example.test`,
    displayName: 'The owner',
    password: 'a-long-enough-test-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env['BRAIN_FORGE_API_BASE'];
  delete process.env[FIRE_SECRET];
  delete process.env['ON_DEMAND_RESEARCH_SECRET'];
  await teardown();
});

/** A fleet that is healthy and wrong for this family: the honest starting point. */
async function researchOnlySurface(): Promise<void> {
  const worker = await createWorker({ name: 'research-only', createdByType: 'SYSTEM', createdById: 't' });
  await setWorkerRouting({
    workerId: worker.id,
    families: ['RESEARCH', 'GENERAL'],
    repositories: [],
    capabilities: [],
    reason: 'research only',
    setBy: 'test',
  });
  const account = await createAccount({ name: 'research-account', planLabel: null, declaredPlanPower: null });
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: 'trig_research_only',
    name: 'Research surface',
    tokenSecretName: 'ON_DEMAND_RESEARCH_SECRET',
    tokenDigest: 'digest',
    capabilities: [],
  });
  await bindRoutineWorker(routine.id, worker.id);
  process.env['ON_DEMAND_RESEARCH_SECRET'] = 'not-a-real-token';
}

async function principalFor(workerId: string): Promise<Principal> {
  return {
    type: 'WORKER',
    id: workerId,
    handle: workerId,
    displayName: workerId,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `cred_${workerId}`,
    authMethod: 'WORKER_BEARER',
    memberships: await listMembershipsForPrincipal('WORKER', workerId),
    requestId: `req_${workerId}`,
  } as unknown as Principal;
}

async function approvedCampaign(): Promise<string> {
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: 'on-demand',
    objective: 'Give the bootstrap checkout a README that says what it is for.',
    expectedOutcome: 'Somebody opening the repository can tell what mounts it.',
    nonGoals: [],
    acceptanceConditions: [
      { id: 'A01', statement: 'the README explains the checkout', verification: 'read it', mandatory: true },
    ],
    repository: GRANT().remote,
    repositoryRoot: '',
    baseBranch: GRANT().defaultBranch,
    baseSha: BASE,
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: ['**'],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'decline',
    verificationCommands: [],
  });
  await approveChangeRequest({
    changeRequestId: changeRequest.id,
    via: 'PERSON',
    userId: actor.id,
    authorityId: null,
  });
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: BASE,
    laneTarget: 1,
    laneTargetReason: 'test',
    executionMode: 'REMOTE',
  });
  return campaign.id;
}

/* ========================================================================= */

describe('an authorized objective survives its setup being missing', () => {
  it('defers, says what is missing, resumes on the authorized action, and executes', async () => {
    await researchOnlySurface();
    const campaignId = await approvedCampaign();

    /* 1. The campaign plans a stage. ---------------------------------------- */
    const planned = await tickRemoteCampaign(campaignId);
    expect(planned.created.some((entry) => entry.startsWith('plan:'))).toBe(true);
    const [plan] = (await listBins({ projectId: fixture.project.id })).filter(
      (bin) => bin.kind === 'FACTORY_PLAN',
    );
    expect(plan).toBeTruthy();

    /* 2. Nobody can be given it — and it is deferred, not spent. ------------- */
    for (let pass = 0; pass < 3; pass += 1) await dispatchTick();
    const [firstIntent] = await listDispatchesForBin(plan!.id);
    const deferred = (await getDispatch(firstIntent!.id))!;
    expect(deferred.state).toBe('PENDING');
    expect(deferred.lastErrorKind).toBe('NO_SURFACE_SERVES_THIS_FAMILY');
    expect(deferred.attemptCount).toBeLessThan(deferred.maxAttempts);
    const held = (await getBin(plan!.id))!;
    expect(held.state).toBe('READY');
    expect(held.leaseId).toBeNull();
    expect(fires).toBe(0);

    /* 3. The campaign says so, with a remedy. -------------------------------- */
    await tickRemoteCampaign(campaignId);
    const stuck = (await getCampaign(campaignId))!;
    expect(stuck.blockerKind).toBe('NO_HEALTHY_EXECUTION_SURFACE');
    expect(stuck.blockerDetail ?? '').toMatch(/nobody to give it to/);
    // The state stays truthful; the work has not failed.
    expect(stuck.state).toBe('PLANNING');

    /* 4. The Build surface says which half is missing. ----------------------- */
    const [before] = await repositoryOnboarding(fixture.project.id);
    expect(before!.readiness).toBe('NOT_ONBOARDED');
    expect(before!.waiting).toBeGreaterThanOrEqual(1);
    expect(before!.remaining[0] ?? '').toMatch(/Onboard this repository/);

    /* 5. The authorized action, and the one step that is not Brain's. -------- */
    const outcome = await onboardRepository({
      projectId: fixture.project.id,
      grantId: GRANT().id,
      actor,
      origin: 'https://brain.example',
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    const factoryWorkerId = outcome.result.onboarding.workerId!;

    const awaiting = (await repositoryOnboarding(fixture.project.id))[0]!;
    expect(awaiting.readiness).toBe('AWAITING_SURFACE');
    expect(awaiting.remaining.join(' ')).toMatch(/connector/i);

    const account = await createAccount({ name: 'factory-account', planLabel: null, declaredPlanPower: null });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_factory_surface',
      name: 'Factory surface',
      tokenSecretName: FIRE_SECRET,
      tokenDigest: 'digest',
      capabilities: [...FACTORY_ROUTING_CAPABILITIES],
    });
    await bindRoutineWorker(routine.id, factoryWorkerId);
    process.env[FIRE_SECRET] = 'not-a-real-token';

    const ready = (await repositoryOnboarding(fixture.project.id))[0]!;
    expect(ready.readiness).toBe('READY');
    expect(ready.remaining).toEqual([]);

    /* 6. Nobody prompts anything: the next ordinary tick resumes it. --------- */
    const resumed = await dispatchTick();
    expect(resumed.rearmed).toBeGreaterThanOrEqual(1);
    expect(resumed.fired).toBeGreaterThanOrEqual(1);
    expect(fires).toBe(1);
    const sent = (await getDispatch(firstIntent!.id))!;
    expect(sent.state).toBe('SENT');
    // And it is the same intent, at the same generation: resuming is not a
    // second piece of work.
    expect(await listDispatchesForBin(plan!.id)).toHaveLength(1);

    await tickRemoteCampaign(campaignId);
    expect((await getCampaign(campaignId))!.blockerKind).toBeNull();

    /* 7. The worker that arrives is handed that stage. ----------------------- */
    const assignment = await checkIn({
      principal: await principalFor(factoryWorkerId),
      workerId: factoryWorkerId,
      sessionRef: 'cse_1',
    });
    expect(assignment.assigned).toBe(true);
    if (!assignment.assigned) throw new Error('no assignment');
    expect(assignment.assignment.binId).toBe(plan!.id);
    expect(assignment.assignment.kind).toBe('FACTORY_PLAN');
  });

  /*
   * A duplicate tick, which is what a retry, a restart and two instances all
   * look like from here. It must not double-fire an intent that is in flight,
   * and it must not create a second one at the same generation.
   */
  it('ticking again while a fire is in flight starts nothing else', async () => {
    await researchOnlySurface();
    const campaignId = await approvedCampaign();
    await tickRemoteCampaign(campaignId);
    const [plan] = (await listBins({ projectId: fixture.project.id })).filter(
      (bin) => bin.kind === 'FACTORY_PLAN',
    );

    const outcome = await onboardRepository({
      projectId: fixture.project.id,
      grantId: GRANT().id,
      actor,
      origin: 'https://brain.example',
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    const account = await createAccount({ name: 'factory-account', planLabel: null, declaredPlanPower: null });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_factory_surface',
      name: 'Factory surface',
      tokenSecretName: FIRE_SECRET,
      tokenDigest: 'digest',
      capabilities: [...FACTORY_ROUTING_CAPABILITIES],
    });
    await bindRoutineWorker(routine.id, outcome.result.onboarding.workerId!);
    process.env[FIRE_SECRET] = 'not-a-real-token';

    await dispatchTick();
    await dispatchTick();
    await dispatchTick();

    expect(fires).toBe(1);
    expect(await listDispatchesForBin(plan!.id)).toHaveLength(1);
  });
});
