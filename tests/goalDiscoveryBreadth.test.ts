/**
 * The $10K goal's search, 2026-11-02: what its owner excluded is said before
 * research is spent, and constructed arrangements are dealt across buyer
 * populations rather than one population filling the top of the list.
 */
import { describe, expect, it } from 'vitest';
import { excludedBy, unionOf } from '../server/services/cash/exclusions.ts';
import { questionFor, type SearchBucket } from '../server/services/cash/discovery.ts';
import { interleaveByPopulation, type ConstructedArrangement } from '../server/services/cash/construct.ts';

const bucket: SearchBucket = { id: 'temporary-exploit', mechanism: 'TEMPORARY_EXPLOIT', title: 't', question: 'Where is money published?' };

describe('a goal exclusion reaches the question and the screen, not only the plan', () => {
  it('puts the exclusion in a broad discovery question once', () => {
    const q = questionFor(bucket, 'Collect cash', 1, [], { lines: [], omitted: 0 }, null, ['GOVERNMENT_CONTRACTING']);
    expect(q).toMatch(/Leave out government and public-sector contracts/);
    // A question that already carries it (a constructed round) is not told twice.
    const carried = questionFor({ ...bucket, question: `${bucket.question} Leave out government and public-sector contracts: the goal's owner excluded them.` }, 'Collect cash', 1, [], { lines: [], omitted: 0 }, null, ['GOVERNMENT_CONTRACTING']);
    expect(carried.match(/Leave out government/g)).toHaveLength(1);
    expect(questionFor(bucket, 'Collect cash', 1, [])).not.toMatch(/Leave out government/);
  });

  it('recognises a government source by its address, as production researched them', () => {
    for (const source of ['https://stlouis-mo.gov/bids/1', 'https://www.neh.gov/program', 'https://www.rfpmart.com/x', 'https://www.publicsurplus.com/sms/auction']) {
      expect(excludedBy(`Some opening ${source}`, ['GOVERNMENT_CONTRACTING'])).toBe('GOVERNMENT_CONTRACTING');
    }
    expect(excludedBy('Holiday light installation for homeowners https://example.com', ['GOVERNMENT_CONTRACTING'])).toBeNull();
  });

  it('takes the union of what live goals exclude', () => {
    expect(unionOf([{ exclusions: ['WEBSITE_REPAIR'] }, { exclusions: ['GOVERNMENT_CONTRACTING'] }])).toEqual(['GOVERNMENT_CONTRACTING', 'WEBSITE_REPAIR']);
    expect(unionOf([])).toEqual([]);
  });
});

describe('constructed arrangements are dealt one buyer population at a time', () => {
  const arrangement = (key: string, sector: string | null, safe = true): ConstructedArrangement =>
    ({ key, sector, demand: { name: key, claimId: null, from: 'REVERSE', ref: `ref-${key}` }, stress: { exposure: safe ? 'SAFE' : 'EXCEEDS' } }) as unknown as ConstructedArrangement;

  it('interleaves sectors and never lets a riskier arrangement jump a safer one', () => {
    const sorted = [arrangement('a1', 'Anime'), arrangement('a2', 'Anime'), arrangement('a3', 'Anime'), arrangement('h1', 'Home services'), arrangement('r1', null), arrangement('x1', 'Gifts', false)];
    const exposure = (one: ConstructedArrangement) => (one.stress.exposure === 'SAFE' ? 0 : 1);
    const out = interleaveByPopulation(sorted, exposure).map((one) => one.key);
    expect(out.slice(0, 3)).toEqual(['a1', 'h1', 'r1']);
    expect(out).toEqual(['a1', 'h1', 'r1', 'a2', 'a3', 'x1']);
  });
});

describe('domain speculation, as the owner excluded it on 2026-11-02', () => {
  it('reads the owner\'s words as an exclusion and recognises the openings production named', async () => {
    const { exclusionsIn } = await import('../server/services/cash/exclusions.ts');
    expect(exclusionsIn('No government contracts. No high-priced domain speculation.')).toEqual(['GOVERNMENT_CONTRACTING', 'DOMAIN_SPECULATION']);
    expect(exclusionsIn('Sell domain names to buyers who want them')).toEqual([]);
    for (const title of [
      'dujo.com is listed for sale on Afternic (a GoDaddy marketplace) with a live Buy Now',
      "Appraise.net's retail appraisal for VJN.com was $55,000-$85,000",
      'Domain brokerage (domain acquisition and sale brokers)',
    ]) {
      expect(excludedBy(title, ['DOMAIN_SPECULATION'])).toBe('DOMAIN_SPECULATION');
    }
    expect(excludedBy('Holiday tree delivery in Mechanicsburg, booked on example.com', ['DOMAIN_SPECULATION'])).toBeNull();
  });

  it('halves the samples when the portfolio doubles', async () => {
    const { defaultEvaluations } = await import('../server/services/goals/plan.ts');
    expect(defaultEvaluations(4)).toBe(20_000);
    expect(defaultEvaluations(8)).toBe(10_000);
    expect(defaultEvaluations(1)).toBe(20_000);
  });
});
