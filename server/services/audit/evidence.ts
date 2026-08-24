/**
 * The citation trail from a verdict back to the passage it rests on
 * (sections 13 and 14).
 *
 * A verdict nobody can check is an assertion. After an audit records its gaps,
 * this attaches to each one the strongest passage in the evidence that bears on
 * it, with the document, the extraction run, the chunk and the page — so the UI
 * and the user can follow a conclusion down to raw text.
 *
 * Retrieved, not asserted. The passages come from the extracted text by search,
 * never from the model's own claim about what the document says, so a citation
 * cannot be hallucinated. What the model contributes is the question; what Brain
 * contributes is the answer to "where does this actually appear?".
 */
import type { Audit, AuditGap } from '../../domain/types.ts';
import { insertAuditEvidence } from '../../repos/extraction.ts';
import { retrieveEvidence, type EvidencePassage } from '../documents/retrieval.ts';

/** Passages per gap. More than a couple is a reading list, not a citation. */
const PER_GAP = 2;
/** Passages backing the verdict itself, when there are no gaps to attach to. */
const PER_VERDICT = 3;

function queryForGap(gap: AuditGap): string {
  return [gap.title, gap.researchQuestion ?? '', gap.detail].join(' ').trim();
}

function rows(
  auditId: string,
  gapId: string | null,
  passages: EvidencePassage[],
): Parameters<typeof insertAuditEvidence>[0] {
  return passages.map((passage) => ({
    auditId,
    gapId,
    documentId: passage.documentId,
    extractionRunId: passage.extractionRunId,
    chunkId: passage.chunkId,
    documentLabel: passage.documentLabel,
    pageNumber: passage.pageStart,
    quote: passage.quote,
  }));
}

/**
 * Record the passages behind an audit. Returns how many citations were written.
 *
 * Deliberately best-effort about coverage and strict about honesty: a gap with
 * no matching passage simply gets no citation, because inventing one would
 * defeat the purpose. It never throws — a verdict that is already recorded must
 * not be undone by a failure to annotate it.
 */
export async function recordAuditEvidence(input: {
  audit: Audit;
  documentIds: string[];
  verdictQuery: string;
}): Promise<number> {
  const documentIds = [...new Set(input.documentIds)].filter((id) => id.length > 0);
  if (documentIds.length === 0) return 0;

  const entries: Parameters<typeof insertAuditEvidence>[0] = [];
  const seen = new Set<string>();

  for (const gap of input.audit.gaps) {
    const query = queryForGap(gap);
    if (query.length === 0) continue;
    const found = await retrieveEvidence({ documentIds, query, limit: PER_GAP });
    for (const passage of found.passages) {
      const key = `${gap.id}:${passage.chunkId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(...rows(input.audit.id, gap.id, [passage]));
    }
  }

  // With no gaps there is still a verdict, and it should be checkable too.
  if (input.audit.gaps.length === 0 && input.verdictQuery.trim().length > 0) {
    const found = await retrieveEvidence({
      documentIds,
      query: input.verdictQuery,
      limit: PER_VERDICT,
    });
    entries.push(...rows(input.audit.id, null, found.passages));
  }

  if (entries.length === 0) return 0;
  await insertAuditEvidence(entries);
  return entries.length;
}
