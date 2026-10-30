import { describe, expect, it } from 'vitest';
import { combineSignals, fromTrigger, type Observation } from '../server/services/signals/combine.ts';

const now = new Date('2026-10-30T00:00:00.000Z');
const at = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const obs = (id: string, kind: Observation['kind'], org: string | null, d = 2, place: string | null = null): Observation => ({
  id, origin: 'TRIGGER', kind, organization: org, place, category: 'FOOD', observedAt: at(d), urls: [`https://x.test/${id}`],
});

describe('combineSignals', () => {
  it('combines related triggers for one organisation into a SIGNAL tied to an industry and need', () => {
    const r = combineSignals([obs('a', 'EXPANSION', 'Acme Bakery LLC'), obs('b', 'HIRING', 'Acme Bakery, Inc.'), obs('c', 'SUPPLY_SHORTAGE', 'acme bakery')], { now, industryNodeFor: (c) => (c ? `node:${c}` : null) });
    expect(r.signals).toHaveLength(1);
    const s = r.signals[0]!;
    expect(s.label).toBe('SIGNAL');
    expect(s.patternId).toBe('EXPANSION_HIRING_SUPPLY');
    expect(s.industryNode).toBe('node:FOOD');
    expect(s.possibleNeed.length).toBeGreaterThan(0);
    expect(s.captureMethods.length).toBeGreaterThan(0);
    expect(s.qualifiers.join(' ')).toMatch(/does not show anyone would pay/);
  });
  it('does not combine one kind repeated, undated, stale or different organisations', () => {
    const r = combineSignals([obs('a', 'HIRING', 'Acme'), obs('b', 'HIRING', 'Acme'), obs('c', 'EXPANSION', 'Other Co'), obs('d', 'EXPANSION', 'Acme', 90), { ...obs('e', 'EXPANSION', 'Acme'), observedAt: 'nope' }], { now });
    expect(r.signals).toHaveLength(0);
  });
  it('combines on place when no organisation is named', () => {
    const r = combineSignals([obs('a', 'EXPANSION', null, 2, 'Ann Arbor'), obs('b', 'HIRING', null, 3, 'ann  arbor')], { now });
    expect(r.signals).toHaveLength(1);
  });
  it('returns an unfamiliar combination once, by pattern key', () => {
    const r = combineSignals([obs('a', 'NEW_RULE', 'Alpha Co'), obs('b', 'HIRING', 'Alpha Co'), obs('c', 'NEW_RULE', 'Beta Co'), obs('d', 'HIRING', 'Beta Co')], { now });
    expect(r.signals).toHaveLength(0);
    expect(r.unfamiliar).toEqual([{ patternKey: 'HIRING+NEW_RULE', kinds: ['HIRING', 'NEW_RULE'], count: 2 }]);
  });
  it('maps trigger buckets to kinds', () => {
    expect(fromTrigger({ id: 'x', bucketId: 'trigger-new-location', organization: 'A', observedAt: at(1), urls: [] }).kind).toBe('EXPANSION');
    expect(fromTrigger({ id: 'x', bucketId: 'unknown', organization: 'A', observedAt: at(1), urls: [] }).kind).toBe('OTHER');
  });
  it('processes 1000 records by code with zero model jobs, and measures the time', () => {
    const batch: Observation[] = [];
    for (let i = 0; i < 500; i++) {
      batch.push(obs(`e${i}`, 'EXPANSION', `Org ${i}`), obs(`h${i}`, 'HIRING', `Org ${i}`));
    }
    const r = combineSignals(batch, { now });
    expect(r.stats.records).toBe(1000);
    expect(r.signals).toHaveLength(500);
    expect(r.stats.modelJobs).toBe(0);
    expect(r.stats.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(r.stats.elapsedMs).toBeLessThan(5000);
  });
});
