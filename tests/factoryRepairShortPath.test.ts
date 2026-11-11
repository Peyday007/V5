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

  it('does not make the program record a repair\'s file: the units\' own files carry the repair', () => {
    const scope = resolveRepairScope({
      suggested: ['objectives/programs/brain-architecture/release-01.map.json'],
      statement: 'The probes r01.auth-20-3 are not implemented; the only references are in objectives/programs/brain-architecture/release-01.map.json',
      evidence: '',
      category: 'BEHAVIOR',
      mutationScope: ['server/services/cash/**', 'tests/program-x-auth*.test.ts'],
      forbiddenPaths: [],
      units: [{ unitKey: 'u1', ownedPaths: ['server/services/cash/authority.ts', 'tests/program-x-auth*.test.ts'] }],
    });
    expect(scope.ok).toBe(true);
    if (scope.ok) {
      expect(scope.derivedFrom).toBe('UNIT_OWNERSHIP');
      expect(scope.ownedPaths).toEqual(['server/services/cash/authority.ts', 'tests/program-x-auth*.test.ts']);
    }
  });

  it('reads a test\'s subject from the one source file a person granted when its unit owns several', () => {
    const input = {
      suggested: ['tests/program-x-acquisition-d01.test.ts'],
      statement: 'operate-unreachable: tests/program-x-acquisition-d01.test.ts shows the judge never reaches OPERATE',
      evidence: '',
      category: 'BEHAVIOR' as const,
      forbiddenPaths: [],
      units: [{ unitKey: 'u1', ownedPaths: ['server/services/sources/access.ts', 'server/services/sources/accessMethods.ts', 'server/services/sources/acquisition.ts', 'tests/program-x-acquisition-d01.test.ts'] }],
    };
    const before = resolveRepairScope({ ...input, mutationScope: ['server/services/sources/**', 'tests/program-x-acquisition*.test.ts'] });
    expect(before.ok).toBe(false);
    const after = resolveRepairScope({ ...input, mutationScope: ['server/services/sources/**', 'server/services/sources/acquisition.ts', 'tests/program-x-acquisition*.test.ts'] });
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.rootCauseFiles).toEqual(['server/services/sources/acquisition.ts']);
  });
});
