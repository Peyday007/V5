/**
 * The bench's own process environment, set before any of Brain's modules is evaluated
 * (`bench/run.ts` imports this first, and ES modules evaluate imports in order).
 *
 * A scenario suite (`mootRequests`) opens real databases. They must never be the
 * checkout's `data/brain.db`, so the data root is a fresh temporary directory unless
 * the caller (a test's `setup.ts`) already chose one. The two cadence knobs are the
 * ones the test runner sets for the same reason: a scenario calls the loop back to
 * back and must read what it just wrote.
 *
 * The loop's optional work (§63: goal plans, re-derivations) waits out a boot grace
 * measured from process start, so whether a scenario's tick ran it would depend on
 * how long the bench had been running — and on the number of hidden cases before it.
 * A measurement may not depend on that, so the grace is held past any bench run: every
 * tick runs the same passes, the ones that settle person-requests among them. (Under
 * vitest the grace is otherwise 0, and the same eighteen scenarios took five minutes.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env['BRAIN_DATA_DIR'] ??= fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bench-'));
process.env['BRAIN_SHARED_SNAPSHOT_MS'] ??= '0';
process.env['BRAIN_STANDING_INTERVAL_MS'] ??= '0';
process.env['BRAIN_OPTIONAL_BOOT_GRACE_MS'] ??= String(24 * 3_600_000);
process.env['BRAIN_GOAL_PLANS_BOOT_GRACE_MS'] ??= String(24 * 3_600_000);
