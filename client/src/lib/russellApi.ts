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

export type {
  Briefing,
  ConnectedSystemView,
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

/** A surface plus the honest reason it is empty, when it is. */
export interface KnowsSurface {
  items: KnowsEntry[];
  emptyReason: 'EMPTY' | 'NOTHING_ACTIVE' | 'NOT_CONNECTED' | 'STALE' | 'UNAVAILABLE' | 'FORBIDDEN' | null;
  explanation: string | null;
}

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

  work: (projectId: string): Promise<{ missions: RussellMission[] }> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/work`),

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
