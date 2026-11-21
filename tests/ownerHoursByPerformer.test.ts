/**
 * A deal's hours are the owner's only when the owner performs the work
 * (production plan read 2026-11-20, run 44811406620, goal
 * wst_7b4fcbb5f2384f31b6c3: "Collect $10K settled cash within 30 days using
 * little up-front capital", limits "capital 3000 · hours 0").
 *
 * Every constructed arrangement's hours were "nobody has established the
 * hours; swept from 1 to 40 per deal", and the screen read them against the
 * goal's hours — the owner's. With 0 owner hours all 404 were cut ("one deal
 * needs at least 1 hours, more than the 0 this goal has"), including designs
 * Brain produces from a proved deliverable and designs a named supplier
 * fulfils while Brain only messages, invoices and records. The owner does no
 * physical work (§91); Brain is the default producer (§41); an approval is
 * not hours. A design that establishes no performer stays at the
 * conservative sweep (invariant 39) and is still cut on a 0-hours goal.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement, Primitive } from '../server/services/cash/construct.ts';
import { capabilityPart, fittedDeliverable } from '../server/services/cash/construct.ts';
import { selectEstimatedArrangements } from '../server/services/cash/goalScenario.ts';
import type { Structure } from '../server/services/cash/properties.ts';

const buyer = (key: string): Primitive => ({ name: `bookkeeping firms ${key}`, claimId: null, from: 'INDUSTRY_MAP', ref: `n_${key}`, path: `BUYER:${key}` });
const need: Primitive = { name: 'monthly reconciliation spreadsheet', claimId: null, from: 'INDUSTRY_MAP', ref: 'need_rec', path: 'NEED:rec' };
const physicalNeed: Primitive = { name: 'on-site boiler repair', claimId: null, from: 'INDUSTRY_MAP', ref: 'need_boiler', path: 'NEED:boiler' };
const capability = capabilityPart(['spreadsheet', 'business document', 'presentation'])!;
const supplier = (name: string): Primitive => ({ name, claimId: null, from: 'INDUSTRY_MAP', ref: `s_${name}`, path: `SUPPLY:${name}` });

function arrangement(key: string, base: Structure, supply: Primitive | null, needPart: Primitive | null = need): ConstructedArrangement {
  const demand = buyer(key);
  return {
    key,
    structure: base,
    design: { base, funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'RECURRING_COHORT' },
    origin: 'FORWARD',
    precedent: null,
    sector: 'accounting',
    demand,
    need: needPart,
    // A capability part is fitted to these buyers exactly as construction fits it.
    supply: supply && supply.from === 'CAPABILITY' ? fittedDeliverable(supply, ['spreadsheet', 'business document', 'presentation'], demand, needPart) : supply,
    label: `Arrangement ${key}`,
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 0, failures: [] },
    evidenced: 1,
    value: { tier: 'COMPONENT', p10: 1_000, p50: 2_000, p90: 4_000, observations: 4 },
    unknownParts: ['buyers'],
    relatedOpenings: [],
    question: `Who buys ${key}?`,
    signature: `sig_${key}`,
    inputsDigest: `in_${key}`,
  } as ConstructedArrangement;
}

const produced = arrangement('produce', 'PRODUCE', capability);
const brokered = arrangement('broker', 'BROKER', supplier('freelance bookkeepers'));
const referred = arrangement('referral', 'REFERRAL', supplier('payroll software vendors'));
// No established performer: Brain's capability matches no proved deliverable for a physical need,
// a broker with no supplier named, and a supplier reverse construction only asks the world for.
const physical = arrangement('physical', 'PRODUCE', capability, physicalNeed);
const nosupplier = arrangement('nosupplier', 'BROKER', null);
const asked = arrangement('asked', 'REFERRAL', { name: 'suppliers to be found', claimId: null, from: 'REVERSE', ref: 'reverse:supply' });
const all = [produced, brokered, referred, physical, nosupplier, asked];

const goal = { projectId: 'prj_hours', currency: 'USD', beforeProofCents: null, exclusions: [], remaining: 10_000, daysLeft: 30, capitalAvailable: 3_000 };
const cutReason = (sel: ReturnType<typeof selectEstimatedArrangements>, key: string) => sel.selection.cut.find((one) => one.arrangementKey === key)?.reason ?? null;
const pickedKeys = (sel: ReturnType<typeof selectEstimatedArrangements>) => sel.selection.picked.map((one) => one.arrangementKey);

describe('owner hours per deal are read from who the design says performs the work', () => {
  const zero = selectEstimatedArrangements(all, { ...goal, hoursAvailable: 0 });

  it('on a goal with no owner hours, a design Brain produces from a proved deliverable is not cut for hours', () => {
    expect(cutReason(zero, 'produce')).toBeNull();
    expect(pickedKeys(zero)).toContain('produce');
    const hours = zero.conversions.get('produce')!.hours;
    expect(hours.value).toBe(0);
    expect(hours.provenance).not.toBe('UNKNOWN');
    expect(hours.note).toMatch(/Brain performs the work .*0 owner hours per deal/);
  });

  it('on a goal with no owner hours, broker and referral designs whose named supplier fulfils are not cut for hours', () => {
    for (const key of ['broker', 'referral']) {
      expect(cutReason(zero, key)).toBeNull();
      expect(pickedKeys(zero)).toContain(key);
      expect(zero.conversions.get(key)!.hours.value).toBe(0);
    }
    expect(zero.conversions.get('broker')!.hours.note).toMatch(/the supplier "freelance bookkeepers" fulfils, and Brain only messages, invoices and records/);
  });

  it('a design with no established performer keeps the conservative sweep and is still cut, in owner hours', () => {
    for (const key of ['physical', 'nosupplier', 'asked']) {
      expect(cutReason(zero, key)).toBe('it does not fit this goal: one deal needs at least 1 owner hours, more than the 0 owner hours this goal has');
      const hours = zero.conversions.get(key)!.hours;
      expect(hours.provenance).toBe('UNKNOWN');
      expect([hours.low, hours.high]).toEqual([1, 40]);
    }
    expect(pickedKeys(zero)).not.toEqual(expect.arrayContaining(['physical']));
  });

  it('on a goal with ample owner hours, nothing is cut for hours and the unknown performers still sweep', () => {
    const ample = selectEstimatedArrangements(all, { ...goal, hoursAvailable: 10_000 });
    for (const one of all) expect(cutReason(ample, one.key) ?? '').not.toMatch(/hours/);
    // Since #1195 a broker or referral design earns its commission, not the buyer's price, so an unpriced one
    // can lose money at the middle readings against a blind cost and enter only on its upside: that is an
    // economic cut, never an hours one. Every design is either picked or cut for a reason other than hours.
    for (const one of all) expect(pickedKeys(ample).includes(one.key) || cutReason(ample, one.key) !== null).toBe(true);
    expect(pickedKeys(ample)).toEqual(expect.arrayContaining(['produce', 'broker', 'physical']));
    expect(ample.conversions.get('nosupplier')!.hours.provenance).toBe('UNKNOWN');
  });
});
