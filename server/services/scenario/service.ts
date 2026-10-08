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
 * The engine runs synchronously in the request. It is bounded — at most
 * 50,000 evaluations and a wall-clock budget — and measured at under two
 * seconds for the demonstration model, so a queue would add a second
 * mechanism for no reliability it does not already have.
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
import { resultDigest, runConfigHash, runScenarioModel } from './run.ts';
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
  const runId = await insertScenarioRun({
    modelId: model.id,
    projectId: model.projectId,
    label: input.label,
    seed: options.seed,
    evaluations: options.evaluations,
    config: { definition: model.definition, options },
    configHash: runConfigHash(compiled.hash, options),
    engineVersion: ENGINE_VERSION,
    createdById: input.createdById,
  });
  const startedAt = Date.now();
  try {
    const result = runScenarioModel(model.definition, options);
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
export function reproduce(run: ScenarioRunRecord): Reproduction {
  const result = runScenarioModel(run.config.definition, run.config.options);
  const recomputed = resultDigest(result);
  return { runId: run.id, reproduced: recomputed === run.resultDigest, recordedDigest: run.resultDigest, recomputedDigest: recomputed, elapsedMs: result.elapsedMs };
}

let demonstrationCache: { key: string; result: ScenarioResult } | null = null;

/**
 * The demonstration, computed and never stored. Read-only: anybody who can
 * read the page can see it, and it writes no row. Cached by its configuration
 * hash, which is safe precisely because the engine is deterministic.
 */
export function demonstration(): { definition: ScenarioModelDefinition; options: RunOptions; result: ScenarioResult } {
  const definition = demonstrationModel();
  const options: RunOptions = { seed: DEMONSTRATION_SEED, evaluations: DEMONSTRATION_EVALUATIONS };
  const key = sha256(canonicalJson({ definition, options }));
  if (!demonstrationCache || demonstrationCache.key !== key) {
    demonstrationCache = { key, result: runScenarioModel(definition, options) };
  }
  return { definition, options, result: demonstrationCache.result };
}
