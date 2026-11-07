/**
 * The $10K discovery overlooked fast-cash work the owner allows (owner,
 * 2026-11-07): "My restriction is against ME performing physical work, not
 * against selling or brokering services fulfilled by other people … Do not
 * favor or reject opportunities merely because each transaction is small."
 *
 * Each test pins one place that used to drop such an opening.
 */
import { describe, expect, it } from 'vitest';
import { clearMateriality, recordMateriality, tooSmallForGoals } from '../server/services/goals/materiality.ts';
import { parseLead } from '../server/services/cheap/lane.ts';
import { leadPassesRules } from '../server/services/feeds/run.ts';
import { REMOTE_AI_FOCUS } from '../server/services/cash/discovery.ts';
import { EXCLUSION_CLASSES, excludedBy } from '../server/services/cash/exclusions.ts';

describe('a small price is not a small opening', () => {
  it('is judged by size only once its volume is known, or when it pays once by nature', () => {
    clearMateriality();
    const now = Date.now();
    recordMateriality('g', 10_000, [
      // A $150 cleaning, volume not yet researched: not too small, ask how many buyers.
      { opportunityId: 'small-unknown', supportedReach: 150, potentialReach: 150, volumeEstablished: false },
      // Same price, volume researched and still tiny: too small.
      { opportunityId: 'small-known', supportedReach: 150, potentialReach: 150, volumeEstablished: true },
      // A one-off award is judged by its size whatever its volume.
      { opportunityId: 'award', supportedReach: 300, potentialReach: 300, volumeEstablished: false, competitiveAward: true },
    ], now);
    expect(tooSmallForGoals('small-unknown', now)).toBeNull();
    expect(tooSmallForGoals('small-known', now)).not.toBeNull();
    expect(tooSmallForGoals('award', now)).not.toBeNull();
  });
});

describe('the free-model lead screen keeps brokered and household work', () => {
  it('accepts a service a contractor performs, and the rules keep it', () => {
    const lead = parseLead(JSON.stringify({ verdict: 'KEEP', window: 'SHORT', deliverable: 'BROKERED_SERVICE', need: 'move-out cleaning by Friday', payer: 'a household', reason: 'dated request' }));
    expect(lead?.deliverable).toBe('BROKERED_SERVICE');
    const now = new Date();
    expect(leadPassesRules({ publishedAt: now.toISOString(), fetchedAt: now.toISOString() } as never, lead, now)).toBe(true);
  });
});

describe('the goal question asks for brokered services and repeat small sales beside digital work', () => {
  it('names contractor-performed and household work, and prefers neither kind', () => {
    expect(REMOTE_AI_FOCUS).toMatch(/independent contractors/);
    expect(REMOTE_AI_FOCUS).toMatch(/households/);
    expect(REMOTE_AI_FOCUS).toMatch(/Neither kind is preferred/);
    expect(REMOTE_AI_FOCUS).toMatch(/how many such buyers there are and how often each buys/);
    expect(REMOTE_AI_FOCUS).toMatch(/what it costs to get each customer/);
  });
});

describe('a place name is not a public buyer', () => {
  it('keeps a consumer opening that names a city, and still excludes public contracts', () => {
    const goal = ['GOVERNMENT_CONTRACTING'] as (keyof typeof EXCLUSION_CLASSES)[];
    expect(excludedBy('Recurring house cleaning for households in the City of Austin', goal)).toBeNull();
    expect(excludedBy('Procurement software consultancy for mid-size manufacturers', goal)).toBeNull();
    expect(excludedBy('City of Austin purchasing RFP for janitorial services', goal)).toBe('GOVERNMENT_CONTRACTING');
    expect(excludedBy("PA Department of Agriculture's Farm Vitality Planning Grant", goal)).toBe('GOVERNMENT_CONTRACTING');
    expect(excludedBy('Listing at https://www.sam.gov/opp/123', goal)).toBe('GOVERNMENT_CONTRACTING');
  });
});
