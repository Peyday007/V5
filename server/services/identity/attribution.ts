/**
 * Which surface produced this session, and can Brain prove it?
 *
 * ---------------------------------------------------------------------------
 * The question this exists to answer
 * ---------------------------------------------------------------------------
 *
 * A Routine on one Claude account checked in and Brain reported the caller as
 * `airynworker2`. That reading is *correct given the credential* — §22's chain
 * is credential -> `oauth_tokens.worker_id` -> worker, and nothing in it ever
 * consults a name — and it is still useless to a person, for two separate
 * reasons that must not be conflated:
 *
 *   1. **A human name is not an identity.** `workers.name` is an operator
 *      handle. It was surfaced as the principal's `handle`, so `brain_whoami`
 *      answered with somebody's first name and every reader took that to be a
 *      statement about whose account had run the session. It was not.
 *   2. **One worker can sit behind several connectors.** The credential
 *      identifies a *connector*, and a connector is chosen on a consent screen.
 *      Two Claude accounts that both approved the same worker mint tokens that
 *      are indistinguishable downstream, so no amount of correct code can tell
 *      their sessions apart afterwards.
 *
 * (1) is fixed by `workers.label` and is a display change. (2) is a property of
 * the rows, cannot be fixed by code at all, and therefore has to be **reported**
 * — which is what this module is for. `MULTIPLE_CLIENTS_ONE_WORKER` is the
 * finding that names it, and a surface carrying it is `AMBIGUOUS` rather than
 * `PROVEN`, however healthy everything else about it looks.
 *
 * ---------------------------------------------------------------------------
 * Shape
 * ---------------------------------------------------------------------------
 *
 * The analysis is a **pure function over a snapshot**, for `router.ts`'s reason:
 * "why was this session attributed that way" has to be answerable afterwards
 * from a recorded input rather than from a re-run against a database that has
 * moved. `fleetAttributionSnapshot` does the reading; `analyseAttribution` does
 * the deciding and touches nothing.
 *
 * It decides nothing operational. Nothing here fires, claims, binds, repoints,
 * revokes or authorizes — §29's rule for the self-model, at a new table: a
 * reading that acted on what it saw would be a control loop whose input is its
 * own output.
 *
 * **No secret, digest or token value crosses this boundary.** A credential is
 * named by its opaque id and, where a fingerprint genuinely helps an operator
 * tell two rows apart, by the first twelve characters of a sha-256 that was
 * already stored — never by anything a value could be recovered from.
 */
import type {
  FleetAccount,
  FleetRoutine,
  OAuthAuthorizationCode,
  OAuthClient,
  OAuthToken,
  Worker,
} from '../../domain/types.ts';
import { listAccounts, listRoutines, getWorkerSession, getRoutine, getAccount } from '../../repos/fleet.ts';
import { getWorker, listWorkers } from '../../repos/identity.ts';
import {
  getToken,
  listAuthorizationCodesForWorker,
  listClients,
  listTokensForWorker,
} from '../../repos/oauth.ts';
import { getBin, listBinEvents, listDispatchesForBin } from '../../repos/bins.ts';

/* ------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* ------------------------------------------------------------------------- */

export interface AttributionSnapshot {
  accounts: FleetAccount[];
  routines: FleetRoutine[];
  workers: Worker[];
  /** Every token ever minted for any worker in `workers`. */
  tokens: OAuthToken[];
  /** Every authorization code ever issued for any worker in `workers`. */
  codes: OAuthAuthorizationCode[];
  clients: OAuthClient[];
}

export async function fleetAttributionSnapshot(): Promise<AttributionSnapshot> {
  const [accounts, routines, workers, clients] = await Promise.all([
    listAccounts(),
    listRoutines(),
    listWorkers({ includeArchived: true }),
    listClients(),
  ]);
  const tokens: OAuthToken[] = [];
  const codes: OAuthAuthorizationCode[] = [];
  for (const worker of workers) {
    tokens.push(...(await listTokensForWorker(worker.id)));
    codes.push(...(await listAuthorizationCodesForWorker(worker.id)));
  }
  return { accounts, routines, workers, tokens, codes, clients };
}

/* ------------------------------------------------------------------------- */
/* Findings                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The closed set. A `Record` rather than two `Set`s, so a finding added later is
 * a compile error until somebody says whether it makes a surface ambiguous —
 * the shape §27 settled on after two `Set`s that had to be total between them
 * were not.
 */
export type AttributionFinding =
  | 'NO_WORKER_BOUND'
  | 'WORKER_DISABLED_OR_ARCHIVED'
  | 'WORKER_SHARED_ACROSS_ROUTINES'
  | 'WORKER_SHARED_ACROSS_ACCOUNTS'
  | 'MULTIPLE_CLIENTS_ONE_WORKER'
  | 'MULTIPLE_APPROVERS_ONE_WORKER'
  | 'NO_CREDENTIAL_EVER_MINTED'
  | 'SECRET_SHARED_ACROSS_ROUTINES'
  | 'TRIGGER_SHARED_ACROSS_ROUTINES'
  | 'BEARER_SHARED_ACROSS_ROUTINES'
  | 'RETIRED_ROUTINE_STILL_BOUND';

/**
 * Does this finding mean an arriving session cannot be attributed to one
 * surface?
 *
 * Only the ones that genuinely destroy the mapping. A pool of Routines under
 * *one* account sharing a worker is the ordinary shape §27 documents and is
 * reported without being called ambiguous; the same worker under *two*
 * accounts is the thing that makes an account attribution a coin toss.
 */
export const AMBIGUATES: Record<AttributionFinding, boolean> = {
  NO_WORKER_BOUND: true,
  WORKER_DISABLED_OR_ARCHIVED: false,
  WORKER_SHARED_ACROSS_ROUTINES: false,
  WORKER_SHARED_ACROSS_ACCOUNTS: true,
  MULTIPLE_CLIENTS_ONE_WORKER: true,
  MULTIPLE_APPROVERS_ONE_WORKER: true,
  NO_CREDENTIAL_EVER_MINTED: false,
  SECRET_SHARED_ACROSS_ROUTINES: true,
  TRIGGER_SHARED_ACROSS_ROUTINES: true,
  BEARER_SHARED_ACROSS_ROUTINES: true,
  RETIRED_ROUTINE_STILL_BOUND: false,
};

export const FINDING_DETAIL: Record<AttributionFinding, string> = {
  NO_WORKER_BOUND:
    'no worker is bound, so an arrival here resolves to nothing and cannot be credited',
  WORKER_DISABLED_OR_ARCHIVED:
    'the bound worker is disabled or archived, so every credential it holds is refused',
  WORKER_SHARED_ACROSS_ROUTINES:
    'the bound worker also serves other Routines of this account — the ordinary pooled shape',
  WORKER_SHARED_ACROSS_ACCOUNTS:
    'the bound worker also serves a Routine of a DIFFERENT account, so a credential cannot say ' +
    'which account a session came from',
  MULTIPLE_CLIENTS_ONE_WORKER:
    'more than one OAuth client has minted a token for this worker, so more than one connector ' +
    'authenticates as it and their sessions are indistinguishable',
  MULTIPLE_APPROVERS_ONE_WORKER:
    'more than one person approved a grant for this worker, so it is not one person’s capacity',
  NO_CREDENTIAL_EVER_MINTED:
    'no token has ever been minted for the bound worker, so nothing has authenticated as it yet',
  SECRET_SHARED_ACROSS_ROUTINES:
    'another Routine names the same deployment secret, so both fire with one bearer',
  TRIGGER_SHARED_ACROSS_ROUTINES: 'another Routine row carries the same trigger reference',
  BEARER_SHARED_ACROSS_ROUTINES:
    'another Routine registered a bearer with the same digest, so two rows are one surface',
  RETIRED_ROUTINE_STILL_BOUND:
    'this Routine is retired or quarantined and still names a worker',
};

/** `PROVEN` only when the credential identifies exactly one surface's account. */
export type AttributionStatus = 'PROVEN' | 'AMBIGUOUS' | 'UNVERIFIED' | 'UNBOUND';

export interface SurfaceAttribution {
  accountId: string;
  accountName: string;
  routineId: string;
  routineName: string;
  routineRef: string;
  routineState: string;
  secretName: string;
  /** First twelve characters of a digest already stored. Never a value. */
  bearerFingerprint: string | null;
  workerId: string | null;
  /** The neutral operational identity. Null only for a row written before labels existed. */
  workerLabel: string | null;
  /** The legacy operator handle. Never authorizes, never attributes; shown so a row is findable. */
  workerLegacyName: string | null;
  workerStatus: string | null;
  /** Distinct OAuth clients that have minted a token for the bound worker. */
  clientIds: string[];
  clientNames: string[];
  /** Distinct people who approved a grant for the bound worker, from the codes. */
  approverUserIds: string[];
  status: AttributionStatus;
  findings: AttributionFinding[];
}

export interface FleetAttributionReport {
  surfaces: SurfaceAttribution[];
  /** Workers that hold a credential and serve no registered Routine. */
  orphanWorkerIds: string[];
  /** One client minting for more than one worker — the reverse of the usual defect. */
  clientsSpanningWorkers: Array<{ clientId: string; workerIds: string[] }>;
  proven: number;
  ambiguous: number;
  unverified: number;
  unbound: number;
}

/* ------------------------------------------------------------------------- */
/* The decision                                                               */
/* ------------------------------------------------------------------------- */

function countBy<T>(items: readonly T[], key: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export function analyseAttribution(snapshot: AttributionSnapshot): FleetAttributionReport {
  const accountById = new Map(snapshot.accounts.map((a) => [a.id, a]));
  const workerById = new Map(snapshot.workers.map((w) => [w.id, w]));
  const clientByClientId = new Map(snapshot.clients.map((c) => [c.clientId, c]));

  // Which Routines, and which accounts, each worker is bound to.
  const routinesByWorker = new Map<string, FleetRoutine[]>();
  for (const routine of snapshot.routines) {
    if (!routine.workerId) continue;
    const list = routinesByWorker.get(routine.workerId) ?? [];
    list.push(routine);
    routinesByWorker.set(routine.workerId, list);
  }

  const clientsByWorker = new Map<string, Set<string>>();
  for (const token of snapshot.tokens) {
    const set = clientsByWorker.get(token.workerId) ?? new Set<string>();
    set.add(token.clientId);
    clientsByWorker.set(token.workerId, set);
  }

  const approversByWorker = new Map<string, Set<string>>();
  for (const code of snapshot.codes) {
    const set = approversByWorker.get(code.workerId) ?? new Set<string>();
    set.add(code.approvedByUserId);
    approversByWorker.set(code.workerId, set);
  }

  const secretCounts = countBy(snapshot.routines, (r) => r.tokenSecretName);
  const refCounts = countBy(snapshot.routines, (r) => r.routineRef);
  const digestCounts = countBy(snapshot.routines, (r) => r.tokenDigest);

  const surfaces: SurfaceAttribution[] = snapshot.routines.map((routine) => {
    const worker = routine.workerId ? (workerById.get(routine.workerId) ?? null) : null;
    const findings: AttributionFinding[] = [];

    if (!routine.workerId) {
      findings.push('NO_WORKER_BOUND');
    } else {
      if (!worker || worker.disabled || worker.archived) findings.push('WORKER_DISABLED_OR_ARCHIVED');
      const siblings = routinesByWorker.get(routine.workerId) ?? [];
      if (siblings.length > 1) findings.push('WORKER_SHARED_ACROSS_ROUTINES');
      const accounts = new Set(siblings.map((one) => one.accountId));
      if (accounts.size > 1) findings.push('WORKER_SHARED_ACROSS_ACCOUNTS');
      const clients = clientsByWorker.get(routine.workerId) ?? new Set<string>();
      if (clients.size > 1) findings.push('MULTIPLE_CLIENTS_ONE_WORKER');
      if (clients.size === 0) findings.push('NO_CREDENTIAL_EVER_MINTED');
      const approvers = approversByWorker.get(routine.workerId) ?? new Set<string>();
      if (approvers.size > 1) findings.push('MULTIPLE_APPROVERS_ONE_WORKER');
      if (routine.state === 'RETIRED' || routine.state === 'QUARANTINED') {
        findings.push('RETIRED_ROUTINE_STILL_BOUND');
      }
    }

    if ((secretCounts.get(routine.tokenSecretName) ?? 0) > 1) {
      findings.push('SECRET_SHARED_ACROSS_ROUTINES');
    }
    if ((refCounts.get(routine.routineRef) ?? 0) > 1) findings.push('TRIGGER_SHARED_ACROSS_ROUTINES');
    if (routine.tokenDigest && (digestCounts.get(routine.tokenDigest) ?? 0) > 1) {
      findings.push('BEARER_SHARED_ACROSS_ROUTINES');
    }

    const clients = [...(clientsByWorker.get(routine.workerId ?? '') ?? new Set<string>())].sort();
    const status: AttributionStatus = !routine.workerId
      ? 'UNBOUND'
      : findings.some((finding) => AMBIGUATES[finding])
        ? 'AMBIGUOUS'
        : clients.length === 0
          ? 'UNVERIFIED'
          : 'PROVEN';

    return {
      accountId: routine.accountId,
      accountName: accountById.get(routine.accountId)?.name ?? routine.accountId,
      routineId: routine.id,
      routineName: routine.name,
      routineRef: routine.routineRef,
      routineState: routine.state,
      secretName: routine.tokenSecretName,
      bearerFingerprint: routine.tokenDigest ? routine.tokenDigest.slice(0, 12) : null,
      workerId: routine.workerId,
      workerLabel: worker?.label ?? null,
      workerLegacyName: worker?.name ?? null,
      workerStatus: worker ? (worker.archived ? 'ARCHIVED' : worker.status) : null,
      clientIds: clients,
      clientNames: clients.map((id) => clientByClientId.get(id)?.clientName ?? id),
      approverUserIds: [...(approversByWorker.get(routine.workerId ?? '') ?? new Set<string>())].sort(),
      status,
      findings,
    };
  });

  const boundWorkers = new Set(snapshot.routines.map((r) => r.workerId).filter((id): id is string => id !== null));
  const orphanWorkerIds = [...clientsByWorker.keys()].filter((id) => !boundWorkers.has(id)).sort();

  const workersByClient = new Map<string, Set<string>>();
  for (const token of snapshot.tokens) {
    const set = workersByClient.get(token.clientId) ?? new Set<string>();
    set.add(token.workerId);
    workersByClient.set(token.clientId, set);
  }
  const clientsSpanningWorkers = [...workersByClient.entries()]
    .filter(([, workers]) => workers.size > 1)
    .map(([clientId, workers]) => ({ clientId, workerIds: [...workers].sort() }))
    .sort((a, b) => a.clientId.localeCompare(b.clientId));

  return {
    surfaces,
    orphanWorkerIds,
    clientsSpanningWorkers,
    proven: surfaces.filter((s) => s.status === 'PROVEN').length,
    ambiguous: surfaces.filter((s) => s.status === 'AMBIGUOUS').length,
    unverified: surfaces.filter((s) => s.status === 'UNVERIFIED').length,
    unbound: surfaces.filter((s) => s.status === 'UNBOUND').length,
  };
}

export async function auditFleetAttribution(): Promise<FleetAttributionReport> {
  return analyseAttribution(await fleetAttributionSnapshot());
}

/* ------------------------------------------------------------------------- */
/* One session, traced end to end                                             */
/* ------------------------------------------------------------------------- */

export interface SessionTrace {
  sessionRef: string;
  workerId: string;
  workerLabel: string | null;
  workerLegacyName: string | null;
  routineId: string;
  routineRef: string | null;
  routineName: string | null;
  accountId: string;
  accountName: string | null;
  /** The NAME of the deployment secret this surface fires with, and a digest prefix. */
  secretName: string | null;
  bearerFingerprint: string | null;
  binId: string;
  leaseGeneration: number;
  /** The packet the bin belongs to, where it has one. */
  orchestrationId: string | null;
  /** When Brain first observed this credential arriving. */
  observedAt: string;
  /** When the bin was actually handed over. */
  claimedAt: string | null;
  /** Brain's own record of the fire that produced this session. */
  firedAt: string | null;
  firedSessionRef: string | null;
  /** The credential itself, by id and client. Never a value. */
  credential: {
    tokenId: string;
    kind: string;
    clientId: string;
    clientName: string | null;
    issuedAt: string;
    expiresAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    /** Minted by a refresh rather than by an authorization code. */
    parentTokenId: string | null;
  } | null;
  /** Every person who has ever approved a grant for this worker. Audit only. */
  approverUserIds: string[];
  /** Whether this trace resolves to one surface, and why not when it does not. */
  status: AttributionStatus;
  findings: AttributionFinding[];
}

/**
 * Given a `worker_session` id, say exactly which registered Routine and which
 * credential produced it.
 *
 * Every link is a row Brain wrote itself: the session row is written at arrival
 * from the dispatch row Brain sent, the dispatch row names the Routine Brain
 * chose, and the Routine row names the account and the deployment secret. The
 * only thing taken from the caller is the id being asked about.
 */
export async function traceWorkerSession(sessionRef: string): Promise<SessionTrace | null> {
  const session = await getWorkerSession(sessionRef);
  if (!session) return null;

  const [worker, routine, account, token, bin] = await Promise.all([
    getWorker(session.workerId),
    getRoutine(session.routineId),
    getAccount(session.accountId),
    getToken(sessionRef),
    getBin(session.binId),
  ]);

  const clients = await listClients();
  const clientName = token
    ? (clients.find((one) => one.clientId === token.clientId)?.clientName ?? null)
    : null;

  const dispatches = await listDispatchesForBin(session.binId);
  const fired =
    dispatches.find(
      (one) => one.leaseGeneration === session.leaseGeneration && one.sentAt !== null,
    ) ?? null;

  const events = await listBinEvents(session.binId, 200);
  const assigned =
    events.find(
      (event) => event.eventType === 'BIN_ASSIGNED' && event.leaseGeneration === session.leaseGeneration,
    ) ?? events.find((event) => event.eventType === 'BIN_ASSIGNED') ?? null;

  // The same analysis the fleet report runs, narrowed to this surface — so a
  // trace and the audit can never disagree about whether a surface is proven.
  const report = analyseAttribution(await fleetAttributionSnapshot());
  const surface = report.surfaces.find((one) => one.routineId === session.routineId) ?? null;

  return {
    sessionRef: session.sessionRef,
    workerId: session.workerId,
    workerLabel: worker?.label ?? null,
    workerLegacyName: worker?.name ?? null,
    routineId: session.routineId,
    routineRef: routine?.routineRef ?? null,
    routineName: routine?.name ?? null,
    accountId: session.accountId,
    accountName: account?.name ?? null,
    secretName: routine?.tokenSecretName ?? null,
    bearerFingerprint: routine?.tokenDigest ? routine.tokenDigest.slice(0, 12) : null,
    binId: session.binId,
    leaseGeneration: session.leaseGeneration,
    orchestrationId: bin?.orchestrationId ?? null,
    observedAt: session.observedAt,
    claimedAt: assigned?.at ?? null,
    firedAt: fired?.sentAt ?? null,
    firedSessionRef: fired?.sessionRef ?? null,
    credential: token
      ? {
          tokenId: token.id,
          kind: token.kind,
          clientId: token.clientId,
          clientName,
          issuedAt: token.createdAt,
          expiresAt: token.expiresAt,
          lastUsedAt: token.lastUsedAt,
          revokedAt: token.revokedAt,
          parentTokenId: token.parentTokenId,
        }
      : null,
    approverUserIds: surface?.approverUserIds ?? [],
    status: surface?.status ?? 'UNVERIFIED',
    findings: surface?.findings ?? [],
  };
}
