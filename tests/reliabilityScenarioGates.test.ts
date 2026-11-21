/**
 * Three root causes the planningReliability benchmark found
 * (bench/planningReliability/BASELINE.md), each pinned as a general rule:
 *
 *  1. A repeatable play's buyers offered follow from the measured close rate and
 *     the evidenced volume (needed deals ÷ the cautious close, capped by volume),
 *     not a fixed 4× — with a measured 10% the fixed multiple never reached the
 *     target though 400 buyers were evidenced (fam-01, ho-01, ho-06, ho-11).
 *  2. A card price contradicted by its own sourced price fact is contested, never
 *     read as evidence and never silently the higher figure (fam-07, ho-13).
 *  3. Changing a goal's objective moves its stored target — figure, amount and
 *     cadence — with the words, through `setTarget` and its event (ho-14).
 *  4. A win rate measured on priced offers ("6 wins from 40 quotes") is the
 *     opening's measured close, on the floor Brain's own per-contact record uses;
 *     the visitor floor of a landing-page smoke test is not applied to it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { changeObjective, createGoal } from '../server/services/goals/decide.ts';
import { goalScope } from '../server/services/goals/target.ts';
import { measuredRateInput } from '../server/services/goals/portfolio.ts';
import { dealsForGoal, MAX_BUYERS_OFFERED, modelOpportunity, OUTREACH_MULTIPLE, priceContradiction, readOfferWins, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { CAPTURE_KEY } from '../server/services/cash/tier.ts';

const known = (value: number, provenance: ModelInput['provenance'] = 'EVIDENCE'): ModelInput => ({ value, low: value, high: value, provenance, source: null, note: 'test' });
const sweep = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'test' });

function play(over: { close: ModelInput; volume: ModelInput; price?: number }): ModelledOpportunity {
  return { repeatable: true, agreedValue: 0, agreedDeals: 0, price: known(over.price ?? 600), close: over.close, volume: over.volume } as unknown as ModelledOpportunity;
}

describe('rule 1: the buyers offered follow from the measured close and the evidenced volume', () => {
  it('offers enough buyers that the cautious measured close covers the deals needed (fam-01: $5,000 at $600, 10% of 400)', () => {
    const close = measuredRateInput({ trials: 400, low: 40, high: 40 });
    const one = play({ close, volume: known(400) });
    const offered = dealsForGoal(one, 5000);
    const needed = Math.ceil(5000 / 600);
    // The cautious close is the end the plan's conservative figure reads.
    expect(offered * close.low!).toBeGreaterThanOrEqual(needed);
    expect(offered).toBeLessThanOrEqual(400);
  });

  it('is capped where the evidenced volume is exhausted, never at the volume read as buyers (ho-11)', () => {
    const close = measuredRateInput({ trials: 200, low: 22, high: 22 });
    // 85 deliveries a month at a measured 11%: 17 needed. A cap of 85 buyers would win about 6.
    const one = play({ close, volume: known(85), price: 180 });
    const offered = dealsForGoal(one, 3000);
    expect(Math.min(offered * close.low!, 85)).toBeGreaterThanOrEqual(Math.ceil(3000 / 180));
    expect(offered).toBeGreaterThan(MAX_BUYERS_OFFERED);
    // Past volume ÷ close another buyer asked wins nothing more.
    const exhausted = dealsForGoal(play({ close, volume: known(30), price: 100 }), 10_000);
    expect(exhausted).toBe(Math.ceil(30 / close.low! - 1e-9));
  });

  it('keeps the fixed multiple when no rate was measured, and never offers fewer than it', () => {
    expect(dealsForGoal(play({ close: sweep(0.02, 0.5), volume: known(400) }), 5000)).toBe(Math.ceil(5000 / 600) * OUTREACH_MULTIPLE);
    // A high measured close does not shrink the offer below the multiple.
    expect(dealsForGoal(play({ close: measuredRateInput({ trials: 100, low: 80, high: 80 }), volume: known(400) }), 5000)).toBe(Math.ceil(5000 / 600) * OUTREACH_MULTIPLE);
    // A market too small for the deals needed still reads as too small to the volume link (deals = offers ÷ the multiple).
    const small = dealsForGoal(play({ close: measuredRateInput({ trials: 400, low: 40, high: 40 }), volume: known(5) }), 5000);
    expect(small).toBeGreaterThanOrEqual(Math.ceil(5000 / 600) * OUTREACH_MULTIPLE);
    expect(Math.ceil(small / OUTREACH_MULTIPLE)).toBeGreaterThan(5);
  });
});

describe('rule 2: a sourced price that contradicts the card makes the price contested', () => {
  it('reads a figure far from every stated price as a contradiction, and an agreeing one as none', () => {
    expect(priceContradiction(600, '$60', 'USD')?.stated).toBe(60);
    expect(priceContradiction(900, '$90', 'USD')?.stated).toBe(90);
    expect(priceContradiction(600, '$600', 'USD')).toBeNull();
    expect(priceContradiction(900, '$900 a month', 'USD')).toBeNull();
    expect(priceContradiction(600, '$500 to $700 per engagement', 'USD')).toBeNull();
    expect(priceContradiction(600, 'buyers pay what the card says', 'USD')).toBeNull();
  });

  describe('through the real card read', () => {
    let projectId = '';
    let userId = '';
    let cashModeId = '';

    beforeEach(async () => {
      projectId = (await freshProject()).project.id;
      userId = (await createUser({ email: `rg-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
      expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
      cashModeId = (await getCashMode(projectId))!.id;
    });

    async function card(priceFact: string) {
      const o = await createOpportunity({
        projectId, cashModeId, ownerUserId: userId, title: 'Vendor-compliance spreadsheet', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD',
        sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [],
      });
      await recordCardFact({ projectId, opportunityId: o.id, field: CAPTURE_KEY, kind: 'EVIDENCE', value: 'Sell the spreadsheet.', claimId: `clm_c_${o.id}`, decidedBy: 'BRAIN' });
      await updateOpportunity(o.id, { price_cents: 60_000, offer_scope: 'The spreadsheet', payer: 'Property managers' });
      await recordCardFact({ projectId, opportunityId: o.id, field: 'price', kind: 'EVIDENCE', value: priceFact, claimId: `clm_price_${o.id}`, decidedBy: 'BRAIN' });
      return (await getOpportunity(o.id))!;
    }

    it('never reads the contradicted card price as evidence, and plans on the lower figure', async () => {
      const contested = await modelOpportunity(await card('$60'), 0, 'QUALIFIED', 'USD', [], null, new Date(), 30);
      if ('reason' in contested) throw new Error(contested.reason);
      expect(contested.price.provenance).not.toBe('EVIDENCE');
      expect(contested.price.value).toBeNull();
      expect(contested.price.low).toBe(60);
      expect(contested.price.high).toBe(600);
      expect(contested.price.note).toMatch(/contested/);

      const agreed = await modelOpportunity(await card('$600'), 0, 'QUALIFIED', 'USD', [], null, new Date(), 30);
      if ('reason' in agreed) throw new Error(agreed.reason);
      expect(agreed.price.value).toBe(600);
      expect(agreed.price.provenance).toBe('EVIDENCE');
    });
  });
});

describe('rule 3: an objective change moves the stored target with the words', () => {
  let projectId = '';
  let userId = '';

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `oc-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  });

  it('re-sets the amount and the cadence a changed cash objective states, with its event (ho-14)', async () => {
    const created = await createGoal({ projectId, objective: 'Collect $3,000 of settled cash within 30 days using no up-front capital.', actorRef: `person:${userId}`, userId });
    if (!created.ok) throw new Error(created.reason);
    expect(created.target?.amountCents).toBe(300_000);

    const changed = await changeObjective(created.goal.id, { intent: 'Earn $1,500 a month in recurring revenue within 45 days using no up-front capital.' }, `person:${userId}`);
    expect(changed.ok).toBe(true);
    const goal = (await getWorkstream(created.goal.id))!;
    expect(goal.target?.amountCents).toBe(150_000);
    expect(goal.target?.metric).toBe('SETTLED_CASH');
    expect(goalScope(goal).recurring).toBe('MONTHLY');
    expect(goal.outcome).toMatch(/monthly recurring run-rate of at least 1500/);
    const events = await listWorkstreamEvents(goal.id);
    const set = events.find((one) => one.kind === 'GOAL_TARGET_SET' && (one.detail.after as { amountCents?: number } | undefined)?.amountCents === 150_000)!;
    expect((set.detail.before as { amountCents: number }).amountCents).toBe(300_000);
    const objective = events.find((one) => one.kind === 'GOAL_OBJECTIVE_CHANGED')!;
    expect((objective.detail.before as { target: { amountCents: number } }).target.amountCents).toBe(300_000);
  });

  it('leaves the stored target alone when the new words state no amount', async () => {
    const created = await createGoal({ projectId, objective: 'Collect $3,000 of settled cash within 30 days using no up-front capital.', actorRef: `person:${userId}`, userId });
    if (!created.ok) throw new Error(created.reason);
    expect((await changeObjective(created.goal.id, { intent: 'Collect settled cash from repeat buyers.' }, `person:${userId}`)).ok).toBe(true);
    expect((await getWorkstream(created.goal.id))!.target?.amountCents).toBe(300_000);
  });
});

describe('rule 4: a win rate on priced offers is a measured close', () => {
  it('reads accepted offers against quotes, proposals and bids, and nothing that is not a priced offer', () => {
    expect(readOfferWins('6 wins from 40 quotes')).toEqual({ won: 6, offers: 40, unit: 'quotes' });
    expect(readOfferWins('3 signed out of 18 proposals sent last quarter')).toEqual({ won: 3, offers: 18, unit: 'proposals' });
    expect(readOfferWins('9 contracts awarded of 52 bids')).toEqual({ won: 9, offers: 52, unit: 'bids' });
    for (const other of ['11 paid bookings from 138 clicks', '4 paid orders among 90 visitors', '18 orders from a 14,000-member group', '40 quotes sent', '50 wins from 40 quotes']) {
      expect(readOfferWins(other), other).toBeNull();
    }
  });

  describe('through the real card read', () => {
    let projectId = '';
    let userId = '';
    let cashModeId = '';

    beforeEach(async () => {
      projectId = (await freshProject()).project.id;
      userId = (await createUser({ email: `ow-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
      expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
      cashModeId = (await getCashMode(projectId))!.id;
    });

    async function modelWith(conversion: string) {
      const o = await createOpportunity({
        projectId, cashModeId, ownerUserId: userId, title: 'Technical translation brokerage', mechanism: 'SUBCONTRACTED_FULFILMENT', currency: 'USD',
        sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: [],
      });
      await recordCardFact({ projectId, opportunityId: o.id, field: CAPTURE_KEY, kind: 'EVIDENCE', value: 'Broker the translation.', claimId: `clm_c_${o.id}`, decidedBy: 'BRAIN' });
      await updateOpportunity(o.id, { price_cents: 168_000, offer_scope: 'One translation job', payer: 'Engineering firms' });
      await recordCardFact({ projectId, opportunityId: o.id, field: 'conversionRates', kind: 'EVIDENCE', value: conversion, claimId: `clm_conv_${o.id}`, decidedBy: 'BRAIN' });
      const modelled = await modelOpportunity((await getOpportunity(o.id))!, 0, 'QUALIFIED', 'USD', [], null, new Date(), 60);
      if ('reason' in modelled) throw new Error(modelled.reason);
      return modelled;
    }

    it('makes 6 wins from 40 quotes the measured close, at its cautious interval', async () => {
      const modelled = await modelWith('6 wins from 40 quotes');
      expect(modelled.close.provenance).toBe('HISTORICAL');
      expect(modelled.close.note).toMatch(/6 accepted of 40 quotes/);
      expect(modelled.close.low!).toBeLessThan(6 / 40);
      expect(modelled.close.low!).toBeGreaterThan(0);
      expect(modelled.respond.value).toBe(1);
    });

    it('keeps a small visitor count an anecdote', async () => {
      const modelled = await modelWith('4 paid orders among 90 visitors');
      expect(modelled.close.provenance).not.toBe('HISTORICAL');
    });
  });
});
