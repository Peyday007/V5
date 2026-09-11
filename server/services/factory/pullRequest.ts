/**
 * The reviewable artifact's title and body, from rows.
 *
 * `assemble.ts` produces the branch and the patch, and is the module a running
 * campaign calls once its diff is ready. This module answers a narrower
 * question — what should the pull request itself say — and answers it the same
 * way: nothing here is a worker's summary, everything resolves to a
 * `CampaignView`. `renderPullRequest` is pure over that view, so the exact
 * wording a person will read is testable without a database.
 *
 * What this module deliberately does **not** do is publish. It renders a title
 * and a body and returns them; opening a request against a remote host is a
 * separately authorized step performed by something a person ran outside the
 * factory. There is no outbound call of any kind in this file.
 */
import { acceptanceConditionStatus, latestReview, loadCampaignView } from './campaignView.ts';
import type { CampaignView } from './campaignView.ts';

/** ~72 characters, never cut inside a word. */
const TITLE_MAX_CHARS = 72;

/**
 * The facts only the module holding the repository can supply.
 *
 * `assemble.ts` has the branch in front of it: a merge base, a head, a diff and
 * the campaign's measured counters. This module has the rows. Keeping the two
 * apart is what makes one renderer possible — the optional half is the half a
 * caller without a checkout genuinely cannot answer, and everything a reviewer
 * reads about *acceptance, review, repairs and limitations* is rendered from
 * rows either way, identically.
 *
 * Before this existed there were two bodies for one campaign: this module's and
 * a second template inside `assemble.ts`, which used the last element of a
 * newest-first review list and reported acceptance conditions with no status at
 * all. The stored artifact and the live route therefore made different claims
 * about the same campaign, and a reviewer had no way to know which they were
 * holding. One derivation, two readers — the rule §24 already settled for
 * `completionLinks.ts`, for the same reason.
 */
export interface PullRequestDeliverable {
  base: string;
  head: string;
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  verificationCommands: string[];
  verificationRan: number;
  verificationFailed: number;
  unitsTotal: number;
  sessionsTotal: number;
  maxObservedConcurrency: number;
  concurrencyEvidence: string;
  merges: number;
  rejections: number;
  conflicts: number;
}

function titleFromObjective(objective: string): string {
  const collapsed = objective.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= TITLE_MAX_CHARS) return collapsed;
  const window = collapsed.slice(0, TITLE_MAX_CHARS);
  const lastBoundary = window.lastIndexOf(' ');
  const safe = lastBoundary > 0 ? window.slice(0, lastBoundary) : window;
  return `${safe}…`;
}

function unitKeyOf(view: CampaignView, unitId: string | null): string {
  if (!unitId) return '(unknown unit)';
  return view.units.find((candidate) => candidate.id === unitId)?.unitKey ?? unitId;
}

function shaFragment(sha: string | null): string {
  return sha ? sha.slice(0, 12) : '(no commit)';
}

/**
 * The body, section by section, in the order a reviewer needs them: what was
 * asked for, whether it was delivered, what landed, who judged it, what was
 * fixed along the way, and what is still wrong. A body that skipped the last
 * two would be the description of a belief rather than of a diff.
 */
export function renderPullRequest(
  view: CampaignView,
  deliverable?: PullRequestDeliverable,
): { title: string; body: string } {
  const { campaign, changeRequest, units, findings } = view;
  const review = latestReview(view);
  const conditions = acceptanceConditionStatus(view);
  const landed = units.filter((unit) => unit.state === 'INTEGRATED');
  const repaired = findings.filter((finding) => finding.state === 'REPAIRED');
  const remaining = findings.filter(
    (finding) =>
      finding.state === 'OPEN' ||
      finding.state === 'REPAIR_QUEUED' ||
      finding.state === 'ACCEPTED_LIMITATION',
  );

  const body = [
    `## ${changeRequest.objective}`,
    '',
    changeRequest.expectedOutcome,
    '',
    '### Acceptance conditions',
    ...conditions.map(
      (condition) =>
        `- **${condition.id}** ${condition.statement} — **${condition.status}** (${condition.basis})`,
    ),
    '',
    '### Units that landed',
    ...(landed.length > 0
      ? landed.map(
          (unit) =>
            `- \`${unit.unitKey}\` — ${unit.title} (integrated as \`${shaFragment(unit.headSha)}\`)`,
        )
      : ['No unit has reached the integration branch yet.']),
    '',
    ...(deliverable
      ? [
          '### What landed',
          `Base \`${shaFragment(deliverable.base)}\` → \`${shaFragment(deliverable.head)}\` ` +
            `on \`${campaign.integrationBranch}\``,
          `${deliverable.commits} commit(s), ${deliverable.filesChanged} file(s), ` +
            `+${deliverable.insertions}/-${deliverable.deletions}`,
          '',
        ]
      : []),
    '### Independent review',
    review
      ? `Round ${review.round}: **${review.verdict}** — independence: **${review.independence}**.\n\n${review.summary}`
      : 'No review has been recorded for this campaign. Independence: **UNKNOWN**.',
    '',
    '### Repairs carried through',
    ...(repaired.length > 0
      ? repaired.map(
          (finding) =>
            `- ${finding.findingKey}: ${finding.statement} — closed by \`${unitKeyOf(view, finding.repairUnitId)}\``,
        )
      : ['No review finding required repair.']),
    '',
    '### Remaining limitations',
    ...(remaining.length > 0
      ? remaining.map(
          (finding) =>
            `- **${finding.severity}** (${finding.state}) ${finding.findingKey}: ${finding.statement}`,
        )
      : ['None recorded.']),
    '',
    ...(deliverable
      ? [
          '### Verification',
          ...(deliverable.verificationCommands.length > 0
            ? deliverable.verificationCommands.map((command) => `- \`${command}\``)
            : ['- (the repository declared no verification commands)']),
          `\nRan ${deliverable.verificationRan} time(s) across the campaign; ` +
            `${deliverable.verificationFailed} failure(s) were repaired or rolled back.`,
          '',
          '### How it was produced',
          `${deliverable.unitsTotal} work unit(s), ${deliverable.sessionsTotal} worker session(s), ` +
            `maximum observed concurrency ${deliverable.maxObservedConcurrency} ` +
            `(${deliverable.concurrencyEvidence}).`,
          `${deliverable.merges} merge(s), ${deliverable.rejections} rejection(s), ` +
            `${deliverable.conflicts} conflict(s).`,
          '',
        ]
      : []),
    '### Rollback',
    changeRequest.rollbackRequirement,
    `Base \`${shaFragment(campaign.baseSha)}\`, integration branch \`${campaign.integrationBranch}\`.`,
  ].join('\n');

  return { title: titleFromObjective(changeRequest.objective), body };
}

/**
 * Load the campaign and render it, or report that there is nothing to render.
 *
 * A campaign whose rows do not resolve is not a state this function can
 * describe — `loadCampaignView` already made that call for the change
 * request, and a vanished campaign is the same kind of absence.
 */
export async function pullRequestFor(
  campaignId: string,
): Promise<{ title: string; body: string } | null> {
  const view = await loadCampaignView(campaignId);
  if (!view) return null;
  return renderPullRequest(view);
}
