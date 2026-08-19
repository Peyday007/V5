/**
 * Structured findings (section 12).
 *
 * An index over a document, never a replacement for it. Each finding names one
 * thing the document establishes — a claim, a definition, a component, an actor,
 * a relationship, an assumption, an exclusion, a question it answers, a question
 * it leaves open, a contradiction — and carries the exact passage it rests on.
 *
 * Two rules make the index trustworthy rather than decorative:
 *
 *   - A finding whose quote cannot be located in the extracted source is
 *     discarded. The spec is explicit: if a finding cannot point back to
 *     evidence, it is not trusted. The page number comes from the block the
 *     quote was found in, never from the model's own claim about the page.
 *   - Nothing is written until every chunk has been read successfully. A
 *     provider failure, a timeout or an invalid response leaves the document
 *     exactly as it was — no partial index, no state moved.
 *
 * Findings are also never derived from the mock provider (section 19): the mock
 * exists so the platform works without credentials, and inventing an index from
 * it would be pretending to have understood the document.
 */
import type { DocumentBlock, DocumentChunk, DocumentFinding, DocumentFindingType } from '../../domain/types.ts';
import { DOCUMENT_FINDING_TYPES } from '../../domain/types.ts';
import type { AIProvider } from '../../providers/types.ts';
import { getProvider, MOCK_PROVIDER_NAME } from '../../providers/index.ts';
import { getDocument } from '../../repos/documents.ts';
import {
  getCurrentExtractionRun,
  listBlocks,
  listChunks,
  listDocumentFindings,
  replaceFindings,
} from '../../repos/extraction.ts';
import { recordEvent } from '../../repos/events.ts';
import { extractJsonObject, strictEnum } from '../audit/schema.ts';
import { isAuditable } from './quality.ts';

/** A shorter quote than this cannot identify a passage; it identifies a word. */
const MIN_QUOTE_CHARS = 12;
/** Default ceiling for one provider call. A hung call is a failed extraction. */
export const DEFAULT_FINDINGS_TIMEOUT_MS = 120_000;

/**
 * Findings could not be derived. Nothing was recorded and no state moved; the
 * document's previous index, if it had one, is still intact.
 */
export class FindingsExtractionError extends Error {
  readonly documentId: string;
  readonly chunkId: string | null;
  readonly rawResponse: string | null;

  constructor(documentId: string, chunkId: string | null, message: string, rawResponse: string | null = null) {
    super(message);
    this.name = 'FindingsExtractionError';
    this.documentId = documentId;
    this.chunkId = chunkId;
    this.rawResponse = rawResponse;
  }
}

export interface ExtractFindingsInput {
  documentId: string;
  /** Injectable so tests can drive exact scenarios; defaults to the configured provider. */
  provider?: AIProvider;
  providerName?: string | null;
  model?: string | null;
  timeoutMs?: number;
  /** Bound the work on a very large document; the cap is reported, never silent. */
  maxChunks?: number;
}

export interface FindingsResult {
  documentId: string;
  extractionRunId: string;
  provider: string;
  chunksRead: number;
  chunksSkipped: number;
  findings: DocumentFinding[];
  /** Findings the model proposed that could not be anchored to the source. */
  rejected: { chunkIndex: number; content: string; reason: string }[];
}

function buildPrompt(canonicalName: string, chunk: DocumentChunk, pageLabel: string): string {
  return [
    'You are indexing one passage of a research document so that a later audit can',
    'find what it needs. You are not judging the document and not summarising it.',
    '',
    `Document: ${canonicalName}`,
    `Passage: ${pageLabel}${chunk.headingPath.length > 0 ? ` — under "${chunk.headingPath.join(' / ')}"` : ''}`,
    '',
    '--- PASSAGE BEGINS ---',
    chunk.text,
    '--- PASSAGE ENDS ---',
    '',
    'List what this passage establishes. Every entry must quote the passage verbatim;',
    'a quote you cannot copy exactly from the text above will be discarded, and an',
    'entry without one is worthless. Do not infer, do not generalise, do not add',
    'anything the passage does not say.',
    '',
    `"type" must be exactly one of: ${DOCUMENT_FINDING_TYPES.join(', ')}.`,
    '',
    'Return ONE JSON object and nothing after it:',
    '{',
    '  "findings": [',
    '    {"type": "CLAIM", "content": "what the passage establishes, in one sentence",',
    '     "quote": "the exact wording from the passage that establishes it"}',
    '  ]',
    '}',
    '',
    'Return an empty findings array if the passage establishes nothing (a table of',
    'contents, a page of references). An empty answer is better than an invented one.',
  ].join('\n');
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whitespace and case are extraction artifacts; wording is the evidence. */
function comparable(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Find the block a quote actually came from.
 *
 * The page number is read off that block, so a finding's anchor is a fact about
 * the extraction rather than a claim by the model.
 */
function anchorFor(quote: string, blocks: DocumentBlock[]): DocumentBlock | null {
  const needle = comparable(quote);
  if (needle.length < MIN_QUOTE_CHARS) return null;
  return (
    blocks.find((block) => comparable(block.normalizedText).includes(needle)) ??
    blocks.find((block) => comparable(block.rawText).includes(needle)) ??
    null
  );
}

interface CandidateFinding {
  findingType: DocumentFindingType;
  content: string;
  quote: string;
}

/** Zero-trust parse of one chunk's response. Any structural problem fails the run. */
function parseFindings(raw: string): { ok: true; value: CandidateFinding[] } | { ok: false; error: string } {
  const parsed = extractJsonObject(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const list = parsed.value['findings'];
  if (!Array.isArray(list)) return { ok: false, error: '"findings" must be an array.' };

  const candidates: CandidateFinding[] = [];
  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `findings[${index}] must be an object.` };
    }
    const record = entry as Record<string, unknown>;
    const type = strictEnum(record['type'], DOCUMENT_FINDING_TYPES, `findings[${index}].type`);
    if (!type.ok) return { ok: false, error: type.error };

    const content = typeof record['content'] === 'string' ? record['content'].trim() : '';
    if (content.length === 0) return { ok: false, error: `findings[${index}].content is empty.` };

    const quote = typeof record['quote'] === 'string' ? record['quote'].trim() : '';
    if (quote.length === 0) return { ok: false, error: `findings[${index}].quote is empty.` };

    candidates.push({ findingType: type.value, content, quote });
  }
  return { ok: true, value: candidates };
}

/**
 * Derive the structured index for one document.
 *
 * Reads only the document's current extraction run, so the index is always about
 * text Brain has actually read, and reprocessing a document replaces its index
 * rather than leaving a stale one attached to new evidence.
 */
export async function extractDocumentFindings(input: ExtractFindingsInput): Promise<FindingsResult> {
  const document = getDocument(input.documentId);
  if (!document) throw new Error(`Cannot extract findings: unknown document ${input.documentId}`);

  const run = getCurrentExtractionRun(document.id);
  if (!run || !isAuditable(run.status)) {
    throw new FindingsExtractionError(
      document.id,
      null,
      run
        ? `${document.canonicalName} is not readable (extraction is ${run.status}), so there is ` +
          'nothing to index. Reprocess or replace the file first.'
        : `${document.canonicalName} has not been read yet, so there is nothing to index.`,
    );
  }

  const provider = input.provider ?? getProvider(input.providerName);
  if (provider.name === MOCK_PROVIDER_NAME) {
    throw new FindingsExtractionError(
      document.id,
      null,
      'The mock provider cannot index a document: its findings would be invented rather than ' +
        'read. Configure a real provider, or leave the document indexed by retrieval alone — ' +
        'audits still read the extracted text either way.',
    );
  }
  const status = provider.getStatus();
  if (!status.available) {
    throw new FindingsExtractionError(document.id, null, status.reason);
  }

  const chunks = listChunks(run.id);
  if (chunks.length === 0) {
    throw new FindingsExtractionError(
      document.id,
      null,
      `${document.canonicalName} produced no indexable passages, so there is nothing to read.`,
    );
  }

  const blocks = listBlocks(run.id);
  const timeoutMs = input.timeoutMs ?? DEFAULT_FINDINGS_TIMEOUT_MS;
  const maxChunks = input.maxChunks ?? chunks.length;
  const selected = chunks.slice(0, maxChunks);

  const accepted: Parameters<typeof replaceFindings>[1] = [];
  const rejected: FindingsResult['rejected'] = [];
  let ordinal = 0;

  // Everything is gathered before anything is written: a failure halfway through
  // a fifty-page document must not leave half an index behind.
  for (const chunk of selected) {
    const pageLabel =
      chunk.pageStart === chunk.pageEnd ? `page ${chunk.pageStart}` : `pages ${chunk.pageStart}-${chunk.pageEnd}`;
    let raw: string;
    try {
      const response = await withTimeout(
        provider.audit({ prompt: buildPrompt(document.canonicalName, chunk, pageLabel), model: input.model ?? null }),
        timeoutMs,
        `Indexing ${pageLabel} of ${document.canonicalName}`,
      );
      raw = response.text;
    } catch (error) {
      throw new FindingsExtractionError(
        document.id,
        chunk.id,
        `Indexing ${pageLabel} of ${document.canonicalName} failed: ` +
          `${error instanceof Error ? error.message : String(error)}. Nothing was recorded.`,
      );
    }

    const parsedFindings = parseFindings(raw);
    if (!parsedFindings.ok) {
      throw new FindingsExtractionError(
        document.id,
        chunk.id,
        `The index returned for ${pageLabel} of ${document.canonicalName} was not usable: ` +
          `${parsedFindings.error} Nothing was recorded.`,
        raw,
      );
    }

    const chunkBlocks = blocks.filter(
      (block) => block.blockIndex >= chunk.blockStart && block.blockIndex <= chunk.blockEnd,
    );
    for (const candidate of parsedFindings.value) {
      const anchor = anchorFor(candidate.quote, chunkBlocks) ?? anchorFor(candidate.quote, blocks);
      if (!anchor) {
        // Not an error: one unanchored entry is the model over-reaching, not a
        // broken response. It is dropped and reported, never stored.
        rejected.push({
          chunkIndex: chunk.chunkIndex,
          content: candidate.content,
          reason: 'The quote does not appear in the extracted text, so the finding has no evidence.',
        });
        continue;
      }
      accepted.push({
        extractionRunId: run.id,
        documentId: document.id,
        chunkId: chunk.id,
        findingType: candidate.findingType,
        ordinal: ordinal++,
        content: candidate.content,
        evidencePage: anchor.pageNumber,
        evidenceQuote: candidate.quote,
        confidence: null,
        source: provider.name,
      });
    }
  }

  replaceFindings(run.id, accepted);
  recordEvent({
    projectId: document.projectId,
    layerId: document.layerId,
    entityType: 'DOCUMENT',
    entityId: document.id,
    eventType: 'DOCUMENT_INDEXED',
    payload: {
      runId: run.id,
      provider: provider.name,
      chunksRead: selected.length,
      chunksSkipped: chunks.length - selected.length,
      findings: accepted.length,
      rejected: rejected.length,
    },
  });

  return {
    documentId: document.id,
    extractionRunId: run.id,
    provider: provider.name,
    chunksRead: selected.length,
    chunksSkipped: chunks.length - selected.length,
    findings: listDocumentFindings(run.id),
    rejected,
  };
}

/** The stored index for a document's current extraction run. */
export function documentFindings(documentId: string): DocumentFinding[] {
  const run = getCurrentExtractionRun(documentId);
  return run ? listDocumentFindings(run.id) : [];
}
