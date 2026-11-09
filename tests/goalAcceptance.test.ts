/**
 * The owner's acceptance rule for a cash goal (2026-11-09): a plan meets the
 * objective only with a defensible probability of at least 90% of collecting
 * the target before the deadline. Everything else — the $900 agency package,
 * a complete chain read at cautious point numbers, coverage of tested
 * conditions — is a candidate, pursued and improved, never accepted.
 */
import { describe, expect, it } from 'vitest';
import { judgeAcceptance, RECOMMENDATION_POLICY, type StrategyReading } from '../server/services/goals/plan.ts';
import { pathwayOf, transactionShapes } from '../server/services/goals/pathways.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

function portfolio(input: { basis: 'PROBABILITY' | 'COVERAGE'; reach: number; ids?: string[]; worlds?: number }): GoalPortfolio {
  const ids = input.ids ?? ['cop_agency'];
  return {
    basis: input.basis,
    worlds: input.worlds ?? 2_000,
    best: { members: ids.map((id) => ({ opportunityId: id, title: `White-label articles (${id})`, share: 1 })), reach: input.reach, settledP10: 2_000, settledP50: 5_400, settledP90: 10_800, capitalShort: 0, overSpend: 0 },
    alternatives: [],
    demand: [],
    limits: { target: 10_000, deadlineDays: 18, startingCapital: 750, perArrangement: 375, spendCeiling: 3_000, contactsPerDay: { value: null, low: 10, high: 60, source: 'not stated; swept' }, correlation: 0.5 },
    missing: input.basis === 'COVERAGE' ? ['White-label articles: reply rate, close rate not established'] : [],
    searched: 1,
  };
}

function strategy(over: Partial<StrategyReading> = {}): StrategyReading {
  return {
    key: 'only_agency',
    label: 'White-label article packs to agencies',
    verdict: 'NEEDS_EVIDENCE',
    opportunityIds: ['cop_agency'],
    links: [],
    constraintsFailed: [],
    sweep: { goalMetShare: 0.6, settledP50: 5_400, settledP90: 10_800, infeasibleShare: 0, probabilistic: false },
    conservativeSettled: null,
    chainComplete: false,
    nextTest: null,
    ...over,
  };
}

const complete = [{ opportunityId: 'cop_agency', missing: [] as never[] }];

describe('the acceptance rule', () => {
  it('holds the bar at 90%, set in code and not by a plan', () => {
    expect(RECOMMENDATION_POLICY.requiredProbability).toBe(0.9);
  });

  it('keeps the $900 agency package a candidate: its conversion is assumed, so its reach is coverage', () => {
    const a = judgeAcceptance({ achieved: false, chosen: strategy(), portfolio: portfolio({ basis: 'COVERAGE', reach: 0.95 }), measuredChance: null, considered: [{ opportunityId: 'cop_agency', missing: ['CONVERSION'] }] });
    expect(a.status).toBe('CANDIDATE_ONLY');
    expect(a.accepted).toBeNull();
    expect(a.probability).toBeNull();
    // Coverage of 95% is not presented as confidence.
    expect(a.candidate).toMatchObject({ source: 'QUANT_PORTFOLIO', reach: 0.95, reachBasis: 'COVERAGE' });
    expect(a.shortfalls.join(' ')).toMatch(/coverage of assumed inputs, not a probability/);
    expect(a.sentence).toMatch(/^NOT ACCEPTED/);
    expect(a.sentence).toMatch(/coverage, not a probability/);
  });

  it('reads an evidenced probability at its lower bound: 91% of 2000 worlds is not a defensible 90%', () => {
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: portfolio({ basis: 'PROBABILITY', reach: 0.905 }), measuredChance: null, considered: complete });
    expect(a.status).toBe('CANDIDATE_ONLY');
    expect(a.shortfalls.join(' ')).toMatch(/lower bound .* under the required 90%/);
  });

  it('accepts an all-evidence combination whose lower bound clears 90%', () => {
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: portfolio({ basis: 'PROBABILITY', reach: 0.96 }), measuredChance: null, considered: complete });
    expect(a.status).toBe('ACCEPTED');
    expect(a.probability).toMatchObject({ basis: 'EVIDENCED_PORTFOLIO', sample: 2_000 });
    expect(a.probability!.lowerBound).toBeGreaterThanOrEqual(0.9);
    expect(a.accepted!.opportunityIds).toEqual(['cop_agency']);
  });

  it('does not accept an evidenced combination whose member still misses a link', () => {
    const a = judgeAcceptance({ achieved: false, chosen: null, portfolio: portfolio({ basis: 'PROBABILITY', reach: 0.99 }), measuredChance: null, considered: [{ opportunityId: 'cop_agency', missing: ['FULFILMENT'] }] });
    expect(a.status).toBe('CANDIDATE_ONLY');
    expect(a.shortfalls.join(' ')).toMatch(/chain is incomplete/);
  });

  it('a complete chain at cautious numbers is a qualified candidate, not acceptance', () => {
    const a = judgeAcceptance({ achieved: false, chosen: strategy({ chainComplete: true, conservativeSettled: 12_000 }), portfolio: null, measuredChance: null, considered: complete });
    expect(a.status).toBe('CANDIDATE_ONLY');
    expect(a.candidate).toMatchObject({ source: 'STRATEGY', settledP50: 12_000 });
    expect(a.shortfalls.join(' ')).toMatch(/point reading, not a 90% probability/);
  });

  it("accepts a complete chain on this Brain's own record only when that record's lower bound clears 90%", () => {
    const chosen = strategy({ chainComplete: true });
    const weak = { estimate: 0.9, lowerBound: 0.6, upperBound: 0.98, sampleSize: 10, cohort: 'accepted plans' };
    expect(judgeAcceptance({ achieved: false, chosen, portfolio: null, measuredChance: weak, considered: complete }).status).toBe('CANDIDATE_ONLY');
    const strong = { estimate: 1, lowerBound: 0.91, upperBound: 1, sampleSize: 40, cohort: 'accepted plans' };
    const a = judgeAcceptance({ achieved: false, chosen, portfolio: null, measuredChance: strong, considered: complete });
    expect(a.status).toBe('ACCEPTED');
    expect(a.probability?.basis).toBe('MEASURED_RECORD');
    // The record alone never accepts a plan whose chain is not complete.
    expect(judgeAcceptance({ achieved: false, chosen: strategy(), portfolio: null, measuredChance: strong, considered: complete }).status).toBe('CANDIDATE_ONLY');
  });

  it('accepts on the ledger once the target is collected', () => {
    expect(judgeAcceptance({ achieved: true, chosen: null, portfolio: null, measuredChance: null, considered: [] }).probability?.basis).toBe('TARGET_MET');
  });

  it('says NO_CANDIDATE when nothing can be pursued yet', () => {
    expect(judgeAcceptance({ achieved: false, chosen: null, portfolio: null, measuredChance: null, considered: [] }).status).toBe('NO_CANDIDATE');
  });
});

describe('a business model is not frozen at one transaction size', () => {
  it('compares unit, bundle, retainer and implementation on cash collectible before the deadline', () => {
    const shapes = transactionShapes({ unitPrice: 90, unitCost: 9, remaining: 10_000, daysLeft: 18, daysToCash: 9 });
    expect(shapes.map((one) => one.kind).sort()).toEqual(['BUNDLE', 'IMPLEMENTATION', 'RETAINER', 'UNIT']);
    // Ranked by what one transaction collects in time.
    for (let i = 1; i < shapes.length; i += 1) expect(shapes[i - 1]!.collectible).toBeGreaterThanOrEqual(shapes[i]!.collectible);
    const unit = shapes.find((one) => one.kind === 'UNIT')!;
    expect(unit.collectible).toBe(81);
    expect(shapes[0]!.dealsForGap).toBeLessThan(unit.dealsForGap);
  });

  it('counts only the retainer months billed before the deadline', () => {
    const short = transactionShapes({ unitPrice: 100, unitCost: 0, remaining: 10_000, daysLeft: 20, daysToCash: 3 }).find((one) => one.kind === 'RETAINER')!;
    const long = transactionShapes({ unitPrice: 100, unitCost: 0, remaining: 10_000, daysLeft: 70, daysToCash: 3 }).find((one) => one.kind === 'RETAINER')!;
    expect(long.collectible).toBeGreaterThan(short.collectible);
    expect(short.collectible).toBeCloseTo(100 * 4 * 0.85);
  });

  it('collects nothing from any size when the cash settles after the deadline', () => {
    expect(transactionShapes({ unitPrice: 100, unitCost: 0, remaining: 10_000, daysLeft: 10, daysToCash: 30 }).every((one) => one.collectible === 0)).toBe(true);
  });

  it('constructs the other sizes on a priced pathway that cannot carry the gap alone', () => {
    const evidence = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: 'a gated claim' });
    const unknown = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'swept' });
    const o = {
      id: 'cop_agency', projectId: 'prj_1', title: 'White-label SEO article for a marketing agency', mechanism: 'PRODUCTIZED_SERVICE', industry: null,
      payer: 'US digital-marketing agencies', reachableChannel: 'agency directory', buyingSignal: 'agencies resell content', signalObservedAt: null,
      offerScope: 'one 1,500-word article', priceCents: 9_000, currency: 'USD', fulfillmentOwner: 'Brain', economicsNote: null, expiresAt: null,
      requiredCapabilities: [], opportunitySignal: null, state: 'EVIDENCE_CARD',
    } as unknown as CashOpportunity;
    const one: ModelledOpportunity = {
      opportunity: o, index: 1, tier: 'CANDIDATE', repeatable: true, price: evidence(90), capital: evidence(0), hours: unknown(1, 2), daysToCash: evidence(9),
      close: unknown(0.02, 0.5), respond: unknown(0.002, 0.15), directCost: evidence(9), volume: unknown(1, 200), agreed: false, agreedValue: 0, agreedDeals: 0,
      fulfilledBy: { value: 'Brain produces it', provenance: 'EVIDENCE', source: null }, competitiveAward: false,
    } as unknown as ModelledOpportunity;
    const p = pathwayOf(one, null, { remaining: 10_000, daysLeft: 18, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: ['CONTACT_BUYER'], now: new Date('2026-11-09T00:00:00Z'), capabilities: null });
    const move = p.moves.find((m) => m.gap === 'ONE_TRANSACTION_SHAPE');
    expect(move?.action).toBe('CONSTRUCT');
    expect(move!.shapes!.length).toBe(4);
    expect(move!.ask).toMatch(/bundle, a monthly retainer, or an implementation/);
    // A missing contact permission blocks the send, not this construction.
    expect(move!.ask).not.toMatch(/CONTACT_BUYER/);
  });
});
