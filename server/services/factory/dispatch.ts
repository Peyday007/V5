/**
 * Running one unit on one worker.
 *
 * Everything between "the scheduler chose this pairing" and "the repository has
 * a branch the integrator can judge" happens here: the worktree, the session
 * row, the assignment, the execution, and the honest reading of what came back.
 *
 * The reading is the part worth being careful about. A worker can end in four
 * ways and they are four different facts:
 *
 *   * **It produced commits.** The unit is IMPLEMENTED — which means only that
 *     there is something to integrate, not that it was right.
 *   * **It produced nothing.** A failure, retryable, with the attempt spent. A
 *     worker that wrote a confident summary and no code has not done the work,
 *     and the branch is how the factory knows.
 *   * **The provider refused it.** Not a failure. The unit is deferred, the
 *     attempt is refunded, and the worker is marked rate-limited rather than
 *     quarantined — §23's sentence, which this file is the place that has to
 *     mean it.
 *   * **It errored or ran out of time.** A failure against the worker as well as
 *     the unit, because something about the surface did not work.
 *
 * A checkpoint is recorded in every one of those cases where the worker managed
 * to write one, because the next attempt may be a different worker and the only
 * thing that makes that cheap is a handover somebody else can read.
 */
import path from 'node:path';
import type {
  FactoryCampaign,
  FactoryChangeRequest,
  FactoryFinding,
  FactoryRole,
  FactoryWorker,
} from '../../domain/factory.ts';
import {
  deferUnit,
  failUnit,
  getUnit,
  latestCheckpoint,
  markImplemented,
  recordCheckpoint,
  refundAttempt,
  type ClaimedUnit,
} from '../../repos/factory.ts';
import {
  closeSession,
  listIntegrations,
  openSession,
  putArtifact,
  recordFactoryEvent,
  recordWorkerFailure,
  recordWorkerRateLimit,
  recordWorkerSuccess,
} from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { compileImplementationAssignment, parseWorkerReport } from './prompts.ts';
import { executorFor } from './executors/index.ts';
import { campaignWorkspace, commitAll, ensureWorktree, gitOrThrow, resolveSha } from './git.ts';

/** How long one unit's worker may run before it is stopped. */
export const DEFAULT_UNIT_TIMEOUT_MS = 25 * 60 * 1000;

/**
 * A branch per attempt, from the attempt's own base.
 *
 * Per attempt rather than per unit so a retry starts from a clean base instead of
 * inheriting the commit that was rejected — and so every earlier attempt stays
 * readable. Nothing deletes a branch: an abandoned worktree is retired, its
 * evidence is not.
 */
export function branchFor(campaign: FactoryCampaign, unitKey: string, attempt: number): string {
  return `factory/${campaign.id}/${unitKey}/a${attempt}`;
}

export function worktreeFor(campaign: FactoryCampaign, unitKey: string, attempt: number): string {
  return path.join(campaignWorkspace(campaign.id), `${unitKey}-a${attempt}`);
}

export interface ExecuteUnitInput {
  repoRoot: string;
  campaign: FactoryCampaign;
  changeRequest: FactoryChangeRequest;
  claimed: ClaimedUnit;
  worker: FactoryWorker;
  model: string;
  role: FactoryRole;
  /** The finding this unit repairs, when it is a repair. */
  finding?: FactoryFinding | null;
  timeoutMs?: number;
  /** Overrides the compiled assignment. A test seam; production never passes it. */
  assignmentOverride?: string;
}

export interface ExecuteUnitResult {
  outcome: 'IMPLEMENTED' | 'NO_CHANGE' | 'DEFERRED' | 'FAILED';
  sessionId: string;
  externalSessionId: string | null;
  branch: string;
  headSha: string | null;
  detail: string;
  durationMs: number;
}

export async function executeUnit(input: ExecuteUnitInput): Promise<ExecuteUnitResult> {
  const { campaign, changeRequest, claimed, worker } = input;
  const unit = claimed.unit;
  const attempt = claimed.attempt;
  const branch = branchFor(campaign, unit.unitKey, attempt);
  const worktreePath = worktreeFor(campaign, unit.unitKey, attempt);

  // Pinned to the campaign base, or to the integration descendant that already
  // contains this unit's dependencies. Never to a sibling's unmerged branch.
  const baseSha = campaign.integrationSha ?? campaign.baseSha;

  const session = await openSession({
    campaignId: campaign.id,
    unitId: unit.id,
    workerId: worker.id,
    accountRef: worker.accountRef,
    attempt,
    role: input.role,
    model: input.model,
  });

  await recordFactoryEvent({
    campaignId: campaign.id,
    unitId: unit.id,
    workerId: worker.id,
    sessionId: session.id,
    accountRef: worker.accountRef,
    kind: FACTORY_EVENT_KINDS.unitClaimed,
    evidenceClass: 'MEASURED',
    detail: {
      unitKey: unit.unitKey,
      attempt,
      role: input.role,
      model: input.model,
      workerKind: worker.kind,
      branch,
      baseSha,
      takeoverFrom: claimed.takeoverFrom,
    },
  });

  if (claimed.takeoverFrom) {
    await recordFactoryEvent({
      campaignId: campaign.id,
      unitId: unit.id,
      workerId: worker.id,
      sessionId: session.id,
      kind: FACTORY_EVENT_KINDS.unitTakeover,
      evidenceClass: 'MEASURED',
      detail: {
        unitKey: unit.unitKey,
        from: claimed.takeoverFrom,
        reason: 'the previous lease expired and the unit was claimable again',
      },
    });
  }

  const proof = {
    unitId: unit.id,
    workerId: worker.id,
    leaseId: claimed.leaseId,
    leaseGeneration: claimed.leaseGeneration,
  };

  const executor = executorFor(worker.kind);
  if (!executor) {
    await closeSession(session.id, {
      state: 'FAILED',
      exitReason: `No executor implements ${worker.kind}.`,
    });
    await failUnit(proof, {
      category: 'WORKER_ERROR',
      detail: `No executor implements ${worker.kind}.`,
      retryable: true,
    });
    return {
      outcome: 'FAILED',
      sessionId: session.id,
      externalSessionId: null,
      branch,
      headSha: null,
      detail: `No executor implements ${worker.kind}.`,
      durationMs: 0,
    };
  }

  await ensureWorktree(input.repoRoot, { path: worktreePath, branch, baseSha });
  const startSha = await gitOrThrow(worktreePath, ['rev-parse', 'HEAD']);

  const checkpoint = await latestCheckpoint(unit.id);
  const priorFailures = await priorFailureHistory(unit.id, unit.campaignId);
  const assignment =
    input.assignmentOverride ??
    compileImplementationAssignment({
      changeRequest,
      unit,
      attempt,
      branch,
      baseSha: startSha,
      checkpoint,
      finding: input.finding ?? null,
      priorFailures,
    });

  await putArtifact({
    campaignId: campaign.id,
    unitId: unit.id,
    sessionId: session.id,
    kind: 'REVIEW_INPUT',
    text: assignment,
  });

  const result = await executor.execute({
    campaignId: campaign.id,
    unitId: unit.id,
    sessionId: session.id,
    worktreePath,
    branch,
    model: input.model,
    assignment,
    timeoutMs: input.timeoutMs ?? DEFAULT_UNIT_TIMEOUT_MS,
  });

  if (result.rawLog) {
    await putArtifact({
      campaignId: campaign.id,
      unitId: unit.id,
      sessionId: session.id,
      kind: 'WORKER_LOG',
      text: result.rawLog,
    });
  }

  const report = parseWorkerReport(result.summary);
  if (report && (report.unresolved || report.nextAction || report.commits.length > 0)) {
    await recordCheckpoint({
      campaignId: campaign.id,
      unitId: unit.id,
      attempt,
      sessionId: session.id,
      workerId: worker.id,
      established: report.summary,
      commits: report.commits,
      testsRun: report.testsRun,
      unresolved: report.unresolved,
      nextAction: report.nextAction,
    });
  }

  /* --------------------------------------------------------------------- */
  /* Provider backpressure                                                  */
  /* --------------------------------------------------------------------- */

  if (result.outcome === 'RATE_LIMITED') {
    const until = await recordWorkerRateLimit(worker.id, result.retryAfterMs ?? 5 * 60 * 1000);
    await closeSession(session.id, {
      state: 'RATE_LIMITED',
      exitReason: result.detail,
      externalSessionId: result.externalSessionId,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      usage: result.usage,
    });
    await deferUnit(proof, until, result.detail);
    // The attempt was spent by the claim and no work was done against it. A
    // refusal the provider issued must not walk the unit toward exhaustion.
    await refundAttempt(unit.id, attempt);
    await recordFactoryEvent({
      campaignId: campaign.id,
      unitId: unit.id,
      workerId: worker.id,
      sessionId: session.id,
      accountRef: worker.accountRef,
      kind: FACTORY_EVENT_KINDS.sessionRateLimited,
      durationMs: result.durationMs,
      // The provider refused; this is its word, not the factory's inference.
      evidenceClass: 'PROVIDER_ENFORCED',
      detail: { unitKey: unit.unitKey, attempt, until, attemptRefunded: true },
    });
    await recordFactoryEvent({
      campaignId: campaign.id,
      unitId: unit.id,
      workerId: worker.id,
      kind: FACTORY_EVENT_KINDS.unitDeferred,
      evidenceClass: 'PROVIDER_ENFORCED',
      detail: { unitKey: unit.unitKey, until },
    });
    return {
      outcome: 'DEFERRED',
      sessionId: session.id,
      externalSessionId: result.externalSessionId,
      branch,
      headSha: null,
      detail: `Deferred until ${until}: ${result.detail}`,
      durationMs: result.durationMs,
    };
  }

  /* --------------------------------------------------------------------- */
  /* What is actually in the repository                                     */
  /* --------------------------------------------------------------------- */

  // A worker that forgot to commit has still done work. Commit it on its behalf
  // rather than discarding it — an uncommitted change cannot be reviewed,
  // reverted or attributed, so it must not stay uncommitted.
  const rescued = await commitAll(worktreePath, `${unit.unitKey}: uncommitted work from attempt ${attempt}`, {
    'Factory-Campaign': campaign.id,
    'Factory-Unit': unit.unitKey,
    'Factory-Attempt': String(attempt),
    'Factory-Session': session.id,
  });
  const headSha = await gitOrThrow(worktreePath, ['rev-parse', 'HEAD']);
  const produced = headSha !== startSha;

  await closeSession(session.id, {
    state: result.outcome === 'COMPLETED' ? 'FINISHED' : 'FAILED',
    exitReason: result.detail,
    externalSessionId: result.externalSessionId,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    usage: result.usage,
  });

  await recordFactoryEvent({
    campaignId: campaign.id,
    unitId: unit.id,
    workerId: worker.id,
    sessionId: session.id,
    accountRef: worker.accountRef,
    kind: FACTORY_EVENT_KINDS.sessionFinished,
    durationMs: result.durationMs,
    evidenceClass: 'MEASURED',
    detail: {
      unitKey: unit.unitKey,
      attempt,
      outcome: result.outcome,
      produced,
      rescuedCommit: rescued !== null,
      numTurns: result.numTurns,
      // Counted rather than assumed, so the $0 claim is a reading of the ledger.
      paidApi: result.paidApi,
      externalSessionId: result.externalSessionId,
    },
  });

  if (!produced) {
    const category = result.outcome === 'TIMEOUT' ? 'CONTEXT_EXHAUSTED' : 'NO_CHANGE_PRODUCED';
    const detail =
      result.outcome === 'COMPLETED'
        ? 'The worker reported success and the branch did not move. The repository is the ' +
          `evidence, so this is not an implementation. Worker said: ${result.summary.slice(0, 600)}`
        : result.detail;
    await failUnit(proof, { category, detail, retryable: true });
    if (result.outcome !== 'COMPLETED') await recordWorkerFailure(worker.id);
    await recordFactoryEvent({
      campaignId: campaign.id,
      unitId: unit.id,
      workerId: worker.id,
      kind: FACTORY_EVENT_KINDS.unitFailed,
      evidenceClass: 'MEASURED',
      detail: { unitKey: unit.unitKey, attempt, category, detail: detail.slice(0, 600) },
    });
    return {
      outcome: result.outcome === 'COMPLETED' ? 'NO_CHANGE' : 'FAILED',
      sessionId: session.id,
      externalSessionId: result.externalSessionId,
      branch,
      headSha,
      detail,
      durationMs: result.durationMs,
    };
  }

  const marked = await markImplemented(proof, {
    branch,
    headSha,
    baseSha: startSha,
    worktreePath,
    workerSummary: result.summary,
    terminalResult: {
      outcome: result.outcome,
      detail: result.detail,
      numTurns: result.numTurns,
      report,
    },
  });

  if (!marked.ok) {
    // The lease was reclaimed while the worker was running. The commits are real
    // and stay on their branch; this session simply no longer owns the unit, and
    // the new owner's work is what counts. Nothing is overwritten.
    await recordFactoryEvent({
      campaignId: campaign.id,
      unitId: unit.id,
      workerId: worker.id,
      sessionId: session.id,
      kind: FACTORY_EVENT_KINDS.unitFailed,
      evidenceClass: 'MEASURED',
      detail: {
        unitKey: unit.unitKey,
        attempt,
        category: 'WORKER_LOST',
        detail: `The lease was no longer this session's (${marked.reason}); its commits are on ${branch}.`,
      },
    });
    return {
      outcome: 'FAILED',
      sessionId: session.id,
      externalSessionId: result.externalSessionId,
      branch,
      headSha,
      detail: `Fenced out: ${marked.reason}`,
      durationMs: result.durationMs,
    };
  }

  await recordWorkerSuccess(worker.id);
  await recordFactoryEvent({
    campaignId: campaign.id,
    unitId: unit.id,
    workerId: worker.id,
    sessionId: session.id,
    kind: FACTORY_EVENT_KINDS.unitImplemented,
    durationMs: result.durationMs,
    evidenceClass: 'MEASURED',
    detail: { unitKey: unit.unitKey, attempt, branch, headSha, baseSha: startSha },
  });

  return {
    outcome: 'IMPLEMENTED',
    sessionId: session.id,
    externalSessionId: result.externalSessionId,
    branch,
    headSha,
    detail: result.detail,
    durationMs: result.durationMs,
  };
}

/**
 * What earlier attempts on this unit already tried.
 *
 * Carried into the next assignment so a worker does not repeat a strategy that
 * has already failed — §15's rule, and the reason the factory does not need an
 * arbitrary retry ceiling to avoid looping: the next attempt is told what not to
 * do, and a unit whose attempts are exhausted is retired with its reasons intact.
 */
export async function priorFailureHistory(
  unitId: string,
  campaignId: string,
): Promise<{ attempt: number; category: string; detail: string }[]> {
  const unit = await getUnit(unitId);
  const history: { attempt: number; category: string; detail: string }[] = [];
  if (unit?.failureCategory && unit.failureDetail) {
    history.push({
      attempt: Math.max(0, unit.attempt - 1),
      category: unit.failureCategory,
      detail: unit.failureDetail,
    });
  }
  for (const integration of await listIntegrations(campaignId)) {
    if (integration.unitId !== unitId) continue;
    if (integration.outcome === 'MERGED') continue;
    history.push({
      attempt: integration.attempt,
      category: integration.outcome,
      detail: integration.reason,
    });
  }
  // Newest last, deduplicated on the pair: the same rejection reported by both
  // the unit row and the integration row is one fact.
  const seen = new Set<string>();
  return history.filter((entry) => {
    const key = `${entry.attempt}:${entry.category}:${entry.detail.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
