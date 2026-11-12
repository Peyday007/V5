/**
 * Guarding what a browser routine does to a site (ACQ-21-5).
 *
 * `browserWorkflow.ts` operates a site through a recorded, versioned workflow.
 * Two things about operating a site are not the workflow's to decide, because
 * they are about every run at once rather than one:
 *
 *  1. **The same mutation must not happen twice.** Two workers handed the same
 *     approved submission, or one worker retrying after a timeout, must not
 *     both press the button. The logical effect is named by a key derived
 *     from the capability (host + workflow name), its version (the definition
 *     the run executes) and the approved input, and from nothing a caller can
 *     vary between attempts — not a worker, a lease, an attempt number, a
 *     clock, or a scope the caller sent (invariant 27). That key is claimed
 *     through the existing owner of "at most once", `idempotency_operations`
 *     (`reserveOperation`'s single `INSERT … ON CONFLICT DO NOTHING`,
 *     invariant 24). No table, queue or lease system is added here.
 *
 *  2. **The site's request limits hold across workers.** The limit a host is
 *     run against is the lower of what the site declares and Brain's own
 *     default, and the count is read from the host's recent
 *     `BROWSER_WORKFLOW_RUN` rows — the record every run already writes. A
 *     host at its limit is deferred, naming the limit and the rows counted,
 *     never exceeded.
 *
 * An outcome nobody knows — a run that timed out after it submitted, or an
 * executor that died holding the claim — is recorded as UNKNOWN (the
 * operation's `UNCERTAIN` state) and is never re-performed automatically
 * (invariant 26). Only a person or a verification that read the site's own
 * state resolves it, through `resolveUnknownBrowserEffect`.
 *
 * Reads are idempotent: they pass the request limit and are not claimed, so a
 * read can be repeated as often as the limit allows. Whether a capability
 * mutates is the capability's declaration, judged when it was approved; this
 * module does not guess it from the steps.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../../db/database.ts';
import {
  getOperation,
  markUncertain,
  reserveOperation,
  resolveUncertain,
  succeedOperation,
  failOperation,
} from '../../../repos/idempotency.ts';
import { BRAIN_BOUNDARY } from '../../effects/engine.ts';
import { canonicalize, fingerprintKey, fingerprintRequest, FINGERPRINT_VERSION, scopeHash } from '../../effects/fingerprint.ts';
import { hostMeasuresPattern } from '../acquisition.ts';
import { BROWSER_WORKFLOW_RUN_EVENT } from '../browserWorkflow.ts';
import type { ActorType, IdempotencyOperation } from '../../../domain/types.ts';

/** The operation namespace browser mutations are claimed under. */
export const BROWSER_EFFECT_NAMESPACE = 'browser.workflow.effect';
export const BROWSER_EFFECT_NAMESPACE_VERSION = 1;

/** Brain's own ceiling on runs against one host per window, when the site declares a higher one or none. */
export const DEFAULT_HOST_RUNS_PER_MINUTE = 6;
export const REQUEST_WINDOW_MS = 60_000;
/** How long a claim may be held before an executor that never settled it is presumed dead. */
export const EFFECT_CLAIM_TTL_MS = 15 * 60_000;

/** Run outcomes that never reached the site, and so do not count against its limit. */
const DID_NOT_REACH_SITE = new Set(['REFUSED', 'DEFERRED']);

/* ------------------------------------------------------------------------- */
/* The logical effect key (pure)                                              */
/* ------------------------------------------------------------------------- */

/**
 * What a browser effect is performed by: a capability's identity and the exact
 * version run. `capability.ts` builds it from a capability record
 * (`effectSubject`), so every caller derives the one key the same way.
 */
export interface EffectSubject {
  /** The host the workflow operates. */
  host: string;
  /** The workflow's name on that host. */
  name: string;
  /** The definition being run: the BROWSER_WORKFLOW row's `definedAt`, or an explicit version label. */
  version: string;
}

export interface EffectKeyInput {
  capability: EffectSubject;
  /** The input a person or the capability's approval fixed: what will be submitted. */
  approvedInput: unknown;
}

const capabilityId = (c: EffectSubject): string => `${c.host.trim().toLowerCase()}/${c.name.trim().toLowerCase()}`;

/**
 * The logical effect key for one approved browser mutation. Pure.
 *
 * Only the capability id, its version and the approved input contribute. The
 * function reads exactly those fields, so a caller that sends a scope, a
 * worker, an attempt or a project alongside them changes nothing.
 */
export function browserEffectKey(input: EffectKeyInput): string {
  const { capability, approvedInput } = input;
  if (!capability?.host?.trim() || !capability.name?.trim()) throw new Error('A browser effect names the capability it performs.');
  if (!capability.version?.trim()) throw new Error('A browser effect names the version of the capability it performs.');
  const canonical = canonicalize({
    v: 1,
    cap: capabilityId(capability),
    ver: capability.version.trim(),
    input: approvedInput ?? null,
  });
  return `bwe-${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 48)}`;
}

/* ------------------------------------------------------------------------- */
/* The request limit (pure over rows, plus a reader)                          */
/* ------------------------------------------------------------------------- */

export interface RunRow {
  id?: string | null;
  outcome: string | null;
  at: string | null;
  /** The row's measures JSON; its `name` attributes the run to a capability. */
  measures?: string | null;
}

/**
 * A capability's own declared bound (its `rateLimit`), applied by the same
 * request budget as the host's limit — there is one budget, not two.
 */
export interface CapabilityRate {
  name: string;
  maxRunsPerHour: number;
  minIntervalMs: number;
}

export const CAPABILITY_RATE_WINDOW_MS = 3_600_000;

export interface RequestBudget {
  decision: 'PROCEED' | 'DEFER';
  host: string;
  /** The limit applied: the lower of the site's declared limit and Brain's default. */
  limit: number;
  limitSource: 'SITE_DECLARED' | 'BRAIN_DEFAULT';
  /** Runs that reached the site inside the window. */
  counted: number;
  countedRowIds: string[];
  windowStart: string;
  /** When a deferred run may be tried again. Null when it may proceed now. */
  retryAfter: string | null;
  /** Which bound deferred the run: the host's per-minute limit, or the capability's hourly or interval bound. */
  bound: 'HOST' | 'CAPABILITY_HOURLY' | 'CAPABILITY_INTERVAL' | null;
  reason: string;
}

/** Whether a run row is this capability's. A row that cannot be attributed is counted: a bound is never exceeded on a guess. */
function rowIsCapability(r: RunRow, name: string): boolean {
  if (!r.measures) return true;
  try {
    const m = JSON.parse(r.measures) as { name?: unknown };
    return typeof m.name !== 'string' || m.name.trim().toLowerCase() === name;
  } catch {
    return true;
  }
}

/**
 * Whether one more run against a host stays within its request limit. Pure.
 *
 * `declaredPerMinute` is what the site states (its terms, a published limit, a
 * Retry-After it answered); `rateLimited` is a 429 it answered recently, which
 * holds the host for the window whatever the count.
 */
export function requestBudgetFrom(
  hostIn: string,
  rows: readonly RunRow[],
  options: { now: Date; declaredPerMinute?: number | null; rateLimited?: boolean; capability?: CapabilityRate | null },
): RequestBudget {
  const host = hostIn.trim().toLowerCase();
  const nowMs = options.now.getTime();
  const windowStartMs = nowMs - REQUEST_WINDOW_MS;
  const declared = options.declaredPerMinute;
  const siteDeclared = typeof declared === 'number' && Number.isFinite(declared) && declared >= 0;
  const limit = siteDeclared ? Math.min(Math.floor(declared), DEFAULT_HOST_RUNS_PER_MINUTE) : DEFAULT_HOST_RUNS_PER_MINUTE;
  const limitSource = siteDeclared && Math.floor(declared) <= DEFAULT_HOST_RUNS_PER_MINUTE ? 'SITE_DECLARED' : 'BRAIN_DEFAULT';
  const inWindow = rows
    .map((r) => ({ r, t: r.at ? Date.parse(r.at) : Number.NaN }))
    .filter((x) => Number.isFinite(x.t) && x.t > windowStartMs && x.t <= nowMs && !DID_NOT_REACH_SITE.has(x.r.outcome ?? ''))
    .sort((a, b) => a.t - b.t);
  const counted = inWindow.length;
  const countedRowIds = inWindow.map((x) => x.r.id).filter((id): id is string => typeof id === 'string');
  const windowStart = new Date(windowStartMs).toISOString();
  const base = { host, limit, limitSource, counted, countedRowIds, windowStart } as const;
  if (options.rateLimited) {
    return {
      ...base,
      decision: 'DEFER',
      bound: 'HOST',
      retryAfter: new Date(nowMs + REQUEST_WINDOW_MS).toISOString(),
      reason: `${host} answered that it is rate limited; deferred for ${REQUEST_WINDOW_MS / 1000}s (${counted} run(s) counted since ${windowStart}, limit ${limit}/min)`,
    };
  }
  if (counted >= limit) {
    // The oldest counted run leaving the window is what frees the next slot.
    const freeing = inWindow[counted - limit];
    const retryAfter = new Date((freeing ? freeing.t : nowMs) + REQUEST_WINDOW_MS).toISOString();
    return {
      ...base,
      decision: 'DEFER',
      bound: 'HOST',
      retryAfter,
      reason: `${host} is at its request limit: ${counted} run(s) counted since ${windowStart} against a limit of ${limit}/min (${limitSource === 'SITE_DECLARED' ? 'declared by the site' : 'Brain default'}); deferred until ${retryAfter}`,
    };
  }
  const cap = options.capability ?? null;
  if (cap) {
    const want = cap.name.trim().toLowerCase();
    const mine = rows
      .map((r) => ({ r, t: r.at ? Date.parse(r.at) : Number.NaN }))
      .filter((x) => Number.isFinite(x.t) && x.t > nowMs - CAPABILITY_RATE_WINDOW_MS && x.t <= nowMs && !DID_NOT_REACH_SITE.has(x.r.outcome ?? '') && rowIsCapability(x.r, want))
      .sort((a, b) => a.t - b.t);
    if (mine.length >= cap.maxRunsPerHour) {
      const retryAfter = new Date(mine[mine.length - cap.maxRunsPerHour]!.t + CAPABILITY_RATE_WINDOW_MS).toISOString();
      return {
        ...base,
        decision: 'DEFER',
        bound: 'CAPABILITY_HOURLY',
        retryAfter,
        reason: `"${cap.name}" on ${host} is at its declared bound: ${mine.length} run(s) in the last hour against ${cap.maxRunsPerHour}/hour; deferred until ${retryAfter}`,
      };
    }
    const newest = mine[mine.length - 1];
    if (newest && nowMs - newest.t < cap.minIntervalMs) {
      const retryAfter = new Date(newest.t + cap.minIntervalMs).toISOString();
      return {
        ...base,
        decision: 'DEFER',
        bound: 'CAPABILITY_INTERVAL',
        retryAfter,
        reason: `"${cap.name}" on ${host} declares at least ${cap.minIntervalMs} ms between runs; deferred until ${retryAfter}`,
      };
    }
  }
  return {
    ...base,
    decision: 'PROCEED',
    bound: null,
    retryAfter: null,
    reason: `${host}: ${counted} of ${limit} run(s) used in the window since ${windowStart}`,
  };
}

/** The host's recent BROWSER_WORKFLOW_RUN rows; a host's own history, never the whole table's. */
export async function readRecentRunRows(host: string, now: Date = new Date(), windowMs: number = REQUEST_WINDOW_MS): Promise<RunRow[]> {
  const since = new Date(now.getTime() - windowMs).toISOString();
  return await getDb().all<RunRow>(
    `SELECT id, outcome, at, measures FROM bin_events
      WHERE event_type = ? AND measures LIKE ? ESCAPE '\\' AND at > ?
      ORDER BY at DESC LIMIT 500`,
    [BROWSER_WORKFLOW_RUN_EVENT, hostMeasuresPattern(host.trim().toLowerCase()), since],
  );
}

/** The request budget for a host, read from its recorded runs. */
export async function readRequestBudget(
  host: string,
  options: { now?: Date; declaredPerMinute?: number | null; rateLimited?: boolean; capability?: CapabilityRate | null; rows?: (host: string, now: Date) => Promise<RunRow[]> } = {},
): Promise<RequestBudget> {
  const now = options.now ?? new Date();
  const capability = options.capability ?? null;
  const rows = await (options.rows ?? ((h: string, n: Date) => readRecentRunRows(h, n, capability ? CAPABILITY_RATE_WINDOW_MS : REQUEST_WINDOW_MS)))(host, now);
  return requestBudgetFrom(host, rows, { now, declaredPerMinute: options.declaredPerMinute ?? null, rateLimited: options.rateLimited ?? false, capability });
}

/* ------------------------------------------------------------------------- */
/* Claiming and settling a mutation                                           */
/* ------------------------------------------------------------------------- */

export interface ClaimInput extends EffectKeyInput {
  /** The project the work belongs to, from the server's own record of the work. */
  projectId: string;
  actor: { type: ActorType; id: string | null };
  workItemId?: string | null;
  now?: Date;
}

export type ClaimResult =
  | { claimed: true; effectKey: string; operationId: string }
  | {
      claimed: false;
      effectKey: string;
      operationId: string;
      /** HELD: another executor is performing it. COMPLETED: it was performed. FAILED: it failed for good. UNKNOWN: nobody knows whether it happened. */
      reason: 'HELD' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
      detail: string;
    };

function scopeFor(projectId: string): string {
  // PROJECT scope: two workers performing the same approved submission are one
  // intent, so the second finds the first rather than repeating it.
  return scopeHash({
    boundary: BRAIN_BOUNDARY,
    projectId,
    namespace: BROWSER_EFFECT_NAMESPACE,
    namespaceVersion: BROWSER_EFFECT_NAMESPACE_VERSION,
    principalScope: 'PROJECT',
    principalType: 'SYSTEM',
    principalId: 'browser-effect',
  });
}

/**
 * Claim the right to perform one browser mutation. Exactly one caller gets it;
 * every other caller is told why not. An abandoned claim is not taken over: a
 * browser submission cannot be asked whether it happened, so it becomes UNKNOWN.
 */
export async function claimBrowserEffect(input: ClaimInput): Promise<ClaimResult> {
  if (!input.projectId?.trim()) throw new Error('A browser effect is claimed inside a project.');
  const effectKey = browserEffectKey(input);
  const now = input.now ?? new Date();
  const reserved = await reserveOperation({
    scopeHash: scopeFor(input.projectId),
    keyFingerprint: fingerprintKey(effectKey),
    namespace: BROWSER_EFFECT_NAMESPACE,
    namespaceVersion: BROWSER_EFFECT_NAMESPACE_VERSION,
    projectId: input.projectId,
    requestFingerprint: fingerprintRequest({
      namespace: BROWSER_EFFECT_NAMESPACE,
      namespaceVersion: BROWSER_EFFECT_NAMESPACE_VERSION,
      projectId: input.projectId,
      payload: { cap: capabilityId(input.capability), ver: input.capability.version.trim(), input: input.approvedInput ?? null },
    }),
    fingerprintVersion: FINGERPRINT_VERSION,
    createdByType: input.actor.type,
    createdById: input.actor.id,
    workItemId: input.workItemId ?? null,
    recoverAfter: new Date(now.getTime() + EFFECT_CLAIM_TTL_MS).toISOString(),
  });
  const op = reserved.operation;
  switch (reserved.outcome) {
    case 'RESERVED':
      return { claimed: true, effectKey, operationId: op.id };
    case 'REPLAY':
      return { claimed: false, effectKey, operationId: op.id, reason: 'COMPLETED', detail: `already performed${op.resultSummary ? `: ${op.resultSummary}` : ''}` };
    case 'TERMINAL_FAILURE':
      return { claimed: false, effectKey, operationId: op.id, reason: 'FAILED', detail: `failed for good${op.resultSummary ? `: ${op.resultSummary}` : ''}; a new approved input or version is a new effect` };
    case 'UNCERTAIN':
      return { claimed: false, effectKey, operationId: op.id, reason: 'UNKNOWN', detail: `outcome unknown (${op.uncertaintyReason ?? 'unrecorded'}); a person or a verification of the site's state resolves it` };
    case 'RECOVERABLE': {
      const reason = `the executor holding this claim stopped without settling it after ${EFFECT_CLAIM_TTL_MS / 60_000} minutes; the submission may have happened`;
      await markUncertain(op.id, reason);
      return { claimed: false, effectKey, operationId: op.id, reason: 'UNKNOWN', detail: reason };
    }
    case 'IN_PROGRESS':
    case 'CONFLICT':
    default:
      return { claimed: false, effectKey, operationId: op.id, reason: 'HELD', detail: 'another executor holds this effect' };
  }
}

/**
 * Record how a claimed mutation ended. COMPLETED and FAILED are facts the run
 * observed; anything else — a timeout after submitting, a lost session, an
 * error with no page state to read — is UNKNOWN.
 */
export async function settleBrowserEffect(
  operationId: string,
  outcome: { result: 'COMPLETED'; summary?: string | null; resultRef?: string | null } | { result: 'FAILED'; detail: string } | { result: 'UNKNOWN'; reason: string },
): Promise<boolean> {
  switch (outcome.result) {
    case 'COMPLETED':
      return await succeedOperation(operationId, { resultSummary: outcome.summary ?? null, resultRef: outcome.resultRef ?? null });
    case 'FAILED':
      return await failOperation(operationId, { category: 'PROVIDER_REJECTED', terminal: true, detail: outcome.detail });
    case 'UNKNOWN':
      return await markUncertain(operationId, outcome.reason);
  }
}

/** The only way out of UNKNOWN: a person, or a verification that read the site's own state. */
export async function resolveUnknownBrowserEffect(
  operationId: string,
  resolution: { by: 'PERSON' | 'VERIFICATION'; happened: boolean; evidence: string },
): Promise<boolean> {
  if (!resolution.evidence?.trim()) throw new Error('Resolving an unknown browser effect states the evidence it was resolved on.');
  const note = `${resolution.by === 'PERSON' ? 'resolved by a person' : 'resolved by verifying the site state'}: ${resolution.evidence.trim()}`;
  return await resolveUncertain(
    operationId,
    resolution.happened ? { as: 'SUCCEEDED', summary: note } : { as: 'FAILED', category: 'PROVIDER_REJECTED', detail: note },
  );
}

export async function readBrowserEffect(operationId: string): Promise<IdempotencyOperation | null> {
  return await getOperation(operationId);
}

/* ------------------------------------------------------------------------- */
/* The guard: one call before a run                                           */
/* ------------------------------------------------------------------------- */

export interface GuardInput extends ClaimInput {
  /** The capability's approved declaration: a READ is idempotent, a MUTATION is claimed. */
  effect: 'READ' | 'MUTATION';
  declaredPerMinute?: number | null;
  rateLimited?: boolean;
  /** The capability's own declared rate bound, enforced by this same budget. */
  capabilityRate?: CapabilityRate | null;
  rows?: (host: string, now: Date) => Promise<RunRow[]>;
}

export type GuardDecision =
  | { decision: 'PROCEED'; budget: RequestBudget; claim: ClaimResult | null }
  | { decision: 'DEFER'; budget: RequestBudget; claim: null }
  | { decision: 'REFUSE'; budget: RequestBudget; claim: ClaimResult };

/**
 * Before a run: the request limit first (a deferred run claims nothing), then,
 * for a mutation, the effect claim. PROCEED with a claim obliges the caller to
 * `settleBrowserEffect` it.
 */
export async function guardBrowserRun(input: GuardInput): Promise<GuardDecision> {
  const now = input.now ?? new Date();
  const budget = await readRequestBudget(input.capability.host, {
    now,
    declaredPerMinute: input.declaredPerMinute ?? null,
    rateLimited: input.rateLimited ?? false,
    capability: input.capabilityRate ?? null,
    ...(input.rows ? { rows: input.rows } : {}),
  });
  if (budget.decision === 'DEFER') return { decision: 'DEFER', budget, claim: null };
  if (input.effect === 'READ') return { decision: 'PROCEED', budget, claim: null };
  const claim = await claimBrowserEffect({ ...input, now });
  return claim.claimed ? { decision: 'PROCEED', budget, claim } : { decision: 'REFUSE', budget, claim };
}
