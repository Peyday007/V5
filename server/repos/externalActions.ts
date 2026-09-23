/**
 * Connections, health readings and prepared actions, as rows (§51).
 *
 * Every state change here is one guarded `UPDATE` naming the state it comes
 * from, so two ticks, two tabs or a retry after a lost response produce one
 * move and one ordinary loser. Nothing here deletes: a revoked connection and
 * a cancelled action keep their rows, and the events table is append-only.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  ExternalAction,
  ExternalActionContent,
  ExternalActionEvent,
  ExternalActionKind,
  ExternalActionRow,
  ExternalActionState,
  ExternalConnection,
  ExternalConnectionRow,
  ExternalHealthCheck,
  ExternalHealthCheckRow,
  ExternalProvider,
} from '../domain/types.ts';

function mapConnection(row: ExternalConnectionRow): ExternalConnection {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider as ExternalProvider,
    label: row.label,
    secretName: row.secret_name,
    selfDestination: row.self_destination,
    sender: row.sender,
    state: row.state as ExternalConnection['state'],
    connectedBy: row.connected_by,
    revokedBy: row.revoked_by,
    revokedReason: row.revoked_reason,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCheck(row: ExternalHealthCheckRow): ExternalHealthCheck {
  return {
    id: row.id,
    connectionId: row.connection_id,
    ok: row.ok === 1,
    mode: (row.mode as ExternalHealthCheck['mode']) ?? null,
    credentialDigest: row.credential_digest,
    detail: row.detail,
    checkedAt: row.checked_at,
  };
}

function mapAction(row: ExternalActionRow): ExternalAction {
  return {
    id: row.id,
    projectId: row.project_id,
    connectionId: row.connection_id,
    kind: row.kind as ExternalActionKind,
    commercialAction: row.commercial_action,
    opportunityId: row.opportunity_id,
    conversationId: row.conversation_id,
    destination: row.destination,
    content: parseJson<ExternalActionContent>(row.content, {}),
    expectedEffect: row.expected_effect,
    amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
    currency: row.currency,
    state: row.state as ExternalActionState,
    approvalRequired: Number(row.approval_required) === 1,
    requestedByType: row.requested_by_type,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    requestKey: row.request_key,
    operationId: row.operation_id,
    providerRef: row.provider_ref,
    outcomeDetail: row.outcome_detail,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    readbackState: row.readback_state,
    readbackDetail: row.readback_detail,
    readbackAt: row.readback_at,
    readbackFinal: Number(row.readback_final) === 1,
    returnedAt: row.returned_at,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------------- */
/* Connections                                                                */
/* ------------------------------------------------------------------------- */

export async function createConnection(input: {
  projectId: string;
  provider: ExternalProvider;
  label: string;
  secretName: string;
  selfDestination: string | null;
  sender: string | null;
  connectedBy: string;
}): Promise<{ connection: ExternalConnection; created: boolean }> {
  const id = newId('xcn');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO external_connections
       (id, project_id, provider, label, secret_name, self_destination, sender, state,
        connected_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
     ON CONFLICT (project_id, provider) WHERE state = 'ACTIVE' DO NOTHING`,
    [
      id,
      input.projectId,
      input.provider,
      input.label,
      input.secretName,
      input.selfDestination,
      input.sender,
      input.connectedBy,
      at,
      at,
    ],
  );
  const live = await liveConnection(input.projectId, input.provider);
  if (!live) throw new Error('The connection disappeared immediately after being written.');
  return { connection: live, created: live.id === id };
}

export async function getConnection(id: string): Promise<ExternalConnection | null> {
  const row = await getDb().get<ExternalConnectionRow>(
    'SELECT * FROM external_connections WHERE id = ?',
    [id],
  );
  return row ? mapConnection(row) : null;
}

export async function liveConnection(
  projectId: string,
  provider: ExternalProvider,
): Promise<ExternalConnection | null> {
  const row = await getDb().get<ExternalConnectionRow>(
    `SELECT * FROM external_connections
      WHERE project_id = ? AND provider = ? AND state = 'ACTIVE'`,
    [projectId, provider],
  );
  return row ? mapConnection(row) : null;
}

export async function listConnections(projectId: string): Promise<ExternalConnection[]> {
  const rows = await getDb().all<ExternalConnectionRow>(
    'SELECT * FROM external_connections WHERE project_id = ? ORDER BY created_at DESC, id',
    [projectId],
  );
  return rows.map(mapConnection);
}

export async function listLiveConnections(): Promise<ExternalConnection[]> {
  const rows = await getDb().all<ExternalConnectionRow>(
    "SELECT * FROM external_connections WHERE state = 'ACTIVE' ORDER BY created_at, id",
  );
  return rows.map(mapConnection);
}

/** Guarded on the connection still being live, so two revokes are one. */
export async function revokeConnection(input: {
  id: string;
  by: string;
  reason: string;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE external_connections
        SET state = 'REVOKED', revoked_by = ?, revoked_reason = ?, revoked_at = ?, updated_at = ?
      WHERE id = ? AND state = 'ACTIVE'`,
    [input.by, input.reason, at, at, input.id],
  );
  return result.changes > 0;
}

export async function recordHealthCheck(input: {
  connectionId: string;
  ok: boolean;
  mode: 'TEST' | 'LIVE' | null;
  credentialDigest: string | null;
  detail: string;
}): Promise<ExternalHealthCheck> {
  const id = newId('xhc');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO external_health_checks
       (id, connection_id, ok, mode, credential_digest, detail, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.connectionId, input.ok ? 1 : 0, input.mode, input.credentialDigest, input.detail, at],
  );
  return {
    id,
    connectionId: input.connectionId,
    ok: input.ok,
    mode: input.mode,
    credentialDigest: input.credentialDigest,
    detail: input.detail,
    checkedAt: at,
  };
}

export async function latestHealthCheck(connectionId: string): Promise<ExternalHealthCheck | null> {
  const row = await getDb().get<ExternalHealthCheckRow>(
    `SELECT * FROM external_health_checks WHERE connection_id = ?
      ORDER BY checked_at DESC, id DESC LIMIT 1`,
    [connectionId],
  );
  return row ? mapCheck(row) : null;
}

/* ------------------------------------------------------------------------- */
/* Actions                                                                    */
/* ------------------------------------------------------------------------- */

export interface NewExternalAction {
  projectId: string;
  connectionId: string;
  kind: ExternalActionKind;
  commercialAction: string | null;
  opportunityId: string | null;
  conversationId: string | null;
  destination: string;
  content: ExternalActionContent;
  expectedEffect: string;
  amountCents: number | null;
  currency: string | null;
  approvalRequired: boolean;
  requestedByType: string;
  requestedBy: string;
  requestKey: string;
}

/** One logical action, once — the `cash_actions` shape. */
export async function insertAction(
  input: NewExternalAction,
): Promise<{ action: ExternalAction; created: boolean }> {
  const id = newId('xac');
  const at = nowIso();
  const params: SqlParam[] = [
    id,
    input.projectId,
    input.connectionId,
    input.kind,
    input.commercialAction,
    input.opportunityId,
    input.conversationId,
    input.destination,
    toJson(input.content),
    input.expectedEffect,
    input.amountCents,
    input.currency,
    input.approvalRequired ? 'AWAITING_APPROVAL' : 'APPROVED',
    input.approvalRequired ? 1 : 0,
    input.requestedByType,
    input.requestedBy,
    input.requestKey,
    at,
    at,
    at,
  ];
  await getDb().run(
    `INSERT INTO external_actions
       (id, project_id, connection_id, kind, commercial_action, opportunity_id, conversation_id,
        destination, content, expected_effect, amount_cents, currency, state, approval_required,
        requested_by_type, requested_by, request_key, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, request_key) DO NOTHING`,
    params,
  );
  const row = await getDb().get<ExternalActionRow>(
    'SELECT * FROM external_actions WHERE project_id = ? AND request_key = ?',
    [input.projectId, input.requestKey],
  );
  if (!row) throw new Error('The action disappeared immediately after being written.');
  return { action: mapAction(row), created: row.id === id };
}

export async function getAction(id: string): Promise<ExternalAction | null> {
  const row = await getDb().get<ExternalActionRow>('SELECT * FROM external_actions WHERE id = ?', [
    id,
  ]);
  return row ? mapAction(row) : null;
}

export async function listActions(
  projectId: string,
  limit = 100,
): Promise<ExternalAction[]> {
  const rows = await getDb().all<ExternalActionRow>(
    `SELECT * FROM external_actions WHERE project_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    [projectId, limit],
  );
  return rows.map(mapAction);
}

export async function listActionsInState(
  states: readonly ExternalActionState[],
  limit = 50,
): Promise<ExternalAction[]> {
  if (states.length === 0) return [];
  const rows = await getDb().all<ExternalActionRow>(
    `SELECT * FROM external_actions WHERE state IN (${states.map(() => '?').join(', ')})
      ORDER BY created_at, id LIMIT ?`,
    [...states, limit],
  );
  return rows.map(mapAction);
}

/**
 * Move an action, guarded on the state the caller read.
 *
 * `patch` columns are written in the same statement that makes the move, so a
 * receipt can never land on an action another caller has already moved.
 */
export async function moveAction(input: {
  id: string;
  from: readonly ExternalActionState[];
  to: ExternalActionState;
  patch?: Partial<{
    approved_by: string;
    approved_at: string;
    operation_id: string;
    provider_ref: string;
    outcome_detail: string;
    attempts: number;
    next_attempt_at: string | null;
    resolved_by: string;
  }>;
}): Promise<boolean> {
  const at = nowIso();
  const patch = input.patch ?? {};
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  const sets = ['state = ?', 'updated_at = ?', ...keys.map((key) => `${key} = ?`)];
  const values: SqlParam[] = [input.to, at, ...keys.map((key) => (patch[key] ?? null) as SqlParam)];
  const result = await getDb().run(
    `UPDATE external_actions SET ${sets.join(', ')}
      WHERE id = ? AND state IN (${input.from.map(() => '?').join(', ')})`,
    [...values, input.id, ...input.from],
  );
  return result.changes > 0;
}

export async function recordReadback(input: {
  id: string;
  state: string;
  detail: string;
  final: boolean;
}): Promise<void> {
  const at = nowIso();
  await getDb().run(
    `UPDATE external_actions
        SET readback_state = ?, readback_detail = ?, readback_at = ?, readback_final = ?,
            updated_at = ?
      WHERE id = ?`,
    [input.state, input.detail, at, input.final ? 1 : 0, at, input.id],
  );
}

/** Claimed once: the compare-and-swap that makes returning a result idempotent. */
export async function claimReturn(id: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    'UPDATE external_actions SET returned_at = ?, updated_at = ? WHERE id = ? AND returned_at IS NULL',
    [at, at, id],
  );
  return result.changes > 0;
}

/** Confirmed actions whose provider-side state may still move. */
export async function actionsAwaitingReadback(limit = 25): Promise<ExternalAction[]> {
  const rows = await getDb().all<ExternalActionRow>(
    `SELECT * FROM external_actions
      WHERE state = 'CONFIRMED' AND readback_final = 0
      ORDER BY updated_at, id LIMIT ?`,
    [limit],
  );
  return rows.map(mapAction);
}

export async function countSentSince(connectionId: string, since: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM external_actions
      WHERE connection_id = ? AND created_at >= ? AND state <> 'CANCELLED'`,
    [connectionId, since],
  );
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------------------------- */
/* History                                                                    */
/* ------------------------------------------------------------------------- */

export async function recordExternalEvent(input: {
  projectId: string;
  actionId?: string | null;
  connectionId?: string | null;
  kind: string;
  actorRef: string;
  summary: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO external_action_events
       (id, project_id, action_id, connection_id, kind, actor_ref, summary, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('xev'),
      input.projectId,
      input.actionId ?? null,
      input.connectionId ?? null,
      input.kind,
      input.actorRef,
      input.summary,
      toJson(input.detail ?? {}),
      nowIso(),
    ],
  );
}

export async function listExternalEvents(
  projectId: string,
  actionId?: string,
  limit = 100,
): Promise<ExternalActionEvent[]> {
  const rows = await getDb().all<{
    id: string;
    project_id: string;
    action_id: string | null;
    connection_id: string | null;
    kind: string;
    actor_ref: string;
    summary: string;
    detail: string;
    created_at: string;
  }>(
    actionId
      ? `SELECT * FROM external_action_events WHERE project_id = ? AND action_id = ?
          ORDER BY created_at, id LIMIT ?`
      : `SELECT * FROM external_action_events WHERE project_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`,
    actionId ? [projectId, actionId, limit] : [projectId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    actionId: row.action_id,
    connectionId: row.connection_id,
    kind: row.kind,
    actorRef: row.actor_ref,
    summary: row.summary,
    detail: parseJson<Record<string, unknown>>(row.detail, {}),
    createdAt: row.created_at,
  }));
}
