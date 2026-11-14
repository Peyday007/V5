/**
 * An objective stated in words becomes a goal (G-2), a changed limit keeps the
 * goal's progress (G-5), and two live targets never count one ledger (G-7).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorkstream, getWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { createUser } from '../server/repos/identity.ts';
import { interpretIntent, readObjective } from '../server/services/industry/construction/intent.ts';
import { cancel, createGoal } from '../server/services/goals/decide.ts';
import { setTarget, setTargetLimits } from '../server/services/goals/target.ts';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const HOUR = 3_600_000;

describe('readObjective', () => {
  it('reads "Generate $100 within 48 hours."', () => {
    const r = readObjective('Generate $100 within 48 hours.', NOW);
    expect(r).toMatchObject({ kind: 'CASH', metric: 'SETTLED_CASH', amount: 100, currency: 'USD', deadlineHours: 48, capitalCeiling: null, hoursCeiling: null });
    expect(r.deadline).toBe(new Date(NOW.getTime() + 48 * HOUR).toISOString());
    expect(r.unread).toEqual([]);
  });

  it('tells the amount from the capital in "Generate $10,000 within 30 days using at most $3,000 in starting capital."', () => {
    const r = readObjective('Generate $10,000 within 30 days using at most $3,000 in starting capital.', NOW);
    expect(r).toMatchObject({ kind: 'CASH', amount: 10_000, currency: 'USD', deadlineHours: 30 * 24, capitalCeiling: 3_000 });
    expect(r.constraints).toEqual(['using at most $3,000 in starting capital']);
    expect(r.unread).toEqual([]);
  });

  it('reads "Generate $100,000 within 90 days." and "Generate $1,000,000 within one year."', () => {
    expect(readObjective('Generate $100,000 within 90 days.', NOW)).toMatchObject({ kind: 'CASH', amount: 100_000, deadlineHours: 90 * 24, capitalCeiling: null });
    const year = readObjective('Generate $1,000,000 within one year.', NOW);
    expect(year).toMatchObject({ kind: 'CASH', amount: 1_000_000, currency: 'USD', capitalCeiling: null });
    expect(year.deadline).toBe('2027-11-14T12:00:00.000Z');
    expect(year.deadlineHours).toBe(365 * 24);
  });

  it('reads "Build or expand a cleaning business in Harrisburg" as OTHER, with nothing invented', () => {
    const r = readObjective('Build or expand a cleaning business in Harrisburg', NOW);
    expect(r).toMatchObject({ kind: 'OTHER', metric: null, amount: null, currency: null, deadline: null, deadlineHours: null, capitalCeiling: null, hoursCeiling: null });
  });

  it('reads the phrasings the old interpreter misread', () => {
    expect(readObjective('Make $10,000 in 30 days with no more than $3,000 of capital', NOW)).toMatchObject({ amount: 10_000, capitalCeiling: 3_000, deadlineHours: 720 });
    expect(readObjective('$100 in 48 hours', NOW)).toMatchObject({ kind: 'CASH', amount: 100, capitalCeiling: null, deadlineHours: 48 });
    expect(readObjective('Make $5,000 by 2026-12-31 on a $3k budget', NOW)).toMatchObject({ amount: 5_000, capitalCeiling: 3_000, deadline: '2026-12-31T23:59:59.000Z' });
    expect(readObjective('Net $20k in 2 months, at most 120 hours of my time, spending no more than $500 before the first sale', NOW)).toMatchObject({
      metric: 'CONTRIBUTION',
      amount: 20_000,
      hoursCeiling: 120,
      beforeProof: 500,
      capitalCeiling: null,
      deadline: '2027-01-14T12:00:00.000Z',
    });
  });

  it('never guesses: what it cannot place is null and named', () => {
    const vague = readObjective('Make $10,000 quickly', NOW);
    expect(vague).toMatchObject({ kind: 'CASH', amount: 10_000, deadline: null });
    expect(vague.unread.join(' ')).toMatch(/quickly/);
    expect(vague.unread.join(' ')).toMatch(/deadline: none stated/);
    const noCurrency = readObjective('Make 10k in 30 days', NOW);
    expect(noCurrency).toMatchObject({ kind: 'CASH', amount: 10_000, currency: null });
    expect(noCurrency.unread.join(' ')).toMatch(/currency/);
    const rate = readObjective('Earn $1,000 a week', NOW);
    expect(rate.amount).toBeNull();
    expect(rate.unread.join(' ')).toMatch(/a rate/);
  });

  it('fixes interpretIntent: the amount is not capital, and a deadline is read', () => {
    const i = interpretIntent('Make $10,000 in 30 days with no more than $3,000 of capital');
    expect(i.capital).toEqual({ low: 3_000, high: 3_000 });
    expect(i.firstCashWithinDays).toBe(30);
    const small = interpretIntent('$100 in 48 hours');
    expect(small.capital).toBeNull();
    expect(small.firstCashWithinDays).toBe(2);
    // What the older reader already got right still holds.
    expect(interpretIntent('I have $10,000-$30,000 available.').capital).toEqual({ low: 10_000, high: 30_000 });
    expect(interpretIntent('start a cleaning business in Columbus with $8,000, make money soon').capital).toEqual({ low: 8_000, high: 8_000 });
  });
});

describe('createGoal, setTarget and setTargetLimits', () => {
  let projectId = '';
  let userId = '';
  const actorRef = 'person:test';

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `intake-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  });

  it('creates a cash goal with its due date and target from the words', async () => {
    const made = await createGoal({ projectId, objective: 'Generate $10,000 within 30 days using at most $3,000 in starting capital.', actorRef, userId, now: NOW });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.goal.purpose).toBe('REVENUE_DIRECT');
    expect(made.goal.dueAt).toBe(new Date(NOW.getTime() + 30 * 24 * HOUR).toISOString());
    expect(made.goal.target).toMatchObject({ metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, capitalCeilingCents: 300_000, setAt: NOW.toISOString() });
    const kinds = (await listWorkstreamEvents(made.goal.id)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['WORKSTREAM_OPENED', 'GOAL_TERMS_SET', 'GOAL_TARGET_SET']));
  });

  it('creates an OTHER objective as a goal with no target, never refusing it', async () => {
    const made = await createGoal({ projectId, objective: 'Build or expand a cleaning business in Harrisburg', actorRef, userId, now: NOW });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.goal.target).toBeNull();
    expect(made.goal.intent).toBe('Build or expand a cleaning business in Harrisburg');
  });

  it('refuses a cash objective with no deadline, writing nothing', async () => {
    const before = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM workstreams');
    const made = await createGoal({ projectId, objective: 'Make $10,000 quickly', actorRef, userId, now: NOW });
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.reason).toMatch(/deadline/);
    const after = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM workstreams');
    expect(Number(after?.n)).toBe(Number(before?.n));
  });

  it('G-5: changing limits keeps target_set_at, so progress is not reset', async () => {
    const made = await createGoal({ projectId, objective: 'Generate $10,000 within 30 days using at most $3,000 in starting capital.', actorRef, userId, now: NOW });
    if (!made.ok) throw new Error(made.reason);
    const later = new Date(NOW.getTime() + 5 * 24 * HOUR);
    const limits = await setTargetLimits({ goal: made.goal, capitalCeilingCents: 500_000, hoursCeiling: 80, now: later });
    expect(limits.ok).toBe(true);
    let goal = (await getWorkstream(made.goal.id))!;
    expect(goal.target).toMatchObject({ setAt: NOW.toISOString(), capitalCeilingCents: 500_000, hoursCeiling: 80, amountCents: 1_000_000 });
    expect(goal.updatedAt).toBe(later.toISOString());
    // setTarget with the same figure, amount and currency also keeps the count.
    const same = await setTarget({ goal, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, capitalCeilingCents: 100_000, now: later });
    expect(same.ok && same.target.setAt).toBe(NOW.toISOString());
    // Moving the amount restarts it, visibly.
    goal = (await getWorkstream(made.goal.id))!;
    const moved = await setTarget({ goal, metric: 'SETTLED_CASH', amountCents: 2_000_000, currency: 'USD', projectId, now: later });
    expect(moved.ok && moved.target.setAt).toBe(later.toISOString());
  });

  it('brain_operator_create_goal acts only as the operator, only in its own projects, through the same writer', async () => {
    const { OPERATOR_TOOLS } = await import('../server/mcp/operatorTools.ts');
    const { OPERATOR_SCOPES } = await import('../server/domain/types.ts');
    const tool = OPERATOR_TOOLS.find((t) => t.name === 'brain_operator_create_goal')!;
    const as = (scopes: readonly string[]) =>
      ({
        type: 'WORKER', id: 'wkr_operator', handle: 'operator', displayName: 'operator', isBrainAdmin: false, mustChangePassword: false,
        credentialId: 'cred_x', authMethod: 'OAUTH_BEARER', requestId: 'req_x',
        memberships: [{ projectId, principalType: 'WORKER', principalId: 'wkr_operator', role: 'MEMBER', scopes, active: true }],
      }) as unknown as import('../server/domain/types.ts').Principal;
    await expect(tool.run({ project_id: projectId, text: 'Generate $100 within 48 hours.' }, { principal: as(['project:read']) } as never)).rejects.toBeTruthy();
    await expect(tool.run({ project_id: 'prj_other', text: 'Generate $100 within 48 hours.' }, { principal: as(OPERATOR_SCOPES) } as never)).rejects.toBeTruthy();
    const out = (await tool.run({ project_id: projectId, text: 'Generate $100 within 48 hours.' }, { principal: as(OPERATOR_SCOPES) } as never)).value as { ok: boolean; goalId: string; target: { amountCents: number } };
    expect(out.ok).toBe(true);
    expect(out.target.amountCents).toBe(10_000);
    expect((await getWorkstream(out.goalId))?.intent).toBe('Generate $100 within 48 hours.');
    const again = (await tool.run({ project_id: projectId, text: 'Generate $500 within 48 hours.' }, { principal: as(OPERATOR_SCOPES) } as never)).value as { ok: boolean; refused: boolean };
    expect(again).toMatchObject({ ok: false, refused: true });
  });

  it('G-7: refuses a second live target on one project and currency, and allows it once the first is cancelled', async () => {
    const first = await createGoal({ projectId, objective: 'Generate $100 within 48 hours.', actorRef, userId, now: NOW });
    if (!first.ok) throw new Error(first.reason);
    const second = await createGoal({ projectId, objective: 'Generate $100,000 within 90 days.', actorRef, userId, now: NOW });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toContain(first.goal.id);
    const plain = await createWorkstream({ projectId, title: 'x', intent: 'x', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const refused = await setTarget({ goal: plain, metric: 'SETTLED_CASH', amountCents: 5_000, currency: 'USD', projectId });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/same money/);
    // Another currency is another ledger.
    expect((await setTarget({ goal: plain, metric: 'SETTLED_CASH', amountCents: 5_000, currency: 'EUR', projectId })).ok).toBe(true);
    await cancel(first.goal.id, 'replaced', actorRef);
    expect((await createGoal({ projectId, objective: 'Generate $100,000 within 90 days.', actorRef, userId, now: NOW })).ok).toBe(true);
  });
});
