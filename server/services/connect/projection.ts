/**
 * What the site is told about a record — derived from rows, never asserted.
 *
 * ---------------------------------------------------------------------------
 * Why this is a derivation rather than a stored status
 * ---------------------------------------------------------------------------
 *
 * A status column would have to be written by whatever moved the work, and the
 * things that move this work are Russell's loop, the research orchestrator, the
 * audit pipeline and a person answering a Needs You request. Every one of them
 * would have to remember, and the one that forgot would leave a record reading
 * "being worked on" for ever. §24 met exactly that defect three times and the
 * rule that came out of it is the one applied here: derive it on the read path
 * from the rows that actually decide, so there is nothing to forget.
 *
 * ---------------------------------------------------------------------------
 * The six answers, and why there is no seventh
 * ---------------------------------------------------------------------------
 *
 * `NOT_EVALUATED` is the honest answer for a record nobody has asked about, and
 * it is the default rather than an error. `QUEUED` means the idea exists and is
 * waiting its turn. `IN_PROGRESS` means a mission is actually running.
 * `NEEDS_PERSON` names what is waiting on a human, including the case a project
 * with no standing authority is in — which is the one a site would otherwise
 * render as "queued" for ever. `COMPLETED` and `FAILED` carry what was
 * concluded and the actual reason it ended.
 *
 * There is no optimistic copy anywhere in here. An idea Russell parked because
 * the archive already answered it reads `COMPLETED` with that as its reason,
 * because it is finished — not "in progress", and not silently absent.
 */
import { getCandidate } from '../../repos/russellCandidates.ts';
import {
  latestMissionForCandidate,
  knowledgeForMission,
  openRequestFor,
} from '../../repos/russellMissions.ts';
import { checkAuthority } from '../../repos/russellAuthority.ts';
import { RESEARCH_WORK } from '../russell/authority.ts';
import { getLayer } from '../../repos/layers.ts';
import { plainLayerName } from '../russell/dealDispatch.ts';
import type {
  CandidatePriority,
  ExternalProjectionState,
  ExternalRecord,
} from '../../domain/types.ts';

/**
 * Brain's priority, in the words a person reads.
 *
 * One mapping, here, rather than the same translation in every site that
 * connects. A label this does not know falls back to nothing rather than to a
 * guess, because inventing a rank is worse than showing none.
 */
const PRIORITY_LABELS: Record<CandidatePriority, string> = {
  MUST_DO: 'Must do',
  BIG_MOVE: 'Big move',
  WORTH_DOING: 'Worth doing',
  EXPLORE: 'Worth a look',
  PARKED: 'Parked',
};

/** Rank order, so a site can sort without knowing Brain's vocabulary. */
const PRIORITY_RANK: Record<CandidatePriority, number> = {
  MUST_DO: 1,
  BIG_MOVE: 2,
  WORTH_DOING: 3,
  EXPLORE: 4,
  PARKED: 5,
};

export interface ExternalProjection {
  /** The Brain id of the link. This is the record's Brain identity. */
  brainId: string;
  sourceSystem: string;
  sourceRecordId: string;
  sourceVersion: string;
  title: string;
  /** What the site itself said the record's state was, at that version. */
  sourceState: string | null;
  state: ExternalProjectionState;
  /** One sentence, always present, saying what that state means here. */
  stateReason: string;
  /** Brain's own ranking, or null when Brain has not formed one. */
  priority: string | null;
  priorityRank: number | null;
  /** Brain's plain sentence about why. Never a template, never invented. */
  reason: string | null;
  confidence: number | null;
  /** What research has produced, when it has produced anything. */
  research: {
    missionId: string;
    objective: string;
    /** Present only once a document has actually been filed. */
    documentId: string | null;
    /** What the project now believes, in one sentence, from the writeback. */
    conclusion: string | null;
    /** The layer it was filed under, in plain words. */
    filedUnder: string | null;
  } | null;
  /** The one thing the site can offer to do next, or null when there is none. */
  nextAction: { command: string; label: string } | null;
  /** When Brain last changed anything about this record. */
  lastUpdatedAt: string;
  /** When the projection itself was derived. Always now; never a memory. */
  observedAt: string;
}

function noAction(): null {
  return null;
}

/**
 * Derive the projection for one registered record.
 *
 * Everything is read at the moment of the call. Nothing here writes, so it is
 * safe to call from a read route and safe to call often.
 */
export async function projectRecord(
  record: ExternalRecord,
  at: string,
): Promise<ExternalProjection> {
  const base = {
    brainId: record.id,
    sourceSystem: record.sourceSystem,
    sourceRecordId: record.sourceRecordId,
    sourceVersion: record.sourceVersion,
    title: record.title,
    sourceState: typeof record.attributes['state'] === 'string'
      ? (record.attributes['state'] as string)
      : typeof record.attributes['stage'] === 'string'
        ? (record.attributes['stage'] as string)
        : null,
    lastUpdatedAt: record.updatedAt,
    observedAt: at,
  };

  if (!record.candidateId) {
    return {
      ...base,
      state: 'NOT_EVALUATED',
      stateReason: 'Brain holds this record and has not been asked to form a view on it.',
      priority: null,
      priorityRank: null,
      reason: null,
      confidence: null,
      research: null,
      nextAction: { command: 'RESEARCH_FURTHER', label: 'Ask Brain to research this' },
    };
  }

  const candidate = await getCandidate(record.candidateId);
  if (!candidate) {
    /*
     * The link points at a candidate that is gone.
     *
     * Visibly wrong rather than silently complete — the §24 rule. A projection
     * that quietly went back to NOT_EVALUATED would invite a second command and
     * hide that something deleted the idea.
     */
    return {
      ...base,
      state: 'FAILED',
      stateReason:
        'Brain was asked about this record and the idea it created can no longer be read. ' +
        'That is a fault here rather than a verdict about the record.',
      priority: null,
      priorityRank: null,
      reason: null,
      confidence: null,
      research: null,
      nextAction: noAction(),
    };
  }

  const priority = candidate.priority;
  const priorityLabel = priority ? PRIORITY_LABELS[priority] : null;
  const priorityRank = priority ? PRIORITY_RANK[priority] : null;
  const mission = await latestMissionForCandidate(candidate.id);

  const research = mission
    ? {
        missionId: mission.id,
        objective: mission.objective,
        documentId: mission.documentId,
        conclusion: await conclusionOf(mission.id),
        filedUnder: await layerNameOf(mission.layerId),
      }
    : null;

  // A mission that exists decides the state, because it is the thing actually
  // happening. The candidate's own state only speaks when no mission does.
  if (mission) {
    switch (mission.state) {
      case 'DONE':
        return {
          ...base,
          state: 'COMPLETED',
          stateReason: mission.documentId
            ? 'Brain researched this, filed a report and audited it.'
            : 'Brain finished with this and recorded its conclusion.',
          priority: priorityLabel,
          priorityRank,
          reason: candidate.reason,
          confidence: candidate.confidence,
          research,
          nextAction: noAction(),
        };
      case 'FAILED':
      case 'CANCELLED':
        return {
          ...base,
          state: 'FAILED',
          stateReason:
            mission.terminalReason?.trim() ||
            'The research ended without producing a report, and no reason was recorded.',
          priority: priorityLabel,
          priorityRank,
          reason: candidate.reason,
          confidence: candidate.confidence,
          research,
          nextAction: noAction(),
        };
      case 'NEEDS_HUMAN': {
        const request = await openRequestFor(mission.id);
        return {
          ...base,
          state: 'NEEDS_PERSON',
          stateReason:
            request?.authorityNeeded?.trim() ||
            mission.waitingOn?.trim() ||
            'Brain has stopped on a decision only a person can take.',
          priority: priorityLabel,
          priorityRank,
          reason: candidate.reason,
          confidence: candidate.confidence,
          research,
          nextAction: noAction(),
        };
      }
      case 'WAITING':
        return {
          ...base,
          state: 'IN_PROGRESS',
          stateReason: mission.waitingOn?.trim()
            ? `Running, waiting on ${mission.waitingOn.trim()}.`
            : 'Running.',
          priority: priorityLabel,
          priorityRank,
          reason: candidate.reason,
          confidence: candidate.confidence,
          research,
          nextAction: noAction(),
        };
      case 'RUNNING':
      case 'LAUNCHING':
      case 'PLANNED':
        return {
          ...base,
          state: 'IN_PROGRESS',
          stateReason: 'Brain is researching this now.',
          priority: priorityLabel,
          priorityRank,
          reason: candidate.reason,
          confidence: candidate.confidence,
          research,
          nextAction: noAction(),
        };
    }
  }

  // No mission. The candidate's own state and Brain's authority to act decide.
  switch (candidate.state) {
    case 'DONE':
    case 'PARKED':
    case 'REJECTED':
      return {
        ...base,
        state: 'COMPLETED',
        stateReason:
          candidate.reason?.trim() ||
          'Brain looked at this and decided it needs nothing further.',
        priority: priorityLabel,
        priorityRank,
        reason: candidate.reason,
        confidence: candidate.confidence,
        research,
        nextAction: noAction(),
      };
    case 'MERGED':
      return {
        ...base,
        state: 'QUEUED',
        stateReason: 'Brain is already working on this as part of something it holds.',
        priority: priorityLabel,
        priorityRank,
        reason: candidate.reason,
        confidence: candidate.confidence,
        research,
        nextAction: noAction(),
      };
    case 'PROBING':
      return {
        ...base,
        state: 'IN_PROGRESS',
        stateReason: 'Brain is taking a cheap look before deciding whether to spend anything.',
        priority: priorityLabel,
        priorityRank,
        reason: candidate.reason,
        confidence: candidate.confidence,
        research,
        nextAction: noAction(),
      };
    case 'CAPTURED':
    case 'PROMOTED':
    case 'QUEUED':
    default:
      break;
  }

  /*
   * Queued — but queued behind what?
   *
   * A project with no standing authority cannot launch anything, so a record
   * here would sit at "waiting its turn" indefinitely while the actual blocker
   * is a decision nobody is being asked for. §24's rule: a state that says
   * "waiting" which nobody can resolve is not waiting, it is stuck. So the
   * authority is checked and the answer says which of the two this is.
   */
  const authority = await checkAuthority({
    projectId: candidate.projectId ?? record.projectId,
    workClass: RESEARCH_WORK,
  });
  if (!authority.ok) {
    return {
      ...base,
      state: 'NEEDS_PERSON',
      stateReason:
        'Brain has this on its list and cannot start it: ' +
        `${authority.reason}. Somebody has to authorise research on this project in Brain first.`,
      priority: priorityLabel,
      priorityRank,
      reason: candidate.reason,
      confidence: candidate.confidence,
      research,
      nextAction: noAction(),
    };
  }

  return {
    ...base,
    state: 'QUEUED',
    stateReason: priority
      ? 'Brain has formed a view and this is waiting its turn.'
      : 'Brain has this on its list and has not yet formed a view on it.',
    priority: priorityLabel,
    priorityRank,
    reason: candidate.reason,
    confidence: candidate.confidence,
    research,
    nextAction: noAction(),
  };
}

/** What the project believes now, from the mission's own writeback. */
async function conclusionOf(missionId: string): Promise<string | null> {
  const knowledge = await knowledgeForMission(missionId);
  const first = knowledge[0];
  if (!first) return null;
  const statement = first.statement?.trim();
  return statement ? statement : null;
}

async function layerNameOf(layerId: string | null): Promise<string | null> {
  if (!layerId) return null;
  const layer = await getLayer(layerId);
  return layer ? plainLayerName(layer.name) : null;
}
