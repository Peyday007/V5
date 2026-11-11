/**
 * TEL-07-1, repair F1: the system-wide measures read both paths work takes.
 *
 * `jobs`, `utilization`, `idleTime`, `providerFailure` and the denominator of
 * `providerQuota` once counted only `FREE_LANE_ITEM` rows, so a bin dispatched
 * to a worker — `DISPATCH_SENT`, `BIN_ASSIGNED`, a lease, `BIN_TERMINAL` — was
 * invisible to a reading labelled as the system's. Each case below seeds only
 * dispatched-bin rows, or both paths, and asserts the figure moves.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { rollingTelemetry, type TelemetryFigure } from '../server/services/cash/screenMetrics.ts';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let seq = 0;
async function event(row: {
  type: string;
  at: string;
  bin?: string | null;
  provider?: string | null;
  generation?: number | null;
  durationMs?: number | null;
  outcome?: string | null;
  reason?: string | null;
  workload?: string | null;
}): Promise<void> {
  seq += 1;
  await getDb().run(
    `INSERT INTO bin_events (id, event_type, at, bin_id, provider, lease_generation, duration_ms, outcome, reason, workload_class)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `bev_test_${seq}`,
      row.type,
      row.at,
      row.bin ?? null,
      row.provider ?? null,
      row.generation ?? null,
      row.durationMs ?? null,
      row.outcome ?? null,
      row.reason ?? null,
      row.workload ?? null,
    ],
  );
}

async function figure(measure: string, window: '1h' | '6h' | '24h' = '1h'): Promise<TelemetryFigure> {
  const reading = await rollingTelemetry(NOW);
  const found = reading.windows[window].find((f) => f.measure === measure);
  if (!found) throw new Error(`no ${measure}`);
  return found;
}

beforeEach(async () => {
  await freshProject();
});

describe('system-wide telemetry counts dispatched bins, not only the free lane (TEL-07-1 F1)', () => {
  it('counts a bin handed to a worker as a submitted job, under the provider that fired it and its purpose', async () => {
    await event({ type: 'DISPATCH_SENT', at: ago(50 * 60_000), bin: 'bin_a', provider: 'claude-routine', generation: 0, workload: 'FACTORY_UNIT_V1' });
    await event({ type: 'BIN_ASSIGNED', at: ago(45 * 60_000), bin: 'bin_a', generation: 1, workload: 'FACTORY_UNIT_V1' });
    await event({ type: 'FREE_LANE_ITEM', at: ago(30 * 60_000), provider: 'ollama', outcome: 'SUBMITTED', workload: 'RESEARCH_FRAGMENT', durationMs: 60_000 });
    await event({ type: 'FREE_LANE_ITEM', at: ago(20 * 60_000), provider: 'ollama', outcome: 'FAILED', workload: 'RESEARCH_FRAGMENT', durationMs: 60_000 });
    await event({ type: 'DISPATCH_NO_SHOW', at: ago(10 * 60_000), bin: 'bin_b' });

    const jobs = await figure('jobs');
    expect(jobs.basis).toBe('ROWS');
    // one lane item submitted plus one dispatched bin
    expect(jobs.numerator).toBe(2);
    // two lane attempts, one dispatched bin, one fire no session took up
    expect(jobs.denominator).toBe(4);
    expect(jobs.groups).toEqual(
      expect.arrayContaining([
        { key: 'claude-routine / FACTORY_UNIT_V1', count: 1 },
        { key: 'ollama / RESEARCH_FRAGMENT', count: 1 },
      ]),
    );
    expect(jobs.groups!.reduce((s, g) => s + g.count, 0)).toBe(jobs.numerator);
  });

  it('reads an assignment with no fire on record as provider (none), never a guessed one', async () => {
    await event({ type: 'BIN_ASSIGNED', at: ago(5 * 60_000), bin: 'bin_c', generation: 1, workload: 'RESEARCH_V1' });
    const jobs = await figure('jobs');
    expect(jobs.groups).toEqual([{ key: '(none) / RESEARCH_V1', count: 1 }]);
  });

  it('counts the time a worker held a bin lease as utilization when no lane item ran at all', async () => {
    await event({ type: 'BIN_ASSIGNED', at: ago(40 * 60_000), bin: 'bin_d', generation: 1 });
    await event({ type: 'BIN_TERMINAL', at: ago(10 * 60_000), bin: 'bin_d', generation: 1, outcome: 'COMPLETE' });

    const utilization = await figure('utilization');
    expect(utilization.numerator).toBe(30 * 60_000);
    expect(utilization.denominator).toBe(HOUR);

    const idle = await figure('idleTime');
    // the longest stretch with nothing running is the 20 minutes before the lease
    expect(idle.numerator).toBe(20 * 60_000);
  });

  it('merges a lease and a lane item that overlap so the overlap counts once', async () => {
    await event({ type: 'BIN_ASSIGNED', at: ago(40 * 60_000), bin: 'bin_e', generation: 1 });
    await event({ type: 'BIN_RELEASED', at: ago(20 * 60_000), bin: 'bin_e', generation: 1 });
    // lane item ran from 30 to 10 minutes ago
    await event({ type: 'FREE_LANE_ITEM', at: ago(10 * 60_000), provider: 'ollama', outcome: 'SUBMITTED', durationMs: 20 * 60_000 });
    const utilization = await figure('utilization');
    expect(utilization.numerator).toBe(30 * 60_000);
  });

  it('clips a lease opened before the window to the part inside it', async () => {
    await event({ type: 'BIN_ASSIGNED', at: ago(90 * 60_000), bin: 'bin_f', generation: 1 });
    await event({ type: 'BIN_TERMINAL', at: ago(45 * 60_000), bin: 'bin_f', generation: 1, outcome: 'COMPLETE' });
    const utilization = await figure('utilization');
    expect(utilization.numerator).toBe(15 * 60_000);
  });

  it('ends a lease with no close and no live bin at its last heartbeat, not at the window end', async () => {
    await event({ type: 'BIN_ASSIGNED', at: ago(50 * 60_000), bin: 'bin_g', generation: 1 });
    await event({ type: 'BIN_HEARTBEAT', at: ago(35 * 60_000), bin: 'bin_g', generation: 1 });
    const utilization = await figure('utilization');
    expect(utilization.numerator).toBe(15 * 60_000);
  });

  it("charges a surface's no-show to provider failure, and counts dispatches in the attempts denominator", async () => {
    await event({ type: 'DISPATCH_SENT', at: ago(50 * 60_000), bin: 'bin_h', provider: 'claude-routine', generation: 0 });
    await event({ type: 'DISPATCH_NO_SHOW', at: ago(30 * 60_000), bin: 'bin_h', generation: 0 });
    // charged to the connector's authentication, not the provider
    await event({ type: 'DISPATCH_SENT', at: ago(25 * 60_000), bin: 'bin_i', provider: 'claude-routine', generation: 0 });
    await event({ type: 'DISPATCH_AUTH_NO_SHOW', at: ago(5 * 60_000), bin: 'bin_i', generation: 0 });
    await event({ type: 'FREE_LANE_ITEM', at: ago(20 * 60_000), provider: 'ollama', outcome: 'FAILED', reason: 'model call failed: 503' });

    const failure = await figure('providerFailure');
    expect(failure.numerator).toBe(2);
    expect(failure.denominator).toBe(3);
    expect(failure.groups).toEqual(
      expect.arrayContaining([
        { key: 'claude-routine', count: 1 },
        { key: 'ollama', count: 1 },
      ]),
    );

    const quota = await figure('providerQuota');
    expect(quota.denominator).toBe(3);
  });
});
