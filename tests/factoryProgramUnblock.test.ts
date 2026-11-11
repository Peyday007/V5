import { describe, expect, it } from 'vitest';
import { grantable, pathsNamedIn, resolveShortPaths, widenScope } from '../server/services/factory/program/unblock.ts';

describe('widening a campaign scope', () => {
  it('widens files to their directory, keeps globs, and never reaches the program verification code', () => {
    expect(widenScope(['server/services/cash/funnel.ts', 'server/services/quant/mechanism.ts', 'client/src/world/**', 'tests/program-x-y*.test.ts']))
      .toEqual(['client/src/world/**', 'server/services/cash/**', 'server/services/cash/funnel.ts', 'server/services/quant/**', 'server/services/quant/mechanism.ts', 'tests/program-x-y*.test.ts']);
    expect(widenScope(['server/domain/factoryProgram.ts', 'server/services/factory/program/probes.ts', 'server/services/factory/release/outcome.ts']))
      .toEqual(['server/domain/factoryProgram.ts', 'server/services/factory/program/probes.ts', 'server/services/factory/release/**', 'server/services/factory/release/outcome.ts']);
  });

  it('never widens a file into a whole top-level directory', () => {
    expect(widenScope(['docs/FACTORY-PROGRAMS.md', 'docs/FACTORY-PROGRAMS-CHECKLIST.md', 'README.md', 'docs/programs/a/b.md']))
      .toEqual(['README.md', 'docs/FACTORY-PROGRAMS-CHECKLIST.md', 'docs/FACTORY-PROGRAMS.md', 'docs/programs/a/**', 'docs/programs/a/b.md']);
  });
});

describe('scope reconciliation reads paths and refuses what is not safe to grant', () => {
  it('reads repository paths out of a blocker or a unit failure', () => {
    expect(pathsNamedIn('The failing assertion is in tests/goalOwnership.test.ts, which is outside both units (client/src/lib/goalsApi.ts).'))
      .toEqual(['tests/goalOwnership.test.ts', 'client/src/lib/goalsApi.ts']);
    expect(pathsNamedIn('F3 requires outside the approved scope: scripts/program-map-release-01.py. Amend the scope.'))
      .toEqual(['scripts/program-map-release-01.py']);
    expect(pathsNamedIn(null)).toEqual([]);
  });

  it('never grants credentials, authentication, money movement, CI or a forbidden path', () => {
    const forbidden = ['data/**', '.git/**'];
    expect(grantable('server/services/cash/funnel.ts', forbidden)).toBe(true);
    expect(grantable('tests/goalOwnership.test.ts', forbidden)).toBe(true);
    for (const path of ['server/services/identity/secrets.ts', 'server/services/auth/session.ts', 'server/repos/oauth.ts', '.github/workflows/deploy.yml', 'server/services/cash/ledger.ts', 'server/services/payments/stripe.ts', 'data/brain.db']) {
      expect(grantable(path, forbidden), path).toBe(false);
    }
  });
});

describe('a blocker that names a path from inside a package', () => {
  it('reads it as the one full path that is a file or that a unit owns, and leaves an ambiguous one alone', () => {
    const detail =
      'failure-classifier-unwired requires outside the approved scope: routing/failures/classify.ts — ' +
      'F-ACQUIRE requires outside the approved scope: cash/needs.ts, docs/x.md, util/both.ts, nowhere/gone.ts. A repair is not created for a file it may not change.';
    const files = new Set(['server/services/cash/needs.ts', 'server/util/both.ts', 'client/src/util/both.ts']);
    expect(resolveShortPaths(detail, ['server/services/routing/failures/**'], (path) => files.has(path))).toEqual([
      'server/services/routing/failures/classify.ts',
      'server/services/cash/needs.ts',
    ]);
    expect(resolveShortPaths(null, [])).toEqual([]);
  });
});
