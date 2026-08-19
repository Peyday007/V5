/**
 * Evidence retrieval (section 13).
 *
 * The auditor must be able to ask for the strongest passage bearing on a
 * question and get back real text with a page anchor. Just as important, it must
 * be able to tell "the document does not say this" from "I never read that part"
 * — a distinction a model cannot make for itself, so Brain makes it here.
 *
 * The index is deliberately the simplest thing that works for Deal Dispatch:
 * scoring over the chunks already stored in SQLite. No vector database.
 */
import type { Document, DocumentChunk, ExtractionRun } from '../../domain/types.ts';
import { getDocument } from '../../repos/documents.ts';
import { getChunk, getCurrentExtractionRun, listBlocks, listChunks } from '../../repos/extraction.ts';
import { isAuditable } from './quality.ts';

export interface EvidencePassage {
  documentId: string;
  documentLabel: string;
  extractionRunId: string;
  chunkId: string;
  pageStart: number;
  pageEnd: number;
  headingPath: string[];
  /** The passage itself, trimmed to a quotable length. */
  quote: string;
  score: number;
  fromOcr: boolean;
}

export interface RetrievalResult {
  passages: EvidencePassage[];
  /**
   * Documents that were searched, and documents that could not be. An empty
   * result over an unread document means "not read", not "not present".
   */
  searched: { documentId: string; documentLabel: string; chunkCount: number }[];
  unreadable: { documentId: string; documentLabel: string; reason: string }[];
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'be', 'been',
  'for', 'on', 'with', 'as', 'by', 'that', 'this', 'it', 'at', 'from', 'but', 'not', 'have',
  'has', 'had', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'what', 'which', 'how',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/**
 * Score a chunk against a query.
 *
 * Term coverage dominates: a passage mentioning four of the five query terms
 * beats one repeating a single term twenty times, which is what you want when
 * the question is "does this document address custody and claim priority?".
 */
function scoreChunk(chunk: DocumentChunk, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = chunk.text.toLowerCase();
  let matched = 0;
  let occurrences = 0;
  for (const term of terms) {
    const count = haystack.split(term).length - 1;
    if (count > 0) {
      matched += 1;
      occurrences += Math.min(count, 5);
    }
  }
  if (matched === 0) return 0;
  const coverage = matched / terms.length;
  const density = occurrences / Math.max(1, terms.length * 5);
  // Heading matches are a strong signal that the passage is about the question.
  const headingText = chunk.headingPath.join(' ').toLowerCase();
  const headingBonus = terms.some((term) => headingText.includes(term)) ? 0.15 : 0;
  return Number((coverage * 0.7 + density * 0.3 + headingBonus).toFixed(4));
}

function labelOf(document: Document): string {
  return document.canonicalName;
}

function quoteFrom(chunk: DocumentChunk, terms: string[], maxChars: number): string {
  const text = chunk.text;
  if (text.length <= maxChars) return text;

  // Centre the excerpt on the first matching term so the quote actually shows
  // the evidence rather than the top of the chunk.
  const lower = text.toLowerCase();
  let anchor = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (anchor === -1 || index < anchor)) anchor = index;
  }
  if (anchor === -1) return `${text.slice(0, maxChars)}…`;

  const start = Math.max(0, anchor - Math.floor(maxChars / 3));
  const end = Math.min(text.length, start + maxChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export interface RetrieveInput {
  documentIds: string[];
  query: string;
  limit?: number;
  maxQuoteChars?: number;
}

/** Find the strongest passages for a question across a set of documents. */
export function retrieveEvidence(input: RetrieveInput): RetrievalResult {
  const terms = [...new Set(tokenize(input.query))];
  const limit = input.limit ?? 5;
  const maxQuoteChars = input.maxQuoteChars ?? 700;

  const searched: RetrievalResult['searched'] = [];
  const unreadable: RetrievalResult['unreadable'] = [];
  const scored: EvidencePassage[] = [];

  for (const documentId of input.documentIds) {
    const document = getDocument(documentId);
    if (!document) continue;
    const run = getCurrentExtractionRun(documentId);

    if (!run || !isAuditable(run.status)) {
      unreadable.push({
        documentId,
        documentLabel: labelOf(document),
        reason: run
          ? (run.blockedReason ?? `Extraction status is ${run.status}.`)
          : 'The document has never been extracted.',
      });
      continue;
    }

    const chunks = listChunks(run.id);
    searched.push({ documentId, documentLabel: labelOf(document), chunkCount: chunks.length });

    for (const chunk of chunks) {
      const score = scoreChunk(chunk, terms);
      if (score <= 0) continue;
      scored.push({
        documentId,
        documentLabel: labelOf(document),
        extractionRunId: run.id,
        chunkId: chunk.id,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        headingPath: chunk.headingPath,
        quote: quoteFrom(chunk, terms, maxQuoteChars),
        score,
        fromOcr: chunk.hasOcr,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.pageStart - b.pageStart);
  return { passages: scored.slice(0, limit), searched, unreadable };
}

/**
 * Resolve a citation back to its source passage.
 *
 * This is what makes a verdict checkable: the UI and the user follow the same
 * path from a conclusion to the exact text it rests on.
 */
export function resolveCitation(chunkId: string): {
  chunk: DocumentChunk;
  document: Document;
  run: ExtractionRun | null;
  blocks: { pageNumber: number; blockType: string; text: string }[];
} | null {
  const chunk = getChunk(chunkId);
  if (!chunk) return null;
  const document = getDocument(chunk.documentId);
  if (!document) return null;
  const run = getCurrentExtractionRun(chunk.documentId);

  // The blocks the chunk was built from, so the citation shows real source text
  // rather than the chunk's concatenation.
  const blocks = listBlocks(chunk.extractionRunId)
    .filter((block) => block.blockIndex >= chunk.blockStart && block.blockIndex <= chunk.blockEnd)
    .map((block) => ({
      pageNumber: block.pageNumber,
      blockType: block.blockType,
      text: block.rawText,
    }));

  return { chunk, document, run, blocks };
}

/** Full readable text of a document's current extraction, for VIEW EXTRACTED TEXT. */
export function readableText(documentId: string): {
  run: ExtractionRun | null;
  pages: { pageNumber: number; blocks: { blockType: string; text: string; method: string }[] }[];
} {
  const run = getCurrentExtractionRun(documentId);
  if (!run) return { run: null, pages: [] };

  const byPage = new Map<number, { blockType: string; text: string; method: string }[]>();
  for (const block of listBlocks(run.id)) {
    const list = byPage.get(block.pageNumber) ?? [];
    list.push({
      blockType: block.blockType,
      text: block.normalizedText,
      method: block.extractionMethod,
    });
    byPage.set(block.pageNumber, list);
  }

  return {
    run,
    pages: [...byPage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([pageNumber, blocks]) => ({ pageNumber, blocks })),
  };
}
