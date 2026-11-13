/**
 * TEL-07-1's fixed check, `probe r01.tel-07-1`, is registered in the Brain that
 * serves the cash surface, passes on a complete reading of real rows, and
 * refuses a reading that drops a measure, loses a window's bounds, merges the
 * job count with the useful or actionable figures, or could not read a measure.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getProbe, probeNames } from '../server/services/factory/program/probes.ts';
import { rollingTelemetry, type RollingTelemetry } from '../server/services/cash/screenMetrics.ts';
import '../server/services/cash/view.ts';
import { TELEMETRY_PROBE, judgeTelemetryReading, telemetryHoldsOnRows } from '../server/services/cash/telemetryProbe.ts';

beforeEach(async () => {
  await freshProject();
});

const clone = (r: RollingTelemetry): RollingTelemetry => JSON.parse(JSON.stringify(r)) as RollingTelemetry;

describe('probe r01.tel-07-1', () => {
  it('is registered once the cash surface is loaded, under the name the requirement checks', () => {
    expect(TELEMETRY_PROBE).toBe('r01.tel-07-1');
    expect(probeNames()).toContain('r01.tel-07-1');
    expect(getProbe('r01.tel-07-1')).not.toBeNull();
  });

  it('passes on a fresh reading of the rows', async () => {
    const answer = await getProbe('r01.tel-07-1')!({});
    expect(answer.detail).toContain('1h/6h/24h');
    expect(answer.ok).toBe(true);
  });

  it('refuses a reading missing a measure in one window', async () => {
    const reading = clone(await rollingTelemetry(new Date('2026-11-10T12:00:00.000Z')));
    reading.windows['6h'] = reading.windows['6h'].filter((f) => f.measure !== 'retries');
    const answer = judgeTelemetryReading(reading);
    expect(answer.ok).toBe(false);
    expect(answer.detail).toContain('6h carries 0 figure(s) for retries');
  });

  it('refuses a figure without its window bounds or denominator wording', async () => {
    const reading = clone(await rollingTelemetry(new Date('2026-11-10T12:00:00.000Z')));
    reading.windows['24h'][0]!.window.since = reading.windows['24h'][0]!.window.until;
    reading.windows['1h'][1]!.denominatorIs = ' ';
    const answer = judgeTelemetryReading(reading);
    expect(answer.ok).toBe(false);
    expect(answer.detail).toMatch(/has no 24h window bounds/);
    expect(answer.detail).toMatch(/does not say what its denominator is/);
  });

  it('refuses a reading that counts jobs, useful claims and actionable openings as one figure', async () => {
    const reading = clone(await rollingTelemetry(new Date('2026-11-10T12:00:00.000Z')));
    const jobs = reading.windows['1h'].find((f) => f.measure === 'jobs')!;
    for (const f of reading.windows['1h']) {
      if (f.measure === 'usefulClaims' || f.measure === 'actionableOpenings') {
        f.label = jobs.label;
        f.denominatorIs = jobs.denominatorIs;
      }
    }
    const answer = judgeTelemetryReading(reading);
    expect(answer.ok).toBe(false);
    expect(answer.detail).toContain('as the same figure');
  });

  it('names an UNKNOWN measure rather than reading it as zero', async () => {
    const reading = clone(await rollingTelemetry(new Date('2026-11-10T12:00:00.000Z')));
    const f = reading.windows['1h'].find((x) => x.measure === 'cost')!;
    Object.assign(f, { basis: 'UNKNOWN', numerator: null, denominator: null, rate: null, note: 'unreadable: no such table' });
    const answer = judgeTelemetryReading(reading);
    expect(answer.ok).toBeNull(); // UNKNOWN, never a pass and never a zero
    expect(answer.detail).toContain('UNKNOWN: 1h cost (unreadable: no such table)');
  });

  it('reads the rows now rather than a cached reading', async () => {
    const at = new Date('2026-11-10T12:00:00.000Z');
    const answer = await telemetryHoldsOnRows(at);
    expect(answer.detail).toContain(at.toISOString());
  });
});
