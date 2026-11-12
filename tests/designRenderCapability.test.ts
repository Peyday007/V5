/**
 * A render bin goes to a surface that can render, and never strands.
 *
 * Production, 7 days to 2026-11-12: six of six DESIGN_RENDER bins ended
 * NEEDS_HUMAN with "The bin used all 3 attempts without satisfying
 * DESIGN_RENDER_V1 v1. Outstanding: No render was submitted". The bins carried
 * no `requiredCapabilities`, so the router fired and the assigner handed them to
 * any surface — sessions with no browser, which could not produce a render —
 * and every attempt was spent on a worker that could never have answered.
 *
 * The contract now implies the capability (`contractCapabilities`), applied by
 * both gates while some enabled Routine declares it and dropped while none
 * does, so the fix routes render work to a browser and cannot strand it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createBin, getBin } from '../server/repos/bins.ts';
import { createAccount, createRoutine, setRoutineCapabilities } from '../server/repos/fleet.ts';
import { createWorker } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import {
  contractCapabilities,
  effectiveCapabilities,
  evaluateContract,
} from '../server/services/bins/contracts.ts';
import { binAdmission, checkIn, release, routinesThatTriedBin } from '../server/services/bins/service.ts';
import { routeBin, type RoutingCandidate } from '../server/services/dispatch/router.ts';
import type { Bin, BinManifest, FleetAccount, FleetRoutine, Principal, WorkerScope } from '../server/domain/types.ts';

const NOW = '2026-11-12T12:00:00.000Z';
const SCOPES: WorkerScope[] = ['queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'];
const tag = () => Math.random().toString(36).slice(2, 8);

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

function renderLike(over: Partial<Bin> = {}): Bin {
  return {
    id: 'bin_render',
    projectId,
    kind: 'DESIGN_RENDER',
    state: 'READY',
    priority: 5,
    completionContract: 'DESIGN_RENDER_V1',
    requiredCapabilities: [],
    workloadClass: 'GENERAL_DESIGN_RENDER',
    manifest: { units: [] },
    createdAt: NOW,
    ...over,
  } as unknown as Bin;
}

function candidate(id: string, capabilities: string[], state = 'ENABLED'): RoutingCandidate {
  return {
    servesRepositories: null,
    servesProjects: [projectId],
    servesFamilies: null,
    workerActive: true,
    routine: {
      id,
      accountId: `acct_${id}`,
      routineRef: `trig_${id}`,
      name: id,
      state,
      capabilities,
      retryAt: null,
      lastFiredAt: null,
    } as unknown as FleetRoutine,
    account: { id: `acct_${id}`, name: id, state: 'ENABLED', retryAt: null } as unknown as FleetAccount,
    routineInFlight: 0,
    accountInFlight: 0,
    routineTarget: null,
    accountTarget: null,
  };
}

describe('the contract names what can satisfy it', () => {
  it('requires a browser for a render and nothing for any other contract', () => {
    expect(contractCapabilities('DESIGN_RENDER_V1')).toEqual(['browser']);
    for (const other of ['DESIGN_REVIEW_V1', 'FACTORY_PLAN_V1', 'FACTORY_UNITS_V1', 'RESEARCH_PACKET_V1']) {
      expect(contractCapabilities(other)).toEqual([]);
    }
  });

  it('adds a derived capability only while the fleet declares it, and never touches explicit ones', () => {
    const bin = renderLike();
    expect(effectiveCapabilities(bin)).toEqual([]);
    expect(effectiveCapabilities(bin, () => false)).toEqual([]);
    expect(effectiveCapabilities(bin, (cap) => cap === 'browser')).toEqual(['browser']);
    const factory = renderLike({ completionContract: 'FACTORY_UNITS_V1' as Bin['completionContract'], requiredCapabilities: ['repository'] });
    expect(effectiveCapabilities(factory, () => true)).toEqual(['repository']);
    expect(effectiveCapabilities(factory, () => false)).toEqual(['repository']);
  });
});

describe('the router fires a render at a surface that can render', () => {
  it('chooses the browser surface and refuses the browserless one for its capability', () => {
    const result = routeBin({
      bin: renderLike(),
      candidates: [candidate('plain', []), candidate('browser', ['browser'])],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routine.id).toBe('browser');
    expect(result.considered.find((one) => one.routineId === 'plain')?.verdict).toBe(
      'lacks a required capability',
    );
  });

  it('still routes when no enabled surface declares a browser, so the bin is never stranded', () => {
    const result = routeBin({
      bin: renderLike(),
      candidates: [candidate('plain', []), candidate('off', ['browser'], 'DISABLED')],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.routine.id).toBe('plain');
  });

  it('routes every other contract exactly as before', () => {
    const result = routeBin({
      bin: renderLike({ completionContract: 'DESIGN_REVIEW_V1' as Bin['completionContract'] }),
      candidates: [candidate('plain', []), candidate('browser', ['browser'])],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

describe('the assigner leaves a render for a surface that can render', () => {
  const manifest = (): BinManifest =>
    ({
      objective: 'Render the registered surfaces and report what was measured in the page.',
      why: 'Brain has no browser.',
      lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'design_render', establishes: 'a render', input: 'npm run design -- render', transform: 'NONE', dependsOn: [] }],
      acceptableSources: [],
      excludedSources: [],
      evidence: [],
      outputs: [],
      authorizedActions: ['starting this product locally'],
      prohibitedActions: ['pushing anything anywhere'],
      budgetUnits: 1,
      retry: { maxAttempts: 2, backoffSeconds: 120 },
      stoppingConditions: ['the submission has been made'],
    }) as unknown as BinManifest;

  async function setup(browserSurface: boolean) {
    const account = await createAccount({ name: `render-${tag()}` });
    const plain = await createRoutine({
      accountId: account.id, routineRef: `trig_plain_${tag()}`, name: `plain-${tag()}`, tokenSecretName: 'S_PLAIN',
    });
    if (browserSurface) {
      const browser = await createRoutine({
        accountId: account.id, routineRef: `trig_browser_${tag()}`, name: `browser-${tag()}`, tokenSecretName: 'S_BROWSER',
      });
      await setRoutineCapabilities({ routineId: browser.id, capabilities: ['browser'], actor: 'test', reason: 'has Chromium' });
    }
    const bin = await createBin({
      projectId,
      kind: 'DESIGN_RENDER',
      title: 'Design render: home',
      objective: 'Render the home surface.',
      manifest: manifest(),
      completionContract: 'DESIGN_RENDER_V1',
      createdByType: 'SYSTEM',
      createdById: `design:render:test:${tag()}`,
      ready: true,
      maxAttempts: 3,
      workloadClass: 'GENERAL_DESIGN_RENDER',
    });
    // Brain fired this session from the browserless Routine.
    const session = `cse_${tag()}${tag()}${tag()}`;
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count, max_attempts,
         next_attempt_at, routine_id, routine_ref, session_ref, created_at, updated_at, sent_at)
       VALUES (?, ?, 0, 'SENT', 1, 5, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('bdi'), bin.id, at, plain.id, plain.routineRef, session, at, at, at],
    );
    const worker = await createWorker({ name: `render-worker-${tag()}`, createdByType: 'SYSTEM', createdById: 't' });
    const principal = {
      type: 'WORKER',
      id: worker.id,
      handle: `worker-${worker.id}`,
      displayName: 'Render worker',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: `cred-${worker.id}`,
      authMethod: 'WORKER_BEARER',
      memberships: [{ projectId, role: null, scopes: SCOPES, active: true }],
      requestId: 'test-request',
    } as unknown as Principal;
    const admit = await binAdmission({ workerId: worker.id, principal, sessionRef: session });
    return { bin, admit };
  }

  it('skips a browserless session quietly while a browser surface exists, costing no attempt', async () => {
    const { bin, admit } = await setup(true);
    const verdict = await admit(bin);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.quiet).toBe(true);
    expect(verdict.reason).toContain('browser');
    const row = await getDb().get<{ attempt_count: number; state: string }>(
      'SELECT attempt_count, state FROM bins WHERE id = ?',
      [bin.id],
    );
    expect(row).toEqual({ attempt_count: 0, state: 'READY' });
  });

  it('admits the same session when no surface declares a browser (fail open, as before)', async () => {
    const { bin, admit } = await setup(false);
    const verdict = await admit(bin);
    if (!verdict.ok) expect(verdict.reason).not.toContain('does not declare browser');
  });

  it('keeps the evidence bar: an unanswered render is still refused', async () => {
    const { bin } = await setup(true);
    const verdict = await evaluateContract(bin);
    expect(verdict.disposition).toBe('RETRY');
    expect(verdict.reasons.join(' ')).toContain('No render was submitted');
  });
});

/*
 * The recorded state itself, walked end to end through check-in.
 *
 * Production, 7 days to 2026-11-12: a fleet in which **no Routine declares
 * `browser`**, a render bin, a session that takes it and submits nothing, and
 * the retry handed back to the same surface until all three attempts are spent.
 * Nothing above changes that state — with no declared browser the capability
 * rule fails open, by design — so these start from exactly it and show what
 * changes: the next attempt goes to a surface that has not already shown, on
 * this bin, that it leaves it unanswered.
 */
describe('a render retry from the recorded state: no surface declares a browser', () => {
  const workerManifest = (): BinManifest =>
    ({
      objective: 'Render the registered surfaces and report what was measured in the page.',
      why: 'Brain has no browser.',
      lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'design_render', establishes: 'a render', input: 'npm run design -- render', transform: 'NONE', dependsOn: [] }],
      acceptableSources: [],
      excludedSources: [],
      evidence: [],
      outputs: [],
      authorizedActions: ['starting this product locally'],
      prohibitedActions: ['pushing anything anywhere'],
      budgetUnits: 1,
      retry: { maxAttempts: 2, backoffSeconds: 120 },
      stoppingConditions: ['the submission has been made'],
    }) as unknown as BinManifest;

  let workerId = '';
  const principalFor = (credentialId: string) =>
    ({
      type: 'WORKER',
      id: workerId,
      handle: `worker-${workerId}`,
      displayName: 'Render worker',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId,
      authMethod: 'WORKER_BEARER',
      memberships: [{ projectId, role: null, scopes: SCOPES, active: true }],
      requestId: `req-${credentialId}`,
    }) as unknown as Principal;

  /** Brain fired `session` from `routine` for this bin — the row `routineRefsForSession` reads. */
  async function fired(binId: string, routine: { id: string; routineRef: string }, session: string, generation: number) {
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count, max_attempts,
         next_attempt_at, routine_id, routine_ref, session_ref, created_at, updated_at, sent_at)
       VALUES (?, ?, ?, 'SENT', 1, 5, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('bdi'), binId, generation, at, routine.id, routine.routineRef, session, at, at, at],
    );
  }

  async function recordedState(surfaces: number) {
    const account = await createAccount({ name: `render-${tag()}` });
    const routines = [];
    for (let i = 0; i < surfaces; i += 1) {
      // No capabilities declared on any of them: the production fleet.
      routines.push(
        await createRoutine({
          accountId: account.id, routineRef: `trig_${i}_${tag()}`, name: `surface-${i}-${tag()}`, tokenSecretName: `S_${i}`,
        }),
      );
    }
    const bin = await createBin({
      projectId,
      kind: 'DESIGN_RENDER',
      title: 'Design render: home',
      objective: 'Render the home surface.',
      manifest: workerManifest(),
      completionContract: 'DESIGN_RENDER_V1',
      createdByType: 'SYSTEM',
      createdById: `design:render:recorded:${tag()}`,
      ready: true,
      maxAttempts: 3,
      workloadClass: 'GENERAL_DESIGN_RENDER',
    });
    workerId = (await createWorker({ name: `render-worker-${tag()}`, createdByType: 'SYSTEM', createdById: 't' })).id;

    // Attempt 1: a session of the first surface takes the bin and submits nothing.
    const first = `cse_${tag()}${tag()}${tag()}`;
    await fired(bin.id, routines[0]!, first, 0);
    const arrival = await checkIn({ principal: principalFor(first), workerId, sessionRef: first });
    expect(arrival.assigned).toBe(true);
    if (!arrival.assigned) throw new Error('unreachable');
    expect(arrival.assignment.binId).toBe(bin.id);
    const proof = {
      binId: bin.id,
      leaseId: arrival.assignment.leaseId,
      leaseGeneration: arrival.assignment.leaseGeneration,
      workerId,
    };
    const verdict = await evaluateContract((await getBin(bin.id))!);
    expect(verdict.reasons.join(' ')).toContain('No render was submitted');
    await release(proof, 'no browser here; nothing rendered');
    const after = (await getBin(bin.id))!;
    expect(after.state).toBe('READY');
    expect(after.attemptCount).toBe(1);
    return { bin, routines, generation: after.leaseGeneration };
  }

  it('does not hand the retry back to the surface that left it unanswered while another has not tried', async () => {
    const { bin, routines, generation } = await recordedState(2);

    // The same surface fires again: before this change it took attempt 2 too.
    const again = `cse_${tag()}${tag()}${tag()}`;
    await fired(bin.id, routines[0]!, again, generation);
    const refused = await checkIn({ principal: principalFor(again), workerId, sessionRef: again });
    expect(refused.assigned && refused.assignment.binId === bin.id).toBe(false);
    expect((await getBin(bin.id))!.attemptCount).toBe(1);

    // A surface that has not tried gets it, and the attempt is the second, not the third.
    const other = `cse_${tag()}${tag()}${tag()}`;
    // A fresh intent, since the refused fire's row already holds this generation.
    await fired(bin.id, routines[1]!, other, generation + 1);
    const taken = await checkIn({ principal: principalFor(other), workerId, sessionRef: other });
    expect(taken.assigned).toBe(true);
    if (taken.assigned) expect(taken.assignment.binId).toBe(bin.id);
    expect((await getBin(bin.id))!.attemptCount).toBe(2);
  });

  it('is never stranded: once every enabled surface has tried, the retry is admitted as before', async () => {
    const { bin, routines, generation } = await recordedState(1);
    const again = `cse_${tag()}${tag()}${tag()}`;
    await fired(bin.id, routines[0]!, again, generation);
    const taken = await checkIn({ principal: principalFor(again), workerId, sessionRef: again });
    expect(taken.assigned).toBe(true);
    if (taken.assigned) expect(taken.assignment.binId).toBe(bin.id);
  });

  it('names the surfaces that tried from the lease rows', async () => {
    const { bin, routines } = await recordedState(2);
    const tried = await routinesThatTriedBin(bin.id);
    expect([...tried]).toEqual([routines[0]!.routineRef]);
  });
});
