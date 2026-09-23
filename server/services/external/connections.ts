/**
 * Connecting a provider, checking it, and taking it away again (§51).
 *
 * A connection is three facts that are easy to confuse, and the reading below
 * keeps them apart because each has a different remedy:
 *
 *   - a person decided this project may act through this provider  (the row)
 *   - the credential is actually deployed                           (the env)
 *   - the provider answered for that credential, recently           (a check)
 *
 * "Connected" is only ever said about all three. A row with no secret deployed
 * is WAITING_FOR_SECRET; a secret the provider refused is UNHEALTHY; a secret
 * that changed since it was last checked is CREDENTIAL_CHANGED; a check older
 * than a day is STALE; and a Stripe key the provider itself reports as test
 * mode is TEST_ONLY, which proves the path and never makes invoicing a real
 * customer available. None of those reads PRESENT to the capability reader.
 *
 * Brain assigns the secret's name so nobody has to invent one — the shape
 * `services/capacity/connection.ts` settled for a Routine's bearer — and never
 * sees a value except at the moment it uses it.
 */
import crypto from 'node:crypto';
import {
  createConnection,
  getConnection,
  latestHealthCheck,
  listConnections,
  liveConnection,
  recordExternalEvent,
  recordHealthCheck,
  revokeConnection,
} from '../../repos/externalActions.ts';
import { credentialDigest, driverFor, DRIVERS } from './drivers.ts';
import type {
  ExternalConnection,
  ExternalHealthCheck,
  ExternalProvider,
} from '../../domain/types.ts';
import { EXTERNAL_PROVIDERS } from '../../domain/types.ts';

/** A check older than this no longer says anything about now. */
export const HEALTH_FRESH_MS = 24 * 3600_000;

/** How often the tick re-asks a live connection. */
export const HEALTH_RECHECK_MS = 30 * 60_000;

export type ConnectionState =
  | 'REVOKED'
  | 'WAITING_FOR_SECRET'
  | 'NOT_CHECKED'
  | 'CREDENTIAL_CHANGED'
  | 'UNHEALTHY'
  | 'STALE'
  | 'TEST_ONLY'
  | 'HEALTHY';

export interface ConnectionReading {
  connection: ExternalConnection;
  state: ConnectionState;
  /** Safe to show: what is true, and the one next step. */
  says: string;
  nextStep: string | null;
  latest: ExternalHealthCheck | null;
  /** Usable for real, third-party effects. */
  live: boolean;
  /** Usable for a self-directed or test-environment effect. */
  usableForTest: boolean;
}

export function isExternalProvider(value: unknown): value is ExternalProvider {
  return typeof value === 'string' && (EXTERNAL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The deployment secret's name, from Brain's own identifiers.
 *
 * Deterministic per project and provider, so reconnecting after a revoke asks
 * for the same name — the credential is rotated in the deployment, and the
 * digest on the next check is what tells Brain it changed.
 */
export function secretNameFor(projectId: string, provider: ExternalProvider): string {
  const suffix = crypto.createHash('sha256').update(projectId, 'utf8').digest('hex').slice(0, 8);
  return `BRAIN_EXT_${provider}_${suffix.toUpperCase()}`;
}

/** Read the credential, by name, now. Never cached and never returned. */
export function readSecret(connection: ExternalConnection): string | null {
  const value = process.env[connection.secretName];
  return value && value.trim() ? value.trim() : null;
}

export async function readConnection(
  connection: ExternalConnection,
  now = Date.now(),
): Promise<ConnectionReading> {
  const latest = await latestHealthCheck(connection.id);
  const base = { connection, latest };
  if (connection.state === 'REVOKED') {
    return {
      ...base,
      state: 'REVOKED',
      says: `Revoked${connection.revokedReason ? `: ${connection.revokedReason}` : ''}. Brain will not act through it.`,
      nextStep: 'Reconnect to use it again. Rotate the credential at the provider if it may have leaked.',
      live: false,
      usableForTest: false,
    };
  }
  const secret = readSecret(connection);
  if (!secret) {
    return {
      ...base,
      state: 'WAITING_FOR_SECRET',
      says: `No credential is deployed under ${connection.secretName}, so nothing can be sent through it.`,
      nextStep: `An administrator sets the deployment secret ${connection.secretName}; then press Check.`,
      live: false,
      usableForTest: false,
    };
  }
  if (!latest) {
    return {
      ...base,
      state: 'NOT_CHECKED',
      says: 'A credential is deployed and the provider has not been asked about it yet.',
      nextStep: 'Press Check. Brain calls the provider and records what it answers.',
      live: false,
      usableForTest: false,
    };
  }
  if (latest.credentialDigest !== credentialDigest(secret)) {
    return {
      ...base,
      state: 'CREDENTIAL_CHANGED',
      says: 'The deployed credential is not the one the last check was about.',
      nextStep: 'Press Check, so the reading is about the credential that is actually deployed.',
      live: false,
      usableForTest: false,
    };
  }
  if (!latest.ok) {
    return {
      ...base,
      state: 'UNHEALTHY',
      says: `The provider did not accept it: ${latest.detail}`,
      nextStep: 'Fix the credential or the account at the provider, then press Check.',
      live: false,
      usableForTest: false,
    };
  }
  if (now - Date.parse(latest.checkedAt) > HEALTH_FRESH_MS) {
    return {
      ...base,
      state: 'STALE',
      says: `The last successful check was at ${latest.checkedAt}, which is too old to say anything about now.`,
      nextStep: 'Press Check.',
      live: false,
      usableForTest: false,
    };
  }
  if (latest.mode === 'TEST') {
    return {
      ...base,
      state: 'TEST_ONLY',
      says: latest.detail,
      nextStep: 'Prove the path with a test action to yourself; replace the secret with the live key only after that.',
      live: false,
      usableForTest: true,
    };
  }
  return {
    ...base,
    state: 'HEALTHY',
    says: latest.detail,
    nextStep: null,
    live: true,
    usableForTest: true,
  };
}

export async function connect(input: {
  projectId: string;
  provider: ExternalProvider;
  label?: string | null;
  selfDestination?: string | null;
  sender?: string | null;
  actorRef: string;
}): Promise<{ connection: ExternalConnection; created: boolean }> {
  const driver = driverFor(input.provider);
  const result = await createConnection({
    projectId: input.projectId,
    provider: input.provider,
    label: input.label?.trim() || driver.title,
    secretName: secretNameFor(input.projectId, input.provider),
    selfDestination: input.selfDestination?.trim() || null,
    sender: input.sender?.trim() || null,
    connectedBy: input.actorRef,
  });
  if (result.created) {
    await recordExternalEvent({
      projectId: input.projectId,
      connectionId: result.connection.id,
      kind: 'EXTERNAL_CONNECTION_CREATED',
      actorRef: input.actorRef,
      summary: `${driver.title} was connected; it is not usable until its credential is deployed and checked.`,
      detail: { provider: input.provider, secretName: result.connection.secretName },
    });
  }
  return result;
}

/**
 * Ask the provider, now, and write down what it said.
 *
 * A check with no credential deployed writes nothing: there was nothing to
 * ask about, and a failed row there would read as the provider refusing.
 */
export async function checkConnection(
  connectionId: string,
  actorRef: string,
): Promise<ConnectionReading | null> {
  const connection = await getConnection(connectionId);
  if (!connection) return null;
  if (connection.state !== 'ACTIVE') return await readConnection(connection);
  const secret = readSecret(connection);
  if (secret) {
    const reading = await driverFor(connection.provider).check(secret);
    await recordHealthCheck({
      connectionId: connection.id,
      ok: reading.ok,
      mode: reading.mode,
      credentialDigest: credentialDigest(secret),
      detail: reading.detail,
    });
    await recordExternalEvent({
      projectId: connection.projectId,
      connectionId: connection.id,
      kind: reading.ok ? 'EXTERNAL_CONNECTION_HEALTHY' : 'EXTERNAL_CONNECTION_UNHEALTHY',
      actorRef,
      summary: reading.detail,
      detail: { provider: connection.provider, mode: reading.mode },
    });
  }
  return await readConnection(connection);
}

export async function revoke(input: {
  connectionId: string;
  actorRef: string;
  reason: string;
}): Promise<boolean> {
  const connection = await getConnection(input.connectionId);
  if (!connection) return false;
  const moved = await revokeConnection({ id: connection.id, by: input.actorRef, reason: input.reason });
  if (moved) {
    await recordExternalEvent({
      projectId: connection.projectId,
      connectionId: connection.id,
      kind: 'EXTERNAL_CONNECTION_REVOKED',
      actorRef: input.actorRef,
      summary: `Revoked: ${input.reason}`,
      detail: { provider: connection.provider },
    });
  }
  return moved;
}

/**
 * A new connection for the same provider, after a revoke.
 *
 * A new row rather than the old one flipped back, so the revoked one keeps its
 * history and none of its checks count for the new one: it must be checked
 * again before anything reads it as present.
 */
export async function reconnect(input: {
  connectionId: string;
  actorRef: string;
}): Promise<{ connection: ExternalConnection; created: boolean } | null> {
  const previous = await getConnection(input.connectionId);
  if (!previous || previous.state !== 'REVOKED') return null;
  return await connect({
    projectId: previous.projectId,
    provider: previous.provider,
    label: previous.label,
    selfDestination: previous.selfDestination,
    sender: previous.sender,
    actorRef: input.actorRef,
  });
}

export async function connectionsView(projectId: string) {
  const rows = await listConnections(projectId);
  const readings = await Promise.all(rows.map((one) => readConnection(one)));
  const providers = EXTERNAL_PROVIDERS.map((provider) => {
    const driver = DRIVERS[provider];
    const current = readings.find((one) => one.connection.provider === provider && one.connection.state === 'ACTIVE') ?? null;
    return {
      provider,
      title: driver.title,
      does: driver.does,
      secretShape: driver.secretShape,
      setup: driver.setup,
      capabilities: driver.capabilities,
      secretName: secretNameFor(projectId, provider),
      current: current ? present(current) : null,
      history: readings
        .filter((one) => one.connection.provider === provider && one.connection.state !== 'ACTIVE')
        .map(present),
    };
  });
  return { providers };
}

function present(reading: ConnectionReading) {
  return {
    id: reading.connection.id,
    label: reading.connection.label,
    state: reading.state,
    says: reading.says,
    nextStep: reading.nextStep,
    secretName: reading.connection.secretName,
    selfDestination: reading.connection.selfDestination,
    sender: reading.connection.sender,
    connectionState: reading.connection.state,
    lastCheckedAt: reading.latest?.checkedAt ?? null,
    mode: reading.latest?.mode ?? null,
    connectedAt: reading.connection.createdAt,
    revokedAt: reading.connection.revokedAt,
  };
}

export async function liveReading(
  projectId: string,
  provider: ExternalProvider,
): Promise<ConnectionReading | null> {
  const connection = await liveConnection(projectId, provider);
  return connection ? await readConnection(connection) : null;
}
