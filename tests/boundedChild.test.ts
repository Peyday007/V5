/**
 * `goals plan` and `goals check` read in a child that this process bounds from
 * outside (scripts/boundedChild.ts), run here against real child processes.
 *
 * Run 44935606985 (2026-11-21): goal C's `goals plan` printed its plan and
 * `GOALS: OK` at 18:29:39, then background work held the process until the
 * step's 30-minute timeout. A child that prints its verdict and never exits is
 * the first case below: waiting for it to exit, as `plan` did, never returns.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runBoundedChild } from '../scripts/boundedChild.ts';

const dir = mkdtempSync(join(tmpdir(), 'bounded-child-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function child(name: string, body: string): string {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, body);
  return path;
}

describe('a read run in a bounded child', () => {
  it('ends a child that printed its verdict and then stayed alive on a handle (the goal C hang)', async () => {
    const path = child('lingers', "console.log('PLAN g1 NEEDS_EVIDENCE');\nconsole.log('GOALS: OK');\nsetInterval(() => {}, 1000);\n");
    const run = await runBoundedChild({ args: [path], ms: 60_000, graceMs: 300 });
    expect(run.verdict).toBe('GOALS: OK');
    expect(run.killed).toBe('AFTER_VERDICT');
    expect(run.out).toContain('PLAN g1 NEEDS_EVIDENCE');
    // Bounded by the grace after the verdict, not by the 60 s bound and not by the child.
    expect(run.elapsedMs).toBeLessThan(5_000);
  });

  it('ends a child whose verdict is followed by a loop that holds its event loop', async () => {
    const path = child('spins', "console.log('GOALS: OK');\nsetTimeout(() => { for (;;) {} }, 0);\n");
    const run = await runBoundedChild({ args: [path], ms: 60_000, graceMs: 300 });
    expect(run.verdict).toBe('GOALS: OK');
    expect(run.killed).toBe('AFTER_VERDICT');
    expect(run.elapsedMs).toBeLessThan(5_000);
  });

  it('kills a child that holds its loop before any verdict, at the bound, and reports it as stopped', async () => {
    const path = child('blocks', "console.log('  trace plan composed');\nfor (;;) {}\n");
    const run = await runBoundedChild({ args: [path], ms: 500 });
    expect(run.verdict).toBeNull();
    expect(run.killed).toBe('TIMEOUT');
    expect(run.out).toContain('composed');
    expect(run.elapsedMs).toBeLessThan(5_000);
  });

  it('leaves a child that exits after its verdict alone, and reads a failing verdict as one', async () => {
    const clean = await runBoundedChild({ args: [child('clean', "console.log('GOALS: OK');\n")], ms: 60_000 });
    expect(clean).toMatchObject({ verdict: 'GOALS: OK', killed: null });
    const failed = await runBoundedChild({ args: [child('fails', "console.log('GOALS: FAIL');\nprocess.exitCode = 1;\n")], ms: 60_000 });
    expect(failed).toMatchObject({ verdict: 'GOALS: FAIL', killed: null });
  });
});
