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
 * Ownership is proven by one kind of row, never by a name or a worker id: a
 * `BOUND_INVITATION` attachment, which records the invitation whose consent
 * attached the client — an invitation on which an administrator named both this
 * member and this connector.
 *
 * Deliberately not evidence, and why (independent review of the first version):
 *
 *   - a member's own `capacity_connections` row. Its account is found by a
 *     normalized display name (`member-<slug>`), and two names that differ only
 *     by an accent fold to one slug — so a row a member can produce themselves
 *     would name somebody else's account.
 *   - an earlier member reconnect. Counting it would make ownership renew
 *     itself for ever, so giving a connection back could never end it.
 *   - a consent matched to a client id. A client id is public, so consenting
 *     on someone else's client must not count as owning their connector.
 *   - an `OBSERVED_ARRIVAL` or `INVITATION_MEMBER` attachment. Both are
 *     inferred — the second's account comes from the same normalized name.
 *
 * A member who gave the connection back (a REVOKED capacity connection for the
 * connector's account and worker, with no live one beside it) has no claim. And
 * a connector whose tokens were explicitly withdrawn after its last grant, or
 * whose clients were disabled, is refused — read from the token rows, not from
 * the health verdict, because a refused refresh after a revocation turns the
 * verdict into `CLIENT_HOLDS_REFUSED_CREDENTIAL` and would hide the withdrawal.
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
  type Connector,
} from '../../repos/connectors.ts';
import { getWorker } from '../../repos/identity.ts';
import { getClientByClientId } from '../../repos/oauth.ts';
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
  | 'SCOPE_NOT_PREVIOUSLY_GRANTED'
  | 'PUBLIC_CLIENT'
  | 'REDIRECT_NOT_CLAUDE';

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
  REDIRECT_NOT_CLAUDE:
    'This connection sends its authorization somewhere other than Claude, so it cannot restore your connector. Reconnect from Claude itself, or ask an administrator for a reconnect link.',
  PUBLIC_CLIENT:
    'This connection has no client secret, so Brain cannot tell that the code will be redeemed by the client that asked for it.',
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

  /*
   * Read from the attachment row itself: a BOUND_INVITATION client records the
   * invitation whose consent attached it, and that invitation names both the
   * member and this connector. Matching a consent to whatever a client id is
   * attached to *now* would let anyone holding an invitation for the same
   * worker consent on somebody else's public client id and appear to own it.
   */
  const rows = await getDb().all<{ connector_id: string; intended_user_id: string; invitation_id: string }>(
    `SELECT cc.connector_id AS connector_id, i.intended_user_id AS intended_user_id, i.id AS invitation_id
       FROM connector_clients cc
       JOIN worker_invitations i ON i.id = cc.invitation_id
      WHERE cc.source = 'BOUND_INVITATION'
        AND i.intended_user_id IS NOT NULL
        AND i.connector_id = cc.connector_id`,
  );
  for (const row of rows) add(row.connector_id, row.intended_user_id, `consent on invitation ${row.invitation_id}`);

  // A member who gave the connection back keeps no claim to it.
  for (const [connectorId, byUser] of owners) {
    const connector = await getConnector(connectorId);
    if (!connector) continue;
    for (const userId of [...byUser.keys()]) {
      const rows = await getDb().all<{ state: string }>(
        'SELECT state FROM capacity_connections WHERE user_id = ? AND account_id = ? AND worker_id = ?',
        [userId, connector.accountId, connector.workerId],
      );
      if (rows.length > 0 && rows.every((row) => row.state === 'REVOKED')) byUser.delete(userId);
    }
    if (byUser.size === 0) owners.delete(connectorId);
  }
  return owners;
}

/**
 * Was this connector's authority withdrawn since it was last granted? Read from
 * the token and client rows directly: an explicit revocation newer than the
 * newest grant, or any of its clients disabled.
 */
async function withdrawnSinceLastGrant(clientIds: string[]): Promise<boolean> {
  if (clientIds.length === 0) return false;
  const list = clientIds.map(() => '?').join(', ');
  const disabled = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM oauth_clients WHERE client_id IN (${list}) AND disabled_at IS NOT NULL`,
    clientIds,
  );
  if ((disabled?.n ?? 0) > 0) return true;
  const facts = await getDb().get<{ last_grant: string | null; last_withdrawal: string | null }>(
    `SELECT
       (SELECT MAX(created_at) FROM oauth_tokens
         WHERE client_id IN (${list}) AND kind = 'REFRESH' AND parent_token_id IS NULL) AS last_grant,
       (SELECT MAX(revoked_at) FROM oauth_tokens
         WHERE client_id IN (${list}) AND revoked_reason = 'EXPLICIT') AS last_withdrawal`,
    [...clientIds, ...clientIds],
  );
  return Boolean(facts?.last_withdrawal && (!facts.last_grant || facts.last_withdrawal >= facts.last_grant));
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

  /*
   * Only a confidential client. Attaching at redemption binds the client to
   * whoever holds its secret; a public client has none, so a member who learned
   * somebody else's freshly registered public client id could approve it,
   * read the code off the callback and attach it to their own connector.
   * Claude's connector registers as client_secret_post.
   */
  const client = await getClientByClientId(input.clientId);
  if (!client || client.tokenAuthMethod === 'none') {
    return { ok: false, reason: 'PUBLIC_CLIENT', connectorIds: [] };
  }
  /*
   * Only a client whose every redirect is Claude's own callback. Registration is
   * unauthenticated and accepts any https redirect, so a confidential client is
   * no proof of who registered it: an attacker holds its secret, sends a
   * signed-in member the authorize link, and one Approve would hand the attacker
   * worker tokens and attach their client to the member's connector. The
   * invitation path is untouched; this is the path with no administrator in it.
   */
  if (!client.redirectUris.length || !client.redirectUris.every(isClaudeCallback)) {
    return { ok: false, reason: 'REDIRECT_NOT_CLAUDE', connectorIds: [] };
  }

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
  // A withdrawal or a disabled client is a decision a reconnect must not reverse.
  const clients = (await clientsOfConnector(connector.id)).map((one) => one.clientId);
  if (
    health?.reason === 'CONSENT_REVOKED' ||
    health?.reason === 'CLIENT_DISABLED' ||
    (await withdrawnSinceLastGrant(clients))
  ) {
    return { ok: false, reason: 'CONSENT_REVOKED', connectorIds: ids };
  }
  if (health?.state === 'DISABLED') return { ok: false, reason: 'WORKER_UNAVAILABLE', connectorIds: ids };

  /*
   * Never wider than what this connector was already granted. Today Brain
   * advertises no OAuth scopes and a worker's reach is its memberships, so this
   * is a guard for the day scopes mean something rather than the boundary.
   */
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

/** Claude's connector callback: https, a Claude host, the MCP auth callback path, nothing else. */
export const CLAUDE_CALLBACK_HOSTS = new Set(['claude.ai', 'claude.com']);
function isClaudeCallback(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === 'https:' &&
      CLAUDE_CALLBACK_HOSTS.has(url.hostname) &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/api/mcp/auth_callback' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}
