import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { classifyAndRecord, classifyWork } from '../server/services/routing/classify/index.ts';
import type { ClassifyInput, WorkRequirements } from '../server/services/routing/types.ts';
import { listDecisions } from '../server/repos/workRouting.ts';

const base: WorkRequirements = {
  algorithmAvailable: false, activeDetectorId: null, structuredInput: false, needsTools: false,
  needsInternet: false, closedAnswerSet: false, verification: 'EVIDENCE_GATE',
};
const input = (r: Partial<WorkRequirements>, m: ClassifyInput['cheapMeasure'] = null): ClassifyInput => ({
  projectId: 'prj_a', workKind: 'TEST', requirements: { ...base, ...r }, cheapMeasure: m, cheapThreshold: 0.9,
});

describe('work classification', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('routes a parse/filter/dedupe/date unit to code and writes a ledger row', async () => {
    const choice = await classifyAndRecord(
      input({ algorithmAvailable: true, structuredInput: true, verification: 'CODE_CHECKABLE' }),
    );
    expect(choice.resource).toBe('CODE');
    const [row] = await listDecisions('prj_a');
    expect(row?.id).toBe(choice.decisionId);
    expect(row?.resource).toBe('CODE');
    expect(row?.reasons).toContain('ALGORITHM_AVAILABLE');
    expect(row?.alternatives.length).toBeGreaterThan(0);
  });

  it('completes a unit an ACTIVE detector covers as code, even when nothing else qualifies', () => {
    expect(classifyWork(input({ activeDetectorId: 'CONCENTRATED_HIRING' })).resource).toBe('CODE');
  });

  it('does not treat an algorithm over prose or the evidence gate as code', () => {
    expect(classifyWork(input({ algorithmAvailable: true, structuredInput: false })).resource).toBe('STRONG');
    expect(
      classifyWork(input({ algorithmAvailable: true, structuredInput: true, verification: 'EVIDENCE_GATE' })).resource,
    ).toBe('STRONG');
  });

  const closed = { closedAnswerSet: true, verification: 'CODE_CHECKABLE' as const };

  it('sends a closed classification to a free model only above the stored reliability', () => {
    expect(classifyWork(input(closed, { attempts: 40, successes: 38, consecutiveFailures: 0 })).resource).toBe('CHEAP');
    const below = classifyWork(input(closed, { attempts: 40, successes: 30, consecutiveFailures: 0 }));
    expect(below.resource).toBe('STRONG');
    expect(below.alternatives.join(' ')).toContain('below the stored');
  });

  it('never trusts an unmeasured free model, or one that keeps failing', () => {
    expect(classifyWork(input(closed, null)).resource).toBe('STRONG');
    expect(classifyWork(input(closed, { attempts: 5, successes: 5, consecutiveFailures: 0 })).resource).toBe('STRONG');
    expect(classifyWork(input(closed, { attempts: 100, successes: 99, consecutiveFailures: 3 })).resource).toBe('STRONG');
  });

  it('sends an unfamiliar problem with no method to the strong resource', () => {
    const choice = classifyWork(input({}, { attempts: 100, successes: 100, consecutiveFailures: 0 }));
    expect(choice.resource).toBe('STRONG');
    expect(choice.reasons).toEqual(['NO_CHEAPER_RESOURCE_QUALIFIES']);
  });
});
