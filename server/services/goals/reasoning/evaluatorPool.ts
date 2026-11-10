/**
 * Concurrent evaluation for multidirectional reasoning (§101).
 *
 * Every line of exploration is judged by the one engine every plan uses
 * (`evaluateGoalPortfolio`). That engine is synchronous, so on the main loop
 * a hundred directions would run one after another and hold the server. The
 * pool runs them on as many niced worker threads as the machine has spare
 * cores, so different explorations are evaluated at the same time, and the
 * server keeps answering while they run.
 *
 * Capacity is read, not configured: `availableParallelism() - 1` threads,
 * at least one and at most `MAX_THREADS`; `BRAIN_REASONING_THREADS=0` (or a
 * pool that cannot start) evaluates inline, yielding between evaluations
 * (§63). A pool is opened for one exploration and closed after it, so no
 * idle thread is kept.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { evaluateGoalPortfolio, type GoalPortfolio } from '../portfolio.ts';

export const MAX_THREADS = 4;
/** An evaluation that takes longer than this on a thread is abandoned and run inline instead. */
export const EVALUATION_TIMEOUT_MS = 60_000;

type PortfolioInput = Parameters<typeof evaluateGoalPortfolio>[0];

export interface Evaluator {
  /** Threads evaluating at once; 1 when inline. */
  readonly threads: number;
  evaluate(input: PortfolioInput): Promise<GoalPortfolio>;
  close(): Promise<void>;
}

export function threadsAvailable(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['BRAIN_REASONING_THREADS'];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(MAX_THREADS, Math.trunc(n));
  }
  let cores = 1;
  try {
    cores = availableParallelism();
  } catch {
    cores = 1;
  }
  return Math.max(1, Math.min(MAX_THREADS, cores - 1));
}

/** Inline: the engine on this loop, yielding between evaluations. */
export function inlineEvaluator(): Evaluator {
  return {
    threads: 1,
    async evaluate(input) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return evaluateGoalPortfolio(input);
    },
    async close() {},
  };
}

/** A pool of `threads` workers; inline when threads is 0 or the pool cannot start. */
export function openEvaluator(threads = threadsAvailable()): Evaluator {
  if (threads <= 0) return inlineEvaluator();
  const inline = inlineEvaluator();
  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const waiting: Array<() => void> = [];
  const pending = new Map<number, { resolve: (p: GoalPortfolio) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let broken = false;
  let next = 1;
  try {
    for (let i = 0; i < threads; i++) {
      const worker = new Worker(new URL('./evaluator-boot.mjs', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 384 } });
      worker.on('message', (message: { id: number; ok: boolean; result?: GoalPortfolio; message?: string }) => {
        const job = pending.get(message.id);
        if (!job) return;
        pending.delete(message.id);
        clearTimeout(job.timer);
        if (message.ok) job.resolve(message.result!);
        else job.reject(new Error(message.message ?? 'evaluation failed'));
      });
      worker.on('error', () => {
        broken = true;
      });
      worker.unref();
      workers.push(worker);
      idle.push(worker);
    }
  } catch {
    for (const w of workers) void w.terminate();
    return inline;
  }
  const take = async (): Promise<Worker> => {
    while (idle.length === 0) await new Promise<void>((resolve) => waiting.push(resolve));
    return idle.pop()!;
  };
  const give = (w: Worker) => {
    idle.push(w);
    waiting.shift()?.();
  };
  return {
    threads,
    async evaluate(input) {
      if (broken) return inline.evaluate(input);
      const worker = await take();
      try {
        return await new Promise<GoalPortfolio>((resolve, reject) => {
          const id = next++;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('evaluation timed out on its thread'));
          }, EVALUATION_TIMEOUT_MS);
          pending.set(id, { resolve, reject, timer });
          worker.postMessage({ id, input });
        });
      } catch {
        // A thread that failed or could not take the input: the same evaluation inline, never a lost one.
        broken = true;
        return inline.evaluate(input);
      } finally {
        give(worker);
      }
    },
    async close() {
      for (const job of pending.values()) clearTimeout(job.timer);
      await Promise.all(workers.map((w) => w.terminate().catch(() => 0)));
    },
  };
}

/** Idle this long, the shared pool's threads are ended; the next exploration starts them again. */
export const SHARED_IDLE_MS = 60_000;
let shared: { evaluator: Evaluator; busy: number; timer: NodeJS.Timeout | null } | null = null;

/**
 * The process's shared pool: a thread costs a second or two to start (it
 * loads the TypeScript loader and the engine), so successive plan reads share
 * one pool instead of each starting its own. Its `close` releases this
 * reader's hold; the threads end after `SHARED_IDLE_MS` with no reader.
 */
export function sharedEvaluator(): Evaluator {
  if (!shared) shared = { evaluator: openEvaluator(), busy: 0, timer: null };
  const s = shared;
  s.busy++;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  let released = false;
  return {
    threads: s.evaluator.threads,
    evaluate: (input) => s.evaluator.evaluate(input),
    async close() {
      if (released) return;
      released = true;
      s.busy--;
      if (s.busy === 0) {
        s.timer = setTimeout(() => {
          if (shared === s && s.busy === 0) {
            shared = null;
            void s.evaluator.close();
          }
        }, SHARED_IDLE_MS);
        s.timer.unref();
      }
    },
  };
}
