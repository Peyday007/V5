/**
 * Scan and reconcile (section 21).
 *
 * The database and the filesystem are two halves of one authoritative state, and
 * they drift: files get dropped into folders by hand, moved, renamed in Finder,
 * or deleted. This module compares the two and reports the difference in the
 * user's language. It reads, it explains, and it offers one-click fixes — it
 * never deletes a file the user put there.
 *
 * Invariant 8: a file on disk is not a registered document.
 * Invariant 9: a database row whose file vanished is not a healthy document.
 */
import type {
  Document,
  DocumentType,
  InferenceResult,
  ReconcileIssue,
  ReconcileReport,
} from '../domain/types.ts';
import { getDocument, listDocuments, updateDocument } from '../repos/documents.ts';
import { recordEvent } from '../repos/events.ts';
import { getLayer } from '../repos/layers.ts';
import { getProject } from '../repos/projects.ts';
import { nowIso } from '../repos/util.ts';
import { inferForProjectFile, inferFromFilename } from './inference.ts';
import { registerExistingFile } from './importer.ts';
import { recomputeProject } from './stateEngine.ts';
import { objectExists, objectSize, hashObject, listProjectFiles } from './storage.ts';

export interface ReconcileFixInput {
  projectId: string;
  kind: ReconcileIssue['kind'];
  path?: string | null;
  documentId?: string | null;
  layerId?: string | null;
  version?: string | null;
  documentType?: DocumentType | null;
}

interface ProjectHandle {
  id: string;
  slug: string;
  name: string;
}

async function requireProject(projectId: string): Promise<ProjectHandle> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return { id: project.id, slug: project.slug, name: project.name };
}

async function unregisteredFileIssue(
  project: ProjectHandle,
  relativePath: string,
): Promise<ReconcileIssue> {
  const inference = await inferForProjectFile(project.id, project.slug, relativePath);
  const fixable = inference.layerId !== null && inference.version !== null;
  return {
    kind: 'UNREGISTERED_FILE',
    path: relativePath,
    documentId: null,
    canonicalName: inference.canonicalName,
    detail: fixable
      ? `"${relativePath}" is in the project folder but no document row points at it. It looks like "${inference.canonicalName ?? ''}".`
      : `"${relativePath}" is in the project folder but no document row points at it, and its name does not say what it is.`,
    inference,
    fixable,
    suggestedFix: fixable
      ? `Register it as "${inference.canonicalName ?? ''}".`
      : 'Confirm the layer and version, then register it.',
  };
}

function missingFileIssue(document: Document): ReconcileIssue {
  return {
    kind: 'MISSING_PHYSICAL_FILE',
    path: document.filesystemPath,
    documentId: document.id,
    canonicalName: document.canonicalName,
    detail: `"${document.canonicalName}" is registered but its file is no longer at ${document.filesystemPath}.`,
    fixable: true,
    suggestedFix:
      'Mark the document as missing so the planner stops treating the layer as complete, then re-import the file.',
  };
}

function checksumIssue(document: Document, currentHash: string): ReconcileIssue {
  return {
    kind: 'CHECKSUM_CHANGED',
    path: document.filesystemPath,
    documentId: document.id,
    canonicalName: document.canonicalName,
    detail:
      `The file for "${document.canonicalName}" has changed since it was imported ` +
      `(recorded ${document.fileHash?.slice(0, 12) ?? 'none'}…, on disk ${currentHash.slice(0, 12)}…).`,
    fixable: true,
    suggestedFix: 'Accept the file on disk as the current content of this document.',
  };
}

async function orphanIssue(projectId: string, document: Document): Promise<ReconcileIssue> {
  const inference: InferenceResult = await inferFromFilename(
    projectId,
    document.filename ?? document.canonicalName,
  );
  return {
    kind: 'ORPHANED_DOCUMENT',
    path: document.filesystemPath,
    documentId: document.id,
    canonicalName: document.canonicalName,
    detail: `"${document.canonicalName}" is registered but belongs to no layer, so no layer's state accounts for it.`,
    inference,
    fixable: inference.layerId !== null,
    suggestedFix: inference.layerId
      ? `Assign it to the "${inference.layerName ?? ''}" layer.`
      : 'Choose the layer this document belongs to.',
  };
}

/**
 * Compare every file under the project's document tree with every registered
 * document and report the differences. Read-only apart from the audit event.
 */
export async function scanAndReconcile(projectId: string): Promise<ReconcileReport> {
  const project = await requireProject(projectId);
  const files = await listProjectFiles(project.slug);
  const documents = await listDocuments(project.id);
  const issues: ReconcileIssue[] = [];

  const registeredPaths = new Set<string>();
  for (const document of documents) {
    if (document.filesystemPath) registeredPaths.add(document.filesystemPath);

    // No layer is a fault only for a document that should have one. A
    // project-wide source — a transcript, a working log — belongs to the project
    // and is linked to several layers by review, so filing it under one would be
    // the error. Reporting it as orphaned every time would train the user to
    // ignore this report.
    if (!document.layerId && (document.scope ?? 'LAYER') === 'LAYER') {
      issues.push(await orphanIssue(project.id, document));
    }

    // A document that was planned but not yet produced legitimately has no file.
    const relativePath = document.filesystemPath;
    if (!relativePath) continue;

    if (!await objectExists(relativePath)) {
      issues.push(missingFileIssue(document));
      continue;
    }
    if (document.fileHash) {
      const currentHash = await hashObject(relativePath);
      if (currentHash !== document.fileHash) issues.push(checksumIssue(document, currentHash));
    }
  }

  for (const relativePath of files) {
    if (registeredPaths.has(relativePath)) continue;
    issues.push(await unregisteredFileIssue(project, relativePath));
  }

  const report: ReconcileReport = {
    projectId: project.id,
    scannedFiles: files.length,
    registeredDocuments: documents.length,
    issues,
    healthy: issues.length === 0,
    generatedAt: nowIso(),
  };

  await recordEvent({
    projectId: project.id,
    entityType: 'PROJECT',
    entityId: project.id,
    eventType: 'RECONCILE_COMPLETED',
    payload: {
      scannedFiles: report.scannedFiles,
      registeredDocuments: report.registeredDocuments,
      healthy: report.healthy,
      issues: issues.map((issue) => ({
        kind: issue.kind,
        path: issue.path,
        documentId: issue.documentId,
        canonicalName: issue.canonicalName,
      })),
    },
  });

  return report;
}

async function fixUnregisteredFile(input: ReconcileFixInput): Promise<{ ok: boolean; message: string }> {
  if (!input.path) return { ok: false, message: 'Which file? A path is needed to register it.' };
  const outcome = await registerExistingFile({
    projectId: input.projectId,
    relativePath: input.path,
    layerId: input.layerId ?? null,
    version: input.version ?? null,
    documentType: input.documentType ?? null,
  });
  return { ok: outcome.registered, message: outcome.message };
}

async function fixMissingFile(input: ReconcileFixInput): Promise<{ ok: boolean; message: string }> {
  if (!input.documentId) return { ok: false, message: 'Which document? A document id is needed.' };
  const document = await getDocument(input.documentId);
  if (!document || document.projectId !== input.projectId) {
    return { ok: false, message: `No document ${input.documentId} in this project.` };
  }
  if (document.filesystemPath && await objectExists(document.filesystemPath)) {
    await updateDocument(document.id, { fileMissing: false });
    await recomputeProject(input.projectId);
    return {
      ok: true,
      message: `The file for "${document.canonicalName}" is back on disk — the document is healthy again.`,
    };
  }
  await updateDocument(document.id, { fileMissing: true });
  await recordEvent({
    projectId: document.projectId,
    layerId: document.layerId,
    entityType: 'DOCUMENT',
    entityId: document.id,
    eventType: 'DOCUMENT_FILE_MISSING',
    payload: { canonicalName: document.canonicalName, expectedPath: document.filesystemPath },
  });
  await recomputeProject(input.projectId);
  return {
    ok: true,
    message:
      `Marked "${document.canonicalName}" as missing. Its layer is no longer counted as complete, ` +
      'and the record was kept so the history survives — re-import the file to restore it.',
  };
}

async function fixChecksum(input: ReconcileFixInput): Promise<{ ok: boolean; message: string }> {
  if (!input.documentId) return { ok: false, message: 'Which document? A document id is needed.' };
  const document = await getDocument(input.documentId);
  if (!document || document.projectId !== input.projectId) {
    return { ok: false, message: `No document ${input.documentId} in this project.` };
  }
  if (!document.filesystemPath || !await objectExists(document.filesystemPath)) {
    return {
      ok: false,
      message: `"${document.canonicalName}" has no file on disk to accept. Re-import it instead.`,
    };
  }
  const previousHash = document.fileHash;
  const hash = await hashObject(document.storageKey ?? document.filesystemPath);
  await updateDocument(document.id, {
    fileHash: hash,
    fileSize: await objectSize(document.filesystemPath),
    fileMissing: false,
  });
  await recordEvent({
    projectId: document.projectId,
    layerId: document.layerId,
    entityType: 'DOCUMENT',
    entityId: document.id,
    eventType: 'USER_CORRECTION',
    payload: {
      correction: 'CHECKSUM_ACCEPTED',
      canonicalName: document.canonicalName,
      previousHash,
      fileHash: hash,
    },
  });
  await recomputeProject(input.projectId);
  return {
    ok: true,
    message: `Accepted the file on disk as the current content of "${document.canonicalName}".`,
  };
}

async function fixOrphanedDocument(input: ReconcileFixInput): Promise<{ ok: boolean; message: string }> {
  if (!input.documentId) return { ok: false, message: 'Which document? A document id is needed.' };
  const document = await getDocument(input.documentId);
  if (!document || document.projectId !== input.projectId) {
    return { ok: false, message: `No document ${input.documentId} in this project.` };
  }
  const inferred = input.layerId
    ? input.layerId
    : (await inferFromFilename(input.projectId, document.filename ?? document.canonicalName)).layerId;
  if (!inferred) {
    return {
      ok: false,
      message: `Nothing in "${document.canonicalName}" says which layer it belongs to — choose one.`,
    };
  }
  const layer = await getLayer(inferred);
  if (!layer || layer.projectId !== input.projectId) {
    return { ok: false, message: `Layer ${inferred} does not belong to this project.` };
  }
  await updateDocument(document.id, {
    layerId: layer.id,
    documentType: input.documentType ?? document.documentType,
  });
  await recordEvent({
    projectId: document.projectId,
    layerId: layer.id,
    entityType: 'DOCUMENT',
    entityId: document.id,
    eventType: 'USER_CORRECTION',
    payload: {
      correction: 'LAYER_ASSIGNED',
      canonicalName: document.canonicalName,
      layerId: layer.id,
      layerName: layer.name,
    },
  });
  await recomputeProject(input.projectId);
  return { ok: true, message: `Assigned "${document.canonicalName}" to ${layer.name}.` };
}

/**
 * Apply one fix and hand back a freshly computed report, so the UI always shows
 * the state that exists after the fix rather than the state that provoked it.
 */
export async function applyReconcileFix(
  input: ReconcileFixInput,
): Promise<{ ok: boolean; message: string; report: ReconcileReport }> {
  await requireProject(input.projectId);
  let outcome: { ok: boolean; message: string };
  try {
    switch (input.kind) {
      case 'UNREGISTERED_FILE':
        outcome = await fixUnregisteredFile(input);
        break;
      case 'MISSING_PHYSICAL_FILE':
        outcome = await fixMissingFile(input);
        break;
      case 'CHECKSUM_CHANGED':
        outcome = await fixChecksum(input);
        break;
      case 'ORPHANED_DOCUMENT':
        outcome = await fixOrphanedDocument(input);
        break;
      default:
        outcome = { ok: false, message: `There is no fix for "${String(input.kind)}".` };
    }
  } catch (error) {
    outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return { ...outcome, report: await scanAndReconcile(input.projectId) };
}
