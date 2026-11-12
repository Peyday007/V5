/**
 * The operator's record (§106): its runs, its memory and the lessons it wrote.
 *
 * The agent itself (Hermes Agent) runs on a machine that stops when idle and
 * keeps nothing. What it remembers between runs is these rows: Brain sends the
 * memory with every run and stores what the run hands back, so the agent's
 * memory is Brain's state (invariant 12) and survives any machine.
 */
import { getDb } from '../db/database.ts';
import type { OperatorLearningRow, OperatorMemoryRow, OperatorRunRow } from '../domain/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';

export interface OperatorToolCall {
  tool: string;
  ok: boolean;
  /** The first line of a failed call's refusal. */
  error?: string;
}

export interface OperatorRun {
  id: string;
  state: OperatorRunRow['state'];
  model: string;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  toolCalls: OperatorToolCall[];
  error: string | null;
}

function mapRun(row: OperatorRunRow): OperatorRun {
  return {
    id: row.id,
    state: row.state,
    model: row.model,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: row.summary,
    toolCalls: parseJson<OperatorToolCall[]>(row.tool_calls, []),
    error: row.error,
  };
}

export async function startOperatorRun(model: string): Promise<OperatorRun> {
  const id = newId('opr');
  await getDb().run(
    `INSERT INTO operator_runs (id, state, model, started_at, finished_at, summary, tool_calls, error)
     VALUES (?, 'RUNNING', ?, ?, NULL, NULL, '[]', NULL)`,
    [id, model.slice(0, 200), nowIso()],
  );
  return (await getOperatorRun(id))!;
}

/** Guarded on RUNNING: a run is finished once, by whichever path reaches it first. */
export async function finishOperatorRun(input: {
  id: string;
  state: 'DONE' | 'FAILED';
  summary: string | null;
  toolCalls: OperatorToolCall[];
  error: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE operator_runs SET state = ?, finished_at = ?, summary = ?, tool_calls = ?, error = ?
      WHERE id = ? AND state = 'RUNNING'`,
    [
      input.state,
      nowIso(),
      input.summary?.slice(0, 8000) ?? null,
      toJson(input.toolCalls.slice(0, 200)),
      input.error?.slice(0, 2000) ?? null,
      input.id,
    ],
  );
  return result.changes === 1;
}

export async function getOperatorRun(id: string): Promise<OperatorRun | null> {
  const row = await getDb().get<OperatorRunRow>('SELECT * FROM operator_runs WHERE id = ?', [id]);
  return row ? mapRun(row) : null;
}

export async function recentOperatorRuns(limit = 10): Promise<OperatorRun[]> {
  const rows = await getDb().all<OperatorRunRow>(
    'SELECT * FROM operator_runs ORDER BY started_at DESC, id DESC LIMIT ?',
    [limit],
  );
  return rows.map(mapRun);
}

/** A run left RUNNING by a restart is not running: it is finished as FAILED so the next one may start. */
export async function failStaleOperatorRuns(olderThanIso: string): Promise<number> {
  const result = await getDb().run(
    `UPDATE operator_runs SET state = 'FAILED', finished_at = ?, error = 'the run did not report back (restart or timeout)'
      WHERE state = 'RUNNING' AND started_at < ?`,
    [nowIso(), olderThanIso],
  );
  return result.changes;
}

export async function runningOperatorRun(): Promise<OperatorRun | null> {
  const row = await getDb().get<OperatorRunRow>(
    "SELECT * FROM operator_runs WHERE state = 'RUNNING' ORDER BY started_at DESC LIMIT 1",
    [],
  );
  return row ? mapRun(row) : null;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/** Bounds on what one run may store, so a confused model cannot fill the database. */
export const MEMORY_MAX_ENTRIES = 60;
export const MEMORY_MAX_BYTES = 24_000;

export async function readOperatorMemory(): Promise<Record<string, string>> {
  const rows = await getDb().all<OperatorMemoryRow>('SELECT * FROM operator_memory ORDER BY name', []);
  return Object.fromEntries(rows.map((row) => [row.name, row.body]));
}

/**
 * Replace the memory with what a run returned. Names are the agent's own
 * relative paths (`memories/MEMORY.md`, `skills/<name>/SKILL.md`); anything
 * else is ignored. An entry the run no longer has is removed, so a lesson the
 * agent deliberately dropped is not resurrected.
 */
export async function storeOperatorMemory(runId: string, files: Record<string, string>): Promise<number> {
  const accepted = Object.entries(files)
    .filter(([name, body]) => isMemoryName(name) && typeof body === 'string')
    .slice(0, MEMORY_MAX_ENTRIES)
    .map(([name, body]) => [name, body.slice(0, MEMORY_MAX_BYTES)] as const);
  if (accepted.length === 0) return 0;
  const at = nowIso();
  const db = getDb();
  for (const [name, body] of accepted) {
    await db.run(
      `INSERT INTO operator_memory (name, body, updated_at, run_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, run_id = excluded.run_id`,
      [name, body, at, runId],
    );
  }
  const keep = accepted.map(([name]) => name);
  await db.run(
    `DELETE FROM operator_memory WHERE name NOT IN (${keep.map(() => '?').join(', ')})`,
    keep,
  );
  return accepted.length;
}

export function isMemoryName(name: string): boolean {
  return (
    /^memories\/[A-Z_]+\.md$/.test(name) ||
    /^skills\/[a-z0-9][a-z0-9._-]{0,80}\/SKILL\.md$/.test(name)
  );
}

// ---------------------------------------------------------------------------
// Learnings
// ---------------------------------------------------------------------------

export interface OperatorLearning {
  id: string;
  goalId: string | null;
  runId: string | null;
  lesson: string;
  evidence: string;
  recordedAt: string;
}

export async function recordOperatorLearning(input: {
  goalId: string | null;
  runId: string | null;
  lesson: string;
  evidence: string;
}): Promise<OperatorLearning> {
  const row: OperatorLearningRow = {
    id: newId('opl'),
    goal_id: input.goalId,
    run_id: input.runId,
    lesson: input.lesson.slice(0, 2000),
    evidence: input.evidence.slice(0, 2000),
    recorded_at: nowIso(),
  };
  await getDb().run(
    `INSERT INTO operator_learnings (id, goal_id, run_id, lesson, evidence, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.goal_id, row.run_id, row.lesson, row.evidence, row.recorded_at],
  );
  return { id: row.id, goalId: row.goal_id, runId: row.run_id, lesson: row.lesson, evidence: row.evidence, recordedAt: row.recorded_at };
}

export async function listOperatorLearnings(input: { goalId?: string | null; limit?: number } = {}): Promise<OperatorLearning[]> {
  const rows = input.goalId
    ? await getDb().all<OperatorLearningRow>(
        'SELECT * FROM operator_learnings WHERE goal_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?',
        [input.goalId, input.limit ?? 20],
      )
    : await getDb().all<OperatorLearningRow>(
        'SELECT * FROM operator_learnings ORDER BY recorded_at DESC, id DESC LIMIT ?',
        [input.limit ?? 20],
      );
  return rows.map((row) => ({
    id: row.id,
    goalId: row.goal_id,
    runId: row.run_id,
    lesson: row.lesson,
    evidence: row.evidence,
    recordedAt: row.recorded_at,
  }));
}
