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
import { createBin } from '../server/repos/bins.ts';
import { createAccount, createRoutine, getRoutine, setRoutineCapabilities } from '../server/repos/fleet.ts';
import { createWorker } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import {
  contractCapabilities,
  effectiveCapabilities,
  evaluateContract,
} from '../server/services/bins/contracts.ts';
import {
  binAdmission,
  fleetDeclarationScanCount,
  forgetFleetDeclarations,
  recordDemonstratedCapabilities,
} from '../server/services/bins/service.ts';
import { routeBin, type RoutingCandidate } from '../server/services/dispatch/router.ts';
import type { Bin, BinManifest, FleetAccount, FleetRoutine, Principal, WorkerScope } from '../server/domain/types.ts';

const NOW = '2026-11-12T12:00:00.000Z';
const SCOPES: WorkerScope[] = ['queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'];
const tag = () => Math.random().toString(36).slice(2, 8);

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  // The fleet's declarations are shared for a short window; each test builds its own fleet.
  forgetFleetDeclarations();
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
  return { bin, admit, plain, session, principal, worker };
}

describe('the assigner leaves a render for a surface that can render', () => {
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
    // Fail open means admitted: an unconditional assertion, so a refusal of any
    // kind — not only one worded about a browser — fails this test.
    expect(verdict.reason ?? null).toBeNull();
    expect(verdict.ok).toBe(true);
    expect(verdict.quiet).toBeUndefined();
  });

  it('keeps the evidence bar: an unanswered render is still refused', async () => {
    const { bin } = await setup(true);
    const verdict = await evaluateContract(bin);
    expect(verdict.disposition).toBe('RETRY');
    expect(verdict.reasons.join(' ')).toContain('No render was submitted');
  });
});

describe('a surface that renders declares the browser it proved it has', () => {
  /*
   * The derived requirement had a consumer and no producer: only a person wrote
   * `capabilities`, nobody had written `browser`, and so every render bin was
   * routed exactly as before. A satisfied render is the proof, and Brain writes
   * it to the Routine it fired.
   */
  async function fired(account: string, session: string) {
    const binId = (
      await createBin({
        projectId,
        kind: 'DESIGN_RENDER',
        title: 'Design render: proof',
        objective: 'Render the home surface.',
        manifest: manifest(),
        completionContract: 'DESIGN_RENDER_V1',
        createdByType: 'SYSTEM',
        createdById: `design:render:proof:${tag()}`,
        ready: true,
        maxAttempts: 3,
        workloadClass: 'GENERAL_DESIGN_RENDER',
      })
    ).id;
    const routine = await createRoutine({
      accountId: account, routineRef: `trig_${tag()}`, name: `r-${tag()}`, tokenSecretName: `S_${tag()}`,
    });
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count, max_attempts,
         next_attempt_at, routine_id, routine_ref, session_ref, created_at, updated_at, sent_at)
       VALUES (?, ?, 0, 'SENT', 1, 5, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('bdi'), binId, at, routine.id, routine.routineRef, session, at, at, at],
    );
    return routine;
  }

  it('reproduces the gap: with nobody declaring a browser, a browserless session is admitted to a render', async () => {
    const account = await createAccount({ name: `gap-${tag()}` });
    const session = `cse_${tag()}${tag()}${tag()}`;
    const bin = renderLike({ id: `bin_${tag()}` });
    await fired(account.id, session);
    expect(effectiveCapabilities(bin, () => false)).toEqual([]);
  });

  it('writes the capability to the Routine whose session satisfied the render, and the gates then use it', async () => {
    const account = await createAccount({ name: `proof-${tag()}` });
    const session = `cse_${tag()}${tag()}${tag()}`;
    const renderer = await fired(account.id, session);
    expect(renderer.capabilities).toEqual([]);

    const changed = await recordDemonstratedCapabilities({
      id: 'bin_rendered', completionContract: 'DESIGN_RENDER_V1', leaseSessionRef: session,
    } as Bin);
    expect(changed).toEqual([renderer.id]);
    expect((await getRoutine(renderer.id))!.capabilities).toEqual(['browser']);

    // Producer reaches consumer: a browserless session is now left the render
    // for the surface that proved it can do it.
    const { bin, admit } = await setup(false);
    const verdict = await admit(bin);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.quiet).toBe(true);
    expect(verdict.reason).toContain('browser');
    const routed = routeBin({
      bin: renderLike(),
      candidates: [candidate('plain', []), candidate(renderer.id, (await getRoutine(renderer.id))!.capabilities)],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: NOW,
    });
    expect(routed.ok && routed.routine.id).toBe(renderer.id);
  });

  it('is idempotent and never removes what a person declared', async () => {
    const account = await createAccount({ name: `keep-${tag()}` });
    const session = `cse_${tag()}${tag()}${tag()}`;
    const routine = await fired(account.id, session);
    await setRoutineCapabilities({ routineId: routine.id, capabilities: ['repository'], actor: 'test', reason: 'checkout' });
    const bin = { id: 'bin_x', completionContract: 'DESIGN_RENDER_V1', leaseSessionRef: session } as Bin;
    expect(await recordDemonstratedCapabilities(bin)).toEqual([routine.id]);
    expect(await recordDemonstratedCapabilities(bin)).toEqual([]);
    expect((await getRoutine(routine.id))!.capabilities).toEqual(['browser', 'repository']);
  });

  it('writes nothing for a contract that implies no capability, or a session Brain did not fire', async () => {
    const account = await createAccount({ name: `none-${tag()}` });
    const session = `cse_${tag()}${tag()}${tag()}`;
    const routine = await fired(account.id, session);
    expect(
      await recordDemonstratedCapabilities({ id: 'b', completionContract: 'FACTORY_UNITS_V1', leaseSessionRef: session } as Bin),
    ).toEqual([]);
    expect(
      await recordDemonstratedCapabilities({ id: 'b', completionContract: 'DESIGN_RENDER_V1', leaseSessionRef: `cse_${tag()}${tag()}${tag()}` } as Bin),
    ).toEqual([]);
    expect(
      await recordDemonstratedCapabilities({ id: 'b', completionContract: 'DESIGN_RENDER_V1', leaseSessionRef: null } as Bin),
    ).toEqual([]);
    expect((await getRoutine(routine.id))!.capabilities).toEqual([]);
  });
});

/*
 * Review finding: admission read every Routine and every Account on each
 * admission of a render bin with a session, so each claim attempt cost two
 * full-table reads on the pressure-sensitive claim path (§61/§63). The fleet is
 * now read only when its answer can change the verdict, and then once per short
 * window — without changing a single verdict above.
 */
describe('admission does not scan the fleet on every claim', () => {
  it('scans at most once across many admissions of the browserless session, and still skips it', async () => {
    const { bin, principal, worker, session } = await setup(true);
    const before = fleetDeclarationScanCount();
    for (let i = 0; i < 5; i += 1) {
      const admit = await binAdmission({ workerId: worker.id, principal, sessionRef: session });
      const verdict = await admit(bin);
      expect(verdict.ok).toBe(false);
      expect(verdict.quiet).toBe(true);
    }
    expect(fleetDeclarationScanCount() - before).toBeLessThanOrEqual(1);
  });

  it('never scans for a session Brain did not fire', async () => {
    const { bin, principal, worker } = await setup(true);
    const before = fleetDeclarationScanCount();
    const admit = await binAdmission({ workerId: worker.id, principal, sessionRef: `cse_unfired_${tag()}` });
    const verdict = await admit(bin);
    expect(verdict.ok).toBe(true);
    expect(fleetDeclarationScanCount()).toBe(before);
  });

  it('never scans for a session whose own enabled Routine already declares the browser', async () => {
    // The session Brain fired from `plain`, which is now declared to have a browser.
    const { bin, principal, worker, plain, session } = await setup(false);
    await setRoutineCapabilities({ routineId: plain.id, capabilities: ['browser'], actor: 'test', reason: 'has Chromium' });
    const before = fleetDeclarationScanCount();
    const admit = await binAdmission({ workerId: worker.id, principal, sessionRef: session });
    const verdict = await admit(bin);
    expect(verdict.reason ?? null).toBeNull();
    expect(verdict.ok).toBe(true);
    expect(fleetDeclarationScanCount()).toBe(before);
  });
});
