/**
 * Whether a finished campaign may be released without a person, as a pure
 * decision over rows and the forge's own list of changed files.
 *
 * Pure for the router's reason: "why was this released" must be answerable from
 * a recorded input rather than from a re-run against a database that has moved,
 * and being pure makes it useless as a safety mechanism — the exclusion is the
 * partial unique index on in-flight runs, and the merge itself is pinned to the
 * reviewed commit by the workflow that performs it.
 *
 * Every condition here is a refusal with a reason, and the reasons are kept on
 * the run so a person reading Brain sees exactly which one held a release back.
 * Nothing here can *widen* what a grant allows: the excluded paths are a
 * constant the grant does not carry, and a LOW risk class is a property of the
 * change request a person approved, not of the grant.
 */
import { matchesGlob } from '../glob.ts';
import { RELEASE_EXCLUDED_PATHS, type ReleaseGrant } from '../../../domain/factoryRelease.ts';
import type {
  FactoryCampaign,
  FactoryChangeRequest,
  FactoryFinding,
  FactoryReview,
} from '../../../domain/factory.ts';

export interface GateInput {
  campaign: FactoryCampaign;
  changeRequest: FactoryChangeRequest;
  grant: ReleaseGrant | null;
  latestReview: FactoryReview | null;
  openFindings: FactoryFinding[];
  /** The repository the release workflow is able to deploy, `owner/name`. */
  releasableRepository: string;
  /** The repository the change request names, parsed to `owner/name`, or null. */
  repositorySlug: string | null;
  /** Files the campaign changed relative to its base, per the forge. Null when unreadable. */
  changedFiles: string[] | null;
  changedFilesTruncated: boolean;
}

export interface GateDecision {
  eligible: boolean;
  reasons: string[];
  /** The excluded paths the change touched, when that is why it was refused. */
  excludedPathsTouched: string[];
}

export function excludedPathsIn(files: string[]): string[] {
  return files.filter((file) => RELEASE_EXCLUDED_PATHS.some((glob) => matchesGlob(file, glob)));
}

export function decideRelease(input: GateInput): GateDecision {
  const reasons: string[] = [];
  const { campaign, changeRequest, grant } = input;

  if (!grant || grant.revokedAt !== null) {
    reasons.push('The owner has not authorized automatic release for this objective; merging is a person’s.');
  }
  if (changeRequest.state !== 'APPROVED') {
    reasons.push(`The objective is ${changeRequest.state}, not APPROVED.`);
  }
  if (changeRequest.riskClass !== 'LOW') {
    reasons.push(`The objective is risk class ${changeRequest.riskClass}; only LOW is released automatically.`);
  }
  if (campaign.state !== 'COMPLETE') {
    reasons.push(`The campaign is ${campaign.state}, not COMPLETE.`);
  }
  if (!campaign.prUrl) {
    reasons.push('The campaign has no pull request the forge has confirmed.');
  }
  if (!campaign.integrationSha) {
    reasons.push('The campaign has no integration commit to release.');
  }
  const review = input.latestReview;
  if (!review) {
    reasons.push('No independent review has been recorded.');
  } else {
    if (review.verdict !== 'PASS') reasons.push(`The latest review verdict is ${review.verdict}, not PASS.`);
    if (review.independence === 'UNKNOWN') {
      reasons.push('The latest review’s independence could not be established from lineage.');
    }
    if (campaign.integrationSha && review.reviewedSha !== campaign.integrationSha) {
      reasons.push(
        `The review read ${review.reviewedSha.slice(0, 12)}, not the integration commit ` +
          `${campaign.integrationSha.slice(0, 12)}.`,
      );
    }
  }
  if (input.openFindings.length > 0) {
    reasons.push(`${input.openFindings.length} review finding(s) are still open.`);
  }
  if (input.repositorySlug === null) {
    reasons.push(`The repository ${changeRequest.repository} is not one this Brain can address.`);
  } else if (input.repositorySlug.toLowerCase() !== input.releasableRepository.toLowerCase()) {
    reasons.push(
      `The release workflow deploys ${input.releasableRepository}; this change is to ${input.repositorySlug}.`,
    );
  }
  let excluded: string[] = [];
  if (input.changedFiles === null) {
    reasons.push('The forge could not say which files changed, so the change cannot be classified.');
  } else if (input.changedFilesTruncated) {
    reasons.push('The forge truncated the list of changed files, so the change cannot be classified.');
  } else if (input.changedFiles.length === 0) {
    reasons.push('The forge reports no changed files; there is nothing to release.');
  } else {
    excluded = excludedPathsIn(input.changedFiles);
    if (excluded.length > 0) {
      reasons.push(
        `The change touches ${excluded.length} path(s) reserved for a person to release ` +
          `(${excluded.slice(0, 5).join(', ')}${excluded.length > 5 ? ', …' : ''}).`,
      );
    }
  }
  return { eligible: reasons.length === 0, reasons, excludedPathsTouched: excluded };
}
