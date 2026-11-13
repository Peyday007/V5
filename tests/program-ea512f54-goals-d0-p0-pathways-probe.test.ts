/**
 * OPP-04: probe r01.opp-04 judges the pathways the goal screens read. Every input is marked,
 * an unknown never states a number, an estimate needs a range, and a reach shortfall is met
 * with a move that changes the channel. It fails when there is nothing to look at.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { pathwayOf, type PathFact } from '../server/services/goals/pathways.ts';
import { factProblem, pathwayProblem } from '../server/services/factory/program/release01/pathwaysProbe.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

const now = new Date();
const ctx = { remaining: 10_000, daysLeft: 18, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: [] as string[], now, capabilities: null };
const evidence = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: 'a gated claim' });
const unknown = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'swept' });

function opening(over: Record<string, unknown> = {}): ModelledOpportunity {
  const o = {
    id: 'cop_x', projectId: 'prj_1', title: 'A monthly report for property managers', mechanism: 'PRODUCTIZED_SERVICE', industry: null,
    payer: 'Property managers', reachableChannel: 'published business email', buyingSignal: 'posted asking for it', signalObservedAt: null,
    offerScope: 'one report', priceCents: 9_000, currency: 'USD', fulfillmentOwner: 'Brain', economicsNote: null, expiresAt: null,
    requiredCapabilities: [], opportunitySignal: null, state: 'EVIDENCE_CARD',
  } as unknown as CashOpportunity;
  return {
    opportunity: o, index: 1, tier: 'CANDIDATE', repeatable: true, price: evidence(90), capital: evidence(0), hours: unknown(1, 2), daysToCash: evidence(9),
    close: unknown(0.02, 0.5), respond: unknown(0.002, 0.15), directCost: evidence(9), volume: unknown(1, 200), agreed: false, agreedValue: 0, agreedDeals: 0,
    fulfilledBy: { value: 'Brain produces it', provenance: 'EVIDENCE', source: null }, competitiveAward: false, ...over,
  } as unknown as ModelledOpportunity;
}

describe('factProblem (pure)', () => {
  const fact = (over: Partial<PathFact>): PathFact => ({ value: 1, low: 1, high: 1, status: 'PROVEN', basis: 'a row', ...over });

  it('accepts a marked fact and refuses each way of passing an assumption off as one', () => {
    expect(factProblem('x', fact({}))).toBeNull();
    expect(factProblem('x', fact({ status: 'UNKNOWN', value: null, low: 1, high: 200 }))).toBeNull();
    expect(factProblem('x', fact({ status: 'ESTIMATED', value: null, low: 1, high: 5 }))).toBeNull();
    expect(factProblem('x', fact({ status: 'UNKNOWN', value: 0.5 }))).toMatch(/unknown yet states the value/);
    expect(factProblem('x', fact({ status: 'ESTIMATED', value: null, low: null, high: null }))).toMatch(/without a value or a range/);
    expect(factProblem('x', fact({ status: 'PROVEN', value: null }))).toMatch(/proven without a value/);
    expect(factProblem('x', fact({ basis: ' ' }))).toMatch(/without a basis/);
    expect(factProblem('x', fact({ status: 'GUESSED' as never }))).toMatch(/not marked/);
    expect(factProblem('x', fact({ status: 'ESTIMATED', value: null, low: 9, high: 2 }))).toMatch(/low exceeds its high/);
    expect(factProblem('x', null)).toMatch(/not marked/);
  });
});

describe('pathwayProblem on pathways the code builds', () => {
  it('finds nothing wrong with a pathway built from an opening, with or without a missing permission', () => {
    expect(pathwayProblem(pathwayOf(opening(), null, ctx))).toBeNull();
    expect(pathwayProblem(pathwayOf(opening(), null, { ...ctx, permissionsMissing: ['CONTACT_BUYER'] }))).toBeNull();
    expect(pathwayOf(opening(), null, { ...ctx, permissionsMissing: ['CONTACT_BUYER'] }).rights.status).toBe('DENIED');
  });

  it('never calls delivery capacity an estimate when nothing gives it a range', () => {
    const p = pathwayOf(opening(), null, ctx);
    expect(p.capacity.status).toBe('UNKNOWN');
    expect(p.capacity.value).toBeNull();
    expect(p.capacity.basis).toMatch(/not yet measured|nobody is named/);
  });

  it('names a reach shortfall and answers it with a channel-changing move', () => {
    const p = pathwayOf(opening({ price: evidence(9), directCost: evidence(1) }), null, { ...ctx, remaining: 1_000_000, outreachPerDay: 5 });
    if (p.fit.lever.variable === 'CHANNEL') {
      expect(p.gaps).toContain('REACH_SHORTFALL');
      expect(p.moves.some((m) => m.gap === 'REACH_SHORTFALL' && m.action === 'CONSTRUCT')).toBe(true);
    }
    expect(pathwayProblem(p)).toBeNull();
  });

  it('refuses a pathway that is broken in each way it checks', () => {
    const base = pathwayOf(opening(), null, ctx);
    expect(pathwayProblem({ ...base, volume: { ...base.volume, status: 'UNKNOWN', value: 100 } })).toMatch(/volume is unknown yet states/);
    expect(pathwayProblem({ ...base, counts: { proven: 0, estimated: 0, unknown: 3 } })).toMatch(/fact tally/);
    expect(pathwayProblem({ ...base, gaps: [...base.gaps, 'REACH_SHORTFALL'], moves: [] })).toMatch(/no move that changes the channel/);
    expect(pathwayProblem({ ...base, fit: { ...base.fit, lever: { variable: 'CHANNEL', change: 'x' } }, gaps: [] })).toMatch(/shortfall is not named/);
  });
});

describe('probe r01.opp-04 on rows', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('is registered once pathways are loaded', () => {
    expect(getProbe('r01.opp-04')).not.toBeNull();
  });

  it('fails with no live goal, and with a live goal that has no pathway, rather than passing on nothing', async () => {
    const none = await getProbe('r01.opp-04')!({});
    expect(none.ok).toBe(false);
    expect(none.detail).toMatch(/no live goal/);

    const { project } = await freshProject();
    const userId = (await createUser({ email: `o4-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    const g = await createWorkstream({ projectId: project.id, title: 'Goal', intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId: project.id, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
    const empty = await getProbe('r01.opp-04')!({});
    expect(empty.detail).toMatch(/none has a pathway|could not be read/);
    expect(empty.ok).toBe(/could not be read/.test(empty.detail) ? null : false);
  });

  it('is UNKNOWN, never FAIL, when a live goal\'s plan cannot be read (production 2026-11-12: pool exhausted)', async () => {
    const { project } = await freshProject();
    const userId = (await createUser({ email: `o4u-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    const g = await createWorkstream({ projectId: project.id, title: 'Goal', intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000, currency: 'USD', projectId: project.id, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
    const plan = await import('../server/services/goals/plan.ts');
    const spy = vi.spyOn(plan, 'readGoalPlan').mockRejectedValue(new Error('The database pool had no free connection within 10000ms'));
    try {
      const r = await getProbe('r01.opp-04')!({});
      expect(r.ok).toBeNull();
      expect(r.detail).toMatch(/could not be read .*pool/);
    } finally {
      spy.mockRestore();
    }
  });
});
