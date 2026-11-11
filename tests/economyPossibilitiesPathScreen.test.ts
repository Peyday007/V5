/**
 * The capital/deadline code screen runs inside the real research producer.
 *
 * `researchGoalPaths` is what raises research needs for a goal's openings (the
 * goals tick calls it through plan.ts). These tests drive it, not the screen
 * alone. An opening whose established facts break the goal's limits gets no
 * research need raised. An opening the screen cannot judge yet is still
 * researched. The repositories underneath are replaced so the count of raised
 * needs is exactly the count of research jobs the producer started.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const facts = new Map<string, { value: string | null; kind: string }>();
const opportunities = new Map<string, Record<string, unknown>>();
const raised: { opportunityId: string; requestKey: string }[] = [];

vi.mock('../server/repos/cashPortfolio.ts', () => ({
  getOpportunity: async (id: string) => opportunities.get(id) ?? null,
  listNeeds: async () => [],
}));
vi.mock('../server/repos/cashCardFacts.ts', () => ({
  cardFact: async (opportunityId: string, field: string) => facts.get(`${opportunityId}:${field}`) ?? null,
}));
vi.mock('../server/services/cash/needs.ts', () => ({
  raiseNeed: async (input: { opportunityId: string; requestKey: string }) => {
    raised.push({ opportunityId: input.opportunityId, requestKey: input.requestKey });
    return { ok: true, value: { id: `need_${raised.length}` } };
  },
  closeNeed: async () => ({ ok: true }),
}));
vi.mock('../server/repos/russellCandidates.ts', () => ({ getCandidate: async () => null }));
vi.mock('../server/repos/russellMissions.ts', () => ({ latestMissionForCandidate: async () => null }));
vi.mock('../server/services/cash/operate.ts', () => ({ diveOwnsItsQuestions: () => false }));

const { researchGoalPaths } = await import('../server/services/goals/pathResearch.ts');
const { goalLimitsOf, openingRequirements, screenOpening } = await import('../server/services/economy/possibilities/opening.ts');

function opening(id: string, peakFundingCents: number | null = null) {
  opportunities.set(id, { id, title: `Opening ${id}`, peakFundingCents, validationState: 'NONE' });
  return {
    opportunityId: id,
    title: `Opening ${id}`,
    modelled: true,
    missing: ['SETTLES_IN_TIME', 'ECONOMICS'],
    supportedReach: 5000,
    potentialReach: 5000,
    competitiveAward: false,
  };
}

function reading(considered: ReturnType<typeof opening>[], target: Partial<Record<string, unknown>> = {}) {
  return {
    considered,
    target: {
      currency: 'USD',
      projectId: 'prj_t',
      remainingCents: 1_000_000,
      daysLeft: 30,
      capitalCeilingCents: 200_000,
      capitalBeforeProofCents: null,
      proven: false,
      ...target,
    },
  } as never;
}

beforeEach(() => {
  facts.clear();
  opportunities.clear();
  raised.length = 0;
});

describe('the code screen inside path research', () => {
  it('raises no research for an opening whose stated capital exceeds the goal limit', async () => {
    const tooCostly = opening('opp_costly', 900_000);
    const screenedOut: string[] = [];
    const ids = await researchGoalPaths({ reading: reading([tooCostly]), projectId: 'prj_t', screenedOut });
    expect(ids).toEqual([]);
    expect(raised).toEqual([]);
    expect(screenedOut).toEqual(['opp_costly']);
  });

  it('raises no research for an opening that settles after the cash deadline', async () => {
    const slow = opening('opp_slow');
    facts.set('opp_slow:timeToFirstCash', { value: 'Paid 90 days after acceptance', kind: 'EVIDENCE' });
    facts.set('opp_slow:requiredCapital', { value: 'USD 100', kind: 'EVIDENCE' });
    await researchGoalPaths({ reading: reading([slow]), projectId: 'prj_t' });
    expect(raised).toEqual([]);
  });

  it('still researches an opening the screen cannot judge, and one that fits', async () => {
    const unknown = opening('opp_unknown');
    const fits = opening('opp_fits', 50_000);
    facts.set('opp_fits:timeToFirstCash', { value: '14 days', kind: 'EVIDENCE' });
    const screenedOut: string[] = [];
    await researchGoalPaths({ reading: reading([unknown, fits]), projectId: 'prj_t', screenedOut });
    expect(screenedOut).toEqual([]);
    expect(new Set(raised.map((one) => one.opportunityId))).toEqual(new Set(['opp_unknown', 'opp_fits']));
  });

  it('only the rejected opening is skipped when both are considered', async () => {
    await researchGoalPaths({ reading: reading([opening('opp_costly', 900_000), opening('opp_ok', 1_000)]), projectId: 'prj_t' });
    expect(raised.length).toBeGreaterThan(0);
    expect(raised.every((one) => one.opportunityId === 'opp_ok')).toBe(true);
  });

  it('a recommendation is not an established fact, so it cannot reject', async () => {
    const guessed = opening('opp_guess');
    facts.set('opp_guess:requiredCapital', { value: 'USD 9,000', kind: 'RECOMMENDATION' });
    await researchGoalPaths({ reading: reading([guessed]), projectId: 'prj_t' });
    expect(raised.some((one) => one.opportunityId === 'opp_guess')).toBe(true);
  });
});

describe('opening adapter', () => {
  it('reads only stated facts and never defaults one to zero', () => {
    expect(openingRequirements({ currency: 'USD', peakFundingCents: null, requiredCapital: null, timeToFirstCash: null })).toEqual({ capital: [], time: [] });
    expect(openingRequirements({ currency: 'USD', peakFundingCents: null, requiredCapital: { value: 'USD 1,200', kind: 'EVIDENCE' }, timeToFirstCash: { value: '3 weeks', kind: 'EVIDENCE' } }))
      .toEqual({ capital: ['ownerCapitalCents:120000'], time: ['paidAfterDays:21'] });
  });

  it('binds the before-proof ceiling until the goal is proven', () => {
    expect(goalLimitsOf({ capitalCeilingCents: 500_000, capitalBeforeProofCents: 50_000, proven: false, daysLeft: 10 }))
      .toEqual({ capitalLimitCents: 50_000, cashDeadlineDays: 10 });
    expect(goalLimitsOf({ capitalCeilingCents: 500_000, capitalBeforeProofCents: 50_000, proven: true, daysLeft: null }))
      .toEqual({ capitalLimitCents: 500_000, cashDeadlineDays: null });
  });

  it('a limit nobody stated is not checked', () => {
    expect(screenOpening({ currency: 'USD', peakFundingCents: 9_999_999, requiredCapital: null, timeToFirstCash: null }, { capitalLimitCents: null, cashDeadlineDays: null }).verdict).toBe('ADVANCE');
  });
});
