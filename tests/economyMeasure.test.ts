import { describe, expect, it } from 'vitest';
import { measureGoal, measurementLines, type MeasureInput } from '../server/services/economy/measure/index.ts';

const base: MeasureInput = {
  goalId: 'wst_1', considered: 6, modelled: 2, excluded: 4, relevantOpenings: 1, supportedPlans: 0, needsMoreOpenings: false,
  readingTimes: [], orchestrations: [], passes: [], now: new Date('2026-10-30T12:00:00Z'),
};

describe('goal measurement', () => {
  it('counts screened, rejected and advanced from the reading', () => {
    const screen = measureGoal(base).stages[0]!;
    expect([screen.candidatesScreened, screen.candidatesRejected, screen.candidatesAdvanced]).toEqual([10, 4, 2]);
  });

  it('reports unmeasured figures as null and prints them as unknown, never zero', () => {
    const m = measureGoal(base);
    expect(m.stages[0]!.timeMs).toBeNull();
    expect(m.stages[4]!.researchJobs).toBeNull();
    const text = measurementLines(m).join('\n');
    expect(text).toContain('unknown');
    expect(text).not.toMatch(/execution\s+time 0/);
  });

  it('sums pass durations per stage and counts AI passes and jobs', () => {
    const m = measureGoal({
      ...base,
      orchestrations: [{ id: 'orc_1', status: 'COMPLETE', queuedAt: 'a', startedAt: 'a', endedAt: 'b' }],
      passes: [
        { passKey: 'TARGETED', status: 'COMPLETE', durationMs: 1000 },
        { passKey: 'VERIFICATION', status: 'COMPLETE', durationMs: 500 },
        { passKey: 'AUDIT', status: 'COMPLETE', durationMs: null },
      ],
    });
    expect(m.stages[1]).toMatchObject({ timeMs: 1500, researchJobs: 1, aiPasses: 2 });
    expect(m.stages[3]).toMatchObject({ timeMs: null, aiPasses: 1 });
  });

  it('names why work is slow and carries no time budget', () => {
    const m = measureGoal({
      ...base,
      needsMoreOpenings: true,
      orchestrations: [{ id: 'orc_q', status: 'QUEUED', queuedAt: '2026-10-30T06:00:00Z', startedAt: null, endedAt: null }],
    });
    expect(m.bottlenecks.join(' ')).toMatch(/queued and waiting/);
    expect(m.bottlenecks.join(' ')).toMatch(/more must be found/);
  });
});
