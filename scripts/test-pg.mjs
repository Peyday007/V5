#!/usr/bin/env node
/**
 * The Postgres half of the test contract, with nobody at the keyboard.
 *
 * CLAUDE.md asks every persistence change to be tested against both backends,
 * and the Postgres half used to be a recipe: start a cluster somehow, make a
 * role and a database, then run `BRAIN_TEST_DATABASE_URL=postgresql://... npm
 * run test:impacted`. Every step of that is a separate shell command, and a
 * command with an environment assignment in front of it matches no permission
 * rule — so an unattended Factory worker either stopped at a permission prompt
 * or skipped the half of the gate that is "the only thing that proves one
 * repository layer over two databases is true rather than merely compiling".
 *
 * `npm run test:pg` is the whole recipe as one allowlisted command:
 *
 *   1. A throwaway cluster in a fresh temporary directory, from the PostgreSQL
 *      binaries already installed (`pg_config --bindir`, PATH, or
 *      /usr/lib/postgresql/<newest>/bin).
 *   2. **No TCP and no password.** `listen_addresses = ''`, a unix socket inside
 *      that private directory, and trust authentication on it — so there is no
 *      credential anywhere to store, print or leak (invariant 22), and nothing
 *      on the machine but this process can reach the cluster.
 *   3. The lock table sized for the suite's schema drops
 *      (`max_locks_per_transaction = 1024`, the same reading postgres-suite.yml
 *      records), and `fsync = off`, because the data is thrown away.
 *   4. The tests, with BRAIN_TEST_DATABASE_URL pointed at it.
 *   5. The cluster stopped and the directory removed, whatever happened.
 *
 * PostgreSQL refuses to run as root, so under root the cluster is owned by and
 * run as the `postgres` operating-system user; the tests still run as the
 * caller and reach it over the socket.
 *
 * If BRAIN_TEST_DATABASE_URL is already set (a CI job with its own cluster), no
 * cluster is made and the tests run against that one.
 *
 * Usage:
 *   npm run test:pg                       impacted tests, as `npm run test:impacted`
 *   npm run test:pg -- --list             any test-impacted flag passes through
 *   npm run test:pg -- --files a.ts b.ts  exactly these test files
 *   npm run test:pg -- --full             the whole suite: the released SHA only
 *                                         (CLAUDE.md rule 3), so it needs CI=true
 *                                         or BRAIN_FULL_GATE=1 in the environment
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);

function say(line) {
  process.stdout.write(`test:pg: ${line}\n`);
}

function die(line) {
  process.stderr.write(`TEST-PG: FAILED ${line}\n`);
  process.exit(1);
}

function commandFor(argv) {
  if (argv[0] === '--full') {
    if (process.env.CI !== 'true' && process.env.BRAIN_FULL_GATE !== '1') {
      die(
        '--full is the release gate (CLAUDE.md rule 3). Run it in CI, or with BRAIN_FULL_GATE=1 on the release SHA. ' +
          'While developing, `npm run test:pg` runs the impacted tests.',
      );
    }
    return ['npx', ['vitest', 'run']];
  }
  if (argv[0] === '--files') {
    const files = argv.slice(1);
    if (files.length === 0) die('--files needs at least one test file');
    return ['npx', ['vitest', 'run', ...files]];
  }
  return ['node', ['scripts/test-impacted.mjs', ...argv]];
}

function binDir() {
  const fromConfig = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (fromConfig.status === 0) {
    const dir = fromConfig.stdout.trim();
    if (existsSync(join(dir, 'initdb'))) return dir;
  }
  const onPath = spawnSync('sh', ['-c', 'command -v initdb'], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim().replace(/\/initdb$/, '');
  const root = '/usr/lib/postgresql';
  if (existsSync(root)) {
    const versions = readdirSync(root)
      .filter((name) => /^\d+$/.test(name) && existsSync(join(root, name, 'bin', 'initdb')))
      .sort((a, b) => Number(b) - Number(a));
    if (versions[0]) return join(root, versions[0], 'bin');
  }
  return null;
}

function run(cmd, argv, env) {
  const child = spawn(cmd, argv, { stdio: 'inherit', env: { ...process.env, ...env } });
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const [testCmd, testArgs] = commandFor(args);

if (process.env.BRAIN_TEST_DATABASE_URL) {
  say('BRAIN_TEST_DATABASE_URL is already set; using that database rather than starting one.');
  const code = await run(testCmd, testArgs, {});
  process.stdout.write(code === 0 ? 'TEST-PG: OK\n' : `TEST-PG: FAILED tests exited ${code}\n`);
  process.exit(code);
}

const bin = binDir();
if (!bin) die('no PostgreSQL binaries were found (pg_config, initdb on PATH, or /usr/lib/postgresql/*/bin).');

const asRoot = userInfo().uid === 0;
let owner = null;
if (asRoot) {
  const lookup = spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' });
  if (lookup.status !== 0) die('running as root, and there is no `postgres` user to own the cluster.');
  owner = 'postgres';
}

function asOwner(cmd, argv) {
  if (!owner) return execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  return execFileSync('runuser', ['-u', owner, '--', cmd, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
}

// A unix socket path is limited to about a hundred bytes, and a session's own
// TMPDIR can be longer than that on its own; /tmp is the fallback.
const base = tmpdir().length <= 60 ? tmpdir() : '/tmp';
const dir = mkdtempSync(join(base, 'brain-pg-'));
const data = join(dir, 'data');
const socket = dir;
const log = join(dir, 'server.log');
let started = false;

function cleanup() {
  if (started) {
    try {
      asOwner(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
    } catch {
      // Already gone; the directory removal below is what matters.
    }
    started = false;
  }
  rmSync(dir, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

let code = 1;
try {
  if (owner) {
    execFileSync('chown', [owner, dir]);
  }
  chmodSync(dir, 0o700);
  say(`initialising a throwaway cluster with ${bin}`);
  asOwner(join(bin, 'initdb'), ['-D', data, '-U', 'brain', '--auth=trust', '--no-sync', '-E', 'UTF8', '--locale=C']);
  const options = [
    `-k ${socket}`,
    "-c listen_addresses=''",
    '-c max_locks_per_transaction=1024',
    '-c fsync=off',
    '-c synchronous_commit=off',
    '-c full_page_writes=off',
  ].join(' ');
  asOwner(join(bin, 'pg_ctl'), ['-D', data, '-o', options, '-l', log, '-w', '-t', '60', 'start']);
  started = true;
  asOwner(join(bin, 'createdb'), ['-h', socket, '-U', 'brain', 'brain_test']);
  // The socket directory is the cluster owner's and private; the caller (root,
  // or the owner itself) can reach it, and nobody else on the machine can.
  const url = `postgresql://brain@/brain_test?host=${encodeURIComponent(socket)}&sslmode=disable`;
  say('cluster ready (unix socket only, no TCP, no password); running the tests against it');
  code = await run(testCmd, testArgs, { BRAIN_TEST_DATABASE_URL: url });
} catch (error) {
  const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '';
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${detail}\n`);
  if (existsSync(log)) {
    try {
      process.stderr.write(execFileSync('tail', ['-n', '30', log], { encoding: 'utf8' }));
    } catch {
      // No log to show.
    }
  }
  code = 1;
} finally {
  cleanup();
}
process.stdout.write(code === 0 ? 'TEST-PG: OK\n' : `TEST-PG: FAILED tests exited ${code}\n`);
process.exit(code);
