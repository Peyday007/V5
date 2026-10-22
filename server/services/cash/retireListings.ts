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
import { getClaim, getOrchestration } from '../../repos/research.ts';
import { listNeeds, listOpportunities } from '../../repos/cashPortfolio.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { getCandidate, transitionCandidate } from '../../repos/russellCandidates.ts';
import { getMissionByOrchestration, missionsForCandidate, transitionMission } from '../../repos/russellMissions.ts';
import { cancelResearch } from '../research/queue.ts';
import { archiveOpportunity } from './opportunities.ts';
import { closeNeed } from './needs.ts';
import { diveStarts } from './diveStage.ts';
import { marketplaceOf } from './worthResearching.ts';
import type { CandidateState, CashOpportunity, CashOpportunityState, MissionState, RussellMission } from '../../domain/types.ts';

const BRAIN = 'BRAIN';

/** The reason every opening this pass archives carries, so a later tick knows it was this pass. */
export const LISTING_ARCHIVE_REASON =
  'A freelance-marketplace listing. This operation takes no freelance work, so Brain put it away ' +
  'with its research; the row, its card and its history are kept.';

export const LISTINGS_RETIRED_EVENT = 'CASH_MARKETPLACE_LISTINGS_RETIRED';

const UNCOMMITTED: CashOpportunityState[] = ['DISCOVERED', 'EVIDENCE_CARD', 'READY'];
const LIVE_MISSIONS: ReadonlySet<MissionState> = new Set(['PLANNED', 'LAUNCHING', 'RUNNING', 'WAITING', 'NEEDS_HUMAN']);
const UNLAUNCHED_CANDIDATES: ReadonlySet<CandidateState> = new Set(['CAPTURED', 'PROMOTED', 'QUEUED', 'PARKED']);

export interface ListingsRetired {
  archived: string[];
  needsWithdrawn: string[];
  candidatesRejected: string[];
  missionsCancelled: string[];
  packetsCancelled: string[];
}

async function isListing(opportunity: CashOpportunity): Promise<boolean> {
  if (!opportunity.sourceClaimId) return false;
  const claim = await getClaim(opportunity.sourceClaimId);
  return marketplaceOf(claim?.sourceUrl) !== null;
}

const FINISHED_PACKETS = new Set(['COMPLETE', 'COMPLETE_WITH_GAPS', 'CANCELLED', 'FAILED']);

async function stopPacket(orchestrationId: string, out: ListingsRetired): Promise<void> {
  const packet = await getOrchestration(orchestrationId);
  if (!packet || FINISHED_PACKETS.has(packet.status)) return;
  const after = await cancelResearch(orchestrationId, LISTING_ARCHIVE_REASON);
  if (after?.status === 'CANCELLED') out.packetsCancelled.push(orchestrationId);
}

async function stopMission(mission: RussellMission, out: ListingsRetired): Promise<void> {
  if (!LIVE_MISSIONS.has(mission.state)) return;
  if (mission.orchestrationId) await stopPacket(mission.orchestrationId, out);
  const moved = await transitionMission({
    missionId: mission.id,
    from: mission.state,
    to: 'CANCELLED',
    terminalReason: LISTING_ARCHIVE_REASON,
  });
  if (moved) out.missionsCancelled.push(mission.id);
}

async function stopResearch(
  opportunity: CashOpportunity,
  needs: Awaited<ReturnType<typeof listNeeds>>,
  out: ListingsRetired,
): Promise<void> {
  const candidates = new Set<string>();
  for (const need of needs) {
    if (need.opportunityId !== opportunity.id) continue;
    if (need.candidateId) candidates.add(need.candidateId);
    if (need.state !== 'OPEN') continue;
    const closed = await closeNeed({
      needId: need.id,
      to: 'WITHDRAWN',
      resolution: `Not researched: ${LISTING_ARCHIVE_REASON} Nothing was established, so this is withdrawn rather than resolved.`,
      actorUserId: BRAIN,
    });
    if (closed.ok) out.needsWithdrawn.push(need.id);
  }
  if (opportunity.candidateId) candidates.add(opportunity.candidateId);
  for (const start of await diveStarts(opportunity.id)) candidates.add(start.candidateId);
  // The bucket that discovered this opening asks about the whole sprint, never this one.
  if (opportunity.discoveredByCandidateId) candidates.delete(opportunity.discoveredByCandidateId);

  for (const candidateId of candidates) {
    for (const mission of await missionsForCandidate(candidateId)) await stopMission(mission, out);
    const candidate = await getCandidate(candidateId);
    if (candidate && UNLAUNCHED_CANDIDATES.has(candidate.state)) {
      if (await transitionCandidate({ candidateId, from: candidate.state, to: 'REJECTED' })) {
        out.candidatesRejected.push(candidateId);
      }
    }
  }
  if (opportunity.validationOrchestrationId) {
    const mission = await getMissionByOrchestration(opportunity.validationOrchestrationId);
    if (mission) await stopMission(mission, out);
    else await stopPacket(opportunity.validationOrchestrationId, out);
  }
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
  for (const opportunity of retire) await stopResearch(opportunity, needs, out);

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
