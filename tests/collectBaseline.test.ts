import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { buildWorkload, measureBaseline } from '../server/services/collect/baseline/index.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'collect-baseline', 'baseline.json');

beforeEach(async () => { await freshProject(); });

describe('collection baseline', () => {
  it('measures the unchanged pipeline and matches the stored baseline counts', async () => {
    const reading = await measureBaseline(buildWorkload(20, 40));
    if (process.env['UPDATE_COLLECT_BASELINE'] === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify({ ...reading, measuredOn: 'dev machine, SQLite, fake fetcher; timings are indicative only' }, null, 2)}\n`);
    }
    const stored = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as typeof reading;
    expect(reading.workload).toBe(stored.workload);
    expect(reading.counts).toEqual(stored.counts);
    expect(reading.rates).toEqual(stored.rates);
  });

  it('counts a failing source as a failed pull and does not invent figures', async () => {
    const r = await measureBaseline(buildWorkload(2, 0));
    expect(r.counts.failedPulls).toBeGreaterThan(0);
    expect(r.counts.claudeJobs).toBe(0);
    expect(r.rates.failureRate).toBeGreaterThan(0);
    expect(r.counts.duplicates).toBe(r.counts.fetched - r.counts.inserted);
  });

  it('is deterministic in its counts', async () => {
    const a = await measureBaseline(buildWorkload(3, 5));
    await freshProject();
    const b = await measureBaseline(buildWorkload(3, 5));
    expect(a.counts).toEqual(b.counts);
  });
});
