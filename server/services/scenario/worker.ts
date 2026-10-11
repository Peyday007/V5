/**
 * The thread a run executes on. It receives a definition and options, calls the
 * pure engine, and posts back either the result or the error's shape — an
 * `Error` does not survive `postMessage` with its class, so the class is sent
 * by name and rebuilt on the other side (`isolate.ts`).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runScenarioModel } from './run.ts';
import { ScenarioModelError } from './model.ts';
import { ScenarioRunError } from './engine.ts';
import type { RunOptions, ScenarioModelDefinition } from '../../domain/scenario.ts';

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
