/**
 * The screen's measurements and its surviving set are read by something: the
 * research pass records the questions it does not ask, and the owner's Cash
 * view carries both the counters and the candidate set.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode, cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { reconcileDiscoverableGaps } from '../server/services/cash/operate.ts';
import { QUESTION_SKIPPED_EVENT, screenMetrics } from '../server/services/cash/screenMetrics.ts';
import { cashView } from '../server/services/cash/view.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `wm-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function goal(capitalCeilingCents: number): Promise<void> {
  const g = await createWorkstream({ projectId, title: 'Cash', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId, capitalCeilingCents, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
}

async function opening(title: string, peakFundingCents: number | null) {
  const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title, mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', sourceClaimId: null, source: 'A publisher' });
  await updateOpportunity(o.id, { peak_funding_cents: peakFundingCents });
  return (await getOpportunity(o.id))!;
}

describe('questions not asked are recorded', () => {
  it('records each skipped question once, and raises no need for a screened-out opening', async () => {
    await goal(500_000);
    const rejected = await opening('Too much capital', 900_000);
    const raised = await reconcileDiscoverableGaps(projectId);
    expect(raised.filter((one) => one.opportunityId === rejected.id)).toEqual([]);
    const first = (await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT)).filter((e) => e.opportunityId === rejected.id);
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]!.summary).toContain('No answer could change the decision');
    await reconcileDiscoverableGaps(projectId);
    const second = (await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT)).filter((e) => e.opportunityId === rejected.id);
    expect(second.length).toBe(first.length);
    expect((await screenMetrics(projectId)).questionsSkipped).toBe(first.length);
  });

  it('records nothing for an opening the screen does not reject', async () => {
    await goal(5_000_000);
    await opening('Affordable', 100_000);
    await reconcileDiscoverableGaps(projectId);
    expect(await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT)).toEqual([]);
  });
});

describe('the owner view reads the counters and the surviving set', () => {
  it('carries screening metrics, and a candidate set only when the project has a goal target', async () => {
    const without = await cashView({ projectId });
    expect(without.screening.candidates).toBeNull();
    expect(without.screening.metrics.questionsSkipped).toBe(0);
    await goal(500_000);
    const keep = await opening('Affordable', 100_000);
    const drop = await opening('Too much capital', 900_000);
    await reconcileDiscoverableGaps(projectId);
    const view = await cashView({ projectId });
    expect(view.screening.metrics.questionsSkipped).toBeGreaterThan(0);
    const set = view.screening.candidates!;
    expect(set.members.map((m) => m.id)).toContain(keep.id);
    expect(set.excluded.map((e) => e.id)).toContain(drop.id);
    expect(set.targetCents).toBe(100_000);
  });
});
