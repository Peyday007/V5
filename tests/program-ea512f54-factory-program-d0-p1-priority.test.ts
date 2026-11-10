import { describe, expect, it } from 'vitest';
import {
  capabilityFactsFromRows,
  demotionForVanishedNeed,
  promotionFromBlockers,
  rankCapabilities,
  reconcileCapabilities,
  type BlockedTransactionRow,
  type CapabilityFacts,
  type CapabilityRecordRow,
} from '../server/services/goals/priority.ts';

function facts(over: Partial<CapabilityFacts> = {}): CapabilityFacts {
  return {
    id: 'cap',
    readiness: 'SPECIFIED',
    prerequisitesMet: true,
    needStillExists: true,
    dueAt: null,
    blocked: [],
    workaroundCostCents: null,
    buildCostCents: null,
    interfaceChanged: false,
    otherBeneficiaries: null,
    uncertainty: null,
    opportunityCostCents: null,
    ...over,
  };
}

const tx = (id: string, valueCents: number | null, businessKey: string | null = null) => ({ id, valueCents, businessKey });

describe('promotion reasons come from measured rows (GOV-22-1)', () => {
  it('names each reason with the figures behind it', () => {
    const d = promotionFromBlockers(
      facts({
        blocked: [tx('t1', 5000, 'a'), tx('t2', 7000, 'b')],
        workaroundCostCents: 9000,
        buildCostCents: 4000,
        interfaceChanged: true,
      }),
    );
    expect(d.promote).toBe(true);
    expect(d.reasons).toEqual(['SEVERAL_BLOCKED_TRANSACTIONS', 'WORKAROUND_COSTS_MORE', 'SHARED_BY_BUSINESSES', 'INTERFACE_CHANGED']);
    expect(d.evidence).toHaveLength(4);
    expect(d.evidence[0]).toContain('2 valued transactions blocked, 12000 cents');
  });

  it('promotes on a single reason without any declared dependency edge', () => {
    expect(promotionFromBlockers(facts({ interfaceChanged: true })).reasons).toEqual(['INTERFACE_CHANGED']);
    expect(promotionFromBlockers(facts({ workaroundCostCents: 10, buildCostCents: 5 })).reasons).toEqual(['WORKAROUND_COSTS_MORE']);
    expect(promotionFromBlockers(facts({ otherBeneficiaries: 2 })).reasons).toEqual(['SHARED_BY_BUSINESSES']);
  });

  it('counts a business once however many of its transactions are blocked', () => {
    const d = promotionFromBlockers(facts({ blocked: [tx('t1', 100, 'a'), tx('t2', 100, 'a')] }));
    expect(d.reasons).toEqual(['SEVERAL_BLOCKED_TRANSACTIONS']);
  });

  it('a workaround that costs no more than the build is no reason', () => {
    expect(promotionFromBlockers(facts({ workaroundCostCents: 5, buildCostCents: 5 })).promote).toBe(false);
  });

  it('only SPECIFIED and PREPOSITIONED are promoted', () => {
    for (const readiness of ['NEEDED_NOW', 'BUILDING', 'VERIFIED', 'SUSPENDED'] as const) {
      expect(promotionFromBlockers(facts({ readiness, interfaceChanged: true })).promote).toBe(false);
    }
    expect(promotionFromBlockers(facts({ readiness: 'PREPOSITIONED', interfaceChanged: true })).promote).toBe(true);
  });
});

describe('unknown inputs never promote', () => {
  it('unknown transaction values are not valued, so two of them are not several', () => {
    const d = promotionFromBlockers(facts({ blocked: [tx('t1', null), tx('t2', null)] }));
    expect(d.promote).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it('unknown or zero values do not make up the count of valued transactions', () => {
    expect(promotionFromBlockers(facts({ blocked: [tx('t1', 500), tx('t2', null), tx('t3', 0)] })).promote).toBe(false);
  });

  it('an unmeasured workaround or build cost is no reason', () => {
    expect(promotionFromBlockers(facts({ workaroundCostCents: 100, buildCostCents: null })).promote).toBe(false);
    expect(promotionFromBlockers(facts({ workaroundCostCents: null, buildCostCents: 1 })).promote).toBe(false);
  });

  it('unknown beneficiaries and unstated business keys add no businesses', () => {
    expect(promotionFromBlockers(facts({ otherBeneficiaries: null, blocked: [tx('t1', 1, null), tx('t2', 1, null)] })).reasons).not.toContain('SHARED_BY_BUSINESSES');
  });

  it('unmet or unknown prerequisites never promote, whatever else is measured', () => {
    const strong = { interfaceChanged: true, blocked: [tx('t1', 9, 'a'), tx('t2', 9, 'b')] };
    expect(promotionFromBlockers(facts({ ...strong, prerequisitesMet: false })).promote).toBe(false);
    expect(promotionFromBlockers(facts({ ...strong, prerequisitesMet: null })).promote).toBe(false);
  });

  it('a vanished need is never promoted, an unknown need is not a veto', () => {
    expect(promotionFromBlockers(facts({ needStillExists: false, interfaceChanged: true })).promote).toBe(false);
    expect(promotionFromBlockers(facts({ needStillExists: null, interfaceChanged: true })).promote).toBe(true);
  });

  it('rows leave an unrecorded interfaceChanged false', () => {
    const rec: CapabilityRecordRow = {
      id: 'c', readiness: 'SPECIFIED', prerequisitesMet: true, needStillExists: true, dueAt: null,
      workaroundCostCents: null, buildCostCents: null, interfaceChanged: null, otherBeneficiaries: null,
      uncertainty: null, opportunityCostCents: null,
    };
    const [f] = capabilityFactsFromRows([rec], []);
    expect(f?.interfaceChanged).toBe(false);
    expect(promotionFromBlockers(f!).promote).toBe(false);
  });
});

describe('demotion keeps the requirement', () => {
  it('a vanished need puts prepared or needed work down to SUSPENDED and retains the requirement', () => {
    for (const readiness of ['SPECIFIED', 'PREPOSITIONED', 'NEEDED_NOW'] as const) {
      expect(demotionForVanishedNeed(facts({ readiness, needStillExists: false }))).toEqual({
        demote: true,
        to: 'SUSPENDED',
        requirementRetained: true,
      });
    }
  });

  it('only an explicit false demotes; an unknown need leaves the state alone', () => {
    const d = demotionForVanishedNeed(facts({ readiness: 'NEEDED_NOW', needStillExists: null }));
    expect(d).toEqual({ demote: false, to: 'NEEDED_NOW', requirementRetained: true });
    expect(demotionForVanishedNeed(facts({ needStillExists: true })).demote).toBe(false);
  });

  it('building, verified and already suspended work is left as it is', () => {
    for (const readiness of ['BUILDING', 'VERIFIED', 'SUSPENDED'] as const) {
      const d = demotionForVanishedNeed(facts({ readiness, needStillExists: false }));
      expect(d.demote).toBe(false);
      expect(d.to).toBe(readiness);
      expect(d.requirementRetained).toBe(true);
    }
  });

  it('reconciliation lists a demotion without dropping the capability from the records it ranks', () => {
    const rec: CapabilityRecordRow = {
      id: 'gone', readiness: 'NEEDED_NOW', prerequisitesMet: true, needStillExists: false, dueAt: null,
      workaroundCostCents: null, buildCostCents: null, interfaceChanged: null, otherBeneficiaries: null,
      uncertainty: null, opportunityCostCents: null,
    };
    const r = reconcileCapabilities([rec], [], { parallelWorkers: 3 });
    expect(r.demotions).toEqual([{ id: 'gone', to: 'SUSPENDED', requirementRetained: true }]);
    expect(r.ranked.map((x) => x.id)).toEqual(['gone']);
    expect(r.ranked[0]?.startable).toBe(false);
    expect(r.promotions).toEqual([]);
  });
});

describe('startable is limited by parallel workers', () => {
  const ready = (id: string, over: Partial<CapabilityFacts> = {}) => facts({ id, interfaceChanged: true, ...over });

  it('starts only as many as there are workers, in rank order', () => {
    const ranked = rankCapabilities(
      [ready('a', { dueAt: '2026-03-01' }), ready('b', { dueAt: '2026-01-01' }), ready('c', { dueAt: '2026-02-01' })],
      { parallelWorkers: 2 },
    );
    expect(ranked.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(ranked.map((r) => r.startable)).toEqual([true, true, false]);
  });

  it('unknown, zero or negative workers start nothing', () => {
    for (const parallelWorkers of [null, 0, -2]) {
      expect(rankCapabilities([ready('a')], { parallelWorkers }).every((r) => !r.startable)).toBe(true);
    }
  });

  it('a fractional worker count is floored', () => {
    const ranked = rankCapabilities([ready('a'), ready('b')], { parallelWorkers: 1.9 });
    expect(ranked.filter((r) => r.startable)).toHaveLength(1);
  });

  it('an ineligible capability is never startable and sorts after every eligible one', () => {
    const ranked = rankCapabilities(
      [facts({ id: 'idle' }), ready('go'), ready('unmet', { prerequisitesMet: false }), ready('gone', { needStillExists: false })],
      { parallelWorkers: 10 },
    );
    expect(ranked[0]?.id).toBe('go');
    expect(ranked.filter((r) => r.startable).map((r) => r.id)).toEqual(['go']);
  });

  it('an already NEEDED_NOW capability is startable without a fresh promotion', () => {
    const [r] = rankCapabilities([facts({ id: 'n', readiness: 'NEEDED_NOW' })], { parallelWorkers: 1 });
    expect(r?.startable).toBe(true);
    expect(r?.promotion.promote).toBe(false);
  });

  it('readiness and urgency are separate: a due date neither makes a capability ready nor blocks one', () => {
    const ranked = rankCapabilities(
      [facts({ id: 'urgent-unready', dueAt: '2026-01-01', prerequisitesMet: false, interfaceChanged: true }), ready('later', { dueAt: '2027-01-01' })],
      { parallelWorkers: 5 },
    );
    expect(ranked[0]?.id).toBe('later');
    expect(ranked[1]?.startable).toBe(false);
    expect(ranked[1]?.urgency.dueAt).toBe('2026-01-01');
  });

  it('unknown uncertainty and unknown values never raise net value', () => {
    const [r] = rankCapabilities([ready('a', { blocked: [tx('t', 10000, 'x')], uncertainty: null, buildCostCents: 100 })], { parallelWorkers: 1 });
    expect(r?.netValueCents).toBe(-100);
  });
});

describe('reconciliation from goal and cash rows', () => {
  it('promotes from blocked transactions in rows and counts a duplicate transaction once', () => {
    const rec: CapabilityRecordRow = {
      id: 'access', readiness: 'SPECIFIED', prerequisitesMet: true, needStillExists: true, dueAt: null,
      workaroundCostCents: null, buildCostCents: 100, interfaceChanged: null, otherBeneficiaries: null,
      uncertainty: 0.5, opportunityCostCents: null,
    };
    const blocked: BlockedTransactionRow[] = [
      { transactionId: 't1', capabilityId: 'access', valueCents: 1000, businessKey: 'a' },
      { transactionId: 't1', capabilityId: 'access', valueCents: 1000, businessKey: 'a' },
      { transactionId: 't2', capabilityId: 'access', valueCents: 3000, businessKey: 'b' },
      { transactionId: 't3', capabilityId: 'no-such-capability', valueCents: 9999, businessKey: 'c' },
    ];
    const r = reconcileCapabilities([rec], blocked, { parallelWorkers: 1 });
    expect(r.promotions.map((p) => p.id)).toEqual(['access']);
    expect(r.promotions[0]?.decision.reasons).toContain('SEVERAL_BLOCKED_TRANSACTIONS');
    expect(r.ranked).toHaveLength(1);
    expect(r.ranked[0]?.netValueCents).toBe(2000 - 100);
    expect(r.ranked[0]?.startable).toBe(true);
  });
});
