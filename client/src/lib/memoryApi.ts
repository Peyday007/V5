/**
 * Historical memory, over HTTP. Shapes are the server's own, imported as types.
 */
import { api } from './api.ts';
import type { CoverageReport } from '../../../server/services/memory/coverage.ts';
import type { ArchiveView } from '../../../server/services/memory/ingest.ts';
import type {
  ConversationRecord,
  DiscoveryView,
  HubView,
  IdeaDetail,
  IdeaSummary,
  MemorySearchHit,
  TopicHistory,
  TopicNode,
} from '../../../server/services/memory/views.ts';
import type { CommitmentReading, MovieSchoolFoundation } from '../../../server/services/memory/hubs.ts';
import type { DecisionResult, MemoryDecision } from '../../../server/services/memory/rediscover.ts';
import type { MemoryPassReport } from '../../../server/services/memory/pipeline.ts';

export type {
  ArchiveView,
  CommitmentReading,
  ConversationRecord,
  CoverageReport,
  DecisionResult,
  DiscoveryView,
  HubView,
  IdeaDetail,
  IdeaSummary,
  MemoryDecision,
  MemorySearchHit,
  MovieSchoolFoundation,
  TopicHistory,
  TopicNode,
};

const post = <T>(url: string, body: unknown = {}): Promise<T> => api<T>(url, { method: 'POST', body: JSON.stringify(body) });
const id = encodeURIComponent;

export const MemoryApi = {
  post,
  overview: (): Promise<{ coverage: CoverageReport; archives: ArchiveView[]; discoveries: number }> => api('/api/memory/overview'),
  discoveries: (state: 'OPEN' | 'DECIDED' = 'OPEN'): Promise<{ discoveries: DiscoveryView[] }> =>
    api(`/api/memory/discoveries?state=${state}`),
  decide: (
    ideaId: string,
    body: { decision: MemoryDecision; feedback?: string; projectId?: string; wantedNow?: string; branch?: boolean },
  ): Promise<{ result: DecisionResult }> => post(`/api/memory/ideas/${id(ideaId)}/decide`, body),
  ideas: (filter: { state?: string; kind?: string; q?: string } = {}): Promise<{ ideas: IdeaSummary[] }> => {
    const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => !!v) as [string, string][]);
    return api(`/api/memory/ideas?${params.toString()}`);
  },
  idea: (ideaId: string): Promise<IdeaDetail> => api(`/api/memory/ideas/${id(ideaId)}`),
  conversation: (conversationId: string, branches: boolean): Promise<ConversationRecord> =>
    api(`/api/memory/conversations/${id(conversationId)}${branches ? '?branches=1' : ''}`),
  topics: (): Promise<{ topics: TopicNode[] }> => api('/api/memory/topics'),
  topic: (topicId: string, role: 'USER' | 'ALL'): Promise<TopicHistory> => api(`/api/memory/topics/${id(topicId)}?role=${role}`),
  search: (q: string, opts: { from?: string; to?: string; role?: string; order?: string } = {}): Promise<{ hits: MemorySearchHit[]; truncated: boolean }> => {
    const params = new URLSearchParams({ q, ...(Object.fromEntries(Object.entries(opts).filter(([, v]) => !!v)) as Record<string, string>) });
    return api(`/api/memory/search?${params.toString()}`);
  },
  hubs: (): Promise<{ hubs: HubView[] }> => api('/api/memory/hubs'),
  decideHub: (hubId: string, decision: 'ACCEPT' | 'DECLINE'): Promise<{ state: string; projectId: string | null }> =>
    post(`/api/memory/hubs/${id(hubId)}/decide`, { decision }),
  commitments: (): Promise<{ commitments: CommitmentReading[] }> => api('/api/memory/commitments'),
  movieSchool: (): Promise<{ foundation: MovieSchoolFoundation }> => api('/api/memory/movie-school'),
  addPractice: (body: { kind: 'OBJECTIVE' | 'EXERCISE' | 'ASSESSMENT'; title: string; body?: string }): Promise<{ id: string }> =>
    post('/api/memory/movie-school/practice', body),
  circumstance: (kind: string, statement: string): Promise<{ id: string }> => post('/api/memory/circumstances', { kind, statement }),
  process: (): Promise<{ report: MemoryPassReport }> => post('/api/memory/process'),
};
