/**
 * GOAL-02 repair (episode 1), the production row itself.
 *
 * docs/ARCHITECTURE-RECORD.md, 2026-11-14: at 06:00Z an operator run committed
 * PAUSE_GOAL on wst_7b4fcbb5f2384f31b6c3, the $10K COLLECTED_CASH goal due
 * 2026-12-09, "to conserve capacity while infrastructure pools are congested".
 * At 07:00:30Z r01.goal-02 failed with "no live goal carries a target and a
 * deadline: no metric to read". This test rebuilds that state: one targeted
 * collected-cash goal with a future deadline, paused by an `operator:` actor
 * with that reason. The probe must fail on it with the recorded message and pass
 * after one goal tick.
 *
 * The other ways a goal can drop out of the live set are a passed deadline,
 * archiving, cancelling, a missing target, or a person's pause. The repair must
 * not hide any of them, so each one still fails the probe with the same message.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { createWorkstream, getWorkstream, recordWorkstreamEvent } from '../server/repos/register.ts';
import { pauseGoal } from '../server/repos/goals.ts';
import { pause, setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { advanceGoals } from '../server/services/goals/tick.ts';
import { goalMetricsHoldOnRows } from '../server/services/factory/program/release01/metricProbe.ts';

const RECORDED_FAILURE = 'no live goal carries a target and a deadline: no metric to read';
const RECORDED_REASON = 'to conserve capacity while infrastructure pools are congested';

const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
let projectId = '';
let userId = '';

beforeEach(async () => {
  // freshProject opens a new database, so this test owns the whole live set.
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `g2p-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

/** The $10K goal's shape: COLLECTED_CASH, $10,000, a deadline still ahead. */
async function tenK(days = 24): Promise<string> {
  const g = await createWorkstream({ projectId, title: '$10K of collected cash', intent: 'Collect $10,000.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'COLLECTED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
  await getDb().run('UPDATE workstreams SET due_at = ? WHERE id = ?', [inDays(days), g.id]);
  return g.id;
}

/** The 06:00Z write, row for row: paused, and the GOAL_PAUSED event by an operator run. */
async function operatorPause(id: string): Promise<void> {
  expect(await pauseGoal(id, `${RECORDED_REASON} (decision opd_recorded)`)).toBe(true);
  await recordWorkstreamEvent({ workstreamId: id, kind: 'GOAL_PAUSED', summary: RECORDED_REASON, actorRef: 'operator:hermes-run' });
}

describe('the recorded production cause of the r01.goal-02 failure', () => {
  it('an operator pause of the only targeted goal gives exactly the recorded failure, and one tick clears it', async () => {
    const id = await tenK();
    await recordMoney({ projectId, kind: 'CUSTOMER_PAYMENT', amountCents: 25_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: `p${Math.random()}`, verifiedReference: 'ch_recorded' });
    await recordMoney({ projectId, kind: 'PIPELINE_AGREED', amountCents: 500_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: `a${Math.random()}` });
    await operatorPause(id);

    const before = await goalMetricsHoldOnRows();
    // No live goal is an absence, read UNKNOWN (§39) since #887; the detail is the recorded one.
    expect(before.ok).toBeNull();
    expect(before.detail).toBe(RECORDED_FAILURE);

    await advanceGoals();
    expect((await getWorkstream(id))!.pausedAt).toBeNull();
    const after = await goalMetricsHoldOnRows();
    expect(after.detail).toMatch(/^1 live goal/);
    expect(after.ok).toBe(true);

    // The operator cannot put it back: the next machine pause is refused.
    const again = await pause(id, RECORDED_REASON, 'operator:hermes-run');
    expect(again.ok).toBe(false);
    expect((await goalMetricsHoldOnRows()).ok).toBe(true);
  });

  it('does not hide a goal that dropped out for a reason other than a machine pause', async () => {
    const cases: Array<[string, (id: string) => Promise<void>]> = [
      ['deadline passed', async (id) => { await getDb().run('UPDATE workstreams SET due_at = ? WHERE id = ?', [inDays(-1), id]); }],
      ['archived', async (id) => { await getDb().run('UPDATE workstreams SET archived_at = ?, archived_reason = ? WHERE id = ?', [now.toISOString(), 'test', id]); }],
      ['cancelled', async (id) => { await getDb().run('UPDATE workstreams SET cancelled_at = ?, cancelled_reason = ? WHERE id = ?', [now.toISOString(), 'test', id]); }],
      ['no target', async (id) => { await getDb().run('UPDATE workstreams SET target_metric = NULL WHERE id = ?', [id]); }],
      ['a person paused it', async (id) => { expect((await pause(id, 'not now', `person:${userId}`)).ok).toBe(true); }],
    ];
    for (const [label, drop] of cases) {
      const id = await tenK();
      await drop(id);
      await advanceGoals();
      const r = await goalMetricsHoldOnRows();
      expect({ label, ok: r.ok, detail: r.detail }).toEqual({ label, ok: null, detail: RECORDED_FAILURE });
      await getDb().run('UPDATE workstreams SET archived_at = ?, archived_reason = ? WHERE id = ?', [now.toISOString(), 'test', id]);
    }
  });
});
