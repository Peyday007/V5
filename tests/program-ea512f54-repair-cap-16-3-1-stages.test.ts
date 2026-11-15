/**
 * CAP-16-3 repair, episode 1 — the stage half of r01.cap-16-3. The probe
 * (`release01/capacityProbe.ts` `checkReading`) judges each hourly
 * FREE_LANE_STAGE_CAPACITY reading; this suite feeds it exactly what the writer
 * (`stageCapacity.ts` `recordStageCapacity`) records from seeded rows, so the
 * writer and the judge cannot drift apart.
 *
 * Defects this pins:
 *  - provider failures were one undifferentiated count, and counted a failure
 *    whose `[cause]` tag says Brain's own database was unavailable as the
 *    provider's; they are now split by cause and `database` is kept out of the
 *    provider's count, as `diagnoseThroughput` already reads it;
 *  - purposes, S-0170 categories and the productive total were three queries
 *    over a window left open at the top, so a job the lane submitted while the
 *    reading ran could be in one and not the others — the probe's "a job is
 *    unattributed or counted twice" failure. They are now one closed snapshot.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import {
  categoriesOf,
  purposesOf,
  recordStageCapacity,
  stageCapacity,
} from '../server/services/freeLane/stageCapacity.ts';
import { checkReading, REQUIRED_STAGES, STAGE_CAPACITY_EVENT } from '../server/services/factory/program/release01/capacityProbe.ts';

const iso = (ms: number): string => new Date(ms).toISOString();
let seq = 0;

async function laneEvent(input: { at: number; workload: string; outcome: string; reason: string; ms?: number; projectId?: string }): Promise<void> {
  seq += 1;
  await getDb().run(
    `INSERT INTO bin_events (id, event_type, at, project_id, duration_ms, measures, outcome, reason, is_proxy, workload_class)
     VALUES (?, 'FREE_LANE_ITEM', ?, ?, ?, '{}', ?, ?, 0, ?)`,
    [`bev_t${seq}`, iso(input.at), input.projectId ?? null, input.ms ?? 1000, input.outcome, input.reason, input.workload],
  );
}

describe('CAP-16-3 stage reading: what the writer records passes the probe', () => {
  let fixture: TestProject;

  beforeEach(async () => {
    fixture = await freshProject();
  });

  afterEach(async () => {
    await teardown();
  });

  async function seed(now: number): Promise<void> {
    // Queued, claimable work for both lane stages, so the oldest-item age must be real.
    await enqueueWork({ projectId: fixture.project.id, workType: 'RESEARCH_FRAGMENT', payload: {}, createdByType: 'SYSTEM', availableAt: iso(now - 40 * 60_000) });
    await enqueueWork({ projectId: fixture.project.id, workType: 'RESEARCH_VERIFY', payload: {}, createdByType: 'SYSTEM', availableAt: iso(now - 15 * 60_000) });
    const p = fixture.project.id;
    await laneEvent({ at: now - 50 * 60_000, workload: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', reason: 'model brain-a', projectId: p });
    await laneEvent({ at: now - 45 * 60_000, workload: 'RESEARCH_FRAGMENT', outcome: 'RELEASED_TRANSIENT', reason: 'model brain-a: model call failed [provider availability]: HTTP 503' });
    await laneEvent({ at: now - 44 * 60_000, workload: 'RESEARCH_FRAGMENT', outcome: 'RELEASED_TRANSIENT', reason: 'model brain-a: model call failed [provider availability]: HTTP 429' });
    await laneEvent({ at: now - 43 * 60_000, workload: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', reason: 'model runpod-qwen: model call failed [broken GPU]: runpod HTTP 404' });
    await laneEvent({ at: now - 42 * 60_000, workload: 'RESEARCH_FRAGMENT', outcome: 'RELEASED_TRANSIENT', reason: 'model brain-a: model call failed [database]: Brain unavailable' });
    await laneEvent({ at: now - 41 * 60_000, workload: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', reason: 'model brain-a: no JSON claims' });
    await laneEvent({ at: now - 30 * 60_000, workload: 'RESEARCH_VERIFY', outcome: 'SUBMITTED', reason: 'model brain-b', projectId: p });
    await laneEvent({ at: now - 29 * 60_000, workload: 'RESEARCH_VERIFY', outcome: 'RELEASED_TRANSIENT', reason: 'model brain-b: model call failed [credentials]: HTTP 401' });
    // After the reading's own time: must be in none of the counts.
    await laneEvent({ at: now + 60_000, workload: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', reason: 'model brain-a', projectId: p });
  }

  it('splits provider failures by their [cause] tag and keeps Brain-unavailable out of the provider count', async () => {
    const now = Date.now();
    await seed(now);
    const report = await stageCapacity({ hours: 2, now });
    const interp = report.stages.find((s) => s.stage === 'model-interpretation')!;
    const verif = report.stages.find((s) => s.stage === 'evidence-verification')!;
    expect(interp.providerFailuresByCause).toEqual({ 'provider availability': 2, 'broken GPU': 1, database: 1 });
    expect(interp.providerFailures).toEqual({ measured: true, value: 3 });
    // Only the no-JSON answer is dropped; no model-call failure is, whatever its cause.
    expect(interp.droppedOrDuplicate).toEqual({ measured: true, value: 1 });
    expect(interp.itemsProcessedPerHour).toEqual({ measured: true, value: 6 / 2 });
    expect(interp.queueSize).toEqual({ measured: true, value: 1 });
    expect(interp.oldestUsefulItemMinutes).toEqual({ measured: true, value: 40 });
    expect(interp.elapsedMs).toEqual({ measured: true, value: 6000 });
    expect(verif.providerFailuresByCause).toEqual({ credentials: 1 });
    expect(verif.providerFailures).toEqual({ measured: true, value: 1 });
    expect(verif.oldestUsefulItemMinutes).toEqual({ measured: true, value: 15 });
  });

  it('attributes purposes, categories and the total from one closed snapshot', async () => {
    const now = Date.now();
    await seed(now);
    const report = await stageCapacity({ hours: 2, now });
    // The SUBMITTED row written after `now` is outside the reading.
    expect(report.totalProductiveJobs).toBe(2);
    expect(report.purposes.reduce((s, p) => s + p.productiveJobs, 0)).toBe(2);
    expect(report.attribution.reduce((s, c) => s + c.productiveJobs, 0)).toBe(2);
    expect(report.purposesSumToTotal).toBe(true);
    expect(report.attributionSumsToTotal).toBe(true);
  });

  it('purposesOf and categoriesOf count each job exactly once', () => {
    const jobs = [
      { bin_purpose: 'PLAY_RESEARCH', brain_project: 0, validates_opening: 0, deal_round: 0, future_goal: 0, commercial: 1 },
      { bin_purpose: 'BRAIN_IMPROVEMENT', brain_project: 0, validates_opening: 1, deal_round: 1, future_goal: 1, commercial: 1 },
      { bin_purpose: null, brain_project: 0, validates_opening: 0, deal_round: 0, future_goal: 0, commercial: 0 },
    ];
    const purposes = purposesOf(jobs);
    expect(purposes.reduce((s, p) => s + p.productiveJobs, 0)).toBe(3);
    expect(purposes.map((p) => p.purpose).sort()).toEqual(['BRAIN_IMPROVEMENT', 'PLAY_RESEARCH', 'UNATTRIBUTED']);
    const categories = categoriesOf(jobs);
    expect(categories.reduce((s, c) => s + c.productiveJobs, 0)).toBe(3);
    expect(categories.find((c) => c.category === 'SELF_IMPROVEMENT')!.productiveJobs).toBe(1);
    expect(categories.find((c) => c.category === 'IMMEDIATE_COMMERCIAL_DISCOVERY')!.productiveJobs).toBe(1);
    expect(categories.find((c) => c.category === 'BROADER_WORLD_RESEARCH')!.productiveJobs).toBe(1);
  });

  it('the recorded reading passes capacityProbe.checkReading with no defect', async () => {
    const now = Date.now();
    await seed(now);
    const report = await recordStageCapacity({ hours: 2, now });
    expect(report).not.toBeNull();
    const row = await getDb().get<{ outcome: string; measures: string }>(
      'SELECT outcome, measures FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 1',
      [STAGE_CAPACITY_EVENT],
    );
    expect(row?.outcome).toBe('MEASURED');
    const measures = JSON.parse(row!.measures) as Record<string, unknown>;
    const check = checkReading(measures);
    expect(check.defect).toBeNull();
    expect(check.productiveJobs).toBe(2);
    // Every stage the probe requires is matched by exactly one stage of the reading.
    const stages = measures['stages'] as { stage: string; label: string }[];
    for (const required of REQUIRED_STAGES) {
      expect(stages.filter((s) => required.match.test(s.stage) || required.match.test(s.label)), required.key).toHaveLength(1);
    }
  });

  it('an empty database still yields a reading the probe accepts', async () => {
    const report = await recordStageCapacity({ hours: 6 });
    expect(report).not.toBeNull();
    const row = await getDb().get<{ measures: string }>(
      'SELECT measures FROM bin_events WHERE event_type = ? ORDER BY at DESC LIMIT 1',
      [STAGE_CAPACITY_EVENT],
    );
    expect(checkReading(JSON.parse(row!.measures) as Record<string, unknown>).defect).toBeNull();
  });
});
