import { getDb } from '../db/database.ts';
import type {
  PromptSection,
  ResearchRun,
  ResearchRunRow,
  RunStatus,
  RunType,
} from '../domain/types.ts';
import { buildUpdate, fromBool, newId, nowIso, parseJson, toBool, toJson } from './util.ts';

export function mapRun(row: ResearchRunRow): ResearchRun {
  return {
    id: row.id,
    projectId: row.project_id,
    layerId: row.layer_id,
    targetDocumentId: row.target_document_id,
    targetVersion: row.target_version,
    runType: row.run_type as RunType,
    attemptNumber: Number(row.attempt_number),
    status: row.status as RunStatus,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    promptSections: parseJson<PromptSection[]>(row.prompt_sections, []),
    requiredAttachments: parseJson<string[]>(row.required_attachments, []),
    expectedConversationTitle: row.expected_conversation_title,
    expectedFilename: row.expected_filename,
    resultText: row.result_text,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    parentRunId: row.parent_run_id,
    redoReason: row.redo_reason,
    dependencyOverride: toBool(row.dependency_override),
    dependencyOverrideReason: row.dependency_override_reason,
    externalResponseId: row.external_response_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateRunInput {
  projectId: string;
  layerId: string | null;
  targetDocumentId?: string | null;
  targetVersion?: string | null;
  runType: RunType;
  attemptNumber?: number;
  status?: RunStatus;
  provider?: string | null;
  model?: string | null;
  prompt?: string | null;
  promptSections?: PromptSection[];
  requiredAttachments?: string[];
  expectedConversationTitle?: string | null;
  expectedFilename?: string | null;
  parentRunId?: string | null;
  redoReason?: string | null;
  conversationId?: string | null;
}

export async function createRun(input: CreateRunInput): Promise<ResearchRun> {
  const db = getDb();
  const ts = nowIso();
  const id = newId('run');
  await db.run(
    `INSERT INTO research_runs (id, project_id, layer_id, target_document_id, target_version,
       run_type, attempt_number, status, provider, model, prompt, prompt_sections,
       required_attachments, expected_conversation_title, expected_filename, parent_run_id,
       redo_reason, conversation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.layerId, input.targetDocumentId ?? null, input.targetVersion ?? null,
      input.runType, input.attemptNumber ?? 1, input.status ?? 'PLANNED', input.provider ?? null,
      input.model ?? null, input.prompt ?? null, toJson(input.promptSections ?? []),
      toJson(input.requiredAttachments ?? []), input.expectedConversationTitle ?? null,
      input.expectedFilename ?? null, input.parentRunId ?? null, input.redoReason ?? null,
      input.conversationId ?? null, ts, ts],
  );
  return (await getRun(id))!;
}

export async function getRun(id: string): Promise<ResearchRun | null> {
  const row = await getDb().get<ResearchRunRow>('SELECT * FROM research_runs WHERE id = ?', [id]);
  return row ? mapRun(row) : null;
}

export async function listRuns(projectId: string): Promise<ResearchRun[]> {
  return (await getDb().all<ResearchRunRow>(
      'SELECT * FROM research_runs WHERE project_id = ? ORDER BY created_at DESC',
      [projectId],
    ))
    .map(mapRun);
}

export async function listRunsByLayer(layerId: string): Promise<ResearchRun[]> {
  return (await getDb().all<ResearchRunRow>('SELECT * FROM research_runs WHERE layer_id = ? ORDER BY created_at DESC', [
      layerId,
    ]))
    .map(mapRun);
}

/**
 * A run without the three columns that carry its text: `prompt`,
 * `prompt_sections` (the same prompt again, split) and `result_text`.
 *
 * The state engine reads every run of a layer on every derivation, and of the
 * project on every recompute, and uses none of the text — only status, type,
 * target and timestamps. Production, 2026-11-10 to 11-14: `SELECT * FROM
 * research_runs WHERE layer_id = $1` was the costliest statement by response in
 * every stalled process, 5–32 s a call on average against well under a second
 * for any other statement under the same event-loop stall, because each call
 * materialised every packet's assignment and every synthesis prompt twice over
 * (the string, then its parsed sections) for a layer that has accumulated
 * hundreds of runs. That garbage, inside the effect transactions that recompute
 * all layers at once, is a large part of what kept the heap near its limit and
 * the collector on the CPU, and the event-loop stalls it caused are what read
 * as an exhausted pool. A summary is all the derivation ever needed.
 */
export type ResearchRunSummary = Omit<ResearchRun, 'prompt' | 'promptSections' | 'resultText' | 'requiredAttachments'>;

const RUN_SUMMARY_COLUMNS =
  'id, project_id, layer_id, target_document_id, target_version, run_type, attempt_number, status, provider, model, ' +
  'expected_conversation_title, expected_filename, started_at, completed_at, failed_at, failure_reason, parent_run_id, ' +
  'redo_reason, dependency_override, dependency_override_reason, external_response_id, conversation_id, created_at, updated_at';

type ResearchRunSummaryRow = Omit<ResearchRunRow, 'prompt' | 'prompt_sections' | 'result_text' | 'required_attachments'>;

function mapRunSummary(row: ResearchRunSummaryRow): ResearchRunSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    layerId: row.layer_id,
    targetDocumentId: row.target_document_id,
    targetVersion: row.target_version,
    runType: row.run_type as RunType,
    attemptNumber: Number(row.attempt_number),
    status: row.status as RunStatus,
    provider: row.provider,
    model: row.model,
    expectedConversationTitle: row.expected_conversation_title,
    expectedFilename: row.expected_filename,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    parentRunId: row.parent_run_id,
    redoReason: row.redo_reason,
    dependencyOverride: toBool(row.dependency_override),
    dependencyOverrideReason: row.dependency_override_reason,
    externalResponseId: row.external_response_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `listRunsByLayer` without the text columns: same rows, same order. */
export async function listRunSummariesByLayer(layerId: string): Promise<ResearchRunSummary[]> {
  return (await getDb().all<ResearchRunSummaryRow>(
    `SELECT ${RUN_SUMMARY_COLUMNS} FROM research_runs WHERE layer_id = ? ORDER BY created_at DESC`,
    [layerId],
  )).map(mapRunSummary);
}

/** A project's runs in the given statuses, without the text columns, newest first. */
export async function listRunSummariesInStatus(projectId: string, statuses: readonly RunStatus[]): Promise<ResearchRunSummary[]> {
  if (statuses.length === 0) return [];
  return (await getDb().all<ResearchRunSummaryRow>(
    `SELECT ${RUN_SUMMARY_COLUMNS} FROM research_runs
      WHERE project_id = ? AND status IN (${statuses.map(() => '?').join(', ')})
      ORDER BY created_at DESC`,
    [projectId, ...statuses],
  )).map(mapRunSummary);
}

export async function listActiveRuns(projectId: string): Promise<ResearchRun[]> {
  return (await getDb().all<ResearchRunRow>(
      `SELECT * FROM research_runs
       WHERE project_id = ? AND status IN ('PLANNED','READY','RUNNING','BLOCKED','AUDIT_REQUIRED','REDO_REQUIRED')
       ORDER BY created_at DESC`,
      [projectId],
    ))
    .map(mapRun);
}

/**
 * Every run in a redo lineage, oldest attempt first.
 *
 * Descends through ALL children, not just the first. Re-auditing the same failed
 * parent creates sibling redos, and following only one branch made
 * `countRedoAttempts` return 1 forever — the max_auto_redos cap could then be
 * bypassed indefinitely by auditing the parent again, which the UI's run picker
 * makes a single click.
 */
export async function getRunLineage(runId: string): Promise<ResearchRun[]> {
  const start = await getRun(runId);
  if (!start) return [];

  // Climb to the root of the lineage first.
  let root = start;
  const climbed = new Set<string>([root.id]);
  while (root.parentRunId) {
    const parent = await getRun(root.parentRunId);
    if (!parent || climbed.has(parent.id)) break;
    climbed.add(parent.id);
    root = parent;
  }

  // Then walk the whole tree beneath it, breadth-first.
  const db = getDb();
  const seen = new Set<string>([root.id]);
  const lineage: ResearchRun[] = [root];
  const queue: string[] = [root.id];
  while (queue.length > 0 && lineage.length < 500) {
    const currentId = queue.shift()!;
    const children = await db.all<ResearchRunRow>(
      'SELECT * FROM research_runs WHERE parent_run_id = ? ORDER BY attempt_number, created_at',
      [currentId],
    );
    for (const row of children) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      lineage.push(mapRun(row));
      queue.push(row.id);
    }
  }
  return lineage;
}

/** How many automatic redos already happened in this lineage. */
export async function countRedoAttempts(runId: string): Promise<number> {
  return (await getRunLineage(runId)).filter((r) => r.runType === 'REDO' || r.attemptNumber > 1).length;
}

export interface UpdateRunInput {
  targetDocumentId?: string | null;
  targetVersion?: string | null;
  status?: RunStatus;
  provider?: string | null;
  model?: string | null;
  prompt?: string | null;
  promptSections?: PromptSection[];
  requiredAttachments?: string[];
  expectedConversationTitle?: string | null;
  expectedFilename?: string | null;
  resultText?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  failureReason?: string | null;
  redoReason?: string | null;
  dependencyOverride?: boolean;
  dependencyOverrideReason?: string | null;
  externalResponseId?: string | null;
  conversationId?: string | null;
}

export async function updateRun(id: string, patch: UpdateRunInput): Promise<ResearchRun | null> {
  const { clause, values } = buildUpdate({
    target_document_id: patch.targetDocumentId,
    target_version: patch.targetVersion,
    status: patch.status,
    provider: patch.provider,
    model: patch.model,
    prompt: patch.prompt,
    prompt_sections: patch.promptSections ? toJson(patch.promptSections) : undefined,
    required_attachments: patch.requiredAttachments ? toJson(patch.requiredAttachments) : undefined,
    expected_conversation_title: patch.expectedConversationTitle,
    expected_filename: patch.expectedFilename,
    result_text: patch.resultText,
    started_at: patch.startedAt,
    completed_at: patch.completedAt,
    failed_at: patch.failedAt,
    failure_reason: patch.failureReason,
    redo_reason: patch.redoReason,
    dependency_override:
      patch.dependencyOverride === undefined ? undefined : fromBool(patch.dependencyOverride),
    dependency_override_reason: patch.dependencyOverrideReason,
    external_response_id: patch.externalResponseId,
    conversation_id: patch.conversationId,
  });
  if (!clause) return getRun(id);
  await getDb().run(`UPDATE research_runs SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getRun(id);
}
