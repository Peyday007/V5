/** The production probe r01.goal-02 (GOAL-02) is registered and judges real rows. */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { readTarget, setTarget } from '../server/services/goals/target.ts';

let projectId = '';
let userId = '';
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
const key = () => `k${Math.random().toString(36).slice(2, 12)}`;

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `r01-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

async function goal(metric: string, amountCents: number, days = 30): Promise<string> {
  const g = await createWorkstream({ projectId, title: `Goal ${metric}`, intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric, amountCents, currency: 'USD', projectId, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
  return g.id;
}


import { getProbe } from '../server/services/factory/program/probes.ts';
import { GOAL_CONDITION_PROBE, goalConditionsHoldOnRows } from '../server/services/goals/goalConditionProbe.ts';
import '../server/services/goals/target.ts';

describe('r01.goal-02 reads production rows (GOAL-02)', () => {
  it('is registered by loading the goals, so it never answers UNKNOWN', () => {
    expect(getProbe(GOAL_CONDITION_PROBE)).not.toBeNull();
  });

  it('does not pass with no targeted goal', async () => {
    expect((await goalConditionsHoldOnRows()).ok).toBe(false);
  });

  it('does not pass until a settled-cash goal exists', async () => {
    await goal('COLLECTED_CASH', 100_000);
    const r = await goalConditionsHoldOnRows();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('none is a settled-cash goal');
  });

  it('passes on a settled-cash goal that agreements and payments in flight do not satisfy', async () => {
    await goal('SETTLED_CASH', 100_000);
    await recordMoney({ projectId, kind: 'PIPELINE_AGREED', amountCents: 500_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key() });
    await recordMoney({ projectId, kind: 'CUSTOMER_PAYMENT', amountCents: 400_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key(), verifiedReference: 'pi_p' });
    const r = await goalConditionsHoldOnRows();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('settlements less refunds');
  });
});
