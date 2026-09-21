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
import type { ContributedCapacity } from '../../../server/services/capacity/contribution.ts';
import type {
  ConnectionCheck,
  ConnectionControl,
  ConnectionIdentity,
  ConnectionStep,
  ConnectionView,
  TroubleshootingEntry,
} from '../../../server/services/capacity/connection.ts';
/*
 * Both of these are imported rather than restated, and one of them was not.
 *
 * `SignsInWith` was a second copy of the server's union, written out here as a
 * literal — so when the server gained `PIN` the client went on compiling
 * against three values, and every screen reading it was type-checked against
 * an enum that had drifted. `MemberState` gaining a value was a compile error
 * in the same commit, because it is imported; that difference is the whole
 * argument. A duplicated enum is two readers of one fact, and the copy nobody
 * looks at is the one that stops being true.
 */
import type { MemberState, SignsInWith } from '../../../server/services/identity/people.ts';

export type {
  CapacityReading,
  ContributedCapacity,
  SurfaceReading,
  ConnectionCheck,
  ConnectionControl,
  ConnectionIdentity,
  ConnectionStep,
  ConnectionView,
  TroubleshootingEntry,
  MemberState,
  SignsInWith,
};

export interface PersonRow {
  userId: string;
  displayName: string;
  state: MemberState;
  /**
   * Which credential lets them in.
   *
   * Sent because `READY` alone does not say whether the enrollment journey
   * applies: the administrator account signs in with a password and has no
   * device, so offering it a connector link is right and offering it an
   * enrollment link is not.
   */
  signsInWith: SignsInWith;
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
  /** Which members' connections are usable capacity, and why not when they are not. */
  contributed: ContributedCapacity;
  me: ConnectionView;
  /**
   * The foundation matrix. Administrator only, and **absent** rather than
   * emptied for anybody else — so there is nothing for a client to forget to
   * hide, which is the only form of that distinction a missing `.filter()`
   * cannot undo.
   */
  foundation?: FoundationReading;
  contract: { mcpUrl: string; bootstrapRepository: string };
}

/**
 * Mirrors `server/services/identity/foundation.ts`.
 *
 * Every sentence in it is composed by the server; nothing here derives a
 * verdict, chooses a remedy or decides who a finding belongs to. The client's
 * whole job is to print what it is handed, which is what keeps one account's
 * reading from ever being described differently to two readers.
 */
export type FoundationVerdict = 'PASS' | 'BLOCKED' | 'NOT_APPLICABLE';

export interface FoundationFinding {
  dimension: string;
  verdict: FoundationVerdict;
  because: string;
  nextAction: string | null;
  owner: string;
}

export interface AccountFoundation {
  userId: string;
  displayName: string;
  isBrainAdmin: boolean;
  findings: FoundationFinding[];
  verdict: 'PASS' | 'BLOCKED';
}

export interface UnattributedSurface {
  routineId: string;
  routineName: string;
  workerId: string;
  workerLabel: string | null;
  enabled: boolean;
  because: string;
  nextAction: string;
}

export interface FoundationReading {
  accounts: AccountFoundation[];
  passing: number;
  blocked: number;
  unattributed: UnattributedSurface[];
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
  /** When the member asked for their link, and when one was issued. */
  invitationRequestedAt: string | null;
  invitationIssuedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
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

  /**
   * Ask for your own one-time connector link.
   *
   * Yours by principal, and idempotent by the timestamp it writes: asking twice
   * asks once. It creates nothing and grants nothing — it puts you in front of
   * a Brain administrator, who is the one who may mint a worker identity.
   */
  requestInvitation: (): Promise<ConnectionView> =>
    api('/api/people/me/claude/invitation-request', { method: 'POST', body: '{}' }),

  /**
   * Check the connection against the rows, rather than against a claim.
   *
   * Reads the worker, its membership, the tokens minted against it, the
   * registered surface, the deployment variable's presence and the four-row
   * proof chain. Fires nothing and spends nothing.
   */
  verify: (): Promise<ConnectionView> =>
    api('/api/people/me/claude/verify', { method: 'POST', body: '{}' }),

  /** Take your own connection back. Destroys nothing; reconnecting resumes it. */
  revoke: (reason: string): Promise<ConnectionView> =>
    api('/api/people/me/claude/revoke', { method: 'POST', body: JSON.stringify({ reason }) }),

  /** Put your own revoked connection back into the journey. */
  reconnect: (): Promise<ConnectionView> =>
    api('/api/people/me/claude/reconnect', { method: 'POST', body: '{}' }),

  /** A Brain administrator's: mints the worker identity and its one-time link. */
  issueConnectorInvitation: (userId: string): Promise<ConnectionView> =>
    api(`/api/people/${p(userId)}/claude/invitation`, { method: 'POST', body: '{}' }),

  /** A Brain administrator's: every connection, for the one outstanding action. */
  connections: (): Promise<{ connections: ConnectionSummary[] }> =>
    api('/api/people/connections'),
};
