import { describe, expect, it } from 'vitest';
import {
  INTERMEDIATION_BUCKETS,
  composeQuestion,
  isIntermediationBucket,
  namedDefaults,
  nearDuplicateBuckets,
  uncoveredEntryPoints,
} from '../server/services/cash/intermediationBuckets.ts';
import { ENTRY_POINTS, INTERMEDIATION_FAMILY, renewFamily } from '../server/services/cash/intermediationPositions.ts';
import { fairOrder, familyOrder, SEARCH_BUCKETS } from '../server/services/cash/discovery.ts';
import { APPROVAL_ENVELOPES } from '../server/services/research/approvalEnvelope.ts';
import { describesOwnAction } from '../server/services/research/actorScope.ts';

const INSIDE = '2026-12-01T00:00:00.000Z';
const AFTER = '2027-03-01T00:00:00.000Z';

describe('RES-15-4 intermediation entry buckets', () => {
  it('has buyer-first and supply-first buckets covering every S-0149 entry point', () => {
    const directions = new Set(INTERMEDIATION_BUCKETS.map((one) => one.direction));
    expect(directions).toEqual(new Set(['BUYER_FIRST', 'SUPPLY_FIRST']));
    expect(uncoveredEntryPoints(INTERMEDIATION_BUCKETS)).toEqual([]);
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(ENTRY_POINTS[bucket.direction] as readonly string[]).toContain(bucket.entryPoint);
    }
    // A set missing an entry point is reported, not passed.
    expect(uncoveredEntryPoints(INTERMEDIATION_BUCKETS.filter((one) => one.entryPoint !== 'bundled supply'))).toEqual([
      'bundled supply',
    ]);
  });

  it('spans more than one buyer type and market structure', () => {
    expect(new Set(INTERMEDIATION_BUCKETS.map((one) => one.buyerType)).size).toBeGreaterThan(1);
    expect(new Set(INTERMEDIATION_BUCKETS.map((one) => one.marketStructure)).size).toBeGreaterThan(1);
    expect(new Set(INTERMEDIATION_BUCKETS.map((one) => one.buyerType)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(INTERMEDIATION_BUCKETS.map((one) => one.marketStructure)).size).toBeGreaterThanOrEqual(5);
  });

  it('passes its own diversity check, which refuses questions that differ only by industry', () => {
    expect(nearDuplicateBuckets(INTERMEDIATION_BUCKETS)).toEqual([]);

    const base = INTERMEDIATION_BUCKETS.find((one) => one.id === 'intermediation-unused-capacity')!;
    const swapped = {
      ...base,
      id: 'intermediation-unused-capacity-copy',
      buyerType: 'CONSUMER',
      ask: base.ask.replace('manufacturing, logistics or concrete', 'cleaning, roofing or plumbing'),
    };
    swapped.question = composeQuestion(swapped.ask);
    const found = nearDuplicateBuckets([base, swapped]);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe('SAME_QUESTION_BUT_INDUSTRY');

    // The same entry, buyer and structure is one search whatever the wording.
    const sameEntry = { ...base, id: 'x', ask: 'Entirely different words about something else altogether?' };
    expect(nearDuplicateBuckets([base, sameEntry]).map((one) => one.reason)).toEqual(['SAME_ENTRY']);
  });

  it('names industries only as examples, never as a filter', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(bucket.ask, bucket.id).toMatch(/for example .* or (?:in )?any other market\?$/);
    }
    // Every family example appears somewhere, so the set is not secretly narrower.
    const all = INTERMEDIATION_BUCKETS.map((one) => one.ask.toLowerCase()).join(' ');
    for (const example of ['cleaning', 'concrete', 'trades', 'logistics', 'distribution', 'manufacturing', 'marketing', 'ai', 'regulated-industry']) {
      expect(all, example).toContain(example);
    }
  });

  it('defaults to none of the owner’s city, presence, catalogue, cold email or AI digital work', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(namedDefaults(bucket.question), bucket.id).toEqual([]);
    }
    expect(namedDefaults('Which buyers near you want cold email about our existing catalogue?')).toEqual([
      'the owner’s city',
      'the existing catalogue',
      'cold email',
    ]);
    expect(namedDefaults('Who buys AI-generated logos from somebody with a physical presence?')).toEqual([
      'physical presence',
      'AI-produced digital work',
    ]);
  });

  it('asks for S-0150 per-position evidence rather than industry facts', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(bucket.question.trimEnd().endsWith('?'), bucket.id).toBe(true);
      expect(bucket.question.match(/\?/g), bucket.id).toHaveLength(1);
      for (const phrase of [
        'introducer',
        'control-right holder',
        'exact payer',
        'channel',
        'observed demand',
        'offer made or proposed',
        'supplier or capacity',
        'price and spread',
        'acquisition costs and throughput',
        'fulfilment',
        'margin and timing',
        'buyer funds fulfilment',
        'capital exposed',
        'rights',
        'uncertain',
        'fastest meaningful next action',
        'buyer-access and',
      ]) {
        expect(bucket.question, `${bucket.id}: ${phrase}`).toContain(phrase);
      }
    }
  });

  it('is part of the ordinary search buckets, and asking stays reading', () => {
    for (const bucket of INTERMEDIATION_BUCKETS) {
      expect(SEARCH_BUCKETS).toContain(bucket);
      expect(isIntermediationBucket(bucket)).toBe(true);
      expect(bucket.deliverable).toBeUndefined();
      expect(bucket.mechanism).not.toBe('OTHER');
    }
    expect(SEARCH_BUCKETS.filter(isIntermediationBucket)).toHaveLength(INTERMEDIATION_BUCKETS.length);
    expect(new Set(SEARCH_BUCKETS.map((one) => one.id)).size).toBe(SEARCH_BUCKETS.length);
    const cash = Object.values(APPROVAL_ENVELOPES).filter((one) => one.id.startsWith('RUSSELL_CASH_'));
    for (const bucket of INTERMEDIATION_BUCKETS) {
      for (const envelope of cash) {
        expect(describesOwnAction(bucket.question, envelope.forbiddenActions), `${bucket.id} / ${envelope.id}`).toBe(false);
      }
    }
  });

  it('is offered first while the family declaration is current, and in ordinary order once it lapses', () => {
    const current = familyOrder(SEARCH_BUCKETS, [], INSIDE);
    const n = INTERMEDIATION_BUCKETS.length;
    expect(current.slice(0, n).every(isIntermediationBucket)).toBe(true);
    expect(current.slice(n).some(isIntermediationBucket)).toBe(false);
    expect(current).toHaveLength(SEARCH_BUCKETS.length);

    const lapsed = familyOrder(SEARCH_BUCKETS, [], AFTER);
    expect(lapsed.map((one) => one.id)).toEqual(fairOrder(SEARCH_BUCKETS, []).map((one) => one.id));
    expect(isIntermediationBucket(lapsed[0]!)).toBe(false);

    // Before the declaration took effect it is not current either.
    expect(familyOrder(SEARCH_BUCKETS, [], '2026-11-01T00:00:00.000Z').map((one) => one.id)).toEqual(
      lapsed.map((one) => one.id),
    );

    // Renewing the declaration restores the priority after the old review date.
    const renewed = renewFamily(INTERMEDIATION_FAMILY, '2027-06-01');
    expect(isIntermediationBucket(familyOrder(SEARCH_BUCKETS, [], AFTER, renewed)[0]!)).toBe(true);
  });
});
