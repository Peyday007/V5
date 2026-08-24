import { getDb } from '../db/database.ts';
import type {
  ClassificationSource,
  Document,
  DocumentFormat,
  DocumentOrigin,
  DocumentRow,
  DocumentScope,
  DocumentStatus,
  DocumentType,
  ExtractionStatus,
} from '../domain/types.ts';
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
    storageKey: row.storage_key ?? row.filesystem_path,
    storageProvider: row.storage_provider,
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
    mimeType: row.mime_type ?? null,
    detectedFormat: (row.detected_format as DocumentFormat | null) ?? null,
    pageCount: row.page_count === null || row.page_count === undefined ? null : Number(row.page_count),
    extractionStatus: (row.extraction_status as ExtractionStatus | undefined) ?? 'QUEUED',
    extractionRunId: row.extraction_run_id ?? null,
    pipelineVersion: row.pipeline_version ?? null,
    origin: (row.origin as DocumentOrigin | undefined) ?? 'UPLOAD',
    scope: (row.scope as DocumentScope | null) ?? 'LAYER',
    classificationSource: (row.classification_source as ClassificationSource | null) ?? null,
    classificationConfidence:
      row.classification_confidence === null || row.classification_confidence === undefined
        ? null
        : Number(row.classification_confidence),
    importJobId: row.import_job_id ?? null,
    sourcePath: row.source_path ?? null,
    sourceModifiedAt: row.source_modified_at ?? null,
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
  /** Where the bytes live in the store. Defaults to the path, which is a key. */
  storageKey?: string | null;
  storageProvider?: string | null;
  fileSize?: number | null;
  fileHash?: string | null;
  conversationTitle?: string | null;
  sourceRunId?: string | null;
  parentDocumentId?: string | null;
  isCanonical?: boolean;
  notes?: string | null;
  importedAt?: string | null;
  mimeType?: string | null;
  detectedFormat?: DocumentFormat | null;
  pageCount?: number | null;
  origin?: DocumentOrigin;
}

export async function createDocument(input: CreateDocumentInput): Promise<Document> {
  const db = getDb();
  const ts = nowIso();
  const id = newId('doc');
  await db.run(
    `INSERT INTO documents (id, project_id, layer_id, canonical_name, version, version_sort, wave,
       document_type, status, filename, filesystem_path, file_size, file_hash, file_missing,
       conversation_title, source_run_id, parent_document_id, is_canonical, frozen, notes,
       imported_at, created_at, updated_at, mime_type, detected_format, page_count, origin,
       storage_key, storage_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.layerId, input.canonicalName, input.version, input.versionSort,
      input.wave ?? null, input.documentType, input.status ?? 'EXPECTED', input.filename ?? null,
      input.filesystemPath ?? null,
      input.fileSize ?? null, input.fileHash ?? null,
      input.conversationTitle ?? null, input.sourceRunId ?? null, input.parentDocumentId ?? null,
      fromBool(input.isCanonical), input.notes ?? null, input.importedAt ?? null, ts, ts,
      input.mimeType ?? null, input.detectedFormat ?? null, input.pageCount ?? null,
      input.origin ?? 'UPLOAD',
      input.storageKey ?? input.filesystemPath ?? null,
      input.storageProvider ?? null],
  );
  return (await getDocument(id))!;
}

export async function getDocument(id: string): Promise<Document | null> {
  const row = await getDb().get<DocumentRow>('SELECT * FROM documents WHERE id = ?', [id]);
  return row ? mapDocument(row) : null;
}

export async function findDocumentByCanonicalName(projectId: string, canonicalName: string): Promise<Document | null> {
  const row = await getDb().get<DocumentRow>(
    'SELECT * FROM documents WHERE project_id = ? AND canonical_name = ? COLLATE NOCASE',
    [projectId, canonicalName],
  );
  return row ? mapDocument(row) : null;
}

export async function findDocumentByPath(filesystemPath: string): Promise<Document | null> {
  const row = await getDb().get<DocumentRow>('SELECT * FROM documents WHERE filesystem_path = ?', [
    filesystemPath,
  ]);
  return row ? mapDocument(row) : null;
}

export async function listDocuments(projectId: string): Promise<Document[]> {
  return (await getDb().all<DocumentRow>(
      'SELECT * FROM documents WHERE project_id = ? ORDER BY layer_id, version_sort, created_at',
      [projectId],
    ))
    .map(mapDocument);
}

export async function listDocumentsByLayer(layerId: string): Promise<Document[]> {
  return (await getDb().all<DocumentRow>('SELECT * FROM documents WHERE layer_id = ? ORDER BY version_sort, created_at', [
      layerId,
    ]))
    .map(mapDocument);
}

export interface UpdateDocumentInput {
  storageKey?: string | null;
  storageProvider?: string | null;
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
  mimeType?: string | null;
  detectedFormat?: DocumentFormat | null;
  pageCount?: number | null;
  extractionStatus?: ExtractionStatus;
  extractionRunId?: string | null;
  pipelineVersion?: string | null;
  origin?: DocumentOrigin;
  scope?: DocumentScope;
  classificationSource?: ClassificationSource | null;
  classificationConfidence?: number | null;
  importJobId?: string | null;
  sourcePath?: string | null;
  sourceModifiedAt?: string | null;
}

export async function updateDocument(id: string, patch: UpdateDocumentInput): Promise<Document | null> {
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
    storage_key: patch.storageKey ?? patch.filesystemPath,
    storage_provider: patch.storageProvider,
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
    mime_type: patch.mimeType,
    detected_format: patch.detectedFormat,
    page_count: patch.pageCount,
    extraction_status: patch.extractionStatus,
    extraction_run_id: patch.extractionRunId,
    pipeline_version: patch.pipelineVersion,
    origin: patch.origin,
    scope: patch.scope,
    classification_source: patch.classificationSource,
    classification_confidence: patch.classificationConfidence,
    import_job_id: patch.importJobId,
    source_path: patch.sourcePath,
    source_modified_at: patch.sourceModifiedAt,
  });
  if (!clause) return getDocument(id);
  await getDb().run(`UPDATE documents SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getDocument(id);
}

/** Documents are never deleted in ordinary operation — history is provenance. */
export async function deleteDocument(id: string): Promise<void> {
  await getDb().run('DELETE FROM documents WHERE id = ?', [id]);
}
