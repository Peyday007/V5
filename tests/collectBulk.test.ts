import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { compareToBaseline, measureBulk } from '../server/services/collect/bench/index.ts';

const BASELINE = path.join(import.meta.dirname, 'fixtures', 'collect-baseline', 'baseline.json');

beforeEach(async () => { await freshProject(); });

describe('bulk collection over fixtures', () => {
  it('processes 10,000+ records with no Claude job and no cheap-lane call for a rule-matched record', async () => {
    const r = await measureBulk({ name: 'companies=1500,filler=4500', companies: 1500, filler: 4500, incrementalPerMille: 10 });
    expect(r.records).toBeGreaterThanOrEqual(10_000);
    expect(r.counts.claudeJobs).toBe(0);
    // runDetectors reads at most 5,000 stored records per rule, so on 10,000+ records it sees a slice:
    // a measured limit of the existing detector owner, reported in docs/COLLECTION-BENCHMARK.md.
    expect(r.counts.detectorRecordsRead).toBeLessThanOrEqual(5_000);
    expect(r.counts.detectorSignals).toBeGreaterThan(0);
    expect(r.counts.detectorSignals).toBeLessThanOrEqual(1500);
    expect(r.counts.ruleCoveredScreened).toBe(0);
    // Two models per screened record, and the lane is bounded per pass, not per record.
    expect(r.counts.cheapCalls).toBe(r.counts.screened * 2);
    expect(r.counts.screened).toBeLessThan(r.records / 10);
    // The failing source is isolated: the others still collected.
    expect(r.counts.failedPulls).toBe(2);
    expect(r.counts.inserted).toBeGreaterThan(r.records - 1);
    // An incremental pull stores only what is new.
    expect(r.counts.incrementalInserted).toBe(r.counts.incrementalFetched - r.records);
    expect(r.rates.incrementalNewRate).toBeLessThan(0.02);
  }, 280_000);

  it('compares with the stored baseline using measured figures only', async () => {
    const stored = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    const r = await measureBulk({ name: 'companies=20,filler=40', companies: 20, filler: 40, incrementalPerMille: 10 });
    const cmp = compareToBaseline(stored, r);
    expect(cmp.baselineWorkload).toBe('companies=20,filler=40');
    for (const row of cmp.rows) expect(row.now).not.toBeNaN();
    expect(cmp.rows.find((x) => x.figure === 'claudeJobs')).toMatchObject({ baseline: 0, now: 0 });
    expect(r.counts.failedPulls).toBe(2);
  }, 120_000);
});
