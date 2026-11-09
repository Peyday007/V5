/**
 * The cash-goal status is read from the ledger and the goal's own target, apart
 * from any architecture or engineering status (Release 01, R01-C).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { cashGoalStatuses } from '../server/services/goals/status.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `status-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
});

describe('cash goal status', () => {
  it('reports a targeted goal as not achieved until the ledger says so, and skips goals without a target', async () => {
    const g = await createWorkstream({ projectId, title: 'Ten thousand', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await createWorkstream({ projectId, title: 'No target', intent: 'Explore.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, now: new Date(Date.now() - 60_000) })).ok).toBe(true);
    const statuses = await cashGoalStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ goalId: g.id, achieved: false, achievedCents: 0, targetCents: 1_000_000, targetLabel: '10,000 USD', planVerdict: null });
  });
});
