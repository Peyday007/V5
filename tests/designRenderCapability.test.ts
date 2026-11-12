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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { createBin } from '../server/repos/bins.ts';
import { createAccount, createRoutine, setRoutineCapabilities } from '../server/repos/fleet.ts';
import { createWorker } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import {
  contractCapabilities,
  effectiveCapabilities,
  evaluateContract,
} from '../server/services/bins/contracts.ts';
import { binAdmission } from '../server/services/bins/service.ts';
import { routeBin, type RoutingCandidate } from '../server/services/dispatch/router.ts';
import type { Bin, BinManifest, FleetAccount, FleetRoutine, Principal, WorkerScope } from '../server/domain/types.ts';

/*
 * Count the fleet's full-table reads without changing what they return: the
 * admission runs on the claim path, which §61/§63 keep cheap.
 */
const fleetReads = vi.hoisted(() => ({ routines: 0, accounts: 0 }));
vi.mock('../server/repos/fleet.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/repos/fleet.ts')>();
  return {
    ...actual,
    listRoutines: (...args: Parameters<typeof actual.listRoutines>) => {
      fleetReads.routines += 1;
      return actual.listRoutines(...args);
    },
    listAccounts: () => {
      fleetReads.accounts += 1;
      return actual.listAccounts();
    },
  };
});

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

  async function setup(browserSurface: boolean, fired = true) {
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
    if (fired) await getDb().run(
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

  it('reads no fleet table for a session Brain did not fire, which this check can never refuse', async () => {
    const { bin, admit } = await setup(true, false);
    fleetReads.routines = 0;
    fleetReads.accounts = 0;
    const verdict = await admit(bin);
    if (!verdict.ok) expect(verdict.reason).not.toContain('does not declare');
    expect(fleetReads).toEqual({ routines: 0, accounts: 0 });
  });

  it('reads the fleet once per admission however many render bins one check-in weighs', async () => {
    const { bin, admit } = await setup(true);
    fleetReads.routines = 0;
    fleetReads.accounts = 0;
    const verdicts = [await admit(bin), await admit(bin), await admit(bin)];
    for (const verdict of verdicts) {
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.quiet).toBe(true);
    }
    expect(fleetReads).toEqual({ routines: 1, accounts: 1 });
  });
});
