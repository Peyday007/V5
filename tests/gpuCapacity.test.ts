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
import { gpuThroughput, hoursToClear, runningByDay, servingAt, shrinkCauses, summarizeGpuJobs, type LaneJobRow } from '../server/services/cheap/gpuCapacity.ts';

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
    expect(s.gpu).toEqual({ submitted: 1, notAccepted: 1, ms: 120_000, inferred: 0 });
    expect(s.slotFallback).toEqual({ submitted: 1, notAccepted: 1, ms: 120_000, inferred: 0 });
    expect(s.byDay.get('2026-11-19')?.gpu.submitted).toBe(1);
    expect(s.byDay.get('2026-11-23')?.gpu.submitted).toBe(0);
    expect(s.byDay.get('2026-11-23')?.slotFallback.submitted).toBe(1);
  });
});

/*
 * Production 2026-11-24: runpod-report 45346060299 printed 126.5 h of the H200
 * pod eaboawshas41wq running (11-10 to 11-19, $135.10) and "GPU answered:
 * submitted 0" on every day. dispatch-diagnose 45348622625 (`gpu-answers`):
 * no GPU-slot row before 2026-11-20T21:13:15Z carries `servedBy` (#1191 began
 * recording it then), so every job the GPU answered was read as the fallback's.
 * The rows below are those rows' real shapes.
 */
describe('rows from before servedBy was recorded', () => {
  const POD = 'eaboawshas41wq';
  const sample = (at: string, outcome: string, ready: boolean) => ({ at, outcome, durationMs: 300_000, costPerHr: outcome === 'SAMPLE_RUNNING' ? 5.29 : 0, ready, podId: POD });
  const samples = [
    sample('2026-11-17T10:00:00.000Z', 'SAMPLE_RUNNING', true),
    sample('2026-11-17T10:05:00.000Z', 'SAMPLE_RUNNING', true),
    sample('2026-11-17T10:10:00.000Z', 'SAMPLE_RUNNING', false), // vLLM loading after a restart
    sample('2026-11-19T19:50:00.000Z', 'SAMPLE_EXITED', false),
    sample('2026-11-21T10:00:00.000Z', 'SAMPLE_EXITED', false),
  ];
  const usage = { modelCalls: 3, modelCallsAvoided: 0, cpuMicros: 41_000, peakRssBytes: 0, rssShareBytes: 0, dbCalls: 12, dbMs: 80, networkBytesOut: 9000, networkBytesIn: 4000 };
  const legacy = (at: string, outcome: string): LaneJobRow => ({ at, outcome, slot: GPU, durationMs: 72_000, measures: JSON.stringify({ usage }) });

  it('attributes a GPU-slot row with no servedBy to the GPU while the pod was serving', () => {
    const s = summarizeGpuJobs(
      [
        legacy('2026-11-17T10:02:11.000Z', 'SUBMITTED'),
        legacy('2026-11-17T10:07:40.000Z', 'FAILED_RETRYABLE'),
        // vLLM not ready: the fallback answered.
        legacy('2026-11-17T10:11:00.000Z', 'SUBMITTED'),
        // Pod exited, servedBy not yet recorded.
        legacy('2026-11-20T08:00:00.000Z', 'SUBMITTED'),
        // After servedBy was recorded: its absence is no inference.
        { at: '2026-11-21T10:01:00.000Z', outcome: 'RELEASED_TRANSIENT', slot: GPU, durationMs: 5000, measures: JSON.stringify({ usage }) },
        { at: '2026-11-21T10:02:00.000Z', outcome: 'SUBMITTED', slot: GPU, durationMs: 208_000, measures: JSON.stringify({ usage, servedBy: ['auto/best-coding'] }) },
      ],
      servingAt(samples),
    );
    expect(s.gpu).toEqual({ submitted: 1, notAccepted: 1, ms: 144_000, inferred: 2 });
    expect(s.slotFallback.submitted).toBe(3);
    expect(s.slotFallback.notAccepted).toBe(1);
    expect(s.slotFallback.inferred).toBe(2);
    expect(s.byDay.get('2026-11-17')?.gpu.submitted).toBe(1);
    expect(s.byDay.get('2026-11-21')?.gpu.submitted).toBe(0);
  });

  it('serves only within two sample periods of a ready RUNNING sample', () => {
    const serving = servingAt(samples);
    expect(serving('2026-11-17T09:59:59.000Z')).toBe(false);
    expect(serving('2026-11-17T10:00:00.000Z')).toBe(true);
    expect(serving('2026-11-17T10:09:59.000Z')).toBe(true);
    expect(serving('2026-11-17T10:10:01.000Z')).toBe(false);
    expect(serving('2026-11-19T20:00:00.000Z')).toBe(false);
    expect(servingAt([sample('2026-11-17T10:00:00.000Z', 'SAMPLE_RUNNING', true)])('2026-11-17T10:10:01.000Z')).toBe(false);
  });

  it('without the pod samples, reads them as before (the fallback)', () => {
    const s = summarizeGpuJobs([legacy('2026-11-17T10:02:11.000Z', 'SUBMITTED')]);
    expect(s.gpu.submitted).toBe(0);
    expect(s.slotFallback).toEqual({ submitted: 1, notAccepted: 0, ms: 72_000, inferred: 1 });
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
