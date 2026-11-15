import { describe, expect, it } from 'vitest';
import {
  buildPlanSet,
  candidateFromStrategy,
  canonical,
  differingDimensions,
  MODEL_FIELDS,
  modelledShareReaching,
  publishedConfidence,
  rebuildAfter,
  renderPlanSet,
  calibrationOf,
  type AcceptanceCondition,
  type ModelField,
  type PlanCandidate,
  type PlanModel,
} from '../server/services/goals/planSet.ts';
import type { VariantReading } from '../server/services/goals/reconstruction.ts';
import { composeGoalReadings, planCalibrationScope, type PlanAcceptance } from '../server/services/goals/plan.ts';
import { goalObjective } from '../server/services/goals/objective.ts';
import { pathwayOf } from '../server/services/goals/pathways.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { TargetReading } from '../server/services/goals/target.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

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
const calibrated = { calibrated: true, observations: 40, basis: 'resolved goal predictions' };

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
    expect(publishedConfidence(m, 10_000, { calibrated: false, observations: 3, basis: 'too few' })).toMatchObject({ value: null, withheld: true });
    expect(publishedConfidence(m, 10_000, calibrated)).toMatchObject({ value: 0.9, withheld: false });
    const set = buildPlanSet([candidate('a')], condition({ confidence: 0.9 }));
    expect(set.plans[0]?.confidence.withheld).toBe(true);
    expect(set.plans[0]?.acceptance).toBe('PROVISIONAL');
    expect(buildPlanSet([candidate('a', { opportunityIds: ['a'] })], condition({ confidence: 0.9 }), { calibration: calibrated, covers: [['a']] }).plans[0]?.acceptance).toBe('ACCEPTED');
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
});

/*
 * Finding F1: one plan's calibration was lent to every candidate, so an
 * unrelated pathway, construction or strategy variant became ACCEPTED and
 * published a confidence nothing calibrated. Calibration is per candidate.
 */
describe('calibration covers only the plan it was measured on (repair F1)', () => {
  const scope = { calibration: calibrated, covers: [['a']] };

  it('accepts and publishes for the covered plan only; every other candidate stays PROVISIONAL and withheld', () => {
    const covered = candidate('a', { opportunityIds: ['a'] });
    const unrelated = candidate('b', { opportunityIds: ['b'] });
    const construction = candidate('arr', { source: 'ARRANGEMENT', opportunityIds: ['a'] });
    const variant = candidate('strategy:v', { source: 'STRATEGY', opportunityIds: ['a', 'b'], customers: ['buyers v'], cashSources: ['payer v'] });
    const rebuilt = candidate('a~x', { source: 'RECONSTRUCTED', opportunityIds: ['a'], customers: ['buyers r'], cashSources: ['payer r'] });
    const set = buildPlanSet([covered, unrelated, construction, variant, rebuilt], condition({ confidence: 0.9 }), scope);
    const byId = new Map(set.plans.map((p) => [p.id, p]));
    expect(byId.get('a')).toMatchObject({ acceptance: 'ACCEPTED', confidence: { withheld: false, value: 0.9 } });
    for (const id of ['b', 'arr', 'strategy:v', 'a~x']) {
      const p = byId.get(id);
      expect(p, id).toBeDefined();
      expect(p?.acceptance, id).toBe('PROVISIONAL');
      expect(p?.confidence, id).toMatchObject({ value: null, withheld: true });
    }
    expect(set.accepted).toBe(1);
  });

  it('a candidate without stated openings is never covered, and a strategy over exactly the covered openings is', () => {
    expect(calibrationOf({ source: 'PATHWAY' }, scope)?.calibrated).toBe(false);
    expect(calibrationOf({ source: 'STRATEGY', opportunityIds: ['a'] }, scope)?.calibrated).toBe(true);
    expect(calibrationOf({ source: 'STRATEGY', opportunityIds: ['a', 'a'] }, scope)?.calibrated).toBe(true);
    expect(calibrationOf({ source: 'PATHWAY', opportunityIds: ['a'] }, { calibration: { ...calibrated, calibrated: false }, covers: [['a']] })?.calibrated).toBe(false);
    expect(calibrationOf({ source: 'PATHWAY', opportunityIds: ['a'] }, null)).toBeNull();
  });

  it('rebuildAfter does not lend the calibration to survivors or rebuilt plans', () => {
    const a = candidate('a', { opportunityIds: ['a'], channels: ['Marketplace'] });
    const b = candidate('b', { opportunityIds: ['b'], channels: ['Referral'] });
    const r = rebuildAfter([a, b], { kind: 'CHANNEL_FAILED', channel: 'Marketplace' }, condition({ confidence: 0.9 }), scope);
    for (const p of [...r.surviving, ...r.reconstructed]) {
      expect(p.acceptance, p.id).toBe('PROVISIONAL');
      expect(p.confidence.withheld, p.id).toBe(true);
    }
  });

  it('composeGoalReadings hands the accepted plan’s calibration to that plan alone', () => {
    const evidence = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: 'a gated claim' });
    const unknown = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'swept' });
    const opening = (id: string): ModelledOpportunity =>
      ({
        opportunity: {
          id, projectId: 'prj_1', title: `Opening ${id}`, mechanism: 'PRODUCTIZED_SERVICE', industry: null, payer: `Payer ${id}`, reachableChannel: `channel ${id}`,
          buyingSignal: 'posted asking for it', signalObservedAt: null, offerScope: `report ${id}`, priceCents: 90_000, currency: 'USD', fulfillmentOwner: 'Brain',
          economicsNote: null, expiresAt: null, requiredCapabilities: [], opportunitySignal: null, state: 'EVIDENCE_CARD',
        } as unknown as CashOpportunity,
        index: 1, tier: 'CANDIDATE', repeatable: true, price: evidence(900), capital: evidence(0), hours: unknown(1, 2), daysToCash: evidence(9),
        close: unknown(0.02, 0.5), respond: unknown(0.002, 0.15), directCost: evidence(90), volume: unknown(1, 200), agreed: false, agreedValue: 0, agreedDeals: 0,
        fulfilledBy: { value: 'Brain produces it', provenance: 'EVIDENCE', source: null }, competitiveAward: false,
      }) as unknown as ModelledOpportunity;
    const ctx = { remaining: 100, daysLeft: 45, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: [] as string[], now: new Date(), capabilities: null };
    const pa = pathwayOf(opening('a'), null, ctx);
    const pb = pathwayOf(opening('b'), null, ctx);
    const combo = (id: string) => ({ members: [{ opportunityId: id, title: `Opening ${id}` }], settledP10: 5_000, settledP50: 8_000, settledP90: 12_000, reach: 0.99 });
    const portfolio = { best: combo('a'), alternatives: [combo('b')], worlds: 2_000, basis: 'PROBABILITY', limits: { correlation: 0.3 }, missing: [], assurance: null } as unknown as GoalPortfolio;
    const acceptance: PlanAcceptance = {
      status: 'ACCEPTED', required: 0.9, accepted: { label: 'Opening a', opportunityIds: ['a'] }, candidate: null, shortfalls: [], sentence: 'accepted',
      probability: { value: 0.99, lowerBound: 0.93, basis: 'EVIDENCED_PORTFOLIO', sample: 40, note: 'smallest sample 40' },
    };
    expect(planCalibrationScope(acceptance).covers).toEqual([['a']]);
    const target = { metric: 'COLLECTED_REVENUE', metricLabel: 'collected', currency: 'USD', projectId: 'prj_1', targetCents: 10_000, achievedCents: 0, remainingCents: 10_000, achieved: false, daysLeft: 45, capitalCeilingCents: null, capitalBeforeProofCents: null } as unknown as TargetReading;
    const objective = goalObjective({ title: 'Collect $100', intent: 'collect $100 at 90% confidence', outcome: null, dueAt: null, target: { amountCents: 10_000 } } as unknown as Parameters<typeof goalObjective>[0]);
    const { planSet, objective: reading } = composeGoalReadings({ objective, target, portfolio, pathways: { pathways: [pa, pb] } as never, arrangements: [], reconstruction: null, acceptance, modelled: [] });
    const a = planSet.plans.find((p) => p.members.includes('a'));
    const b = planSet.plans.find((p) => p.members.includes('b'));
    expect(a?.confidence.withheld).toBe(false);
    expect(b?.confidence).toMatchObject({ value: null, withheld: true });
    expect(b?.acceptance).toBe('PROVISIONAL');
    // The unrelated alternative combination is not accepted on the best one's calibration either.
    const alt = reading.tradeOffs.find((t) => t.key === 'b');
    expect(alt?.status).toBe('CANDIDATE');
    expect(reading.outcome?.confidenceWithheld).toBeNull();
  });
});
