/**
 * The objective obeyed (2026-11-18): what a goal's words confine its plan to —
 * a monthly recurring run-rate and weekly hours, one named industry, an
 * up-front capital limit stated without a figure, a stake to put to work, and
 * the deadline — read from the words and carried to the plan's own inputs.
 * The whole chain is rehearsed in `objectiveRehearsal.test.ts`; these pin the parts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { listWorkstreamEvents } from '../server/repos/register.ts';
import { readObjective, readRequiredIndustry, LITTLE_CAPITAL_SHARE } from '../server/services/industry/construction/intent.ts';
import { createGoal } from '../server/services/goals/decide.ts';
import { goalScope, readTarget, RUN_RATE_DAYS } from '../server/services/goals/target.ts';
import { arrangementOutOfScope, namesIndustry, outOfGoalScope, recurringRevenue, type HeldTerms } from '../server/services/cash/goalScenario.ts';
import { stakeCycles } from '../server/services/goals/portfolio.ts';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import type { ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const NOW = new Date('2026-11-18T12:00:00.000Z');

describe('reading the objective', () => {
  it('reads a monthly recurring target and a weekly hours limit', () => {
    const r = readObjective('Earn $5,000 a month in recurring revenue within 60 days with no more than 10 hours a week of owner time.', NOW);
    expect(r).toMatchObject({ kind: 'CASH', amount: 5_000, recurring: 'MONTHLY', hoursPerWeek: 10, hoursCeiling: 86, deadlineHours: 60 * 24, capitalCeiling: null });
    expect(r.unread).toEqual([]);
    expect(readObjective('Make $5k MRR within 90 days', NOW)).toMatchObject({ amount: 5_000, recurring: 'MONTHLY' });
    expect(readObjective('Earn $5,000 in monthly recurring revenue within 90 days', NOW)).toMatchObject({ amount: 5_000, recurring: 'MONTHLY' });
  });

  it('still names what it cannot place: a money rate that is not recurring revenue, an hours rate with no window', () => {
    const rate = readObjective('Earn $1,000 a week', NOW);
    expect(rate.amount).toBeNull();
    expect(rate.unread.join(' ')).toMatch(/a rate/);
    const hours = readObjective('Make $10,000 with 10 hours a week', NOW);
    expect(hours.hoursPerWeek).toBeNull();
    expect(hours.unread.join(' ')).toMatch(/an hours rate/);
  });

  it('reads the one industry the words confine the work to, and only that', () => {
    expect(readRequiredIndustry('Generate $20,000 within 45 days in a single industry the owner names: commercial cleaning.')).toBe('commercial cleaning');
    expect(readRequiredIndustry('Make $10,000 in 30 days only in commercial cleaning')).toBe('commercial cleaning');
    expect(readRequiredIndustry('Make $10,000 in the dental billing industry only')).toBe('dental billing');
    expect(readRequiredIndustry('Collect $10,000 of settled cash within 30 days using little up-front capital.')).toBeNull();
    expect(readRequiredIndustry('Make $10,000 in 30 days only')).toBeNull();
  });

  it('reads "little up-front capital" as an assumed low figure, never as a stated ceiling', () => {
    const r = readObjective('Collect $10,000 of settled cash within 30 days using little up-front capital.', NOW);
    expect(r.capitalCeiling).toBeNull();
    expect(r.capitalAssumed).toMatchObject({ amount: 10_000 * LITTLE_CAPITAL_SHARE, phrase: 'little up-front capital' });
    // A stated figure wins, and nothing is assumed beside it.
    expect(readObjective('Make $10,000 in 30 days with at most $3,000 of capital and little up-front capital', NOW).capitalAssumed).toBeNull();
    // "No up-front capital" is a limit of nothing before money comes in, never no limit (metamorphic P6b, 2026-11-20).
    for (const words of ['Collect $15,000 within 30 days using no up-front capital.', 'Make $5,000 in 60 days with zero starting money', 'Make $5,000 within 30 days without any investment']) {
      expect(readObjective(words, NOW).capitalAssumed, words).toMatchObject({ amount: 0 });
    }
  });
});

describe('the goal scope reaches the plan', () => {
  const goal = (intent: string, target: Partial<{ capitalCeilingCents: number | null; capitalBeforeProofCents: number | null }> = {}) =>
    ({ intent, title: intent, target: { capitalCeilingCents: null, capitalBeforeProofCents: null, ...target } }) as never;

  it('derives the scope from the goal words, and a set figure overrides the assumption', () => {
    expect(goalScope(goal('Collect $10,000 of settled cash within 30 days using little up-front capital.'), NOW).capitalAssumed?.cents).toBe(100_000);
    expect(goalScope(goal('Collect $15,000 of settled cash within 30 days using no up-front capital.'), NOW).capitalAssumed?.cents).toBe(0);
    expect(goalScope(goal('Collect $10,000 of settled cash within 30 days using little up-front capital.', { capitalBeforeProofCents: 50_000 }), NOW).capitalAssumed).toBeNull();
    expect(goalScope(goal('Earn $5,000 a month in recurring revenue within 60 days.'), NOW)).toMatchObject({ recurring: 'MONTHLY', industry: null });
    expect(goalScope(goal('Generate $20,000 within 45 days in a single industry the owner names: commercial cleaning.'), NOW).industry).toBe('commercial cleaning');
  });

  it('leaves out an opening outside the named industry or one that pays once for a recurring target, and nothing else', () => {
    const cleaning = { industry: 'commercial cleaning', title: 'Office cleaning subcontract', payer: 'Property managers' };
    const dental = { industry: 'dental practices', title: 'Monthly bookkeeping retainer', payer: 'Dentists' };
    const scope = { recurring: null, industry: 'commercial cleaning', hoursPerWeek: null, capitalAssumed: null };
    expect(outOfGoalScope(scope, cleaning, false)).toBeNull();
    expect(outOfGoalScope(scope, dental, true)).toMatch(/outside the one industry/);
    const recurring = { recurring: 'MONTHLY' as const, industry: null, hoursPerWeek: null, capitalAssumed: null };
    expect(outOfGoalScope(recurring, dental, true)).toBeNull();
    expect(outOfGoalScope(recurring, cleaning, false)).toMatch(/pays once/);
    expect(outOfGoalScope(undefined, dental, false)).toBeNull();
    expect(namesIndustry('commercial cleaning', 'Commercial office cleaning for property managers')).toBe(true);
    expect(namesIndustry('commercial cleaning', 'Vendor-compliance spreadsheet')).toBe(false);
    expect(recurringRevenue('$900 a month', 'Bookkeeping')).toBe(true);
    expect(recurringRevenue('$600', 'Compliance spreadsheet')).toBe(false);
  });

  it('judges a constructed arrangement by what it sells: its recurrence, its days to cash and the money it ties up', () => {
    const held = new Map<string, HeldTerms>([
      ['opp_resale', { industry: 'restaurant equipment', title: 'Resale of kitchen equipment', recurring: false, days: 21, capital: 8_000 }],
      ['opp_retainer', { industry: 'dental practices', title: 'Monthly bookkeeping retainer', recurring: true, days: 30, capital: null }],
    ]);
    const arrangement = (need: string, repeat: 'ONE_OFF' | 'SUBSCRIPTION', base = 'PRODUCE') =>
      ({ label: 'Constructed', sector: null, demand: { name: 'buyers', from: 'OPENING', ref: need }, need: { name: 'it', from: 'OPENING', ref: need }, supply: null, design: { base, funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat } }) as unknown as ConstructedArrangement;
    const recurring = { recurring: 'MONTHLY' as const, industry: null, hoursPerWeek: null, capitalAssumed: null };
    // A one-off's design renamed a subscription evidences nothing about its buyers paying monthly.
    expect(arrangementOutOfScope(recurring, arrangement('opp_resale', 'SUBSCRIPTION'), held)).toMatch(/does not recur/);
    expect(arrangementOutOfScope(recurring, arrangement('opp_retainer', 'ONE_OFF'), held)).toBeNull();
    expect(arrangementOutOfScope(undefined, arrangement('opp_resale', 'ONE_OFF'), held, 7)).toMatch(/takes 21 days/);
    expect(arrangementOutOfScope(undefined, arrangement('opp_resale', 'ONE_OFF'), held, 30, 1_000)).toMatch(/ties up 8000/);
    // A supplier delivers a brokered need: its lot is not this goal's money.
    expect(arrangementOutOfScope(undefined, arrangement('opp_resale', 'ONE_OFF', 'BROKER'), held, 30, 1_000)).toBeNull();
  });

  it('puts a stated stake to work: a capital-using line turns the stake over inside the window', () => {
    const line = { repeatable: true, agreedValue: 0, capital: { value: 8_000, low: null, high: null, provenance: 'EVIDENCE' }, directCost: { value: 8_000, low: null, high: null, provenance: 'EVIDENCE' }, daysToCash: { value: 21, low: null, high: null, provenance: 'EVIDENCE' } } as unknown as ModelledOpportunity;
    expect(stakeCycles(line, { amount: 8_000, established: true }, 10_000, 90)).toEqual({ lots: 1, cycles: 4, deals: 4, tiedUp: 8_000 });
    expect(stakeCycles(line, { amount: 8_000, established: true }, 1_000, 90)).toBeNull();
    expect(stakeCycles(line, { amount: 8_000, established: true }, null, 90)).toBeNull();
    expect(stakeCycles({ ...line, repeatable: false } as ModelledOpportunity, { amount: 8_000, established: true }, 10_000, 90)).toBeNull();
    // Money tied up beside a cheaper deal is not spent by selling, so nothing turns over.
    expect(stakeCycles({ ...line, directCost: { value: 10, low: null, high: null, provenance: 'EVIDENCE' } } as unknown as ModelledOpportunity, { amount: 60, established: true }, 3_000, 24)).toBeNull();
  });
});

describe('a recurring goal from words', () => {
  let projectId = '';
  let userId = '';
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `scope-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  });

  it('is a monthly run-rate target with its hours limit, counted over the trailing month', async () => {
    const made = await createGoal({ projectId, objective: 'Earn $5,000 a month in recurring revenue within 60 days with no more than 10 hours a week of owner time.', actorRef: 'person:test', userId, now: NOW });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.goal.target).toMatchObject({ metric: 'SETTLED_CASH', amountCents: 500_000, hoursCeiling: 86, capitalCeilingCents: null });
    expect(made.goal.outcome).toMatch(/monthly recurring run-rate/);
    const set = (await listWorkstreamEvents(made.goal.id)).find((e) => e.kind === 'GOAL_TARGET_SET')!;
    expect(set.summary).toMatch(/a month/);
    expect(set.detail).toMatchObject({ recurring: 'MONTHLY', hoursPerWeek: 10 });
    const later = new Date(NOW.getTime() + 45 * 86_400_000);
    const reading = (await readTarget(made.goal, later))!;
    expect(reading.scope).toMatchObject({ recurring: 'MONTHLY', hoursPerWeek: 10 });
    expect(reading.since).toBe(new Date(later.getTime() - RUN_RATE_DAYS * 86_400_000).toISOString());
  });

  it('plans "little up-front capital" at the assumed figure as its before-proof limit, and stores no figure', async () => {
    const made = await createGoal({ projectId, objective: 'Collect $10,000 of settled cash within 30 days using little up-front capital.', actorRef: 'person:test', userId, now: NOW });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.goal.target).toMatchObject({ capitalCeilingCents: null, capitalBeforeProofCents: null });
    const reading = (await readTarget(made.goal, NOW))!;
    expect(reading.capitalBeforeProofCents).toBe(100_000);
    expect(reading.capitalCeilingCents).toBeNull();
    expect(reading.scope?.capitalAssumed).toMatchObject({ cents: 100_000, phrase: 'little up-front capital' });
  });
});
