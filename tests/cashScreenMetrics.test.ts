/**
 * The measurement and the candidate set have consumers: a question no answer to
 * which could change the decision is recorded as skipped when the gap pass
 * declines to raise it, and both the metrics and the surviving set are on the
 * owner's Cash view.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { reconcileDiscoverableGaps } from '../server/services/cash/operate.ts';
import { screenMetrics } from '../server/services/cash/screenMetrics.ts';
import { cashView } from '../server/services/cash/view.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({
    email: `metrics-${Math.random().toString(36).slice(2, 10)}@example.com`,
    displayName: 'Owner',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
});

async function goalWithCeiling(capitalCeilingCents: number | null): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ownerUserId: userId }, `person:${userId}`);
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 500_000, currency: 'USD', projectId, capitalCeilingCents, now: new Date(Date.now() - 60_000) });
  expect(set.ok).toBe(true);
  return g.id;
}

async function opening(title: string, peakFundingCents: number | null): Promise<string> {
  const o = await createOpportunity({
    projectId, cashModeId: (await import('../server/repos/cashMode.ts').then((m) => m.getCashMode(projectId)))!.id,
    ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', opportunitySignal: 'PAID_TASK_OR_CONTRACT', currency: 'USD',
  });
  if (peakFundingCents !== null) await updateOpportunity(o.id, { peak_funding_cents: peakFundingCents });
  return o.id;
}

describe('skipped questions are recorded, and the measurement can be read', () => {
  it('records a question no answer could change, once, and still asks it of an opening that is not rejected', async () => {
    await goalWithCeiling(100_000);
    const tooBig = await opening('Needs a lot of capital', 5_000_000);
    const fine = await opening('Needs nothing', null);

    const first = await reconcileDiscoverableGaps(projectId);
    expect(first.some((gap) => gap.opportunityId === fine)).toBe(true);
    expect(first.some((gap) => gap.opportunityId === tooBig && gap.field === 'payer')).toBe(false);

    const metrics = await screenMetrics(projectId);
    expect(metrics.questionsSkipped).toBeGreaterThan(0);
    expect(metrics.claudeJobsAvoided.questionsSkipped).toBe(metrics.questionsSkipped);

    // A second pass records nothing again.
    await reconcileDiscoverableGaps(projectId);
    expect((await screenMetrics(projectId)).questionsSkipped).toBe(metrics.questionsSkipped);
  });

  it('asks every question when there is no live goal to judge against', async () => {
    const tooBig = await opening('Needs a lot of capital', 5_000_000);
    const gaps = await reconcileDiscoverableGaps(projectId);
    expect(gaps.some((gap) => gap.opportunityId === tooBig)).toBe(true);
    expect((await screenMetrics(projectId)).questionsSkipped).toBe(0);
  });

  it('puts the metrics and the surviving set on the owner\'s Cash view', async () => {
    await goalWithCeiling(100_000);
    await opening('Needs a lot of capital', 5_000_000);
    await opening('Small and open', null);
    await reconcileDiscoverableGaps(projectId);

    const view = await cashView({ projectId });
    const screening = view.myCurrentWork.screening;
    expect(screening.metrics.questionsSkipped).toBeGreaterThan(0);
    expect(screening.candidateSet).not.toBeNull();
    expect(screening.candidateSet!.members.map((m) => m.title)).toContain('Small and open');
    expect(screening.candidateSet!.excluded.length + screening.candidateSet!.members.length).toBe(2);
  });

  it('has no candidate set without a live goal, and says nothing was measured', async () => {
    await opening('Small and open', null);
    const view = await cashView({ projectId });
    expect(view.myCurrentWork.screening.candidateSet).toBeNull();
    expect(view.myCurrentWork.screening.metrics.notes.join(' ')).toMatch(/No question has been recorded as skipped/);
  });
});
