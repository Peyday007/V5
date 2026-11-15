/**
 * CAP-16-3 repair, episode 1, the stage half. `r01.cap-16-3` judges each hourly
 * `FREE_LANE_STAGE_CAPACITY` row with `capacityProbe.checkReading`, but only
 * once throughput passes, so a malformed reading would stay hidden until then.
 * These tests feed what the writer (`stageCapacity.ts`) actually records into
 * the judge, so writer and judge cannot drift: all six stages separated, every
 * measure present, the lane's stages measured in full with provider failures
 * split by cause, and purposes summing to the productive total.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { recordFeedPull } from '../server/repos/feeds.ts';
import { checkReading, REQUIRED_STAGES, STAGE_CAPACITY_EVENT as PROBE_EVENT, stageCapacityHoldsOnRows } from '../server/services/factory/program/release01/capacityProbe.ts';
import {
  readStageCapacity,
  recordStageCapacity,
  STAGE_CAPACITY_EVENT,
  STAGES,
  stageCapacity,
} from '../server/services/freeLane/stageCapacity.ts';
import { contractLine, stageCapacityReport } from '../server/services/freeLane/stageCapacityReport.ts';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const t = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

async function at(iso: string, input: Parameters<typeof recordBinEvent>[0]): Promise<void> {
  await recordBinEvent(input);
  await getDb().run('UPDATE bin_events SET at = ? WHERE id = (SELECT id FROM bin_events ORDER BY rowid DESC LIMIT 1)', [iso]);
}
const item = (iso: string, workloadClass: string, outcome: string, reason: string) =>
  at(iso, { eventType: 'FREE_LANE_ITEM', workloadClass, outcome, reason, durationMs: 1500 });

/** Production's shape on 2026-11-15: mostly provider failures, a few accepted, work waiting on both lane stages. */
async function seed(fixture: TestProject): Promise<void> {
  await item(t(50), 'RESEARCH_FRAGMENT', 'SUBMITTED', 'model brain-a');
  await item(t(45), 'RESEARCH_FRAGMENT', 'RELEASED_TRANSIENT', 'model brain-a: model call failed [provider availability]: cheap lane HTTP 429 retry-after 30s');
  await item(t(44), 'RESEARCH_FRAGMENT', 'RELEASED_TRANSIENT', 'model brain-a: model call failed [provider availability]: cheap lane HTTP 503');
  await item(t(40), 'RESEARCH_FRAGMENT', 'RELEASED_TRANSIENT', 'model brain-b: model call failed [credentials]: cheap lane HTTP 401');
  await item(t(35), 'RESEARCH_FRAGMENT', 'FAILED_RETRYABLE', 'model brain-a: no claim survived the gate');
  await item(t(30), 'RESEARCH_VERIFY', 'SUBMITTED', 'model brain-b');
  await item(t(25), 'RESEARCH_VERIFY', 'RELEASED_TRANSIENT', 'model runpod/Qwen/Qwen3-4B: model call failed [broken GPU]: cheap lane HTTP 429');
  // An older reason with no tag is classified from its text.
  await item(t(20), 'RESEARCH_VERIFY', 'RELEASED_TRANSIENT', 'model brain-a: model call failed: cheap lane HTTP 404');
  await enqueueWork({ projectId: fixture.project.id, workType: 'RESEARCH_FRAGMENT', availableAt: t(90), createdByType: 'SYSTEM' });
  await enqueueWork({ projectId: fixture.project.id, workType: 'RESEARCH_VERIFY', availableAt: t(15), createdByType: 'SYSTEM' });
  await recordFeedPull({ source: 'a', ok: true, fetched: 5, inserted: 3, error: null, at: t(10) });
}

describe('what the writer records passes the probe\'s own judge', () => {
  let fixture: TestProject;
  beforeEach(async () => {
    fixture = await freshProject();
  });
  afterEach(async () => {
    await teardown();
  });

  it('writer and probe agree on the event and each required stage is exactly one writer stage', () => {
    expect(STAGE_CAPACITY_EVENT).toBe(PROBE_EVENT);
    for (const required of REQUIRED_STAGES) {
      const matching = STAGES.filter((s) => required.match.test(s.id) || required.match.test(s.label));
      expect(matching.map((s) => s.id), required.label).toHaveLength(1);
    }
  });

  it('a reading from seeded rows, round-tripped through its bin_events row, has no defect', async () => {
    await seed(fixture);
    await recordStageCapacity({ hours: 1, now: NOW });
    const row = await getDb().get<{ outcome: string; measures: string }>(
      'SELECT outcome, measures FROM bin_events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1',
      [STAGE_CAPACITY_EVENT],
    );
    expect(row?.outcome).toBe('MEASURED');
    const measures = JSON.parse(row!.measures) as Record<string, unknown>;
    const check = checkReading(measures);
    expect(check.defect).toBeNull();
    expect(check.productiveJobs).toBe(2);
  });

  it('an empty database still produces a well-formed reading', async () => {
    const report = await stageCapacity({ hours: 1, now: NOW });
    expect(checkReading(JSON.parse(JSON.stringify(report)) as Record<string, unknown>).defect).toBeNull();
  });

  it('interpretation and verification carry real numbers for every LANE_REAL measure and failures by cause', async () => {
    await seed(fixture);
    const report = await stageCapacity({ hours: 1, now: NOW });
    const byId = Object.fromEntries(report.stages.map((s) => [s.stage, s]));
    const interp = byId['model-interpretation']!;
    const verify = byId['evidence-verification']!;
    for (const stage of [interp, verify]) {
      for (const key of ['queueSize', 'oldestUsefulItemMinutes', 'itemsProcessedPerHour', 'uniqueUsableFacts', 'droppedOrDuplicate', 'providerFailures', 'elapsedMs'] as const) {
        expect(stage[key].measured, `${stage.stage}.${key}`).toBe(true);
      }
    }
    expect(interp.queueSize).toEqual({ measured: true, value: 1 });
    expect(interp.oldestUsefulItemMinutes).toEqual({ measured: true, value: 90 });
    expect(interp.providerFailures).toEqual({ measured: true, value: 3 });
    expect(interp.providerFailuresByCause).toEqual({ 'provider availability': 2, credentials: 1 });
    expect(interp.droppedOrDuplicate).toEqual({ measured: true, value: 1 });
    expect(interp.elapsedMs).toEqual({ measured: true, value: 7500 });
    expect(verify.queueSize).toEqual({ measured: true, value: 1 });
    expect(verify.oldestUsefulItemMinutes).toEqual({ measured: true, value: 15 });
    expect(verify.providerFailures).toEqual({ measured: true, value: 2 });
    expect(verify.providerFailuresByCause).toEqual({ 'broken GPU': 1, 'task routing': 1 });
    // The causes sum to the failures they split.
    for (const stage of [interp, verify]) {
      const sum = Object.values(stage.providerFailuresByCause ?? {}).reduce((a, b) => a + (b ?? 0), 0);
      expect(sum).toBe(stage.providerFailures.measured ? stage.providerFailures.value : -1);
    }
    // Every stage has a real throughput.
    for (const stage of report.stages) expect(stage.itemsProcessedPerHour.measured, stage.stage).toBe(true);
  });

  it('purpose attribution sums to the productive total with no job counted twice', async () => {
    await seed(fixture);
    const report = await stageCapacity({ hours: 1, now: NOW });
    expect(report.totalProductiveJobs).toBe(2);
    expect(report.purposes.reduce((s, p) => s + p.productiveJobs, 0)).toBe(report.totalProductiveJobs);
    expect(report.purposesSumToTotal).toBe(true);
    expect(report.attribution.reduce((s, c) => s + c.productiveJobs, 0)).toBe(report.totalProductiveJobs);
    expect(report.attributionSumsToTotal).toBe(true);
  });

  it('two hourly readings from the writer make the probe pass', async () => {
    await seed(fixture);
    await recordStageCapacity({ hours: 1, now: NOW - 60 * 60_000 });
    await getDb().run('UPDATE bin_events SET at = ? WHERE event_type = ?', [t(60), STAGE_CAPACITY_EVENT]);
    await recordStageCapacity({ hours: 1, now: NOW });
    await getDb().run(
      'UPDATE bin_events SET at = ? WHERE id = (SELECT id FROM bin_events WHERE event_type = ? ORDER BY rowid DESC LIMIT 1)',
      [t(0), STAGE_CAPACITY_EVENT],
    );
    const verdict = await stageCapacityHoldsOnRows({ now: NOW });
    expect(verdict.detail).not.toMatch(/reading .* (does not|carries|records|reports|measures|stands|labels|attributes)/);
    expect(verdict.ok).toBe(true);
  });

  it('the report CLI prints the probe\'s verdict on the latest reading', async () => {
    await seed(fixture);
    await recordStageCapacity({ hours: 1, now: NOW });
    const recorded = await readStageCapacity(NOW);
    expect(contractLine(recorded)).toMatch(/probe contract {2}well-formed/);
    expect(contractLine(null)).toMatch(/no reading/);
    const text = await stageCapacityReport([]);
    expect(text).toMatch(/probe contract/);
    expect(text).toMatch(/provider availability 2, credentials 1/);
  });
});
