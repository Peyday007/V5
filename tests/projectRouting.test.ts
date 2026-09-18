/**
 * A fire aimed at a surface that cannot be handed the work.
 *
 * ---------------------------------------------------------------------------
 * The defect
 * ---------------------------------------------------------------------------
 *
 * `services/bins/routing.ts` lists the project as dimension 1 and the assigner
 * has always applied it: `assignNextBin` scopes its candidate query by the
 * caller's active memberships. The *fire* did not. `routeBin` filtered on
 * account state, Routine state, workload family, repository, capabilities, rate
 * limits and headroom, and on nothing else — so with four private operations,
 * four workers and four Routines, Brain picked between the four surfaces on
 * headroom alone and three of the four could not take the bin.
 *
 * Nothing false was recorded and no bin attempt was spent: the assigner refused
 * them correctly, exactly as designed. What was spent was an activation each
 * time, plus a thirty-minute in-flight window before the intent could be
 * re-armed — and `bin_dispatch.max_attempts` is five, so a bin could plausibly
 * exhaust its dispatch budget without its own worker ever being fired.
 *
 * ---------------------------------------------------------------------------
 * Why this dimension fails closed when the other two do not
 * ---------------------------------------------------------------------------
 *
 * The router states the rule it lives by: fail closed where the unknown could
 * record something false, fail open where it could only waste a fire. Family
 * and repository are scopes an operator *narrows*, so not having narrowed one
 * is an unknown, and failing open there costs the occasional wasted fire.
 *
 * A project membership is not a narrowing. It is the authorization itself, in
 * rows Brain wrote — `fleet_routines.worker_id` names the worker and
 * `project_memberships` says what that worker may be handed — so there is no
 * unknown to fail open on, and the waste is the common case rather than the
 * occasional one. This is §27's own correction for repositories, at the
 * dimension that correction did not reach.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import {
  createWorker,
  grantMembership,
  revokeMembership,
  setWorkerRouting,
} from '../server/repos/identity.ts';
import {
  bindRoutineWorker,
  createAccount,
  createRoutine,
  setRoutineState,
} from '../server/repos/fleet.ts';
import {
  createBin,
  getBin,
  listBinEvents,
  listDispatchesForBin,
  rearmSurfaceDeferredIntents,
} from '../server/repos/bins.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';
import {
  OPERATOR_RESOLVED_ROUTING_REFUSALS,
  REFUSAL_WAIT,
  routeBin,
  waitsForOperator,
} from '../server/services/dispatch/router.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import { findTool } from '../server/mcp/tools.ts';
import type { Bin, BinManifest, Principal, WorkerScope } from '../server/domain/types.ts';

const SCOPES: WorkerScope[] = [
  'project:read',
  'research:read',
  // `derivedFamiliesFrom` reads this one to imply the RESEARCH family, so a
  // fixture without it describes a worker that may be handed GENERAL work only.
  'research:write',
  'queue:read',
  'queue:claim',
  'queue:complete',
];

/** One private operation: a project, a worker on it, and a Routine bound to it. */
interface Operation {
  who: string;
  projectId: string;
  workerId: string;
  routineId: string;
  routineRef: string;
}

let seeded = '';
const fired: string[] = [];

beforeEach(async () => {
  const fixture = await freshProject();
  seeded = fixture.project.id;
  fired.length = 0;
  process.env['PROJECT_ROUTING_SECRET'] = 'not-a-real-token';
  // Every fire is intercepted. Nothing external is called by this suite.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fired.push(String(input));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
});

function manifest(projectId: string): BinManifest {
  return {
    objective: 'Prove a fire lands only where the work can be taken.',
    why: 'the project is dimension one',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [{ key: 'u1', establishes: 'a value', input: 'x', transform: 'sha256', dependsOn: [] }],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['a stored value'],
    outputs: ['one unit result'],
    authorizedActions: ['submit unit results'],
    prohibitedActions: ['anything with an external effect'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the declared unit has a verified result'],
  };
}

async function readyBin(projectId: string, kind = 'RESEARCH_PACKET'): Promise<Bin> {
  const bin = await createBin({
    projectId,
    kind,
    title: `work for ${projectId}`,
    objective: 'Establish something.',
    manifest: manifest(projectId),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    workloadClass: 'RESEARCH',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  return (await getBin(bin.id))!;
}

/**
 * One operation, set up the way §31's topology says: one project, one worker
 * holding only that project, one Routine bound to that worker.
 */
async function operation(who: string, projectId?: string): Promise<Operation> {
  const id =
    projectId ??
    (
      await createProject({
        name: `${who} operation`,
        slug: `${who}-${Math.random().toString(36).slice(2, 8)}`,
      })
    ).id;
  const worker = await createWorker({
    name: `worker-${who}-${Math.random().toString(36).slice(2, 8)}`,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  await grantMembership({
    projectId: id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const account = await createAccount({ provider: 'anthropic', name: `acct-${who}` });
  const ref = `trig_${who}`;
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: ref,
    name: `V-${who}`,
    tokenSecretName: 'PROJECT_ROUTING_SECRET',
  });
  await bindRoutineWorker(routine.id, worker.id);
  return { who, projectId: id, workerId: worker.id, routineId: routine.id, routineRef: ref };
}

/** Route one bin against the real snapshot, the way the tick does. */
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

describe('four private operations, four surfaces', () => {
  it('routes every bin only to the Routine whose worker holds its project', async () => {
    const ops = [
      await operation('ana', seeded),
      await operation('ben'),
      await operation('cara'),
      await operation('dee'),
    ];

    for (const op of ops) {
      const bin = await readyBin(op.projectId);
      const decision = await route(bin);
      expect(
        decision.ok,
        `${op.who}: ${!decision.ok ? decision.refusal : 'routed'}`,
      ).toBe(true);
      if (decision.ok) {
        expect(decision.routine.routineRef).toBe(op.routineRef);
      }
      // And every other surface was considered and turned down for the project.
      if (decision.ok) {
        const others = decision.considered.filter((c) => c.routineId !== op.routineId);
        expect(others.length).toBe(3);
        expect(others.every((c) => c.verdict === 'serves no work in this project')).toBe(true);
      }
    }
  });

  it('dispatches two projects concurrently with zero cross-project fires', async () => {
    const ana = await operation('ana', seeded);
    const ben = await operation('ben');
    const anaBin = await readyBin(ana.projectId);
    const benBin = await readyBin(ben.projectId);

    /*
     * Asserted on the *decision* as well as on the outcome, because the outcome
     * alone is a coin toss.
     *
     * With two idle surfaces and two bins a project-blind router hands out one
     * fire each about half the time, purely by headroom rotation — so a test
     * that only counted fires passed against the defect it was written for. It
     * was caught by removing the filter and watching this one go green. What
     * cannot happen by luck is the other operation's surface being *considered
     * and refused for the project*, so that is what is asserted.
     */
    for (const [mine, theirs, bin] of [
      [ana, ben, anaBin],
      [ben, ana, benBin],
    ] as const) {
      const decision = await route(bin);
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.routine.routineRef).toBe(mine.routineRef);
        expect(decision.considered).toContainEqual({
          routineId: theirs.routineId,
          verdict: 'serves no work in this project',
        });
      }
    }

    const tick = await dispatchTick({ burst: 4 });
    expect(tick.fired).toBe(2);
    // One fire each, at the surface that can actually take the work.
    expect(fired.filter((url) => url.includes(ana.routineRef))).toHaveLength(1);
    expect(fired.filter((url) => url.includes(ben.routineRef))).toHaveLength(1);
    expect(tick.unrouted).toEqual({});
  });

  it('refuses project B’s bin to a surface that only holds project A', async () => {
    const ana = await operation('ana', seeded);
    const ben = await operation('ben');
    // Take Ben's own surface out, so the only enabled candidate is Ana's.
    await setRoutineState({
      routineId: ben.routineId,
      from: 'ENABLED',
      to: 'UNAVAILABLE',
      reason: 'held for this test',
    });

    const decision = await route(await readyBin(ben.projectId));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal).toBe('NO_SURFACE_SERVES_THIS_PROJECT');
      expect(decision.considered).toContainEqual({
        routineId: ana.routineId,
        verdict: 'serves no work in this project',
      });
    }
  });
});

describe('what makes a surface eligible, and what takes it away', () => {
  it('drops a Routine the moment its worker’s membership is revoked', async () => {
    const ana = await operation('ana', seeded);
    const bin = await readyBin(ana.projectId);
    expect((await route(bin)).ok).toBe(true);

    expect(await revokeMembership(ana.projectId, 'WORKER', ana.workerId)).toBe(true);

    // No cache to invalidate: the snapshot reads live memberships, and a revoked
    // one is not a weaker membership, it is none.
    const after = await route(bin);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.refusal).toBe('NO_SURFACE_SERVES_THIS_PROJECT');
  });

  it('leaves a Routine bound to no worker ineligible for project work', async () => {
    const account = await createAccount({ provider: 'anthropic', name: 'unbound' });
    await createRoutine({
      accountId: account.id,
      routineRef: 'trig_unbound',
      name: 'V-unbound',
      tokenSecretName: 'PROJECT_ROUTING_SECRET',
    });

    const decision = await route(await readyBin(seeded));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal).toBe('NO_SURFACE_SERVES_THIS_PROJECT');
      // The remedy is named, because an escalation whose fix is invisible is
      // not a remedy.
      expect(decision.reason).toContain('bind-worker');
      expect(decision.reason).toContain('access grant');
    }
  });

  it('names a switched-off fleet as switched off, not as a missing membership', async () => {
    const ana = await operation('ana', seeded);
    await setRoutineState({
      routineId: ana.routineId,
      from: 'ENABLED',
      to: 'QUARANTINED',
      reason: 'AUTH 401',
    });

    const decision = await route(await readyBin(ana.projectId));
    expect(decision.ok).toBe(false);
    // §23's rule: a surface that never got past its own state was never asked
    // the project question, so the project must not claim the refusal.
    if (!decision.ok) expect(decision.refusal).toBe('ALL_SURFACES_INELIGIBLE');
  });

  it('composes with the repository dimension rather than replacing it', async () => {
    const ana = await operation('ana', seeded);
    // Ana's worker is registered for one repository and one family.
    await setWorkerRouting({
      workerId: ana.workerId,
      families: ['FACTORY'],
      repositories: ['peyday007/one'],
      capabilities: [],
      reason: 'onboarded for one repository',
      setBy: 'test',
    });

    const inScope = await createBin({
      projectId: ana.projectId,
      kind: 'FACTORY_UNITS',
      title: 'work on the authorized repository',
      objective: 'Move a branch.',
      manifest: {
        ...manifest(ana.projectId),
        repository: {
          remote: 'https://github.com/peyday007/one',
          ref: 'main',
          baseSha: 'a'.repeat(40),
          integrationBranch: 'factory/x',
          pullRequest: null,
        },
      },
      completionContract: 'FACTORY_UNITS_V1',
      workloadClass: 'FACTORY_UNIT',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    expect((await route((await getBin(inScope.id))!)).ok).toBe(true);

    // Same project, a repository this worker is not authorized for: the project
    // passes and the repository refuses, each by its own name.
    const outOfScope = await createBin({
      projectId: ana.projectId,
      kind: 'FACTORY_UNITS',
      title: 'work on a repository nobody onboarded',
      objective: 'Move a branch.',
      manifest: {
        ...manifest(ana.projectId),
        repository: {
          remote: 'https://github.com/peyday007/two',
          ref: 'main',
          baseSha: 'b'.repeat(40),
          integrationBranch: 'factory/y',
          pullRequest: null,
        },
      },
      completionContract: 'FACTORY_UNITS_V1',
      workloadClass: 'FACTORY_UNIT',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    const refused = await route((await getBin(outOfScope.id))!);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal).toBe('NO_SURFACE_SERVES_THIS_REPOSITORY');
  });

  it('still routes a deterministic surface probe, which lives in its worker’s own project', async () => {
    /*
     * There is no projectless bin in this schema — `bins.project_id` is NOT
     * NULL — and `verify-surface --probe` already builds its bin in the
     * worker's own first active membership. So the project filter does not make
     * surface verification impossible; it makes it exact.
     */
    const ana = await operation('ana', seeded);
    const probe = await readyBin(ana.projectId, 'DETERMINISTIC_CHECK');
    const decision = await route(probe);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.routine.routineRef).toBe(ana.routineRef);
  });
});

describe('a refusal nobody can act on yet', () => {
  it('defers without spending a bin attempt, a dispatch attempt or a fire', async () => {
    const account = await createAccount({ provider: 'anthropic', name: 'unbound' });
    await createRoutine({
      accountId: account.id,
      routineRef: 'trig_unbound',
      name: 'V-unbound',
      tokenSecretName: 'PROJECT_ROUTING_SECRET',
    });
    const bin = await readyBin(seeded);

    for (let round = 0; round < 6; round += 1) {
      const tick = await dispatchTick({ burst: 1, projectIds: [seeded] });
      expect(tick.fired).toBe(0);
      expect(tick.skippedNotConfigured).toBe(false);
    }

    expect(fired).toHaveLength(0);
    const [intent] = await listDispatchesForBin(bin.id);
    expect(intent!.state).toBe('PENDING');
    expect(intent!.state).not.toBe('ABANDONED');
    expect(intent!.attemptCount).toBe(0);
    expect((await getBin(bin.id))!.state).toBe('READY');

    const events = await listBinEvents(bin.id);
    const deferred = events.find((event) => event.eventType === 'DISPATCH_DEFERRED');
    expect(deferred?.outcome).toBe('NO_SURFACE_SERVES_THIS_PROJECT');
    expect(events.some((event) => event.eventType === 'DISPATCH_ABANDONED')).toBe(false);
  });

  it('is classified as an operator wait, so the re-arm can reach it', () => {
    expect(REFUSAL_WAIT.NO_SURFACE_SERVES_THIS_PROJECT).toBe('OPERATOR');
    expect(waitsForOperator('NO_SURFACE_SERVES_THIS_PROJECT')).toBe(true);
    expect(OPERATOR_RESOLVED_ROUTING_REFUSALS).toContain('NO_SURFACE_SERVES_THIS_PROJECT');
  });

  it('lets the preserved work proceed once a membership makes a surface eligible', async () => {
    const account = await createAccount({ provider: 'anthropic', name: 'late' });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_late',
      name: 'V-late',
      tokenSecretName: 'PROJECT_ROUTING_SECRET',
    });
    const worker = await createWorker({
      name: `worker-late-${Math.random().toString(36).slice(2, 8)}`,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await bindRoutineWorker(routine.id, worker.id);
    const bin = await readyBin(seeded);

    await dispatchTick({ burst: 1, projectIds: [seeded] });
    expect(fired).toHaveLength(0);

    /*
     * Asserted before the re-arm, so a failure says which half broke.
     *
     * `rearmed === 0` has two completely different causes — the intent was
     * never deferred in the first place, or it was and the watermark could not
     * see the membership — and a bare count cannot tell them apart. This one
     * observation is what separates them, and it is what identified the tie
     * below rather than leaving it as an unexplained flake.
     */
    const [deferred] = await listDispatchesForBin(bin.id);
    expect(deferred!.state).toBe('PENDING');
    expect(deferred!.lastErrorKind).toBe('NO_SURFACE_SERVES_THIS_PROJECT');

    /*
     * Wait for the clock to leave the deferral's millisecond, and do not
     * pretend this is a formality.
     *
     * The candidate query is `updated_at < watermark`, strictly, so a fleet
     * write landing in the *same millisecond* as the deferral is not seen by
     * that write. Measured on this machine at roughly one run in three:
     * `intent=…350` against `mem=…350`. The strictness is load-bearing — §27
     * records the unbounded rescan that `<=` reintroduces, where a stamped
     * candidate matches its own stamp for ever — so the product keeps it, and
     * the cost is bounded: such an intent still retries on its own
     * `next_attempt_at`, which this deferral put ten minutes out, and any later
     * operator write re-arms it.
     *
     * In production the two events are a dispatch tick and a person typing a
     * command. Here they were 0.3ms apart, so the test moves them apart rather
     * than depending on which side of a millisecond boundary they fall.
     */
    while (new Date().toISOString() <= deferred!.updatedAt) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // The operator answers the refusal: the worker is given the project. That
    // write is on `project_memberships`, which is why the re-arm watermark has
    // to watch it — `fleet_routines` and `worker_routing` do not move here.
    await grantMembership({
      projectId: seeded,
      principalType: 'WORKER',
      principalId: worker.id,
      role: 'MEMBER',
      scopes: SCOPES,
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });

    const rearmed = await rearmSurfaceDeferredIntents({
      kinds: OPERATOR_RESOLVED_ROUTING_REFUSALS,
      routesNow: async (candidate) => (await route(candidate)).ok,
    });
    expect(rearmed).toBe(1);

    const tick = await dispatchTick({ burst: 1, projectIds: [seeded] });
    expect(tick.fired).toBe(1);
    expect(fired.filter((url) => url.includes('trig_late'))).toHaveLength(1);
    // Nothing was re-submitted and no attempt was spent getting here.
    const [intent] = await listDispatchesForBin(bin.id);
    expect(intent!.binId).toBe(bin.id);
  });
});

describe('the refusal says nothing about projects the caller cannot see', () => {
  it('answers an invented project id exactly as it answers an inaccessible one', async () => {
    const ana = await operation('ana', seeded);
    const ben = await operation('ben');

    const principal = {
      type: 'WORKER',
      id: ana.workerId,
      handle: 'ana-worker',
      displayName: 'ana-worker',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: 'cred_ana',
      authMethod: 'WORKER_BEARER',
      memberships: [
        {
          id: 'mem_ana',
          projectId: ana.projectId,
          principalType: 'WORKER',
          principalId: ana.workerId,
          role: 'MEMBER',
          scopes: SCOPES,
          active: true,
          grantedByType: 'SYSTEM',
          grantedById: 'test',
          grantedAt: new Date().toISOString(),
          revokedAt: null,
        },
      ],
      requestId: 'req_ana',
    } as unknown as Principal;

    const claim = findTool('brain_claim_work')!;
    const ask = async (projectId: string): Promise<string> => {
      try {
        const outcome = await claim.run(
          { project_id: projectId, work_types: ['RESEARCH_PACKET'], limit: 1 },
          { principal, requestId: 'r' },
        );
        return `ok:${JSON.stringify(outcome.value)}`;
      } catch (error) {
        return `refused:${(error as Error).message}`;
      }
    };

    // Ben's project is real and Ana may not have it; the other id never existed.
    // Byte-identical, so neither answer says which of the two it was.
    expect(await ask(ben.projectId)).toBe(await ask('prj_0123456789abcdef0123'));
  });
});
