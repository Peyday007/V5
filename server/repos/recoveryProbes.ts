/**
 * Recovery probes: one controlled activation of one quarantined or unattributed
 * Routine, recorded so its outcome can be read rather than reconstructed.
 *
 * Every transition is a compare-and-swap on the state the caller read, so two
 * settlers (the tick and an operator's `connectors probe` waiting on the same
 * probe) produce one outcome and an ordinary loser. Nothing is deleted: a
 * settled probe is the record of what that fire proved.
 */
import { getDb } from '../db/database.ts';
import { normalizeSessionRef } from '../domain/sessionRef.ts';
import { newId, nowIso } from './util.ts';

export type RecoveryProbeState =
  | 'FIRING'
  | 'FIRED'
  | 'HEALTHY'
  | 'REAUTH_REQUIRED'
  | 'NO_MCP'
  | 'PROVIDER_REFUSED'
  | 'AMBIGUOUS';

export const LIVE_RECOVERY_STATES: readonly RecoveryProbeState[] = ['FIRING', 'FIRED'];

export interface RecoveryProbe {
  id: string;
  routineId: string;
  accountId: string;
  workerId: string | null;
  binId: string | null;
  state: RecoveryProbeState;
  providerSession: string | null;
  credentialId: string | null;
  clientId: string | null;
  connectorId: string | null;
  health: string | null;
  outcome: string | null;
  nextAction: string | null;
  requestedById: string;
  authorityChannel: string;
  createdAt: string;
  firedAt: string | null;
  arrivedAt: string | null;
  settledAt: string | null;
  expiresAt: string;
}

interface RecoveryProbeRow {
  id: string;
  routine_id: string;
  account_id: string;
  worker_id: string | null;
  bin_id: string | null;
  state: RecoveryProbeState;
  provider_session: string | null;
  credential_id: string | null;
  client_id: string | null;
  connector_id: string | null;
  health: string | null;
  outcome: string | null;
  next_action: string | null;
  requested_by_id: string;
  authority_channel: string;
  created_at: string;
  fired_at: string | null;
  arrived_at: string | null;
  settled_at: string | null;
  expires_at: string;
}

function map(row: RecoveryProbeRow): RecoveryProbe {
  return {
    id: row.id,
    routineId: row.routine_id,
    accountId: row.account_id,
    workerId: row.worker_id,
    binId: row.bin_id,
    state: row.state,
    providerSession: row.provider_session,
    credentialId: row.credential_id,
    clientId: row.client_id,
    connectorId: row.connector_id,
    health: row.health,
    outcome: row.outcome,
    nextAction: row.next_action,
    requestedById: row.requested_by_id,
    authorityChannel: row.authority_channel,
    createdAt: row.created_at,
    firedAt: row.fired_at,
    arrivedAt: row.arrived_at,
    settledAt: row.settled_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Reserve the Brain's one probe slot for this Routine.
 *
 * Returns null when another probe is live anywhere — the UNIQUE constraint on
 * `live` refuses the insert, so the loser of a race is an ordinary outcome.
 */
export async function reserveRecoveryProbe(input: {
  routineId: string;
  accountId: string;
  workerId: string | null;
  requestedById: string;
  authorityChannel: string;
  expiresAt: string;
}): Promise<RecoveryProbe | null> {
  const id = newId('crp');
  const result = await getDb().run(
    `INSERT INTO connector_recovery_probes
       (id, routine_id, account_id, worker_id, state, live, requested_by_id, authority_channel, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'FIRING', 1, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.routineId,
      input.accountId,
      input.workerId,
      input.requestedById,
      input.authorityChannel,
      nowIso(),
      input.expiresAt,
    ],
  );
  return result.changes === 1 ? getRecoveryProbe(id) : null;
}

export async function getRecoveryProbe(id: string): Promise<RecoveryProbe | null> {
  const row = await getDb().get<RecoveryProbeRow>('SELECT * FROM connector_recovery_probes WHERE id = ?', [id]);
  return row ? map(row) : null;
}

export async function liveRecoveryProbe(): Promise<RecoveryProbe | null> {
  const row = await getDb().get<RecoveryProbeRow>('SELECT * FROM connector_recovery_probes WHERE live = 1');
  return row ? map(row) : null;
}

export async function latestRecoveryProbeFor(routineId: string): Promise<RecoveryProbe | null> {
  const row = await getDb().get<RecoveryProbeRow>(
    'SELECT * FROM connector_recovery_probes WHERE routine_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [routineId],
  );
  return row ? map(row) : null;
}

export async function listRecoveryProbes(states?: readonly RecoveryProbeState[]): Promise<RecoveryProbe[]> {
  const rows = states?.length
    ? await getDb().all<RecoveryProbeRow>(
        `SELECT * FROM connector_recovery_probes WHERE state IN (${states.map(() => '?').join(', ')})
          ORDER BY created_at, id`,
        [...states],
      )
    : await getDb().all<RecoveryProbeRow>('SELECT * FROM connector_recovery_probes ORDER BY created_at, id');
  return rows.map(map);
}

/** The probe whose fire produced this provider session, if any — in any state. */
export async function recoveryProbeForSession(sessionRef: string | null | undefined): Promise<RecoveryProbe | null> {
  const key = normalizeSessionRef(sessionRef);
  if (!key) return null;
  const row = await getDb().get<RecoveryProbeRow>('SELECT * FROM connector_recovery_probes WHERE session_key = ?', [
    key,
  ]);
  return row ? map(row) : null;
}

export async function attachRecoveryBin(id: string, binId: string): Promise<boolean> {
  const result = await getDb().run(
    "UPDATE connector_recovery_probes SET bin_id = ? WHERE id = ? AND state = 'FIRING' AND bin_id IS NULL",
    [binId, id],
  );
  return result.changes === 1;
}

/** The provider started a session. FIRING -> FIRED, recording which session. */
export async function markRecoveryFired(id: string, providerSession: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE connector_recovery_probes
        SET state = 'FIRED', provider_session = ?, session_key = ?, fired_at = ?
      WHERE id = ? AND state = 'FIRING'`,
    [providerSession, normalizeSessionRef(providerSession), nowIso(), id],
  );
  return result.changes === 1;
}

/** Record what the arrival authenticated with, before the outcome is decided. */
export async function recordRecoveryArrival(
  id: string,
  input: { credentialId: string | null; clientId: string | null; arrivedAt: string },
): Promise<void> {
  await getDb().run(
    `UPDATE connector_recovery_probes
        SET credential_id = COALESCE(credential_id, ?), client_id = COALESCE(client_id, ?),
            arrived_at = COALESCE(arrived_at, ?)
      WHERE id = ? AND state = 'FIRED'`,
    [input.credentialId, input.clientId, input.arrivedAt, id],
  );
}

/** A terminal outcome, written once, releasing the Brain's probe slot. */
export async function settleRecoveryProbe(
  id: string,
  from: RecoveryProbeState,
  input: {
    to: Exclude<RecoveryProbeState, 'FIRING' | 'FIRED'>;
    connectorId?: string | null;
    clientId?: string | null;
    health?: string | null;
    outcome: string;
    nextAction?: string | null;
  },
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE connector_recovery_probes
        SET state = ?, live = NULL, connector_id = COALESCE(?, connector_id), client_id = COALESCE(?, client_id),
            health = ?, outcome = ?, next_action = ?, settled_at = ?
      WHERE id = ? AND state = ?`,
    [
      input.to,
      input.connectorId ?? null,
      input.clientId ?? null,
      input.health ?? null,
      input.outcome,
      input.nextAction ?? null,
      nowIso(),
      id,
      from,
    ],
  );
  return result.changes === 1;
}
