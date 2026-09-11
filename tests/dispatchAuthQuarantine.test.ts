/**
 * An authentication failure is not backpressure.
 *
 * §23's rule is that a refusal is not misconduct: an account at its ceiling is
 * busy rather than broken, so a rate limit advances the retry point and leaves the
 * failure streak alone. That is right for a rate limit and wrong for a `401`. A
 * token that does not authorize a Routine will not start authorizing it on the
 * next tick, and the dispatcher treated that as a fleet-wide wall — it ended the
 * whole burst, so the healthy Routine beside the broken one was never tried, and
 * nothing took the broken one out of routing.
 *
 * Production measured it: eighteen consecutive `AUTH 401 "Token is not authorized
 * for this routine"` against one registered Routine, a factory bin sitting READY
 * with its dispatch PENDING, and every surface in the fleet still ENABLED.
 *
 * So these tests pin the two halves: the surface that refused goes out of routing
 * by name, and the burst carries on to the next intent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createAccount, createRoutine, listRoutines, setRoutineState } from '../server/repos/fleet.ts';
import { createBin } from '../server/repos/bins.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
const realFetch = globalThis.fetch;

/** Which routine ref the provider refuses, and which it accepts. */
let refuseRef = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const account = await createAccount({ provider: 'anthropic', name: 'auth-account' });
  await createRoutine({
    accountId: account.id,
    routineRef: 'trig_bad_token',
    name: 'V-bad',
    tokenSecretName: 'AUTH_TEST_SECRET_BAD',
  });
  await createRoutine({
    accountId: account.id,
    routineRef: 'trig_good_token',
    name: 'V-good',
    tokenSecretName: 'AUTH_TEST_SECRET_GOOD',
  });
  process.env['AUTH_TEST_SECRET_BAD'] = 'bad-token';
  process.env['AUTH_TEST_SECRET_GOOD'] = 'good-token';
  refuseRef = 'trig_bad_token';

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(refuseRef)) {
      return new Response(
        JSON.stringify({
          error: { message: 'Token is not authorized for this routine', type: 'authentication_error' },
        }),
        { status: 401 },
      );
    }
    return new Response(JSON.stringify({ claude_code_session_id: 'cse_ok' }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['AUTH_TEST_SECRET_BAD'];
  delete process.env['AUTH_TEST_SECRET_GOOD'];
});

function manifest(): BinManifest {
  return {
    objective: 'Prove a 401 takes one surface out rather than stopping the fleet.',
    why: 'A token that does not authorize will not start authorizing on retry.',
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

async function readyBin(title: string): Promise<string> {
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title,
    objective: manifest().objective,
    rationale: 'a bin to fire at',
    manifest: manifest(),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    contractVersion: 1,
    priority: 5,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: 2,
  });
  return bin.id;
}

describe('a fire refused for authentication', () => {
  it('quarantines the surface that refused and carries the burst on to the next intent', async () => {
    await readyBin('first');
    await readyBin('second');

    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });

    /*
     * Both halves, in one tick. The bad surface refused one intent and the good
     * one took the next — which before the fix could not happen, because a
     * non-retryable failure broke out of the loop.
     */
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.fired).toBeGreaterThanOrEqual(1);

    const routines = await listRoutines();
    const bad = routines.find((routine) => routine.routineRef === 'trig_bad_token');
    const good = routines.find((routine) => routine.routineRef === 'trig_good_token');
    expect(bad?.state).toBe('QUARANTINED');
    expect(bad?.stateReason ?? '').toContain('AUTH');
    // And the healthy surface is untouched: a 401 is a fact about one secret.
    expect(good?.state).toBe('ENABLED');
  });

  /*
   * And the intent it deferred is put back once the fleet changes — which is the
   * fix-after-the-damage case and its own defect. The first dispatcher wrote a
   * twenty-four-hour backoff for every non-retryable failure; shortening that
   * helped every future failure and left the intents already written behind a wall,
   * with a factory review bin READY and nothing anywhere able to answer it.
   */
  it('puts a surface-deferred intent back once a Routine row changes', async () => {
    const binId = await readyBin('only');
    // Fire, be refused, and be deferred with the error recorded against the intent.
    await dispatchTick({ burst: 4, projectIds: [projectId] });

    const { getDb } = await import('../server/db/database.ts');
    /*
     * Scoped to this test's own bin. The first version asked `bin_dispatch` for
     * "the PENDING row", which is true of a file running alone and not of a suite
     * where other files share the database — it passed locally and failed in CI on
     * a row that was never this test's to read.
     */
    const deferred = await getDb().get<{ next_attempt_at: string; last_error_kind: string }>(
      `SELECT next_attempt_at, last_error_kind FROM bin_dispatch
        WHERE bin_id = ? AND state = 'PENDING'`,
      [binId],
    );
    expect(deferred?.last_error_kind).toBe('AUTH');
    // Pushed out beyond now, so nothing would claim it on the next tick.
    await getDb().run(
      `UPDATE bin_dispatch SET next_attempt_at = ?, updated_at = ?
        WHERE bin_id = ? AND state = 'PENDING'`,
      [
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        '2000-01-01T00:00:00.000Z',
        binId,
      ],
    );

    // A person corrects the fleet: any write to a Routine row is the condition.
    const routines = await listRoutines();
    const bad = routines.find((routine) => routine.routineRef === 'trig_bad_token')!;
    await setRoutineState({
      routineId: bad.id,
      from: bad.state,
      to: 'ENABLED',
      reason: 'the deployment secret was corrected',
    });

    refuseRef = 'trig_nothing_refuses_this';
    const second = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(second.rearmed).toBeGreaterThanOrEqual(1);
    expect(second.fired).toBeGreaterThanOrEqual(1);
  });

  it('leaves every surface enabled when the provider accepts', async () => {
    refuseRef = 'trig_nothing_refuses_this';
    await readyBin('only');
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBeGreaterThanOrEqual(1);
    // This test's own two surfaces, not every row in a shared database.
    const routines = await listRoutines();
    for (const ref of ['trig_bad_token', 'trig_good_token']) {
      expect(routines.find((routine) => routine.routineRef === ref)?.state).toBe('ENABLED');
    }
  });
});
