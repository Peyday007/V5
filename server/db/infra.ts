/**
 * What a database failure *is*, and the control plane that must survive one.
 *
 * Two things live here because every layer above `server/db/` needs both and
 * neither may depend on the services that use them.
 *
 * **One classification.** A credential that could not be *checked* is a
 * different fact from a credential that was checked and refused, and for a long
 * time Brain said both in one sentence: an MCP request whose authentication
 * threw on a pool timeout was answered `503 "Not authorized."`, so a connector
 * Claude held perfectly well read — to Claude, to the worker and to the person
 * notified — as unauthorized, and whoami failed in exactly those words during
 * every Supabase hiccup. `classifyInfraFailure` is the one place that decides
 * *Brain's database could not answer*, and every surface that has to tell the
 * two apart asks it rather than matching strings of its own.
 *
 * **One control plane.** Authenticating a credential, rotating a refresh token,
 * answering whoami and recording that a session arrived are a handful of
 * indexed lookups each, and they used to queue behind every research audit,
 * factory tick and operator read for the same ten connections. Under load the
 * last connection went to whichever caller asked first, and a slow archive
 * query could make a valid connector look dead. `asControlPlane` marks an async
 * context whose statements the Postgres adapter sends to a small pool of its
 * own, carved out of the same ceiling rather than added to it — so the pooler's
 * shared client limit is not spent any faster, and heavy work is what slows
 * down instead.
 *
 * Counters are in memory and per process. They are a reading of *this*
 * process's experience, which is the thing the operator report needs; the
 * durable record of an incident is `infra_incidents`, written by
 * `services/infra/incidents.ts` from the listener below.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/* ------------------------------------------------------------------------- */
/* Classification                                                            */
/* ------------------------------------------------------------------------- */

export type InfraFailureKind =
  /** Brain's own pool had no connection to hand out in time. */
  | 'POOL_CHECKOUT_TIMEOUT'
  /** The pooler in front of the database accepted us and could not get a backend. */
  | 'POOLER_CHECKOUT_TIMEOUT'
  /** The pooler refused a new client outright (session-mode client limit). */
  | 'POOLER_REFUSED'
  /** A statement ran past `statement_timeout` (SQLSTATE 57014). */
  | 'STATEMENT_TIMEOUT'
  /** The connection broke, or could not be opened, or the server is going away. */
  | 'CONNECTION_LOST'
  /** The database or its storage API answered that it is unavailable. */
  | 'DATABASE_UNAVAILABLE';

/** SQLSTATEs that say the server, not the statement, is the problem. */
const UNAVAILABLE_SQLSTATES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01', // protocol_violation: what a pooler dropping a session mid-flight looks like
]);

/**
 * Socket errnos — but only on the error itself, never found by walking a
 * `cause`. `fetch` wraps exactly these in `TypeError('fetch failed')`, and a
 * storage, forge or Routine-fire call failing on the network is not the
 * database: reporting it to a worker as "Brain's database is busy" would be the
 * same wrong sentence this module exists to stop, one subsystem along.
 */
const CONNECTION_ERRNOS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE']);

function textOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

/**
 * Whether this error means Brain's database could not answer, and which way.
 *
 * Null for everything else — a constraint violation, a syntax error, a bug, a
 * failed HTTP call to some other service — because calling those
 * "infrastructure" would hide a defect behind a retry. The patterns are the
 * driver's and the pooler's own sentences, anchored, not words that could
 * appear in any message. Walks `cause` for the database's own shapes only,
 * because the adapter wraps a pool timeout in a sentence of its own.
 */
export function classifyInfraFailure(error: unknown, depth = 0): InfraFailureKind | null {
  if (!error || typeof error !== 'object' || depth > 3) return null;
  const text = textOf(error);
  const code = (error as { code?: unknown }).code;

  if ('brainPool' in error) return 'POOL_CHECKOUT_TIMEOUT';
  if (text === 'timeout exceeded when trying to connect') return 'POOL_CHECKOUT_TIMEOUT';
  if (text.includes('(ECHECKOUTTIMEOUT)')) return 'POOLER_CHECKOUT_TIMEOUT';
  if (text.includes('(EMAXCONNSESSION)')) return 'POOLER_REFUSED';
  if (code === '57014' || /canceling statement due to statement timeout/.test(text)) return 'STATEMENT_TIMEOUT';
  if (typeof code === 'string' && UNAVAILABLE_SQLSTATES.has(code)) return 'DATABASE_UNAVAILABLE';
  if (
    /^Connection terminated|^Client has encountered a connection error|^The database connection has been closed|server closed the connection unexpectedly|^Connection ended unexpectedly|SSL connection has been closed unexpectedly|^Query read timeout/.test(
      text,
    )
  ) {
    return 'CONNECTION_LOST';
  }
  if (/configured for Postgres but could not reach/.test(text)) return 'DATABASE_UNAVAILABLE';
  if (depth === 0 && typeof code === 'string' && CONNECTION_ERRNOS.has(code) && text !== 'fetch failed') {
    return 'CONNECTION_LOST';
  }
  if (text === 'fetch failed') return null;

  const cause = (error as { cause?: unknown }).cause;
  return cause ? classifyInfraFailure(cause, depth + 1) : null;
}

/* ------------------------------------------------------------------------- */
/* The control plane                                                         */
/* ------------------------------------------------------------------------- */

export type WorkloadClass = 'CONTROL' | 'WORKLOAD';

const workloadClass = new AsyncLocalStorage<WorkloadClass>();

/**
 * Run `fn` on the control plane: authentication, token rotation, whoami and
 * session arrival. Nothing heavy belongs here — a control-plane caller that
 * scanned the archive would starve the very thing this exists to protect.
 */
export function asControlPlane<T>(fn: () => Promise<T>): Promise<T> {
  return workloadClass.run('CONTROL', fn);
}

/** Leave the control plane for the work a request goes on to do. */
export function asWorkload<T>(fn: () => Promise<T>): Promise<T> {
  return workloadClass.run('WORKLOAD', fn);
}

export function currentWorkloadClass(): WorkloadClass {
  return workloadClass.getStore() ?? 'WORKLOAD';
}

/**
 * How many of a pool ceiling the control plane is given.
 *
 * Carved out of the ceiling, never added to it: the app's total against the
 * pooler is unchanged. Below four there is nothing to carve — the operator
 * scripts run on one connection and the release harness on two, and splitting
 * those would halve work that is deliberately sequential.
 */
export function controlPlaneShare(poolSize: number): number {
  const raw = process.env['BRAIN_DATABASE_CONTROL_POOL_SIZE'];
  const asked = raw && /^\d+$/.test(raw) ? Number(raw) : 2;
  if (poolSize < 4) return 0;
  return Math.max(0, Math.min(asked, Math.floor(poolSize / 2)));
}

/* ------------------------------------------------------------------------- */
/* Counters and the incident listener                                        */
/* ------------------------------------------------------------------------- */

export interface InfraFailureObservation {
  kind: InfraFailureKind;
  /** Where it was felt: a request path, a tool, `pool`. Never a credential. */
  surface: string;
  workloadClass: WorkloadClass;
  at: string;
}

const counts = new Map<string, number>();
const databaseCounts = new Map<string, number>();

/**
 * Count a failure the adapter felt, without making an incident of it.
 *
 * The adapter sees every failure — including the incident recorder's own
 * writes, which must never feed back into the recorder — and does not know
 * which request it belonged to. The incident is the caller's to note, with the
 * surface it was felt on; this is the raw count the report prints beside it.
 */
export function countDatabaseFailure(kind: InfraFailureKind): void {
  const key = `${currentWorkloadClass()}:${kind}`;
  databaseCounts.set(key, (databaseCounts.get(key) ?? 0) + 1);
}

export function databaseFailureCounts(): Record<string, number> {
  return Object.fromEntries([...databaseCounts.entries()].sort());
}
const listeners: ((observation: InfraFailureObservation) => void)[] = [];
const recent: InfraFailureObservation[] = [];
const RECENT_LIMIT = 500;

/**
 * Say that an infrastructure failure was felt.
 *
 * Synchronous and cannot throw: it is called from inside the failure it is
 * reporting, and a report that could fail would replace the failure.
 */
export function noteInfraFailure(kind: InfraFailureKind, surface: string, at = new Date()): void {
  const observation: InfraFailureObservation = {
    kind,
    surface,
    workloadClass: currentWorkloadClass(),
    at: at.toISOString(),
  };
  const key = `${observation.workloadClass}:${kind}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  recent.push(observation);
  if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
  for (const listener of listeners) {
    try {
      listener(observation);
    } catch {
      // A listener is a convenience; the count above is the reading.
    }
  }
}

export function onInfraFailure(listener: (observation: InfraFailureObservation) => void): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}

/** `CONTROL:STATEMENT_TIMEOUT → 3`, and so on, since this process started. */
export function infraFailureCounts(): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort());
}

export function recentInfraFailures(sinceIso?: string): InfraFailureObservation[] {
  return sinceIso ? recent.filter((o) => o.at >= sinceIso) : [...recent];
}

/** Tests only. */
export function resetInfraCounters(): void {
  counts.clear();
  databaseCounts.clear();
  recent.length = 0;
}

/* ------------------------------------------------------------------------- */
/* Latency                                                                   */
/* ------------------------------------------------------------------------- */

const latencies = new Map<string, number[]>();
const LATENCY_SAMPLES = 500;

/** Record how long a control-plane operation took, in milliseconds. */
export function noteLatency(operation: string, ms: number): void {
  const samples = latencies.get(operation) ?? [];
  samples.push(ms);
  if (samples.length > LATENCY_SAMPLES) samples.splice(0, samples.length - LATENCY_SAMPLES);
  latencies.set(operation, samples);
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export function latencySummary(): Record<string, LatencySummary> {
  const out: Record<string, LatencySummary> = {};
  for (const [operation, samples] of latencies) {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    out[operation] = { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
  }
  return out;
}

export function resetLatencies(): void {
  latencies.clear();
}
