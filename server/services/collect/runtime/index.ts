/**
 * The collection runtime: the rules a batch of pulls runs under, kept pure and
 * clock-injectable so each can be argued with and tested without a network.
 *
 *  - a per-host token bucket (a host's rate is never exceeded, however many
 *    sources share it);
 *  - failure classification: retry timeouts, 429 and 5xx with backoff, never
 *    401/403/410 or a robots disallow;
 *  - isolation: one failing source never stops or delays another;
 *  - checkpoints: an interrupted job resumes after the last committed item and
 *    a duplicate delivery is a no-op;
 *  - SOURCE_UNREACHABLE is a different outcome from NO_MATCHING_RECORDS.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A manual clock: sleeping advances time, so tests never wait. */
export function fakeClock(start = 0): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += Math.max(0, ms);
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

// ---------------------------------------------------------------- rate limit

/** Tokens refill continuously; `acquire` waits until one is available. */
export class TokenBucket {
  #tokens: number;
  #last: number;
  #chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly clock: Clock,
    readonly capacity: number,
    readonly refillPerSecond: number,
  ) {
    if (capacity < 1 || refillPerSecond <= 0) throw new Error('a bucket needs capacity >= 1 and a positive refill rate');
    this.#tokens = capacity;
    this.#last = clock.now();
  }
  #refill(): void {
    const now = this.clock.now();
    this.#tokens = Math.min(this.capacity, this.#tokens + ((now - this.#last) / 1000) * this.refillPerSecond);
    this.#last = now;
  }
  /** Waiters are served strictly in order, so parallel callers cannot overspend. */
  acquire(): Promise<void> {
    const run = this.#chain.then(async () => {
      this.#refill();
      while (this.#tokens < 1) {
        const wait = Math.ceil(((1 - this.#tokens) / this.refillPerSecond) * 1000);
        await this.clock.sleep(Math.max(1, wait));
        this.#refill();
      }
      this.#tokens -= 1;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}

/** One bucket per host. */
export class HostLimiter {
  #buckets = new Map<string, TokenBucket>();
  constructor(
    private readonly clock: Clock,
    private readonly perHost: { capacity: number; refillPerSecond: number } = { capacity: 1, refillPerSecond: 1 },
    private readonly overrides: Record<string, { capacity: number; refillPerSecond: number }> = {},
  ) {}
  acquire(host: string): Promise<void> {
    const key = host.toLowerCase();
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      const cfg = this.overrides[key] ?? this.perHost;
      bucket = new TokenBucket(this.clock, cfg.capacity, cfg.refillPerSecond);
      this.#buckets.set(key, bucket);
    }
    return bucket.acquire();
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

// ------------------------------------------------------------ classification

export type FailureCause =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'GONE'
  | 'NOT_FOUND'
  | 'ROBOTS_DISALLOWED'
  | 'CLIENT_ERROR'
  | 'NO_INTERNET'
  | 'UNKNOWN';

export interface Failure {
  cause: FailureCause;
  retryable: boolean;
  status: number | null;
  message: string;
}

const PERMANENT: ReadonlySet<FailureCause> = new Set(['UNAUTHORIZED', 'FORBIDDEN', 'GONE', 'NOT_FOUND', 'ROBOTS_DISALLOWED', 'CLIENT_ERROR', 'NO_INTERNET']);

/** Only timeouts, 429, 5xx and network resets are temporary. Pure. */
export function classifyFailure(error: unknown): Failure {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  const status = /\bHTTP (\d{3})\b/.exec(message)?.[1] ?? (error as { status?: number } | null)?.status;
  const code = typeof status === 'string' ? Number(status) : typeof status === 'number' ? status : null;
  const make = (cause: FailureCause): Failure => ({ cause, retryable: !PERMANENT.has(cause), status: code, message });
  if (/robots/i.test(message)) return make('ROBOTS_DISALLOWED');
  if (/no internet|ENETUNREACH/i.test(message)) return make('NO_INTERNET');
  if (code !== null) {
    if (code === 401) return make('UNAUTHORIZED');
    if (code === 403) return make('FORBIDDEN');
    if (code === 404) return make('NOT_FOUND');
    if (code === 410) return make('GONE');
    if (code === 429) return make('RATE_LIMITED');
    if (code >= 500) return make('SERVER_ERROR');
    if (code >= 400) return make('CLIENT_ERROR');
  }
  if (/timed out|timeout|ETIMEDOUT|TimeoutError/i.test(message)) return make('TIMEOUT');
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket/i.test(message)) return make('NETWORK');
  return make('UNKNOWN');
}

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseMs: 1000, maxMs: 60_000 };

export function backoffMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  return Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
}

export interface AttemptReport<T> {
  ok: boolean;
  value: T | null;
  attempts: number;
  failure: Failure | null;
}

/** Retry temporary failures with backoff; stop at once on a permanent one. */
export async function withRetry<T>(
  clock: Clock,
  task: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<AttemptReport<T>> {
  let failure: Failure | null = null;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return { ok: true, value: await task(attempt), attempts: attempt, failure: null };
    } catch (error) {
      failure = classifyFailure(error);
      if (!failure.retryable || attempt === policy.maxAttempts) return { ok: false, value: null, attempts: attempt, failure };
      await clock.sleep(backoffMs(attempt, policy));
    }
  }
  return { ok: false, value: null, attempts: policy.maxAttempts, failure };
}

// ------------------------------------------------------------------ outcomes

export type SourceOutcome = 'RECORDS' | 'NO_MATCHING_RECORDS' | 'SOURCE_UNREACHABLE';

/** Reaching a source and finding nothing is not the same as not reaching it. */
export function outcomeOf(report: { ok: boolean }, recordCount: number): SourceOutcome {
  if (!report.ok) return 'SOURCE_UNREACHABLE';
  return recordCount > 0 ? 'RECORDS' : 'NO_MATCHING_RECORDS';
}

// ---------------------------------------------------------------- checkpoints

export interface Checkpoint {
  /** Index of the first item not yet committed. */
  next: number;
  /** Keys already committed, so a redelivered batch writes nothing twice. */
  seen: string[];
}

export interface CheckpointStore {
  load(jobKey: string): Promise<Checkpoint | null>;
  save(jobKey: string, checkpoint: Checkpoint): Promise<void>;
}

export function memoryCheckpoints(): CheckpointStore & { data: Map<string, Checkpoint> } {
  const data = new Map<string, Checkpoint>();
  return {
    data,
    load: async (k) => {
      const c = data.get(k);
      return c ? { next: c.next, seen: [...c.seen] } : null;
    },
    save: async (k, c) => {
      data.set(k, { next: c.next, seen: [...c.seen] });
    },
  };
}

export interface BatchResult {
  committed: number;
  skippedDuplicates: number;
  resumedFrom: number;
  done: boolean;
}

/**
 * Commit items in batches, saving a checkpoint after each. Resuming starts at
 * the checkpoint; an item whose key was already committed is skipped, so a
 * crash between commit and save cannot duplicate it. `stopAfterBatches` lets a
 * test (or a time budget) interrupt a job deterministically.
 */
export async function runCheckpointed<T>(input: {
  jobKey: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  commit: (batch: T[]) => Promise<void>;
  store: CheckpointStore;
  batchSize?: number;
  stopAfterBatches?: number;
}): Promise<BatchResult> {
  const size = Math.max(1, input.batchSize ?? 50);
  const prior = await input.store.load(input.jobKey);
  const seen = new Set(prior?.seen ?? []);
  let next = prior?.next ?? 0;
  const resumedFrom = next;
  let committed = 0;
  let skipped = 0;
  let batches = 0;
  while (next < input.items.length) {
    if (input.stopAfterBatches !== undefined && batches >= input.stopAfterBatches) {
      return { committed, skippedDuplicates: skipped, resumedFrom, done: false };
    }
    const slice = input.items.slice(next, next + size);
    const fresh: T[] = [];
    for (const item of slice) {
      const key = input.keyOf(item);
      if (seen.has(key)) skipped += 1;
      else {
        seen.add(key);
        fresh.push(item);
      }
    }
    if (fresh.length > 0) await input.commit(fresh);
    committed += fresh.length;
    next += slice.length;
    batches += 1;
    await input.store.save(input.jobKey, { next, seen: [...seen] });
  }
  return { committed, skippedDuplicates: skipped, resumedFrom, done: true };
}

// ------------------------------------------------------------------ isolation

export interface SourceTask {
  id: string;
  url: string;
  /** True when collection needs the open internet. */
  needsInternet?: boolean;
  run: () => Promise<{ records: number }>;
}

export interface SourceRun {
  id: string;
  outcome: SourceOutcome | 'REFUSED_NO_INTERNET';
  records: number;
  attempts: number;
  failure: Failure | null;
  waitedMs: number;
}

/**
 * Run source tasks with a per-host bucket and a per-source concurrency of one
 * (tasks for different sources run side by side; raising it is a measured
 * decision, not a default). One source's failure is its own result and never
 * rejects the batch. Internet-dependent work is refused on a surface that has
 * none, instead of being run to a timeout.
 */
export async function runSources(input: {
  tasks: readonly SourceTask[];
  clock: Clock;
  limiter: HostLimiter;
  hasInternet: boolean;
  retry?: RetryPolicy;
  concurrency?: number;
}): Promise<SourceRun[]> {
  const results: SourceRun[] = new Array(input.tasks.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= input.tasks.length) return;
      const task = input.tasks[i]!;
      if (task.needsInternet !== false && !input.hasInternet) {
        results[i] = {
          id: task.id,
          outcome: 'REFUSED_NO_INTERNET',
          records: 0,
          attempts: 0,
          failure: { cause: 'NO_INTERNET', retryable: false, status: null, message: 'this surface has no internet' },
          waitedMs: 0,
        };
        continue;
      }
      const started = input.clock.now();
      let records = 0;
      const report = await withRetry(
        input.clock,
        async () => {
          await input.limiter.acquire(hostOf(task.url));
          const r = await task.run();
          records = r.records;
          return r;
        },
        input.retry,
      );
      results[i] = {
        id: task.id,
        outcome: outcomeOf(report, records),
        records,
        attempts: report.attempts,
        failure: report.failure,
        waitedMs: input.clock.now() - started,
      };
    }
  };
  const n = Math.max(1, Math.min(input.concurrency ?? 4, input.tasks.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
