/**
 * One branch owns production, and the console stays gone.
 *
 * ---------------------------------------------------------------------------
 * What this is really about
 * ---------------------------------------------------------------------------
 *
 * Three branches deployed to one Fly app on one evening and each overwrote the
 * last. `/operator` came back twice — not because anybody re-added it, but
 * because a branch that predated its removal deployed after the branch that
 * removed it. A feature branch reaching production is not a mistake somebody
 * makes once; it is what a dispatchable deploy workflow does by default.
 *
 * So the rule is a file (`.github/CANONICAL_BRANCH`), the workflow reads that
 * file rather than restating the name, and this suite fails if either the rule
 * or the removal it protects is undone.
 *
 * **It is honest about what it cannot prove.** A guard inside a workflow file
 * cannot bind a branch whose copy of that file predates the guard, because
 * `workflow_dispatch` runs the workflow from the ref it is dispatched on. The
 * control that binds every ref is GitHub's deployment branch policy on the
 * `production` environment, which is repository configuration and not code.
 * What this asserts is that the repository half is in place and that nothing
 * has quietly grown a second way to reach production.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => fs.readFileSync(path.join(REPO, file), 'utf8');
const tracked = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);

const CANONICAL = read('.github/CANONICAL_BRANCH').trim();

describe('one branch owns production', () => {
  it('names the canonical branch in exactly one place', () => {
    expect(CANONICAL).toBe('production');
    // The workflow reads the file. A second copy of the name is a second thing
    // to forget to change.
    const deploy = read('.github/workflows/deploy.yml');
    expect(deploy).toContain('.github/CANONICAL_BRANCH');
    expect(deploy).not.toMatch(/ref_name\s*}}"\s*!=\s*"production"/);
  });

  it('refuses a non-canonical ref before anything else in the deploy runs', () => {
    const deploy = read('.github/workflows/deploy.yml');
    // The guard is a job, and every other job depends on it — a guard that runs
    // beside the deploy rather than before it is not a guard.
    expect(deploy).toMatch(/^ {2}canonical:/m);
    expect(deploy).toMatch(/^ {2}verify:\n {4}needs: canonical/m);
    expect(deploy).toMatch(/needs: verify/);
    // And it refuses an outdated checkout of the right branch too, which is the
    // same failure wearing the correct name.
    expect(deploy).toContain('HEAD..origin/$canonical');
  });

  it('leaves exactly one workflow able to deploy', () => {
    /*
     * A *command*, not the phrase.
     *
     * `step12a-acceptance.yml` carries a product owner's authorization ledger
     * verbatim, and one of those sentences contains the words "flyctl deploy".
     * Matching the phrase would fail on a quotation — a check that goes red on
     * correct content teaches people to delete it. A command sits at the start
     * of its own line inside a `run:` block; quoted prose does not.
     */
    const deploying = tracked()
      .filter((f) => f.startsWith('.github/workflows/'))
      .filter((f) => /^\s*flyctl\s+deploy\b/m.test(read(f)));
    expect(deploying).toEqual(['.github/workflows/deploy.yml']);
  });

  it('keeps the deploy behind the production environment, which is what GitHub can enforce', () => {
    const deploy = read('.github/workflows/deploy.yml');
    // The in-workflow guard cannot bind an older branch's copy of itself. The
    // environment can, so the job must stay attached to it.
    expect(deploy).toMatch(/environment: production/);
  });

  it('tells a future session the rule, in the file sessions are told to read', () => {
    const claude = read('CLAUDE.md');
    expect(claude).toContain('.github/CANONICAL_BRANCH');
    expect(claude).toMatch(/canonical/i);
    // The rule is an invariant, not only prose.
    expect(claude).toMatch(/^36\. /m);
  });
});

describe('and the console it protects stays gone', () => {
  it('has no operator route module, and refuses the path explicitly', () => {
    expect(fs.existsSync(path.join(REPO, 'server/routes/operator.ts'))).toBe(false);
    const index = read('server/index.ts');
    expect(index).not.toContain('operatorRouter');
    expect(index).toMatch(/'\/operator'/);
    expect(index).toMatch(/404/);
  });

  it('would fail if a merge brought the console back with another branch', () => {
    // The exact way it came back twice: a branch that predates the removal is
    // merged or deployed, and nothing notices because the file simply exists
    // again. Anything that reintroduces it fails here.
    for (const file of tracked()) {
      expect(file).not.toBe('server/routes/operator.ts');
    }
    for (const file of tracked().filter((f) => f.startsWith('client/'))) {
      expect(read(file), file).not.toContain('/operator');
    }
  });
});

describe('every workstream is present in the canonical tree', () => {
  /*
   * Converging three branches is only safe if the convergence is checked. Each
   * of these is a file one branch owned and the others did not, so a merge that
   * dropped a workstream fails here rather than in production.
   */
  const MUST_EXIST: Record<string, string[]> = {
    'Step 12A': [
      'server/services/dispatch/lineageRecovery.ts',
      'server/services/russell/needsHuman.ts',
      'server/db/migrations/035_worker_sessions.sql',
      'scripts/step12a-acceptance.ts',
    ],
    'Website Connection': [
      'server/routes/connect.ts',
      'server/services/connect/sites.ts',
      'server/repos/externalRecords.ts',
      'server/domain/jurisdiction.ts',
      'server/db/migrations/036_external_records.sql',
    ],
    'Software Factory': [
      'server/routes/factory.ts',
      'server/repos/factory.ts',
      'server/repos/factoryFleet.ts',
      'server/services/factory/loop.ts',
      'scripts/factory.ts',
      'server/db/migrations/037_software_factory.sql',
      'server/db/migrations/038_factory_repository_root.sql',
    ],
  };

  for (const [workstream, files] of Object.entries(MUST_EXIST)) {
    it(`still has ${workstream}`, () => {
      for (const file of files) {
        expect(fs.existsSync(path.join(REPO, file)), file).toBe(true);
      }
    });
  }

  /*
   * The Software Factory's amendment ledger, checked rather than assumed.
   *
   * Its commit was called "the amendment ledger gets an operator entrance",
   * which reads alarmingly next to a console that was being deleted the same
   * night. It is not that: "operator" there means the person, and the entrance
   * is `scripts/factory.ts`. So it already sits the way §26 prescribes — the
   * reading on a normal API surface, the mutation on a terminal — and this
   * pins that rather than trusting the reading of one commit message.
   */
  it('keeps the factory amendment ledger readable over the API and writable only from a terminal', () => {
    const routes = read('server/routes/factory.ts');
    expect(routes).toContain('listAmendments');
    expect(routes).toMatch(/'\/factory\/change-requests\/:changeRequestId'/);
    // Reading only: no HTTP route mutates an amendment.
    expect(routes).not.toContain('amendContract');

    const cli = read('scripts/factory.ts');
    expect(cli).toContain('amendContract');

    // And the service still refuses what it always refused.
    const contract = read('server/services/factory/contract.ts');
    expect(contract).toContain('recordAmendment');
  });

  it('has one migration chain per backend, numbered without a gap or a collision', () => {
    for (const [dir, kind] of [
      ['server/db/migrations', 'SQLite'],
      ['server/db/pg-migrations', 'Postgres'],
    ] as const) {
      const versions = fs
        .readdirSync(path.join(REPO, dir))
        .filter((f) => f.endsWith('.sql'))
        .map((f) => Number(f.slice(0, 3)))
        .sort((a, b) => a - b);
      expect(versions.length, kind).toBeGreaterThan(0);
      expect(new Set(versions).size, `${kind} has a duplicate number`).toBe(versions.length);
      for (let i = 1; i < versions.length; i += 1) {
        expect(versions[i]! - versions[i - 1]!, `${kind} jumps at ${versions[i]}`).toBe(1);
      }
    }
  });
});
