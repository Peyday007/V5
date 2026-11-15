/**
 * GOAL-02 repair (episode 1): a machine actor cannot pause a goal that carries
 * its own metric and a deadline still ahead — it changes allocation, it does
 * not stop the condition. A person's pause is unchanged, and an untargeted or
 * past-deadline goal can still be paused by an operator.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { pause, setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';

const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `g2p-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

async function goal(opts: { targeted: boolean; days: number }): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Goal', intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  if (opts.targeted) {
    await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  }
  await getDb().run('UPDATE workstreams SET due_at = ? WHERE id = ?', [inDays(opts.days), g.id]);
  return g.id;
}

async function pausedEvents(id: string) {
  return getDb().all<{ actor_ref: string }>(
    "SELECT actor_ref FROM workstream_events WHERE workstream_id = ? AND kind = 'GOAL_PAUSED'",
    [id],
  );
}

describe('pause guards a targeted goal with a live deadline', () => {
  it('refuses an operator pause and records nothing', async () => {
    const id = await goal({ targeted: true, days: 30 });
    const r = await pause(id, 'Pausing goal with 0 marginal value to reduce system congestion', 'operator:run');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/metric and deadline still bind/);
    expect(r.consequence).toBe('Nothing changed.');
    expect((await getWorkstream(id))!.pausedAt).toBeNull();
    expect(await pausedEvents(id)).toHaveLength(0);
  });

  it("still pauses on a person's decision and records GOAL_PAUSED", async () => {
    const id = await goal({ targeted: true, days: 30 });
    expect((await pause(id, 'not now', `person:${userId}`)).ok).toBe(true);
    expect((await getWorkstream(id))!.pausedAt).not.toBeNull();
    const ev = await pausedEvents(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor_ref).toBe(`person:${userId}`);
  });

  it('lets an operator pause an untargeted or past-deadline goal as before', async () => {
    const untargeted = await goal({ targeted: false, days: 30 });
    const past = await goal({ targeted: true, days: -1 });
    expect((await pause(untargeted, 'capacity', 'operator:run')).ok).toBe(true);
    expect((await pause(past, 'capacity', 'operator:run')).ok).toBe(true);
    expect((await getWorkstream(untargeted))!.pausedAt).not.toBeNull();
    expect((await getWorkstream(past))!.pausedAt).not.toBeNull();
  });
});
