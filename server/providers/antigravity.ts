/**
 * The Antigravity provider (section 2).
 *
 * Runs a research prompt through the locally installed automation CLI and
 * returns what it produced. Three rules shape everything below.
 *
 * It never pretends. Every call first asks the capability probe whether the work
 * is possible, and refuses with the specific reason when it is not — a user who
 * believes real research happened when it did not is worse off than one who was
 * told to run it themselves, so the refusal carries the copy-the-prompt path.
 *
 * It never hangs. `agy -p` is known to stall when its stdout is a pipe
 * (antigravity-cli issue #318), which is exactly how Brain calls it, so a hard
 * timeout that kills the whole process tree is load-bearing rather than
 * defensive. A stall becomes a reported failure in a bounded time.
 *
 * It never leaks. Local paths, environment and raw diagnostic dumps stay on the
 * server; what crosses to the browser is a sentence a person can act on.
 */
import type {
  AIProvider,
  AuditRequest,
  AuditResponse,
  ChatRequest,
  ChatResponse,
  ProviderStatus,
  ResearchRequest,
  ResearchResponse,
  ResearchRunOptions,
} from './types.ts';
import { COPY_PROMPT_FALLBACK } from './types.ts';
import { antigravityStatus, readQuotaDetail, type AntigravityStatus } from './antigravity/runtime.ts';
import { runAntigravityJob, type JobResult } from './antigravity/process.ts';
import { createJob, sha256, writeExecutionLog, type ExecutionLog } from './antigravity/jobs.ts';

/** Raised for anything Antigravity cannot currently do. Never a silent fallback. */
export class AntigravityUnavailableError extends Error {
  readonly status: AntigravityStatus;

  constructor(status: AntigravityStatus) {
    super(status.message);
    this.name = 'AntigravityUnavailableError';
    this.status = status;
  }
}

/** Raised when the run started but did not produce a usable report. */
export class AntigravityRunError extends Error {
  readonly outcome: JobResult['outcome'];
  readonly jobId: string;

  constructor(outcome: JobResult['outcome'], jobId: string, message: string) {
    super(message);
    this.name = 'AntigravityRunError';
    this.outcome = outcome;
    this.jobId = jobId;
  }
}

/** Default ceiling for one research job. Deep research is slow; hanging is not. */
export const DEFAULT_RESEARCH_TIMEOUT_MS = 15 * 60 * 1000;

function timeoutMs(): number {
  const raw = (process.env['BRAIN_ANTIGRAVITY_TIMEOUT_MS'] ?? '').trim();
  const parsed = Number(raw);
  if (raw.length === 0 || !Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESEARCH_TIMEOUT_MS;
  return Math.min(60 * 60 * 1000, Math.max(30_000, Math.floor(parsed)));
}

/**
 * The non-interactive invocation.
 *
 * `-p` is the documented print mode: run the prompt once and exit. The prompt is
 * not among these arguments — it goes over stdin — so nothing a document
 * contains can become part of the command.
 */
function baseArgs(model: string | null): string[] {
  const args = ['-p'];
  if (model) args.push('--model', model);
  return args;
}

/**
 * One research job at a time (section 2).
 *
 * Two deep-research runs against the same local tool compete for the same
 * account, the same rate limit and the same machine, and the second one usually
 * makes the first slower rather than finishing sooner. Extra jobs queue and run
 * in the order they were asked for.
 */
let active: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = active.then(work, work);
  // Keep the chain alive after a rejection; the caller still gets the error.
  active = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export class AntigravityProvider implements AIProvider {
  readonly name = 'antigravity';

  /** True only when every stage of the probe passed. */
  #usable(status: AntigravityStatus): boolean {
    return (
      status.installed &&
      status.authenticated &&
      status.automationReady &&
      status.quotaState !== 'exhausted'
    );
  }

  #require(): { status: AntigravityStatus; command: string } {
    const probe = antigravityStatus();
    if (!this.#usable(probe.status) || !probe.diagnostics.executable.command) {
      throw new AntigravityUnavailableError(probe.status);
    }
    return { status: probe.status, command: probe.diagnostics.executable.command };
  }

  async chat(_request: ChatRequest): Promise<ChatResponse> {
    throw new AntigravityUnavailableError(antigravityStatus().status);
  }

  async audit(_request: AuditRequest): Promise<AuditResponse> {
    // Audits go through Brain's own multi-pass engine against a provider that
    // returns structured JSON. Wiring this one in is the next checkpoint.
    throw new AntigravityUnavailableError(antigravityStatus().status);
  }

  /**
   * Run one research prompt end to end.
   *
   * Everything about the attempt is recorded before anything is returned, so a
   * timeout and a success leave the same quality of trail.
   */
  async runResearch(
    request: ResearchRequest,
    options: ResearchRunOptions = {},
  ): Promise<ResearchResponse> {
    // Availability is checked before queueing: making someone wait behind
    // another job only to be told the tool is not installed is the wrong order.
    this.#require();
    return await serialize(() => this.#runOne(request, options));
  }

  async #runOne(
    request: ResearchRequest,
    options: ResearchRunOptions,
  ): Promise<ResearchResponse> {
    const { status, command } = this.#require();
    const probe = antigravityStatus();
    const job = createJob(options.runId ?? 'adhoc');
    const args = baseArgs(request.model ?? status.model ?? null);
    const startedAt = new Date().toISOString();

    const result = await runAntigravityJob({
      command,
      args,
      prompt: request.prompt,
      jobDir: job.directory,
      timeoutMs: timeoutMs(),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onOutput ? { onOutput: options.onOutput } : {}),
      // The CLI has no documented prompt-file flag, so large prompts still go
      // over stdin rather than being guessed onto the command line.
      promptFileFlag: null,
    });

    const log: ExecutionLog = {
      runId: options.runId ?? 'adhoc',
      jobId: job.jobId,
      provider: this.name,
      providerVersion: probe.diagnostics.executable.version,
      model: request.model ?? status.model ?? null,
      promptSha256: sha256(request.prompt),
      promptBytes: Buffer.byteLength(request.prompt),
      promptDelivery: result.promptDelivery,
      command,
      args,
      outcome: result.outcome,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      truncated: result.truncated,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    writeExecutionLog(job, log, result);

    if (result.outcome !== 'COMPLETED') {
      throw new AntigravityRunError(result.outcome, job.jobId, result.message);
    }

    const text = result.stdout.trim();
    if (text.length === 0) {
      // Exit zero with nothing on stdout is the shape of the known headless
      // stall, and an empty report must never be filed as research.
      throw new AntigravityRunError(
        'FAILED',
        job.jobId,
        'The research tool finished without producing a report. Nothing was recorded. ' +
          'Run the prompt yourself and import the result if this persists.',
      );
    }

    return {
      text,
      externalResponseId: job.jobId,
      model: log.model,
    };
  }

  getStatus(): ProviderStatus {
    const probe = antigravityStatus();
    const status = probe.status;
    const usable = this.#usable(status);
    return {
      name: this.name,
      available: usable,
      reason: usable ? status.message : `${status.message} ${COPY_PROMPT_FALLBACK}`,
      model: status.model,
      // Research is what this provider does. Chat and audit still belong to the
      // providers that return structured output for them.
      capabilities: { chat: false, research: usable, audit: false },
      quota: readQuotaDetail(probe.diagnostics.rawExcerpt ?? ''),
    };
  }
}
