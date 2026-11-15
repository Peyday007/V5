/**
 * RES-15-4 (S-0148, S-0149, S-0150): intermediation entry buckets in discovery.
 */
import { describe, expect, it } from 'vitest';
import {
  INTERMEDIATION_BUCKETS,
  bucketDiversityProblems,
  forbiddenDefaultsIn,
  isIntermediationBucket,
  orderForFamily,
  uncoveredEntryPoints,
} from '../server/services/cash/intermediationBuckets.ts';
import { ENTRY_POINTS, INTERMEDIATION_FAMILY, POSITIONS, renewFamily } from '../server/services/cash/intermediationPositions.ts';
import { SEARCH_BUCKETS, fairOrder } from '../server/services/cash/discovery.ts';
import { CASH_MECHANISMS } from '../server/domain/types.ts';

describe('intermediation entry buckets', () => {
  it('has both BUYER_FIRST and SUPPLY_FIRST buckets and covers every S-0149 entry point', () => {
    const directions = new Set(INTERMEDIATION_BUCKETS.map((one) => one.entry));
    expect(directions).toEqual(new Set(['BUYER_FIRST', 'SUPPLY_FIRST']));
    expect(uncoveredEntryPoints(INTERMEDIATION_BUCKETS)).toEqual([]);
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect((ENTRY_POINTS[bucket.entry] as readonly string[]).includes(bucket.entryPoint)).toBe(true);
    }
    // Remove one and its entry point is reported.
    const without = INTERMEDIATION_BUCKETS.filter((one) => one.entryPoint !== 'bundled supply');
    expect(uncoveredEntryPoints(without)).toEqual(['bundled supply']);
  });

  it('spans more than one buyer type and market structure, and passes its own diversity check', () => {
    expect(new Set(INTERMEDIATION_BUCKETS.map((one) => one.buyerType)).size).toBeGreaterThan(1);
    expect(new Set(INTERMEDIATION_BUCKETS.map((one) => one.marketStructure)).size).toBeGreaterThan(1);
    expect(bucketDiversityProblems(INTERMEDIATION_BUCKETS)).toEqual([]);
  });

  it('refuses near-duplicate questions that differ only by industry noun', () => {
    const base = { entry: 'BUYER_FIRST' as const, buyerType: 'BUSINESS' as const, marketStructure: 'CONTRACTED_RECURRING' as const };
    const dupes = [
      { ...base, id: 'a', ask: 'Which cleaning buyers publish requests for recurring service contracts this quarter?' },
      { ...base, id: 'b', ask: 'Which concrete buyers publish requests for recurring service contracts this quarter?', entry: 'SUPPLY_FIRST' as const, buyerType: 'CONSUMER' as const, marketStructure: 'PROJECT_BASED' as const },
    ];
    const problems = bucketDiversityProblems(dupes);
    expect(problems.map((one) => one.kind)).toContain('NEAR_DUPLICATE');
    // A monoculture of buyer type / structure / direction is refused too.
    const mono = [
      { ...base, id: 'x', ask: 'Which public tenders award to arrangers?' },
      { ...base, id: 'y', ask: 'Which warehouses advertise idle pallet space?' },
    ];
    expect(bucketDiversityProblems(mono).map((one) => one.kind).sort()).toEqual(['ONE_BUYER_TYPE', 'ONE_DIRECTION', 'ONE_MARKET_STRUCTURE']);
  });

  it('names no forbidden default, uses industries only as examples, and asks the per-position evidence', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(forbiddenDefaultsIn(bucket.question)).toEqual([]);
      expect(bucket.question).toContain('are examples of where this happens, not limits on where to look');
      for (const example of INTERMEDIATION_FAMILY.examples) expect(bucket.question).toContain(example);
      for (const position of Object.values(POSITIONS)) expect(bucket.question).toContain(position.label);
      expect(bucket.question).toContain('or any other position the evidence shows');
      expect(bucket.question).toContain('fastest meaningful next action');
      expect(bucket.question).toContain('only a public asking price or a total market size');
      expect((CASH_MECHANISMS as readonly string[]).includes(bucket.mechanism)).toBe(true);
    }
    expect(forbiddenDefaultsIn('Start in the owner’s city and send cold email.').length).toBeGreaterThan(0);
  });

  it('is part of SEARCH_BUCKETS with unique ids', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) expect(SEARCH_BUCKETS.some((one) => one.id === bucket.id)).toBe(true);
    expect(new Set(SEARCH_BUCKETS.map((one) => one.id)).size).toBe(SEARCH_BUCKETS.length);
  });

  it('orders intermediation first while the family is current, and reverts to the fair order when it lapses', () => {
    // A history where intermediation mechanisms were asked a lot, so fair order puts others first.
    const rounds = INTERMEDIATION_BUCKETS.flatMap((one) =>
      [1, 2, 3].map((round) => ({ bucketId: one.id, mechanism: one.mechanism, round }) as unknown as Parameters<typeof fairOrder>[1][number]),
    );
    const fair = fairOrder(SEARCH_BUCKETS, rounds);
    expect(isIntermediationBucket(fair[0]!)).toBe(false);

    const current = orderForFamily(fair, '2026-12-01T00:00:00Z');
    const n = INTERMEDIATION_BUCKETS.length;
    expect(current.slice(0, n).every(isIntermediationBucket)).toBe(true);
    expect(current.slice(n).some(isIntermediationBucket)).toBe(false);
    // Relative order inside each part is the fair order's.
    expect(current.slice(0, n).map((one) => one.id)).toEqual(fair.filter(isIntermediationBucket).map((one) => one.id));

    const lapsed = orderForFamily(fair, '2027-03-01T00:00:00Z');
    expect(lapsed.map((one) => one.id)).toEqual(fair.map((one) => one.id));
    expect(lapsed.filter(isIntermediationBucket)).toHaveLength(n);

    // Renewing the declaration makes it current again.
    const renewed = renewFamily(INTERMEDIATION_FAMILY, '2027-06-01');
    expect(isIntermediationBucket(orderForFamily(fair, '2027-03-01T00:00:00Z', renewed)[0]!)).toBe(true);
  });
});
