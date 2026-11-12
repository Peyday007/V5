/**
 * The screen runs where research is launched: no caller passes it limits, so
 * `notWorthResearching` reads the project's own goals. Two goals, one opening.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { describeNotWorthResearching, notWorthResearching } from '../server/services/cash/worthResearching.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `wired-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function goal(capitalCeilingCents: number): Promise<void> {
  const g = await createWorkstream({ projectId, title: 'Cash', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId, capitalCeilingCents, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
}

async function opening(peakFundingCents: number | null, mechanism: 'PRODUCTIZED_SERVICE' | 'SUPPLY_DEMAND_MISMATCH' = 'PRODUCTIZED_SERVICE') {
  const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title: 'An opening', mechanism, currency: 'USD', sourceClaimId: null, source: 'A publisher' });
  await updateOpportunity(o.id, { peak_funding_cents: peakFundingCents });
  return (await import('../server/repos/cashPortfolio.ts')).getOpportunity(o.id) as Promise<NonNullable<Awaited<ReturnType<typeof createOpportunity>>>>;
}

describe('the goal screen at research launch', () => {
  it('stops research on capital above the goal ceiling and not under a higher ceiling', async () => {
    await goal(500_000);
    const o = await opening(900_000);
    const reason = await notWorthResearching(o, { now: now.toISOString() });
    expect(reason).toMatchObject({ kind: 'SCREENED_OUT', reason: 'CAPITAL_TOO_HIGH' });
    expect(describeNotWorthResearching(reason!)).toContain('capital ceiling');
    await goal(5_000_000);
    expect(await notWorthResearching(o, { now: now.toISOString() })).toBeNull();
  });

  it('never stops research with no goal target, an unknown capital, or a named no-capital route', async () => {
    expect(await notWorthResearching(await opening(900_000), { now: now.toISOString() })).toBeNull();
    await goal(500_000);
    expect(await notWorthResearching(await opening(null), { now: now.toISOString() })).toBeNull();
    expect(await notWorthResearching(await opening(900_000, 'SUPPLY_DEMAND_MISMATCH'), { now: now.toISOString() })).toBeNull();
  });
});
