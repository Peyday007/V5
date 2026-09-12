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
  CandidatePriority,
  CandidateState,
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
import type { HomeView } from '../../../server/services/russell/home.ts';
import type { CollectionView, RankedThread, Starter } from '../../../server/services/russell/collections.ts';
import type {
  AuthorityView,
  AuthorityLimitKey,
} from '../../../server/services/russell/authority.ts';

export type {
  AuthorityLimitKey,
  AuthorityView,
  Briefing,
  CollectionView,
  HomeView,
  RankedThread,
  Starter,
  CandidatePriority,
  CandidateState,
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

/** What comes back from asking for another attempt at a failed turn. */
export interface RetryResponse {
  pending: RussellMessage | null;
  /** Which attempt this is, counting the original as 1. */
  attempt: number | null;
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

/* --------------------------------------------------------------------------
 * Connected sites
 * ------------------------------------------------------------------------ */

/**
 * The five answers, matching the server's vocabulary exactly.
 *
 * `NOT_CONNECTED` and `AWAITING_FIRST_CALL` are different on purpose: the
 * first means nothing has been issued, the second means Brain's half is done
 * and the secret has not reached the site yet. Collapsing them would leave a
 * person pressing Connect against a Brain that was already ready.
 */
export type SiteConnectionState =
  | 'NOT_CONNECTED'
  | 'AWAITING_FIRST_CALL'
  | 'CONNECTED'
  | 'NEEDS_REPAIR'
  | 'DISCONNECTED';

export interface SiteStatus {
  system: string;
  name: string;
  slug: string;
  description: string;
  variables: { url: string; token: string; project: string };
  state: SiteConnectionState;
  stateReason: string;
  workerName: string;
  workerId: string | null;
  scopes: string[] | null;
  scopesCorrect: boolean;
  liveCredentials: number;
  lastUsedAt: string | null;
  records: number;
  rejections: number;
  lastDeliveryAt: string | null;
  lastCommandAt: string | null;
}

export interface ConnectSiteResult {
  status: SiteStatus;
  /** Shown once, held only in this tab's memory, never fetched again. */
  secret: string;
  createdIdentity: boolean;
  repairedScopes: boolean;
  revokedCredentials: number;
  instruction: {
    reason: string;
    variables: { name: string; value: string | null; secret: boolean }[];
  };
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

  /**
   * Have another go at a turn that failed.
   *
   * No body on purpose. A retry that carried text would be a way to ask
   * something different while calling it the same question; the server walks
   * back to what the person actually said.
   */
  retry: (conversationId: string, messageId: string): Promise<RetryResponse> =>
    api(
      `/api/russell/conversations/${encodeURIComponent(conversationId)}/turns/` +
        `${encodeURIComponent(messageId)}/retry`,
      { method: 'POST' },
    ),

  briefing: (projectId: string): Promise<BriefingResponse> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/briefing`),

  /**
   * The whole home in one read.
   *
   * One call rather than five, because §6 asks for one deterministic answer
   * about status and progress: a client that assembled it from separate reads
   * could show a briefing from one instant beside a state from another.
   */
  home: (projectId: string): Promise<{
    home: HomeView;
    project: { id: string; name: string };
  }> => api(`/api/russell/projects/${encodeURIComponent(projectId)}/home`),

  /** A person's threads, organized and ranked by meaning. */
  collections: (projectId: string | null): Promise<{ collections: CollectionView[] }> =>
    api(`/api/russell/collections${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),

  /** Move a thread. `null` takes it out of every collection. */
  fileConversation: (conversationId: string, collectionId: string | null): Promise<{ ok: true }> =>
    api(`/api/russell/conversations/${encodeURIComponent(conversationId)}/collection`, {
      method: 'PATCH',
      body: JSON.stringify({ collectionId }),
    }),

  /** Say a thread is finished, or that it is not. */
  closeConversation: (
    conversationId: string,
    closed: boolean,
  ): Promise<{ ok: true; closed: boolean }> =>
    api(`/api/russell/conversations/${encodeURIComponent(conversationId)}/closed`, {
      method: 'PATCH',
      body: JSON.stringify({ closed }),
    }),

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

  sites: (projectId: string): Promise<{ sites: SiteStatus[] }> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/sites`),

  /**
   * Connect a site, or rotate what it holds. The same call for both, because
   * they are the same operation: the identity is reused, the permissions are
   * rewritten from the server's own constant, and exactly one credential is
   * live afterwards.
   *
   * The secret is in this response and in no other. Nothing stores it.
   */
  connectSite: (projectId: string, slug: string): Promise<ConnectSiteResult> =>
    api(
      `/api/russell/projects/${encodeURIComponent(projectId)}/sites/` +
        `${encodeURIComponent(slug)}/connect`,
      { method: 'POST' },
    ),

  disconnectSite: (projectId: string, slug: string, reason: string | null): Promise<SiteStatus> =>
    api(
      `/api/russell/projects/${encodeURIComponent(projectId)}/sites/` +
        `${encodeURIComponent(slug)}/disconnect`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

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

  /**
   * Disagree with Russell about one idea.
   *
   * A reason is required by the server and is not optional here either: a
   * ranking with no stated reason is one nobody can argue with later, which is
   * the same rule Russell's own judgments are held to.
   */
  overrideJudgment: (
    candidateId: string,
    body: { priority: CandidatePriority; state: CandidateState; reason: string },
  ): Promise<{ candidate: RussellCandidate }> =>
    api(`/api/russell/candidates/${encodeURIComponent(candidateId)}/judgment`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** What Russell may do on its own here, in the words a person decides in. */
  authority: (projectId: string): Promise<AuthorityView> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/authority`),

  /**
   * Grant it.
   *
   * The limits go as numbers, not strings: the server refuses anything that is
   * not a whole number in range rather than coercing it, so a form that sent
   * "2" would be told off for something it did not do wrong.
   */
  grantAuthority: (
    projectId: string,
    body: {
      name: string;
      /**
       * The one number a person sets. Missions, fragments and probes are
       * counted rather than rationed, so there is nothing else to send: the
       * server names its own policy and refuses a body field it did not ask
       * for the same way it always has.
       */
      maxConcurrent: number;
      expiresAt: string | null;
    },
  ): Promise<AuthorityView> =>
    api(`/api/russell/projects/${encodeURIComponent(projectId)}/authority`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Withdraw it. A reason is required, and is kept. */
  revokeAuthority: (
    projectId: string,
    goalId: string,
    reason: string,
  ): Promise<AuthorityView> =>
    api(
      `/api/russell/projects/${encodeURIComponent(projectId)}/authority/` +
        `${encodeURIComponent(goalId)}/revoke`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  /** Pull an idea back out of the one it was folded into. */
  splitIdea: (candidateId: string, reason: string): Promise<{ candidate: RussellCandidate }> =>
    api(`/api/russell/candidates/${encodeURIComponent(candidateId)}/split`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  dealDispatch: (): Promise<ConnectedSystemView> => api('/api/russell/deal-dispatch'),
};
