/**
 * Filing the artifact a run produced.
 *
 * This used to live inside the upload route, which was fine while a human
 * uploading a file was the only way a run could finish. Staged research finishes
 * runs too, and the two must file identically — same naming, same document type,
 * same event, same recompute — or a report Brain generated would be registered
 * differently from the same report a person dropped in.
 *
 * The platform owns the filename either way (invariant 4): whatever the model or
 * the browser called it, the stored name comes from `buildNames`.
 */
import type {
  Document,
  DocumentType,
  ImportResult,
  Layer,
  Project,
  ResearchRun,
  RunStatus,
  RunType,
} from '../domain/types.ts';
import { isValidVersion, normalizeVersion } from '../domain/version.ts';
import { getDocument, updateDocument } from '../repos/documents.ts';
import { recordEvent } from '../repos/events.ts';
import { getRun, updateRun } from '../repos/runs.ts';
import { nowIso } from '../repos/util.ts';
import { importFile } from './importer.ts';
import { defaultTargetVersion } from './promptCompiler.ts';
import { recomputeProject } from './stateEngine.ts';

/** Statuses from which "the artifact came back" means the run is finished. */
export const PENDING_RUN_STATUSES = new Set<RunStatus>(['PLANNED', 'READY', 'BLOCKED', 'RUNNING']);

/** The kind of artifact each run type produces. */
export const DOCUMENT_TYPE_BY_RUN_TYPE: Record<RunType, DocumentType> = {
  FOUNDATION: 'FOUNDATION',
  EXPANSION: 'EXPANSION',
  PATCH: 'PATCH',
  AUDIT: 'AUDIT',
  SYNTHESIS: 'SYNTHESIS',
  REDO: 'EXPANSION',
  CROSS_LAYER_AUDIT: 'AUDIT',
};

/** A redo produces whatever its original attempt was trying to produce. */
export function documentTypeForRun(run: ResearchRun): DocumentType {
  let current: ResearchRun | null = run;
  for (let hops = 0; current !== null && hops < 20; hops += 1) {
    if (current.runType !== 'REDO') return DOCUMENT_TYPE_BY_RUN_TYPE[current.runType];
    current = current.parentRunId ? getRun(current.parentRunId) : null;
  }
  return DOCUMENT_TYPE_BY_RUN_TYPE.REDO;
}

export function targetVersionForRun(run: ResearchRun, layerId: string, projectId: string): string {
  const declared = run.targetVersion?.trim();
  if (declared && isValidVersion(declared)) return normalizeVersion(declared);
  return normalizeVersion(defaultTargetVersion(projectId, layerId, run.runType));
}

export interface RegisterRunArtifactResult {
  imported: ImportResult;
  document: Document | null;
  /** True when this registration is what finished the run. */
  finished: boolean;
}

/**
 * Register a run's result and complete the run.
 *
 * Returns rather than throws when the import declines (a duplicate, a frozen
 * canonical name): the caller decides whether that is a 409 for a browser or a
 * failed orchestration, and both need the importer's own message.
 */
export function registerRunArtifact(input: {
  run: ResearchRun;
  layer: Layer;
  project: Project;
  originalFilename: string;
  contents: Buffer;
  notes?: string | null;
}): RegisterRunArtifactResult {
  const { run, layer, project } = input;
  const version = targetVersionForRun(run, layer.id, project.id);
  const documentType = documentTypeForRun(run);

  const imported = importFile({
    projectId: project.id,
    originalFilename: input.originalFilename,
    contents: input.contents,
    layerId: layer.id,
    version,
    documentType,
    notes: input.notes ?? `Returned by run ${run.id}.`,
  });
  if (!imported.documentId) return { imported, document: null, finished: false };

  const document =
    updateDocument(imported.documentId, { sourceRunId: run.id, status: 'COMPLETE' }) ??
    getDocument(imported.documentId);

  const finished = PENDING_RUN_STATUSES.has(run.status);
  const completedAt = nowIso();
  updateRun(run.id, {
    targetDocumentId: imported.documentId,
    status: finished ? 'COMPLETE' : undefined,
    completedAt: finished ? completedAt : undefined,
  });

  if (finished) {
    recordEvent({
      projectId: project.id,
      layerId: layer.id,
      entityType: 'RUN',
      entityId: run.id,
      eventType: 'RUN_COMPLETED',
      payload: {
        runType: run.runType,
        documentId: imported.documentId,
        canonicalName: document?.canonicalName ?? null,
        storedPath: imported.storedPath,
        completedAt,
      },
    });
  }

  recomputeProject(project.id);
  return { imported, document, finished };
}
