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
import { ocrStatus } from '../services/documents/ocr.ts';
import { readableText, resolveCitation } from '../services/documents/retrieval.ts';
import {
  documentFindings,
  extractDocumentFindings,
  FindingsExtractionError,
} from '../services/documents/findings.ts';
import { ingestSource } from '../services/sources/ingest.ts';
import {
  decideLink,
  latestIngestionReport,
  listLinks,
  listSegments,
} from '../repos/sources.ts';
import { DOCUMENT_SCOPES, LINK_STATUSES, LINK_TYPES } from '../domain/types.ts';
import type { DocumentScope, LinkStatus, LinkType } from '../domain/types.ts';
import { layerSlugFromPath, relocateFile, storageKeyOf} from '../services/storage.ts';
import { getStorage, ObjectNotFoundError } from '../services/storage/index.ts';
import {
  badRequest,
  bodyOf,
  conflict,
  handler,
  notFound,
  nullableString,
  optionalBoolean,
  optionalEnum,
  optionalString,
  pathId,
  requireChunk,
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
  handler(async (req) => {
    const document = await requireDocument(pathId(req, 'documentId'));
    return {
      document,
      layer: document.layerId ? await getLayer(document.layerId) : null,
      dependencies: await listDependenciesForDocument(document.id),
      dependents: await listDependentsOfCanonicalName(document.projectId, document.canonicalName),
      audits: (await listAuditsByProject(document.projectId)).filter(
        (audit) => audit.auditedDocumentId === document.id,
      ),
      events: await listEventsByEntity('DOCUMENT', document.id),
    };
  }),
);

documentsRouter.patch(
  '/:documentId',
  handler(async (req) => {
    const document = await requireDocument(pathId(req, 'documentId'));
    const project = await requireProject(document.projectId);
    const body = bodyOf(req);

    let layerId = document.layerId;
    if ('layerId' in body) {
      const raw = body['layerId'];
      layerId =
        raw === null || raw === ''
          ? null
          : (await requireLayerOfProject(optionalString(raw, 'layerId') ?? '', project.id)).id;
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
      const layer = layerId ? await requireLayerOfProject(layerId, project.id) : null;
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
        const clash = await findDocumentByCanonicalName(project.id, names.canonicalName);
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
            const stored = await relocateFile(
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
      updated = await updateDocument(document.id, patch) ?? document;
    } catch (error) {
      // The row did not change, so put the artifact back where the row still
      // says it is rather than leaving the two disagreeing.
      if (movedFrom && movedTo) {
        try {
          await relocateFile(
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
    await recordEvent({
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

    await recomputeProject(project.id);
    return { document: await requireDocument(updated.id), plan: await buildPlan(project.id) };
  }),
);

documentsRouter.get(
  '/:documentId/file',
  handler(async (req, res, next) => {
    const document = await requireDocument(pathId(req, 'documentId'));
    // The key comes from the row, never from the request. Whether it names a
    // file under the data folder or an object in a bucket is the storage
    // layer's business, and the same refusals apply either way.
    const key = storageKeyOf(document);
    if (!key) {
      throw notFound(
        `"${document.canonicalName}" has no file registered yet — it exists as an expectation only.`,
      );
    }
    let object: Awaited<ReturnType<ReturnType<typeof getStorage>['openRead']>>;
    try {
      object = await getStorage().openRead(key);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        throw notFound(
          `The file for "${document.canonicalName}" is no longer in the document store ` +
            `(expected ${key}). Run SCAN & RECONCILE to resolve the inconsistency, or ` +
            're-import the document.',
        );
      }
      throw badRequest(
        `The stored location for "${document.canonicalName}" will not be served: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const filename = document.filename ?? path.posix.basename(key);
    res.setHeader('Content-Type', object.contentType || contentTypeFor(filename));
    res.setHeader('Content-Disposition', contentDisposition(filename));
    if (object.size > 0) res.setHeader('Content-Length', String(object.size));
    // Documents are replaced in place by reconciliation; never let a proxy or
    // the browser show yesterday's version.
    res.setHeader('Cache-Control', 'no-store');

    const stream = object.stream;
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
async function extractionView(documentId: string) {
  const run = await getCurrentExtractionRun(documentId);
  return {
    run,
    history: await listExtractionRuns(documentId),
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
    // What OCR did to this document, page by page, and what OCR can do here at all.
    ocrPages: run?.ocrPages ?? [],
    ocrEngine: run?.ocrEngine ?? null,
    ocrEngineVersion: run?.ocrEngineVersion ?? null,
    ocrRendererVersion: run?.ocrRendererVersion ?? null,
    ocr: ocrStatus(),
  };
}

documentsRouter.get(
  '/:documentId/extraction',
  handler(async (req) => {
    const document = await requireDocument(pathId(req, 'documentId'));
    return { document, ...await extractionView(document.id) };
  }),
);

/** VIEW EXTRACTED TEXT: exactly what the auditor will read, page by page. */
documentsRouter.get(
  '/:documentId/text',
  handler(async (req) => {
    const document = await requireDocument(pathId(req, 'documentId'));
    const { run, pages } = await readableText(document.id);
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
    const document = await requireDocument(pathId(req, 'documentId'));
    const result = await enqueueExtraction(document.id, { force: true });
    await recordEvent({
      projectId: document.projectId,
      layerId: document.layerId,
      entityType: 'DOCUMENT',
      entityId: document.id,
      eventType: 'DOCUMENT_REPROCESSED',
      payload: { runId: result.run.id, status: result.quality.status },
    });
    await recomputeProject(document.projectId);
    return { document: await requireDocument(document.id), ...await extractionView(document.id) };
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
  handler(async (req) => {
    const document = await requireDocument(pathId(req, 'documentId'));
    const run = await getCurrentExtractionRun(document.id);
    return { document, extractionRunId: run?.id ?? null, findings: await documentFindings(document.id) };
  }),
);

documentsRouter.post(
  '/:documentId/findings',
  handler(async (req) => {
    const document = await requireDocument(pathId(req, 'documentId'));
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

/**
 * Read a source properly: extract, segment, classify, propose links, report.
 *
 * Separate from extraction because it means something different. Extraction is
 * "what does this file say"; ingestion is "what is this file about, and which
 * parts of the project does it belong to".
 */
documentsRouter.post(
  '/:documentId/ingest',
  handler(async (req) => {
    const document = await requireDocument(pathId(req, 'documentId'));
    const body = bodyOf(req);
    const scope = optionalEnum<DocumentScope>(body['scope'], DOCUMENT_SCOPES, 'scope');
    const report = await ingestSource({
      documentId: document.id,
      ...(scope ? { scope } : {}),
      force: optionalBoolean(body['force'], 'force') ?? false,
    });
    return { document: await requireDocument(document.id), report };
  }),
);

/** The last ingestion report, its segments, and every proposed link. */
documentsRouter.get(
  '/:documentId/ingestion',
  handler(async (req) => {
    const document = await requireDocument(pathId(req, 'documentId'));
    return {
      document,
      report: await latestIngestionReport(document.id),
      segments: await listSegments(document.id),
      links: await listLinks(document.id),
    };
  }),
);

/**
 * Accept, change or exclude one proposed link.
 *
 * The review step is the point: classification proposes, a person decides, and
 * nothing becomes layer evidence in between.
 */
documentsRouter.patch(
  '/:documentId/links/:linkId',
  handler(async (req) => {
    const document = await requireDocument(pathId(req, 'documentId'));
    const linkId = pathId(req, 'linkId');
    const body = bodyOf(req);

    const status = optionalEnum<LinkStatus>(body['status'], LINK_STATUSES, 'status');
    if (!status) throw badRequest('A "status" of PROPOSED, ACCEPTED or EXCLUDED is required.');
    const linkType = optionalEnum<LinkType>(body['linkType'], LINK_TYPES, 'linkType');
    const layerId = optionalString(body['layerId'], 'layerId');
    if (layerId) await requireLayerOfProject(layerId, document.projectId);
    const version = nullableString(body['version'], 'version');

    const updated = await decideLink(linkId, {
      status,
      ...(linkType ? { linkType } : {}),
      ...(layerId ? { layerId } : {}),
      ...(version === undefined ? {} : { version }),
    });
    if (!updated) throw notFound(`No link with id ${linkId}.`);
    await recomputeProject(document.projectId);
    return { link: updated, links: await listLinks(document.id) };
  }),
);

/** Follow a citation back to the passage it rests on. */
documentsRouter.get(
  '/chunks/:chunkId',
  handler(async (req) => {
    // A passage is addressed by its own id. It reaches a project only through
    // its document, so that is the lineage the check has to follow — otherwise
    // a citation id would be a way to read a paragraph of somebody else's
    // research without ever naming their project.
    const chunk = await requireChunk(pathId(req, 'chunkId'));
    const resolved = await resolveCitation(chunk.id);
    if (!resolved) throw notFound(`No stored passage with id "${chunk.id}".`);
    return resolved;
  }),
);
