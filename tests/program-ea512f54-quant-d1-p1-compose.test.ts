/**
 * COM-13-2 (S-0103): composable commercial leverage traced through cash,
 * margin, supplier risk, delivery capacity, liability, acquisition speed and
 * repeatability — on the existing composer, with no revenue ceiling from owned
 * capital and no prepayment presumed.
 */
import { describe, expect, it } from 'vitest';
import { composeArrangement, type Arrangement, type Levers, type Part } from '../server/services/quant/mechanism.ts';
import { reconstruct } from '../server/services/quant/reconstruct.ts';
import type { Observation } from '../server/domain/quant.ts';

const now = new Date('2026-11-14T00:00:00Z');
const src = (url: string) => ({ url, title: url, retrievedAt: '2026-11-01T00:00:00Z' }) as unknown as Observation['source'];
const pt = (id: string, value: number): Part => ({ observations: [{ id, value: { kind: 'POINT', value, exact: true }, context: {}, lineage: [id], source: src(`https://example.test/${id}`) }] });
const rate = (id: string, successes: number, trials: number): Part => ({ observations: [{ id, value: { kind: 'COUNT', successes, trials }, context: {}, lineage: [id], source: src(`https://example.test/${id}`) }] });

const base = (levers?: Levers, over: Partial<Arrangement> = {}): Arrangement => ({
  key: 'lev', label: 'A levered arrangement', period: 'month', currency: 'USD',
  demand: { buyers: pt('buyers', 200), needRate: pt('need', 1), reach: rate('reach', 50, 100), conversion: rate('conv', 20, 100) },
  value: pt('price', 1_000),
  capture: { kind: 'MARGIN', supplyCost: pt('supply_cost', 600) },
  cost: pt('cost', 50),
  ...(levers ? { levers } : {}),
  ...over,
});

const all: Levers = {
  aiLabor: { costPerTransaction: pt('ai_cost', 10), throughput: pt('ai_tp', 500) },
  fulfilment: { capacity: pt('sup_cap', 30), failureRate: rate('sup_fail', 5, 100), paymentDays: pt('sup_days', 30) },
  channel: { share: rate('ch_share', 40, 100), fee: pt('ch_fee', 25) },
  marketing: { reachUplift: pt('uplift', 0.2), acquisitionCost: pt('acq', 20), daysToAcquire: pt('acq_days', 10) },
  prepayment: { willingness: rate('willing', 50, 100), refundShare: rate('refund', 10, 100), usableDays: pt('usable', 2) },
  financing: { rate: rate('fin_rate', 12, 100), termDays: pt('fin_term', 30), advanceShare: rate('fin_adv', 50, 100) },
  sharedInfrastructure: { costPerTransaction: pt('infra', 5) },
  settlementDays: pt('settle', 14),
};

const p50 = (a: Arrangement, key: string) => {
  const c = composeArrangement(a);
  return reconstruct(c.graph, key, now).estimates[key]!;
};

describe('COM-13-2 composable leverage', () => {
  it('composes all seven levers at once and emits every traced dimension as a resolvable node', () => {
    const c = composeArrangement(base(all));
    const t = c.traced!;
    for (const key of [t.cashConversion, t.margin, t.supplierRisk, t.deliveryCapacity, t.liability, t.acquisitionSpeed, t.repeatability, t.cashExposure]) {
      expect(c.graph.nodes.some((n) => n.key === key)).toBe(true);
      expect(() => reconstruct(c.graph, key, now)).not.toThrow();
    }
    expect(c.exposure).toBe(t.cashExposure);
    const keys = c.graph.nodes.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('each lever composes alone', () => {
    const singles: Levers[] = [
      { aiLabor: all.aiLabor! }, { fulfilment: all.fulfilment! }, { channel: all.channel! }, { marketing: all.marketing! },
      { prepayment: all.prepayment! }, { financing: all.financing! }, { sharedInfrastructure: all.sharedInfrastructure! },
    ];
    for (const levers of singles) {
      const c = composeArrangement(base(levers));
      expect(c.traced).toBeDefined();
      const r = reconstruct(c.graph, c.contribution, now);
      expect(Number.isFinite(r.estimates[c.contribution]!.p50)).toBe(true);
      expect(r.estimates[c.traced!.margin]!.p50).toBeLessThanOrEqual((1_000 - 600 - 50) * 1.03);
    }
  });

  it('margin subtracts every lever cost', () => {
    // 1000 − 600 − 50 − 10 (ai) − 0.4×25 (channel) − 20 (acq) − 5 (infra) − financing
    // financing = 0.5 × (600+50+10+20+5) × 0.12 × 30/365 ≈ 3.38
    const m = p50(base(all), 'lev_margin').p50;
    expect(m).toBeGreaterThan(290);
    expect(m).toBeLessThan(310);
  });

  it('delivery capacity is the minimum of demand, supply, AI and supplier throughput', () => {
    // demand = 200 × 1 × min(1, 0.5×1.2) × 0.2 = 24; supplier 30; AI 500
    const c = composeArrangement(base(all));
    expect(c.formulas.lev_delivery_capacity).toBe('min(lev_demand, lev_ai_throughput, lev_supplier_capacity)');
    expect(p50(base(all), 'lev_delivery_capacity').p50).toBeCloseTo(24, 0);
    const tight = base({ ...all, fulfilment: { ...all.fulfilment!, capacity: pt('sup_cap_small', 8) } });
    expect(p50(tight, 'lev_transactions').p50).toBeCloseTo(8, 0);
    const supplied = base({ aiLabor: { costPerTransaction: pt('ai_c', 1), throughput: pt('ai_t', 3) } }, { supply: { units: pt('u', 100), acceptance: rate('acc', 50, 100) } });
    expect(composeArrangement(supplied).formulas.lev_delivery_capacity).toBe('min(lev_demand, lev_supply, lev_ai_throughput)');
    expect(p50(supplied, 'lev_transactions').p50).toBeCloseTo(3, 0);
  });

  it('no node caps transactions or revenue by owned capital', () => {
    const c = composeArrangement(base(all));
    for (const n of c.graph.nodes) expect(`${n.key} ${n.formula ?? ''}`).not.toMatch(/capital|balance|owned|revenue_ceiling/);
    // A large transaction: nothing but demand and capacity bound it.
    const big = base({ ...all, aiLabor: { ...all.aiLabor!, throughput: pt('big_ai', 1_000_000) }, fulfilment: { ...all.fulfilment!, capacity: pt('big_cap', 100_000) } }, { demand: { buyers: pt('many', 100_000), needRate: pt('n1', 1), reach: rate('r1', 100, 100), conversion: rate('c1', 100, 100) } });
    expect(p50(big, 'lev_transactions').p50).toBeGreaterThan(80_000);
  });

  it('transactions are bounded by real cash-exposure, authority and contract limits', () => {
    const limited = base({ ...all, limits: { cashAvailable: pt('cash', 3_000), authorityCeiling: pt('auth', 10_000), contractMax: pt('contract', 20) } });
    const c = composeArrangement(limited);
    expect(c.formulas.lev_transactions).toBe('min(lev_delivery_capacity, lev_cash_limit, lev_authority_limit, lev_contract_max)');
    const exposure = p50(limited, 'lev_cash_exposure').p50;
    const tx = p50(limited, 'lev_transactions').p50;
    expect(tx).toBeCloseTo(Math.min(24, 3_000 / exposure, 10_000 / exposure, 20), 0);
  });

  it('prepayment lowers exposure only by willingness net of refunds, and only when usable before the supplier is paid', () => {
    const none = p50(base({ ...all, prepayment: undefined }), 'lev_cash_exposure').p50;
    const c = composeArrangement(base(all));
    expect(c.prepayment!.credited).toBe(true);
    const credited = p50(base(all), 'lev_cash_exposure').p50;
    // credit = 0.5 × (1 − 0.1) = 0.45
    expect(credited / none).toBeCloseTo(0.55, 1);
    const late = base({ ...all, prepayment: { ...all.prepayment!, usableDays: pt('usable_late', 45) } });
    expect(p50(late, 'lev_cash_exposure').p50 / none).toBeCloseTo(1, 1);
  });

  it('unknown willingness or timing never lowers exposure', () => {
    const none = p50(base({ ...all, prepayment: undefined }), 'lev_cash_exposure').p50;
    const variants: Levers[] = [
      { ...all, prepayment: { ...all.prepayment!, willingness: {} } },
      { ...all, prepayment: { ...all.prepayment!, usableDays: {} } },
      { ...all, prepayment: { ...all.prepayment!, refundShare: {} } },
      { ...all, fulfilment: undefined, prepayment: all.prepayment! },
    ];
    for (const levers of variants) {
      const c = composeArrangement(base(levers));
      expect(c.prepayment!.credited).toBe(false);
      expect(c.prepayment!.reason).toMatch(/unstated/);
      expect(c.formulas.lev_cash_exposure).not.toMatch(/prepay/);
    }
    // With supplier terms only on the prepayment lever, the credit applies.
    const viaPrepay = base({ ...all, fulfilment: undefined, prepayment: { ...all.prepayment!, supplierPaymentDays: pt('sd', 30) } });
    expect(composeArrangement(viaPrepay).prepayment!.credited).toBe(true);
    expect(p50(base(variants[0]!), 'lev_cash_exposure').p50 / none).toBeCloseTo(1, 1);
  });

  it('refund obligations and supplier defaults add to liability', () => {
    const withBoth = p50(base(all), 'lev_liability').p50;
    const noRefund = p50(base({ ...all, prepayment: undefined }), 'lev_liability').p50;
    expect(withBoth).toBeGreaterThan(noRefund);
    // 24 × 1000 × (0.5 × 0.1 + 0.05) = 2400
    expect(withBoth).toBeGreaterThan(1_800);
    expect(withBoth).toBeLessThan(3_000);
    const noSupplier = composeArrangement(base({ aiLabor: all.aiLabor! }, { capture: { kind: 'FEE', fee: pt('fee', 100) } }));
    expect(noSupplier.formulas.lev_supplier_risk).toBe('0');
    expect(noSupplier.formulas.lev_liability).toBe('0');
  });

  it('traces cash conversion, acquisition speed and repeatability', () => {
    // credit 0.45: 0.45 × 2 + 0.55 × 14 − 30 = −21.4 days
    expect(p50(base(all), 'lev_cash_conversion').p50).toBeCloseTo(-21.4, 0);
    expect(p50(base(all), 'lev_acquisition_speed').p50).toBeCloseTo(2.4, 1);
    const rep = base(all, { repeat: { rate: rate('rep', 30, 100) } });
    expect(p50(rep, 'lev_repeatability').p50).toBeCloseTo(0.3 * 0.95, 1);
    // Unstated settlement terms leave conversion unknown rather than invented.
    expect(p50(base({ ...all, settlementDays: undefined }), 'lev_cash_conversion').tier).toBe('UNKNOWN');
  });

  it('pooling keeps its threshold rule under levers', () => {
    const pooled = composeArrangement(base(all, { pooling: { fixedCost: pt('fx', 500), minParticipants: pt('mp', 10), threshold: true } }));
    expect(pooled.formulas.lev_contribution).toBe('if(lev_transactions >= lev_min_participants, lev_transactions * lev_margin - lev_fixed_cost, 0)');
  });

  it('an arrangement without levers composes exactly as before', () => {
    const plain = composeArrangement(base());
    expect(plain.traced).toBeUndefined();
    expect(plain.prepayment).toBeUndefined();
    expect(Object.keys(plain).sort()).toEqual(['contribution', 'exposure', 'formulas', 'graph', 'revenue', 'transactions']);
    expect(plain.formulas).toEqual({
      lev_demand: 'lev_buyers * lev_need_rate * lev_reach * lev_conversion',
      lev_transactions: 'lev_demand',
      lev_capture: 'lev_value - lev_supply_cost',
      lev_revenue: 'lev_transactions * lev_capture',
      lev_contribution: 'lev_transactions * (lev_capture - lev_cost)',
      lev_exposure: 'lev_supply_cost',
    });
    expect(plain.graph.nodes.map((n) => n.key)).toEqual([
      'lev_buyers', 'lev_need_rate', 'lev_reach', 'lev_conversion', 'lev_demand', 'lev_transactions', 'lev_value', 'lev_supply_cost', 'lev_capture', 'lev_cost', 'lev_exposure', 'lev_revenue', 'lev_contribution',
    ]);
  });
});

describe('an arrangement Brain fulfils itself has no supplier term to wait on', () => {
  const aiOnly = (levers: Levers): Arrangement => base(levers, { capture: { kind: 'FEE', fee: pt('fee', 100) } });

  it('emits no supplier payment part, and cash conversion is established from evidenced settlement alone', () => {
    const c = composeArrangement(aiOnly({ aiLabor: all.aiLabor!, settlementDays: pt('settle', 14) }));
    expect(c.graph.nodes.some((n) => n.key === 'lev_supplier_payment_days')).toBe(false);
    expect(c.formulas.lev_cash_conversion).not.toMatch(/supplier/);
    const conversion = reconstruct(c.graph, 'lev_cash_conversion', now).estimates['lev_cash_conversion']!;
    expect(conversion.tier).not.toBe('UNKNOWN');
    expect(conversion.p50).toBeCloseTo(14, 0);
  });

  it('still leaves cash conversion unknown when settlement itself is unstated', () => {
    const c = composeArrangement(aiOnly({ aiLabor: all.aiLabor! }));
    expect(reconstruct(c.graph, 'lev_cash_conversion', now).estimates['lev_cash_conversion']!.tier).toBe('UNKNOWN');
  });

  it('judges prepayment timing against delivery, not an absent supplier term', () => {
    const prepay = { willingness: rate('willing', 50, 100), refundShare: rate('refund', 10, 100), usableDays: pt('usable', 0) };
    const c = composeArrangement(aiOnly({ aiLabor: all.aiLabor!, prepayment: prepay, settlementDays: pt('settle', 14) }));
    expect(c.prepayment!.credited).toBe(true);
    expect(c.prepayment!.reason).toMatch(/usable by delivery/);
    // Prepaid money usable only after delivery funds nothing before Brain's own outlay leaves.
    const late = composeArrangement(aiOnly({ aiLabor: all.aiLabor!, prepayment: { ...prepay, usableDays: pt('usable', 5) }, settlementDays: pt('settle', 14) }));
    expect(reconstruct(late.graph, 'lev_prepay_credit', now).estimates['lev_prepay_credit']!.p50).toBe(0);
  });

  it('keeps the supplier term wherever there is a supplier, so an unstated one stays a question', () => {
    const c = composeArrangement(base({ aiLabor: all.aiLabor!, settlementDays: pt('settle', 14) }));
    expect(c.graph.nodes.some((n) => n.key === 'lev_supplier_payment_days')).toBe(true);
    expect(reconstruct(c.graph, 'lev_cash_conversion', now).estimates['lev_cash_conversion']!.tier).toBe('UNKNOWN');
  });
});
