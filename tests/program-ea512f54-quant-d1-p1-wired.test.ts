/**
 * COM-13-2 (S-0103), wired into the running Brain: construction — the path the
 * goal plan reads (`goalArrangements`) and asks the world from
 * (`askConstructedArrangements`) — traces each best-ranked arrangement's
 * leverage on its own parts and evidence, judges it against the goal's real
 * cash and authority limits, verifies prepayment rather than presuming it, and
 * lets what it found act on the arrangement's exposure and research question.
 * The probe reader reads what construction traced instead of a bounds-only
 * re-mapping.
 */
import { describe, expect, it } from 'vitest';
import {
  composeConstruction,
  constraintsFrom,
  leversFor,
  MAX_LEVERAGE_TRACED,
  type ConstructionJob,
  type Primitive,
} from '../server/services/cash/construct.ts';
import { defaultDesign, type GoalLimits } from '../server/services/cash/properties.ts';
import { leverageHoldsOnRows, leversOf } from '../server/services/quant/leverage.ts';
import type { Observation } from '../server/domain/quant.ts';

const now = new Date('2026-11-14T00:00:00Z');

const prim = (name: string, ref: string, claimId: string | null = `clm_${ref}`): Primitive => ({ name, claimId, from: 'INDUSTRY_MAP', ref });

const priced = (id: string, cents: number): Observation => ({
  id: `opp:${id}`,
  value: { kind: 'POINT', value: cents / 100 },
  context: { payer: 'independent hotels', industry: 'commercial laundry', arrangement: 'held' },
  lineage: [`claim:${id}`],
  source: { kind: 'CLAIM', ref: id },
  measures: `the price on ${id}`,
});

function job(limits: GoalLimits): ConstructionJob {
  return {
    sectors: [
      {
        name: 'Commercial laundry',
        demand: [prim('Independent hotels', 'n_hotels')],
        needs: [prim('linen turnaround', 'n_need')],
        supply: [prim('Regional laundries', 'n_supply')],
      },
    ],
    opportunities: [],
    precedent: [],
    capability: null,
    priced: [priced('p1', 120_000), priced('p2', 150_000), priced('p3', 135_000)],
    tiedUp: [],
    input: { projectId: 'prj_test', currency: 'USD', delivers: [], capitalCeilingCents: limits.capitalCeilingCents, daysLeft: 30, limits, now },
    limits,
    targets: [],
    exclusions: [],
    now,
  };
}

const limits: GoalLimits = { daysLeft: 30, remainingCents: 1_000_000, capitalCeilingCents: 50_000, capitalBeforeProofCents: 20_000, bestReachCents: null };

describe('construction traces leverage on the arrangements it ranks', () => {
  it('attaches a trace to the best-ranked arrangements, built on construction’s own evidence', async () => {
    const built = await composeConstruction(job(limits));
    expect(built.length).toBeGreaterThan(0);
    const traced = built.slice(0, MAX_LEVERAGE_TRACED);
    for (const one of traced) {
      const lv = one.leverage!;
      expect(lv).toBeDefined();
      expect(lv.combinations).toBe(2 ** leversOf(lv.arrangement).length);
      expect(lv.established.length + lv.unknown.length).toBe(7);
      // The value part carries the observations construction holds — not a bare bound.
      expect(lv.arrangement.value.observations?.length).toBe(3);
      expect(lv.arrangement.levers).toEqual(leversFor(one.design));
    }
    for (const one of built.slice(MAX_LEVERAGE_TRACED)) expect(one.leverage).toBeUndefined();
  }, 120_000);

  it('judges every traced combination against the goal’s real cash and authority limits, with no revenue ceiling', async () => {
    expect(constraintsFrom(limits)).toEqual({ cashAvailable: 200, authorityCeiling: 500, contractMax: null });
    // Unset limits are unknown, never unlimited.
    expect(constraintsFrom({ ...limits, capitalCeilingCents: null, capitalBeforeProofCents: null })).toEqual({ cashAvailable: null, authorityCeiling: null, contractMax: null });
    const built = await composeConstruction(job(limits));
    const margin = built.find((one) => one.leverage && one.structure === 'SUBCONTRACT')!;
    expect(margin).toBeDefined();
    const v = margin.leverage!.full.constraint;
    expect(margin.leverage!.constraints.cashAvailable).toBe(200);
    expect(Object.keys(v.allows).sort()).toEqual(['AUTHORITY', 'CAPACITY', 'CASH_EXPOSURE', 'CONTRACT']);
    // No contract is recorded, so the contract limit is a question, not a permission.
    expect(v.unknown).toContain('CONTRACT');
    expect(v.detail).not.toMatch(/revenue/i);
  }, 120_000);

  it('verifies prepayment on a prepaid design and asks for what is not established', async () => {
    const built = await composeConstruction(job(limits));
    const prepaid = built.find((one) => one.leverage && one.design.funding !== 'ON_DELIVERY');
    expect(prepaid).toBeDefined();
    const p = prepaid!.leverage!.prepayment!;
    expect(p).not.toBeNull();
    // Nothing on these rows establishes buyer willingness or refund obligations: unknown, uncredited, and asked.
    expect(p.willingness).toBe('UNKNOWN');
    expect(p.refundObligations).toBe('UNKNOWN');
    expect(p.credited).toBe(false);
    expect(prepaid!.question).toMatch(/prepayment as a possibility to verify, not a presumption/);
    expect(prepaid!.question).toMatch(/what share of these buyers will prepay/);
    expect(prepaid!.question).toMatch(/refund obligations on prepaid money/);
    // A design with no prepayment takes no prepayment lever and is never asked about it.
    const onDelivery = built.find((one) => one.leverage && one.design.funding === 'ON_DELIVERY')!;
    expect(onDelivery.leverage!.prepayment).toBeNull();
    expect(onDelivery.question).not.toMatch(/will prepay/);
    expect(onDelivery.question).toMatch(/through cash conversion, margin, supplier risk, delivery capacity, liability, acquisition speed and repeatability/);
  }, 120_000);

  it('composes the levers the design implies: a supplier fulfils, or Brain does', () => {
    expect(Object.keys(leversFor(defaultDesign('SUBCONTRACT'))).sort()).toEqual(['fulfilment', 'settlementDays']);
    expect(Object.keys(leversFor({ ...defaultDesign('BROKER'), funding: 'PREPAID' })).sort()).toEqual(['fulfilment', 'prepayment', 'settlementDays']);
  });

  it('the probe reader traces what construction traced, against the limits it carried', async () => {
    const built = await composeConstruction(job(limits));
    const targets = built.filter((one) => one.leverage).slice(0, 3).map((one) => ({ arrangement: one.leverage!.arrangement, constraints: one.leverage!.constraints }));
    const r = await leverageHoldsOnRows({ now, projects: async () => [{ id: 'p1' }], arrangementsFor: async () => targets });
    expect(r.ok).toBe(true);
    expect(r.arrangements).toBe(3);
    expect(r.constrained).toBeGreaterThan(0);
    expect(r.detail).toMatch(/judged against a real limit/);
  }, 120_000);
});
