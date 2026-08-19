/**
 * Data access for document understanding.
 *
 * An extraction run is immutable once finished: reprocessing creates a new run
 * and marks the old one superseded, so an audit recorded months ago still points
 * at the exact text it actually read.
 */
import { getDb } from '../db/database.ts';
import type {
  AuditEvidence,
  AuditEvidenceRow,
  BlockType,
  DocumentBlock,
  DocumentBlockRow,
  DocumentChunk,
  DocumentChunkRow,
  DocumentFinding,
  DocumentFindingRow,
  DocumentFindingType,
  DocumentFormat,
  ExtractionMethod,
  ExtractionRun,
  ExtractionRunRow,
  ExtractionStatus,
} from '../domain/types.ts';
import { fromBool, newId, nowIso, parseJson, toBool, toJson } from './util.ts';

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function mapExtractionRun(row: ExtractionRunRow): ExtractionRun {
  return {
    id: row.id,
    documentId: row.document_id,
    projectId: row.project_id,
    status: row.status as ExtractionStatus,
    pipelineVersion: row.pipeline_version,
    detectedFormat: (row.detected_format as DocumentFormat | null) ?? null,
    sourceHash: row.source_hash,
    pagesExpected: Number(row.pages_expected),
    pagesReadable: Number(row.pages_readable),
    pagesOcr: Number(row.pages_ocr),
    pagesFailed: parseJson<number[]>(row.pages_failed, []),
    characterCount: Number(row.character_count),
    coverageRatio: Number(row.coverage_ratio),
    warnings: parseJson<string[]>(row.warnings, []),
    blockedReason: row.blocked_reason,
    error: row.error,
    supersededByRunId: row.superseded_by_run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBlock(row: DocumentBlockRow): DocumentBlock {
  return {
    id: row.id,
    extractionRunId: row.extraction_run_id,
    documentId: row.document_id,
    pageNumber: Number(row.page_number),
    blockIndex: Number(row.block_index),
    blockType: row.block_type as BlockType,
    rawText: row.raw_text,
    normalizedText: row.normalized_text,
    charStart: Number(row.char_start),
    charEnd: Number(row.char_end),
    extractionMethod: row.extraction_method as ExtractionMethod,
    confidence: row.confidence === null ? null : Number(row.confidence),
    warnings: parseJson<string[]>(row.warnings, []),
    contentHash: row.content_hash,
    bbox: parseJson<[number, number, number, number] | null>(row.bbox, null),
    createdAt: row.created_at,
  };
}

function mapChunk(row: DocumentChunkRow): DocumentChunk {
  return {
    id: row.id,
    extractionRunId: row.extraction_run_id,
    documentId: row.document_id,
    chunkIndex: Number(row.chunk_index),
    pageStart: Number(row.page_start),
    pageEnd: Number(row.page_end),
    blockStart: Number(row.block_start),
    blockEnd: Number(row.block_end),
    headingPath: parseJson<string[]>(row.heading_path, []),
    text: row.text,
    charCount: Number(row.char_count),
    charStart: Number(row.char_start),
    charEnd: Number(row.char_end),
    overlapPrev: Number(row.overlap_prev),
    hasOcr: toBool(row.has_ocr),
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

function mapFinding(row: DocumentFindingRow): DocumentFinding {
  return {
    id: row.id,
    extractionRunId: row.extraction_run_id,
    documentId: row.document_id,
    chunkId: row.chunk_id,
    findingType: row.finding_type as DocumentFindingType,
    ordinal: Number(row.ordinal),
    content: row.content,
    evidencePage: row.evidence_page === null ? null : Number(row.evidence_page),
    evidenceQuote: row.evidence_quote,
    confidence: row.confidence === null ? null : Number(row.confidence),
    source: row.source,
    createdAt: row.created_at,
  };
}

function mapEvidence(row: AuditEvidenceRow): AuditEvidence {
  return {
    id: row.id,
    auditId: row.audit_id,
    gapId: row.gap_id,
    documentId: row.document_id,
    extractionRunId: row.extraction_run_id,
    chunkId: row.chunk_id,
    documentLabel: row.document_label,
    pageNumber: row.page_number === null ? null : Number(row.page_number),
    quote: row.quote,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Extraction runs
// ---------------------------------------------------------------------------

export function createExtractionRun(input: {
  documentId: string;
  projectId: string;
  pipelineVersion: string;
  detectedFormat?: DocumentFormat | null;
  sourceHash?: string | null;
  status?: ExtractionStatus;
}): ExtractionRun {
  const id = newId('exr');
  const ts = nowIso();
  getDb().run(
    `INSERT INTO extraction_runs (id, document_id, project_id, status, pipeline_version,
       detected_format, source_hash, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.documentId, input.projectId, input.status ?? 'QUEUED', input.pipelineVersion,
      input.detectedFormat ?? null, input.sourceHash ?? null, ts, ts, ts],
  );
  return getExtractionRun(id)!;
}

export function getExtractionRun(id: string): ExtractionRun | null {
  const row = getDb().get<ExtractionRunRow>('SELECT * FROM extraction_runs WHERE id = ?', [id]);
  return row ? mapExtractionRun(row) : null;
}

export function listExtractionRuns(documentId: string): ExtractionRun[] {
  return getDb()
    .all<ExtractionRunRow>(
      'SELECT * FROM extraction_runs WHERE document_id = ? ORDER BY created_at DESC, rowid DESC',
      [documentId],
    )
    .map(mapExtractionRun);
}

/** The run whose evidence is current for a document. */
export function getCurrentExtractionRun(documentId: string): ExtractionRun | null {
  const row = getDb().get<ExtractionRunRow>(
    `SELECT * FROM extraction_runs
     WHERE document_id = ? AND superseded_by_run_id IS NULL
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [documentId],
  );
  return row ? mapExtractionRun(row) : null;
}

export function updateExtractionRun(
  id: string,
  patch: {
    status?: ExtractionStatus;
    detectedFormat?: DocumentFormat | null;
    pagesExpected?: number;
    pagesReadable?: number;
    pagesOcr?: number;
    pagesFailed?: number[];
    characterCount?: number;
    coverageRatio?: number;
    warnings?: string[];
    blockedReason?: string | null;
    error?: string | null;
    supersededByRunId?: string | null;
    completedAt?: string | null;
  },
): ExtractionRun | null {
  const fields: Record<string, unknown> = {
    status: patch.status,
    detected_format: patch.detectedFormat,
    pages_expected: patch.pagesExpected,
    pages_readable: patch.pagesReadable,
    pages_ocr: patch.pagesOcr,
    pages_failed: patch.pagesFailed ? toJson(patch.pagesFailed) : undefined,
    character_count: patch.characterCount,
    coverage_ratio: patch.coverageRatio,
    warnings: patch.warnings ? toJson(patch.warnings) : undefined,
    blocked_reason: patch.blockedReason,
    error: patch.error,
    superseded_by_run_id: patch.supersededByRunId,
    completed_at: patch.completedAt,
  };
  const keys = Object.keys(fields).filter((key) => fields[key] !== undefined);
  if (keys.length === 0) return getExtractionRun(id);
  getDb().run(
    `UPDATE extraction_runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...(keys.map((k) => fields[k]) as never[]), nowIso(), id],
  );
  return getExtractionRun(id);
}

/**
 * Runs left mid-flight by a crash. They are recoverable, and crucially they are
 * never mistaken for a document that was successfully read.
 */
export function listUnfinishedExtractionRuns(): ExtractionRun[] {
  return getDb()
    .all<ExtractionRunRow>(
      `SELECT * FROM extraction_runs
       WHERE status IN ('QUEUED','EXTRACTING','OCR','INDEXING')
       ORDER BY created_at`,
    )
    .map(mapExtractionRun);
}

// ---------------------------------------------------------------------------
// Blocks, chunks, findings
// ---------------------------------------------------------------------------

export interface InsertBlockInput {
  extractionRunId: string;
  documentId: string;
  pageNumber: number;
  blockIndex: number;
  blockType: BlockType;
  rawText: string;
  normalizedText: string;
  charStart: number;
  charEnd: number;
  extractionMethod: ExtractionMethod;
  confidence?: number | null;
  warnings?: string[];
  contentHash: string;
  bbox?: [number, number, number, number] | null;
}

export function insertBlocks(blocks: InsertBlockInput[]): void {
  if (blocks.length === 0) return;
  const db = getDb();
  const ts = nowIso();
  db.transaction(() => {
    for (const block of blocks) {
      db.run(
        `INSERT INTO document_blocks (id, extraction_run_id, document_id, page_number, block_index,
           block_type, raw_text, normalized_text, char_start, char_end, extraction_method,
           confidence, warnings, content_hash, bbox, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('blk'), block.extractionRunId, block.documentId, block.pageNumber, block.blockIndex,
          block.blockType, block.rawText, block.normalizedText, block.charStart, block.charEnd,
          block.extractionMethod, block.confidence ?? null, toJson(block.warnings ?? []),
          block.contentHash, block.bbox ? toJson(block.bbox) : null, ts],
      );
    }
  });
}

export function listBlocks(extractionRunId: string): DocumentBlock[] {
  return getDb()
    .all<DocumentBlockRow>(
      'SELECT * FROM document_blocks WHERE extraction_run_id = ? ORDER BY page_number, block_index',
      [extractionRunId],
    )
    .map(mapBlock);
}

export function listBlocksForPage(extractionRunId: string, pageNumber: number): DocumentBlock[] {
  return getDb()
    .all<DocumentBlockRow>(
      'SELECT * FROM document_blocks WHERE extraction_run_id = ? AND page_number = ? ORDER BY block_index',
      [extractionRunId, pageNumber],
    )
    .map(mapBlock);
}

export interface InsertChunkInput {
  extractionRunId: string;
  documentId: string;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  blockStart: number;
  blockEnd: number;
  headingPath: string[];
  text: string;
  charStart: number;
  charEnd: number;
  overlapPrev: number;
  hasOcr: boolean;
  contentHash: string;
}

export function insertChunks(chunks: InsertChunkInput[]): DocumentChunk[] {
  if (chunks.length === 0) return [];
  const db = getDb();
  const ts = nowIso();
  const ids: string[] = [];
  db.transaction(() => {
    for (const chunk of chunks) {
      const id = newId('chk');
      ids.push(id);
      db.run(
        `INSERT INTO document_chunks (id, extraction_run_id, document_id, chunk_index, page_start,
           page_end, block_start, block_end, heading_path, text, char_count, char_start, char_end,
           overlap_prev, has_ocr, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, chunk.extractionRunId, chunk.documentId, chunk.chunkIndex, chunk.pageStart,
          chunk.pageEnd, chunk.blockStart, chunk.blockEnd, toJson(chunk.headingPath), chunk.text,
          chunk.text.length, chunk.charStart, chunk.charEnd, chunk.overlapPrev,
          fromBool(chunk.hasOcr), chunk.contentHash, ts],
      );
    }
  });
  return listChunks(chunks[0]!.extractionRunId);
}

export function listChunks(extractionRunId: string): DocumentChunk[] {
  return getDb()
    .all<DocumentChunkRow>(
      'SELECT * FROM document_chunks WHERE extraction_run_id = ? ORDER BY chunk_index',
      [extractionRunId],
    )
    .map(mapChunk);
}

export function getChunk(id: string): DocumentChunk | null {
  const row = getDb().get<DocumentChunkRow>('SELECT * FROM document_chunks WHERE id = ?', [id]);
  return row ? mapChunk(row) : null;
}

export function insertFindings(
  findings: {
    extractionRunId: string;
    documentId: string;
    chunkId: string | null;
    findingType: DocumentFindingType;
    ordinal: number;
    content: string;
    evidencePage?: number | null;
    evidenceQuote?: string;
    confidence?: number | null;
    source?: string;
  }[],
): void {
  if (findings.length === 0) return;
  const db = getDb();
  const ts = nowIso();
  db.transaction(() => {
    for (const finding of findings) {
      db.run(
        `INSERT INTO document_findings (id, extraction_run_id, document_id, chunk_id, finding_type,
           ordinal, content, evidence_page, evidence_quote, confidence, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('dfn'), finding.extractionRunId, finding.documentId, finding.chunkId,
          finding.findingType, finding.ordinal, finding.content, finding.evidencePage ?? null,
          finding.evidenceQuote ?? '', finding.confidence ?? null, finding.source ?? 'PROVIDER', ts],
      );
    }
  });
}

export function listDocumentFindings(extractionRunId: string): DocumentFinding[] {
  return getDb()
    .all<DocumentFindingRow>(
      'SELECT * FROM document_findings WHERE extraction_run_id = ? ORDER BY finding_type, ordinal',
      [extractionRunId],
    )
    .map(mapFinding);
}

// ---------------------------------------------------------------------------
// Audit evidence
// ---------------------------------------------------------------------------

export function insertAuditEvidence(
  entries: {
    auditId: string;
    gapId?: string | null;
    documentId?: string | null;
    extractionRunId?: string | null;
    chunkId?: string | null;
    documentLabel: string;
    pageNumber?: number | null;
    quote: string;
  }[],
): void {
  if (entries.length === 0) return;
  const db = getDb();
  const ts = nowIso();
  db.transaction(() => {
    for (const entry of entries) {
      db.run(
        `INSERT INTO audit_evidence (id, audit_id, gap_id, document_id, extraction_run_id, chunk_id,
           document_label, page_number, quote, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('aev'), entry.auditId, entry.gapId ?? null, entry.documentId ?? null,
          entry.extractionRunId ?? null, entry.chunkId ?? null, entry.documentLabel,
          entry.pageNumber ?? null, entry.quote, ts],
      );
    }
  });
}

export function listAuditEvidence(auditId: string): AuditEvidence[] {
  return getDb()
    .all<AuditEvidenceRow>('SELECT * FROM audit_evidence WHERE audit_id = ? ORDER BY rowid', [auditId])
    .map(mapEvidence);
}
