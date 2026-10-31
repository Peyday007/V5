/**
 * The decision record has a producer: a Cash Mode tick writes one current
 * REJECT / HOLD / PRIORITIZE per opening per goal, from the code screen, and
 * recomputes whatever a reconsideration flagged. Before this, decideOpportunity
 * and recomputeFlaggedDecisions had no caller outside tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { decideOpenings } from '../server/services/cash/decisions.ts';
import { operate } from '../server/services/cash/operate.ts';
import { currentDecision, currentDecisionsForProject, requestDecisionRecompute } from '../server/repos/cashDecisions.ts';

let projectId = '';
let userId = '';
let cashModeId = '';
const now = new Date();

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `producer-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

async function goal(capitalCeilingCents: number): Promise<string> {
  const g = await createWorkstream({ projectId, title: 'Cash', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, capitalCeilingCents, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
  return g.id;
}

async function opening(peakFundingCents: number | null): Promise<string> {
  const o = await createOpportunity({ projectId, cashModeId, ownerUserId: userId, title: 'An opening', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', sourceClaimId: null, source: 'A publisher' });
  await updateOpportunity(o.id, { peak_funding_cents: peakFundingCents });
  return o.id;
}

describe('the decision producer', () => {
  it('writes nothing without a goal target', async () => {
    await opening(900_000);
    const pass = await decideOpenings(projectId, { now: now.toISOString() });
    expect(pass.goals).toBe(0);
    expect(await currentDecisionsForProject(projectId)).toHaveLength(0);
  });

  it('records one current decision per opening per goal, once per change', async () => {
    const goalId = await goal(500_000);
    const tooDear = await opening(900_000);
    const unknown = await opening(null);
    const first = await decideOpenings(projectId, { now: now.toISOString() });
    expect(first.recorded).toBe(2);
    expect((await currentDecision(tooDear, goalId))?.verdict).toBe('REJECT');
    expect((await currentDecision(tooDear, goalId))?.bindingConstraint).toBeTruthy();
    expect((await currentDecision(unknown, goalId))?.verdict).not.toBe('REJECT');

    const second = await decideOpenings(projectId, { now: now.toISOString() });
    expect(second.recorded).toBe(0);
    expect(second.unchanged).toBe(2);

    // A new fact is a distinct change and is decided again.
    await updateOpportunity(tooDear, { peak_funding_cents: 100_000 });
    const third = await decideOpenings(projectId, { now: now.toISOString() });
    expect(third.recorded).toBe(1);
    expect((await currentDecision(tooDear, goalId))?.verdict).not.toBe('REJECT');
  });

  it('recomputes a decision a reconsideration flagged', async () => {
    await goal(500_000);
    const id = await opening(900_000);
    await decideOpenings(projectId, { now: now.toISOString() });
    expect(await requestDecisionRecompute(id, 'EVIDENCE:test-change')).toBe(1);
    const pass = await decideOpenings(projectId, { now: now.toISOString() });
    expect(pass.recompute.recomputed + pass.recompute.released).toBe(1);
  });

  it('runs on the live Cash Mode tick', async () => {
    const goalId = await goal(500_000);
    const id = await opening(900_000);
    const tick = await operate(projectId, now.toISOString());
    expect(tick.decisions && 'recorded' in tick.decisions ? tick.decisions.recorded : -1).toBe(1);
    expect((await currentDecision(id, goalId))?.verdict).toBe('REJECT');
  });
});
