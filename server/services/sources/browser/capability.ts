/**
 * A browser routine as a versioned, reusable capability (ACQ-21-5).
 *
 * `browserWorkflow.ts` owns how a site's interface is operated: a recorded
 * `BrowserWorkflow` (steps addressed by `Locator`s, explicit `expect` checks),
 * run under the authority chain there (acquisition judgment, the person's
 * standing OPERATE_PERMISSION, host-bound destinations, boundaries handed off).
 * This module does not run anything a second way. It wraps that workflow in the
 * contract that makes it safe to run thousands of times after a model or a
 * person discovered it once:
 *
 *  - **a version** — a content hash of the whole definition plus a version
 *    number that only ever increases. Changing any step is a new version; the
 *    previous version's rows stay where they are (append-only `bin_events`).
 *  - **declared inputs and outputs**, the **effect** (an idempotent READ or a
 *    MUTATION) and a check, before anything is submitted, for steps that look
 *    destructive or externally consequential. A READ that would press such a
 *    control is refused at definition time.
 *  - **expected page states** after named steps, a **timeout**, a **retry
 *    policy** (a read may retry within a bound; a mutation is never retried
 *    automatically, and an unknown outcome stays UNKNOWN — invariant 26), a
 *    **freshness window**, a **failure-reason vocabulary**, **test fixtures**,
 *    a **maintenance owner**, a **request-rate bound**, and the **session rule**
 *    (whether a granted account is used and when it must be reauthorized).
 *
 * Lifecycle DRAFT → APPROVED → ACTIVE → REVIEW → RETIRED is never stored as a
 * status: it is derived by reading BROWSER_CAPABILITY rows and the existing
 * BROWSER_WORKFLOW_RUN rows, all written through `recordBinEvent` (no table,
 * scheduler or store is added — §10.3, §20.4). A run that found the interface
 * changed moves an ACTIVE capability to REVIEW instead of guessing; a run that
 * met an expired or rejected session yields a REAUTHORIZE handoff.
 *
 * **Discover once, run thousands of times.** `discoverBrowserCapability` is the
 * producer: it takes a workflow a model (or a person) recorded through the
 * workflow owner, runs it once through `operateWorkflow`, and — only when that
 * run completed, found the interface unchanged and obtained every output —
 * records it as a DRAFT capability (`draftCapabilityFromRun` decides the
 * definition from the run; `capabilityFromSuccessfulRun` records it from a run
 * a caller already holds). The draft runs again only after a person approves
 * that exact content hash; from then on ordinary code runs it.
 *
 * Session material is never held by Brain, and this module relies on the
 * browser server as its owner. An account workflow is run only through the
 * browser server's own signed-in session (`BRAIN_BROWSER_SESSION_MCP_URL`,
 * chosen by `runBrowserWorkflow`), which keeps the encrypted session outside
 * the repository and Brain's rows. Reauthorization is modelled here as the rule
 * that decides when a person must sign in again: the session's age since the
 * approval (`reauthorizeAfterMs`) and a run the session server sent to an
 * AUTHENTICATION boundary both yield a REAUTHORIZE handoff. A capability record
 * carries only that rule, never a cookie, token or password;
 * `validateCapability` refuses any definition shaped like one.
 *
 * Nothing here names a host, category or industry, and no list is a whitelist:
 * the consequential-control pattern only decides what needs a declared MUTATION
 * and an approval, and Brain judges fitness per case (`recordAcquisitionJudgment`).
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../../db/database.ts';
import { recordBinEvent } from '../../../repos/bins.ts';
import { hostMeasuresPattern } from '../acquisition.ts';
import { redactText } from './redaction.ts';
import {
  BROWSER_WORKFLOW_RUN_EVENT,
  MAX_WORKFLOW_STEPS,
  WORKFLOW_TIMEOUT_MS,
  operateWorkflow,
  readBrowserWorkflows,
  recordBrowserWorkflow,
  validateWorkflow,
  type BrowserWorkflow,
  type Locator,
  type OperateDeps,
  type OperateResult,
} from '../browserWorkflow.ts';

export const BROWSER_CAPABILITY_EVENT = 'BROWSER_CAPABILITY';

/** The bounds a definition may ask for. */
export const MAX_READ_RETRIES = 3;
export const MAX_CAPABILITY_TIMEOUT_MS = WORKFLOW_TIMEOUT_MS;
export const MIN_FRESHNESS_MS = 60_000;

export type CapabilityEffect = 'READ' | 'MUTATION';
export type CapabilityStatus = 'DRAFT' | 'APPROVED' | 'ACTIVE' | 'REVIEW' | 'RETIRED';

/** Why a run did not obtain what it was for. A definition may add its own reasons; these always exist. */
export const BASE_FAILURE_REASONS = [
  'INTERFACE_CHANGED',
  'EXPECTED_STATE_MISSING',
  'SESSION_EXPIRED',
  'BOUNDARY',
  'TIMEOUT',
  'RATE_LIMITED',
  'OUTCOME_UNKNOWN',
  'STALE',
] as const;

export interface CapabilityField {
  name: string;
  description: string;
}

/** A page state a run must observe after a step, before the next one is taken. */
export interface ExpectedState {
  /** 1-based step after which the state must hold. */
  afterStep: number;
  text?: string;
  absentText?: string;
  urlIncludes?: string;
  locator?: Locator;
}

export interface RetryPolicy {
  /** Total attempts, including the first. A mutation has exactly one. */
  maxAttempts: number;
  backoffMs: number;
  /** Whether an attempt whose outcome is unknown may be retried automatically. Never for a mutation. */
  retryAfterUnknown: boolean;
}

/** A recorded example the routine is checked against: what it is given and what it must obtain. */
export interface CapabilityFixture {
  name: string;
  inputs: Record<string, string>;
  /** Output name → text the obtained output must contain. */
  expect: Record<string, string>;
}

export interface SessionRule {
  /** The routine runs under the account a person granted for the host (the workflow's `account`). */
  account: boolean;
  /** Longest a signed-in session is trusted before a person reauthorizes it; null when no account is used. */
  reauthorizeAfterMs: number | null;
}

export interface RateLimit {
  /** At most this many runs of the capability per hour, across all workers. */
  maxRunsPerHour: number;
  /** At least this long between two runs. */
  minIntervalMs: number;
}

export interface BrowserCapability {
  workflow: BrowserWorkflow;
  inputs: CapabilityField[];
  outputs: CapabilityField[];
  effect: CapabilityEffect;
  expectedStates: ExpectedState[];
  timeoutMs: number;
  retry: RetryPolicy;
  /** How long an obtained result stays current before the routine must run again. */
  freshnessMs: number;
  failureReasons: string[];
  fixtures: CapabilityFixture[];
  maintenanceOwner: string;
  session: SessionRule;
  rateLimit: RateLimit;
}

/* ------------------------------------------------------------------------- */
/* Validation (pure)                                                          */
/* ------------------------------------------------------------------------- */

/** A control whose activation could change the world outside Brain. Detection, not a whitelist. */
const CONSEQUENTIAL = /\b(buy|purchase|pay|checkout|check out|order|place order|subscribe|delete|remove|destroy|erase|cancel|close account|publish|post|send|submit|sign|accept|agree|confirm|transfer|withdraw|book|reserve|apply|bid|offer|list item|unsubscribe|deactivate)\b/i;
/** A key or value shaped like session material or a credential. */
const CREDENTIAL_KEY = /^(password|passwd|passcode|secret|token|access_?token|refresh_?token|api_?key|cookie|cookies|session_?id|sessionid|authorization|bearer|credential|credentials|otp)$/i;
const CREDENTIAL_VALUE = /^(bearer\s+\S+|basic\s+\S+)$|^(sk|pk|ghp|gho|ghs|xox[abp]|brn[a-z])[-_]|^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|^[A-Za-z0-9+/_-]{40,}={0,2}$|(^|;\s*)[A-Za-z0-9_.-]+=[^;]{16,};/i;

const locatorText = (l: Locator | undefined): string => (l ? [l.role, l.name, l.label, l.testId, l.css, l.text].filter(Boolean).join(' ') : '');

/**
 * Steps that would press a destructive or externally consequential control,
 * found before anything is submitted. Pure.
 */
export function consequentialSteps(workflow: BrowserWorkflow): { step: number; why: string }[] {
  const out: { step: number; why: string }[] = [];
  (workflow.steps ?? []).forEach((s, i) => {
    if (s.kind === 'click' && CONSEQUENTIAL.test(locatorText(s.locator))) out.push({ step: i + 1, why: `clicks "${locatorText(s.locator)}"` });
    if (s.kind === 'fill' && s.submit && CONSEQUENTIAL.test(locatorText(s.locator))) out.push({ step: i + 1, why: `submits "${locatorText(s.locator)}"` });
  });
  return out;
}

function credentialProblems(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE.test(value.trim())) out.push(`${path}: a capability never carries a credential or session value`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((v, i) => credentialProblems(v, `${path}[${i}]`, out));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEY.test(k)) out.push(`${path}.${k}: session material stays with the browser server, never in a capability`);
      credentialProblems(v, `${path}.${k}`, out);
    }
  }
}

const hasLocator = (l: Locator | undefined): boolean => Boolean(l && locatorText(l).trim());

/** Every problem with a capability definition; empty when it may be recorded. Pure. */
export function validateCapability(c: BrowserCapability): string[] {
  const problems: string[] = [];
  if (!c || typeof c !== 'object' || !c.workflow) return ['a capability wraps a recorded browser workflow'];
  problems.push(...validateWorkflow(c.workflow).map((p) => `workflow: ${p}`));
  const steps = c.workflow.steps ?? [];

  const selectors = steps.filter((s) => 'locator' in s && hasLocator((s as { locator?: Locator }).locator));
  if (selectors.length === 0) problems.push('the capability addresses the interface by selectors (Locators), not by addresses alone');

  const fields = (list: unknown, what: string) => {
    if (!Array.isArray(list)) return problems.push(`${what} are declared (an empty list when there are none)`);
    const seen = new Set<string>();
    for (const f of list as CapabilityField[]) {
      if (!f?.name?.trim() || !f.description?.trim()) problems.push(`every one of the ${what} has a name and a description`);
      else if (seen.has(f.name)) problems.push(`${what}: "${f.name}" is declared twice`);
      else seen.add(f.name);
    }
    return undefined;
  };
  fields(c.inputs, 'inputs');
  fields(c.outputs, 'outputs');
  if (Array.isArray(c.outputs) && c.outputs.length === 0) problems.push('the capability declares what it obtains (outputs)');
  const captured = new Set(steps.flatMap((s) => (s.kind === 'extract' || s.kind === 'download' ? [s.name] : [])));
  for (const o of Array.isArray(c.outputs) ? c.outputs : []) if (o?.name && !captured.has(o.name)) problems.push(`output "${o.name}" is captured by an extract or download step`);

  if (c.effect !== 'READ' && c.effect !== 'MUTATION') problems.push('the effect is READ or MUTATION');
  const consequential = consequentialSteps(c.workflow);
  if (c.effect === 'READ' && consequential.length > 0) {
    problems.push(`a READ may not press a consequential control: ${consequential.map((x) => `step ${x.step} ${x.why}`).join('; ')}; declare it a MUTATION`);
  }

  if (!Array.isArray(c.expectedStates) || c.expectedStates.length === 0) problems.push('the capability declares expected page states');
  else
    c.expectedStates.forEach((e, i) => {
      if (!Number.isInteger(e?.afterStep) || e.afterStep < 1 || e.afterStep > Math.min(steps.length, MAX_WORKFLOW_STEPS)) problems.push(`expected state ${i + 1}: afterStep names one of the workflow's steps`);
      if (!e?.text && !e?.absentText && !e?.urlIncludes && !hasLocator(e?.locator)) problems.push(`expected state ${i + 1}: names what must hold`);
    });

  if (!(Number.isInteger(c.timeoutMs) && c.timeoutMs > 0 && c.timeoutMs <= MAX_CAPABILITY_TIMEOUT_MS)) problems.push(`a timeout of 1-${MAX_CAPABILITY_TIMEOUT_MS} ms`);

  const r = c.retry;
  if (!r || !Number.isInteger(r.maxAttempts) || r.maxAttempts < 1 || !(Number.isFinite(r.backoffMs) && r.backoffMs >= 0) || typeof r.retryAfterUnknown !== 'boolean') {
    problems.push('a retry policy: maxAttempts ≥ 1, backoffMs ≥ 0, retryAfterUnknown');
  } else if (c.effect === 'MUTATION') {
    if (r.maxAttempts !== 1) problems.push('a mutation is never retried automatically (maxAttempts 1)');
    if (r.retryAfterUnknown) problems.push('a mutation whose outcome is unknown stays UNKNOWN and is never retried automatically');
  } else if (r.maxAttempts > 1 + MAX_READ_RETRIES) problems.push(`a read retries at most ${MAX_READ_RETRIES} times`);

  if (!(Number.isFinite(c.freshnessMs) && c.freshnessMs >= MIN_FRESHNESS_MS)) problems.push(`a freshness window of at least ${MIN_FRESHNESS_MS} ms`);
  if (!Array.isArray(c.failureReasons) || c.failureReasons.some((x) => typeof x !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(x))) problems.push('failure reasons are UPPER_SNAKE names');
  if (!Array.isArray(c.fixtures) || c.fixtures.length === 0) problems.push('the capability has at least one test fixture');
  else
    c.fixtures.forEach((f, i) => {
      if (!f?.name?.trim()) problems.push(`fixture ${i + 1}: has a name`);
      if (!f?.expect || Object.keys(f.expect).length === 0) problems.push(`fixture ${i + 1}: states what must be obtained`);
      for (const inName of Array.isArray(c.inputs) ? c.inputs.map((x) => x?.name) : []) if (inName && !(f?.inputs && inName in f.inputs)) problems.push(`fixture ${i + 1}: gives input "${inName}"`);
    });
  if (!c.maintenanceOwner?.trim()) problems.push('the capability names a maintenance owner');

  const s = c.session;
  if (!s || typeof s.account !== 'boolean') problems.push('the session rule says whether a granted account is used');
  else {
    if (s.account !== Boolean(c.workflow.account)) problems.push("the session rule agrees with the workflow's account");
    if (s.account && !(Number.isFinite(s.reauthorizeAfterMs) && (s.reauthorizeAfterMs as number) > 0)) problems.push('an account session names when it must be reauthorized');
  }
  const rl = c.rateLimit;
  if (!rl || !(Number.isInteger(rl.maxRunsPerHour) && rl.maxRunsPerHour >= 1) || !(Number.isFinite(rl.minIntervalMs) && rl.minIntervalMs >= 0)) {
    problems.push("a request-rate bound that respects the site's limits (maxRunsPerHour ≥ 1, minIntervalMs ≥ 0)");
  }

  credentialProblems(c, 'capability', problems);
  return problems;
}

/* ------------------------------------------------------------------------- */
/* Versions (pure)                                                            */
/* ------------------------------------------------------------------------- */

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

const normalize = (c: BrowserCapability): BrowserCapability => ({
  ...c,
  workflow: { ...c.workflow, host: c.workflow.host.trim().toLowerCase(), name: c.workflow.name.trim() },
});

/** The content hash of a definition: any change to any step or field is a different hash. Pure. */
export function capabilityHash(c: BrowserCapability): string {
  return createHash('sha256').update(JSON.stringify(canonical(normalize(c)))).digest('hex');
}

const capKey = (host: string, name: string) => `${host.trim().toLowerCase()}\u0000${name.trim().toLowerCase()}`;

export interface CapabilityRow {
  measures: string | null;
  outcome: string | null;
  at: string | null;
}

export interface CapabilityVersion {
  version: number;
  contentHash: string;
  definedAt: string;
  capability: BrowserCapability;
}

export interface CapabilityRecord {
  host: string;
  name: string;
  current: CapabilityVersion;
  /** Every version ever recorded, oldest first. Earlier versions are kept, never rewritten. */
  versions: CapabilityVersion[];
  status: CapabilityStatus;
  /** A person or the run record says what must happen before the next run. */
  handoff: 'REAUTHORIZE' | 'REVIEW' | null;
  approvedBy: string | null;
  lastCompletedAt: string | null;
  fresh: boolean;
  why: string;
}

const parse = <T>(raw: string | null): T | null => {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

interface CapMeasures {
  host?: string;
  name?: string;
  contentHash?: string;
  version?: number;
  capability?: BrowserCapability;
  by?: string;
}

interface RunMeasures {
  host?: string;
  name?: string;
  interfaceChanged?: boolean;
  boundary?: string | null;
}

const timeOf = (at: string | null): number => (at ? Date.parse(at) : Number.NaN);

/**
 * Capabilities and their lifecycle, derived only from rows: BROWSER_CAPABILITY
 * rows (DEFINED, APPROVED, RETIRED) and the workflow owner's BROWSER_WORKFLOW_RUN
 * rows. Pure.
 *
 *  - DRAFT: the newest version has no approval.
 *  - APPROVED: a person approved this exact content hash; no run has completed since.
 *  - ACTIVE: approved, and a run completed after the approval.
 *  - REVIEW: since the approval, a run found the interface changed. It stays in
 *    REVIEW until a person approves again or a new version is recorded.
 *  - RETIRED: a person retired this version.
 */
export function capabilitiesFrom(capRows: readonly CapabilityRow[], runRows: readonly CapabilityRow[], now: number = Date.now()): Map<string, CapabilityRecord> {
  const rows = capRows
    .map((r) => ({ r, m: parse<CapMeasures>(r.measures), t: timeOf(r.at) }))
    .filter((x) => x.m?.host && x.m.name && x.m.contentHash && Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const versions = new Map<string, CapabilityVersion[]>();
  for (const x of rows) {
    if (x.r.outcome !== 'DEFINED' || !x.m!.capability || !Number.isInteger(x.m!.version)) continue;
    if (capabilityHash(x.m!.capability) !== x.m!.contentHash || validateCapability(x.m!.capability).length > 0) continue;
    const key = capKey(x.m!.host!, x.m!.name!);
    const list = versions.get(key) ?? [];
    const last = list[list.length - 1];
    if (last && (x.m!.version! <= last.version || last.contentHash === x.m!.contentHash)) continue;
    list.push({ version: x.m!.version!, contentHash: x.m!.contentHash!, definedAt: x.r.at!, capability: x.m!.capability });
    versions.set(key, list);
  }

  const out = new Map<string, CapabilityRecord>();
  for (const [key, list] of versions) {
    const current = list[list.length - 1]!;
    const definedT = Date.parse(current.definedAt);
    const mine = rows.filter((x) => capKey(x.m!.host!, x.m!.name!) === key && x.m!.contentHash === current.contentHash && x.t >= definedT);
    const approvals = mine.filter((x) => x.r.outcome === 'APPROVED');
    const retired = mine.find((x) => x.r.outcome === 'RETIRED');
    const approval = approvals[approvals.length - 1] ?? null;
    const runs = runRows
      .map((r) => ({ r, m: parse<RunMeasures>(r.measures), t: timeOf(r.at) }))
      .filter((x) => x.m && capKey(x.m.host ?? '', x.m.name ?? '') === key && Number.isFinite(x.t) && x.t >= definedT)
      .sort((a, b) => a.t - b.t);
    const since = approval ? runs.filter((x) => x.t >= approval.t) : [];
    const completed = since.filter((x) => x.r.outcome === 'COMPLETED');
    const changed = since.find((x) => x.m!.interfaceChanged === true);
    const lastRun = since[since.length - 1];
    const lastCompleted = runs.filter((x) => x.r.outcome === 'COMPLETED').pop() ?? null;
    const sessionRejected = current.capability.session.account && lastRun?.r.outcome === 'HANDOFF' && lastRun.m!.boundary === 'AUTHENTICATION';
    const sessionAged =
      current.capability.session.account && approval !== null && current.capability.session.reauthorizeAfterMs !== null && now - approval.t > current.capability.session.reauthorizeAfterMs;

    let status: CapabilityStatus;
    let why: string;
    if (retired) {
      status = 'RETIRED';
      why = `version ${current.version} was retired by ${retired.m!.by ?? 'a person'}`;
    } else if (!approval) {
      status = 'DRAFT';
      why = `version ${current.version} is not approved; it runs only after a person approves this exact definition`;
    } else if (changed) {
      status = 'REVIEW';
      why = `a run at ${changed.r.at} found the interface changed; validation and review, never a guess through its controls`;
    } else if (completed.length > 0) {
      status = 'ACTIVE';
      why = `approved by ${approval.m!.by ?? 'a person'}; ${completed.length} of ${since.length} runs since approval completed`;
    } else {
      status = 'APPROVED';
      why = `approved by ${approval.m!.by ?? 'a person'}; no run has completed yet`;
    }
    const handoff = status === 'REVIEW' ? 'REVIEW' : status !== 'RETIRED' && status !== 'DRAFT' && (sessionRejected || sessionAged) ? 'REAUTHORIZE' : null;
    if (handoff === 'REAUTHORIZE') why += sessionRejected ? '; the signed-in session was rejected — a person reauthorizes it' : '; the signed-in session is older than its reauthorization window';
    const lastCompletedAt = lastCompleted?.r.at ?? null;
    out.set(key, {
      host: current.capability.workflow.host,
      name: current.capability.workflow.name,
      current,
      versions: list,
      status,
      handoff,
      approvedBy: approval?.m!.by ?? null,
      lastCompletedAt,
      fresh: lastCompletedAt !== null && now - Date.parse(lastCompletedAt) <= current.capability.freshnessMs,
      why,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Running: retry, idempotency and rate bounds (pure decision)                */
/* ------------------------------------------------------------------------- */

/**
 * The logical key of one effect: the version's content hash and the inputs.
 * Nothing about the attempt, the worker or the time is in it, so every attempt
 * at the same mutation has the same key (invariant 27). Pure.
 */
export function effectKey(contentHash: string, inputs: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify([contentHash, canonical(inputs)])).digest('hex');
}

export interface PriorRun {
  key: string;
  outcome: string;
  at: string;
}

export type RunDecision =
  | { decision: 'RUN'; key: string; attempt: number }
  | { decision: 'ALREADY_DONE'; key: string; detail: string }
  | { decision: 'WAIT'; key: string; retryAt: string; detail: string }
  | { decision: 'REFUSED'; key: string; reason: (typeof BASE_FAILURE_REASONS)[number] | 'NOT_APPROVED' | 'RETIRED' | 'BAD_INPUT'; detail: string };

/**
 * Whether this capability may run now with these inputs, from its record and
 * its recorded runs. Pure.
 *
 * A mutation that already completed is not performed again; one whose outcome
 * is unknown stays UNKNOWN and is refused rather than retried. A read retries
 * within its bound. Every run, read or mutation, stays inside the rate bound.
 */
export function planCapabilityRun(record: CapabilityRecord, inputs: Record<string, string>, prior: readonly PriorRun[], now: number = Date.now()): RunDecision {
  const c = record.current.capability;
  const key = effectKey(record.current.contentHash, inputs);
  const missing = c.inputs.filter((f) => typeof inputs[f.name] !== 'string').map((f) => f.name);
  const extra = Object.keys(inputs).filter((k) => !c.inputs.some((f) => f.name === k));
  if (missing.length || extra.length) return { decision: 'REFUSED', key, reason: 'BAD_INPUT', detail: `inputs: missing ${missing.join(', ') || 'none'}; undeclared ${extra.join(', ') || 'none'}` };
  if (record.status === 'RETIRED') return { decision: 'REFUSED', key, reason: 'RETIRED', detail: record.why };
  if (record.status === 'DRAFT') return { decision: 'REFUSED', key, reason: 'NOT_APPROVED', detail: record.why };
  if (record.status === 'REVIEW') return { decision: 'REFUSED', key, reason: 'INTERFACE_CHANGED', detail: record.why };
  if (record.handoff === 'REAUTHORIZE') return { decision: 'REFUSED', key, reason: 'SESSION_EXPIRED', detail: record.why };

  const mine = prior.filter((p) => p.key === key).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (c.effect === 'MUTATION') {
    if (mine.some((p) => p.outcome === 'COMPLETED')) return { decision: 'ALREADY_DONE', key, detail: 'this mutation already completed; it is not performed twice' };
    const latest = mine[mine.length - 1];
    if (mine.some((p) => p.outcome === 'UNKNOWN') || latest?.outcome === 'STARTED') {
      return { decision: 'REFUSED', key, reason: 'OUTCOME_UNKNOWN', detail: 'an earlier attempt at this mutation has no known outcome; it is recorded as UNKNOWN and never retried automatically' };
    }
  } else {
    const failed = mine.filter((p) => p.outcome !== 'COMPLETED');
    const lastDone = mine.filter((p) => p.outcome === 'COMPLETED').pop();
    if (lastDone && now - Date.parse(lastDone.at) <= c.freshnessMs) return { decision: 'ALREADY_DONE', key, detail: `obtained at ${lastDone.at}, still within its freshness window` };
    const sinceDone = lastDone ? failed.filter((p) => Date.parse(p.at) > Date.parse(lastDone.at)) : failed;
    if (sinceDone.length >= c.retry.maxAttempts) return { decision: 'REFUSED', key, reason: 'EXPECTED_STATE_MISSING', detail: `${sinceDone.length} attempts failed; the retry bound is ${c.retry.maxAttempts}` };
    const last = sinceDone[sinceDone.length - 1];
    if (last && now < Date.parse(last.at) + c.retry.backoffMs) return { decision: 'WAIT', key, retryAt: new Date(Date.parse(last.at) + c.retry.backoffMs).toISOString(), detail: 'backing off before the next read attempt' };
  }

  const hourAgo = now - 3_600_000;
  const recent = prior.filter((p) => Date.parse(p.at) > hourAgo).map((p) => Date.parse(p.at)).sort((a, b) => a - b);
  if (recent.length >= c.rateLimit.maxRunsPerHour) {
    return { decision: 'WAIT', key, retryAt: new Date(recent[recent.length - c.rateLimit.maxRunsPerHour]! + 3_600_000).toISOString(), detail: `the site's bound is ${c.rateLimit.maxRunsPerHour} runs an hour` };
  }
  const newest = recent[recent.length - 1];
  if (newest !== undefined && now - newest < c.rateLimit.minIntervalMs) {
    return { decision: 'WAIT', key, retryAt: new Date(newest + c.rateLimit.minIntervalMs).toISOString(), detail: `at least ${c.rateLimit.minIntervalMs} ms between runs` };
  }
  return { decision: 'RUN', key, attempt: mine.length + 1 };
}

/** Whether every output the capability declares was actually obtained by a run. Pure. */
export function verifyObtained(c: BrowserCapability, run: OperateResult['run']): { ok: boolean; missing: string[] } {
  if (run.outcome !== 'COMPLETED') return { ok: false, missing: c.outputs.map((o) => o.name) };
  const got = new Set([...run.extracted.filter((e) => e.text.trim().length > 0).map((e) => e.name), ...run.downloads.filter((d) => d.chars > 0).map((d) => d.name)]);
  const missing = c.outputs.map((o) => o.name).filter((n) => !got.has(n));
  return { ok: missing.length === 0, missing };
}

/* ------------------------------------------------------------------------- */
/* Records: append-only rows through recordBinEvent                           */
/* ------------------------------------------------------------------------- */

export interface CapabilityDeps {
  record?: typeof recordBinEvent;
  rows?: (host: string) => Promise<{ capabilities: CapabilityRow[]; runs: CapabilityRow[] }>;
  recordWorkflow?: typeof recordBrowserWorkflow;
  operate?: typeof operateWorkflow;
  operateDeps?: OperateDeps;
  now?: () => number;
}

async function readCapabilityRows(host: string): Promise<{ capabilities: CapabilityRow[]; runs: CapabilityRow[] }> {
  try {
    const pattern = hostMeasuresPattern(host);
    const capabilities = await getDb().all<CapabilityRow>(
      `SELECT measures, outcome, at FROM bin_events WHERE event_type = ? AND measures LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT 500`,
      [BROWSER_CAPABILITY_EVENT, pattern],
    );
    const runs = await getDb().all<CapabilityRow>(
      `SELECT measures, outcome, at FROM bin_events WHERE event_type = ? AND measures LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT 500`,
      [BROWSER_WORKFLOW_RUN_EVENT, pattern],
    );
    return { capabilities, runs };
  } catch {
    return { capabilities: [], runs: [] };
  }
}

/** A host's capabilities and their derived lifecycle. */
export async function readBrowserCapabilities(host: string, deps: CapabilityDeps = {}): Promise<Map<string, CapabilityRecord>> {
  const { capabilities, runs } = await (deps.rows ?? readCapabilityRows)(host);
  return capabilitiesFrom(capabilities, runs, (deps.now ?? Date.now)());
}

/**
 * Record a capability definition. Validated first; the workflow it wraps is
 * recorded through the workflow owner, so `operateWorkflow` runs exactly this
 * version. Recording the same content again changes nothing; any change is the
 * next version number, and earlier versions' rows are never touched.
 */
export async function recordBrowserCapability(capability: BrowserCapability, recordedBy: string, deps: CapabilityDeps = {}): Promise<CapabilityVersion> {
  const c = normalize(capability);
  const problems = validateCapability(c);
  if (problems.length > 0) throw new Error(`Refused: ${problems.join('; ')}`);
  if (!recordedBy.trim()) throw new Error('A capability names who recorded it.');
  const contentHash = capabilityHash(c);
  const existing = (await readBrowserCapabilities(c.workflow.host, deps)).get(capKey(c.workflow.host, c.workflow.name));
  const same = existing?.versions.find((v) => v.contentHash === contentHash);
  if (same && existing?.current.contentHash === contentHash) return same;
  const version = (existing?.current.version ?? 0) + 1;
  await (deps.recordWorkflow ?? recordBrowserWorkflow)(c.workflow, recordedBy, deps.record ? { record: deps.record } : {});
  await (deps.record ?? recordBinEvent)({
    eventType: BROWSER_CAPABILITY_EVENT,
    provider: c.workflow.origin === 'MODEL_ASSISTED' ? 'MODEL_ASSISTED' : 'BROWSER',
    workloadClass: 'acquisition',
    outcome: 'DEFINED',
    reason: `Capability "${c.workflow.name}" v${version} on ${c.workflow.host} (${c.effect}), maintained by ${c.maintenanceOwner}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    routineVersion: String(version),
    measures: { host: c.workflow.host, name: c.workflow.name, version, contentHash, by: recordedBy.trim(), capability: c },
  });
  return { version, contentHash, definedAt: new Date((deps.now ?? Date.now)()).toISOString(), capability: c };
}

/** A person approves, or retires, one exact version (by content hash). Append-only. */
export async function recordCapabilityDecision(
  input: { host: string; name: string; contentHash: string; decision: 'APPROVED' | 'RETIRED'; by: string; note?: string },
  deps: CapabilityDeps = {},
): Promise<CapabilityRecord> {
  if (!input.by.trim()) throw new Error('A decision names the person who made it.');
  const host = input.host.trim().toLowerCase();
  const record = (await readBrowserCapabilities(host, deps)).get(capKey(host, input.name));
  if (!record) throw new Error(`No capability "${input.name}" is recorded for ${host}.`);
  if (record.current.contentHash !== input.contentHash) throw new Error(`Refused: ${input.contentHash.slice(0, 12)} is not the current version (v${record.current.version}, ${record.current.contentHash.slice(0, 12)}).`);
  await (deps.record ?? recordBinEvent)({
    eventType: BROWSER_CAPABILITY_EVENT,
    provider: 'PERSON',
    workloadClass: 'acquisition',
    outcome: input.decision,
    reason: `${input.decision} "${record.name}" v${record.current.version} on ${host}${input.note ? `: ${input.note}` : ''}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    routineVersion: String(record.current.version),
    measures: { host, name: record.name, version: record.current.version, contentHash: record.current.contentHash, by: input.by.trim() },
  });
  return record;
}

export interface CapabilityRunResult {
  decision: RunDecision;
  result: OperateResult | null;
  /** COMPLETED only when every declared output was obtained. */
  outcome: 'COMPLETED' | 'FAILED' | 'UNKNOWN' | 'HANDOFF' | 'REFUSED' | 'SKIPPED';
  missing: string[];
}

/**
 * Run a capability once, through the workflow owner. Decided first from the
 * rows (approval, review, reauthorization, idempotency, retry and rate bounds);
 * a mutation records STARTED before it acts, so a second worker reading the
 * rows sees it in flight and refuses rather than repeating it. A mutation whose
 * run did not complete is recorded as UNKNOWN, never as not having happened.
 */
export async function runBrowserCapability(host: string, name: string, inputs: Record<string, string>, prior: readonly PriorRun[], deps: CapabilityDeps = {}): Promise<CapabilityRunResult> {
  const now = (deps.now ?? Date.now)();
  const record = (await readBrowserCapabilities(host, deps)).get(capKey(host, name));
  if (!record) return { decision: { decision: 'REFUSED', key: '', reason: 'NOT_APPROVED', detail: `no capability "${name}" on ${host}` }, result: null, outcome: 'REFUSED', missing: [] };
  const decision = planCapabilityRun(record, inputs, prior, now);
  const c = record.current.capability;
  const write = (outcome: string, detail: string, extra: Record<string, unknown> = {}) =>
    (deps.record ?? recordBinEvent)({
      eventType: BROWSER_CAPABILITY_EVENT,
      provider: 'BROWSER',
      workloadClass: 'acquisition',
      outcome: `RUN_${outcome}`,
      reason: detail.slice(0, 480),
      evidenceClass: 'MEASURED',
      routineVersion: String(record.current.version),
      measures: { host: record.host, name: record.name, version: record.current.version, contentHash: record.current.contentHash, effect: c.effect, key: decision.key, ...extra },
    });
  if (decision.decision !== 'RUN') {
    await write(decision.decision, decision.detail);
    return { decision, result: null, outcome: decision.decision === 'ALREADY_DONE' ? 'SKIPPED' : decision.decision === 'WAIT' ? 'SKIPPED' : 'REFUSED', missing: [] };
  }
  if (c.effect === 'MUTATION') await write('STARTED', `mutation attempt ${decision.attempt} started`, { attempt: decision.attempt });
  const result = await (deps.operate ?? operateWorkflow)(record.host, record.name, { ...(deps.operateDeps ?? {}), options: { ...(deps.operateDeps?.options ?? {}), timeoutMs: c.timeoutMs } });
  const verified = verifyObtained(c, result.run);
  let outcome: CapabilityRunResult['outcome'];
  if (verified.ok) outcome = 'COMPLETED';
  else if (result.run.steps.length === 0 && (result.run.outcome === 'HANDOFF' || result.run.outcome === 'REFUSED')) outcome = result.run.outcome;
  // Once any step ran, a mutation that did not verify may or may not have happened.
  else outcome = c.effect === 'MUTATION' ? 'UNKNOWN' : result.run.outcome === 'HANDOFF' ? 'HANDOFF' : 'FAILED';
  const reason = result.run.interfaceChanged ? 'INTERFACE_CHANGED' : result.run.boundary === 'AUTHENTICATION' && c.session.account ? 'SESSION_EXPIRED' : result.run.boundary ? 'BOUNDARY' : verified.ok ? null : 'EXPECTED_STATE_MISSING';
  await write(outcome, `${outcome}${reason ? ` (${reason})` : ''}: ${result.run.detail}`, { attempt: decision.attempt, failureReason: reason, missing: verified.missing });
  return { decision, result, outcome, missing: verified.missing };
}

/** Prior runs of a capability, read from its RUN_* rows, for `planCapabilityRun`. Pure. */
export function priorRunsFrom(capRows: readonly CapabilityRow[]): PriorRun[] {
  const out: PriorRun[] = [];
  for (const r of capRows) {
    const m = parse<{ key?: string }>(r.measures);
    if (!m?.key || !r.at || !r.outcome?.startsWith('RUN_')) continue;
    const o = r.outcome.slice(4);
    if (o === 'ALREADY_DONE' || o === 'WAIT' || o === 'REFUSED') continue;
    out.push({ key: m.key, outcome: o, at: r.at });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Discovery: the first successful run becomes a DRAFT capability             */
/* ------------------------------------------------------------------------- */

/** What a discovery cannot read from the run itself: who maintains it, and what it is given. */
export interface DiscoverySpec {
  maintenanceOwner: string;
  /** The inputs the workflow was given on this run; they become the first fixture. */
  inputs?: CapabilityField[];
  fixtureInputs?: Record<string, string>;
  /** Output name → description; an output without one is described by the workflow's purpose. */
  outputDescriptions?: Record<string, string>;
  timeoutMs?: number;
  freshnessMs?: number;
  /** How long an account session is trusted before a person reauthorizes it. */
  reauthorizeAfterMs?: number;
  rateLimit?: RateLimit;
  failureReasons?: string[];
}

/** Conservative defaults for a first draft; the approver sees and may change every one. */
export const DISCOVERY_DEFAULTS = {
  freshnessMs: 24 * 3_600_000,
  reauthorizeAfterMs: 7 * 24 * 3_600_000,
  rateLimit: { maxRunsPerHour: 6, minIntervalMs: 60_000 } as RateLimit,
  readRetry: { maxAttempts: 3, backoffMs: 30_000, retryAfterUnknown: true } as RetryPolicy,
  mutationRetry: { maxAttempts: 1, backoffMs: 0, retryAfterUnknown: false } as RetryPolicy,
  fixtureChars: 60,
};

export type DraftDecision = { drafted: true; capability: BrowserCapability } | { drafted: false; reason: string };

/** A short, secret-free excerpt of what a run obtained, used as the fixture's expectation. */
function fixtureExcerpt(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return redactText(line.slice(0, DISCOVERY_DEFAULTS.fixtureChars)).trim();
}

/**
 * The capability a successful run proves, or why that run proves none. Pure.
 *
 * Only a COMPLETED run that found the interface unchanged and obtained every
 * extract and download the workflow declares can be drafted. The effect is
 * MUTATION when any step presses a consequential control, else READ; expected
 * page states are the workflow's own `expect` steps (or, when it has none, the
 * URL the run ended on); the first fixture is what this run actually obtained.
 */
export function draftCapabilityFromRun(workflow: BrowserWorkflow, run: OperateResult['run'], spec: DiscoverySpec): DraftDecision {
  const host = workflow.host.trim().toLowerCase();
  if (run.host.trim().toLowerCase() !== host || run.name.trim().toLowerCase() !== workflow.name.trim().toLowerCase()) {
    return { drafted: false, reason: `the run is of "${run.name}" on ${run.host}, not "${workflow.name}" on ${host}` };
  }
  if (run.outcome !== 'COMPLETED') return { drafted: false, reason: `the run ended ${run.outcome}: ${redactText(run.detail)}`.slice(0, 400) };
  if (run.interfaceChanged) return { drafted: false, reason: 'the run found the interface changed; nothing is drafted from a guess' };
  if (!spec.maintenanceOwner?.trim()) return { drafted: false, reason: 'a draft names a maintenance owner' };

  const steps = workflow.steps ?? [];
  const captured = steps.flatMap((s) => (s.kind === 'extract' || s.kind === 'download' ? [s.name] : []));
  if (captured.length === 0) return { drafted: false, reason: 'the workflow obtains nothing (no extract or download step)' };
  const obtained = new Map<string, string>();
  for (const e of run.extracted) if (e.text.trim()) obtained.set(e.name, e.text);
  for (const d of run.downloads) if (d.chars > 0) obtained.set(d.name, d.text);
  const missing = captured.filter((n) => !obtained.has(n));
  if (missing.length > 0) return { drafted: false, reason: `the run did not obtain ${missing.join(', ')}; only a run that obtained every output is drafted` };

  const expectedStates: ExpectedState[] = [];
  steps.forEach((s, i) => {
    if (s.kind !== 'expect') return;
    const e: ExpectedState = { afterStep: i + 1 };
    if (s.text) e.text = s.text;
    if (s.absentText) e.absentText = s.absentText;
    if (s.urlIncludes) e.urlIncludes = s.urlIncludes;
    if (s.locator) e.locator = s.locator;
    expectedStates.push(e);
  });
  if (expectedStates.length === 0 && run.finalUrl) {
    try {
      const path = new URL(run.finalUrl).pathname;
      if (path && path !== '/') expectedStates.push({ afterStep: steps.length, urlIncludes: path });
    } catch {
      /* an unparseable final URL proves no page state */
    }
  }
  if (expectedStates.length === 0) return { drafted: false, reason: 'the run proves no page state (no expect step and no final URL path); a person adds one' };

  const expect: Record<string, string> = {};
  for (const n of captured) {
    const excerpt = fixtureExcerpt(obtained.get(n) ?? '');
    if (excerpt) expect[n] = excerpt;
  }
  const mutates = consequentialSteps(workflow).length > 0;
  const fixtureInputs = spec.fixtureInputs ?? {};
  const capability: BrowserCapability = {
    workflow: { ...workflow, host, name: workflow.name.trim() },
    inputs: spec.inputs ?? [],
    outputs: captured.map((n) => ({ name: n, description: spec.outputDescriptions?.[n] ?? `${n}, obtained by: ${workflow.purpose}`.slice(0, 200) })),
    effect: mutates ? 'MUTATION' : 'READ',
    expectedStates,
    timeoutMs: spec.timeoutMs ?? MAX_CAPABILITY_TIMEOUT_MS,
    retry: mutates ? { ...DISCOVERY_DEFAULTS.mutationRetry } : { ...DISCOVERY_DEFAULTS.readRetry },
    freshnessMs: spec.freshnessMs ?? DISCOVERY_DEFAULTS.freshnessMs,
    failureReasons: spec.failureReasons ?? [],
    fixtures: [{ name: 'discovered run', inputs: { ...fixtureInputs }, expect }],
    maintenanceOwner: spec.maintenanceOwner.trim(),
    session: { account: Boolean(workflow.account), reauthorizeAfterMs: workflow.account ? (spec.reauthorizeAfterMs ?? DISCOVERY_DEFAULTS.reauthorizeAfterMs) : null },
    rateLimit: spec.rateLimit ?? { ...DISCOVERY_DEFAULTS.rateLimit },
  };
  const problems = validateCapability(capability);
  if (problems.length > 0) return { drafted: false, reason: `the run's definition is not a capability yet: ${problems.join('; ')}`.slice(0, 600) };
  return { drafted: true, capability };
}

export interface DiscoveryResult {
  outcome: 'DRAFTED' | 'NOT_DRAFTED' | 'REFUSED';
  reason: string;
  version: CapabilityVersion | null;
  run: OperateResult['run'] | null;
}

/**
 * Turn a run a caller already holds into a DRAFT capability record. The
 * capability's lifecycle reads DRAFT until a person approves this exact
 * content hash; nothing here approves anything.
 */
export async function capabilityFromSuccessfulRun(
  workflow: BrowserWorkflow,
  run: OperateResult['run'],
  spec: DiscoverySpec,
  recordedBy: string,
  deps: CapabilityDeps = {},
): Promise<DiscoveryResult> {
  const draft = draftCapabilityFromRun(workflow, run, spec);
  if (!draft.drafted) return { outcome: 'NOT_DRAFTED', reason: draft.reason, version: null, run };
  const version = await recordBrowserCapability(draft.capability, recordedBy, deps);
  return { outcome: 'DRAFTED', reason: `recorded as DRAFT v${version.version} (${version.contentHash.slice(0, 12)}); it runs again once a person approves it`, version, run };
}

/**
 * The producer for "the model discovers once": run a recorded workflow once
 * through the workflow owner (its judgment, permission and session handling
 * unchanged) and, if that run succeeded, record it as a DRAFT capability.
 *
 * A workflow that presses a consequential control is never run to discover it
 * — discovery must not perform a purchase, publication or deletion. Such a
 * workflow is drafted from a run that was already approved and performed,
 * through `capabilityFromSuccessfulRun`.
 */
export async function discoverBrowserCapability(
  hostIn: string,
  name: string,
  spec: DiscoverySpec,
  recordedBy: string,
  deps: CapabilityDeps & { workflows?: OperateDeps['workflows'] } = {},
): Promise<DiscoveryResult> {
  const host = hostIn.trim().toLowerCase();
  if (!recordedBy.trim()) return { outcome: 'REFUSED', reason: 'a discovery names who recorded it', version: null, run: null };
  // Read the definition before anything runs: a consequential workflow is refused without opening a browser.
  const workflows = deps.workflows ?? deps.operateDeps?.workflows ?? readBrowserWorkflows;
  const known = (await workflows(host)).get(capKey(host, name)) ?? null;
  if (!known) return { outcome: 'NOT_DRAFTED', reason: `no workflow "${name}" is recorded for ${host}`, version: null, run: null };
  if (consequentialSteps(known.workflow).length > 0) {
    return { outcome: 'REFUSED', reason: `"${name}" presses a consequential control (${consequentialSteps(known.workflow).map((x) => `step ${x.step} ${x.why}`).join('; ')}); it is not run to discover it`, version: null, run: null };
  }
  const result = await (deps.operate ?? operateWorkflow)(host, name, { ...(deps.operateDeps ?? {}), workflows });
  const workflow = result.record?.workflow ?? known.workflow;
  // The owner ran whatever definition was newest at that moment; it is re-checked, never assumed.
  if (consequentialSteps(workflow).length > 0) {
    return { outcome: 'REFUSED', reason: `"${name}" presses a consequential control; it is drafted only from an approved run`, version: null, run: result.run };
  }
  return capabilityFromSuccessfulRun(workflow, result.run, spec, recordedBy, deps);
}
