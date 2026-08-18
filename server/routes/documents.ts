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
import type { DocumentStatus, DocumentType } from '../domain/types.ts';
import { DOCUMENT_STATUSES, DOCUMENT_TYPES } from '../domain/types.ts';
import type { UpdateDocumentInput } from '../repos/documents.ts';
import { buildNames } from '../domain/naming.ts';
import { isValidVersion, normalizeVersion, versionSortKey, waveForVersion } from '../domain/version.ts';
import { listAuditsByProject } from '../repos/audits.ts';
import {
  listDependenciesForDocument,
  listDependentsOfCanonicalName,
} from '../repos/dependencies.ts';
import { updateDocument } from '../repos/documents.ts';
import { listEventsByEntity, recordEvent } from '../repos/events.ts';
import { getLayer } from '../repos/layers.ts';
import { buildPlan } from '../services/planner.ts';
import { recomputeProject } from '../services/stateEngine.ts';
import { absolutePathFor, relocateFile } from '../services/storage.ts';
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

    if (identityChanged) {
      const layer = layerId ? requireLayerOfProject(layerId, project.id) : null;
      patch.layerId = layerId;
      patch.version = version;
      // version_sort is the only orderable form; storing it is not optional.
      patch.versionSort = versionSortKey(version);
      patch.wave = waveForVersion(version, project.versionPolicy);

      if (layer) {
        const extension = path.extname(document.filename ?? '');
        const names = buildNames(layer.name, version, extension.length > 0 ? extension : undefined);
        patch.canonicalName = names.canonicalName;
        patch.conversationTitle = names.conversationTitle;

        // Move the file so the folder tree keeps matching the database rather
        // than leaving the artifact filed under the layer it just left.
        if (document.filesystemPath) {
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
          } catch {
            // The file is already gone; the recompute below records that as an
            // inconsistency instead of failing the correction.
            patch.fileMissing = true;
          }
        }
      }
    }

    const updated = updateDocument(document.id, patch) ?? document;
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
