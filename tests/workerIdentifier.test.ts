/**
 * The identifier `workers list` prints, and the command that consumes it.
 *
 * Production, on 2026-09-20: `admin workers list` printed
 * `worker-05  wkr_1cdd82cfb2a54faf8edd`, and `admin access grant worker-05 …`
 * answered **No such worker** — then listed the candidates by a third
 * spelling, `airynworker2`, which the listing had never shown. Nothing was
 * broken in the sense of throwing: `workerIdentity` prints the neutral label
 * migration 074 assigns, `workerFrom` resolved `workers.name`, and 074's own
 * header says that column "participates in nothing". Two readers of one fact,
 * and the quieter one is the one nobody notices is wrong.
 *
 * So this suite is in two halves, and the second is the one that would have
 * caught it.
 *
 * The first drives `resolveWorkerRef` against the suite's own database — which
 * means Postgres too when `BRAIN_TEST_DATABASE_URL` is set, because
 * `getWorkerByLabel` is a new query and a repository layer over two databases
 * is true or merely compiling.
 *
 * The second spawns the **real script**, against a scratch Brain of its own,
 * and does what an operator does: read the listing, copy an identifier off it,
 * pass it to `access grant`. A test that rendered the listing itself would be
 * asserting against its own idea of the format, which is exactly the kind of
 * agreement that was never there.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { freshProject, teardown } from './helpers.ts';
import { createWorker } from '../server/repos/identity.ts';
import { resolveWorkerRef } from '../server/services/identity/workerRef.ts';
import { workerIdentity } from '../server/services/identity/authenticate.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/* ------------------------------------------------------------------------ */
/* Half one: what a reference may be                                         */
/* ------------------------------------------------------------------------ */

describe('resolving a worker reference', () => {
  beforeEach(async () => {
    await freshProject();
  });
  afterEach(async () => {
    await teardown();
  });

  async function aWorker(name: string) {
    return await createWorker({
      name,
      displayName: name,
      workerType: 'GENERIC',
      description: null,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
  }

  it('answers to the label the listing prints', async () => {
    const worker = await aWorker('airynworker2');
    expect(worker.label, 'migration 074 assigns every worker a label').toBeTruthy();

    const found = await resolveWorkerRef(workerIdentity(worker));
    expect(found.kind).toBe('FOUND');
    expect(found.kind === 'FOUND' && found.worker.id).toBe(worker.id);
  });

  it('answers to the id the listing prints beside it', async () => {
    const worker = await aWorker('airynworker3');
    const found = await resolveWorkerRef(worker.id);
    expect(found.kind === 'FOUND' && found.worker.id).toBe(worker.id);
  });

  /*
   * The half that must not move. Every command anybody has ever run passed a
   * `workers.name`, and widening a lookup must not re-point one of them.
   */
  it('still answers to the handle every existing command passes', async () => {
    const worker = await aWorker('airynworker4');
    const found = await resolveWorkerRef('airynworker4');
    expect(found.kind === 'FOUND' && found.worker.id).toBe(worker.id);
  });

  it('answers nothing to a reference that names nothing', async () => {
    expect((await resolveWorkerRef('no-such-worker')).kind).toBe('NONE');
    expect((await resolveWorkerRef('   ')).kind).toBe('NONE');
  });

  /*
   * One string, two rows. Refused rather than chosen between: picking either
   * would be a confident answer to the wrong question with every row healthy,
   * which is the defect `jurisdiction.ts` and `softwareTarget.ts` both exist
   * to refuse one altitude up.
   */
  it('refuses a reference that names two workers rather than picking one', async () => {
    const labelled = await aWorker('first-worker');
    const label = workerIdentity(labelled);
    expect(label.startsWith('worker-')).toBe(true);
    // A second worker whose *handle* is the first one's label.
    const collider = await aWorker(label);

    const found = await resolveWorkerRef(label);
    expect(found.kind).toBe('AMBIGUOUS');
    const ids = found.kind === 'AMBIGUOUS' ? found.matches.map((one) => one.id).sort() : [];
    expect(ids).toEqual([labelled.id, collider.id].sort());
  });
});

/* ------------------------------------------------------------------------ */
/* Half two: the operator journey, through the real script                    */
/* ------------------------------------------------------------------------ */

const ADMIN = 'operator@example.invalid';
let scratch: string | null = null;

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/**
 * A Brain of this suite's own, on disk, so the script under test opens the
 * same database twice over a process boundary — which is the only way to run
 * `workers list` and `access grant` as two separate operator actions.
 *
 * SQLite even on the Postgres run: what is under test is a script's argument
 * handling, and the query that needed the second backend is proved above.
 */
function scratchRoot(): string {
  return (scratch ??= mkdtempSync(path.join(tmpdir(), 'brain-worker-ref-')));
}

/** Pointed at the scratch Brain, and explicitly not at the suite's own. */
function scratchEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BRAIN_DATA_DIR: root,
    BRAIN_DB_PATH: path.join(root, 'brain.db'),
  };
  delete env['BRAIN_DATABASE_URL'];
  delete env['BRAIN_TEST_DATABASE_URL'];
  return env;
}

/**
 * Every child is bounded, and that is not belt-and-braces.
 *
 * `execFileSync` blocks the worker thread, so vitest's own per-test timeout
 * cannot interrupt one — a child that never exits hangs the entire suite with
 * no failing test and no diagnosis, which is the shape this repository keeps
 * correcting: an outcome reported as *still running* when it is actually
 * stuck. The bound turns that into a named failure naming the command.
 */
const CHILD_TIMEOUT_MS = 90_000;

function run(command: string, argv: string[], root: string): string {
  try {
    return execFileSync(command, argv, {
      cwd: REPO,
      env: scratchEnv(root),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    const failure = error as { signal?: string; stdout?: string; stderr?: string };
    if (failure.signal === 'SIGKILL') {
      throw new Error(
        `\`${[command, ...argv].join(' ')}\` did not exit within ` +
          `${CHILD_TIMEOUT_MS / 1000}s and was killed.`,
      );
    }
    throw new Error(
      `\`${[command, ...argv].join(' ')}\` failed: ` +
        `${(failure.stderr ?? '').trim() || (failure.stdout ?? '').trim() || String(error)}`,
    );
  }
}

function admin(...argv: string[]): string {
  return run(path.join(REPO, 'node_modules/.bin/tsx'), [path.join(REPO, 'scripts/admin.ts'), ...argv], scratchRoot());
}

describe('an operator reading the listing and using what it says', () => {
  it('accepts every identifier `workers list` prints, in `access grant`', () => {
    const root = scratchRoot();

    // The one thing no admin command creates: the administrator `--admin`
    // resolves against. Seeded through the repository, in its own process, so
    // this suite's database is not swapped underneath it.
    const seed = path.join(root, 'seed.mts');
    writeFileSync(
      seed,
      [
        `import { closeDatabase, initDatabase } from ${JSON.stringify(path.join(REPO, 'server/db/database.ts'))};`,
        `import { createUser } from ${JSON.stringify(path.join(REPO, 'server/repos/identity.ts'))};`,
        'await initDatabase();',
        `await createUser({ email: ${JSON.stringify(ADMIN)}, displayName: 'Operator', ` +
          "password: 'a-password-long-enough', isBrainAdmin: true });",
        'await closeDatabase();',
      ].join('\n'),
      'utf8',
    );
    run(path.join(REPO, 'node_modules/.bin/tsx'), [seed], root);

    admin('projects', 'create', 'Wedge', '--admin', ADMIN);
    admin('workers', 'create', 'airynworker2', '--admin', ADMIN);

    const listing = admin('workers', 'list', '--admin', ADMIN)
      .split('\n')
      .find((line) => line.includes('airynworker2') || /^\s+worker-\d/.test(line));
    expect(listing, '`workers list` printed a row for the worker it just made').toBeTruthy();

    /*
     * Every whitespace-separated field on the row that is an identifier rather
     * than a count or a status. Taken off the rendered line on purpose: the
     * thing under test is what a person can copy, so a test that knew the
     * fields by name would be asserting against its own idea of the format.
     */
    const printed = (listing ?? '').trim().split(/\s+/).filter((field) => /^(worker-\d+|wkr_[0-9a-f]+)$/.test(field));
    expect(printed.length, 'the row prints both the label and the id').toBe(2);

    for (const identifier of printed) {
      const out = admin('access', 'grant', identifier, 'wedge', '--admin', ADMIN);
      expect(out, `"${identifier}" came off the listing and must be accepted here`).toContain(
        'ADMIN: OK',
      );
      expect(out).toContain('researches for Wedge');
    }

    // And the handle that always worked still does, so nothing was invalidated.
    expect(admin('access', 'grant', 'airynworker2', 'wedge', '--admin', ADMIN)).toContain('ADMIN: OK');
  }, 180_000);
});

/*
 * Left deliberately unasserted: that the membership row landed. `access grant`
 * printing `ADMIN: OK` is the script's own report of having written it, and
 * re-reading it from here would need this process to open that scratch
 * database — swapping the one the first half is using. `grantMembership` is
 * already covered elsewhere, and what was broken was never the write; it was
 * getting as far as it.
 */
