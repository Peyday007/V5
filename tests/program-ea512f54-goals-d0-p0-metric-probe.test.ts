/**
 * GOAL-02: probe r01.goal-02 judges production goal rows. A goal keeps its own metric and
 * deadline; collected/settled cash is only ever cash that happened; the probe fails when
 * there is nothing to read and when a reading disagrees with the ledger rows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { readTarget, setTarget } from '../server/services/goals/target.ts';
import { metricProblem, type GoalRow } from '../server/services/factory/program/release01/metricProbe.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';

const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
const key = () => `k${Math.random().toString(36).slice(2, 12)}`;
let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `g2-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

async function goal(metric: string, amountCents: number, days: number): Promise<string> {
  const g = await createWorkstream({ projectId, title: `Goal ${metric}`, intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric, amountCents, currency: 'USD', projectId, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
  return g.id;
}

const probe = () => getProbe('r01.goal-02')!({});

describe('probe r01.goal-02 on rows', () => {
  it('is registered once targets are loaded, and fails with no live goal rather than passing on nothing', async () => {
    expect(getProbe('r01.goal-02')).not.toBeNull();
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no live goal/);
  });

  it('passes with goals on different metrics and deadlines, whatever promises the ledger also holds', async () => {
    await goal('SETTLED_CASH', 100_000, 30);
    await goal('COLLECTED_CASH', 100_000, 90);
    await goal('CONTRIBUTION', 50_000, 60);
    await recordMoney({ projectId, kind: 'PIPELINE_AGREED', amountCents: 900_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key() });
    await recordMoney({ projectId, kind: 'CUSTOMER_PAYMENT', amountCents: 400_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key(), verifiedReference: 'pi_g2a' });
    await recordMoney({ projectId, kind: 'SETTLEMENT', amountCents: 100_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key(), verifiedReference: 'po_g2a' });
    await recordMoney({ projectId, kind: 'REFUND', amountCents: 10_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key(), verifiedReference: 're_g2a' });
    await recordMoney({ projectId, kind: 'COST', amountCents: 5_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key() });
    const r = await probe();
    expect(r.detail).toMatch(/3 live goal\(s\), 3 distinct metric\/deadline pair\(s\)/);
    expect(r.ok).toBe(true);
  });
});

describe('metricProblem (pure)', () => {
  const row: GoalRow = { id: 'g', target_metric: 'SETTLED_CASH', target_amount_cents: 100_000, target_currency: 'USD', target_project_id: 'p', target_set_at: '2026-01-01T00:00:00.000Z', due_at: inDays(10) };
  const reading = async () => {
    const id = await goal('SETTLED_CASH', 100_000, 10);
    await recordMoney({ projectId, kind: 'SETTLEMENT', amountCents: 30_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key(), verifiedReference: 'po_m' });
    return (await readTarget((await getWorkstream(id))!, now))!;
  };

  it('accepts a reading that equals the rows and refuses each way it could drift', async () => {
    const r = await reading();
    const goalRow = { ...row, due_at: inDays(10) };
    const raw = { SETTLEMENT: 30_000, PIPELINE_AGREED: 5_000_000, CUSTOMER_PAYMENT: 90_000 };
    expect(metricProblem(goalRow, r, raw, 0, now)).toBeNull();
    expect(metricProblem({ ...goalRow, target_metric: 'COLLECTED_CASH' }, r, raw, 0, now)).toMatch(/reads metric/);
    expect(metricProblem(goalRow, { ...r, achievedCents: 5_030_000 }, raw, 0, now)).toMatch(/where the ledger rows give 30000/);
    expect(metricProblem(goalRow, { ...r, counted: ['SETTLEMENT', 'PIPELINE_AGREED'] }, raw, 0, now)).toMatch(/not cash that happened/);
    expect(metricProblem(goalRow, { ...r, counted: ['SETTLEMENT', '-COST'] }, raw, 0, now)).toMatch(/subtracts costs/);
    expect(metricProblem(goalRow, { ...r, daysLeft: 999 }, raw, 0, now)).toMatch(/deadline/);
    expect(metricProblem(goalRow, { ...r, targetCents: 1 }, raw, 0, now)).toMatch(/different target amount/);
    expect(metricProblem(goalRow, { ...r, achieved: true }, raw, 0, now)).toMatch(/inconsistently/);
  });
});
