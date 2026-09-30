import { describe, expect, it } from 'vitest';
import type { ResearchFragment } from '../server/domain/types.ts';
import {
  assignExecutionPriority,
  executionOrder,
  storedTier,
  tierOf,
  type TierInput,
} from '../server/services/research/quota.ts';

const brief = (fragmentKey: string, priority: number): TierInput => ({
  fragmentKey,
  dependsOn: [],
  requirementIds: ['R1'],
  expectedClaimTypes: [],
  requiredCalculations: [],
  contradictionTargets: [],
  evidenceLane: 'market',
  priority,
});

describe('stored execution priority', () => {
  it('keeps a necessity-1 brief mandatory after assignment', () => {
    const briefs = [brief('a', 1), brief('b', 5), brief('c', 8)];
    assignExecutionPriority(briefs);
    expect(briefs.map((b) => b.priority)).toEqual([5, 6, 7]);
    expect(storedTier(briefs[0]!, briefs).tier).toBe('MANDATORY_SYNTHESIS_INPUT');
    expect(storedTier(briefs[1]!, briefs).tier).toBe('SUPPORTING_CONTEXT');
    expect(storedTier(briefs[2]!, briefs).tier).toBe('OPTIONAL_ENRICHMENT');
    // The defect: reading the stored rank as necessity demotes the mandatory one.
    expect(tierOf(briefs[0]!, briefs).tier).toBe('SUPPORTING_CONTEXT');
  });

  it('is idempotent', () => {
    const briefs = [brief('a', 1), brief('b', 5), brief('c', 8)];
    assignExecutionPriority(briefs);
    const first = briefs.map((b) => b.priority);
    assignExecutionPriority(briefs);
    expect(briefs.map((b) => b.priority)).toEqual(first);
  });

  it('keeps structural overrides when reading a stored tier', () => {
    const boundary = { ...brief('x', 5), requirementIds: [] };
    const dependent = { ...brief('y', 5), dependsOn: [{ key: 'z', kind: 'HARD' }] } as unknown as TierInput;
    const all = [boundary, brief('z', 5), dependent];
    expect(storedTier(boundary, all).tier).toBe('BOUNDARY_AND_DEFINITION');
    expect(storedTier(all[1]!, all).tier).toBe('FOUNDATIONAL_EVIDENCE');
  });

  it('orders mandatory before supporting for stored fragments', () => {
    const briefs = [brief('sup', 5), brief('man', 1), brief('opt', 8)];
    assignExecutionPriority(briefs);
    const fragments = briefs.map((b, i) => ({
      ...b,
      id: `f${i}`,
      fragmentIndex: i,
      attempt: 1,
      estimatedEffort: 'MEDIUM',
    })) as unknown as ResearchFragment[];
    expect(executionOrder(fragments, fragments).map((f) => f.fragmentKey)).toEqual(['man', 'sup', 'opt']);
  });
});
