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
}

export const VERDICT_LINE = /^GOALS: .*$/m;
export const AFTER_VERDICT_GRACE_MS = 10_000;

export function runBoundedChild(options: BoundedChildOptions): Promise<BoundedChildResult> {
  const started = Date.now();
  const graceMs = options.graceMs ?? AFTER_VERDICT_GRACE_MS;
  return new Promise<BoundedChildResult>((resolve) => {
    const child = spawn(process.execPath, options.args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
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
    child.on('close', () => {
      clearTimeout(bound);
      if (grace) clearTimeout(grace);
      resolve({ verdict, killed, out, elapsedMs: Date.now() - started });
    });
  });
}
