/**
 * Where a finished campaign's change stands on its way to production, read
 * from the forge and from this Brain's own revision (CLAUDE.md §58).
 *
 * The factory stops at a reviewable pull request (§27). What happens after it
 * — whether a person must release it, whether the release workflow may, whether
 * it merged, and whether the code is actually serving — was readable nowhere,
 * so a merged change and a deployed one looked the same as an unreviewed one.
 * This module is that reading, with five answers and a blocker list:
 *
 *   NOT_DELIVERED             no pull request yet, or the campaign is not finished
 *   MANUAL_RELEASE_REQUIRED   a person must merge and deploy, and every reason is named
 *   AUTO_RELEASE_ELIGIBLE     everything Brain can check holds; the release workflow
 *                             re-checks it from the canonical branch and does the rest
 *   MERGED_NOT_LIVE           the forge says merged; this Brain's revision does not
 *                             contain it yet, so a Deploy has not landed it
 *   LIVE                      the revision serving this request contains the change
 *   UNKNOWN                   the forge or this Brain's revision could not be read
 *
 * **LIVE is a reading of the serving process, never of a workflow.** A Deploy
 * that reported success says what was *asked*; `BRAIN_REVISION` is the commit
 * the running image was built from, and the forge says whether the change's head
 * is contained in it. That is the only sentence here that may say "live".
 *
 * **It authorizes nothing.** Eligibility is a reading the release workflow asks
 * for and then re-derives from the canonical branch's own checkout; the merge
 * and the deploy are the workflow's, under GitHub settings only a repository
 * administrator controls. Brain holds no forge write credential and still
 * writes nothing to the forge (§27).
 */
import { BRAIN_REVISION } from '../../env.ts';
import { getCampaign, getChangeRequest } from '../../repos/factory.ts';
import { listFactoryEvents, listFindings, listReviews, recordFactoryEvent } from '../../repos/factoryFleet.ts';
import { liveReleaseAuthorization } from '../../repos/releaseAuthorizations.ts';
import { getDb } from '../../db/database.ts';
import { mapCampaign } from '../../repos/factory.ts';
import type { FactoryCampaign, FactoryCampaignRow, FactoryReview } from '../../domain/factory.ts';
import {
  compareCommits as forgeCompare,
  parseRemote,
  readPullRequest as forgeReadPullRequest,
  type ForgeComparison,
  type ForgePullRequest,
  type ForgeReply,
  type ForgeRepository,
} from './forge.ts';
import { decideRepository } from './repositoryEnvelope.ts';
import { pullRequestNumber } from './remote.ts';
import { classifyRelease, describeReleaseReason, type ProtectedClass } from './releaseEligibility.ts';

export const RELEASE_STAGES = [
  'NOT_DELIVERED',
  'MANUAL_RELEASE_REQUIRED',
  'AUTO_RELEASE_ELIGIBLE',
  'MERGED_NOT_LIVE',
  'LIVE',
  'UNKNOWN',
] as const;
export type ReleaseStage = (typeof RELEASE_STAGES)[number];

export const RELEASE_EVENT_KINDS = {
  assessed: 'RELEASE_ASSESSED',
  live: 'RELEASE_LIVE',
} as const;

export interface ReleaseBlocker {
  code: string;
  sentence: string;
  /** Who acts on it. A blocker nobody can act on is not written. */
  owner: 'PERSON' | 'BRAIN' | 'RELEASE_WORKFLOW' | 'DEPLOY';
}

export interface ReleaseReading {
  campaignId: string;
  stage: ReleaseStage;
  summary: string;
  prNumber: number | null;
  prUrl: string | null;
  headSha: string | null;
  baseRef: string | null;
  repositoryGrant: string | null;
  protectedClasses: ProtectedClass[];
  changedFiles: number | null;
  reviewVerdict: string | null;
  reviewIndependence: string | null;
  authorizationId: string | null;
  servingRevision: string | null;
  blockers: ReleaseBlocker[];
  assessedAt: string;
}

export interface ReleaseDeps {
  readPullRequest: (repository: ForgeRepository, number: number) => Promise<ForgeReply<ForgePullRequest>>;
  compareCommits: (repository: ForgeRepository, base: string, head: string) => Promise<ForgeReply<ForgeComparison>>;
  servingRevision: string | null;
  now: () => Date;
}

const DEFAULT_DEPS: ReleaseDeps = {
  readPullRequest: forgeReadPullRequest,
  compareCommits: forgeCompare,
  servingRevision: BRAIN_REVISION,
  now: () => new Date(),
};

/** The independence tiers that count as an independent review. UNKNOWN never does. */
const INDEPENDENT_TIERS = new Set(['SESSION_SEPARATED', 'WORKER_SEPARATED', 'ACCOUNT_SEPARATED']);

function reading(base: Omit<ReleaseReading, 'assessedAt'>, deps: ReleaseDeps): ReleaseReading {
  return { ...base, assessedAt: deps.now().toISOString() };
}

/**
 * Whether `revision` contains `head`. Asked as compare(head...revision): the
 * forge answers `ahead` or `identical` exactly when the revision is the head or
 * descends from it. Anything else — `behind`, `diverged`, an error — is "no" or
 * "could not tell", and the second is kept apart from the first.
 */
async function contains(
  deps: ReleaseDeps,
  repository: ForgeRepository,
  head: string,
  revision: string,
): Promise<'YES' | 'NO' | 'UNKNOWN'> {
  const reply = await deps.compareCommits(repository, head, revision);
  if (!reply.ok || !reply.body) return 'UNKNOWN';
  return reply.body.status === 'ahead' || reply.body.status === 'identical' ? 'YES' : 'NO';
}

/** One campaign's release reading. Reads only; `observeRelease` records it. */
export async function assessRelease(
  campaignId: string,
  deps: ReleaseDeps = DEFAULT_DEPS,
): Promise<ReleaseReading> {
  const campaign = await getCampaign(campaignId);
  const empty = {
    campaignId,
    prNumber: null,
    prUrl: null,
    headSha: null,
    baseRef: null,
    repositoryGrant: null,
    protectedClasses: [] as ProtectedClass[],
    changedFiles: null,
    reviewVerdict: null,
    reviewIndependence: null,
    authorizationId: null,
    servingRevision: deps.servingRevision,
  };
  if (!campaign) {
    return reading({ ...empty, stage: 'UNKNOWN', summary: 'No such campaign.', blockers: [] }, deps);
  }
  const number = pullRequestNumber(campaign);
  if (!campaign.prUrl || number === null) {
    return reading(
      {
        ...empty,
        stage: 'NOT_DELIVERED',
        summary: 'No pull request has been delivered yet, so there is nothing to release.',
        blockers: [],
      },
      deps,
    );
  }
  const changeRequest = await getChangeRequest(campaign.changeRequestId);
  const repository = changeRequest ? parseRemote(changeRequest.repository) : null;
  const grant = changeRequest ? decideRepository(changeRequest.repository).grant : null;
  const withPr = { ...empty, prNumber: number, prUrl: campaign.prUrl, repositoryGrant: grant?.id ?? null };
  if (!repository) {
    return reading(
      {
        ...withPr,
        stage: 'UNKNOWN',
        summary: 'The repository this campaign changed is not one this Brain can read.',
        blockers: [],
      },
      deps,
    );
  }

  const pr = await deps.readPullRequest(repository, number);
  if (!pr.ok || !pr.body) {
    return reading(
      {
        ...withPr,
        stage: 'UNKNOWN',
        summary: `The forge did not answer about pull request #${number}: ${pr.reason ?? 'no reason given'}.`,
        blockers: [],
      },
      deps,
    );
  }
  const head = pr.body.headSha;
  const located = { ...withPr, headSha: head, baseRef: pr.body.baseRef, prUrl: pr.body.url || campaign.prUrl };

  /*
   * Merged, or already contained in what is serving — the rest of the questions
   * are about whether it *may* be released, and it already has been.
   */
  if (pr.body.merged || deps.servingRevision !== null) {
    const live = deps.servingRevision === null ? 'UNKNOWN' : await contains(deps, repository, head, deps.servingRevision);
    if (live === 'YES') {
      return reading(
        {
          ...located,
          stage: 'LIVE',
          summary: `Live: the revision serving this Brain (${deps.servingRevision?.slice(0, 12)}) contains pull request #${number}.`,
          blockers: [],
        },
        deps,
      );
    }
    if (pr.body.merged) {
      return reading(
        {
          ...located,
          stage: 'MERGED_NOT_LIVE',
          summary:
            deps.servingRevision === null
              ? `Pull request #${number} merged. This Brain does not know its own revision, so it cannot say whether it is live.`
              : `Pull request #${number} merged, and the revision serving this Brain (${deps.servingRevision.slice(0, 12)}) does not contain it yet.`,
          blockers: [
            {
              code: 'NOT_DEPLOYED',
              sentence:
                live === 'UNKNOWN'
                  ? 'Whether the serving revision contains the merge could not be read; the next reading asks again.'
                  : 'A Deploy of the canonical branch has not landed it. The release workflow dispatches one; a manual release needs a person to dispatch it.',
              owner: 'DEPLOY',
            },
          ],
        },
        deps,
      );
    }
  }

  if (campaign.state !== 'COMPLETE') {
    return reading(
      {
        ...located,
        stage: 'NOT_DELIVERED',
        summary: `The campaign is ${campaign.state}, so its pull request is not ready to release.`,
        blockers: [],
      },
      deps,
    );
  }

  const blockers: ReleaseBlocker[] = [];

  const diff = await deps.compareCommits(repository, pr.body.baseRef, head);
  let protectedClasses: ProtectedClass[] = [];
  let changedFiles: number | null = null;
  if (!diff.ok || !diff.body) {
    blockers.push({
      code: 'DIFF_UNREADABLE',
      sentence: `The forge did not say which files changed (${diff.reason ?? 'no reason given'}), and an unread diff is never low risk.`,
      owner: 'BRAIN',
    });
  } else {
    const classified = classifyRelease(diff.body.files, { truncated: diff.body.truncated });
    protectedClasses = classified.classes;
    changedFiles = classified.paths.length;
    for (const reason of classified.reasons) {
      blockers.push({
        code: reason.kind === 'PROTECTED' ? `PROTECTED_${reason.class}` : reason.kind,
        sentence: describeReleaseReason(reason),
        owner: 'PERSON',
      });
    }
  }

  const reviews: FactoryReview[] = await listReviews(campaign.id);
  const review = reviews.filter((one) => one.scope === 'CAMPAIGN').at(-1) ?? null;
  if (!review || review.verdict !== 'PASS') {
    blockers.push({
      code: 'REVIEW_NOT_PASSED',
      sentence: review
        ? `The last independent review said ${review.verdict}, not PASS.`
        : 'No independent review of the whole change is recorded.',
      owner: 'PERSON',
    });
  } else if (!INDEPENDENT_TIERS.has(review.independence)) {
    blockers.push({
      code: 'REVIEW_NOT_INDEPENDENT',
      sentence: `The review's independence is ${review.independence}, which does not establish a second session reviewed it.`,
      owner: 'PERSON',
    });
  } else if (review.reviewedSha !== head) {
    blockers.push({
      code: 'REVIEW_STALE',
      sentence: `The review read ${review.reviewedSha.slice(0, 12)}, and the pull request's head is now ${head.slice(0, 12)}.`,
      owner: 'PERSON',
    });
  }

  const blocking = (await listFindings(campaign.id)).filter(
    (finding) => finding.state === 'OPEN' && finding.severity === 'BLOCKER',
  );
  if (blocking.length > 0) {
    blockers.push({
      code: 'OPEN_BLOCKER_FINDINGS',
      sentence: `${blocking.length} blocking finding(s) are still open.`,
      owner: 'PERSON',
    });
  }

  const authorization = grant
    ? await liveReleaseAuthorization(campaign.projectId, grant.id, deps.now().toISOString())
    : null;
  if (!authorization) {
    blockers.push({
      code: 'NO_RELEASE_AUTHORIZATION',
      sentence:
        'Nobody has authorized unattended release for this repository in this project, so a person merges and deploys it.',
      owner: 'PERSON',
    });
  }

  const eligible = blockers.length === 0;
  return reading(
    {
      ...located,
      protectedClasses,
      changedFiles,
      reviewVerdict: review?.verdict ?? null,
      reviewIndependence: review?.independence ?? null,
      authorizationId: authorization?.id ?? null,
      stage: eligible ? 'AUTO_RELEASE_ELIGIBLE' : 'MANUAL_RELEASE_REQUIRED',
      summary: eligible
        ? `Pull request #${number} is eligible for unattended release. The release workflow re-checks it from the canonical branch, tests the merged tree, merges and deploys.`
        : `Pull request #${number} needs a person to release it: ${blockers.length} reason(s).`,
      blockers,
    },
    deps,
  );
}

/** The last recorded reading, without asking the forge. What a screen reads. */
export async function latestReleaseReading(campaignId: string): Promise<ReleaseReading | null> {
  const events = await listFactoryEvents(campaignId, { kinds: [RELEASE_EVENT_KINDS.assessed], limit: 5000 });
  const last = events.at(-1);
  if (!last) return null;
  return last.detail as unknown as ReleaseReading;
}

function sameReading(a: ReleaseReading, b: ReleaseReading): boolean {
  return (
    a.stage === b.stage &&
    a.headSha === b.headSha &&
    a.authorizationId === b.authorizationId &&
    JSON.stringify(a.blockers.map((one) => one.code)) === JSON.stringify(b.blockers.map((one) => one.code))
  );
}

/**
 * Assess and record. A reading is written only when it differs from the last
 * one, so the ledger is a history of changes rather than a log of ticks;
 * `RELEASE_LIVE` is written once.
 */
export async function observeRelease(
  campaignId: string,
  deps: ReleaseDeps = DEFAULT_DEPS,
): Promise<{ reading: ReleaseReading; recorded: boolean }> {
  const fresh = await assessRelease(campaignId, deps);
  const previous = await latestReleaseReading(campaignId);
  let recorded = false;
  if (fresh.stage !== 'UNKNOWN' && (!previous || !sameReading(previous, fresh))) {
    await recordFactoryEvent({
      campaignId,
      kind: RELEASE_EVENT_KINDS.assessed,
      evidenceClass: 'MEASURED',
      detail: fresh as unknown as Record<string, unknown>,
    });
    recorded = true;
  }
  if (fresh.stage === 'LIVE') {
    const live = await listFactoryEvents(campaignId, { kinds: [RELEASE_EVENT_KINDS.live], limit: 1 });
    if (live.length === 0) {
      await recordFactoryEvent({
        campaignId,
        kind: RELEASE_EVENT_KINDS.live,
        evidenceClass: 'MEASURED',
        detail: {
          headSha: fresh.headSha,
          servingRevision: fresh.servingRevision,
          prNumber: fresh.prNumber,
        },
      });
    }
  }
  return { reading: fresh, recorded };
}

/** How long a campaign's release keeps being read after it finished. */
export const RELEASE_OBSERVATION_DAYS = 30;
/** How often one campaign is read. The forge rate limit is shared by every reader. */
export const RELEASE_OBSERVATION_INTERVAL_MS = 5 * 60 * 1000;

const lastObserved = new Map<string, number>();

/**
 * Finished remote campaigns with a pull request that is not yet known live.
 * Bounded by age, so a request nobody will ever merge stops being asked about.
 */
export async function campaignsAwaitingRelease(now: Date = new Date()): Promise<FactoryCampaign[]> {
  const since = new Date(now.getTime() - RELEASE_OBSERVATION_DAYS * 86_400_000).toISOString();
  const rows = await getDb().all<FactoryCampaignRow>(
    `SELECT c.* FROM factory_campaigns c
      WHERE c.state = 'COMPLETE'
        AND c.execution_mode = 'REMOTE'
        AND c.pr_url IS NOT NULL
        AND c.finished_at IS NOT NULL
        AND c.finished_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM factory_events e WHERE e.campaign_id = c.id AND e.kind = ?
        )
      ORDER BY c.finished_at`,
    [since, RELEASE_EVENT_KINDS.live],
  );
  return rows.map(mapCampaign);
}

/** The tick's pass. Throttled per campaign, and one failure stops nobody else's. */
export async function observeReleases(deps: ReleaseDeps = DEFAULT_DEPS): Promise<number> {
  const now = deps.now().getTime();
  let read = 0;
  for (const campaign of await campaignsAwaitingRelease(deps.now())) {
    const last = lastObserved.get(campaign.id) ?? 0;
    if (now - last < RELEASE_OBSERVATION_INTERVAL_MS) continue;
    lastObserved.set(campaign.id, now);
    try {
      await observeRelease(campaign.id, deps);
      read += 1;
    } catch {
      // A forge or database failure is the next reading's to retry.
    }
  }
  return read;
}

/** Test seam: forget the throttle. */
export function resetReleaseObservationThrottle(): void {
  lastObserved.clear();
}
