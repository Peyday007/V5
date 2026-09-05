/**
 * An arrival is an arrival, whether or not there was work.
 *
 * The defect this pins is one an operator hit and I then misread. Brain fires,
 * a session starts, authenticates, asks for work, and is told `NO_READY_BINS`
 * — which `checkIn`'s own comment calls "an ordinary answer" and which is the
 * *expected* outcome for the losing half of a duplicate activation. Until this
 * fix, that session left `consecutive_no_shows` exactly where a session that
 * never started at all would have left it.
 *
 * So the counter said "nobody came" when somebody had, and three ordinary
 * answers in a row would quarantine a completely healthy Routine. §23 recorded
 * that exact failure once — "a health signal pointing the opposite way to
 * reality" — and fixed it only for the path where a bin is handed over.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  bindRoutineWorker,
  createAccount,
  createRoutine,
  getRoutine,
  recordRoutineFire,
  recordWorkerArrival,
} from '../server/repos/fleet.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import { checkIn } from '../server/services/bins/service.ts';
import { shouldQuarantine, NO_SHOW_QUARANTINE_THRESHOLD } from '../server/services/dispatch/scaler.ts';
import type { Principal } from '../server/domain/types.ts';

let routineId = '';
let workerId = '';

beforeEach(async () => {
  await freshProject();
  const account = await createAccount({ provider: 'anthropic', name: 'arrival-account' });
  const worker = await createWorker({ name: 'arrival-worker', displayName: 'arrival-worker', createdByType: 'SYSTEM', createdById: 'test' });
  workerId = worker.id;
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: 'trig_arrival',
    name: 'V-arrival',
    tokenSecretName: 'ARRIVAL_SECRET',
  });
  routineId = routine.id;
  await bindRoutineWorker(routine.id, worker.id);
});

/** A worker principal, built the way `authenticate` builds one. */
function workerPrincipal(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'arrival-worker',
    displayName: 'arrival-worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_arrival',
    authMethod: 'WORKER_BEARER',
    memberships: [],
    requestId: 'req_arrival',
  };
}

describe('the counter measures arrival, not assignment', () => {
  it('is cleared by a session that arrives and finds nothing to do', async () => {
    await recordRoutineFire({ routineId, ok: true });
    expect((await getRoutine(routineId))!.consecutiveNoShows).toBe(1);

    // No memberships, so there is nothing claimable: the ordinary answer.
    const result = await checkIn({ principal: workerPrincipal(), workerId });
    expect(result.assigned).toBe(false);
    if (!result.assigned) expect(result.reason).toBe('NO_READY_BINS');

    // The session authenticated and reached us. That is the whole meaning of
    // "did not no-show", and it used to count against the surface anyway.
    expect((await getRoutine(routineId))!.consecutiveNoShows).toBe(0);
  });

  it('does not quarantine a healthy Routine for answering "nothing to do"', async () => {
    for (let round = 0; round < NO_SHOW_QUARANTINE_THRESHOLD + 1; round += 1) {
      await recordRoutineFire({ routineId, ok: true });
      await checkIn({ principal: workerPrincipal(), workerId });
    }
    const routine = (await getRoutine(routineId))!;
    expect(routine.consecutiveNoShows).toBe(0);
    expect(shouldQuarantine(routine).quarantine).toBe(false);
  });

  it('still quarantines a surface whose sessions genuinely never arrive', async () => {
    // The signal is not weakened — only made to mean what it says.
    for (let round = 0; round < NO_SHOW_QUARANTINE_THRESHOLD; round += 1) {
      await recordRoutineFire({ routineId, ok: true });
    }
    const routine = (await getRoutine(routineId))!;
    expect(routine.consecutiveNoShows).toBe(NO_SHOW_QUARANTINE_THRESHOLD);
    expect(shouldQuarantine(routine).quarantine).toBe(true);
  });

  it('records when the arrival happened, so a reading can be dated', async () => {
    await recordRoutineFire({ routineId, ok: true });
    expect((await getRoutine(routineId))!.lastCheckInAt).toBeNull();
    await recordWorkerArrival(workerId);
    expect((await getRoutine(routineId))!.lastCheckInAt).not.toBeNull();
  });

  it('credits nothing for a worker no Routine is bound to', async () => {
    // Attribution is a server-owned row. A worker with no binding resolves to
    // no surface, and inventing one from anything the worker said would be the
    // mistake §19 refuses for queue ownership.
    await recordRoutineFire({ routineId, ok: true });
    const stranger = await createWorker({ name: 'unbound', displayName: 'unbound', createdByType: 'SYSTEM', createdById: 'test' });
    expect(await recordWorkerArrival(stranger.id)).toBe(0);
    expect((await getRoutine(routineId))!.consecutiveNoShows).toBe(1);
  });

  it('is a no-op when there is no outstanding fire, so it cannot invent health', async () => {
    expect(await recordWorkerArrival(workerId)).toBe(0);
  });
});

describe('the counter is honestly named nowhere, and that is the finding', () => {
  it('advances on every fire, so it means "awaiting arrival" rather than "never came"', async () => {
    /*
     * Pinned deliberately. `recordRoutineFire` increments on success, which
     * means a reading of 1 is "one fire outstanding", not "one session failed
     * to turn up". I read it the second way in a production report and was
     * wrong; this test is here so the next reader is not.
     */
    await recordRoutineFire({ routineId, ok: true });
    const routine = (await getRoutine(routineId))!;
    expect(routine.consecutiveNoShows).toBe(1);
    expect(routine.totalRefusals).toBe(0);
  });

  it('leaves a refusal out of the arrival counter entirely', async () => {
    await recordRoutineFire({ routineId, ok: false, rateLimited: true });
    const routine = (await getRoutine(routineId))!;
    expect(routine.consecutiveNoShows).toBe(0);
    expect(routine.totalRefusals).toBe(1);
    expect(shouldQuarantine(routine).quarantine).toBe(false);
  });
});
