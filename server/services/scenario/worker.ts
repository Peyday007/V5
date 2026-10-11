/**
 * The thread a run executes on. It receives a definition and options, calls the
 * pure engine, and posts back either the result or the error's shape — an
 * `Error` does not survive `postMessage` with its class, so the class is sent
 * by name and rebuilt on the other side (`isolate.ts`).
 */
import { setPriority } from 'node:os';
import { parentPort, workerData } from 'node:worker_threads';
import { runScenarioModel } from './run.ts';
import { ScenarioModelError } from './model.ts';
import { ScenarioRunError } from './engine.ts';
import type { RunOptions, ScenarioModelDefinition } from '../../domain/scenario.ts';

// Yield the CPU to the server. On Linux niceness is per thread, so this lowers
// only this run's thread: on the one shared vCPU production runs, the main
// thread then wins every contended slice and keeps answering while a run
// executes. Measured on deploy 439: without it, a run on a throttled CPU took
// /healthz to 8.4 s. Best effort — a platform that refuses it changes nothing.
try {
  setPriority(19);
} catch {
  /* not permitted here; the run still executes */
}

const { definition, options } = workerData as { definition: ScenarioModelDefinition; options: RunOptions };

try {
  parentPort!.postMessage({ ok: true, result: runScenarioModel(definition, options) });
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    kind: error instanceof ScenarioModelError ? 'MODEL' : error instanceof ScenarioRunError ? 'RUN' : 'OTHER',
    message: error instanceof Error ? error.message : String(error),
    problems: error instanceof ScenarioModelError ? error.problems : undefined,
  });
}
