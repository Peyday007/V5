/**
 * What the Brain already knows, as one reading.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists to close
 * ---------------------------------------------------------------------------
 *
 * `russell_knowledge` holds what Russell has captured *since Step 12A*. The
 * Brain's actual research — every accepted claim from every packet Steps 9, 10
 * and 11 filed — lives in `research_claims`, and nothing read it. So a person
 * opened Knows, saw an almost empty list, and concluded the Brain knew nothing,
 * while the archive held the evidence that had already answered a question for
 * them.
 *
 * That is the failure the build contract names directly: **do not print
 * "nothing yet" when data exists but the projection is missing.**
 *
 * ---------------------------------------------------------------------------
 * Zero-copy, on purpose
 * ---------------------------------------------------------------------------
 *
 * This module contains no `INSERT`. It reads two authoritative tables and
 * returns one shape. Nothing is duplicated into `russell_knowledge`, because a
 * copy is a second place for the truth to live and the one nobody reconciles —
 * and because a claim's evidence chain is precisely what a copy loses.
 *
 * Every projected entry therefore carries the ids it came from. A reader can
 * always walk back to the orchestration, the claim, the source and the passage.
 *
 * ---------------------------------------------------------------------------
 * Epistemic status is preserved, never rounded up
 * ---------------------------------------------------------------------------
 *
 * A claim that did not clear the evidence gate is **not** accepted knowledge,
 * and showing it as though it were is worse than not showing it at all. The
 * Florida licensing material is the live example: explicitly provisional, and
 * missing two of the gate's evidence conditions. It appears in Knows — a person
 * asking about Florida should see it — labelled `PROVISIONAL`, with the
 * conditions it is missing named.
 *
 * So `accepted` decides the status, `contradiction_state` can override it, and
 * neither is inferred from how confident the sentence sounds.
 */
import { getDb } from '../../db/database.ts';
import type { KnowledgeConfidence, KnowledgeKind } from '../../domain/types.ts';

/**
 * Where an entry came from.
 *
 * Kept on the entry rather than implied by its id, so a caller filtering or
 * grouping never has to parse a string to find out what it is holding.
 */
export type KnowsOrigin = 'RUSSELL_KNOWLEDGE' | 'RESEARCH_CLAIM';

/**
 * The epistemic states the authoritative rows can actually distinguish.
 *
 * Deliberately not a superset of what is knowable. Every value here is decided
 * by a column; none is a mood. `UNDER_REVIEW` and `SUPERSEDED` exist because
 * `russell_knowledge` records them; a research claim cannot currently reach
 * either, and is never labelled with one to make the list look richer.
 */
export type KnowsStatus =
  | 'ACCEPTED'
  | 'PROVISIONAL'
  | 'UNDER_REVIEW'
  | 'CONTRADICTED'
  | 'STALE'
  | 'SUPERSEDED';

export interface KnowsProvenance {
  orchestrationId?: string;
  claimId?: string;
  fragmentId?: string;
  missionId?: string;
  conversationId?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  locator?: string;
  retrievedAt?: string;
}

export interface KnowsEntry {
  /**
   * Stable and *derived*, never allocated.
   *
   * `claim:<id>` and `knowledge:<id>` — so the same row projects to the same
   * entry on every read, and so nothing here can be mistaken for a new record
   * somebody needs to clean up.
   */
  id: string;
  origin: KnowsOrigin;
  kind: KnowledgeKind;
  statement: string;
  detail: string | null;
  confidence: KnowledgeConfidence;
  status: KnowsStatus;
  /** The gate conditions this entry does not meet. Empty when it meets them. */
  missingEvidence: string[];
  provenance: KnowsProvenance;
  /** What the entry is true *as of*, when the rows say. Never row age. */
  asOf: string | null;
}

interface ClaimRow {
  id: string;
  orchestration_id: string;
  fragment_id: string | null;
  claim: string;
  source_url: string | null;
  source_title: string | null;
  source_date: string | null;
  evidence_excerpt: string | null;
  evidence_locator: string | null;
  retrieved_at: string | null;
  confidence: number;
  contradiction_state: string;
  validation_state: string;
  accepted: number;
}

interface KnowledgeRow {
  id: string;
  kind: string;
  statement: string;
  detail: string | null;
  provenance: string;
  confidence: string;
  as_of: string | null;
  superseded_by_id: string | null;
  mission_id: string | null;
  conversation_id: string | null;
}

/**
 * A claim's numeric confidence, bucketed into the words the rest of the Brain
 * uses.
 *
 * The thresholds are the only judgement in this file and they are deliberately
 * coarse. A claim that did not clear the gate can never read `ESTABLISHED`
 * however high its number: the gate's decision outranks the score, because the
 * score is the researcher's own estimate and the gate is Brain's.
 */
function bucket(confidence: number, accepted: boolean): KnowledgeConfidence {
  if (!accepted) return confidence >= 0.5 ? 'UNCERTAIN' : 'DISPUTED';
  if (confidence >= 0.85) return 'ESTABLISHED';
  if (confidence >= 0.6) return 'SUPPORTED';
  return 'UNCERTAIN';
}

/**
 * Why a claim is not accepted knowledge, in the gate's own terms.
 *
 * Named conditions rather than a score, because "0.4" tells a reader nothing
 * they can act on and "no source URL was recorded" tells them exactly what is
 * missing.
 */
function missingFor(row: ClaimRow): string[] {
  const missing: string[] = [];
  if (!row.source_url) missing.push('no canonical source URL was recorded');
  if (row.validation_state === 'NO_URL') missing.push('the source URL was never validated');
  if (row.validation_state === 'UNREACHABLE') missing.push('the source could not be retrieved');
  if (!row.evidence_excerpt && !row.evidence_locator) {
    missing.push('no passage or locator ties the claim to its source');
  }
  if (row.contradiction_state === 'RETAINED') {
    missing.push('a contradiction was recorded and deliberately retained');
  }
  return missing;
}

function statusFor(row: ClaimRow): KnowsStatus {
  if (row.contradiction_state === 'CONTRADICTED') return 'CONTRADICTED';
  return row.accepted === 1 ? 'ACCEPTED' : 'PROVISIONAL';
}

/**
 * A claim as a knowledge kind.
 *
 * Only two are honestly derivable from a claim row: a contradicted claim is a
 * `CONTRADICTION`, everything else is a `CONCLUSION`. Guessing `ASSUMPTION` or
 * `DECISION` from the sentence would be exactly the filename-is-a-hint mistake
 * the platform refuses elsewhere.
 */
function kindFor(row: ClaimRow): KnowledgeKind {
  return row.contradiction_state === 'CONTRADICTED' ? 'CONTRADICTION' : 'CONCLUSION';
}

function parseProvenance(raw: string): KnowsProvenance {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as KnowsProvenance)
      : {};
  } catch {
    return {};
  }
}

/**
 * Everything the Brain knows about one project, from both authoritative homes.
 *
 * Russell's own captured knowledge first — it is the most recent and the most
 * deliberate — then the research archive. Neither is copied into the other.
 *
 * **Private knowledge never widens.** `includePrivate` defaults to false and is
 * the only way to see it; there is no query parameter above this that can set
 * it, because a flag a caller supplies is not a boundary.
 */
export async function knowsForProject(input: {
  projectId: string;
  includePrivate?: boolean;
  limit?: number;
}): Promise<KnowsEntry[]> {
  const limit = Math.max(1, Math.min(500, input.limit ?? 200));
  const entries: KnowsEntry[] = [];

  /* ----------------------------------------------------------------------- *
   * 1. Russell's own knowledge.
   * ----------------------------------------------------------------------- */
  const knowledge = await getDb().all<KnowledgeRow>(
    `SELECT id, kind, statement, detail, provenance, confidence, as_of,
            superseded_by_id, mission_id, conversation_id
       FROM russell_knowledge
      WHERE project_id = ?
        AND (visibility = 'SHARED' OR ? = 1)
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`,
    [input.projectId, input.includePrivate ? 1 : 0, limit] as never[],
  );
  for (const row of knowledge) {
    entries.push({
      id: `knowledge:${row.id}`,
      origin: 'RUSSELL_KNOWLEDGE',
      kind: row.kind as KnowledgeKind,
      statement: row.statement,
      detail: row.detail,
      confidence: row.confidence as KnowledgeConfidence,
      // Supersession is recorded, so it is read rather than guessed from dates.
      status: row.superseded_by_id ? 'SUPERSEDED' : 'ACCEPTED',
      missingEvidence: [],
      provenance: {
        ...parseProvenance(row.provenance),
        ...(row.mission_id ? { missionId: row.mission_id } : {}),
        ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      },
      asOf: row.as_of,
    });
  }

  /* ----------------------------------------------------------------------- *
   * 2. The research archive, projected — not copied.
   *
   * Joined through the orchestration so the project boundary is the same one
   * every other read uses. A claim belonging to another project cannot appear
   * here however it is worded.
   * ----------------------------------------------------------------------- */
  const remaining = Math.max(0, limit - entries.length);
  if (remaining > 0) {
    const claims = await getDb().all<ClaimRow>(
      `SELECT c.id, c.orchestration_id, c.fragment_id, c.claim, c.source_url,
              c.source_title, c.source_date, c.evidence_excerpt, c.evidence_locator,
              c.retrieved_at, c.confidence, c.contradiction_state, c.validation_state,
              c.accepted
         FROM research_claims c
         JOIN research_orchestrations o ON o.id = c.orchestration_id
        WHERE o.project_id = ?
        ORDER BY c.accepted DESC, c.confidence DESC, c.rowid DESC
        LIMIT ?`,
      [input.projectId, remaining] as never[],
    );
    for (const row of claims) {
      entries.push({
        id: `claim:${row.id}`,
        origin: 'RESEARCH_CLAIM',
        kind: kindFor(row),
        statement: row.claim,
        detail: row.evidence_excerpt,
        confidence: bucket(row.confidence, row.accepted === 1),
        status: statusFor(row),
        missingEvidence: missingFor(row),
        provenance: {
          orchestrationId: row.orchestration_id,
          claimId: row.id,
          ...(row.fragment_id ? { fragmentId: row.fragment_id } : {}),
          ...(row.source_url ? { sourceUrl: row.source_url } : {}),
          ...(row.source_title ? { sourceTitle: row.source_title } : {}),
          ...(row.evidence_locator ? { locator: row.evidence_locator } : {}),
          ...(row.retrieved_at ? { retrievedAt: row.retrieved_at } : {}),
        },
        asOf: row.source_date ?? row.retrieved_at,
      });
    }
  }

  return entries;
}

/**
 * Why a surface is showing nothing.
 *
 * Six answers, because "nothing yet" covering all six is the defect. A person
 * who is refused must not be told the thing is empty, and a person looking at a
 * genuinely empty project must not be left wondering whether it is broken.
 */
export type EmptyReason =
  | 'EMPTY'
  | 'NOTHING_ACTIVE'
  | 'NOT_CONNECTED'
  | 'STALE'
  | 'UNAVAILABLE'
  | 'FORBIDDEN';

export interface SurfaceState<T> {
  items: T[];
  /** Null when there is something to show. */
  emptyReason: EmptyReason | null;
  /** One plain sentence. Safe to render; names no id the reader lacks. */
  explanation: string | null;
}

/**
 * Wrap a projection in the honest reason it is empty.
 *
 * `total` is what exists *before* the active filter, which is what separates
 * "there is none of this" from "none of it is active right now" — the
 * distinction a filtered list otherwise destroys.
 */
export function surfaceState<T>(input: {
  items: T[];
  total?: number;
  reason?: EmptyReason;
}): SurfaceState<T> {
  if (input.items.length > 0) return { items: input.items, emptyReason: null, explanation: null };
  const reason: EmptyReason =
    input.reason ?? ((input.total ?? 0) > 0 ? 'NOTHING_ACTIVE' : 'EMPTY');
  const explanation: Record<EmptyReason, string> = {
    EMPTY: 'There is nothing here yet.',
    NOTHING_ACTIVE: 'There is nothing active right now, but this is not empty.',
    NOT_CONNECTED: 'This is not connected yet, so there is nothing to read.',
    STALE: 'The last reading is out of date and has not been refreshed.',
    UNAVAILABLE: 'This could not be read just now.',
    FORBIDDEN: 'This could not be read just now.',
  };
  return { items: [], emptyReason: reason, explanation: explanation[reason] };
}
