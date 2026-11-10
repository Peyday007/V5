/**
 * TEL-07-1, repair F3: "constructed variants" is a listed measure, and the
 * arrangements Brain composes itself (§81-83) are rows — the discovery rounds
 * `openConstructedRound` records under `goal-<goalId>-mx-<key>`. The reading
 * counts them over every window, against every discovery round opened, and
 * never claims them as unmeasurable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { TELEMETRY_WINDOWS, rollingTelemetry, telemetryMeasureKeys } from '../server/services/cash/screenMetrics.ts';

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const NOW = new Date('2026-11-10T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

async function round(id: string, bucketId: string, n: number, state: string, openedAt: string, found: number): Promise<void> {
  await getDb().run(
    `INSERT INTO cash_discovery_rounds (id, project_id, cash_mode_id, bucket_id, mechanism, round, candidate_id, state, opened_at, found, created_at, updated_at)
     VALUES (?, ?, 'cm_test', ?, 'OTHER', ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, bucketId, n, `rcn_${id}`, state, openedAt, found, openedAt, openedAt],
  );
}

describe('constructed variants are measured (TEL-07-1, F3)', () => {
  it('declares the measure', () => {
    expect(telemetryMeasureKeys()).toContain('constructedVariants');
  });

  it('counts constructed rounds against all discovery rounds, per window, with distinct variants and states', async () => {
    // two constructed variants, one asked twice; a plain goal lens; an ordinary bucket
    await round('r1', 'goal-wst_a-mx-aaa111', 1, 'HARVESTED', ago(30), 2);
    await round('r2', 'goal-wst_a-mx-aaa111', 2, 'OPEN', ago(200), 0);
    await round('r3', 'goal-wst_a-mx-bbb222', 1, 'ABANDONED', ago(600), 0);
    await round('r4', 'goal-wst_a-wide', 1, 'HARVESTED', ago(20), 1);
    await round('r5', 'b-service-gaps', 1, 'OPEN', ago(100), 0);
    // outside every window
    await round('r6', 'goal-wst_a-mx-ccc333', 1, 'HARVESTED', ago(60 * 30), 1);

    const reading = await rollingTelemetry(NOW);
    const fig = (key: string) => reading.windows[key as '1h'].find((f) => f.measure === 'constructedVariants')!;

    const h1 = fig('1h');
    expect(h1.basis).toBe('ROWS');
    expect([h1.numerator, h1.denominator]).toEqual([1, 2]);
    expect(h1.groups).toEqual([{ key: 'HARVESTED', count: 1 }]);
    expect(h1.note).toMatch(/^1 distinct constructed variant\(s\) asked; 1 round\(s\) found/);

    const h6 = fig('6h');
    expect([h6.numerator, h6.denominator]).toEqual([2, 4]);
    expect(h6.note).toMatch(/^1 distinct/);

    const h24 = fig('24h');
    expect([h24.numerator, h24.denominator]).toEqual([3, 5]);
    expect(h24.rate).toBeCloseTo(3 / 5);
    expect(h24.groups!.reduce((s, g) => s + g.count, 0)).toBe(h24.numerator);
    expect(h24.note).toMatch(/^2 distinct constructed variant\(s\) asked; 1 round\(s\) found/);

    for (const w of TELEMETRY_WINDOWS) {
      const diversity = reading.windows[w.key].find((f) => f.measure === 'mechanismDiversity')!;
      expect(diversity.note ?? '').not.toMatch(/not claimed|not recorded/);
    }
  });
});
