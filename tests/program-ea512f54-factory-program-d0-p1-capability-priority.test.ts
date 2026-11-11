/**
 * GOV-22-1: a prepared capability is promoted from measured blockers in goal
 * and cash rows, never from an unknown; a vanished need demotes it without
 * removing the requirement; and only as many capabilities are startable as
 * there are parallel workers.
 */
import { describe, expect, it } from 'vitest';
import {
  demotionForVanishedNeed,
  promotionFromBlockers,
  rankCapabilities,
  reconcileCapabilities,
  type BlockedTransactionRow,
  type CapabilityFacts,
  type CapabilityRecordRow,
} from '../server/services/goals/priority.ts';

function facts(overrides: Partial<CapabilityFacts> = {}): CapabilityFacts {
  return {
    id: 'cap',
    readiness: 'PREPOSITIONED',
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
    ...overrides,
  };
}

function record(overrides: Partial<CapabilityRecordRow> & { id: string }): CapabilityRecordRow {
  return {
    readiness: 'PREPOSITIONED',
    prerequisitesMet: true,
    needStillExists: true,
    dueAt: null,
    workaroundCostCents: null,
    buildCostCents: null,
    interfaceChanged: null,
    otherBeneficiaries: null,
    uncertainty: null,
    opportunityCostCents: null,
    ...overrides,
  };
}

describe('promotion reasons', () => {
  it('promotes for several valued blocked transactions', () => {
    const d = promotionFromBlockers(
      facts({
        blocked: [
          { id: 't1', valueCents: 500_00, businessKey: null },
          { id: 't2', valueCents: 250_00, businessKey: null },
        ],
      }),
    );
    expect(d.promote).toBe(true);
    expect(d.reasons).toEqual(['SEVERAL_BLOCKED_TRANSACTIONS']);
    expect(d.evidence[0]).toContain('2 valued transactions blocked, 75000 cents');
  });

  it('promotes when the workaround costs more than building', () => {
    const d = promotionFromBlockers(facts({ workaroundCostCents: 2_000, buildCostCents: 1_000 }));
    expect(d).toMatchObject({ promote: true, reasons: ['WORKAROUND_COSTS_MORE'] });
  });

  it('does not promote when building costs at least as much as the workaround', () => {
    expect(promotionFromBlockers(facts({ workaroundCostCents: 1_000, buildCostCents: 1_000 })).promote).toBe(false);
  });

  it('promotes when several businesses share it, counting blocked businesses and other beneficiaries', () => {
    const d = promotionFromBlockers(
      facts({ blocked: [{ id: 't1', valueCents: null, businessKey: 'biz-a' }], otherBeneficiaries: 1 }),
    );
    expect(d).toMatchObject({ promote: true, reasons: ['SHARED_BY_BUSINESSES'] });
  });

  it('promotes when an interface it depends on changed', () => {
    expect(promotionFromBlockers(facts({ interfaceChanged: true }))).toMatchObject({
      promote: true,
      reasons: ['INTERFACE_CHANGED'],
    });
  });

  it('records every reason that holds, each with its evidence', () => {
    const d = promotionFromBlockers(
      facts({
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

  it('does not need a declared dependency edge: promotion comes from the measured rows alone', () => {
    const r = reconcileCapabilities(
      [record({ id: 'pay-path' })],
      [
        { transactionId: 'deal-1', capabilityId: 'pay-path', valueCents: 1_000, businessKey: 'a' },
        { transactionId: 'deal-2', capabilityId: 'pay-path', valueCents: 2_000, businessKey: 'a' },
      ],
      { parallelWorkers: 1 },
    );
    expect(r.promotions.map((p) => p.id)).toEqual(['pay-path']);
  });

  it('only promotes from SPECIFIED or PREPOSITIONED', () => {
    for (const readiness of ['NEEDED_NOW', 'BUILDING', 'VERIFIED', 'SUSPENDED'] as const) {
      expect(promotionFromBlockers(facts({ readiness, interfaceChanged: true })).promote).toBe(false);
    }
    expect(promotionFromBlockers(facts({ readiness: 'SPECIFIED', interfaceChanged: true })).promote).toBe(true);
  });
});

describe('unknown inputs never promote', () => {
  it('ignores blocked transactions whose value no row states', () => {
    const d = promotionFromBlockers(
      facts({
        blocked: [
          { id: 't1', valueCents: null, businessKey: null },
          { id: 't2', valueCents: null, businessKey: null },
          { id: 't3', valueCents: 100, businessKey: null },
        ],
      }),
    );
    expect(d.promote).toBe(false);
  });

  it('does not compare costs when either is unknown', () => {
    expect(promotionFromBlockers(facts({ workaroundCostCents: 1_000_000, buildCostCents: null })).promote).toBe(false);
    expect(promotionFromBlockers(facts({ workaroundCostCents: null, buildCostCents: 1 })).promote).toBe(false);
  });

  it('does not count unstated businesses or unknown beneficiaries', () => {
    const d = promotionFromBlockers(
      facts({
        blocked: [
          { id: 't1', valueCents: null, businessKey: null },
          { id: 't2', valueCents: null, businessKey: 'a' },
        ],
        otherBeneficiaries: null,
      }),
    );
    expect(d.promote).toBe(false);
  });

  it('does not promote with unknown or unmet prerequisites, whatever else holds', () => {
    expect(promotionFromBlockers(facts({ prerequisitesMet: null, interfaceChanged: true })).promote).toBe(false);
    expect(promotionFromBlockers(facts({ prerequisitesMet: false, interfaceChanged: true })).promote).toBe(false);
  });

  it('reads an unrecorded interface change from rows as false, never true', () => {
    const r = reconcileCapabilities([record({ id: 'c', interfaceChanged: null })], [], { parallelWorkers: 4 });
    expect(r.promotions).toEqual([]);
    expect(r.ranked[0]?.startable).toBe(false);
  });

  it('does not invent a capability for a blocked row naming an unrecorded one, and counts a repeated transaction once', () => {
    const r = reconcileCapabilities(
      [record({ id: 'known' })],
      [
        { transactionId: 't1', capabilityId: 'ghost', valueCents: 100, businessKey: null },
        { transactionId: 't1', capabilityId: 'known', valueCents: 100, businessKey: null },
        { transactionId: 't1', capabilityId: 'known', valueCents: 100, businessKey: null },
      ],
      { parallelWorkers: 2 },
    );
    expect(r.ranked.map((c) => c.id)).toEqual(['known']);
    expect(r.ranked[0]?.urgency.blockedTransactions).toBe(1);
    expect(r.promotions).toEqual([]);
  });
});

describe('demotion keeps the requirement', () => {
  it('suspends work whose need disappeared and retains the requirement', () => {
    for (const readiness of ['SPECIFIED', 'PREPOSITIONED', 'NEEDED_NOW'] as const) {
      expect(demotionForVanishedNeed(facts({ readiness, needStillExists: false }))).toEqual({
        demote: true,
        to: 'SUSPENDED',
        requirementRetained: true,
      });
    }
  });

  it('leaves the state alone when the need is unknown or still exists', () => {
    expect(demotionForVanishedNeed(facts({ needStillExists: null }))).toEqual({
      demote: false,
      to: 'PREPOSITIONED',
      requirementRetained: true,
    });
    expect(demotionForVanishedNeed(facts({ needStillExists: true })).demote).toBe(false);
  });

  it('does not demote a capability already building, verified or suspended', () => {
    for (const readiness of ['BUILDING', 'VERIFIED', 'SUSPENDED'] as const) {
      expect(demotionForVanishedNeed(facts({ readiness, needStillExists: false }))).toMatchObject({
        demote: false,
        to: readiness,
        requirementRetained: true,
      });
    }
  });

  it('a vanished need neither promotes nor is startable, and the capability stays in the ranking', () => {
    const r = reconcileCapabilities(
      [record({ id: 'gone', needStillExists: false, interfaceChanged: true })],
      [],
      { parallelWorkers: 3 },
    );
    expect(r.promotions).toEqual([]);
    expect(r.demotions).toEqual([{ id: 'gone', to: 'SUSPENDED', requirementRetained: true }]);
    expect(r.ranked.map((c) => [c.id, c.startable])).toEqual([['gone', false]]);
  });
});

describe('startable is limited by parallel workers', () => {
  const ready = (id: string, overrides: Partial<CapabilityFacts> = {}): CapabilityFacts =>
    facts({ id, readiness: 'NEEDED_NOW', ...overrides });

  it('starts no more capabilities than there are workers, in rank order', () => {
    const ranked = rankCapabilities(
      [
        ready('late', { dueAt: '2027-03-01T00:00:00.000Z' }),
        ready('soon', { dueAt: '2026-12-01T00:00:00.000Z' }),
        ready('undated'),
      ],
      { parallelWorkers: 2 },
    );
    expect(ranked.map((r) => [r.id, r.startable])).toEqual([
      ['soon', true],
      ['late', true],
      ['undated', false],
    ]);
  });

  it('starts nothing when workers are unknown or zero', () => {
    for (const parallelWorkers of [null, 0, -1]) {
      expect(rankCapabilities([ready('a'), ready('b')], { parallelWorkers }).some((r) => r.startable)).toBe(false);
    }
  });

  it('does not spend a worker on a capability that is neither promoted nor needed now', () => {
    const ranked = rankCapabilities(
      [facts({ id: 'idle', readiness: 'PREPOSITIONED' }), ready('needed')],
      { parallelWorkers: 1 },
    );
    expect(ranked.map((r) => [r.id, r.startable])).toEqual([
      ['needed', true],
      ['idle', false],
    ]);
  });

  it('keeps readiness and urgency separate in the result', () => {
    const [only] = rankCapabilities([facts({ id: 'x', readiness: 'SPECIFIED', dueAt: '2026-12-01T00:00:00.000Z' })], {
      parallelWorkers: 1,
    });
    expect(only?.readiness).toBe('SPECIFIED');
    expect(only?.urgency.dueAt).toBe('2026-12-01T00:00:00.000Z');
    expect(only?.startable).toBe(false);
  });

  it('ranks equally urgent work by net value, with unknown uncertainty read as the worst case', () => {
    const blocked = [
      { id: 't1', valueCents: 10_000, businessKey: null },
      { id: 't2', valueCents: 10_000, businessKey: null },
    ];
    const ranked = rankCapabilities(
      [ready('unsure', { blocked, uncertainty: null }), ready('sure', { blocked, uncertainty: 0 })],
      { parallelWorkers: 1 },
    );
    expect(ranked.map((r) => [r.id, r.netValueCents, r.startable])).toEqual([
      ['sure', 20_000, true],
      ['unsure', 0, false],
    ]);
  });
});
