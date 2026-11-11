/**
 * TEL-07-1, repair F3: S-0082 lists "cost and resource limits", and the
 * reading carried cost alone. Resource limits are read from the rows that
 * record them — dispatches Brain held back on its own capacity, database
 * pressure (§63), the subscription allowance left (§16), and storage (§33) —
 * and a limit with no row in the window reads 0 of 0, never a guessed level.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { TELEMETRY_WINDOWS, rollingTelemetry, telemetryMeasureKeys, type TelemetryFigure } from '../server/services/cash/screenMetrics.ts';
import { judgeTelemetryReading } from '../server/services/cash/telemetryProbe.ts';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const RESOURCE_MEASURES = ['resourceDeferrals', 'databasePressure', 'allowanceExhausted', 'storage'];

let seq = 0;
async function binEvent(type: string, at: string, outcome: string | null = null): Promise<void> {
  seq += 1;
  await getDb().run('INSERT INTO bin_events (id, event_type, at, outcome) VALUES (?, ?, ?, ?)', [`bev_res_${seq}`, type, at, outcome]);
}

async function liveness(instance: string, aliveAt: string, readings: unknown): Promise<void> {
  await getDb().run('INSERT INTO runtime_liveness (instance_id, started_at, alive_at, readings) VALUES (?, ?, ?, ?)', [
    instance,
    ago(48 * HOUR),
    aliveAt,
    readings === undefined ? null : JSON.stringify(readings),
  ]);
}

async function storage(at: string, databaseBytes: number | null, objectBytes: number | null): Promise<void> {
  seq += 1;
  await getDb().run(
    `INSERT INTO storage_readings (id, observed_at, provider, database_bytes, object_bytes, object_count, object_bytes_raw, categories)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [`str_res_${seq}`, at, 'local', databaseBytes, objectBytes, 3, objectBytes, '[]'],
  );
}

async function figure(measure: string, window: '1h' | '6h' | '24h' = '1h'): Promise<TelemetryFigure> {
  const found = (await rollingTelemetry(NOW)).windows[window].find((f) => f.measure === measure);
  if (!found) throw new Error(`no ${measure}`);
  return found;
}

beforeEach(async () => {
  await freshProject();
  await getDb().run('DELETE FROM runtime_liveness', []);
  await getDb().run('DELETE FROM storage_readings', []);
});

describe('resource limits are reported beside cost (TEL-07-1, S-0082)', () => {
  it('declares a resource-limit measure for each limit the rows record, in every window', async () => {
    for (const key of RESOURCE_MEASURES) expect(telemetryMeasureKeys()).toContain(key);
    const reading = await rollingTelemetry(NOW);
    for (const w of TELEMETRY_WINDOWS) {
      for (const key of RESOURCE_MEASURES) {
        const f = reading.windows[w.key].find((x) => x.measure === key)!;
        expect(f.basis).toBe('ROWS');
        expect(f.denominatorIs.length).toBeGreaterThan(0);
      }
    }
  });

  it('with no rows, each limit reads 0 of 0 and the probe still passes — nothing unknown, nothing guessed', async () => {
    const reading = await rollingTelemetry(NOW);
    for (const key of RESOURCE_MEASURES) {
      const f = reading.windows['1h'].find((x) => x.measure === key)!;
      expect([f.numerator, f.denominator, f.rate]).toEqual([0, 0, null]);
    }
    expect((await figure('storage')).note).toMatch(/no size is reported because none was measured/);
    expect(judgeTelemetryReading(reading).ok).toBe(true);
  });

  it('counts dispatches Brain held back on its own capacity, by refusal, against every dispatch decision', async () => {
    await binEvent('DISPATCH_DEFERRED', ago(10 * MINUTE), 'CAPACITY_FULL');
    await binEvent('DISPATCH_DEFERRED', ago(20 * MINUTE), 'CAPACITY_FULL');
    await binEvent('DISPATCH_DEFERRED', ago(30 * MINUTE), 'ALLOWANCE_LOW');
    await binEvent('DISPATCH_SENT', ago(5 * MINUTE));
    await binEvent('DISPATCH_DEFERRED', ago(3 * HOUR), 'CAPACITY_FULL');

    const h1 = await figure('resourceDeferrals');
    expect([h1.numerator, h1.denominator]).toEqual([3, 4]);
    expect(h1.rate).toBeCloseTo(0.75);
    expect(h1.groups).toEqual([
      { key: 'CAPACITY_FULL', count: 2 },
      { key: 'ALLOWANCE_LOW', count: 1 },
    ]);
    const h6 = await figure('resourceDeferrals', '6h');
    expect([h6.numerator, h6.denominator]).toEqual([4, 5]);
  });

  it('reads database pressure from each process’s liveness reading, and never counts a missing state as shedding', async () => {
    await liveness('proc-a', ago(2 * MINUTE), { pressure: { state: 'SHEDDING', reason: 'p90 reached the pool checkout timeout' } });
    await liveness('proc-b', ago(4 * MINUTE), { pressure: { state: 'NORMAL', reason: 'healthy' } });
    await liveness('proc-c', ago(6 * MINUTE), { pools: {} });
    await liveness('proc-old', ago(5 * HOUR), { pressure: { state: 'SHEDDING', reason: 'old' } });

    const h1 = await figure('databasePressure');
    expect([h1.numerator, h1.denominator]).toEqual([1, 3]);
    expect(h1.note).toMatch(/p90 reached the pool checkout timeout/);
    expect(h1.note).toMatch(/1 reading\(s\) carried no pressure state/);
    const h6 = await figure('databasePressure', '6h');
    expect([h6.numerator, h6.denominator]).toEqual([2, 4]);
  });

  it('reports the newest storage reading’s sizes as measured, and an unmeasured size as unmeasured', async () => {
    await storage(ago(50 * MINUTE), 1000, 2000);
    await storage(ago(10 * MINUTE), 1500, null);

    const h1 = await figure('storage');
    expect([h1.numerator, h1.denominator]).toEqual([2, 2]);
    expect(h1.note).toMatch(/database 1500 bytes, objects unmeasured/);
    expect(h1.note).toMatch(/never a threshold that stops work/);
  });

  it('says plainly when no account reported its allowance, rather than assuming any remains', async () => {
    const f = await figure('allowanceExhausted', '24h');
    expect([f.numerator, f.denominator]).toEqual([0, 0]);
    expect(f.note).toMatch(/nothing is assumed about what remains/);
  });
});
