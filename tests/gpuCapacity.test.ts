/**
 * The GPU's capacity reading (`cheap/gpuCapacity.ts`, runpod-report's `GPU
 * CAPACITY`): GPU work is what the GPU answered (`servedBy`), not what its slot
 * was labelled, and throughput is per hour the pod actually ran.
 *
 * Production 2026-11-23 (cheap-lane run 45260588741): the report counted 44 jobs
 * "submitted on runpod/openai/gpt-oss-120b" and priced $31.09 of GPU time over
 * their span while the pod had been EXITED since 11-19 19:49Z; every call was
 * answered by the free fallback.
 */
import { describe, expect, it } from 'vitest';
import { answeredBy, servedByGpu } from '../server/services/cheap/runpod.ts';
import { gpuThroughput, hoursToClear, runningByDay, shrinkCauses, summarizeGpuJobs, type LaneJobRow } from '../server/services/cheap/gpuCapacity.ts';

const GPU = 'runpod/openai/gpt-oss-120b';

describe('servedByGpu', () => {
  it('is true only when the GPU itself answered one of the calls', () => {
    expect(servedByGpu(JSON.stringify({ usage: {}, servedBy: [GPU] }))).toBe(true);
    expect(servedByGpu({ servedBy: ['auto/best-coding', GPU] })).toBe(true);
    // The GPU slot answered by its fallback: the row's reason names the slot, servedBy the fallback.
    expect(servedByGpu(JSON.stringify({ servedBy: ['auto/best-coding'] }))).toBe(false);
    expect(servedByGpu(JSON.stringify({ usage: {} }))).toBe(false);
    expect(servedByGpu('not json')).toBe(false);
    expect(servedByGpu(null)).toBe(false);
    // A row whose discovery text mentions the GPU is not GPU work.
    expect(servedByGpu(JSON.stringify({ servedBy: ['auto'], discovery: { note: `asked ${GPU}` } }))).toBe(false);
  });
});

describe('answeredBy and fitness attribution', () => {
  it('reads a GPU-slot row the fallback answered as the fallback', () => {
    expect(answeredBy(GPU, JSON.stringify({ servedBy: ['auto/best-coding'] }))).toBe('auto/best-coding');
    expect(answeredBy(GPU, { servedBy: ['auto/best-coding', GPU] })).toBe(GPU);
    expect(answeredBy(GPU, JSON.stringify({ usage: {} }))).toBe(GPU);
    expect(answeredBy('auto', JSON.stringify({ servedBy: ['other'] }))).toBe('auto');
  });

  it('does not hold the GPU back for answers its fallback gave (runpod-report 45320773844)', async () => {
    const { attributeAnswer, recentAnswers, unfitPairs } = await import('../server/services/freeLane/worker.ts');
    const fallbackFailure = {
      reason: `model ${GPU}: the model returned no usable JSON`,
      work_type: 'RESEARCH_PLAN',
      outcome: 'FAILED_RETRYABLE',
      measures: JSON.stringify({ servedBy: ['auto/best-coding'] }),
    };
    const rows = Array.from({ length: 12 }, () => fallbackFailure);
    // Read by slot (before): the GPU is held back from planning.
    expect(unfitPairs(recentAnswers(rows), [GPU, 'auto/best-coding']).has(`${GPU}|RESEARCH_PLAN`)).toBe(true);
    // Read by who answered: the hold is the fallback's, and the GPU is judged on its own answers.
    const attributed = rows.map(attributeAnswer);
    expect(attributed[0]!.reason).toBe('model auto/best-coding: the model returned no usable JSON');
    const unfit = unfitPairs(recentAnswers(attributed), [GPU, 'auto/best-coding']);
    expect(unfit.has(`${GPU}|RESEARCH_PLAN`)).toBe(false);
    expect(unfit.has('auto/best-coding|RESEARCH_PLAN')).toBe(true);
    // A row the GPU answered stays the GPU's.
    const own = { ...fallbackFailure, measures: JSON.stringify({ servedBy: [GPU] }) };
    expect(attributeAnswer(own)).toBe(own);
  });
});

describe('summarizeGpuJobs', () => {
  const row = (at: string, outcome: string, slot: string, servedBy: string[] | null, durationMs = 60_000): LaneJobRow => ({
    at,
    outcome,
    slot,
    durationMs,
    measures: JSON.stringify(servedBy ? { servedBy } : {}),
  });

  it('splits the GPU slot by who answered, and ignores other slots', () => {
    const s = summarizeGpuJobs([
      row('2026-11-19T08:10:00Z', 'SUBMITTED', GPU, [GPU]),
      row('2026-11-19T08:11:00Z', 'RELEASED_TRANSIENT', GPU, [GPU]),
      row('2026-11-23T15:00:00Z', 'SUBMITTED', GPU, ['auto/best-coding']),
      row('2026-11-23T15:01:00Z', 'RELEASED_TRANSIENT', GPU, ['auto/best-coding']),
      row('2026-11-23T15:02:00Z', 'SUBMITTED', 'auto', ['auto']),
    ]);
    expect(s.gpu).toEqual({ submitted: 1, notAccepted: 1, ms: 120_000 });
    expect(s.slotFallback).toEqual({ submitted: 1, notAccepted: 1, ms: 120_000 });
    expect(s.byDay.get('2026-11-19')?.gpu.submitted).toBe(1);
    expect(s.byDay.get('2026-11-23')?.gpu.submitted).toBe(0);
    expect(s.byDay.get('2026-11-23')?.slotFallback.submitted).toBe(1);
  });
});

describe('runningByDay and gpuThroughput', () => {
  it('prices only RUNNING samples and divides GPU work by the hours the pod ran', () => {
    const samples = [
      ...Array.from({ length: 12 }, (_, i) => ({ at: `2026-11-19T08:${String(i * 5).padStart(2, '0')}:00Z`, outcome: 'SAMPLE_RUNNING', durationMs: 300_000, costPerHr: 5.29 })),
      { at: '2026-11-23T15:00:00Z', outcome: 'SAMPLE_EXITED', durationMs: 300_000, costPerHr: 0 },
    ];
    const days = runningByDay(samples);
    expect(days.map((d) => d.day)).toEqual(['2026-11-19', '2026-11-23']);
    expect(days[0]!.runningHours).toBeCloseTo(1, 6);
    expect(days[0]!.dollars).toBeCloseTo(5.29, 6);
    expect(days[1]!.runningHours).toBe(0);
    expect(days[1]!.dollars).toBe(0);

    const jobs = summarizeGpuJobs(
      Array.from({ length: 40 }, (_, i) => ({
        at: '2026-11-19T08:30:00Z',
        outcome: i < 30 ? 'SUBMITTED' : 'RELEASED_TRANSIENT',
        slot: GPU,
        durationMs: 180_000,
        measures: { servedBy: [GPU] },
      })),
    );
    const t = gpuThroughput(jobs, days);
    expect(t.runningHours).toBe(1);
    expect(t.jobsPerRunningHour).toBe(40);
    expect(t.acceptedPerRunningHour).toBe(30);
    // 40 jobs x 3 min over 60 min running: two in flight on average.
    expect(t.meanInFlight).toBe(2);
    expect(t.acceptedShare).toBe(0.75);
    expect(t.dollarsPerAccepted).toBeCloseTo(0.18, 2);
  });

  it('says nothing about throughput when the pod never ran', () => {
    const t = gpuThroughput(summarizeGpuJobs([]), runningByDay([{ at: '2026-11-23T00:00:00Z', outcome: 'SAMPLE_EXITED', durationMs: 300_000, costPerHr: null }]));
    expect(t.jobsPerRunningHour).toBeNull();
    expect(t.meanInFlight).toBeNull();
    expect(hoursToClear(100, t.acceptedPerRunningHour)).toBeNull();
    expect(hoursToClear(150, 30)).toBe(5);
  });
});

describe('shrinkCauses', () => {
  it('groups the controller reasons by cause', () => {
    const causes = shrinkCauses([
      { outcome: 'SHRINK', reason: "12 -> 6: Brain CPU at 88%: the server's event loop busy 88% of the step (machine 48% of its cores)" },
      { outcome: 'SHRINK', reason: "12 -> 6: Brain CPU at 90%: the server's event loop busy 90% of the step (machine 50% of its cores)" },
      { outcome: 'SHRINK', reason: '6 -> 2: starting up: held at its starting size for the first minutes' },
      { outcome: 'GROW', reason: '6 -> 12: useful research waiting (40), errors acceptable; held to its share of the database pool (12 of 24 slots)' },
    ]);
    expect(causes.get('SHRINK Brain CPU over 85%')).toBe(2);
    expect(causes.get('SHRINK boot grace after a restart')).toBe(1);
    expect(causes.get('GROW held to its share of the database pool')).toBe(1);
  });
});
