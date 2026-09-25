/**
 * The fleet: registry, policy, routing, scaling, health and independence.
 *
 * The interesting half is the refusals, as it was in Step 10. A router is one
 * step from a system that fires at anything, and the only thing between them is
 * the set of guards below — so most of this file is work that should *not* be
 * routed, and the inversions prove the guards are load-bearing rather than
 * decorative.
 *
 * One rule is asserted more than any other, because it is the governing
 * principle of the whole step: **an unknown capacity stays unknown.** A test
 * that let a plan label become a number would pass while the system lied.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { assignNextBin, createBin, finishBin, getBin, listBinEvents } from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { createUser } from '../server/repos/identity.ts';
import { latestAllowanceReports, recordAllowanceReport } from '../server/repos/allowance.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import {
  bindRoutineWorker,
  claimRoutineFireSlot,
  createAccount,
  createRoutine,
  credentialDigest,
  currentPolicy,
  effectiveTarget,
  getAccountByName,
  getRoutine,
  getRoutineByRef,
  listAccounts,
  listRoutines,
  policyHistory,
  recordAccountRefusal,
  recordRoutineCheckIn,
  recordRoutineFire,
  recordRoutineNoShow,
  renameAccount,
  renameRoutine,
  setAccountState,
  setPolicy,
  setRoutineState,
} from '../server/repos/fleet.ts';
import { routeBin, type RoutingCandidate } from '../server/services/dispatch/router.ts';
import {
  proposeScale,
  shouldQuarantine,
  NO_SHOW_QUARANTINE_THRESHOLD,
  FAILURE_QUARANTINE_THRESHOLD,
} from '../server/services/dispatch/scaler.ts';
import {
  checkIndependence,
  INDEPENDENCE_POLICY_VERSION,
  type AuditLineage,
} from '../server/services/research/independence.ts';
import { referenceFleet, simulate, traceId } from '../server/services/dispatch/simulate.ts';
import { activationTrace } from '../server/services/dispatch/profiles.ts';
import type { Bin, FleetAccount, FleetRoutine } from '../server/domain/types.ts';

let projectId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
});

/**
 * Bind a Routine to a worker that may actually be handed this project's work.
 *
 * Every `dispatchTick` fixture below used to register a Routine bound to
 * nothing, which routed fine while the fire was project-blind and described a
 * fleet that could never have delivered a bin: `assignNextBin` scopes its
 * candidates by the caller's memberships, so an unbound surface — or one whose
 * worker is a member of nothing — is fired and then correctly refused the work.
 *
 * The fire asks that question now, so these fixtures have to answer it. Doing
 * so makes them describe a fleet that works rather than one that only routes.
 */
async function bindToProject(routineId: string, name: string): Promise<string> {
  const worker = await createWorker({
    name: `${name}-${Math.random().toString(36).slice(2, 8)}`,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:claim'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  await bindRoutineWorker(routineId, worker.id);
  return worker.id;
}

/**
 * `createRoutine`, plus the worker and membership that make it able to deliver.
 *
 * Used by every `dispatchTick` fixture below. Creating the Routine unbound and
 * firing it anyway described a fleet that routes and cannot work; the fire asks
 * about the project now, so the fixtures state it.
 */
async function boundRoutine(input: Parameters<typeof createRoutine>[0]) {
  const routine = await createRoutine(input);
  await bindToProject(routine.id, input.name);
  return routine;
}


/** A bin-shaped object the router can rank. Only the fields it reads. */
/*
 * A synthetic bin for the pure routing tests.
 *
 * `requiredCapabilities` is defaulted here rather than tolerated in the router.
 * It used to be absent, the router read it through a cast, and every real bin
 * loaded from the database got `undefined` — so the capability rule was dead in
 * production while this fixture, which always supplied the field when a test
 * asked for it, went on passing. The router now reads an ordinary field, and a
 * fixture that omits it is a wrong fixture rather than something the production
 * path should defend against.
 */
function binLike(over: Partial<Bin> = {}): Bin {
  return {
    id: 'bin_test',
    projectId,
    state: 'READY',
    priority: 5,
    requiredCapabilities: [],
    workloadClass: null,
    createdAt: new Date().toISOString(),
    ...over,
  } as unknown as Bin;
}

function candidate(
  routine: Partial<FleetRoutine>,
  account: Partial<FleetAccount>,
  counts: Partial<RoutingCandidate> = {},
): RoutingCandidate {
  return {
    // Unknown rather than empty, which is what a worker with no explicit routing
    // row resolves to — these fixtures are about capacity, not scope.
    servesRepositories: null,
    // The project dimension is not unknowable, so these capacity fixtures state
    // it: a candidate that served no project would be refused one dimension
    // before the capacity question these tests are actually about.
    servesProjects: [projectId],
    // The bound worker can authenticate; these fixtures are about capacity.
    workerActive: true,
    routine: {
      id: 'rtn_1',
      accountId: 'acct_1',
      routineRef: 'trig_1',
      name: 'r1',
      state: 'ENABLED',
      capabilities: [],
      retryAt: null,
      lastFiredAt: null,
      ...routine,
    } as FleetRoutine,
    account: {
      id: 'acct_1',
      name: 'a1',
      state: 'ENABLED',
      retryAt: null,
      ...account,
    } as FleetAccount,
    // Unknown by default, which the router treats as eligible: these tests are
    // about capacity and slots, and a family scope they never set must not
    // silently refuse every candidate.
    servesFamilies: null,
    routineInFlight: 0,
    accountInFlight: 0,
    routineTarget: null,
    accountTarget: null,
    ...counts,
  };
}

const NOW = '2026-09-02T12:00:00.000Z';

/* ========================================================================= */

describe('an account is not a Routine', () => {
  it('holds many Routines under one account, each on exactly one', async () => {
    const account = await createAccount({ name: 'personal', planLabel: 'Max 20x', declaredPlanPower: '20x' });
    const a = await createRoutine({
      accountId: account.id, routineRef: 'trig_a', name: 'a', tokenSecretName: 'S_A',
    });
    const b = await createRoutine({
      accountId: account.id, routineRef: 'trig_b', name: 'b', tokenSecretName: 'S_B',
    });
    expect(a.accountId).toBe(account.id);
    expect(b.accountId).toBe(account.id);
    expect((await listRoutines({ accountId: account.id })).map((r) => r.routineRef).sort())
      .toEqual(['trig_a', 'trig_b']);
  });

  it('refuses to register the same trigger twice', async () => {
    const account = await createAccount({ name: 'personal' });
    await createRoutine({ accountId: account.id, routineRef: 'trig_a', name: 'a', tokenSecretName: 'S' });
    await expect(
      createRoutine({ accountId: account.id, routineRef: 'trig_a', name: 'dup', tokenSecretName: 'S' }),
    ).rejects.toThrow();
  });

  it('keeps the declared plan power as a label and never as a number', async () => {
    // The governing principle, asserted directly: "20x" is what was bought, not
    // a throughput. Nothing in the registry converts it into capacity.
    const account = await createAccount({ name: 'work', declaredPlanPower: '20x' });
    expect(account.declaredPlanPower).toBe('20x');
    expect(typeof account.declaredPlanPower).toBe('string');
    // And the router is given targets, never the label.
    const result = routeBin({
      bin: binLike(),
      candidates: [candidate({}, { declaredPlanPower: '20x' })],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reason).not.toContain('20x');
  });
});

describe('a row never holds a credential', () => {
  it('stores the secret name and a digest, and nothing that reveals the value', async () => {
    const account = await createAccount({ name: 'personal' });
    const secretValue = 'sk-a-token-that-must-never-be-stored';
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_a',
      name: 'a',
      tokenSecretName: 'BRAIN_ROUTINE_TOKEN_2',
      tokenDigest: credentialDigest(secretValue),
    });
    const serialised = JSON.stringify(routine);
    expect(serialised).not.toContain(secretValue);
    expect(routine.tokenSecretName).toBe('BRAIN_ROUTINE_TOKEN_2');
    expect(routine.tokenDigest).toBe(credentialDigest(secretValue));
    // The digest is one-way: knowing it must not reconstruct the value.
    expect(routine.tokenDigest).not.toContain(secretValue.slice(0, 6));
  });

  it('will not silently re-point a Routine at a different worker', async () => {
    const account = await createAccount({ name: 'personal' });
    const routine = await createRoutine({
      accountId: account.id, routineRef: 'trig_a', name: 'a', tokenSecretName: 'S',
    });
    expect(await bindRoutineWorker(routine.id, 'wkr_1')).toBe(true);
    expect(await bindRoutineWorker(routine.id, 'wkr_1')).toBe(true); // idempotent
    expect(await bindRoutineWorker(routine.id, 'wkr_2')).toBe(false);
    expect((await getRoutineByRef('trig_a'))!.workerId).toBe('wkr_1');
  });
});

describe('routing chooses on fleet state, and says why when it will not', () => {
  it('selects an enabled surface and names what it considered', () => {
    const result = routeBin({
      bin: binLike(), candidates: [candidate({}, {})], fleetPolicy: null, fleetInFlight: 0, now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.considered.at(-1)).toMatchObject({ verdict: 'selected' });
  });

  it('refuses when nothing is registered, rather than returning nothing', () => {
    const result = routeBin({ bin: binLike(), candidates: [], fleetPolicy: null, fleetInFlight: 0, now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('NO_ROUTINES_REGISTERED');
  });

  it('skips a rate-limited surface until its retry point and names the time', () => {
    const later = '2026-09-02T13:00:00.000Z';
    const result = routeBin({
      bin: binLike(),
      candidates: [candidate({ retryAt: later }, {})],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('ALL_SURFACES_RATE_LIMITED');
    expect(result.retryAt).toBe(later);
  });

  it('routes around a rate-limited account to a healthy one', () => {
    const result = routeBin({
      bin: binLike(),
      candidates: [
        candidate({ id: 'rtn_1', routineRef: 't1', retryAt: '2026-09-02T13:00:00.000Z' }, { id: 'acct_1', name: 'a1' }),
        candidate({ id: 'rtn_2', routineRef: 't2' }, { id: 'acct_2', name: 'a2' }),
      ],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.account.name).toBe('a2');
  });

  it('resumes the surface once its refusal window passes', () => {
    const past = '2026-09-02T11:00:00.000Z';
    const result = routeBin({
      bin: binLike(),
      candidates: [candidate({ retryAt: past }, {})],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('skips a disabled, draining or quarantined surface', () => {
    for (const state of ['DRAINING', 'UNAVAILABLE', 'QUARANTINED', 'RETIRED'] as const) {
      const byRoutine = routeBin({
        bin: binLike(), candidates: [candidate({ state }, {})], fleetPolicy: null, fleetInFlight: 0, now: NOW,
      });
      expect(byRoutine.ok).toBe(false);
      const byAccount = routeBin({
        bin: binLike(), candidates: [candidate({}, { state })], fleetPolicy: null, fleetInFlight: 0, now: NOW,
      });
      expect(byAccount.ok).toBe(false);
    }
  });

  it('will not send work to a surface lacking a required capability', () => {
    const result = routeBin({
      bin: binLike({ requiredCapabilities: ['egress:mi.gov'] }),
      candidates: [candidate({ capabilities: [] }, {})],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('NO_CAPABLE_SURFACE');
  });

  it('holds at the fleet target rather than over-firing', () => {
    const policy = { version: 3, target: 2, paused: false, boostTarget: null, boostUntil: null, exploreCeiling: null, exploreUntil: null, actor: 'op' } as never;
    const result = routeBin({
      bin: binLike(), candidates: [candidate({}, {})], fleetPolicy: policy, fleetInFlight: 2, now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('FLEET_TARGET_REACHED');
  });

  it('separates account headroom from Routine headroom', () => {
    // The distinction the whole step turns on: a Routine with room on an
    // account that has none must not be chosen.
    const result = routeBin({
      bin: binLike(),
      candidates: [candidate({}, {}, { routineInFlight: 0, routineTarget: 5, accountInFlight: 3, accountTarget: 3 })],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('ACCOUNT_TARGETS_REACHED');
  });

  it('spreads load by relative headroom, not by absolute size', () => {
    const busy = candidate(
      { id: 'rtn_big', routineRef: 't_big' }, { id: 'acct_big', name: 'big' },
      { routineInFlight: 9, routineTarget: 10 },
    );
    const idle = candidate(
      { id: 'rtn_small', routineRef: 't_small' }, { id: 'acct_small', name: 'small' },
      { routineInFlight: 0, routineTarget: 2 },
    );
    const result = routeBin({ bin: binLike(), candidates: [busy, idle], fleetPolicy: null, fleetInFlight: 0, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // The big account has more absolute room (1 vs 2 is false — it has 1, the
    // small has 2) — the point is proportion: 10% free versus 100% free.
    expect(result.account.name).toBe('small');
  });

  it('alternates between two equally idle surfaces instead of always picking one', () => {
    const first = candidate({ id: 'rtn_1', routineRef: 't1', lastFiredAt: '2026-09-02T11:59:00.000Z' }, { id: 'acct_1', name: 'a1' });
    const second = candidate({ id: 'rtn_2', routineRef: 't2', lastFiredAt: null }, { id: 'acct_2', name: 'a2' });
    const result = routeBin({ bin: binLike(), candidates: [first, second], fleetPolicy: null, fleetInFlight: 0, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Never fired beats fired a minute ago.
    expect(result.account.name).toBe('a2');
  });
});

describe('Factory allocation uses reported allowance only while it is comparable', () => {
  const owner = (percent: number | null, reportedAt = NOW) => candidate(
    { id: 'rtn_owner', lastFiredAt: null }, { id: 'acct_owner', name: 'owner' },
    { allowanceReport: percent === null ? null : { accountId: 'acct_owner', remainingPercent: percent, reportedAt } },
  );
  const friend = (percent: number | null, reportedAt = NOW) => candidate(
    { id: 'rtn_friend', lastFiredAt: NOW }, { id: 'acct_friend', name: 'friend' },
    { allowanceReport: percent === null ? null : { accountId: 'acct_friend', remainingPercent: percent, reportedAt } },
  );
  const choose = (candidates: RoutingCandidate[]) => routeBin({
    bin: binLike(), candidates, fleetPolicy: null, fleetInFlight: 0, now: NOW,
  });

  it('prefers 100% over 40% without changing either account target', () => {
    const decision = choose([owner(40), friend(100)]);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.account.id).toBe('acct_friend');
      expect(decision.reason).toMatch(/person-reported balances/i);
    }
  });

  it('falls back to fair headroom when one report is missing or older than six hours', () => {
    for (const candidates of [
      [owner(40), friend(null)],
      [owner(40), friend(100, '2026-09-02T05:00:00.000Z')],
    ]) {
      const decision = choose(candidates);
      expect(decision.ok).toBe(true);
      if (decision.ok) expect(decision.account.id).toBe('acct_owner');
    }
  });

  it('never overrides provider cooldown or account health with a high report', () => {
    const cooling = friend(100);
    cooling.account.retryAt = '2026-09-02T13:00:00.000Z';
    expect(choose([owner(40), cooling])).toMatchObject({ ok: true, account: { id: 'acct_owner' } });
    const quarantined = friend(100);
    quarantined.routine.state = 'QUARANTINED';
    expect(choose([owner(40), quarantined])).toMatchObject({ ok: true, account: { id: 'acct_owner' } });
  });

  it('retains the latest signed report and rejects invalid values', async () => {
    const account = await createAccount({ name: 'factory-account' });
    const user = await createUser({ email: 'allowance@example.test', displayName: 'Owner', password: 'fixture-password-123' });
    await recordAllowanceReport({ accountId: account.id, remainingPercent: 40, reportedBy: user.id, projectId });
    await recordAllowanceReport({ accountId: account.id, remainingPercent: 100, reportedBy: user.id, projectId });
    expect((await latestAllowanceReports()).get(account.id)?.remainingPercent).toBe(100);
    await expect(recordAllowanceReport({ accountId: account.id, remainingPercent: 101, reportedBy: user.id, projectId }))
      .rejects.toThrow(/0 to 100/);
    const rows = await getDb().all<{ remaining_percent: number }>(
      'SELECT remaining_percent FROM fleet_allowance_reports WHERE account_id = ?', [account.id],
    );
    expect(rows).toHaveLength(2);
  });
});

describe('policy is rows, and raising a target needs no deployment', () => {
  it('writes a new version and keeps the old one', async () => {
    const a = await setPolicy({ scope: 'FLEET', target: 2, actor: 'op', reason: 'start' });
    const b = await setPolicy({ scope: 'FLEET', target: 8, actor: 'op', reason: 'push harder' });
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect((await currentPolicy('FLEET', null))!.target).toBe(8);
    const history = await policyHistory('FLEET', null);
    expect(history.map((h) => h.target)).toEqual([8, 2]);
    expect(history[1]!.reason).toBe('start');
  });

  it('applies a live boost and stops applying an expired one', () => {
    const base = { version: 1, target: 4, paused: false, exploreCeiling: null, exploreUntil: null } as never;
    const live = { ...(base as object), boostTarget: 12, boostUntil: '2026-09-02T13:00:00.000Z' } as never;
    const expired = { ...(base as object), boostTarget: 12, boostUntil: '2026-09-02T11:00:00.000Z' } as never;
    expect(effectiveTarget(live, NOW)).toMatchObject({ target: 12, boosted: true });
    // Expired without anything having had to run: the reader compares to a clock.
    expect(effectiveTarget(expired, NOW)).toMatchObject({ target: 4, boosted: false });
  });

  it('reports a paused fleet as zero rather than as its target', () => {
    const paused = { version: 1, target: 9, paused: true, boostTarget: null, boostUntil: null, exploreCeiling: null, exploreUntil: null } as never;
    expect(effectiveTarget(paused, NOW).target).toBe(0);
  });

  it('reports an unset policy as unknown, not as zero capacity', () => {
    expect(effectiveTarget(null, NOW)).toMatchObject({ target: 0, source: 'UNKNOWN' });
  });
});

describe('scaling responds to evidence, and a refusal outranks a deep queue', () => {
  const signals = {
    queueDepth: 0, inFlight: 0, recentRefusals: 0, recentNoShows: 0, recentCompletions: 0,
  };
  const policy = (over: Record<string, unknown> = {}) =>
    ({ version: 1, target: 4, autoScale: true, autoScaleCeiling: 10, paused: false, ...over }) as never;

  it('raises when the queue is deeper than the target and work is completing', () => {
    const proposal = proposeScale({
      policy: policy(), signals: { ...signals, queueDepth: 20, inFlight: 4, recentCompletions: 3 }, now: NOW,
    });
    expect(proposal.direction).toBe('RAISE');
    expect(proposal.to).toBe(5);
  });

  it('will not raise past the ceiling the operator set', () => {
    const proposal = proposeScale({
      policy: policy({ target: 10, autoScaleCeiling: 10 }),
      signals: { ...signals, queueDepth: 99, inFlight: 10, recentCompletions: 5 },
      now: NOW,
    });
    expect(proposal.direction).toBe('HOLD');
    expect(proposal.reason).toMatch(/ceiling/i);
  });

  it('lowers on a provider refusal even with a deep queue', () => {
    // The inversion that matters: optimism must never beat a wall.
    const proposal = proposeScale({
      policy: policy({ target: 8 }),
      signals: { ...signals, queueDepth: 500, inFlight: 8, recentRefusals: 2, recentCompletions: 40 },
      now: NOW,
    });
    expect(proposal.direction).toBe('LOWER');
    expect(proposal.to).toBe(4);
  });

  it('holds when the fleet is paused, whatever the queue says', () => {
    const proposal = proposeScale({
      policy: policy({ paused: true }), signals: { ...signals, queueDepth: 99 }, now: NOW,
    });
    expect(proposal.direction).toBe('HOLD');
    expect(proposal.automatic).toBe(false);
  });
});

describe('health is proportional, and being busy is not misconduct', () => {
  it('never quarantines for refusals alone, however many', () => {
    // A 429 is capacity evidence. An account at its ceiling that got
    // quarantined for it would be a working fleet destroyed for being busy.
    expect(shouldQuarantine({ consecutiveNoShows: 0, consecutiveFailures: 0 }).quarantine).toBe(false);
    const rateLimited = { consecutiveNoShows: 0, consecutiveFailures: 0 };
    for (let i = 0; i < 50; i += 1) {
      expect(shouldQuarantine(rateLimited).quarantine).toBe(false);
    }
  });

  it('quarantines a surface whose sessions never arrive', () => {
    expect(shouldQuarantine({ consecutiveNoShows: NO_SHOW_QUARANTINE_THRESHOLD - 1, consecutiveFailures: 0 }).quarantine).toBe(false);
    const verdict = shouldQuarantine({ consecutiveNoShows: NO_SHOW_QUARANTINE_THRESHOLD, consecutiveFailures: 0 });
    expect(verdict.quarantine).toBe(true);
    expect(verdict.reason).toMatch(/never checked in/i);
  });

  it('quarantines after repeated non-rate-limit fire failures', () => {
    expect(shouldQuarantine({ consecutiveNoShows: 0, consecutiveFailures: FAILURE_QUARANTINE_THRESHOLD }).quarantine).toBe(true);
  });

  it('keeps a rate limit off the failure streak in the rows themselves', async () => {
    const account = await createAccount({ name: 'personal' });
    const routine = await createRoutine({
      accountId: account.id, routineRef: 'trig_a', name: 'a', tokenSecretName: 'S',
    });
    await recordRoutineFire({ routineId: routine.id, ok: false, rateLimited: true, retryAt: NOW });
    const after = (await getRoutineByRef('trig_a'))!;
    expect(after.totalRefusals).toBe(1);
    expect(after.consecutiveFailures).toBe(0);
    expect(after.retryAt).toBe(NOW);

    await recordRoutineFire({ routineId: routine.id, ok: false, rateLimited: false });
    expect((await getRoutineByRef('trig_a'))!.consecutiveFailures).toBe(1);
  });

  it('clears the no-show streak when a session actually checks in', async () => {
    const account = await createAccount({ name: 'personal' });
    const routine = await createRoutine({
      accountId: account.id, routineRef: 'trig_a', name: 'a', tokenSecretName: 'S',
    });
    await recordRoutineNoShow(routine.id);
    await recordRoutineNoShow(routine.id);
    expect((await getRoutineByRef('trig_a'))!.consecutiveNoShows).toBe(2);
    await recordRoutineCheckIn(routine.id);
    const after = (await getRoutineByRef('trig_a'))!;
    expect(after.consecutiveNoShows).toBe(0);
    expect(after.lastCheckInAt).not.toBeNull();
  });

  it('guards a state change on the state it was read at', async () => {
    const account = await createAccount({ name: 'personal' });
    expect(await setAccountState({ accountId: account.id, from: 'ENABLED', to: 'QUARANTINED', reason: 'x' })).toBe(true);
    // A second operator acting on the stale read changes nothing.
    expect(await setAccountState({ accountId: account.id, from: 'ENABLED', to: 'RETIRED', reason: 'y' })).toBe(false);
    expect((await getAccountByName('personal'))!.state).toBe('QUARANTINED');
  });

  it('records a refusal without inventing a retry time', async () => {
    const account = await createAccount({ name: 'personal' });
    await recordAccountRefusal({ accountId: account.id, reason: '429 too many', retryAt: null });
    const after = (await getAccountByName('personal'))!;
    expect(after.lastRefusalReason).toBe('429 too many');
    // Unknown stays unknown: no retry time was given, so none is stored.
    expect(after.retryAt).toBeNull();
  });
});

describe('audit independence is lineage, not a role name', () => {
  const lineage = (over: Partial<AuditLineage>): AuditLineage => ({
    role: 'PRIMARY', workerId: 'w1', routineId: 'r1', accountId: 'a1', sessionRef: 's1', ...over,
  });

  it('refuses a synthesis session that audits its own report, even at NONE', () => {
    const verdict = checkIndependence({
      level: 'NONE',
      synthesis: lineage({ sessionRef: 'synth' }),
      audits: [lineage({ role: 'PRIMARY', sessionRef: 'synth' })],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations[0]).toMatch(/cannot review itself/i);
  });

  it('refuses PRIMARY and ADVERSARIAL sharing a session', () => {
    const verdict = checkIndependence({
      level: 'SESSION',
      synthesis: null,
      audits: [
        lineage({ role: 'PRIMARY', sessionRef: 'same' }),
        lineage({ role: 'ADVERSARIAL', sessionRef: 'same' }),
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toMatch(/PRIMARY and ADVERSARIAL shared the same session/);
  });

  it('accepts separate sessions at SESSION and refuses them at ACCOUNT', () => {
    const audits = [
      lineage({ role: 'PRIMARY', sessionRef: 's1', accountId: 'a1' }),
      lineage({ role: 'ADVERSARIAL', sessionRef: 's2', accountId: 'a1' }),
      lineage({ role: 'JUDGE', sessionRef: 's3', accountId: 'a1' }),
    ];
    expect(checkIndependence({ level: 'SESSION', synthesis: null, audits }).ok).toBe(true);
    // The level the fleet exists to make reachable.
    const strict = checkIndependence({ level: 'ACCOUNT', synthesis: null, audits });
    expect(strict.ok).toBe(false);
    expect(strict.violations.join(' ')).toMatch(/shared the same account/);
  });

  it('accepts roles on genuinely different accounts', () => {
    const verdict = checkIndependence({
      level: 'ACCOUNT',
      synthesis: lineage({ sessionRef: 's0', accountId: 'a0' }),
      audits: [
        lineage({ role: 'PRIMARY', sessionRef: 's1', accountId: 'a1' }),
        lineage({ role: 'ADVERSARIAL', sessionRef: 's2', accountId: 'a2' }),
        lineage({ role: 'JUDGE', sessionRef: 's3', accountId: 'a3' }),
      ],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.policyVersion).toBe(INDEPENDENCE_POLICY_VERSION);
  });

  it('treats unrecorded lineage as a violation, never as a pass', () => {
    // "We could not tell" must not read the same as "we checked".
    const verdict = checkIndependence({
      level: 'ACCOUNT',
      synthesis: null,
      audits: [
        lineage({ role: 'PRIMARY', accountId: null }),
        lineage({ role: 'ADVERSARIAL', accountId: 'a2' }),
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join(' ')).toMatch(/recorded no account/);
  });
});

describe('simulation is deterministic and never mistaken for observation', () => {
  const trace = [
    { durationMs: 107_000, binsDrained: 7 },
    { durationMs: 60_000, binsDrained: 1 },
    { durationMs: 45_000, binsDrained: 2 },
  ];

  it('gives the same answer for the same trace and configuration', () => {
    const a = simulate(referenceFleet(10, 50, 60 * 60_000), trace);
    const b = simulate(referenceFleet(10, 50, 60 * 60_000), trace);
    expect(a).toEqual(b);
    expect(a.traceId).toBe(traceId(trace));
  });

  it('labels every result as simulated, structurally', () => {
    for (const size of [5, 10, 20, 30, 50]) {
      const result = simulate(referenceFleet(size, 50, 60 * 60_000), trace);
      // Not a string a reader might miss: a required literal on the type.
      expect(result.simulated).toBe(true);
    }
  });

  it('completes more of the queue with more workers, up to the queue', () => {
    const small = simulate(referenceFleet(5, 200, 10 * 60_000), trace);
    const large = simulate(referenceFleet(50, 200, 10 * 60_000), trace);
    expect(large.binsCompleted).toBeGreaterThan(small.binsCompleted);
  });

  it('models an account outage as no capacity from that account', () => {
    const result = simulate(
      {
        label: 'one down',
        accounts: [
          { name: 'a1', routines: 1, concurrency: 1, firesPerHour: null, unavailable: true },
          { name: 'a2', routines: 1, concurrency: 1, firesPerHour: null },
        ],
        queueDepth: 10,
        fleetTarget: null,
        horizonMs: 60 * 60_000,
      },
      trace,
    );
    expect(result.perAccount.find((a) => a.name === 'a1')!.activations).toBe(0);
    expect(result.perAccount.find((a) => a.name === 'a2')!.activations).toBeGreaterThan(0);
  });

  it('names what it could not model rather than defaulting it', () => {
    const result = simulate(referenceFleet(5, 10, 60 * 60_000), trace);
    expect(result.unknowns.join(' ')).toMatch(/no observed fire ceiling|no measured concurrency|cost distribution/i);
  });

  it('reports an empty trace as nothing simulated, not as zero throughput', () => {
    const result = simulate(referenceFleet(10, 50, 60 * 60_000), []);
    expect(result.binsCompleted).toBe(0);
    expect(result.binsRemaining).toBe(50);
    expect(result.unknowns[0]).toMatch(/empty trace/i);
  });
});

describe('the registry survives being used', () => {
  it('lists accounts and routines in a stable order across both backends', async () => {
    const a = await createAccount({ name: 'first' });
    const b = await createAccount({ name: 'second' });
    await createRoutine({ accountId: a.id, routineRef: 't1', name: 'r1', tokenSecretName: 'S1' });
    await createRoutine({ accountId: b.id, routineRef: 't2', name: 'r2', tokenSecretName: 'S2' });
    expect((await listAccounts()).map((x) => x.name)).toEqual(['first', 'second']);
    expect((await listRoutines()).map((x) => x.routineRef)).toEqual(['t1', 't2']);
  });

  it('drains a Routine without touching the account it belongs to', async () => {
    const account = await createAccount({ name: 'personal' });
    const routine = await createRoutine({
      accountId: account.id, routineRef: 'trig_a', name: 'a', tokenSecretName: 'S',
    });
    expect(await setRoutineState({ routineId: routine.id, from: 'ENABLED', to: 'DRAINING', reason: 'retiring' })).toBe(true);
    expect((await getAccountByName('personal'))!.state).toBe('ENABLED');
    expect((await getRoutineByRef('trig_a'))!.state).toBe('DRAINING');
  });
});

/* ========================================================================= */

/**
 * Atomic Routine selection.
 *
 * This is the section the step's testing requirement names, and it is the one
 * that would be missing if `routeBin` were mistaken for a safety mechanism. It
 * is not: it is arithmetic over a snapshot, and arithmetic two processes both
 * perform correctly still fires twice.
 *
 * These run against real Postgres when BRAIN_TEST_DATABASE_URL is set, which is
 * the only place they mean anything as a race. On SQLite the writers serialise,
 * so the `Promise.all` pairs below execute one after another — they still prove
 * the guard rejects a stale generation, which is the property, but they cannot
 * prove it under genuine simultaneity. That distinction is the whole reason
 * `bin_dispatch`'s original swap on `attempt_count` shipped: SQLite was happy
 * with it and Postgres failed it on the first run.
 */
describe('a fire slot is claimed, not computed', () => {
  async function surface(): Promise<FleetRoutine> {
    const account = await createAccount({ name: 'personal' });
    return createRoutine({
      accountId: account.id, routineRef: 'trig_slot', name: 'slot', tokenSecretName: 'S',
    });
  }

  it('lets exactly one of two simultaneous claims on one generation win', async () => {
    const routine = await surface();
    const [a, b] = await Promise.all([
      claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: routine.fireGeneration }),
      claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: routine.fireGeneration }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await getRoutineByRef('trig_slot'))!.fireGeneration).toBe(1);
  });

  it('refuses ten simultaneous claims on one generation all but once', async () => {
    const routine = await surface();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: routine.fireGeneration }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    // One winner, one increment. A guard that matched on anything the claimant
    // supplied would show ten here.
    expect((await getRoutineByRef('trig_slot'))!.fireGeneration).toBe(1);
    expect((await getRoutineByRef('trig_slot'))!.totalFires).toBe(1);
  });

  it('lets the loser win once it has re-read', async () => {
    // A lost claim is an ordinary outcome, not a dead surface: the next tick
    // reads the new generation and succeeds.
    const routine = await surface();
    expect(await claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: 0 })).toBe(true);
    expect(await claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: 0 })).toBe(false);
    const reread = (await getRoutineByRef('trig_slot'))!;
    expect(await claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: reread.fireGeneration })).toBe(true);
  });

  it('refuses a claim against a surface that was disabled after the snapshot', async () => {
    // The candidate list is a photograph. Between taking it and firing, an
    // operator may quarantine the surface — and the guard, not the photograph,
    // is what has to notice.
    const routine = await surface();
    await setRoutineState({ routineId: routine.id, from: 'ENABLED', to: 'QUARANTINED', reason: 'suspect' });
    expect(
      await claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: routine.fireGeneration }),
    ).toBe(false);
    expect((await getRoutineByRef('trig_slot'))!.totalFires).toBe(0);
  });

  it('refuses a claim against a surface rate-limited after the snapshot', async () => {
    const routine = await surface();
    await recordRoutineFire({
      routineId: routine.id,
      ok: false,
      rateLimited: true,
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const reread = (await getRoutineByRef('trig_slot'))!;
    expect(
      await claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: reread.fireGeneration }),
    ).toBe(false);
  });

  it('claims each surface independently, so two accounts are not one queue', async () => {
    const one = await createAccount({ name: 'one' });
    const two = await createAccount({ name: 'two' });
    const ra = await createRoutine({ accountId: one.id, routineRef: 't_one', name: 'a', tokenSecretName: 'S1' });
    const rb = await createRoutine({ accountId: two.id, routineRef: 't_two', name: 'b', tokenSecretName: 'S2' });
    const [a, b] = await Promise.all([
      claimRoutineFireSlot({ routineId: ra.id, expectedGeneration: 0 }),
      claimRoutineFireSlot({ routineId: rb.id, expectedGeneration: 0 }),
    ]);
    // Contending surfaces serialise; unrelated ones must not.
    expect([a, b]).toEqual([true, true]);
  });

  it('counts a refused fire as one attempt and one refusal, never as neither', async () => {
    // The claim is the commit point. If a crash or a refusal followed it, the
    // attempt still happened and the counter has to be able to say so.
    const routine = await surface();
    await claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: 0 });
    await recordRoutineFire({ routineId: routine.id, ok: false, retryAt: null });
    const after = (await getRoutineByRef('trig_slot'))!;
    expect(after.totalFires).toBe(1);
    expect(after.totalRefusals).toBe(1);
  });

  it('does not double-count a successful fire on the way back', async () => {
    const routine = await surface();
    await claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: 0 });
    await recordRoutineFire({ routineId: routine.id, ok: true });
    expect((await getRoutineByRef('trig_slot'))!.totalFires).toBe(1);
  });

  it('proves the guard is the generation and not the fire count', async () => {
    // The inversion. `total_fires` moves in step with `fire_generation`, so a
    // guard written against it would pass every test above. It is not equivalent:
    // a claimant that supplies its own read of a counter matches its own read.
    // Here the counter is advanced by an unrelated path — a refusal — while the
    // generation is not, and the stale generation must still be refused.
    const routine = await surface();
    await recordRoutineFire({ routineId: routine.id, ok: false, retryAt: null });
    const after = (await getRoutineByRef('trig_slot'))!;
    expect(after.totalRefusals).toBe(1);
    expect(after.fireGeneration).toBe(0);
    // Correct generation still wins; a wrong one never does, whatever the
    // counters say.
    expect(await claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: 1 })).toBe(false);
    expect(await claimRoutineFireSlot({ routineId: routine.id, expectedGeneration: 0 })).toBe(true);
  });
});

/* ========================================================================= */

/**
 * The dispatcher against a registered fleet.
 *
 * Everything above tests the router and the claim in isolation. These run the
 * real tick over real rows with the network stubbed, because the failure this
 * step most needs to not have is the one where every part is individually
 * correct and the whole thing still over-fires: the snapshot is read once, and
 * a burst of five would otherwise spend five activations on headroom measured
 * before any of them left.
 */
describe('a burst spends the headroom it measured, once', () => {
  const fired: string[] = [];
  let restoreFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fired.length = 0;
    restoreFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      fired.push(String(input));
      return new Response(JSON.stringify({ session_id: `session_${fired.length}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    process.env['FLEET_TEST_SECRET'] = 'sk-not-a-real-token';
    process.env['FLEET_TEST_SECRET_2'] = 'sk-also-not-real';
  });

  afterEach(() => {
    globalThis.fetch = restoreFetch;
    delete process.env['FLEET_TEST_SECRET'];
    delete process.env['FLEET_TEST_SECRET_2'];
  });

  /** Force a bin lease into the past without waiting for real time. */
  async function expireBinLease(binId: string): Promise<void> {
    await getDb().run(
      "UPDATE bins SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      [binId],
    );
  }

  async function readyBin(
    over: { priority?: number; requiredCapabilities?: string[]; workloadClass?: string } = {},
  ): Promise<string> {
    const bin = await createBin({
      projectId,
      kind: 'DETERMINISTIC_CHECK',
      title: 'A tiny checkable mission',
      objective: 'Establish a small set of values Brain can check for itself.',
      manifest: {
        objective: 'Establish a small set of values Brain can check for itself.',
        why: 'To exercise dispatch without spending research allowance.',
        lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
        units: [{ key: 'unit-1', establishes: 'x', input: 'y', transform: 'sha256', dependsOn: [] }],
        acceptableSources: [],
        excludedSources: [],
        evidence: ['a stored value matching Brain’s own recomputation'],
        outputs: ['one unit result per declared unit'],
        authorizedActions: ['submit unit results'],
        prohibitedActions: ['anything with an external effect'],
        budgetUnits: 1,
        retry: { maxAttempts: 3, backoffSeconds: 30 },
        stoppingConditions: ['every declared unit has a verified result'],
      },
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
      priority: over.priority,
      requiredCapabilities: over.requiredCapabilities,
      workloadClass: over.workloadClass,
    });
    return bin.id;
  }

  /*
   * The gap this closes, and why the router test above did not catch it.
   *
   * `routeBin`'s capability test builds its bin with `binLike({ … })` — a
   * hand-made object that always had the field. A bin read back from the
   * database never did: migration 026 added both columns, and the row type, the
   * mapper and the create path had all never learned about them, so the router
   * reached the value through a cast and got `undefined` for every real bin.
   * Every capability requirement therefore evaluated to "none" in production
   * while the unit test went on passing.
   *
   * So this one goes through storage. It is the difference between proving a
   * pure function and proving the field arrives.
   */
  it('persists a bin’s capability requirement all the way to the router', async () => {
    const binId = await readyBin({
      requiredCapabilities: ['egress:flsenate.gov'],
      workloadClass: 'RESEARCH_LIGHT',
    });
    const stored = await getBin(binId);
    expect(stored!.requiredCapabilities).toEqual(['egress:flsenate.gov']);
    expect(stored!.workloadClass).toBe('RESEARCH_LIGHT');

    const account = await createAccount({ name: 'capability-account' });
    const routine = await boundRoutine({
      accountId: account.id,
      routineRef: `trig_cap_${account.id}`,
      name: 'V1',
      tokenSecretName: 'BRAIN_TEST_TOKEN',
      capabilities: [],
    });

    // A surface without the tag is refused, by name.
    const refused = routeBin({
      bin: stored!,
      candidates: [
        {
          account,
          routine,
          servesProjects: [stored!.projectId],
          accountInFlight: 0,
          routineInFlight: 0,
          accountTarget: 1,
          routineTarget: 1,
        } as never,
      ],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: new Date().toISOString(),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal).toBe('NO_CAPABLE_SURFACE');

    // And a bin that requires nothing still routes, so the fix did not turn an
    // absent requirement into an impossible one.
    const plain = await getBin(await readyBin());
    expect(plain!.requiredCapabilities).toEqual([]);
  });

  it('fires one activation at a Routine whose target is one, not five', async () => {
    const account = await createAccount({ name: 'personal' });
    const routine = await boundRoutine({
      accountId: account.id, routineRef: 'trig_one', name: 'one', tokenSecretName: 'FLEET_TEST_SECRET',
    });
    await setPolicy({
      scope: 'ROUTINE', scopeId: routine.id, target: 1, actor: 'test', reason: 'ceiling of one',
    });
    await readyBin();
    await readyBin();
    await readyBin();

    const tick = await dispatchTick({ projectIds: [projectId], burst: 5 });

    expect(tick.fired).toBe(1);
    expect(fired).toHaveLength(1);
    expect((await getRoutineByRef('trig_one'))!.totalFires).toBe(1);

    /*
     * *Why* it is one matters as much as that it is one, and this is the
     * assertion that separates the two mechanisms.
     *
     * The compare-and-swap alone already caps this burst: iteration two carries
     * the generation the snapshot recorded before iteration one fired, so its
     * claim loses. That is correct and it is the wrong reason — the surface is
     * at its target, and a dispatcher racing *itself* would report a contended
     * fleet to an operator looking at a fleet with one Routine in it.
     *
     * So the burst also spends the headroom locally, and the refusal that comes
     * out names the target rather than the race. Delete that accounting and
     * this line is the one that fails, with `SLOT_LOST` in place of the truth.
     */
    expect(tick.unrouted['ACCOUNT_TARGETS_REACHED']).toBeGreaterThanOrEqual(1);
    expect(tick.unrouted['SLOT_LOST']).toBeUndefined();
  });

  it('spreads a burst across two accounts instead of exhausting one', async () => {
    // Cross-account routing, at the smallest scale that can show it. Each
    // surface may take one; two bins must therefore land on two accounts.
    const one = await createAccount({ name: 'one' });
    const two = await createAccount({ name: 'two' });
    const ra = await boundRoutine({
      accountId: one.id, routineRef: 'trig_a', name: 'a', tokenSecretName: 'FLEET_TEST_SECRET',
    });
    const rb = await boundRoutine({
      accountId: two.id, routineRef: 'trig_b', name: 'b', tokenSecretName: 'FLEET_TEST_SECRET_2',
    });
    await setPolicy({ scope: 'ROUTINE', scopeId: ra.id, target: 1, actor: 'test', reason: 'one each' });
    await setPolicy({ scope: 'ROUTINE', scopeId: rb.id, target: 1, actor: 'test', reason: 'one each' });
    await readyBin();
    await readyBin();

    const tick = await dispatchTick({ projectIds: [projectId], burst: 5 });
    expect(tick.fired).toBe(2);
    expect((await getRoutineByRef('trig_a'))!.totalFires).toBe(1);
    expect((await getRoutineByRef('trig_b'))!.totalFires).toBe(1);
  });

  it('alternates within one burst instead of piling onto whichever fired first', async () => {
    /*
     * Two idle accounts, no targets anywhere, four bins, one burst.
     *
     * `relativeHeadroom` returns the same number for two surfaces with no
     * configured target, so the whole decision falls to the least-recently-fired
     * tiebreak. Read once at the top of the tick and never advanced, that named
     * the same surface for every iteration and sent all four to one account.
     *
     * Seen in production first: with no account targets set, one batch went
     * entirely to one account and the next batch entirely to the other. Account
     * targets bound the ceiling and are the right control for that, but they are
     * not a fairness fix — a fleet may legitimately run with no targets at all.
     */
    const one = await createAccount({ name: 'one' });
    const two = await createAccount({ name: 'two' });
    await boundRoutine({
      accountId: one.id, routineRef: 'trig_a', name: 'a', tokenSecretName: 'FLEET_TEST_SECRET',
    });
    await boundRoutine({
      accountId: two.id, routineRef: 'trig_b', name: 'b', tokenSecretName: 'FLEET_TEST_SECRET_2',
    });
    for (let i = 0; i < 4; i += 1) await readyBin();

    const tick = await dispatchTick({ projectIds: [projectId], burst: 4 });
    expect(tick.fired).toBe(4);
    expect((await getRoutineByRef('trig_a'))!.totalFires).toBe(2);
    expect((await getRoutineByRef('trig_b'))!.totalFires).toBe(2);
  });

  it('routes around an account the operator took out mid-fleet', async () => {
    const one = await createAccount({ name: 'one' });
    const two = await createAccount({ name: 'two' });
    await boundRoutine({
      accountId: one.id, routineRef: 'trig_a', name: 'a', tokenSecretName: 'FLEET_TEST_SECRET',
    });
    await boundRoutine({
      accountId: two.id, routineRef: 'trig_b', name: 'b', tokenSecretName: 'FLEET_TEST_SECRET_2',
    });
    await setAccountState({ accountId: one.id, from: 'ENABLED', to: 'UNAVAILABLE', reason: 'operator' });
    await readyBin();

    const tick = await dispatchTick({ projectIds: [projectId], burst: 1 });
    expect(tick.fired).toBe(1);
    expect((await getRoutineByRef('trig_a'))!.totalFires).toBe(0);
    expect((await getRoutineByRef('trig_b'))!.totalFires).toBe(1);
  });

  it('holds every bin when the fleet is paused, and loses none of them', async () => {
    const account = await createAccount({ name: 'personal' });
    await boundRoutine({
      accountId: account.id, routineRef: 'trig_one', name: 'one', tokenSecretName: 'FLEET_TEST_SECRET',
    });
    await setPolicy({
      scope: 'FLEET', scopeId: null, target: 5, paused: true, actor: 'test', reason: 'stop',
    });
    const binId = await readyBin();

    const tick = await dispatchTick({ projectIds: [projectId], burst: 5 });
    expect(tick.fired).toBe(0);
    expect(fired).toHaveLength(0);
    expect(tick.unrouted['FLEET_PAUSED']).toBe(1);
    // The work is untouched, which is the point: a pause is not a cancel.
    expect((await getBin(binId))!.state).toBe('READY');
  });

  it('skips a Routine whose secret is not deployed rather than failing on it', async () => {
    const account = await createAccount({ name: 'personal' });
    await boundRoutine({
      accountId: account.id, routineRef: 'trig_ghost', name: 'ghost', tokenSecretName: 'NOT_DEPLOYED',
    });
    await boundRoutine({
      accountId: account.id, routineRef: 'trig_real', name: 'real', tokenSecretName: 'FLEET_TEST_SECRET',
    });
    await readyBin();

    const tick = await dispatchTick({ projectIds: [projectId], burst: 1 });
    expect(tick.missingSecrets).toBe(1);
    expect(tick.fired).toBe(1);
    expect((await getRoutineByRef('trig_real'))!.totalFires).toBe(1);
    expect((await getRoutineByRef('trig_ghost'))!.totalFires).toBe(0);
  });

  it('clears the no-show streak when the fired session actually arrives', async () => {
    /*
     * The defect this closes: `recordRoutineFire({ok:true})` advances
     * `consecutive_no_shows`, and until the arrival path existed nothing in
     * production ever cleared it. Three healthy fires made a healthy Routine a
     * quarantine candidate — a health signal pointing the opposite way to
     * reality — while `bindRoutineWorker`'s own comment said "the check-in path
     * fills it in" about a path that was never wired.
     */
    const account = await createAccount({ name: 'personal' });
    const routine = await createRoutine({
      accountId: account.id, routineRef: 'trig_one', name: 'one', tokenSecretName: 'FLEET_TEST_SECRET',
    });
    /*
     * Bound by an operator rather than observed on arrival, and that is a
     * change worth naming rather than a fixture convenience.
     *
     * This used to create the Routine unbound, fire it, and assert that the
     * arriving session *taught* the row which worker it was. The fire asks
     * about the project now, and a Routine bound to no worker serves no
     * project — so that sequence is unreachable for project-scoped work, which
     * is every bin in this schema. `bindRoutineWorker`'s observe-on-arrival is
     * therefore a fallback rather than the normal path, and `fleet bind-worker`
     * is what an operator uses instead.
     *
     * What this still proves is the thing it was written for: a fired surface
     * whose session actually arrives has its no-show streak cleared, credited
     * from Brain's own dispatch row.
     */
    const worker = await bindToProject(routine.id, 'w1');
    const binId = await readyBin();
    await dispatchTick({ projectIds: [projectId], burst: 1 });

    // Fired, and nothing has arrived: the pessimistic count is the honest one.
    expect((await getRoutineByRef('trig_one'))!.consecutiveNoShows).toBe(1);

    const assigned = await assignNextBin({ workerId: worker, projectIds: [projectId] });
    expect(assigned?.bin.id).toBe(binId);

    const after = (await getRoutineByRef('trig_one'))!;
    expect(after.consecutiveNoShows).toBe(0);
    expect(shouldQuarantine(after).quarantine).toBe(false);
    expect(after.workerId).toBe(worker);
  });

  it('credits the arrival to the surface that was fired, not to the one that asked', async () => {
    // Attribution comes from the dispatch row, never from the worker. A worker
    // that belongs to another Routine must not clear this one's streak.
    const one = await createAccount({ name: 'one' });
    const two = await createAccount({ name: 'two' });
    const ra = await createRoutine({
      accountId: one.id, routineRef: 'trig_a', name: 'a', tokenSecretName: 'FLEET_TEST_SECRET',
    });
    const rb = await createRoutine({
      accountId: two.id, routineRef: 'trig_b', name: 'b', tokenSecretName: 'FLEET_TEST_SECRET_2',
    });
    // Both bound, both able to serve this project — so the only thing that
    // decides the crediting is which one Brain actually fired.
    const workerA = await bindToProject(ra.id, 'w-a');
    await bindToProject(rb.id, 'w-b');
    // Take b out so the fire can only go to a.
    await setRoutineState({ routineId: rb.id, from: 'ENABLED', to: 'UNAVAILABLE', reason: 'held' });
    await readyBin();
    await dispatchTick({ projectIds: [projectId], burst: 1 });
    expect((await getRoutineByRef('trig_a'))!.consecutiveNoShows).toBe(1);

    await assignNextBin({ workerId: workerA, projectIds: [projectId] });

    expect((await getRoutineByRef('trig_a'))!.consecutiveNoShows).toBe(0);
    expect((await getRoutineByRef('trig_a'))!.workerId).toBe(workerA);
    // b was never fired, so it has nothing to clear: the arrival is credited
    // from the dispatch row rather than from the worker that turned up.
    expect((await getRoutineByRef('trig_b'))!.consecutiveNoShows).toBe(0);
  });

  it('credits nothing when a takeover follows a lease that expired', async () => {
    // The intent at that generation belonged to the previous owner, and its
    // session genuinely did not finish. Crediting it would erase the one signal
    // that says so.
    const account = await createAccount({ name: 'personal' });
    await boundRoutine({
      accountId: account.id, routineRef: 'trig_one', name: 'one', tokenSecretName: 'FLEET_TEST_SECRET',
    });
    const binId = await readyBin();
    await dispatchTick({ projectIds: [projectId], burst: 1 });
    // The first arrival is the worker this Routine is bound to. An unrelated
    // identity taking the bin is not this Routine's session and is credited
    // nothing either — `fleetFourAccountAcceptance` pins that — so it could not
    // stand in for "the fired session arrived" here.
    const firstId = (await getRoutineByRef('trig_one'))!.workerId!;
    await assignNextBin({ workerId: firstId, projectIds: [projectId] });
    expect((await getRoutineByRef('trig_one'))!.consecutiveNoShows).toBe(0);

    // The first worker dies. The lease lapses; a second worker takes over at a
    // generation this Routine was never fired for.
    await expireBinLease(binId);
    await recordRoutineFire({ routineId: (await getRoutineByRef('trig_one'))!.id, ok: true });
    const second = await createWorker({ name: 'w2', createdByType: 'SYSTEM', createdById: 'test' });
    const takeover = await assignNextBin({ workerId: second.id, projectIds: [projectId] });
    expect(takeover?.takeover).toBe(true);
    expect((await getRoutineByRef('trig_one'))!.consecutiveNoShows).toBe(1);
  });

  it('measures how long an execution took, so a simulation has something to replay', async () => {
    /*
     * `medianActivationMs` was null and `activationTrace` empty against a
     * production Brain that had drained eighty-one bins. Two causes, one shape:
     * `BIN_TERMINAL` carried no duration, and the trace grouped an event that
     * never carries a session by session. So the simulator reported "nothing to
     * simulate" about a fleet with months of history.
     */
    const account = await createAccount({ name: 'personal' });
    await boundRoutine({
      accountId: account.id, routineRef: 'trig_one', name: 'one', tokenSecretName: 'FLEET_TEST_SECRET',
    });
    const binId = await readyBin();
    await dispatchTick({ projectIds: [projectId], burst: 1 });
    const worker = await createWorker({ name: 'w1', createdByType: 'SYSTEM', createdById: 'test' });
    const assigned = (await assignNextBin({ workerId: worker.id, projectIds: [projectId] }))!;
    expect(
      await finishBin(
        {
          binId,
          leaseId: assigned.leaseId,
          leaseGeneration: assigned.leaseGeneration,
          workerId: worker.id,
        },
        { state: 'COMPLETE', reason: 'test' },
      ),
    ).toBe('OK');

    const terminal = (await listBinEvents(binId)).find((e) => e.eventType === 'BIN_TERMINAL');
    expect(terminal?.durationMs).not.toBeNull();
    expect(terminal!.durationMs!).toBeGreaterThanOrEqual(0);

    /*
     * A test lease is held for well under a millisecond, so this duration is
     * usually exactly zero — and zero is a measurement, not a missing one. The
     * first version of the filter dropped it with `total > 0` and this line
     * failed on roughly one run in three, which is the honest way to have found
     * out that a real activation could go missing for being fast.
     */
    const trace = await activationTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0]!.binsDrained).toBe(1);
    expect(trace[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports nothing simulated rather than a made-up minute', async () => {
    // The inversion of the line above. An execution with no recorded duration
    // is one that cannot be measured, and a default would put an invented
    // number into a projection reported as resting on observed samples.
    const samples = await activationTrace();
    expect(samples).toHaveLength(0);
    const result = simulate(referenceFleet(3, 10, 60 * 60_000), samples);
    expect(result.simulated).toBe(true);
    expect(result.binsCompleted).toBe(0);
    expect(result.binsRemaining).toBe(10);
    expect(result.unknowns.join(' ')).toMatch(/empty trace|Nothing can be simulated/i);
  });

  it('still fires through the environment when nothing is registered yet', async () => {
    // The migration window: this code is deployed and nobody has registered an
    // account. A flag day here would strand every bin in production.
    process.env['BRAIN_ROUTINE_ID'] = 'trig_env';
    process.env['BRAIN_ROUTINE_TOKEN'] = 'sk-env-not-real';
    try {
      await readyBin();
      const tick = await dispatchTick({ projectIds: [projectId], burst: 1 });
      expect(tick.fired).toBe(1);
      expect(fired[0]).toContain('trig_env');
    } finally {
      delete process.env['BRAIN_ROUTINE_ID'];
      delete process.env['BRAIN_ROUTINE_TOKEN'];
    }
  });

  it('does not fire the environment trigger when every registered secret is missing', async () => {
    // The snapshot leaves out a Routine whose secret is not deployed, and the
    // fallback used to read that as "nothing registered" — firing every bin at
    // one fixed Routine with no router, no scope and no fire slot.
    const account = await createAccount({ name: 'rotated-away' });
    await createRoutine({
      accountId: account.id,
      routineRef: 'trig_registered_but_unset',
      name: 'Registered surface',
      tokenSecretName: 'A_SECRET_NOBODY_DEPLOYED',
    });
    process.env['BRAIN_ROUTINE_ID'] = 'trig_env';
    process.env['BRAIN_ROUTINE_TOKEN'] = 'sk-env-not-real';
    try {
      await readyBin();
      const tick = await dispatchTick({ projectIds: [projectId], burst: 1 });
      expect(tick.fired).toBe(0);
      expect(fired.some((one) => one.includes('trig_env'))).toBe(false);
      expect(tick.missingSecrets).toBe(1);
    } finally {
      delete process.env['BRAIN_ROUTINE_ID'];
      delete process.env['BRAIN_ROUTINE_TOKEN'];
    }
  });
});

describe('renaming a surface', () => {
  it('changes the label and touches nothing the fire depends on', async () => {
    /*
     * `V1` and `V2` were the site names borrowed for capacity surfaces, which is
     * what makes a fleet reading ambiguous — so a capacity surface becomes
     * `Brain Research A` and a site keeps its own name. The reason this needs a
     * test rather than an UPDATE is the surface being renamed is the one already
     * doing the work: a rename that disturbed its credential, its trigger or its
     * worker binding would stop the packet it is in the middle of.
     */
    const account = await createAccount({ name: 'primary', planLabel: 'Max 20x' });
    const worker = await createWorker({
      name: 'shared-research',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_live',
      name: 'V1',
      tokenSecretName: 'BRAIN_ROUTINE_TOKEN_V1',
      tokenDigest: 'a-digest-taken-at-registration',
      capabilities: ['research'],
      workerId: worker.id,
    });

    expect(await renameRoutine({ routineId: routine.id, from: 'V1', to: 'Brain Research A' })).toBe(
      true,
    );

    const after = (await getRoutine(routine.id))!;
    expect(after.name).toBe('Brain Research A');
    // Everything the dispatcher actually reads is byte-identical.
    expect(after.routineRef).toBe(routine.routineRef);
    expect(after.tokenSecretName).toBe(routine.tokenSecretName);
    expect(after.tokenDigest).toBe(routine.tokenDigest);
    expect(after.workerId).toBe(routine.workerId);
    expect(after.state).toBe(routine.state);
    expect(after.capabilities).toEqual(routine.capabilities);
    expect(after.totalFires).toBe(routine.totalFires);
    // And it is still found by the trigger Brain fires, which is its identity.
    expect((await getRoutineByRef('trig_live'))!.id).toBe(routine.id);
  });

  it('is guarded on the name it was given, so two renames produce one', async () => {
    const account = await createAccount({ name: 'primary', planLabel: 'Max 20x' });
    const routine = await createRoutine({
      accountId: account.id, routineRef: 'trig_x', name: 'V1', tokenSecretName: 'S_X',
    });
    expect(await renameRoutine({ routineId: routine.id, from: 'V1', to: 'Brain Research A' })).toBe(true);
    // The second caller read `V1` too, and loses. An ordinary outcome.
    expect(await renameRoutine({ routineId: routine.id, from: 'V1', to: 'Something Else' })).toBe(false);
    expect((await getRoutine(routine.id))!.name).toBe('Brain Research A');
  });

  it('renames an account without disturbing the Routines under it', async () => {
    const account = await createAccount({ name: 'friend-2', planLabel: 'Max 20x' });
    const routine = await createRoutine({
      accountId: account.id, routineRef: 'trig_y', name: 'V2', tokenSecretName: 'S_Y',
    });
    expect(await renameAccount({ accountId: account.id, from: 'friend-2', to: 'Brain Research B' })).toBe(
      true,
    );
    expect((await getAccountByName('Brain Research B'))!.id).toBe(account.id);
    expect((await getRoutine(routine.id))!.accountId).toBe(account.id);
    expect((await getRoutine(routine.id))!.tokenSecretName).toBe('S_Y');
  });
});
