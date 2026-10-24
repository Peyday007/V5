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

describe('the Postgres suite is sharded without shrinking', () => {
  const suite = read('.github/workflows/postgres-suite.yml');
  const job = (name: string) => {
    const start = suite.indexOf(`\n  ${name}:\n`);
    expect(start).toBeGreaterThan(-1);
    const rest = suite.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  };

  it('runs every shard of one count, each against its own cluster', () => {
    const shards = job('suite');
    const matrix = /shard: \[([\d, ]+)\]/.exec(shards)?.[1]?.split(',').map((n) => Number(n.trim()));
    expect(matrix).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shards).toContain('npx vitest run --shard=${{ matrix.shard }}/8');
    // A cluster per job: the start step is inside the matrix job, not shared.
    expect(shards).toContain('ALTER SYSTEM SET max_locks_per_transaction');
    expect(shards).toContain('BRAIN_TEST_DATABASE_URL');
    expect(shards).not.toMatch(/\bnpm test\b(?!`)/);
  });

  it('still typechecks, and lists the whole suite for the verdict to hold the shards against', () => {
    const partition = job('partition');
    expect(partition).toContain('npm run typecheck');
    expect(partition).toContain('postgres-shards.sh all postgres-suite-files.txt');
    expect(fs.existsSync(path.join(ROOT, '.github/workflows/postgres-shards.sh'))).toBe(true);
    // Each shard reports what it ran, even when it went red.
    const shards = job('suite');
    expect(shards).toContain('--outputFile.json=postgres-shard-report.json');
    expect(shards).toMatch(/- name: What this shard ran\n\s+if: always\(\)/);
  });

  it('reaches one verdict that fails unless every shard passed and together they ran the whole suite once', () => {
    const verdict = job('verdict');
    expect(verdict).toContain('needs: [partition, suite]');
    // Runs, and fails, when a shard failed, was cancelled or was skipped.
    expect(verdict).toContain('if: ${{ always() }}');
    expect(verdict).toMatch(/\[ "\$PARTITION" != success \] \|\| \[ "\$SUITE" != success \]/);
    expect(verdict).toMatch(/exit 1/);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(verdict).toContain(`postgres-shard-${n}/postgres-shard-${n}.txt`);
    expect(verdict).toContain('postgres-shards.sh check');
    // Every other job feeds the verdict, so the run's conclusion — what
    // postgres-evidence.sh reads — is never success with a job left out.
    const jobs = [...suite.slice(suite.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z][\w-]*):\n/gm)].map((m) => m[1]);
    expect(jobs.sort()).toEqual(['partition', 'suite', 'verdict']);
  });

  it('Deploy still reads the run conclusion on the exact commit', () => {
    const evidence = read('.github/workflows/postgres-evidence.sh');
    expect(evidence).toContain('postgres-suite.yml/runs?head_sha=$sha');
    expect(evidence).toMatch(/\.status == "completed" and \.conclusion == "success"/);
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
