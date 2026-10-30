import { describe, expect, it } from 'vitest';
import { binFactOf } from '../server/services/factory/metrics.ts';
import { computeStages } from '../server/services/factory/throughput.ts';

const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();
const ev = (eventType: string, min: number) => ({ eventType, at: t(min) });

const plan = binFactOf({ id: 'p', kind: 'FACTORY_PLAN', createdAt: t(1) }, [ev('BIN_READY', 1), ev('BIN_ASSIGNED', 4), ev('BIN_TERMINAL', 9)]);
const u1 = binFactOf({ id: 'u1', kind: 'FACTORY_UNITS', createdAt: t(12) }, [ev('BIN_READY', 12), ev('BIN_ASSIGNED', 15), ev('BIN_TERMINAL', 30)]);
const u2 = binFactOf({ id: 'u2', kind: 'FACTORY_UNITS', createdAt: t(12) }, [ev('BIN_READY', 12), ev('BIN_ASSIGNED', 20), ev('BIN_TERMINAL', 35)]);
const integ = binFactOf({ id: 'i', kind: 'FACTORY_INTEGRATE', createdAt: t(36) }, [ev('BIN_READY', 36), ev('BIN_ASSIGNED', 40), ev('BIN_TERMINAL', 50)]);
const review = binFactOf({ id: 'r', kind: 'FACTORY_REVIEW', createdAt: t(51) }, [ev('BIN_READY', 51), ev('BIN_ASSIGNED', 58), ev('BIN_TERMINAL', 60)]);

const base = {
  campaignId: 'c',
  campaignCreatedAt: t(0),
  completedAt: t(60),
  bins: [plan, u1, u2, integ, review],
  events: [
    { kind: 'PLAN_INSTALLED', at: t(10) },
    { kind: 'UNIT_IMPLEMENTED', at: t(30) },
  ],
  integratedUnits: 2,
  now: new Date(t(90)),
};
const MIN = 60_000;

describe('stage latency', () => {
  it('returns exact durations from rows with known timestamps', () => {
    const s = computeStages(base);
    expect(s.planDurationMs.value).toBe(9 * MIN);
    expect(s.timeToFirstCodingMs.value).toBe(15 * MIN);
    expect(s.queueDelayByKind['FACTORY_UNITS']).toMatchObject({ samples: 2 });
    expect(s.queueDelayByKind['FACTORY_UNITS']!.average.value).toBe(5.5 * MIN);
    expect(s.queueDelayByKind['FACTORY_UNITS']!.max.value).toBe(8 * MIN);
    expect(s.integrationDelayMs.value).toBe(10 * MIN);
    expect(s.reviewDelayMs.value).toBe(8 * MIN);
    expect(s.concurrentUnitBinsMax.value).toBe(2);
    expect(s.completionMs.value).toBe(60 * MIN);
    expect(s.unitsPerHour.value).toBe(2);
  });
  it('reports null with a basis, never 0, where rows do not exist', () => {
    const s = computeStages({ ...base, bins: [], events: [], integratedUnits: 0, completedAt: null });
    for (const n of [s.planDurationMs, s.timeToFirstCodingMs, s.integrationDelayMs, s.reviewDelayMs, s.concurrentUnitBinsMax, s.unitsPerHour, s.completionMs]) {
      expect(n.value).toBeNull();
      expect(n.evidence).toBe('UNKNOWN');
      expect(n.basis).toMatch(/^not measured/);
    }
    expect(s.queueDelayByKind).toEqual({});
  });
  it('does not count touching leases as concurrent, and a bin never leased has no queue delay', () => {
    const a = binFactOf({ id: 'a', kind: 'FACTORY_UNITS', createdAt: t(0) }, [ev('BIN_READY', 0), ev('BIN_ASSIGNED', 1), ev('BIN_RELEASED', 5)]);
    const b = binFactOf({ id: 'b', kind: 'FACTORY_UNITS', createdAt: t(0) }, [ev('BIN_READY', 0), ev('BIN_ASSIGNED', 5), ev('BIN_RELEASED', 8)]);
    const c = binFactOf({ id: 'c', kind: 'FACTORY_UNITS', createdAt: t(0) }, [ev('BIN_READY', 0)]);
    const s = computeStages({ ...base, bins: [a, b, c] });
    expect(s.concurrentUnitBinsMax.value).toBe(1);
    expect(s.queueDelayByKind['FACTORY_UNITS']!.samples).toBe(2);
  });
});
