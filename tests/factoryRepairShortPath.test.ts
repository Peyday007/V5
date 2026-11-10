/**
 * A reviewer's short path resolves to the file that exists when a glob could
 * compose more than one reading (production 2026-11-10, causal-model-d0-p1:
 * "goals/portfolio.ts" read as both server/services/goals/portfolio.ts and
 * server/services/quant/goals/portfolio.ts, so no repair was ever created).
 */
import { describe, expect, it } from 'vitest';
import { resolveRepairScope } from '../server/services/factory/ownership.ts';

describe('a short path in a finding', () => {
  it('resolves to the one candidate that exists, and is anchored when a person granted that file', () => {
    const scope = resolveRepairScope({
      suggested: ['goals/portfolio.ts'],
      statement: 'goals/portfolio.ts must consume the causal graph',
      evidence: '',
      category: 'BEHAVIOR',
      mutationScope: ['server/routes/**', 'server/services/goals/**', 'server/services/goals/portfolio.ts', 'server/services/quant/**', 'tests/program-x-causal*.test.ts'],
      forbiddenPaths: [],
      units: [{ unitKey: 'u1', ownedPaths: ['server/services/quant/**'] }],
    });
    expect(scope.ok).toBe(true);
    if (scope.ok) expect(scope.evidenceFiles).toContain('server/services/goals/portfolio.ts');
  });
});
