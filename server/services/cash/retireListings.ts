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
import { emptyRelease, releaseOpportunityResearch, type ResearchReleased } from './releaseResearch.ts';
import { describeNotWorthResearching, marketplaceOf, notWorthResearching } from './worthResearching.ts';
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

/** The event the excluded-research pass records when it stopped anything. */
export const UNWORTHY_RESEARCH_RELEASED_EVENT = 'CASH_UNWORTHY_RESEARCH_RELEASED';

/**
 * Why research may be released for good: reasons no later fact reverses. A
 * goal's exclusion is its owner's words, a listing stays a listing, a closing
 * date that passed stays passed, and the owner does no physical work. A
 * screen's REJECT or a size test is not here — the goal screen already
 * releases on its own verdicts, and a size is a fact research can still move.
 */
const DURABLE: ReadonlySet<string> = new Set(['EXCLUDED_BY_GOAL', 'OWNER_PHYSICAL_WORK']);

function durable(reason: Awaited<ReturnType<typeof notWorthResearching>>): boolean {
  if (!reason) return false;
  if (reason.kind === 'MARKETPLACE_LISTING' || reason.kind === 'CLOSES_TOO_SOON') return true;
  return DURABLE.has(reason.reason);
}

/**
 * Research still running for an opening Brain already decided is not worth
 * researching, stopped (§5: nothing is archived or deleted here).
 *
 * `notWorthResearching` refuses a *new* dive or question on an opening every
 * live goal excludes, but a packet launched before the exclusion existed, or a
 * question raised before it, kept its slot. Production, 2026-11-07: of 27 open
 * research items on the $10K goal's project, ten were about openings the goal
 * excludes (domain resales appraised on Afternic, a City of St. Louis RFP, a
 * Freelancer.com listing) and kept leasing fleet slots at priority 6–9.
 *
 * Only openings that still hold live research are judged, so a quiet project
 * costs one read of its needs. Idempotent: `releaseOpportunityResearch` acts
 * only on what is still open, live or unlaunched.
 */
export async function releaseUnworthyResearch(projectId: string, now: string): Promise<ResearchReleased & { released: string[] }> {
  const out: ResearchReleased & { released: string[] } = { ...emptyRelease(), released: [] };
  const needs = await listNeeds({ projectId });
  const withOpenNeed = new Set(needs.filter((one) => one.state === 'OPEN' && one.opportunityId).map((one) => one.opportunityId!));
  for (const opportunity of await listOpportunities({ projectId, states: [...UNCOMMITTED] })) {
    if (!withOpenNeed.has(opportunity.id) && !opportunity.validationOrchestrationId) continue;
    const reason = await notWorthResearching(opportunity, { now });
    if (!durable(reason)) continue;
    const before = out.needsWithdrawn.length + out.candidatesRejected.length + out.missionsCancelled.length + out.packetsCancelled.length;
    await releaseOpportunityResearch({ opportunity, needs, reason: `${describeNotWorthResearching(reason!)}.`, out });
    const after = out.needsWithdrawn.length + out.candidatesRejected.length + out.missionsCancelled.length + out.packetsCancelled.length;
    if (after > before) out.released.push(opportunity.id);
  }
  if (out.released.length > 0) {
    await recordCashEvent({
      projectId,
      kind: UNWORTHY_RESEARCH_RELEASED_EVENT,
      actorRef: BRAIN,
      summary:
        `Stopped research on ${out.released.length} opening(s) no goal may use ` +
        `(${out.needsWithdrawn.length} need(s) withdrawn, ${out.candidatesRejected.length} idea(s) rejected, ` +
        `${out.missionsCancelled.length} mission(s) and ${out.packetsCancelled.length} packet(s) cancelled).`,
      detail: { ...out },
    });
  }
  return out;
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
