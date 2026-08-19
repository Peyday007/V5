/**
 * Document API.
 *
 * A document is a database row plus a real file; either one missing is a
 * reportable inconsistency, never "the document exists" (invariants 8 and 9).
 * Correcting a document therefore moves the file too, so the tree on disk and
 * the canonical name in the database never drift apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Document, DocumentStatus, DocumentType } from '../domain/types.ts';
import { DOCUMENT_STATUSES, DOCUMENT_TYPES } from '../domain/types.ts';
import type { UpdateDocumentInput } from '../repos/documents.ts';
import { buildNames } from '../domain/naming.ts';
import { isValidVersion, normalizeVersion, versionSortKey, waveForVersion } from '../domain/version.ts';
import { listAuditsByProject } from '../repos/audits.ts';
import {
  listDependenciesForDocument,
  listDependentsOfCanonicalName,
} from '../repos/dependencies.ts';
import { findDocumentByCanonicalName, updateDocument } from '../repos/documents.ts';
import { listEventsByEntity, recordEvent } from '../repos/events.ts';
import { getLayer } from '../repos/layers.ts';
import { buildPlan } from '../services/planner.ts';
import { recomputeProject } from '../services/stateEngine.ts';
import { getCurrentExtractionRun, listExtractionRuns } from '../repos/extraction.ts';
import { enqueueExtraction } from '../services/documents/queue.ts';
import { getOcrEngine } from '../services/documents/ocr.ts';
import { readableText, resolveCitation } from '../services/documents/retrieval.ts';
import {
  documentFindings,
  extractDocumentFindings,
  FindingsExtractionError,
} from '../services/documents/findings.ts';
import { absolutePathFor, layerSlugFromPath, relocateFile } from '../services/storage.ts';
import {
  badRequest,
  bodyOf,
  conflict,
  handler,
  nullableString,
  notFound,
  optionalEnum,
  optionalString,
  pathId,
  requireDocument,
  requireLayerOfProject,
  requireProject,
} from './helpers.ts';

export const documentsRouter = Router();

/** Enough of the web's document formats to serve a research library inline. */
const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};

function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * `Content-Disposition` accepts only a narrow ASCII subset unquoted, so the
 * canonical name is sent twice: a stripped fallback and the RFC 5987 form that
 * modern browsers prefer.
 */
function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\u0020-\u007E]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function parseVersion(value: unknown, field: string): string | undefined {
  const raw = optionalString(value, field);
  if (raw === undefined) return undefined;
  if (!isValidVersion(raw)) {
    throw badRequest(
      `"${raw}" is not a version this project understands. Expected something like v1, v1G or v3.1.`,
    );
  }
  return normalizeVersion(raw);
}

documentsRouter.get(
  '/:documentId',
  handler((req) => {
    const document = requireDocument(pathId(req, 'documentId'));
    return {
      document,
      layer: document.layerId ? getLayer(document.layerId) : null,
      dependencies: listDependenciesForDocument(document.id),
      dependents: listDependentsOfCanonicalName(document.projectId, document.canonicalName),
      audits: listAuditsByProject(document.projectId).filter(
        (audit) => audit.auditedDocumentId === document.id,
      ),
      events: listEventsByEntity('DOCUMENT', document.id),
    };
  }),
);

documentsRouter.patch(
  '/:documentId',
  handler((req) => {
    const document = requireDocument(pathId(req, 'documentId'));
    const project = requireProject(document.projectId);
    const body = bodyOf(req);

    let layerId = document.layerId;
    if ('layerId' in body) {
      const raw = body['layerId'];
      layerId =
        raw === null || raw === ''
          ? null
          : requireLayerOfProject(optionalString(raw, 'layerId') ?? '', project.id).id;
    }

    const version = parseVersion(body['version'], 'version') ?? document.version;
    const documentType =
      optionalEnum<DocumentType>(body['documentType'], DOCUMENT_TYPES, 'documentType') ??
      document.documentType;
    const status = optionalEnum<DocumentStatus>(body['status'], DOCUMENT_STATUSES, 'status');
    const notes = 'notes' in body ? nullableString(body['notes'], 'notes') : undefined;

    const identityChanged = layerId !== document.layerId || version !== document.version;
    if (identityChanged && (document.frozen || document.isCanonical)) {
      throw conflict(
        `"${document.canonicalName}" is the frozen canonical artifact of its layer. ` +
          'Reopen the layer before renaming or moving it.',
      );
    }

    const patch: UpdateDocumentInput = { documentType, status, notes };

    // Set when the artifact has already been moved, so a failed database write
    // can put it back instead of stranding it.
    let movedFrom: string | null = null;
    let movedTo: string | null = null;

    if (identityChanged) {
      const layer = layerId ? requireLayerOfProject(layerId, project.id) : null;
      patch.layerId = layerId;
      patch.version = version;
      // version_sort is the only orderable form; storing it is not optional.
      patch.versionSort = versionSortKey(version);
      patch.wave = waveForVersion(version, project.versionPolicy);

      // A document with no layer has no name to rebuild from, so accepting a new
      // version would leave canonical_name pinned to the old one. Refuse rather
      // than store a row whose name and version disagree.
      if (!layer && !document.layerId) {
        throw badRequest(
          `${document.canonicalName} is not filed under a layer, so its version cannot be changed ` +
            `on its own. Assign it to a layer in the same request.`,
        );
      }

      if (layer) {
        const extension = path.extname(document.filename ?? '');
        const names = buildNames(layer.name, version, extension.length > 0 ? extension : undefined);
        patch.canonicalName = names.canonicalName;
        patch.conversationTitle = names.conversationTitle;

        // (project_id, canonical_name) is UNIQUE. Check it BEFORE touching the
        // filesystem: moving first and letting the insert fail left the file
        // renamed under the new layer while the row still pointed at the old
        // path, manufacturing exactly the inconsistency invariants 8 and 9 exist
        // to prevent.
        const clash = findDocumentByCanonicalName(project.id, names.canonicalName);
        if (clash && clash.id !== document.id) {
          throw conflict(
            `"${names.canonicalName}" already exists in this project, so ${document.canonicalName} ` +
              `cannot be renamed to it. Supersede or correct the existing document first.`,
            { conflictingDocumentId: clash.id },
          );
        }

        // Move the file so the folder tree keeps matching the database rather
        // than leaving the artifact filed under the layer it just left.
        if (document.filesystemPath) {
          const previousPath = document.filesystemPath;
          try {
            const stored = relocateFile(
              document.filesystemPath,
              project.slug,
              layer.slug,
              names.filename,
            );
            patch.filename = stored.filename;
            patch.filesystemPath = stored.relativePath;
            patch.fileSize = stored.size;
            patch.fileHash = stored.hash;
            patch.fileMissing = false;
            movedFrom = previousPath;
            movedTo = stored.relativePath;
          } catch {
            // The file is already gone; the recompute below records that as an
            // inconsistency instead of failing the correction.
            patch.fileMissing = true;
          }
        }
      }
    }

    let updated: Document;
    try {
      updated = updateDocument(document.id, patch) ?? document;
    } catch (error) {
      // The row did not change, so put the artifact back where the row still
      // says it is rather than leaving the two disagreeing.
      if (movedFrom && movedTo) {
        try {
          relocateFile(
            movedTo,
            project.slug,
            layerSlugFromPath(project.slug, movedFrom),
            path.basename(movedFrom),
          );
        } catch {
          // Best effort; a reconcile scan reports whatever is left over.
        }
      }
      throw error;
    }
    recordEvent({
      projectId: project.id,
      layerId: updated.layerId,
      entityType: 'DOCUMENT',
      entityId: updated.id,
      eventType: 'USER_CORRECTION',
      payload: {
        from: {
          layerId: document.layerId,
          version: document.version,
          documentType: document.documentType,
          status: document.status,
          canonicalName: document.canonicalName,
        },
        to: {
          layerId: updated.layerId,
          version: updated.version,
          documentType: updated.documentType,
          status: updated.status,
          canonicalName: updated.canonicalName,
        },
      },
    });

    recomputeProject(project.id);
    return { document: requireDocument(updated.id), plan: buildPlan(project.id) };
  }),
);

documentsRouter.get(
  '/:documentId/file',
  handler((req, res, next) => {
    const document = requireDocument(pathId(req, 'documentId'));
    if (!document.filesystemPath) {
      throw notFound(
        `"${document.canonicalName}" has no file registered yet — it exists as an expectation only.`,
      );
    }

    let absolute: string;
    try {
      absolute = absolutePathFor(document.filesystemPath);
    } catch {
      throw badRequest(
        `The stored path for "${document.canonicalName}" points outside the data root and will not be served.`,
      );
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      throw notFound(
        `The file for "${document.canonicalName}" is no longer on disk (expected ${document.filesystemPath}). ` +
          'Run SCAN & RECONCILE to resolve the inconsistency, or re-import the document.',
      );
    }
    if (!stat.isFile()) {
      throw notFound(`${document.filesystemPath} is not a file.`);
    }

    const filename = document.filename ?? path.basename(absolute);
    res.setHeader('Content-Type', contentTypeFor(filename));
    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.setHeader('Content-Length', String(stat.size));
    // Documents are replaced in place by reconciliation; never let a proxy or
    // the browser show yesterday's version.
    res.setHeader('Cache-Control', 'no-store');

    const stream = fs.createReadStream(absolute);
    stream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      next(error);
    });
    stream.pipe(res);
    return undefined;
  }),
);

// ---------------------------------------------------------------------------
// Document understanding
// ---------------------------------------------------------------------------

/** What the import screen and the document card need to show. */
function extractionView(documentId: string) {
  const run = getCurrentExtractionRun(documentId);
  return {
    run,
    history: listExtractionRuns(documentId),
    quality: run
      ? {
          status: run.status,
          pagesExpected: run.pagesExpected,
          pagesReadable: run.pagesReadable,
          pagesOcr: run.pagesOcr,
          pagesFailed: run.pagesFailed,
          characterCount: run.characterCount,
          warnings: run.warnings,
          coverageRatio: run.coverageRatio,
          pipelineVersion: run.pipelineVersion,
          blockedReason: run.blockedReason,
        }
      : null,
    ocr: { engine: getOcrEngine().name, available: getOcrEngine().available, reason: getOcrEngine().reason },
  };
}

documentsRouter.get(
  '/:documentId/extraction',
  handler((req) => {
    const document = requireDocument(pathId(req, 'documentId'));
    return { document, ...extractionView(document.id) };
  }),
);

/** VIEW EXTRACTED TEXT: exactly what the auditor will read, page by page. */
documentsRouter.get(
  '/:documentId/text',
  handler((req) => {
    const document = requireDocument(pathId(req, 'documentId'));
    const { run, pages } = readableText(document.id);
    if (!run) {
      throw notFound(
        `${document.canonicalName} has not been read yet, so there is no extracted text to show.`,
      );
    }
    return { document, run, pages };
  }),
);

/**
 * REPROCESS. Creates a NEW extraction run rather than editing the old one, so
 * audits recorded against the previous reading keep resolving to what they saw.
 */
documentsRouter.post(
  '/:documentId/reprocess',
  handler(async (req) => {
    const document = requireDocument(pathId(req, 'documentId'));
    const result = await enqueueExtraction(document.id, { force: true });
    recordEvent({
      projectId: document.projectId,
      layerId: document.layerId,
      entityType: 'DOCUMENT',
      entityId: document.id,
      eventType: 'DOCUMENT_REPROCESSED',
      payload: { runId: result.run.id, status: result.quality.status },
    });
    recomputeProject(document.projectId);
    return { document: requireDocument(document.id), ...extractionView(document.id) };
  }),
);

/**
 * The structured index over a document (section 12).
 *
 * Deriving it needs a real provider, so it is an explicit action rather than
 * part of import: a fabricated index would be worse than none. Failure records
 * nothing, so the document's previous index survives a failed attempt.
 */
documentsRouter.get(
  '/:documentId/findings',
  handler((req) => {
    const document = requireDocument(pathId(req, 'documentId'));
    const run = getCurrentExtractionRun(document.id);
    return { document, extractionRunId: run?.id ?? null, findings: documentFindings(document.id) };
  }),
);

documentsRouter.post(
  '/:documentId/findings',
  handler(async (req) => {
    const document = requireDocument(pathId(req, 'documentId'));
    const body = bodyOf(req);
    try {
      return await extractDocumentFindings({
        documentId: document.id,
        providerName: optionalString(body['provider'], 'provider') ?? null,
        model: optionalString(body['model'], 'model') ?? null,
      });
    } catch (error) {
      if (error instanceof FindingsExtractionError) {
        throw conflict(error.message, { documentId: document.id, chunkId: error.chunkId });
      }
      throw error;
    }
  }),
);

/** Follow a citation back to the passage it rests on. */
documentsRouter.get(
  '/chunks/:chunkId',
  handler((req) => {
    const chunkId = pathId(req, 'chunkId');
    const resolved = resolveCitation(chunkId);
    if (!resolved) throw notFound(`No stored passage with id ${chunkId}.`);
    return resolved;
  }),
);
