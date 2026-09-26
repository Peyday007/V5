/**
 * A declared `repository-write` is intent; a delivery probe is capability.
 *
 * Production, 2026-09-26: a surface whose Brain chain was closed — it had
 * fired, authenticated, been handed a bin and completed it — was handed real
 * implementation work, and its session could not push, because the Claude
 * Routine behind it was attached to another repository. These tests pin the
 * rule that replaced the declaration: real work is the evidence. A Routine
 * with no reading is provisional and takes one real push at a time; a real
 * push the forge confirmed proves it; a real refusal takes it out of push
 * routing until a person says the repository was attached. The probe is the
 * fallback for a surface with no real work.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createWorker, grantMembership, setWorkerRouting } from '../server/repos/identity.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createBin, getBin } from '../server/repos/bins.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';
import { routeBin } from '../server/services/dispatch/router.ts';
import {
  createDeliveryProbe,
  evaluateDeliveryProbe,
  parseDeliveryProbeReport,
  settleDeliveryProofs,
} from '../server/services/dispatch/deliveryProof.ts';
import {
  clearDeliveryRefusal,
  deliveryProvenRepositories,
  deliveryReadings,
  getDeliveryProofByBin,
} from '../server/repos/deliveryProofs.ts';
import { isRepositoryAccessRefusal, recordDeliveryEvidence } from '../server/services/dispatch/deliveryEvidence.ts';
import { readCommission } from '../server/services/fleet/commission.ts';
import { getDb } from '../server/db/database.ts';
import type { Bin, FleetRoutine } from '../server/domain/types.ts';

const REMOTE = 'https://github.com/Peyday007/V5';
const REPOSITORY = 'peyday007/v5';
const SECRET = 'DELIVERY_PROOF_TEST_TOKEN';
const HEAD = 'a'.repeat(40);

let fixture: TestProject;
let routine: FleetRoutine;
let realFetch: typeof globalThis.fetch;
/** What the stub forge says about the probe pull request. */
let forge: { prState: string; merged: boolean; headRef: string; files: string[]; branchExists: boolean };

beforeEach(async () => {
  fixture = await freshProject();
  realFetch = globalThis.fetch;
  process.env['BRAIN_FORGE_API_BASE'] = 'https://forge.test';
  process.env[SECRET] = 'test-bearer';
  forge = { prState: 'closed', merged: false, headRef: '', files: [], branchExists: false };
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (/\/pulls\/\d+$/.test(url)) {
      return json({
        number: 77,
        state: forge.prState,
        merged: forge.merged,
        html_url: 'https://github.com/Peyday007/V5/pull/77',
        title: 'probe',
        updated_at: new Date().toISOString(),
        head: { sha: HEAD, ref: forge.headRef },
        base: { ref: 'production' },
      });
    }
    if (url.includes('/compare/')) {
      return json({ ahead_by: 1, status: 'ahead', files: forge.files.map((filename) => ({ filename })) });
    }
    if (/\/git\/ref\/heads\//.test(url)) {
      return forge.branchExists ? json({ object: { sha: HEAD } }) : json({ message: 'Not Found' }, 404);
    }
    return json({ message: 'Not Found' }, 404);
  }) as typeof globalThis.fetch;

  const worker = await createWorker({ name: 'factory-brain', createdByType: 'SYSTEM', createdById: 't' });
  await grantMembership({
    projectId: fixture.project.id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:claim'],
    grantedByType: 'SYSTEM',
    grantedById: 't',
  });
  await setWorkerRouting({
    workerId: worker.id,
    families: ['FACTORY'],
    repositories: [REPOSITORY],
    capabilities: [],
    reason: 'test',
    setBy: 't',
  });
  const account = await createAccount({ name: 'Airyn' });
  routine = await createRoutine({
    accountId: account.id,
    routineRef: 'trig_surface2',
    name: 'Factory surface 2',
    tokenSecretName: SECRET,
    capabilities: ['repository', 'repository-write'],
    workerId: worker.id,
  });
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env['BRAIN_FORGE_API_BASE'];
  delete process.env[SECRET];
  await teardown();
});

async function writeBin(requiredCapabilities: string[]): Promise<Bin> {
  return createBin({
    projectId: fixture.project.id,
    kind: 'FACTORY_UNITS',
    title: 'Implement one unit',
    objective: 'x',
    rationale: 'x',
    manifest: {
      objective: 'x',
      why: 'x',
      lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
      units: [],
      repository: { remote: REMOTE, ref: 'production', baseSha: '', integrationBranch: '', pullRequest: null },
      acceptableSources: [],
      excludedSources: [],
      evidence: [],
      outputs: [],
      authorizedActions: [],
      prohibitedActions: [],
      budgetUnits: null,
      retry: { maxAttempts: 2, backoffSeconds: 60 },
      stoppingConditions: [],
    },
    completionContract: 'FACTORY_UNITS_V1',
    workloadClass: 'FACTORY_UNITS',
    requiredCapabilities,
    createdByType: 'SYSTEM',
    createdById: 't',
    ready: true,
    maxAttempts: 2,
  });
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

/** Answer the probe bin as a worker would, then mark it complete. */
async function answer(binId: string, value: unknown): Promise<void> {
  await getDb().run(
    `INSERT INTO bin_unit_results (id, bin_id, unit_key, value, content_hash, created_at)
     VALUES (?, ?, 'deliver', ?, 'h', ?)`,
    [`bur_${binId}`, binId, JSON.stringify(value), new Date().toISOString()],
  );
  await getDb().run("UPDATE bins SET state = 'COMPLETE' WHERE id = ?", [binId]);
}

/** The row Brain writes when it fires a Routine and the provider names the session. */
async function dispatched(binId: string, routineRef: string, sessionRef: string): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count,
       next_attempt_at, routine_ref, session_ref, created_at, updated_at)
     VALUES (?, ?, 0, 'SENT', 1, ?, ?, ?, ?, ?)`,
    [`bdp_${binId}`, binId, now, routineRef, sessionRef, now, now] as never[],
  );
}

async function probe() {
  return createDeliveryProbe({
    routine: {
      id: routine.id,
      name: routine.name,
      routineRef: routine.routineRef,
      capabilities: routine.capabilities,
      workerId: routine.workerId,
    },
    repository: REMOTE,
    baseBranch: 'production',
    requestedBy: 'test',
  });
}

describe('a declared repository-write is not a capability until a delivery probe passes', () => {
  it('routes one real implementation to a surface with no reading — provisional, not refused', async () => {
    const bin = await writeBin(['repository', 'repository-write']);
    expect((await route(bin)).ok).toBe(true);

    // One real push at a time: a provisional surface with work in flight waits.
    const snapshot = await fleetSnapshot();
    const busy = routeBin({
      bin,
      candidates: snapshot.candidates.map((c) => ({ ...c, routineInFlight: 1 })),
      fleetPolicy: snapshot.fleetPolicy,
      fleetInFlight: 1,
      now: new Date().toISOString(),
    });
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.considered[0]?.verdict).toMatch(/provisional/);

    // This fixture's surface has never run, so an earlier step blocks; the
    // delivery step itself reads provisional rather than failed.
    const reading = await readCommission({ routineRef: routine.routineRef, repository: REMOTE });
    const delivery = reading.steps.find((step) => step.key === 'delivery')!;
    expect(delivery.state).toBe('PENDING');
    expect(delivery.detail).toMatch(/provisional/);
  });

  it('takes a surface out the moment its real session is refused a push, and puts it back on a person\'s word', async () => {
    const refusal =
      "remote: Peyday007/V5 is not in this session's authorized repository set. " +
      'fatal: unable to access https://github.com/Peyday007/V5/: The requested URL returned error: 403';
    expect(isRepositoryAccessRefusal(refusal)).toBe(true);
    expect(isRepositoryAccessRefusal('npm test exited 1')).toBe(false);

    const work = await writeBin(['repository', 'repository-write']);
    await dispatched(work.id, routine.routineRef, 'cse_AIRYN0SESSION01');
    const credited = await recordDeliveryEvidence({
      sessionRef: 'session_AIRYN0SESSION01',
      repository: REMOTE,
      evidenceKey: work.id,
      state: 'FAILED',
      detail: refusal,
    });
    expect(credited).toBe(routine.id);

    const refused = await route(await writeBin(['repository', 'repository-write']));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal).toBe('NO_CAPABLE_SURFACE');
      expect(refused.considered[0]?.verdict).toMatch(/refused a push to peyday007\/v5/);
    }
    // Planning and review still go to it.
    expect((await route(await writeBin(['repository']))).ok).toBe(true);

    expect(await clearDeliveryRefusal({ routineId: routine.id, repository: REMOTE, reason: 'attached', requestedBy: 't' })).toBe(true);
    expect(await clearDeliveryRefusal({ routineId: routine.id, repository: REMOTE, reason: 'again', requestedBy: 't' })).toBe(false);
    expect((await route(await writeBin(['repository', 'repository-write']))).ok).toBe(true);
  });

  it('credits real delivery only to the one Routine Brain fired that session at', async () => {
    const other = await createRoutine({
      accountId: routine.accountId,
      routineRef: 'trig_other',
      name: 'Other',
      tokenSecretName: SECRET,
      capabilities: ['repository', 'repository-write'],
      workerId: routine.workerId,
    });
    const a = await writeBin(['repository']);
    const b = await writeBin(['repository']);
    await dispatched(a.id, routine.routineRef, 'cse_SHAREDSESSION1');
    await dispatched(b.id, other.routineRef, 'cse_SHAREDSESSION1');
    // Ambiguous: two Routines fired that provider session. Nobody is credited.
    expect(
      await recordDeliveryEvidence({ sessionRef: 'cse_SHAREDSESSION1', repository: REMOTE, evidenceKey: 'x', state: 'PROVEN' }),
    ).toBeNull();
    // Unknown session: nobody is credited either.
    expect(
      await recordDeliveryEvidence({ sessionRef: 'cse_NEVERFIRED0000', repository: REMOTE, evidenceKey: 'y', state: 'PROVEN' }),
    ).toBeNull();
    expect((await deliveryReadings()).size).toBe(0);

    const c = await writeBin(['repository']);
    await dispatched(c.id, routine.routineRef, 'cse_ONLYONE0000001');
    expect(
      await recordDeliveryEvidence({ sessionRef: 'cse_ONLYONE0000001', repository: REMOTE, evidenceKey: c.id, state: 'PROVEN' }),
    ).toBe(routine.id);
    // Idempotent by the evidence key.
    await recordDeliveryEvidence({ sessionRef: 'cse_ONLYONE0000001', repository: REMOTE, evidenceKey: c.id, state: 'PROVEN' });
    expect((await deliveryReadings()).get(routine.id)?.get(REPOSITORY)).toBe('PROVEN');
    const reading = await readCommission({ routineRef: routine.routineRef, repository: REMOTE });
    const delivery = reading.steps.find((s) => s.key === 'delivery')!;
    expect(delivery.state).toBe('PASS');
    expect(delivery.detail).toMatch(/real Factory work/);
  });

  it('still routes read-only Factory work (planning, review) to the same surface', async () => {
    const decision = await route(await writeBin(['repository']));
    expect(decision.ok).toBe(true);
  });

  it('routes the probe itself, pinned, to the surface it is proving', async () => {
    const { binId, proof } = await probe();
    expect(proof.state).toBe('PENDING');
    const bin = (await getBin(binId))!;
    expect(bin.state).toBe('READY');
    expect(bin.pinnedRoutineId).toBe(routine.id);
    const decision = await route(bin);
    expect(decision.ok).toBe(true);
  });

  it('records PROVEN only when the forge shows the PR at the commit, one file, closed unmerged, branch gone', async () => {
    const { binId, proof } = await probe();
    forge.headRef = proof.branch;
    forge.files = [proof.probePath];
    await answer(binId, { outcome: 'DELIVERED', branch: proof.branch, headSha: HEAD, pullRequest: 77 });

    expect((await evaluateDeliveryProbe((await getBin(binId))!)).satisfied).toBe(true);
    await settleDeliveryProofs();
    const settled = (await getDeliveryProofByBin(binId))!;
    expect(settled.state).toBe('PROVEN');
    expect(settled.pullRequest).toBe(77);
    expect((await deliveryProvenRepositories()).get(routine.id)?.has(REPOSITORY)).toBe(true);

    const decision = await route(await writeBin(['repository', 'repository-write']));
    expect(decision.ok).toBe(true);

    const reading = await readCommission({ routineRef: routine.routineRef, repository: REMOTE });
    const delivery = reading.steps.find((s) => s.key === 'delivery')!;
    expect(delivery.state).toBe('PASS');
  });

  it('a newer failed probe withdraws an older proof, and names the missing step', async () => {
    const first = await probe();
    forge.headRef = first.proof.branch;
    forge.files = [first.proof.probePath];
    await answer(first.binId, { outcome: 'DELIVERED', branch: first.proof.branch, headSha: HEAD, pullRequest: 77 });
    await settleDeliveryProofs();
    expect((await deliveryProvenRepositories()).get(routine.id)?.has(REPOSITORY)).toBe(true);

    const second = await probe();
    await answer(second.binId, {
      outcome: 'BLOCKED',
      step: 'REPOSITORY_NOT_IN_SESSION',
      detail: "Peyday007/V5 is not in this session's authorized repository set",
    });
    expect((await evaluateDeliveryProbe((await getBin(second.binId))!)).satisfied).toBe(true);
    await settleDeliveryProofs();
    expect((await getDeliveryProofByBin(second.binId))!.failureStep).toBe('REPOSITORY_NOT_IN_SESSION');
    expect((await deliveryProvenRepositories()).get(routine.id)?.has(REPOSITORY) ?? false).toBe(false);

    const decision = await route(await writeBin(['repository', 'repository-write']));
    expect(decision.ok).toBe(false);

    const reading = await readCommission({ routineRef: routine.routineRef, repository: REMOTE });
    expect(reading.ready).toBe(false);
    const delivery = reading.steps.find((s) => s.key === 'delivery')!;
    expect(delivery.state).toBe('FAIL');
    expect(delivery.remedy).toMatch(/set Repository to this repository/);
  });

  it('does not accept a probe left open, left behind, or merged', async () => {
    const { binId, proof } = await probe();
    forge.headRef = proof.branch;
    forge.files = [proof.probePath];
    await answer(binId, { outcome: 'DELIVERED', branch: proof.branch, headSha: HEAD, pullRequest: 77 });

    forge.prState = 'open';
    let verdict = await evaluateDeliveryProbe((await getBin(binId))!);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.disposition).toBe('RETRY');

    forge.prState = 'closed';
    forge.branchExists = true;
    verdict = await evaluateDeliveryProbe((await getBin(binId))!);
    expect(verdict.satisfied).toBe(false);

    forge.branchExists = false;
    forge.files = [proof.probePath, 'server/index.ts'];
    verdict = await evaluateDeliveryProbe((await getBin(binId))!);
    expect(verdict.satisfied).toBe(false);

    forge.files = [proof.probePath];
    forge.merged = true;
    verdict = await evaluateDeliveryProbe((await getBin(binId))!);
    expect(verdict.disposition).toBe('HUMAN');
    await settleDeliveryProofs();
    expect((await getDeliveryProofByBin(binId))!.failureStep).toBe('PULL_REQUEST_MERGED');
  });

  it('reads a worker report strictly', () => {
    expect(parseDeliveryProbeReport('{"outcome":"DELIVERED","branch":"b","headSha":"x","pullRequest":1}').ok).toBe(false);
    expect(parseDeliveryProbeReport('{"outcome":"BLOCKED","step":"SOMETHING_ELSE"}').ok).toBe(false);
    expect(parseDeliveryProbeReport('{"outcome":"BLOCKED","step":"CLONE_REFUSED","extra":1}').ok).toBe(false);
    expect(parseDeliveryProbeReport('{"outcome":"BLOCKED","step":"CLONE_REFUSED"}').ok).toBe(true);
  });

  it('commissioning names the first missing step before any probe exists', async () => {
    const reading = await readCommission({ routineRef: routine.routineRef, repository: REMOTE });
    expect(reading.ready).toBe(false);
    expect(reading.verdict).toMatch(/^NOT READY — /);
    expect(reading.mayProbe).toBe(true);
    const missing = await readCommission({ routineRef: 'trig_nobody', repository: REMOTE });
    expect(missing.verdict).toMatch(/Routine registered/);
  });
});
