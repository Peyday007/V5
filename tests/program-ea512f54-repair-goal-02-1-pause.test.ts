/**
 * GOAL-02 repair: a goal with its own target and a future deadline keeps its metric and
 * deadline in the running Brain. A machine actor (the operator weighing congestion) may
 * not pause it; a person still may. Goals without a target, or past their deadline, pause
 * as before.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
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

async function goal(opts: { target: boolean; dueDays: number | null }): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect $10K', intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  if (opts.dueDays !== null) await setTerms(g.id, { dueAt: inDays(opts.dueDays), ownerUserId: userId }, `person:${userId}`);
  if (opts.target) {
    const r = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, now: new Date(now.getTime() - 60_000) });
    expect(r.ok).toBe(true);
  }
  return g.id;
}

async function pausedEvents(id: string): Promise<number> {
  const events = await listWorkstreamEvents(id);
  return events.filter((e) => e.kind === 'GOAL_PAUSED').length;
}

describe('pause guard on a live targeted goal', () => {
  it('refuses an operator pause of a goal with a target and a future deadline, changing nothing', async () => {
    const id = await goal({ target: true, dueDays: 30 });
    const r = await pause(id, 'Pausing goal with 0 marginal value to reduce system congestion', 'operator:run_1');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/metric and deadline still bind/);
    expect(r.consequence).toBe('Nothing changed.');
    expect((await getWorkstream(id))!.pausedAt).toBeNull();
    expect(await pausedEvents(id)).toBe(0);
  });

  it('still lets a person pause that goal, recording GOAL_PAUSED', async () => {
    const id = await goal({ target: true, dueDays: 30 });
    const r = await pause(id, 'Owner wants a break.', `person:${userId}`);
    expect(r.ok).toBe(true);
    expect((await getWorkstream(id))!.pausedAt).not.toBeNull();
    expect(await pausedEvents(id)).toBe(1);
  });

  it('lets an operator pause a goal with no target, as before', async () => {
    const id = await goal({ target: false, dueDays: 30 });
    const r = await pause(id, 'congestion', 'operator:run_2');
    expect(r.ok).toBe(true);
    expect((await getWorkstream(id))!.pausedAt).not.toBeNull();
  });

  it('lets an operator pause a targeted goal whose deadline has passed', async () => {
    const id = await goal({ target: true, dueDays: 30 });
    const later = new Date(now.getTime() + 31 * 86_400_000);
    const r = await pause(id, 'congestion', 'operator:run_3', later);
    expect(r.ok).toBe(true);
    expect((await getWorkstream(id))!.pausedAt).not.toBeNull();
  });
});
