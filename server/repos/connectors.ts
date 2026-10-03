/**
 * Logical connectors: one Claude account at one Brain endpoint.
 *
 * A worker identity is not a connector. `factory-brain` is served by several
 * Claude accounts, each holding its own connector, its own OAuth client and its
 * own tokens — so "worker-10 authenticated" says nothing about whether Airyn's
 * connector or Caleb's is the one that works. Claude refuses a second custom
 * connector at a URL one already holds, so (fleet account, endpoint) names
 * exactly one connector, and that pair is the identity here.
 *
 * A reconnect can leave a new OAuth client behind the same connector. Every
 * client that was ever this connector is kept in `connector_clients` with the
 * evidence that made it so, and none is ever re-pointed silently: a client
 * observed under a second connector is a conflict to report, not a correction
 * to apply (§23's rule about `bindRoutineWorker`, one table along).
 *
 * Nothing here stores health. Health is derived on every read from the token
 * rows, the refusals and the fires (`services/fleet/connectorHealth.ts`).
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';

export type ConnectorClientSource = 'OBSERVED_ARRIVAL' | 'INVITATION_MEMBER' | 'BOUND_INVITATION' | 'OPERATOR';

export interface Connector {
  id: string;
  accountId: string;
  resource: string;
  workerId: string | null;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorClient {
  clientId: string;
  connectorId: string;
  source: ConnectorClientSource;
  evidence: string | null;
  attachedAt: string;
}

interface ConnectorRow {
  id: string;
  account_id: string;
  resource: string;
  worker_id: string | null;
  label: string | null;
  created_at: string;
  updated_at: string;
}

interface ConnectorClientRow {
  client_id: string;
  connector_id: string;
  source: ConnectorClientSource;
  evidence: string | null;
  attached_at: string;
}

function mapConnector(row: ConnectorRow): Connector {
  return {
    id: row.id,
    accountId: row.account_id,
    resource: row.resource,
    workerId: row.worker_id,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapClient(row: ConnectorClientRow): ConnectorClient {
  return {
    clientId: row.client_id,
    connectorId: row.connector_id,
    source: row.source,
    evidence: row.evidence,
    attachedAt: row.attached_at,
  };
}

/**
 * The endpoint a token was issued for, as a path.
 *
 * Tokens record the `resource` the client asked for, which is a full URL; the
 * identity is the path, because the host is the same Brain behind whatever name
 * reached it. A client that sent no resource is `UNSPECIFIED`, deliberately not
 * defaulted to `/mcp` — guessing the research endpoint would weld a Factory
 * connector to a research one in the same account.
 */
export function endpointOf(resource: string | null): string {
  if (!resource) return 'UNSPECIFIED';
  try {
    const path = new URL(resource).pathname.replace(/\/+$/, '');
    return path || '/';
  } catch {
    return resource.startsWith('/') ? resource.replace(/\/+$/, '') || '/' : 'UNSPECIFIED';
  }
}

export async function getConnector(id: string): Promise<Connector | null> {
  const row = await getDb().get<ConnectorRow>('SELECT * FROM connectors WHERE id = ?', [id]);
  return row ? mapConnector(row) : null;
}

export async function listConnectors(): Promise<Connector[]> {
  const rows = await getDb().all<ConnectorRow>('SELECT * FROM connectors ORDER BY created_at, id');
  return rows.map(mapConnector);
}

/**
 * The connector for one account at one endpoint, created if it does not exist.
 * Idempotent by the unique pair, so two observers produce one row.
 */
export async function ensureConnector(input: {
  accountId: string;
  resource: string;
  workerId: string | null;
  label?: string | null;
}): Promise<Connector> {
  const at = nowIso();
  await getDb().run(
    `INSERT INTO connectors (id, account_id, resource, worker_id, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, resource) DO NOTHING`,
    [newId('cnr'), input.accountId, input.resource, input.workerId, input.label ?? null, at, at],
  );
  const row = await getDb().get<ConnectorRow>(
    'SELECT * FROM connectors WHERE account_id = ? AND resource = ?',
    [input.accountId, input.resource],
  );
  if (!row) throw new Error('The connector disappeared immediately after being written.');
  // The worker a connector authorizes as is observed; fill it once, never re-point.
  if (row.worker_id === null && input.workerId) {
    await getDb().run('UPDATE connectors SET worker_id = ?, updated_at = ? WHERE id = ? AND worker_id IS NULL', [
      input.workerId,
      at,
      row.id,
    ]);
    row.worker_id = input.workerId;
  }
  return mapConnector(row);
}

export type AttachOutcome = 'ATTACHED' | 'ALREADY' | 'CONFLICT';

/**
 * This OAuth client is this connector. First evidence wins; a client already
 * attached to a *different* connector is reported as a conflict and left alone.
 */
export async function attachClient(input: {
  clientId: string;
  connectorId: string;
  source: ConnectorClientSource;
  evidence?: string | null;
}): Promise<AttachOutcome> {
  const result = await getDb().run(
    `INSERT INTO connector_clients (client_id, connector_id, source, evidence, attached_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (client_id) DO NOTHING`,
    [input.clientId, input.connectorId, input.source, input.evidence ?? null, nowIso()],
  );
  if (result.changes === 1) return 'ATTACHED';
  const existing = await connectorClient(input.clientId);
  return existing?.connectorId === input.connectorId ? 'ALREADY' : 'CONFLICT';
}

export async function connectorClient(clientId: string): Promise<ConnectorClient | null> {
  const row = await getDb().get<ConnectorClientRow>('SELECT * FROM connector_clients WHERE client_id = ?', [
    clientId,
  ]);
  return row ? mapClient(row) : null;
}

export async function clientsOfConnector(connectorId: string): Promise<ConnectorClient[]> {
  const rows = await getDb().all<ConnectorClientRow>(
    'SELECT * FROM connector_clients WHERE connector_id = ? ORDER BY attached_at, client_id',
    [connectorId],
  );
  return rows.map(mapClient);
}

export async function listConnectorClients(): Promise<ConnectorClient[]> {
  const rows = await getDb().all<ConnectorClientRow>('SELECT * FROM connector_clients ORDER BY attached_at');
  return rows.map(mapClient);
}

/**
 * Which connector a Routine's sessions authenticate through. Filled once, from
 * evidence; an operator's `fleet bind-connector` is the way to change it.
 */
export async function bindRoutineConnector(routineId: string, connectorId: string): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE fleet_routines SET connector_id = ?, updated_at = ? WHERE id = ? AND connector_id IS NULL',
    [connectorId, nowIso(), routineId],
  );
  return result.changes === 1;
}

/** The operator's correction, guarded on the binding they say they are replacing. */
export async function repointRoutineConnector(input: {
  routineId: string;
  from: string | null;
  to: string;
}): Promise<boolean> {
  const result = await getDb().run(
    input.from === null
      ? 'UPDATE fleet_routines SET connector_id = ?, updated_at = ? WHERE id = ? AND connector_id IS NULL'
      : 'UPDATE fleet_routines SET connector_id = ?, updated_at = ? WHERE id = ? AND connector_id = ?',
    (input.from === null
      ? [input.to, nowIso(), input.routineId]
      : [input.to, nowIso(), input.routineId, input.from]) as never[],
  );
  return result.changes === 1;
}
