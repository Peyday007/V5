/**
 * RES-15-4 (S-0148, S-0149): intermediation entry buckets in discovery —
 * buyer-first and supply-first, across buyer types and market structures,
 * industries as examples only, no default to the owner's city, presence,
 * catalogue, cold email or AI-digital work, and ordered first only while the
 * family declaration is current.
 */
import { describe, expect, it } from 'vitest';
import { fairOrder, SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import {
  bucketDiversity,
  forbiddenDefaults,
  INTERMEDIATION_BUCKETS,
  isIntermediationBucket,
  prioritizeIntermediation,
  uncoveredEntryPoints,
} from '../server/services/cash/intermediationBuckets.ts';
import { ENTRY_POINTS, INTERMEDIATION_FAMILY, renewFamily } from '../server/services/cash/intermediationPositions.ts';
import type { CashDiscoveryRound } from '../server/domain/types.ts';

describe('intermediation entry buckets', () => {
  it('has both buyer-first and supply-first buckets and covers every S-0149 entry point', () => {
    expect(INTERMEDIATION_BUCKETS.some((b) => b.direction === 'BUYER_FIRST')).toBe(true);
    expect(INTERMEDIATION_BUCKETS.some((b) => b.direction === 'SUPPLY_FIRST')).toBe(true);
    expect(uncoveredEntryPoints()).toEqual([]);
    for (const b of INTERMEDIATION_BUCKETS) expect((ENTRY_POINTS[b.direction] as readonly string[]).includes(b.entryPoint)).toBe(true);
  });

  it('names a missing entry point when one is uncovered', () => {
    expect(uncoveredEntryPoints(INTERMEDIATION_BUCKETS.filter((b) => b.entryPoint !== 'bundled supply'))).toEqual(['bundled supply']);
  });

  it('spans more than one buyer type and market structure', () => {
    expect(new Set(INTERMEDIATION_BUCKETS.map((b) => b.buyerType)).size).toBeGreaterThan(1);
    expect(new Set(INTERMEDIATION_BUCKETS.map((b) => b.marketStructure)).size).toBeGreaterThan(1);
  });

  it('passes the diversity check, which refuses questions that differ only by industry', () => {
    expect(bucketDiversity(INTERMEDIATION_BUCKETS)).toEqual({ ok: true, duplicates: [] });
    const near = [
      { id: 'a', question: 'Which cleaning suppliers have unused capacity buyers would pay for?' },
      { id: 'b', question: 'Which concrete suppliers have unused capacity buyers would pay for?' },
      { id: 'c', question: 'Which logistics suppliers have unused capacity buyers would pay for?' },
      { id: 'd', question: 'Which buyers renew contracts in the next quarter?' },
    ];
    const r = bucketDiversity(near);
    expect(r.ok).toBe(false);
    expect(r.duplicates).toEqual([['a', 'b'], ['a', 'c']]);
  });

  it('uses industries only as examples, never as a filter', () => {
    for (const b of INTERMEDIATION_BUCKETS) {
      expect(b.question).toMatch(/For example [^.]+ — or any other market where it holds\./);
      const ask = b.question.split(' For example ')[0]!;
      for (const industry of INTERMEDIATION_FAMILY.examples) expect(ask.toLowerCase()).not.toContain(` ${industry.toLowerCase()} `);
    }
  });

  it('no question defaults to the owner’s city, physical presence, the catalogue, cold email or AI-digital work', () => {
    for (const b of INTERMEDIATION_BUCKETS) expect(forbiddenDefaults(b.question)).toEqual([]);
    expect(forbiddenDefaults('Find businesses in your city and send a cold email offering our existing catalogue of AI-generated websites, visiting in person.')).toEqual([
      'the owner’s city', 'physical presence', 'the existing catalogue', 'cold email', 'AI-produced digital work',
    ]);
  });

  it('asks for usable evidence per position, and for the access and conversion gaps behind a bare price or market size', () => {
    for (const b of INTERMEDIATION_BUCKETS) {
      for (const phrase of ['exact payer', 'channel', 'observed demand', 'supplier or capacity source', 'price and the spread', 'acquisition cost and throughput', 'fulfilment obligations', 'margin and timing', 'buyers fund it', 'capital tied up', 'rights, liabilities and restrictions', 'uncertain', 'fastest meaningful next action', 'buyer-access and conversion']) {
        expect(b.question).toContain(phrase);
      }
    }
  });

  it('is part of discovery’s search buckets, with unique ids', () => {
    for (const b of INTERMEDIATION_BUCKETS) expect(SEARCH_BUCKETS.some((one) => one.id === b.id)).toBe(true);
    expect(new Set(SEARCH_BUCKETS.map((b) => b.id)).size).toBe(SEARCH_BUCKETS.length);
  });
});

describe('ordering follows the family declaration', () => {
  const round = (bucketId: string, mechanism: string): CashDiscoveryRound => ({ bucketId, mechanism } as unknown as CashDiscoveryRound);
  // History that makes fair order push the intermediation buckets back: their mechanisms were asked often.
  const history = INTERMEDIATION_BUCKETS.flatMap((b) => [round(b.id, b.mechanism), round(b.id, b.mechanism), round(b.id, b.mechanism)]);
  const ordinary = fairOrder(SEARCH_BUCKETS, history);

  it('puts intermediation first while the declaration is current', () => {
    const now = '2026-12-01T00:00:00Z';
    const ordered = prioritizeIntermediation(ordinary, now);
    expect(ordered.slice(0, INTERMEDIATION_BUCKETS.length).every(isIntermediationBucket)).toBe(true);
    expect(ordered).toHaveLength(ordinary.length);
    expect(ordered.filter(isIntermediationBucket).map((b) => b.id)).toEqual(ordinary.filter(isIntermediationBucket).map((b) => b.id));
  });

  it('reverts to the ordinary order when it lapses, and before it begins', () => {
    expect(ordinary.slice(0, INTERMEDIATION_BUCKETS.length).every(isIntermediationBucket)).toBe(false);
    expect(prioritizeIntermediation(ordinary, '2027-03-01T00:00:00Z')).toEqual(ordinary);
    expect(prioritizeIntermediation(ordinary, '2026-11-01T00:00:00Z')).toEqual(ordinary);
  });

  it('follows a renewed declaration', () => {
    const renewed = renewFamily(INTERMEDIATION_FAMILY, '2027-06-01');
    const ordered = prioritizeIntermediation(ordinary, '2027-03-01T00:00:00Z', renewed);
    expect(ordered.slice(0, INTERMEDIATION_BUCKETS.length).every(isIntermediationBucket)).toBe(true);
  });
});
