/**
 * Days to cash comes from the design's own payment structure first, and from
 * comparables only where the structure does not settle it.
 *
 * Production plan run 44826035355 (goal wst_7b4f, "Collect $10K within 30
 * days", 19 days left): every constructed design's days to cash was inferred
 * from the project's own time-to-first-cash records, government award cycles
 * among them — a long-tailed range the engine reads no better than its centre
 * (portfolio.ts `sampler`, E4a), so every design read ~200 days and none could
 * settle inside 19. For a design Brain produces and sells prepaid, an award's
 * wait is a mismatched comparable: cash is the time to agree plus the payment
 * provider's payout, an assumption named as such, never evidence.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import { AGREE_DAYS, estimatedFromArrangement, structuralDaysToCash } from '../server/services/cash/goalScenario.ts';
import { PROVIDER_PAYOUT_DAYS } from '../server/services/cash/money.ts';
import { sampler } from '../server/services/goals/portfolio.ts';
import type { CashKnowledge } from '../server/services/quant/knowledge.ts';
import type { CashCardFact, CashOpportunity } from '../server/domain/types.ts';
import type { Design } from '../server/services/cash/properties.ts';

const now = new Date('2026-11-21T00:00:00Z');
const DAYS_LEFT = 19;

function arrangement(design: Partial<Design>, over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key: `county-reports-${design.funding ?? 'none'}`,
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'PREPAID', aggregation: 'SINGLE', repeat: 'RECURRING_COHORT', ...design },
    origin: 'FORWARD',
    precedent: null,
    sector: 'local government',
    demand: { name: 'County agencies', claimId: null, from: 'INDUSTRY_MAP', ref: 'ind_counties' },
    need: null,
    supply: null,
    label: 'Brain produces compliance reports for county agencies',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] },
    evidenced: 0,
    value: { tier: 'COMPARABLE', p10: 400, p50: 900, p90: 2_000, observations: 3 },
    unknownParts: ['conversion'],
    relatedOpenings: [],
    question: 'Do county agencies buy compliance reports?',
    ...over,
  } as ConstructedArrangement;
}

function opening(id: string): CashOpportunity {
  return { id, title: `County work ${id}`, mechanism: 'PRODUCTIZED_SERVICE', opportunitySignal: 'ACTIVE_BUYER_DEMAND', industry: 'local government', payer: 'County agencies', priceCents: 90_000, currency: 'USD', duplicateOfId: null } as unknown as CashOpportunity;
}

function claim(id: string, opportunityId: string, value: string): CashCardFact {
  return { id, projectId: 'prj_cash', opportunityId, field: 'timeToFirstCash', kind: 'EVIDENCE', value, claimId: `clm_${id}`, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' } as unknown as CashCardFact;
}

/** The project's own time-to-first-cash records: a few quick payments and the award cycles of public RFPs. */
const RECORDS = [
  ['a', 'Paid within 5 days of delivery.'],
  ['b', 'Paid within 9 days of delivery.'],
  ['c', 'Paid within 12 days of delivery.'],
  ['d', 'Payment arrives 180 days after the RFP is released, once the award is made.'],
  ['e', 'Payment arrives 400 days after the RFP is released, once the award is made.'],
] as const;

function longTailed(): CashKnowledge {
  const openings = RECORDS.map(([id]) => opening(`own_${id}`));
  return {
    projectId: 'prj_cash',
    opportunities: new Map(openings.map((one) => [one.id, one])),
    facts: RECORDS.map(([id, text]) => claim(id, `own_${id}`, text)),
    lessons: [],
    sources: new Map(),
    watermark: '',
    routeMoney: new Map(),
    routeScores: new Map(),
    routeMoneyError: null,
    estimates: new Map(),
    learning: null,
  } as unknown as CashKnowledge;
}

const input = { projectId: 'prj_cash', currency: 'USD', beforeProofCents: null, now, daysLeft: DAYS_LEFT, remaining: 10_000 };
const modelled = (a: ConstructedArrangement) => estimatedFromArrangement(a, { ...input, knowledge: longTailed() })!;

/** The lowest value the engine draws for an unestablished days to cash: its range's centre (E4a), the reading every world is held at or above. */
function engineMidpoint(days: ReturnType<typeof modelled>['daysToCash']): number {
  let seed = 7;
  const rng = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  const draw = sampler(days, rng, 'HIGH');
  let low = Infinity;
  for (let i = 0; i < 2_000; i++) low = Math.min(low, draw());
  return low;
}

describe('days to cash from the design’s payment structure', () => {
  it('the fixture is long-tailed: an ON_DELIVERY design reads the award cycles (the defect’s shape)', () => {
    const one = modelled(arrangement({ funding: 'ON_DELIVERY' }));
    expect(one.daysToCash.high!).toBeGreaterThan(150);
    expect(engineMidpoint(one.daysToCash)).toBeGreaterThan(DAYS_LEFT);
  });

  it('a PREPAID design Brain produces is bounded by time to agree plus the provider’s payout, not the award cycles', () => {
    const one = modelled(arrangement({ funding: 'PREPAID' }));
    expect(one.daysToCash).toMatchObject({
      value: null,
      low: AGREE_DAYS.low + PROVIDER_PAYOUT_DAYS.low,
      high: AGREE_DAYS.high + PROVIDER_PAYOUT_DAYS.high,
      provenance: 'ASSUMPTION',
    });
    // Derived from the stated structure, its assumptions named — never evidence, never an inference from other openings.
    expect(one.daysToCash.provenance).not.toBe('EVIDENCE');
    expect(one.daysToCash.inferred).toBeUndefined();
    expect(one.daysToCash.note).toMatch(/design's stated structure/);
    expect(one.daysToCash.note).toMatch(/Stripe/);
    expect(one.daysToCash.note).toMatch(/assumed/);
    expect(one.daysToCash.high!).toBeLessThan(30);
  });

  it('on the $10K-in-19-days shape, the engine’s midpoint for a prepaid repeatable design no longer exceeds the days left', () => {
    const one = modelled(arrangement({ funding: 'PREPAID', repeat: 'RECURRING_COHORT' }));
    expect(one.repeatable).toBe(true);
    const mid = engineMidpoint(one.daysToCash);
    expect(mid).toBeLessThanOrEqual(DAYS_LEFT);
    expect(mid).toBeCloseTo((AGREE_DAYS.low + PROVIDER_PAYOUT_DAYS.low + AGREE_DAYS.high + PROVIDER_PAYOUT_DAYS.high) / 2, 0);
  });

  it('an ARREARS (on-delivery) design keeps the comparable inference', () => {
    const one = modelled(arrangement({ funding: 'ON_DELIVERY' }));
    expect(one.daysToCash.inferred).toBeDefined();
    expect(one.daysToCash.note).not.toMatch(/design's stated structure/);
    expect(structuralDaysToCash(arrangement({ funding: 'ON_DELIVERY' }), null, DAYS_LEFT)).toBeNull();
  });

  it('an unknown funding keeps the inference', () => {
    const a = arrangement({}, {});
    const unstated = { ...a, design: { ...a.design, funding: undefined } } as unknown as ConstructedArrangement;
    expect(structuralDaysToCash(unstated, null, DAYS_LEFT)).toBeNull();
    const one = modelled(unstated);
    expect(one.daysToCash.inferred).toBeDefined();
    expect(one.daysToCash.high!).toBeGreaterThan(150);
  });

  it('a prepaid design over buyers stated to pay in arrears, or only a deposit, is never read more favourably than stated', () => {
    const arrears = arrangement({ funding: 'PREPAID' }, { buyerTerms: { timing: 'ARREARS', basis: 'an RFP: paid on award' } });
    expect(structuralDaysToCash(arrears, null, DAYS_LEFT)).toBeNull();
    expect(modelled(arrears).daysToCash.high!).toBeGreaterThan(150);
    const deposit = arrangement({ funding: 'PREPAID' }, { buyerTerms: { timing: 'PREPAID', basis: 'a 30% deposit', share: 0.3 } });
    expect(structuralDaysToCash(deposit, null, DAYS_LEFT)).toBeNull();
  });

  it('a threshold presale settles when the presale fills, inside the selling window, plus the payout', () => {
    const one = structuralDaysToCash(arrangement({ funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS' }), null, DAYS_LEFT)!;
    expect(one).toMatchObject({ low: AGREE_DAYS.low + PROVIDER_PAYOUT_DAYS.low, high: DAYS_LEFT + PROVIDER_PAYOUT_DAYS.high, provenance: 'ASSUMPTION' });
    expect(one.note).toMatch(/selling window/);
  });
});
