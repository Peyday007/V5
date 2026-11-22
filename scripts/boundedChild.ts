/**
 * One command of a script run in its own child process, with a bound this
 * process applies from outside it.
 *
 * Two ways a goals.sh read has run into goals.yml's 30-minute step timeout:
 *
 *  - a plan read that held the child's event loop (release check 44718014146,
 *    2026-11-20): no timer inside that process can fire, so only a process
 *    outside it can stop it (#1180);
 *  - a plan read that finished, printed `GOALS: OK`, and then never exited
 *    (`goals plan` on goal C, run 44935606985, 2026-11-21: verdict at
 *    18:29:39, step killed at 18:57:37). Work the read had started in the
 *    background kept the process alive; the same read on the same revision at
 *    09:45 drained 45 s after its verdict, this one did not drain at all.
 *
 * So the child's verdict line ends the run: once it prints `GOALS: …`, the
 * child is given `graceMs` to exit by itself and is then killed. A child still
 * running at `ms` without a verdict is killed and reported as stopped.
 *
 * And a child's heap is capped (`heapMb`). Production OOM, 2026-11-21
 * (21:08:22Z, exit 137 on the 4096 MB machine): during a release check the app,
 * the goals parent and the child each grew towards Node's default ~2 GB heap,
 * and the kernel killed the app rather than the script. A capped child that
 * outgrows its cap dies of its own heap error, which is that goal's ERROR, and
 * the app keeps serving.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export interface BoundedChildResult {
  /** The child's own verdict line (`GOALS: OK`, `GOALS: INTEGRITY FAILED`, …), or null when it printed none. */
  verdict: string | null;
  /** Why this process killed the child: it ran past `ms` with no verdict, or it outlived its verdict by `graceMs`. */
  killed: 'TIMEOUT' | 'AFTER_VERDICT' | null;
  /** Everything the child wrote to stdout. */
  out: string;
  elapsedMs: number;
  /** The child died of V8's heap limit (its own `--max-old-space-size`), not of a kill from here. */
  outOfMemory: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Not started: the machine did not have the memory the read needs beside the app (`memoryGuard`). */
  deferred?: string | null;
}

export interface BoundedChildOptions {
  /** Arguments to the node binary: the script and its command. */
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Killed at this bound when no verdict has been printed. */
  ms: number;
  /** After the verdict line, the child may take this long to exit before it is killed. */
  graceMs?: number;
  /** Each chunk of the child's stdout, as it arrives. */
  onStdout?: (text: string) => void;
  /** The child's V8 heap cap, `--max-old-space-size`, in MB. Replaces any cap in `args`. */
  heapMb?: number;
  /**
   * Refuse to start the child until the machine has its heap cap plus headroom
   * available, and make the child the kernel's first choice if memory runs out.
   * Production, 2026-11-22: a 700 MB read child beside a 3.3 GB app on the
   * 4 GB machine stalled the app itself for 428 s, 112 s and 36 min, each stall
   * starting and ending with a release-check read (runs 45057935518,
   * 45060366506); `nice` lowers CPU priority, never memory.
   */
  memoryGuard?: MemoryGuard;
}

export interface MemoryGuard {
  /** Megabytes available now, or null where the platform cannot say (no /proc). */
  availableMb: () => number | null;
  /** Kept free beyond the child's heap cap. */
  headroomMb: number;
  /** How long to wait for memory before deferring the read. */
  waitMs: number;
  /** Marks the child as the process to sacrifice; a no-op where unsupported. */
  sacrifice: (pid: number) => void;
}

/** MemAvailable from /proc/meminfo in MB, or null where there is none. */
export function procAvailableMb(read: () => string = () => fs.readFileSync('/proc/meminfo', 'utf8')): number | null {
  try {
    const kb = /^MemAvailable:\s+(\d+)\s+kB/m.exec(read());
    return kb ? Math.floor(Number(kb[1]) / 1024) : null;
  } catch {
    return null;
  }
}

/** The production guard: /proc/meminfo, 300 MB headroom, a minute's wait, oom_score_adj 1000 on the child. */
export const MACHINE_MEMORY_GUARD: MemoryGuard = {
  availableMb: () => procAvailableMb(),
  headroomMb: 300,
  waitMs: 60_000,
  sacrifice: (pid) => {
    try {
      fs.writeFileSync(`/proc/${pid}/oom_score_adj`, '1000');
    } catch {
      /* no /proc or not permitted: the heap cap still bounds the child */
    }
  },
};

/** Waits (up to `guard.waitMs`) for the child's heap plus headroom to be available; the deferral sentence, or null to start. */
export async function memoryDeferral(guard: MemoryGuard, heapMb: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<string | null> {
  const needed = heapMb + guard.headroomMb;
  const deadline = Date.now() + guard.waitMs;
  for (;;) {
    const available = guard.availableMb();
    if (available === null || available >= needed) return null;
    if (Date.now() >= deadline) {
      return `deferred: the machine had ${available} MB available and the read needs ${needed} MB (its ${heapMb} MB heap cap plus ${guard.headroomMb} MB), so it was not started beside the app`;
    }
    await sleep(5_000);
  }
}

export const VERDICT_LINE = /^GOALS: .*$/m;
export const AFTER_VERDICT_GRACE_MS = 10_000;

/** V8's own words when a heap reaches its cap (`FATAL ERROR: Reached heap limit … JavaScript heap out of memory`). */
const HEAP_EXHAUSTED = /JavaScript heap out of memory|Reached heap limit/;
const HEAP_FLAG = /^--max[-_]old[-_]space[-_]size(=|$)/;

/** A goals read child's heap cap: 700 MB, or `BRAIN_GOALS_CHILD_HEAP_MB`. Three of them never fit beside the app on a 4096 MB machine uncapped. */
export const GOALS_CHILD_HEAP_MB_DEFAULT = 700;
export function goalsChildHeapMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['BRAIN_GOALS_CHILD_HEAP_MB']);
  return Number.isFinite(raw) && raw >= 64 ? Math.floor(raw) : GOALS_CHILD_HEAP_MB_DEFAULT;
}

/** The node arguments a child runs with: `args`, with `--max-old-space-size=<heapMb>` first and no other heap cap. */
export function childArgs(args: string[], heapMb?: number): string[] {
  if (heapMb === undefined) return args;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (HEAP_FLAG.test(args[i]!)) {
      // `--max-old-space-size 2048` as two arguments.
      if (!args[i]!.includes('=')) i += 1;
      continue;
    }
    rest.push(args[i]!);
  }
  return [`--max-old-space-size=${heapMb}`, ...rest];
}

/** Why a child ended without a verdict, in a sentence that ends `(out of memory)` when it outgrew its heap cap; null when it printed one. */
export function failureReason(run: BoundedChildResult, ms: number, heapMb?: number): string | null {
  if (run.verdict !== null) return null;
  if (run.deferred) return run.deferred;
  if (run.killed === 'TIMEOUT') return `the plan read did not finish within ${Math.round(ms / 1000)}s and was stopped`;
  if (run.outOfMemory) return `the plan read outgrew its ${heapMb ?? '?'} MB heap cap and died (out of memory)`;
  return `the plan read exited without a verdict (${run.signal ? `signal ${run.signal}` : `exit code ${run.exitCode ?? 'unknown'}`})`;
}

/**
 * Waits for `work`, but only up to `ms`. Returns true if it finished in time
 * and false if this stopped waiting. The work is not cancelled, so the caller
 * prints what it has and ends the process. This bounds a wait on I/O inside a
 * read child: goal C's `plan` (run 44960240885, 2026-11-21) printed its plan
 * and then sat in the search listing after it, one query at a time over the
 * single pooled connection, until the step timed out. A loop that holds the
 * event loop cannot be bounded this way; the parent's bound is for that.
 */
export async function finishesWithin(ms: number, work: () => Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work().then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runBoundedChild(options: BoundedChildOptions): Promise<BoundedChildResult> {
  const started = Date.now();
  if (options.memoryGuard && options.heapMb !== undefined) {
    const deferred = await memoryDeferral(options.memoryGuard, options.heapMb);
    if (deferred) {
      return { verdict: null, killed: null, out: '', elapsedMs: Date.now() - started, outOfMemory: false, exitCode: null, signal: null, deferred };
    }
  }
  return runSpawned(options, started);
}

function runSpawned(options: BoundedChildOptions, started: number): Promise<BoundedChildResult> {
  const graceMs = options.graceMs ?? AFTER_VERDICT_GRACE_MS;
  return new Promise<BoundedChildResult>((resolve) => {
    const child = spawn(process.execPath, childArgs(options.args, options.heapMb), {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (options.memoryGuard && child.pid !== undefined) options.memoryGuard.sacrifice(child.pid);
    let out = '';
    // Passed through as it arrives (heartbeats, traces); the tail is kept to recognise a heap death.
    let errTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      errTail = (errTail + chunk.toString('utf8')).slice(-8192);
    });
    let verdict: string | null = null;
    let killed: BoundedChildResult['killed'] = null;
    let grace: NodeJS.Timeout | undefined;
    const bound = setTimeout(() => {
      killed = 'TIMEOUT';
      child.kill('SIGKILL');
    }, options.ms);
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      out += text;
      options.onStdout?.(text);
      if (verdict === null) {
        const line = VERDICT_LINE.exec(out);
        if (line) {
          verdict = line[0].trim();
          clearTimeout(bound);
          grace = setTimeout(() => {
            killed = 'AFTER_VERDICT';
            child.kill('SIGKILL');
          }, graceMs);
        }
      }
    });
    // 'close', not 'exit': every byte the child wrote has been read by then.
    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(bound);
      if (grace) clearTimeout(grace);
      const outOfMemory = killed === null && HEAP_EXHAUSTED.test(errTail);
      resolve({ verdict, killed, out, elapsedMs: Date.now() - started, outOfMemory, exitCode, signal });
    });
  });
}
