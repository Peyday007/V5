/**
 * Objective-plan readings (migration 148): one row per reading of a goal with
 * no cash target. Written by `services/goals/objectivePlan.ts` only. The insert
 * is keyed on (goal, reading_key), so a restart or a second process reading
 * the same goal on the same inputs in the same window writes nothing new.
 */
import { getDb } from '../db/database.ts';
import type { GoalObjectiveReadingRow } from '../domain/types.ts';
import { newId, parseJson, toJson } from './util.ts';

export type ObjectiveVerdict = 'PLAN_READY' | 'NEEDS_EVIDENCE' | 'NOT_SUPPORTED' | 'DEGRADED';

export interface ObjectiveReadingRecord {
  id: string;
  goalId: string;
  readingKey: string;
  inputsDigest: string;
  verdict: ObjectiveVerdict;
  chosenStrategy: string | null;
  interpretation: Record<string, unknown>;
  strategies: unknown[];
  critique: unknown[];
  decision: Record<string, unknown>;
  calls: Record<string, unknown>;
  error: string | null;
  createdAt: string;
}

function mapReading(row: GoalObjectiveReadingRow): ObjectiveReadingRecord {
  return {
    id: row.id,
    goalId: row.workstream_id,
    readingKey: row.reading_key,
    inputsDigest: row.inputs_digest,
    verdict: row.verdict as ObjectiveVerdict,
    chosenStrategy: row.chosen_strategy,
    interpretation: parseJson<Record<string, unknown>>(row.interpretation, {}),
    strategies: parseJson<unknown[]>(row.strategies, []),
    critique: parseJson<unknown[]>(row.critique, []),
    decision: parseJson<Record<string, unknown>>(row.decision, {}),
    calls: parseJson<Record<string, unknown>>(row.calls, {}),
    error: row.error,
    createdAt: row.created_at,
  };
}

/** Insert once per (goal, key). Returns the stored row, and whether this call wrote it. */
export async function insertObjectiveReading(input: Omit<ObjectiveReadingRecord, 'id'>): Promise<{ reading: ObjectiveReadingRecord; created: boolean }> {
  const id = newId('gor');
  const result = await getDb().run(
    `INSERT INTO goal_objective_readings
       (id, workstream_id, reading_key, inputs_digest, verdict, chosen_strategy, interpretation, strategies, critique, decision, calls, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.goalId,
      input.readingKey,
      input.inputsDigest,
      input.verdict,
      input.chosenStrategy,
      toJson(input.interpretation),
      toJson(input.strategies),
      toJson(input.critique),
      toJson(input.decision),
      toJson(input.calls),
      input.error,
      input.createdAt,
    ],
  );
  const row = await getDb().get<GoalObjectiveReadingRow>(
    'SELECT * FROM goal_objective_readings WHERE workstream_id = ? AND reading_key = ?',
    [input.goalId, input.readingKey],
  );
  if (!row) throw new Error('The objective reading was written and could not be read back.');
  return { reading: mapReading(row), created: result.changes > 0 && row.id === id };
}

export async function getObjectiveReadingByKey(goalId: string, readingKey: string): Promise<ObjectiveReadingRecord | null> {
  const row = await getDb().get<GoalObjectiveReadingRow>(
    'SELECT * FROM goal_objective_readings WHERE workstream_id = ? AND reading_key = ?',
    [goalId, readingKey],
  );
  return row ? mapReading(row) : null;
}

export async function latestObjectiveReading(goalId: string): Promise<ObjectiveReadingRecord | null> {
  const row = await getDb().get<GoalObjectiveReadingRow>(
    'SELECT * FROM goal_objective_readings WHERE workstream_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [goalId],
  );
  return row ? mapReading(row) : null;
}
