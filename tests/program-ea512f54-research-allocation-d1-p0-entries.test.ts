/**
 * RES-15-4 (S-0149) in discovery: intermediation search buckets start from both the buyer
 * and the supply end, cover every named entry point, span buyer types and market
 * structures, never fall back on the owner's defaults, are refused when they are
 * near-duplicate industry searches, and are ordered by the family's dated declaration.
 */
import { describe, expect, it } from 'vitest';
import {
  INTERMEDIATION_BUCKETS,
  assertDiverse,
  familyRank,
  nearDuplicates,
  ownerDefaultsIn,
  uncoveredEntryPoints,
  type IntermediationBucket,
} from '../server/services/cash/intermediationBuckets.ts';
import { ENTRY_POINTS, INTERMEDIATION_FAMILY, renewFamily } from '../server/services/cash/intermediationPositions.ts';
import { SEARCH_BUCKETS, fairOrder } from '../server/services/cash/discovery.ts';
import { describesOwnAction } from '../server/services/research/actorScope.ts';
import { APPROVAL_ENVELOPES } from '../server/services/research/approvalEnvelope.ts';

const INSIDE = '2026-12-01T00:00:00Z';
const AFTER = '2027-03-01T00:00:00Z';

describe('entry points (S-0149)', () => {
  it('has buyer-first and supply-first buckets, and every named entry point is covered', () => {
    const ends = new Set(INTERMEDIATION_BUCKETS.map((one) => one.entry));
    expect(ends).toEqual(new Set(['BUYER_FIRST', 'SUPPLY_FIRST']));
    expect(uncoveredEntryPoints(INTERMEDIATION_BUCKETS)).toEqual([]);
    for (const point of [...ENTRY_POINTS.BUYER_FIRST, ...ENTRY_POINTS.SUPPLY_FIRST]) {
      expect(INTERMEDIATION_BUCKETS.some((one) => one.entryPoints.includes(point)), point).toBe(true);
    }
    // A set missing one end's buckets leaves its points uncovered.
    expect(uncoveredEntryPoints(INTERMEDIATION_BUCKETS.filter((one) => one.entry === 'BUYER_FIRST'))).toEqual(
      expect.arrayContaining(['unused supplier capacity', 'existing intermediary economics']),
    );
  });

  it('is part of discovery’s own bucket table, with unique ids, and asks questions', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(SEARCH_BUCKETS).toContain(bucket);
      expect(bucket.question.trimEnd().endsWith('?')).toBe(true);
      expect(bucket.mechanism).not.toBe('OTHER');
    }
    expect(new Set(SEARCH_BUCKETS.map((one) => one.id)).size).toBe(SEARCH_BUCKETS.length);
  });

  it('never tells the worker to act: every question is read-only under every envelope', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) {
      for (const envelope of Object.values(APPROVAL_ENVELOPES)) {
        expect(describesOwnAction(bucket.question, envelope.forbiddenActions), `${bucket.id} / ${envelope.id}`).toBe(false);
      }
    }
  });
});

describe('breadth, not near-duplicate industry searches', () => {
  it('spans more than one buyer type and market structure, and passes the diversity check', () => {
    expect(new Set(INTERMEDIATION_BUCKETS.map((one) => one.buyerType)).size).toBeGreaterThan(1);
    expect(new Set(INTERMEDIATION_BUCKETS.map((one) => one.marketStructure)).size).toBeGreaterThan(1);
    expect(nearDuplicates(INTERMEDIATION_BUCKETS)).toEqual([]);
    expect(() => assertDiverse(INTERMEDIATION_BUCKETS)).not.toThrow();
  });

  it('rejects two questions that differ only by an industry noun', () => {
    const base = INTERMEDIATION_BUCKETS[0]!;
    const a: IntermediationBucket = { ...base, id: 'a', question: 'Which cleaning buyers publish requests for quotes this month, naming the buyer?' };
    const b: IntermediationBucket = { ...base, id: 'b', question: 'Which concrete buyers publish requests for quotes this month, naming the buyer?' };
    const c: IntermediationBucket = { ...base, id: 'c', entry: 'SUPPLY_FIRST', buyerType: 'consumer', marketStructure: 'tiered', question: 'Which logistics buyers publish requests for quotes this month, naming the buyer?' };
    expect(nearDuplicates([a, b])).toEqual([['a', 'b']]);
    expect(() => assertDiverse([a, b, c])).toThrow(/near-duplicate/);
    // Different questions about the same industry are not near-duplicates.
    const d: IntermediationBucket = { ...base, id: 'd', question: 'Which cleaning suppliers publish idle crews and their hourly rate?' };
    expect(nearDuplicates([a, d])).toEqual([]);
  });

  it('refuses a set with one end, one buyer type or one market structure', () => {
    const buyerOnly = INTERMEDIATION_BUCKETS.filter((one) => one.entry === 'BUYER_FIRST');
    expect(() => assertDiverse(buyerOnly)).toThrow(/both the buyer and the supply end/);
    const sameBuyer = INTERMEDIATION_BUCKETS.map((one) => ({ ...one, buyerType: 'business' }));
    expect(() => assertDiverse(sameBuyer)).toThrow(/buyer type/);
    const sameStructure = INTERMEDIATION_BUCKETS.map((one) => ({ ...one, marketStructure: 'x' }));
    expect(() => assertDiverse(sameStructure)).toThrow(/market structure/);
  });

  it('names industries only as examples inside the question, never as a filter', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(bucket.question).toMatch(/are examples of where this happens, not limits/);
      expect(Object.keys(bucket)).not.toContain('industry');
    }
  });
});

describe('no owner defaults', () => {
  it('no bucket question falls back on the owner’s city, presence, catalogue, cold email or AI-digital work', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) expect(ownerDefaultsIn(bucket.question), bucket.id).toEqual([]);
  });

  it('the check catches each default when a question does name it', () => {
    expect(ownerDefaultsIn('buyers in the owner’s city')).toEqual([INTERMEDIATION_FAMILY.notDefaults[0]]);
    expect(ownerDefaultsIn('needs physical presence')).toEqual([INTERMEDIATION_FAMILY.notDefaults[1]]);
    expect(ownerDefaultsIn('sell the existing catalogue')).toEqual([INTERMEDIATION_FAMILY.notDefaults[2]]);
    expect(ownerDefaultsIn('reach them by cold email')).toEqual([INTERMEDIATION_FAMILY.notDefaults[3]]);
    expect(ownerDefaultsIn('AI-produced reports')).toEqual([INTERMEDIATION_FAMILY.notDefaults[4]]);
  });
});

describe('ordering follows the family declaration', () => {
  const rankOf = (order: { id: string }[], id: string) => order.findIndex((one) => one.id === id);

  it('inside its window, each family bucket comes before every other bucket of its mechanism', () => {
    const order = fairOrder(SEARCH_BUCKETS, [], INSIDE);
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(familyRank(bucket, INSIDE)).toBe(0);
      const peers = SEARCH_BUCKETS.filter((one) => one.mechanism === bucket.mechanism && !INTERMEDIATION_BUCKETS.includes(one as IntermediationBucket));
      for (const peer of peers) expect(rankOf(order, bucket.id), `${bucket.id} before ${peer.id}`).toBeLessThan(rankOf(order, peer.id));
    }
  });

  it('after the window lapses, the ordinary order returns, and renewing restores the priority', () => {
    const lapsed = fairOrder(SEARCH_BUCKETS, [], AFTER);
    for (const bucket of INTERMEDIATION_BUCKETS) expect(familyRank(bucket, AFTER)).toBe(1);
    // With no family priority, list order breaks ties inside a mechanism, and the family buckets are last in the list.
    const explicit = lapsed.filter((one) => one.mechanism === 'EXPLICIT_PAID_REQUEST').map((one) => one.id);
    expect(explicit).toEqual(['explicit-paid-request', 'int-buyer-requests']);
    const inside = fairOrder(SEARCH_BUCKETS, [], INSIDE).filter((one) => one.mechanism === 'EXPLICIT_PAID_REQUEST').map((one) => one.id);
    expect(inside).toEqual(['int-buyer-requests', 'explicit-paid-request']);
    const renewed = renewFamily(INTERMEDIATION_FAMILY, '2027-06-01');
    expect(familyRank(INTERMEDIATION_BUCKETS[0]!, AFTER, renewed)).toBe(0);
  });

  it('never takes another mechanism’s turn: a fresh sprint still opens across mechanisms', () => {
    const fresh = fairOrder(SEARCH_BUCKETS, [], INSIDE).slice(0, 10);
    expect(new Set(fresh.map((one) => one.mechanism)).size).toBe(10);
  });
});
