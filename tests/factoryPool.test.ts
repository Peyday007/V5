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
  recordWorkerArrival,
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
import { fleetSnapshot, IN_FLIGHT_WINDOW_MS } from '../server/services/dispatch/candidates.ts';
import { routeBin } from '../server/services/dispatch/router.ts';
import { decideBinRouting } from '../server/services/bins/routing.ts';
import { judgePool, readFactoryPool, verifyFactoryPool } from '../server/services/dispatch/pool.ts';
import { createProbeBin } from '../server/services/fleet/probe.ts';
import { NO_SHOW_QUARANTINE_THRESHOLD } from '../server/services/dispatch/scaler.ts';
import { getDb } from '../server/db/database.ts';
import fs from 'node:fs';
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
      now: read.now,
      expectedWorker: read.expectedWorker,
      repository: read.repository,
      surfaces: read.surfaces.slice(0, 1),
    });
    expect(alone.ok).toBe(true);
    expect(alone.notes.join(' ')).toContain('nothing here is pooled');
    expect(alone.problems).toEqual([]);
  });

  it('counts accounts and surfaces as two numbers, because they are two facts', async () => {
    /*
     * §23 draws this distinction and then warns about the arithmetic that
     * ignores it: an account holds a subscription allowance and a Routine is a
     * fire surface, so a second Routine on one account doubles how fast Brain
     * can *start* sessions and changes nothing about how much that account may
     * *do*. `verify-pool` reported `surfaces 3` and nothing else, so a pool of
     * three Routines on one subscription read exactly like three accounts on
     * the one command whose whole job is to report the pool.
     */
    for (const surface of surfaces) await completeChainFor(surface);
    const read = await readFactoryPool({ workerName: 'factory-brain', repository: REPOSITORY });

    const spread = judgePool(read);
    expect(spread.accounts).toBe(3);
    expect(spread.surfaces).toHaveLength(3);
    expect(spread.notes.join(' ')).not.toMatch(/subscription/i);

    // The same three surfaces reported as being on one account. Nothing is
    // refused — that arrangement is legitimate and sometimes deliberate — and
    // it is said out loud on the green run, which is the only run where
    // somebody could read the surface count as an account count.
    const onOne = judgePool({
      ...read,
      surfaces: read.surfaces.map((one) => ({
        ...one,
        account: { ...read.surfaces[0]!.account },
      })),
    });
    expect(onOne.ok).toBe(true);
    expect(onOne.accounts).toBe(1);
    expect(onOne.surfaces).toHaveLength(3);
    expect(onOne.notes.join(' ')).toMatch(/one Claude account/i);
  });

  it('reports a cooldown only while it is still ahead, so it cannot contradict "eligible yes"', async () => {
    /*
     * `retry_at` in the past is history: the fire router compares it to the
     * clock and ignores it. Printing it anyway put "cooling until <a moment
     * two weeks ago>" on the same line as "eligible yes", which is two answers
     * to one question — and production printed exactly that.
     */
    const read = await readFactoryPool({ workerName: 'factory-brain', repository: REPOSITORY });
    const first = read.surfaces[0]!;
    const at = (iso: string): string | null =>
      judgePool({
        now: '2026-09-20T00:00:00.000Z',
        expectedWorker: read.expectedWorker,
        repository: read.repository,
        surfaces: [{ ...first, routine: { ...first.routine, retryAt: iso } }],
      }).surfaces[0]!.cooldownUntil;

    expect(at('2026-09-09T22:32:10.195Z')).toBeNull();
    expect(at('2026-09-20T01:00:00.000Z')).toBe('2026-09-20T01:00:00.000Z');
  });

  it('judges from rows it is handed, so a verdict can be argued with afterwards', () => {
    // The pure half, with nothing read: an empty pool is not a proven one.
    const report = judgePool({
      now: new Date().toISOString(),
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

  /*
   * A sibling cannot take it, and that is the shape this helper used to model
   * by accident.
   *
   * The bin is pinned, so it is answerable only by the session Brain fired at
   * *this* surface. The helper passed no `sessionRef` at all, which is not what
   * a Cowork worker does — production's own rows carry it, in two spellings:
   *
   *     BIN_ASSIGNED  session session_01EJAUDiZArHdjBizN6w64M8
   *     DISPATCH_SENT session cse_01EJAUDiZArHdjBizN6w64M8
   *
   * So the arrival reports the session the fire recorded, and an arrival that
   * reports somebody else's is refused before the accounting — which is
   * asserted here rather than assumed, because this helper is what every pool
   * proof in this file is built on.
   */
  expect(
    await assignNextBin({
      workerId: factoryWorkerId,
      projectIds: [projectId],
      credentialId: `cse_${surface.routineRef}`,
      sessionRef: 'claude-code-session_somebody-else',
    }),
  ).toBeNull();

  const assigned = await assignNextBin({
    workerId: factoryWorkerId,
    projectIds: [projectId],
    credentialId: `cse_${surface.routineRef}`,
    sessionRef: dispatch!.sessionRef,
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

/**
 * A proof is evidence about the moment it was taken.
 *
 * `judgeSurface` closed the four-row chain and then wrote `problems.length = 0`,
 * which is right about the *proof's* own complaints — "nothing has ever arrived
 * here" is genuinely answered by an arrival — and wrong about every standing
 * fact recorded beside them. Two of those reach that line: a bound worker that
 * has been **archived**, and a Factory identity whose routing row also serves
 * research. Both are faults about the surface *now*, both were discarded by a
 * chain closed at any point in the past, and `judgePool` only reports problems
 * for a surface whose verdict is not PROVEN — so the pool answered `ok: true`
 * over a surface that cannot authenticate at all.
 *
 * And nothing bounded the chain's age. `proveSurface` walks every arrival ever
 * attributed to a Routine and takes the first closed one, so a surface proved
 * once and dead since certified itself for ever. That is the `CONFIGURED`
 * masquerading as `HEALTHY` rule §23 and §32 both state, inverted: *verified
 * once* masquerading as *verified now*.
 *
 * The remedy is not a timer. Brain cannot see a connector revoked inside
 * somebody's Claude account, so an invented expiry would be a policy nobody
 * measured — and this file already refuses that shape. What it *can* read is
 * its own later evidence: a fire it made after the proof that produced no
 * arrival, and a refusal the provider issued after it. A proof contradicted by
 * what happened next is `STALE`, which is a third answer with its own remedy —
 * re-probe — rather than a green tick over a surface that has stopped working.
 */
describe('a proof is not a certificate', () => {
  /** One surface with its chain genuinely closed, as the real path writes it. */
  async function provenSurface() {
    await completeChainFor(surfaces[0]!);
    const read = await readFactoryPool({ workerName: 'factory-brain', repository: REPOSITORY });
    const first = read.surfaces.find((s) => s.routine.routineRef === surfaces[0]!.routineRef)!;
    return { read, first };
  }

  const judgeOne = (
    read: Awaited<ReturnType<typeof readFactoryPool>>,
    surface: (typeof read.surfaces)[number],
  ) =>
    judgePool({
      now: new Date().toISOString(),
      expectedWorker: read.expectedWorker,
      repository: read.repository,
      surfaces: [surface],
    });

  it('closes the chain it is built on, so the rest of this reads a real proof', async () => {
    const { read, first } = await provenSurface();
    const report = judgeOne(read, first);
    expect(report.surfaces[0]!.verdict).toBe('PROVEN');
    expect(report.ok).toBe(true);
  });

  it('does not let a past proof erase an archived worker', async () => {
    const { read, first } = await provenSurface();
    const report = judgeOne(read, {
      ...first,
      worker: { ...first.worker!, archived: true },
    });
    // An archived identity cannot authenticate, so this is a fault about now
    // rather than a proof that is merely missing.
    expect(report.surfaces[0]!.verdict).toBe('FAULT');
    expect(report.surfaces[0]!.problems.join(' ')).toContain('archived');
    expect(report.ok).toBe(false);
    // And the pool says so, rather than reporting problems only for surfaces it
    // had already decided were not proven.
    expect(report.problems.join(' ')).toContain('archived');
  });

  it('does not let a past proof erase a disabled worker either', async () => {
    const { read, first } = await provenSurface();
    const report = judgeOne(read, {
      ...first,
      worker: { ...first.worker!, disabled: true },
    });
    // Disabling is reversible and archiving is not, and to a proof they are one
    // fault: nothing can authenticate as this worker now.
    expect(report.surfaces[0]!.verdict).toBe('FAULT');
    expect(report.surfaces[0]!.problems.join(' ')).toContain('disabled');
    expect(report.ok).toBe(false);
  });

  it('does not let a past proof erase a Factory identity that also serves research', async () => {
    const { read, first } = await provenSurface();
    const report = judgeOne(read, {
      ...first,
      routing: { ...first.routing!, families: ['FACTORY', 'RESEARCH'] },
    });
    expect(report.surfaces[0]!.verdict).toBe('FAULT');
    expect(report.surfaces[0]!.problems.join(' ')).toContain('research');
    expect(report.ok).toBe(false);
  });

  it('calls a proof contradicted by a later unanswered fire stale rather than proven', async () => {
    const { read, first } = await provenSurface();
    // The one fact both this report and the dispatcher's quarantine read: a
    // fire that reached SENT, aged out of the in-flight window, and whose bin
    // was still claimable at the generation that fire named.
    const report = judgeOne(read, { ...first, unansweredFires: 1 });
    expect(report.surfaces[0]!.verdict).toBe('STALE');
    expect(report.surfaces[0]!.problems.join(' ')).toContain('no arrival');
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('--probe');
  });

  it('does not call a fire that is still in flight a contradiction', async () => {
    /*
     * The half that stops this being a warning that cries wolf. A surface fired
     * at thirty seconds ago has an unanswered fire by construction — its worker
     * is booting — and `consecutive_no_shows` reads 1 on every healthy surface
     * in that state. Only a fire that has aged out of the window produces a
     * `DISPATCH_NO_SHOW` row, so a live one contributes nothing here.
     */
    const { read, first } = await provenSurface();
    const report = judgeOne(read, {
      ...first,
      routine: { ...first.routine, lastFiredAt: new Date(Date.now() - 30_000).toISOString() },
    });
    expect(first.unansweredFires).toBe(0);
    expect(report.surfaces[0]!.verdict).toBe('PROVEN');
    expect(report.ok).toBe(true);
  });

  it('does not call a proof stale because the provider was busy', async () => {
    /*
     * The defect the first version of this check had, and the reason the fact
     * is read from the ledger rather than derived from `last_fired_at`:
     * `claimRoutineFireSlot` advances that column when it takes the slot,
     * *before* the HTTP call, so a fire the provider rate-limited advances it
     * exactly as a delivered one does. Comparing it against the newest arrival
     * therefore called a busy account's proof stale — §23's "a refusal is not
     * misconduct", broken by the check written to catch a dead surface.
     */
    const { read, first } = await provenSurface();
    const report = judgeOne(read, {
      ...first,
      routine: {
        ...first.routine,
        totalRefusals: 6,
        lastFiredAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      },
      sessions: first.sessions.map((session) => ({
        ...session,
        observedAt: new Date(Date.now() - 8 * 60 * 60_000).toISOString(),
      })),
      unansweredFires: 0,
    });
    expect(report.surfaces[0]!.verdict).toBe('PROVEN');
    expect(report.ok).toBe(true);
  });

  it('calls a proof contradicted by a later failed fire stale rather than proven', async () => {
    const { read, first } = await provenSurface();
    // Not a rate limit: `consecutive_failures` is left alone by one of those on
    // purpose, so a non-zero value is a fact about this surface rather than
    // about how busy the account is.
    const report = judgeOne(read, {
      ...first,
      routine: { ...first.routine, consecutiveFailures: 1 },
    });
    expect(report.surfaces[0]!.verdict).toBe('STALE');
    expect(report.surfaces[0]!.problems.join(' ')).toContain('not a rate limit');
    expect(report.ok).toBe(false);
  });

  it('leaves a rate-limited surface proven, because a refusal is not misconduct', async () => {
    const { read, first } = await provenSurface();
    // What a rate limit actually writes: a retry point and a refusal count, and
    // deliberately no failure. A busy account is not a broken one.
    const report = judgeOne(read, {
      ...first,
      routine: {
        ...first.routine,
        totalRefusals: 4,
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(report.surfaces[0]!.verdict).toBe('PROVEN');
    expect(report.surfaces[0]!.cooldownUntil).not.toBeNull();
  });

  it('keeps an ordinary healthy proof green, so the guard is not a blanket refusal', async () => {
    const { read, first } = await provenSurface();
    // Cooling down and carrying work are eligibility facts, never faults: a
    // surface at its target has been proven and is simply busy.
    const report = judgeOne(read, {
      ...first,
      routineInFlight: 99,
      routineTarget: 1,
      // The router is the one reader of eligibility now (`routerSays`), so a
      // hand-edited snapshot states what the router answers for it: at its
      // target is waiting, never broken.
      routerSays: { dispatch: 'WAITING', reason: 'routine at target 99/1' },
    });
    expect(report.surfaces[0]!.verdict).toBe('PROVEN');
    expect(report.surfaces[0]!.eligible).toBe(false);
    expect(report.surfaces[0]!.ineligibleBecause).toEqual(['routine at target 99/1']);
  });
});

/**
 * One dead account in a pool, and the signal that could not see it.
 *
 * `shouldQuarantine` states the fleet's own rule — repeated no-shows take a
 * surface out of routing, because a session that starts and never arrives is a
 * permission or connector fault that will repeat for ever at one activation
 * each — and it had exactly one caller in the repository: `fleet scale-advice`,
 * which prints a line. Nothing anywhere acted on it, so no surface has ever
 * been quarantined for not answering.
 *
 * Wiring the function up as it stood would not have helped, and that is the
 * part only a pool shows. Its input was `fleet_routines.consecutive_no_shows`,
 * which `recordWorkerArrival` clears **for every Routine bound to the same
 * worker** — which is exactly what a Factory pool is. So in a fleet of four
 * accounts on one identity, one dead surface has its counter reset by its
 * healthy siblings' arrivals and is fired at for ever: an activation each time,
 * out of a fixed subscription allowance, with every row reading healthy.
 *
 * The per-surface fact was already being established and was being thrown away.
 * `reopenNoShowDispatches` decides, exactly, that a fire produced no arrival —
 * `SENT`, aged past the window in which it still counts as a live activation,
 * and the bin still claimable at the very generation that fire named — and the
 * event it wrote named no surface at all, so the ledger recorded that a fire
 * went unanswered and nothing about whose. §23's own sentence, at the one row
 * that says an account has stopped working.
 */
describe('a surface that stops answering leaves routing, and its siblings do not', () => {
  /** Fire at one named surface and let the window close with nobody arriving. */
  async function unansweredFire(surface: Surface, title: string): Promise<void> {
    const binId = await factoryBin(title, { pinnedRoutineId: surface.routineId });
    await dispatchTick({ burst: 5, projectIds: [projectId] });
    const dispatch = (await listDispatchesForBin(binId))[0];
    expect(dispatch?.state).toBe('SENT');
    expect(dispatch?.routineRef).toBe(surface.routineRef);
    /*
     * The one thing a test cannot do by waiting. Everything else here is the
     * real path: Brain routed it, claimed the fire slot, fired, recorded the
     * dispatch — and nothing arrived.
     */
    await getDb().run('UPDATE bin_dispatch SET sent_at = ? WHERE id = ?', [
      new Date(Date.now() - IN_FLIGHT_WINDOW_MS - 60_000).toISOString(),
      dispatch!.id,
    ]);
  }

  it('quarantines the surface whose fires go unanswered, and only that one', async () => {
    const dead = surfaces[1]!;
    for (let i = 0; i < NO_SHOW_QUARANTINE_THRESHOLD; i += 1) {
      await unansweredFire(dead, `unanswered ${i}`);
      // Each tick reopens the aged fire and re-asks the question.
      await dispatchTick({ burst: 5, projectIds: [projectId] });
    }

    const after = await listRoutines();
    const quarantined = after.find((one) => one.id === dead.routineId)!;
    expect(quarantined.state).toBe('QUARANTINED');
    expect(quarantined.stateReason ?? '').toMatch(/never checked in|arriv/i);
    // Its siblings are untouched: this is a fact about one account's surface,
    // and a fleet-wide consequence would be the poisoning the pool exists to
    // avoid.
    for (const other of surfaces.filter((one) => one.routineId !== dead.routineId)) {
      expect(after.find((one) => one.id === other.routineId)!.state).toBe('ENABLED');
    }
  });

  it('is not cleared by a sibling arriving, which is what the counter could not express', async () => {
    const dead = surfaces[1]!;
    for (let i = 0; i < NO_SHOW_QUARANTINE_THRESHOLD; i += 1) {
      await unansweredFire(dead, `unanswered ${i}`);
      /*
       * A healthy surface answers in between. `brain_check_in` is what a real
       * worker calls on arrival and it clears `consecutive_no_shows` on
       * **every** Routine bound to this worker — including the dead one, which
       * is why that column cannot express a pool. `recordWorkerArrival` is that
       * write, called here directly because `assignNextBin` reaches only the
       * per-Routine reset beside it.
       */
      await completeChainFor(surfaces[0]!);
      await recordWorkerArrival(factoryWorkerId);
      await dispatchTick({ burst: 5, projectIds: [projectId] });
    }

    const after = await listRoutines();
    expect(after.find((one) => one.id === dead.routineId)!.consecutiveNoShows).toBe(0);
    expect(after.find((one) => one.id === dead.routineId)!.state).toBe('QUARANTINED');
    expect(after.find((one) => one.id === surfaces[0]!.routineId)!.state).toBe('ENABLED');
  });

  it('stops counting once the surface answers again, so a repair is the end of it', async () => {
    const recovering = surfaces[1]!;
    for (let i = 0; i < NO_SHOW_QUARANTINE_THRESHOLD - 1; i += 1) {
      await unansweredFire(recovering, `unanswered ${i}`);
      await dispatchTick({ burst: 5, projectIds: [projectId] });
    }
    expect((await listRoutines()).find((one) => one.id === recovering.routineId)!.state).toBe(
      'ENABLED',
    );

    // It answers. Every no-show before this instant is history about a surface
    // that has since worked, and history does not quarantine anything.
    await completeChainFor(recovering);
    await unansweredFire(recovering, 'one after the repair');
    await dispatchTick({ burst: 5, projectIds: [projectId] });

    expect((await listRoutines()).find((one) => one.id === recovering.routineId)!.state).toBe(
      'ENABLED',
    );
  });

  it('lets an operator re-enable it, which is the whole point of the transition', async () => {
    /*
     * The defect §27 records one object along, arriving in this rule: a
     * transition that exists, reports success and changes nothing that lasts.
     *
     * The count is read from an append-only ledger, so re-enabling a surface
     * does not touch it — and an arrival is what would, which cannot happen
     * until Brain fires the surface again, which it will not do while the
     * surface is quarantined. So `fleet set-state --to ENABLED` would have
     * returned true, and the very next tick would have re-quarantined it on the
     * same three rows, for ever, with the connector genuinely repaired.
     *
     * Re-enabling is a person saying the operational condition is fixed. Every
     * no-show before that moment is history, exactly as §27's factory worker
     * transition resets the failure streak for the same reason — and a
     * condition that was *not* actually fixed quarantines again three
     * unanswered fires later rather than immediately.
     */
    const dead = surfaces[1]!;
    for (let i = 0; i < NO_SHOW_QUARANTINE_THRESHOLD; i += 1) {
      await unansweredFire(dead, `unanswered ${i}`);
      await dispatchTick({ burst: 5, projectIds: [projectId] });
    }
    expect((await getRoutineByRef(dead.routineRef))!.state).toBe('QUARANTINED');

    expect(
      await setRoutineState({
        routineId: dead.routineId,
        from: 'QUARANTINED',
        to: 'ENABLED',
        reason: 'the connector was reconnected as the right worker',
      }),
    ).toBe(true);

    // Two ticks, so this is not merely "it survived the instant it was set".
    await dispatchTick({ burst: 5, projectIds: [projectId] });
    await dispatchTick({ burst: 5, projectIds: [projectId] });
    expect((await getRoutineByRef(dead.routineRef))!.state).toBe('ENABLED');

    // And the ceiling still binds. A condition somebody said was fixed and was
    // not takes the surface out again on its own evidence.
    for (let i = 0; i < NO_SHOW_QUARANTINE_THRESHOLD; i += 1) {
      await unansweredFire(dead, `still broken ${i}`);
      await dispatchTick({ burst: 5, projectIds: [projectId] });
    }
    expect((await getRoutineByRef(dead.routineRef))!.state).toBe('QUARANTINED');
  });

  it('names which surface did not answer on the ledger, rather than only that one did not', async () => {
    const dead = surfaces[2]!;
    await unansweredFire(dead, 'attributed');
    await dispatchTick({ burst: 5, projectIds: [projectId] });

    const rows = await getDb().all<{ routine_id: string | null; routine_ref: string | null }>(
      `SELECT routine_id, routine_ref FROM bin_events WHERE event_type = 'DISPATCH_NO_SHOW'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.routine_id).toBe(dead.routineId);
    expect(rows[0]!.routine_ref).toBe(dead.routineRef);
  });
});

/**
 * The column nobody may print again, and why the rule is worth writing down.
 *
 * `fleet_routines.consecutive_no_shows` is a real column with a real meaning —
 * its own repository comment calls it "fires awaiting an arrival" — and it is
 * the wrong number to put in front of a person under any heading. It is
 * advanced optimistically on every successful fire, so a healthy surface whose
 * worker is still booting reads 1; and `recordWorkerArrival` clears it for
 * **every Routine bound to the same worker**, which is precisely what a pool
 * is, so a dead surface in a four-account fleet reads 0 while its siblings
 * answer.
 *
 * Six surfaces were printing it: the Fleet page, the People page, `who`,
 * `fleet show`, `fleet verify-surface` and `fleet scale-advice` — the last of
 * which also *advised* on it. Every one of them under-reported exactly the
 * condition an operator is looking for.
 *
 * Asserted by reading the source, for `operatorConsoleRemoved`'s reason: what
 * must not exist is somewhere to read it, and a passing request cannot show you
 * one.
 */
describe('no surface prints the counter that cannot express a pool', () => {
  const read = (relative: string): string =>
    fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

  const SURFACES = [
    '../client/src/russell/Fleet.tsx',
    '../client/src/russell/People.tsx',
    '../server/services/fleet/view.ts',
    '../server/services/fleet/capacity.ts',
    '../server/services/russell/who.ts',
  ];

  it('keeps it out of every view type and every screen', () => {
    // Non-vacuous: these files exist and are substantial.
    for (const path of SURFACES) expect(read(path).length).toBeGreaterThan(500);
    for (const path of SURFACES) {
      const source = read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect({ path, hit: source.includes('consecutiveNoShows') }).toEqual({ path, hit: false });
    }
  });

  it('is read only where a decision is made, and there from the derived count', () => {
    const cli = read('../scripts/fleet.ts').replace(/\/\*[\s\S]*?\*\//g, '');
    // The one occurrence left is the argument name `shouldQuarantine` takes,
    // and the value handed to it is the derived map rather than the column.
    const hits = [...cli.matchAll(/consecutiveNoShows:\s*([^,\n]+)/g)].map((m) => m[1]!.trim());
    expect(hits).toEqual(['unanswered.get(routine.id) ?? 0']);
  });
});
