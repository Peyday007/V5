/**
 * Running the automation CLI safely (section 2).
 *
 * Everything here exists because a research job is an external program that
 * Brain does not control, and the ways that goes wrong are predictable:
 *
 *   - A command assembled by string interpolation is an injection waiting for a
 *     prompt containing a quote. Arguments are always an array and the shell is
 *     always off.
 *   - A prompt is far too big for a command line and its contents are
 *     attacker-influenced text. It goes over stdin, or into a file inside the
 *     job directory — never onto the command line.
 *   - A CLI can hang forever. `agy -p` is known to, when its stdout is a pipe
 *     rather than a terminal (antigravity-cli issue #318), which is exactly how
 *     Brain calls it. So the timeout is not a nicety, it is the thing that keeps
 *     the application usable, and it kills the whole process tree rather than
 *     the one process it can see.
 *   - Output can be unbounded. It is capped, and truncation is recorded rather
 *     than hidden.
 *
 * What comes back is a record of what happened — command, exit code, duration,
 * captured output — for the run's execution log. What must never leave the
 * server is in `internal`: local paths and raw output stay here.
 */
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Above this, the prompt goes to a file rather than down stdin. */
export const STDIN_LIMIT_BYTES = 256 * 1024;
/** Captured output ceiling per stream. Beyond it, the run is truncated, not lost. */
export const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

export type JobOutcome = 'COMPLETED' | 'TIMED_OUT' | 'CANCELLED' | 'FAILED';

export interface JobResult {
  outcome: JobOutcome;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** How the prompt was delivered, for the reproducibility record. */
  promptDelivery: 'stdin' | 'file';
  /** Safe to show a user: no paths, no environment, no raw dump. */
  message: string;
}

export interface RunJobInput {
  command: string;
  /** Arguments before the prompt. Never contains the prompt itself. */
  args: string[];
  prompt: string;
  /** Directory this job owns. Created by the caller, under the data root. */
  jobDir: string;
  timeoutMs: number;
  /** Cancellation from the UI. Kills the tree, same as a timeout. */
  signal?: AbortSignal;
  /** Called with each chunk of stdout, for live progress. */
  onOutput?: (chunk: string) => void;
  /**
   * Flag that makes the CLI read the prompt from a file, when one exists.
   * Without it a large prompt still goes over stdin.
   */
  promptFileFlag?: string | null;
}

/**
 * Kill a process and everything it started.
 *
 * Killing only the direct child leaves its children holding the pipes, so the
 * parent's streams never close and the "timeout" never actually returns. On
 * POSIX the child is its own process-group leader and the group is signalled; on
 * Windows taskkill /T walks the tree.
 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    // Negative pid signals the whole process group (see `detached` below).
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** Accumulates a stream up to a ceiling, remembering that it overflowed. */
class Capture {
  #parts: string[] = [];
  #bytes = 0;
  truncated = false;

  add(chunk: string): void {
    if (this.truncated) return;
    this.#bytes += Buffer.byteLength(chunk);
    if (this.#bytes > OUTPUT_LIMIT_BYTES) {
      this.truncated = true;
      this.#parts.push('\n[output truncated by Brain: the run produced more than it will store]');
      return;
    }
    this.#parts.push(chunk);
  }

  get text(): string {
    return this.#parts.join('');
  }
}

/**
 * Run one job to completion, a timeout, or a cancellation.
 *
 * Never throws for anything the child does — a failed run is a result, not an
 * exception, because the caller has to record it either way.
 */
export async function runAntigravityJob(input: RunJobInput): Promise<JobResult> {
  fs.mkdirSync(input.jobDir, { recursive: true });

  const promptBytes = Buffer.byteLength(input.prompt);
  const useFile = Boolean(input.promptFileFlag) && promptBytes > STDIN_LIMIT_BYTES;
  const args = [...input.args];
  let promptDelivery: JobResult['promptDelivery'] = 'stdin';

  if (useFile && input.promptFileFlag) {
    const promptPath = path.join(input.jobDir, 'prompt.txt');
    fs.writeFileSync(promptPath, input.prompt, 'utf8');
    args.push(input.promptFileFlag, promptPath);
    promptDelivery = 'file';
  }

  const startedAt = Date.now();
  const stdout = new Capture();
  const stderr = new Capture();

  return await new Promise<JobResult>((resolve) => {
    let settled = false;
    let outcome: JobOutcome = 'COMPLETED';

    const child = spawn(input.command, args, {
      cwd: input.jobDir,
      shell: false,
      windowsHide: true,
      // Its own process group, so a timeout can take the whole tree with it.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Discourage the interactive rendering that makes output unparseable.
        NO_COLOR: '1',
        TERM: 'dumb',
        CI: '1',
      },
    });

    const finish = (result: Omit<JobResult, 'durationMs' | 'stdout' | 'stderr' | 'truncated' | 'promptDelivery'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({
        ...result,
        durationMs: Date.now() - startedAt,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        promptDelivery,
      });
    };

    const stop = (why: JobOutcome): void => {
      outcome = why;
      if (child.pid) killTree(child.pid);
    };

    const timer = setTimeout(() => stop('TIMED_OUT'), input.timeoutMs);
    const onAbort = (): void => stop('CANCELLED');
    input.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout.add(chunk);
      input.onOutput?.(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderr.add(chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        outcome: 'FAILED',
        exitCode: null,
        signal: null,
        message:
          error.code === 'ENOENT'
            ? 'The research tool could not be started — it is no longer where Brain found it. Use Check connection.'
            : 'The research tool could not be started.',
      });
    });

    child.on('close', (code, signalName) => {
      if (outcome === 'TIMED_OUT') {
        finish({
          outcome: 'TIMED_OUT',
          exitCode: code,
          signal: signalName,
          message:
            `The research tool did not respond within ${Math.round(input.timeoutMs / 1000)} seconds and was stopped. ` +
            'Nothing was recorded. Some versions of the tool stall when another program runs them; ' +
            'if this keeps happening, run the prompt yourself and import the report back.',
        });
        return;
      }
      if (outcome === 'CANCELLED') {
        finish({
          outcome: 'CANCELLED',
          exitCode: code,
          signal: signalName,
          message: 'The research run was cancelled. Nothing was recorded.',
        });
        return;
      }
      if (code === 0) {
        finish({ outcome: 'COMPLETED', exitCode: 0, signal: null, message: 'The research run finished.' });
        return;
      }
      finish({
        outcome: 'FAILED',
        exitCode: code,
        signal: signalName,
        message: `The research tool stopped with an error (exit code ${code ?? 'unknown'}). Nothing was recorded.`,
      });
    });

    // The prompt goes down stdin unless it was written to a file. Either way it
    // never appears on the command line.
    if (promptDelivery === 'stdin') {
      child.stdin.on('error', () => undefined);
      child.stdin.end(input.prompt, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}
