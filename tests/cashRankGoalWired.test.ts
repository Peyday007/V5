/**
 * The goal's own ordering reaches the portfolio: `goalCompareFor` reads the
 * project's goal, and `assemble` hands it to `rank`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { goalCompareFor } from '../server/services/cash/rankGoal.ts';
import { assemble } from '../server/services/cash/portfolio.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `rk-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function goal(capitalCeilingCents: number): Promise<void> {
  const g = await createWorkstream({ projectId, title: 'Cash', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId, capitalCeilingCents, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
}

async function opening(title: string, peakFundingCents: number, deadline: string) {
  const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title, mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', sourceClaimId: null, source: 'A publisher' });
  await updateOpportunity(o.id, { peak_funding_cents: peakFundingCents, deadline });
  return (await getOpportunity(o.id))!;
}

const plan = (opportunities: Awaited<ReturnType<typeof opening>>[], goalCompare?: (a: never, b: never) => number) =>
  assemble({ opportunities, tiers: {}, deployableCents: 0, maxConcurrent: 1, discoveryOpen: true, ...(goalCompare ? { goalCompare: goalCompare as never } : {}) }).placements.map((p) => p.opportunity.title);

describe('the goal orders the portfolio', () => {
  it('puts what fits the goal ahead of what breaks its capital limit, and changes nothing without a goal', async () => {
    const over = await opening('needs too much', 900_000, '2026-11-01');
    const fits = await opening('inside the limit', 100_000, '2026-12-01');
    expect(await goalCompareFor(projectId, [over, fits], now)).toBeUndefined();
    await goal(500_000);
    const compare = await goalCompareFor(projectId, [over, fits], now);
    expect(compare).toBeTypeOf('function');
    expect(plan([over, fits], compare as never)[0]).toBe('inside the limit');
    expect(plan([fits, over], compare as never)[0]).toBe('inside the limit');
    // Without the goal the earlier deadline wins, so the goal is what reorders them.
    expect(plan([over, fits])[0]).toBe('needs too much');
  });
});
