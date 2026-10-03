/**
 * Connector health: the one answer to "can this connector authenticate now, and
 * if not, does it need a person?"
 *
 * Before this, every reader inferred it differently. Fleet showed a Routine's
 * state column, the dispatcher saw only the trigger token, the no-show pass saw
 * only that a session never arrived, and a worker identity shared by several
 * Claude accounts made "worker-10 authenticated" read as healthy for all of
 * them. This projection is derived on every read from rows Brain wrote — the
 * connector's OAuth tokens, the refusals the token endpoint recorded, and the
 * fires that went unanswered — and every consumer reads it rather than its own
 * copy: the router (`surfaceIneligibility`), the no-show pass, the recovery of
 * an auth-caused quarantine, and the operator's `fleet connectors`.
 *
 * Configured is not authenticated, authenticated is not observed, and a past
 * proof is not a present answer: nothing here reads a delivery proof or a
 * routine's state to decide whether the credential works.
 *
 * The states and what each one means for a person:
 *
 *   HEALTHY                 the client holds a credential Brain honours and is using it.
 *   REFRESH_RECOVERABLE     a rotation's answer was not picked up, but the client's
 *                           next retry will be answered with the same successor;
 *                           fires continue (they are the retry) and an unanswered
 *                           one is charged to auth, never to the surface.
 *   HUMAN_REAUTH_REQUIRED   proven unrecoverable without consent — one of the reasons
 *                           below, each read from a row.
 *   DISABLED                the worker the connector authorizes as is disabled.
 *   UNKNOWN                 no OAuth client is attributed to this connector yet, so
 *                           nothing can be said; routing fails open, as it does for
 *                           every other unknown that could only waste a fire.
 */
import { getDb } from '../../db/database.ts';
import { CONCURRENT_REFRESH_LEEWAY_MS } from '../../repos/oauth.ts';
import { clientsOfConnector, getConnector, listConnectors, type Connector } from '../../repos/connectors.ts';
import { getWorker } from '../../repos/identity.ts';

export type ConnectorAuthState =
  | 'HEALTHY'
  | 'REFRESH_RECOVERABLE'
  | 'HUMAN_REAUTH_REQUIRED'
  | 'DISABLED'
  | 'UNKNOWN';

export type ConnectorReason =
  | 'IN_USE'
  | 'IDLE_WITH_LIVE_REFRESH'
  | 'REPLY_NOT_PICKED_UP'
  | 'NOT_ATTRIBUTED'
  | 'WORKER_DISABLED'
  | 'CLIENT_DISABLED'
  | 'NEVER_AUTHORIZED'
  | 'CONSENT_REVOKED'
  | 'CREDENTIALS_EXPIRED'
  | 'CLIENT_HOLDS_REFUSED_CREDENTIAL'
  | 'CLIENT_STOPPED_RETRYING';

/**
 * How many fires may go unanswered against a connector whose last rotation was
 * never picked up before Brain concludes the client stopped retrying.
 *
 * Production, 2026-09-30: the Routine's next session retried an hour later and
 * would have recovered; 2026-10-01: Claude marked the connector as needing
 * authorization and never retried at all. Three activations is the same
 * threshold a real no-show quarantine uses, so a client that has given up costs
 * no more than a dead surface did — and every one of them is charged to auth.
 */
export const AUTH_NO_SHOW_LIMIT = 3;

export interface ConnectorHealth {
  connectorId: string;
  accountId: string;
  resource: string;
  workerId: string | null;
  state: ConnectorAuthState;
  reason: ConnectorReason;
  /** A sentence a person can act on. Names ids and categories, never a credential. */
  detail: string;
  humanActionRequired: boolean;
  currentClientId: string | null;
  clientIds: string[];
  lastRegistrationAt: string | null;
  lastGrantAt: string | null;
  lastRefreshAt: string | null;
  lastRecoveredRefreshAt: string | null;
  lastAccessUseAt: string | null;
  lastRefusal: { at: string; reason: string } | null;
  authNoShowsSinceAnomaly: number;
}

interface TokenFacts {
  last_use: string | null;
  last_grant: string | null;
  last_refresh: string | null;
  live_refresh: number;
}

interface TipRow {
  id: string;
  created_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  parent_token_id: string | null;
  expires_at: string;
}

function inList(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** The health of one connector, read now. */
export async function connectorHealth(connectorId: string, now = Date.now()): Promise<ConnectorHealth | null> {
  const connector = await getConnector(connectorId);
  return connector ? healthOf(connector, now) : null;
}

export async function allConnectorHealth(now = Date.now()): Promise<ConnectorHealth[]> {
  const out: ConnectorHealth[] = [];
  for (const connector of await listConnectors()) out.push(await healthOf(connector, now));
  return out;
}

/**
 * Health by Routine, for the routing snapshot.
 *
 * Read once per tick and cached for a few seconds: the dispatcher ticks every
 * ten seconds on a database that is sometimes slow, and a connector's health
 * does not change faster than a person can reconnect it. The cache is a
 * convenience for the router only — the no-show pass and the operator read go
 * to the rows.
 */
let routingCache: { at: number; byRoutine: Map<string, ConnectorHealth> } | null = null;
const ROUTING_CACHE_MS = 20_000;

export async function connectorHealthByRoutine(now = Date.now()): Promise<Map<string, ConnectorHealth>> {
  if (routingCache && now - routingCache.at < ROUTING_CACHE_MS && now >= routingCache.at) return routingCache.byRoutine;
  const rows = await getDb().all<{ id: string; connector_id: string | null }>(
    'SELECT id, connector_id FROM fleet_routines WHERE connector_id IS NOT NULL',
  );
  const byConnector = new Map<string, ConnectorHealth | null>();
  const byRoutine = new Map<string, ConnectorHealth>();
  for (const row of rows) {
    if (!row.connector_id) continue;
    if (!byConnector.has(row.connector_id)) byConnector.set(row.connector_id, await connectorHealth(row.connector_id, now));
    const health = byConnector.get(row.connector_id);
    if (health) byRoutine.set(row.id, health);
  }
  routingCache = { at: now, byRoutine };
  return byRoutine;
}

/** For tests and for a write that knows the answer just changed. */
export function forgetRoutingHealth(): void {
  routingCache = null;
}

async function healthOf(connector: Connector, now: number): Promise<ConnectorHealth> {
  const at = new Date(now).toISOString();
  const clients = await clientsOfConnector(connector.id);
  const clientIds = clients.map((c) => c.clientId);
  const base = {
    connectorId: connector.id,
    accountId: connector.accountId,
    resource: connector.resource,
    workerId: connector.workerId,
    clientIds,
    currentClientId: null as string | null,
    lastRegistrationAt: null as string | null,
    lastGrantAt: null as string | null,
    lastRefreshAt: null as string | null,
    lastRecoveredRefreshAt: null as string | null,
    lastAccessUseAt: null as string | null,
    lastRefusal: null as { at: string; reason: string } | null,
    authNoShowsSinceAnomaly: 0,
  };
  const verdict = (state: ConnectorAuthState, reason: ConnectorReason, detail: string): ConnectorHealth => ({
    ...base,
    state,
    reason,
    detail,
    humanActionRequired: state === 'HUMAN_REAUTH_REQUIRED',
  });

  if (clientIds.length === 0) {
    return verdict(
      'UNKNOWN',
      'NOT_ATTRIBUTED',
      'No OAuth client is attributed to this connector yet. It becomes known when a session Brain fired at one of its Routines arrives, or when a person binds it.',
    );
  }

  if (connector.workerId) {
    const worker = await getWorker(connector.workerId);
    if (!worker || worker.disabled) {
      return verdict('DISABLED', 'WORKER_DISABLED', 'The worker this connector authorizes as is disabled.');
    }
  }

  const ph = inList(clientIds.length);
  const registered = await getDb().all<{ client_id: string; created_at: string; disabled_at: string | null }>(
    `SELECT client_id, created_at, disabled_at FROM oauth_clients WHERE client_id IN (${ph})`,
    clientIds,
  );
  base.lastRegistrationAt = registered.reduce<string | null>((m, r) => (m && m > r.created_at ? m : r.created_at), null);
  if (registered.length > 0 && registered.every((r) => r.disabled_at !== null)) {
    return verdict('HUMAN_REAUTH_REQUIRED', 'CLIENT_DISABLED', 'Every OAuth client behind this connector is disabled.');
  }

  const facts = (await getDb().get<TokenFacts>(
    `SELECT MAX(last_used_at) AS last_use,
            MAX(CASE WHEN kind = 'REFRESH' AND parent_token_id IS NULL THEN created_at END) AS last_grant,
            MAX(CASE WHEN kind = 'REFRESH' AND parent_token_id IS NOT NULL THEN created_at END) AS last_refresh,
            SUM(CASE WHEN kind = 'REFRESH' AND revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS live_refresh
       FROM oauth_tokens WHERE client_id IN (${ph})`,
    [at, ...clientIds],
  )) ?? { last_use: null, last_grant: null, last_refresh: null, live_refresh: 0 };
  base.lastAccessUseAt = facts.last_use;
  base.lastGrantAt = facts.last_grant;
  base.lastRefreshAt = facts.last_refresh;

  const tip = await getDb().get<TipRow & { client_id: string }>(
    `SELECT id, client_id, created_at, revoked_at, revoked_reason, parent_token_id, expires_at
       FROM oauth_tokens WHERE kind = 'REFRESH' AND client_id IN (${ph})
        -- The tip is the end of the lineage, not merely the newest row: a
        -- rotation committed in the same millisecond as its predecessor ties on
        -- created_at, and an id tiebreak then picks the rotated parent half the
        -- time — which reads a reply nobody picked up as HEALTHY. A token with
        -- a refresh child is never the tip.
        AND NOT EXISTS (SELECT 1 FROM oauth_tokens c
                         WHERE c.parent_token_id = oauth_tokens.id AND c.kind = 'REFRESH')
      -- A superseded leaf loses a millisecond tie to its live sibling.
      ORDER BY created_at DESC, CASE WHEN revoked_reason = 'SUPERSEDED' THEN 1 ELSE 0 END, id DESC LIMIT 1`,
    clientIds,
  );
  if (!tip) {
    return verdict(
      'HUMAN_REAUTH_REQUIRED',
      'NEVER_AUTHORIZED',
      'A client was registered for this connector and consent was never completed, so it holds no credential.',
    );
  }
  base.currentClientId = tip.client_id;

  const lastActivity = [facts.last_use, tip.created_at].filter((x): x is string => !!x).sort().at(-1)!;

  // The newest refusal the token endpoint recorded for this connector's clients.
  if (connector.workerId) {
    // Narrowed by client in SQL: a worker shared by several accounts records
    // every account's refreshes under one target, and the newest fifty of
    // those need not include this connector's at all. The metadata is
    // `toJson` output, so the key is written without spaces.
    const clientLikes = clientIds.map((id) => `%"clientId":"${id}"%`);
    const denials = await getDb().all<{ created_at: string; metadata: string | null }>(
      `SELECT created_at, metadata FROM identity_events
        WHERE action = 'OAUTH_TOKEN' AND result = 'DENIED' AND target_id = ? AND created_at > ?
          AND (${clientIds.map(() => 'metadata LIKE ?').join(' OR ')})
        ORDER BY created_at DESC LIMIT 20`,
      [connector.workerId, new Date(now - 45 * 24 * 3_600_000).toISOString(), ...clientLikes],
    );
    const recovered = await getDb().all<{ created_at: string; metadata: string | null }>(
      `SELECT created_at, metadata FROM identity_events
        WHERE action = 'OAUTH_TOKEN' AND result = 'SUCCESS' AND target_id = ? AND created_at > ?
          AND metadata LIKE '%"recovered"%'
          AND (${clientIds.map(() => 'metadata LIKE ?').join(' OR ')})
        ORDER BY created_at DESC LIMIT 20`,
      [connector.workerId, new Date(now - 45 * 24 * 3_600_000).toISOString(), ...clientLikes],
    );
    const mine = (rows: { created_at: string; metadata: string | null }[]) =>
      rows
        .map((r) => ({ at: r.created_at, meta: safeJson(r.metadata) }))
        .filter((r) => typeof r.meta['clientId'] === 'string' && clientIds.includes(r.meta['clientId'] as string));
    const refusal = mine(denials)[0];
    if (refusal) base.lastRefusal = { at: refusal.at, reason: String(refusal.meta['reason'] ?? 'UNKNOWN') };
    const recovery = mine(recovered).find((r) => r.meta['recovered'] !== undefined);
    if (recovery) base.lastRecoveredRefreshAt = recovery.at;
  }

  /*
   * A REUSED refusal while the grant still holds a live refresh token is not
   * the client being stuck: REUSED means a newer token in that lineage was
   * presented or used, so somebody holds it — and a stale or stolen old token
   * presented while the real client is idle must not take the connector out of
   * routing until a person re-consents. Whether the live chain is actually
   * being picked up is the question the checks below already answer.
   */
  const refusalStrands =
    base.lastRefusal !== null &&
    base.lastRefusal.at > lastActivity &&
    !(base.lastRefusal.reason === 'REUSED' && Number(facts.live_refresh ?? 0) > 0);
  if (base.lastRefusal && refusalStrands) {
    return verdict(
      'HUMAN_REAUTH_REQUIRED',
      'CLIENT_HOLDS_REFUSED_CREDENTIAL',
      `The client last presented a refresh token Brain refused (${base.lastRefusal.reason}, ${base.lastRefusal.at}) and has not authenticated since. ` +
        'Under idempotent rotation a refusal means the token was explicitly withdrawn or provably superseded, so only a new consent restores it.',
    );
  }

  if (Number(facts.live_refresh ?? 0) === 0) {
    return tip.revoked_reason === 'EXPLICIT'
      ? verdict('HUMAN_REAUTH_REQUIRED', 'CONSENT_REVOKED', 'The connector’s authorization was explicitly withdrawn.')
      : verdict(
          'HUMAN_REAUTH_REQUIRED',
          'CREDENTIALS_EXPIRED',
          'Every refresh token behind this connector has expired unused, so it holds nothing Brain can honour.',
        );
  }

  // Was the newest rotation's answer ever picked up?
  const tipUse = await getDb().get<{ used: string | null }>(
    `SELECT MAX(COALESCE(first_used_at, last_used_at)) AS used FROM oauth_tokens WHERE id = ? OR parent_token_id = ?`,
    [tip.id, tip.id],
  );
  const settledBefore = new Date(now - CONCURRENT_REFRESH_LEEWAY_MS).toISOString();
  if (!tipUse?.used && tip.revoked_at === null && tip.created_at < settledBefore) {
    base.authNoShowsSinceAnomaly = await authNoShowsSince(connector.id, tip.created_at);
    if (base.authNoShowsSinceAnomaly >= AUTH_NO_SHOW_LIMIT) {
      return verdict(
        'HUMAN_REAUTH_REQUIRED',
        'CLIENT_STOPPED_RETRYING',
        `The answer to the client’s last refresh (${tip.created_at}) was never picked up, and ${base.authNoShowsSinceAnomaly} sessions Brain fired since never presented a credential. ` +
          'Brain would still answer a retry with the same successor; the client has stopped asking, which only a new consent changes.',
      );
    }
    return verdict(
      'REFRESH_RECOVERABLE',
      'REPLY_NOT_PICKED_UP',
      `The answer to the client’s last refresh (${tip.created_at}) has not been picked up. Its next retry will be answered with the same successor, ` +
        'so fires continue and an unanswered one is charged to auth rather than to the surface.',
    );
  }

  return facts.last_use && facts.last_use >= tip.created_at
    ? verdict('HEALTHY', 'IN_USE', 'The client holds a live credential and is using it.')
    : verdict('HEALTHY', 'IDLE_WITH_LIVE_REFRESH', 'The client holds a live refresh token; its next session refreshes as normal.');
}

async function authNoShowsSince(connectorId: string, since: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bin_events e
      WHERE e.event_type = 'DISPATCH_AUTH_NO_SHOW' AND e.at > ?
        AND e.routine_id IN (SELECT r.id FROM fleet_routines r WHERE r.connector_id = ?)`,
    [since, connectorId],
  );
  return Number(row?.n ?? 0);
}

function safeJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Whether a fire at this connector should be charged to auth rather than to the surface. */
export function chargesToAuth(health: ConnectorHealth | null | undefined): boolean {
  return health?.state === 'REFRESH_RECOVERABLE' || health?.state === 'HUMAN_REAUTH_REQUIRED';
}
