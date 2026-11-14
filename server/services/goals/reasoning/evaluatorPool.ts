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
import type { SweepJob } from '../reconstruction.ts';
import type { ConstructedArrangement, ConstructionJob } from '../../cash/construct.ts';
import { DEFAULT_SWEEP_MS, type VariableSweep } from './variables.ts';

export const MAX_THREADS = 4;
/** An evaluation that takes longer than this on a thread is abandoned and run inline instead. */
export const EVALUATION_TIMEOUT_MS = 60_000;
/** A construction pass on a thread is abandoned and run inline (yielding) after this long. */
export const CONSTRUCTION_TIMEOUT_MS = 120_000;

type PortfolioInput = Parameters<typeof evaluateGoalPortfolio>[0];

export interface Evaluator {
  /** Threads evaluating at once; 1 when inline. */
  readonly threads: number;
  evaluate(input: PortfolioInput): Promise<GoalPortfolio>;
  /** The variable sweep (§102), on a thread when the pool has one: it runs for up to a minute and must not hold the server's loop. */
  sweep(job: SweepJob): Promise<VariableSweep>;
  /**
   * The construction pass (§82): composing and reconstructing up to
   * `MAX_CONSTRUCTIONS` arrangements is seconds of pure quant work, so it runs
   * on a thread like the engine it feeds (§109). Optional so an evaluator
   * written elsewhere need not supply it; a caller without it composes inline.
   */
  construct?(job: ConstructionJob): Promise<ConstructedArrangement[]>;
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
    async sweep(job) {
      const { sweepFor } = await import('../reconstruction.ts');
      return sweepFor(job);
    },
    async construct(job) {
      const { composeConstruction, YIELD_EVERY_MS } = await import('../../cash/construct.ts');
      return composeConstruction(job, YIELD_EVERY_MS);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending = new Map<number, { resolve: (p: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let broken = false;
  let next = 1;
  try {
    for (let i = 0; i < threads; i++) {
      const worker = new Worker(new URL('./evaluator-boot.mjs', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 384 } });
      worker.on('message', (message: { id: number; ok: boolean; result?: unknown; message?: string }) => {
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
  /** One job on one thread; on a thread failure or a timeout, the same job inline — never a lost one. */
  const onThread = async <T>(message: Record<string, unknown>, timeoutMs: number, fallback: () => Promise<T>): Promise<T> => {
    if (broken) return fallback();
    const worker = await take();
    try {
      return await new Promise<T>((resolve, reject) => {
        const id = next++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('timed out on its thread'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, ...message });
      });
    } catch {
      broken = true;
      return fallback();
    } finally {
      give(worker);
    }
  };
  return {
    threads,
    evaluate: (input) => onThread<GoalPortfolio>({ kind: 'evaluate', input }, EVALUATION_TIMEOUT_MS, () => inline.evaluate(input)),
    sweep: (job) => onThread<VariableSweep>({ kind: 'sweep', job }, (job.maxMs ?? DEFAULT_SWEEP_MS) + 120_000, () => inline.sweep(job)),
    construct: (job) => onThread<ConstructedArrangement[]>({ kind: 'construct', job }, CONSTRUCTION_TIMEOUT_MS, () => inline.construct!(job)),
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
    sweep: (job) => s.evaluator.sweep(job),
    construct: (job) => (s.evaluator.construct ? s.evaluator.construct(job) : inlineEvaluator().construct!(job)),
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
