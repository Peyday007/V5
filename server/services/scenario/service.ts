/**
 * Saving models and running them, with the run written down first.
 *
 * A run is recorded `RUNNING` with its full configuration before the engine
 * starts, and finished `COMPLETE` or `FAILED` after — guarded on `RUNNING`, so
 * a finished run is never rewritten. A process that dies mid-run leaves a
 * `RUNNING` row, which the read path reports as interrupted rather than as
 * working; re-running it is safe because the engine is pure and the same
 * configuration produces the same digest.
 *
 * The engine runs on a worker thread, never on the request's own loop, and a
 * process runs one at a time (`isolate.ts`): bounded is not harmless, and a
 * 20 s synchronous run would hold every other request in the process. A run
 * refused as busy is refused before its row is written — nothing was run.
 */
import { ENGINE_VERSION, SCENARIO_LIMITS, type RunOptions, type ScenarioModelDefinition, type ScenarioResult } from '../../domain/scenario.ts';
import {
  finishScenarioRun,
  getScenarioRun,
  insertScenarioModel,
  insertScenarioRun,
  updateScenarioModel,
  getScenarioModel,
  type ScenarioModelRecord,
  type ScenarioRunRecord,
} from '../../repos/scenario.ts';
import { canonicalJson, compileModel, sha256 } from './model.ts';
import { resultDigest, runConfigHash } from './run.ts';
import { claimRunSlot, runIsolated, runOnWorker } from './isolate.ts';
import { DEMONSTRATION_EVALUATIONS, DEMONSTRATION_SEED, demonstrationModel } from './demo.ts';

/** A RUNNING row older than this belonged to a process that is gone. */
export const INTERRUPTED_AFTER_MS = 5 * 60 * 1000;

export type RunReading = 'RUNNING' | 'COMPLETE' | 'FAILED' | 'INTERRUPTED';

export function readRunState(run: Pick<ScenarioRunRecord, 'state' | 'startedAt'>, now = Date.now()): RunReading {
  if (run.state === 'RUNNING' && now - Date.parse(run.startedAt) > INTERRUPTED_AFTER_MS) return 'INTERRUPTED';
  return run.state;
}

export async function saveModel(input: { projectId: string; definition: ScenarioModelDefinition; createdById: string }): Promise<ScenarioModelRecord> {
  const compiled = compileModel(input.definition);
  return await insertScenarioModel({
    projectId: input.projectId,
    title: input.definition.title,
    definition: input.definition,
    definitionHash: compiled.hash,
    illustrative: input.definition.illustrative === true,
    createdById: input.createdById,
  });
}

export async function reviseModel(modelId: string, definition: ScenarioModelDefinition): Promise<ScenarioModelRecord | null> {
  const compiled = compileModel(definition);
  const changed = await updateScenarioModel(modelId, { title: definition.title, definition, definitionHash: compiled.hash });
  return changed ? await getScenarioModel(modelId) : null;
}

/** Validate run options at the door, so a refusal names the field rather than failing deep. */
export function normalizeOptions(raw: Partial<RunOptions> | undefined): RunOptions {
  const options: RunOptions = {
    seed: raw?.seed ?? DEMONSTRATION_SEED,
    evaluations: raw?.evaluations ?? 10_000,
  };
  if (raw?.basis !== undefined) options.basis = raw.basis;
  if (raw?.overrides !== undefined) options.overrides = raw.overrides;
  if (raw?.objective !== undefined) options.objective = raw.objective;
  if (raw?.acceptable !== undefined) options.acceptable = raw.acceptable;
  if (options.evaluations > SCENARIO_LIMITS.maxEvaluations) options.evaluations = SCENARIO_LIMITS.maxEvaluations;
  return options;
}

/**
 * Run a saved model and record the run. The definition evaluated is the one
 * on the model row now, copied onto the run.
 */
export async function runModel(input: { model: ScenarioModelRecord; options: RunOptions; label: string | null; createdById: string }): Promise<ScenarioRunRecord> {
  const { model, options } = input;
  const compiled = compileModel(model.definition);
  const release = claimRunSlot();
  try {
    return await recordRun(input, compiled.hash, options);
  } finally {
    release();
  }
}

async function recordRun(
  input: { model: ScenarioModelRecord; label: string | null; createdById: string },
  modelHash: string,
  options: RunOptions,
): Promise<ScenarioRunRecord> {
  const { model } = input;
  const runId = await insertScenarioRun({
    modelId: model.id,
    projectId: model.projectId,
    label: input.label,
    seed: options.seed,
    evaluations: options.evaluations,
    config: { definition: model.definition, options },
    configHash: runConfigHash(modelHash, options),
    engineVersion: ENGINE_VERSION,
    createdById: input.createdById,
  });
  const startedAt = Date.now();
  try {
    const result = await runOnWorker(model.definition, options);
    await finishScenarioRun(runId, { state: 'COMPLETE', result, resultDigest: resultDigest(result), elapsedMs: result.elapsedMs });
  } catch (error) {
    await finishScenarioRun(runId, { state: 'FAILED', failure: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt });
  }
  return (await getScenarioRun(runId))!;
}

export interface Reproduction {
  runId: string;
  reproduced: boolean;
  recordedDigest: string | null;
  recomputedDigest: string;
  elapsedMs: number;
}

/** Re-run a recorded run's exact configuration and compare digests. Writes nothing. */
export async function reproduce(run: ScenarioRunRecord): Promise<Reproduction> {
  const result = await runIsolated(run.config.definition, run.config.options);
  const recomputed = resultDigest(result);
  return { runId: run.id, reproduced: recomputed === run.resultDigest, recordedDigest: run.resultDigest, recomputedDigest: recomputed, elapsedMs: result.elapsedMs };
}

let demonstrationCache: { key: string; result: Promise<ScenarioResult> } | null = null;

/**
 * The demonstration, computed and never stored. Read-only: anybody who can
 * read the page can see it, and it writes no row. Cached by its configuration
 * hash, which is safe precisely because the engine is deterministic.
 */
export async function demonstration(): Promise<{ definition: ScenarioModelDefinition; options: RunOptions; result: ScenarioResult }> {
  const definition = demonstrationModel();
  const options: RunOptions = { seed: DEMONSTRATION_SEED, evaluations: DEMONSTRATION_EVALUATIONS };
  const key = sha256(canonicalJson({ definition, options }));
  // The promise is cached, so concurrent first readers share one computation.
  // It runs on a worker too, outside the one-run slot: it is computed once per
  // process, and a demonstration a busy slot refused would be a blank page.
  if (!demonstrationCache || demonstrationCache.key !== key) {
    const result = runOnWorker(definition, options);
    demonstrationCache = { key, result };
    result.catch(() => { if (demonstrationCache?.result === result) demonstrationCache = null; });
  }
  return { definition, options, result: await demonstrationCache.result };
}
