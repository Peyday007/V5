import { describe, it, expect } from 'vitest';
import { toModelInput, consumedInputs, forNewOperator } from '../server/services/economy/relationships/variables.ts';
import { partitionRelationships, related, requiredClosure } from '../server/services/economy/relationships/graph.ts';
import { compareArrangements } from '../server/services/economy/relationships/arrangements.ts';
import type { ActivityVariable, EconomicRelationship } from '../server/services/economy/relationships/types.ts';

const v = (o: Partial<ActivityVariable>): ActivityVariable => ({ activityId: 'a', key: 'price', state: 'VERIFIED', value: 100, low: 100, high: 100, source: { kind: 'CLAIM', ref: 'c1' }, basis: null, operatorBasis: 'REPRODUCIBLE_BY_NEW_OPERATOR', ...o });
const rel = (o: Partial<EconomicRelationship>): EconomicRelationship => ({ id: 'r', kind: 'SUPPLIES', from: { kind: 'INDUSTRY_NODE', id: 'x' }, to: { kind: 'INDUSTRY_NODE', id: 'y' }, state: 'VERIFIED', source: { kind: 'CLAIM', ref: 'c' }, basis: null, ...o });
const fb = { low: 0, high: 10 };

describe('variables', () => {
  it('maps VERIFIED to EVIDENCE with its source, ESTIMATE to ASSUMPTION', () => {
    expect(toModelInput(v({}), fb)).toMatchObject({ provenance: 'EVIDENCE', source: { ref: 'c1' } });
    expect(toModelInput(v({ state: 'ESTIMATE', source: null, basis: 'two quotes' }), fb)).toMatchObject({ provenance: 'ASSUMPTION' });
  });
  it('never trusts a malformed or unknown variable', () => {
    expect(toModelInput(v({ source: null }), fb)).toMatchObject({ provenance: 'UNKNOWN', value: null });
    expect(toModelInput(v({ state: 'ESTIMATE', source: null, basis: ' ' }), fb).provenance).toBe('UNKNOWN');
    expect(toModelInput(v({ state: 'UNKNOWN', value: null, low: null, high: null, source: null }), fb)).toMatchObject({ low: 0, high: 10 });
  });
  it('fills all six consumed inputs, missing ones UNKNOWN', () => {
    const all = consumedInputs([v({})], { price: fb, capital: fb, hours: fb, daysToCash: fb, close: fb, directCost: fb });
    expect(all.price.provenance).toBe('EVIDENCE');
    expect(all.capital.provenance).toBe('UNKNOWN');
  });
  it('prefers a new operator figure', () => {
    const out = forNewOperator([v({ operatorBasis: 'ESTABLISHED_OPERATOR', value: 500 }), v({ value: 100 })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe(100);
  });
});

describe('graph', () => {
  it('refuses unsourced VERIFIED and self edges with reasons', () => {
    const { valid, refused } = partitionRelationships([rel({ id: '1' }), rel({ id: '2', source: null }), rel({ id: '3', to: { kind: 'INDUSTRY_NODE', id: 'x' } })]);
    expect(valid.map((r) => r.id)).toEqual(['1']);
    expect(refused.map((r) => r.id)).toEqual(['2', '3']);
  });
  it('walks requires transitively, tolerating cycles', () => {
    const e = (a: string, b: string) => rel({ id: a + b, kind: 'REQUIRES', from: { kind: 'ACTIVITY', id: a }, to: { kind: 'ACTIVITY', id: b } });
    expect(requiredClosure([e('a', 'b'), e('b', 'c'), e('c', 'a')], 'a')).toEqual(['b', 'c']);
    expect(related([rel({ kind: 'COMPETES_WITH' })], 'y', 'COMPETES_WITH')).toEqual(['x']);
  });
});

describe('arrangements', () => {
  const arr = (key: string, activityId: string, needId = 'n') => ({ key, activityId, needId });
  it('ranks by stated net and withholds unstated, never as zero', () => {
    const vars = [
      v({ activityId: 'direct', key: 'price', value: 100 }), v({ activityId: 'direct', key: 'directCost', value: 70 }),
      v({ activityId: 'broker', key: 'price', value: 30 }), v({ activityId: 'broker', key: 'directCost', value: 0 }),
      v({ activityId: 'ref', key: 'price', value: 10 }),
    ];
    const out = compareArrangements([arr('referral', 'ref'), arr('brokerage', 'broker'), arr('direct', 'direct')], vars);
    expect(out.ranked.map((r) => r.arrangement.key)).toEqual(['brokerage', 'direct', 'referral']);
    expect(out.ranked[2]!.netPerTransaction).toBeNull();
    expect(out.ranked[2]!.withheld).toMatch(/directCost/);
  });
  it('refuses arrangements for different needs', () => {
    expect(compareArrangements([arr('a', 'a', 'n1'), arr('b', 'b', 'n2')], []).refused).toMatch(/different needs/);
  });
});
