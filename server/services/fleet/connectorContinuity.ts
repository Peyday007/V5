/**
 * Reconnecting an existing logical connector keeps its worker.
 *
 * Production, 2026-10-03 04:52–04:59Z: the owner pressed Reconnect on the
 * research connector of the Brain Research A account. Claude registered a fresh
 * OAuth client, as it always does, and `/oauth/authorize` showed the signed-in
 * administrator `ADMIN_CHOOSER` — every live worker in the Brain, with nothing
 * tying the new client to the connector it was replacing. The posted worker was
 * `calebworker1` (worker-04), another member's identity, and the token was
 * minted for it. When the connectors table arrived later that day, the first
 * proven arrival through that client *created* the Brain Research A connector
 * with worker-04 and bound the Brain Research A Routine to it — whose own
 * registered worker is worker-05. Every row read healthy, and Cash Mode 1
 * research, which only worker-05 is a member of, could not run.
 *
 * Two transitions, two guards:
 *
 *   1. Consent. An administrator approving an unattributed client at an
 *      endpoint where logical connectors already exist chooses a *connector*,
 *      not a worker: the worker comes from the connector — from the worker its
 *      Routines are registered for — and the new client is attached to that
 *      connector. Connecting a worker as a brand-new connector is a separate,
 *      labelled choice, and nothing is preselected for either.
 *   2. Attribution. An arrival whose token authenticates as a worker other than
 *      the one the fired Routine is registered for is a conflict, never the
 *      basis for creating a connector or binding the Routine to one.
 *
 * Read-only; the approval route does the writing after asking again.
 */
import { getDb } from '../../db/database.ts';
import { getConnector, listConnectors, endpointOf, type Connector } from '../../repos/connectors.ts';
import { getAccount } from '../../repos/fleet.ts';
import { getWorker } from '../../repos/identity.ts';
import type { Worker } from '../../domain/types.ts';

export interface ReconnectTarget {
  connector: Connector;
  accountName: string;
  /** Live Routines on this connector, by name. */
  routineNames: string[];
  /** The worker a reconnect restores: the Routines' registered worker, else the connector's own. */
  worker: Worker;
  /** The connector currently authorizes as another worker than its Routines are registered for. */
  restoresFrom: string | null;
}

/**
 * The one worker every live Routine on this connector is registered for, or
 * null when there are none or they disagree. `fleet_routines.worker_id` is the
 * operator's registration, which is the binding a reconnect must honour.
 */
async function routinesWorker(connectorId: string): Promise<{ workerId: string | null; names: string[] }> {
  const rows = await getDb().all<{ name: string; worker_id: string | null }>(
    "SELECT name, worker_id FROM fleet_routines WHERE connector_id = ? AND state <> 'RETIRED' ORDER BY name",
    [connectorId],
  );
  const workers = new Set(rows.map((row) => row.worker_id).filter((id): id is string => !!id));
  return { workerId: workers.size === 1 ? [...workers][0]! : null, names: rows.map((row) => row.name) };
}

export async function reconnectTarget(connector: Connector): Promise<ReconnectTarget | null> {
  const routines = await routinesWorker(connector.id);
  const workerId = routines.workerId ?? connector.workerId;
  if (!workerId) return null;
  const worker = await getWorker(workerId);
  if (!worker || worker.disabled) return null;
  const account = await getAccount(connector.accountId);
  if (!account || account.state === 'RETIRED') return null;
  return {
    connector,
    accountName: account.name,
    routineNames: routines.names,
    worker,
    restoresFrom: connector.workerId && connector.workerId !== workerId ? connector.workerId : null,
  };
}

/** Every existing connector an administrator could be reconnecting at this endpoint. */
export async function reconnectTargets(resource: string | null): Promise<ReconnectTarget[]> {
  const endpoint = endpointOf(resource);
  if (endpoint === 'UNSPECIFIED') return [];
  const out: ReconnectTarget[] = [];
  for (const connector of await listConnectors()) {
    if (connector.resource !== endpoint) continue;
    const target = await reconnectTarget(connector);
    if (target) out.push(target);
  }
  return out;
}

export async function reconnectTargetById(connectorId: string, resource: string | null): Promise<ReconnectTarget | null> {
  const connector = await getConnector(connectorId);
  if (!connector || connector.resource !== endpointOf(resource)) return null;
  return reconnectTarget(connector);
}
