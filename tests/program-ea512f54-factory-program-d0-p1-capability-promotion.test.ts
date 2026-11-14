/**
 * GOV-22-1: a prepared capability is promoted only from a measured blocker in
 * goal/cash rows, an unknown never promotes, a vanished need demotes without
 * removing the requirement, and only as many promoted requirements are
 * startable as there are parallel workers.
 */
import { describe, expect, it } from 'vitest';
import {
  demotionForVanishedNeed,
  promotionFromBlockers,
  rankPreparedRequirements,
  reconcileCapabilities,
  type BlockedTransactionRow,
  type CapabilityFacts,
  type CapabilityRecordRow,
} from '../server/services/goals/priority.ts';

/** A prepared, specified capability with prerequisites met and nothing measured. */
function waiting(over: Partial<CapabilityFacts> = {}): CapabilityFacts {
  return {
    id: 'cap',
    status: 'SPECIFIED',
    prepared: true,
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

function record(over: Partial<CapabilityRecordRow> & { id: string }): CapabilityRecordRow {
  return {
    status: 'SPECIFIED',
    prepared: true,
    prerequisitesMet: true,
    needStillExists: true,
    dueAt: null,
    workaroundCostCents: null,
    buildCostCents: null,
    interfaceChanged: null,
    otherBeneficiaries: null,
    uncertainty: null,
    opportunityCostCents: null,
    ...over,
  };
}

describe('promotion reasons come from measured rows', () => {
  it('nothing measured promotes nothing', () => {
    expect(promotionFromBlockers(waiting())).toEqual({ promote: false, reasons: [], evidence: [] });
  });

  it('several valued blocked transactions promote with their total as evidence', () => {
    const d = promotionFromBlockers(
      waiting({
        blocked: [
          { id: 't1', valueCents: 1000, businessKey: 'a' },
          { id: 't2', valueCents: 2500, businessKey: 'a' },
        ],
      }),
    );
    expect(d.promote).toBe(true);
    expect(d.reasons).toEqual(['SEVERAL_BLOCKED_TRANSACTIONS']);
    expect(d.evidence[0]).toContain('3500');
  });

  it('a single blocked transaction is not "several"', () => {
    const d = promotionFromBlockers(waiting({ blocked: [{ id: 't1', valueCents: 9_999_999, businessKey: 'a' }] }));
    expect(d.promote).toBe(false);
  });

  it('a workaround that costs more than building promotes', () => {
    const d = promotionFromBlockers(waiting({ workaroundCostCents: 5000, buildCostCents: 4000 }));
    expect(d.reasons).toEqual(['WORKAROUND_COSTS_MORE']);
    expect(promotionFromBlockers(waiting({ workaroundCostCents: 4000, buildCostCents: 4000 })).promote).toBe(false);
  });

  it('reuse across businesses promotes, counting blocked businesses and other beneficiaries', () => {
    const d = promotionFromBlockers(
      waiting({ blocked: [{ id: 't1', valueCents: null, businessKey: 'a' }], otherBeneficiaries: 1 }),
    );
    expect(d.reasons).toEqual(['SHARED_BY_BUSINESSES']);
  });

  it('a changed interface promotes', () => {
    expect(promotionFromBlockers(waiting({ interfaceChanged: true })).reasons).toEqual(['INTERFACE_CHANGED']);
  });

  it('every applicable reason is reported together', () => {
    const d = promotionFromBlockers(
      waiting({
        blocked: [
          { id: 't1', valueCents: 100, businessKey: 'a' },
          { id: 't2', valueCents: 100, businessKey: 'b' },
        ],
        workaroundCostCents: 10,
        buildCostCents: 5,
        interfaceChanged: true,
      }),
    );
    expect(d.reasons).toEqual([
      'SEVERAL_BLOCKED_TRANSACTIONS',
      'WORKAROUND_COSTS_MORE',
      'SHARED_BY_BUSINESSES',
      'INTERFACE_CHANGED',
    ]);
    expect(d.evidence).toHaveLength(4);
  });
});

describe('unknown inputs never promote', () => {
  it('unvalued blocked transactions are not several valuable ones', () => {
    const d = promotionFromBlockers(
      waiting({
        blocked: [
          { id: 't1', valueCents: null, businessKey: null },
          { id: 't2', valueCents: null, businessKey: null },
          { id: 't3', valueCents: 0, businessKey: null },
        ],
      }),
    );
    expect(d.promote).toBe(false);
  });

  it('an unknown workaround or build cost is no reason', () => {
    expect(promotionFromBlockers(waiting({ workaroundCostCents: 1_000_000, buildCostCents: null })).promote).toBe(false);
    expect(promotionFromBlockers(waiting({ workaroundCostCents: null, buildCostCents: 1 })).promote).toBe(false);
  });

  it('unknown or unmet prerequisites block promotion even with a measured blocker', () => {
    const blocker = { interfaceChanged: true };
    expect(promotionFromBlockers(waiting({ ...blocker, prerequisitesMet: null })).promote).toBe(false);
    expect(promotionFromBlockers(waiting({ ...blocker, prerequisitesMet: false })).promote).toBe(false);
  });

  it('a vanished need never promotes', () => {
    expect(promotionFromBlockers(waiting({ interfaceChanged: true, needStillExists: false })).promote).toBe(false);
  });

  it('only a waiting requirement is promoted: live, building and verified ones are not', () => {
    for (const over of [
      { prepared: false },
      { status: 'IMPLEMENTED' as const },
      { status: 'PRODUCTION_VERIFIED' as const },
    ]) {
      expect(promotionFromBlockers(waiting({ interfaceChanged: true, ...over })).promote).toBe(false);
    }
  });

  it('an unrecorded interfaceChanged row reads as false, and a blocker for an unrecorded capability invents nothing', () => {
    const out = reconcileCapabilities(
      [record({ id: 'c1', interfaceChanged: null })],
      [
        { transactionId: 't1', capabilityId: 'ghost', valueCents: 500, businessKey: 'a' },
        { transactionId: 't2', capabilityId: 'ghost', valueCents: 500, businessKey: 'b' },
      ],
      { parallelWorkers: 4 },
    );
    expect(out.promotions).toEqual([]);
    expect(out.ranked.map((r) => r.id)).toEqual(['c1']);
  });

  it('a duplicated transaction row counts once', () => {
    const row: BlockedTransactionRow = { transactionId: 't1', capabilityId: 'c1', valueCents: 500, businessKey: 'a' };
    const out = reconcileCapabilities([record({ id: 'c1' })], [row, { ...row }], { parallelWorkers: 1 });
    expect(out.promotions).toEqual([]);
    expect(out.ranked[0]?.urgency.blockedTransactions).toBe(1);
  });
});

describe('demotion keeps the requirement', () => {
  it('a live requirement whose need vanished goes back to prepared, and is retained', () => {
    const d = demotionForVanishedNeed(waiting({ prepared: false, needStillExists: false }));
    expect(d).toEqual({ demote: true, prepared: true, requirementRetained: true });
  });

  it('an unknown need does not demote', () => {
    const d = demotionForVanishedNeed(waiting({ prepared: false, needStillExists: null }));
    expect(d.demote).toBe(false);
    expect(d.prepared).toBe(false);
    expect(d.requirementRetained).toBe(true);
  });

  it('work already building or verified is not touched', () => {
    for (const status of ['MAPPED', 'IMPLEMENTED', 'INTEGRATED', 'PRODUCTION_VERIFIED'] as const) {
      const d = demotionForVanishedNeed(waiting({ status, prepared: false, needStillExists: false }));
      expect(d.demote).toBe(false);
      expect(d.requirementRetained).toBe(true);
    }
  });

  it('reconcile lists the demotion and still ranks the requirement rather than dropping it', () => {
    const out = reconcileCapabilities(
      [record({ id: 'gone', prepared: false, needStillExists: false }), record({ id: 'live', prepared: false })],
      [],
      { parallelWorkers: 2 },
    );
    expect(out.demotions).toEqual([{ id: 'gone', prepared: true, requirementRetained: true }]);
    const gone = out.ranked.find((r) => r.id === 'gone');
    expect(gone).toBeDefined();
    expect(gone?.startable).toBe(false);
    expect(out.ranked.find((r) => r.id === 'live')?.startable).toBe(true);
  });
});

describe('startable is limited by parallel workers', () => {
  const promotable = (id: string, dueAt: string | null, value: number): CapabilityFacts =>
    waiting({
      id,
      dueAt,
      uncertainty: 0,
      blocked: [
        { id: `${id}-1`, valueCents: value, businessKey: 'a' },
        { id: `${id}-2`, valueCents: value, businessKey: 'a' },
      ],
    });

  it('only as many eligible requirements as workers are startable, in rank order', () => {
    const ranked = rankPreparedRequirements(
      [promotable('late', '2027-02-01', 100), promotable('soon', '2027-01-01', 100), promotable('undated', null, 1_000_000)],
      { parallelWorkers: 2 },
    );
    expect(ranked.map((r) => r.id)).toEqual(['soon', 'late', 'undated']);
    expect(ranked.map((r) => r.startable)).toEqual([true, true, false]);
  });

  it('unknown or zero workers make nothing startable', () => {
    for (const parallelWorkers of [null, 0, -1]) {
      const ranked = rankPreparedRequirements([promotable('a', null, 100)], { parallelWorkers });
      expect(ranked[0]?.startable).toBe(false);
      expect(ranked[0]?.promotion.promote).toBe(true);
    }
  });

  it('ineligible requirements never take a worker slot, however many workers there are', () => {
    const ranked = rankPreparedRequirements(
      [waiting({ id: 'idle' }), waiting({ id: 'unmet', interfaceChanged: true, prerequisitesMet: null }), promotable('real', null, 100)],
      { parallelWorkers: 10 },
    );
    expect(ranked[0]?.id).toBe('real');
    expect(ranked.filter((r) => r.startable).map((r) => r.id)).toEqual(['real']);
  });

  it('net value compares expected value against cost, opportunity cost and uncertainty; unknown uncertainty is worst case', () => {
    const cheap = waiting({ id: 'cheap', interfaceChanged: true, uncertainty: 0, buildCostCents: 10, blocked: [{ id: 'x', valueCents: 1000, businessKey: null }] });
    const unsure = waiting({ id: 'unsure', interfaceChanged: true, uncertainty: null, buildCostCents: 10, blocked: [{ id: 'y', valueCents: 1000, businessKey: null }] });
    const costly = waiting({ id: 'costly', interfaceChanged: true, uncertainty: 0, buildCostCents: 10, opportunityCostCents: 500, blocked: [{ id: 'z', valueCents: 1000, businessKey: null }] });
    const ranked = rankPreparedRequirements([unsure, costly, cheap], { parallelWorkers: 1 });
    expect(ranked.map((r) => [r.id, r.netValueCents])).toEqual([
      ['cheap', 990],
      ['costly', 490],
      ['unsure', -10],
    ]);
    expect(ranked.map((r) => r.startable)).toEqual([true, false, false]);
  });
});
