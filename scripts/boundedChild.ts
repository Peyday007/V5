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
  if (run.killed === 'TIMEOUT') return `the plan read did not finish within ${Math.round(ms / 1000)}s and was stopped`;
  if (run.outOfMemory) return `the plan read outgrew its ${heapMb ?? '?'} MB heap cap and died (out of memory)`;
  return `the plan read exited without a verdict (${run.signal ? `signal ${run.signal}` : `exit code ${run.exitCode ?? 'unknown'}`})`;
}

export function runBoundedChild(options: BoundedChildOptions): Promise<BoundedChildResult> {
  const started = Date.now();
  const graceMs = options.graceMs ?? AFTER_VERDICT_GRACE_MS;
  return new Promise<BoundedChildResult>((resolve) => {
    const child = spawn(process.execPath, childArgs(options.args, options.heapMb), {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
