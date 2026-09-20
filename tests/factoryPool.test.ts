/**
 * One logical Factory worker, served by several Claude accounts.
 *
 * The arrangement being proved here is the one an operator actually wants once a
 * single connector is not enough: `factory-brain` is one identity, one
 * repository and one workload family, and it is reachable through **one
 * independently authenticated connector and Routine per Claude account**, all
 * pooled. Everything in this file is driven through the real routing and claim
 * paths — `routeBin`, `dispatchTick`, `decideBinRouting`, `fleetSnapshot`,
 * `judgePool` — because the properties that matter are properties of the wiring
 * and a fixture that arranged its own answer would prove none of them.
 *
 * Two of them were genuinely missing before this suite existed and are pinned
 * first, because each was invisible to every per-surface test:
 *
 *   - **One unroutable bin ended the whole tick's burst**, so a Factory bin whose
 *     surfaces were all busy stopped research dispatch behind it, and the
 *     reverse. The classification `refusalEndsBurst` is what separates a
 *     fleet-wide refusal from a per-bin one.
 *   - **A surface's refusal charged the bin an attempt**, so five bad tokens
 *     across five accounts could retire a bin that nothing was ever wrong with.
 *
 * And one mechanism had to be built rather than fixed: a probe could not reach a
 * *named* surface, because several Routines bound to one worker are
 * interchangeable to the router. `bins.pinned_routine_id` is that, and
 * `verify-pool` is what uses it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  createWorker,
  getWorkerByName,
  grantMembership,
  setWorkerRouting,
} from '../server/repos/identity.ts';
import {
  bindRoutineWorker,
  createAccount,
  createRoutine,
  credentialDigest,
  getRoutineByRef,
  listRoutines,
  recordWorkerSession,
  routineRegistrationCollision,
  setPolicy,
  setRoutineState,
} from '../server/repos/fleet.ts';
import {
  assignNextBin,
  claimDispatchIntent,
  createBin,
  ensureDispatchIntent,
  finishBin,
  getBin,
  getDispatch,
  listDispatchesForBin,
  markDispatchSent,
} from '../server/repos/bins.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';
import { routeBin } from '../server/services/dispatch/router.ts';
import { decideBinRouting } from '../server/services/bins/routing.ts';
import { judgePool, readFactoryPool, verifyFactoryPool } from '../server/services/dispatch/pool.ts';
import { createProbeBin } from '../server/services/fleet/probe.ts';
import type { BinManifest, Principal } from '../server/domain/types.ts';

const REPOSITORY = 'peyday007/v5';
/** The same repository as a remote, which is how a manifest names one. */
const REMOTE = 'https://github.com/Peyday007/V5';

/** One Claude account: its fleet account, its Routine, its own secret name. */
interface Surface {
  accountId: string;
  accountName: string;
  routineId: string;
  routineRef: string;
  secretName: string;
}

let projectId = '';
let factoryWorkerId = '';
let researchWorkerId = '';
let surfaces: Surface[] = [];
const realFetch = globalThis.fetch;
/** Refs the fake provider refuses, and how. */
let refuse = new Map<string, { status: number; body: unknown }>();
let fired: string[] = [];
let refused: string[] = [];
/** How many of the surfaces Brain reaches for first should refuse. */
let refuseFirst = 0;

/** The one refusal that takes a surface out of routing rather than deferring it. */
const UNAUTHORIZED = {
  status: 401,
  body: {
    error: { message: 'Token is not authorized for this routine', type: 'authentication_error' },
  },
};

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  refuse = new Map();
  fired = [];
  refused = [];
  refuseFirst = 0;

  /*
   * One logical worker, exactly as the arrangement requires. Its routing row is
   * explicit and therefore exhaustive: FACTORY only, this repository only, and
   * both repository capabilities.
   */
  const factory = await createWorker({
    name: 'factory-brain',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  factoryWorkerId = factory.id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: factory.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:claim', 'queue:complete'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  await setWorkerRouting({
    workerId: factory.id,
    families: ['FACTORY'],
    repositories: [REPOSITORY],
    capabilities: ['repository', 'repository-write'],
    reason: 'the pooled factory identity',
    setBy: 'test',
  });

  // The research identity beside it, which must never be handed factory work.
  const research = await createWorker({
    name: 'research-worker',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  researchWorkerId = research.id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: research.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:claim'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  await setWorkerRouting({
    workerId: research.id,
    families: ['RESEARCH', 'GENERAL'],
    repositories: [],
    capabilities: [],
    reason: 'research only',
    setBy: 'test',
  });

  // Three Claude accounts, one Routine each, one secret name each.
  surfaces = [];
  for (const label of ['a', 'b', 'c']) {
    const account = await createAccount({ provider: 'anthropic', name: `claude-${label}` });
    const secretName = `POOL_TEST_TOKEN_${label.toUpperCase()}`;
    process.env[secretName] = `token-${label}`;
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: `trig_pool_${label}`,
      name: `Factory Brain ${label.toUpperCase()}`,
      tokenSecretName: secretName,
      // As `register-routine` stores it: the name, and a digest of the value
      // taken once. Nothing recovers a value from either.
      tokenDigest: credentialDigest(`token-${label}`),
      capabilities: ['repository', 'repository-write'],
    });
    await bindRoutineWorker(routine.id, factory.id);
    surfaces.push({
      accountId: account.id,
      accountName: account.name,
      routineId: routine.id,
      routineRef: routine.routineRef,
      secretName,
    });
  }

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const ref = /\/routines\/([^/]+)\/fire/.exec(url)?.[1] ?? url;
    const named = refuse.get(ref);
    // Refuse a surface this test named, or — when it asked for the first N
    // arrivals to refuse — whichever ones Brain actually reached for first.
    const how =
      named ?? (refused.length < refuseFirst && !refused.includes(ref) ? UNAUTHORIZED : undefined);
    if (how) {
      refused.push(ref);
      return new Response(JSON.stringify(how.body), { status: how.status });
    }
    fired.push(ref);
    return new Response(JSON.stringify({ claude_code_session_id: `cse_${fired.length}` }), {
      status: 200,
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const surface of surfaces) delete process.env[surface.secretName];
});

function manifest(repository: string | null): BinManifest {
  return {
    objective: 'Prove pooled dispatch.',
    why: 'one logical worker on several accounts',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [{ key: 'u', establishes: 'a value', input: 'x', transform: 'sha256', dependsOn: [] }],
    ...(repository
      ? {
          repository: {
            remote: `https://github.com/${repository}`,
            ref: 'main',
            baseSha: '',
            integrationBranch: '',
            pullRequest: null,
          },
        }
      : {}),
    acceptableSources: [],
    excludedSources: [],
    evidence: ['one unit result'],
    outputs: ['one unit result'],
    authorizedActions: ['submit the unit result'],
    prohibitedActions: ['anything with an external effect'],
    budgetUnits: 1,
    retry: { maxAttempts: 2, backoffSeconds: 30 },
    stoppingConditions: ['the declared unit has a result'],
  };
}

async function factoryBin(title: string, options: { pinnedRoutineId?: string } = {}): Promise<string> {
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title,
    objective: 'Prove pooled dispatch.',
    rationale: 'pool test',
    manifest: manifest(REPOSITORY),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    workloadClass: 'FACTORY_SURFACE_PROBE',
    requiredCapabilities: ['repository', 'repository-write'],
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: 5,
    ...(options.pinnedRoutineId ? { pinnedRoutineId: options.pinnedRoutineId } : {}),
  });
  return bin.id;
}

async function researchBin(title: string): Promise<string> {
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title,
    objective: 'Prove research dispatch is unaffected.',
    rationale: 'pool test',
    manifest: manifest(null),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    workloadClass: 'SURFACE_PROBE_RESEARCH_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: 5,
  });
  return bin.id;
}

function principalFor(workerId: string, scopes: string[]): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: workerId,
    displayName: workerId,
    isBrainAdmin: false,
    memberships: [
      { projectId, role: 'MEMBER', scopes, active: true } as Principal['memberships'][number],
    ],
  } as Principal;
}

/* ------------------------------------------------------------------------ */
/* 1. The pool exists, and every account is in it                            */
/* ------------------------------------------------------------------------ */

describe('several accounts serving one logical Factory worker', () => {
  it('exposes every account as a candidate for the same worker and repository', async () => {
    const snapshot = await fleetSnapshot();
    expect(snapshot.candidates).toHaveLength(3);
    for (const candidate of snapshot.candidates) {
      expect(candidate.routine.workerId).toBe(factoryWorkerId);
      expect(candidate.servesFamilies).toEqual(['FACTORY']);
      expect(candidate.servesRepositories).toEqual([REPOSITORY]);
      expect(candidate.servesProjects).toContain(projectId);
    }
    // Three accounts, not one account with three names.
    expect(new Set(snapshot.candidates.map((c) => c.account.id)).size).toBe(3);
  });

  it('shows the pool operationally, with the four facts a list of Routines cannot say', async () => {
    /*
     * Property 9 on the product surface rather than only on a terminal. Every
     * surface in one pool carries the same *name*, so a list of names cannot say
     * whether three accounts are covering for one worker or are three separate
     * pools — the binding says that, the reference says which Routine a remedy
     * is applied to, and the headroom and the last fire say whether this one is
     * carrying any of the load.
     */
    const { fleetView } = await import('../server/services/fleet/view.ts');
    const view = await fleetView({ includeTechnical: false, projectId });
    const mine = view.surfaces.filter((s) => s.boundWorker === 'factory-brain');
    expect(mine).toHaveLength(3);
    for (const surface of mine) {
      expect(surface.accountName).toMatch(/^claude-[abc]$/);
      expect(surface.headroom.used).toBe(0);
      // Nobody has set a target for these, and that is not a ceiling of zero.
      expect(surface.headroom.limit).toBeNull();
      expect(surface.lastOutcome).toBe('never fired');
    }
    // Three accounts: the pool is legible as a pool without any raw identifier.
    expect(new Set(mine.map((s) => s.accountName)).size).toBe(3);
    /*
     * The trigger reference is operator depth, matching §34's own decision on
     * the People surface — this route admits any project member. The binding,
     * the headroom and the outcome are what a member is owed; the identifier a
     * remedy is applied to is what an administrator is.
     */
    expect(mine.every((s) => s.routineRef === null)).toBe(true);
    expect(mine.every((s) => s.workerId === null)).toBe(true);

    const operator = await fleetView({ includeTechnical: true, projectId });
    const refs = operator.surfaces
      .filter((s) => s.boundWorker === 'factory-brain')
      .map((s) => s.routineRef);
    expect(refs.every((ref) => ref !== null && /^trig_pool_[abc]$/.test(ref))).toBe(true);
    expect(new Set(refs).size).toBe(3);
  });

  it('counts a surface that is carrying work against its own recorded ceiling', async () => {
    await setPolicy({
      scope: 'ACCOUNT',
      scopeId: surfaces[0]!.accountId,
      target: 2,
      actor: 'test',
      reason: 'two at a time',
    });
    await factoryBin('busy', { pinnedRoutineId: surfaces[0]!.routineId });
    await dispatchTick({ burst: 5, projectIds: [projectId] });

    const { fleetView } = await import('../server/services/fleet/view.ts');
    // Operator depth, because this asserts on the surface by its trigger ref.
    const view = await fleetView({ includeTechnical: true, projectId });
    const busy = view.surfaces.find((s) => s.routineRef === surfaces[0]!.routineRef)!;
    expect(busy.headroom).toEqual({ used: 1, limit: 2 });
    /*
     * Fired, and nobody has turned up yet — which is what this fixture's fake
     * provider actually does, and what the sentence says. A reading that called
     * that "1 fired" would be describing the request rather than the outcome.
     */
    expect(busy.lastOutcome).toContain('nobody arriving');
    // And its neighbours are untouched: headroom is per surface, not per fleet.
    const idle = view.surfaces.find((s) => s.routineRef === surfaces[1]!.routineRef)!;
    expect(idle.headroom.used).toBe(0);
  });

  it('reports the pool as the set it is, and refuses to call it proven before anything has run', async () => {
    const report = await verifyFactoryPool({ workerName: 'factory-brain', repository: REPOSITORY });
    expect(report.surfaces).toHaveLength(3);
    expect(report.ok).toBe(false);
    // Unproven rather than faulted: nothing has been fired at them yet.
    expect(report.surfaces.map((s) => s.verdict)).toEqual(['UNPROVEN', 'UNPROVEN', 'UNPROVEN']);
    expect(report.problems.join(' ')).toContain('no fire to this Routine has ever produced');
    // Three surfaces, so nothing to say about being unpooled.
    expect(report.notes).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* 2 & 3. Capacity decides, and independent work runs in parallel            */
/* ------------------------------------------------------------------------ */

describe('choosing among the pool', () => {
  it('sends work to the account with room rather than the first one', async () => {
    // Account A is full; B and C are not. The bin must not go to A.
    await setPolicy({ scope: 'ACCOUNT', scopeId: surfaces[0]!.accountId, target: 0, actor: 'test', reason: 'full' });
    const binId = await factoryBin('one');
    const snapshot = await fleetSnapshot();
    const decision = routeBin({
      bin: (await getBin(binId))!,
      candidates: snapshot.candidates,
      fleetPolicy: snapshot.fleetPolicy,
      fleetInFlight: snapshot.fleetInFlight,
      now: new Date().toISOString(),
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.account.id).not.toBe(surfaces[0]!.accountId);
  });

  it('runs independent bins on different accounts in one tick', async () => {
    await factoryBin('one');
    await factoryBin('two');
    await factoryBin('three');

    const result = await dispatchTick({ burst: 5, projectIds: [projectId] });
    expect(result.fired).toBe(3);
    // Three fires, three *different* surfaces: that is the pool doing the one
    // thing a single account cannot.
    expect(new Set(fired).size).toBe(3);
  });
});

/* ------------------------------------------------------------------------ */
/* 4 & 5. Failover, and the ceiling that is never exceeded                   */
/* ------------------------------------------------------------------------ */

describe('a surface that cannot take the work', () => {
  it('fails over to another account without charging the bin an attempt', async () => {
    /*
     * Whichever two surfaces Brain reaches for first refuse with a 401. The bin
     * must still end up fired at the third, and — the half that was wrong —
     * must not have paid for the two refusals. Five accounts with stale tokens
     * would otherwise retire a bin at `max_attempts` for a condition that was
     * never about the work.
     *
     * The refusals are chosen by *arrival* rather than by name on purpose. Which
     * surface the router picks first is its own decision over headroom, and a
     * test that named two of the three in advance would pass or fail on that
     * ordering instead of on the failover it is about.
     */
    refuseFirst = 2;
    const binId = await factoryBin('failover');

    await dispatchTick({ burst: 5, projectIds: [projectId] });

    expect(refused).toHaveLength(2);
    expect(fired).toHaveLength(1);
    expect(refused).not.toContain(fired[0]);

    const routines = await listRoutines();
    for (const ref of refused) {
      expect(routines.find((r) => r.routineRef === ref)?.state).toBe('QUARANTINED');
    }
    // A refusal is not misconduct for the surface that never refused.
    expect(routines.find((r) => r.routineRef === fired[0])?.state).toBe('ENABLED');

    /*
     * The accounting. The intent was claimed three times and refused twice, and
     * the two refusals were refunded — so the charge that remains is the one
     * fire that actually reached a surface.
     */
    const intents = await listDispatchesForBin(binId);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.attemptCount).toBeLessThanOrEqual(1);
    expect(intents[0]!.state).not.toBe('ABANDONED');
  });

  it('fails over inside one tick, so a pool of stale tokens costs time rather than the bin', async () => {
    /*
     * The same failover, read as elapsed work rather than as an outcome: one
     * `dispatchTick` is enough. Before the surface-specific backoff went to
     * zero this took three ticks thirty seconds apart, because the intent it
     * had just refunded was not claimable again — a pool that failed over on
     * paper and waited half a minute per stale token in practice.
     */
    refuseFirst = 2;
    await factoryBin('one tick');
    const result = await dispatchTick({ burst: 5, projectIds: [projectId] });
    expect(result.fired).toBe(1);
    expect(result.failed).toBe(2);
  });

  it('never fires an account past its target', async () => {
    for (const surface of surfaces) {
      await setPolicy({ scope: 'ACCOUNT', scopeId: surface.accountId, target: 1, actor: 'test', reason: 'one each' });
    }
    for (let i = 0; i < 6; i += 1) await factoryBin(`bin-${i}`);

    await dispatchTick({ burst: 10, projectIds: [projectId] });

    // Three accounts at one each: three fires and no more, however many bins ask.
    expect(fired).toHaveLength(3);
    expect(new Set(fired).size).toBe(3);
  });

  it('does not let one unroutable bin stop the bins behind it', async () => {
    /*
     * The burst defect, pinned from both sides. A factory bin with every factory
     * surface quarantined is unroutable; a research bin behind it is not — and
     * before `refusalEndsBurst` the first one ended the tick, so the second was
     * never considered.
     *
     * The research surface here is a fourth account bound to the research
     * identity, which is the shape a real Brain has.
     */
    for (const surface of surfaces) {
      await setRoutineState({
        routineId: surface.routineId,
        from: 'ENABLED',
        to: 'QUARANTINED',
        reason: 'test',
      });
    }
    const account = await createAccount({ provider: 'anthropic', name: 'claude-research' });
    process.env['POOL_TEST_TOKEN_R'] = 'token-r';
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_pool_research',
      name: 'Research',
      tokenSecretName: 'POOL_TEST_TOKEN_R',
    });
    await bindRoutineWorker(routine.id, researchWorkerId);

    // The factory bin first, so it is the one the burst reaches first.
    await factoryBin('unroutable factory work');
    await researchBin('perfectly routable research');

    const result = await dispatchTick({ burst: 5, projectIds: [projectId] });
    delete process.env['POOL_TEST_TOKEN_R'];

    expect(fired).toEqual(['trig_pool_research']);
    expect(result.fired).toBe(1);
    expect(result.deferred).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------------ */
/* 6 & 7. The two identities never cross                                     */
/* ------------------------------------------------------------------------ */

describe('research and Factory stay apart under pooling', () => {
  it('permanently refuses a research identity any Factory bin', async () => {
    const binId = await factoryBin('factory work');
    const decision = decideBinRouting({
      bin: (await getBin(binId))!,
      principal: principalFor(researchWorkerId, ['project:read', 'queue:claim']),
      routing: {
        workerId: researchWorkerId,
        reason: 'test',
        families: ['RESEARCH', 'GENERAL'],
        repositories: [],
        capabilities: [],
        explicit: true,
      },
    });
    expect(decision.ok).toBe(false);
    expect(decision.refusal).toBe('FAMILY_NOT_SERVED');
  });

  it('permanently refuses the Factory identity any research bin', async () => {
    const binId = await researchBin('research work');
    const decision = decideBinRouting({
      bin: (await getBin(binId))!,
      principal: principalFor(factoryWorkerId, ['project:read', 'queue:claim']),
      routing: {
        workerId: factoryWorkerId,
        reason: 'test',
        families: ['FACTORY'],
        repositories: [REPOSITORY],
        capabilities: ['repository', 'repository-write'],
        explicit: true,
      },
    });
    expect(decision.ok).toBe(false);
    expect(decision.refusal).toBe('FAMILY_NOT_SERVED');
  });

  it('will not fire a Factory surface for research work, so the fire agrees with the claim', async () => {
    const binId = await researchBin('research work');
    const snapshot = await fleetSnapshot();
    const decision = routeBin({
      bin: (await getBin(binId))!,
      candidates: snapshot.candidates,
      fleetPolicy: snapshot.fleetPolicy,
      fleetInFlight: snapshot.fleetInFlight,
      now: new Date().toISOString(),
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal).toBe('NO_SURFACE_SERVES_THIS_FAMILY');
  });
});

/* ------------------------------------------------------------------------ */
/* 8 & 9. Duplicates, replay, and one secret each                            */
/* ------------------------------------------------------------------------ */

describe('registration and replay', () => {
  it('refuses a second Routine on the same trigger reference', async () => {
    await expect(
      createRoutine({
        accountId: surfaces[1]!.accountId,
        routineRef: surfaces[0]!.routineRef,
        name: 'a duplicate',
        tokenSecretName: 'POOL_TEST_TOKEN_A',
      }),
    ).rejects.toThrow();
  });

  it('produces exactly one fire per bin however many ticks read it', async () => {
    const binId = await factoryBin('once');
    const bin = (await getBin(binId))!;
    // The same intent, ensured twice: ON CONFLICT DO NOTHING by (bin, generation).
    await ensureDispatchIntent(bin);
    await ensureDispatchIntent(bin);
    expect(await listDispatchesForBin(binId)).toHaveLength(1);

    await dispatchTick({ burst: 5, projectIds: [projectId] });
    await dispatchTick({ burst: 5, projectIds: [projectId] });
    expect(fired).toHaveLength(1);
  });

  it('refuses a second Routine on a secret — or a token — another one already holds', async () => {
    /*
     * Two Routines on one trigger token is one surface wearing two rows, and the
     * damage runs both ways: the pool reports capacity that does not exist, and
     * one stale token quarantines two surfaces. The name catches the
     * copy-paste; the digest catches the same value stored twice under two
     * names, which the name check cannot see.
     */
    const registered = await listRoutines();
    const mine = registered.find((r) => r.routineRef === surfaces[0]!.routineRef)!;

    const byName = routineRegistrationCollision(registered, {
      tokenSecretName: mine.tokenSecretName,
      tokenDigest: credentialDigest('a-completely-different-token'),
    });
    expect(byName).toContain('is already the deployment secret for');

    const byToken = routineRegistrationCollision(registered, {
      tokenSecretName: 'AN_UNUSED_SECRET_NAME',
      tokenDigest: credentialDigest(process.env[surfaces[0]!.secretName]!),
    });
    expect(byToken).toContain('Two names for one token is still one token');

    // A genuinely new account with its own name and its own token is the case
    // this whole arrangement exists for, and it is not refused.
    expect(
      routineRegistrationCollision(registered, {
        tokenSecretName: 'POOL_TEST_TOKEN_D',
        tokenDigest: credentialDigest('a-brand-new-token'),
      }),
    ).toBeNull();
  });

  it('drops only the surface whose own secret is missing', async () => {
    delete process.env[surfaces[1]!.secretName];
    const snapshot = await fleetSnapshot();
    expect(snapshot.candidates).toHaveLength(2);
    expect(snapshot.missingSecrets.map((entry) => entry.secretName)).toEqual([surfaces[1]!.secretName]);
    // And the other two still resolve their own, rather than falling back to a
    // shared one: a pool where two Routines read one secret is one trigger
    // fired twice while reporting headroom on two surfaces.
    expect(snapshot.candidates.map((c) => c.routine.tokenSecretName).sort()).toEqual(
      [surfaces[0]!.secretName, surfaces[2]!.secretName].sort(),
    );
  });
});

/* ------------------------------------------------------------------------ */
/* 10 & 11. Correlation, and what pooling does to independence               */
/* ------------------------------------------------------------------------ */

describe('proving each surface, one at a time', () => {
  it('pins a probe to the surface it is proving, so a pool can be proved member by member', async () => {
    const target = surfaces[2]!;
    const routine = (await getRoutineByRef(target.routineRef))!;
    const worker = (await getWorkerByName('factory-brain'))!;
    const binId = await createProbeBin({
      worker,
      repositories: [REPOSITORY],
      routine,
      family: 'FACTORY',
    });

    const bin = (await getBin(binId))!;
    expect(bin.pinnedRoutineId).toBe(routine.id);

    // Every other surface is idle and would otherwise have been chosen.
    const snapshot = await fleetSnapshot();
    const decision = routeBin({
      bin,
      candidates: snapshot.candidates,
      fleetPolicy: snapshot.fleetPolicy,
      fleetInFlight: snapshot.fleetInFlight,
      now: new Date().toISOString(),
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.routine.id).toBe(routine.id);
  });

  it('says a pinned surface that is not a candidate is unavailable, rather than picking another', async () => {
    const target = surfaces[0]!;
    delete process.env[target.secretName];
    const binId = await factoryBin('pinned', { pinnedRoutineId: target.routineId });
    const snapshot = await fleetSnapshot();
    const decision = routeBin({
      bin: (await getBin(binId))!,
      candidates: snapshot.candidates,
      fleetPolicy: snapshot.fleetPolicy,
      fleetInFlight: snapshot.fleetInFlight,
      now: new Date().toISOString(),
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal).toBe('PINNED_SURFACE_UNAVAILABLE');
  });

  it('calls a surface proven only on the whole chain, and the pool only when every one is', async () => {
    // Two of the three complete their chain; the pool must still refuse.
    for (const surface of surfaces.slice(0, 2)) {
      await completeChainFor(surface);
    }
    const partial = await verifyFactoryPool({ workerName: 'factory-brain', repository: REPOSITORY });
    expect(partial.surfaces.filter((s) => s.verdict === 'PROVEN')).toHaveLength(2);
    expect(partial.ok).toBe(false);

    await completeChainFor(surfaces[2]!);
    const whole = await verifyFactoryPool({ workerName: 'factory-brain', repository: REPOSITORY });
    expect(whole.surfaces.map((s) => s.verdict)).toEqual(['PROVEN', 'PROVEN', 'PROVEN']);
    expect(whole.ok).toBe(true);
    // Each chain names its own Routine's fire, not somebody else's.
    for (const surface of whole.surfaces) expect(surface.chain).not.toBeNull();
  });

  it('calls an arrival under another identity a fault rather than a missing proof', async () => {
    const surface = surfaces[0]!;
    const binId = await factoryBin('foreign');
    const bin = (await getBin(binId))!;
    await ensureDispatchIntent(bin);
    const intent = await claimDispatchIntent();
    await markDispatchSent(intent!.id, {
      routineRef: surface.routineRef,
      sessionRef: 'cse_foreign',
      routineId: surface.routineId,
      accountId: surface.accountId,
    });
    // The research identity turns up on a Factory surface's fire: exactly the
    // mistake a second connector *name* invites.
    await recordWorkerSession({
      sessionRef: 'cse_foreign',
      workerId: researchWorkerId,
      routineId: surface.routineId,
      accountId: surface.accountId,
      binId,
      leaseGeneration: bin.leaseGeneration,
    });

    const report = await verifyFactoryPool({ workerName: 'factory-brain', repository: REPOSITORY });
    const judged = report.surfaces.find((s) => s.routineRef === surface.routineRef)!;
    expect(judged.verdict).toBe('FAULT');
    expect(judged.problems.join(' ')).toContain('authenticated as a different worker');
    expect(report.ok).toBe(false);
  });

  it('keeps every arrival attributable to its own account, which is what independence reads', async () => {
    /*
     * Pooling must not blur lineage. Each surface's arrival is written from the
     * dispatch row Brain sent, so two activations of one logical worker on two
     * accounts resolve to two accounts — which is what the audit separation
     * matrix reads, and is strictly more separation than one account could
     * supply, never less.
     */
    for (const surface of surfaces) await completeChainFor(surface);
    const report = await verifyFactoryPool({ workerName: 'factory-brain', repository: REPOSITORY });
    const accounts = new Set(report.surfaces.map((s) => s.accountName));
    expect(accounts.size).toBe(3);
    const sessions = new Set(report.surfaces.map((s) => s.chain?.sessionRef));
    expect(sessions.size).toBe(3);
  });

  it('still refuses a review to the session that wrote the code, whichever account it came from',
    async () => {
    /*
     * The floor is a **session**, and pooling must not let an account stand in
     * for one. A worker that implemented a unit from a session on one account
     * and then arrives again — same identity, different account, different
     * activation — is a different session, and is admitted; the session that
     * actually wrote the code is refused wherever it turns up.
     *
     * That is the property pooling had to preserve rather than acquire, so it is
     * asked of the production admission hook every entrance already calls, with
     * the pooled fleet from this file's fixture underneath it.
     */
    const { ensureChangeRequest, approveChangeRequest, ensureCampaign } = await import(
      '../server/repos/factory.ts'
    );
    const { recordFactoryEvent } = await import('../server/repos/factoryFleet.ts');
    const { FACTORY_EVENT_KINDS } = await import('../server/services/factory/metrics.ts');
    const { createReviewBin } = await import('../server/services/factory/remote.ts');
    const { binAdmission } = await import('../server/services/bins/service.ts');
    const { createUser } = await import('../server/repos/identity.ts');

    const approver = (
      await createUser({
        email: `pool-approver-${Math.random().toString(36).slice(2)}@example.invalid`,
        displayName: 'Approver',
        password: 'a-long-enough-test-password',
        isBrainAdmin: true,
        createdByType: 'SYSTEM',
        createdById: 'test',
      })
    ).id;
    const base = 'a'.repeat(40);
    const { changeRequest } = await ensureChangeRequest({
      projectId,
      submissionKey: `pool-independence-${Math.random()}`,
      objective: 'Change something in the pooled repository.',
      expectedOutcome: 'It is changed.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'asserted', verification: 'npm test', mandatory: true },
      ],
      repository: REMOTE,
      repositoryRoot: '',
      baseBranch: 'production',
      baseSha: base,
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'decline',
      verificationCommands: ['npm test'],
    });
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approver,
      authorityId: null,
    });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId,
      baseSha: base,
      laneTarget: 1,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });
    const reviewBin = await createReviewBin(campaign, changeRequest, base, 1);

    // The unit was implemented by a session that arrived on the first account.
    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: FACTORY_EVENT_KINDS.unitImplemented,
      evidenceClass: 'MEASURED',
      sessionId: `cse_${surfaces[0]!.routineRef}`,
      detail: { unitKey: 'u', binId: 'bin_x' },
    });

    const principal = principalFor(factoryWorkerId, ['queue:claim', 'queue:complete']);
    const bin = (await getBin(reviewBin.id))!;

    const itself = await binAdmission({
      workerId: factoryWorkerId,
      principal,
      sessionRef: `cse_${surfaces[0]!.routineRef}`,
    });
    const refusal = await itself(bin);
    expect(refusal.ok).toBe(false);
    expect(refusal.reason).toContain('implemented part of this campaign');

    // The same logical worker, arriving from a second account's surface.
    const elsewhere = await binAdmission({
      workerId: factoryWorkerId,
      principal,
      sessionRef: `cse_${surfaces[1]!.routineRef}`,
    });
    expect((await elsewhere(bin)).ok).toBe(true);
  });

  it('says a one-surface Factory is not a pool on the run that passes, not only on one that fails', async () => {
    /*
     * The caveat used to be a `problem`, and `ok` never counted it — so the
     * only run that ever printed it was one that had already failed for some
     * other reason, and the green run, which is the single place somebody
     * could read "VERIFIED" as "pooled", said nothing. It is a note now, and
     * this pins both halves: present when there is one surface, and never
     * counted as a reason to refuse.
     */
    for (const surface of surfaces) await completeChainFor(surface);
    const read = await readFactoryPool({ workerName: 'factory-brain', repository: REPOSITORY });

    const whole = judgePool(read);
    expect(whole.ok).toBe(true);
    expect(whole.notes).toEqual([]);

    const alone = judgePool({
      expectedWorker: read.expectedWorker,
      repository: read.repository,
      surfaces: read.surfaces.slice(0, 1),
    });
    expect(alone.ok).toBe(true);
    expect(alone.notes.join(' ')).toContain('nothing here is pooled');
    expect(alone.problems).toEqual([]);
  });

  it('judges from rows it is handed, so a verdict can be argued with afterwards', () => {
    // The pure half, with nothing read: an empty pool is not a proven one.
    const report = judgePool({
      expectedWorker: { id: 'wkr_x', name: 'factory-brain' },
      repository: REPOSITORY,
      surfaces: [],
    });
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('no pool to verify');
  });
});

/**
 * Drive one surface's whole chain: fire, arrival, assignment, completion.
 *
 * Every row here is one Brain writes on the real path. The bin is pinned to the
 * surface, the **dispatcher** decides and fires it, the worker is handed it
 * through `assignNextBin`, and `creditDispatchArrival` — not this helper — is
 * what writes `worker_sessions` from the dispatch row Brain itself wrote. That
 * is the whole point: a helper that asserted the arrival row would be proving
 * its own fixture rather than the attribution the pool report reads.
 */
async function completeChainFor(surface: Surface): Promise<void> {
  const binId = await factoryBin(`chain for ${surface.routineRef}`, {
    pinnedRoutineId: surface.routineId,
  });
  await dispatchTick({ burst: 5, projectIds: [projectId] });
  const dispatch = (await listDispatchesForBin(binId))[0];
  expect(dispatch?.state).toBe('SENT');
  expect(dispatch?.routineRef).toBe(surface.routineRef);

  const assigned = await assignNextBin({
    workerId: factoryWorkerId,
    projectIds: [projectId],
    credentialId: `cse_${surface.routineRef}`,
  });
  expect(assigned?.bin.id).toBe(binId);
  expect(
    await finishBin(
      {
        binId,
        leaseId: assigned!.leaseId,
        leaseGeneration: assigned!.leaseGeneration,
        workerId: factoryWorkerId,
      },
      { state: 'COMPLETE', reason: 'the surface answered' },
    ),
  ).toBe('OK');
}
