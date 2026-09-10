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
  listReviews,
  putArtifact,
  recordFactoryEvent,
} from '../../repos/factoryFleet.ts';
import { listUnits, patchCampaign } from '../../repos/factory.ts';
import { FACTORY_EVENT_KINDS, campaignMetrics } from './metrics.ts';
import { commitsBetween, diffStat, git, mergeBase } from './git.ts';

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
  const reviews = await listReviews(campaign.id);
  const findings = await listFindings(campaign.id);
  const integrations = await listIntegrations(campaign.id);
  const metrics = await campaignMetrics(campaign.id);

  const lastReview = reviews[reviews.length - 1];
  const openFindings = findings.filter((finding) => finding.state === 'OPEN');
  const repaired = findings.filter((finding) => finding.state === 'REPAIRED');

  const body = [
    `## ${changeRequest.objective}`,
    '',
    changeRequest.expectedOutcome,
    '',
    '### Acceptance conditions',
    ...changeRequest.acceptanceConditions.map(
      (condition) =>
        `- **${condition.id}** ${condition.statement}\n  _checked by:_ ${condition.verification}`,
    ),
    '',
    '### What landed',
    `Base \`${base.slice(0, 12)}\` → \`${head.slice(0, 12)}\` on \`${campaign.integrationBranch}\``,
    `${commits.length} commit(s), ${stat.filesChanged} file(s), +${stat.insertions}/-${stat.deletions}`,
    '',
    ...units
      .filter((unit) => unit.state === 'INTEGRATED')
      .map((unit) => `- \`${unit.unitKey}\` — ${unit.title}`),
    '',
    '### Independent review',
    lastReview
      ? `Round ${lastReview.round}: **${lastReview.verdict}** (${lastReview.independence}).\n\n${lastReview.summary}`
      : 'No review was recorded, which means this change has not been independently judged.',
    '',
    repaired.length > 0
      ? `${repaired.length} review finding(s) were repaired and re-verified:\n` +
        repaired.map((finding) => `- ${finding.findingKey}: ${finding.statement}`).join('\n')
      : 'No review findings required repair.',
    '',
    openFindings.length > 0
      ? `### Remaining limitations\n` +
        openFindings
          .map((finding) => `- **${finding.severity}** ${finding.statement}`)
          .join('\n')
      : '### Remaining limitations\nNone recorded.',
    '',
    '### Verification',
    changeRequest.verificationCommands.length > 0
      ? changeRequest.verificationCommands.map((command) => `- \`${command}\``).join('\n')
      : '- (the repository declared no verification commands)',
    `\nRan ${metrics.verification.ran} time(s) across the campaign; ${metrics.verification.failed} failure(s) were repaired or rolled back.`,
    '',
    '### How it was produced',
    `${metrics.units.total} work unit(s), ${metrics.sessions.total} worker session(s), ` +
      `maximum observed concurrency ${metrics.maxObservedConcurrency} (${metrics.concurrencyEvidence}).`,
    `${integrations.filter((i) => i.outcome === 'MERGED').length} merge(s), ` +
      `${integrations.filter((i) => i.outcome === 'REJECTED').length} rejection(s), ` +
      `${integrations.filter((i) => i.outcome === 'CONFLICT').length} conflict(s).`,
    '',
    `Rollback: ${changeRequest.rollbackRequirement}`,
  ].join('\n');

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
      openFindings: openFindings.length,
      lastVerdict: lastReview?.verdict ?? null,
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
