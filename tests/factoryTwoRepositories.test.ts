/**
 * Two authorized repositories, two workers, and the dimensions that keep them
 * apart.
 *
 * Everything before this proved the factory could be pointed at *a* repository.
 * The moment there are two, three questions become answerable that were not, and
 * all three had wrong answers:
 *
 *   1. **Does onboarding A make Brain fire A's surface for B's work?** It did.
 *      The fire router scoped by workload family and capability and not by
 *      repository, so two factory surfaces were interchangeable to it — and the
 *      one it picked on headroom was refused by the assigner with
 *      `REPOSITORY_NOT_AUTHORIZED`, spending an activation and an attempt while
 *      B's own surface was never tried.
 *   2. **Does a temporary fleet condition kill a campaign a person is on their
 *      way to fixing?** It did. An empty registry and a fully quarantined fleet
 *      exhausted the bin's five dispatch attempts and abandoned it, for two
 *      conditions whose remedies — `fleet register-routine` and `fleet
 *      set-state` — this codebase documents.
 *   3. **Does a fleet that is merely switched off say so?** It did not. Every
 *      candidate was refused on its own state before any scope question was
 *      asked, so the flags those questions set stayed false and the first check
 *      after the loop claimed the refusal: a quarantined fleet reported
 *      `NO_SURFACE_SERVES_THIS_FAMILY`.
 *
 * And beneath all three, the property that must survive them: what still refuses
 * permanently still refuses. A repository outside the envelope, a worker outside
 * its routing row, a caller outside its role — none of those is a wait.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  createUser,
  getWorkerByName,
  getWorkerRouting,
  listMembershipsForPrincipal,
} from '../server/repos/identity.ts';
import {
  bindRoutineWorker,
  createAccount,
  createRoutine,
  listRoutines,
  setRoutineState,
} from '../server/repos/fleet.ts';
import {
  createBin,
  ensureDispatchIntent,
  getBin,
  getDispatch,
  listDispatchesForBin,
  markDispatchDeferred,
  rearmSurfaceDeferredIntents,
} from '../server/repos/bins.ts';
import { dispatchTick, OPERATOR_RESOLVED_KINDS } from '../server/services/dispatch/loop.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';
import { REFUSAL_WAIT, routeBin } from '../server/services/dispatch/router.ts';
import type { RoutingRefusal } from '../server/services/dispatch/router.ts';
import { binAdmission } from '../server/services/bins/service.ts';
import { decideRepository, listRepositoryGrants } from '../server/services/factory/repositoryEnvelope.ts';
import {
  FACTORY_ROUTING_CAPABILITIES,
  factoryWorkerName,
  onboardRepository,
  repositoryIdOfRemote,
  repositoryOnboarding,
} from '../server/services/factory/onboard.ts';
import { listInvitationsForWorker } from '../server/repos/invitations.ts';
import type { Bin, BinManifest, Principal, User } from '../server/domain/types.ts';

const BASE = 'd'.repeat(40);

const MOUNT = () => listRepositoryGrants().find((g) => g.id === 'brain-worker-bootstrap')!;
const TARGET = () => listRepositoryGrants().find((g) => g.id === 'oakwood-site')!;

let fixture: TestProject;
let actor: User;
let realFetch: typeof globalThis.fetch;
let fired: string[] = [];

beforeEach(async () => {
  fixture = await freshProject();
  fired = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.includes('/fire')) {
      fired.push(url);
      return new Response(JSON.stringify({ claude_code_session_id: `cse_${fired.length}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as typeof globalThis.fetch;
  actor = await createUser({
    email: `two-repos-${Math.random().toString(36).slice(2)}@example.test`,
    displayName: 'The owner',
    password: 'a-long-enough-test-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const name of ['MOUNT_SECRET', 'TARGET_SECRET', 'LONE_SECRET']) delete process.env[name];
  await teardown();
});

function manifest(over: Partial<BinManifest> = {}): BinManifest {
  return {
    objective: 'Do the declared thing.',
    why: 'a two-repository test',
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

async function factoryBin(remote: string, title: string): Promise<Bin> {
  const bin = await createBin({
    projectId: fixture.project.id,
    kind: 'FACTORY_UNITS',
    title,
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
    requiredCapabilities: [...FACTORY_ROUTING_CAPABILITIES],
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  return (await getBin(bin.id))!;
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

async function onboard(grantId: string) {
  const outcome = await onboardRepository({
    projectId: fixture.project.id,
    grantId,
    actor,
    origin: 'https://brain.example',
  });
  if (!outcome.ok) throw new Error(`onboarding refused: ${outcome.reason}`);
  return outcome.result;
}

/** A fire surface bound to one worker, with its deployment secret present. */
async function surface(workerId: string, secret: string, name: string): Promise<string> {
  const account = await createAccount({ name, planLabel: null, declaredPlanPower: null });
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: `trig_${secret.toLowerCase()}`,
    name,
    tokenSecretName: secret,
    tokenDigest: 'digest',
    capabilities: [...FACTORY_ROUTING_CAPABILITIES],
  });
  await bindRoutineWorker(routine.id, workerId);
  process.env[secret] = 'not-a-real-token';
  return routine.id;
}

async function route(bin: Bin) {
  const snapshot = await fleetSnapshot();
  return routeBin({
    bin,
    candidates: snapshot.candidates,
    fleetPolicy: snapshot.fleetPolicy,
    fleetInFlight: snapshot.fleetInFlight,
    now: new Date().toISOString(),
  });
}

/* ========================================================================= */

describe('two repositories, two workers, and no crossing between them', () => {
  it('gives each repository its own worker, its own scope and its own invitation', async () => {
    const mount = await onboard(MOUNT().id);
    const target = await onboard(TARGET().id);

    expect(mount.onboarding.workerId).not.toBe(target.onboarding.workerId);
    expect(mount.onboarding.workerName).toBe(factoryWorkerName(MOUNT().id));
    expect(target.onboarding.workerName).toBe(factoryWorkerName(TARGET().id));

    const mountRouting = (await getWorkerRouting(mount.onboarding.workerId!))!;
    const targetRouting = (await getWorkerRouting(target.onboarding.workerId!))!;
    expect(mountRouting.repositories).toEqual([repositoryIdOfRemote(MOUNT().remote)]);
    expect(targetRouting.repositories).toEqual([repositoryIdOfRemote(TARGET().remote)]);
    // Exhaustive in both directions: neither row lists the other's repository.
    expect(mountRouting.repositories).not.toContain(repositoryIdOfRemote(TARGET().remote));
    expect(targetRouting.repositories).not.toContain(repositoryIdOfRemote(MOUNT().remote));

    // One live invitation each, and they are different invitations.
    for (const worker of [mount.onboarding.workerId!, target.onboarding.workerId!]) {
      const live = (await listInvitationsForWorker(worker)).filter(
        (i) => i.revokedAt === null && i.redeemedAt === null,
      );
      expect(live).toHaveLength(1);
    }
    expect(mount.invitationUrl).not.toBe(target.invitationUrl);
  });

  /*
   * The defect this file was written for.
   *
   * Onboarding the mount registers a surface Brain would happily have fired for
   * the target's bin — same project, same family, same capabilities — because the
   * router had no repository dimension. The assigner would then refuse it, so
   * nothing false was ever recorded; what was spent was an activation, one of the
   * bin's dispatch attempts, and the chance to try the surface that could do it.
   */
  it('does not fire the mount’s surface for the target’s work', async () => {
    const mount = await onboard(MOUNT().id);
    await surface(mount.onboarding.workerId!, 'MOUNT_SECRET', 'mount-account');

    const targetBin = await factoryBin(TARGET().remote, 'Change the site');
    const decision = await route(targetBin);

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal).toBe('NO_SURFACE_SERVES_THIS_REPOSITORY');
      // Named, so the remedy is legible: onboard *that* repository.
      expect(decision.reason).toContain(repositoryIdOfRemote(TARGET().remote)!);
      expect(decision.considered[0]?.verdict).toContain('not authorized for');
    }

    // And the fire never happens, over as many ticks as you like.
    await ensureDispatchIntent(targetBin);
    for (let pass = 0; pass < 4; pass += 1) await dispatchTick();
    expect(fired).toHaveLength(0);
  });

  it('sends each repository’s work to that repository’s surface', async () => {
    const mount = await onboard(MOUNT().id);
    const target = await onboard(TARGET().id);
    const mountRoutine = await surface(mount.onboarding.workerId!, 'MOUNT_SECRET', 'mount-account');
    const targetRoutine = await surface(target.onboarding.workerId!, 'TARGET_SECRET', 'target-account');

    const mountBin = await factoryBin(MOUNT().remote, 'Change the bootstrap');
    const targetBin = await factoryBin(TARGET().remote, 'Change the site');

    const forMount = await route(mountBin);
    const forTarget = await route(targetBin);
    expect(forMount.ok).toBe(true);
    expect(forTarget.ok).toBe(true);
    if (forMount.ok) expect(forMount.routine.id).toBe(mountRoutine);
    if (forTarget.ok) expect(forTarget.routine.id).toBe(targetRoutine);
  });

  it('refuses the arriving worker the other repository’s bin, as it always did', async () => {
    const mount = await onboard(MOUNT().id);
    const admit = await binAdmission({
      workerId: mount.onboarding.workerId!,
      principal: await principalFor(mount.onboarding.workerId!),
      sessionRef: 'cse_mount',
    });
    expect((await admit(await factoryBin(MOUNT().remote, 'its own'))).ok).toBe(true);
    const other = await admit(await factoryBin(TARGET().remote, 'somebody else’s'));
    expect(other.ok).toBe(false);
    expect(other.reason).toContain('REPOSITORY_NOT_AUTHORIZED');
  });

  /*
   * The re-arm inherits the dimension for free, because the predicate *is*
   * `routeBin`. Onboarding and surfacing the mount must not put the target's
   * deferred stage back — waking work nothing can route is a fire the work that
   * can be routed does not get.
   */
  it('wakes only the repository whose surface arrived', async () => {
    const mountBin = await factoryBin(MOUNT().remote, 'Change the bootstrap');
    const targetBin = await factoryBin(TARGET().remote, 'Change the site');
    for (const bin of [mountBin, targetBin]) {
      await ensureDispatchIntent(bin);
      const [intent] = await listDispatchesForBin(bin.id);
      await markDispatchDeferred(intent!.id, {
        refusal: 'NO_SURFACE_SERVES_THIS_REPOSITORY',
        message: 'nobody is registered for this repository',
        retryAfterMs: 24 * 60 * 60 * 1000,
      });
    }

    const mount = await onboard(MOUNT().id);
    await surface(mount.onboarding.workerId!, 'MOUNT_SECRET', 'mount-account');
    await dispatchTick();

    const [woken] = await listDispatchesForBin(mountBin.id);
    const [asleep] = await listDispatchesForBin(targetBin.id);
    expect(Date.parse(woken!.nextAttemptAt)).toBeLessThan(Date.now() + 60 * 60 * 1000);
    expect(Date.parse(asleep!.nextAttemptAt)).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
    // Exactly one fire, and it was the mount's.
    expect(fired).toHaveLength(1);
    expect(fired[0]).toContain('trig_mount_secret');
  });
});

/* ========================================================================= */

describe('a temporary fleet condition is a wait, and a permanent refusal is not', () => {
  /*
   * The classification is total by type, which is the point: a refusal in
   * neither set used to fall silently into the exhausting branch, and that is
   * how two of them got there. This asserts the whole union is classified and
   * that none of it exhausts.
   */
  it('classifies every routing refusal as a wait, and none as a failure', () => {
    const ALL: RoutingRefusal[] = [
      'NO_ROUTINES_REGISTERED',
      'FLEET_PAUSED',
      'FLEET_TARGET_REACHED',
      'ALL_SURFACES_INELIGIBLE',
      'ALL_SURFACES_RATE_LIMITED',
      'NO_CAPABLE_SURFACE',
      'NO_SURFACE_SERVES_THIS_FAMILY',
      'NO_SURFACE_SERVES_THIS_REPOSITORY',
      'ACCOUNT_TARGETS_REACHED',
    ];
    // Every member of the union, and nothing else.
    expect(Object.keys(REFUSAL_WAIT).sort()).toEqual([...ALL].sort());
    for (const refusal of ALL) expect(['CAPACITY', 'OPERATOR']).toContain(REFUSAL_WAIT[refusal]);
    // The two an authorized action resolves are operator waits, which is what
    // makes them re-armable by the write that resolves them.
    expect(REFUSAL_WAIT['NO_ROUTINES_REGISTERED']).toBe('OPERATOR');
    expect(REFUSAL_WAIT['ALL_SURFACES_INELIGIBLE']).toBe('OPERATOR');
  });

  it('names a switched-off fleet as switched off, not as a missing routing row', async () => {
    const mount = await onboard(MOUNT().id);
    const routineId = await surface(mount.onboarding.workerId!, 'MOUNT_SECRET', 'mount-account');
    await setRoutineState({
      routineId,
      from: 'ENABLED',
      to: 'QUARANTINED',
      reason: 'AUTH 401 from the provider',
    });

    const decision = await route(await factoryBin(MOUNT().remote, 'its own'));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal).toBe('ALL_SURFACES_INELIGIBLE');
      // The remedy, in the words §23 already uses for it.
      expect(decision.reason).toContain('fleet set-state');
    }
  });

  it('holds the stage through a quarantine and hands it over when the surface returns', async () => {
    const mount = await onboard(MOUNT().id);
    const routineId = await surface(mount.onboarding.workerId!, 'MOUNT_SECRET', 'mount-account');
    await setRoutineState({ routineId, from: 'ENABLED', to: 'QUARANTINED', reason: 'AUTH 401' });

    const bin = await factoryBin(MOUNT().remote, 'its own');
    await ensureDispatchIntent(bin);
    for (let pass = 0; pass < 6; pass += 1) await dispatchTick();

    const [intent] = await listDispatchesForBin(bin.id);
    const held = (await getDispatch(intent!.id))!;
    // Deferred, not abandoned: the attempts a quarantine never justified spending
    // are still there.
    expect(held.state).toBe('PENDING');
    expect(held.lastErrorKind).toBe('ALL_SURFACES_INELIGIBLE');
    expect(held.attemptCount).toBeLessThan(held.maxAttempts);
    expect((await getBin(bin.id))!.state).toBe('READY');
    expect(fired).toHaveLength(0);

    // The answering transition, and the work resumes on the very next tick.
    await setRoutineState({ routineId, from: 'QUARANTINED', to: 'ENABLED', reason: 'secret fixed' });
    await dispatchTick();
    expect(fired).toHaveLength(1);
    expect((await getDispatch(intent!.id))!.state).toBe('SENT');
  });

  it('holds the stage while the registry is empty, and does not wake it into an empty room', async () => {
    const bin = await factoryBin(MOUNT().remote, 'its own');
    await ensureDispatchIntent(bin);
    const [intent] = await listDispatchesForBin(bin.id);
    await markDispatchDeferred(intent!.id, {
      refusal: 'NO_SURFACE_SERVES_THIS_REPOSITORY',
      message: 'nobody is registered for this repository',
      retryAfterMs: 24 * 60 * 60 * 1000,
    });

    // No Routine exists at all, which is what the refusal says.
    expect(await listRoutines()).toHaveLength(0);
    const empty = routeBin({
      bin,
      candidates: [],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: new Date().toISOString(),
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.refusal).toBe('NO_ROUTINES_REGISTERED');

    // Onboarding alone changes `worker_routing`, which is a write the re-arm
    // watches — and the recheck still refuses, because there is nowhere to fire.
    const mount = await onboard(MOUNT().id);
    for (let pass = 0; pass < 4; pass += 1) await dispatchTick();
    let now = (await getDispatch(intent!.id))!;
    expect(now.state).toBe('PENDING');
    expect(now.attemptCount).toBeLessThan(now.maxAttempts);

    // And the moment a surface exists it is put back and fired, with no further
    // action of any kind.
    await surface(mount.onboarding.workerId!, 'MOUNT_SECRET', 'mount-account');
    await dispatchTick();
    now = (await getDispatch(intent!.id))!;
    expect(now.state).toBe('SENT');
    expect(fired).toHaveLength(1);
  });

  /*
   * And the refusals that are decisions rather than waits. None of these is a
   * dispatch intent, so none of them is reached by any of the above — which is
   * the property, stated where somebody widening the deferral would read it.
   */
  it('keeps every permanent refusal permanent', async () => {
    // The envelope: a campaign cannot be created against an unauthorized remote.
    for (const remote of [
      'https://github.com/Peyday007/V5',
      'https://github.com/someone/else',
      'https://github.com/Peyday007/V4',
    ]) {
      expect(decideRepository(remote).ok).toBe(false);
    }
    // Onboarding: a grant the envelope does not name cannot be onboarded, and
    // the refusal does not enumerate what it would have allowed.
    const refused = await onboardRepository({
      projectId: fixture.project.id,
      grantId: 'not-a-grant',
      actor,
      origin: 'https://brain.example',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      for (const grant of listRepositoryGrants()) expect(refused.reason).not.toContain(grant.remote);
    }
    // Admission: a worker registered for one repository is refused the other,
    // ahead of the compare-and-swap, so it costs no attempt.
    const mount = await onboard(MOUNT().id);
    const admit = await binAdmission({
      workerId: mount.onboarding.workerId!,
      principal: await principalFor(mount.onboarding.workerId!),
      sessionRef: 'cse_mount',
    });
    const bin = await factoryBin(TARGET().remote, 'somebody else’s');
    expect((await admit(bin)).ok).toBe(false);
    expect((await getBin(bin.id))!.attemptCount).toBe(0);
  });
});

/* ========================================================================= */

describe('an onboarding whose response was lost', () => {
  /*
   * The write commits and the caller never learns what it said. Everything the
   * person needed — the invitation link, shown once — is gone, and nothing about
   * the rows says so. Recovery is to do it again, and what makes that safe is
   * that onboarding is a repair rather than an accumulation.
   */
  it('recovers by repeating, without a second identity or a second live invitation', async () => {
    const lost = await onboard(MOUNT().id);
    const workerId = lost.onboarding.workerId!;

    const again = await onboard(MOUNT().id);
    expect(again.onboarding.workerId).toBe(workerId);
    expect(again.createdIdentity).toBe(false);
    expect(again.invitationUrl).not.toBe(lost.invitationUrl);

    // One worker, one membership, one routing row, one live invitation.
    expect((await getWorkerByName(factoryWorkerName(MOUNT().id)))!.id).toBe(workerId);
    const memberships = (await listMembershipsForPrincipal('WORKER', workerId)).filter(
      (m) => m.projectId === fixture.project.id && m.active,
    );
    expect(memberships).toHaveLength(1);
    const live = (await listInvitationsForWorker(workerId)).filter(
      (i) => i.revokedAt === null && i.redeemedAt === null,
    );
    expect(live).toHaveLength(1);

    // The invitation whose link was lost is revoked, which is the half that
    // matters: a token nobody read is still a token somebody could have.
    const all = await listInvitationsForWorker(workerId);
    expect(all).toHaveLength(2);
    expect(all.filter((i) => i.revokedAt !== null)).toHaveLength(1);
  });

  it('leaves the deferred work exactly where the first onboarding left it', async () => {
    const bin = await factoryBin(MOUNT().remote, 'its own');
    await ensureDispatchIntent(bin);
    const [intent] = await listDispatchesForBin(bin.id);
    await markDispatchDeferred(intent!.id, {
      refusal: 'NO_SURFACE_SERVES_THIS_REPOSITORY',
      message: 'nobody is registered for this repository',
      retryAfterMs: 24 * 60 * 60 * 1000,
    });
    const before = (await getDispatch(intent!.id))!;

    await onboard(MOUNT().id);
    await onboard(MOUNT().id);
    await onboard(MOUNT().id);

    const after = (await getDispatch(intent!.id))!;
    // Three onboardings, no attempt spent and no duplicate intent.
    expect(after.attemptCount).toBe(before.attemptCount);
    expect(await listDispatchesForBin(bin.id)).toHaveLength(1);
    // And the readiness a person reads is the same one every time.
    const shown = (await repositoryOnboarding(fixture.project.id)).find(
      (r) => r.grantId === MOUNT().id,
    )!;
    expect(shown.readiness).toBe('AWAITING_SURFACE');
    expect(shown.waiting).toBe(1);
  });

  it('re-arms once however many times onboarding is repeated', async () => {
    const bin = await factoryBin(MOUNT().remote, 'its own');
    await ensureDispatchIntent(bin);
    const [intent] = await listDispatchesForBin(bin.id);
    await markDispatchDeferred(intent!.id, {
      refusal: 'NO_SURFACE_SERVES_THIS_REPOSITORY',
      message: 'nobody is registered for this repository',
      retryAfterMs: 24 * 60 * 60 * 1000,
    });
    await onboard(MOUNT().id);
    await onboard(MOUNT().id);
    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS })).toBe(1);
    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS })).toBe(0);
  });
});
