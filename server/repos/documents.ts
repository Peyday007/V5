import { getDb } from '../db/database.ts';
import type { Document, DocumentRow, DocumentStatus, DocumentType } from '../domain/types.ts';
import { buildUpdate, fromBool, newId, nowIso, toBool } from './util.ts';

export function mapDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    projectId: row.project_id,
    layerId: row.layer_id,
    canonicalName: row.canonical_name,
    version: row.version,
    versionSort: row.version_sort,
    wave: row.wave === null ? null : Number(row.wave),
    documentType: row.document_type as DocumentType,
    status: row.status as DocumentStatus,
    filename: row.filename,
    filesystemPath: row.filesystem_path,
    fileSize: row.file_size === null ? null : Number(row.file_size),
    fileHash: row.file_hash,
    fileMissing: toBool(row.file_missing),
    conversationTitle: row.conversation_title,
    sourceRunId: row.source_run_id,
    parentDocumentId: row.parent_document_id,
    supersededByDocumentId: row.superseded_by_document_id,
    isCanonical: toBool(row.is_canonical),
    frozen: toBool(row.frozen),
    notes: row.notes,
    importedAt: row.imported_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateDocumentInput {
  projectId: string;
  layerId: string | null;
  canonicalName: string;
  version: string;
  versionSort: string;
  wave?: number | null;
  documentType: DocumentType;
  status?: DocumentStatus;
  filename?: string | null;
  filesystemPath?: string | null;
  fileSize?: number | null;
  fileHash?: string | null;
  conversationTitle?: string | null;
  sourceRunId?: string | null;
  parentDocumentId?: string | null;
  isCanonical?: boolean;
  notes?: string | null;
  importedAt?: string | null;
}

export function createDocument(input: CreateDocumentInput): Document {
  const db = getDb();
  const ts = nowIso();
  const id = newId('doc');
  db.run(
    `INSERT INTO documents (id, project_id, layer_id, canonical_name, version, version_sort, wave,
       document_type, status, filename, filesystem_path, file_size, file_hash, file_missing,
       conversation_title, source_run_id, parent_document_id, is_canonical, frozen, notes,
       imported_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [id, input.projectId, input.layerId, input.canonicalName, input.version, input.versionSort,
      input.wave ?? null, input.documentType, input.status ?? 'EXPECTED', input.filename ?? null,
      input.filesystemPath ?? null, input.fileSize ?? null, input.fileHash ?? null,
      input.conversationTitle ?? null, input.sourceRunId ?? null, input.parentDocumentId ?? null,
      fromBool(input.isCanonical), input.notes ?? null, input.importedAt ?? null, ts, ts],
  );
  return getDocument(id)!;
}

export function getDocument(id: string): Document | null {
  const row = getDb().get<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id]);
  return row ? mapDocument(row) : null;
}

export function findDocumentByCanonicalName(projectId: string, canonicalName: string): Document | null {
  const row = getDb().get<DocumentRow>(
    'SELECT * FROM documents WHERE project_id = ? AND canonical_name = ? COLLATE NOCASE',
    [projectId, canonicalName],
  );
  return row ? mapDocument(row) : null;
}

export function findDocumentByPath(filesystemPath: string): Document | null {
  const row = getDb().get<DocumentRow>('SELECT * FROM documents WHERE filesystem_path = ?', [
    filesystemPath,
  ]);
  return row ? mapDocument(row) : null;
}

export function listDocuments(projectId: string): Document[] {
  return getDb()
    .all<DocumentRow>(
      'SELECT * FROM documents WHERE project_id = ? ORDER BY layer_id, version_sort, created_at',
      [projectId],
    )
    .map(mapDocument);
}

export function listDocumentsByLayer(layerId: string): Document[] {
  return getDb()
    .all<DocumentRow>('SELECT * FROM documents WHERE layer_id = ? ORDER BY version_sort, created_at', [
      layerId,
    ])
    .map(mapDocument);
}

export interface UpdateDocumentInput {
  layerId?: string | null;
  canonicalName?: string;
  version?: string;
  versionSort?: string;
  wave?: number | null;
  documentType?: DocumentType;
  status?: DocumentStatus;
  filename?: string | null;
  filesystemPath?: string | null;
  fileSize?: number | null;
  fileHash?: string | null;
  fileMissing?: boolean;
  conversationTitle?: string | null;
  sourceRunId?: string | null;
  parentDocumentId?: string | null;
  supersededByDocumentId?: string | null;
  isCanonical?: boolean;
  frozen?: boolean;
  notes?: string | null;
  importedAt?: string | null;
}

export function updateDocument(id: string, patch: UpdateDocumentInput): Document | null {
  const { clause, values } = buildUpdate({
    layer_id: patch.layerId,
    canonical_name: patch.canonicalName,
    version: patch.version,
    version_sort: patch.versionSort,
    wave: patch.wave,
    document_type: patch.documentType,
    status: patch.status,
    filename: patch.filename,
    filesystem_path: patch.filesystemPath,
    file_size: patch.fileSize,
    file_hash: patch.fileHash,
    file_missing: patch.fileMissing === undefined ? undefined : fromBool(patch.fileMissing),
    conversation_title: patch.conversationTitle,
    source_run_id: patch.sourceRunId,
    parent_document_id: patch.parentDocumentId,
    superseded_by_document_id: patch.supersededByDocumentId,
    is_canonical: patch.isCanonical === undefined ? undefined : fromBool(patch.isCanonical),
    frozen: patch.frozen === undefined ? undefined : fromBool(patch.frozen),
    notes: patch.notes,
    imported_at: patch.importedAt,
  });
  if (!clause) return getDocument(id);
  getDb().run(`UPDATE documents SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getDocument(id);
}

/** Documents are never deleted in ordinary operation — history is provenance. */
export function deleteDocument(id: string): void {
  getDb().run('DELETE FROM documents WHERE id = ?', [id]);
}
