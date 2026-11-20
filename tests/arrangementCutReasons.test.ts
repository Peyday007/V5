/**
 * Every cut arrangement says why, and a price the goal cannot use is never
 * credited to an unknown close (production plan read 2026-11-20, run
 * 44826035355, revision a770e1d3, goal wst_7b4fcbb5f2384f31b6c3: "Collect
 * $10,000 settled cash within 30 days using little up-front capital", 19 days
 * left, capital 3,000, owner hours 0).
 *
 * The compose trace read "9 of 404 … (395 cut, 0 in reserve)" followed by the
 * reasons of only the 40 cuts `CUT_RECORDED` names on the model — 28 for owner
 * hours, about 11 modelled twins — so about 355 cuts carried no reason anyone
 * could read (invariant 47). And the screen capped a design's expected cash at
 * the remaining amount only after multiplying by its chance, so a one-off
 * priced far above what the goal still needs was credited the whole price at
 * its close rate: a $3M one-off at close 0.26 read as the whole goal, and
 * $54K–$104K one-offs outranked designs the goal could actually use
 * (invariant 39).
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement, Primitive } from '../server/services/cash/construct.ts';
import { CUT_RECORDED, cutReasonClass, screenArrangement, selectEstimatedArrangements } from '../server/services/cash/goalScenario.ts';
import type { ModelInput } from '../server/services/cash/goalScenario.ts';

const buyer = (key: string): Primitive => ({ name: `owner-operated trade firms ${key}`, claimId: null, from: 'INDUSTRY_MAP', ref: `n_${key}`, path: `BUYER:${key}` });
const need: Primitive = { name: 'quarterly marketing report', claimId: null, from: 'INDUSTRY_MAP', ref: 'need_rep', path: 'NEED:rep' };
// Brain's capability nobody fitted to these buyers: no proved deliverable, so the owner-hours sweep stands.
const unfitted: Primitive = { name: 'spreadsheet, business document', claimId: null, from: 'CAPABILITY', ref: 'cap', path: 'CAPABILITY:brain' };

function arrangement(key: string, tier: 'COMPONENT' | 'UNKNOWN'): ConstructedArrangement {
  return {
    key,
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'PREPAID', aggregation: 'SINGLE', repeat: 'RECURRING_COHORT' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'trades',
    demand: buyer(key),
    need,
    supply: unfitted,
    label: `Arrangement ${key}`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] },
    evidenced: 1,
    value: tier === 'UNKNOWN' ? { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 } : { tier: 'COMPONENT', p10: 200, p50: 300, p90: 500, observations: 3 },
    unknownParts: ['buyers'],
    relatedOpenings: [],
    question: `Who buys ${key}?`,
    signature: `sig_${key}`,
    inputsDigest: `in_${key}`,
  } as ConstructedArrangement;
}

const hex = (i: number) => i.toString(16).padStart(12, 'a');
// 60 designs a 0-hours goal cuts for owner hours, and 10 nothing prices.
const forHours = Array.from({ length: 60 }, (_, i) => arrangement(hex(i), 'COMPONENT'));
const unpriced = Array.from({ length: 10 }, (_, i) => arrangement(hex(1000 + i), 'UNKNOWN'));
const goal = { projectId: 'prj_cuts', currency: 'USD', beforeProofCents: null, exclusions: [], remaining: 10_000, daysLeft: 19, capitalAvailable: 3_000, hoursAvailable: 0 };

describe('every cut arrangement says why', () => {
  const sel = selectEstimatedArrangements([...forHours, ...unpriced], goal).selection;

  it('names the strongest few and counts every cut by its reason, the counts summing to the cut count', () => {
    expect(sel.cutCount).toBe(70);
    expect(sel.cut.length).toBe(CUT_RECORDED);
    expect(sel.reasons.reduce((n, r) => n + r.count, 0)).toBe(sel.cutCount);
    const hours = sel.reasons.find((r) => /owner hours/.test(r.reason));
    const price = sel.reasons.find((r) => /nothing reconstructs its value/.test(r.reason));
    expect(hours?.count).toBe(60);
    expect(price?.count).toBe(10);
    expect(sel.reasons[0]).toBe(hours);
  });

  it('a reason class keeps what the cut is and drops the key, the names and the figures that make it one cut', () => {
    expect(cutReasonClass('it does not fit this goal: one deal needs at least 1 owner hours, more than the 0 owner hours this goal has')).toBe(
      'it does not fit this goal: one deal needs at least N owner hours, more than the N owner hours this goal has',
    );
    expect(
      cutReasonClass('the model reads it exactly as 1b2dfcb3a4c5 over the same buyers (same price, cost, close, capital and market), so it is that strategy run another way: repeats SUBSCRIPTION rather than RECURRING_COHORT'),
    ).toBe('the model reads it exactly as another design over the same buyers (same price, cost, close, capital and market), so it is that strategy run another way');
    expect(cutReasonClass('its buyers ("GitHub") name one organisation or no buyer at all, not a population a list can be built of')).toBe('its buyers ("…") name one organisation or no buyer at all, not a population a list can be built of');
  });
});

describe('a price above what the goal still needs is never credited to an unknown close', () => {
  const stated = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });
  const fit = { remaining: 10_000, daysLeft: 19, contactsPerDay: 30, capital: 3_000, hours: null };
  const oneOff = (price: number, close: number) =>
    screenArrangement(
      {
        repeatable: false,
        price: stated(price),
        close: stated(close),
        respond: stated(0.05),
        daysToCash: stated(5),
        hours: stated(0),
        volume: stated(1),
        capital: { value: null, low: 0, high: 0.01, provenance: 'ASSUMPTION', source: null, note: '' },
        directCost: stated(0),
        agreedValue: 0,
      } as never,
      { value: { tier: 'DIRECT', p10: price, p50: price, p90: price, observations: 3 }, stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] } },
      fit,
    );

  it('a $3M one-off at close 0.26 reads 0.26 of the goal, not the whole goal', () => {
    expect(oneOff(3_000_000, 0.26).value).toBeCloseTo(2_600, 6);
    expect(oneOff(3_000_000, 0.26).upside).toBeCloseTo(2_600, 6);
  });

  it('two one-offs that would each settle the whole goal rank by their chance, not by their nominal price', () => {
    expect(oneOff(54_000, 0.1).value).toBeCloseTo(oneOff(10_000, 0.1).value, 6);
    expect(oneOff(104_000, 0.05).value).toBeLessThan(oneOff(12_000, 0.1).value);
  });

  it('a one-off priced under what is needed reads as before: its chance × its price', () => {
    expect(oneOff(4_000, 0.25).value).toBeCloseTo(1_000, 6);
  });
});
