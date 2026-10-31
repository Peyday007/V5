/**
 * Stage latencies from rows with known timestamps: exact values where the rows
 * exist, null with a basis where they do not — never zero.
 */
import { describe, expect, it } from 'vitest';
import { computeStageLatency, type StageLatencyInput } from '../server/services/factory/throughput.ts';

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

function input(over: Partial<StageLatencyInput> = {}): StageLatencyInput {
  return {
    campaignId: 'c1',
    campaignCreatedAt: t(0),
    mergedUnits: 2,
    bins: [
      { id: 'p', kind: 'FACTORY_PLAN', createdAt: t(10) },
      { id: 'u1', kind: 'FACTORY_UNITS', createdAt: t(100) },
      { id: 'u2', kind: 'FACTORY_UNITS', createdAt: t(100) },
      { id: 'i', kind: 'FACTORY_INTEGRATE', createdAt: t(400) },
      { id: 'r', kind: 'FACTORY_REVIEW', createdAt: t(600) },
    ],
    binEvents: [
      { binId: 'p', eventType: 'BIN_READY', at: t(10) },
      { binId: 'p', eventType: 'BIN_ASSIGNED', at: t(40) },
      { binId: 'u1', eventType: 'BIN_READY', at: t(100) },
      { binId: 'u1', eventType: 'BIN_ASSIGNED', at: t(130) },
      { binId: 'u1', eventType: 'BIN_TERMINAL', at: t(300) },
      { binId: 'u2', eventType: 'BIN_READY', at: t(100) },
      { binId: 'u2', eventType: 'BIN_ASSIGNED', at: t(220) },
      { binId: 'u2', eventType: 'BIN_RELEASED', at: t(350) },
      { binId: 'i', eventType: 'BIN_READY', at: t(400) },
      { binId: 'i', eventType: 'BIN_ASSIGNED', at: t(460) },
      { binId: 'r', eventType: 'BIN_READY', at: t(600) },
      { binId: 'r', eventType: 'BIN_ASSIGNED', at: t(650) },
    ],
    events: [
      { kind: 'PLAN_INSTALLED', at: t(90), detail: {} },
      { kind: 'UNIT_IMPLEMENTED', at: t(300), detail: {} },
      { kind: 'UNIT_IMPLEMENTED', at: t(350), detail: {} },
      { kind: 'INTEGRATION_MERGED', at: t(500), detail: {} },
      { kind: 'CAMPAIGN_STATE', at: t(1800), detail: { to: 'COMPLETE' } },
    ],
    ...over,
  };
}

describe('computeStageLatency', () => {
  it('returns exact values for rows with known timestamps', () => {
    const s = computeStageLatency(input());
    expect(s.planDurationMs.value).toBe(80_000);
    expect(s.timeToFirstCodingMs.value).toBe(130_000);
    expect(s.queueDelayByKind['FACTORY_UNITS']?.average.value).toBe(75_000);
    expect(s.queueDelayByKind['FACTORY_UNITS']?.max.value).toBe(120_000);
    expect(s.queueDelayByKind['FACTORY_PLAN']?.max.value).toBe(30_000);
    expect(s.integrationDelayMs.value).toBe(160_000);
    expect(s.reviewDelayMs.value).toBe(150_000);
    expect(s.concurrentUnitBinsMax.value).toBe(2);
    expect(s.completionMs.value).toBe(1_800_000);
    expect(s.unitsPerHour.value).toBe(4);
    expect(s.planDurationMs.evidence).toBe('MEASURED');
  });

  it('counts only overlapping leases in the peak', () => {
    const s = computeStageLatency(
      input({
        binEvents: [
          { binId: 'u1', eventType: 'BIN_ASSIGNED', at: t(100) },
          { binId: 'u1', eventType: 'BIN_TERMINAL', at: t(200) },
          { binId: 'u2', eventType: 'BIN_ASSIGNED', at: t(200) },
          { binId: 'u2', eventType: 'BIN_TERMINAL', at: t(300) },
        ],
      }),
    );
    expect(s.concurrentUnitBinsMax.value).toBe(1);
  });

  it('reports null with a basis, never zero, when rows do not exist', () => {
    const s = computeStageLatency(
      input({ bins: [], binEvents: [], events: [], campaignCreatedAt: null }),
    );
    for (const n of [
      s.planDurationMs,
      s.timeToFirstCodingMs,
      s.integrationDelayMs,
      s.reviewDelayMs,
      s.concurrentUnitBinsMax,
      s.unitsPerHour,
      s.completionMs,
    ]) {
      expect(n.value).toBeNull();
      expect(n.evidence).toBe('UNKNOWN');
      expect(n.basis).toContain('not measured');
    }
    expect(s.queueDelayByKind).toEqual({});
  });

  it('marks a kind with no leased bin as not measured', () => {
    const s = computeStageLatency(input({ binEvents: [{ binId: 'u1', eventType: 'BIN_READY', at: t(100) }] }));
    expect(s.queueDelayByKind['FACTORY_UNITS']?.max.value).toBeNull();
  });
});
