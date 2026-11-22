/**
 * planningReliability round 9: what the volume reader counts.
 *
 * - A payer named by a compound before its role ("Marina berth managers",
 *   "Depot facility managers") is counted by each noun of the compound, and a
 *   noun ending in -y pluralizes to -ies, so a market sized in the payer's own
 *   organisation noun is read as sized rather than left open.
 * - A cycle whose due dates research states are spread through it is bounded
 *   by the window: buyers renewing once a year, evenly, make window/365 of
 *   their renewals inside a month — never one each. A cycle stated without its
 *   timing keeps one purchase each, as before.
 * - A reconstruction that counts money from a member whose price nobody has
 *   established is not adopted as the plan (invariant 39), whichever
 *   arrangements a run happened to construct.
 */
import { describe, expect, it } from 'vitest';
import { payerHeldWords, readVolume } from '../server/services/cash/volume.ts';
import { adoptReconstruction } from '../server/services/goals/plan.ts';
import type { Reconstruction, VariantReading } from '../server/services/goals/reconstruction.ts';

describe('payerHeldWords: the nouns of a compound before the role', () => {
  it('reads each organisation noun and pluralizes -y to -ies', () => {
    expect(payerHeldWords('Depot facility managers')).toEqual(expect.arrayContaining(['depot', 'depots', 'facility', 'facilities']));
    expect(payerHeldWords('Depot facility managers')).not.toContain('facilitys');
    expect(payerHeldWords('Marina berth revenue managers')).toEqual(expect.arrayContaining(['marinas', 'berths']));
  });
  it('never takes an adjective further out than the head', () => {
    expect(payerHeldWords('Licensed regional depot managers')).not.toContain('licenseds');
    expect(payerHeldWords('Licensed regional depot managers')).not.toContain('regionals');
    expect(payerHeldWords('Licensed regional depot managers')).toContain('depots');
  });
  it('sizes a market counted in the compound noun', () => {
    expect(readVolume('310 marinas are listed in the harbour directory; each books berth audits every quarter.', 45, 'Marina berth revenue managers')).toMatchObject({ buyers: 310 });
    expect(readVolume('95 depot facilities are registered; each contracts cleaning monthly.', 30, 'Depot facility managers')).toMatchObject({ buyers: 95 });
  });
});

describe('readVolume: a spread cycle is bounded by the window', () => {
  it('counts only the purchases that fall due inside the window', () => {
    // 730 × 30 / 365 = 60.
    expect(readVolume('730 shops renew their hygiene certificate once a year, spread evenly through the year.', 30)).toMatchObject({ deals: 60, buyers: 730, everyDays: 365 });
    // 200 × 20 / 91 = 43.
    expect(readVolume('200 clinics each recalibrate quarterly on a rolling schedule.', 20)).toMatchObject({ deals: 43, buyers: 200 });
  });
  it('keeps one purchase each when the timing is not stated', () => {
    expect(readVolume('730 shops renew their hygiene certificate once a year.', 30)).toMatchObject({ deals: 730 });
    expect(readVolume('200 clinics each recalibrate quarterly.', 20)).toMatchObject({ deals: 200 });
  });
  it('reads once and twice as a frequency, and a stated renewal rate as orders', () => {
    expect(readVolume('90 salons renew twice a year, staggered across the year.', 30)).toMatchObject({ deals: 14 });
    expect(readVolume('About 25 renewals a month are filed.', 30)).toMatchObject({ deals: 25, counted: 'ORDERS' });
  });
});

describe('adoptReconstruction: an unpriced member is not evidence of reach', () => {
  const variant = (over: Partial<VariantReading> = {}): VariantReading =>
    ({ key: 'as planned', changes: [], reach: 0.05, settledP10: 0, settledP50: 3000, settledP90: 6000, basis: 'COVERAGE', committed: 0, feasible: true, why: null, members: ['Held opening'], ...over }) as VariantReading;
  const estimated = { dimension: 'ACQUISITION', label: 'partner', detail: 'sell through a partner', cost: 0, basis: 'ESTIMATE', startDay: { low: 0, high: 0 } } as unknown as VariantReading['changes'][number];
  const reconstruction = {
    required: 0.9, baseline: variant(), diagnosis: [], headroom: { reach: 0.8, settledP50: 9000 }, structural: false, challenges: [], rounds: [],
    best: variant({ key: 'ACQUISITION:partner', reach: 0.8, settledP50: 9000, members: ['Constructed arrangement'], changes: [estimated] }),
    floor: variant({ reach: 0 }), requiredReply: null, volumePlans: [], limitation: null, confidence: { basis: 'COVERAGE', measured: [], assumed: [], statement: '' }, searchBrief: '', evaluations: 4, exploration: null, flags: [],
  } as unknown as Reconstruction;
  const openings = [{ opportunity: { id: 'held', title: 'Held opening' } }, { opportunity: { id: 'arr_x', title: 'Constructed arrangement' } }];
  const baseline = (unestablished: string[]) =>
    ({ best: { reach: 0.05, settledP50: 3000 }, demand: [{ opportunityId: 'arr_x', unestablished }] }) as unknown as Parameters<typeof adoptReconstruction>[0]['baseline'];

  it('keeps the plan as held when the reconstruction counts an unpriced member', () => {
    const out = adoptReconstruction({ reconstruction, baseline: baseline(['price', 'close rate']), openings });
    expect(out.candidate).toBeNull();
    expect(out.adoption).toMatchObject({ source: 'BASELINE', hypothetical: true });
    expect(out.adoption.reason).toMatch(/whose price nobody has established/);
  });
  it('adopts the same reconstruction once its members are priced', () => {
    const out = adoptReconstruction({ reconstruction, baseline: baseline(['close rate']), openings });
    expect(out.adoption.source).toBe('RECONSTRUCTED');
    expect(out.candidate!.opportunityIds).toEqual(['arr_x']);
  });
});
