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
import { spawn } from 'node:child_process';
import { childArgs, failureReason, finishesWithin, goalsChildHeapMb, memoryDeferral, procAvailableMb, runBoundedChild, type MemoryGuard } from '../scripts/boundedChild.ts';
import { checkGoals, planGoal, type ReadChildren } from '../scripts/goals.ts';

/** Holds everything it allocates, so it can only end at its heap cap. */
const GROWS = "const held = [];\nfor (;;) held.push(new Array(1e5).fill({ x: Math.random() }));\n";

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

  it('runs a child under the heap cap, replacing any cap it would have inherited', async () => {
    const path = child('argv', "console.log('ARGV ' + JSON.stringify(process.execArgv));\nconsole.log('GOALS: OK');\n");
    const run = await runBoundedChild({ args: ['--max-old-space-size=4096', path], ms: 60_000, heapMb: 700 });
    expect(run.verdict).toBe('GOALS: OK');
    const argv = JSON.parse(/^ARGV (.*)$/m.exec(run.out)![1]!) as string[];
    expect(argv).toContain('--max-old-space-size=700');
    expect(argv.filter((one) => one.startsWith('--max-old-space-size'))).toEqual(['--max-old-space-size=700']);
    expect(childArgs(['--max-old-space-size', '2048', '--import', 'tsx', 's.ts'], 700)).toEqual(['--max-old-space-size=700', '--import', 'tsx', 's.ts']);
  });

  it('defaults a goals child to 700 MB, overridable by BRAIN_GOALS_CHILD_HEAP_MB', () => {
    expect(goalsChildHeapMb({})).toBe(700);
    expect(goalsChildHeapMb({ BRAIN_GOALS_CHILD_HEAP_MB: '512' })).toBe(512);
    expect(goalsChildHeapMb({ BRAIN_GOALS_CHILD_HEAP_MB: 'lots' })).toBe(700);
  });

  it('reports a child that outgrows its heap cap as out of memory, promptly, rather than waiting for its bound', async () => {
    const run = await runBoundedChild({ args: [child('grows', GROWS)], ms: 60_000, heapMb: 48 });
    expect(run.verdict).toBeNull();
    expect(run.killed).toBeNull();
    expect(run.outOfMemory).toBe(true);
    expect(failureReason(run, 60_000, 48)).toMatch(/48 MB heap cap.*\(out of memory\)$/);
    expect(run.elapsedMs).toBeLessThan(30_000);
  });

  it('leaves a child that exits after its verdict alone, and reads a failing verdict as one', async () => {
    const clean = await runBoundedChild({ args: [child('clean', "console.log('GOALS: OK');\n")], ms: 60_000 });
    expect(clean).toMatchObject({ verdict: 'GOALS: OK', killed: null });
    const failed = await runBoundedChild({ args: [child('fails', "console.log('GOALS: FAIL');\nprocess.exitCode = 1;\n")], ms: 60_000 });
    expect(failed).toMatchObject({ verdict: 'GOALS: FAIL', killed: null });
  });
});

/**
 * Production OOM, 2026-11-21 21:08:22Z: during a release check the app, the
 * goals parent and an uncapped child shared the 4096 MB machine, and the kernel
 * killed the app. The parent (scripts/goals.ts) now spawns each read under a
 * heap cap; a read that outgrows it is that goal's ERROR, and the check goes on.
 */
describe('the goals release check and plan, against children that stand in for the reads', () => {
  // A stand-in for `goals.ts check <goal>` / `plan <goal>`: argv[2] is the command, argv[3] the goal.
  const fake = child(
    'goal-read',
    [
      'const [, , command, goalId] = process.argv;',
      "if (process.env.BRAIN_CHECK_CHILD === 'list') { console.log('GOAL g-ok'); console.log('GOAL g-oom'); console.log('GOAL g-after'); console.log('GOALS: OK'); process.exit(0); }",
      `if (goalId === 'g-oom') { ${GROWS} }`,
      "console.log(`INTEGRITY ${goalId} OK ${command} ${JSON.stringify(process.execArgv)}`);",
      "console.log('GOALS: OK');",
    ].join('\n'),
  );
  function io(): ReadChildren & { text: () => string } {
    let text = '';
    return { script: fake, execArgv: [], env: process.env, heapMb: 48, write: (t) => void (text += t), text: () => text };
  }

  it('reads every listed goal under the cap, reports the one that ran out of memory as its ERROR, and does not hang', async () => {
    const out = io();
    const started = Date.now();
    const ok = await checkGoals([], out);
    expect(ok).toBe(false);
    const text = out.text();
    expect(text).toContain('INTEGRITY g-ok OK check ["--max-old-space-size=48"]');
    expect(text).toMatch(/^INTEGRITY g-oom ERROR .*\(out of memory\)$/m);
    // The goal after it is still read.
    expect(text).toContain('INTEGRITY g-after OK check');
    expect(text.trimEnd().split('\n').at(-1)).toBe('GOALS: INTEGRITY FAILED');
    expect(text.match(/^GOALS: /gm)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(60_000);
  });

  it('passes a check whose reads all pass', async () => {
    const out = io();
    expect(await checkGoals(['g-ok'], out)).toBe(true);
    expect(out.text().trimEnd().split('\n').at(-1)).toBe('GOALS: OK');
  });

  it('fails a plan read that outgrew its heap, saying so', async () => {
    const out = io();
    expect(await planGoal('g-oom', out)).toBe(false);
    expect(out.text()).toMatch(/error {7}.*\(out of memory\)\nGOALS: FAILED\n$/);
    const good = io();
    expect(await planGoal('g-ok', good)).toBe(true);
    expect(good.text()).toContain('["--max-old-space-size=48"]');
  });
});

/**
 * Run 44960240885 (2026-11-21, production 3afa4261): goal C's `goals plan`
 * printed its plan and `timing plan read in 129551 ms`, then sat in the search
 * listing after it and printed no `GOALS:` line before the step's 30-minute
 * timeout. Here the real entry point, scripts/goals.ts, runs `plan` through its
 * real child (scripts/goalsCli.ts) against a fresh database.
 */
describe('`goals plan` through the real entry point and its real child', () => {
  const data = mkdtempSync(join(tmpdir(), 'goals-plan-'));
  afterAll(() => rmSync(data, { recursive: true, force: true }));
  // The test's own database, never the developer's, and never Postgres.
  const env: NodeJS.ProcessEnv = { ...process.env, BRAIN_DATA_DIR: data, BRAIN_DB_PATH: join(data, 'brain.db'), BRAIN_DATABASE_URL: '' };
  const real = (): ReadChildren & { text: () => string } => {
    let text = '';
    return { script: 'scripts/goals.ts', execArgv: ['--import', 'tsx'], env, heapMb: 700, write: (t) => void (text += t), text: () => text };
  };

  it('prints exactly one GOALS verdict, last, and the process exits', async () => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/goals.ts', 'plan', 'wst_no_such_goal'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString('utf8')));
    child.stderr.resume();
    const code = await new Promise<number | null>((resolve) => child.on('close', (exit) => resolve(exit)));
    expect(out.match(/^GOALS: .*$/gm)).toEqual(['GOALS: FAILED']);
    expect(out.trimEnd().split('\n').at(-1)).toBe('GOALS: FAILED');
    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(90_000);
  }, 120_000);

  it('stops a read still running at its bound, and still prints the one verdict', async () => {
    const out = real();
    const started = Date.now();
    expect(await planGoal('wst_no_such_goal', out, 1_000)).toBe(false);
    expect(out.text()).toMatch(/error {7}the plan read did not finish within 1s and was stopped\nGOALS: FAILED\n$/);
    expect(out.text().match(/^GOALS: /gm)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it('gives up waiting on a listing that never finishes, so the verdict is still printed', async () => {
    const started = Date.now();
    expect(await finishesWithin(200, () => new Promise(() => undefined))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await finishesWithin(5_000, async () => undefined)).toBe(true);
  });
});

describe('a read child beside the app on a machine short of memory', () => {
  // Production, 2026-11-22: a 700 MB read beside a 3.3 GB app on the 4 GB machine stalled the app itself
  // (428 s, 112 s, 36 min), each stall starting and ending with a release-check read (45057935518, 45060366506).
  const guard = (available: Array<number | null>, sacrificed: number[] = []): MemoryGuard => ({
    availableMb: () => (available.length > 1 ? available.shift()! : available[0]!),
    headroomMb: 300,
    waitMs: 0,
    sacrifice: (pid) => void sacrificed.push(pid),
  });

  it('is not started when the machine cannot fit its heap and headroom, and says why', async () => {
    const path = child('never', "console.log('GOALS: OK');\n");
    const run = await runBoundedChild({ args: [path], ms: 60_000, heapMb: 700, memoryGuard: guard([600]) });
    expect(run.verdict).toBeNull();
    expect(run.deferred).toMatch(/600 MB available and the read needs 1000 MB/);
    expect(failureReason(run, 60_000, 700)).toBe(run.deferred);
  });

  it('starts once memory frees within the wait, and marks the child as the kernel\'s first choice', async () => {
    const path = child('fits', "console.log('GOALS: OK');\n");
    const sacrificed: number[] = [];
    const deferral = await memoryDeferral({ ...guard([400, 400, 2000]), waitMs: 60_000 }, 700, async () => undefined);
    expect(deferral).toBeNull();
    const run = await runBoundedChild({ args: [path], ms: 60_000, heapMb: 700, memoryGuard: guard([2000], sacrificed) });
    expect(run.verdict).toBe('GOALS: OK');
    expect(sacrificed).toHaveLength(1);
  });

  it('starts where the platform cannot say, and reads MemAvailable from /proc/meminfo', async () => {
    expect(await memoryDeferral(guard([null]), 700)).toBeNull();
    expect(procAvailableMb(() => 'MemTotal:  4026532 kB\nMemAvailable:  512000 kB\n')).toBe(500);
    expect(procAvailableMb(() => { throw new Error('no /proc'); })).toBeNull();
  });
});
