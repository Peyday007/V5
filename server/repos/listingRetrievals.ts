/**
 * Every retrieval Brain made of a known listing, append-only.
 *
 * See `121_listing_retrievals.sql`. Nothing here decides anything about an
 * opportunity; the rows are context for the worker that judges it.
 */
import { getDb } from '../db/database.ts';
import { newId } from './util.ts';
import type { ListingOutcome, ListingPlatform } from '../domain/listing.ts';

export interface ListingRetrieval {
  id: string;
  projectId: string;
  opportunityId: string;
  platform: ListingPlatform;
  platformId: string | null;
  seoUrl: string | null;
  originalUrl: string;
  requestUrl: string;
  outcome: ListingOutcome;
  httpStatus: number | null;
  reason: string;
  responseBody: string | null;
  bodyTruncated: boolean;
  retrievedAt: string;
}

interface Row {
  id: string;
  project_id: string;
  opportunity_id: string;
  platform: ListingPlatform;
  platform_id: string | null;
  seo_url: string | null;
  original_url: string;
  request_url: string;
  outcome: ListingOutcome;
  http_status: number | null;
  reason: string;
  response_body: string | null;
  body_truncated: number;
  retrieved_at: string;
}

function map(row: Row): ListingRetrieval {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    platform: row.platform,
    platformId: row.platform_id,
    seoUrl: row.seo_url,
    originalUrl: row.original_url,
    requestUrl: row.request_url,
    outcome: row.outcome,
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    reason: row.reason,
    responseBody: row.response_body,
    bodyTruncated: Number(row.body_truncated) === 1,
    retrievedAt: row.retrieved_at,
  };
}

/** A stored response is bounded; the truncation is recorded rather than hidden. */
export const MAX_STORED_BODY_CHARS = 64_000;

export async function recordListingRetrieval(
  input: Omit<ListingRetrieval, 'id' | 'bodyTruncated'>,
): Promise<ListingRetrieval> {
  const body = input.responseBody;
  const truncated = body !== null && body.length > MAX_STORED_BODY_CHARS;
  const stored = truncated ? body!.slice(0, MAX_STORED_BODY_CHARS) : body;
  const id = newId('lsr');
  await getDb().run(
    `INSERT INTO listing_retrievals
       (id, project_id, opportunity_id, platform, platform_id, seo_url, original_url, request_url,
        outcome, http_status, reason, response_body, body_truncated, retrieved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.opportunityId,
      input.platform,
      input.platformId,
      input.seoUrl,
      input.originalUrl,
      input.requestUrl,
      input.outcome,
      input.httpStatus,
      input.reason,
      stored,
      truncated ? 1 : 0,
      input.retrievedAt,
    ],
  );
  return { ...input, id, responseBody: stored, bodyTruncated: truncated };
}

/** The newest attempts for one opportunity, newest first. */
export async function recentListingRetrievals(opportunityId: string, limit = 5): Promise<ListingRetrieval[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM listing_retrievals WHERE opportunity_id = ?
      ORDER BY retrieved_at DESC, id DESC LIMIT ?`,
    [opportunityId, Math.max(1, limit)],
  );
  return rows.map(map);
}

/** The newest attempt for each of a project's opportunities, in one read. */
export async function latestListingRetrievals(projectId: string): Promise<Map<string, ListingRetrieval[]>> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM listing_retrievals WHERE project_id = ?
      ORDER BY opportunity_id, retrieved_at DESC, id DESC`,
    [projectId],
  );
  const out = new Map<string, ListingRetrieval[]>();
  for (const row of rows) {
    const list = out.get(row.opportunity_id) ?? [];
    if (list.length < 5) list.push(map(row));
    out.set(row.opportunity_id, list);
  }
  return out;
}

/** Each of a project's opportunities whose accepted source claim carries a link. */
export async function opportunitySourceLinks(
  projectId: string,
): Promise<{ opportunityId: string; sourceClaimId: string; sourceUrl: string; state: string; validationState: string | null; duplicateOfId: string | null }[]> {
  const rows = await getDb().all<{
    id: string;
    source_claim_id: string;
    source_url: string;
    state: string;
    validation_state: string | null;
    duplicate_of_id: string | null;
  }>(
    `SELECT o.id, o.source_claim_id, c.source_url, o.state, o.validation_state, o.duplicate_of_id
       FROM cash_opportunities o
       JOIN research_claims c ON c.id = o.source_claim_id
      WHERE o.project_id = ? AND c.source_url IS NOT NULL
      ORDER BY o.created_at, o.id`,
    [projectId],
  );
  return rows.map((row) => ({
    opportunityId: row.id,
    sourceClaimId: row.source_claim_id,
    sourceUrl: row.source_url,
    state: row.state,
    validationState: row.validation_state,
    duplicateOfId: row.duplicate_of_id,
  }));
}

/**
 * The opportunity a research orchestration is a follow-up about: its deep
 * dive, or the research a need or the dive's own idea launched. Null for a
 * discovery packet, which is about no one listing.
 */
export async function opportunityIdForOrchestration(orchestrationId: string): Promise<string | null> {
  const row = await getDb().get<{ id: string }>(
    `SELECT o.id FROM cash_opportunities o WHERE o.validation_orchestration_id = ?
     UNION ALL
     SELECT o.id FROM russell_missions m JOIN cash_opportunities o ON o.candidate_id = m.candidate_id
      WHERE m.orchestration_id = ?
     UNION ALL
     SELECT n.opportunity_id FROM russell_missions m JOIN cash_needs n ON n.candidate_id = m.candidate_id
      WHERE m.orchestration_id = ? AND n.opportunity_id IS NOT NULL
     LIMIT 1`,
    [orchestrationId, orchestrationId, orchestrationId],
  );
  return row?.id ?? null;
}
