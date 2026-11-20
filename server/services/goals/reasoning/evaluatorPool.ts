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
 * pool none of whose threads can start) evaluates inline, one evaluation per
 * turn of the loop (§63). A pool is opened for one exploration and closed
 * after it, so no idle thread is kept.
 *
 * The loop is never held for more than one evaluation (release check run
 * 44718014146, 2026-11-20: goal wst_db2e2e0e5204477692d5's plan read printed
 * `composed`, then neither a trace nor its 30 s heartbeat for 27 minutes, and
 * its own 6-minute timeout never fired). Two things put the engine on the
 * loop for that long, and neither is allowed any more:
 *
 *  - an evaluation that timed out on its thread was re-run inline — the one
 *    input known to be too heavy for a thread, on the loop, with no budget —
 *    and every timeout also spent the pool's replacement budget, which is
 *    there for threads that cannot boot. On a machine whose cores the server
 *    holds (the check runs at nice 19 beside the freshly deployed server),
 *    healthy threads time out, three timeouts leave the pool threadless, and
 *    every later evaluation of the read ran inline. Now a slow thread is
 *    replaced without counting against that budget, its evaluation is retried
 *    once on a thread, and a second fault is the evaluation's error: the read
 *    degrades (`reconstructionFor` records it), it does not stall;
 *  - inline evaluations "yielded first" with one `setImmediate` each, but an
 *    exploration asks for a chunk of them at once (`exploreDirections`'
 *    `inChunks`), so every one of them resumed in the same check phase and
 *    the chunk ran as one block, timers starved for all of it. Inline
 *    evaluations are now queued: each waits for its own turn of the loop.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { evaluateGoalPortfolio, type GoalPortfolio } from '../portfolio.ts';
import type { SweepJob } from '../reconstruction.ts';
import type { ConstructedArrangement, ConstructionJob } from '../../cash/construct.ts';
import { DEFAULT_SWEEP_MS, type VariableSweep } from './variables.ts';

export const MAX_THREADS = 4;
/**
 * An evaluation that takes longer than this on a thread is abandoned: its thread is replaced and the evaluation is
 * retried once on a thread; never on the server's loop.
 */
export const EVALUATION_TIMEOUT_MS = 60_000;
/** How many times one evaluation is tried on a thread before its fault is the evaluation's error. */
export const EVALUATION_ATTEMPTS = 2;
/**
 * At most this many threads that failed (crashed, or could not boot) are replaced in REPLACEMENT_WINDOW_MS; past it
 * the pool runs short instead of respawning for ever. A thread replaced because it was slow does not count: it booted.
 */
export const REPLACEMENTS_PER_WINDOW = 3;
export const REPLACEMENT_WINDOW_MS = 10 * 60_000;
/** The errors that mean the thread itself is unusable, not that one evaluation failed. */
const THREAD_FAULT = /timed out on its thread|its thread failed/;
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

/**
 * Inline evaluations, one per turn of the loop, across every inline evaluator in the process. Each waits for the one
 * before it and then for a `setImmediate` of its own, scheduled only once its predecessor has finished: an immediate
 * queued while the check phase runs is deferred to the next iteration, so timers, sockets and heartbeats run between
 * any two evaluations however many were asked for at once.
 */
let inlineTurn: Promise<unknown> = Promise.resolve();
function onItsOwnTurn<T>(work: () => T): Promise<T> {
  const run = inlineTurn.then(() => new Promise<void>((resolve) => setImmediate(resolve))).then(work);
  inlineTurn = run.catch(() => undefined);
  return run;
}

/** Inline: the engine on this loop, one evaluation per turn of it. */
export function inlineEvaluator(): Evaluator {
  return {
    threads: 1,
    evaluate(input) {
      return onItsOwnTurn(() => evaluateGoalPortfolio(input));
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

const NO_THREAD = 'no evaluation thread is running';

/** A pool of `threads` workers; inline when threads is 0 or the pool cannot start. */
export function openEvaluator(threads = threadsAvailable(), options: { evaluationTimeoutMs?: number } = {}): Evaluator {
  if (threads <= 0) return inlineEvaluator();
  const evaluationTimeoutMs = options.evaluationTimeoutMs ?? EVALUATION_TIMEOUT_MS;
  const inline = inlineEvaluator();
  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const waiting: Array<() => void> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending = new Map<number, { resolve: (p: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; worker: Worker }>();
  let next = 1;
  let closed = false;
  /** Threads that failed or timed out: terminated, and replaced. */
  const dead = new Set<Worker>();
  const replaced: number[] = [];
  const spawn = (): Worker => {
    const worker = new Worker(new URL('./evaluator-boot.mjs', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 384 } });
    worker.on('message', (message: { id: number; ok: boolean; result?: unknown; message?: string }) => {
      const job = pending.get(message.id);
      if (!job) return;
      pending.delete(message.id);
      clearTimeout(job.timer);
      if (message.ok) job.resolve(message.result!);
      else job.reject(new Error(message.message ?? 'evaluation failed'));
    });
    worker.on('error', () => retire(worker, true));
    worker.unref();
    workers.push(worker);
    return worker;
  };
  /**
   * C-12: a thread that failed or timed out is terminated and replaced, so one slow evaluation never sends every later
   * one — a minute-long sweep included — onto the server's own loop. Only a thread that `failed` (crashed, or could
   * not boot) counts against REPLACEMENTS_PER_WINDOW: a thread that was merely slow had booted, and counting it let
   * three timeouts on a contended machine leave the pool with no thread at all (2026-11-20).
   */
  const retire = (worker: Worker, failed: boolean): void => {
    if (dead.has(worker)) return;
    dead.add(worker);
    for (const [id, job] of pending) {
      if (job.worker !== worker) continue;
      pending.delete(id);
      clearTimeout(job.timer);
      job.reject(new Error('its thread failed'));
    }
    const at = idle.indexOf(worker);
    if (at >= 0) idle.splice(at, 1);
    const listed = workers.indexOf(worker);
    if (listed >= 0) workers.splice(listed, 1);
    void worker.terminate().catch(() => 0);
    if (closed) return;
    // A thread that cannot boot would otherwise fail, be replaced and fail again for ever (review F6):
    // at most REPLACEMENTS_PER_WINDOW replacements of failed threads in a window, then the pool runs a thread short.
    if (failed) {
      const now = Date.now();
      while (replaced.length && now - replaced[0]! > REPLACEMENT_WINDOW_MS) replaced.shift();
      if (replaced.length >= REPLACEMENTS_PER_WINDOW) {
        if (workers.length === 0) for (const wake of waiting.splice(0)) wake();
        return;
      }
      replaced.push(now);
    }
    try {
      idle.push(spawn());
      waiting.shift()?.();
    } catch {
      // No replacement could start: the pool is one thread smaller, and with none left a waiting caller is told so.
      if (workers.length === 0) for (const wake of waiting.splice(0)) wake();
    }
  };
  try {
    for (let i = 0; i < threads; i++) idle.push(spawn());
  } catch {
    for (const w of workers) void w.terminate();
    return inline;
  }
  const take = async (): Promise<Worker | null> => {
    while (idle.length === 0) {
      if (workers.length === 0 || workers.every((w) => dead.has(w))) return null;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    return idle.pop()!;
  };
  const give = (w: Worker) => {
    if (dead.has(w)) return;
    idle.push(w);
    waiting.shift()?.();
  };
  /** One job on one thread. On a failure or timeout the thread is replaced, and `fallback` decides what the caller gets. */
  const onThread = async <T>(message: Record<string, unknown>, timeoutMs: number, fallback: (error: Error) => Promise<T>): Promise<T> => {
    const worker = await take();
    if (!worker) return fallback(new Error(NO_THREAD));
    try {
      return await new Promise<T>((resolve, reject) => {
        const id = next++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('timed out on its thread'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, worker });
        worker.postMessage({ id, ...message });
      });
    } catch (error) {
      // Only a thread that timed out or died is replaced; an evaluation that answered with an error leaves a
      // healthy thread in the pool (review F6). A thread that died was retired, as failed, by its 'error' event.
      if (THREAD_FAULT.test((error as Error).message)) retire(worker, false);
      return fallback(error as Error);
    } finally {
      give(worker);
    }
  };
  return {
    threads,
    /*
     * A thread fault (a timeout, a crash) is retried on a thread, and after EVALUATION_ATTEMPTS it is the
     * evaluation's error — never a rerun on this loop of the very input a thread could not finish. Only a pool none of
     * whose threads can run evaluates inline, one evaluation per turn of the loop.
     */
    evaluate: async (input) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await onThread<GoalPortfolio>({ kind: 'evaluate', input }, evaluationTimeoutMs, (error) => Promise.reject(error));
        } catch (error) {
          const message = (error as Error).message;
          if (message === NO_THREAD) return inline.evaluate(input);
          if (!THREAD_FAULT.test(message)) throw error;
          if (attempt >= EVALUATION_ATTEMPTS) throw new Error(`evaluation abandoned after ${attempt} attempts on a thread: ${message}`);
        }
      }
    },
    // A sweep is never run inline: it holds a loop for up to a minute. A failed one is no sweep, and the plan reads without it.
    sweep: (job) => onThread<VariableSweep>({ kind: 'sweep', job }, (job.maxMs ?? DEFAULT_SWEEP_MS) + 120_000, (error) => Promise.reject(new Error(`variable sweep abandoned: ${error.message}`))),
    // A failed construction is composed inline, handing the loop back every 25 ms (§109): its result is the plan's arrangements.
    construct: (job) => onThread<ConstructedArrangement[]>({ kind: 'construct', job }, CONSTRUCTION_TIMEOUT_MS, () => inline.construct!(job)),
    async close() {
      closed = true;
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
