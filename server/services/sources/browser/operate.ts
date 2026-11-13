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
 *  1. load the capability's current version and make the one pre-run
 *     decision, `planCapabilityRun`: only an APPROVED or ACTIVE version runs
 *     (REVIEW and REAUTHORIZE are handoffs, never retried), and a read
 *     already fresh or backing off is deferred;
 *  2. the inputs are exactly the declared ones (the same decision);
 *  3. classify the steps and require an approval bound to each effectful step
 *     — a CONSEQUENTIAL step without its approval is refused here;
 *  4. check the one request budget — the host's limit and the capability's
 *     declared rate, over the same run rows — and, for anything that changes
 *     state, claim the logical effect key (`capabilityEffectKey`, the same key
 *     the plan reports) so a second worker cannot repeat it;
 *  5. run through the existing owner, `operateWorkflow` → `runBrowserWorkflow`
 *     (its acquisition judgment, OPERATE_PERMISSION check, destination checks
 *     and browser slot are unchanged);
 *     The steps that run are the approved ones with each declared expected
 *     page state checked as an `expect` step after the step it names
 *     (`executedWorkflow`);
 *  6. verify the outcome against the declared outputs and, when given, the
 *     expected page state and datasets. A declared expected state that did
 *     not hold, or a READ's fixture (one whose inputs are this run's) that
 *     the run did not satisfy, moves the capability to REVIEW: the run row
 *     carries `interfaceChanged`, from which the lifecycle is derived;
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
 * BROWSER_CAPABILITY `RUN_*` row, beside the capability's own definition and
 * approval rows, so it does not disturb the run history the lifecycle is
 * derived from.
 *
 * This is the only path a capability runs through. Whether a mutation was
 * already performed or is in flight is decided by the effect claim in step 4
 * (`reserveOperation`'s single conditional insert), never by rows read before
 * the run: a read-then-write check lets two workers both pass (invariant 24).
 *
 * No table, queue, scheduler or authority path is added, and nothing here
 * names a host, category or industry.
 */
import { recordBinEvent, type RecordBinEventInput } from '../../../repos/bins.ts';
import { BROWSER_WORKFLOW_RUN_EVENT, MAX_WORKFLOW_STEPS, operateWorkflow, readBrowserWorkflows, type OperateDeps, type OperateResult, type WorkflowRecord, type WorkflowRun } from '../browserWorkflow.ts';
import type { ActorType } from '../../../domain/types.ts';
import { authorizeActions, type ActionClass, type ApprovedAction, type WorkflowJudgment } from './actionClass.ts';
import {
  BROWSER_CAPABILITY_EVENT,
  effectSubject,
  executedWorkflow,
  expectedStateResults,
  fixtureResults,
  planCapabilityRun,
  outcomeExpectationFor,
  readBrowserCapabilities,
  verifyObtained,
  type PriorRun,
  type CapabilityDeps,
  type CapabilityRecord,
  type CapabilityStatus,
  type ExpectedStateResult,
  type FixtureResult,
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
  | 'FIXTURE_FAILED'
  | 'FRESH'
  | 'RETRY_BACKOFF'
  | string;

export interface OperateCapabilityInput {
  /** The project the work belongs to, from the server's own record of the work. */
  projectId: string;
  host: string;
  name: string;
  inputs: Record<string, string>;
  /** Approvals recorded for this capability's effectful steps, each bound to a step fingerprint. */
  approvals?: readonly ApprovedAction[];
  /**
   * Expected page state, datasets, downloads and freshness, verified after the run.
   * When omitted, the run is verified against `outcomeExpectationFor` of the approved version.
   */
  expectation?: OutcomeExpectation;
  /** The request limit the site declares, per minute, when it declares one. */
  declaredPerMinute?: number | null;
  /** This capability's earlier read results by effect key, for freshness and the retry bound. Never consulted for a mutation. */
  priorReads?: readonly PriorRun[];
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
  /** Each declared expected page state, as the run found it (empty when no session opened). */
  expectedStates: ExpectedStateResult[];
  /** The fixtures whose inputs are this run's inputs, judged against what it obtained (a READ only). */
  fixtures: FixtureResult[];
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
    effectKey: null, budget: null, verification: null, expectedStates: [], fixtures: [], run: null, sessionOpened: false,
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

  // 1–2. The one pre-run decision: lifecycle (only an approved version runs; review and
  // reauthorization are handoffs), exactly the declared inputs, and a read's freshness and retry bound.
  const plan = planCapabilityRun(cap, input.inputs, input.priorReads ?? [], now.getTime());
  const keyed = { ...base, effectKey: plan.key };
  if (plan.decision === 'REFUSED') {
    if (plan.reason === 'INTERFACE_CHANGED') return decided({ ...keyed, outcome: 'REVIEW', failureReason: plan.reason, detail: plan.detail });
    if (plan.reason === 'SESSION_EXPIRED') return decided({ ...keyed, outcome: 'REAUTHORIZE', failureReason: plan.reason, detail: plan.detail });
    return decided({ ...keyed, failureReason: plan.reason, detail: plan.detail });
  }
  if (plan.decision === 'ALREADY_DONE') return decided({ ...keyed, outcome: 'DEFERRED', failureReason: 'FRESH', detail: plan.detail });
  if (plan.decision === 'WAIT') return decided({ ...keyed, outcome: 'DEFERRED', failureReason: 'RETRY_BACKOFF', detail: `${plan.detail}; retry at ${plan.retryAt}` });

  // 3. Classify every step; each effectful step needs its own approval, bound to it.
  const auth = authorizeActions(c.workflow, input.approvals ?? []);
  const actionClass = auth.judgment.actionClass;
  const classified = { ...keyed, actionClass, judgment: auth.judgment };
  if (!auth.permitted) {
    return decided({ ...classified, failureReason: 'APPROVAL_MISSING', detail: `refused before submission: ${auth.refusals.map((r) => r.reason).join('; ')}` });
  }
  if (actionClass !== 'IDEMPOTENT_READ' && c.effect === 'READ') {
    return decided({ ...classified, failureReason: 'EFFECT_UNDECLARED', detail: `the capability is declared a READ but step ${auth.judgment.effectSteps[0]} is ${auth.judgment.steps[auth.judgment.effectSteps[0]!]?.actionClass}; a new version must declare the mutation` });
  }
  const mutates = actionClass !== 'IDEMPOTENT_READ' || c.effect === 'MUTATION';
  // The steps that run: the approved ones, each declared expected page state checked after the step it names.
  const executed = executedWorkflow(c);
  if (executed.workflow.steps.length > MAX_WORKFLOW_STEPS) {
    return decided({ ...classified, failureReason: 'EXPECTED_STATE_MISSING', detail: `the approved steps and their expected-state checks are ${executed.workflow.steps.length} steps, more than ${MAX_WORKFLOW_STEPS}; a new version checks fewer states` });
  }

  // 4. The one request budget (the host's limit and this capability's declared rate), then the effect claim.
  const guard: GuardDecision = await (deps.guard ?? guardBrowserRun)({
    projectId: input.projectId,
    capability: effectSubject(cap),
    approvedInput: input.inputs,
    actor: input.actor,
    workItemId: input.workItemId ?? null,
    effect: mutates ? 'MUTATION' : 'READ',
    declaredPerMinute: input.declaredPerMinute ?? null,
    capabilityRate: { name: cap.name, maxRunsPerHour: c.rateLimit.maxRunsPerHour, minIntervalMs: c.rateLimit.minIntervalMs },
    now,
    ...(deps.runRows ? { rows: deps.runRows } : {}),
  });
  // The claim derives its key with the same function as the plan; they are one key.
  const effectKey = guard.claim?.effectKey ?? plan.key;
  const guarded = { ...classified, budget: guard.budget, effectKey };
  if (guard.decision === 'DEFER') return decided({ ...guarded, outcome: 'DEFERRED', failureReason: 'RATE_LIMITED', detail: guard.budget.reason });
  if (guard.decision === 'REFUSE') {
    const claim = guard.claim;
    const unknown = !claim.claimed && claim.reason === 'UNKNOWN';
    return decided({ ...guarded, failureReason: unknown ? 'OUTCOME_UNKNOWN' : 'DUPLICATE_EFFECT', detail: claim.claimed ? '' : `${claim.reason}: ${claim.detail}` });
  }
  const operationId = guard.claim?.claimed ? guard.claim.operationId : null;

  // 5. Run through the existing owner. Its run row is captured here and written once, enriched, below.
  // The owner is pinned to the approved version's step list: the steps classified and
  // authorized above are the steps that run. The newest BROWSER_WORKFLOW row for this
  // host/name is written separately (and `recordBrowserWorkflow` is callable on its own),
  // so reading it here would let a step list nobody approved run under this approval.
  // Only its lifecycle (retired, interface changed, draft) is taken from the store.
  // Every declared expected state is checked as an `expect` step after the step it names
  // (`executedWorkflow`), so a page that no longer reaches a declared state is seen.
  const approvedWorkflow = executed.workflow;
  const readStored = deps.operateDeps?.workflows ?? readBrowserWorkflows;
  const pinnedWorkflows = async (h: string): Promise<Map<string, WorkflowRecord>> => {
    const stored = await readStored(h);
    const pinned = new Map<string, WorkflowRecord>();
    for (const [key, r] of stored) {
      if (r.workflow.host.trim().toLowerCase() === cap.host.toLowerCase() && r.workflow.name.trim().toLowerCase() === cap.name.trim().toLowerCase()) {
        pinned.set(key, { ...r, workflow: approvedWorkflow });
      }
    }
    return pinned;
  };
  let captured: RecordBinEventInput | null = null;
  let result: OperateResult | null = null;
  let thrown: string | null = null;
  try {
    result = await (deps.operate ?? operateWorkflow)(cap.host, cap.name, {
      ...(deps.operateDeps ?? {}),
      workflows: pinnedWorkflows,
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
  // A declared expected page state that did not hold is the interface no longer behaving as
  // approved: validation and review, never a guess past it (the lifecycle reads interfaceChanged).
  const states = expectedStateResults(c, executed, run);
  const stateMissing = states.filter((x) => x.result === 'MISSING');
  // A READ's fixtures that apply to these inputs: what this version must obtain when given them.
  // A mutation's output differs per performance by design, so its fixtures are not judged on a live run.
  const fixtures = !mutates && run.outcome === 'COMPLETED' ? fixtureResults(c, input.inputs, run) : [];
  const fixtureFailed = fixtures.filter((f) => f.result === 'FAILED');
  const interfaceChanged = run.interfaceChanged || stateMissing.length > 0 || fixtureFailed.length > 0;
  if (stateMissing.length > 0 || fixtureFailed.length > 0) {
    const why = [
      ...stateMissing.map((x) => `expected state ${x.state + 1} (after step ${x.afterStep}) did not hold: ${x.detail}`),
      ...fixtureFailed.map((f) => `fixture "${f.name}" failed: ${f.failures.join('; ')}`),
    ].join('; ');
    run.detail = `${run.detail}; ${why}`.slice(0, 400);
  }
  // Whether anything could have been submitted: a step ran, or the run died with no record of how far it got.
  const stepsRan = run.steps.length > 0 || thrown !== null;

  // 6. Verify.
  const obtained = verifyObtained(c, run);
  // Always judged: the caller's expectation when it states one, otherwise what the approved version promises.
  const expectation = input.expectation ?? outcomeExpectationFor(c);
  const verification: OutcomeVerification | null = verifyOutcome(run, expectation, { now, ...(deps.finalPage ? { finalPage: deps.finalPage } : {}) });
  const verified = run.outcome === 'COMPLETED' && obtained.ok && (verification?.verified ?? true) && !interfaceChanged;

  let outcome: OperateOutcome;
  let failureReason: OperateFailureReason | null;
  if (verified) {
    outcome = 'COMPLETED';
    failureReason = null;
  } else if (interfaceChanged) {
    outcome = 'REVIEW';
    failureReason = run.interfaceChanged || stateMissing.length > 0 ? 'INTERFACE_CHANGED' : 'FIXTURE_FAILED';
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
      interfaceChanged,
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
        expectedStates: states.map((x) => ({ state: x.state, afterStep: x.afterStep, result: x.result })),
        fixtures: fixtures.map((f) => ({ name: f.name, result: f.result })),
      },
    },
  }));

  return {
    ...guarded,
    outcome,
    failureReason,
    detail: safeRun.detail,
    verification,
    expectedStates: states,
    fixtures,
    run: { ...safeRun, interfaceChanged },
    sessionOpened: true,
  };
}
