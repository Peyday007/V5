/**
 * The extraction quality gate (section 10).
 *
 * A non-empty extraction is not proof of success, so this is where "we read
 * something" becomes "we can be trusted to have read it". The thresholds are
 * named constants rather than scattered magic numbers, because they are the
 * difference between an audit and a guess, and they have to be testable.
 *
 * A BLOCKED document cannot be audited, synthesised or frozen.
 */
import type { ExtractionQuality, ExtractionStatus } from '../../domain/types.ts';
import type { ExtractedPage } from './pdf.ts';

export const PIPELINE_VERSION = 'doc-understanding-1';

export const THRESHOLDS = {
  /** Below this share of readable pages the document cannot be trusted. */
  minCoverageRatio: 0.8,
  /** A page with fewer characters than this is treated as not read. */
  minPageCharacters: 40,
  /** Below this, a whole document is effectively empty however many pages it has. */
  minDocumentCharacters: 200,
  /** Characters per thousand square points below which a PDF page looks scanned. */
  scannedPageDensity: 0.35,
  /** A low-density page above this length is sparse prose, not a scan. */
  sparseTextLayerCharacters: 300,
  /** Share of pages carrying replacement glyphs that makes the text untrustworthy. */
  maxReplacementGlyphPageRatio: 0.2,
} as const;

export interface PageOutcome {
  pageNumber: number;
  readable: boolean;
  usedOcr: boolean;
  characterCount: number;
  warnings: string[];
}

/**
 * Pages with no usable text layer — the ones OCR exists for.
 *
 * Deliberately narrow. A page carrying real text is not a scan, however short it
 * is: the last page of a report is sparse, not unreadable, and demanding OCR for
 * it would send the user chasing an install they do not need. Thin-but-present
 * text is reported separately as a warning instead (see `lowDensityPages`).
 */
export function pagesNeedingOcr(pages: ExtractedPage[]): number[] {
  return pages
    .filter((page) => page.characterCount < THRESHOLDS.minPageCharacters)
    .map((page) => page.pageNumber);
}

/**
 * Pages whose text layer is present but unusually thin for their size. Not a
 * failure and not an OCR case — a prompt to check that nothing was clipped.
 */
export function lowDensityPages(pages: ExtractedPage[]): number[] {
  return pages
    .filter(
      (page) =>
        page.width > 0 &&
        page.characterCount >= THRESHOLDS.minPageCharacters &&
        page.characterCount < THRESHOLDS.sparseTextLayerCharacters &&
        page.signals.characterDensity < THRESHOLDS.scannedPageDensity,
    )
    .map((page) => page.pageNumber);
}

export interface AssessInput {
  pages: ExtractedPage[];
  /** Pages OCR actually produced text for. */
  ocrPages: number[];
  /** Warnings gathered during extraction (format-level, OCR-level). */
  warnings: string[];
  /** Set when the format itself could not be read at all. */
  blockedReason?: string | null;
}

/**
 * Turn per-page outcomes into the machine-readable verdict the rest of the
 * platform acts on. Deliberately conservative: when in doubt, warn or block.
 */
export function assessExtraction(input: AssessInput): ExtractionQuality {
  const warnings = [...input.warnings];
  const pages = input.pages;
  const ocrSet = new Set(input.ocrPages);

  if (input.blockedReason) {
    return {
      status: 'BLOCKED',
      pagesExpected: pages.length,
      pagesReadable: 0,
      pagesOcr: 0,
      pagesFailed: pages.map((page) => page.pageNumber),
      characterCount: 0,
      warnings,
      coverageRatio: 0,
      pipelineVersion: PIPELINE_VERSION,
      blockedReason: input.blockedReason,
    };
  }

  const readable: number[] = [];
  const failed: number[] = [];
  let characterCount = 0;

  for (const page of pages) {
    characterCount += page.characterCount;
    if (page.characterCount >= THRESHOLDS.minPageCharacters) readable.push(page.pageNumber);
    else failed.push(page.pageNumber);
  }

  const pagesExpected = pages.length;
  const coverageRatio = pagesExpected === 0 ? 0 : readable.length / pagesExpected;

  const glyphPages = pages.filter((page) => page.signals.hasReplacementGlyphs).length;
  if (glyphPages > 0) {
    warnings.push(
      `${glyphPages} page(s) contain replacement or private-use glyphs; the font mapping may be broken.`,
    );
  }
  const sparse = lowDensityPages(pages);
  if (sparse.length > 0) {
    warnings.push(
      `Page(s) ${sparse.join(', ')} carry noticeably less text than the rest of the document; ` +
        'check that nothing was clipped.',
    );
  }
  const multiColumn = pages.filter((page) => page.signals.columnCount > 1).length;
  if (multiColumn > 0) {
    warnings.push(`${multiColumn} page(s) were read as multi-column; verify the reading order.`);
  }
  if (failed.length > 0) {
    warnings.push(`Pages with no usable text: ${failed.join(', ')}.`);
  }
  if (ocrSet.size > 0) {
    warnings.push(`${ocrSet.size} page(s) were read by OCR and may contain recognition errors.`);
  }

  let status: ExtractionStatus;
  let blockedReason: string | null = null;

  if (pagesExpected === 0) {
    status = 'BLOCKED';
    blockedReason = 'The document contains no pages.';
  } else if (characterCount < THRESHOLDS.minDocumentCharacters) {
    status = 'BLOCKED';
    blockedReason =
      `Only ${characterCount} characters could be extracted from ${pagesExpected} page(s), ` +
      'which is not enough to audit. The file may be a scan with no OCR available, or empty.';
  } else if (coverageRatio < THRESHOLDS.minCoverageRatio) {
    status = 'BLOCKED';
    blockedReason =
      `Only ${readable.length} of ${pagesExpected} pages could be read ` +
      `(${Math.round(coverageRatio * 100)}% coverage, ${Math.round(THRESHOLDS.minCoverageRatio * 100)}% required). ` +
      `Unreadable pages: ${failed.join(', ')}.`;
  } else if (glyphPages / pagesExpected > THRESHOLDS.maxReplacementGlyphPageRatio) {
    status = 'BLOCKED';
    blockedReason =
      `${glyphPages} of ${pagesExpected} pages contain replacement glyphs, so the extracted text ` +
      'does not reliably represent the document.';
  } else if (warnings.length > 0) {
    status = 'READY_WITH_WARNINGS';
  } else {
    status = 'READY';
  }

  return {
    status,
    pagesExpected,
    pagesReadable: readable.length,
    pagesOcr: ocrSet.size,
    pagesFailed: failed,
    characterCount,
    warnings,
    coverageRatio: Number(coverageRatio.toFixed(4)),
    pipelineVersion: PIPELINE_VERSION,
    blockedReason,
  };
}

/** Whether a document in this state may be used as audit evidence. */
export function isAuditable(status: ExtractionStatus): boolean {
  return status === 'READY' || status === 'READY_WITH_WARNINGS';
}
