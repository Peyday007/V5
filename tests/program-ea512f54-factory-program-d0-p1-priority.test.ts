/**
 * GOV-22-1: readiness is separate from urgency, a prepared capability is promoted
 * from what goal and cash rows measure, unknown inputs never promote, a vanished
 * need demotes without removing the requirement, and what may start is limited by
 * the parallel workers available.
 */
import { describe, expect, it } from 'vitest';
import {
  capabilityFactsFromRows,
  demotionForVanishedNeed,
  promotionFromBlockers,
  rankCapabilities,
  reconcileCapabilities,
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

describe('promotion from measured blockers', () => {
  it('names each reason it promotes for, with the measured figures', () => {
    const several = promotionFromBlockers(facts({ blocked: [tx('a', 100), tx('b', 250)] }));
    expect(several.promote).toBe(true);
    expect(several.reasons).toEqual(['SEVERAL_BLOCKED_TRANSACTIONS']);
    expect(several.evidence[0]).toMatch(/2 valued transactions blocked, 350 cents/);

    const workaround = promotionFromBlockers(facts({ workaroundCostCents: 900, buildCostCents: 400 }));
    expect(workaround.reasons).toEqual(['WORKAROUND_COSTS_MORE']);

    const shared = promotionFromBlockers(facts({ blocked: [tx('a', null, 'one')], otherBeneficiaries: 1 }));
    expect(shared.reasons).toEqual(['SHARED_BY_BUSINESSES']);

    const interfaceChanged = promotionFromBlockers(facts({ interfaceChanged: true }));
    expect(interfaceChanged.reasons).toEqual(['INTERFACE_CHANGED']);

    const all = promotionFromBlockers(
      facts({
        blocked: [tx('a', 100, 'x'), tx('b', 100, 'y')],
        workaroundCostCents: 10,
        buildCostCents: 1,
        interfaceChanged: true,
      }),
    );
    expect(all.reasons).toEqual(['SEVERAL_BLOCKED_TRANSACTIONS', 'WORKAROUND_COSTS_MORE', 'SHARED_BY_BUSINESSES', 'INTERFACE_CHANGED']);
  });

  it('needs no declared dependency edge: the facts alone decide', () => {
    expect(promotionFromBlockers(facts({ id: 'no-edge-anywhere', blocked: [tx('a', 5), tx('b', 5)] })).promote).toBe(true);
  });

  it('never promotes from unknown inputs, however favourable the missing figure might be', () => {
    expect(promotionFromBlockers(facts()).promote).toBe(false);
    // Transactions whose value no row states are not valued: they do not make "several".
    expect(promotionFromBlockers(facts({ blocked: [tx('a', null), tx('b', null)] })).reasons).toEqual([]);
    expect(promotionFromBlockers(facts({ blocked: [tx('a', 0), tx('b', -5)] })).promote).toBe(false);
    // One side of the workaround comparison unknown is no comparison.
    expect(promotionFromBlockers(facts({ workaroundCostCents: 1_000_000, buildCostCents: null })).promote).toBe(false);
    expect(promotionFromBlockers(facts({ workaroundCostCents: null, buildCostCents: 0 })).promote).toBe(false);
    expect(promotionFromBlockers(facts({ otherBeneficiaries: null, blocked: [tx('a', 1, null), tx('b', 1, null)] })).reasons).not.toContain('SHARED_BY_BUSINESSES');
  });

  it('does not promote while prerequisites are unmet or unknown, or when the need is gone', () => {
    const strong = { blocked: [tx('a', 100, 'x'), tx('b', 100, 'y')], interfaceChanged: true };
    expect(promotionFromBlockers(facts({ ...strong, prerequisitesMet: false })).promote).toBe(false);
    expect(promotionFromBlockers(facts({ ...strong, prerequisitesMet: null })).promote).toBe(false);
    expect(promotionFromBlockers(facts({ ...strong, needStillExists: false })).promote).toBe(false);
    // An unknown need neither promotes nor blocks.
    expect(promotionFromBlockers(facts({ ...strong, needStillExists: null })).promote).toBe(true);
  });

  it('only moves a prepared capability: nothing building, finished or suspended is promoted again', () => {
    const strong = { blocked: [tx('a', 100, 'x'), tx('b', 100, 'y')] };
    for (const readiness of ['SPECIFIED', 'PREPOSITIONED'] as const) expect(promotionFromBlockers(facts({ ...strong, readiness })).promote).toBe(true);
    for (const readiness of ['NEEDED_NOW', 'BUILDING', 'VERIFIED', 'SUSPENDED'] as const) {
      expect(promotionFromBlockers(facts({ ...strong, readiness })).promote).toBe(false);
    }
  });
});

describe('demotion keeps the requirement', () => {
  it('suspends work whose need explicitly disappeared and always retains the requirement', () => {
    for (const readiness of ['SPECIFIED', 'PREPOSITIONED', 'NEEDED_NOW'] as const) {
      expect(demotionForVanishedNeed(facts({ readiness, needStillExists: false }))).toEqual({ demote: true, to: 'SUSPENDED', requirementRetained: true });
    }
  });

  it('leaves an unknown or standing need alone, and never touches work that is building or finished', () => {
    expect(demotionForVanishedNeed(facts({ needStillExists: null })).demote).toBe(false);
    expect(demotionForVanishedNeed(facts({ needStillExists: true })).demote).toBe(false);
    for (const readiness of ['BUILDING', 'VERIFIED', 'SUSPENDED'] as const) {
      const d = demotionForVanishedNeed(facts({ readiness, needStillExists: false }));
      expect(d.demote).toBe(false);
      expect(d.to).toBe(readiness);
      expect(d.requirementRetained).toBe(true);
    }
  });

  it('reconciliation suspends a vanished need but the capability stays in the ranking and in the record', () => {
    const rows: CapabilityRecordRow[] = [record({ id: 'gone', needStillExists: false })];
    const out = reconcileCapabilities(rows, [], { parallelWorkers: 3 });
    expect(out.demotions).toEqual([{ id: 'gone', to: 'SUSPENDED', requirementRetained: true }]);
    expect(out.ranked.map((r) => r.id)).toEqual(['gone']);
    expect(out.ranked[0]!.startable).toBe(false);
  });
});

function record(over: Partial<CapabilityRecordRow> = {}): CapabilityRecordRow {
  return {
    id: 'cap',
    readiness: 'SPECIFIED',
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

describe('what may start is limited by the parallel workers', () => {
  const ready = (id: string, over: Partial<CapabilityFacts> = {}) =>
    facts({ id, readiness: 'NEEDED_NOW', blocked: [tx(`${id}-1`, 1000, id)], uncertainty: 0, ...over });

  it('starts at most one capability per available worker, in rank order', () => {
    const caps = [ready('a', { dueAt: '2026-03-03' }), ready('b', { dueAt: '2026-03-01' }), ready('c', { dueAt: '2026-03-02' })];
    const two = rankCapabilities(caps, { parallelWorkers: 2 });
    expect(two.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(two.map((r) => r.startable)).toEqual([true, true, false]);
    expect(rankCapabilities(caps, { parallelWorkers: 1 }).filter((r) => r.startable).map((r) => r.id)).toEqual(['b']);
    expect(rankCapabilities(caps, { parallelWorkers: 10 }).every((r) => r.startable)).toBe(true);
  });

  it('starts nothing when the number of workers is unknown, zero or negative', () => {
    const caps = [ready('a')];
    for (const parallelWorkers of [null, 0, -2]) expect(rankCapabilities(caps, { parallelWorkers })[0]!.startable).toBe(false);
  });

  it('keeps readiness and urgency separate: a prepared capability with a due date still waits, a due-less one that may start does', () => {
    const urgentButPrepared = facts({ id: 'urgent', readiness: 'SPECIFIED', dueAt: '2026-01-01' });
    const calmButReady = ready('calm');
    const out = rankCapabilities([urgentButPrepared, calmButReady], { parallelWorkers: 5 });
    expect(out.map((r) => r.id)).toEqual(['calm', 'urgent']);
    expect(out.find((r) => r.id === 'urgent')!.startable).toBe(false);
    expect(out.find((r) => r.id === 'calm')!.startable).toBe(true);
  });

  it('never starts a capability whose prerequisites are unmet or whose need is gone, however valuable', () => {
    const rich = { blocked: [tx('a', 9_000_000, 'x'), tx('b', 9_000_000, 'y')], uncertainty: 0 };
    const out = rankCapabilities(
      [ready('unmet', { ...rich, prerequisitesMet: false }), ready('unknown', { ...rich, prerequisitesMet: null }), ready('gone', { ...rich, needStillExists: false })],
      { parallelWorkers: 5 },
    );
    expect(out.every((r) => !r.startable)).toBe(true);
  });

  it('ranks by net value, treating unknown uncertainty as the worst case and an unknown cost after a known one', () => {
    const sure = ready('sure', { blocked: [tx('s', 1000, 'x')], uncertainty: 0, buildCostCents: 100 });
    const unsure = ready('unsure', { blocked: [tx('u', 1000, 'x')], uncertainty: null });
    const out = rankCapabilities([unsure, sure], { parallelWorkers: 2 });
    expect(out.map((r) => r.id)).toEqual(['sure', 'unsure']);
    expect(out[1]!.netValueCents).toBe(0);
    expect(out[0]!.netValueCents).toBe(900);
  });
});

describe('facts built from goal and cash rows', () => {
  it('counts a repeated transaction once, drops rows for an unrecorded capability, and reads an unrecorded interface change as false', () => {
    const built = capabilityFactsFromRows(
      [record({ id: 'cap-a', interfaceChanged: null })],
      [
        { transactionId: 't1', capabilityId: 'cap-a', valueCents: 500, businessKey: 'x' },
        { transactionId: 't1', capabilityId: 'cap-a', valueCents: 500, businessKey: 'x' },
        { transactionId: 't2', capabilityId: 'cap-nobody-recorded', valueCents: 900, businessKey: 'y' },
      ],
    );
    expect(built).toHaveLength(1);
    expect(built[0]!.blocked.map((t) => t.id)).toEqual(['t1']);
    expect(built[0]!.interfaceChanged).toBe(false);
  });

  it('one pass promotes from measured blockers alone and reports the reasons', () => {
    const out = reconcileCapabilities(
      [record({ id: 'shared' }), record({ id: 'quiet' })],
      [
        { transactionId: 't1', capabilityId: 'shared', valueCents: 700, businessKey: 'x' },
        { transactionId: 't2', capabilityId: 'shared', valueCents: 300, businessKey: 'y' },
      ],
      { parallelWorkers: 1 },
    );
    expect(out.promotions.map((p) => p.id)).toEqual(['shared']);
    expect(out.promotions[0]!.decision.reasons).toEqual(['SEVERAL_BLOCKED_TRANSACTIONS', 'SHARED_BY_BUSINESSES']);
    expect(out.ranked.find((r) => r.id === 'shared')!.startable).toBe(true);
    expect(out.ranked.find((r) => r.id === 'quiet')!.startable).toBe(false);
    expect(out.demotions).toEqual([]);
  });
});
