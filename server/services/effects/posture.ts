/**
 * How Brain operates while part of the outside world is down (CONT-35, S-0485).
 *
 * `continuity.ts` answers S-0484 for one effect at a time: what was attempted,
 * what may have been accepted, what is confirmed and what is unknown. This
 * module answers S-0485 for the project as a whole, from the same rows
 * (`idempotency_operations`, `effect_attempts`, through
 * `server/repos/idempotency.ts`) — no table, store, scheduler or retry loop of
 * its own (§10.3, §20.4):
 *
 * - **Which dependencies are down, and how.** `dependencyHealth` reads each
 *   namespace's recent definite outcomes. Repeated `DEPENDENCY_UNAVAILABLE` /
 *   `TIMEOUT` refusals are an OUTAGE — a recoverable operational failure, the
 *   circuit is open and the same provider is not hammered. A `NOT_AUTHORIZED`
 *   refusal on the latest outcome is CONSTRAINED — an account suspended or a
 *   permission withdrawn, which no retry under that account can legitimately
 *   undo. Everything else keeps running: a namespace that is not down is
 *   listed as unaffected and its work continues.
 *
 * - **What to do about a commitment that needs a down dependency.**
 *   `planContinuation` decides, and records why it applied or skipped each
 *   alternative (the approved reading of S-0484/S-0485: applied when the case
 *   needs it, with the reason on record). It never switches while the original
 *   may have accepted the effect — a supplier reassignment or a channel change
 *   over an unsettled send is exactly how a commitment is made twice. It moves
 *   only to an alternative somebody declared permitted (and, for a supplier,
 *   contractually workable); an unknown is never read as a yes (invariant 39).
 *   A suspended channel is never "bypassed" by another account on the same
 *   channel. A time-critical commitment that cannot move is escalated rather
 *   than left to a backoff that would outlast it. No kind of dependency,
 *   channel, supplier or industry is a whitelist here (R01-A1): the
 *   alternatives are whatever the caller's records name.
 *
 * - **A degraded but truthful interface.** `continuityPosture` is what the
 *   project route serves: the dependencies that are down, the work that is
 *   unaffected, what is known and what remains uncertain. When the ledger
 *   itself cannot be read the route says so, with status 503, instead of an
 *   empty account that would read as "nothing in doubt".
 *
 * - **Verified backup and restore of the commitment ledger.**
 *   `continuitySnapshot` writes the project's effect ledger as a canonical,
 *   checksummed document, and `verifyContinuityRestore` proves a copy restores:
 *   the checksum holds, every operation re-classifies from the restored rows to
 *   the class it had when it was taken, and nothing the snapshot held as a
 *   commitment is missing from (or regressed in) the live ledger. The drill's
 *   verdict is appended to `project_events` (invariant 3). The database itself
 *   is backed up by its owner — `server/db/migrate.ts` before every local
 *   migration, the managed provider in cloud mode; this is the restore check on
 *   the part of it that holds money and obligations.
 *
 * `CONTINUITY_CLAUSE_OWNERS` names the owner of every S-0485 clause, so the
 * program's probe can read each from production rows rather than from prose.
 */
import crypto from 'node:crypto';
import { listAttempts, listOperations, operationNow } from '../../repos/idempotency.ts';
import { recordEvent } from '../../repos/events.ts';
import { getDb } from '../../db/database.ts';
import { classifyOperation, effectContinuityAccount, type ContinuityAccount, type ContinuityClass } from './continuity.ts';
import type { EffectAttempt, EffectFailureCategory, IdempotencyOperation } from '../../domain/types.ts';

/* ------------------------------------------------------------------------- */
/* Which clause is owned where                                                */
/* ------------------------------------------------------------------------- */

export interface ClauseOwner {
  clause: string;
  owner: string;
  /** What reads it from production rows. */
  reader: string;
}

export const CONTINUITY_CLAUSE_OWNERS: readonly ClauseOwner[] = [
  {
    clause: 'continue unaffected work',
    owner: 'server/services/effects/posture.ts (dependencyHealth, continuityPosture.unaffected)',
    reader: 'GET /api/projects/:projectId/continuity',
  },
  {
    clause: 'offer a degraded but truthful interface',
    owner: 'server/routes/operations.ts (GET /projects/:projectId/continuity)',
    reader: 'GET /api/projects/:projectId/continuity — 503 with what is unknown when the ledger cannot be read',
  },
  {
    clause: 'reroute eligible research to another model/provider',
    owner: 'server/services/freeLane/worker.ts (unfitNow and the reroute of a model whose items mostly failed)',
    reader: 'free-lane work item rows',
  },
  {
    clause: 'change to a permitted acquisition channel when an account is suspended',
    owner: 'server/services/effects/posture.ts (planContinuation: CONSTRAINED → REROUTE to a permitted, different channel), applied before every send by server/services/cash/perform.ts (performCommercialAction → decideCommitmentContinuation)',
    reader: 'NOT_AUTHORIZED refusals in idempotency_operations; cash_events CASH_CONTINUATION_DECIDED',
  },
  {
    clause: 'switch suppliers if the original fails and an alternative is contractually workable',
    owner: 'server/services/effects/posture.ts (planContinuation: contractuallyWorkable must be declared true), applied before every send by server/services/cash/perform.ts (performCommercialAction → decideCommitmentContinuation)',
    reader: 'idempotency_operations per supplier namespace; cash_events CASH_CONTINUATION_DECIDED',
  },
  {
    clause: 'preserve time-critical customer commitments',
    owner: 'server/services/effects/posture.ts (planContinuation: ESCALATE_TIME_CRITICAL), applied before every send by server/services/cash/perform.ts (performCommercialAction → decideCommitmentContinuation, the opportunity deadline)',
    reader: 'cash_events CASH_CONTINUATION_DECIDED; the OPEN cash_needs row it raises (request_key continuation:<opportunity>:<action>:ESCALATE_TIME_CRITICAL); continuity.ts continuation --project ID --namespace NS',
  },
  {
    clause: 'backup/restoration procedures for essential data and configurations, with verified restore behavior',
    owner: 'server/db/migrate.ts (backup before migration) + server/services/effects/posture.ts (continuitySnapshot, verifyContinuityRestore)',
    reader: 'project_events RECONCILE_COMPLETED with payload.kind CONTINUITY_RESTORE_DRILL',
  },
  {
    clause: 'distinguish recoverable operational failure from an external constraint no alternate service can legitimately bypass',
    owner: 'server/services/effects/posture.ts (OUTAGE vs CONSTRAINED; WAIT_RECOVERABLE vs EXTERNAL_CONSTRAINT)',
    reader: 'failure_category on idempotency_operations; the OPEN cash_needs row an EXTERNAL_CONSTRAINT continuation raises',
  },
];

/* ------------------------------------------------------------------------- */
/* Dependency health                                                          */
/* ------------------------------------------------------------------------- */

export type DependencyStatus = 'HEALTHY' | 'OUTAGE' | 'CONSTRAINED' | 'UNKNOWN';

export interface DependencyHealth {
  namespace: string;
  status: DependencyStatus;
  /** Recoverable means waiting (or another permitted provider) can get it done; a constraint cannot be retried past. */
  recoverable: boolean | null;
  reason: string;
  /** Definite outcomes read, newest first, within the window. */
  observed: number;
  lastOutcomeAt: string | null;
}

/** Consecutive unavailability refusals that open the circuit. */
export const OUTAGE_THRESHOLD = 3;
/** How far back an outcome still describes the dependency now. */
export const HEALTH_WINDOW_MS = 30 * 60_000;

const UNAVAILABLE: ReadonlySet<EffectFailureCategory> = new Set(['DEPENDENCY_UNAVAILABLE', 'TIMEOUT']);

/** One definite outcome on one namespace: success, or a refusal with its category. */
export interface NamespaceOutcome {
  at: string;
  succeeded: boolean;
  category: EffectFailureCategory | null;
}

/** The definite outcomes of one operation's attempts. An unknown is not an outcome (invariant 26). */
export function outcomesOf(operation: IdempotencyOperation, attempts: readonly EffectAttempt[]): NamespaceOutcome[] {
  const out: NamespaceOutcome[] = [];
  for (const attempt of attempts) {
    if (attempt.phase === 'INTENT' || attempt.endedAt === null) continue;
    if (attempt.outcome === 'SUCCEEDED') out.push({ at: attempt.endedAt, succeeded: true, category: null });
    else if (attempt.outcome === 'FAILED') {
      // The category is the operation's; it describes its latest refusal.
      out.push({ at: attempt.endedAt, succeeded: false, category: operation.failureCategory });
    }
  }
  return out;
}

/** Pure: the health of one namespace from its definite outcomes. */
export function judgeDependency(namespace: string, outcomes: readonly NamespaceOutcome[], now: string = operationNow()): DependencyHealth {
  const since = new Date(Date.parse(now) - HEALTH_WINDOW_MS).toISOString();
  const recent = outcomes.filter((o) => o.at >= since).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const latest = recent[0] ?? null;
  const base = { namespace, observed: recent.length, lastOutcomeAt: latest?.at ?? null };
  if (!latest) {
    return { ...base, status: 'UNKNOWN', recoverable: null, reason: 'no definite outcome in the last 30 minutes; nothing says it is up or down' };
  }
  if (latest.succeeded) return { ...base, status: 'HEALTHY', recoverable: null, reason: `its latest outcome (${latest.at}) succeeded` };
  if (latest.category === 'NOT_AUTHORIZED') {
    return {
      ...base,
      status: 'CONSTRAINED',
      recoverable: false,
      reason: 'its latest refusal was NOT_AUTHORIZED: the account is suspended or its permission withdrawn, and no retry under it can legitimately get past that',
    };
  }
  let run = 0;
  for (const outcome of recent) {
    if (outcome.succeeded || outcome.category === null || !UNAVAILABLE.has(outcome.category)) break;
    run += 1;
  }
  if (run >= OUTAGE_THRESHOLD) {
    return {
      ...base,
      status: 'OUTAGE',
      recoverable: true,
      reason:
        `${run} consecutive refusals said it was unavailable: a recoverable outage, so the circuit is open and no new attempt is sent to it ` +
        `(runExternalEffect and runIdempotentRequest withhold it) until those refusals are more than ${HEALTH_WINDOW_MS / 60_000} minutes old, when the next attempt probes it again`,
    };
  }
  return { ...base, status: 'HEALTHY', recoverable: null, reason: `its latest outcome was refused (${latest.category ?? 'no category'}) but not often enough to call it down` };
}

/** The health of every namespace the project has used, read from the rows. */
export async function dependencyHealth(projectId: string, now: string = operationNow()): Promise<DependencyHealth[]> {
  const operations = await listOperations(projectId, { limit: 500 });
  const byNamespace = new Map<string, NamespaceOutcome[]>();
  for (const operation of operations) {
    const list = byNamespace.get(operation.namespace) ?? [];
    list.push(...outcomesOf(operation, await listAttempts(operation.id)));
    byNamespace.set(operation.namespace, list);
  }
  return [...byNamespace.entries()].map(([ns, outcomes]) => judgeDependency(ns, outcomes, now)).sort((a, b) => a.namespace.localeCompare(b.namespace));
}

/**
 * The health of one namespace, read from the definite outcomes of its attempts
 * inside the health window only.
 *
 * This is what a send path asks before an attempt leaves Brain, so it reads
 * one namespace's recent attempts in one statement rather than the project's
 * whole ledger the way `dependencyHealth` does for the posture page. Same rows,
 * same judge: the page and the send path cannot disagree about whether a
 * dependency is down.
 */
export async function namespaceHealth(projectId: string, namespace: string, now: string = operationNow()): Promise<DependencyHealth> {
  const since = new Date(Date.parse(now) - HEALTH_WINDOW_MS).toISOString();
  const rows = await getDb().all<{ ended_at: string; outcome: string | null; failure_category: string | null }>(
    `SELECT a.ended_at AS ended_at, a.outcome AS outcome, o.failure_category AS failure_category
       FROM effect_attempts a
       JOIN idempotency_operations o ON o.id = a.operation_id
      WHERE o.project_id = ? AND o.namespace = ?
        AND a.phase <> 'INTENT' AND a.ended_at IS NOT NULL AND a.ended_at >= ?
        AND a.outcome IN ('SUCCEEDED', 'FAILED')
      ORDER BY a.ended_at DESC
      LIMIT 50`,
    [projectId, namespace, since],
  );
  const outcomes: NamespaceOutcome[] = rows.map((row) => ({
    at: row.ended_at,
    succeeded: row.outcome === 'SUCCEEDED',
    category: row.outcome === 'SUCCEEDED' ? null : ((row.failure_category as EffectFailureCategory | null) ?? null),
  }));
  return judgeDependency(namespace, outcomes, now);
}

/**
 * The circuit breaker every send path consults before a new attempt leaves
 * Brain: the namespace's health when it is an OUTAGE, otherwise null.
 *
 * Only an OUTAGE is withheld. A CONSTRAINED namespace's next attempt is left
 * to the provider, which refuses it NOT_AUTHORIZED again without effect, and
 * an UNKNOWN or HEALTHY one is sent. A withheld attempt opens no attempt row,
 * so it is not itself an outcome: the circuit closes because the refusals that
 * opened it age out of the window, and the attempt after that is the probe.
 * A read that fails withholds nothing — the circuit is a courtesy to a
 * provider that is down, and a ledger that cannot be read is not evidence
 * that it is.
 */
export async function openCircuit(projectId: string, namespace: string, now: string = operationNow()): Promise<DependencyHealth | null> {
  try {
    const health = await namespaceHealth(projectId, namespace, now);
    return health.status === 'OUTAGE' ? health : null;
  } catch {
    return null;
  }
}

/** What a send that the open circuit withheld says about itself. */
export function withheldReason(health: Pick<DependencyHealth, 'namespace' | 'reason'>): string {
  return `Not sent: ${health.namespace} is down and its circuit is open (${health.reason}). Nothing left Brain, so nothing can have happened.`;
}

/* ------------------------------------------------------------------------- */
/* Continuing a commitment                                                    */
/* ------------------------------------------------------------------------- */

export interface ContinuationAlternative {
  /** The namespace (provider, channel, supplier) the commitment could move to. */
  namespace: string;
  /** The channel it reaches people through; two accounts on one channel share it. Null when not a channel. */
  channel: string | null;
  /** Somebody established Brain may use it for this commitment. Null: nobody said. */
  permitted: boolean | null;
  /** For a supplier: the contract allows moving the work there. Null: nobody said. */
  contractuallyWorkable: boolean | null;
  /** Whether the contract question applies at all (a supplier) or not (a research provider). */
  requiresContract: boolean;
  status: DependencyStatus;
}

export interface ContinuationInput {
  namespace: string;
  /** The channel the original reaches people through, when it is one. */
  channel: string | null;
  health: Pick<DependencyHealth, 'status' | 'reason'>;
  /** Effects for this commitment whose outcome is not settled (MAY_HAVE_BEEN_ACCEPTED or UNKNOWN). */
  unsettled: number;
  /** The commitment has a deadline a backoff could outlast. */
  timeCritical: boolean;
  alternatives: readonly ContinuationAlternative[];
}

export type ContinuationAction =
  | 'PROCEED'
  | 'HOLD_RECONCILE'
  | 'REROUTE'
  | 'WAIT_RECOVERABLE'
  | 'ESCALATE_TIME_CRITICAL'
  | 'EXTERNAL_CONSTRAINT';

export interface ContinuationDecision {
  action: ContinuationAction;
  /** The alternative moved to, for REROUTE. */
  to: string | null;
  reason: string;
  /** Every alternative not taken, and why — the record of when the rule was skipped. */
  skipped: { namespace: string; why: string }[];
}

function whyNot(input: ContinuationInput, alt: ContinuationAlternative): string | null {
  if (alt.namespace === input.namespace) return 'it is the dependency that is down';
  if (alt.permitted !== true) return alt.permitted === false ? 'it is not permitted for this commitment' : 'nobody has said it is permitted, and an unknown is never a yes';
  if (alt.requiresContract && alt.contractuallyWorkable !== true) {
    return alt.contractuallyWorkable === false ? 'the contract does not allow moving the work there' : 'nobody has established the contract allows it, and an unknown is never a yes';
  }
  if (input.health.status === 'CONSTRAINED' && input.channel !== null && alt.channel === input.channel) {
    return 'it is another account on the suspended channel, which would bypass the constraint rather than respect it';
  }
  if (alt.status === 'OUTAGE' || alt.status === 'CONSTRAINED') return `it is itself ${alt.status === 'OUTAGE' ? 'down' : 'constrained'}`;
  return null;
}

/**
 * Pure: what to do with one commitment whose dependency may be down. The
 * decision and every skipped alternative carry their reason, so the record
 * says when each part of S-0485 was applied and when it was not.
 */
export function planContinuation(input: ContinuationInput): ContinuationDecision {
  if (input.unsettled > 0) {
    return {
      action: 'HOLD_RECONCILE',
      to: null,
      reason: `${input.unsettled} effect(s) for this commitment may already have been accepted; it is reconciled with the outside world before it is sent again or moved anywhere, so nothing is done twice`,
      skipped: input.alternatives.map((a) => ({ namespace: a.namespace, why: 'not considered while the original is unsettled' })),
    };
  }
  if (input.health.status === 'HEALTHY' || input.health.status === 'UNKNOWN') {
    return { action: 'PROCEED', to: null, reason: `${input.namespace} is not known to be down (${input.health.reason}); the work continues where it is`, skipped: [] };
  }
  const skipped: { namespace: string; why: string }[] = [];
  let chosen: ContinuationAlternative | null = null;
  for (const alt of input.alternatives) {
    const why = whyNot(input, alt);
    if (why === null && chosen === null) chosen = alt;
    else skipped.push({ namespace: alt.namespace, why: why ?? 'an earlier eligible alternative was chosen' });
  }
  if (chosen) {
    return {
      action: 'REROUTE',
      to: chosen.namespace,
      reason: `${input.namespace} is ${input.health.status === 'OUTAGE' ? 'down' : 'constrained'} (${input.health.reason}); ${chosen.namespace} is permitted${chosen.requiresContract ? ' and contractually workable' : ''}, so the commitment moves there`,
      skipped,
    };
  }
  if (input.timeCritical) {
    return {
      action: 'ESCALATE_TIME_CRITICAL',
      to: null,
      reason: `${input.namespace} is ${input.health.status === 'OUTAGE' ? 'down' : 'constrained'} and no permitted alternative exists; the commitment has a deadline a wait could miss, so a person is told now`,
      skipped,
    };
  }
  if (input.health.status === 'OUTAGE') {
    return {
      action: 'WAIT_RECOVERABLE',
      to: null,
      reason:
        `${input.namespace} is down, which is recoverable; while the circuit is open every new attempt on it is withheld unsent, ` +
        `the next attempt after the refusals age out probes it again, and unaffected work continues`,
      skipped,
    };
  }
  return {
    action: 'EXTERNAL_CONSTRAINT',
    to: null,
    reason: `${input.namespace} refused for good (${input.health.reason}) and no permitted alternative exists; this is an external constraint no other service may be used to get past`,
    skipped,
  };
}

/** A deadline nearer than this is one a backoff could outlast. */
export const TIME_CRITICAL_WINDOW_MS = 72 * 60 * 60_000;

/** Pure: whether a commitment's deadline is near enough (or past) that waiting out an outage could miss it. */
export function isTimeCritical(deadline: string | null, now: string = operationNow()): boolean {
  if (!deadline) return false;
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) return false;
  return at - Date.parse(now) <= TIME_CRITICAL_WINDOW_MS;
}

const UNSETTLED_CLASSES: ReadonlySet<ContinuityClass> = new Set(['MAY_HAVE_BEEN_ACCEPTED', 'UNKNOWN']);

export interface CommitmentContinuationInput {
  projectId: string;
  /** The namespace the commitment would be performed through. */
  namespace: string;
  channel: string | null;
  /** The operations that belong to this commitment and are not the attempt being made now (that one reconciles itself under its own key). */
  otherAttempt: (operation: IdempotencyOperation) => boolean;
  deadline: string | null;
  /** Alternatives the caller's records name; none named is none, never an invented one (R01-A1, invariant 39). */
  alternatives?: readonly ContinuationAlternative[];
  now?: string;
}

export interface CommitmentContinuation extends ContinuationDecision {
  namespace: string;
  health: DependencyHealth;
  unsettled: number;
  timeCritical: boolean;
}

/**
 * The production reading of `planContinuation` for one commitment (S-0485):
 * the dependency's health and the commitment's unsettled effects are read from
 * the same ledger rows `dependencyHealth` and `effectContinuityAccount` read,
 * the deadline decides whether it is time-critical, and the pure decision is
 * returned with what it was decided from. The caller acts on it — the
 * commercial send path refuses rather than hammering an outage, bypassing a
 * suspended account or resending over an unsettled effect — and records it.
 */
export async function decideCommitmentContinuation(input: CommitmentContinuationInput): Promise<CommitmentContinuation> {
  const now = input.now ?? operationNow();
  const operations = (await listOperations(input.projectId, { limit: 500 })).filter((op) => op.namespace === input.namespace);
  const outcomes: NamespaceOutcome[] = [];
  let unsettled = 0;
  for (const operation of operations) {
    const attempts = await listAttempts(operation.id);
    outcomes.push(...outcomesOf(operation, attempts));
    if (input.otherAttempt(operation) && UNSETTLED_CLASSES.has(classifyOperation(operation, attempts, now).class)) unsettled += 1;
  }
  const health = judgeDependency(input.namespace, outcomes, now);
  const timeCritical = isTimeCritical(input.deadline, now);
  const decision = planContinuation({
    namespace: input.namespace,
    channel: input.channel,
    health,
    unsettled,
    timeCritical,
    alternatives: input.alternatives ?? [],
  });
  return { ...decision, namespace: input.namespace, health, unsettled, timeCritical };
}

/* ------------------------------------------------------------------------- */
/* The degraded but truthful interface                                        */
/* ------------------------------------------------------------------------- */

export interface ContinuityPosture {
  projectId: string;
  at: string;
  /** True when any dependency is down or constrained. */
  degraded: boolean;
  dependencies: DependencyHealth[];
  /** Namespaces whose work continues untouched. */
  unaffected: string[];
  totals: ContinuityAccount['totals'];
  unsettled: number;
  known: string[];
  uncertain: string[];
}

export async function continuityPosture(projectId: string, now: string = operationNow()): Promise<ContinuityPosture> {
  const [account, dependencies] = await Promise.all([effectContinuityAccount(projectId), dependencyHealth(projectId, now)]);
  const down = dependencies.filter((d) => d.status === 'OUTAGE' || d.status === 'CONSTRAINED');
  const known: string[] = [];
  const uncertain: string[] = [];
  known.push(`${account.totals.CONFIRMED} effect(s) confirmed by their provider.`);
  for (const d of down) known.push(`${d.namespace} is ${d.status === 'OUTAGE' ? 'down (recoverable)' : 'constrained (not recoverable by retrying)'}: ${d.reason}.`);
  if (account.unsettled > 0) uncertain.push(`${account.unsettled} effect(s) may have been accepted by the outside world; each is reconciled before anything is sent again.`);
  for (const d of dependencies.filter((x) => x.status === 'UNKNOWN')) uncertain.push(`${d.namespace}: ${d.reason}.`);
  if (account.truncated) uncertain.push('Only the newest 500 operations were read; older ones are not in this account.');
  return {
    projectId,
    at: now,
    degraded: down.length > 0,
    dependencies,
    unaffected: dependencies.filter((d) => d.status === 'HEALTHY' || d.status === 'UNKNOWN').map((d) => d.namespace),
    totals: account.totals,
    unsettled: account.unsettled,
    known,
    uncertain,
  };
}

/** What the route serves when the ledger itself cannot be read: degraded, and saying so. */
export function unreadablePosture(projectId: string, now: string = operationNow()): { projectId: string; at: string; degraded: true; available: false; known: string[]; uncertain: string[] } {
  return {
    projectId,
    at: now,
    degraded: true,
    available: false,
    known: [],
    uncertain: ['The effect ledger could not be read just now. Nothing here means "nothing in doubt": effects may be unsettled, and nothing is resent until the ledger answers.'],
  };
}

/* ------------------------------------------------------------------------- */
/* Verified backup and restore of the commitment ledger                       */
/* ------------------------------------------------------------------------- */

export const SNAPSHOT_VERSION = 1;

export interface ContinuitySnapshot {
  version: number;
  projectId: string;
  takenAt: string;
  operations: IdempotencyOperation[];
  attempts: Record<string, EffectAttempt[]>;
  /** The class each operation had when the snapshot was taken. */
  classes: Record<string, ContinuityClass>;
  checksum: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function snapshotChecksum(snapshot: Omit<ContinuitySnapshot, 'checksum'>): string {
  return crypto.createHash('sha256').update(canonical(snapshot)).digest('hex');
}

/** The project's effect ledger as a checksummed document. Read-only. */
export async function continuitySnapshot(projectId: string, now: string = operationNow()): Promise<ContinuitySnapshot> {
  const operations = await listOperations(projectId, { limit: 500 });
  const attempts: Record<string, EffectAttempt[]> = {};
  const classes: Record<string, ContinuityClass> = {};
  for (const operation of operations) {
    const list = await listAttempts(operation.id);
    attempts[operation.id] = list;
    classes[operation.id] = classifyOperation(operation, list, now).class;
  }
  const body = { version: SNAPSHOT_VERSION, projectId, takenAt: now, operations, attempts, classes };
  return { ...body, checksum: snapshotChecksum(body) };
}

export interface RestoreVerification {
  verified: boolean;
  checksumOk: boolean;
  operations: number;
  /** Operations whose restored rows classify differently from the class recorded when the snapshot was taken. */
  reclassified: { operationId: string; recorded: ContinuityClass | null; restored: ContinuityClass }[];
  /** Operations the snapshot holds and the live ledger no longer has: a lost commitment. */
  missingFromLive: string[];
  /** Settled in the snapshot and not settled the same way live: a regressed commitment. */
  regressed: { operationId: string; snapshot: string; live: string }[];
  problems: string[];
}

const SETTLED = new Set(['SUCCEEDED', 'FAILED']);

/**
 * Prove a snapshot restores: its checksum holds, every operation re-derives
 * its recorded class from the restored rows alone, and — when the live ledger
 * is given — nothing it held as a commitment is missing or regressed live.
 */
export function verifyContinuityRestore(raw: string | ContinuitySnapshot, live?: readonly IdempotencyOperation[]): RestoreVerification {
  const problems: string[] = [];
  let snapshot: ContinuitySnapshot;
  try {
    snapshot = typeof raw === 'string' ? (JSON.parse(raw) as ContinuitySnapshot) : raw;
  } catch {
    return { verified: false, checksumOk: false, operations: 0, reclassified: [], missingFromLive: [], regressed: [], problems: ['the snapshot is not valid JSON'] };
  }
  if (snapshot.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.operations) || !snapshot.attempts || !snapshot.classes) {
    return { verified: false, checksumOk: false, operations: 0, reclassified: [], missingFromLive: [], regressed: [], problems: ['the snapshot is not a continuity snapshot this version can read'] };
  }
  const { checksum, ...body } = snapshot;
  const checksumOk = snapshotChecksum(body) === checksum;
  if (!checksumOk) problems.push('the checksum does not match: the copy is damaged or was edited');
  const reclassified: RestoreVerification['reclassified'] = [];
  for (const operation of snapshot.operations) {
    const restored = classifyOperation(operation, snapshot.attempts[operation.id] ?? [], snapshot.takenAt).class;
    const recorded = snapshot.classes[operation.id] ?? null;
    if (restored !== recorded) reclassified.push({ operationId: operation.id, recorded, restored });
  }
  if (reclassified.length > 0) problems.push(`${reclassified.length} operation(s) restore to a different class than they had`);
  const missingFromLive: string[] = [];
  const regressed: RestoreVerification['regressed'] = [];
  if (live) {
    const byId = new Map(live.map((o) => [o.id, o]));
    for (const operation of snapshot.operations) {
      const now = byId.get(operation.id);
      if (!now) missingFromLive.push(operation.id);
      else if (SETTLED.has(operation.state) && now.state !== operation.state) regressed.push({ operationId: operation.id, snapshot: operation.state, live: now.state });
    }
    if (missingFromLive.length > 0) problems.push(`${missingFromLive.length} operation(s) in the snapshot are missing from the live ledger`);
    if (regressed.length > 0) problems.push(`${regressed.length} settled operation(s) are no longer settled the same way live`);
  }
  return {
    verified: problems.length === 0,
    checksumOk,
    operations: snapshot.operations.length,
    reclassified,
    missingFromLive,
    regressed,
    problems,
  };
}

/**
 * The restore drill: take a snapshot, restore it through a serialised copy,
 * verify it against the live ledger, and append the verdict to
 * `project_events` so the drill is a row a probe can read.
 */
export async function runRestoreDrill(projectId: string): Promise<RestoreVerification & { checksum: string }> {
  const snapshot = await continuitySnapshot(projectId);
  const copy = JSON.stringify(snapshot);
  const live = await listOperations(projectId, { limit: 500 });
  const verification = verifyContinuityRestore(copy, live);
  await recordEvent({
    projectId,
    entityType: 'CONTINUITY_SNAPSHOT',
    entityId: snapshot.checksum.slice(0, 32),
    eventType: 'RECONCILE_COMPLETED',
    payload: {
      kind: 'CONTINUITY_RESTORE_DRILL',
      verified: verification.verified,
      operations: verification.operations,
      checksumOk: verification.checksumOk,
      reclassified: verification.reclassified.length,
      missingFromLive: verification.missingFromLive.length,
      regressed: verification.regressed.length,
      problems: verification.problems,
      takenAt: snapshot.takenAt,
    },
  });
  return { ...verification, checksum: snapshot.checksum };
}
