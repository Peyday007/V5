import { describe, expect, it } from 'vitest';
import {
  bucketDiversity,
  defaultingBuckets,
  familyOrder,
  INTERMEDIATION_BUCKETS,
  isIntermediationBucket,
  uncoveredEntryPoints,
  type IntermediationBucket,
} from '../server/services/cash/intermediationBuckets.ts';
import { ENTRY_POINTS, INTERMEDIATION_FAMILY, renewFamily } from '../server/services/cash/intermediationPositions.ts';
import { SEARCH_BUCKETS, fairOrder } from '../server/services/cash/discovery.ts';

describe('RES-15-4: intermediation entry buckets (S-0149)', () => {
  it('has buyer-first and supply-first buckets, and every S-0149 entry point is searched', () => {
    const sides = new Set(INTERMEDIATION_BUCKETS.map((one) => one.entry));
    expect(sides).toEqual(new Set(['BUYER_FIRST', 'SUPPLY_FIRST']));
    expect(uncoveredEntryPoints(INTERMEDIATION_BUCKETS)).toEqual([]);
    const covered = new Set(INTERMEDIATION_BUCKETS.flatMap((one) => one.covers));
    for (const point of [...ENTRY_POINTS.BUYER_FIRST, ...ENTRY_POINTS.SUPPLY_FIRST]) expect(covered).toContain(point);
    // An entry point no bucket covers is named.
    expect(uncoveredEntryPoints(INTERMEDIATION_BUCKETS.filter((one) => !one.covers.includes('pricing spreads')))).toEqual(['pricing spreads']);
  });

  it('spans more than one buyer type and market structure', () => {
    const reading = bucketDiversity(INTERMEDIATION_BUCKETS);
    expect(reading.ok).toBe(true);
    expect(reading.buyerTypes.length).toBeGreaterThanOrEqual(3);
    expect(reading.marketStructures.length).toBeGreaterThanOrEqual(3);
    expect(reading.nearDuplicates).toEqual([]);
  });

  it('refuses near-duplicate searches that differ only by an industry noun', () => {
    const base = INTERMEDIATION_BUCKETS[0]!;
    const twin: IntermediationBucket = {
      ...base,
      id: 'twin',
      question: base.question.replace('commercial cleaning or concrete work', 'plumbing or roofing work'),
    };
    expect(twin.question).not.toBe(base.question);
    const reading = bucketDiversity([...INTERMEDIATION_BUCKETS, twin]);
    expect(reading.ok).toBe(false);
    expect(reading.nearDuplicates).toEqual([[base.id, 'twin']]);
    // A set narrowed to one side, one buyer type and one structure is refused too.
    const narrow = bucketDiversity(INTERMEDIATION_BUCKETS.filter((one) => one.id === base.id));
    expect(narrow.ok).toBe(false);
    expect(narrow.problems.join(' ')).toMatch(/one buyer type/);
    expect(narrow.problems.join(' ')).toMatch(/no supply-first/);
  });

  it('names industries only as examples, never as a filter, and defaults to nothing S-0149 forbids', () => {
    expect(defaultingBuckets(INTERMEDIATION_BUCKETS)).toEqual([]);
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(bucket.question).not.toMatch(/\bonly\b/i);
      expect(bucket.question.trimEnd().endsWith('?')).toBe(true);
      expect(bucket.question).toMatch(/who exactly pays/);
      expect(bucket.question).toMatch(/fastest meaningful next step/);
      expect(bucket.mechanism).not.toBe('OTHER');
    }
    // The check bites: a question defaulting to cold email or the owner's city is named.
    const bad = { ...INTERMEDIATION_BUCKETS[0]!, id: 'bad', question: 'Which buyers in the owner’s city answer cold email?' };
    expect(defaultingBuckets([bad])).toEqual(['bad']);
  });

  it('is part of discovery’s own buckets, opened by the same machinery', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) expect(SEARCH_BUCKETS).toContain(bucket);
    expect(new Set(SEARCH_BUCKETS.map((one) => one.id)).size).toBe(SEARCH_BUCKETS.length);
    expect(SEARCH_BUCKETS.filter(isIntermediationBucket)).toHaveLength(INTERMEDIATION_BUCKETS.length);
  });

  it('orders the family first while its declaration is current, and reverts when it lapses', () => {
    const ordinary = fairOrder(SEARCH_BUCKETS, []);
    const inside = familyOrder(ordinary, '2026-12-01T00:00:00.000Z');
    expect(inside.slice(0, INTERMEDIATION_BUCKETS.length).every(isIntermediationBucket)).toBe(true);
    expect(inside).toHaveLength(ordinary.length);
    // Each set keeps its relative order.
    expect(inside.filter((one) => !isIntermediationBucket(one))).toEqual(ordinary.filter((one) => !isIntermediationBucket(one)));
    expect(inside.filter(isIntermediationBucket)).toEqual(ordinary.filter(isIntermediationBucket));

    const lapsed = familyOrder(ordinary, '2027-03-01T00:00:00.000Z');
    expect(lapsed).toEqual(ordinary);
    const before = familyOrder(ordinary, '2026-11-01T00:00:00.000Z');
    expect(before).toEqual(ordinary);
    // Renewal extends the window; nothing is hard-coded forever.
    const renewed = renewFamily(INTERMEDIATION_FAMILY, '2027-06-01');
    expect(familyOrder(ordinary, '2027-03-01T00:00:00.000Z', renewed).slice(0, INTERMEDIATION_BUCKETS.length).every(isIntermediationBucket)).toBe(true);
  });
});
