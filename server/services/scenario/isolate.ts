/**
 * Where a run executes: on a worker thread, never on the request's own loop.
 *
 * The engine is synchronous and bounded at 50,000 evaluations and a 20 s
 * budget. Bounded is not the same as harmless: run inline, a large model held
 * Node's one event loop for the whole of that budget, and nothing else in the
 * process — `/mcp`, `/oauth/token`, heartbeats, the dispatch tick — was served
 * meanwhile. A client that gives up at 60 s then reports a connector that was
 * up as down (CLAUDE.md §20, §53). So a run gets a thread of its own, which the
 * main loop terminates outright if it overruns the budget, and a process runs
 * at most one at a time: a second request is refused as busy rather than
 * queued, because a queue of runs is a second way to hold the process.
 *
 * The engine stays pure and is unchanged; this module only decides where it
 * runs. A refusal here is never recorded as a run — nothing was evaluated.
 */
import { Worker } from 'node:worker_threads';
import { SCENARIO_LIMITS, type RunOptions, type ScenarioModelDefinition, type ScenarioResult } from '../../domain/scenario.ts';
import { ScenarioModelError } from './model.ts';
import { ScenarioRunError } from './engine.ts';

/** Runs in flight in this process at once. */
export const MAX_CONCURRENT_RUNS = 1;

/** Past the engine's own budget, how long the thread may take to start and answer before it is ended. */
export const WORKER_GRACE_MS = 10_000;

/** Another run is already using this process's one slot. Nothing was evaluated. */
export class ScenarioBusyError extends Error {
  constructor() {
    super('Another scenario run is in progress on this Brain. Nothing was run; try again in a few seconds.');
  }
}

let inFlight = 0;

export function runsInFlight(): number {
  return inFlight;
}

/** Take the one slot, or refuse as busy. Release it with the returned function. */
export function claimRunSlot(): () => void {
  if (inFlight >= MAX_CONCURRENT_RUNS) throw new ScenarioBusyError();
  inFlight++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      inFlight--;
    }
  };
}

/** Run the engine on its own thread. The caller holds a slot. */
export function runOnWorker(definition: ScenarioModelDefinition, options: RunOptions): Promise<ScenarioResult> {
  return new Promise<ScenarioResult>((resolve, reject) => {
    // A plain `.mjs` entry, because a worker does not inherit the main thread's
    // TypeScript loader: it registers tsx and then imports worker.ts.
    const worker = new Worker(new URL('./worker-boot.mjs', import.meta.url), {
      workerData: { definition, options },
      resourceLimits: { maxOldGenerationSizeMb: 768 },
    });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new ScenarioRunError(`The run passed its ${SCENARIO_LIMITS.maxRunMs / 1000}s budget and its thread was stopped rather than left running.`)));
    }, SCENARIO_LIMITS.maxRunMs + WORKER_GRACE_MS);
    worker.once('message', (message: { ok: true; result: ScenarioResult } | { ok: false; kind: 'MODEL' | 'RUN' | 'OTHER'; message: string; problems?: string[] }) => {
      settle(() => {
        if (message.ok) resolve(message.result);
        else if (message.kind === 'MODEL') reject(new ScenarioModelError(message.problems ?? [message.message]));
        else if (message.kind === 'RUN') reject(new ScenarioRunError(message.message));
        else reject(new Error(message.message));
      });
    });
    worker.once('error', (error) => {
      settle(() => reject(
        (error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new ScenarioRunError('The run needed more memory than a scenario run is allowed, and was stopped.')
          : error,
      ));
    });
    worker.once('exit', (code) => {
      settle(() => reject(new ScenarioRunError(`The run's thread ended (code ${code}) without an answer.`)));
    });
  });
}

/** Claim the slot, run on a worker, release. Throws `ScenarioBusyError` when the slot is taken. */
export async function runIsolated(definition: ScenarioModelDefinition, options: RunOptions): Promise<ScenarioResult> {
  const release = claimRunSlot();
  try {
    return await runOnWorker(definition, options);
  } finally {
    release();
  }
}
