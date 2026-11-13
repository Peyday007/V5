/**
 * TEL-07-1: the rolling reading carries every listed measure in every window,
 * a rate is null at a zero denominator, and a measure that cannot be read is
 * UNKNOWN rather than 0.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  TELEMETRY_WINDOWS,
  formatTelemetry,
  rollingTelemetry,
  telemetryMeasureKeys,
} from '../server/services/cash/screenMetrics.ts';

const LISTED = [
  'jobs', 'claimsAccepted', 'claimsRejected', 'usefulClaims', 'auditCompletion', 'readableSources',
  'openingsFiled', 'actionableOpenings', 'mechanismDiversity', 'constructedVariants', 'usableOffers', 'salesAndReceipts',
  'queue', 'utilization', 'idleTime', 'retries', 'providerFailure', 'providerQuota', 'cost',
  'improvementPrOutcomes',
];

beforeEach(async () => {
  await freshProject();
});

describe('rolling telemetry (TEL-07-1)', () => {
  it('declares every listed measure', () => {
    for (const key of LISTED) expect(telemetryMeasureKeys()).toContain(key);
  });

  it('carries every measure in all of the 1h, 6h and 24h windows with its window bounds and denominator wording', async () => {
    const now = new Date('2026-11-10T12:00:00.000Z');
    const reading = await rollingTelemetry(now);
    expect(Object.keys(reading.windows).sort()).toEqual(['1h', '24h', '6h']);
    for (const w of TELEMETRY_WINDOWS) {
      const figures = reading.windows[w.key];
      expect(figures.map((f) => f.measure).sort()).toEqual([...telemetryMeasureKeys()].sort());
      for (const f of figures) {
        expect(f.window.key).toBe(w.key);
        expect(f.window.until).toBe(now.toISOString());
        expect(Date.parse(f.window.until) - Date.parse(f.window.since)).toBe(w.ms);
        expect(f.denominatorIs.length).toBeGreaterThan(0);
      }
    }
  });

  it('reads a rate as null at a zero denominator, and counts zero rows as 0, not unknown', async () => {
    const reading = await rollingTelemetry(new Date('2000-01-01T00:00:00.000Z'));
    for (const w of TELEMETRY_WINDOWS) {
      for (const f of reading.windows[w.key]) {
        if (f.basis !== 'ROWS' || f.denominator !== 0) continue;
        expect(f.rate).toBeNull();
        expect(f.numerator).toBe(0);
      }
    }
    const claims = reading.windows['1h'].find((f) => f.measure === 'claimsAccepted')!;
    expect(claims.basis).toBe('ROWS');
    expect(claims.denominator).toBe(0);
    expect(claims.rate).toBeNull();
  });

  it('reads a measure whose rows cannot be read as UNKNOWN with no number, never 0', async () => {
    const db = getDb();
    await db.run('ALTER TABLE quota_pauses RENAME TO quota_pauses_hidden', []);
    try {
      const reading = await rollingTelemetry(new Date('2026-11-10T12:00:00.000Z'));
      for (const w of TELEMETRY_WINDOWS) {
        const quota = reading.windows[w.key].find((f) => f.measure === 'providerQuota')!;
        expect(quota.basis).toBe('UNKNOWN');
        expect(quota.numerator).toBeNull();
        expect(quota.denominator).toBeNull();
        expect(quota.rate).toBeNull();
        expect(quota.note).toMatch(/^unreadable:/);
        // the failure is confined to the measure that could not be read
        const others = reading.windows[w.key].filter((f) => f.measure !== 'providerQuota');
        expect(others.every((f) => f.basis === 'ROWS')).toBe(true);
      }
      expect(formatTelemetry(reading).join('\n')).toMatch(/providerQuota\s+1h unknown/);
    } finally {
      await db.run('ALTER TABLE quota_pauses_hidden RENAME TO quota_pauses', []);
    }
  });
});
