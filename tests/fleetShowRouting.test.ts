/**
 * `fleet show`'s per-Routine line, held to the router's own answer.
 *
 * Before this, the line's only ineligibility signal was `(not routable)`,
 * printed when a Routine did not appear in the fleet snapshot's candidate
 * list — which happens only when its deployment secret is absent. A Routine
 * that *does* appear as a candidate and is still refused by the router (an
 * UNAVAILABLE account, a disabled or archived worker, no project membership)
 * printed exactly like one the router would fire. `routingRefusalByRoutine`
 * already answers this question for every registered Routine at once; these
 * tests drive it and the extracted per-line text together, over a real fleet,
 * so the screen and the dispatcher cannot disagree about the same Routine.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { bindRoutineWorker, createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createWorker, grantMembership, setWorkerStatus } from '../server/repos/identity.ts';
import { fleetSnapshot, routingRefusalByRoutine } from '../server/services/dispatch/candidates.ts';
import { routineRoutabilitySuffix } from '../scripts/fleet.ts';

let projectId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
});

/** A worker that is a member of this test's project, and may be bound to a Routine. */
async function boundWorker(name: string): Promise<string> {
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
  return worker.id;
}

describe('fleet show: the router\'s own routable / not-routable answer', () => {
  it('reads a fully routable Routine as `routable`, with its in-flight count', async () => {
    const account = await createAccount({ name: 'personal' });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_routable',
      name: 'routable-one',
      tokenSecretName: `FLEET_SHOW_ROUTING_TEST_SECRET_${Math.random().toString(36).slice(2, 8)}`,
    });
    process.env[routine.tokenSecretName] = 'present';
    const workerId = await boundWorker('routable');
    await bindRoutineWorker(routine.id, workerId);

    const snapshot = await fleetSnapshot();
    const refusals = routingRefusalByRoutine(snapshot, [routine.id]);
    expect(refusals.get(routine.id)).toBeNull();

    const suffix = routineRoutabilitySuffix(snapshot, routine.id, refusals.get(routine.id) ?? null);
    expect(suffix).toMatch(/routable$/);
    expect(suffix).toContain('in-flight=0');
    expect(suffix).not.toContain('not routable');

    delete process.env[routine.tokenSecretName];
  });

  it('names a disabled worker as the reason an otherwise-ENABLED Routine is not routable', async () => {
    const account = await createAccount({ name: 'personal' });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_disabled_worker',
      name: 'disabled-worker-one',
      tokenSecretName: `FLEET_SHOW_ROUTING_TEST_SECRET_${Math.random().toString(36).slice(2, 8)}`,
    });
    process.env[routine.tokenSecretName] = 'present';
    const workerId = await boundWorker('disabled');
    await bindRoutineWorker(routine.id, workerId);
    await setWorkerStatus(workerId, 'DISABLED');

    const snapshot = await fleetSnapshot();
    const refusals = routingRefusalByRoutine(snapshot, [routine.id]);
    expect(refusals.get(routine.id)).toBe('bound worker is disabled or archived');

    const suffix = routineRoutabilitySuffix(snapshot, routine.id, refusals.get(routine.id) ?? null);
    expect(suffix).toBe('  not routable: bound worker is disabled or archived');

    delete process.env[routine.tokenSecretName];
  });

  it('names an absent deployment secret as the reason a Routine is not routable', async () => {
    const account = await createAccount({ name: 'personal' });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_no_secret',
      name: 'no-secret-one',
      tokenSecretName: `FLEET_SHOW_ROUTING_TEST_SECRET_${Math.random().toString(36).slice(2, 8)}`,
    });
    // Deliberately never set: this Routine's deployment secret is absent.

    const snapshot = await fleetSnapshot();
    expect(snapshot.candidates.find((c) => c.routine.id === routine.id)).toBeUndefined();

    const refusals = routingRefusalByRoutine(snapshot, [routine.id]);
    expect(refusals.get(routine.id)).toBe('its deployment secret is not present');

    const suffix = routineRoutabilitySuffix(snapshot, routine.id, refusals.get(routine.id) ?? null);
    expect(suffix).toBe('  not routable: its deployment secret is not present');
  });

  it('answers all three at once, agreeing with the router about each', async () => {
    const account = await createAccount({ name: 'personal' });

    const routable = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_all_routable',
      name: 'all-routable',
      tokenSecretName: `FLEET_SHOW_ROUTING_TEST_SECRET_${Math.random().toString(36).slice(2, 8)}`,
    });
    process.env[routable.tokenSecretName] = 'present';
    await bindRoutineWorker(routable.id, await boundWorker('all-routable'));

    const disabledWorker = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_all_disabled',
      name: 'all-disabled',
      tokenSecretName: `FLEET_SHOW_ROUTING_TEST_SECRET_${Math.random().toString(36).slice(2, 8)}`,
    });
    process.env[disabledWorker.tokenSecretName] = 'present';
    const disabledWorkerId = await boundWorker('all-disabled');
    await bindRoutineWorker(disabledWorker.id, disabledWorkerId);
    await setWorkerStatus(disabledWorkerId, 'DISABLED');

    const noSecret = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_all_no_secret',
      name: 'all-no-secret',
      tokenSecretName: `FLEET_SHOW_ROUTING_TEST_SECRET_${Math.random().toString(36).slice(2, 8)}`,
    });

    const snapshot = await fleetSnapshot();
    const ids = [routable.id, disabledWorker.id, noSecret.id];
    const refusals = routingRefusalByRoutine(snapshot, ids);

    expect(routineRoutabilitySuffix(snapshot, routable.id, refusals.get(routable.id) ?? null)).toMatch(/routable$/);
    expect(routineRoutabilitySuffix(snapshot, disabledWorker.id, refusals.get(disabledWorker.id) ?? null)).toBe(
      '  not routable: bound worker is disabled or archived',
    );
    expect(routineRoutabilitySuffix(snapshot, noSecret.id, refusals.get(noSecret.id) ?? null)).toBe(
      '  not routable: its deployment secret is not present',
    );

    delete process.env[routable.tokenSecretName];
    delete process.env[disabledWorker.tokenSecretName];
  });
});
