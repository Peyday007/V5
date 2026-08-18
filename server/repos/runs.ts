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

export function createRun(input: CreateRunInput): ResearchRun {
  const db = getDb();
  const ts = nowIso();
  const id = newId('run');
  db.run(
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
  return getRun(id)!;
}

export function getRun(id: string): ResearchRun | null {
  const row = getDb().get<ResearchRunRow>('SELECT * FROM research_runs WHERE id = ?', [id]);
  return row ? mapRun(row) : null;
}

export function listRuns(projectId: string): ResearchRun[] {
  return getDb()
    .all<ResearchRunRow>(
      'SELECT * FROM research_runs WHERE project_id = ? ORDER BY created_at DESC',
      [projectId],
    )
    .map(mapRun);
}

export function listRunsByLayer(layerId: string): ResearchRun[] {
  return getDb()
    .all<ResearchRunRow>('SELECT * FROM research_runs WHERE layer_id = ? ORDER BY created_at DESC', [
      layerId,
    ])
    .map(mapRun);
}

export function listActiveRuns(projectId: string): ResearchRun[] {
  return getDb()
    .all<ResearchRunRow>(
      `SELECT * FROM research_runs
       WHERE project_id = ? AND status IN ('PLANNED','READY','RUNNING','BLOCKED','AUDIT_REQUIRED','REDO_REQUIRED')
       ORDER BY created_at DESC`,
      [projectId],
    )
    .map(mapRun);
}

/** Full redo lineage for a run, oldest attempt first. */
export function getRunLineage(runId: string): ResearchRun[] {
  const lineage: ResearchRun[] = [];
  let current = getRun(runId);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    lineage.unshift(current);
    current = current.parentRunId ? getRun(current.parentRunId) : null;
  }
  // Walk forward through children too.
  let tail = lineage.at(-1);
  while (tail) {
    const child = getDb().get<ResearchRunRow>(
      'SELECT * FROM research_runs WHERE parent_run_id = ? ORDER BY attempt_number LIMIT 1',
      [tail.id],
    );
    if (!child || guard.has(child.id)) break;
    guard.add(child.id);
    const mapped = mapRun(child);
    lineage.push(mapped);
    tail = mapped;
  }
  return lineage;
}

/** How many automatic redos already happened in this lineage. */
export function countRedoAttempts(runId: string): number {
  return getRunLineage(runId).filter((r) => r.runType === 'REDO' || r.attemptNumber > 1).length;
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

export function updateRun(id: string, patch: UpdateRunInput): ResearchRun | null {
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
  getDb().run(`UPDATE research_runs SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getRun(id);
}
