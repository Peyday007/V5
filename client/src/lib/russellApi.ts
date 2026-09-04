/**
 * The Russell half of the door between the UI and the server.
 *
 * Kept beside `api.ts` rather than inside it, because the two surfaces answer
 * different questions and are versioned by different steps. Everything here is
 * a plain function over `api()`, so a screen never builds a URL and never sees
 * a `fetch`.
 *
 * The types are imported from the server, type-only, for the same reason the
 * rest of the client does it: the two halves cannot drift, and nothing from the
 * server is bundled.
 */
import { api } from './api.ts';
import type {
  RussellCandidate,
  RussellConversation,
  RussellHumanRequest,
  RussellKnowledge,
  RussellMessage,
  RussellMission,
  RussellProbe,
  RussellProbeObservation,
  CycleState,
} from '../../../server/domain/types.ts';
import type { Briefing } from '../../../server/services/russell/projections.ts';
import type { ConnectedSystemView } from '../../../server/services/russell/dealDispatch.ts';
import type { Progress } from '../../../server/services/russell/progress.ts';
import type { GroupedWork, WorkEntry } from '../../../server/services/russell/work.ts';
import type { IdeaEdge, IdeaMap, IdeaNode } from '../../../server/services/russell/ideas.ts';
import type { WhoView } from '../../../server/services/russell/who.ts';

export type {
  Briefing,
  ConnectedSystemView,
  GroupedWork,
  IdeaEdge,
  IdeaMap,
  IdeaNode,
  Progress,
  WhoView,
  WorkEntry,
  RussellCandidate,
  RussellConversation,
  RussellHumanRequest,
  RussellKnowledge,
  RussellMessage,
  RussellMission,
};

export interface BriefingResponse {
  briefing: Briefing;
  focusLayer: string | null;
  cycle: { state: CycleState; pausedReason: string | null } | null;
}

export interface ThreadResponse {
  conversation: RussellConversation;
  turns: RussellMessage[];
}

export interface TurnResponse {
  userMessage: RussellMessage | null;
  pending: RussellMessage | null;
  attachedProjectId: string | null;
  dispatched: boolean;
}

/**
 * One entry in Knows.
 *
 * Mirrors the server projection exactly, including `missingEvidence`: a
 * provisional claim's shortfalls are part of what a reader is owed, not an
 * internal detail to hide behind a confidence word.
 */
export interface KnowsEntry {
  id: string;
  origin: 'RUSSELL_KNOWLEDGE' | 'RESEARCH_CLAIM';
  kind: string;
  statement: string;
  detail: string | null;
  confidence: string;
  status: 'ACCEPTED' | 'PROVISIONAL' | 'UNDER_REVIEW' | 'CONTRADICTED' | 'STALE' | 'SUPERSEDED';
  missingEvidence: string[];
  provenance: Record<string, string>;
  asOf: string | null;
}

/** The six honest empties, matching the server's vocabulary exactly. */
export type EmptyReason =
  | 'EMPTY'
  | 'NOTHING_ACTIVE'
  | 'NOT_CONNECTED'
  | 'STALE'
  | 'UNAVAILABLE'
  | 'FORBIDDEN';

/** Any list the server wrapped with the reason it might be empty. */
export interface SurfaceEnvelope<T> {
  items: T[];
  emptyReason: EmptyReason | null;
  explanation: string | null;
}

/** A surface plus the honest reason it is empty, when it is. */
export type KnowsSurface = SurfaceEnvelope<KnowsEntry>;

export const RussellApi = {
  conversations: (): Promise<{ conversations: RussellConversation[] }> =>
    api('/api/russell/conversations'),

  openConversation: (title: string, projectId?: string | null): Promise<RussellConversation> =>
    api('/api/russell/conversations', {
      method: 'POST',
      body: JSON.stringify({ title, projectId: projectId ?? null }),
    }),

  thread: (conversationId: string): Promise<ThreadResponse> =>
    api(`/api/russell/conversations/${encodeURIComponent(conversationId)}`),

  say: (conversationId: string, content: string): Promise<TurnResponse> =>
    api(`/api/russell/conversations/${encodeURIComponent(conversationId)}/turns`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  briefing: (projectId: string): Promise<BriefingResponse> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/briefing`),

  /**
   * Work, grouped and provenance-labelled.
   *
   * `technical` opens the verifier's scopes, fixtures and conversation
   * machinery. It defaults off, because those are real rows that are not
   * anybody's project work, and counting them inflates every number a person
   * reads.
   */
  work: (
    projectId: string,
    options: { technical?: boolean } = {},
  ): Promise<{
    missions: RussellMission[];
    work: {
      items: WorkEntry[];
      emptyReason: EmptyReason | null;
      explanation: string | null;
      groups: GroupedWork[];
      includesTechnical: boolean;
      technicalHidden: number;
    };
  }> =>
    api(
      `/api/russell/projects/${encodeURIComponent(projectId)}/work${options.technical ? '?technical=1' : ''}`,
    ),

  ideas: (projectId: string): Promise<{ map: IdeaMap; state: SurfaceEnvelope<IdeaNode> }> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/ideas`),

  who: (projectId: string): Promise<WhoView> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/who`),

  progress: (
    projectId: string,
  ): Promise<{ project: Progress; work: Progress; build: Progress }> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/progress`),

  candidates: (projectId: string): Promise<{ candidates: RussellCandidate[] }> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/candidates`),

  knowledge: (
    projectId: string,
  ): Promise<{ knowledge: RussellKnowledge[]; knows: KnowsSurface }> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/knowledge`),

  needsYou: (projectId: string): Promise<{ requests: RussellHumanRequest[] }> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/needs-you`),

  answer: (requestId: string, choice: string, reason?: string): Promise<RussellHumanRequest> =>
    api(`/api/russell/needs-you/${encodeURIComponent(requestId)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ choice, reason: reason ?? null }),
    }),

  probes: (
    candidateId: string,
  ): Promise<{ probes: (RussellProbe & { observations: RussellProbeObservation[] })[] }> =>
    api(`/api/russell/candidates/${encodeURIComponent(candidateId)}/probes`),

  dealDispatch: (): Promise<ConnectedSystemView> => api('/api/russell/deal-dispatch'),
};
