/**
 * The $10K goal's search, 2026-11-02: what its owner excluded is said before
 * research is spent, and constructed arrangements are dealt across buyer
 * populations rather than one population filling the top of the list.
 */
import { describe, expect, it } from 'vitest';
import { commonTo, excludedBy, exclusionsIn } from '../server/services/cash/exclusions.ts';
import { questionFor, type SearchBucket } from '../server/services/cash/discovery.ts';
import { interleaveByPopulation, type ConstructedArrangement } from '../server/services/cash/construct.ts';

const bucket: SearchBucket = { id: 'temporary-exploit', mechanism: 'TEMPORARY_EXPLOIT', title: 't', question: 'Where is money published?' };

describe('a goal exclusion reaches the question and the screen, not only the plan', () => {
  it('puts the exclusion in a broad discovery question once', () => {
    const q = questionFor(bucket, 'Collect cash', 1, [], { lines: [], omitted: 0 }, null, ['WEBSITE_REPAIR']);
    expect(q).toMatch(/Leave out broken-website and website-repair plays/);
    // A question that already carries it (a constructed round) is not told twice.
    const carried = questionFor({ ...bucket, question: `${bucket.question} Leave out broken-website and website-repair plays: the goal's owner excluded them.` }, 'Collect cash', 1, [], { lines: [], omitted: 0 }, null, ['WEBSITE_REPAIR']);
    expect(carried.match(/Leave out broken-website/g)).toHaveLength(1);
    expect(questionFor(bucket, 'Collect cash', 1, [])).not.toMatch(/Leave out/);
  });

  it('shares only what every live goal excludes: one goal never narrows the project\'s discovery', () => {
    expect(commonTo([{ exclusions: ['WEBSITE_REPAIR'] }, { exclusions: ['DOMAIN_SPECULATION', 'WEBSITE_REPAIR'] }])).toEqual(['WEBSITE_REPAIR']);
    expect(commonTo([{ exclusions: ['WEBSITE_REPAIR'] }, { exclusions: [] }])).toEqual([]);
    expect(commonTo([])).toEqual([]);
  });
});

describe('an industry is never excluded (owner, 2026-11-12)', () => {
  it('reads the $10K goal\'s old government words as excluding nothing, and keeps every government opening in play', () => {
    expect(exclusionsIn('No government contracts. No high-priced domain speculation.')).toEqual(['DOMAIN_SPECULATION']);
    expect(exclusionsIn('Avoid government/federal contracts and public-sector work.')).toEqual([]);
    const everyClass = ['WEBSITE_REPAIR', 'DOMAIN_SPECULATION'] as const;
    for (const opening of [
      'Listing at https://www.sam.gov/opp/123',
      'City of Austin purchasing RFP for janitorial services',
      "PA Department of Agriculture's Farm Vitality Planning Grant",
      'Weekly federal bid digest for small contractors (SAM.gov, USAspending)',
    ]) {
      expect(excludedBy(opening, everyClass)).toBeNull();
    }
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
    expect(exclusionsIn('No high-priced domain speculation.')).toEqual(['DOMAIN_SPECULATION']);
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

describe('an opening the goal plan judged too small is not researched by any other spender', () => {
  it('screens it out once every goal that read it found it under the floor, and not before', async () => {
    const { recordMateriality, clearMateriality } = await import('../server/services/goals/materiality.ts');
    const { notWorthResearching } = await import('../server/services/cash/worthResearching.ts');
    clearMateriality();
    const now = new Date().toISOString();
    const sneaker = { id: 'cop_sneaker', projectId: '', title: 'A concert ticket resale at $783', sourceClaimId: null, expiresAt: null } as never;
    // Nobody has read it: nothing to say.
    expect(await notWorthResearching(sneaker, { now })).toBeNull();
    recordMateriality('wst_a', 10_000, [{ opportunityId: 'cop_sneaker', supportedReach: 0, potentialReach: 205 }]);
    const reason = await notWorthResearching(sneaker, { now });
    expect(reason).toMatchObject({ kind: 'SCREENED_OUT', reason: 'TOO_SMALL_FOR_GOAL' });
    // A second goal that could use it keeps it worth researching.
    recordMateriality('wst_b', 1_000, [{ opportunityId: 'cop_sneaker', supportedReach: 0, potentialReach: 205 }]);
    expect(await notWorthResearching(sneaker, { now })).toBeNull();
    // An opening with no price at all is asked what buyers pay, never called small.
    clearMateriality();
    recordMateriality('wst_a', 10_000, [{ opportunityId: 'cop_sneaker', supportedReach: 0, potentialReach: null }]);
    expect(await notWorthResearching(sneaker, { now })).toBeNull();
  });
});
