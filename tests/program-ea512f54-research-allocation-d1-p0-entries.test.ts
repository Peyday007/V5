/**
 * RES-15-4 (A01): intermediation research starts from both ends — buyer-first and
 * supply-first — across buyer types and market structures, asks for per-position
 * evidence, never narrows to an industry or a forbidden default, and is asked first
 * only while the family declaration is current.
 */
import { describe, expect, it } from 'vitest';
import {
  checkBucketSet,
  defaultViolations,
  industryFilters,
  INTERMEDIATION_BUCKETS,
  isIntermediationBucket,
  nearDuplicateBuckets,
  POSITION_EVIDENCE_ASK,
  type IntermediationBucket,
} from '../server/services/cash/intermediationBuckets.ts';
import { ENTRY_POINTS, INTERMEDIATION_FAMILY, POSITIONS, renewFamily } from '../server/services/cash/intermediationPositions.ts';
import { discoveryOrder, fairOrder, SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';

const CURRENT = '2026-12-01T00:00:00.000Z';
const LAPSED = '2027-03-01T00:00:00.000Z';

describe('intermediation entry buckets', () => {
  it('the shipped set passes its own breadth check', () => {
    const verdict = checkBucketSet(INTERMEDIATION_BUCKETS);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('has both BUYER_FIRST and SUPPLY_FIRST buckets and covers every S-0149 entry point', () => {
    const ends = new Set(INTERMEDIATION_BUCKETS.map((one) => one.entry));
    expect(ends).toEqual(new Set(['BUYER_FIRST', 'SUPPLY_FIRST']));
    for (const point of ENTRY_POINTS.BUYER_FIRST) {
      expect(INTERMEDIATION_BUCKETS.some((one) => one.entry === 'BUYER_FIRST' && one.entryPoint === point)).toBe(true);
    }
    for (const point of ENTRY_POINTS.SUPPLY_FIRST) {
      expect(INTERMEDIATION_BUCKETS.some((one) => one.entry === 'SUPPLY_FIRST' && one.entryPoint === point)).toBe(true);
    }
  });

  it('spans more than one buyer type and market structure', () => {
    expect(new Set(INTERMEDIATION_BUCKETS.map((one) => one.buyerType)).size).toBeGreaterThan(2);
    expect(new Set(INTERMEDIATION_BUCKETS.map((one) => one.marketStructure)).size).toBeGreaterThan(2);
    const narrowed = INTERMEDIATION_BUCKETS.map((one) => ({ ...one, buyerType: 'BUSINESS' as const, marketStructure: 'SPOT' as const }));
    const verdict = checkBucketSet(narrowed);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toContain('only one buyer type');
    expect(verdict.reasons).toContain('only one market structure');
  });

  it('every question asks for the per-position evidence, naming every catalogued position', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(bucket.question).toContain(POSITION_EVIDENCE_ASK);
      expect(bucket.question.startsWith(bucket.focus)).toBe(true);
    }
    for (const position of Object.values(POSITIONS)) expect(POSITION_EVIDENCE_ASK).toContain(position.label);
    for (const asked of ['exact payer', 'reachable channel', 'observed demand', 'supplier or capacity source', 'spread', 'acquisition cost', 'throughput', 'fulfilment obligations', 'margin', 'timing', 'buyer-funded cash structure', 'capital exposed', 'rights', 'limits', 'uncertain', 'next action']) {
      expect(POSITION_EVIDENCE_ASK).toContain(asked);
    }
    expect(POSITION_EVIDENCE_ASK).toMatch(/public asking price or a total market size/);
    expect(POSITION_EVIDENCE_ASK).toMatch(/reaching that buyer and converting them/);
  });

  it('rejects near-duplicates that differ only by industry noun', () => {
    const base = INTERMEDIATION_BUCKETS[0]!;
    const twin = (industry: string, id: string): IntermediationBucket => ({
      ...base,
      id,
      focus: `Which ${industry} suppliers have published idle capacity they want filled, and what is the published rate?`,
      question: `Which ${industry} suppliers have published idle capacity they want filled, and what is the published rate? ${POSITION_EVIDENCE_ASK}`,
    });
    const dupes = nearDuplicateBuckets([twin('cleaning', 'x-cleaning'), twin('concrete', 'x-concrete'), twin('logistics', 'x-logistics')]);
    expect(dupes).toHaveLength(3);
    const verdict = checkBucketSet([...INTERMEDIATION_BUCKETS, twin('cleaning', 'x-cleaning'), twin('concrete', 'x-concrete')]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((one) => one.includes('x-cleaning and x-concrete differ only by industry'))).toBe(true);
    // Genuinely different questions are not duplicates, however much evidence ask they share.
    expect(nearDuplicateBuckets(INTERMEDIATION_BUCKETS)).toEqual([]);
  });

  it('names no forbidden default, and an industry only as an example', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(defaultViolations(bucket.question)).toEqual([]);
      expect(industryFilters(bucket.question)).toEqual([]);
    }
    // The checks actually bite.
    expect(defaultViolations('Which businesses in the owner’s city need help?')).toContain('the owner’s city');
    expect(defaultViolations('Who would answer a cold email about this?')).toContain('cold email');
    expect(defaultViolations('Which buyers want AI-generated logos?')).toContain('AI-produced digital work');
    expect(defaultViolations('Which buyers need someone on-site?')).toContain('physical presence');
    expect(defaultViolations('Which buyers want our existing catalogue?')).toContain('the existing catalogue');
    expect(industryFilters('Which cleaning firms have idle crews?')).toEqual(['cleaning']);
    expect(industryFilters('Which firms have idle crews (for example: cleaning — examples, not limits)?')).toEqual([]);
    // Every family example is offered somewhere, as an example.
    const all = INTERMEDIATION_BUCKETS.map((one) => one.question.toLowerCase()).join(' ');
    for (const example of INTERMEDIATION_FAMILY.examples) expect(all).toContain(example.toLowerCase());
  });

  it('are ordinary discovery buckets with unique ids and a real mechanism', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(SEARCH_BUCKETS).toContain(bucket);
      expect(isIntermediationBucket(bucket)).toBe(true);
      expect(bucket.mechanism).not.toBe('OTHER');
    }
    expect(new Set(SEARCH_BUCKETS.map((one) => one.id)).size).toBe(SEARCH_BUCKETS.length);
  });
});

describe('discovery order follows the family declaration', () => {
  it('asks intermediation buckets first while the declaration is current', () => {
    const order = discoveryOrder(SEARCH_BUCKETS, [], CURRENT);
    const n = INTERMEDIATION_BUCKETS.length;
    expect(order.slice(0, n).every((one) => isIntermediationBucket(one))).toBe(true);
    expect(order.slice(n).some((one) => isIntermediationBucket(one))).toBe(false);
    expect(order).toHaveLength(SEARCH_BUCKETS.length);
  });

  it('reverts to the ordinary order when the declaration lapses, removing nothing', () => {
    const order = discoveryOrder(SEARCH_BUCKETS, [], LAPSED);
    expect(order).toEqual(fairOrder(SEARCH_BUCKETS, []));
    expect(isIntermediationBucket(order[0]!)).toBe(false);
    for (const bucket of INTERMEDIATION_BUCKETS) expect(order).toContain(bucket);
  });

  it('a renewed declaration puts them first again', () => {
    const renewed = renewFamily(INTERMEDIATION_FAMILY, '2027-06-01');
    expect(isIntermediationBucket(discoveryOrder(SEARCH_BUCKETS, [], LAPSED, renewed)[0]!)).toBe(true);
  });
});
