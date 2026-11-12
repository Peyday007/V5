/**
 * Running an approved browser capability deterministically (ACQ-21-5).
 *
 * The sibling modules each decide one thing about a browser routine:
 *
 *  - `capability.ts`   — which version is current and its lifecycle, read from rows;
 *  - `actionClass.ts`  — what each step would do to the world, and whether the
 *                        recorded approvals cover it;
 *  - `effectGuard.ts`  — that one mutation is performed once, and that the
 *                        host's request limit holds across workers;
 *  - `verifyOutcome.ts`— whether the run actually obtained what it promised;
 *  - `redaction.ts`    — that nothing recorded carries a secret.
 *
 * This module composes them into the one path a capability runs through, in
 * this order, and every refusal happens before any browser session opens:
 *
 *  1. load the capability's current version; only an APPROVED or ACTIVE
 *     version runs. REVIEW (the interface changed) and REAUTHORIZE (the
 *     signed-in session was rejected or aged out) are handoffs, never retried;
 *  2. check the inputs against the declared ones;
 *  3. classify the steps and require an approval bound to each effectful step
 *     — a CONSEQUENTIAL step without its approval is refused here;
 *  4. check the host's request limit and, for anything that changes state,
 *     claim the logical effect key so a second worker cannot repeat it;
 *  5. run through the existing owner, `operateWorkflow` → `runBrowserWorkflow`
 *     (its acquisition judgment, OPERATE_PERMISSION check, destination checks
 *     and browser slot are unchanged);
 *  6. verify the outcome against the declared outputs and, when given, the
 *     expected page state and datasets;
 *  7. settle the effect claim (COMPLETED, FAILED, or UNKNOWN — never assumed
 *     not to have happened once a step ran);
 *  8. write exactly one BROWSER_WORKFLOW_RUN row through `recordBinEvent`,
 *     redacted, carrying the capability version, action class, effect key,
 *     verification and failure reason. The run row the workflow owner would
 *     write is captured and enriched rather than written twice, and a
 *     completed run that did not verify is recorded as FAILED so the
 *     lifecycle derived from these rows never counts it as a success.
 *
 * A refusal or deferral that never reached the site is recorded as a
 * BROWSER_CAPABILITY `RUN_*` row, beside the capability's own decisions, so it
 * does not disturb the run history the lifecycle is derived from.
 *
 * This is the only path a capability runs through. A mutation is performed
 * only by the worker whose effect claim won `reserveOperation`'s single
 * conditional INSERT (step 4); rows read before a run are never what permits
 * it, because two workers can both read before either writes (invariant 24).
 *
 * No table, queue, scheduler or authority path is added, and nothing here
 * names a host, category or industry.
 */
import { recordBinEvent, type RecordBinEventInput } from '../../../repos/bins.ts';
import { BROWSER_WORKFLOW_RUN_EVENT, operateWorkflow, type OperateDeps, type OperateResult, type WorkflowRun } from '../browserWorkflow.ts';
import type { ActorType } from '../../../domain/types.ts';
import { authorizeActions, type ActionClass, type ApprovedAction, type WorkflowJudgment } from './actionClass.ts';
import {
  BROWSER_CAPABILITY_EVENT,
  readBrowserCapabilities,
  verifyObtained,
  type CapabilityDeps,
  type CapabilityRecord,
  type CapabilityStatus,
} from './capability.ts';
import { guardBrowserRun, settleBrowserEffect, type GuardDecision, type RequestBudget, type RunRow } from './effectGuard.ts';
import { redactLog, redactRun } from './redaction.ts';
import { verifyOutcome, type FinalPage, type OutcomeExpectation, type OutcomeVerification } from './verifyOutcome.ts';

export type OperateOutcome =
  /** Ran, and every declared output and expectation was verified. */
  | 'COMPLETED'
  /** Ran and did not obtain what it promised; nothing state-changing is in doubt. */
  | 'FAILED'
  /** A state-changing run whose effect is not known. Never retried automatically. */
  | 'UNKNOWN'
  /** The interface changed: the capability is in validation/review, not retried. */
  | 'REVIEW'
  /** The signed-in session was rejected or is too old: a person reauthorizes it. */
  | 'REAUTHORIZE'
  /** A boundary (sign-in wall, challenge, judgment) handed the run to a person. */
  | 'HANDOFF'
  /** The host is at its request limit: tried later, never exceeded. */
  | 'DEFERRED'
  /** Refused before any browser session opened. */
  | 'REFUSED';

export type OperateFailureReason =
  | 'NO_CAPABILITY'
  | 'NOT_APPROVED'
  | 'RETIRED'
  | 'BAD_INPUT'
  | 'APPROVAL_MISSING'
  | 'EFFECT_UNDECLARED'
  | 'DUPLICATE_EFFECT'
  | 'OUTCOME_UNKNOWN'
  | 'RATE_LIMITED'
  | 'INTERFACE_CHANGED'
  | 'SESSION_EXPIRED'
  | 'BOUNDARY'
  | 'EXPECTED_STATE_MISSING'
  | string;

export interface OperateCapabilityInput {
  /** The project the work belongs to, from the server's own record of the work. */
  projectId: string;
  host: string;
  name: string;
  inputs: Record<string, string>;
  /** Approvals recorded for this capability's effectful steps, each bound to a step fingerprint. */
  approvals?: readonly ApprovedAction[];
  /** Expected page state, datasets, downloads and freshness, verified after the run. */
  expectation?: OutcomeExpectation;
  /** The request limit the site declares, per minute, when it declares one. */
  declaredPerMinute?: number | null;
  actor: { type: ActorType; id: string | null };
  workItemId?: string | null;
}

export interface OperateCapabilityDeps {
  capabilities?: (host: string) => Promise<Map<string, CapabilityRecord>>;
  capabilityDeps?: CapabilityDeps;
  operate?: typeof operateWorkflow;
  operateDeps?: OperateDeps;
  record?: typeof recordBinEvent;
  guard?: typeof guardBrowserRun;
  settle?: typeof settleBrowserEffect;
  /** The host's recent run rows, for the request limit; defaults to reading bin_events. */
  runRows?: (host: string, now: Date) => Promise<RunRow[]>;
  finalPage?: FinalPage;
  now?: () => Date;
}

export interface OperateCapabilityResult {
  outcome: OperateOutcome;
  failureReason: OperateFailureReason | null;
  detail: string;
  capability: { host: string; name: string; version: number; contentHash: string; status: CapabilityStatus } | null;
  actionClass: ActionClass | null;
  judgment: WorkflowJudgment | null;
  effectKey: string | null;
  budget: RequestBudget | null;
  verification: OutcomeVerification | null;
  /** The run as recorded: redacted. */
  run: WorkflowRun | null;
  /** Whether a browser session was opened for this call. */
  sessionOpened: boolean;
}

const findRecord = (records: Map<string, CapabilityRecord>, host: string, name: string): CapabilityRecord | null => {
  const want = name.trim().toLowerCase();
  for (const r of records.values()) if (r.host.toLowerCase() === host && r.name.trim().toLowerCase() === want) return r;
  return null;
};

/**
 * Run one approved capability once, through the existing workflow owner.
 * Every refusal is decided before a browser session opens.
 */
export async function operateCapability(input: OperateCapabilityInput, deps: OperateCapabilityDeps = {}): Promise<OperateCapabilityResult> {
  const now = (deps.now ?? (() => new Date()))();
  const host = input.host.trim().toLowerCase();
  const record = deps.record ?? recordBinEvent;
  const empty: OperateCapabilityResult = {
    outcome: 'REFUSED', failureReason: null, detail: '', capability: null, actionClass: null, judgment: null,
    effectKey: null, budget: null, verification: null, run: null, sessionOpened: false,
  };

  const records = await (deps.capabilities ?? ((h: string) => readBrowserCapabilities(h, deps.capabilityDeps ?? {})))(host);
  const cap = findRecord(records, host, input.name);
  if (!cap) return { ...empty, failureReason: 'NO_CAPABILITY', detail: `no capability "${input.name}" is recorded for ${host}` };
  const c = cap.current.capability;
  const capability = { host: cap.host, name: cap.name, version: cap.current.version, contentHash: cap.current.contentHash, status: cap.status };
  const base: OperateCapabilityResult = { ...empty, capability };

  /** A decision that never reached the site: recorded beside the capability, redacted. */
  const decided = async (result: OperateCapabilityResult): Promise<OperateCapabilityResult> => {
    await record(redactLog<RecordBinEventInput>({
      eventType: BROWSER_CAPABILITY_EVENT,
      provider: 'BROWSER',
      workloadClass: 'acquisition',
      outcome: `RUN_${result.outcome}`,
      reason: `${result.outcome}${result.failureReason ? ` (${result.failureReason})` : ''}: ${result.detail}`.slice(0, 480),
      evidenceClass: 'MEASURED',
      routineVersion: String(cap.current.version),
      measures: {
        host: cap.host, name: cap.name, version: cap.current.version, contentHash: cap.current.contentHash,
        actionClass: result.actionClass, effectKey: result.effectKey, failureReason: result.failureReason,
        ...(result.budget ? { budget: { limit: result.budget.limit, counted: result.budget.counted, countedRowIds: result.budget.countedRowIds, retryAfter: result.budget.retryAfter } } : {}),
      },
    }));
    return result;
  };

  // 1. Lifecycle: only an approved version runs; review and reauthorization are handoffs.
  if (cap.status === 'RETIRED') return decided({ ...base, failureReason: 'RETIRED', detail: cap.why });
  if (cap.status === 'DRAFT') return decided({ ...base, failureReason: 'NOT_APPROVED', detail: cap.why });
  if (cap.status === 'REVIEW') return decided({ ...base, outcome: 'REVIEW', failureReason: 'INTERFACE_CHANGED', detail: cap.why });
  if (cap.handoff === 'REAUTHORIZE') return decided({ ...base, outcome: 'REAUTHORIZE', failureReason: 'SESSION_EXPIRED', detail: cap.why });

  // 2. Inputs are exactly the declared ones.
  const missing = c.inputs.filter((f) => typeof input.inputs[f.name] !== 'string').map((f) => f.name);
  const extra = Object.keys(input.inputs).filter((k) => !c.inputs.some((f) => f.name === k));
  if (missing.length || extra.length) {
    return decided({ ...base, failureReason: 'BAD_INPUT', detail: `inputs: missing ${missing.join(', ') || 'none'}; undeclared ${extra.join(', ') || 'none'}` });
  }

  // 3. Classify every step; each effectful step needs its own approval, bound to it.
  const auth = authorizeActions(c.workflow, input.approvals ?? []);
  const actionClass = auth.judgment.actionClass;
  const classified = { ...base, actionClass, judgment: auth.judgment };
  if (!auth.permitted) {
    return decided({ ...classified, failureReason: 'APPROVAL_MISSING', detail: `refused before submission: ${auth.refusals.map((r) => r.reason).join('; ')}` });
  }
  if (actionClass !== 'IDEMPOTENT_READ' && c.effect === 'READ') {
    return decided({ ...classified, failureReason: 'EFFECT_UNDECLARED', detail: `the capability is declared a READ but step ${auth.judgment.effectSteps[0]} is ${auth.judgment.steps[auth.judgment.effectSteps[0]!]?.actionClass}; a new version must declare the mutation` });
  }
  const mutates = actionClass !== 'IDEMPOTENT_READ' || c.effect === 'MUTATION';

  // 4. Request limit, then the effect claim.
  const guard: GuardDecision = await (deps.guard ?? guardBrowserRun)({
    projectId: input.projectId,
    capability: { host: cap.host, name: cap.name, version: `v${cap.current.version}:${cap.current.contentHash}` },
    approvedInput: input.inputs,
    actor: input.actor,
    workItemId: input.workItemId ?? null,
    effect: mutates ? 'MUTATION' : 'READ',
    declaredPerMinute: input.declaredPerMinute ?? null,
    now,
    ...(deps.runRows ? { rows: deps.runRows } : {}),
  });
  const effectKey = guard.claim?.effectKey ?? null;
  const guarded = { ...classified, budget: guard.budget, effectKey };
  if (guard.decision === 'DEFER') return decided({ ...guarded, outcome: 'DEFERRED', failureReason: 'RATE_LIMITED', detail: guard.budget.reason });
  if (guard.decision === 'REFUSE') {
    const claim = guard.claim;
    const unknown = !claim.claimed && claim.reason === 'UNKNOWN';
    return decided({ ...guarded, failureReason: unknown ? 'OUTCOME_UNKNOWN' : 'DUPLICATE_EFFECT', detail: claim.claimed ? '' : `${claim.reason}: ${claim.detail}` });
  }
  const operationId = guard.claim?.claimed ? guard.claim.operationId : null;

  // 5. Run through the existing owner. Its run row is captured here and written once, enriched, below.
  let captured: RecordBinEventInput | null = null;
  let result: OperateResult | null = null;
  let thrown: string | null = null;
  try {
    result = await (deps.operate ?? operateWorkflow)(cap.host, cap.name, {
      ...(deps.operateDeps ?? {}),
      record: async (e: RecordBinEventInput) => {
        captured = e;
      },
      options: { ...(deps.operateDeps?.options ?? {}), timeoutMs: c.timeoutMs },
    });
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  const run: WorkflowRun = result?.run ?? {
    host: cap.host, name: cap.name, outcome: 'FAILED', steps: [], extracted: [], downloads: [], finalUrl: null,
    boundary: null, interfaceChanged: false, detail: `the run ended without a result: ${thrown ?? 'no result'}`,
  };
  // Whether anything could have been submitted: a step ran, or the run died with no record of how far it got.
  const stepsRan = run.steps.length > 0 || thrown !== null;

  // 6. Verify.
  const obtained = verifyObtained(c, run);
  const verification = input.expectation ? verifyOutcome(run, input.expectation, { now, ...(deps.finalPage ? { finalPage: deps.finalPage } : {}) }) : null;
  const verified = run.outcome === 'COMPLETED' && obtained.ok && (verification?.verified ?? true);

  let outcome: OperateOutcome;
  let failureReason: OperateFailureReason | null;
  if (verified) {
    outcome = 'COMPLETED';
    failureReason = null;
  } else if (run.interfaceChanged) {
    outcome = 'REVIEW';
    failureReason = 'INTERFACE_CHANGED';
  } else if (run.boundary === 'AUTHENTICATION' && c.session.account) {
    outcome = 'REAUTHORIZE';
    failureReason = 'SESSION_EXPIRED';
  } else if (mutates && stepsRan) {
    outcome = 'UNKNOWN';
    failureReason = 'OUTCOME_UNKNOWN';
  } else if (run.outcome === 'HANDOFF' || run.boundary) {
    outcome = 'HANDOFF';
    failureReason = 'BOUNDARY';
  } else if (run.outcome === 'REFUSED') {
    outcome = 'REFUSED';
    failureReason = 'BOUNDARY';
  } else {
    outcome = 'FAILED';
    failureReason = verification?.failureReason ?? 'EXPECTED_STATE_MISSING';
  }
  // A mutation that ran a step and then hit a changed interface or a rejected session may still have acted.
  const effectUnknown = mutates && stepsRan && !verified;

  // 7. Settle the claim.
  if (operationId) {
    const settle = deps.settle ?? settleBrowserEffect;
    if (verified) await settle(operationId, { result: 'COMPLETED', summary: `verified: ${cap.name} v${cap.current.version}` });
    else if (effectUnknown) await settle(operationId, { result: 'UNKNOWN', reason: `${failureReason ?? 'unverified'}: ${run.detail}`.slice(0, 400) });
    else await settle(operationId, { result: 'FAILED', detail: `nothing was submitted: ${failureReason ?? 'not run'}: ${run.detail}`.slice(0, 400) });
  }

  // 8. One run row, redacted, carrying the version, class, key, verification and reason.
  const safeRun = redactRun(run);
  const prior = (captured as RecordBinEventInput | null) ?? null;
  const rowOutcome = run.outcome === 'COMPLETED' && !verified ? 'FAILED' : run.outcome;
  await record(redactLog<RecordBinEventInput>({
    ...(prior ?? {}),
    eventType: BROWSER_WORKFLOW_RUN_EVENT,
    provider: prior?.provider ?? 'BROWSER',
    workloadClass: 'acquisition',
    outcome: rowOutcome,
    reason: `${outcome}${failureReason ? ` (${failureReason})` : ''}: ${safeRun.detail}`.slice(0, 480),
    evidenceClass: 'MEASURED',
    routineVersion: String(cap.current.version),
    measures: {
      ...(prior?.measures ?? {}),
      host: cap.host,
      name: cap.name,
      boundary: run.boundary,
      interfaceChanged: run.interfaceChanged,
      finalUrl: safeRun.finalUrl,
      steps: safeRun.steps,
      stepsOutcome: run.outcome,
      capability: { version: cap.current.version, contentHash: cap.current.contentHash },
      actionClass,
      effectKey,
      outcome,
      failureReason,
      verification: {
        verified,
        missing: obtained.missing,
        checks: verification?.checks ?? [],
        asOf: verification?.asOf ?? null,
      },
    },
  }));

  return {
    ...guarded,
    outcome,
    failureReason,
    detail: safeRun.detail,
    verification,
    run: safeRun,
    sessionOpened: true,
  };
}
