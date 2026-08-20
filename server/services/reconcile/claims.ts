/**
 * Recovering the claims already sitting in the project's own documents.
 *
 * A previous research packet is not a source. It is a document containing
 * claims, each of which either has a citation underneath it or does not — and
 * the difference is the whole point. This module reads extracted text and pulls
 * out the sentences that assert something, with the page and character offsets
 * that let a reader find them again, the citation the document itself gave, and
 * an honest label for what kind of claim it is.
 *
 * Nothing here is a model call. It is deliberately mechanical: sentence
 * boundaries, cited-URL proximity, and a vocabulary of hedges, forecasts,
 * calculations and self-descriptions. A mechanical reading that is right about
 * where a sentence came from is worth more than a clever reading that cannot be
 * checked — and everything it produces is marked UNVERIFIED until something
 * verifies it.
 */
import crypto from 'node:crypto';
import type { ClaimType, Document, ExistingClaim } from '../../domain/types.ts';
import { getDocument } from '../../repos/documents.ts';
import { getCurrentExtractionRun, listBlocks } from '../../repos/extraction.ts';
import { listAuditsByLayer } from '../../repos/audits.ts';
import {
  clearExistingClaims,
  insertExistingClaims,
  listExistingClaimsForDocument,
  type InsertExistingClaimInput,
} from '../../repos/reconciliation.ts';

/** A sentence shorter than this asserts nothing worth tracking. */
const MIN_CLAIM_CHARS = 40;
/** Longer than this is a paragraph that happens to lack full stops. */
const MAX_CLAIM_CHARS = 600;

/** How far past a sentence a citation may sit and still be its citation. */
const NEAR_SOURCE_CHARS = 160;

const URL_RE = /https?:\/\/[^\s<>()\[\]"']+/gi;

/** Wording that marks what kind of claim a sentence is making. */
const MARKERS: { type: ClaimType; patterns: RegExp[] }[] = [
  {
    type: 'NEGATIVE_EXISTENCE',
    patterns: [
      /\b(no|not any|none of the)\b[^.]*\b(datasets?|data|figures?|statistics?|sources?|studies|evidence|disclosures?|records?)\b/i,
      /\bdo(?:es)? not (?:publish|disclose|report|exist)\b/i,
      /\bis not (?:published|available|disclosed|reported)\b/i,
    ],
  },
  {
    type: 'FORECAST',
    patterns: [
      /\b(?:will|expected to|projected to|forecast(?:ed)? to|anticipated to)\b[^.]*\b(?:reach|grow|decline|rise|fall|exceed)\b/i,
      /\bby 20[3-9]\d\b/,
      /\b(?:CAGR|compound annual growth)\b/i,
    ],
  },
  {
    type: 'CALCULATION',
    patterns: [
      /\b(?:multiplied by|divided by|calculated as|derived from|implies?|therefore approximately)\b/i,
      /\b\d[\d,.]*\s*(?:×|x|\*)\s*\d/,
    ],
  },
  {
    type: 'INFERENCE',
    patterns: [
      /\b(?:suggests?|implies|indicates?|appears? to|likely|probably|we (?:can )?infer)\b/i,
      /\b(?:this means|it follows that|reasonably)\b/i,
    ],
  },
  {
    type: 'SELF_REPORT',
    patterns: [
      /\b(?:according to (?:its|their) (?:own|website|marketing)|the company (?:says|states|claims)|on its website)\b/i,
      /\b(?:self-reported|as advertised)\b/i,
    ],
  },
  {
    type: 'RECOMMENDATION',
    patterns: [/\b(?:we recommend|should (?:be|adopt|use|prioritise|prioritize)|the recommendation is)\b/i],
  },
  {
    type: 'DECISION',
    patterns: [/\b(?:we decided|the decision (?:is|was)|agreed that|it was agreed)\b/i],
  },
  {
    type: 'INSTRUCTION',
    patterns: [/^\s*(?:please|do not|ignore|you must|research)\b/i],
  },
  {
    type: 'QUOTATION',
    patterns: [/^["“][^"”]{20,}["”]/],
  },
];

/** Sentences that assert a measurable thing are worth tracking even unmarked. */
const FACTUAL_SIGNALS = [
  /\b\d[\d,.]*\s*(?:%|per cent|percent|million|billion|thousand|bn|m\b)/i,
  /\b(?:employment|revenue|wage|price|share|count|total|median|average|mean)\b/i,
  /\b(?:in|as at|as of)\s+(?:19|20)\d\d\b/i,
];

export interface ExtractedClaimCandidate {
  claim: string;
  claimType: ClaimType;
  page: number | null;
  blockIndex: number;
  charStart: number;
  charEnd: number;
  locator: string;
  sourceUrl: string | null;
  supportingPassage: string;
  extractionConfidence: number;
}

/**
 * Split a block into sentences, keeping each one's offset inside the block.
 *
 * URLs are masked before splitting and restored afterwards: `oes419041.htm`
 * contains a full stop, and a splitter that treats it as a sentence boundary
 * produces half a link and loses the citation the claim depends on.
 */
function sentences(text: string): { text: string; start: number; end: number }[] {
  const masked = text.replace(URL_RE, (url) => '\u0000'.repeat(url.length));
  URL_RE.lastIndex = 0;
  const out: { text: string; start: number; end: number }[] = [];
  const pattern = /[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g;
  let match = pattern.exec(masked);
  while (match !== null) {
    const value = match[0];
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const offset = match.index + value.indexOf(trimmed);
      // Offsets index the real text; the mask only guided the split.
      out.push({
        text: text.slice(offset, offset + trimmed.length),
        start: offset,
        end: offset + trimmed.length,
      });
    }
    match = pattern.exec(masked);
  }
  return out;
}

/** Every URL in a block, with where it starts. */
function urlsIn(text: string): { url: string; index: number }[] {
  const found: { url: string; index: number }[] = [];
  URL_RE.lastIndex = 0;
  let match = URL_RE.exec(text);
  while (match !== null) {
    found.push({ url: match[0].replace(/[.,;:)\]]+$/, ''), index: match.index });
    match = URL_RE.exec(text);
  }
  URL_RE.lastIndex = 0;
  return found;
}

function classify(sentence: string, hasSource: boolean): { type: ClaimType; confidence: number } | null {
  for (const marker of MARKERS) {
    if (marker.patterns.some((pattern) => pattern.test(sentence))) {
      return { type: marker.type, confidence: 0.7 };
    }
  }
  if (hasSource) {
    // The document itself put a citation with this sentence. Whether that source
    // supports it is a separate question, asked later.
    return { type: 'SOURCED_FACT', confidence: 0.75 };
  }
  if (FACTUAL_SIGNALS.some((pattern) => pattern.test(sentence))) {
    // A measurable assertion with no citation in sight is exactly the thing this
    // whole subsystem exists to notice.
    return { type: 'UNSUPPORTED_ASSERTION', confidence: 0.6 };
  }
  return null;
}

function firstUrl(text: string): string | null {
  URL_RE.lastIndex = 0;
  const match = URL_RE.exec(text);
  URL_RE.lastIndex = 0;
  return match ? match[0].replace(/[.,;:)\]]+$/, '') : null;
}

/**
 * Read one document's extracted text into claim candidates.
 *
 * The nearby-citation rule matters: a claim is credited with the URL in its own
 * sentence, or failing that the one in the sentence immediately after it, which
 * is how footnote-style writing actually reads. Anything further away is not
 * treated as that claim's source.
 */
export function extractClaimCandidates(documentId: string): ExtractedClaimCandidate[] {
  const run = getCurrentExtractionRun(documentId);
  if (!run) return [];

  // Flattened into one document-ordered list first, because a citation usually
  // sits on its own line — which extraction puts in its own block. Looking for
  // the source only inside the claim's own block would miss almost every
  // footnote-style reference a real report uses.
  interface Located {
    text: string;
    blockIndex: number;
    page: number | null;
    charStart: number;
    charEnd: number;
    blockText: string;
    blockStart: number;
    localStart: number;
    localEnd: number;
  }

  const located: (Located & { blockUrls: { url: string; index: number }[] })[] = [];
  for (const [index, block] of listBlocks(run.id).entries()) {
    const text = block.normalizedText || block.rawText;
    if (!text || text.trim().length === 0) continue;
    // Headings assert nothing; they title what follows.
    if (block.blockType === 'HEADING') continue;

    const blockUrls = urlsIn(text);
    for (const sentence of sentences(text)) {
      located.push({
        text: sentence.text,
        blockIndex: index,
        page: block.pageNumber,
        charStart: block.charStart + sentence.start,
        charEnd: block.charStart + sentence.end,
        blockText: text,
        blockStart: block.charStart,
        localStart: sentence.start,
        localEnd: sentence.end,
        blockUrls,
      });
    }
  }

  const candidates: ExtractedClaimCandidate[] = [];
  for (const [position, entry] of located.entries()) {
    if (entry.text.length < MIN_CLAIM_CHARS || entry.text.length > MAX_CLAIM_CHARS) continue;
    // A bare URL is a citation, not a claim.
    if (isBareUrl(entry.text)) continue;

    // The citation for a claim is the nearest URL inside it or just after it:
    // footnote-style writing puts the link at the end of the sentence or on the
    // line below, and anything further away belongs to something else.
    const inline = entry.blockUrls.find(
      (candidate) => candidate.index >= entry.localStart && candidate.index <= entry.localEnd + NEAR_SOURCE_CHARS,
    );
    const next = located[position + 1];
    const trailing =
      inline ??
      (next && next.blockIndex !== entry.blockIndex && isBareUrl(next.text)
        ? next.blockUrls.find((candidate) => candidate.index <= NEAR_SOURCE_CHARS)
        : undefined);
    const nearby = trailing?.url ?? null;

    const kind = classify(entry.text, nearby !== null);
    if (!kind) continue;

    candidates.push({
      claim: entry.text,
      claimType: kind.type,
      page: entry.page,
      blockIndex: entry.blockIndex,
      charStart: entry.charStart,
      charEnd: entry.charEnd,
      locator: entry.page !== null ? `page ${entry.page}, block ${entry.blockIndex}` : `block ${entry.blockIndex}`,
      sourceUrl: nearby,
      supportingPassage: entry.blockText.slice(
        Math.max(0, entry.localStart - 120),
        Math.min(entry.blockText.length, entry.localEnd + 120),
      ),
      extractionConfidence: kind.confidence,
    });
  }

  return candidates;
}

/** A line that is only a link. It cites something; it claims nothing. */
function isBareUrl(text: string): boolean {
  const stripped = text.replace(URL_RE, '').trim();
  URL_RE.lastIndex = 0;
  return stripped.length < 12;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex');
}

/**
 * How much a claim's own evidence is worth before anyone verifies it.
 *
 * A sourced fact with a real URL starts well ahead of an unsupported assertion,
 * and a self-report is capped low however confidently it is phrased — an
 * organisation describing itself establishes what it says, not what is true.
 */
function evidenceConfidence(candidate: ExtractedClaimCandidate): number {
  switch (candidate.claimType) {
    case 'SOURCED_FACT':
      return candidate.sourceUrl ? 0.7 : 0.35;
    case 'QUOTATION':
      return candidate.sourceUrl ? 0.6 : 0.3;
    case 'CALCULATION':
    case 'INFERENCE':
      return 0.4;
    case 'SELF_REPORT':
      return 0.3;
    case 'FORECAST':
      return 0.3;
    case 'NEGATIVE_EXISTENCE':
      return 0.2;
    case 'UNSUPPORTED_ASSERTION':
      return 0.15;
    default:
      return 0.2;
  }
}

/**
 * Read a document and record what it claims.
 *
 * Idempotent: re-reading replaces that document's claims, because the document
 * is the source of truth and a stale claim row would be a claim the document no
 * longer makes.
 */
export function inventoryDocument(documentId: string): ExistingClaim[] {
  const document = getDocument(documentId);
  if (!document) return [];

  const run = getCurrentExtractionRun(documentId);
  const candidates = extractClaimCandidates(documentId);
  clearExistingClaims(documentId);
  if (candidates.length === 0) return [];

  // A previous audit's verdict on this document travels with its claims: a
  // document that already failed an audit does not get to satisfy a requirement
  // on the strength of the same prose.
  const priorAudit = document.layerId
    ? (listAuditsByLayer(document.layerId).find(
        (audit) => audit.auditedDocumentId === documentId,
      ) ?? null)
    : null;

  const inputs: InsertExistingClaimInput[] = candidates.map((candidate) => ({
    projectId: document.projectId,
    documentId,
    extractionRunId: run?.id ?? null,
    layerId: document.layerId,
    claim: candidate.claim,
    claimType: candidate.claimType,
    page: candidate.page,
    blockIndex: candidate.blockIndex,
    charStart: candidate.charStart,
    charEnd: candidate.charEnd,
    locator: candidate.locator,
    sourceUrl: candidate.sourceUrl,
    supportingPassage: candidate.supportingPassage,
    extractionConfidence: candidate.extractionConfidence,
    evidenceConfidence: evidenceConfidence(candidate),
    verificationState: 'UNVERIFIED',
    priorAuditId: priorAudit?.id ?? null,
    documentVersion: document.version,
    superseded: document.supersededByDocumentId !== null,
    contentHash: hash(candidate.claim),
  }));

  return insertExistingClaims(inputs);
}

/** Everything one document claims, reading it first if nobody has yet. */
export function claimsForDocument(documentId: string): ExistingClaim[] {
  const existing = listExistingClaimsForDocument(documentId);
  if (existing.length > 0) return existing;
  return inventoryDocument(documentId);
}

export function documentIsSuperseded(document: Document): boolean {
  return document.supersededByDocumentId !== null;
}
