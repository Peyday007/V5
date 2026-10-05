/**
 * Which connector an OAuth client is, and which connector a Routine uses —
 * established from evidence Brain wrote, never guessed from a worker id.
 *
 * Two kinds of evidence, both rows:
 *
 *   OBSERVED_ARRIVAL   Brain fired Routine R (account A), and the session that
 *                      arrived authenticated with an access token from client C
 *                      for endpoint E. So C is connector (A, E), and R uses it.
 *                      Accepted only where the arrival is provably the fired
 *                      session (its provider session matches the dispatch row),
 *                      or where every Routine bound to that worker is in one
 *                      account so the account is not in doubt — because one
 *                      worker served by several accounts is exactly the case in
 *                      which "a worker-10 session arrived" proves nothing.
 *   INVITATION_MEMBER  the client was approved on a member-bound invitation, and
 *                      that member's own capacity connection names exactly one
 *                      fleet account.
 *
 * Where the evidence names more than one account, nothing is attached and the
 * connector stays UNKNOWN for an operator's `fleet bind-connector`. A client is
 * never re-pointed: a second connector observed for an attached client is a
 * conflict, reported and left alone.
 */
import { getDb } from '../../db/database.ts';
import {
  attachClient,
  bindRoutineConnector,
  connectorClient,
  endpointOf,
  ensureConnector,
  getConnector,
  listConnectors,
} from '../../repos/connectors.ts';
import { getToken } from '../../repos/oauth.ts';
import { getRoutine, listRoutines } from '../../repos/fleet.ts';
import { forgetRoutingHealth } from './connectorHealth.ts';

/** Is this worker's account unambiguous — every Routine bound to it in one account? */
async function singleAccountFor(workerId: string): Promise<string | null> {
  const rows = await getDb().all<{ account_id: string }>(
    "SELECT DISTINCT account_id FROM fleet_routines WHERE worker_id = ? AND state <> 'RETIRED'",
    [workerId],
  );
  return rows.length === 1 ? rows[0]!.account_id : null;
}

export type ArrivalAttribution = {
  outcome: 'BOUND' | 'ALREADY' | 'CONFLICT' | 'NOT_EVIDENCE';
  connectorId: string | null;
  clientId: string | null;
  /** Why, for CONFLICT and NOT_EVIDENCE; names ids and categories, never a credential. */
  reason: string | null;
};

/**
 * A fired session arrived. Called from the arrival credit with the credential
 * the request authenticated with.
 */
export async function observeConnectorArrival(input: {
  routineId: string;
  workerId: string;
  credentialId: string;
  /** The arriving session is provably the one Brain fired (provider sessions match). */
  proven: boolean;
}): Promise<'BOUND' | 'ALREADY' | 'CONFLICT' | 'NOT_EVIDENCE'> {
  return (await attributeArrival(input)).outcome;
}

/**
 * The same attribution, saying which connector it reached and why it did not.
 *
 * A connector is (account, endpoint), and one Claude connector at one URL holds
 * one authorization — so a connector that already authorizes as one worker
 * cannot also be the connector a session authenticated as a *different* worker
 * came through. That is the case of one person's research connector and their
 * Factory connector: same account, and if both were at one endpoint, the second
 * would have silently become the first. It is a conflict, reported, and nothing
 * is attached: the fix is to know which endpoint each uses, not to weld them.
 */
export async function attributeArrival(input: {
  routineId: string;
  workerId: string;
  credentialId: string;
  proven: boolean;
}): Promise<ArrivalAttribution> {
  const none = (outcome: ArrivalAttribution['outcome'], reason: string, clientId: string | null = null) => ({
    outcome,
    connectorId: null,
    clientId,
    reason,
  });
  const token = await getToken(input.credentialId);
  if (!token || token.kind !== 'ACCESS') {
    return none('NOT_EVIDENCE', 'the arrival did not authenticate with an OAuth access token, so it names no connector');
  }
  const routine = await getRoutine(input.routineId);
  if (!routine) return none('NOT_EVIDENCE', `no Routine ${input.routineId}`, token.clientId);
  if (!input.proven && (await singleAccountFor(input.workerId)) !== routine.accountId) {
    return none(
      'NOT_EVIDENCE',
      'the arrival is not provably the fired session and its worker serves more than one account',
      token.clientId,
    );
  }

  /*
   * A Routine is registered for one worker, and an arrival authenticated as a
   * different one did not come through this Routine's connector as it should
   * be. Production, 2026-10-03: a reconnect consented as worker-04 on the Brain
   * Research A account, and the first proven arrival through it created that
   * account's connector *as worker-04* and bound the worker-05 Routine to it —
   * enshrining the wrong consent as the connector's identity. A contradiction
   * is reported and nothing is created or bound.
   */
  if (routine.workerId && routine.workerId !== token.workerId) {
    return none(
      'CONFLICT',
      `routine ${routine.id} is registered for ${routine.workerId}, but this arrival authenticated as ` +
        `${token.workerId}; the connector's consent was for the wrong worker and is not adopted`,
      token.clientId,
    );
  }

  const resource = endpointOf(token.resource);
  const existing = await connectorClient(token.clientId);
  let connectorId: string;
  if (existing) {
    const bound = await getConnector(existing.connectorId);
    if (!bound || bound.accountId !== routine.accountId || bound.resource !== resource) {
      return none(
        'CONFLICT',
        `client ${token.clientId} is already connector ${existing.connectorId}, which is not this account at ${resource}`,
        token.clientId,
      );
    }
    connectorId = bound.id;
  } else {
    const current = await getDb().get<{ id: string; worker_id: string | null }>(
      'SELECT id, worker_id FROM connectors WHERE account_id = ? AND resource = ?',
      [routine.accountId, resource],
    );
    if (current?.worker_id && current.worker_id !== token.workerId) {
      return none(
        'CONFLICT',
        `connector ${current.id} (this account at ${resource}) authorizes as ${current.worker_id}, ` +
          `but this arrival authenticated as ${token.workerId}; two workers are not one connector. If the worker ` +
          `legitimately changed, an operator corrects it with \`connectors repoint-worker ${current.id} ${token.workerId}\``,
        token.clientId,
      );
    }
    const connector = await ensureConnector({ accountId: routine.accountId, resource, workerId: token.workerId });
    const outcome = await attachClient({
      clientId: token.clientId,
      connectorId: connector.id,
      source: 'OBSERVED_ARRIVAL',
      evidence: `routine ${routine.id} fired; arrival authenticated with ${token.id}${input.proven ? ' (provider session matched)' : ' (single-account worker)'}`,
    });
    if (outcome === 'CONFLICT') {
      return none('CONFLICT', `client ${token.clientId} was attached to another connector concurrently`, token.clientId);
    }
    connectorId = connector.id;
  }
  if (routine.connectorId && routine.connectorId !== connectorId) {
    return {
      outcome: 'CONFLICT',
      connectorId,
      clientId: token.clientId,
      reason: `routine ${routine.id} is already bound to connector ${routine.connectorId}, not ${connectorId}`,
    };
  }
  const bound = routine.connectorId ? false : await bindRoutineConnector(routine.id, connectorId);
  forgetRoutingHealth();
  return { outcome: bound || !existing ? 'BOUND' : 'ALREADY', connectorId, clientId: token.clientId, reason: null };
}

/**
 * Derive bindings for everything already in the rows. Idempotent; runs on the
 * tick so it reaches connectors that existed before this code did, and needs
 * nobody to reconnect to be migrated.
 */
export async function reconcileConnectorBindings(): Promise<{ attached: number; routinesBound: number; ambiguous: string[] }> {
  let attached = 0;
  let routinesBound = 0;
  const ambiguous: string[] = [];

  /*
   * Clients not yet attached, with every account an observed arrival put them
   * under and every endpoint their tokens were for. `worker_sessions` keys an
   * observation by credential, and an OAuth credential is a token row, so the
   * join is exact.
   */
  const observations = await getDb().all<{ client_id: string; account_id: string; resource: string | null; worker_id: string }>(
    `SELECT DISTINCT t.client_id AS client_id, s.account_id AS account_id, t.resource AS resource, t.worker_id AS worker_id
       FROM worker_sessions s
       JOIN oauth_tokens t ON t.id = s.session_ref
      WHERE t.client_id NOT IN (SELECT client_id FROM connector_clients)`,
  );
  const byClient = new Map<string, { accounts: Set<string>; resources: Set<string>; workerId: string; source: 'OBSERVED_ARRIVAL' | 'INVITATION_MEMBER' }>();
  /*
   * A `worker_sessions` row is written under the *fired* Routine's account even
   * when nothing proves the arriving session was that fire (either provider
   * session missing), so for a worker served by several accounts it is not
   * evidence of which account's connector a client is. Only a single-account
   * worker's observations are trusted here; a shared worker's clients wait for
   * a proven arrival (`observeConnectorArrival`), a member-bound consent, or an
   * operator.
   */
  const accountOf = new Map<string, string | null>();
  const contradicted = new Set<string>();
  for (const row of observations) {
    if (!accountOf.has(row.worker_id)) accountOf.set(row.worker_id, await singleAccountFor(row.worker_id));
    const single = accountOf.get(row.worker_id);
    if (single === null) continue;
    // A row naming an account the worker does not serve contradicts the rest:
    // the client is reported ambiguous rather than attached on the majority.
    if (single !== row.account_id) {
      contradicted.add(row.client_id);
      continue;
    }
    const entry = byClient.get(row.client_id) ?? { accounts: new Set(), resources: new Set(), workerId: row.worker_id, source: 'OBSERVED_ARRIVAL' as const };
    entry.accounts.add(row.account_id);
    entry.resources.add(endpointOf(row.resource));
    byClient.set(row.client_id, entry);
  }

  /*
   * A member-bound invitation names a person, and that person's capacity
   * connection names their fleet account. Read from the consent's own audit
   * row, which records the client and the invitation it was approved on.
   */
  const consents = await getDb().all<{ metadata: string | null }>(
    `SELECT metadata FROM identity_events WHERE action = 'OAUTH_AUTHORIZE' AND result = 'SUCCESS'`,
  );
  for (const consent of consents) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(consent.metadata ?? '{}') as Record<string, unknown>;
    } catch {
      continue;
    }
    const clientId = typeof meta['clientId'] === 'string' ? meta['clientId'] : null;
    const invitationId = typeof meta['invitationId'] === 'string' ? meta['invitationId'] : null;
    if (!clientId || !invitationId) continue;
    if (await connectorClient(clientId)) continue;
    const invitation = await getDb().get<{ intended_user_id: string | null; worker_id: string }>(
      'SELECT intended_user_id, worker_id FROM worker_invitations WHERE id = ?',
      [invitationId],
    );
    if (!invitation?.intended_user_id) continue;
    const accounts = await getDb().all<{ account_id: string }>(
      // The member's connection *for this worker*: a research connection names a
      // different account from a Factory pool's, and attaching across them would
      // make every later proven arrival a conflict.
      'SELECT DISTINCT account_id FROM capacity_connections WHERE user_id = ? AND worker_id = ? AND account_id IS NOT NULL',
      [invitation.intended_user_id, invitation.worker_id],
    );
    const resources = await getDb().all<{ resource: string | null }>(
      'SELECT DISTINCT resource FROM oauth_tokens WHERE client_id = ?',
      [clientId],
    );
    const entry = byClient.get(clientId) ?? { accounts: new Set(), resources: new Set(), workerId: invitation.worker_id, source: 'INVITATION_MEMBER' as const };
    for (const a of accounts) entry.accounts.add(a.account_id);
    for (const r of resources) entry.resources.add(endpointOf(r.resource));
    byClient.set(clientId, entry);
  }

  for (const clientId of contradicted) {
    if (!byClient.has(clientId)) byClient.set(clientId, { accounts: new Set(), resources: new Set(), workerId: '', source: 'OBSERVED_ARRIVAL' });
  }
  for (const [clientId, entry] of byClient) {
    if (contradicted.has(clientId) || entry.accounts.size !== 1 || entry.resources.size !== 1) {
      ambiguous.push(clientId);
      continue;
    }
    const [accountId] = [...entry.accounts];
    const [resource] = [...entry.resources];
    const connector = await ensureConnector({ accountId: accountId!, resource: resource!, workerId: entry.workerId });
    const outcome = await attachClient({
      clientId,
      connectorId: connector.id,
      source: entry.source,
      evidence:
        entry.source === 'INVITATION_MEMBER'
          ? 'derived from a member-bound consent and that member’s connection for this worker'
          : 'derived from recorded arrivals of a single-account worker',
    });
    if (outcome === 'ATTACHED') attached += 1;
  }

  /*
   * A Routine uses the one connector in its account that authorizes as its
   * worker. Two such connectors (research and Factory endpoints for one worker
   * in one account) are ambiguous and left for an observed arrival.
   */
  const connectors = await listConnectors();
  for (const routine of await listRoutines()) {
    if (routine.connectorId || !routine.workerId) continue;
    const candidates = connectors.filter((c) => c.accountId === routine.accountId && c.workerId === routine.workerId);
    if (candidates.length !== 1) continue;
    if (await bindRoutineConnector(routine.id, candidates[0]!.id)) routinesBound += 1;
  }
  if (attached > 0 || routinesBound > 0) forgetRoutingHealth();
  return { attached, routinesBound, ambiguous };
}

/*
 * A surface quarantined for not answering, whose connector has since been
 * re-authorized, comes back by itself.
 *
 * The no-show quarantine's remedy has always been "fix the surface", and for a
 * connector that stopped authenticating the fix *is* a new consent — which
 * nothing used to notice, so somebody also had to remember `fleet set-state`.
 * The proof is account-specific: a grant or a token use on this connector's
 * own clients after the quarantine, never a sibling account's session under the
 * same worker id. The forgiveness boundary `setRoutineState` writes means a
 * connector that was not actually fixed is quarantined again three unanswered
 * fires later, exactly as a person's re-enable would be.
 */
export const NO_SHOW_QUARANTINE_MARK = 'fired sessions never checked in';

export async function recoverReauthorizedSurfaces(now = Date.now()): Promise<string[]> {
  const { connectorHealth } = await import('./connectorHealth.ts');
  const { setRoutineState } = await import('../../repos/fleet.ts');
  const recovered: string[] = [];
  for (const routine of await listRoutines()) {
    if (routine.state !== 'QUARANTINED' || !routine.connectorId) continue;
    if (!(routine.stateReason ?? '').includes(NO_SHOW_QUARANTINE_MARK)) continue;
    const health = await connectorHealth(routine.connectorId, now);
    if (!health || health.state !== 'HEALTHY') continue;
    /*
     * Only a new consent proves the connector was re-authorized. Token use is
     * not proof: a connector is one account at one endpoint, so every Routine in
     * that account shares it, and a sibling's ordinary MCP call would otherwise
     * re-enable a surface whose own trigger is what never answers — "the
     * no-shows were the connector's" would be false and the loop would repeat
     * every three fires. `lastGrantAt` is an authorization-code grant
     * (`parent_token_id IS NULL`), which only a person's consent produces.
     */
    const since = routine.updatedAt;
    const fresh = health.lastGrantAt && health.lastGrantAt > since ? health.lastGrantAt : null;
    if (!fresh) continue;
    const moved = await setRoutineState({
      routineId: routine.id,
      from: 'QUARANTINED',
      to: 'ENABLED',
      reason:
        `Connector ${health.connectorId} re-authorized (${fresh}) after this surface was quarantined for unanswered fires; ` +
        'the no-shows were the connector’s. Re-enabled automatically; a surface that still does not answer is quarantined again.',
    });
    if (moved) recovered.push(routine.id);
  }
  if (recovered.length > 0) forgetRoutingHealth();
  return recovered;
}

/**
 * Touch every Routine on a connector, so intents deferred while it could not
 * authenticate are re-armed now rather than at their backoff
 * (`rearmSurfaceDeferredIntents` watches Routine writes).
 */
export async function touchConnectorRoutines(connectorId: string): Promise<void> {
  await getDb().run('UPDATE fleet_routines SET updated_at = ? WHERE connector_id = ?', [
    new Date().toISOString(),
    connectorId,
  ]);
  forgetRoutingHealth();
}
