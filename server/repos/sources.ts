/**
 * Data access for project-level sources.
 *
 * Segments and their proposed links are derived from one extraction run, so they
 * are replaced wholesale when a source is re-ingested rather than accumulated —
 * with one deliberate exception: a link a person has already decided on survives
 * re-ingestion. Re-reading the file must not silently undo somebody's review.
 */
import { getDb } from '../db/database.ts';
import type {
  DocumentSegment,
  DocumentSegmentRow,
  IngestionReportRow,
  SegmentLayerLink,
  SegmentLayerLinkRow,
  SegmentType,
  LinkStatus,
  LinkType,
} from '../domain/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';

function mapSegment(row: DocumentSegmentRow): DocumentSegment {
  return {
    id: row.id,
    documentId: row.document_id,
    extractionRunId: row.extraction_run_id,
    segmentIndex: Number(row.segment_index),
    segmentType: row.segment_type as SegmentType,
    title: row.title,
    speaker: row.speaker,
    timestampText: row.timestamp_text,
    blockStart: Number(row.block_start),
    blockEnd: Number(row.block_end),
    charStart: Number(row.char_start),
    charEnd: Number(row.char_end),
    text: row.text,
    contentHash: row.content_hash,
    confidence: Number(row.confidence),
    rationale: row.rationale,
    warnings: parseJson<string[]>(row.warnings, []),
    createdAt: row.created_at,
  };
}

function mapLink(row: SegmentLayerLinkRow): SegmentLayerLink {
  return {
    id: row.id,
    documentId: row.document_id,
    segmentId: row.segment_id,
    layerId: row.layer_id,
    version: row.version,
    linkType: row.link_type as LinkType,
    confidence: Number(row.confidence),
    rationale: row.rationale,
    status: row.status as LinkStatus,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

export interface InsertSegmentInput {
  documentId: string;
  extractionRunId: string;
  segmentIndex: number;
  segmentType: SegmentType;
  title: string;
  speaker: string | null;
  timestampText: string | null;
  blockStart: number;
  blockEnd: number;
  charStart: number;
  charEnd: number;
  text: string;
  contentHash: string;
  confidence: number;
  rationale: string;
  warnings: string[];
}

/** Write a run's segments, returning them with their ids. */
export async function insertSegments(inputs: InsertSegmentInput[]): Promise<DocumentSegment[]> {
  if (inputs.length === 0) return [];
  const db = getDb();
  const ts = nowIso();
  const ids: string[] = [];
  await db.transaction(async () => {
    for (const input of inputs) {
      const id = newId('seg');
      ids.push(id);
      await db.run(
        `INSERT INTO document_segments (id, document_id, extraction_run_id, segment_index,
           segment_type, title, speaker, timestamp_text, block_start, block_end, char_start,
           char_end, text, content_hash, confidence, rationale, warnings, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.documentId, input.extractionRunId, input.segmentIndex, input.segmentType,
          input.title, input.speaker, input.timestampText, input.blockStart, input.blockEnd,
          input.charStart, input.charEnd, input.text, input.contentHash, input.confidence,
          input.rationale, toJson(input.warnings), ts],
      );
    }
  });
  const loaded = await Promise.all(ids.map((id) => getSegment(id)));
  return loaded.filter((s): s is DocumentSegment => s !== null);
}

export async function getSegment(id: string): Promise<DocumentSegment | null> {
  const row = await getDb().get<DocumentSegmentRow>('SELECT * FROM document_segments WHERE id = ?', [id]);
  return row ? mapSegment(row) : null;
}

export async function listSegments(documentId: string): Promise<DocumentSegment[]> {
  return (await getDb().all<DocumentSegmentRow>(
      'SELECT * FROM document_segments WHERE document_id = ? ORDER BY segment_index',
      [documentId],
    ))
    .map(mapSegment);
}

/** Remove a document's segments, for a re-ingestion. */
export async function clearSegments(documentId: string): Promise<void> {
  await getDb().run('DELETE FROM document_segments WHERE document_id = ?', [documentId]);
}

export interface InsertLinkInput {
  documentId: string;
  segmentId: string | null;
  layerId: string;
  version: string | null;
  linkType: LinkType;
  confidence: number;
  rationale: string;
  status?: LinkStatus;
  /** Carried over when a decided link is re-anchored to a re-read passage. */
  decidedAt?: string | null;
}

export async function insertLinks(inputs: InsertLinkInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const db = getDb();
  const ts = nowIso();
  await db.transaction(async () => {
    for (const input of inputs) {
      await db.run(
        `INSERT INTO segment_layer_links (id, document_id, segment_id, layer_id, version,
           link_type, confidence, rationale, status, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('lnk'), input.documentId, input.segmentId, input.layerId, input.version,
          input.linkType, input.confidence, input.rationale, input.status ?? 'PROPOSED',
          input.decidedAt ?? null, ts],
      );
    }
  });
}

export async function listLinks(documentId: string): Promise<SegmentLayerLink[]> {
  return (await getDb().all<SegmentLayerLinkRow>(
      'SELECT * FROM segment_layer_links WHERE document_id = ? ORDER BY created_at, rowid',
      [documentId],
    ))
    .map(mapLink);
}

/** Every accepted link into one layer — what that layer may actually draw on. */
export async function listAcceptedLinksForLayer(layerId: string): Promise<SegmentLayerLink[]> {
  return (await getDb().all<SegmentLayerLinkRow>(
      "SELECT * FROM segment_layer_links WHERE layer_id = ? AND status = 'ACCEPTED' ORDER BY created_at",
      [layerId],
    ))
    .map(mapLink);
}

/**
 * A decided link together with the content hash of the passage it was made about.
 *
 * Re-ingestion rebuilds segments from scratch, and the database cascade takes
 * their links with them. A decision, though, is about a passage rather than
 * about a row: the hash is what lets an accepted or excluded link find its
 * passage again in the new run.
 */
export interface DecidedLink {
  contentHash: string | null;
  layerId: string;
  version: string | null;
  linkType: LinkType;
  confidence: number;
  rationale: string;
  status: LinkStatus;
  decidedAt: string | null;
}

export async function listDecidedLinks(documentId: string): Promise<DecidedLink[]> {
  return (await getDb().all<SegmentLayerLinkRow & { content_hash: string | null }>(
      `SELECT l.*, s.content_hash AS content_hash
         FROM segment_layer_links l
         LEFT JOIN document_segments s ON s.id = l.segment_id
        WHERE l.document_id = ? AND l.status != 'PROPOSED'
        ORDER BY l.created_at, l.rowid`,
      [documentId],
    ))
    .map((row) => ({
      contentHash: row.content_hash ?? null,
      layerId: row.layer_id,
      version: row.version,
      linkType: row.link_type as LinkType,
      confidence: Number(row.confidence),
      rationale: row.rationale,
      status: row.status as LinkStatus,
      decidedAt: row.decided_at,
    }));
}

/**
 * Discard only the links nobody has ruled on.
 *
 * Re-reading a file must not undo a review. An accepted or excluded link is a
 * decision somebody made, and it outlives the proposal that prompted it.
 */
export async function clearProposedLinks(documentId: string): Promise<void> {
  await getDb().run("DELETE FROM segment_layer_links WHERE document_id = ? AND status = 'PROPOSED'", [
    documentId,
  ]);
}

export async function decideLink(
  id: string,
  patch: { status: LinkStatus; linkType?: LinkType; layerId?: string; version?: string | null },
): Promise<SegmentLayerLink | null> {
  const db = getDb();
  const fields: Record<string, unknown> = {
    status: patch.status,
    link_type: patch.linkType,
    layer_id: patch.layerId,
    version: patch.version,
    decided_at: nowIso(),
  };
  const keys = Object.keys(fields).filter((key) => fields[key] !== undefined);
  await db.run(
    `UPDATE segment_layer_links SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    [...(keys.map((k) => fields[k]) as never[]), id],
  );
  const row = await getDb().get<SegmentLayerLinkRow>('SELECT * FROM segment_layer_links WHERE id = ?', [id]);
  return row ? mapLink(row) : null;
}

export async function saveIngestionReport(input: {
  documentId: string;
  extractionRunId: string;
  scope: string;
  report: unknown;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO ingestion_reports (id, document_id, extraction_run_id, scope, report, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId('ing'), input.documentId, input.extractionRunId, input.scope, toJson(input.report), nowIso()],
  );
}

/** The most recent ingestion report for a document. */
export async function latestIngestionReport<T>(documentId: string): Promise<T | null> {
  const row = await getDb().get<IngestionReportRow>(
    'SELECT * FROM ingestion_reports WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [documentId],
  );
  return row ? parseJson<T | null>(row.report, null) : null;
}
