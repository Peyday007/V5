/**
 * Onboarding a repository, and the four things that were missing without it.
 *
 * The factory could be pointed at a repository and could not execute one. Every
 * piece existed — an envelope, a routing table, an invitation redeemer, a
 * dispatcher — and the joins between them were an operator's memory: compose a
 * scope set by hand, write a routing row by hand, mint an invitation with nothing
 * that could mint one, and hope the dispatch intent written before all that had
 * not already exhausted itself.
 *
 * Each test below is one of those joins, and every one of them is checked in both
 * directions: what onboarding makes possible, and what it still refuses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { createUser, createWorker, getWorkerByName, getWorkerRouting, grantMembership, listMembershipsForPrincipal, setWorkerRouting } from '../server/repos/identity.ts';
import { listRepositoryGrants } from '../server/services/factory/repositoryEnvelope.ts';
import {
  FACTORY_ROUTING_CAPABILITIES,
  factoryWorkerName,
  onboardRepository,
  repositoryIdOfRemote,
  repositoryOnboarding,
} from '../server/services/factory/onboard.ts';
import { FACTORY_WORKER_SCOPES } from '../server/domain/types.ts';
import { createBin, getBin, getDispatch, listDispatchesForBin, markDispatchDeferred, ensureDispatchIntent, rearmSurfaceDeferredIntents } from '../server/repos/bins.ts';
import { binAdmission } from '../server/services/bins/service.ts';
import { listInvitationsForWorker } from '../server/repos/invitations.ts';
import type { Bin, BinManifest, Principal, User } from '../server/domain/types.ts';
import { OPERATOR_RESOLVED_KINDS } from '../server/services/dispatch/loop.ts';

let fixture: TestProject;
let actor: User;

const BASE = 'b'.repeat(40);
const GRANT = () => listRepositoryGrants()[0]!;

beforeEach(async () => {
  fixture = await freshProject();
  actor = await createUser({
    email: `onboarder-${Date.now()}@example.com`,
    displayName: 'The onboarder',
    password: 'a-long-enough-test-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
});

function manifest(over: Partial<BinManifest> = {}): BinManifest {
  return {
    objective: 'Do the declared thing.',
    why: 'an onboarding test',
    lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
    units: [{ key: 'u', establishes: 'a value', input: '{}', transform: 'sha256', dependsOn: [] }],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['a stored value'],
    outputs: ['one result'],
    authorizedActions: ['submit unit results'],
    prohibitedActions: ['anything with an external effect'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the declared unit has a result'],
    ...over,
  };
}

async function factoryBin(remote: string): Promise<Bin> {
  const bin = await createBin({
    projectId: fixture.project.id,
    kind: 'FACTORY_UNITS',
    title: 'Implement a unit and push it',
    objective: 'Move a branch.',
    manifest: manifest({
      repository: {
        remote,
        ref: 'main',
        baseSha: BASE,
        integrationBranch: 'factory/campaign/x',
        pullRequest: null,
      },
    }),
    completionContract: 'FACTORY_UNITS_V1',
    workloadClass: 'FACTORY_UNIT',
    requiredCapabilities: ['repository', 'repository-write'],
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  return (await getBin(bin.id))!;
}

async function researchBin(): Promise<Bin> {
  const bin = await createBin({
    projectId: fixture.project.id,
    kind: 'RESEARCH_PACKET',
    title: 'A Step 12A packet',
    objective: 'Establish something from primary sources.',
    manifest: manifest(),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    workloadClass: 'RESEARCH',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  return (await getBin(bin.id))!;
}

/** A principal built the way authentication builds one, from the worker's own rows. */
async function principalFor(workerId: string): Promise<Principal> {
  const memberships = await listMembershipsForPrincipal('WORKER', workerId);
  return {
    type: 'WORKER',
    id: workerId,
    handle: workerId,
    displayName: workerId,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `cred_${workerId}`,
    authMethod: 'WORKER_BEARER',
    memberships,
    requestId: `req_${workerId}`,
  } as unknown as Principal;
}

/**
 * Wait until the wall clock reports a different ISO instant.
 *
 * `rearmSurfaceDeferredIntents` compares an intent's `updated_at` against the
 * newest `fleet_routines` / `worker_routing` write and re-arms only what was
 * deferred **strictly before** it. Timestamps are ISO-8601 with millisecond
 * resolution, so a fixture that defers an intent and then onboards inside the
 * same millisecond has not set up the condition it means to test — it has set up
 * the boundary case, and the assertion then fails on a fast machine and passes on
 * a slow one. This makes the ordering the fixture claims actually true.
 *
 * The production path never needs it: a tick is ten seconds and an operator's
 * write is minutes from a deferral.
 */
async function afterThisInstant(): Promise<void> {
  const started = new Date().toISOString();
  while (new Date().toISOString() === started) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function onboard() {
  const outcome = await onboardRepository({
    projectId: fixture.project.id,
    grantId: GRANT().id,
    actor,
    origin: 'https://brain.example',
  });
  if (!outcome.ok) throw new Error(`onboarding refused: ${outcome.reason}`);
  return outcome.result;
}

/* ========================================================================= */

describe('onboarding registers one worker for one repository', () => {
  it('writes the fixed scope set and an exhaustive FACTORY routing row', async () => {
    const result = await onboard();
    const grant = GRANT();
    const repositoryId = repositoryIdOfRemote(grant.remote)!;

    const worker = (await getWorkerByName(factoryWorkerName(grant.id)))!;
    expect(worker).toBeTruthy();
    expect(result.createdIdentity).toBe(true);

    const membership = (await listMembershipsForPrincipal('WORKER', worker.id)).find(
      (m) => m.projectId === fixture.project.id,
    )!;
    expect([...membership.scopes].sort()).toEqual([...FACTORY_WORKER_SCOPES].sort());

    const routing = (await getWorkerRouting(worker.id))!;
    expect(routing.families).toEqual(['FACTORY']);
    expect(routing.repositories).toEqual([repositoryId]);
    expect(routing.capabilities).toEqual([...FACTORY_ROUTING_CAPABILITIES]);
  });

  /*
   * The second, independent lock. Routing decides what this identity may be
   * *handed*; the scope set decides what it could *write* if it were handed one
   * anyway — and it holds no research scope at all, so it could not record a
   * claim, a verification or an audit verdict even with every routing guard
   * removed. The defect both exist for was one identity doing both jobs.
   */
  it('gives it no scope that could write anybody research', async () => {
    await onboard();
    const worker = (await getWorkerByName(factoryWorkerName(GRANT().id)))!;
    const membership = (await listMembershipsForPrincipal('WORKER', worker.id)).find(
      (m) => m.projectId === fixture.project.id,
    )!;
    for (const forbidden of [
      'research:write',
      'research:propose',
      'claims:write',
      'contradictions:write',
      'external:sync',
    ]) {
      expect(membership.scopes).not.toContain(forbidden);
    }
  });

  it('refuses a repository the envelope does not name, without naming what it does', async () => {
    const outcome = await onboardRepository({
      projectId: fixture.project.id,
      grantId: 'a-repository-nobody-authorized',
      actor,
      origin: 'https://brain.example',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      for (const grant of listRepositoryGrants()) {
        expect(outcome.reason).not.toContain(grant.remote);
      }
    }
  });

  /*
   * A rotation as much as a setup, which is `connectSite`'s property and the
   * reason it matters here too: two live invitations for one worker is two
   * chances to connect something and no way to say which was meant.
   */
  it('replaces the invitation rather than adding a second one', async () => {
    const first = await onboard();
    const second = await onboard();
    expect(second.createdIdentity).toBe(false);
    expect(second.invitationUrl).not.toEqual(first.invitationUrl);

    const worker = (await getWorkerByName(factoryWorkerName(GRANT().id)))!;
    const live = (await listInvitationsForWorker(worker.id)).filter(
      (invitation) => !invitation.revokedAt && !invitation.redeemedAt,
    );
    expect(live).toHaveLength(1);
  });

  it('never puts the invitation anywhere it can be read back', async () => {
    const result = await onboard();
    expect(result.invitationUrl).toContain('/oauth/invite/brnv_');
    // The projection a later read returns carries the identity and the scope and
    // nothing that could reconstruct the link.
    const [projected] = await repositoryOnboarding(fixture.project.id);
    expect(JSON.stringify(projected)).not.toContain('brnv_');
  });
});

describe('an onboarded worker may be handed its repository and nothing else', () => {
  it('admits the repository it was registered for', async () => {
    await onboard();
    const worker = (await getWorkerByName(factoryWorkerName(GRANT().id)))!;
    const bin = await factoryBin(GRANT().remote);
    const admit = await binAdmission({
      workerId: worker.id,
      principal: await principalFor(worker.id),
      sessionRef: 'cse_factory',
    });
    expect((await admit(bin)).ok).toBe(true);
  });

  it('refuses a different repository, and research, and says which dimension', async () => {
    await onboard();
    const worker = (await getWorkerByName(factoryWorkerName(GRANT().id)))!;
    const principal = await principalFor(worker.id);
    const admit = await binAdmission({
      workerId: worker.id,
      principal,
      sessionRef: 'cse_factory',
    });

    const elsewhere = await admit(await factoryBin('https://github.com/someone/else'));
    expect(elsewhere.ok).toBe(false);
    expect(elsewhere.reason).toContain('REPOSITORY_NOT_AUTHORIZED');

    const research = await admit(await researchBin());
    expect(research.ok).toBe(false);
    expect(research.reason).toContain('FAMILY_NOT_SERVED');
  });

  /*
   * And the crossing in the other direction, which is the one ACC-14 actually
   * observed: the research identity is refused the factory's own work.
   */
  it('refuses the factory bin to a research worker', async () => {
    await onboard();
    const researcher = await createWorker({
      name: 'a-research-worker',
      createdByType: 'SYSTEM',
      createdById: 't',
    });
    await grantMembership({
      projectId: fixture.project.id,
      principalType: 'WORKER',
      principalId: researcher.id,
      role: 'MEMBER',
      scopes: ['queue:claim', 'research:write'],
      grantedByType: 'SYSTEM',
      grantedById: 't',
    });
    const admit = await binAdmission({
      workerId: researcher.id,
      principal: await principalFor(researcher.id),
      sessionRef: 'cse_research',
    });
    const verdict = await admit(await factoryBin(GRANT().remote));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('FAMILY_NOT_SERVED');
  });
});

describe('readiness is derived, and says what is left', () => {
  it('walks NOT_ONBOARDED to AWAITING_SURFACE to READY', async () => {
    const before = (await repositoryOnboarding(fixture.project.id))[0]!;
    expect(before.readiness).toBe('NOT_ONBOARDED');
    expect(before.remaining.join(' ')).toContain('Onboard');

    await onboard();
    const after = (await repositoryOnboarding(fixture.project.id))[0]!;
    expect(after.readiness).toBe('AWAITING_SURFACE');
    // Both remaining steps, in the order they have to happen, and the second one
    // says plainly that the access is granted where the worker runs.
    expect(after.remaining).toHaveLength(2);
    expect(after.remaining[0]).toContain('connector');
    expect(after.remaining[1]).toContain('register-routine');

    const { createAccount, createRoutine, bindRoutineWorker } = await import(
      '../server/repos/fleet.ts'
    );
    const account = await createAccount({ name: 'proving', planLabel: null, declaredPlanPower: null });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_proving',
      name: 'Factory surface',
      tokenSecretName: 'A_SECRET_NAME',
      tokenDigest: 'digest',
      routineVersion: null,
      baseUrl: null,
      capabilities: [...FACTORY_ROUTING_CAPABILITIES],
    });
    const worker = (await getWorkerByName(factoryWorkerName(GRANT().id)))!;
    await bindRoutineWorker(routine.id, worker.id);

    const ready = (await repositoryOnboarding(fixture.project.id))[0]!;
    expect(ready.readiness).toBe('READY');
    expect(ready.remaining).toHaveLength(0);
    expect(ready.surfaces).toContain('Factory surface');
  });
});

describe('a stage deferred before its worker existed is put back by the onboarding', () => {
  /*
   * The stale-backoff failure, end to end.
   *
   * A factory bin created before anybody was registered for its repository is
   * refused `NO_SURFACE_SERVES_THIS_FAMILY`, deferred, and — before this — sat
   * behind that timestamp until it lapsed, because the re-arm only watched
   * `fleet_routines` and onboarding writes `worker_routing`. So the repository
   * became executable and the work already waiting for it did not notice.
   */
  it('re-arms a scope-deferred intent when a routing row is written', async () => {
    const bin = await factoryBin(GRANT().remote);
    await ensureDispatchIntent(bin);
    const [intent] = await listDispatchesForBin(bin.id);
    expect(intent).toBeTruthy();

    await markDispatchDeferred(intent!.id, {
      refusal: 'NO_SURFACE_SERVES_THIS_FAMILY',
      message: 'no registered worker may be handed FACTORY work',
      retryAfterMs: 24 * 60 * 60 * 1000,
    });
    const deferred = (await getDispatch(intent!.id))!;
    expect(Date.parse(deferred.nextAttemptAt)).toBeGreaterThan(Date.now() + 60_000);

    // Nothing has changed about the fleet yet, so nothing is put back.
    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS })).toBe(0);

    await afterThisInstant();
    await onboard();

    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS })).toBe(1);
    const rearmed = (await getDispatch(intent!.id))!;
    expect(Date.parse(rearmed.nextAttemptAt)).toBeLessThanOrEqual(Date.now() + 1_000);
    // The attempt count is untouched: a re-arm is not a retry and must not spend
    // one of the five this intent has.
    expect(rearmed.attemptCount).toBe(deferred.attemptCount);
  });

  it('leaves an intent deferred for a reason onboarding does not answer', async () => {
    const bin = await factoryBin(GRANT().remote);
    await ensureDispatchIntent(bin);
    const [intent] = await listDispatchesForBin(bin.id);
    await markDispatchDeferred(intent!.id, {
      refusal: 'ALL_SURFACES_RATE_LIMITED',
      message: 'the account is at its ceiling',
      retryAfterMs: 24 * 60 * 60 * 1000,
    });
    await afterThisInstant();
    await onboard();
    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS })).toBe(0);
  });
});

describe('the dispatcher waits for an operator rather than exhausting the stage', () => {
  /*
   * A scope refusal used to spend one of the bin's five dispatch attempts and
   * abandon at the fifth — and an abandoned stage counts toward the campaign's
   * per-stage ceiling. So a campaign created before its repository was onboarded
   * had destroyed its own planning stage by the time the worker existed, for a
   * reason that was never about the work.
   */
  it('keeps the attempts a scope refusal never justified spending', async () => {
    const { dispatchTick } = await import('../server/services/dispatch/loop.ts');
    const { createAccount, createRoutine } = await import('../server/repos/fleet.ts');
    const account = await createAccount({ name: 'busy', planLabel: null, declaredPlanPower: null });
    // A Routine bound to a worker registered for research only: a real fleet that
    // cannot serve this family, rather than an empty registry.
    const researcher = await createWorker({
      name: 'research-only',
      createdByType: 'SYSTEM',
      createdById: 't',
    });
    await setWorkerRouting({
      workerId: researcher.id,
      families: ['RESEARCH', 'GENERAL'],
      repositories: [],
      capabilities: [],
      reason: 'research only',
      setBy: 'test',
    });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_research_only',
      name: 'Research surface',
      tokenSecretName: 'ANOTHER_SECRET',
      tokenDigest: 'digest',
      routineVersion: null,
      baseUrl: null,
      capabilities: [],
    });
    const { bindRoutineWorker } = await import('../server/repos/fleet.ts');
    await bindRoutineWorker(routine.id, researcher.id);
    // A Routine whose deployment secret is absent is left out of routing and
    // reported, which is a different refusal — so the value is present here and
    // the fleet is genuinely healthy and genuinely wrong for this family.
    process.env['ANOTHER_SECRET'] = 'not-a-real-token';

    const bin = await factoryBin(GRANT().remote);
    await ensureDispatchIntent(bin);

    for (let pass = 0; pass < 6; pass += 1) await dispatchTick();

    const [intent] = await listDispatchesForBin(bin.id);
    const after = (await getDispatch(intent!.id))!;
    expect(after.state).toBe('PENDING');
    expect(after.lastErrorKind).toBe('NO_SURFACE_SERVES_THIS_FAMILY');
    expect(after.attemptCount).toBeLessThan(after.maxAttempts);
    // And the bin is still there to be handed out the moment a surface exists.
    expect((await getBin(bin.id))!.state).toBe('READY');
    delete process.env['ANOTHER_SECRET'];
  });
});

/* ========================================================================= */

/**
 * A surface for the onboarded worker, so the fleet is genuinely able to serve
 * this repository. Everything below turns on the difference between "the fleet
 * cannot do this" and "the fleet cannot do *that one*".
 */
async function surfaceFor(workerId: string, secret: string): Promise<void> {
  const { bindRoutineWorker, createAccount, createRoutine } = await import('../server/repos/fleet.ts');
  const account = await createAccount({ name: `acct-${secret}`, planLabel: null, declaredPlanPower: null });
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: `trig_${secret}`,
    name: `Surface ${secret}`,
    tokenSecretName: secret,
    tokenDigest: 'digest',
    routineVersion: null,
    baseUrl: null,
    capabilities: [...FACTORY_ROUTING_CAPABILITIES],
  });
  await bindRoutineWorker(routine.id, workerId);
  process.env[secret] = 'not-a-real-token';
}

describe('a re-arm wakes the work the change was about, and nothing else', () => {
  /*
   * The scoped re-arm.
   *
   * The old re-arm put back every scope-deferred intent on any fleet write, so
   * onboarding one repository woke every stranded bin in the Brain — each of
   * which was then fired at, refused, and deferred again. That is not merely
   * wasteful: a fire spent on work nobody can do is a fire the work that *can*
   * be done did not get.
   *
   * The dimension the recheck can decide on is the one the fire router decides
   * on, which is the **family** — §27 is explicit that the repository is settled
   * at admission instead, where being wrong records something false rather than
   * wasting a fire. So this holds the re-arm to exactly what the fire would say.
   */
  it('leaves work no surface serves exactly where it was', async () => {
    const { dispatchTick } = await import('../server/services/dispatch/loop.ts');
    const mine = await factoryBin(GRANT().remote);
    const other = await researchBin();
    for (const bin of [mine, other]) {
      await ensureDispatchIntent(bin);
      const [intent] = await listDispatchesForBin(bin.id);
      await markDispatchDeferred(intent!.id, {
        refusal: 'NO_SURFACE_SERVES_THIS_FAMILY',
        message: 'no registered worker may be handed this work',
        retryAfterMs: 24 * 60 * 60 * 1000,
      });
    }

    await afterThisInstant();
    const result = await onboard();
    await surfaceFor(result.onboarding.workerId!, 'SCOPED_REARM_SECRET');

    await dispatchTick();

    const [woken] = await listDispatchesForBin(mine.id);
    const [asleep] = await listDispatchesForBin(other.id);
    // The factory work was reconsidered — it either fired or was deferred again
    // on a *current* decision, and either way it is no longer behind the
    // day-long wall it was parked at.
    expect(Date.parse(woken!.nextAttemptAt)).toBeLessThan(Date.now() + 60 * 60 * 1000);
    // The research packet is served by nobody still, so nothing about it changed.
    expect(Date.parse(asleep!.nextAttemptAt)).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
    expect(asleep!.lastErrorKind).toBe('NO_SURFACE_SERVES_THIS_FAMILY');
    delete process.env['SCOPED_REARM_SECRET'];
  });

  /*
   * Partial setup: the routing row exists and the surface does not.
   *
   * This is the state onboarding *leaves behind on purpose* — Brain cannot
   * create a fire surface — so it has to be a state the system sits in
   * indefinitely without damaging anything. The work keeps its attempts, keeps
   * its blocker, and holds no lease.
   */
  it('holds a stage safely while only half the setup exists', async () => {
    const { dispatchTick } = await import('../server/services/dispatch/loop.ts');
    const bin = await factoryBin(GRANT().remote);
    await ensureDispatchIntent(bin);
    await onboard();

    for (let pass = 0; pass < 4; pass += 1) await dispatchTick();

    const [intent] = await listDispatchesForBin(bin.id);
    const after = (await getDispatch(intent!.id))!;
    expect(after.state).toBe('PENDING');
    expect(after.attemptCount).toBeLessThan(after.maxAttempts);
    const held = (await getBin(bin.id))!;
    expect(held.state).toBe('READY');
    // No lease: nothing is holding this open, so nothing has to be released for
    // a real worker to take it.
    expect(held.workerId).toBeNull();
    expect(held.leaseId).toBeNull();

    // And the projection says which half is missing, rather than reading as
    // finished or as broken.
    const [shown] = await repositoryOnboarding(fixture.project.id);
    expect(shown!.readiness).toBe('AWAITING_SURFACE');
    expect(shown!.waiting).toBe(1);
    expect(shown!.remaining.join(' ')).toMatch(/connector/i);
  });

  /*
   * Revocation. Access taken away has to take effect on the next decision, not
   * at the next restart — and it must not destroy the work, which is somebody
   * else's to resume once access comes back.
   */
  it('stops routing the moment the routing row is taken away', async () => {
    const result = await onboard();
    const workerId = result.onboarding.workerId!;
    const bin = await factoryBin(GRANT().remote);

    const before = await (
      await binAdmission({ workerId, principal: await principalFor(workerId), sessionRef: 'cse_f' })
    )(bin);
    expect(before.ok).toBe(true);

    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: [],
      capabilities: [...FACTORY_ROUTING_CAPABILITIES],
      reason: 'access withdrawn',
      setBy: 'test',
    });

    const after = await (
      await binAdmission({ workerId, principal: await principalFor(workerId), sessionRef: 'cse_f' })
    )(bin);
    expect(after.ok).toBe(false);
    // The bin itself is untouched: revoking somebody's access is not a decision
    // about the work.
    expect((await getBin(bin.id))!.state).toBe('READY');
    // And the card says so, rather than continuing to read as registered.
    const [shown] = await repositoryOnboarding(fixture.project.id);
    expect(shown!.readiness).toBe('NOT_ONBOARDED');
  });

  it('refuses an archived identity rather than quietly reviving it', async () => {
    const { archiveWorker } = await import('../server/repos/identity.ts');
    const result = await onboard();
    await archiveWorker(result.onboarding.workerId!);
    const again = await onboardRepository({
      projectId: fixture.project.id,
      grantId: GRANT().id,
      actor,
      origin: 'https://brain.example',
    });
    expect(again.ok).toBe(false);
  });
});

describe('a duplicate action produces no duplicate execution', () => {
  /*
   * A lost response, from every direction it can be lost from: the person
   * pressed the button again, the tick ran twice, the intent was ensured twice.
   * None of them may produce a second identity, a second live invitation, a
   * second routing row or a second fire.
   */
  it('onboarding twice leaves one worker, one routing row and one invitation', async () => {
    const first = await onboard();
    const second = await onboard();
    expect(second.onboarding.workerId).toBe(first.onboarding.workerId);
    expect(second.createdIdentity).toBe(false);

    const worker = (await getWorkerByName(factoryWorkerName(GRANT().id)))!;
    const routing = (await getWorkerRouting(worker.id))!;
    expect(routing.families).toEqual(['FACTORY']);
    expect(routing.repositories).toEqual([repositoryIdOfRemote(GRANT().remote)]);

    const live = (await listInvitationsForWorker(worker.id)).filter(
      (invitation) => invitation.revokedAt === null && invitation.redeemedAt === null,
    );
    expect(live).toHaveLength(1);

    const memberships = (await listMembershipsForPrincipal('WORKER', worker.id)).filter(
      (m) => m.projectId === fixture.project.id && m.active,
    );
    expect(memberships).toHaveLength(1);
    expect([...memberships[0]!.scopes].sort()).toEqual([...FACTORY_WORKER_SCOPES].sort());
  });

  it('ensuring the intent twice is still one fire’s worth of intent', async () => {
    const bin = await factoryBin(GRANT().remote);
    expect(await ensureDispatchIntent(bin)).toBe(true);
    expect(await ensureDispatchIntent(bin)).toBe(false);
    expect(await listDispatchesForBin(bin.id)).toHaveLength(1);
  });

  it('re-arming twice puts the same intent back once', async () => {
    const bin = await factoryBin(GRANT().remote);
    await ensureDispatchIntent(bin);
    const [intent] = await listDispatchesForBin(bin.id);
    await markDispatchDeferred(intent!.id, {
      refusal: 'NO_SURFACE_SERVES_THIS_FAMILY',
      message: 'nobody is registered for this repository',
      retryAfterMs: 24 * 60 * 60 * 1000,
    });
    await afterThisInstant();
    await onboard();
    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS })).toBe(1);
    // The re-arm stamps the intent, so the watermark it compares against is now
    // behind it. Self-limiting by construction rather than by a flag.
    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS })).toBe(0);
  });
});
