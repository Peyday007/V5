/**
 * A signed-in member reconnecting their own connector, without an invitation.
 *
 * Production, 2026-10-03 08:37Z: Airyn pressed Reconnect in Claude. Claude
 * registered a fresh OAuth client and opened `/oauth/authorize` in a browser
 * already signed in to Brain as him — and Brain rendered "Sign in to connect a
 * worker", because a member could approve only on an unspent invitation and
 * both of his had been spent connecting the first time. Nothing could proceed
 * until an administrator issued a third link. Every reconnect of every member
 * would end the same way, which made the invitation a recurring chore rather
 * than the one-time authorization it was meant to be.
 *
 * The authorization a member needs to reconnect already exists: an
 * administrator approved *this member* for *this connector* when its first
 * client was consented on a member-bound invitation, or recorded the member's
 * own Claude connection against that account and worker. A reconnect restores
 * that grant on a new OAuth client; it does not widen it. So this module
 * answers one question, from rows Brain wrote, and refuses whenever it cannot
 * answer it exactly:
 *
 *   Is there exactly one logical connector, at the endpoint this request names,
 *   that belongs to this signed-in member and to nobody else, whose worker is
 *   live, whose consent was not explicitly withdrawn, and whose earlier grants
 *   already covered every scope this request asks for?
 *
 * Ownership is proven by either of two rows, never by a name or a worker id:
 *
 *   CONSENT     an `OAUTH_AUTHORIZE SUCCESS` approved on an invitation bound to
 *               this member (or an earlier member reconnect by them), for a
 *               client attached to the connector.
 *   CONNECTION  the member's own `capacity_connections` row names the
 *               connector's account and worker, and is not REVOKED.
 *
 * A worker id is never evidence: Airyn, Caleb and the owner all authenticate
 * as worker-10, and "somebody who uses worker-10" is precisely the claim that
 * must not let one of them restore another's connector. Zero candidates, two
 * candidates, a connector somebody else also owns, an endpoint the request does
 * not name, a revoked consent or a widened scope are each refused by name, and
 * the caller falls back to a bound invitation or an operator. Nothing here
 * writes; the approval route does that after asking again.
 */
import { getDb } from '../../db/database.ts';
import {
  clientsOfConnector,
  connectorClient,
  endpointOf,
  getConnector,
  listConnectors,
  type Connector,
} from '../../repos/connectors.ts';
import { getWorker } from '../../repos/identity.ts';
import type { Worker } from '../../domain/types.ts';
import { connectorHealth } from './connectorHealth.ts';

export type MemberReconnectRefusal =
  | 'ENDPOINT_UNSPECIFIED'
  | 'NO_CONNECTOR_FOR_MEMBER'
  | 'AMBIGUOUS_CONNECTORS'
  | 'CONNECTOR_SHARED_WITH_ANOTHER_MEMBER'
  | 'CLIENT_ATTACHED_ELSEWHERE'
  | 'WORKER_UNAVAILABLE'
  | 'CONSENT_REVOKED'
  | 'SCOPE_NOT_PREVIOUSLY_GRANTED';

export type MemberReconnect =
  | { ok: true; connector: Connector; worker: Worker; basis: string[] }
  | { ok: false; reason: MemberReconnectRefusal; connectorIds: string[] };

/** Why each refusal happened, for the screen a signed-in member is shown. */
export const MEMBER_RECONNECT_SENTENCE: Record<MemberReconnectRefusal, string> = {
  ENDPOINT_UNSPECIFIED:
    'The connection request does not say which Brain endpoint it is for, so Brain cannot tell which of your connectors it would restore.',
  NO_CONNECTOR_FOR_MEMBER:
    'Brain has no record of a connector of yours at this endpoint, so there is nothing to reconnect yet.',
  AMBIGUOUS_CONNECTORS:
    'You have more than one connector at this endpoint, and Brain will not choose between them for you.',
  CONNECTOR_SHARED_WITH_ANOTHER_MEMBER:
    'Brain’s records tie this connector to more than one person, so it cannot be restored by either of you alone.',
  CLIENT_ATTACHED_ELSEWHERE:
    'This Claude connection is already recorded as a different connector, so it cannot be attached to yours.',
  WORKER_UNAVAILABLE: 'The worker your connector acts as is disabled or no longer exists.',
  CONSENT_REVOKED:
    'Your connector’s authorization was explicitly withdrawn, and a withdrawal is not undone by reconnecting.',
  SCOPE_NOT_PREVIOUSLY_GRANTED:
    'This request asks for more access than your connector was ever granted.',
};

function scopeSet(scope: string | null | undefined): Set<string> {
  return new Set((scope ?? '').split(/\s+/).filter((one) => one.length > 0));
}

/**
 * Every connector with the members whose ownership a row proves, and why.
 *
 * Computed whole rather than for one member, because "belongs to this member"
 * and "belongs to nobody else" are one question: a connector two people have a
 * claim to is restored by neither.
 */
export async function connectorOwners(): Promise<Map<string, Map<string, string[]>>> {
  const owners = new Map<string, Map<string, string[]>>();
  const add = (connectorId: string, userId: string, why: string): void => {
    const byUser = owners.get(connectorId) ?? new Map<string, string[]>();
    const reasons = byUser.get(userId) ?? [];
    if (!reasons.includes(why)) reasons.push(why);
    byUser.set(userId, reasons);
    owners.set(connectorId, byUser);
  };

  // CONSENT: an approval that names a member, for a client that is a connector.
  const consents = await getDb().all<{ actor_id: string | null; metadata: string | null }>(
    `SELECT actor_id, metadata FROM identity_events WHERE action = 'OAUTH_AUTHORIZE' AND result = 'SUCCESS'`,
  );
  for (const consent of consents) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(consent.metadata ?? '{}') as Record<string, unknown>;
    } catch {
      continue;
    }
    const clientId = typeof meta['clientId'] === 'string' ? meta['clientId'] : null;
    if (!clientId) continue;
    const attached = await connectorClient(clientId);
    if (!attached) continue;
    if (meta['via'] === 'INVITATION' && typeof meta['invitationId'] === 'string') {
      const invitation = await getDb().get<{ intended_user_id: string | null; worker_id: string }>(
        'SELECT intended_user_id, worker_id FROM worker_invitations WHERE id = ?',
        [meta['invitationId']],
      );
      if (invitation?.intended_user_id) {
        add(attached.connectorId, invitation.intended_user_id, `consent on invitation ${meta['invitationId'] as string}`);
      }
    } else if (meta['via'] === 'MEMBER_RECONNECT' && consent.actor_id) {
      add(attached.connectorId, consent.actor_id, `earlier member reconnect of client ${clientId}`);
    }
  }

  // CONNECTION: the member's own Claude connection names the account and worker.
  const connections = await getDb().all<{ id: string; user_id: string; account_id: string; worker_id: string }>(
    `SELECT id, user_id, account_id, worker_id FROM capacity_connections
      WHERE account_id IS NOT NULL AND worker_id IS NOT NULL AND state <> 'REVOKED'`,
  );
  if (connections.length > 0) {
    const connectors = await listConnectors();
    for (const connection of connections) {
      for (const connector of connectors) {
        if (connector.accountId === connection.account_id && connector.workerId === connection.worker_id) {
          add(connector.id, connection.user_id, `capacity connection ${connection.id}`);
        }
      }
    }
  }
  return owners;
}

/**
 * The one connector this signed-in member may restore with this request, or the
 * reason there is not exactly one. Read-only; the approval asks again.
 */
export async function resolveMemberReconnect(input: {
  userId: string;
  clientId: string;
  resource: string | null;
  scope: string | null;
}): Promise<MemberReconnect> {
  const endpoint = endpointOf(input.resource);
  if (endpoint === 'UNSPECIFIED') return { ok: false, reason: 'ENDPOINT_UNSPECIFIED', connectorIds: [] };

  const owners = await connectorOwners();
  const mine: { connector: Connector; basis: string[]; others: number }[] = [];
  for (const [connectorId, byUser] of owners) {
    const basis = byUser.get(input.userId);
    if (!basis) continue;
    const connector = await getConnector(connectorId);
    if (!connector || connector.resource !== endpoint) continue;
    mine.push({ connector, basis, others: byUser.size - 1 });
  }
  if (mine.length === 0) return { ok: false, reason: 'NO_CONNECTOR_FOR_MEMBER', connectorIds: [] };
  if (mine.length > 1) {
    return { ok: false, reason: 'AMBIGUOUS_CONNECTORS', connectorIds: mine.map((one) => one.connector.id) };
  }
  const [{ connector, basis, others }] = mine as [(typeof mine)[number]];
  const ids = [connector.id];
  if (others > 0) return { ok: false, reason: 'CONNECTOR_SHARED_WITH_ANOTHER_MEMBER', connectorIds: ids };

  // A client already recorded as a connector is that connector for ever.
  const attached = await connectorClient(input.clientId);
  if (attached && attached.connectorId !== connector.id) {
    return { ok: false, reason: 'CLIENT_ATTACHED_ELSEWHERE', connectorIds: ids };
  }

  const worker = connector.workerId ? await getWorker(connector.workerId) : null;
  if (!worker || worker.disabled) return { ok: false, reason: 'WORKER_UNAVAILABLE', connectorIds: ids };

  const health = await connectorHealth(connector.id);
  // An administrator withdrawing consent or disabling the clients is a decision
  // a reconnect must not reverse.
  if (health?.reason === 'CONSENT_REVOKED' || health?.reason === 'CLIENT_DISABLED') {
    return { ok: false, reason: 'CONSENT_REVOKED', connectorIds: ids };
  }
  if (health?.state === 'DISABLED') return { ok: false, reason: 'WORKER_UNAVAILABLE', connectorIds: ids };

  // Never wider than what this connector was already granted.
  const clients = (await clientsOfConnector(connector.id)).map((one) => one.clientId);
  const granted = new Set<string>();
  let anyGrant = false;
  if (clients.length > 0) {
    const rows = await getDb().all<{ scope: string | null }>(
      `SELECT DISTINCT scope FROM oauth_tokens WHERE kind = 'REFRESH' AND client_id IN (${clients.map(() => '?').join(', ')})`,
      clients,
    );
    for (const row of rows) {
      anyGrant = true;
      for (const one of scopeSet(row.scope)) granted.add(one);
    }
  }
  if (!anyGrant) return { ok: false, reason: 'SCOPE_NOT_PREVIOUSLY_GRANTED', connectorIds: ids };
  for (const one of scopeSet(input.scope)) {
    if (!granted.has(one)) return { ok: false, reason: 'SCOPE_NOT_PREVIOUSLY_GRANTED', connectorIds: ids };
  }
  return { ok: true, connector, worker, basis };
}
