/**
 * Ingesting a project-wide source (the master-transcript addendum).
 *
 * The failure this exists to correct: a file was copied into storage, its name
 * was parsed, and that was called an import. Storing a file is not reading it.
 *
 * What happens instead:
 *
 *   original preserved -> extracted and normalized -> chunked and indexed
 *   -> segmented on the text's own boundaries -> each segment typed
 *   -> each segment classified against the project's layers
 *   -> links proposed with confidence and rationale -> report
 *
 * Nothing here becomes layer evidence. Every link is a proposal a person accepts,
 * changes or excludes, because a transcript is a record of thinking rather than a
 * set of audited artifacts — and a chat message promoted straight into a layer
 * would be exactly the false confidence the audit engine exists to prevent.
 *
 * The transcript is untrusted input throughout. It is matched against, counted
 * and quoted; it is never followed.
 */
import type { Document, DocumentScope } from '../../domain/types.ts';
import { getDocument, updateDocument } from '../../repos/documents.ts';
import { listLayers } from '../../repos/layers.ts';
import { getProject } from '../../repos/projects.ts';
import { recordEvent } from '../../repos/events.ts';
import { getCurrentExtractionRun, listBlocks, listChunks } from '../../repos/extraction.ts';
import {
  clearProposedLinks,
  clearSegments,
  insertLinks,
  insertSegments,
  listDecidedLinks,
  listLinks,
  listSegments,
  saveIngestionReport,
  type InsertLinkInput,
} from '../../repos/sources.ts';
import { enqueueExtraction } from '../documents/queue.ts';
import { isAuditable } from '../documents/quality.ts';
import { segmentBlocks, type SegmentType } from './segmenter.ts';
import { classifyToLayers, detectInjection } from './classify.ts';

/** What one ingestion read and concluded. */
export interface IngestionReport {
  documentId: string;
  canonicalName: string;
  filename: string;
  scope: DocumentScope;
  extractionRunId: string;
  extractionStatus: string;

  characters: number;
  /** Estimated, and labelled as such: no tokenizer is bundled. */
  estimatedTokens: number;
  pages: number;
  blocks: number;
  chunks: number;

  segments: number;
  segmentsByType: Record<string, number>;

  researchAssignments: number;
  returnedReports: number;
  audits: number;
  decisions: number;
  revisions: number;
  supersededConclusions: number;
  unresolvedGaps: number;
  attachmentReferences: number;

  proposedLinks: number;
  acceptedLinks: number;
  excludedLinks: number;
  /** Distinct layers this one source touches. */
  layersTouched: { layerId: string; layerName: string; segments: number; topConfidence: number }[];

  lowConfidenceSegments: number;
  lowConfidenceLinks: number;
  warnings: string[];
  /** Passages that try to issue instructions. Flagged, never obeyed. */
  suspiciousSegments: { segmentIndex: number; title: string; matched: string[] }[];

  generatedAt: string;
}

/** Rough token estimate. English prose runs about four characters per token. */
function estimateTokens(characters: number): number {
  return Math.round(characters / 4);
}

const LOW_CONFIDENCE = 0.5;

export interface IngestInput {
  documentId: string;
  /** Defaults to the document's current scope. */
  scope?: DocumentScope;
  /** Re-extract even when the bytes are unchanged. */
  force?: boolean;
  /** Below this, a layer link is not proposed at all. */
  minLinkConfidence?: number;
}

/**
 * Read a source properly and propose what it connects to.
 *
 * Idempotent: running it again replaces the derived segments and the proposals
 * nobody has ruled on, and leaves decided links alone.
 */
export async function ingestSource(input: IngestInput): Promise<IngestionReport> {
  const document = await getDocument(input.documentId);
  if (!document) throw new Error(`Cannot ingest: unknown document ${input.documentId}`);
  const project = await getProject(document.projectId);
  if (!project) throw new Error(`Cannot ingest: unknown project ${document.projectId}`);

  const scope: DocumentScope = input.scope ?? document.scope ?? 'LAYER';

  // Reading the file is the first step, not an afterthought. Everything below
  // depends on text that actually came out of it.
  //
  // Through the queue rather than straight into the extractor: an import has
  // usually just scheduled this same document, and two extractions of one file
  // racing leaves both runs superseded by the other — a document with no current
  // reading at all. The queue exists to make that impossible, so this joins it.
  const extraction = await enqueueExtraction(document.id, { force: input.force ?? false });
  const run = await getCurrentExtractionRun(document.id);
  if (!run) throw new Error('Cannot ingest: the document produced no extraction run.');

  const warnings = [...run.warnings];

  if (!isAuditable(run.status)) {
    // Nothing to segment. The report still gets written, because "we could not
    // read it, and here is why" is the answer the user needs.
    const report = emptyReport(document, scope, run.id, run.status, [
      run.blockedReason ?? 'The document could not be read.',
      ...warnings,
    ]);
    await saveIngestionReport({
      documentId: document.id,
      extractionRunId: run.id,
      scope,
      report,
    });
    return report;
  }

  const blocks = await listBlocks(run.id);
  const chunks = await listChunks(run.id);
  const layers = await listLayers(project.id);

  const segments = segmentBlocks(blocks);

  // Derived state is rebuilt, and decided links survive it. They are held by the
  // content hash of the passage they were made about, because the segment rows
  // themselves are about to be replaced — a decision belongs to the text, not to
  // the row that happened to carry it on the last read.
  const decided = await listDecidedLinks(document.id);
  await clearSegments(document.id);
  await clearProposedLinks(document.id);

  const stored = await insertSegments(
    segments.map((segment) => ({
      documentId: document.id,
      extractionRunId: run.id,
      segmentIndex: segment.segmentIndex,
      segmentType: segment.segmentType,
      title: segment.title,
      speaker: segment.speaker,
      timestampText: segment.timestampText,
      blockStart: segment.blockStart,
      blockEnd: segment.blockEnd,
      charStart: segment.charStart,
      charEnd: segment.charEnd,
      text: segment.text,
      contentHash: segment.contentHash,
      confidence: segment.confidence,
      rationale: segment.rationale,
      warnings: segment.warnings,
    })),
  );

  // Re-anchor each decision onto the passage it was about. A passage that is no
  // longer in the file keeps its decision as a document-level link, and says so,
  // rather than vanishing.
  const segmentByHash = new Map<string, string>();
  for (const [index, segment] of segments.entries()) {
    const record = stored[index];
    if (record) segmentByHash.set(segment.contentHash, record.id);
  }

  const restored: InsertLinkInput[] = [];
  let orphanedDecisions = 0;
  for (const link of decided) {
    const segmentId = link.contentHash === null ? null : segmentByHash.get(link.contentHash) ?? null;
    const orphaned = link.contentHash !== null && segmentId === null;
    if (orphaned) orphanedDecisions += 1;
    restored.push({
      documentId: document.id,
      segmentId,
      layerId: link.layerId,
      version: link.version,
      linkType: link.linkType,
      confidence: link.confidence,
      rationale: orphaned
        ? `${link.rationale} (The passage this decision was made about is no longer in the file.)`
        : link.rationale,
      status: link.status,
      decidedAt: link.decidedAt,
    });
  }
  await insertLinks(restored);

  const alreadyDecided = new Set(
    restored
      .filter((link) => link.segmentId !== null)
      .map((link) => `${link.segmentId}:${link.layerId}`),
  );

  const proposals: InsertLinkInput[] = [];
  const suspicious: IngestionReport['suspiciousSegments'] = [];
  let lowConfidenceLinks = 0;

  for (const [index, segment] of segments.entries()) {
    const record = stored[index];
    if (!record) continue;

    const injection = detectInjection(segment.text);
    if (injection.length > 0) {
      suspicious.push({
        segmentIndex: segment.segmentIndex,
        title: segment.title,
        matched: injection,
      });
    }

    // A whole-source scope classifies per segment; a layer document is one
    // subject and is classified once, at the document level.
    const matches = classifyToLayers({
      text: segment.text,
      layers,
      projectSlug: project.slug,
      segmentType: segment.segmentType,
      ...(input.minLinkConfidence === undefined ? {} : { minConfidence: input.minLinkConfidence }),
    });

    for (const match of matches) {
      if (alreadyDecided.has(`${record.id}:${match.layerId}`)) continue;
      if (match.confidence < LOW_CONFIDENCE) lowConfidenceLinks += 1;
      proposals.push({
        documentId: document.id,
        segmentId: record.id,
        layerId: match.layerId,
        version: match.version,
        linkType: match.linkType,
        confidence: match.confidence,
        rationale: match.rationale,
      });
    }
  }

  await insertLinks(proposals);

  if (orphanedDecisions > 0) {
    warnings.push(
      `${orphanedDecisions} previously decided link(s) refer to a passage that is no longer in ` +
        'this file. They were kept, unattached, rather than discarded.',
    );
  }

  if (suspicious.length > 0) {
    warnings.push(
      `${suspicious.length} passage(s) contain text that reads like an instruction to an AI. ` +
        'They are stored as data and flagged for review; instructions found inside imported ' +
        'text are never executed.',
    );
  }

  // Record the scope and say plainly that the layer came from the content.
  await updateDocument(document.id, {
    scope,
    classificationSource: 'CONTENT',
    classificationConfidence: highestConfidence(proposals),
  });

  const report = buildReport({
    document,
    scope,
    run: { id: run.id, status: run.status, pages: run.pagesExpected, characters: run.characterCount },
    blocks: blocks.length,
    chunks: chunks.length,
    segments,
    links: await listLinks(document.id),
    layers,
    warnings,
    suspicious,
    lowConfidenceLinks,
  });

  await saveIngestionReport({
    documentId: document.id,
    extractionRunId: run.id,
    scope,
    report,
  });

  await recordEvent({
    projectId: document.projectId,
    layerId: document.layerId,
    entityType: 'DOCUMENT',
    entityId: document.id,
    eventType: 'DOCUMENT_INDEXED',
    payload: {
      scope,
      segments: report.segments,
      proposedLinks: report.proposedLinks,
      layersTouched: report.layersTouched.length,
      extractionRunId: run.id,
    },
  });

  void extraction;
  return report;
}

function highestConfidence(links: InsertLinkInput[]): number {
  return links.reduce((best, link) => Math.max(best, link.confidence), 0);
}

function emptyReport(
  document: Document,
  scope: DocumentScope,
  runId: string,
  status: string,
  warnings: string[],
): IngestionReport {
  return {
    documentId: document.id,
    canonicalName: document.canonicalName,
    filename: document.filename ?? '',
    scope,
    extractionRunId: runId,
    extractionStatus: status,
    characters: 0,
    estimatedTokens: 0,
    pages: 0,
    blocks: 0,
    chunks: 0,
    segments: 0,
    segmentsByType: {},
    researchAssignments: 0,
    returnedReports: 0,
    audits: 0,
    decisions: 0,
    revisions: 0,
    supersededConclusions: 0,
    unresolvedGaps: 0,
    attachmentReferences: 0,
    proposedLinks: 0,
    acceptedLinks: 0,
    excludedLinks: 0,
    layersTouched: [],
    lowConfidenceSegments: 0,
    lowConfidenceLinks: 0,
    warnings,
    suspiciousSegments: [],
    generatedAt: new Date().toISOString(),
  };
}

function buildReport(input: {
  document: Document;
  scope: DocumentScope;
  run: { id: string; status: string; pages: number; characters: number };
  blocks: number;
  chunks: number;
  segments: { segmentType: SegmentType; confidence: number }[];
  links: { layerId: string; segmentId: string | null; status: string; confidence: number }[];
  layers: { id: string; name: string }[];
  warnings: string[];
  suspicious: IngestionReport['suspiciousSegments'];
  lowConfidenceLinks: number;
}): IngestionReport {
  const byType: Record<string, number> = {};
  for (const segment of input.segments) {
    byType[segment.segmentType] = (byType[segment.segmentType] ?? 0) + 1;
  }

  const layerName = new Map(input.layers.map((layer) => [layer.id, layer.name]));
  const touched = new Map<string, { segments: Set<string>; topConfidence: number }>();
  for (const link of input.links) {
    if (link.status === 'EXCLUDED') continue;
    const entry = touched.get(link.layerId) ?? { segments: new Set<string>(), topConfidence: 0 };
    entry.segments.add(link.segmentId ?? 'document');
    entry.topConfidence = Math.max(entry.topConfidence, link.confidence);
    touched.set(link.layerId, entry);
  }

  return {
    documentId: input.document.id,
    canonicalName: input.document.canonicalName,
    filename: input.document.filename ?? '',
    scope: input.scope,
    extractionRunId: input.run.id,
    extractionStatus: input.run.status,

    characters: input.run.characters,
    estimatedTokens: estimateTokens(input.run.characters),
    pages: input.run.pages,
    blocks: input.blocks,
    chunks: input.chunks,

    segments: input.segments.length,
    segmentsByType: byType,

    researchAssignments: byType['RESEARCH_ASSIGNMENT'] ?? 0,
    returnedReports: byType['RETURNED_RESEARCH'] ?? 0,
    audits: byType['AUDIT'] ?? 0,
    decisions: byType['DECISION'] ?? 0,
    revisions: byType['REVISION'] ?? 0,
    supersededConclusions: byType['SUPERSEDED'] ?? 0,
    unresolvedGaps: byType['OPEN_GAP'] ?? 0,
    attachmentReferences: byType['ATTACHMENT_REF'] ?? 0,

    proposedLinks: input.links.filter((link) => link.status === 'PROPOSED').length,
    acceptedLinks: input.links.filter((link) => link.status === 'ACCEPTED').length,
    excludedLinks: input.links.filter((link) => link.status === 'EXCLUDED').length,
    layersTouched: [...touched.entries()]
      .map(([layerId, entry]) => ({
        layerId,
        layerName: layerName.get(layerId) ?? layerId,
        segments: entry.segments.size,
        topConfidence: Number(entry.topConfidence.toFixed(2)),
      }))
      .sort((a, b) => b.segments - a.segments),

    lowConfidenceSegments: input.segments.filter((s) => s.confidence < LOW_CONFIDENCE).length,
    lowConfidenceLinks: input.lowConfidenceLinks,
    warnings: input.warnings,
    suspiciousSegments: input.suspicious,

    generatedAt: new Date().toISOString(),
  };
}

/**
 * Relevant segments for one question (spec item 12).
 *
 * The whole transcript is never handed to a provider. This picks the passages
 * that bear on a specific task, within a character budget, so a research or
 * classification call sees what it needs and nothing else.
 */
export async function selectRelevantSegments(input: {
  documentId: string;
  query: string;
  budgetChars?: number;
  limit?: number;
}): Promise<{ segmentId: string; title: string; score: number; text: string }[]> {
  const budget = input.budgetChars ?? 20_000;
  const limit = input.limit ?? 12;
  const terms = [
    ...new Set(
      input.query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 3),
    ),
  ];
  if (terms.length === 0) return [];

  const scored = (await listSegments(input.documentId))
    .map((segment) => {
      const lowered = segment.text.toLowerCase();
      const matched = terms.filter((term) => lowered.includes(term));
      return {
        segmentId: segment.id,
        title: segment.title,
        score: Number((matched.length / terms.length).toFixed(4)),
        text: segment.text,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked: typeof scored = [];
  let used = 0;
  for (const entry of scored) {
    if (picked.length >= limit || used + entry.text.length > budget) continue;
    picked.push(entry);
    used += entry.text.length;
  }
  return picked;
}
