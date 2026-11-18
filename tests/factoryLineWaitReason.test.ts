/**
 * A READY factory stage whose dispatch Brain deferred is a wait with a reason,
 * not executable work beside idle capacity.
 *
 * The defect this exists for was recorded in production on 2026-11-18: the
 * FACTORY pool read `waiting=1, running=0, capacity=1, idle=true` with "1
 * piece(s) of executable work and 1 free surface(s), and nothing is running or
 * arriving. That is a fault, not a wait." — while the bin's dispatch intent sat
 * `PENDING` on a recorded deferral the dispatcher would answer by itself. The
 * operator read that sentence as a RECURRING_OPERATIONAL_FAILURE and commissioned
 * a repair for a wait Brain had already explained. These tests pin both sides:
 * a live deferral reads as a named wait, and a READY bin with no deferral, or one
 * whose deferral has lapsed, still raises the fault.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { ensureCampaign, ensureChangeRequest, patchCampaign } from '../server/repos/factory.ts';
import { createWorker, grantMembership, setWorkerRouting } from '../server/repos/identity.ts';
import { bindRoutineWorker, createAccount, createRoutine, credentialDigest, setPolicy } from '../server/repos/fleet.ts';
import { createBin, ensureDispatchIntent, getBin, markDispatchDeferred, markDispatchFailed } from '../server/repos/bins.ts';
import { DISPATCH_DEFERRAL_KINDS, readLine, resetIdleObservation } from '../server/services/factory/line.ts';
import { getDb } from '../server/db/database.ts';
import { DISPATCH_BURST, DISPATCH_CLAIM_LIMIT, dispatchTick, endsBurst } from '../server/services/dispatch/loop.ts';
import { recordDeliveryProven } from './helpers/deliveryProven.ts';

const REPOSITORY = 'peyday007/v5';
const SECRET = 'LINE_WAIT_REASON_TOKEN';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
  resetIdleObservation();

  // One working Factory surface: a routed worker in the project, its account and
  // Routine, the delivery proof a repository-writing surface needs.
  const worker = await createWorker({ name: 'factory-line-wait', createdByType: 'SYSTEM', createdById: 'test' });
  await grantMembership({
    projectId: fixture.project.id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:claim', 'queue:complete'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  await setWorkerRouting({
    workerId: worker.id,
    families: ['FACTORY'],
    repositories: [REPOSITORY],
    capabilities: ['repository', 'repository-write'],
    reason: 'the factory identity',
    setBy: 'test',
  });
  const account = await createAccount({ provider: 'anthropic', name: 'claude-line-wait' });
  process.env[SECRET] = 'token-line-wait';
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: 'trig_line_wait',
    name: 'Factory line wait',
    tokenSecretName: SECRET,
    tokenDigest: credentialDigest('token-line-wait'),
    capabilities: ['repository', 'repository-write'],
  });
  await bindRoutineWorker(routine.id, worker.id);
  await recordDeliveryProven(routine.id, REPOSITORY);
});

afterEach(async () => {
  delete process.env[SECRET];
  await teardown();
});

/** A working campaign with one READY stage bin. */
async function readyStage(label: string): Promise<string> {
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `wait-${label}-${Math.random().toString(36).slice(2)}`,
    objective: `Objective ${label}`,
    expectedOutcome: `Outcome ${label}`,
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: `${label} holds`, verification: 'npm test', mandatory: true }],
    repository: 'not-a-forge-remote',
    baseBranch: 'production',
    baseSha: 'a'.repeat(40),
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: [`server/wait-${label}/**`],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'discard the branch',
    verificationCommands: [],
  });
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: changeRequest.baseSha,
    laneTarget: 1,
    laneTargetReason: 'initial',
    executionMode: 'REMOTE',
  });
  await patchCampaign(campaign.id, { state: 'EXECUTING' });
  const bin = await createBin({
    projectId: fixture.project.id,
    kind: 'FACTORY_UNITS',
    title: 'units',
    objective: 'Do the stage.',
    manifest: {
      objective: 'Do the stage.',
      why: 'wait-reason test',
      lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'u1', establishes: 'a result', input: '{}', transform: 'FACTORY_UNITS', dependsOn: [] }],
      acceptableSources: [],
      excludedSources: [],
      evidence: ['a result'],
      outputs: ['one result'],
      authorizedActions: ['do the stage'],
      prohibitedActions: ['anything else'],
      budgetUnits: null,
      retry: { maxAttempts: 2, backoffSeconds: 60 },
      stoppingConditions: ['a result per unit'],
    },
    completionContract: 'FACTORY_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    factoryCampaignId: campaign.id,
  });
  return bin.id;
}

/** Put the bin's dispatch intent on a recorded deferral, as the dispatch loop does. */
async function defer(binId: string, refusal: string, retryAfterMs: number): Promise<void> {
  const bin = (await getBin(binId))!;
  await ensureDispatchIntent(bin);
  const intent = await getDb().get<{ id: string }>(`SELECT id FROM bin_dispatch WHERE bin_id = ?`, [binId]);
  await markDispatchDeferred(intent!.id, { refusal, message: `deferred: ${refusal}`, retryAfterMs });
}

/** An instant off the live poll, so the reading takes its own fleet snapshot. */
const reading = () => readLine(new Date(Date.now() + 5_000));

describe('a deferred READY stage is a wait, not idle work', () => {
  it('reads a live deferral beside a free surface as a named wait, not the fault', async () => {
    const binId = await readyStage('deferred');
    await defer(binId, 'NO_CLAIMABLE_WORK', 10 * 60_000);
    const line = await reading();
    expect(line.capacity.freeSurfaces).toBe(1);
    expect(line.executable.readyBins).toBe(0);
    expect(line.unexplainedIdle).toBe(false);
    expect(line.because).toMatch(/waiting out a recorded dispatch deferral \(NO_CLAIMABLE_WORK\)/);
    expect(line.because).toMatch(/lapses at \d{4}-\d{2}-\d{2}T/);
    expect(line.because).not.toMatch(/fault, not a wait/);
  });

  it('names an operator-resolved routing refusal the same way', async () => {
    const binId = await readyStage('scope');
    await defer(binId, 'NO_CAPABLE_SURFACE', 60 * 60_000);
    const line = await reading();
    expect(line.unexplainedIdle).toBe(false);
    expect(line.because).toMatch(/NO_CAPABLE_SURFACE/);
  });

  it('still raises the fault for a READY stage with no dispatch intent beside a free surface', async () => {
    await readyStage('undispatched');
    const line = await reading();
    expect(line.capacity.freeSurfaces).toBe(1);
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
    expect(line.because).toMatch(/That is a fault, not a wait\./);
  });

  it('still raises the fault once the deferral has lapsed with nothing having moved', async () => {
    const binId = await readyStage('lapsed');
    await defer(binId, 'NO_CLAIMABLE_WORK', 0);
    await getDb().run(`UPDATE bin_dispatch SET next_attempt_at = ? WHERE bin_id = ?`, [
      new Date(Date.now() - 60_000).toISOString(),
      binId,
    ]);
    const line = await reading();
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
  });

  it('still raises the fault for a no-show reopen: an unanswered fire is not a deferral', async () => {
    const binId = await readyStage('no-show');
    await ensureDispatchIntent((await getBin(binId))!);
    // The shape the in-flight sweep leaves (bins.ts reopen): PENDING, NO_SHOW, a future retry.
    await getDb().run(
      `UPDATE bin_dispatch SET state = 'PENDING', next_attempt_at = ?, last_error_kind = 'NO_SHOW',
              last_error = 'Fired, and no worker ever claimed the bin before the in-flight window closed.'
        WHERE bin_id = ?`,
      [new Date(Date.now() + 30 * 60_000).toISOString(), binId],
    );
    const line = await reading();
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
    expect(line.because).toMatch(/That is a fault, not a wait\./);
    expect(line.because).not.toMatch(/NO_SHOW/);
  });

  it('still raises the fault for a fire the provider refused, on its backoff', async () => {
    const binId = await readyStage('fire-failed');
    await ensureDispatchIntent((await getBin(binId))!);
    const intent = await getDb().get<{ id: string }>(`SELECT id FROM bin_dispatch WHERE bin_id = ?`, [binId]);
    await markDispatchFailed(intent!.id, { kind: 'HTTP_503', message: 'provider unavailable', retryAfterMs: 30 * 60_000 });
    const line = await reading();
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
    expect(line.because).not.toMatch(/HTTP_503/);
  });

  it('names every refusal the dispatch loop defers with, and nothing else', () => {
    for (const kind of ['NO_CLAIMABLE_WORK', 'NO_ELIGIBLE_AUDIT_SESSION', 'BIN_REFIRE_GUARD', 'SLOT_LOST', 'NO_CAPABLE_SURFACE', 'ACCOUNT_SESSIONS_UNPRODUCTIVE']) {
      expect(DISPATCH_DEFERRAL_KINDS.has(kind)).toBe(true);
    }
    for (const kind of ['NO_SHOW', 'SUPERSEDED', 'HTTP_503', 'NOT_CONFIGURED']) expect(DISPATCH_DEFERRAL_KINDS.has(kind)).toBe(false);
  });

  it('keeps the fault when one stage is deferred and another is executable', async () => {
    const deferred = await readyStage('one-deferred');
    await defer(deferred, 'BIN_REFIRE_GUARD', 30 * 60_000);
    await readyStage('one-executable');
    const line = await reading();
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
  });
});

/*
 * A READY stage the dispatcher will never fire for earned no intent and so no
 * deferral, and the line counted it as executable work beside a free surface —
 * the recorded fault — while the dispatcher was correctly holding it by its own
 * predicate (`DISPATCHABLE_SQL AND FIREABLE_SQL AND workReadySql`). These are
 * that failure class: each failed before the line asked the dispatcher's own
 * question.
 */
describe('a READY stage the dispatcher holds by its own predicate is a wait, not idle work', () => {
  it('reads a stage under a fire backoff as a named wait with its end', async () => {
    const binId = await readyStage('backoff');
    const until = new Date(Date.now() + 20 * 60_000).toISOString();
    await getDb().run('UPDATE bins SET dispatch_not_before = ? WHERE id = ?', [until, binId]);
    const line = await reading();
    expect(line.capacity.freeSurfaces).toBe(1);
    expect(line.executable.readyBins).toBe(0);
    expect(line.unexplainedIdle).toBe(false);
    expect(line.because).toMatch(/FIRE_BACKOFF/);
    expect(line.because).toContain(until);
    expect(line.because).not.toMatch(/fault, not a wait/);
  });

  it('reads a stage out of attempts as held, not executable', async () => {
    const binId = await readyStage('exhausted');
    await getDb().run('UPDATE bins SET attempt_count = max_attempts WHERE id = ?', [binId]);
    const line = await reading();
    expect(line.executable.readyBins).toBe(0);
    expect(line.unexplainedIdle).toBe(false);
    expect(line.because).toMatch(/ATTEMPTS_EXHAUSTED/);
    expect(line.because).not.toMatch(/fault, not a wait/);
  });

  it('counts a stage again once its fire backoff has passed', async () => {
    const binId = await readyStage('backoff-passed');
    await getDb().run('UPDATE bins SET dispatch_not_before = ? WHERE id = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      binId,
    ]);
    const line = await reading();
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
    expect(line.because).toMatch(/That is a fault, not a wait\./);
  });

  it('keeps the fault when one stage is held and another is executable', async () => {
    const held = await readyStage('one-held');
    await getDb().run('UPDATE bins SET dispatch_not_before = ? WHERE id = ?', [
      new Date(Date.now() + 20 * 60_000).toISOString(),
      held,
    ]);
    await readyStage('one-free');
    const line = await reading();
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
  });

  it('asks the dispatcher’s fragments rather than restating them', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../server/repos/bins.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function dispatchReadiness');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('${DISPATCHABLE_SQL}');
    expect(body).toContain('${FIREABLE_SQL}');
    expect(body).toContain("${workReadySql('bins.')}");
    expect(body).toContain("${claimableStateSql('')}");
    expect(body).not.toMatch(/attempt_count\s*</);
    expect(body).not.toMatch(/dispatch_not_before\s*(<=|IS NULL)/);
  });
});

/*
 * The dispatcher's half of the same fault (5c1166f). `FLEET_TARGET_REACHED` is
 * classified fleet-wide, but `routeBin` exempts the Factory family from the
 * fleet target. When it ended the burst — and spent a burst slot on each such
 * deferral — any due research intent at or above a Factory stage's priority
 * stopped every tick before the Factory intent was claimed, and the line read
 * the READY stage beside its free surface as the fault. These drive the real
 * `dispatchTick` against the real router; only the provider's fire endpoint is
 * stubbed, and every fire it receives is counted.
 */
describe('the research ceiling does not stop a tick before Factory work', () => {
  let realFetch: typeof globalThis.fetch;
  let fired: string[];

  beforeEach(() => {
    fired = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes('/fire')) {
        fired.push(url);
        return new Response(JSON.stringify({ claude_code_session_id: `cse_ceiling_${fired.length}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** The fleet target the research family has already met: none may start. */
  async function researchCeilingReached(): Promise<void> {
    await setPolicy({ scope: 'FLEET', target: 0, actor: 'test', reason: 'research ceiling reached' });
  }

  /** A due research intent, at a priority at or above the Factory stage's. */
  async function dueResearchIntents(count: number, priority: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const bin = await createBin({
        projectId: fixture.project.id,
        kind: 'GENERAL',
        title: `research ${index}`,
        objective: 'Answer a question.',
        manifest: {
          objective: 'Answer a question.',
          why: 'research-ceiling test',
          lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
          units: [{ key: 'u1', establishes: 'an answer', input: '{}', transform: 'sha256', dependsOn: [] }],
          acceptableSources: [],
          excludedSources: [],
          evidence: ['an answer'],
          outputs: ['one answer'],
          authorizedActions: ['answer'],
          prohibitedActions: ['anything else'],
          budgetUnits: null,
          retry: { maxAttempts: 2, backoffSeconds: 60 },
          stoppingConditions: ['an answer'],
        },
        completionContract: 'DETERMINISTIC_UNITS_V1',
        createdByType: 'SYSTEM',
        createdById: 'test',
        ready: true,
        priority,
      });
      await ensureDispatchIntent((await getBin(bin.id))!);
      ids.push(bin.id);
    }
    return ids;
  }

  async function intentState(binId: string): Promise<{ state: string; last_error_kind: string | null } | undefined> {
    return getDb().get<{ state: string; last_error_kind: string | null }>(
      'SELECT state, last_error_kind FROM bin_dispatch WHERE bin_id = ? ORDER BY created_at DESC LIMIT 1',
      [binId],
    );
  }

  it('fires a Factory stage queued behind more due research intents than one burst, in one tick', async () => {
    await researchCeilingReached();
    const factoryBinId = await readyStage('behind-research');
    await getDb().run('UPDATE bins SET priority = 1 WHERE id = ?', [factoryBinId]);
    await ensureDispatchIntent((await getBin(factoryBinId))!);
    const research = await dueResearchIntents(DISPATCH_BURST + 3, 9);

    const result = await dispatchTick({ projectIds: [fixture.project.id] });

    // Every research intent met the ceiling and was deferred, not fired …
    for (const id of research) expect((await intentState(id))?.last_error_kind).toBe('FLEET_TARGET_REACHED');
    // … and the walk went past all of them to the Factory stage in this same tick.
    expect(fired).toHaveLength(1);
    expect(fired[0]).toContain('trig_line_wait');
    expect((await intentState(factoryBinId))?.state).not.toBe('PENDING');
    expect(result.deferred).toBeGreaterThanOrEqual(research.length);
  });

  it('stops at DISPATCH_CLAIM_LIMIT when every due intent is research at the ceiling', async () => {
    await researchCeilingReached();
    await dueResearchIntents(DISPATCH_CLAIM_LIMIT + 5, 5);

    await dispatchTick({ projectIds: [fixture.project.id] });

    expect(fired).toHaveLength(0);
    const deferred = await getDb().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bin_dispatch WHERE last_error_kind = 'FLEET_TARGET_REACHED'`,
    );
    // The walk is bounded: it claimed exactly the limit and left the rest due.
    expect(Number(deferred?.n)).toBe(DISPATCH_CLAIM_LIMIT);
    const stillDue = await getDb().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bin_dispatch WHERE state = 'PENDING' AND last_error_kind IS NULL`,
    );
    expect(Number(stillDue?.n)).toBe(5);
  });

  it('still ends the burst on a fleet-wide refusal that binds the Factory too', () => {
    const unpinned = { pinnedRoutineId: null };
    expect(endsBurst(unpinned, 'FLEET_TARGET_REACHED')).toBe(false);
    expect(endsBurst(unpinned, 'NO_ROUTINES_REGISTERED')).toBe(true);
    expect(endsBurst(unpinned, 'FLEET_PAUSED')).toBe(true);
    // A pinned bin's refusal is about its own surface, never the fleet's.
    expect(endsBurst({ pinnedRoutineId: 'rtn_pinned' }, 'FLEET_PAUSED')).toBe(false);
  });

  it('ends the tick at a paused fleet: neither research nor the Factory stage is fired', async () => {
    await setPolicy({ scope: 'FLEET', target: 5, paused: true, actor: 'test', reason: 'paused' });
    const factoryBinId = await readyStage('paused');
    await ensureDispatchIntent((await getBin(factoryBinId))!);
    await dueResearchIntents(3, 9);

    await dispatchTick({ projectIds: [fixture.project.id] });

    expect(fired).toHaveLength(0);
    // The first intent claimed met the pause and ended the burst: nothing else was walked.
    const refused = await getDb().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bin_dispatch WHERE last_error_kind = 'FLEET_PAUSED'`,
    );
    expect(Number(refused?.n)).toBe(1);
  });
});
