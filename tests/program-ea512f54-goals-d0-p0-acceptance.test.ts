/**
 * GOAL-02, GOAL-09 and OPP-04 of the Brain-architecture program, asserted
 * against the running code rather than a comment: a goal's own metric is the
 * only thing that counts toward it, a candidate is never an accepted plan,
 * execution of authorized offers does not wait on acceptance, and every input
 * of a transaction path is marked evidence-backed, estimated or unknown.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordMoney } from '../server/repos/cashLedger.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { readTarget, setTarget } from '../server/services/goals/target.ts';
import { executionPolicyForProject, forgetExecutionPolicies } from '../server/services/goals/policy.ts';
import { judgeAcceptance, RECOMMENDATION_POLICY, type StrategyReading } from '../server/services/goals/plan.ts';
import { pathwayOf } from '../server/services/goals/pathways.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
const key = () => `k${Math.random().toString(36).slice(2, 12)}`;

beforeEach(async () => {
  forgetExecutionPolicies();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `r01-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

async function goal(metric: string, amountCents: number, days = 30): Promise<string> {
  const g = await createWorkstream({ projectId, title: `Goal ${metric}`, intent: 'Reach the figure.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: inDays(days), ownerUserId: userId }, `person:${userId}`);
  const set = await setTarget({ goal: (await getWorkstream(g.id))!, metric, amountCents, currency: 'USD', projectId, now: new Date(now.getTime() - 60_000) });
  expect(set.ok).toBe(true);
  return g.id;
}

describe('GOAL-02: a goal keeps its own metric and deadline', () => {
  it('a settled-cash goal is not met by sales, agreements or payments still with the provider', async () => {
    const id = await goal('SETTLED_CASH', 100_000);
    await recordMoney({ projectId, kind: 'PIPELINE_AGREED', amountCents: 500_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key() });
    await recordMoney({ projectId, kind: 'CUSTOMER_PAYMENT', amountCents: 400_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key(), verifiedReference: 'pi_a' });
    const before = (await readTarget((await getWorkstream(id))!))!;
    expect(before.achievedCents).toBe(0);
    expect(before.achieved).toBe(false);
    expect(before.notCounted.map((one) => one.cents)).toEqual(expect.arrayContaining([500_000, 400_000]));
    await recordMoney({ projectId, kind: 'SETTLEMENT', amountCents: 100_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key(), verifiedReference: 'po_a' });
    expect((await readTarget((await getWorkstream(id))!))!.achieved).toBe(true);
  });

  it('two goals on one ledger each read their own metric and carry their own deadline', async () => {
    const settled = await goal('SETTLED_CASH', 100_000, 30);
    const collected = await goal('COLLECTED_CASH', 100_000, 90);
    await recordMoney({ projectId, kind: 'CUSTOMER_PAYMENT', amountCents: 100_000, currency: 'USD', recordedBy: 'PERSON', idempotencyKey: key(), verifiedReference: 'pi_b' });
    const a = (await readTarget((await getWorkstream(settled))!, now))!;
    const b = (await readTarget((await getWorkstream(collected))!, now))!;
    expect([a.metric, a.achieved]).toEqual(['SETTLED_CASH', false]);
    expect([b.metric, b.achieved]).toEqual(['COLLECTED_CASH', true]);
    expect(a.daysLeft).toBe(30);
    expect(b.daysLeft).toBe(90);
  });

  it('refuses an amount or figure it cannot count, and never reads an aspiration as a 90% claim', async () => {
    const g = await createWorkstream({ projectId, title: 'g', intent: 'g', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const goalRow = (await getWorkstream(g.id))!;
    expect((await setTarget({ goal: goalRow, metric: 'ENTERPRISE_VALUE', amountCents: 1, currency: 'USD', projectId })).ok).toBe(false);
    expect((await setTarget({ goal: goalRow, metric: 'SETTLED_CASH', amountCents: 0, currency: 'USD', projectId })).ok).toBe(false);
    // An aspirational reading (coverage of tested conditions) stays a candidate however high it is.
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: portfolio({ basis: 'COVERAGE', reach: 1 }), measuredChance: null, considered: [{ opportunityId: 'cop_x', missing: [] }] });
    expect(a.status).toBe('CANDIDATE_ONLY');
  });
});

function portfolio(input: { basis: 'PROBABILITY' | 'COVERAGE'; reach: number; worlds?: number }): GoalPortfolio {
  return {
    basis: input.basis,
    worlds: input.worlds ?? 2_000,
    best: { members: [{ opportunityId: 'cop_x', title: 'An offer', share: 1 }], reach: input.reach, settledP10: 1, settledP50: 2, settledP90: 3, capitalShort: 0, overSpend: 0 },
    alternatives: [],
    demand: [],
    limits: { target: 10_000, deadlineDays: 18, startingCapital: 750, perArrangement: 375, spendCeiling: 3_000, contactsPerDay: { value: null, low: 10, high: 60, source: 'not stated; swept' }, correlation: 0.5 },
    missing: input.basis === 'COVERAGE' ? ['reply rate, close rate not established'] : [],
    searched: 1,
    // The engine's own assurance over the smallest real sample (C-7): an evidenced reach of at least 96% carries a defensible 90%.
    ...(input.basis === 'PROBABILITY' && input.reach >= 0.96
      ? { assurance: { status: 'CLAIMS_AT_LEAST_90', claimsAtLeast90: true, range: { low: 0.91, high: 0.99 }, coverage: input.reach, validationProblems: [], tailSettledP10: null, reason: 'calibrated evidence (smallest sample 200) puts the lower bound at 91%, above 90%' } }
      : {}),
  };
}

function strategy(over: Partial<StrategyReading> = {}): StrategyReading {
  return {
    key: 's', label: 'A promising package', verdict: 'NEEDS_EVIDENCE', opportunityIds: ['cop_x'], links: [], constraintsFailed: [],
    sweep: { goalMetShare: 0.99, settledP50: 12_000, settledP90: 20_000, infeasibleShare: 0, probabilistic: false }, conservativeSettled: 12_000, chainComplete: true, nextTest: null, ...over,
  };
}

describe('GOAL-09: a candidate is never an accepted plan, and work continues while planning is unproven', () => {
  const considered = [{ opportunityId: 'cop_x', missing: [] as never[] }];

  it('no hypothetical coverage, unmeasured conversion or complete-looking package is 90% proof', () => {
    expect(RECOMMENDATION_POLICY.requiredProbability).toBe(0.9);
    for (const reach of [0.9, 0.99, 1]) {
      const a = judgeAcceptance({ achieved: false, chosen: strategy(), portfolio: portfolio({ basis: 'COVERAGE', reach }), measuredChance: null, considered });
      expect(a.status).toBe('CANDIDATE_ONLY');
      expect(a.accepted).toBeNull();
      expect(a.probability).toBeNull();
    }
    // A package whose chain is complete at cautious point numbers is still only a candidate.
    const point = judgeAcceptance({ achieved: false, chosen: strategy(), portfolio: null, measuredChance: null, considered });
    expect(point.status).toBe('CANDIDATE_ONLY');
    expect(point.candidate).not.toBeNull();
    expect(point.accepted).toBeNull();
  });

  it('says plainly that there is too little history to calibrate, and keeps improving the candidate', () => {
    const a = judgeAcceptance({ achieved: false, chosen: strategy(), portfolio: null, measuredChance: null, considered });
    expect(a.shortfalls.join(' ')).toMatch(/too few finished accepted plans/);
    expect(a.sentence).toMatch(/^NOT ACCEPTED/);
    expect(a.sentence).toMatch(/keeps constructing/);
  });

  it('accepts only a defensible probability, and keeps candidate and accepted plan as separate fields', () => {
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: portfolio({ basis: 'PROBABILITY', reach: 0.97 }), measuredChance: null, considered });
    expect(a.status).toBe('ACCEPTED');
    expect(a.probability!.lowerBound).toBeGreaterThanOrEqual(0.9);
    expect(a.accepted).not.toBeNull();
    expect(a.candidate).not.toBeNull();
  });

  it('execution policy follows the goal rows, so authorized offers are pursued while no plan is accepted', async () => {
    expect(await executionPolicyForProject(projectId, now)).toBe('EVIDENCE_FIRST');
    await goal('SETTLED_CASH', 1_000_000);
    forgetExecutionPolicies();
    expect(await executionPolicyForProject(projectId, now)).toBe('SQUEEZE');
    // The policy takes no acceptance input at all: an unproven plan cannot switch it off.
    expect(executionPolicyForProject.length).toBeLessThanOrEqual(2);
  });
});

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

describe('OPP-04: every input of a transaction path is marked, and an unknown is not read as favourable', () => {
  const ctx = { remaining: 10_000, daysLeft: 18, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: [] as string[], now, capabilities: null };

  it('marks each fact PROVEN, ESTIMATED, UNKNOWN or DENIED and counts them', () => {
    const p = pathwayOf(opening(), null, ctx);
    const facts = [p.buyer, p.motivation, p.channel, p.offer, p.fulfiller, p.revenuePerDeal, p.acquisitionCost, p.fulfilmentCost, p.net, p.conversion, p.volume, p.frequency, p.daysToCash, p.capital, p.rights, p.capacity];
    for (const f of facts) {
      expect(['PROVEN', 'ESTIMATED', 'UNKNOWN', 'DENIED']).toContain(f.status);
      expect(f.basis.length).toBeGreaterThan(0);
    }
    expect(p.counts.proven + p.counts.estimated + p.counts.unknown).toBeGreaterThanOrEqual(14);
    expect(p.counts.proven).toBeGreaterThan(0);
  });

  it('an unmeasured conversion and an unknown volume stay UNKNOWN or ESTIMATED with a range, never PROVEN', () => {
    const p = pathwayOf(opening(), null, ctx);
    expect(p.conversion.status).not.toBe('PROVEN');
    expect(p.volume.status).not.toBe('PROVEN');
    expect(p.volume.value).toBeNull();
  });

  it('a priced path with a missing component is still a partial arrangement with a move to learn or supply it', () => {
    const p = pathwayOf(opening({ volume: unknown(1, 200) }), { missing: ['MARKET_VOLUME'], paysOnce: false, competitiveAward: false, volumeEstablished: false }, ctx);
    expect(p.moves.length).toBeGreaterThan(0);
    expect(p.moves.every((m) => ['SELL', 'RESEARCH', 'CONSTRUCT'].includes(m.action))).toBe(true);
  });

  it('slow cash prompts a structurally different move rather than dropping the path', () => {
    const p = pathwayOf(opening({ daysToCash: evidence(40) }), null, ctx);
    expect(p.gaps).toContain('SLOW_OR_UNKNOWN_CASH');
    expect(p.moves.length).toBeGreaterThan(0);
  });
});
