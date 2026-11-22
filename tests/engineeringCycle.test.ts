/**
 * Brain's engineering cycle (§115): stages measured from forge records, the
 * limiting stage named, competing corrections ranked, a bottleneck shift
 * detected, and the reading fed to the existing operator detector and §87's
 * metric — on synthetic workflow runs, jobs and pull requests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  CYCLE_STAGES,
  LIMITING_SHARE_THRESHOLD,
  bottleneckChange,
  measureThroughput,
  type CycleSources,
  type CycleStage,
  type ForgeJob,
  type ForgeRun,
} from '../server/domain/engineeringCycle.ts';
import { measureAndRecord, storedCycles } from '../server/services/engineering/cycle.ts';
import { throughputDeficiencies } from '../server/services/operator/director.ts';
import { readMetric } from '../server/services/improvement/scoreboard.ts';

const MIN = 60_000;
const iso = (t: number): string => new Date(t).toISOString();

/** `n` cycles, one Deploy each, with the given stage minutes, starting at `start`, every 2 h. */
function synthetic(start: number, n: number, minutes: Record<CycleStage, number>, opts: { failEvery?: number } = {}): CycleSources {
  const runs: ForgeRun[] = [];
  const jobs: Record<string, ForgeJob[]> = {};
  const pulls: CycleSources['pulls'] = [];
  const commits: CycleSources['commits'] = {};
  let runId = Math.floor(start / 1000);
  for (let i = 0; i < n; i += 1) {
    const first = start + i * 120 * MIN;
    const opened = first + minutes.DEVELOPMENT * MIN;
    const merged = opened + minutes.INTEGRATION_WAIT * MIN;
    const dispatched = merged + minutes.RELEASE_QUEUE * MIN;
    const gates = dispatched + minutes.TEST * MIN;
    const deployed = gates + minutes.RELEASE * MIN;
    const done = deployed + minutes.VERIFICATION * MIN;
    const number = Math.floor(start / 3_600_000) * 100 + i;
    pulls.push({ number, created_at: iso(opened), merged_at: iso(merged), base: { ref: 'production' } });
    commits[String(number)] = [{ commit: { author: { date: iso(first) } } }];
    if (opts.failEvery && i % opts.failEvery === 0) {
      // A failed Deploy dispatched right after the merge: the cycle waits for the next one.
      runId += 1;
      runs.push({ id: runId, name: 'Deploy', status: 'completed', conclusion: 'failure', head_branch: 'production', head_sha: 'f', created_at: iso(merged + 1000), updated_at: iso(merged + 2000) });
      jobs[String(runId)] = [];
    }
    runId += 1;
    runs.push({ id: runId, name: 'Deploy', status: 'completed', conclusion: 'success', head_branch: 'production', head_sha: 'a', created_at: iso(dispatched), updated_at: iso(done), run_attempt: 1 });
    jobs[String(runId)] = [
      {
        name: 'The Postgres suite passed on this commit',
        conclusion: 'success',
        started_at: iso(dispatched + MIN),
        completed_at: iso(gates - 1000),
        steps: [
          { name: 'Set up job', conclusion: 'success', started_at: iso(dispatched + MIN), completed_at: iso(dispatched + 2 * MIN) },
          { name: 'Wait for completed Postgres evidence', conclusion: 'success', started_at: iso(dispatched + 2 * MIN), completed_at: iso(gates - 1000) },
        ],
      },
      {
        name: 'Deploy to Fly',
        conclusion: 'success',
        started_at: iso(gates),
        completed_at: iso(done),
        steps: [{ name: 'Deploy', conclusion: 'success', started_at: iso(gates + 1000), completed_at: iso(deployed) }],
      },
    ];
  }
  return { repository: 'peyday007/v5', canonicalBranch: 'production', runs, jobs, pulls, commits };
}

const T0 = Date.parse('2026-11-01T00:00:00Z');
const testBound: Record<CycleStage, number> = { DEVELOPMENT: 10, INTEGRATION_WAIT: 10, RELEASE_QUEUE: 2, TEST: 40, RELEASE: 3, VERIFICATION: 5 };
const reviewBound: Record<CycleStage, number> = { DEVELOPMENT: 10, INTEGRATION_WAIT: 80, RELEASE_QUEUE: 2, TEST: 15, RELEASE: 3, VERIFICATION: 5 };
const window = (start: number, n: number) => ({ from: iso(start - MIN), to: iso(start + n * 120 * MIN + 5 * 60 * MIN) });

describe('measuring the engineering cycle', () => {
  it('splits each cycle into sequential stages and names the largest share of the critical path', () => {
    const sources = synthetic(T0, 12, testBound);
    const reading = measureThroughput(sources, window(T0, 12), [
      { ref: 'evx_1', kind: 'EVOLUTION_ADOPT', at: iso(T0 + 60 * MIN) },
      { ref: 'imp_old', kind: 'IMPROVEMENT_KEPT', at: iso(T0 - 72 * 60 * MIN) },
    ]);
    expect(reading.merged).toBe(12);
    expect(reading.verified).toBe(12);
    for (const stage of CYCLE_STAGES) expect(reading.stages[stage].medianHours).toBeCloseTo(testBound[stage] / 60, 2);
    expect(reading.cycleMedianHours).toBeCloseTo(70 / 60, 2);
    expect(reading.limitingStage).toBe('TEST');
    expect(reading.limitingShare).toBeCloseTo(40 / 70, 2);
    // Only a measurement that moved counts, and only inside the window; twelve merged PRs are not improvements.
    expect(reading.improvements.count).toBe(1);
    expect(reading.improvements.refs).toEqual(['EVOLUTION_ADOPT:evx_1']);
    // The best estimate is a TEST correction, and the measured Postgres wait bounds it.
    expect(reading.corrections[0]!.stage).toBe('TEST');
    expect(reading.corrections[0]!.assumption).toContain('Postgres');
    expect(reading.releases).toMatchObject({ dispatched: 12, shipped: 12, failed: 0 });
  });

  it('charges a failed release to the release queue and counts it', () => {
    const sources = synthetic(T0, 6, testBound, { failEvery: 2 });
    const reading = measureThroughput(sources, window(T0, 6));
    expect(reading.releases.failed).toBe(3);
    expect(reading.releases.shipped).toBe(6);
    expect(reading.verified).toBe(6);
  });

  it('names no limiting stage below the minimum sample', () => {
    const reading = measureThroughput(synthetic(T0, 3, testBound), window(T0, 3));
    expect(reading.limitingStage).toBeNull();
    expect(bottleneckChange(null, reading).record).toBe(false);
  });

  it('detects when the bottleneck moves', () => {
    const before = measureThroughput(synthetic(T0, 10, testBound), window(T0, 10));
    const later = T0 + 48 * 60 * MIN;
    const after = measureThroughput(synthetic(later, 10, reviewBound), window(later, 10));
    expect(after.limitingStage).toBe('INTEGRATION_WAIT');
    const change = bottleneckChange(before, after);
    expect(change).toMatchObject({ shifted: true, from: 'TEST', to: 'INTEGRATION_WAIT', record: true });
    const steady = bottleneckChange(after, after);
    expect(steady.shifted).toBe(false);
    expect(steady.overThreshold).toBe((after.limitingShare ?? 0) >= LIMITING_SHARE_THRESHOLD);
  });
});

describe('feeding the existing loop', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('stores readings as evidence, raises the limiting stage as a deficiency, and serves §87 its metric', async () => {
    expect(await throughputDeficiencies()).toEqual([]);
    const first = await measureAndRecord(synthetic(T0, 10, testBound), window(T0, 10), { record: true });
    expect(first.recorded).toMatch(/^eev_/);
    expect(first.change).toMatchObject({ shifted: false, overThreshold: true, record: true });

    // Seen once: recorded, watched, not engineered.
    let found = await throughputDeficiencies();
    expect(found).toHaveLength(1);
    expect(found[0]!.diagnosis.title).toBe('Engineering throughput is limited by the TEST stage');
    expect(found[0]!.diagnosis.metric).toBe('ENGINEERING_CYCLE_HOURS_MEDIAN');
    expect(found[0]!.intervention).toBe('WATCH');

    // The same stage limits the next window too: an established, owned, recurring cause.
    const second = T0 + 30 * 60 * MIN;
    await measureAndRecord(synthetic(second, 10, testBound), window(second, 10), { record: true });
    found = await throughputDeficiencies();
    expect(found[0]!.intervention).toBe('ENGINEERING');
    expect(found[0]!.diagnosis.ownerPaths).toContain('.github/workflows/deploy.yml');

    // The bottleneck moves: a new deficiency, named for the new stage.
    const third = T0 + 60 * 60 * MIN;
    const shifted = await measureAndRecord(synthetic(third, 10, reviewBound), window(third, 10), { record: true });
    expect(shifted.change).toMatchObject({ shifted: true, from: 'TEST', to: 'INTEGRATION_WAIT' });
    found = await throughputDeficiencies();
    expect(found[0]!.diagnosis.title).toBe('Engineering throughput is limited by the INTEGRATION_WAIT stage');
    expect(await storedCycles()).toHaveLength(3);

    // §87 judges a correction on the stored cycles: before (TEST-bound, 70 min) and after (review-bound, 115 min).
    const before = await readMetric('ENGINEERING_CYCLE_HOURS_MEDIAN', iso(T0), iso(T0 + 25 * 60 * MIN));
    const after = await readMetric('ENGINEERING_CYCLE_HOURS_MEDIAN', iso(third), iso(third + 25 * 60 * MIN));
    expect(before.status).toBe('MEASURED');
    expect(before.value).toBeCloseTo(70 / 60, 2);
    expect(after.value).toBeCloseTo(115 / 60, 2);
    const { compare } = await import('../server/domain/improvement.ts');
    expect(compare(before, after).verdict).toBe('REGRESSED');
  });
});
