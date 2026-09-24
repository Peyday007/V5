/**
 * Every test file gets its own isolated data root. Vitest runs each file in a
 * fresh forked process with a fresh module registry, and setup files execute
 * before the test module (and therefore before server/env.ts) is imported.
 *
 * Cleaning them up is less obvious than it looks. `process.on('exit')` fires
 * for an ordinary exit and not for a signal, and vitest terminates its worker
 * pool — so an interrupted run, a killed worker or a crashed suite leaves its
 * root behind. Left alone that accumulates silently until the disk is full,
 * and the failure it produces then is a hundred unrelated tests failing on
 * "No space left on device", which looks like anything except a leak here.
 *
 * So there are two mechanisms, and the second is the one that actually holds:
 * this run tidies up after itself, and every run sweeps what earlier ones left.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { releaseTestSchemas } from './pgSchemas.ts';

const PREFIX = 'brain-test-';

/**
 * Old enough that no live suite could own it.
 *
 * Test files run concurrently and each one lands here, so a sweep with no age
 * limit would delete a sibling's data root out from under it. The longest
 * individual suite is a couple of minutes; an hour is far past any of them and
 * far short of leaving a run's worth of directories behind.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000;

function sweepStaleRoots(): void {
  const tmp = os.tmpdir();
  const cutoff = Date.now() - STALE_AFTER_MS;
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(PREFIX)) continue;
    const full = path.join(tmp, entry);
    try {
      if (fs.statSync(full).mtimeMs > cutoff) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // Another worker may be removing the same directory, or it may belong to
      // a different user. Neither is this run's problem.
    }
  }
}

sweepStaleRoots();

/*
 * No test may reach a live model, or a credential that is not the test's own.
 *
 * The API-key variables are removed rather than trusted to be absent — a
 * developer's shell routinely has one — and the factory's CLI is pointed at a
 * refusal (`helpers/no-live-cli.mjs`) so an unplanned spawn fails loudly
 * instead of running the `claude` on PATH as whoever is signed in there. Both
 * are inherited by every server a suite boots, because those spawn with
 * `process.env`. A suite that needs a CLI sets its own stub first.
 */
for (const variable of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'BRAIN_PROVIDER']) {
  delete process.env[variable];
}
process.env.BRAIN_FACTORY_CLI ??= path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'helpers',
  'no-live-cli.mjs',
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
process.env.BRAIN_DATA_DIR = dir;
process.env.BRAIN_DB_PATH = path.join(dir, 'brain.db');
process.env.NODE_ENV = 'test';

function removeOwnRoot(): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort; the next run's sweep will get it */
  }
}

/*
 * And the Postgres schema derived from this root, in the same place for the
 * same reason.
 *
 * A global `afterAll` rather than something a test file opts into: the first
 * version of this put the drop in `helpers.ts`'s `teardown()`, which **47 of
 * 169 files call**. The other 122 leaked exactly as they had before, and the
 * sweep — which skips anything younger than `STALE_AFTER_MS` — could not see a
 * run's own leavings until an hour after it finished.
 *
 * It cannot fail a suite. A schema that will not drop is a leak for the sweep
 * to clear, which is what the sweep is for.
 */
afterAll(async () => {
  await releaseTestSchemas();
});

process.on('exit', removeOwnRoot);
// The signals vitest's pool actually uses to stop a worker. Without these an
// interrupted run leaks one root per test file, every time.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    removeOwnRoot();
    process.exit(130);
  });
}
