/**
 * A coding worker as a process on this machine.
 *
 * The surface is the Claude Code CLI in print mode: one process, one worktree,
 * one assignment, one session. It is the executor the factory can prove things
 * with, because everything it does is observable from outside — the process
 * exits, the worktree has commits or it does not, and the repository is the
 * record either way.
 *
 * Four properties worth keeping while editing this file:
 *
 *   * **No paid model API is activated, structurally.** The child's environment
 *     has every API-key variable removed, so a worker cannot be run on a paid
 *     key even by accident. The surface authenticates the way the session that
 *     launched it does, against the subscription already in place. This is not a
 *     promise in a comment; it is the `env` object below.
 *
 *   * **Every execution gets its own session id.** Passed explicitly and with
 *     the inherited one removed, because review independence is decided on
 *     recorded session identity and two executions that reported the same
 *     session would make a self-review look like an independent one.
 *
 *   * **The worker's reply is a summary, never a result.** What the factory does
 *     with it is store it. Whether the unit succeeded is decided from the
 *     branch, the diff and the verification commands.
 *
 *   * **A rate limit is not a failure.** It comes back as `RATE_LIMITED` with a
 *     retry point, and the caller defers the unit instead of spending one of its
 *     attempts on a condition that was never about the work.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { FactoryUsage } from '../../../domain/factory.ts';
import type { ExecutionRequest, ExecutionResult, Executor } from './index.ts';

/** What the CLI prints with `--output-format json`, as much of it as is used. */
interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  num_turns?: number;
  duration_ms?: number;
  api_error_status?: string | number | null;
  permission_denials?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Variables that would point the surface at a paid API.
 *
 * Removed from every child, whether or not they are set here. The guarantee the
 * assignment asks for — no paid model API activated — is then a property of the
 * spawn rather than of an operator remembering.
 */
const PAID_API_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/**
 * The default tool allowance for an implementation worker.
 *
 * Narrow on purpose, and narrow in a way that matches what a unit is for: read
 * and write inside its own worktree, search it, and run the repository's own
 * tooling. There is no `Bash(*)`, no network fetch and no git push — a worker
 * publishing its own branch would be a worker deciding what the factory
 * delivers.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'TodoWrite',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(npm run:*)',
  'Bash(npm test:*)',
  'Bash(npx:*)',
  'Bash(node:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(grep:*)',
  'Bash(find:*)',
  'Bash(wc:*)',
  'Bash(sed:*)',
  'Bash(mkdir:*)',
  'Bash(python3:*)',
];

/** Which binary to run. A seam for tests and for an operator with a custom path. */
export function cliPath(): string {
  return process.env.BRAIN_FACTORY_CLI ?? 'claude';
}

/**
 * The CLI prints warnings before its JSON. Take the JSON.
 *
 * Scanning for the first line that opens an object is deliberate rather than
 * lazy: a surface that adds a new diagnostic line should not turn every worker
 * into a parse failure, and a parse failure here would read as a worker error.
 */
export function parseCliOutput(stdout: string): CliResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  for (let from = start; from !== -1; from = trimmed.indexOf('\n{', from + 1)) {
    const candidate = trimmed.slice(from === start ? from : from + 1);
    try {
      return JSON.parse(candidate) as CliResult;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Did the surface refuse because of its allowance rather than because of the work?
 *
 * Read from the surface's own words, and conservative: a genuine failure
 * mistaken for a rate limit defers a unit that should have been repaired, which
 * is recoverable; a rate limit mistaken for a failure spends an attempt and
 * eventually retires a unit that was never broken, which is not.
 */
export function looksRateLimited(text: string, apiStatus: string | number | null): boolean {
  if (apiStatus === 429 || apiStatus === '429') return true;
  return /rate limit|usage limit|too many requests|quota exceeded|overloaded|capacity constraints/i.test(
    text,
  );
}

/** How long to wait, when the surface did not say. */
const DEFAULT_RETRY_AFTER_MS = 5 * 60 * 1000;

export function retryAfterFrom(text: string): number {
  const seconds = /retry[- ]after[:\s]+(\d+)/i.exec(text);
  if (seconds?.[1]) return Math.min(60 * 60 * 1000, Number(seconds[1]) * 1000);
  const minutes = /(\d+)\s*minutes?/i.exec(text);
  if (minutes?.[1]) return Math.min(60 * 60 * 1000, Number(minutes[1]) * 60 * 1000);
  return DEFAULT_RETRY_AFTER_MS;
}

function usageFrom(result: CliResult | null): FactoryUsage | null {
  const usage = result?.usage;
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

const MAX_LOG_BYTES = 1024 * 1024;

export const localCliExecutor: Executor = {
  kind: 'LOCAL_CLI',

  async probe(): Promise<{ ok: boolean; detail: string }> {
    return await new Promise((resolve) => {
      const child = spawn(cliPath(), ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.on('error', (error: Error) => {
        resolve({ ok: false, detail: `The coding CLI is not runnable here: ${error.message}` });
      });
      child.on('close', (code) => {
        if (code === 0) resolve({ ok: true, detail: out.trim() });
        else resolve({ ok: false, detail: `The coding CLI exited ${code} on --version.` });
      });
      setTimeout(() => child.kill('SIGKILL'), 30_000);
    });
  },

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startedAt = Date.now();
    // A fresh session identity per execution, so lineage is real.
    const externalSessionId = randomUUID();

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (PAID_API_VARIABLES.includes(key)) continue;
      // The parent's session identity must not become the child's.
      if (key === 'CLAUDE_CODE_SESSION_ID') continue;
      env[key] = value;
    }

    const args = [
      '-p',
      request.assignment,
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--model',
      request.model,
      '--session-id',
      externalSessionId,
      '--allowedTools',
      ...(request.allowedTools ?? DEFAULT_ALLOWED_TOOLS),
    ];

    const { stdout, stderr, exitCode, timedOut } = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
    }>((resolve) => {
      const child = spawn(cliPath(), args, {
        cwd: request.worktreePath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, request.timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (out.length < MAX_LOG_BYTES) out += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (err.length < MAX_LOG_BYTES) err += chunk.toString('utf8');
      });
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        resolve({ stdout: out, stderr: `${err}${error.message}`, exitCode: -1, timedOut: killed });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout: out, stderr: err, exitCode: code ?? -1, timedOut: killed });
      });
    });

    const durationMs = Date.now() - startedAt;
    const parsed = parseCliOutput(stdout);
    const rawLog = `${stdout}\n--- stderr ---\n${stderr}`.slice(0, MAX_LOG_BYTES);
    const combined = `${parsed?.result ?? ''}\n${stderr}`;

    const base = {
      // The id the factory generated and passed in, which is what it recorded —
      // not whatever the surface echoed back.
      externalSessionId,
      rawLog,
      durationMs,
      numTurns: parsed?.num_turns ?? null,
      usage: usageFrom(parsed),
      paidApi: false,
    };

    if (timedOut) {
      return {
        ...base,
        outcome: 'TIMEOUT',
        summary: '',
        retryAfterMs: null,
        detail: `The worker did not finish within ${Math.round(request.timeoutMs / 1000)}s and was stopped.`,
      };
    }

    if (looksRateLimited(combined, parsed?.api_error_status ?? null)) {
      return {
        ...base,
        outcome: 'RATE_LIMITED',
        summary: (parsed?.result ?? '').slice(0, 2000),
        retryAfterMs: retryAfterFrom(combined),
        detail: 'The provider refused the session. Backpressure, not a failure.',
      };
    }

    if (exitCode !== 0 || !parsed || parsed.is_error) {
      return {
        ...base,
        outcome: 'ERROR',
        summary: (parsed?.result ?? '').slice(0, 2000),
        retryAfterMs: null,
        detail:
          parsed?.result?.slice(0, 1000) ??
          (stderr.trim() || `The worker exited ${exitCode} without a parsable result.`).slice(
            0,
            1000,
          ),
      };
    }

    return {
      ...base,
      outcome: 'COMPLETED',
      summary: (parsed.result ?? '').slice(0, 8000),
      retryAfterMs: null,
      detail: `${parsed.subtype ?? 'success'} in ${parsed.num_turns ?? '?'} turns`,
    };
  },
};
