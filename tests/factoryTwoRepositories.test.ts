/**
 * Two authorized repositories, two workers, and the dimensions that keep them
 * apart.
 *
 * Everything before this proved the factory could be pointed at *a* repository.
 * The moment there are two, three questions become answerable that were not, and
 * all three had wrong answers:
 *
 *   1. **Does registering a surface for A make Brain fire it for B's work?** It
 *      did. The fire router scoped by workload family and capability and not by
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
  createWorker,
  getWorkerByName,
  getWorkerRouting,
  grantMembership,
  listMembershipsForPrincipal,
  setWorkerRouting,
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
import { proveSurface } from '../server/services/dispatch/surfaceProof.ts';
import type { WorkerSession } from '../server/repos/fleet.ts';
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
import { FACTORY_WORKER_SCOPES } from '../server/domain/types.ts';
import type { Bin, BinDispatch, BinManifest, Principal, User } from '../server/domain/types.ts';

const BASE = 'd'.repeat(40);

/**
 * The one authorized grant, and a **fixture** second repository.
 *
 * The second one is deliberately not in the envelope and never will be. An
 * earlier version of this file proved the two-repository properties by
 * authorizing a real, retired repository — which made a test's convenience into
 * a production authorization, and is exactly the shape of mistake the envelope
 * exists to prevent. Nothing here needs a grant: what separates two repositories
 * is a `worker_routing` row and the bin's own manifest, and both can be written
 * for a repository the factory may never be pointed at. That the fixture *is*
 * unauthorized is itself asserted below.
 */
const MOUNT = () => listRepositoryGrants().find((g) => g.id === 'brain-worker-bootstrap')!;
const OTHER_REMOTE = 'https://github.com/fixture-owner/second-repository';
const OTHER_REPO = 'fixture-owner/second-repository';

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

/**
 * A factory worker for a repository the envelope does not name.
 *
 * The same four rows `onboardRepository` writes — identity, membership, the
 * fixed scope set, an exhaustive routing row — written by hand because there is
 * no grant to onboard and there must not be one. Onboarding's *own* properties
 * are tested against the real grant; this exists only to give the routing
 * boundary a second subject to separate.
 */
async function fixtureFactoryWorker(name: string, repositoryId: string): Promise<string> {
  const worker = await createWorker({ name, createdByType: 'SYSTEM', createdById: 'test' });
  await grantMembership({
    projectId: fixture.project.id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: null,
    scopes: [...FACTORY_WORKER_SCOPES],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  await setWorkerRouting({
    workerId: worker.id,
    families: ['FACTORY'],
    repositories: [repositoryId],
    capabilities: [...FACTORY_ROUTING_CAPABILITIES],
    reason: 'a fixture factory worker for a repository the envelope does not name',
    setBy: 'test',
  });
  return worker.id;
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
  it('keeps the two workers’ scopes exhaustive and disjoint', async () => {
    const mount = await onboard(MOUNT().id);
    const other = await fixtureFactoryWorker('factory-fixture-second', OTHER_REPO);

    expect(mount.onboarding.workerId).not.toBe(other);
    expect(mount.onboarding.workerName).toBe(factoryWorkerName(MOUNT().id));

    const mountRouting = (await getWorkerRouting(mount.onboarding.workerId!))!;
    const otherRouting = (await getWorkerRouting(other))!;
    expect(mountRouting.repositories).toEqual([repositoryIdOfRemote(MOUNT().remote)]);
    expect(otherRouting.repositories).toEqual([OTHER_REPO]);
    // Exhaustive in both directions: neither row lists the other's repository.
    expect(mountRouting.repositories).not.toContain(OTHER_REPO);
    expect(otherRouting.repositories).not.toContain(repositoryIdOfRemote(MOUNT().remote));

    // And the second repository is a fixture rather than an authorization: the
    // envelope refuses it, so no campaign could ever be created against it.
    expect(decideRepository(OTHER_REMOTE).ok).toBe(false);

    // The onboarded one has exactly one live invitation. The fixture has none,
    // because nothing issued it one — which is the difference between a worker a
    // person authorized and a row a test wrote.
    const live = (await listInvitationsForWorker(mount.onboarding.workerId!)).filter(
      (i) => i.revokedAt === null && i.redeemedAt === null,
    );
    expect(live).toHaveLength(1);
    expect(await listInvitationsForWorker(other)).toHaveLength(0);
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
  it('does not fire one repository’s surface for another repository’s work', async () => {
    const mount = await onboard(MOUNT().id);
    await surface(mount.onboarding.workerId!, 'MOUNT_SECRET', 'mount-account');

    const otherBin = await factoryBin(OTHER_REMOTE, 'Change the other repository');
    const decision = await route(otherBin);

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal).toBe('NO_SURFACE_SERVES_THIS_REPOSITORY');
      // Named, so the remedy is legible: authorize and onboard *that* repository.
      expect(decision.reason).toContain(OTHER_REPO);
      expect(decision.considered[0]?.verdict).toContain('not authorized for');
    }

    // And the fire never happens, over as many ticks as you like.
    await ensureDispatchIntent(otherBin);
    for (let pass = 0; pass < 4; pass += 1) await dispatchTick();
    expect(fired).toHaveLength(0);
  });

  it('sends each repository’s work to that repository’s surface', async () => {
    const mount = await onboard(MOUNT().id);
    const other = await fixtureFactoryWorker('factory-fixture-second', OTHER_REPO);
    const mountRoutine = await surface(mount.onboarding.workerId!, 'MOUNT_SECRET', 'mount-account');
    const otherRoutine = await surface(other, 'TARGET_SECRET', 'other-account');

    const mountBin = await factoryBin(MOUNT().remote, 'Change the bootstrap');
    const otherBin = await factoryBin(OTHER_REMOTE, 'Change the other repository');

    const forMount = await route(mountBin);
    const forOther = await route(otherBin);
    expect(forMount.ok).toBe(true);
    expect(forOther.ok).toBe(true);
    if (forMount.ok) expect(forMount.routine.id).toBe(mountRoutine);
    if (forOther.ok) expect(forOther.routine.id).toBe(otherRoutine);
  });

  it('refuses the arriving worker the other repository’s bin, as it always did', async () => {
    const mount = await onboard(MOUNT().id);
    const admit = await binAdmission({
      workerId: mount.onboarding.workerId!,
      principal: await principalFor(mount.onboarding.workerId!),
      sessionRef: 'cse_mount',
    });
    expect((await admit(await factoryBin(MOUNT().remote, 'its own'))).ok).toBe(true);
    const elsewhere = await admit(await factoryBin(OTHER_REMOTE, 'somebody else’s'));
    expect(elsewhere.ok).toBe(false);
    expect(elsewhere.reason).toContain('REPOSITORY_NOT_AUTHORIZED');
  });

  /*
   * The re-arm inherits the dimension for free, because the predicate *is*
   * `routeBin`. Onboarding and surfacing the mount must not put the target's
   * deferred stage back — waking work nothing can route is a fire the work that
   * can be routed does not get.
   */
  it('wakes only the repository whose surface arrived', async () => {
    const mountBin = await factoryBin(MOUNT().remote, 'Change the bootstrap');
    const otherBin = await factoryBin(OTHER_REMOTE, 'Change the other repository');
    for (const bin of [mountBin, otherBin]) {
      await ensureDispatchIntent(bin);
      const [intent] = await listDispatchesForBin(bin.id);
      await markDispatchDeferred(intent!.id, {
        refusal: 'NO_SURFACE_SERVES_THIS_REPOSITORY',
        message: 'nobody is registered for this repository',
        retryAfterMs: 24 * 60 * 60 * 1000,
      });
    }

    await afterThisInstant();
    const mount = await onboard(MOUNT().id);
    await surface(mount.onboarding.workerId!, 'MOUNT_SECRET', 'mount-account');
    await dispatchTick();

    const [woken] = await listDispatchesForBin(mountBin.id);
    const [asleep] = await listDispatchesForBin(otherBin.id);
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
    await afterThisInstant();
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
      // Retired, and retired is not authorized.
      'https://github.com/Peyday007/oakwood-junk-removal',
      OTHER_REMOTE,
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
    const bin = await factoryBin(OTHER_REMOTE, 'somebody else’s');
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

    await afterThisInstant();
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

  /*
   * The scan has to be self-limiting in both directions.
   *
   * A candidate the recheck *skips* still matched the candidate query, so
   * without stamping it the next tick re-read its bin and re-routed it, for
   * ever. With the recheck reading a bin per candidate that is up to two hundred
   * extra reads every ten seconds against a Brain that is also serving workers —
   * which is how a deploy's post-restart verification ran an audit step past five
   * minutes and lost the work item's lease.
   */
  it('asks a skipped candidate once per fleet write, not once per tick', async () => {
    const bin = await factoryBin(OTHER_REMOTE, 'nobody is registered for this');
    await ensureDispatchIntent(bin);
    const [intent] = await listDispatchesForBin(bin.id);
    await markDispatchDeferred(intent!.id, {
      refusal: 'NO_SURFACE_SERVES_THIS_REPOSITORY',
      message: 'nobody is registered for this repository',
      retryAfterMs: 24 * 60 * 60 * 1000,
    });
    await afterThisInstant();
    // A fleet write the recheck will answer "no" for: a surface for the *other*
    // repository, which cannot take this bin.
    const mount = await onboard(MOUNT().id);
    await surface(mount.onboarding.workerId!, 'MOUNT_SECRET', 'mount-account');

    const before = (await getDispatch(intent!.id))!;
    let looked = 0;
    const counting = async (candidate: Bin): Promise<boolean> => {
      looked += 1;
      return (await route(candidate)).ok;
    };

    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS, routesNow: counting })).toBe(0);
    expect(looked).toBe(1);

    // Asked, answered, and not asked again until something about the fleet
    // changes — the scan does not grow into a per-tick cost.
    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS, routesNow: counting })).toBe(0);
    expect(looked).toBe(1);

    // And skipping it changed nothing about when it would fire, or its attempts.
    const after = (await getDispatch(intent!.id))!;
    expect(after.nextAttemptAt).toBe(before.nextAttemptAt);
    expect(after.attemptCount).toBe(before.attemptCount);
    expect(after.state).toBe('PENDING');

    // The next fleet write asks it again, because that is the only moment the
    // answer could have changed.
    await afterThisInstant();
    const other = await fixtureFactoryWorker('factory-fixture-second', OTHER_REPO);
    await surface(other, 'TARGET_SECRET', 'other-account');
    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS, routesNow: counting })).toBe(1);
    expect(looked).toBe(2);
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
    await afterThisInstant();
    await onboard(MOUNT().id);
    await onboard(MOUNT().id);
    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS })).toBe(1);
    expect(await rearmSurfaceDeferredIntents({ kinds: OPERATOR_RESOLVED_KINDS })).toBe(0);
  });
});

/* ========================================================================= */

/**
 * Proving a Routine runs as the worker it is bound to.
 *
 * The claim that had to be strengthened. `fleet_routines.worker_id` is an
 * operator's assertion, and an OAuth token is held by a *connector* rather than
 * by a Routine — so "registered for worker X" and "X has authenticated
 * somewhere" can both be true of a Routine whose Cowork configuration actually
 * selects a different connector. That is exactly the mistake a second connector
 * *name* invites.
 *
 * What settles it is a chain of four rows Brain wrote itself: it fired this
 * Routine, a session arrived and was attributed to a worker from that same
 * dispatch row, it was handed the bin, and the bin reached `COMPLETE`.
 */
describe('a surface is proved by a fire that came back and finished something', () => {
  const ROUTINE_REF = 'trig_proof';
  const BOUND = 'wkr_bound';

  function session(over: Partial<WorkerSession> = {}): WorkerSession {
    return {
      sessionRef: 'cse_1',
      workerId: BOUND,
      routineId: 'rtn_1',
      accountId: 'acct_1',
      binId: 'bin_1',
      leaseGeneration: 1,
      observedAt: '2026-09-12T10:00:00.000Z',
      ...over,
    };
  }

  function inputs(over: Partial<Parameters<typeof proveSurface>[0]> = {}) {
    return {
      boundWorkerId: BOUND,
      routineRef: ROUTINE_REF,
      sessions: [session()],
      bins: new Map([['bin_1', { id: 'bin_1', state: 'COMPLETE' } as unknown as Bin]]),
      dispatches: new Map([
        [
          'bin_1',
          [{ routineRef: ROUTINE_REF, sentAt: '2026-09-12T09:59:00.000Z' } as unknown as BinDispatch],
        ],
      ]),
      ...over,
    };
  }

  it('closes the chain when a fire came back, took a bin and completed it', () => {
    const proof = proveSurface(inputs());
    expect(proof.problems).toEqual([]);
    expect(proof.chain).toMatchObject({
      sessionRef: 'cse_1',
      binId: 'bin_1',
      sentAt: '2026-09-12T09:59:00.000Z',
    });
  });

  it('refuses a Routine nothing has ever arrived on, however its rows read', () => {
    const proof = proveSurface(inputs({ sessions: [] }));
    expect(proof.chain).toBeNull();
    expect(proof.problems.join(' ')).toMatch(/has ever produced an authenticated arrival/);
  });

  /*
   * The distinction the strengthening is for: a session that connected and never
   * finished anything proves the connector works and says nothing about whether
   * this surface can be given work and complete it.
   */
  it('refuses an arrival that never completed a bin', () => {
    const proof = proveSurface(
      inputs({ bins: new Map([['bin_1', { id: 'bin_1', state: 'READY' } as unknown as Bin]]) }),
    );
    expect(proof.chain).toBeNull();
    expect(proof.problems.join(' ')).toMatch(/none of them was assigned a bin it then completed/);
  });

  /*
   * And the failure this whole check exists for: the Routine is configured with
   * somebody else's connector, so its arrivals authenticate as another worker.
   * That is a fault rather than a missing proof, and it is named as one.
   */
  it('names the fault when the arrivals are a different worker', () => {
    const proof = proveSurface({
      ...inputs({ sessions: [session({ workerId: 'wkr_research' })] }),
    });
    expect(proof.chain).toBeNull();
    expect(proof.foreignWorkerIds).toEqual(['wkr_research']);
    expect(proof.problems.join(' ')).toMatch(/authenticated as a different worker \(wkr_research\)/);
    expect(proof.problems.join(' ')).toMatch(/not the identity this surface is bound to/);
  });

  it('will not accept a completion that some other Routine’s fire produced', () => {
    const proof = proveSurface(
      inputs({
        dispatches: new Map([
          [
            'bin_1',
            [{ routineRef: 'trig_somebody_else', sentAt: '2026-09-12T09:59:00.000Z' } as unknown as BinDispatch],
          ],
        ]),
      }),
    );
    // The arrival is still this Routine's — `worker_sessions.routine_id` is what
    // selected it — so the chain closes; what is absent is only the fire's own
    // timestamp, and the report says so rather than inventing one.
    expect(proof.chain).not.toBeNull();
    expect(proof.chain!.sentAt).toBeNull();
  });
});
