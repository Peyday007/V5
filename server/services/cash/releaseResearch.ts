/**
 * Research released when an opening no longer deserves it.
 *
 * One owner for "stop the work behind this opening", used by the marketplace
 * retirement and by the goal screen's REJECT and decision-irrelevant HOLD, so a
 * slot returns to the queue the same way whichever reason freed it.
 *
 * It uses only paths that already exist: open needs are withdrawn, ideas that
 * have not launched are rejected, live missions are cancelled, and packets are
 * cancelled through `cancelResearch`. Nothing is deleted (§5). An opening
 * somebody took (`EXECUTING` and later) is never touched, because ending a kind
 * of work does not end a customer's obligation (invariant 40), and the idea that
 * discovered the opening asks about the whole sprint, so it is never released.
 */
import { getOrchestration } from '../../repos/research.ts';
import { listNeeds } from '../../repos/cashPortfolio.ts';
import { getCandidate, transitionCandidate } from '../../repos/russellCandidates.ts';
import { getMissionByOrchestration, missionsForCandidate, transitionMission } from '../../repos/russellMissions.ts';
import { cancelResearch } from '../research/queue.ts';
import { closeNeed } from './needs.ts';
import { diveStarts } from './diveStage.ts';
import type { CandidateState, CashOpportunity, CashOpportunityState, MissionState, RussellMission } from '../../domain/types.ts';

const BRAIN = 'BRAIN';

/** States whose research may be released: nobody has committed to the opening. */
export const RELEASABLE_STATES: ReadonlySet<CashOpportunityState> = new Set<CashOpportunityState>([
  'DISCOVERED',
  'EVIDENCE_CARD',
  'READY',
  'ARCHIVED',
  'DECLINED',
]);

const LIVE_MISSIONS: ReadonlySet<MissionState> = new Set(['PLANNED', 'LAUNCHING', 'RUNNING', 'WAITING', 'NEEDS_HUMAN']);
const UNLAUNCHED_CANDIDATES: ReadonlySet<CandidateState> = new Set(['CAPTURED', 'PROMOTED', 'QUEUED', 'PARKED']);
const FINISHED_PACKETS = new Set(['COMPLETE', 'COMPLETE_WITH_GAPS', 'CANCELLED', 'FAILED']);

export interface ResearchReleased {
  needsWithdrawn: string[];
  candidatesRejected: string[];
  missionsCancelled: string[];
  packetsCancelled: string[];
}

export function emptyRelease(): ResearchReleased {
  return { needsWithdrawn: [], candidatesRejected: [], missionsCancelled: [], packetsCancelled: [] };
}

async function stopPacket(orchestrationId: string, reason: string, out: ResearchReleased): Promise<void> {
  const packet = await getOrchestration(orchestrationId);
  if (!packet || FINISHED_PACKETS.has(packet.status)) return;
  const after = await cancelResearch(orchestrationId, reason);
  if (after?.status === 'CANCELLED') out.packetsCancelled.push(orchestrationId);
}

async function stopMission(mission: RussellMission, reason: string, out: ResearchReleased): Promise<void> {
  if (!LIVE_MISSIONS.has(mission.state)) return;
  if (mission.orchestrationId) await stopPacket(mission.orchestrationId, reason, out);
  const moved = await transitionMission({
    missionId: mission.id,
    from: mission.state,
    to: 'CANCELLED',
    terminalReason: reason,
  });
  if (moved) out.missionsCancelled.push(mission.id);
}

/**
 * Release the research behind one opening. Does nothing (`released: false`)
 * for an opening somebody committed to. `needs` may be passed to avoid
 * re-reading them for every opening.
 */
export async function releaseOpportunityResearch(input: {
  opportunity: CashOpportunity;
  reason: string;
  needs?: Awaited<ReturnType<typeof listNeeds>>;
  out?: ResearchReleased;
}): Promise<ResearchReleased & { released: boolean }> {
  const out = input.out ?? emptyRelease();
  const { opportunity, reason } = input;
  if (!RELEASABLE_STATES.has(opportunity.state)) return { ...out, released: false };
  const needs = input.needs ?? (await listNeeds({ projectId: opportunity.projectId }));

  const candidates = new Set<string>();
  for (const need of needs) {
    if (need.opportunityId !== opportunity.id) continue;
    if (need.candidateId) candidates.add(need.candidateId);
    if (need.state !== 'OPEN') continue;
    const closed = await closeNeed({
      needId: need.id,
      to: 'WITHDRAWN',
      resolution: `Not researched: ${reason} Nothing was established, so this is withdrawn rather than resolved.`,
      actorUserId: BRAIN,
    });
    if (closed.ok) out.needsWithdrawn.push(need.id);
  }
  if (opportunity.candidateId) candidates.add(opportunity.candidateId);
  for (const start of await diveStarts(opportunity.id)) candidates.add(start.candidateId);
  // The bucket that discovered this opening asks about the whole sprint, never this one.
  if (opportunity.discoveredByCandidateId) candidates.delete(opportunity.discoveredByCandidateId);

  for (const candidateId of candidates) {
    for (const mission of await missionsForCandidate(candidateId)) await stopMission(mission, reason, out);
    const candidate = await getCandidate(candidateId);
    if (candidate && UNLAUNCHED_CANDIDATES.has(candidate.state)) {
      if (await transitionCandidate({ candidateId, from: candidate.state, to: 'REJECTED' })) {
        out.candidatesRejected.push(candidateId);
      }
    }
  }
  if (opportunity.validationOrchestrationId) {
    const mission = await getMissionByOrchestration(opportunity.validationOrchestrationId);
    if (mission) await stopMission(mission, reason, out);
    else await stopPacket(opportunity.validationOrchestrationId, reason, out);
  }
  return { ...out, released: true };
}
