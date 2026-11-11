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

  it('resolves to the file a person granted exactly, whether or not it is on disk where the server runs', () => {
    const scope = resolveRepairScope({
      suggested: ['widgets/ledger.ts'],
      statement: 'widgets/ledger.ts must persist the graph',
      evidence: '',
      category: 'BEHAVIOR',
      mutationScope: ['server/routes/**', 'server/services/**', 'server/services/widgets/ledger.ts', 'tests/program-x-causal*.test.ts'],
      forbiddenPaths: [],
      units: [{ unitKey: 'u1', ownedPaths: ['server/services/quant/**'] }],
    });
    expect(scope.ok).toBe(true);
    if (scope.ok) expect(scope.evidenceFiles).toEqual(['server/services/widgets/ledger.ts']);
  });

  it('keeps a path that is already a file from the repository root', () => {
    const scope = resolveRepairScope({
      suggested: ['objectives/programs/brain-architecture/release-01.map.json'],
      statement: 'objectives/programs/brain-architecture/release-01.map.json maps AUTH-20-3 to the wrong file',
      evidence: '',
      category: 'BEHAVIOR',
      mutationScope: ['server/services/cash/**', 'tests/program-x-auth*.test.ts'],
      forbiddenPaths: [],
      units: [{ unitKey: 'u1', ownedPaths: ['server/services/cash/**'] }],
    });
    expect(scope.ok).toBe(false);
    if (!scope.ok && scope.reason === 'REQUIRED_FILE_NOT_WRITABLE') {
      expect(scope.outsideScope).toEqual(['objectives/programs/brain-architecture/release-01.map.json']);
    } else {
      throw new Error(`expected REQUIRED_FILE_NOT_WRITABLE, got ${JSON.stringify(scope)}`);
    }
  });
});
