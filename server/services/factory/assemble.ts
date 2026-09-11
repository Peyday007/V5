/**
 * The reviewable artifact.
 *
 * A campaign's output is a diff a person can read and a description of what it
 * is for. Both are produced from the repository and from rows — the commits that
 * actually landed, the verdict that actually judged them, the findings that are
 * actually still open — because a pull request body written from a worker's
 * summary is a description of a belief.
 *
 * What this module deliberately does **not** do is publish. It produces the
 * branch, the patch and the body, and stops. Pushing and opening a pull request
 * are separately authorized steps performed by something a person ran, and a
 * function that quietly published would make "the factory may not deploy to
 * production" depend on nobody calling it.
 */
import type { FactoryCampaign, FactoryChangeRequest } from '../../domain/factory.ts';
import {
  listFindings,
  listIntegrations,
  putArtifact,
  recordFactoryEvent,
} from '../../repos/factoryFleet.ts';
import { listUnits, patchCampaign } from '../../repos/factory.ts';
import { FACTORY_EVENT_KINDS, campaignMetrics } from './metrics.ts';
import { commitsBetween, diffStat, git, mergeBase } from './git.ts';
import { latestReview, loadCampaignView } from './campaignView.ts';
import { renderPullRequest } from './pullRequest.ts';

export interface AssembleInput {
  repoRoot: string;
  campaign: FactoryCampaign;
  changeRequest: FactoryChangeRequest;
}

export interface AssembleResult {
  summary: string;
  diffRef: string;
  body: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  commits: number;
}

/** Bounded: a patch is evidence, and a 50MB one is evidence nobody reads. */
const MAX_PATCH_BYTES = 4 * 1024 * 1024;

export async function assembleDeliverable(input: AssembleInput): Promise<AssembleResult> {
  const { repoRoot, campaign, changeRequest } = input;
  const head = campaign.integrationSha ?? campaign.baseSha;
  // The merge base rather than the pin: a pull request describes what the branch
  // adds, not what the repository did while the branch was open.
  const base =
    (await mergeBase(repoRoot, changeRequest.baseBranch, head)) ?? campaign.baseSha;
  const diffRef = `${base}..${head}`;

  const stat = await diffStat(repoRoot, base, head);
  const commits = await commitsBetween(repoRoot, base, head);
  const patch = await git(repoRoot, ['diff', diffRef], 300_000);
  const units = await listUnits(campaign.id);
  const findings = await listFindings(campaign.id);
  const integrations = await listIntegrations(campaign.id);
  const metrics = await campaignMetrics(campaign.id);

  /*
   * One renderer, two readers.
   *
   * This module used to hold its own body template. It produced a *different*
   * document from `GET /factory/campaigns/:id/pull-request` over the identical
   * rows — no status on the acceptance conditions, the last element of a
   * newest-first review list rather than the newest, and only OPEN findings as
   * limitations — so the stored artifact and the live route disagreed about the
   * same campaign and nothing reconciled them. Rendering through
   * `renderPullRequest` makes that impossible rather than merely unlikely: the
   * only thing this module still contributes is the half a caller without a
   * checkout cannot answer, and it contributes it as data.
   */
  const view = await loadCampaignView(campaign.id);
  if (!view) {
    throw new Error(
      `Campaign ${campaign.id} cannot be rendered: its rows did not resolve into a view.`,
    );
  }
  const { body } = renderPullRequest(view, {
    base,
    head,
    commits: commits.length,
    filesChanged: stat.filesChanged,
    insertions: stat.insertions,
    deletions: stat.deletions,
    verificationCommands: changeRequest.verificationCommands,
    verificationRan: metrics.verification.ran,
    verificationFailed: metrics.verification.failed,
    unitsTotal: metrics.units.total,
    sessionsTotal: metrics.sessions.total,
    maxObservedConcurrency: metrics.maxObservedConcurrency,
    concurrencyEvidence: metrics.concurrencyEvidence,
    merges: integrations.filter((i) => i.outcome === 'MERGED').length,
    rejections: integrations.filter((i) => i.outcome === 'REJECTED').length,
    conflicts: integrations.filter((i) => i.outcome === 'CONFLICT').length,
  });

  await putArtifact({
    campaignId: campaign.id,
    kind: 'PR_BODY',
    text: body,
  });

  if (patch.exitCode === 0 && patch.stdout.length > 0) {
    await putArtifact({
      campaignId: campaign.id,
      kind: 'PATCH',
      text: patch.stdout.slice(0, MAX_PATCH_BYTES),
      inlineLimit: 0,
    });
  }

  await patchCampaign(campaign.id, { prRef: campaign.integrationBranch });
  await recordFactoryEvent({
    campaignId: campaign.id,
    kind: FACTORY_EVENT_KINDS.prAssembled,
    evidenceClass: 'MEASURED',
    detail: {
      diffRef,
      branch: campaign.integrationBranch,
      commits: commits.length,
      filesChanged: stat.filesChanged,
      insertions: stat.insertions,
      deletions: stat.deletions,
      // Read from the same view the body was rendered from, so the ledger row
      // and the artifact can never describe different campaigns.
      openFindings: findings.filter((finding) => finding.state === 'OPEN').length,
      lastVerdict: latestReview(view)?.verdict ?? null,
    },
  });

  return {
    summary: `${commits.length} commit(s), ${stat.filesChanged} file(s), +${stat.insertions}/-${stat.deletions} on ${campaign.integrationBranch}`,
    diffRef,
    body,
    filesChanged: stat.filesChanged,
    insertions: stat.insertions,
    deletions: stat.deletions,
    commits: commits.length,
  };
}
