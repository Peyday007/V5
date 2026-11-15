/**
 * GOAL-02 repair (episode 1): a machine's pause of a targeted goal whose
 * deadline is still ahead is undone by the goal tick, so production rows again
 * carry a live goal with its own metric and deadline. A person's pause stands,
 * and an untargeted or past-deadline goal is left alone.
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

const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `g2r-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

async function goal(opts: { targeted: boolean; days: number }): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Goal', intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  if (opts.targeted) {
    await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  }
  // The deadline written last, directly, so a past one is possible.
  await getDb().run('UPDATE workstreams SET due_at = ? WHERE id = ?', [inDays(opts.days), g.id]);
  return g.id;
}

/**
 * A machine pause made before decide.ts refused one: pause() now refuses an operator on a
 * targeted, future-deadline goal, so the legacy production state is written as it was then
 * written — the paused row and its GOAL_PAUSED event by the operator.
 */
async function legacyMachinePause(id: string, actorRef: string): Promise<void> {
  expect(await pauseGoal(id, 'capacity')).toBe(true);
  await recordWorkstreamEvent({ workstreamId: id, kind: 'GOAL_PAUSED', summary: 'capacity', actorRef });
}

async function events(id: string, kind: string) {
  return getDb().all<{ actor_ref: string; summary: string }>(
    'SELECT actor_ref, summary FROM workstream_events WHERE workstream_id = ? AND kind = ?',
    [id, kind],
  );
}

describe('advanceGoals restores a machine-paused targeted goal', () => {
  it('unpauses a targeted, future-deadline goal an operator paused, and records why', async () => {
    const id = await goal({ targeted: true, days: 30 });
    await legacyMachinePause(id, 'operator:x');
    await advanceGoals();
    expect((await getWorkstream(id))!.pausedAt).toBeNull();
    const resumed = await events(id, 'GOAL_RESUMED');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.actor_ref).toBe('brain:goal-tick');
    expect(resumed[0]!.summary).toMatch(/operator:x/);
    expect(resumed[0]!.summary).toMatch(/only reduce/);
    // Idempotent by rows: a second pass changes nothing.
    await advanceGoals();
    expect(await events(id, 'GOAL_RESUMED')).toHaveLength(1);
  });

  it('a new operator pause of that goal is refused outright', async () => {
    const id = await goal({ targeted: true, days: 30 });
    expect((await pause(id, 'capacity', 'operator:x')).ok).toBe(false);
    expect((await getWorkstream(id))!.pausedAt).toBeNull();
  });

  it('leaves a person\'s pause alone', async () => {
    const id = await goal({ targeted: true, days: 30 });
    expect((await pause(id, 'not now', `person:${userId}`)).ok).toBe(true);
    await advanceGoals();
    expect((await getWorkstream(id))!.pausedAt).not.toBeNull();
    expect(await events(id, 'GOAL_RESUMED')).toHaveLength(0);
  });

  it('leaves an untargeted or past-deadline goal paused by an operator alone', async () => {
    const untargeted = await goal({ targeted: false, days: 30 });
    const past = await goal({ targeted: true, days: -1 });
    expect((await pause(untargeted, 'capacity', 'operator:x')).ok).toBe(true);
    expect((await pause(past, 'capacity', 'operator:x')).ok).toBe(true);
    await advanceGoals();
    expect((await getWorkstream(untargeted))!.pausedAt).not.toBeNull();
    expect((await getWorkstream(past))!.pausedAt).not.toBeNull();
  });

  it('after the pass the settled-cash goal is live and the metric check passes on rows', async () => {
    const id = await goal({ targeted: true, days: 30 });
    await legacyMachinePause(id, 'operator:x');
    await recordMoney({ projectId, kind: 'PIPELINE_AGREED', amountCents: 900_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: `k${Math.random()}` });
    await recordMoney({ projectId, kind: 'SETTLEMENT', amountCents: 100_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: `k${Math.random()}`, verifiedReference: 'po_r1' });
    expect((await goalMetricsHoldOnRows()).ok).toBe(false);
    await advanceGoals();
    const r = await goalMetricsHoldOnRows();
    expect(r.detail).toMatch(/1 live goal/);
    expect(r.ok).toBe(true);
  });
});
