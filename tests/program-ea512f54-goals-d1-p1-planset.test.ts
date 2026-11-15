import { describe, expect, it } from 'vitest';
import {
  buildPlanSet,
  calibrationFor,
  candidateFromStrategy,
  canonical,
  differingDimensions,
  MODEL_FIELDS,
  modelledShareReaching,
  publishedConfidence,
  rebuildAfter,
  renderPlanSet,
  type AcceptanceCondition,
  type ModelField,
  type PlanCandidate,
  type PlanModel,
} from '../server/services/goals/planSet.ts';
import type { VariantReading } from '../server/services/goals/reconstruction.ts';
import { judgeAcceptance, planCalibration, type StrategyReading } from '../server/services/goals/plan.ts';

const field = (status: ModelField['status'], value: string | number | null = 'x'): ModelField => ({ value, low: null, high: null, status, basis: `test ${status}` });
const model = (status: ModelField['status'] = 'ESTIMATED', over: Partial<PlanModel> = {}): PlanModel => {
  const m = {} as PlanModel;
  for (const f of MODEL_FIELDS) m[f] = field(status);
  return { ...m, ...over };
};

function candidate(id: string, over: Partial<PlanCandidate> = {}): PlanCandidate {
  return {
    id,
    title: `Plan ${id}`,
    source: 'PATHWAY',
    opportunityIds: [id],
    dimensions: { mechanism: `mechanism ${id}`, channel: `channel ${id}`, fulfilment: `fulfiller ${id}`, risk: `risk ${id}`, revenue: 'one-off' },
    customers: [`buyers ${id}`],
    cashSources: [`payer ${id}`],
    channels: [`channel ${id}`],
    suppliers: [`supplier ${id}`],
    model: model(),
    modelled: { p10: 12_000, p50: 18_000, p90: 30_000 },
    observedCollections: 0,
    enforceableCommitments: 0,
    capitalRequired: 500,
    daysToCash: 20,
    attempts: { researched: true, authorized: false, executed: false },
    whyItWorks: [`why ${id}`],
    transfers: [`transfers ${id}`],
    stopsTransferringWhen: [],
    ...over,
  };
}

/** A goal whose amount, window and confidence are this test's choice — the module holds none of them. */
const condition = (over: Partial<AcceptanceCondition> = {}): AcceptanceCondition => ({ amount: 10_000, daysLeft: 60, confidence: null, capitalCeiling: 2_000, ...over });
/** Calibrated on plan `a` — the only plan it speaks for. */
const calibrated = { calibrated: true, observations: 40, basis: 'resolved goal predictions', covers: ['a'] };

describe('distinct plan set (GOAL-23)', () => {
  it('collapses two plans that differ only in wording into one', () => {
    const a = candidate('a', { dimensions: { mechanism: 'Done-for-you Bookkeeping Services', channel: 'cold email', fulfilment: 'Brain', risk: 'small firms', revenue: 'recurring' } });
    const b = candidate('b', {
      dimensions: { mechanism: 'bookkeeping, done for you', channel: 'Cold Email', fulfilment: 'brain', risk: 'firms small', revenue: 'Recurring' },
      customers: ['other buyers'],
      cashSources: ['other payer'],
    });
    expect(differingDimensions(a.dimensions, b.dimensions)).toEqual([]);
    const set = buildPlanSet([a, b], condition());
    expect(set.candidates).toBe(2);
    expect(set.distinct).toBe(1);
    expect(set.collapses[0]?.why).toBe('PARAPHRASE');
    expect(set.plans[0]?.members.sort()).toEqual(['a', 'b']);
  });

  it('counts plans distinct only when a mechanism, channel, fulfilment, risk or revenue dimension differs', () => {
    const base = candidate('a');
    const variants = (['mechanism', 'channel', 'fulfilment', 'risk', 'revenue'] as const).map((d, i) =>
      candidate(`v${i}`, { dimensions: { ...base.dimensions, [d]: `different ${d}` } }),
    );
    for (const v of variants) expect(differingDimensions(base.dimensions, v.dimensions)).toHaveLength(1);
    expect(buildPlanSet([base, ...variants], condition()).distinct).toBe(6);
  });

  it('folds plans that would count the same customers or cash, and flags the double count', () => {
    const a = candidate('a', { customers: ['dental clinics'] });
    const b = candidate('b', { customers: ['Dental Clinic'] });
    const c = candidate('c', { cashSources: ['payer a'] });
    const set = buildPlanSet([a, b, c], condition());
    expect(set.distinct).toBe(1);
    expect(set.doubleCounted.map((d) => d.kind).sort()).toEqual(['CASH', 'CUSTOMERS']);
    expect(set.collapses.map((x) => x.why).sort()).toEqual(['SHARED_CASH', 'SHARED_CUSTOMERS']);
    // Folded members never add their cash to the plan's.
    expect(buildPlanSet([candidate('x', { observedCollections: 100, customers: ['p'] }), candidate('y', { observedCollections: 100, customers: ['p'] })], condition()).collections.observed).toBe(100);
  });

  it('gives every plan a complete model with a per-field status and an ACCEPTED or PROVISIONAL status', () => {
    const good = candidate('good');
    const unknown = candidate('unknown', { model: model('ESTIMATED', { acquisitionRoute: field('UNKNOWN', null) }) });
    const set = buildPlanSet([good, unknown], condition());
    for (const p of set.plans) {
      for (const f of MODEL_FIELDS) expect(['PROVEN', 'ESTIMATED', 'UNKNOWN']).toContain(p.model[f].status);
      expect(['ACCEPTED', 'PROVISIONAL']).toContain(p.acceptance);
    }
    expect(set.plans.find((p) => p.id === 'good')?.acceptance).toBe('ACCEPTED');
    const prov = set.plans.find((p) => p.id === 'unknown');
    expect(prov?.acceptance).toBe('PROVISIONAL');
    expect(prov?.gaps.map((g) => g.field)).toEqual(['acquisitionRoute']);
  });

  it('qualifies nothing merely by being compared: a weak plan beside strong ones stays provisional', () => {
    const plans = [candidate('s1'), candidate('s2'), candidate('weak', { modelled: { p10: 2_000, p50: 6_000, p90: 9_000 } })];
    const set = buildPlanSet(plans, condition());
    expect(set.accepted).toBe(2);
    expect(set.plans.find((p) => p.id === 'weak')?.acceptance).toBe('PROVISIONAL');
  });

  it('keeps researched, authorized and executed attempts, and observed and modelled collections, apart', () => {
    const set = buildPlanSet(
      [
        candidate('r'),
        candidate('au', { attempts: { researched: true, authorized: true, executed: false } }),
        candidate('ex', { attempts: { researched: true, authorized: true, executed: true }, observedCollections: 1_500 }),
      ],
      condition(),
    );
    expect(set.attempts).toEqual({ researched: 3, authorized: 2, executed: 1 });
    expect(set.collections.observed).toBe(1_500);
    expect(set.collections.modelledP50).toBe(54_000);
  });

  it('shows which plans survive a shared channel or supplier failing', () => {
    const a = candidate('a', { channels: ['LinkedIn'] });
    const b = candidate('b', { channels: ['linkedin'] });
    const c = candidate('c', { suppliers: ['supplier a'] });
    const set = buildPlanSet([a, b, c], condition());
    const ch = set.resilience.find((r) => r.kind === 'CHANNEL');
    expect(ch?.fails.sort()).toEqual(['a', 'b']);
    expect(ch?.survives).toEqual(['c']);
    const sup = set.resilience.find((r) => r.kind === 'SUPPLIER');
    expect(sup?.fails.sort()).toEqual(['a', 'c']);
    expect(sup?.survives).toEqual(['b']);
  });

  it('rebuildAfter returns the surviving and the reconstructed alternatives after a named change', () => {
    const a = candidate('a', { channels: ['marketplace'] });
    const b = candidate('b', { channels: ['partner referrals'] });
    const r = rebuildAfter([a, b], { kind: 'CHANNEL_FAILED', channel: 'Marketplace' }, condition());
    expect(r.removed.map((x) => x.id)).toEqual(['a']);
    expect(r.surviving.map((p) => p.id)).toEqual(['b']);
    expect(r.reconstructed).toHaveLength(1);
    const rebuilt = r.reconstructed[0];
    expect(rebuilt?.channels).toEqual(['partner referrals']);
    expect(rebuilt?.model.acquisitionRoute.status).toBe('UNKNOWN');
    expect(rebuilt?.acceptance).toBe('PROVISIONAL');
    expect(rebuilt?.attempts).toEqual({ researched: false, authorized: false, executed: false });

    const cut = rebuildAfter([a, candidate('big', { capitalRequired: 5_000 })], { kind: 'BUDGET_CUT', budget: 1_000 }, condition());
    expect(cut.removed.map((x) => x.id)).toEqual(['big']);
    expect(cut.surviving.map((p) => p.id)).toEqual(['a']);
    expect(cut.reconstructed).toEqual([]);

    const sup = rebuildAfter([a, b], { kind: 'SUPPLIER_FAILED', supplier: 'supplier a' }, condition());
    expect(sup.reconstructed[0]?.suppliers).toEqual(['supplier b']);
  });

  it('withholds confidence without calibration and publishes it only when calibrated', () => {
    const m = { p10: 12_000, p50: 18_000, p90: 30_000 };
    expect(publishedConfidence(m, 10_000, null)).toMatchObject({ value: null, withheld: true });
    expect(publishedConfidence(m, 10_000, { calibrated: false, observations: 3, basis: 'too few', covers: null })).toMatchObject({ value: null, withheld: true });
    expect(publishedConfidence(m, 10_000, calibrated)).toMatchObject({ value: 0.9, withheld: false });
    const set = buildPlanSet([candidate('a')], condition({ confidence: 0.9 }));
    expect(set.plans[0]?.confidence.withheld).toBe(true);
    expect(set.plans[0]?.acceptance).toBe('PROVISIONAL');
    expect(buildPlanSet([candidate('a')], condition({ confidence: 0.9 }), calibrated).plans[0]?.acceptance).toBe('ACCEPTED');
    expect(set.confidence.withheld).toBe(true);
  });

  it('reads 90% as at most a modelled 10% below the amount — never as a floor (GOAL-18-4)', () => {
    expect(modelledShareReaching({ p10: 10_000, p50: 15_000, p90: 20_000 }, 10_000)).toBeCloseTo(0.9);
    expect(modelledShareReaching({ p10: 5_000, p50: 10_000, p90: 20_000 }, 10_000)).toBeCloseTo(0.5);
    const plan = buildPlanSet([candidate('a')], condition()).plans[0];
    expect(plan?.downside.adverse).toBe(12_000);
    expect(plan?.downside.floor).toBe(0);
    expect(plan?.downside.overTarget).toEqual({ expected: 8_000, upper: 20_000 });
    const committed = buildPlanSet([candidate('a', { enforceableCommitments: 4_000 })], condition()).plans[0];
    expect(committed?.downside.floor).toBe(4_000);
  });

  it('hard-codes no plan count, amount or objective: they come from the acceptance condition', () => {
    const plans = Array.from({ length: 4 }, (_, i) => candidate(`p${i}`));
    expect(buildPlanSet(plans, condition()).breadth).toEqual({ required: null, met: null });
    expect(buildPlanSet(plans, condition({ breadth: 3 })).breadth).toEqual({ required: 3, met: true });
    expect(buildPlanSet(plans, condition({ breadth: 7 })).breadth).toEqual({ required: 7, met: false });
    expect(buildPlanSet(plans, condition({ amount: 50_000 })).accepted).toBe(0);
    const fast = candidate('fast', { daysToCash: 3, modelled: { p10: 11_000, p50: 14_000, p90: 16_000 } });
    const big = candidate('big', { daysToCash: 50, modelled: { p10: 11_000, p50: 20_000, p90: 60_000 } });
    expect(buildPlanSet([fast, big], condition({ objective: { upside: 1 } })).plans[0]?.id).toBe('big');
    expect(buildPlanSet([fast, big], condition({ objective: { velocity: 1 } })).plans[0]?.id).toBe('fast');
  });

  it('records repeatability conditions and what transfers', () => {
    const p = buildPlanSet([candidate('a', { observedCollections: 900 })], condition()).plans[0];
    expect(p?.repeatability.some((r) => r.includes('channel a'))).toBe(true);
    expect(p?.repeatability.some((r) => r.includes('supplier a'))).toBe(true);
    expect(p?.repeatability.some((r) => r.includes('does not prove the same conversion'))).toBe(true);
    expect(p?.whyItWorks).toEqual(['why a']);
    expect(p?.transfers).toEqual(['transfers a']);
  });

  it('reads a strategy reading as the union of its member pathways', () => {
    const a = candidate('a');
    const b = candidate('b');
    const reading: VariantReading = { key: 'k', changes: [], reach: 0.4, settledP10: 9_000, settledP50: 20_000, settledP90: 40_000, basis: 'COVERAGE', committed: 800, feasible: true, why: null, members: ['a', 'b'] };
    const s = candidateFromStrategy(reading, new Map([['a', a], ['b', b]]));
    expect(s?.customers.sort()).toEqual(['buyers a', 'buyers b']);
    expect(s?.modelled).toEqual({ p10: 9_000, p50: 20_000, p90: 40_000 });
    // It counts its members' customers again, so it and they are one plan, never three.
    const set = buildPlanSet([a, b, s as PlanCandidate], condition());
    expect(set.distinct).toBe(1);
    expect(set.doubleCounted.length).toBeGreaterThan(0);
    expect(candidateFromStrategy({ ...reading, members: ['nobody'] }, new Map())).toBeNull();
  });

  it('canonicalises wording and renders the published count', () => {
    expect(canonical('The Agencies, offering SEO')).toBe(canonical('seo agency'));
    const lines = renderPlanSet(buildPlanSet([candidate('a'), candidate('b')], condition()));
    expect(lines[0]).toContain('2 distinct plan(s) from 2 candidate(s)');
  });

  it('never lends one plan’s calibration to another candidate', () => {
    const condition90 = condition({ confidence: 0.9 });
    // Every one of these has p10 above the amount, so a lent calibration would publish 90% and accept it.
    const own = candidate('a');
    const other = candidate('b');
    const arrangement = candidate('arr', { source: 'ARRANGEMENT', opportunityIds: [] });
    const both = candidate('strategy:ab', { source: 'STRATEGY', opportunityIds: ['a', 'b'] });
    const set = buildPlanSet([own, other, arrangement, both], condition90, calibrated);
    const by = (id: string) => set.plans.find((p) => p.id === id);
    expect(by('a')?.acceptance).toBe('ACCEPTED');
    expect(by('a')?.confidence).toMatchObject({ value: 0.9, withheld: false });
    for (const id of ['b', 'arr', 'strategy:ab']) {
      expect(by(id)?.acceptance).toBe('PROVISIONAL');
      expect(by(id)?.confidence).toMatchObject({ value: null, withheld: true });
      expect(by(id)?.confidence.reason).toContain('covers a only');
    }
    expect(set.accepted).toBe(1);
    expect(calibrationFor({ opportunityIds: ['a'] }, { ...calibrated, covers: null })?.calibrated).toBe(false);
  });

  it('gives a plan rebuilt after a change no calibration of the plan it replaced', () => {
    const a = candidate('a', { channels: ['marketplace'], model: model('ESTIMATED') });
    const b = candidate('b', { channels: ['partner referrals'] });
    const r = rebuildAfter([a, b], { kind: 'CHANNEL_FAILED', channel: 'marketplace' }, condition({ confidence: 0.9 }), calibrated);
    expect(r.reconstructed[0]?.confidence.withheld).toBe(true);
    expect(r.reconstructed[0]?.acceptance).toBe('PROVISIONAL');
  });

  it('covers, through the plan pass’s own acceptance, only the plan that acceptance accepted', () => {
    const chosen = { key: 's1', label: 'Monthly reports', verdict: 'RECOMMENDABLE', opportunityIds: ['a'], links: [], constraintsFailed: [], sweep: { goalMetShare: null, settledP50: null, settledP90: null, infeasibleShare: null, probabilistic: false }, conservativeSettled: 100, chainComplete: true, nextTest: null } as StrategyReading;
    const acceptance = judgeAcceptance({ achieved: false, chosen, portfolio: null, measuredChance: { estimate: 0.95, lowerBound: 0.92, upperBound: 0.98, sampleSize: 30, cohort: 'earlier plans' }, considered: [] });
    expect(acceptance.probability?.basis).toBe('MEASURED_RECORD');
    const calibration = planCalibration(acceptance);
    expect(calibration).toMatchObject({ calibrated: true, covers: ['a'] });
    const set = buildPlanSet([candidate('a'), candidate('b'), candidate('arr', { source: 'ARRANGEMENT', opportunityIds: [] })], condition({ confidence: 0.9 }), calibration);
    expect(set.plans.filter((p) => p.acceptance === 'ACCEPTED').map((p) => p.id)).toEqual(['a']);
    expect(set.plans.filter((p) => !p.confidence.withheld).map((p) => p.id)).toEqual(['a']);
  });
});
