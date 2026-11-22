/**
 * The goals door on a terminal (`sh scripts/goals.sh <command> …`). The
 * commands, and everything that reads or decides a goal, are in
 * scripts/goalsCli.ts; this file is the entry point, and it stays light.
 *
 * `plan` and `check` read in child processes this process bounds from outside
 * (scripts/boundedChild.ts: #1180, #1209). The parent of those reads only
 * spawns, waits and prints, so it imports nothing of the application and never
 * opens the database: production OOM, 2026-11-21 (21:08:22Z, exit 137 on the
 * 4096 MB machine) had three full Node processes on the box during a release
 * check — the app, this parent with the whole application imported and the
 * database open, and an uncapped child — and the kernel killed the app. Each
 * child now runs under a heap cap (`BRAIN_GOALS_CHILD_HEAP_MB`, 700 MB by
 * default); a child that outgrows it is that goal's `ERROR … (out of memory)`.
 *
 * Every other command, and the children themselves (`BRAIN_PLAN_CHILD`,
 * `BRAIN_CHECK_CHILD`), load scripts/goalsCli.ts and run in this process.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AFTER_VERDICT_GRACE_MS, failureReason, goalsChildHeapMb, MACHINE_MEMORY_GUARD, runBoundedChild, VERDICT_LINE, type MemoryGuard } from './boundedChild.ts';

/**
 * `goals plan` inside goals.yml's 30-minute step: the read, and the listing
 * after it, are killed at this bound. 20 minutes, not 26: run 44960240885
 * (2026-11-21) left a 26-minute bound four minutes of a step that also opens
 * the SSH session, and goals.yml bounds that session on the runner at 27.
 */
export const PLAN_TOTAL_MS = 20 * 60_000;
/** One goal's plan read inside the release check, and the whole check, kept inside goals.yml's 30-minute step. */
const CHECK_PER_GOAL_MS = 6 * 60_000;
const CHECK_TOTAL_MS = 26 * 60_000;
/** Listing the active targeted goals is one query. */
const LIST_MS = 3 * 60_000;

/** How the reads are spawned: this script again, under the parent's node flags, with a capped heap. Replaceable in tests. */
export interface ReadChildren {
  script: string;
  execArgv: string[];
  env: NodeJS.ProcessEnv;
  heapMb: number;
  write: (text: string) => void;
  /** Production's guard (`MACHINE_MEMORY_GUARD`); tests leave it out and spawn unguarded. */
  memoryGuard?: MemoryGuard;
}

function spawnedHere(): ReadChildren {
  return {
    script: process.argv[1]!,
    execArgv: process.execArgv,
    env: process.env,
    heapMb: goalsChildHeapMb(),
    write: (text) => void process.stdout.write(text),
    memoryGuard: MACHINE_MEMORY_GUARD,
  };
}

/** A child's own verdict line is the parent's to print, once. */
function passThrough(io: ReadChildren): (text: string) => void {
  return (text) => io.write(text.split('\n').filter((line) => !VERDICT_LINE.test(line)).join('\n'));
}

function words(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i]!.startsWith('--')) {
      i += 1;
      continue;
    }
    out.push(argv[i]!);
  }
  return out;
}

/**
 * `goals plan <goal>`: the read runs in a child (BRAIN_PLAN_CHILD=1). Goal C's
 * read in run 44935606985 (2026-11-21) printed its plan and `GOALS: OK` at
 * 18:29:39 and then never exited; the child's verdict now ends it, and a child
 * with no verdict at the bound, or one that outgrew its heap, is the failure.
 */
export async function planGoal(goalId: string, io: ReadChildren = spawnedHere(), ms: number = PLAN_TOTAL_MS): Promise<boolean> {
  const run = await runBoundedChild({
    args: [...io.execArgv, io.script, 'plan', goalId],
    env: { ...io.env, BRAIN_PLAN_CHILD: '1' },
    ms,
    heapMb: io.heapMb,
    memoryGuard: io.memoryGuard,
    onStdout: passThrough(io),
  });
  if (run.killed === 'AFTER_VERDICT') io.write(`  exit        the read printed its verdict and did not exit; stopped ${Math.round(AFTER_VERDICT_GRACE_MS / 1000)}s after it\n`);
  const ok = run.verdict !== null && /^GOALS: OK/.test(run.verdict);
  if (!ok) io.write(`  error       ${failureReason(run, ms, io.heapMb) ?? `the plan read ended without a passing verdict (${run.verdict})`}\n`);
  io.write(ok ? 'GOALS: OK\n' : 'GOALS: FAILED\n');
  return ok;
}

/**
 * The release check (`sh /app/scripts/goals.sh check [goalIds…]`): each goal
 * read in its own child, killed at its bound (check 44718014146, 2026-11-20:
 * one read held the event loop for twenty minutes, so no in-process timer
 * could fire). A child that is killed, or that outgrows its heap cap, is that
 * goal's ERROR; the others are still read. With no ids, a child lists every
 * active goal with a cash target, so this process never opens the database.
 */
export async function checkGoals(ids: string[], io: ReadChildren = spawnedHere()): Promise<boolean> {
  let goalIds = ids;
  if (goalIds.length === 0) {
    const listed = await runBoundedChild({
      args: [...io.execArgv, io.script, 'check'],
      env: { ...io.env, BRAIN_CHECK_CHILD: 'list' },
      ms: LIST_MS,
      heapMb: io.heapMb,
      memoryGuard: io.memoryGuard,
    });
    if (listed.verdict === null || !/^GOALS: OK/.test(listed.verdict)) {
      io.write(`INTEGRITY - ERROR the active goals could not be listed: ${failureReason(listed, LIST_MS, io.heapMb) ?? listed.verdict}\n`);
      io.write('GOALS: INTEGRITY FAILED\n');
      return false;
    }
    goalIds = [...listed.out.matchAll(/^GOAL (\S+)$/gm)].map((match) => match[1]!);
  }
  let failed = 0;
  const deadline = Date.now() + CHECK_TOTAL_MS;
  for (const goalId of goalIds) {
    const left = deadline - Date.now();
    if (left < 60_000) {
      failed += 1;
      io.write(`INTEGRITY ${goalId} ERROR not reached: the check's ${Math.round(CHECK_TOTAL_MS / 60000)}-minute budget was spent on the goals before it\n`);
      continue;
    }
    const ok = await checkInChild(goalId, Math.min(CHECK_PER_GOAL_MS, left), io);
    if (!ok) failed += 1;
  }
  io.write(failed > 0 ? 'GOALS: INTEGRITY FAILED\n' : 'GOALS: OK\n');
  return failed === 0;
}

/**
 * One goal's release check in a child process: its INTEGRITY lines are passed
 * through, and a child that is killed at `ms`, outgrows its heap cap or exits
 * without a verdict is reported as that goal's ERROR. True when it printed GOALS: OK.
 */
async function checkInChild(goalId: string, ms: number, io: ReadChildren): Promise<boolean> {
  const run = await runBoundedChild({
    args: [...io.execArgv, io.script, 'check', goalId],
    env: { ...io.env, BRAIN_CHECK_CHILD: '1' },
    ms,
    heapMb: io.heapMb,
    memoryGuard: io.memoryGuard,
    onStdout: passThrough(io),
  });
  const reason = failureReason(run, ms, io.heapMb);
  if (reason) io.write(`INTEGRITY ${goalId} ERROR ${reason}\n`);
  return run.verdict !== null && /^GOALS: OK/.test(run.verdict);
}

/**
 * Ends this process once everything written to stdout has left it. A pipe's
 * writes are queued in this process, and `process.exit` does not wait for
 * them, so the verdict line, the last thing written, could be lost behind a
 * slow SSH session. Bounded, so a reader that never drains cannot hold it.
 */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5_000).unref();
  process.stdout.write('', () => process.exit(code));
}

async function main(): Promise<void> {
  const [command, ...rest] = words();
  const inChild = process.env['BRAIN_PLAN_CHILD'] === '1' || Boolean(process.env['BRAIN_CHECK_CHILD']);
  if (!inChild && command === 'plan') {
    const goalId = rest[0];
    if (!goalId) {
      console.error('plan needs a goal id.');
      console.log('GOALS: FAIL');
      process.exit(1);
    }
    // The verdict is printed; end the process (as the children do, #1158).
    return exitAfterFlush((await planGoal(goalId)) ? 0 : 1);
  }
  if (!inChild && command === 'check') return exitAfterFlush((await checkGoals(rest)) ? 0 : 1);
  const { run } = await import('./goalsCli.ts');
  await run();
}

function isEntryPoint(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) void main();
