/**
 * TEL-07-1, repair F1: "submitted research jobs by provider and purpose",
 * "utilization", "idle time" and "provider quota/failure" are system-wide
 * figures. Work dispatched to bin workers — `DISPATCH_SENT`, `BIN_ASSIGNED`,
 * a lease that runs until `BIN_TERMINAL`, and a fire nobody answered — is
 * counted beside the free lane's `FREE_LANE_ITEM`s, not left out of them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { rollingTelemetry, type TelemetryFigure } from '../server/services/cash/screenMetrics.ts';

let projectId = '';
let seq = 0;

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const NOW = new Date('2026-11-10T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

async function bin(id: string, kind: string, state = 'COMPLETE', generation = 1): Promise<void> {
  const leased = state === 'LEASED';
  if (leased) {
    await getDb().run(
      `INSERT INTO workers (id, name, display_name, created_by_type, created_by_id, created_at, updated_at)
       VALUES (?, ?, 'w', 'SYSTEM', 'test', ?, ?)`,
      [`wkr_${id}`, `w-${id}`, ago(1440), ago(1440)],
    );
  }
  await getDb().run(
    `INSERT INTO bins (id, project_id, kind, title, objective, completion_contract, state, lease_generation,
       lease_id, worker_id, lease_expires_at, created_by_type, created_at, updated_at)
     VALUES (?, ?, ?, 't', 'o', 'FACTORY_UNITS_V1', ?, ?, ?, ?, ?, 'SYSTEM', ?, ?)`,
    [id, projectId, kind, state, generation, leased ? `bls_${id}` : null, leased ? `wkr_${id}` : null, leased ? NOW.toISOString() : null, ago(1440), ago(1440)],
  );
}

async function event(type: string, at: string, fields: { binId?: string; provider?: string; workloadClass?: string; outcome?: string; reason?: string; durationMs?: number; generation?: number } = {}): Promise<void> {
  seq += 1;
  await getDb().run(
    `INSERT INTO bin_events (id, event_type, at, bin_id, provider, workload_class, outcome, reason, duration_ms, lease_generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`bev_t${seq}`, type, at, fields.binId ?? null, fields.provider ?? null, fields.workloadClass ?? null, fields.outcome ?? null, fields.reason ?? null, fields.durationMs ?? null, fields.generation ?? 1],
  );
}

const fig = (figures: TelemetryFigure[], measure: string): TelemetryFigure => figures.find((f) => f.measure === measure)!;

describe('dispatched bin work is counted system-wide (TEL-07-1, F1)', () => {
  it('counts bins handed to workers as submitted jobs, by the provider that fired them and the bin kind', async () => {
    await event('FREE_LANE_ITEM', ago(10), { provider: 'ollama', workloadClass: 'RESEARCH', outcome: 'SUBMITTED', durationMs: 60_000 });
    await bin('bin_a', 'FACTORY_UNITS');
    await event('DISPATCH_SENT', ago(30), { binId: 'bin_a', provider: 'claude-routine' });
    await event('BIN_ASSIGNED', ago(29), { binId: 'bin_a' });
    await bin('bin_b', 'RESEARCH_FRAGMENTS');
    await event('BIN_ASSIGNED', ago(20), { binId: 'bin_b' });
    await bin('bin_c', 'FACTORY_UNITS', 'READY');
    await event('DISPATCH_SENT', ago(50), { binId: 'bin_c', provider: 'claude-routine' });
    await event('DISPATCH_NO_SHOW', ago(40), { binId: 'bin_c' });

    const jobs = fig((await rollingTelemetry(NOW)).windows['1h'], 'jobs');
    expect(jobs.basis).toBe('ROWS');
    expect(jobs.numerator).toBe(3);
    expect(jobs.denominator).toBe(4); // the fired bin no session took up was attempted, not submitted
    expect(jobs.groups).toEqual(
      expect.arrayContaining([
        { key: 'ollama / RESEARCH', count: 1 },
        { key: 'claude-routine / FACTORY_UNITS', count: 1 },
        { key: '(none) / RESEARCH_FRAGMENTS', count: 1 },
      ]),
    );
    expect(jobs.groups!.reduce((sum, g) => sum + g.count, 0)).toBe(jobs.numerator);
  });

  it('charges a provider no-show as a provider failure over every attempt that reached a provider', async () => {
    await event('FREE_LANE_ITEM', ago(10), { provider: 'ollama', outcome: 'FAILED', reason: 'model call failed: 500' });
    await event('FREE_LANE_ITEM', ago(11), { provider: 'ollama', outcome: 'SUBMITTED' });
    await bin('bin_c', 'FACTORY_UNITS', 'READY');
    await event('DISPATCH_SENT', ago(50), { binId: 'bin_c', provider: 'claude-routine' });
    await event('DISPATCH_NO_SHOW', ago(40), { binId: 'bin_c' });
    await bin('bin_d', 'FACTORY_UNITS');
    await event('DISPATCH_SENT', ago(45), { binId: 'bin_d', provider: 'claude-routine' });
    await event('DISPATCH_INFRA_NO_SHOW', ago(35), { binId: 'bin_d' }); // Brain's outage, not the provider's

    const reading = (await rollingTelemetry(NOW)).windows['1h'];
    const failure = fig(reading, 'providerFailure');
    expect(failure.numerator).toBe(2);
    expect(failure.denominator).toBe(4);
    expect(failure.groups).toEqual(expect.arrayContaining([{ key: 'ollama', count: 1 }, { key: 'claude-routine', count: 1 }]));
    expect(fig(reading, 'providerQuota').denominator).toBe(4);
  });

  it('counts a held bin lease as busy time, so utilization and idle time are not one lane\'s', async () => {
    // No free-lane work at all; a worker held bin_a from 50 to 20 minutes ago, and holds bin_e from 10 minutes ago until now.
    await bin('bin_a', 'FACTORY_UNITS');
    await event('BIN_ASSIGNED', ago(50), { binId: 'bin_a' });
    await event('BIN_TERMINAL', ago(20), { binId: 'bin_a', outcome: 'COMPLETE', durationMs: 30 * 60_000 });
    await bin('bin_e', 'FACTORY_UNITS', 'LEASED', 2);
    await event('BIN_ASSIGNED', ago(10), { binId: 'bin_e', generation: 2 });

    const reading = (await rollingTelemetry(NOW)).windows['1h'];
    const utilization = fig(reading, 'utilization');
    expect(utilization.numerator).toBe(40 * 60_000);
    expect(utilization.denominator).toBe(60 * 60_000);
    const idle = fig(reading, 'idleTime');
    expect(idle.numerator).toBe(10 * 60_000); // the gaps are 0–10 and 40–50 minutes into the hour
  });

  it('ends a lease that closed with no event at its last heartbeat, not at the window\'s end', async () => {
    await bin('bin_f', 'FACTORY_UNITS', 'READY', 2);
    await event('BIN_ASSIGNED', ago(30), { binId: 'bin_f' });
    await event('BIN_HEARTBEAT', ago(25), { binId: 'bin_f' });

    const utilization = fig((await rollingTelemetry(NOW)).windows['1h'], 'utilization');
    expect(utilization.numerator).toBe(5 * 60_000);
  });
});
