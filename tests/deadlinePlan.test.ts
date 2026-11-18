/**
 * Deadline intelligence (§113), tested on the arithmetic and on a replay of the
 * deadline it was built from: the GPU-readiness mission of 2026-11-17, accepted
 * at 17:21Z for 19:00Z and still not ready after three verification cycles.
 *
 * The durations below are not invented. DEPLOY and CI are every completed
 * `deploy.yml` and `postgres-suite.yml` run on Peyday007/V5 from 2026-11-15 to
 * 2026-11-18 (GitHub's created_at → updated_at, minutes, successes and failures
 * separately). MODEL_LOAD and GPU_VERIFY are the three capped windows of
 * 2026-11-17/18 (launch → served, served → stop) on 04b754ce, 08cba93f and
 * 0ba2eb30.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assessDeadline,
  estimateKind,
  outcomesOf,
  reforecast,
  samplesFromOutcomes,
  schedule,
  staffing,
  type DurationSample,
  type PlanTask,
} from '../server/domain/deadlinePlan.ts';
import { freshProject } from './helpers.ts';
import { findTool } from '../server/mcp/tools.ts';
import { durationSamples, recurringCauses, deadlineReviews } from '../server/repos/deadlines.ts';
import type { Principal } from '../server/domain/types.ts';

const DEPLOY_OK = [34, 32, 29, 44, 9, 59, 32, 51, 6, 6, 40, 48, 30, 32, 24, 32, 50, 4, 3, 14, 30, 10, 3, 3, 12, 27, 38, 6, 4, 32, 39, 36, 15, 4, 38, 12, 55, 4, 4, 16, 18, 18, 8, 3, 36, 15, 65, 28, 32, 51, 5, 0, 36, 17, 43, 79, 6, 31, 26, 47, 5, 3, 32, 45, 53, 37, 5, 45, 37, 34, 30, 32, 32];
const DEPLOY_FAILED = [33, 26, 30, 46, 22, 23, 25, 26, 24, 21, 31, 27, 23, 25, 24];
const CI_OK = [22, 19, 36, 26, 51, 30, 22, 41, 26, 30, 50, 27, 23, 23, 22, 41, 21, 25, 26, 62, 26, 18, 32, 23, 20, 22, 40, 21, 28, 25, 29, 21, 39, 36, 21, 26, 24, 29, 20, 23, 42, 26, 25, 21, 33, 49, 42, 26, 22, 22, 19, 22, 16, 38, 24];
const CI_FAILED = [25, 30, 22, 32, 38, 16, 25, 23, 23, 29];

const measured = (kind: string, ok: number[], failed: number[], source: string): DurationSample[] => [
  ...ok.map((minutes) => ({ kind, minutes, failed: false, source })),
  ...failed.map((minutes) => ({ kind, minutes, failed: true, source })),
];

const HISTORY: DurationSample[] = [
  ...measured('DEPLOY', DEPLOY_OK, DEPLOY_FAILED, 'deploy.yml'),
  ...measured('CI', CI_OK, CI_FAILED, 'postgres-suite.yml'),
  ...measured('MODEL_LOAD', [12, 12, 17], [], 'cheap-lane runpod-launch'),
  ...measured('GPU_VERIFY', [47, 54, 45], [], 'cheap-lane runpod-report/stop'),
];

describe('estimates come from measured history', () => {
  it('budgets p80 of successes times the attempts the failure rate implies', () => {
    const deploy = estimateKind('DEPLOY', HISTORY);
    expect(deploy.measured).toBe(true);
    expect(deploy.samples).toBe(88);
    expect(deploy.failureRate).toBeCloseTo(0.17, 2);
    // p80 of the 73 successes, ×1.2 for one failure in six.
    expect(deploy.p80Min).toBe(40);
    expect(deploy.plannedMin).toBeGreaterThan(deploy.p80Min);
    expect(deploy.basis).toMatch(/^MEASURED: 73 successful of 88 DEPLOY/);
  });

  it('flags an unmeasured kind and costs it pessimistically instead of passing a guess off as history', () => {
    const e = estimateKind('DIAGNOSE', HISTORY);
    expect(e.measured).toBe(false);
    expect(e.plannedMin).toBe(45);
    expect(e.basis).toMatch(/^UNMEASURED/);
  });

  it('widens a kind with fewer than five samples', () => {
    const gpu = estimateKind('GPU_VERIFY', HISTORY);
    expect(gpu.p80Min).toBeGreaterThanOrEqual(gpu.p50Min * 1.5);
    expect(gpu.basis).toMatch(/few samples, widened/);
  });
});

describe('work is not elapsed time, and staffing follows the work', () => {
  const sixteen: PlanTask[] = Array.from({ length: 16 }, (_, i) => ({ id: `T${i + 1}`, kind: 'UNIT', estimateMin: 60 }));
  const hour = () => 60;

  it('sixteen independent one-hour tasks in eight hours need at least two workers', () => {
    const s = staffing(sixteen, 8 * 60, 8, hour);
    expect(s.minimumWorkers).toBe(2);
    expect(schedule(sixteen, 2, hour)).toMatchObject({ workMin: 960, elapsedMin: 480 });
  });

  it('commits four when four finish sooner and four are authorized', () => {
    const a = assessDeadline({
      tasks: sixteen,
      samples: measured('UNIT', Array(10).fill(60), [], 'test'),
      now: '2026-11-18T00:00:00Z',
      deadline: '2026-11-18T08:00:00Z',
      availableWorkers: 4,
      maxWorkers: 4,
    });
    expect(a.verdict).toBe('FEASIBLE');
    expect(a.staffing.minimumWorkers).toBe(2);
    expect(a.commitWorkers).toBe(4);
    expect(a.plan.elapsedMin).toBe(240);
    expect(a.plan.workMin).toBe(960);
  });

  it('preserves dependencies: a chain is not shortened by workers', () => {
    const chain: PlanTask[] = [
      { id: 'A', kind: 'X', estimateMin: 30 },
      { id: 'B', kind: 'X', estimateMin: 30, deps: ['A'] },
      { id: 'C', kind: 'X', estimateMin: 30, deps: ['B'] },
    ];
    const s = staffing(chain, 60, 5, () => 30);
    expect(s.minimumWorkers).toBeNull();
    expect(s.usefulWorkers).toBe(1);
    expect(schedule(chain, 5, () => 30).criticalPath).toEqual(['A', 'B', 'C']);
  });

  it('an exclusive resource serializes the tasks that share it, whatever the worker count', () => {
    const deploys: PlanTask[] = [
      { id: 'D1', kind: 'DEPLOY', resource: 'DEPLOY_PIPELINE' },
      { id: 'D2', kind: 'DEPLOY', resource: 'DEPLOY_PIPELINE' },
    ];
    const s = schedule(deploys, 4, () => 30);
    expect(s.elapsedMin).toBe(60);
    const [a, b] = s.tasks;
    expect(a!.endMin <= b!.startMin || b!.endMin <= a!.startMin).toBe(true);
  });
});

/*
 * The mission as it was actually run on 2026-11-17: four blockers diagnosed one
 * after another, the fixes coded, the Postgres gate, a deploy, a paid GPU
 * window to find out — then the next hidden failure. Two sessions.
 */
const AS_RUN: PlanTask[] = [
  { id: 'diag-B1', kind: 'DIAGNOSE', acceptance: true },
  { id: 'diag-B2', kind: 'DIAGNOSE', deps: ['diag-B1'] },
  { id: 'diag-B3', kind: 'DIAGNOSE', deps: ['diag-B2'] },
  { id: 'fix', kind: 'CODE', estimateMin: 45, deps: ['diag-B3'] },
  { id: 'ci', kind: 'CI', deps: ['fix'] },
  { id: 'deploy', kind: 'DEPLOY', deps: ['ci'] },
  { id: 'load', kind: 'MODEL_LOAD', deps: ['deploy'] },
  { id: 'gpu', kind: 'GPU_VERIFY', deps: ['load'], acceptance: true },
];

describe('replay: the GPU-readiness deadline of 2026-11-17', () => {
  const accepted = { now: '2026-11-17T17:21:00Z', deadline: '2026-11-17T19:00:00Z', availableWorkers: 2, maxWorkers: 2 };

  it('escalates at acceptance, with the limiting chain and the earliest completion, instead of at 19:00', () => {
    const a = assessDeadline({ tasks: AS_RUN, samples: HISTORY, ...accepted });
    expect(a.windowMin).toBe(99);
    expect(a.verdict).toBe('INFEASIBLE');
    // One verification cycle alone is two to two and a half hours — the owner's own measurement.
    expect(a.plan.elapsedMin).toBeGreaterThan(120);
    expect(a.plan.criticalPath).toEqual(['diag-B1', 'diag-B2', 'diag-B3', 'fix', 'ci', 'deploy', 'load', 'gpu']);
    expect(a.limiting).toMatch(/deploy \(DEPLOY/);
    expect(Date.parse(a.earliestAt)).toBeGreaterThan(Date.parse(accepted.deadline));
    expect(a.actions[0]).toMatch(/^escalate now, before work starts/);
    expect(a.alternatives.some((x) => /earliest evidence-supported completion/.test(x))).toBe(true);
  });

  it('names the failure patterns that cost the day', () => {
    const a = assessDeadline({ tasks: AS_RUN, samples: HISTORY, ...accepted });
    const h = a.hazards.join('\n');
    expect(h).toMatch(/gpu \(GPU_VERIFY\) runs before any cheap check/);
    expect(h).toMatch(/diagnosis is serialized/);
    expect(h).toMatch(/not on the DEPLOY_PIPELINE resource/);
    expect(h).toMatch(/unmeasured kind\(s\) DIAGNOSE/);
  });

  it('the corrected plan — parallel diagnosis, a free report before the paid window, one pipeline — is shorter and lint-clean on those patterns', () => {
    const fixed: PlanTask[] = [
      { id: 'diag-B1', kind: 'DIAGNOSE' },
      { id: 'diag-B2', kind: 'DIAGNOSE' },
      { id: 'diag-B3', kind: 'DIAGNOSE' },
      { id: 'fix', kind: 'CODE', estimateMin: 45, deps: ['diag-B1', 'diag-B2', 'diag-B3'] },
      { id: 'ci', kind: 'CI', deps: ['fix'] },
      { id: 'deploy', kind: 'DEPLOY', resource: 'DEPLOY_PIPELINE', deps: ['ci'] },
      { id: 'free-report', kind: 'REPORT', deps: ['deploy'] },
      { id: 'load', kind: 'MODEL_LOAD', resource: 'GPU', deps: ['free-report'] },
      { id: 'gpu', kind: 'GPU_VERIFY', resource: 'GPU', deps: ['load'], acceptance: true },
    ];
    const before = assessDeadline({ tasks: AS_RUN, samples: HISTORY, ...accepted, availableWorkers: 3, maxWorkers: 3 });
    const after = assessDeadline({ tasks: fixed, samples: HISTORY, ...accepted, availableWorkers: 3, maxWorkers: 3 });
    expect(after.plan.elapsedMin).toBeLessThan(before.plan.elapsedMin);
    const h = after.hazards.join('\n');
    expect(h).not.toMatch(/runs before any cheap check/);
    expect(h).not.toMatch(/diagnosis is serialized/);
    expect(h).not.toMatch(/DEPLOY_PIPELINE/);
    // Still honest: even the corrected cycle does not fit 99 minutes.
    expect(after.verdict).toBe('INFEASIBLE');
  });

  it('detects the slip mid-run and says what to do', () => {
    // 20:05Z: the deploy has run 110 min, past twice its planned duration.
    const running: PlanTask[] = AS_RUN.map((t) =>
      ['diag-B1', 'diag-B2', 'diag-B3', 'fix', 'ci'].includes(t.id)
        ? { ...t, status: 'DONE' as const }
        : t.id === 'deploy' ? { ...t, status: 'RUNNING' as const, startedAt: '2026-11-17T18:15:00Z' } : t,
    );
    const r = reforecast({ tasks: running, samples: HISTORY, now: '2026-11-17T20:05:00Z', deadline: '2026-11-17T21:30:00Z', availableWorkers: 2, maxWorkers: 4 });
    expect(r.slips).toEqual([expect.objectContaining({ id: 'deploy', state: 'STALLED', onCriticalPath: true })]);
    expect(r.actions.join('\n')).toMatch(/reassign deploy/);
    expect(r.remainingTasks).toBe(3);
  });
});

describe('every deadline teaches the next estimate', () => {
  it('a finished task becomes a sample, and an unmeasured kind becomes measured', () => {
    const done: PlanTask[] = [
      { id: 'd1', kind: 'DIAGNOSE', status: 'DONE', startedAt: '2026-11-17T17:30:00Z', finishedAt: '2026-11-17T18:40:00Z' },
      { id: 'd2', kind: 'DIAGNOSE', status: 'DONE', startedAt: '2026-11-17T18:40:00Z', finishedAt: '2026-11-17T19:35:00Z' },
    ];
    const outcomes = outcomesOf(done, HISTORY);
    expect(outcomes.map((o) => o.actualMin)).toEqual([70, 55]);
    expect(outcomes[0]!.ratio).toBeGreaterThan(1);
    const next = estimateKind('DIAGNOSE', [...HISTORY, ...samplesFromOutcomes(outcomes, 'deadline_record')]);
    expect(next.measured).toBe(true);
    expect(next.plannedMin).toBeGreaterThan(45);
  });
});

describe('the two connector tools against the real database', () => {
  const principal = { type: 'USER', id: 'usr_test', name: 'test' } as unknown as Principal;
  beforeEach(async () => {
    await freshProject();
  });

  it('records outcomes once, reviews once, and feeds both into the next plan', async () => {
    const record = findTool('brain_deadline_record')!;
    const plan = findTool('brain_deadline_plan')!;
    const args = {
      deadline_ref: 'readiness-2026-11-17',
      tasks: [
        { id: 'd1', kind: 'DIAGNOSE', status: 'DONE', started_at: '2026-11-17T17:30:00Z', finished_at: '2026-11-17T18:40:00Z' },
        { id: 'w1', kind: 'GPU_VERIFY', status: 'DONE', started_at: '2026-11-17T20:14:00Z', finished_at: '2026-11-17T21:01:00Z' },
      ],
      review: {
        deadline_at: '2026-11-17T19:00:00Z', met: false, forecast_at: '2026-11-17T19:00:00Z',
        causes: ['SEQUENTIAL_DIAGNOSIS', 'OVERLAPPING_DEPLOYS'], avoidable_wait_min: 40,
      },
    };
    const first = await record.run(args, { principal } as never);
    expect(first.value).toMatchObject({ recorded: 2, duplicates: 0, reviewRecorded: true });
    const again = await record.run(args, { principal } as never);
    expect(again.value).toMatchObject({ recorded: 0, duplicates: 2, reviewRecorded: false });
    await record.run({ ...args, deadline_ref: 'readiness-2026-11-18', review: { ...args.review, deadline_at: '2026-11-18T03:00:00Z' } }, { principal } as never);

    const samples = await durationSamples('2026-11-01T00:00:00Z');
    expect(samples.filter((s) => s.source === 'deadline_task_outcomes').map((s) => s.kind).sort()).toEqual(['DIAGNOSE', 'DIAGNOSE', 'GPU_VERIFY', 'GPU_VERIFY']);
    expect(recurringCauses(await deadlineReviews())).toEqual(
      expect.arrayContaining([{ cause: 'SEQUENTIAL_DIAGNOSIS', deadlines: 2, missed: 2 }]),
    );

    const out = await plan.run({
      deadline: '2026-11-18T12:00:00Z', now: '2026-11-18T10:00:00Z', available_workers: 1, max_workers: 3,
      tasks: [{ id: 'a', kind: 'DIAGNOSE' }, { id: 'b', kind: 'DIAGNOSE' }, { id: 'c', kind: 'CODE', deps: ['a', 'b'], estimate_min: 20 }],
    }, { principal } as never);
    const value = out.value as { assessment: { estimates: Array<{ kind: string; measured: boolean }>; hazards: string[]; commitWorkers: number } };
    expect(value.assessment.estimates.find((e) => e.kind === 'DIAGNOSE')?.measured).toBe(true);
    expect(value.assessment.hazards.join('\n')).toMatch(/recurring cause SEQUENTIAL_DIAGNOSIS: in 2 past deadline\(s\), 2 missed/);
    expect(value.assessment.commitWorkers).toBe(2);
  });

  it('refuses a plan with a cycle or an unknown dependency', async () => {
    const plan = findTool('brain_deadline_plan')!;
    await expect(plan.run({ deadline: '2026-11-18T12:00:00Z', tasks: [{ id: 'a', kind: 'X', deps: ['b'] }, { id: 'b', kind: 'X', deps: ['a'] }] }, { principal } as never)).rejects.toThrow(/dependency cycle/);
    await expect(plan.run({ deadline: '2026-11-18T12:00:00Z', tasks: [{ id: 'a', kind: 'X', deps: ['zz'] }] }, { principal } as never)).rejects.toThrow(/unknown task zz/);
  });
});
