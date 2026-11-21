/**
 * A strategy that fails because nobody is established to do the work says so,
 * and the quant engine that drives the plan's sensitivity reads the owner's
 * hours as the gate does.
 *
 * Production 2026-11-21 (goal wst_7b4fcbb5f2384f31b6c3, "Collect $10K within
 * 30 days", capital 3000 · hours 0): every strategy, down to one $15 opening
 * tying up $15, ended "breaks the money or hours limit in every tested case",
 * while the reconstruction's sensitivity read "days to cash ÷2 → reach 96.7%".
 * No found opening had a performer established, so the gate swept its owner
 * hours from 1 to 40 a deal against the owner's 0 (invariant 39) and every
 * world broke the hours limit — correct, but named as a money-or-hours
 * failure. The quant portfolio never read hours at all, so the same opening
 * counted toward its reach as if somebody worked it for free.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { everyCaseInfeasible, readGoalPlan } from '../server/services/goals/plan.ts';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

const fixed = (value: number, provenance: ModelInput['provenance'] = 'EVIDENCE'): ModelInput => ({ value, low: value, high: value, provenance, source: null, note: '' });
const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });

function opening(id: string, over: Partial<ModelledOpportunity> = {}, index = 1): ModelledOpportunity {
  return {
    opportunity: { id, title: `Opening ${id}` } as ModelledOpportunity['opportunity'],
    index,
    tier: 'QUALIFIED',
    repeatable: false,
    price: fixed(15_000),
    capital: fixed(15),
    hours: fixed(0),
    daysToCash: fixed(3),
    close: fixed(0.9),
    respond: fixed(1),
    directCost: fixed(3),
    volume: fixed(1),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  };
}

const limits = { remaining: 10_000, daysLeft: 18, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: null, worlds: 800, seed: 7 };

describe('the quant portfolio reads the owner hours the gate reads', () => {
  it('refuses an opening with no performer established against a goal with no owner hours, and counts none of its reach', () => {
    const result = evaluateGoalPortfolio({ ...limits, hours: 0, openings: [opening('nobody', { hours: swept(1, 40) })] });
    const d = result.demand[0]!;
    expect(d.refused).toMatch(/no performer is established/);
    expect(d.refused).toMatch(/0 owner hours this goal has/);
    expect(result.best?.members.map((m) => m.opportunityId) ?? []).not.toContain('nobody');
    expect(result.best?.reach ?? 0).toBe(0);
  });

  it('keeps an opening whose performer is established (0 owner hours), and bounds nothing when the goal states no hours', () => {
    const performed = evaluateGoalPortfolio({ ...limits, hours: 0, openings: [opening('brain')] });
    expect(performed.demand[0]!.refused).toBeNull();
    expect(performed.best?.members.map((m) => m.opportunityId)).toContain('brain');
    const unstated = evaluateGoalPortfolio({ ...limits, hours: null, openings: [opening('nobody', { hours: swept(1, 40) })] });
    expect(unstated.demand[0]!.refused).toBeNull();
  });

  it('says a repeatable play contacts nobody because its money settles too late, not because outreach is missing', () => {
    const result = evaluateGoalPortfolio({
      ...limits,
      hours: null,
      openings: [opening('slow', { repeatable: true, volume: swept(1, 200), daysToCash: swept(8, 32), respond: fixed(0.05), close: fixed(0.2) })],
    });
    const d = result.demand[0]!;
    expect(d.contacted.p90).toBe(0);
    expect(d.noContactBecause).toMatch(/settles in time: days to usable cash reads at least 20 \(not established/);
    const fast = evaluateGoalPortfolio({ ...limits, hours: null, openings: [opening('fast', { repeatable: true, volume: swept(1, 200), daysToCash: fixed(3), respond: fixed(0.05), close: fixed(0.2) })] });
    expect(fast.demand[0]!.noContactBecause).toBeUndefined();
  });
});

describe('a strategy that breaks a limit in every case names the limit', () => {
  const target = { hoursCeiling: 0, capitalCeilingCents: 300_000, currency: 'USD' };
  const member = { one: opening('nobody', { hours: swept(1, 40) }), deals: 1 };

  it('names the missing performer when the hours limit broke in every case', () => {
    const reasons = everyCaseInfeasible({ hours: 500 }, 500, [member], target);
    expect(reasons.join(' ')).toMatch(/no performer is established for "Opening nobody".*1–40 owner hours a deal, against the 0 owner hours this goal has/);
    expect(reasons.join(' ')).not.toMatch(/money/);
  });

  it('names the money limit only when it is the one broken, and keeps the generic sentence when the run does not say', () => {
    expect(everyCaseInfeasible({ capital: 500 }, 500, [member], target)).toEqual(['ties up more than the 3000 USD the owner said this goal may commit in every tested case']);
    expect(everyCaseInfeasible({ hours: 250, capital: 250 }, 500, [member], target)).toEqual(['breaks the money or hours limit in every tested case']);
    expect(everyCaseInfeasible(undefined, 500, [member], target)).toEqual(['breaks the money or hours limit in every tested case']);
  });
});

describe('the production journey: a $15 one-off with nobody to do it, against 0 owner hours', () => {
  let projectId = '';
  let userId = '';
  let cashModeId = '';
  const now = new Date();
  const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `np-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    cashModeId = (await getCashMode(projectId))!.id;
  });

  async function fact(o: CashOpportunity, field: string, value: string): Promise<void> {
    await recordCardFact({ projectId, opportunityId: o.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${o.id}`, decidedBy: 'BRAIN' });
  }

  it('fails every strategy on the missing performer, never on money it does not tie up', async () => {
    const o = await createOpportunity({
      projectId,
      cashModeId,
      ownerUserId: userId,
      title: 'Brokerage request for information',
      mechanism: 'SUPPLY_DEMAND_MISMATCH',
      currency: 'USD',
      sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`,
      opportunitySignal: 'PAID_TASK_OR_CONTRACT',
      source: 'A publisher',
      requiredCapabilities: [],
    });
    await fact(o, CAPTURE_KEY, 'Answer the request for a fee.');
    await fact(o, 'payer', 'The district');
    await updateOpportunity(o.id, {
      payer: 'The district',
      price_cents: 1_500,
      offer_scope: 'Answer one request',
      reachable_channel: 'The posted contact',
      buying_signal: 'Posted this week',
      signal_observed_at: inDays(-2),
      peak_funding_cents: 1_498,
      human_hours: null,
      fulfillment_owner: null,
    });
    await fact(o, 'price', '$15');
    await fact(o, 'timeToFirstCash', '3 days');
    await fact(o, 'directCosts', '$3');
    await fact(o, 'exposure', '$14.98');

    const g = await createWorkstream({ projectId, title: 'Collect $10K within 30 days', intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(18), ownerUserId: userId }, `person:${userId}`);
    const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId, capitalCeilingCents: 300_000, hoursCeiling: 0, now: new Date(now.getTime() - 60_000) });
    expect(set.ok).toBe(true);

    const reading = (await readGoalPlan({ goalId: g.id, evaluations: 2_000 }))!;
    const only = reading.strategies.find((one) => one.opportunityIds.includes(o.id))!;
    expect(only.sweep.infeasibleShare).toBe(1);
    expect(only.constraintsFailed.join(' ')).toMatch(/no performer is established for "Brokerage request for information"/);
    expect(only.constraintsFailed.join(' ')).not.toMatch(/breaks the money or hours limit/);
    // The quant engine that the reconstruction's sensitivity reads refuses it for the same reason, so no lever claims reach from it.
    const demand = reading.portfolio?.demand.find((one) => one.opportunityId === o.id);
    expect(demand?.refused).toMatch(/no performer is established/);
    expect(reading.portfolio?.best?.members.map((m) => m.opportunityId) ?? []).not.toContain(o.id);
  }, 120_000);
});
