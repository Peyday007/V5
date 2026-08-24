/**
 * The extraction pipeline.
 *
 *   preserve original -> detect format -> extract pages/blocks -> OCR where needed
 *   -> normalize (keeping raw) -> measure quality -> chunk with anchors
 *   -> READY / READY_WITH_WARNINGS / BLOCKED
 *
 * Runs are append-only: reprocessing creates a new run and supersedes the old
 * one, so an audit recorded last month still resolves to the text it actually
 * read. A crash leaves the run in a recoverable state, never in one that looks
 * successful.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type {
  Document,
  DocumentFormat,
  ExtractionMethod,
  ExtractionQuality,
  ExtractionRun,
  OcrPageRecord,
} from '../../domain/types.ts';
import { recordEvent } from '../../repos/events.ts';
import { getDocument, updateDocument } from '../../repos/documents.ts';
import {
  createExtractionRun,
  getCurrentExtractionRun,
  insertBlocks,
  insertChunks,
  listBlocks,
  listUnfinishedExtractionRuns,
  supersedePreviousRuns,
  updateExtractionRun,
  type InsertBlockInput,
} from '../../repos/extraction.ts';
import { objectExists, readObject } from '../storage.ts';
import { detectFormat } from './formats.ts';
import { extractDocx, DocxUnreadableError } from './docx.ts';
import { extractPdf, PdfUnreadableError, type ExtractedBlock, type ExtractedPage } from './pdf.ts';
import { extractText } from './text.ts';
import { getOcrEngine, LOW_CONFIDENCE, type OcrPageResult } from './ocr.ts';
import { normalizeBlockText } from './normalize.ts';
import { assessExtraction, pagesNeedingOcr, PIPELINE_VERSION } from './quality.ts';
import { planChunks } from './chunker.ts';

export interface ExtractionResult {
  run: ExtractionRun;
  quality: ExtractionQuality;
  document: Document;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function methodFor(format: DocumentFormat): ExtractionMethod {
  switch (format) {
    case 'PDF':
      return 'NATIVE';
    case 'DOCX':
      return 'DOCX';
    case 'PASTED':
      return 'PASTED';
    default:
      return 'TEXT';
  }
}

/**
 * Read the pages of a document by format. Throws only for genuinely unreadable
 * input; a partly-readable file returns pages and lets the quality gate judge.
 */
async function readPages(
  format: DocumentFormat,
  buffer: Buffer,
): Promise<{ pages: ExtractedPage[]; warnings: string[]; blockedReason: string | null }> {
  switch (format) {
    case 'PDF': {
      try {
        const result = await extractPdf(buffer);
        return { pages: result.pages, warnings: [], blockedReason: null };
      } catch (error) {
        if (error instanceof PdfUnreadableError) {
          return { pages: [], warnings: [], blockedReason: `${error.reason} ${error.recovery}` };
        }
        throw error;
      }
    }
    case 'DOCX': {
      try {
        const result = await extractDocx(buffer);
        return { pages: result.pages, warnings: result.warnings, blockedReason: null };
      } catch (error) {
        if (error instanceof DocxUnreadableError) {
          return { pages: [], warnings: [], blockedReason: `${error.reason} ${error.recovery}` };
        }
        throw error;
      }
    }
    case 'TEXT':
    case 'MARKDOWN':
    case 'PASTED':
      return {
        pages: extractText(buffer, format === 'MARKDOWN').pages,
        warnings: [],
        blockedReason: null,
      };
    default:
      return {
        pages: [],
        warnings: [],
        blockedReason:
          'Brain cannot read this file format. The original is preserved and remains visibly ' +
          'unreadable; convert it to PDF, DOCX, TXT or Markdown and import that.',
      };
  }
}

export interface OcrOutcome {
  /** Pages OCR actually produced usable text for. */
  ocrPages: number[];
  warnings: string[];
  /** Per-page provenance, including the pages OCR was asked for and failed. */
  records: OcrPageRecord[];
  engine: string | null;
  engineVersion: string | null;
  rendererVersion: string | null;
}

/**
 * OCR the pages that need it, and fold the results back into the page list.
 *
 * Selective by construction: `pagesNeedingOcr` has already decided which pages
 * carry no usable text layer, and only those are rendered. A readable page is
 * never re-read merely because a different page in the same document is a scan.
 */
async function applyOcr(
  format: DocumentFormat,
  buffer: Buffer,
  pages: ExtractedPage[],
): Promise<OcrOutcome> {
  const none: OcrOutcome = {
    ocrPages: [],
    warnings: [],
    records: [],
    engine: null,
    engineVersion: null,
    rendererVersion: null,
  };
  if (format !== 'PDF') return none;
  const candidates = pagesNeedingOcr(pages);
  if (candidates.length === 0) return none;

  const engine = getOcrEngine();
  if (!engine.available) {
    return {
      ...none,
      engine: engine.name,
      warnings: [
        `${candidates.length} page(s) appear to be scanned and need OCR (pages ` +
          `${candidates.join(', ')}). ${engine.reason}`,
      ],
      // Recorded as attempted-and-unavailable, so the run says which pages were
      // never read rather than leaving it to be inferred from a gap.
      records: candidates.map((page) => ({
        page,
        ok: false,
        imageHash: null,
        width: null,
        height: null,
        dpi: null,
        confidence: null,
        durationMs: null,
        blocks: 0,
        characters: 0,
        warnings: [engine.reason],
      })),
    };
  }

  const results = await engine.recognizePages(buffer, candidates);
  const ocrPages: number[] = [];
  const warnings: string[] = [];
  const records: OcrPageRecord[] = [];

  for (const result of results) {
    warnings.push(...result.warnings);
    const page = pages.find((entry) => entry.pageNumber === result.pageNumber);
    const usable = page !== undefined && result.text.trim().length > 0;

    if (usable) {
      // OCR text replaces the empty native extraction for that page only, and is
      // labelled so the auditor knows it is recognition rather than transcription.
      const confidenceNote =
        result.confidence !== null && result.confidence < LOW_CONFIDENCE
          ? `Read by OCR at ${Math.round(result.confidence * 100)}% confidence; verify the wording against the original.`
          : 'Read by OCR; wording may contain recognition errors.';

      page.blocks = ocrBlocksFor(result, confidenceNote);
      page.characterCount = page.blocks.reduce((total, block) => total + block.text.length, 0);
      page.signals.nearlyEmpty = page.characterCount < 40;
      ocrPages.push(result.pageNumber);
    }

    records.push({
      page: result.pageNumber,
      ok: usable,
      imageHash: result.imageHash ?? null,
      width: result.imageWidth ?? null,
      height: result.imageHeight ?? null,
      dpi: result.dpi ?? null,
      confidence: result.confidence,
      durationMs: result.durationMs ?? null,
      blocks: usable ? (page?.blocks.length ?? 0) : 0,
      characters: usable ? (page?.characterCount ?? 0) : 0,
      warnings: result.warnings,
    });
  }

  return {
    ocrPages,
    warnings,
    records,
    engine: engine.name,
    engineVersion: engine.version,
    rendererVersion: engine.rendererVersion,
  };
}

/**
 * Turn one OCR result into blocks.
 *
 * An engine that reports structure gives us its paragraphs, their bounding boxes
 * and their confidence; one that only returns text gets split on blank lines.
 * Either way every block says it was read by recognition.
 */
function ocrBlocksFor(result: OcrPageResult, note: string): ExtractedBlock[] {
  if (result.blocks && result.blocks.length > 0) {
    return result.blocks.map<ExtractedBlock>((block) => ({
      pageNumber: result.pageNumber,
      blockType: block.blockType,
      text: block.text,
      bbox: block.bbox,
      confidence: block.confidence,
      warnings: [
        block.confidence !== null && block.confidence < LOW_CONFIDENCE
          ? `Read by OCR at ${Math.round(block.confidence * 100)}% confidence; verify the wording against the original.`
          : note,
      ],
    }));
  }
  return result.text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0)
    .map<ExtractedBlock>((paragraph) => ({
      pageNumber: result.pageNumber,
      blockType: 'PARAGRAPH',
      text: paragraph,
      bbox: null,
      confidence: result.confidence,
      warnings: [note],
    }));
}

/**
 * Extract one document.
 *
 * Idempotent by content: re-running against unchanged bytes with an existing
 * READY run returns that run rather than doing the work twice, unless `force` is
 * set (the REPROCESS button).
 */
export async function extractDocument(
  documentId: string,
  options: { force?: boolean } = {},
): Promise<ExtractionResult> {
  const document = await getDocument(documentId);
  if (!document) throw new Error(`Cannot extract: unknown document ${documentId}`);
  if (!document.filesystemPath || !await objectExists(document.filesystemPath)) {
    // Invariant 9 territory: a row whose file is gone is not evidence.
    const run = await createExtractionRun({
      documentId: document.id,
      projectId: document.projectId,
      pipelineVersion: PIPELINE_VERSION,
      status: 'BLOCKED',
    });
    const quality = assessExtraction({
      pages: [],
      ocrPages: [],
      warnings: [],
      blockedReason: 'The registered file is missing from disk, so there is nothing to read.',
    });
    return finish(document, run, quality, []);
  }

  const buffer = await readObject(document.storageKey ?? document.filesystemPath);
  const sourceHash = sha256(buffer);

  const current = await getCurrentExtractionRun(document.id);
  if (
    !options.force &&
    current &&
    current.sourceHash === sourceHash &&
    current.pipelineVersion === PIPELINE_VERSION &&
    (current.status === 'READY' || current.status === 'READY_WITH_WARNINGS' || current.status === 'BLOCKED')
  ) {
    // The reading still stands, so the document row is made to agree with it.
    // Without this a row left saying INTERRUPTED by a crash recovery would stay
    // that way forever, because re-reading correctly declines to do the work twice.
    const reconciled =
      document.extractionStatus === current.status && document.extractionRunId === current.id
        ? document
        : (await updateDocument(document.id, {
            extractionStatus: current.status,
            extractionRunId: current.id,
            pipelineVersion: current.pipelineVersion,
          }) ?? document);
    return { run: current, quality: qualityOf(current), document: reconciled };
  }

  const detection = detectFormat(document.filename ?? document.canonicalName, buffer);
  const run = await createExtractionRun({
    documentId: document.id,
    projectId: document.projectId,
    pipelineVersion: PIPELINE_VERSION,
    detectedFormat: detection.format,
    sourceHash,
    status: 'EXTRACTING',
  });
  await updateDocument(document.id, {
    extractionStatus: 'EXTRACTING',
    extractionRunId: run.id,
    mimeType: detection.mimeType,
    detectedFormat: detection.format,
    pipelineVersion: PIPELINE_VERSION,
  });

  try {
    const { pages, warnings, blockedReason } = await readPages(detection.format, buffer);
    if (detection.extensionMismatch) {
      warnings.push(
        `The file extension does not match its contents: it is actually ${detection.format}.`,
      );
    }

    let ocrPages: number[] = [];
    let ocrRecords: OcrPageRecord[] = [];
    if (!blockedReason && pages.length > 0) {
      const needsOcr = pagesNeedingOcr(pages);
      if (needsOcr.length > 0) {
        await updateExtractionRun(run.id, { status: 'OCR' });
        await updateDocument(document.id, { extractionStatus: 'OCR' });
      }
      const ocr = await applyOcr(detection.format, buffer, pages);
      ocrPages = ocr.ocrPages;
      ocrRecords = ocr.records;
      warnings.push(...ocr.warnings);
      if (ocr.records.length > 0) {
        // Written before the verdict: which engine read which rendered image is
        // part of the evidence, not a footnote to a successful outcome.
        await updateExtractionRun(run.id, {
          ocrEngine: ocr.engine,
          ocrEngineVersion: ocr.engineVersion,
          ocrRendererVersion: ocr.rendererVersion,
          ocrPages: ocr.records,
        });
      }
    }

    await updateExtractionRun(run.id, { status: 'INDEXING' });
    await updateDocument(document.id, { extractionStatus: 'INDEXING' });

    const blocks = await persistBlocks(run.id, document.id, pages, methodFor(detection.format), ocrPages);
    const quality = assessExtraction({ pages, ocrPages, ocrRecords, warnings, blockedReason });

    if (blocks.length > 0) {
      const planned = planChunks(await listBlocks(run.id));
      await insertChunks(
        planned.map((chunk) => ({
          extractionRunId: run.id,
          documentId: document.id,
          chunkIndex: chunk.chunkIndex,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          blockStart: chunk.blockStart,
          blockEnd: chunk.blockEnd,
          headingPath: chunk.headingPath,
          text: chunk.text,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          overlapPrev: chunk.overlapPrev,
          hasOcr: chunk.hasOcr,
          contentHash: chunk.contentHash,
        })),
      );
    }

    return finish(document, run, quality, pages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateExtractionRun(run.id, {
      status: 'FAILED',
      error: message,
      completedAt: new Date().toISOString(),
    });
    await updateDocument(document.id, { extractionStatus: 'FAILED' });
    await recordEvent({
      projectId: document.projectId,
      layerId: document.layerId,
      entityType: 'DOCUMENT',
      entityId: document.id,
      eventType: 'DOCUMENT_EXTRACTION_FAILED',
      payload: { runId: run.id, error: message },
    });
    throw error;
  }
}

/** Persist blocks with raw text, normalized text and running character offsets. */
async function persistBlocks(
  runId: string,
  documentId: string,
  pages: ExtractedPage[],
  defaultMethod: ExtractionMethod,
  ocrPages: number[],
): Promise<InsertBlockInput[]> {
  const ocr = new Set(ocrPages);
  const rows: InsertBlockInput[] = [];
  let offset = 0;
  let blockIndex = 0;

  for (const page of pages) {
    for (const block of page.blocks) {
      const normalized = normalizeBlockText(block.text);
      const warnings = [...block.warnings];
      if (normalized.notes.length > 0) warnings.push(`normalized: ${normalized.notes.join(', ')}`);
      const charStart = offset;
      const charEnd = offset + normalized.text.length;
      offset = charEnd + 2; // the "\n\n" a chunk uses to join blocks

      rows.push({
        extractionRunId: runId,
        documentId,
        pageNumber: page.pageNumber,
        blockIndex: blockIndex++,
        blockType: block.blockType,
        // Raw text is kept beside the normalized text: normalization can never
        // be the only copy of the evidence.
        rawText: block.text,
        normalizedText: normalized.text,
        charStart,
        charEnd,
        extractionMethod: ocr.has(page.pageNumber) ? 'OCR' : defaultMethod,
        confidence: block.confidence ?? null,
        warnings,
        contentHash: createHash('sha256').update(block.text).digest('hex').slice(0, 32),
        bbox: block.bbox,
      });
    }
  }
  await insertBlocks(rows);
  return rows;
}

function qualityOf(run: ExtractionRun): ExtractionQuality {
  return {
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
  };
}

async function finish(
  document: Document,
  run: ExtractionRun,
  quality: ExtractionQuality,
  pages: ExtractedPage[],
): Promise<ExtractionResult> {
  const completedAt = new Date().toISOString();
  const updated = (await updateExtractionRun(run.id, {
    status: quality.status,
    pagesExpected: quality.pagesExpected,
    pagesReadable: quality.pagesReadable,
    pagesOcr: quality.pagesOcr,
    pagesFailed: quality.pagesFailed,
    characterCount: quality.characterCount,
    coverageRatio: quality.coverageRatio,
    warnings: quality.warnings,
    blockedReason: quality.blockedReason,
    completedAt,
  }))!;

  // Supersede the previous run only now that this one has a verdict, so a failed
  // reprocess never leaves the document with no current evidence.
  await supersedePreviousRuns(document.id, run.id);

  const documentAfter =
    await updateDocument(document.id, {
      extractionStatus: quality.status,
      extractionRunId: run.id,
      pageCount: pages.length > 0 ? pages.length : (document.pageCount ?? null),
      pipelineVersion: quality.pipelineVersion,
    }) ?? document;

  await recordEvent({
    projectId: document.projectId,
    layerId: document.layerId,
    entityType: 'DOCUMENT',
    entityId: document.id,
    eventType: 'DOCUMENT_EXTRACTED',
    payload: {
      runId: run.id,
      status: quality.status,
      pagesExpected: quality.pagesExpected,
      pagesReadable: quality.pagesReadable,
      pagesOcr: quality.pagesOcr,
      coverageRatio: quality.coverageRatio,
      blockedReason: quality.blockedReason,
    },
  });

  return { run: updated, quality, document: documentAfter };
}

/**
 * Boot recovery: a run still marked in-flight was interrupted by a crash or a
 * restart. Mark it INTERRUPTED so nothing mistakes it for a readable document,
 * and leave it available to reprocess.
 */
export async function recoverInterruptedExtractions(): Promise<number> {
  const unfinished = await listUnfinishedExtractionRuns();
  for (const run of unfinished) {
    await updateExtractionRun(run.id, {
      status: 'INTERRUPTED',
      error: 'The extraction was interrupted before it finished.',
      completedAt: new Date().toISOString(),
    });
    const document = await getDocument(run.documentId);
    if (document && document.extractionRunId === run.id) {
      await updateDocument(document.id, { extractionStatus: 'INTERRUPTED' });
    }
  }
  return unfinished.length;
}
