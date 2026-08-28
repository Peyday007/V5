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
import { getDocument, listDocumentsByLayer, updateDocument } from '../repos/documents.ts';
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
export async function documentTypeForRun(run: ResearchRun): Promise<DocumentType> {
  let current: ResearchRun | null = run;
  for (let hops = 0; current !== null && hops < 20; hops += 1) {
    if (current.runType !== 'REDO') return DOCUMENT_TYPE_BY_RUN_TYPE[current.runType];
    current = current.parentRunId ? await getRun(current.parentRunId) : null;
  }
  return DOCUMENT_TYPE_BY_RUN_TYPE.REDO;
}

/**
 * Which kind of run a newly started packet is.
 *
 * FOUNDATION always targets the layer's foundation version — v1 — because that
 * is what a foundation *is*. So a second packet started on a layer that already
 * has one cannot be a FOUNDATION: it would target v1 again, and the importer
 * would decline it as a duplicate canonical name. Correct refusal, baffling
 * message, and the operator did nothing wrong.
 *
 * Found by running a second test packet, which is exactly the thing an operator
 * does after reading the first one and wanting another look.
 *
 * A layer that already holds a document gets an EXPANSION instead, which
 * resolves to the next expansion version. Nothing here decides *what* the
 * version is — `resolveTargetVersion` owns that and keeps owning it.
 */
export async function runTypeForNewPacket(layerId: string): Promise<RunType> {
  const existing = await listDocumentsByLayer(layerId);
  return existing.length === 0 ? 'FOUNDATION' : 'EXPANSION';
}

export async function targetVersionForRun(run: ResearchRun, layerId: string, projectId: string): Promise<string> {
  const declared = run.targetVersion?.trim();
  if (declared && isValidVersion(declared)) return normalizeVersion(declared);
  return normalizeVersion(await defaultTargetVersion(projectId, layerId, run.runType));
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
export async function registerRunArtifact(input: {
  run: ResearchRun;
  layer: Layer;
  project: Project;
  originalFilename: string;
  contents: Buffer;
  notes?: string | null;
}): Promise<RegisterRunArtifactResult> {
  const { run, layer, project } = input;
  const version = await targetVersionForRun(run, layer.id, project.id);
  const documentType = await documentTypeForRun(run);

  const imported = await importFile({
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
    await updateDocument(imported.documentId, { sourceRunId: run.id, status: 'COMPLETE' }) ??
    await getDocument(imported.documentId);

  const finished = PENDING_RUN_STATUSES.has(run.status);
  const completedAt = nowIso();
  await updateRun(run.id, {
    targetDocumentId: imported.documentId,
    status: finished ? 'COMPLETE' : undefined,
    completedAt: finished ? completedAt : undefined,
  });

  if (finished) {
    await recordEvent({
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

  await recomputeProject(project.id);
  return { imported, document, finished };
}
