/**
 * The one status a person reads about an approved objective:
 * BUILDING → VERIFYING → RELEASING → LIVE, or BLOCKED with the exact blocker.
 *
 * Derived on the read path from the campaign, the owner's grant and the latest
 * release run, and stored nowhere — a stored status is stale the moment the row
 * it summarises moves. LIVE is reachable only from a release run whose
 * verification ran inside the released Brain (`verify.ts`); a pull request, a
 * green review or a merge is never LIVE.
 */
import type { FactoryBlockerKind, FactoryCampaign } from '../../../domain/factory.ts';
import { MAX_RELEASE_ATTEMPTS, type ObjectiveOutcome, type ReleaseGrant, type ReleaseRun } from '../../../domain/factoryRelease.ts';

/**
 * Which campaign blockers wait on a person rather than on Brain. A blocker Brain
 * re-examines by itself — a surface that will come back, a reviewer that will
 * arrive, a base that will be re-read — is not a person's, and saying it is
 * would send somebody to answer a question the next tick answers.
 */
const PERSON_BLOCKERS: Record<FactoryBlockerKind, string | null> = {
  NO_HEALTHY_EXECUTION_SURFACE: null,
  NO_ELIGIBLE_REVIEWER: null,
  STALE_BASE: null,
  DEPENDENCY_CYCLE: 'Amend the objective so its units do not depend on each other in a circle, or withdraw it.',
  UNIT_EXHAUSTED_ATTEMPTS: 'Amend the objective, regrant the unit (factory regrant-unit), or withdraw it.',
  CONTRADICTORY_CONTRACT: 'Amend the objective so its conditions can all hold, or withdraw it.',
  AWAITING_HUMAN_RELEASE: 'Approve or refuse the release on Build.',
  EXTERNAL_CREDENTIAL_REQUIRED: 'Grant the named access where the worker runs; Brain resumes by itself.',
  SCOPE_AMENDMENT_REQUIRED: 'Widen the mutation scope to the named file, or withdraw the objective.',
  REPAIR_OWNERSHIP_UNRESOLVED: 'Name the file the repair may change in the objective’s scope.',
};

export interface OutcomeInput {
  campaign: FactoryCampaign;
  grant: ReleaseGrant | null;
  latestRun: ReleaseRun | null;
  /** The public origin of this Brain, for the page link. */
  origin: string | null;
}

function pageUrl(input: OutcomeInput): string | null {
  const path = input.grant?.pagePath;
  if (!path) return null;
  return input.origin ? new URL(path, input.origin).toString() : path;
}

export function deriveOutcome(input: OutcomeInput): ObjectiveOutcome {
  const { campaign, grant, latestRun } = input;
  // A run about an earlier head says nothing about this one.
  const run = latestRun && latestRun.headSha === campaign.integrationSha ? latestRun : null;
  const base = {
    prUrl: campaign.prUrl,
    pageUrl: null as string | null,
    release: run
      ? {
          runId: run.id,
          state: run.state,
          mergeSha: run.mergeSha,
          deployRunId: run.deployRunId,
          attempt: run.attempt,
        }
      : null,
    autoRelease: grant !== null && grant.revokedAt === null,
  };
  const make = (
    status: ObjectiveOutcome['status'],
    detail: string,
    blocker: string | null = null,
    personAction: string | null = null,
  ): ObjectiveOutcome => ({
    ...base,
    status,
    detail,
    blocker,
    needsPerson: personAction !== null,
    personAction,
  });

  switch (campaign.state) {
    case 'CANCELLED':
      return make('CANCELLED', 'This objective was cancelled.');
    case 'BLOCKED': {
      const kind = campaign.blockerKind;
      const action = kind ? PERSON_BLOCKERS[kind] : null;
      return make(
        'BLOCKED',
        action ? 'Stopped until a person acts.' : 'Stopped; Brain re-examines this by itself every tick.',
        campaign.blockerDetail ?? kind ?? 'blocked',
        action,
      );
    }
    case 'PLANNING':
    case 'EXECUTING':
    case 'INTEGRATING':
    case 'REVIEWING':
    case 'REPAIRING':
      return make('BUILDING', campaign.stageDetail ?? `Factory is ${campaign.state.toLowerCase()}.`);
    case 'VERIFYING':
    case 'ASSEMBLING':
      return make('VERIFYING', campaign.stageDetail ?? 'Checking the work before it is released.');
    case 'AWAITING_RELEASE':
      return make(
        'BLOCKED',
        'Built and verified; this objective was not authorized for automatic release.',
        'Waiting for a person to approve the release.',
        PERSON_BLOCKERS.AWAITING_HUMAN_RELEASE,
      );
    case 'COMPLETE':
      break;
  }

  // COMPLETE: reviewed and confirmed by the forge. What happens next is release.
  if (!base.autoRelease) {
    return make(
      'BLOCKED',
      'Built, reviewed and ready as a pull request. Automatic release was not authorized for this objective.',
      'Merging and deploying is a person’s decision for this objective.',
      campaign.prUrl ? `Read and merge ${campaign.prUrl}, then run Deploy.` : 'Merge the pull request and run Deploy.',
    );
  }
  if (!run) {
    return make('VERIFYING', 'Built and reviewed. Waiting for the release gate to pick it up.');
  }
  switch (run.state) {
    case 'REFUSED':
      return make(
        'BLOCKED',
        'The release gate refused automatic release.',
        run.refusal.join(' '),
        campaign.prUrl
          ? `Read ${campaign.prUrl}; merge and deploy it yourself, or amend the objective.`
          : 'Amend the objective, or release it yourself.',
      );
    case 'GATING':
      return make('RELEASING', 'Running the release gate: merge, scan and tests on the merged tree.');
    case 'MERGED':
      return make('RELEASING', `Merged as ${run.mergeSha?.slice(0, 12) ?? '—'}; starting the deployment.`);
    case 'DEPLOYING':
      return make('RELEASING', `Deploying ${run.mergeSha?.slice(0, 12) ?? '—'} through the canonical pipeline.`);
    case 'VERIFYING':
      return make('RELEASING', 'Deployed; verifying it inside the released Brain.');
    case 'LIVE':
      return { ...make('LIVE', `Live and verified at ${run.mergeSha?.slice(0, 12) ?? '—'}.`), pageUrl: pageUrl(input) };
    case 'FAILED':
      if ((run.failureStage === 'INFRA' || run.failureStage === 'DISPATCH') && run.attempt < MAX_RELEASE_ATTEMPTS) {
        return make('RELEASING', `The last attempt stopped on the runner (${run.failureDetail ?? 'no detail'}); it will be tried again.`);
      }
      return make(
        'BLOCKED',
        `Release failed at ${run.failureStage ?? 'an unknown stage'}.`,
        run.failureDetail ?? 'no detail recorded',
        'Read the failure, then amend the objective or release by hand.',
      );
    case 'ROLLED_BACK':
      return make(
        'BLOCKED',
        `Did not go live (failed at ${run.failureStage ?? '—'}) and was rolled back.`,
        run.failureDetail ?? 'no detail recorded',
        'Read the failure and amend the objective; production is back on the previous version.',
      );
  }
}

/** The outcome for one campaign, read from its rows. */
export async function objectiveOutcome(campaign: FactoryCampaign): Promise<ObjectiveOutcome> {
  const { latestRun: readLatest, liveGrantFor } = await import('../../../repos/factoryRelease.ts');
  const [grant, latest] = await Promise.all([liveGrantFor(campaign.changeRequestId), readLatest(campaign.id)]);
  return deriveOutcome({ campaign, grant, latestRun: latest, origin: null });
}
