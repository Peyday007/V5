/**
 * CAP-16-3, repair F1: the hourly `FREE_LANE_STAGE_CAPACITY` row is read back.
 * A reviewer found it written and never read — the per-stage figures, the
 * diagnosed failing route and `chooseConstraint`'s recommendation reached
 * nobody except through a hand-written query (CLAUDE.md §2). These tests hold
 * the readers to the recorded row: `readStageCapacity`, the lines `admin
 * free-lane show` gets through `freeLaneReading`, the cause a coverage refusal
 * carries, and the report CLI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import {
  readStageCapacity,
  recordedCause,
  recordStageCapacity,
  STAGE_CAPACITY_EVENT,
  STAGE_CAPACITY_STALE_MS,
  stageCapacityLines,
  STAGES,
} from '../server/services/freeLane/stageCapacity.ts';
import { freeLaneReading } from '../server/services/freeLane/coverage.ts';
import { stageCapacityReport } from '../server/services/freeLane/stageCapacityReport.ts';

const GPU = 'runpod/Qwen/Qwen3-4B';
const FREE = 'brain-a';
const t = (minutes: number) => new Date(Date.UTC(2026, 10, 9, 1, 0, 0) + minutes * 60_000).toISOString();

async function at(iso: string, input: Parameters<typeof recordBinEvent>[0]): Promise<void> {
  await recordBinEvent(input);
  await getDb().run('UPDATE bin_events SET at = ? WHERE id = (SELECT id FROM bin_events ORDER BY rowid DESC LIMIT 1)', [iso]);
}
const item = (iso: string, outcome: string, reason: string) =>
  at(iso, { eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_VERIFY', outcome, reason, durationMs: 1000 });

/** A failing GPU route, recorded as the lane's hourly loop records it, dated t(30). */
async function recordFailingReading(): Promise<void> {
  for (let m = 0; m < 30; m += 5) {
    await at(t(m), { eventType: 'RUNPOD_POD', provider: 'runpod', outcome: 'SAMPLE_UNKNOWN', reason: 'sample' });
  }
  for (let m = 1; m <= 6; m += 1) await item(t(m), 'RELEASED_TRANSIENT', `model ${GPU}: model call failed: cheap lane HTTP 404`);
  await item(t(9), 'SUBMITTED', `model ${FREE}`);
  await recordStageCapacity({ hours: 1, now: Date.parse(t(30)) });
  await getDb().run('UPDATE bin_events SET at = ? WHERE event_type = ?', [t(30), STAGE_CAPACITY_EVENT]);
}

describe('the recorded stage-capacity reading is read back (stageCapacity.ts, coverage.ts)', () => {
  beforeEach(async () => {
    await freshProject();
  });
  afterEach(async () => {
    await teardown();
  });

  it('says nothing is recorded rather than inventing a reading', async () => {
    expect(await readStageCapacity()).toBeNull();
    expect(stageCapacityLines(null)[0]).toContain('not recorded yet');
    expect(recordedCause(null)).toBeNull();
  });

  it('reads the latest row: per-stage figures, the failing route, the queue verdict and the recommendation', async () => {
    await recordFailingReading();
    const recorded = await readStageCapacity(Date.parse(t(31)));
    expect(recorded).not.toBeNull();
    expect(recorded!.outcome).toBe('MEASURED');
    expect(recorded!.stale).toBe(false);
    expect(recorded!.ageMinutes).toBe(1);
    expect(recorded!.report!.diagnosis.primary).toMatchObject({ route: GPU, cause: 'broken GPU' });
    expect(recorded!.queueAdvance!.verdict).toBe('FIRST_READING');

    const lines = stageCapacityLines(recorded).join('\n');
    expect(lines).toContain(`failing route   ${GPU}: broken GPU, 6 failure(s)`);
    expect(lines).toContain('queued work     FIRST_READING');
    expect(lines).toContain(`recommendation  Restore model route ${GPU} first`);
    expect(lines).toContain('Do not enlarge the web process');
    for (const stage of STAGES) expect(lines).toContain(`stage ${stage.id} `);
    expect(lines).toContain('attribution');

    expect(recordedCause(recorded)).toContain(`model route ${GPU} failing (broken GPU, 6 failure(s))`);
  });

  it('marks a reading older than two intervals stale, and a stale cause is not carried as a current signal', async () => {
    await recordFailingReading();
    const recorded = await readStageCapacity(Date.parse(t(30)) + STAGE_CAPACITY_STALE_MS + 60_000);
    expect(recorded!.stale).toBe(true);
    expect(stageCapacityLines(recorded)[0]).toContain('STALE');
    expect(recordedCause(recorded)).toBeNull();
  });

  it('reads a failed measurement as NOT_MEASURED with its reason', async () => {
    await recordBinEvent({ eventType: STAGE_CAPACITY_EVENT, outcome: 'NOT_MEASURED', reason: 'stage capacity measurement failed: boom' });
    const recorded = await readStageCapacity();
    expect(recorded).toMatchObject({ outcome: 'NOT_MEASURED', report: null });
    expect(stageCapacityLines(recorded).join('\n')).toContain('measurement failed: boom');
  });

  it('reaches admin free-lane show through freeLaneReading, and the report CLI prints the same row', async () => {
    await recordFailingReading();
    const reading = await freeLaneReading();
    expect(reading.stageCapacity!.at).toBe(t(30));
    expect(reading.stageCapacityLines.join('\n')).toContain(`failing route   ${GPU}`);

    expect(await stageCapacityReport([])).toContain(`failing route   ${GPU}`);
    const json = JSON.parse(await stageCapacityReport(['--json'])) as { at: string; report: { constrained: { recommendation: string } } };
    expect(json.at).toBe(t(30));
    expect(json.report.constrained.recommendation).toContain('Restore');
  });
});
