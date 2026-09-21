/**
 * The work register and the conversation bridge, over HTTP.
 *
 * Thin by design, like `peopleApi` and `cashApi`: every sentence, every state
 * and every count in these payloads is the server's, and this file's whole job
 * is to name the routes and import the shapes. The server's own types are
 * imported rather than restated — a client holding its own copy of a contract
 * is a second contract, and the copy is the one that drifts. Type-only, so
 * nothing of the server reaches the bundle.
 */
import { api } from './api.ts';
import type { RegisterView, WorkstreamView } from '../../../server/services/register/view.ts';
import type { UnfiledItem } from '../../../server/services/register/unfiled.ts';
import type { LinkReading } from '../../../server/services/register/resolve.ts';
import type {
  BridgeConversation,
  BridgeCredential,
  LinkKind,
  LinkRelation,
  Workstream,
  WorkstreamEvent,
  WorkstreamLink,
  WorkstreamPurpose,
} from '../../../server/domain/register.ts';
import type { BridgeStatus } from '../../../server/services/bridge/status.ts';

export type {
  BridgeConversation,
  BridgeCredential,
  BridgeStatus,
  LinkKind,
  LinkReading,
  LinkRelation,
  RegisterView,
  UnfiledItem,
  Workstream,
  WorkstreamEvent,
  WorkstreamLink,
  WorkstreamPurpose,
  WorkstreamView,
};

export interface NewLink {
  kind: LinkKind;
  ref: string;
  relation: LinkRelation;
  label?: string | null;
  detail?: Record<string, unknown>;
}

export const RegisterApi = {
  /** The whole view, in one read. Nothing in it is derived in the client. */
  view: (options?: { archived?: boolean }): Promise<RegisterView> =>
    api(`/api/register${options?.archived ? '?archived=true' : ''}`),

  workstream: (
    id: string,
  ): Promise<{ workstream: WorkstreamView; corrections: WorkstreamLink[]; events: WorkstreamEvent[] }> =>
    api(`/api/register/workstreams/${encodeURIComponent(id)}`),

  /**
   * Open one, optionally with the links that file something already derived as
   * unaccounted-for. One call, because filing in two is a filing somebody
   * abandons halfway.
   */
  open: (input: {
    projectId?: string | null;
    title: string;
    intent: string;
    purpose: WorkstreamPurpose;
    links?: NewLink[];
  }): Promise<{ workstream: Workstream; links: WorkstreamLink[] }> =>
    api('/api/register/workstreams', { method: 'POST', body: JSON.stringify(input) }),

  link: (workstreamId: string, link: NewLink): Promise<{ link: WorkstreamLink }> =>
    api(`/api/register/workstreams/${encodeURIComponent(workstreamId)}/links`, {
      method: 'POST',
      body: JSON.stringify(link),
    }),

  /** A correction, never a delete: the row stays with its reason. */
  supersede: (workstreamId: string, linkId: string, reason: string): Promise<{ superseded: boolean }> =>
    api(
      `/api/register/workstreams/${encodeURIComponent(workstreamId)}/links/${encodeURIComponent(linkId)}/supersede`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  archive: (workstreamId: string, reason: string): Promise<{ workstream: Workstream }> =>
    api(`/api/register/workstreams/${encodeURIComponent(workstreamId)}/archive`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
};

export const BridgeApi = {
  credentials: (): Promise<{ credentials: BridgeCredential[] }> => api('/api/bridge/credentials'),

  /**
   * Mint one. The secret comes back exactly once and is recoverable afterwards
   * by nobody, so the screen that calls this has to show it before it reloads
   * anything — §34 records what a reload that unmounted the card cost.
   */
  mint: (label: string): Promise<{ credential: BridgeCredential; secret: string }> =>
    api('/api/bridge/credentials', { method: 'POST', body: JSON.stringify({ label }) }),

  revoke: (credentialId: string, reason: string): Promise<{ revoked: boolean }> =>
    api(`/api/bridge/credentials/${encodeURIComponent(credentialId)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  conversations: (): Promise<{ conversations: BridgeConversation[] }> =>
    api('/api/bridge/conversations'),

  status: (conversationId: string): Promise<BridgeStatus> =>
    api(`/api/bridge/conversations/${encodeURIComponent(conversationId)}/status`),

  /** Paste or upload an export. `format` says which reading actually happened. */
  import: (input: { body: string; title?: string }): Promise<{
    conversationId: string;
    format: string;
    notes: string[];
    receipt: { accepted: number; duplicates: number; missing: number[] };
  }> => api('/api/bridge/conversations/import', { method: 'POST', body: JSON.stringify(input) }),
};
