/**
 * Openings that are freelance-marketplace listings, put away with their work.
 *
 * Cash Mode takes no freelance work. Discovery is told not to report a
 * marketplace listing, and `worthResearching.ts` refuses research on one —
 * but openings filed before that rule existed are still in the portfolio, and
 * some still hold research that can never make them executable.
 *
 * This pass is derived from rows on every tick, so it reaches every such
 * opening whenever it was filed, and it is idempotent:
 *
 *   * An opening nobody has committed to (`DISCOVERED`, `EVIDENCE_CARD`,
 *     `READY`) whose source claim is a marketplace listing is archived by
 *     Brain, with the reason on the row. Nothing is deleted: the row, its card,
 *     its claims and its history stay readable (§5). An opening somebody took
 *     (`EXECUTING` and later) is never touched, because a sprint winding down a
 *     kind of work does not end a customer's obligation (invariant 40).
 *   * Research still waiting or running for an opening this pass archived is
 *     stopped through the paths that already exist: open needs are withdrawn,
 *     ideas that have not launched are rejected, live missions are cancelled,
 *     and their packets are cancelled through `cancelResearch`, whose outstanding
 *     work the terminal-packet reconciliation then retires.
 *
 * It contacts nobody, spends nothing and reverses no person's decision: an
 * opening a person archived or declined is left exactly as they left it.
 */
import { getClaim } from '../../repos/research.ts';
import { listNeeds, listOpportunities } from '../../repos/cashPortfolio.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { archiveOpportunity } from './opportunities.ts';
import { releaseOpportunityResearch, type ResearchReleased } from './releaseResearch.ts';
import { marketplaceOf } from './worthResearching.ts';
import type { CashOpportunity, CashOpportunityState } from '../../domain/types.ts';

const BRAIN = 'BRAIN';

/** The reason every opening this pass archives carries, so a later tick knows it was this pass. */
export const LISTING_ARCHIVE_REASON =
  'A freelance-marketplace listing. This operation takes no freelance work, so Brain put it away ' +
  'with its research; the row, its card and its history are kept.';

export const LISTINGS_RETIRED_EVENT = 'CASH_MARKETPLACE_LISTINGS_RETIRED';

const UNCOMMITTED: CashOpportunityState[] = ['DISCOVERED', 'EVIDENCE_CARD', 'READY'];

export interface ListingsRetired extends ResearchReleased {
  archived: string[];
}

async function isListing(opportunity: CashOpportunity): Promise<boolean> {
  if (!opportunity.sourceClaimId) return false;
  const claim = await getClaim(opportunity.sourceClaimId);
  return marketplaceOf(claim?.sourceUrl) !== null;
}

export async function retireMarketplaceListings(projectId: string): Promise<ListingsRetired> {
  const out: ListingsRetired = {
    archived: [],
    needsWithdrawn: [],
    candidatesRejected: [],
    missionsCancelled: [],
    packetsCancelled: [],
  };
  const retire: CashOpportunity[] = [];
  for (const opportunity of await listOpportunities({ projectId, states: [...UNCOMMITTED, 'ARCHIVED'] })) {
    // An archive somebody else made is theirs; only this pass's own are revisited.
    if (opportunity.state === 'ARCHIVED' && opportunity.archivedReason !== LISTING_ARCHIVE_REASON) continue;
    if (!(await isListing(opportunity))) continue;
    if (opportunity.state !== 'ARCHIVED') {
      const archived = await archiveOpportunity({
        opportunityId: opportunity.id,
        actorRef: BRAIN,
        reason: LISTING_ARCHIVE_REASON,
      });
      if (!archived.ok) continue;
      out.archived.push(opportunity.id);
    }
    retire.push(opportunity);
  }
  if (retire.length === 0) return out;
  const needs = await listNeeds({ projectId });
  for (const opportunity of retire) {
    await releaseOpportunityResearch({ opportunity, needs, reason: LISTING_ARCHIVE_REASON, out });
  }

  const changed =
    out.archived.length + out.needsWithdrawn.length + out.candidatesRejected.length +
    out.missionsCancelled.length + out.packetsCancelled.length;
  if (changed > 0) {
    await recordCashEvent({
      projectId,
      kind: LISTINGS_RETIRED_EVENT,
      actorRef: BRAIN,
      summary:
        `Put away ${out.archived.length} freelance-marketplace listing(s) and stopped their research ` +
        `(${out.needsWithdrawn.length} need(s) withdrawn, ${out.candidatesRejected.length} idea(s) rejected, ` +
        `${out.missionsCancelled.length} mission(s) and ${out.packetsCancelled.length} packet(s) cancelled).`,
      detail: { ...out },
    });
  }
  return out;
}
