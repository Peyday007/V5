/**
 * The idle reading: why ready work is not moving. Pure over a recorded snapshot,
 * so every case is a hand-built fleet — the reading composes `routeBin` and the
 * snapshot and re-derives no eligibility, which is what these cases pin.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeIdle, surfaceStatus } from '../server/services/factory/throughput.ts';
import type { RoutingCandidate } from '../server/services/dispatch/router.ts';
import type { FleetSnapshot } from '../server/services/dispatch/candidates.ts';
import type { Bin, BinDispatch, FleetAccount, FleetPolicy, FleetRoutine } from '../server/domain/types.ts';

const NOW = '2026-10-30T12:00:00.000Z';
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
const PROJECT = 'prj_idle';

const bin = (over: Partial<Bin> = {}): Bin =>
  ({ id: 'bin_a', projectId: PROJECT, kind: 'FACTORY_UNITS', state: 'READY', priority: 5, requiredCapabilities: [], workloadClass: null,
     createdAt: minutesAgo(50), readyAt: minutesAgo(42), factoryCampaignId: 'fcp_1', ...over }) as unknown as Bin;

const dispatch = (over: Partial<BinDispatch> = {}): BinDispatch =>
  ({ id: 'd1', binId: 'bin_a', leaseGeneration: 0, state: 'DEFERRED', lastErrorKind: 'FLEET_TARGET_REACHED',
     lastError: '3 activations are in flight and the fleet target is 3', ...over }) as unknown as BinDispatch;

function candidate(id: string, routine: Partial<FleetRoutine> = {}, account: Partial<FleetAccount> = {}, counts: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    servesRepositories: null, servesProjects: [PROJECT], workerActive: true, servesFamilies: null,
    routine: { id, accountId: 'acct_1', routineRef: `trig_${id}`, name: id, state: 'ENABLED', capabilities: [], retryAt: null, stateReason: null, lastFiredAt: null, ...routine } as FleetRoutine,
    account: { id: 'acct_1', name: 'a1', state: 'ENABLED', retryAt: null, ...account } as FleetAccount,
    routineInFlight: 0, accountInFlight: 0, routineTarget: null, accountTarget: null, ...counts,
  };
}

const snapshot = (candidates: RoutingCandidate[], over: Partial<FleetSnapshot> = {}): FleetSnapshot =>
  ({ candidates, fleetPolicy: { target: 3 } as FleetPolicy, fleetInFlight: 0, factoryInFlight: 0, missingSecrets: [], ...over });

describe('the idle reading', () => {
  it('reports a waiting bin with how long it waited and the refusal on its dispatch', () => {
    const reading = computeIdle({
      now: new Date(NOW),
      bins: [{ bin: bin({ kind: 'RESEARCH_PACKET', factoryCampaignId: null, workloadClass: 'GENERAL_RESEARCH' }), dispatches: [dispatch({ lastErrorKind: 'OLD' }), dispatch()] }],
      snapshot: snapshot([candidate('r1')], { fleetInFlight: 3 }),
    });
    const [b] = reading.bins;
    expect(b!.waitedMs).toBe(42 * 60_000);
    expect(b!.dispatch).toMatchObject({ state: 'DEFERRED', lastErrorKind: 'FLEET_TARGET_REACHED' });
    expect(b!.fleet).toEqual({ inFlight: 3, target: 3, factoryInFlight: 0 });
    expect(b!.routing).toMatchObject({ ok: false, refusal: 'FLEET_TARGET_REACHED' });
  });

  it('says when nothing has been tried yet, and when the fleet could fire it now', () => {
    const reading = computeIdle({ now: new Date(NOW), bins: [{ bin: bin(), dispatches: [] }], snapshot: snapshot([candidate('r1')]) });
    expect(reading.bins[0]!.dispatch).toBeNull();
    expect(reading.bins[0]!.routing.ok === false ? reading.bins[0]!.routing.refusal : 'fires').not.toBe('NO_ROUTINES_REGISTERED');
  });

  it('names an empty fleet rather than leaving the wait unexplained', () => {
    const reading = computeIdle({ now: new Date(NOW), bins: [{ bin: bin(), dispatches: [] }], snapshot: snapshot([]) });
    expect(reading.bins[0]!.routing).toMatchObject({ ok: false, refusal: 'NO_ROUTINES_REGISTERED' });
    expect(reading.surfaces).toEqual([]);
  });

  it('orders the longest wait first', () => {
    const reading = computeIdle({
      now: new Date(NOW),
      bins: [{ bin: bin({ id: 'young', readyAt: minutesAgo(1) }), dispatches: [] }, { bin: bin({ id: 'old', readyAt: minutesAgo(90) }), dispatches: [] }],
      snapshot: snapshot([candidate('r1')]),
    });
    expect(reading.bins.map((b) => b.binId)).toEqual(['old', 'young']);
  });

  it('classifies every routable Routine: in flight, rate limited, quarantined, idle', () => {
    const later = new Date(Date.parse(NOW) + 20 * 60_000).toISOString();
    const reading = computeIdle({
      now: new Date(NOW),
      bins: [],
      snapshot: snapshot([
        candidate('busy', {}, {}, { routineInFlight: 2 }),
        candidate('limited', { retryAt: later }),
        candidate('account-limited', {}, { retryAt: later }),
        candidate('out', { state: 'QUARANTINED', stateReason: 'AUTH 403 routines are not available' }),
        candidate('free'),
        candidate('past-limit', { retryAt: minutesAgo(5) }),
      ]),
    });
    const by = Object.fromEntries(reading.surfaces.map((s) => [s.name, s]));
    expect(by['busy']).toMatchObject({ status: 'IN_FLIGHT', inFlight: 2 });
    expect(by['limited']).toMatchObject({ status: 'RATE_LIMITED', retryAt: later });
    expect(by['account-limited']).toMatchObject({ status: 'RATE_LIMITED', retryAt: later });
    expect(by['out']).toMatchObject({ status: 'QUARANTINED', stateReason: 'AUTH 403 routines are not available', retryAt: null });
    expect(by['free']).toMatchObject({ status: 'IDLE', retryAt: null });
    // A limit that has already passed is history, not a condition.
    expect(by['past-limit']!.status).toBe('IDLE');
  });

  it('quarantine outranks a rate limit, which outranks being in flight', () => {
    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    expect(surfaceStatus(candidate('x', { state: 'QUARANTINED', retryAt: later }, {}, { routineInFlight: 1 }), NOW)).toBe('QUARANTINED');
    expect(surfaceStatus(candidate('x', { retryAt: later }, {}, { routineInFlight: 1 }), NOW)).toBe('RATE_LIMITED');
  });
});

describe('the factory door', () => {
  const source = readFileSync('scripts/factory.ts', 'utf8');
  it('has an idle command, advertised, that prints the reading', () => {
    expect(source).toMatch(/case 'idle': \{/);
    expect(source).toMatch(/idleReading\(\)/);
    expect(source.slice(source.lastIndexOf('commands:'))).toMatch(/\bidle\b/);
  });
  it('prints the stages block inside throughput', () => {
    const printer = source.slice(source.indexOf("case 'throughput': {"), source.indexOf("case 'pull-request': {"));
    for (const field of ['planDurationMs', 'timeToFirstCodingMs', 'integrationDelayMs', 'reviewDelayMs', 'concurrentUnitBinsMax', 'completionMs', 'queueDelayByKind']) {
      expect(printer).toContain(field);
    }
  });
});
