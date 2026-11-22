/**
 * Four root causes the planningReliability benchmark found in round 4, each
 * pinned as a general rule on synthetic openings:
 *
 *  1. Agreements per buyer contacted ("6 agreements from 40 contacts") are a
 *     measured close, exactly like Brain's own per-contact record: an outreach
 *     play's own measurement was dropped and its conversion read as unknown.
 *  2. A count of what the payer holds counts buyers ("3,400 boats" for boat
 *     owners), and a price per period is one subscription per buyer, never the
 *     buyers times the service's own frequency.
 *  3. A volume statement with no count is an unsized market — a repeatable
 *     play with its volume link open — never a one-off whose one buyer passes it.
 *  4. A measured rate wins at most its share of the prospects the market holds:
 *     a per-visitor rate applied to a count of stores cannot ask more stores
 *     than exist.
 *  5. An agreed lot that ties up money the plan does not need is left out when
 *     the owner's ceiling rules it out and the other openings still reach the
 *     target — the capital counterpart of the spare-owner-work rule.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { measuredRateInput } from '../server/services/goals/portfolio.ts';
import { modelOpportunity, readOfferWins, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { payerHeldWords, readVolume } from '../server/services/cash/volume.ts';
import { conservative, prospectsAsked, withoutSpareCapitalLots } from '../server/services/goals/plan.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';

const known = (value: number, provenance: ModelInput['provenance'] = 'EVIDENCE'): ModelInput => ({ value, low: value, high: value, provenance, source: null, note: 'test' });

describe('rule 1: agreements per contact are a measured close', () => {
  it('reads agreements against contacts, and still nothing that is not a buyer asked', () => {
    expect(readOfferWins('6 agreements from 40 contacts')).toEqual({ won: 6, offers: 40, unit: 'contacts' });
    expect(readOfferWins('9 orders of 30 stores asked')).toEqual({ won: 9, offers: 30, unit: 'asked' });
    expect(readOfferWins('2 signed of 25 firms approached')).toEqual({ won: 2, offers: 25, unit: 'approached' });
    for (const other of ['22 orders from 1,900 members', '4 paid pre-orders from 1600 unique visitors', '40 contacts made', '50 agreements from 40 contacts']) {
      expect(readOfferWins(other), other).toBeNull();
    }
  });
});

describe('rule 2: what a count counts', () => {
  it('reads the noun a payer is named for holding as a buyer word, and only that noun', () => {
    expect(payerHeldWords('Recreational boat owners')).toEqual(expect.arrayContaining(['boat', 'boats']));
    expect(payerHeldWords('Recreational boat owners')).not.toContain('recreationals');
    expect(payerHeldWords('Fleet operators')).toEqual(expect.arrayContaining(['fleets']));
    expect(payerHeldWords('Engineering firms')).toEqual([]);
    expect(payerHeldWords(null)).toEqual([]);
  });

  it('counts held things as buyers only for the payer that holds them', () => {
    const text = '2,100 kayaks are registered in the district; each must be stored for winter.';
    expect(readVolume(text, 30)).toBeNull();
    expect(readVolume(text, 30, 'Kayak owners')).toMatchObject({ deals: 2100, buyers: 2100, counted: 'BUYERS' });
    // An order rate is still an order rate.
    expect(readVolume('120 firms ship 3 orders a month', 30, 'Kayak owners')).toMatchObject({ counted: 'ORDERS' });
  });

  describe('through the real card read', () => {
    let projectId = '';
    let userId = '';
    let cashModeId = '';

    beforeEach(async () => {
      projectId = (await freshProject()).project.id;
      userId = (await createUser({ email: `r4-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
      expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
      cashModeId = (await getCashMode(projectId))!.id;
    });

    async function model(o: { price: string; priceCents: number; volume?: { text: string; kind: 'EVIDENCE' | 'RECOMMENDATION' }; conversion?: string; payer?: string; title?: string }) {
      const opp = await createOpportunity({
        projectId, cashModeId, ownerUserId: userId, title: o.title ?? 'Gutter cleaning for property managers', mechanism: 'SUBCONTRACTED_FULFILMENT', currency: 'USD',
        sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [],
      });
      const fact = (field: string, value: string, kind: 'EVIDENCE' | 'RECOMMENDATION' = 'EVIDENCE') =>
        recordCardFact({ projectId, opportunityId: opp.id, field, kind, value, claimId: kind === 'EVIDENCE' ? `clm_${field}_${opp.id}` : null, decidedBy: 'BRAIN' });
      await fact(CAPTURE_KEY, 'Sell the work.');
      await updateOpportunity(opp.id, { price_cents: o.priceCents, offer_scope: 'One job', payer: o.payer ?? 'Property managers' });
      await fact('price', o.price);
      if (o.volume) await fact('buyerVolume', o.volume.text, o.volume.kind);
      if (o.conversion) await fact('conversionRates', o.conversion);
      const modelled = await modelOpportunity((await getOpportunity(opp.id))!, 0, 'QUALIFIED', 'USD', [], null, new Date(), 60);
      if ('reason' in modelled) throw new Error(modelled.reason);
      return modelled;
    }

    it('reads a per-period price as one subscription per buyer, whatever the service frequency', async () => {
      const subscription = await model({ price: '$90 a month', priceCents: 9_000, volume: { text: '140 dental offices in the county each need their filters changed weekly.', kind: 'EVIDENCE' } });
      expect(subscription.repeatable).toBe(true);
      expect(subscription.volume.value).toBe(140);
      // A price per job keeps the buyers times how often each buys.
      const perJob = await model({ price: '$90', priceCents: 9_000, volume: { text: '140 dental offices in the county each need their filters changed weekly.', kind: 'EVIDENCE' } });
      expect(perJob.volume.value).toBeGreaterThan(140);
    });

    it('reads agreements per contact as the measured close through the card', async () => {
      const modelled = await model({ price: '$500', priceCents: 50_000, volume: { text: '600 property managers are listed.', kind: 'EVIDENCE' }, conversion: '6 agreements from 40 contacts' });
      expect(modelled.close.provenance).toBe('HISTORICAL');
      expect(modelled.close.low!).toBeLessThan(6 / 40);
      expect(modelled.respond.value).toBe(1);
      expect(modelled.prospects).toBe(600);
    });

    it('rule 3: reads a volume with no count as an unsized repeatable market, not a one-off', async () => {
      for (const kind of ['EVIDENCE', 'RECOMMENDATION'] as const) {
        const modelled = await model({ price: '$350', priceCents: 35_000, volume: { text: 'Managers in the region probably clean gutters every few months.', kind }, conversion: '3 wins from 12 quotes' });
        expect(modelled.repeatable, kind).toBe(true);
        expect(modelled.volume.value, kind).toBeNull();
        expect(modelled.prospects ?? null, kind).toBeNull();
      }
      // With no volume statement at all, nothing changes: a one-off is one deal.
      const none = await model({ price: '$350', priceCents: 35_000 });
      expect(none.repeatable).toBe(false);
    });
  });
});

describe('rule 4: a measured rate wins at most its share of the prospects that exist', () => {
  function play(over: { close: ModelInput; volume: number; prospects: number | null; price?: number }): ModelledOpportunity {
    return {
      repeatable: true, agreed: false, agreedValue: 0, agreedDeals: 0,
      price: known(over.price ?? 600), close: over.close, volume: known(over.volume), prospects: over.prospects,
      daysToCash: known(7), directCost: known(300), capital: known(0), hours: known(0.5),
    } as unknown as ModelledOpportunity;
  }

  it('asks deals ÷ the cautious close, and nothing when prospects are not counted', () => {
    const visitorRate = measuredRateInput({ trials: 1600, low: 4, high: 4 });
    const one = play({ close: visitorRate, volume: 300, prospects: 300 });
    expect(prospectsAsked(one, 10)).toBeGreaterThan(300);
    expect(prospectsAsked(play({ close: visitorRate, volume: 300, prospects: null }), 10)).toBeNull();
    const contactRate = measuredRateInput({ trials: 40, low: 6, high: 6 });
    expect(prospectsAsked(play({ close: contactRate, volume: 500, prospects: 500 }), 9)).toBeLessThanOrEqual(500);
  });

  it('caps the conservative figure at the prospects held times the rate', () => {
    const close = measuredRateInput({ trials: 1600, low: 4, high: 4 });
    const offers = 20_000;
    const capped = conservative([{ one: play({ close, volume: 300, prospects: 300 }), deals: offers }], { daysLeft: 30 });
    expect(capped.settled!).toBeLessThan(600);
    // An order-rate volume counts deals made, not prospects: the cap does not apply.
    const uncapped = conservative([{ one: play({ close, volume: 300, prospects: null }), deals: offers }], { daysLeft: 30 });
    expect(uncapped.settled!).toBeGreaterThan(capped.settled!);
  });
});

describe('rule 5: an agreed lot the plan does not need does not break the capital limit', () => {
  const member = (id: string, over: { agreedValue?: number; agreedDeals?: number; capital?: number; close?: ModelInput; price?: number; volume?: number }, deals: number) => ({
    one: {
      opportunity: { id, title: id }, repeatable: !over.agreedDeals, agreed: !!over.agreedDeals, agreedValue: over.agreedValue ?? 0, agreedDeals: over.agreedDeals ?? 0,
      price: known(over.price ?? 9000), close: over.close ?? known(0, 'UNKNOWN'), volume: known(over.volume ?? 1), prospects: null,
      daysToCash: known(7), directCost: known(10), capital: known(over.capital ?? 0), hours: known(0.5),
    } as unknown as ModelledOpportunity,
    deals,
  });
  const target = { daysLeft: 45, remainingCents: 800_000 };
  const lot = member('lot', { agreedValue: 9000, agreedDeals: 1, capital: 6000 }, 0);
  const service = member('service', { price: 400, volume: 900, close: measuredRateInput({ trials: 40, low: 6, high: 6 }) }, 400);

  it('leaves the lot out when the ceiling rules it out and the service reaches the target alone', () => {
    expect(withoutSpareCapitalLots([lot, service], { ...target, capitalCeilingCents: 0 }).map((m) => m.one.opportunity.id)).toEqual(['service']);
  });

  it('keeps it when the ceiling allows it, when there is no ceiling, or when the rest falls short', () => {
    expect(withoutSpareCapitalLots([lot, service], { ...target, capitalCeilingCents: 1_000_000 })).toHaveLength(2);
    expect(withoutSpareCapitalLots([lot, service], target)).toHaveLength(2);
    expect(withoutSpareCapitalLots([lot, service], { ...target, capitalBeforeProofCents: 0 }).map((m) => m.one.opportunity.id)).toEqual(["service"]);
    const small = member('small', { price: 400, volume: 900, close: measuredRateInput({ trials: 40, low: 6, high: 6 }) }, 20);
    expect(withoutSpareCapitalLots([lot, small], { ...target, capitalCeilingCents: 0 })).toHaveLength(2);
  });
});
