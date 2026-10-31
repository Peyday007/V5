import { describe, expect, it } from 'vitest';
import { goalComparator, rankForGoal, type RankGoal, type RankInput } from '../server/services/cash/rankGoal.ts';
import { candidateSet } from '../server/services/cash/candidateSet.ts';
import { rank } from '../server/services/cash/portfolio.ts';
import type { ValueLayerReading } from '../server/domain/cashValueLayers.ts';

const goal = (over: Partial<RankGoal> = {}): RankGoal => ({
  metric: 'COLLECTED_CASH', targetCents: 1_000_000, daysLeft: 30, capitalCeilingCents: null, capitalBeforeProofCents: null, hoursCeiling: null, currency: 'USD', ...over,
});
const layer = (opportunityId: string, l: ValueLayerReading['layer'], status: ValueLayerReading['status'], amountCents: number | null, source: string | null = 'src'): ValueLayerReading => ({
  id: `${opportunityId}-${l}`, projectId: 'p', opportunityId, layer: l, status, amountCents, currency: 'USD', source, note: null, createdAt: '', updatedAt: '',
});
function input(id: string, o: { readings?: ValueLayerReading[]; days?: number | null; capital?: number | null; hours?: number | null } = {}): RankInput {
  return {
    opportunity: { id, title: id, peakFundingCents: o.capital ?? null, humanHours: o.hours ?? null, fulfillmentOwner: null, deliveryMethod: null, dependsOnId: null, createdAt: '2026-01-01' } as never,
    readings: o.readings ?? [], daysToCash: o.days ?? null, repeatable: null, combinable: null,
  };
}
const supportedSmall = (id: string, cents: number) => [
  layer(id, 'BUYER_DEMAND', 'VERIFIED', null), layer(id, 'ACCESSIBILITY', 'VERIFIED', null), layer(id, 'REALISTIC_REVENUE', 'ESTIMATE', cents),
];

describe('goal-derived ranking', () => {
  it('ranks a small supported opportunity above a much larger one supported only by advertised value', () => {
    const big = input('big', { readings: [layer('big', 'ADVERTISED_VALUE', 'VERIFIED', 90_000_000)], days: 5 });
    const small = input('small', { readings: supportedSmall('small', 100_000), days: 5 });
    const out = rankForGoal([big, small], goal());
    expect(out.map((r) => r.id)).toEqual(['small', 'big']);
    expect(out[0]!.explanation).toMatch(/achievable contribution/);
    expect(out[1]!.countedCents).toBe(0);
  });
  it('gives different orderings under different goals', () => {
    const slowBig = input('slowBig', { readings: supportedSmall('slowBig', 800_000), days: 25 });
    const fastSmall = input('fastSmall', { readings: supportedSmall('fastSmall', 200_000), days: 3 });
    expect(rankForGoal([slowBig, fastSmall], goal({ daysLeft: 30 })).map((r) => r.id)).toEqual(['fastSmall', 'slowBig']);
    expect(rankForGoal([slowBig, fastSmall], goal({ metric: 'CONTRIBUTION', daysLeft: null })).map((r) => r.id)).toEqual(['slowBig', 'fastSmall']);
  });
  it('sorts a known misfit after unknowns, and unknowns after knowns', () => {
    const g = goal({ capitalCeilingCents: 10_000 });
    const misfit = input('misfit', { readings: supportedSmall('misfit', 900_000), capital: 50_000, days: 1 });
    const unknown = input('unknown', { readings: supportedSmall('unknown', 100_000), days: 1 });
    const fits = input('fits', { readings: supportedSmall('fits', 100_000), capital: 5_000, days: 1 });
    expect(rankForGoal([misfit, unknown, fits], g).map((r) => r.id)).toEqual(['fits', 'unknown', 'misfit']);
  });
  it('exports several small opportunities that only together reach the goal, all surviving', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => input(id, { readings: supportedSmall(id, 300_000), days: 10 }));
    const set = candidateSet(items, goal());
    expect(set.members).toHaveLength(4);
    expect(set.members.every((m) => m.countedCents === 300_000)).toBe(true);
    expect(set.reachesTarget).toBe(true);
    expect(candidateSet([items[0]!], goal()).reachesTarget).toBe(false);
  });
  it('lists an excluded misfit with a reason instead of dropping it silently', () => {
    const set = candidateSet([input('x', { capital: 99_999_999 }), input('y')], goal({ capitalCeilingCents: 1_000 }));
    expect(set.excluded).toEqual([{ id: 'x', why: expect.stringMatching(/limit/) }]);
    expect(set.members.map((m) => m.id)).toEqual(['y']);
  });
  it('plugs into portfolio.rank after the tier, and leaves rank unchanged without it', () => {
    const items = [input('big', { readings: [layer('big', 'ADVERTISED_VALUE', 'VERIFIED', 9e7)] }), input('small', { readings: supportedSmall('small', 1e5) })];
    const opps = items.map((i) => i.opportunity);
    const cmp = goalComparator(new Map(items.map((i) => [i.opportunity.id, i])), goal());
    expect(rank(opps, {}, {}, cmp).map((o) => o.id)).toEqual(['small', 'big']);
    expect(rank(opps).map((o) => o.id)).toEqual(rank(opps, {}, {}, undefined).map((o) => o.id));
  });
});
