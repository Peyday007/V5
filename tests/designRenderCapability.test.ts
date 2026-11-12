/**
 * A render bin can be done by the worker it is handed, and goes to a surface
 * that can render.
 *
 * Production, 7 days to 2026-11-12: six of six DESIGN_RENDER bins ended
 * NEEDS_HUMAN with "The bin used all 3 attempts without satisfying
 * DESIGN_RENDER_V1 v1. Outstanding: No render was submitted".
 *
 * The cause is the manifest, not the fleet: a direct run in an ordinary worker
 * session renders with the manifest's exact command. The command needs the
 * repository's dependencies installed and builds the client, and the manifest
 * authorized neither and prohibited "changing any file in the repository" — so
 * a worker that kept to its authority could not run it and submitted nothing.
 * `the manifest authorizes the command it gives` reproduces that class.
 *
 * A review finding then refuted the routing preference that was added beside
 * the manifest fix: a capability derived from the render contract became
 * required fleet-wide the moment any one Routine declared `browser` (and Brain
 * wrote that declaration itself after one satisfied render), so the router and
 * the assigner excluded every other Routine from renders — Routines that could
 * render, and could never earn the tag because they were never admitted to
 * one. Render work collapsed onto whichever Routines completed first. The
 * derived routing and the automatic write are gone; a bin's own
 * `requiredCapabilities` still fail closed exactly as before.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createBin } from '../server/repos/bins.ts';
import { createAccount, createRoutine, getRoutine, setRoutineCapabilities } from '../server/repos/fleet.ts';
import { createWorker } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import { evaluateContract } from '../server/services/bins/contracts.ts';
import { binAdmission } from '../server/services/bins/service.ts';
import { routeBin, type RoutingCandidate } from '../server/services/dispatch/router.ts';
import { designRenderManifest, renderCommand } from '../server/services/design/render.ts';
import { SEED_SURFACES } from '../server/services/design/surfaces.ts';
import { readFileSync } from 'node:fs';
import type { DesignCycle, DesignSurface } from '../server/domain/design.ts';
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

describe('the router does not strand render work on the surfaces that declared a browser first', () => {
  it('keeps a browserless surface eligible for a render while another surface declares a browser', () => {
    const result = routeBin({
      bin: renderLike(),
      candidates: [candidate('plain', []), candidate('browser', ['browser'])],
      fleetPolicy: null,
      fleetInFlight: 0,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.considered.find((one) => one.routineId === 'plain')?.verdict).not.toBe(
      'lacks a required capability',
    );
  });

  it('fires a render at a browserless surface when it is the only one with room', () => {
    const busy = { ...candidate('browser', ['browser']), routineInFlight: 1, routineTarget: 1 };
    const result = routeBin({
      bin: renderLike(),
      candidates: [busy, candidate('plain', [])],
      fleetPolicy: null,
      fleetInFlight: 1,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.routine.id).toBe('plain');
  });

  it('still fails closed on a capability the bin itself requires', () => {
    const result = routeBin({
      bin: renderLike({ requiredCapabilities: ['browser'] }),
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

async function setup(browserSurface: boolean, requiredCapabilities: string[] = []) {
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
    ...(requiredCapabilities.length > 0 ? { requiredCapabilities } : {}),
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

describe('the assigner does not strand render work on the surfaces that declared a browser first', () => {
  it('admits a browserless session to a render while another Routine declares a browser', async () => {
    const { bin, admit } = await setup(true);
    const verdict = await admit(bin);
    // Unconditional: a refusal of any kind fails this test.
    expect(verdict.reason ?? null).toBeNull();
    expect(verdict.ok).toBe(true);
    expect(verdict.quiet).toBeUndefined();
  });

  it('admits the same session when no surface declares a browser', async () => {
    const { bin, admit } = await setup(false);
    const verdict = await admit(bin);
    expect(verdict.reason ?? null).toBeNull();
    expect(verdict.ok).toBe(true);
    expect(verdict.quiet).toBeUndefined();
  });

  it('still skips a session quietly when the bin itself requires a capability its Routine lacks', async () => {
    const { bin, admit } = await setup(true, ['browser']);
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

  it('keeps the evidence bar: an unanswered render is still refused', async () => {
    const { bin } = await setup(true);
    const verdict = await evaluateContract(bin);
    expect(verdict.disposition).toBe('RETRY');
    expect(verdict.reasons.join(' ')).toContain('No render was submitted');
  });
});

describe('the manifest authorizes the command it gives', () => {
  /*
   * The recorded failure class: a render bin whose worker, keeping to the
   * manifest's authority as every worker is told to, cannot run the one command
   * the manifest gives it, and so submits nothing. Six of six in production.
   */
  const surfaces = SEED_SURFACES.map((seed, index) => ({
    ...seed,
    id: `srf_${index}`,
    registeredBy: 'test',
    retiredAt: null,
    retiredReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  })) as unknown as DesignSurface[];
  const built = () =>
    designRenderManifest({ cycle: { id: 'dcy_test' } as DesignCycle, pass: 0, projectId: 'prj_test', surfaces });

  it('gives the exact command, and the dependency install it needs in a fresh checkout', () => {
    const render = built();
    const input = render.units[0]?.input ?? '';
    expect(render.units.map((unit) => unit.key)).toEqual(['design_render']);
    expect(input).toContain(renderCommand({ pass: 0, surfaces }));
    expect(input).toContain('npm ci');
  });

  it('authorizes every step of the command’s own footprint', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      dependencies: Record<string, string>;
    };
    // The command runs through a tool that only an install provides, so the
    // install is part of the work, not a side effect of it.
    const runner = (pkg.scripts['design'] ?? '').split(' ')[0] ?? '';
    expect(runner).toBe('tsx');
    expect({ ...pkg.dependencies, ...pkg.devDependencies }[runner]).toBeDefined();

    const authorized = built().authorizedActions.join('\n').toLowerCase();
    expect(authorized).toContain('npm ci');
    expect(authorized).toMatch(/building the client/);
    expect(authorized).toMatch(/starting this product locally/);
    expect(authorized).toMatch(/driving a browser/);
    expect(authorized).toMatch(/temporary directory/);
    expect(authorized).toMatch(/submitting one unit result/);
  });

  it('prohibits nothing the command must do, and keeps every prohibition a render needs', () => {
    const prohibited = built().prohibitedActions;
    // The prohibition that made the command unrunnable: a build writes files.
    expect(prohibited).not.toContain('changing any file in the repository');
    expect(prohibited).toContain('changing any file git tracks in the repository');
    expect(prohibited).toContain('pushing anything anywhere');
    expect(prohibited).toContain('installing a paid service or a new credential');
    expect(prohibited).toContain('editing the printed submission by hand');
  });

  it('builds only into output git ignores, so the tracked-file prohibition holds while it runs', () => {
    const ignored = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n');
    expect(ignored).toContain('client/dist/');
    expect(ignored).toContain('node_modules');
  });
});

/*
 * Review finding: every test above that shows a change starts from a fleet
 * that declares a browser, or from the manifest on its own. Here the test
 * starts from the recorded state instead, and drives it through the real
 * check-in, submission, completion and reconcile paths. The state: a render
 * bin with three attempts, no Routine declaring a browser, and a session Brain
 * fired from a plain Routine.
 *
 * The worker does what every worker is told to do: it runs only work its
 * manifest's authorized actions cover, and where a prohibition conflicts with
 * the work, the prohibition wins and it submits nothing. Its footprint is the
 * command's own, stated here independently of either manifest. Against the
 * manifest production issued before a72a4b3, the bin ends exactly as the six
 * did. Against the manifest Brain issues now, the same worker on the same
 * fleet completes it.
 */
describe('from the recorded state: a render bin, no declared browser, a worker that keeps to its authority', () => {
  /** What running `npm ci` + the render command does, step by step; independent of any manifest. */
  const FOOTPRINT: { step: string; authorizedBy: RegExp; writesRepositoryFiles: boolean }[] = [
    { step: 'install the dependencies from the lockfile', authorizedBy: /npm ci/i, writesRepositoryFiles: true },
    { step: 'build the client', authorizedBy: /building the client/i, writesRepositoryFiles: true },
    { step: 'start a throwaway Brain', authorizedBy: /starting this product locally/i, writesRepositoryFiles: false },
    { step: 'drive a browser against it', authorizedBy: /driving a browser/i, writesRepositoryFiles: false },
    { step: 'write the captures', authorizedBy: /temporary directory/i, writesRepositoryFiles: false },
    { step: 'submit the printed object', authorizedBy: /submitting one unit result/i, writesRepositoryFiles: false },
  ];

  /** The steps a worker keeping to `manifest` may not take, with why. Empty means it may run the command. */
  function refusedSteps(manifest: BinManifest): string[] {
    const authorized = manifest.authorizedActions.join('\n');
    const forbidsAnyRepositoryWrite = manifest.prohibitedActions.includes('changing any file in the repository');
    return FOOTPRINT.flatMap((one) => {
      if (!one.authorizedBy.test(authorized)) return [`${one.step}: not authorized`];
      if (one.writesRepositoryFiles && forbidsAnyRepositoryWrite) return [`${one.step}: prohibited`];
      return [];
    });
  }

  const surfaces = SEED_SURFACES.slice(0, 1).map((seed) => ({
    ...seed, id: 'srf_home', registeredBy: 'test', retiredAt: null, retiredReason: null, createdAt: NOW, updatedAt: NOW,
  })) as unknown as DesignSurface[];

  /** The manifest Brain issued before a72a4b3: the same work, with the authority it had in production. */
  const issuedBefore = (current: BinManifest): BinManifest => ({
    ...current,
    authorizedActions: ['starting this product locally', 'driving a browser against it', 'submitting one unit result'],
    prohibitedActions: [
      'changing any file in the repository',
      'pushing anything anywhere',
      'installing a paid service or a new credential',
      'editing the printed submission by hand',
    ],
  });

  /** Brain's recorded state, then the worker's attempts through the real paths, then the reconcile. */
  async function drive(which: 'before' | 'now') {
    const { checkIn, submitUnit, requestCompletion, release, reconcileBins } = await import('../server/services/bins/service.ts');
    const { getBin } = await import('../server/repos/bins.ts');
    const current = designRenderManifest({ cycle: { id: `dcy_${tag()}` } as DesignCycle, pass: 0, projectId, surfaces });
    const account = await createAccount({ name: `recorded-${tag()}` });
    // The recorded fleet: one enabled Routine, declaring nothing.
    const plain = await createRoutine({
      accountId: account.id, routineRef: `trig_plain_${tag()}`, name: `plain-${tag()}`, tokenSecretName: 'S_PLAIN',
    });
    expect(plain.capabilities).toEqual([]);
    const bin = await createBin({
      projectId,
      kind: 'DESIGN_RENDER',
      title: 'Design render: home',
      objective: 'Render the home surface.',
      manifest: which === 'before' ? issuedBefore(current) : current,
      completionContract: 'DESIGN_RENDER_V1',
      createdByType: 'SYSTEM',
      createdById: `design:render:recorded:${tag()}`,
      ready: true,
      maxAttempts: 3,
      workloadClass: 'GENERAL_DESIGN_RENDER',
    });
    const worker = await createWorker({ name: `render-worker-${tag()}`, createdByType: 'SYSTEM', createdById: 't' });
    const principal = {
      type: 'WORKER', id: worker.id, handle: `worker-${worker.id}`, displayName: 'Render worker',
      isBrainAdmin: false, mustChangePassword: false, credentialId: `cred-${worker.id}`, authMethod: 'WORKER_BEARER',
      memberships: [{ projectId, role: null, scopes: SCOPES, active: true }], requestId: 'test-request',
    } as unknown as Principal;

    const refusals: string[][] = [];
    let completed: string | null = null;
    for (let attempt = 1; attempt <= 3 && !completed; attempt += 1) {
      // Each attempt is a session Brain fired from the plain Routine, for the bin's current generation.
      const session = `cse_${tag()}${tag()}${tag()}`;
      const at = new Date().toISOString();
      const generation = (await getBin(bin.id))!.leaseGeneration;
      await getDb().run(
        `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count, max_attempts,
           next_attempt_at, routine_id, routine_ref, session_ref, created_at, updated_at, sent_at)
         VALUES (?, ?, ?, 'SENT', 1, 5, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('bdi'), bin.id, generation, at, plain.id, plain.routineRef, session, at, at, at],
      );
      const arrival = await checkIn({ principal, workerId: worker.id, sessionRef: session });
      // No surface declares a browser, so the plain session is admitted (fail open), as in production.
      expect(arrival.assigned).toBe(true);
      if (!arrival.assigned) return null;
      expect(arrival.assignment.binId).toBe(bin.id);
      const proof = {
        binId: arrival.assignment.binId, leaseId: arrival.assignment.leaseId,
        leaseGeneration: arrival.assignment.leaseGeneration, workerId: worker.id,
      };
      const refused = refusedSteps(arrival.assignment.manifest);
      refusals.push(refused);
      if (refused.length > 0) {
        // Keeping to its authority: nothing is run and nothing is submitted.
        expect(await release(proof, `cannot run the command within the manifest: ${refused.join('; ')}`)).toBe('OK');
        continue;
      }
      // Ran the command; submits the object it printed, verbatim.
      const printed = JSON.stringify({
        revision: 'abc1234', treeDirty: false,
        captures: [{ surfaceKey: 'home', width: 1280, sha256: 'f'.repeat(64), engine: 'chromium', engineVersion: '131' }],
      });
      expect((await submitUnit({ workerId: worker.id, proof, unitKey: 'design_render', value: printed })).held).toBe(true);
      const outcome = await requestCompletion({ workerId: worker.id, proof });
      completed = outcome.state;
    }
    await reconcileBins(projectId);
    return { bin: (await getBin(bin.id))!, refusals, completed, plain };
  }

  it('reproduces the recorded failure: the manifest issued before ends NEEDS_HUMAN with "No render was submitted"', async () => {
    const result = (await drive('before'))!;
    expect(result.completed).toBeNull();
    expect(result.refusals).toHaveLength(3);
    for (const refused of result.refusals) {
      expect(refused).toContain('install the dependencies from the lockfile: not authorized');
      expect(refused).toContain('build the client: not authorized');
    }
    expect(result.bin.state).toBe('NEEDS_HUMAN');
    expect(result.bin.terminalReason).toMatch(/used all 3 attempts without satisfying DESIGN_RENDER_V1/);
    expect(result.bin.terminalReason).toContain('No render was submitted');
  });

  it('changes the outcome: the same worker on the same browserless fleet completes the manifest Brain issues now', async () => {
    const result = (await drive('now'))!;
    expect(result.refusals).toEqual([[]]);
    expect(result.completed).toBe('COMPLETE');
    expect(result.bin.state).toBe('COMPLETE');
  });

  it('a satisfied render declares nothing on its Routine, so the next render is not withheld from the rest of the fleet', async () => {
    const result = (await drive('now'))!;
    expect(result.completed).toBe('COMPLETE');
    // No automatic capability write: the Routine that rendered is unchanged.
    expect((await getRoutine(result.plain.id))!.capabilities).toEqual([]);
    // And a different browserless Routine's session is still admitted to the next render.
    const { bin, admit } = await setup(false);
    const verdict = await admit(bin);
    expect(verdict.reason ?? null).toBeNull();
    expect(verdict.ok).toBe(true);
  });
});
