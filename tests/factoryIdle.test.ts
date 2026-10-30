import { describe, expect, it } from 'vitest';
import { readIdle } from '../server/services/factory/metrics.ts';

const now = '2026-10-30T12:00:00.000Z';

describe('readIdle', () => {
  it('reports each READY factory bin with its wait and dispatch refusal, longest first', () => {
    const reading = readIdle({
      now,
      routines: [],
      bins: [
        { id: 'b1', kind: 'FACTORY_UNITS', readySince: '2026-10-30T11:50:00.000Z', dispatch: { state: 'PENDING', lastErrorKind: 'FLEET_TARGET_REACHED', lastError: '4 in flight, target 4' }, routing: null },
        { id: 'b2', kind: 'FACTORY_PLAN', readySince: '2026-10-30T11:00:00.000Z', dispatch: null, routing: { ok: false, refusal: 'NO_CAPABLE_SURFACE', reason: 'none can push' } },
        { id: 'r1', kind: 'RESEARCH_PACKET', readySince: '2026-10-30T10:00:00.000Z', dispatch: null, routing: null },
      ],
    });
    expect(reading.bins.map((b) => b.id)).toEqual(['b2', 'b1']);
    expect(reading.bins[0]).toMatchObject({ waitedMs: 3_600_000, refusalKind: 'NO_CAPABLE_SURFACE', reason: 'none can push' });
    expect(reading.bins[1]).toMatchObject({ waitedMs: 600_000, dispatchState: 'PENDING', refusalKind: 'FLEET_TARGET_REACHED', reason: '4 in flight, target 4' });
  });

  it('classifies every routine as in flight, rate limited, quarantined, unavailable or idle', () => {
    const base = { inFlight: 0, retryAt: null, ineligibility: null };
    const reading = readIdle({
      now,
      bins: [],
      routines: [
        { id: 'a', name: 'A', state: 'ENABLED', ...base, inFlight: 2 },
        { id: 'b', name: 'B', state: 'ENABLED', ...base, retryAt: '2026-10-30T13:00:00.000Z' },
        { id: 'c', name: 'C', state: 'QUARANTINED', ...base, ineligibility: 'routine QUARANTINED' },
        { id: 'd', name: 'D', state: 'ENABLED', ...base, ineligibility: 'bound to no worker' },
        { id: 'e', name: 'E', state: 'ENABLED', ...base, retryAt: '2026-10-30T11:00:00.000Z' },
      ],
    });
    expect(reading.routines.map((r) => r.status)).toEqual(['IN_FLIGHT', 'RATE_LIMITED', 'QUARANTINED', 'UNAVAILABLE', 'IDLE']);
    expect(reading.routines[1]?.detail).toContain('2026-10-30T13:00:00.000Z');
  });
});
