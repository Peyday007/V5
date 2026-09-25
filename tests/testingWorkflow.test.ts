/**
 * Ordinary development runs the tests a change reaches; one full cross-system
 * gate runs on the SHA that is integrated and released.
 *
 * Both halves are properties of files rather than of behaviour, so this reads
 * the repository, for `operatorConsoleRemoved`'s reason: a branch adding itself
 * to the Postgres suite's push trigger, or the impacted runner disappearing,
 * passes every behavioural test there is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** The branch names under `on.push.branches`, comments stripped. */
function pushBranches(workflow: string): string[] {
  const lines = workflow.split('\n');
  const push = lines.findIndex((line) => /^ {2}push:\s*$/.test(line));
  if (push === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(push + 1)) {
    if (/^ {0,3}\S/.test(line) && !/^\s*#/.test(line)) break;
    const entry = /^\s*-\s*'?([^'#\s]+)'?/.exec(line);
    if (entry && !/^\s*#/.test(line)) out.push(entry[1]!);
  }
  return out;
}

describe('the full Postgres suite runs on the integrated SHA only', () => {
  it('is pushed only on the canonical branch', () => {
    const canonical = read('.github/CANONICAL_BRANCH').trim();
    const branches = pushBranches(read('.github/workflows/postgres-suite.yml'));
    // Non-empty first, so a parser that found nothing cannot pass this.
    expect(branches.length).toBeGreaterThan(0);
    expect(branches).toEqual([canonical]);
  });

  it('is still dispatchable by hand for a deliberate full run', () => {
    expect(read('.github/workflows/postgres-suite.yml')).toMatch(/^\s{2}workflow_dispatch:/m);
  });
});

describe('ordinary development has a focused runner', () => {
  it('is wired to npm and exists', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:impacted']).toBe('node scripts/test-impacted.mjs');
    expect(fs.existsSync(path.join(ROOT, 'scripts/test-impacted.mjs'))).toBe(true);
  });

  it('always runs the guards no module graph reaches, including this one', () => {
    const runner = read('scripts/test-impacted.mjs');
    for (const guard of ['tests/deploymentOwnership.test.ts', 'tests/testingWorkflow.test.ts']) {
      expect(runner).toContain(`'${guard}'`);
      expect(fs.existsSync(path.join(ROOT, guard))).toBe(true);
    }
    // And the migration chains whenever either one moved.
    expect(runner).toContain("'tests/migrations.test.ts'");
  });

  it('does not count a type-only import as covering a file', () => {
    // `import type` is erased before a test runs; counting it pulls most of the
    // suite in on any edit to domain/types.ts, which is the cost being removed.
    expect(read('scripts/test-impacted.mjs')).toMatch(/if \(!match\[2\]\) add\(match\[3\]\)/);
  });
});
