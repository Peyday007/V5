/**
 * People & Capacity over HTTP.
 *
 * Thin by design, like `cashApi`: every decision, every sentence and every
 * count is the server's, and this file's whole job is to name the routes and
 * import the shapes. The server's own types are imported rather than restated —
 * a client holding its own copy of a contract is a second contract, and the
 * copy is the one that drifts. They are type-only imports, so nothing of the
 * server reaches the bundle.
 */
import { api } from './api.ts';
import type { CapacityReading, SurfaceReading } from '../../../server/services/fleet/capacity.ts';
import type { ConnectionStep, ConnectionView } from '../../../server/services/capacity/connection.ts';
import type { MemberState } from '../../../server/services/identity/people.ts';

export type { CapacityReading, SurfaceReading, ConnectionStep, ConnectionView, MemberState };

export interface PersonRow {
  userId: string;
  displayName: string;
  state: MemberState;
  isYou: boolean;
  isBrainAdmin: boolean;
  /** Administrator only, and only while a link is outstanding. */
  linkExpiresAt?: string;
}

export interface PeopleAndCapacity {
  you: { userId: string; isBrainAdmin: boolean };
  people: {
    rows: PersonRow[];
    joined: number;
    invited: number;
    /** Administrator only. What the real-member reading deliberately left out. */
    excluded?: { systemIdentities: number; disabledAccounts: number };
  };
  capacity: CapacityReading;
  me: ConnectionView;
  contract: { mcpUrl: string; bootstrapRepository: string };
}

export interface ConnectionSummary {
  userId: string;
  displayName: string;
  state: ConnectionView['state'];
  /** The name of a deployment variable. Never a value. */
  secretName: string;
  triggerRef: string | null;
  routineId: string | null;
  failureReason: string | null;
  updatedAt: string;
}

const p = (value: string): string => encodeURIComponent(value);

export const PeopleApi = {
  /** The whole page in one read. Reading it registers, fires and spends nothing. */
  page: (): Promise<PeopleAndCapacity> => api('/api/people'),

  /** Your own connection, for the wizard's re-reads. Yours by principal. */
  myConnection: (): Promise<ConnectionView> => api('/api/people/me/claude'),

  /** Idempotent by the trigger: submitting the same id twice is one surface. */
  submitTrigger: (triggerRef: string): Promise<ConnectionView> =>
    api('/api/people/me/claude/trigger', {
      method: 'POST',
      body: JSON.stringify({ triggerRef }),
    }),

  /** One bounded self-test. Pressing it twice makes one bin. */
  sendProbe: (): Promise<ConnectionView> =>
    api('/api/people/me/claude/probe', { method: 'POST', body: '{}' }),

  /** A Brain administrator's: mints the worker identity and its one-time link. */
  issueConnectorInvitation: (userId: string): Promise<ConnectionView> =>
    api(`/api/people/${p(userId)}/claude/invitation`, { method: 'POST', body: '{}' }),

  /** A Brain administrator's: every connection, for the one outstanding action. */
  connections: (): Promise<{ connections: ConnectionSummary[] }> =>
    api('/api/people/connections'),
};
