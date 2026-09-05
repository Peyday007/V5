/**
 * A full fleet is not a broken dispatch.
 *
 * The frozen Step 12A acceptance message was sent into production on
 * 2026-09-04 at 21:49:11.857Z. Its bin was ready 200ms later, an intent was
 * created a second after that, and then the dispatcher was refused five times
 * with `ACCOUNT_TARGETS_REACHED` — "every capable surface is at its configured
 * target" — and abandoned the intent at 21:53:53.653Z. Four minutes and
 * forty-one seconds, no activation attempted, and a person left looking at a
 * pending turn that nothing was ever going to answer again.
 *
 * The mechanism was that `claimDispatchIntent` increments `attempt_count` when
 * a tick *picks the intent up*, before routing and long before firing. So
 * asking the router and being told to wait cost an attempt, and five ticks of a
 * busy fleet spent the whole budget.
 *
 * These tests hold the distinction the fix rests on: a refusal that resolves by
 * itself defers and keeps its attempts, and a refusal that means no surface
 * exists still exhausts and abandons, because retrying into an empty room
 * forever would hide the problem from the person waiting.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createAccount, createRoutine, bindRoutineWorker, setPolicy } from '../server/repos/fleet.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import {
  createBin,
  getBin,
  listBinEvents,
  listDispatchesForBin,
} from '../server/repos/bins.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  await createUser({
    email: `defer-${Math.random().toString(36).slice(2, 8)}@example.test`,
    displayName: 'Test person',
    password: 'correct horse battery staple',
  });
});

function manifest(): BinManifest {
  return {
    objective: 'Prove a deferral keeps its attempts.',
    why: 'A full fleet is not a broken dispatch.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [
      { key: 'unit-1', establishes: 'one value', input: 'a value', transform: 'sha256', dependsOn: [] },
    ],
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

async function aReadyBin(): Promise<string> {
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: 'A bin nobody has room for',
    objective: 'Prove a deferral keeps its attempts',
    completionContract: 'DETERMINISTIC_UNITS_V1',
    manifest: manifest(),
    workloadClass: 'RUSSELL_TURN',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  return bin.id;
}

/** A registered, healthy, bound Routine — so routing has a surface to refuse from. */
async function aFleet(): Promise<void> {
  // The deployment secret has to be present, or the Routine is left out of
  // routing entirely and the dispatcher skips as unconfigured — which would
  // make these tests pass without ever claiming an intent.
  process.env['DEFER_SECRET'] = 'not-a-real-token';
  const account = await createAccount({ provider: 'anthropic', name: 'defer-account' });
  const worker = await createWorker({
    name: 'defer-worker',
    displayName: 'defer-worker',
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: 'trig_defer',
    name: 'V-defer',
    tokenSecretName: 'DEFER_SECRET',
  });
  await bindRoutineWorker(routine.id, worker.id);
}

describe('an intent the fleet had no room for', () => {
  it('is deferred rather than abandoned, however many ticks go by', async () => {
    const binId = await aReadyBin();
    await aFleet();
    // Paused: a condition that resolves the moment an operator un-pauses, and
    // one the router reports without needing a real in-flight activation.
    await setPolicy({ scope: 'FLEET', target: 2, paused: true, actor: 'test', reason: 'no room' });

    // Far more ticks than the intent has attempts. Under the old behaviour the
    // sixth of these found an ABANDONED intent.
    for (let round = 0; round < 8; round += 1) {
      const result = await dispatchTick({ burst: 1, projectIds: [projectId] });
      expect(result.skippedNotConfigured).toBe(false);
      if (round === 0) {
        expect(result.intentsCreated).toBe(1);
        // Claimed, routed, refused and put back — inside the first tick.
        expect(result.deferred).toBe(1);
      }
      // The intent is deferred with a backoff, so later ticks legitimately find
      // nothing claimable; what must never happen is an abandonment.
      expect(result.fired).toBe(0);
    }

    const [intent] = await listDispatchesForBin(binId);
    expect(intent).toBeTruthy();
    expect(intent!.state).toBe('PENDING');
    expect(intent!.state).not.toBe('ABANDONED');
    // And the budget is intact: the claim took one and the deferral gave it
    // back, every time.
    expect(intent!.attemptCount).toBe(0);

    // The bin is still dispatchable, which is the whole point.
    expect((await getBin(binId))!.state).toBe('READY');
  });

  it('records the wait as its own event rather than as a retry after a failure', async () => {
    const binId = await aReadyBin();
    await aFleet();
    await setPolicy({ scope: 'FLEET', target: 2, paused: true, actor: 'test', reason: 'no room' });
    await dispatchTick({ burst: 1, projectIds: [projectId] });

    const events = await listBinEvents(binId);
    const deferred = events.find((event) => event.eventType === 'DISPATCH_DEFERRED');
    expect(deferred).toBeTruthy();
    expect(deferred!.outcome).toBe('FLEET_PAUSED');
    // Brain read its own capacity rows. No provider was asked, so nothing here
    // may claim the provider enforced anything.
    expect(deferred!.evidenceClass).toBe('MEASURED');
    expect(events.some((event) => event.eventType === 'DISPATCH_ABANDONED')).toBe(false);
  });

  it('still abandons when there is no fleet at all', async () => {
    /*
     * The other half, and the reason this is a set rather than a blanket rule.
     * "No Routine is registered" does not resolve by waiting, so an intent that
     * retried forever would hide a broken deployment behind a patient spinner.
     */
    process.env['BRAIN_ROUTINE_ID'] = 'trig_env_fallback';
    process.env['BRAIN_ROUTINE_TOKEN'] = 'token';
    const binId = await aReadyBin();
    const account = await createAccount({ provider: 'anthropic', name: 'empty-account' });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_nobody',
      name: 'V-nobody',
      tokenSecretName: 'SECRET_THAT_IS_NOT_SET',
    });
    void routine;

    for (let round = 0; round < 8; round += 1) {
      await dispatchTick({ burst: 1, projectIds: [projectId] });
      const [intent] = await listDispatchesForBin(binId);
      if (intent?.state === 'ABANDONED') break;
      // Move the clock forward by making the intent claimable again.
      const { getDb } = await import('../server/db/database.ts');
      await getDb().run(
        "UPDATE bin_dispatch SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE bin_id = ?",
        [binId],
      );
    }

    const [intent] = await listDispatchesForBin(binId);
    expect(intent!.state).toBe('ABANDONED');
    delete process.env['BRAIN_ROUTINE_ID'];
    delete process.env['BRAIN_ROUTINE_TOKEN'];
  });
});
