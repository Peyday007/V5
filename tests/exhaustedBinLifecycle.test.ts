/**
 * What happens to a bin a worker cannot finish.
 *
 * The defect this file is written from: one activation was handed the same item
 * over and over until it read 5/5. Most of that is the design working — the
 * attempt budget is exactly what bounds work nobody can complete, and each
 * assignment is supposed to cost one — so the tests here pin the *boundary*
 * rather than the budget: what must stop happening once the budget is spent,
 * and which of the lifecycle transitions were able to undo that.
 *
 * One of them was. `reopenNoShowDispatches` asked the intent's own attempt
 * budget and never the bin's, so an exhausted bin still sitting READY had its
 * unanswered intent put back to PENDING every window, for ever, on a bin the
 * assigner and all four of the dispatcher's readers already refuse. Nothing was
 * ever fired, which is why it was invisible; what it produced was an intent
 * that could not reach a terminal state, because the thing that advances its
 * counter is the claim it would never get.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  assignNextBin,
  createBin,
  ensureDispatchIntent,
  getBin,
  isDispatchable,
  listBinEvents,
  listDispatchableBins,
  listDispatchesForBin,
  releaseBin,
  reopenNoShowDispatches,
} from '../server/repos/bins.ts';
import { reconcileBins } from '../server/services/bins/service.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { classesForFamilies } from '../server/services/bins/routing.ts';

describe('a bin that has spent its attempts', () => {
  let projectId = '';
  let workerId = '';

  beforeEach(async () => {
    const fresh = await freshProject();
    projectId = fresh.project.id;
    const worker = await createWorker({
      name: 'exhaustion-surface',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    workerId = worker.id;
    await grantMembership({
      principalType: 'WORKER',
      principalId: worker.id,
      projectId,
      role: 'MEMBER',
      scopes: ['project:read', 'queue:claim'],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
  });
  afterEach(async () => {
    await teardown();
  });

  async function readyBin(title = 'A tiny checkable mission'): Promise<string> {
    const bin = await createBin({
      projectId,
      kind: 'DETERMINISTIC_CHECK',
      title,
      objective: 'Establish a small set of values Brain can check for itself.',
      manifest: {
        objective: 'Establish a small set of values Brain can check for itself.',
        why: 'To exercise dispatch without spending research allowance.',
        lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
        units: [{ key: 'unit-1', establishes: 'x', input: 'y', transform: 'sha256', dependsOn: [] }],
        acceptableSources: [],
        excludedSources: [],
        evidence: ['a stored value matching Brain’s own recomputation'],
        outputs: ['one unit result per declared unit'],
        authorizedActions: ['submit unit results'],
        prohibitedActions: ['anything with an external effect'],
        budgetUnits: 1,
        retry: { maxAttempts: 3, backoffSeconds: 30 },
        stoppingConditions: ['every declared unit has a verified result'],
      },
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    return bin.id;
  }

  const assign = async () =>
    await assignNextBin({
      workerId,
      credentialId: 'cred-test',
      projectIds: [projectId],
      families: classesForFamilies(['RESEARCH', 'GENERAL']),
    });

  /**
   * Spend every attempt, and the two ways that happens are kept apart on
   * purpose — the whole defect below lives in the difference between them.
   *
   * `byRelease` is a worker that took the bin and gave it back: the bin ends
   * READY. `byExpiry` is a worker that took it and never came back: the bin
   * ends LEASED with a dead lease, which every other reader in the codebase
   * already treats as nobody holding it.
   */
  async function spend(binId: string, how: 'byRelease' | 'byExpiry'): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      const bin = await getBin(binId);
      if (!bin) throw new Error('bin vanished');
      if (bin.attemptCount >= bin.maxAttempts) return;
      if (bin.state === 'LEASED') {
        await getDb().run(
          "UPDATE bins SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
          [binId],
        );
      }
      const assigned = await assign();
      if (!assigned || assigned.bin.id !== binId) {
        throw new Error('nothing was assignable while attempts remained');
      }
      if (how === 'byRelease') {
        const outcome = await releaseBin({
          binId,
          leaseId: assigned.leaseId,
          leaseGeneration: assigned.bin.leaseGeneration,
          workerId,
        });
        if (outcome !== 'OK') throw new Error(`release refused: ${outcome}`);
      } else {
        await getDb().run(
          "UPDATE bins SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
          [binId],
        );
      }
    }
    throw new Error('the attempt budget never ran out');
  }

  it('is refused by the assigner once its budget is spent', async () => {
    const binId = await readyBin();
    await spend(binId, 'byRelease');
    const bin = await getBin(binId);
    expect(bin?.attemptCount).toBe(bin?.maxAttempts);
    // Still READY, and still not offerable. Those are different facts and the
    // second is the one that matters.
    expect(await assign()).toBeNull();
    expect(isDispatchable(bin!)).toBe(false);
    expect((await listDispatchableBins(10)).map((one) => one.id)).not.toContain(binId);
  });

  it('becomes exactly one decision, with the contract’s own reason', async () => {
    const binId = await readyBin();
    await spend(binId, 'byRelease');
    const report = await reconcileBins(projectId);
    expect(report.escalated).toBeGreaterThanOrEqual(1);
    const bin = await getBin(binId);
    expect(bin?.state).toBe('NEEDS_HUMAN');
    expect(bin?.terminalReason).toContain('attempts');
    // And it stays refused afterwards — terminal is terminal.
    expect(await assign()).toBeNull();
  });

  it('cannot be released back into the queue', async () => {
    const binId = await readyBin();
    await spend(binId, 'byRelease');
    const assigned = { leaseId: 'a lease it no longer holds', generation: 0 };
    await reconcileBins(projectId);
    const parked = await getBin(binId);
    expect(parked?.state).toBe('NEEDS_HUMAN');
    // A release carries the whole ownership proof, and the proof requires the
    // bin to be LEASED. A terminal bin holds no lease, so there is nothing to
    // release — the refusal is structural rather than a check somebody added.
    const outcome = await releaseBin({
      binId,
      leaseId: assigned.leaseId,
      leaseGeneration: assigned.generation,
      workerId,
    });
    expect(outcome).toBe('NOT_OWNER');
    expect((await getBin(binId))?.state).toBe('NEEDS_HUMAN');
  });

  it('has its unanswered fire abandoned rather than reopened for ever', async () => {
    const binId = await readyBin();
    await spend(binId, 'byRelease');
    const bin = await getBin(binId);
    expect(bin?.state).toBe('READY');
    // A fire that went out at the bin's current generation and was never
    // answered — the shape `reopenNoShowDispatches` exists for.
    await ensureDispatchIntent(bin!);
    await getDb().run(
      `UPDATE bin_dispatch SET state = 'SENT', sent_at = '2000-01-01T00:00:00.000Z',
         routine_id = 'rtn-test', routine_ref = 'trig_test'
       WHERE bin_id = ?`,
      [binId],
    );

    const reopened = await reopenNoShowDispatches(1_000, 20);
    expect(reopened).toEqual([{ dispatchId: expect.any(String), binId, outcome: 'ABANDONED' }]);

    const dispatches = await listDispatchesForBin(binId);
    expect(dispatches[0]?.state).toBe('ABANDONED');
    expect(dispatches[0]?.lastError).toContain('out of attempts');
    // Which is the point: a second pass finds nothing left to reopen, so the
    // thirty-minute churn stops instead of running for ever.
    expect(await reopenNoShowDispatches(1_000, 20)).toEqual([]);
    const events = await listBinEvents(binId, 200);
    expect(events.filter((one) => one.eventType === 'DISPATCH_INTENT').length).toBe(1);
    expect(events.some((one) => one.eventType === 'DISPATCH_ABANDONED')).toBe(true);
  });

  it('still reopens an unanswered fire while the bin has attempts left', async () => {
    // The inversion, so the fix above is a narrowing rather than a removal.
    const binId = await readyBin();
    const bin = await getBin(binId);
    await ensureDispatchIntent(bin!);
    await getDb().run(
      `UPDATE bin_dispatch SET state = 'SENT', sent_at = '2000-01-01T00:00:00.000Z',
         routine_id = 'rtn-test', routine_ref = 'trig_test'
       WHERE bin_id = ?`,
      [binId],
    );
    const reopened = await reopenNoShowDispatches(1_000, 20);
    expect(reopened[0]?.outcome).toBe('REOPENED');
    expect((await listDispatchesForBin(binId))[0]?.state).toBe('PENDING');
  });

  it('is turned into a decision even when its last lease merely lapsed', async () => {
    /*
     * The defect. A bin whose final attempt ended by the lease running out —
     * a worker that took it and never came back — is LEASED with a dead lease
     * and no attempts left. `DISPATCHABLE_SQL` refuses it and the assigner
     * refuses it, and `terminateUnleasedBin` matched READY and DRAFT only, so
     * the pass whose whole job is to turn that into one decision could not
     * touch it. It read the failed UPDATE as a race and counted the bin
     * healthy, every tick, for ever.
     */
    const binId = await readyBin();
    await spend(binId, 'byExpiry');
    const before = await getBin(binId);
    expect(before?.state).toBe('LEASED');
    expect(before?.attemptCount).toBe(before?.maxAttempts);
    expect(isDispatchable(before!)).toBe(false);

    const report = await reconcileBins(projectId);
    expect(report.escalated).toBe(1);
    const after = await getBin(binId);
    expect(after?.state).toBe('NEEDS_HUMAN');
    expect(after?.terminalReason).toContain('attempts');
    // The dead lease goes with it: a terminal bin carrying a lease id is a row
    // two readers would disagree about.
    expect(after?.leaseId).toBeNull();
    expect(after?.workerId).toBeNull();
    expect(after?.leaseExpiresAt).toBeNull();
  });

  it('refuses to terminalize a bin somebody is actually holding', async () => {
    // The inversion, so the widening above is a narrowing of "unleased" rather
    // than a removal of the guard.
    const binId = await readyBin();
    const assigned = await assign();
    expect(assigned?.bin.id).toBe(binId);
    const { terminateUnleasedBin } = await import('../server/repos/bins.ts');
    const taken = await terminateUnleasedBin(
      binId,
      assigned!.bin.leaseGeneration,
      'NEEDS_HUMAN',
      'should not happen',
    );
    expect(taken).toBe(false);
    expect((await getBin(binId))?.state).toBe('LEASED');
  });

  it('does not take its siblings down with it', async () => {
    const spent = await readyBin('the one nobody can finish');
    const healthy = await readyBin('the one that is fine');
    await spend(spent, 'byRelease');
    await reconcileBins(projectId);
    expect((await getBin(spent))?.state).toBe('NEEDS_HUMAN');
    // Still fireable: the sibling's own budget is untouched by what happened
    // next door, and it is what the dispatcher would pick up.
    expect(isDispatchable((await getBin(healthy))!)).toBe(true);
    expect((await listDispatchableBins(10)).map((one) => one.id)).toEqual([healthy]);
    // And it is the sibling the assigner hands over.
    const assigned = await assign();
    expect(assigned?.bin.id).toBe(healthy);
  });
});
