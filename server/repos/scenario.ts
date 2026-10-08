/**
 * Saved scenario models and their runs.
 *
 * Nothing here computes or decides. A model row holds the definition a person
 * last saved; a run row holds a copy of the definition it evaluated, the seed,
 * the options and the result, so a run never depends on the model staying as
 * it was. Runs are never rewritten once they finish: a re-run is a new row,
 * and the comparison of two digests is what proves reproducibility.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, toBool } from './util.ts';
import type { ScenarioModelRow, ScenarioRunRow, ScenarioRunState } from '../domain/types.ts';
import type { RunOptions, ScenarioModelDefinition, ScenarioResult } from '../domain/scenario.ts';

export interface ScenarioModelRecord {
  id: string;
  projectId: string;
  title: string;
  definition: ScenarioModelDefinition;
  definitionHash: string;
  illustrative: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ScenarioRunRecord {
  id: string;
  modelId: string;
  projectId: string;
  label: string | null;
  seed: number;
  evaluations: number;
  config: { definition: ScenarioModelDefinition; options: RunOptions };
  configHash: string;
  engineVersion: string;
  state: ScenarioRunState;
  result: ScenarioResult | null;
  resultDigest: string | null;
  failure: string | null;
  elapsedMs: number | null;
  createdById: string;
  startedAt: string;
  finishedAt: string | null;
}

export function mapScenarioModel(row: ScenarioModelRow): ScenarioModelRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    definition: JSON.parse(row.definition_json) as ScenarioModelDefinition,
    definitionHash: row.definition_hash,
    illustrative: toBool(Number(row.illustrative)),
    createdById: row.created_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function mapScenarioRun(row: ScenarioRunRow, withResult = true): ScenarioRunRecord {
  return {
    id: row.id,
    modelId: row.model_id,
    projectId: row.project_id,
    label: row.label,
    seed: Number(row.seed),
    evaluations: Number(row.evaluations),
    config: JSON.parse(row.config_json) as ScenarioRunRecord['config'],
    configHash: row.config_hash,
    engineVersion: row.engine_version,
    state: row.state,
    result: withResult && row.result_json ? (JSON.parse(row.result_json) as ScenarioResult) : null,
    resultDigest: row.result_digest,
    failure: row.failure,
    elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
    createdById: row.created_by_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function insertScenarioModel(input: {
  projectId: string;
  title: string;
  definition: ScenarioModelDefinition;
  definitionHash: string;
  illustrative: boolean;
  createdById: string;
}): Promise<ScenarioModelRecord> {
  const id = newId('scm');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO scenario_models (id, project_id, title, definition_json, definition_hash, illustrative, created_by_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.title, JSON.stringify(input.definition), input.definitionHash, input.illustrative ? 1 : 0, input.createdById, at, at],
  );
  return (await getScenarioModel(id))!;
}

/** Replace a model's definition. Guarded on the model being live. */
export async function updateScenarioModel(id: string, input: { title: string; definition: ScenarioModelDefinition; definitionHash: string }): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE scenario_models SET title = ?, definition_json = ?, definition_hash = ?, updated_at = ?
      WHERE id = ? AND archived_at IS NULL`,
    [input.title, JSON.stringify(input.definition), input.definitionHash, nowIso(), id],
  );
  return result.changes > 0;
}

export async function archiveScenarioModel(id: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    'UPDATE scenario_models SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL',
    [at, at, id],
  );
  return result.changes > 0;
}

export async function getScenarioModel(id: string): Promise<ScenarioModelRecord | null> {
  const row = await getDb().get<ScenarioModelRow>('SELECT * FROM scenario_models WHERE id = ?', [id]);
  return row ? mapScenarioModel(row) : null;
}

export async function listScenarioModels(projectId: string): Promise<ScenarioModelRecord[]> {
  const rows = await getDb().all<ScenarioModelRow>(
    'SELECT * FROM scenario_models WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC, id DESC',
    [projectId],
  );
  return rows.map(mapScenarioModel);
}

export async function insertScenarioRun(input: {
  modelId: string;
  projectId: string;
  label: string | null;
  seed: number;
  evaluations: number;
  config: ScenarioRunRecord['config'];
  configHash: string;
  engineVersion: string;
  createdById: string;
}): Promise<string> {
  const id = newId('scr');
  await getDb().run(
    `INSERT INTO scenario_runs (id, model_id, project_id, label, seed, evaluations, config_json, config_hash, engine_version, state, created_by_id, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)`,
    [id, input.modelId, input.projectId, input.label, input.seed, input.evaluations, JSON.stringify(input.config), input.configHash, input.engineVersion, input.createdById, nowIso()],
  );
  return id;
}

/** Finish a run. Guarded on RUNNING, so a finished run is never rewritten. */
export async function finishScenarioRun(
  id: string,
  outcome: { state: 'COMPLETE'; result: ScenarioResult; resultDigest: string; elapsedMs: number } | { state: 'FAILED'; failure: string; elapsedMs: number },
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE scenario_runs SET state = ?, result_json = ?, result_digest = ?, failure = ?, elapsed_ms = ?, finished_at = ?
      WHERE id = ? AND state = 'RUNNING'`,
    [
      outcome.state,
      outcome.state === 'COMPLETE' ? JSON.stringify(outcome.result) : null,
      outcome.state === 'COMPLETE' ? outcome.resultDigest : null,
      outcome.state === 'FAILED' ? outcome.failure : null,
      outcome.elapsedMs,
      nowIso(),
      id,
    ],
  );
  return result.changes > 0;
}

export async function getScenarioRun(id: string): Promise<ScenarioRunRecord | null> {
  const row = await getDb().get<ScenarioRunRow>('SELECT * FROM scenario_runs WHERE id = ?', [id]);
  return row ? mapScenarioRun(row) : null;
}

/** Runs of one model, newest first, without their result bodies. */
export async function listScenarioRuns(modelId: string): Promise<ScenarioRunRecord[]> {
  const rows = await getDb().all<ScenarioRunRow>(
    `SELECT id, model_id, project_id, label, seed, evaluations, config_json, config_hash, engine_version, state,
            NULL AS result_json, result_digest, failure, elapsed_ms, created_by_id, started_at, finished_at
       FROM scenario_runs WHERE model_id = ? ORDER BY started_at DESC, id DESC`,
    [modelId],
  );
  return rows.map((row) => mapScenarioRun(row, false));
}
