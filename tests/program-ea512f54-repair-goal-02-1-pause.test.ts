/**
 * GOAL-02: a goal with its own metric and a deadline still ahead is a condition
 * Brain is bound to. A machine actor (an operator run's congestion heuristic)
 * may not pause it — capacity moves through allocation instead — while a
 * person's pause, and a machine pause of an untargeted or expired goal, are
 * unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorkstream, getWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { pause } from '../server/services/goals/decide.ts';

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

async function goal(input: { target: boolean; dueInMs: number | null }): Promise<string> {
  const g = await createWorkstream({
    projectId,
    title: 'Collect $10,000',
    intent: 'Collected, settled cash.',
    purpose: 'REVENUE_DIRECT',
    createdByUserId: null,
  });
  const due = input.dueInMs === null ? null : new Date(Date.now() + input.dueInMs).toISOString();
  if (input.target) {
    await getDb().run(
      `UPDATE workstreams SET target_metric = 'SETTLED_CASH', target_amount_cents = 1000000, target_currency = 'USD',
              target_project_id = ?, target_set_at = ?, due_at = ? WHERE id = ?`,
      [projectId, new Date().toISOString(), due, g.id],
    );
  } else {
    await getDb().run(`UPDATE workstreams SET due_at = ? WHERE id = ?`, [due, g.id]);
  }
  return g.id;
}

const DAY = 24 * 60 * 60 * 1000;

describe('GOAL-02: a targeted goal with a live deadline is not paused by a machine', () => {
  it('refuses an operator pause and changes nothing', async () => {
    const id = await goal({ target: true, dueInMs: 30 * DAY });
    const result = await pause(id, 'Pausing goal with 0 marginal value to reduce system congestion', 'operator:run');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/metric and deadline still bind/);
    expect(result.consequence).toBe('Nothing changed.');
    expect((await getWorkstream(id))!.pausedAt).toBeNull();
    expect((await listWorkstreamEvents(id)).some((e) => e.kind === 'GOAL_PAUSED')).toBe(false);
  });

  it("still lets a person pause it, and records the event", async () => {
    const id = await goal({ target: true, dueInMs: 30 * DAY });
    expect((await pause(id, 'owner holds it', 'person:usr_owner')).ok).toBe(true);
    expect((await getWorkstream(id))!.pausedAt).not.toBeNull();
    expect((await listWorkstreamEvents(id)).some((e) => e.kind === 'GOAL_PAUSED')).toBe(true);
  });

  it('still lets an operator pause a goal with no target', async () => {
    const id = await goal({ target: false, dueInMs: 30 * DAY });
    expect((await pause(id, 'congested', 'operator:run')).ok).toBe(true);
    expect((await getWorkstream(id))!.pausedAt).not.toBeNull();
  });

  it('still lets an operator pause a targeted goal whose deadline has passed', async () => {
    const id = await goal({ target: true, dueInMs: -DAY });
    expect((await pause(id, 'congested', 'operator:run')).ok).toBe(true);
    expect((await getWorkstream(id))!.pausedAt).not.toBeNull();
  });
});
