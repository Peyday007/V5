/**
 * What the release workflow should do next, decided by Brain from its rows.
 *
 * The workflow asks; Brain answers with at most one action and records the
 * attempt *before* the workflow acts on it, so a workflow run that dies at any
 * point leaves a row the next run resumes rather than a merge nobody knows
 * about. That is the whole recovery story, and it is the one this codebase
 * already uses for queue items and bins: the durable record comes first, the
 * effect second, and the next pass reads the record.
 *
 * Nothing here writes to the forge or deploys. Brain still holds no forge write
 * credential and no deployment credential; it reads the forge to classify the
 * change, and that is all.
 */
import {
  getChangeRequest,
  listTerminalCampaigns,
} from '../../../repos/factory.ts';
import {
  advanceRun,
  getGrant,
  getRun,
  latestRun,
  listInFlightRuns,
  liveGrantFor,
  openRun,
} from '../../../repos/factoryRelease.ts';
import {
  MAX_RELEASE_ATTEMPTS,
  RELEASE_IN_FLIGHT,
  RETRYABLE_FAILURE_STAGES,
  type LiveCheck,
  type ReleaseFailureStage,
  type ReleaseRun,
  type ReleaseRunState,
} from '../../../domain/factoryRelease.ts';
import { compareCommits, parseRemote, readPullRequest } from '../forge.ts';
import { pullRequestNumber } from '../remote.ts';
import { latestReview, loadCampaignView, openFindings } from '../campaignView.ts';
import { decideRelease } from './gate.ts';
import { recordFactoryEvent } from '../../../repos/factoryFleet.ts';

export interface ReleaseActionBase {
  runId: string;
  campaignId: string;
  prNumber: number;
  headSha: string;
  baseBranch: string;
  title: string;
  liveChecks: LiveCheck[];
  pagePath: string | null;
}

export type ReleaseAction =
  | (ReleaseActionBase & { action: 'RELEASE' })
  | (ReleaseActionBase & {
      action: 'RESUME';
      state: ReleaseRunState;
      mergeSha: string | null;
      deployRunId: string | null;
    });

export interface ReleasePlan {
  action: ReleaseAction | null;
  /** What was considered and why nothing else was chosen, for the run log. */
  notes: string[];
}

async function actionFor(run: ReleaseRun, kind: 'RELEASE' | 'RESUME'): Promise<ReleaseAction | null> {
  const view = await loadCampaignView(run.campaignId);
  const grant = await getGrant(run.grantId);
  if (!view || !grant) return null;
  const prNumber = pullRequestNumber(view.campaign);
  if (prNumber === null) return null;
  const base: ReleaseActionBase = {
    runId: run.id,
    campaignId: run.campaignId,
    prNumber,
    headSha: run.headSha,
    baseBranch: view.changeRequest.baseBranch,
    title: view.changeRequest.objective.slice(0, 120),
    liveChecks: grant.liveChecks,
    pagePath: grant.pagePath,
  };
  if (kind === 'RELEASE') return { ...base, action: 'RELEASE' };
  return { ...base, action: 'RESUME', state: run.state, mergeSha: run.mergeSha, deployRunId: run.deployRunId };
}

/**
 * Decide the next release action for `releasableRepository` (`owner/name`).
 *
 * An in-flight attempt is always resumed first: one release at a time is what
 * keeps a deploy from being stacked on a deploy nobody has verified yet.
 */
export async function planRelease(input: {
  releasableRepository: string;
  workflowRunId: string | null;
}): Promise<ReleasePlan> {
  const notes: string[] = [];
  const inFlight = await listInFlightRuns();
  for (const run of inFlight) {
    const action = await actionFor(run, 'RESUME');
    if (action) {
      notes.push(`resuming ${run.id} at ${run.state}`);
      return { action, notes };
    }
    notes.push(`${run.id} is ${run.state} but its campaign, grant or pull request is unreadable`);
  }

  const campaigns = (await listTerminalCampaigns()).filter((one) => one.state === 'COMPLETE');
  for (const campaign of campaigns) {
    const grant = await liveGrantFor(campaign.changeRequestId);
    if (!grant) continue;
    const head = campaign.integrationSha;
    if (!head) continue;
    const latest = await latestRun(campaign.id);
    let attempt = 1;
    if (latest && latest.headSha === head) {
      if (latest.state === 'LIVE' || latest.state === 'ROLLED_BACK' || latest.state === 'REFUSED') continue;
      if (latest.state === 'FAILED') {
        const retryable =
          latest.failureStage !== null &&
          RETRYABLE_FAILURE_STAGES.includes(latest.failureStage) &&
          latest.attempt < MAX_RELEASE_ATTEMPTS;
        if (!retryable) continue;
        attempt = latest.attempt + 1;
      }
    }

    const view = await loadCampaignView(campaign.id);
    if (!view) continue;
    const repository = parseRemote(view.changeRequest.repository);
    const prNumber = pullRequestNumber(campaign);
    if (repository && prNumber !== null) {
      const pr = await readPullRequest(repository, prNumber);
      // Merged by an earlier attempt of this mechanism (its merge is on the
      // attempt) is a release to resume, not somebody else's merge.
      const mergedHere = latest !== null && latest.headSha === head && latest.mergeSha !== null;
      if (pr.ok && pr.body?.merged && !mergedHere) {
        notes.push(`${campaign.id}: pull request #${prNumber} was already merged, not by this mechanism`);
        continue;
      }
    }
    let changedFiles: string[] | null = null;
    let truncated = false;
    if (repository) {
      const comparison = await compareCommits(repository, campaign.baseSha, head);
      if (!comparison.ok || !comparison.body) {
        // A forge that did not answer is not a verdict about the change: say so
        // and ask again on the next pass rather than recording a refusal.
        notes.push(`${campaign.id}: the forge did not answer (${comparison.reason ?? 'no reason'})`);
        continue;
      }
      changedFiles = comparison.body.files;
      truncated = comparison.body.truncated;
    }
    const decision = decideRelease({
      campaign,
      changeRequest: view.changeRequest,
      grant,
      latestReview: latestReview(view),
      openFindings: openFindings(view),
      releasableRepository: input.releasableRepository,
      repositorySlug: repository?.slug ?? null,
      changedFiles,
      changedFilesTruncated: truncated,
    });
    const opened = await openRun({
      campaignId: campaign.id,
      changeRequestId: campaign.changeRequestId,
      grantId: grant.id,
      headSha: head,
      attempt,
      state: decision.eligible ? 'GATING' : 'REFUSED',
      refusal: decision.reasons,
      workflowRunId: input.workflowRunId,
    });
    if (!opened.created || !opened.run) {
      notes.push(`${campaign.id}: another release attempt already holds this campaign`);
      continue;
    }
    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: decision.eligible ? 'RELEASE_STARTED' : 'RELEASE_REFUSED',
      evidenceClass: 'DERIVED',
      detail: { runId: opened.run.id, headSha: head, attempt, reasons: decision.reasons },
    });
    if (!decision.eligible) {
      notes.push(`${campaign.id}: refused — ${decision.reasons.join(' ')}`);
      continue;
    }
    const action = await actionFor(opened.run, 'RELEASE');
    if (action) return { action, notes };
  }
  return { action: null, notes };
}

/**
 * Whether the merge may still happen, asked by the workflow immediately before
 * it asks the forge to merge.
 *
 * The plan decided eligibility when the attempt opened, and the gate between
 * that decision and the merge runs the whole Postgres suite — long enough for
 * the owner to withdraw the grant, or for the campaign to move to another head.
 * A withdrawal that could not stop a merge already in its gate would be a
 * decision recorded and ignored, so the facts that made the attempt eligible are
 * read again here, from rows, at the last moment they can still stop it.
 * Anything after the merge is finished rather than stopped: a merged change is
 * on the branch either way, and stopping half-way would leave branch and image
 * disagreeing.
 */
export async function mayMerge(runId: string): Promise<{ ok: boolean; reasons: string[] }> {
  const run = await getRun(runId);
  if (!run) return { ok: false, reasons: ['No such release attempt.'] };
  const reasons: string[] = [];
  if (run.state !== 'GATING') reasons.push(`The attempt is ${run.state}, not GATING.`);
  const grant = await liveGrantFor(run.changeRequestId);
  if (!grant || grant.id !== run.grantId) {
    reasons.push('The owner withdrew automatic release for this objective before it was merged.');
  }
  const view = await loadCampaignView(run.campaignId);
  if (!view) {
    reasons.push('The campaign can no longer be read.');
  } else {
    if (view.campaign.state !== 'COMPLETE') reasons.push(`The campaign is ${view.campaign.state}, not COMPLETE.`);
    if (view.campaign.integrationSha !== run.headSha) {
      reasons.push('The campaign moved to another head after this attempt was gated.');
    }
    if (view.changeRequest.state !== 'APPROVED') reasons.push(`The objective is ${view.changeRequest.state}.`);
    if (view.changeRequest.riskClass !== 'LOW') reasons.push(`The objective is risk class ${view.changeRequest.riskClass}.`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Which state each move may come from. */
const FROM: Record<ReleaseRunState, readonly ReleaseRunState[]> = {
  REFUSED: [],
  GATING: [],
  MERGED: ['GATING'],
  DEPLOYING: ['MERGED'],
  VERIFYING: ['DEPLOYING'],
  LIVE: ['VERIFYING'],
  // FAILED may restamp FAILED: a rollback whose revert could not land records
  // what a person must do on the attempt that already failed.
  FAILED: [...RELEASE_IN_FLIGHT, 'FAILED'],
  ROLLED_BACK: ['FAILED'],
};

export interface AdvanceRequest {
  runId: string;
  to: ReleaseRunState;
  mergeSha?: string | null;
  deployRunId?: string | null;
  failureStage?: ReleaseFailureStage | null;
  failureDetail?: string | null;
  verification?: Record<string, unknown>;
}

export async function advanceRelease(request: AdvanceRequest): Promise<{ moved: boolean; run: ReleaseRun | null }> {
  const from = FROM[request.to];
  if (from.length === 0) throw new Error(`Nothing moves a release run to ${request.to}.`);
  if (request.to === 'FAILED' && !request.failureStage) throw new Error('A failure needs a stage.');
  const moved = await advanceRun(request.runId, {
    from,
    to: request.to,
    mergeSha: request.mergeSha,
    deployRunId: request.deployRunId,
    failureStage: request.failureStage,
    failureDetail: request.failureDetail,
    verification: request.verification,
  });
  const run = await getRun(request.runId);
  if (moved && run) {
    await recordFactoryEvent({
      campaignId: run.campaignId,
      kind: `RELEASE_${request.to}`,
      evidenceClass: 'MEASURED',
      detail: {
        runId: run.id,
        mergeSha: run.mergeSha,
        deployRunId: run.deployRunId,
        failureStage: run.failureStage,
        failureDetail: run.failureDetail,
      },
    });
  }
  return { moved, run };
}

export { getChangeRequest };
