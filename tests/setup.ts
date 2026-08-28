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

const PREFIX = 'brain-test-';

/**
 * Old enough that no live suite could own it.
 *
 * Test files run concurrently and each one lands here, so a sweep with no age
 * limit would delete a sibling's data root out from under it. The longest
 * individual suite is a couple of minutes; an hour is far past any of them and
 * far short of leaving a run's worth of directories behind.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

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

process.on('exit', removeOwnRoot);
// The signals vitest's pool actually uses to stop a worker. Without these an
// interrupted run leaks one root per test file, every time.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    removeOwnRoot();
    process.exit(130);
  });
}
