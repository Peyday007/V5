/**
 * Three root causes the planningReliability benchmark found in round 6, each
 * pinned as a general rule on synthetic openings:
 *
 *  1. Paid deals per ad click ("46 bookings from 520 clicks") are a measured
 *     close read on the visitor floor: the click is the traffic the deal was
 *     measured on, never the outcome.
 *  2. A volume stated in the measured rate's own trial unit ("60 RFQs a month"
 *     for a win rate per bid, "9,000 clicks this month" for a booking rate per
 *     click) counts the prospects that rate applies to.
 *  3. In a market whose buyers were counted, the buyers who already agreed are
 *     among them: new deals are checked against the buyers left, not the whole
 *     market again.
 */
import { describe, expect, it } from 'vitest';
import { readClickConversions, readInboundCommitments, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { readTrialVolume, readVolume } from '../server/services/cash/volume.ts';
import { measuredRateInput } from '../server/services/goals/portfolio.ts';
import { volumeCheck } from '../server/services/goals/plan.ts';

const known = (value: number, provenance: ModelInput['provenance'] = 'EVIDENCE'): ModelInput => ({ value, low: value, high: value, provenance, source: null, note: 'test' });

describe('rule 1: paid deals per ad click are a measured close', () => {
  it('reads paid outcomes against clicks', () => {
    expect(readClickConversions('46 bookings from 520 clicks')).toEqual({ paid: 46, clicks: 520, unit: 'bookings' });
    expect(readClickConversions('12 paid orders out of 900 ad clicks')).toEqual({ paid: 12, clicks: 900, unit: 'orders' });
  });

  it('never reads a click as the outcome, nor more deals than clicks', () => {
    for (const other of ['60 clicks on buy now from 300 visitors', '600 bookings from 520 clicks', '40 email signups from 240 clicks', '520 clicks last month']) {
      expect(readClickConversions(other), other).toBeNull();
    }
    // A landing page's reader is unchanged: a click is not a unique visitor.
    expect(readInboundCommitments('46 bookings from 520 clicks')).toBeNull();
  });
});

describe('rule 2: a volume in the rate’s own trial unit counts its prospects', () => {
  it('reads solicitations per period for a win rate per bid', () => {
    const text = 'The county portal posts 40 grounds-maintenance RFQs a month.';
    expect(readVolume(text, 45)).toBeNull();
    expect(readTrialVolume(text, 45, 'bids')).toMatchObject({ deals: 60, buyers: 60, counted: 'BUYERS' });
    expect(readTrialVolume(text, 30, 'bids')).toMatchObject({ deals: 40 });
    expect(readTrialVolume('12 tenders are posted each week', 14, 'tenders')).toMatchObject({ deals: 24 });
  });

  it('cuts a count over a named span to the window, and never stretches one', () => {
    expect(readTrialVolume('The ad network forecasts 3,000 clicks on these ads this March.', 15, 'clicks')).toMatchObject({ deals: 1500 });
    expect(readTrialVolume('The ad network forecasts 3,000 clicks on these ads this month.', 60, 'clicks')).toMatchObject({ deals: 3000 });
    expect(readTrialVolume('About 800 clicks are expected over the launch fortnight.', 30, 'clicks')).toMatchObject({ deals: 800 });
  });

  it('reads nothing for a unit with no trial words, or a text that states none', () => {
    expect(readTrialVolume('The county portal posts 40 RFQs a month.', 45, 'contacts')).toBeNull();
    expect(readTrialVolume('Plenty of RFQs are posted.', 45, 'bids')).toBeNull();
    expect(readTrialVolume('30% of clicks convert', 30, 'clicks')).toBeNull();
  });
});

function counted(over: Partial<ModelledOpportunity> = {}): ModelledOpportunity {
  return {
    opportunity: { id: 'o', title: 'Opening o' } as ModelledOpportunity['opportunity'],
    index: 1, tier: 'QUALIFIED', repeatable: true,
    price: known(300), capital: known(0), hours: known(1), daysToCash: known(20), close: known(0, 'UNKNOWN'), respond: known(0, 'UNKNOWN'),
    directCost: known(10), volume: known(8), prospects: 8, agreed: true, agreedValue: 1500, agreedDeals: 5, fulfilledBy: null, competitiveAward: false,
    ...over,
  } as ModelledOpportunity;
}

describe('rule 3: agreed buyers are part of a counted market', () => {
  it('checks new deals against the buyers left after the agreed ones', () => {
    // 8 buyers exist and 5 agreed: 4 more cannot be found among the 3 left.
    const short = volumeCheck(counted(), 16);
    expect(short.ok).toBe(false);
    expect(short.basis).toMatch(/only 3 are left/);
    // The same 4 new deals fit a market of 8 that nobody has signed yet.
    expect(volumeCheck(counted({ agreed: false, agreedValue: 0, agreedDeals: 0 }), 16).ok).toBe(true);
  });

  it('leaves an order rate, which counts deals rather than buyers, as before', () => {
    expect(volumeCheck(counted({ prospects: null }), 16).ok).toBe(true);
  });

  it('bounds a measured rate by the counted buyers still unasked', () => {
    // 1 of 2 asked agreed: 2 new deals need 4+ asked at the cautious end, and 10 − 5 agreed leaves 5.
    const rate = { close: measuredRateInput({ trials: 40, low: 20, high: 20 }) };
    expect(volumeCheck(counted({ ...rate, volume: known(10), prospects: 10 }), 2).ok).toBe(true);
    expect(volumeCheck(counted({ ...rate, volume: known(10), prospects: 10, agreedDeals: 9 }), 2).ok).toBe(false);
  });
});
