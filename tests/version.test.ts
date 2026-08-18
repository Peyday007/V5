import { describe, expect, it } from 'vitest';
import {
  branchToIndex,
  compareVersions,
  extractVersionToken,
  indexToBranch,
  maxVersion,
  nextExpansionVersion,
  normalizeVersion,
  parseVersion,
  sortVersions,
  synthesisSourceVersions,
  synthesisVersion,
  waveForVersion,
} from '../server/domain/version.ts';
import { DEFAULT_VERSION_POLICY } from '../server/domain/types.ts';

describe('parseVersion', () => {
  it('parses the shapes the spec lists', () => {
    expect(parseVersion('v1')).toMatchObject({ major: 1, minor: 0, branch: '', branchIndex: 0, valid: true });
    expect(parseVersion('v1A')).toMatchObject({ major: 1, minor: 0, branch: 'A', branchIndex: 1 });
    expect(parseVersion('v1J')).toMatchObject({ major: 1, minor: 0, branch: 'J', branchIndex: 10 });
    expect(parseVersion('v2')).toMatchObject({ major: 2, minor: 0, branch: '' });
    expect(parseVersion('v3.1')).toMatchObject({ major: 3, minor: 1, branch: '' });
    expect(parseVersion('v3.1B')).toMatchObject({ major: 3, minor: 1, branch: 'B', branchIndex: 2 });
  });

  it('normalises case and a missing v prefix', () => {
    expect(normalizeVersion('V1g')).toBe('v1G');
    expect(normalizeVersion('1')).toBe('v1');
    expect(normalizeVersion(' v3.1a ')).toBe('v3.1A');
  });

  it('marks nonsense invalid without throwing', () => {
    expect(parseVersion('draft-final').valid).toBe(false);
    expect(parseVersion('').valid).toBe(false);
    expect(parseVersion(null).valid).toBe(false);
  });
});

describe('branch index round trip', () => {
  it('is bijective base-26', () => {
    expect(branchToIndex('')).toBe(0);
    expect(branchToIndex('A')).toBe(1);
    expect(branchToIndex('Z')).toBe(26);
    expect(branchToIndex('AA')).toBe(27);
    for (const i of [0, 1, 5, 26, 27, 52, 53, 703]) {
      expect(branchToIndex(indexToBranch(i))).toBe(i);
    }
  });
});

describe('ordering', () => {
  it('does NOT sort lexicographically', () => {
    // The whole reason the engine exists: "v1J" > "v2" as plain strings.
    const lexicographic = ['v1J', 'v2'].sort();
    expect(lexicographic).toEqual(['v1J', 'v2']);
    expect(compareVersions('v1J', 'v2')).toBeLessThan(0);
  });

  it('orders a full Deal Dispatch ladder correctly', () => {
    const shuffled = ['v3.1B', 'v1', 'v1J', 'v2', 'v1B', 'v3.1', 'v1A', 'v3.1A'];
    expect(sortVersions(shuffled)).toEqual(['v1', 'v1A', 'v1B', 'v1J', 'v2', 'v3.1', 'v3.1A', 'v3.1B']);
    expect(maxVersion(shuffled)).toBe('v3.1B');
  });

  it('treats v1 as earlier than v1A', () => {
    expect(compareVersions('v1', 'v1A')).toBeLessThan(0);
  });
});

describe('waves', () => {
  it('maps foundation, expansions and synthesis to waves 1, 2 and 3', () => {
    expect(waveForVersion('v1')).toBe(1);
    expect(waveForVersion('v1B')).toBe(2);
    expect(waveForVersion('v1G')).toBe(2);
    expect(waveForVersion('v3.1')).toBe(3);
  });
});

describe('nextExpansionVersion', () => {
  it('starts sibling expansions at the policy branch', () => {
    // Deal Dispatch convention: v1 foundation, then v1B, v1C, ...
    expect(nextExpansionVersion(['v1'])).toBe('v1B');
  });

  it('continues from the highest existing branch', () => {
    expect(nextExpansionVersion(['v1', 'v1B', 'v1C'])).toBe('v1D');
    expect(nextExpansionVersion(['v1', 'v1A', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F'])).toBe('v1G');
  });

  it('respects a policy that starts expansions at A', () => {
    const policy = { ...DEFAULT_VERSION_POLICY, expansionStartBranch: 'A' };
    expect(nextExpansionVersion(['v1'], policy)).toBe('v1A');
  });

  it('ignores versions outside the foundation family', () => {
    expect(nextExpansionVersion(['v1', 'v1B', 'v3.1'])).toBe('v1C');
  });
});

describe('synthesis', () => {
  it('never invents a version beyond the policy', () => {
    expect(synthesisVersion()).toBe('v3.1');
    // Even once v3.1 exists, the policy version is unchanged — no automatic v3.2.
    expect(synthesisVersion(DEFAULT_VERSION_POLICY)).toBe('v3.1');
  });

  it('collects the whole source packet, excluding the synthesis itself', () => {
    const versions = ['v1', 'v1A', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G', 'v3.1'];
    expect(synthesisSourceVersions(versions)).toEqual([
      'v1', 'v1A', 'v1B', 'v1C', 'v1D', 'v1E', 'v1F', 'v1G',
    ]);
  });
});

describe('extractVersionToken', () => {
  it('pulls the version out of real filenames', () => {
    expect(extractVersionToken('Decision Routing Rules v1F.pdf')).toBe('v1F');
    expect(extractVersionToken('Discovery Logic v1G.pdf')).toBe('v1G');
    expect(extractVersionToken('Qualification Logic v3.1.pdf')).toBe('v3.1');
    expect(extractVersionToken('World_Model_v1.pdf')).toBe('v1');
    expect(extractVersionToken('monetization-logic-v1c.pdf')).toBe('v1C');
  });

  it('returns null when there is no version', () => {
    expect(extractVersionToken('Notes.pdf')).toBeNull();
    expect(extractVersionToken('overview.pdf')).toBeNull();
  });
});
