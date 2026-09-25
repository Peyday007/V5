/**
 * Build's "Ready to execute" is the dispatcher's answer, or it is not an answer.
 *
 * The defect these pin: `describeGrant` called a repository READY when any
 * ENABLED Routine was bound to its worker. A Routine meets that with no
 * deployment secret, with no `repository-write`, and with its account out of
 * routing — and the dispatcher refuses every one. So each scenario below builds
 * a real fleet row, asks the card, and asks the router about a real factory bin
 * in the same project, and requires the two to agree.
 *
 * Every fixture token is a placeholder string set on `process.env` for the
 * length of one test and removed after it. Nothing here fires anything: the
 * router is pure and the card only reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import {
  archiveWorker,
  createUser,
  getWorkerByName,
  revokeMembership,
  setWorkerRouting,
} from '../server/repos/identity.ts';
import { listRepositoryGrants } from '../server/services/factory/repositoryEnvelope.ts';
import {
  FACTORY_ROUTING_CAPABILITIES,
  factoryWorkerName,
  onboardRepository,
  repositoryOnboarding,
} from '../server/services/factory/onboard.ts';
import {
  bindRoutineWorker,
  createAccount,
  createRoutine,
  getRoutineByRef,
  recordAccountRefusal,
  setAccountState,
  setRoutineState,
} from '../server/repos/fleet.ts';
import { createBin, getBin, recordBinEvent } from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';
import { routeBin } from '../server/services/dispatch/router.ts';
import { recordAllowanceReport } from '../server/repos/allowance.ts';
import { factoryAllocation } from '../server/services/factory/allocation.ts';
import { capacityReading } from '../server/services/fleet/capacity.ts';
import { FACTORY_CAPABILITY, FACTORY_WRITE_CAPABILITY } from '../server/services/factory/remote.ts';
import type { Bin, User } from '../server/domain/types.ts';

let fixture: TestProject;
let actor: User;
const deployed: string[] = [];
const GRANT = () => listRepositoryGrants()[0]!;

beforeEach(async () => {
  fixture = await freshProject();
  actor = await createUser({
    email: `readiness-${Date.now()}-${Math.random()}@example.com`,
    displayName: 'The onboarder',
    password: 'a-long-enough-test-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
});

afterEach(() => {
  for (const name of deployed.splice(0)) delete process.env[name];
});

async function onboard(projectId = fixture.project.id): Promise<string> {
  const outcome = await onboardRepository({
    projectId,
    grantId: GRANT().id,
    scope: { kind: 'WHOLE_REPOSITORY' },
    actor,
    origin: 'https://brain.example',
  });
  if (!outcome.ok) throw new Error(outcome.reason);
  return (await getWorkerByName(factoryWorkerName(GRANT().id)))!.id;
}

let seq = 0;
async function surface(
  workerId: string,
  options: { deploySecret?: boolean; capabilities?: readonly string[]; label?: string } = {},
) {
  seq += 1;
  const label = options.label ?? `S${seq}`;
  const secret = `READINESS_SECRET_${seq}_${Date.now()}`;
  const account = await createAccount({ name: `acct-${label}-${seq}-${Date.now()}` });
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: `trig_readiness_${seq}_${Date.now()}`,
    name: `Factory ${label}`,
    tokenSecretName: secret,
    tokenDigest: `digest-${seq}`,
    routineVersion: null,
    baseUrl: null,
    capabilities: [...(options.capabilities ?? FACTORY_ROUTING_CAPABILITIES)],
  });
  await bindRoutineWorker(routine.id, workerId);
  if (options.deploySecret !== false) {
    process.env[secret] = 'placeholder-not-a-token';
    deployed.push(secret);
  }
  return { routine: (await getRoutineByRef(routine.routineRef))!, account, secret };
}

/** A real units bin, exactly as `remote.ts` builds the stage that pushes. */
async function unitsBin(projectId = fixture.project.id): Promise<Bin> {
  const bin = await createBin({
    projectId,
    kind: 'FACTORY_UNITS',
    title: 'Implement a unit',
    objective: 'Move a branch.',
    manifest: {
      objective: 'Move a branch.',
      why: 'readiness agreement',
      repository: {
        remote: GRANT().remote,
        ref: 'production',
        baseSha: 'b'.repeat(40),
        integrationBranch: 'factory/campaign/x',
        pullRequest: null,
      },
      lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'u', establishes: 'a value', input: '{}', transform: 'sha256', dependsOn: [] }],
      acceptableSources: [],
      excludedSources: [],
      evidence: ['x'],
      outputs: ['x'],
      authorizedActions: ['x'],
      prohibitedActions: ['x'],
      budgetUnits: 1,
      retry: { maxAttempts: 2, backoffSeconds: 30 },
      stoppingConditions: ['x'],
    },
    completionContract: 'FACTORY_UNITS_V1',
    workloadClass: 'FACTORY_UNIT',
    requiredCapabilities: [FACTORY_CAPABILITY, FACTORY_WRITE_CAPABILITY],
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  return (await getBin(bin.id))!;
}

/** The card, and the dispatcher's own decision about a real bin — they must agree. */
async function both(projectId = fixture.project.id) {
  const card = (await repositoryOnboarding(projectId)).find((one) => one.grantId === GRANT().id)!;
  const snapshot = await fleetSnapshot();
  const decision = routeBin({
    bin: await unitsBin(projectId),
    candidates: snapshot.candidates,
    fleetPolicy: snapshot.fleetPolicy,
    fleetInFlight: snapshot.fleetInFlight,
    now: new Date().toISOString(),
  });
  expect(card.readiness === 'READY').toBe(decision.ok);
  return { card, decision };
}

describe('Build previews the same account allocation as the dispatcher', () => {
  /** The preview, and the dispatcher's own decision about a real units bin. */
  async function previewAndFire() {
    const view = await factoryAllocation({ projectId: fixture.project.id, canReport: true });
    const repo = view.repositories.find((one) => one.grantId === GRANT().id)!;
    const snapshot = await fleetSnapshot();
    const decision = routeBin({
      bin: await unitsBin(),
      candidates: snapshot.candidates,
      fleetPolicy: snapshot.fleetPolicy,
      fleetInFlight: snapshot.fleetInFlight,
      now: new Date().toISOString(),
    });
    expect(repo.nextAccountId).toBe(decision.ok ? decision.account.id : null);
    return repo;
  }

  it('routes from 40/100 reports, then around a provider refusal, without firing anything', async () => {
    const workerId = await onboard();
    const owner = await surface(workerId, { label: 'owner' });
    const friend = await surface(workerId, { label: 'friend' });
    const dispatchesBefore = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM bin_dispatch'))!.n;

    await recordAllowanceReport({ accountId: owner.account.id, remainingPercent: 40,
      reportedBy: actor.id, projectId: fixture.project.id });
    await recordAllowanceReport({ accountId: friend.account.id, remainingPercent: 100,
      reportedBy: actor.id, projectId: fixture.project.id });
    const repo = await previewAndFire();
    expect(repo.nextAccountId).toBe(friend.account.id);
    expect(repo.explanation).toMatch(/person-reported/);
    expect(repo.accounts.map((one) => [one.id, one.remainingPercent])).toEqual(
      expect.arrayContaining([[owner.account.id, 40], [friend.account.id, 100]]),
    );
    expect(repo.accounts.every((one) => one.fires === 0 && one.arrivals === 0)).toBe(true);

    // A cooldown always wins over a higher reported allowance.
    await recordAccountRefusal({ accountId: friend.account.id, reason: 'provider asked to wait',
      retryAt: new Date(Date.now() + 60_000).toISOString() });
    const after = await previewAndFire();
    expect(after.nextAccountId).toBe(owner.account.id);
    expect(after.accounts.find((one) => one.id === friend.account.id)?.unavailable)
      .toMatch(/rate limited/);

    // Nothing was fired, claimed or queued to answer either question.
    const dispatchesAfter = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM bin_dispatch'))!.n;
    expect(Number(dispatchesAfter)).toBe(Number(dispatchesBefore));
  });
});

describe('the allocation counts are read from bin_events, never inferred', () => {
  it('counts fires, arrivals at the next generation and provider refusals, per account', async () => {
    const workerId = await onboard();
    const counted = await surface(workerId, { label: 'counted' });
    const bin = await unitsBin();
    const common = { binId: bin.id, projectId: fixture.project.id, accountId: counted.account.id,
      routineId: counted.routine.id, workloadClass: 'FACTORY_UNIT' };
    // Two fires; only the first one's bin was then taken by a session.
    await recordBinEvent({ ...common, eventType: 'DISPATCH_SENT', leaseGeneration: 0 });
    await recordBinEvent({ binId: bin.id, projectId: fixture.project.id, eventType: 'BIN_ASSIGNED', leaseGeneration: 1 });
    await recordBinEvent({ ...common, eventType: 'DISPATCH_SENT', leaseGeneration: 5 });
    await recordBinEvent({ ...common, eventType: 'PROVIDER_ALLOWANCE' });

    const view = await factoryAllocation({ projectId: fixture.project.id, canReport: false });
    const row = view.repositories.find((one) => one.grantId === GRANT().id)!
      .accounts.find((one) => one.id === counted.account.id)!;
    expect(row).toMatchObject({ fires: 2, arrivals: 1, providerRefusals: 1, remainingPercent: null });
    expect(row.reportFresh).toBe(false);
  });
});

describe('the probe is the stage that pushes', () => {
  it('requires exactly what a units bin requires', () => {
    expect([...FACTORY_ROUTING_CAPABILITIES].sort()).toEqual(
      [FACTORY_CAPABILITY, FACTORY_WRITE_CAPABILITY].sort(),
    );
  });
});

describe('Build calls a repository READY only where the dispatcher would fire', () => {
  it('an enabled, bound surface with no deployed secret is not ready', async () => {
    const workerId = await onboard();
    const { secret } = await surface(workerId, { deploySecret: false });
    const { card, decision } = await both();
    expect(decision.ok).toBe(false);
    expect(card.readiness).toBe('NO_USABLE_SURFACE');
    expect(card.surfaces[0]!.dispatch).toBe('UNUSABLE');
    expect(card.surfaces[0]!.dispatchReason).toContain(secret);
    expect(card.remaining.join(' ')).toContain(secret);
    expect(card.accountsServing).toBe(0);
    expect(card.eligibleSurfaces).toBe(0);
  });

  it('a surface without repository-write is not ready', async () => {
    const workerId = await onboard();
    await surface(workerId, { capabilities: [FACTORY_CAPABILITY] });
    const { card, decision } = await both();
    expect(decision.ok).toBe(false);
    expect(card.readiness).toBe('NO_USABLE_SURFACE');
    expect(card.surfaces[0]!.dispatchReason).toContain('capability');
  });

  it.each(['UNAVAILABLE', 'DRAINING', 'QUARANTINED'] as const)(
    'a %s surface is listed with its reason and is not ready',
    async (state) => {
      const workerId = await onboard();
      const { routine } = await surface(workerId);
      expect(
        await setRoutineState({ routineId: routine.id, from: 'ENABLED', to: state, reason: `taken out: ${state}` }),
      ).toBe(true);
      const { card } = await both();
      expect(card.readiness).toBe('NO_USABLE_SURFACE');
      expect(card.surfaces).toHaveLength(1);
      expect(card.surfaces[0]!.state).toBe(state);
      expect(card.surfaces[0]!.dispatchReason).toContain(`taken out: ${state}`);
    },
  );

  it('a surface whose account is quarantined is not ready', async () => {
    const workerId = await onboard();
    const { account } = await surface(workerId);
    await setAccountState({ accountId: account.id, from: 'ENABLED', to: 'QUARANTINED', reason: 'auth' });
    const { card } = await both();
    expect(card.readiness).toBe('NO_USABLE_SURFACE');
  });

  it('a retired (archived) surface is history, and the card asks for a surface again', async () => {
    const workerId = await onboard();
    const { routine } = await surface(workerId);
    await setRoutineState({ routineId: routine.id, from: 'ENABLED', to: 'RETIRED', reason: 'retired' });
    const { card } = await both();
    expect(card.readiness).toBe('AWAITING_SURFACE');
    expect(card.surfaces).toHaveLength(0);
  });

  it('an archived worker is not onboarded, whatever its surfaces say', async () => {
    const workerId = await onboard();
    await surface(workerId);
    await archiveWorker(workerId);
    const { card } = await both();
    expect(card.readiness).toBe('NOT_ONBOARDED');
  });

  it('a worker without this project is not ready here', async () => {
    const workerId = await onboard();
    await surface(workerId);
    await revokeMembership(fixture.project.id, 'WORKER', workerId);
    const { card } = await both();
    expect(card.readiness).toBe('NOT_ONBOARDED');
  });

  it('a worker without this repository is not ready here', async () => {
    const workerId = await onboard();
    await surface(workerId);
    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: ['someone/else'],
      capabilities: [...FACTORY_ROUTING_CAPABILITIES],
      reason: 'narrowed elsewhere',
      setBy: 'test',
    });
    const { card } = await both();
    expect(card.readiness).toBe('NOT_ONBOARDED');
  });

  it('a routing row that declares no repository-write is repaired by onboarding, not called ready', async () => {
    const workerId = await onboard();
    await surface(workerId);
    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: [GRANT().remote.replace('https://github.com/', '').toLowerCase()],
      capabilities: [FACTORY_CAPABILITY],
      reason: 'read-only',
      setBy: 'test',
    });
    const card = (await repositoryOnboarding(fixture.project.id))[0]!;
    expect(card.readiness).toBe('NOT_ONBOARDED');
    expect(card.remaining[0]).toContain('repository-write');
  });

  it('another project reads the repository as not onboarded, even with a ready surface here', async () => {
    const workerId = await onboard();
    await surface(workerId);
    const { createProject } = await import('../server/repos/projects.ts');
    const elsewhere = await createProject({ name: `A friend's own project ${Date.now()}` });
    const { card } = await both(elsewhere.id);
    expect(card.readiness).toBe('NOT_ONBOARDED');
    expect((await both()).card.readiness).toBe('READY');
  });

  it('a valid surface nobody has fired is READY and says it is unproven', async () => {
    const workerId = await onboard();
    await surface(workerId);
    const { card } = await both();
    expect(card.readiness).toBe('READY');
    expect(card.eligibleSurfaces).toBe(1);
    expect(card.provenSurfaces).toBe(0);
    expect(card.surfaces[0]!.proven).toBe(false);
    expect(card.summary).toContain('configured rather than proven');
  });
});

describe('capacity is waiting, not broken', () => {
  it('a provider cooldown reads WAITING_FOR_CAPACITY with when it ends', async () => {
    const workerId = await onboard();
    const { account } = await surface(workerId);
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    await recordAccountRefusal({ accountId: account.id, reason: '429', retryAt: until });
    const { card } = await both();
    expect(card.readiness).toBe('WAITING_FOR_CAPACITY');
    expect(card.surfaces[0]!.dispatch).toBe('WAITING');
    expect(card.summary).toContain(until);
    // Nothing tells a person to re-register a surface that is merely busy.
    expect(card.remaining).toHaveLength(0);
    expect(card.accountsServing).toBe(1);
  });
});

describe('a historical proof is not present capacity', () => {
  it('a proven surface taken out of routing is not ready, and is still proven', async () => {
    const workerId = await onboard();
    const { routine } = await surface(workerId);
    const { assignNextBin, claimDispatchIntent, ensureDispatchIntent, finishBin, markDispatchRoutine, markDispatchSent } =
      await import('../server/repos/bins.ts');
    const bin = await unitsBin();
    await ensureDispatchIntent(bin);
    const intent = (await claimDispatchIntent())!;
    await markDispatchRoutine(intent.id, routine.id);
    await markDispatchSent(intent.id, {
      routineRef: routine.routineRef,
      sessionRef: 'cse_readiness',
      routineId: routine.id,
      accountId: routine.accountId,
    });
    const assigned = (await assignNextBin({
      workerId,
      projectIds: [fixture.project.id],
      credentialId: 'cred_readiness',
      sessionRef: 'cse_readiness',
    }))!;
    await finishBin(
      { binId: bin.id, leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, workerId },
      { state: 'COMPLETE', reason: 'answered' },
    );
    expect((await repositoryOnboarding(fixture.project.id))[0]!.provenSurfaces).toBe(1);

    await setRoutineState({ routineId: routine.id, from: 'ENABLED', to: 'QUARANTINED', reason: 'no-shows' });
    const { card } = await both();
    expect(card.readiness).toBe('NO_USABLE_SURFACE');
    expect(card.provenSurfaces).toBe(1);
    expect(card.accountsServing).toBe(0);
  });
});

describe('the fleet reading agrees with routing about who could be fired', () => {
  it('a quarantined surface with its secret deployed is not eligible now', async () => {
    const workerId = await onboard();
    const { routine } = await surface(workerId);
    await setRoutineState({ routineId: routine.id, from: 'ENABLED', to: 'QUARANTINED', reason: 'x' });
    const reading = (await capacityReading()).surfaces.find((one) => one.routineId === routine.id)!;
    expect(['HEALTHY', 'CONFIGURING']).not.toContain(reading.health);
  });

  it('a surface whose provider asked Brain to wait is waiting, not eligible now', async () => {
    const workerId = await onboard();
    const { routine, account } = await surface(workerId);
    await recordAccountRefusal({
      accountId: account.id,
      reason: '429',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const reading = (await capacityReading()).surfaces.find((one) => one.routineId === routine.id)!;
    expect(reading.health).toBe('WAITING');
  });
});

describe('a member’s research connection is never counted as a Factory account', () => {
  it('even tagged with both repository capabilities, on a worker that is a project member', async () => {
    await onboard();
    const { createWorker, grantMembership } = await import('../server/repos/identity.ts');
    const research = await createWorker({
      name: `research-a-friend-${Date.now()}`,
      displayName: 'A friend (research)',
      workerType: 'MCP',
      description: 'What “Your Claude connection” creates.',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await grantMembership({
      projectId: fixture.project.id,
      principalType: 'WORKER',
      principalId: research.id,
      role: null,
      scopes: ['project:read', 'research:write', 'queue:claim'],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    // The capability tags are an operator's label; the worker's routing is what
    // it may be handed. A mis-tagged research surface must still not count.
    await surface(research.id, { label: 'friend-research' });

    const { card, decision } = await both();
    expect(decision.ok).toBe(false);
    expect(decision.ok ? null : decision.refusal).toBe('NO_SURFACE_SERVES_THIS_FAMILY');
    expect(card.readiness).toBe('AWAITING_SURFACE');
    expect(card.surfaces).toHaveLength(0);
    expect(card.accountsServing).toBe(0);
    expect(card.contributedSurfaces).toHaveLength(0);
  });
});

describe('verify-pool reads eligibility from the router too', () => {
  it('agrees with the card about a missing secret and about a valid surface', async () => {
    const { verifyFactoryPool } = await import('../server/services/dispatch/pool.ts');
    const workerId = await onboard();
    const { secret } = await surface(workerId, { deploySecret: false, label: 'no-secret' });
    await surface(workerId, { label: 'valid' });
    const report = await verifyFactoryPool({
      workerName: factoryWorkerName(GRANT().id),
      repository: GRANT().remote.replace('https://github.com/', ''),
    });
    const card = (await repositoryOnboarding(fixture.project.id))[0]!;
    for (const pooled of report.surfaces) {
      const carded = card.surfaces.find((one) => one.routineName === pooled.routineName)!;
      expect(pooled.eligible).toBe(carded.dispatch === 'ELIGIBLE');
    }
    const missing = report.surfaces.find((one) => one.routineName === 'Factory no-secret')!;
    expect(missing.eligible).toBe(false);
    expect(missing.ineligibleBecause.join(' ')).toContain(secret);
    expect(report.surfaces.find((one) => one.routineName === 'Factory valid')!.eligible).toBe(true);
  });
});

describe('another Claude account can be invited into a READY repository’s pool', () => {
  it('issues one link per member, keeps every earlier link live, and changes no membership, routing or boundary', async () => {
    const { issueFactoryInvitation } = await import('../server/services/factory/onboard.ts');
    const { listInvitationsForWorker } = await import('../server/repos/invitations.ts');
    const { createUser, getWorkerRouting, listMembershipsForPrincipal } = await import('../server/repos/identity.ts');
    const { getProjectRepository } = await import('../server/repos/factory.ts');
    const friend = await createUser({
      email: `friend-${Date.now()}@example.com`,
      displayName: 'A friend',
      password: 'a-long-enough-test-password',
      isBrainAdmin: false,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const another = await createUser({
      email: `another-${Date.now()}@example.com`,
      displayName: 'Another friend',
      password: 'a-long-enough-test-password',
      isBrainAdmin: false,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const issue = (intendedUserId: string) =>
      issueFactoryInvitation({
        projectId: fixture.project.id,
        grantId: GRANT().id,
        intendedUserId,
        actor,
        origin: 'https://brain.example',
      });

    // Nothing to connect to before onboarding.
    expect((await issue(friend.id)).ok).toBe(false);

    const workerId = await onboard();
    await surface(workerId);
    expect((await repositoryOnboarding(fixture.project.id))[0]!.readiness).toBe('READY');

    const before = {
      routing: await getWorkerRouting(workerId),
      memberships: await listMembershipsForPrincipal('WORKER', workerId),
      boundary: await getProjectRepository(fixture.project.id, GRANT().id),
    };
    const live = async () =>
      (await listInvitationsForWorker(workerId)).filter((one) => !one.revokedAt && !one.redeemedAt);
    const onboardingLinks = (await live()).length;

    const first = await issue(friend.id);
    const second = await issue(another.id);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.result.invitationUrl).toMatch(/\/oauth\/invite\//);
    expect(second.result.invitationUrl).not.toBe(first.result.invitationUrl);
    // Issuing the second withdrew nothing: both are live, beside onboarding's own.
    const nowLive = await live();
    expect(nowLive).toHaveLength(onboardingLinks + 2);
    expect(nowLive.map((one) => one.intendedUserId)).toEqual(
      expect.arrayContaining([friend.id, another.id]),
    );
    expect(await getWorkerRouting(workerId)).toEqual(before.routing);
    expect(await listMembershipsForPrincipal('WORKER', workerId)).toEqual(before.memberships);
    expect(await getProjectRepository(fixture.project.id, GRANT().id)).toEqual(before.boundary);
  });
});
