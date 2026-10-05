/**
 * A software change asked for in a conversation, followed all the way back to
 * that conversation.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * The entrance existed: a person asks Russell, a card is authorized, the factory
 * plans, implements, integrates, reviews, repairs and opens a pull request. What
 * came back to the conversation was a projection somebody had to be looking at,
 * and it stopped at the pull request. Nothing observed the release decision,
 * nothing observed the change reaching production, and nothing confirmed it
 * behaved there. So the person carried the last half of every journey by hand —
 * which is exactly what the Software Factory as a service exists to stop.
 *
 * This module is that half, and it adds no second set of rules:
 *
 * - **Every fact is read, never reported.** A stage is the campaign row's own
 *   state; a merge is the forge's `merged` flag and merge commit; "released" is
 *   this process's own `BRAIN_REVISION` containing that merge commit, which the
 *   forge's compare answers; the live check is a GET this process makes against
 *   itself. No worker's summary decides anything here.
 * - **The release decision stays a person's, where the repository puts it.**
 *   For a hosted campaign the release is merging the pull request, and §27 is
 *   explicit that the factory may open a request and may never merge one. Brain
 *   holds no forge credential and must not. So what Russell offers is the
 *   decision made legible — exactly what would be released — the place to make
 *   it, and a recorded refusal. It observes the person's merge; it never
 *   performs one.
 * - **Each milestone is written once and says so in the conversation once.**
 *   `(request_id, milestone_key)` is unique, only the caller that inserted a
 *   milestone writes its message, and a milestone whose message a crashed tick
 *   never wrote is finished by the next one. That is what makes this survive a
 *   restart, a closed browser and two instances without a second message.
 * - **It is derived on the tick, not hooked to a transition.** A hook would fix
 *   one entrance and miss every request already stranded; reading rows reaches
 *   all of them.
 *
 * ---------------------------------------------------------------------------
 * What it deliberately cannot claim
 * ---------------------------------------------------------------------------
 *
 * Brain can observe deployment only of the repository it runs from — its own
 * revision is the one deployment it can read. For any other repository a merge
 * is reported as a merge and the deployment is named as outside what Brain can
 * see, rather than guessed. And the live check is one path and one piece of
 * text a person saw on the card before authorizing; the acceptance conditions
 * themselves were verified on the integrated tree by the repository's own
 * checks and the independent review, and are not re-run against production.
 */
import { createHash } from 'node:crypto';
import { BRAIN_REVISION, PORT } from '../../env.ts';
import { addMessage } from '../../repos/russellConversations.ts';
import {
  attachMilestoneMessage,
  claimDeliveryPoll,
  getSoftwareRequest,
  listDeliveryMilestones,
  listFollowedSoftwareRequests,
  milestonesAwaitingMessage,
  recordDeliveryMilestone,
} from '../../repos/russellSoftware.ts';
import { loadCampaignView, integratedUnits, latestReview, openFindings, totalUnits } from '../factory/campaignView.ts';
import { campaignBriefing } from '../factory/projections.ts';
import { pullRequestNumber } from '../factory/remote.ts';
import {
  compareCommits,
  parseRemote,
  readChecks,
  readPullRequest,
} from '../factory/forge.ts';
import type { ForgeChecks, ForgeComparison, ForgePullRequest, ForgeReply, ForgeRepository } from '../factory/forge.ts';
import type {
  RussellSoftwareRequest,
  SoftwareDeliveryKind,
  SoftwareDeliveryMilestone,
} from '../../domain/types.ts';
import type { FactoryCampaignState } from '../../domain/factory.ts';

/**
 * The grant whose repository is the one this Brain runs from.
 *
 * The only repository whose deployment Brain can observe, because the only
 * deployment it can read is its own revision. Named by the envelope's own id
 * rather than by a remote, so a fork or a mirror is not mistaken for it.
 */
export const SELF_GRANT_ID = 'brain';

/** How often the forge is asked about one request, at most. */
export const DELIVERY_POLL_MS = 5 * 60_000;

/** A milestone's message is re-written by the reconcile pass only after this long. */
const ORPHAN_MESSAGE_MS = 2 * 60_000;

/** At most this many files are carried on a release card. */
const MAX_RELEASE_FILES = 60;

/** The kinds that end following a request. */
export const TERMINAL_DELIVERY_KINDS: readonly SoftwareDeliveryKind[] = [
  'RELEASE_REFUSED',
  'CLOSED_UNMERGED',
  'CANCELLED',
  'LIVE_VERIFIED',
  'RELEASED',
  'DEPLOY_UNOBSERVABLE',
];

/* -------------------------------------------------------------------------- */
/* What this module reads the world through                                    */
/* -------------------------------------------------------------------------- */

export interface DeliveryDeps {
  readPullRequest(repo: ForgeRepository, number: number): Promise<ForgeReply<ForgePullRequest>>;
  compareCommits(repo: ForgeRepository, base: string, head: string): Promise<ForgeReply<ForgeComparison>>;
  readChecks(repo: ForgeRepository, sha: string): Promise<ForgeReply<ForgeChecks>>;
  /** The revision this process was built from, or null when it carries none. */
  revision(): string | null;
  /** A GET against this process's own origin. Brain composes the URL. */
  fetchSelf(path: string): Promise<{ status: number; contentType: string; body: string }>;
  now(): Date;
}

async function fetchSelf(path: string): Promise<{ status: number; contentType: string; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      signal: controller.signal,
      redirect: 'manual',
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body: await response.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export const REAL_DEPS: DeliveryDeps = {
  readPullRequest,
  compareCommits,
  readChecks,
  revision: () => BRAIN_REVISION,
  fetchSelf,
  now: () => new Date(),
};

/* -------------------------------------------------------------------------- */
/* Recording a milestone and saying it in the conversation                     */
/* -------------------------------------------------------------------------- */

/**
 * Record a fact once and, if this call is the one that recorded it, tell the
 * conversation. `message` null records a fact the conversation need not hear
 * about (a checks reading that changed nothing a person must do).
 */
async function milestone(input: {
  request: RussellSoftwareRequest;
  key: string;
  kind: SoftwareDeliveryKind;
  detail: Record<string, unknown>;
  message: string | null;
  actorType?: 'BRAIN' | 'PERSON';
  actorId?: string | null;
}): Promise<{ created: boolean; milestone: SoftwareDeliveryMilestone }> {
  const recorded = await recordDeliveryMilestone({
    requestId: input.request.id,
    conversationId: input.request.conversationId,
    milestoneKey: input.key,
    kind: input.kind,
    detail: { ...input.detail, ...(input.message ? { message: input.message } : {}) },
    actorType: input.actorType,
    actorId: input.actorId,
  });
  if (recorded.created && input.message) {
    await writeMessage(recorded.milestone, input.message);
  }
  return recorded;
}

/**
 * The message a milestone puts into the conversation, as Brain.
 *
 * SYSTEM rather than RUSSELL: these are facts Brain read — a stage column, a
 * forge flag, a revision — and attributing them to Russell would make a
 * recorded observation read like an opinion somebody formed.
 */
async function writeMessage(entry: SoftwareDeliveryMilestone, content: string): Promise<void> {
  const message = await addMessage({
    conversationId: entry.conversationId,
    role: 'SYSTEM',
    content,
    produced: {
      softwareRequestId: entry.requestId,
      deliveryMilestone: entry.kind,
      milestoneId: entry.id,
    },
  });
  await attachMilestoneMessage(entry.id, message.id);
}

/**
 * Finish what a crashed tick left: a milestone recorded with no message.
 *
 * Only after `ORPHAN_MESSAGE_MS`, so the caller that inserted it — which writes
 * the message in the next statement — is never raced by this pass.
 */
export async function finishOrphanedMessages(limit = 20, now = new Date()): Promise<number> {
  let written = 0;
  for (const entry of await milestonesAwaitingMessage(limit)) {
    if (now.getTime() - Date.parse(entry.observedAt) < ORPHAN_MESSAGE_MS) continue;
    const content = typeof entry.detail['message'] === 'string' ? entry.detail['message'] : null;
    if (!content) continue;
    await writeMessage(entry, content);
    written += 1;
  }
  return written;
}

/* -------------------------------------------------------------------------- */
/* Following one request                                                        */
/* -------------------------------------------------------------------------- */

export interface FollowOutcome {
  requestId: string;
  recorded: SoftwareDeliveryKind[];
  note: string | null;
}

const STAGE_WORDS: Partial<Record<FactoryCampaignState, string>> = {
  PLANNING: 'Planning: turning the request into units of work.',
  EXECUTING: 'Implementing: a worker is writing the code.',
  INTEGRATING: "Integrating: merging the work and running the repository's own checks on it.",
  REVIEWING: 'Under independent review by a session that did not write the change.',
  REPAIRING: 'Repairing what the review found.',
  VERIFYING: "Verifying: running the repository's checks on the finished tree.",
  ASSEMBLING: 'Opening the pull request.',
};

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : 'unknown';
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function has(milestones: SoftwareDeliveryMilestone[], kind: SoftwareDeliveryKind): SoftwareDeliveryMilestone | null {
  return [...milestones].reverse().find((entry) => entry.kind === kind) ?? null;
}

function checksSummary(checks: ForgeChecks | null): {
  state: 'NONE' | 'PENDING' | 'FAILED' | 'PASSED' | 'UNREADABLE';
  total: number;
  failed: string[];
} {
  if (!checks) return { state: 'UNREADABLE', total: 0, failed: [] };
  if (checks.none) return { state: 'NONE', total: 0, failed: [] };
  if (checks.failed.length > 0) {
    return { state: 'FAILED', total: checks.checks.length, failed: checks.failed.map((c) => c.name) };
  }
  if (checks.pending) return { state: 'PENDING', total: checks.checks.length, failed: [] };
  return { state: 'PASSED', total: checks.checks.length, failed: [] };
}

function checksSentence(summary: ReturnType<typeof checksSummary>): string {
  switch (summary.state) {
    case 'PASSED':
      return `All ${summary.total} checks the repository ran on it passed.`;
    case 'FAILED':
      return `${summary.failed.length} of ${summary.total} checks failed: ${summary.failed.join(', ')}.`;
    case 'PENDING':
      return `The repository's checks are still running (${summary.total} reported so far).`;
    case 'NONE':
      return 'The repository has reported no checks on it — which is an absence, not a pass.';
    default:
      return 'The checks could not be read.';
  }
}

/**
 * Advance one authorized request as far as the rows and the forge allow.
 *
 * Every branch either records a milestone or records nothing and says why in
 * `note`; none of them writes anything else.
 */
export async function followSoftwareRequest(
  request: RussellSoftwareRequest,
  deps: DeliveryDeps = REAL_DEPS,
): Promise<FollowOutcome> {
  const outcome: FollowOutcome = { requestId: request.id, recorded: [], note: null };
  if (request.state !== 'AUTHORIZED' || !request.campaignId) {
    outcome.note = 'not authorized';
    return outcome;
  }
  const view = await loadCampaignView(request.campaignId);
  if (!view) {
    outcome.note = 'campaign unreadable';
    return outcome;
  }
  const { campaign, changeRequest } = view;
  const record = async (
    key: string,
    kind: SoftwareDeliveryKind,
    detail: Record<string, unknown>,
    message: string | null,
  ): Promise<void> => {
    const result = await milestone({ request, key, kind, detail, message });
    if (result.created) outcome.recorded.push(kind);
  };

  await record(
    'STARTED',
    'STARTED',
    { campaignId: campaign.id, changeRequestId: changeRequest.id, scope: changeRequest.mutationScope },
    `Authorized. Campaign ${campaign.id} started against ${changeRequest.repository} ` +
      `(${changeRequest.baseBranch}), limited to ${changeRequest.mutationScope.join(', ')}. ` +
      `Done means: ${changeRequest.acceptanceConditions.map((c) => c.statement).join('; ')}`,
  );

  if (campaign.state === 'CANCELLED') {
    await record('CANCELLED', 'CANCELLED', { campaignId: campaign.id }, 'The campaign was cancelled, so nothing will be released.');
    return outcome;
  }

  if (campaign.state === 'BLOCKED' || campaign.blockerKind) {
    const briefing = await campaignBriefing(campaign.id);
    const blocker = briefing?.blocker ?? null;
    if (blocker) {
      const key = `BLOCKED:${blocker.kind}:${fingerprint(blocker.detail ?? '')}`;
      await record(
        key,
        'BLOCKED',
        { kind: blocker.kind, detail: blocker.detail, remedy: blocker.remedy, state: campaign.state },
        `Blocked: ${blocker.detail ?? blocker.kind}. What would unblock it: ${blocker.remedy}`,
      );
    }
    if (campaign.state === 'BLOCKED') return outcome;
  }

  const stageWords = STAGE_WORDS[campaign.state];
  if (stageWords) {
    const total = totalUnits(view);
    const done = integratedUnits(view);
    const round = view.reviews.length;
    const progress = total > 0 ? ` ${done} of ${total} units integrated.` : '';
    /*
     * The number of blockers seen so far is part of the key, so a campaign
     * that was blocked and then resumed in the same stage says so — otherwise
     * the conversation's last word would stay "Blocked" over work that is
     * moving again.
     */
    const blocks = (await listDeliveryMilestones(request.id)).filter((m) => m.kind === 'BLOCKED').length;
    await record(
      `STAGE:${campaign.state}:${round}:${blocks}`,
      'STAGE',
      { state: campaign.state, integratedUnits: done, totalUnits: total, reviewRounds: round },
      `${stageWords}${progress}`,
    );
    return outcome;
  }

  if (campaign.state !== 'COMPLETE' || !campaign.prUrl) {
    outcome.note = `campaign ${campaign.state}`;
    return outcome;
  }

  const repo = parseRemote(changeRequest.repository);
  const number = pullRequestNumber(campaign);
  if (!repo || number === null) {
    outcome.note = 'the pull request cannot be addressed on the forge';
    return outcome;
  }

  const milestones = await listDeliveryMilestones(request.id);
  const ready = has(milestones, 'RELEASE_READY');

  /*
   * A merge is permanent, so once the forge has reported one it is never asked
   * again. What remains is a question about *this process* — does the revision
   * it was built from contain the merge — and that answer only changes when a
   * new process starts, so it is asked once per revision.
   */
  const merged = has(milestones, 'MERGED');
  if (merged) {
    if (request.grantId !== SELF_GRANT_ID) {
      outcome.note = 'merged; deployment is not observable';
      return outcome;
    }
    return followRelease(request, (merged.detail['mergeSha'] as string | null) ?? null, repo, deps, outcome, milestones);
  }

  /*
   * Everything below asks the forge, so it is rate-limited per request by a
   * compare-and-swap on the last poll time rather than by a timer somebody has
   * to remember. The first reading is taken immediately.
   */
  const now = deps.now();
  if (ready && request.deliveryPolledAt) {
    if (now.getTime() - Date.parse(request.deliveryPolledAt) < DELIVERY_POLL_MS) {
      outcome.note = 'polled recently';
      return outcome;
    }
  }
  if (!(await claimDeliveryPoll({ requestId: request.id, previous: request.deliveryPolledAt, at: now.toISOString() }))) {
    outcome.note = 'another tick is polling';
    return outcome;
  }

  const pull = await deps.readPullRequest(repo, number);
  if (!pull.ok || !pull.body) {
    outcome.note = `the forge did not answer: ${pull.reason ?? pull.status}`;
    return outcome;
  }
  const pr = pull.body;

  if (!ready) {
    const [comparison, checks] = await Promise.all([
      deps.compareCommits(repo, pr.baseRef || changeRequest.baseBranch, pr.headSha),
      deps.readChecks(repo, pr.headSha),
    ]);
    const review = latestReview(view);
    const files = comparison.ok && comparison.body ? comparison.body.fileStats.slice(0, MAX_RELEASE_FILES) : [];
    const summary = checksSummary(checks.ok ? checks.body : null);
    const detail = {
      pullRequest: { number: pr.number, url: pr.url, title: pr.title, baseRef: pr.baseRef, headRef: pr.headRef },
      headSha: pr.headSha,
      integrationSha: campaign.integrationSha,
      /*
       * The delivery ingest already refused a pull request whose head is not the
       * commit Brain integrated; this says so on the card rather than asking a
       * person to trust it.
       */
      headIsIntegration: campaign.integrationSha === pr.headSha,
      files,
      filesTotal: comparison.ok && comparison.body ? comparison.body.fileStats.length : null,
      filesTruncated: comparison.ok && comparison.body ? comparison.body.truncated : null,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      checks: summary,
      review: review
        ? { verdict: review.verdict, independence: review.independence, round: review.round, summary: review.summary }
        : null,
      openFindings: openFindings(view).length,
      unitsIntegrated: integratedUnits(view),
      acceptanceConditions: changeRequest.acceptanceConditions.map((c) => ({ statement: c.statement, verification: c.verification })),
      liveCheck: request.liveCheck,
      releasesBrain: request.grantId === SELF_GRANT_ID,
    };
    await record(
      'RELEASE_READY',
      'RELEASE_READY',
      detail,
      `Ready for your release decision: pull request #${pr.number} (${pr.url}) — ` +
        `${files.length} file(s), +${detail.additions}/-${detail.deletions}, head ${short(pr.headSha)}` +
        `${detail.headIsIntegration ? ', which is the commit Brain integrated and had reviewed' : ''}. ` +
        `${review ? `Independent review: ${review.verdict} (${review.independence}). ` : ''}` +
        `${checksSentence(summary)} ` +
        `Merging it is the release${detail.releasesBrain ? ', and the next deploy of production carries it' : ''}; ` +
        'Brain does not merge and will say here when it sees the merge.',
    );
    return outcome;
  }

  if (pr.merged) {
    const mergeSha = pr.mergeCommitSha ?? null;
    await record(
      'MERGED',
      'MERGED',
      { number: pr.number, mergeSha, mergedAt: pr.mergedAt ?? null },
      `Merged: pull request #${pr.number} landed on ${pr.baseRef} as ${short(mergeSha)}` +
        `${pr.mergedAt ? ` at ${pr.mergedAt}` : ''}.` +
        (request.grantId === SELF_GRANT_ID
          ? ' Brain will confirm here when production is serving it.'
          : ''),
    );
    if (request.grantId !== SELF_GRANT_ID) {
      await record(
        'DEPLOY_UNOBSERVABLE',
        'DEPLOY_UNOBSERVABLE',
        { repository: changeRequest.repository },
        `This is merged. Where ${changeRequest.repository} is deployed is outside what Brain can observe, ` +
          'so nothing further is claimed about it here.',
      );
      return outcome;
    }
    return followRelease(request, mergeSha, repo, deps, outcome, await listDeliveryMilestones(request.id));
  }

  if (pr.state === 'closed') {
    await record(
      'CLOSED_UNMERGED',
      'CLOSED_UNMERGED',
      { number: pr.number, closedAt: pr.closedAt ?? null },
      `Pull request #${pr.number} was closed without merging, so nothing was released.`,
    );
    return outcome;
  }

  // Still open: keep the checks reading current, and say so only when a person
  // would act on it — a failure, or the first time everything passed. Once the
  // checks on this head have settled they cannot change, so they are not read
  // again until a new head is pushed.
  const settled = milestones.some(
    (m) =>
      m.kind === 'CHECKS' &&
      (m.detail['headSha'] as string | undefined) === pr.headSha &&
      ['PASSED', 'FAILED'].includes(String((m.detail['checks'] as { state?: string } | undefined)?.state)),
  );
  if (settled) {
    outcome.note = 'awaiting the release decision';
    return outcome;
  }
  const checks = await deps.readChecks(repo, pr.headSha);
  const summary = checksSummary(checks.ok ? checks.body : null);
  if (summary.state !== 'UNREADABLE') {
    const speak = summary.state === 'FAILED' || summary.state === 'PASSED';
    await record(
      `CHECKS:${pr.headSha}:${fingerprint(summary)}`,
      'CHECKS',
      { headSha: pr.headSha, checks: summary },
      speak ? `On pull request #${pr.number}: ${checksSentence(summary)}` : null,
    );
  }
  outcome.note = outcome.note ?? 'awaiting the release decision';
  return outcome;
}

/**
 * After the merge: is this process serving it, and does it behave?
 *
 * Only reached for the repository this Brain runs from. The revision is the
 * process's own; the containment is the forge's compare; the behaviour is a GET
 * against this process. A process built before the merge simply finds nothing
 * yet, and the next process — the one a deploy starts — finds it.
 */
/**
 * Revisions already compared against a merge and found not to contain it.
 *
 * In memory on purpose: the answer is about this process's revision, which
 * cannot change while this process lives, and a new process — the only thing
 * that could change it — starts with an empty map and asks again. It saves a
 * forge call per request per poll for as long as a merge waits for a deploy.
 */
const notYetServing = new Set<string>();

async function followRelease(
  request: RussellSoftwareRequest,
  mergeSha: string | null,
  repo: ForgeRepository,
  deps: DeliveryDeps,
  outcome: FollowOutcome,
  milestones: SoftwareDeliveryMilestone[],
): Promise<FollowOutcome> {
  const revision = deps.revision();
  if (!mergeSha) {
    outcome.note = 'the forge reported no merge commit';
    return outcome;
  }
  if (!revision) {
    outcome.note = 'this process carries no BRAIN_REVISION, so it cannot say what it serves';
    return outcome;
  }
  if (milestones.some((m) => m.milestoneKey === `LIVE:${revision}`)) {
    outcome.note = 'already checked on this revision';
    return outcome;
  }
  const memo = `${request.id}:${mergeSha}:${revision}`;
  if (notYetServing.has(memo)) {
    outcome.note = `serving ${short(revision)}, which does not contain ${short(mergeSha)} yet`;
    return outcome;
  }
  const comparison = await deps.compareCommits(repo, mergeSha, revision);
  if (!comparison.ok || !comparison.body) {
    outcome.note = `the forge could not compare: ${comparison.reason ?? comparison.status}`;
    return outcome;
  }
  const contains = comparison.body.status === 'identical' || comparison.body.status === 'ahead';
  if (!contains) {
    notYetServing.add(memo);
    outcome.note = `serving ${short(revision)}, which does not contain ${short(mergeSha)} yet`;
    return outcome;
  }

  const checks = await deps.readChecks(repo, revision);
  const summary = checksSummary(checks.ok ? checks.body : null);
  const recordedDeploy = await milestone({
    request,
    key: `DEPLOYED:${revision}`,
    kind: 'DEPLOYED',
    detail: { revision, mergeSha, relation: comparison.body.status, checks: summary },
    message:
      `Released: production is serving ${short(revision)}, which contains the merge ${short(mergeSha)} ` +
      `(checked through the forge, not assumed). On that revision: ${checksSentence(summary)}`,
  });
  if (recordedDeploy.created) outcome.recorded.push('DEPLOYED');

  const live = request.liveCheck;
  if (!live) {
    const done = await milestone({
      request,
      key: 'RELEASED',
      kind: 'RELEASED',
      detail: { revision },
      message:
        'No live check was declared for this change, so Brain confirms it is deployed and claims nothing ' +
        'further about how it behaves in production. Its acceptance conditions were verified before release.',
    });
    if (done.created) outcome.recorded.push('RELEASED');
    return outcome;
  }

  const result = await runLiveCheck(live.path, live.contains, deps);
  const done = await milestone({
    request,
    key: `LIVE:${revision}`,
    kind: result.found ? 'LIVE_VERIFIED' : 'LIVE_CHECK_FAILED',
    detail: { revision, ...live, ...result },
    message: result.found
      ? `Verified live: ${live.path} on production (${short(revision)}) serves "${live.contains}"` +
        `${result.where !== live.path ? ` (in ${result.where})` : ''}. The change is released and working.`
      : `The live check did not pass: ${live.path} on production (${short(revision)}) does not serve ` +
        `"${live.contains}" (${result.reason}). The change is deployed; it is not behaving as the card said.`,
  });
  if (done.created) outcome.recorded.push(done.milestone.kind);
  return outcome;
}

/**
 * One path on this process, and the same-origin scripts and styles it loads.
 *
 * A single-page application's text lives in its bundle rather than in the HTML,
 * so a check that only read the page would fail every UI change. It follows only
 * references that start with `/` — this origin — and at most twelve of them.
 */
export async function runLiveCheck(
  path: string,
  contains: string,
  deps: Pick<DeliveryDeps, 'fetchSelf'>,
): Promise<{ found: boolean; where: string; reason: string; status: number }> {
  let page: { status: number; contentType: string; body: string };
  try {
    page = await deps.fetchSelf(path);
  } catch (error: unknown) {
    return { found: false, where: path, reason: `the request failed (${String(error)})`, status: 0 };
  }
  if (page.status !== 200) {
    return { found: false, where: path, reason: `it answered ${page.status}`, status: page.status };
  }
  if (page.body.includes(contains)) return { found: true, where: path, reason: 'found', status: 200 };
  if (!/html/i.test(page.contentType)) {
    return { found: false, where: path, reason: 'the text is not in the response', status: 200 };
  }
  const references = [...page.body.matchAll(/(?:src|href)="(\/[^"#?]+\.(?:js|css))"/g)]
    .map((match) => match[1]!)
    .filter((ref) => !ref.startsWith('//'))
    .slice(0, 12);
  for (const ref of references) {
    try {
      const asset = await deps.fetchSelf(ref);
      if (asset.status === 200 && asset.body.includes(contains)) {
        return { found: true, where: ref, reason: 'found', status: 200 };
      }
    } catch {
      /* one unreadable asset is not a verdict about the rest */
    }
  }
  return {
    found: false,
    where: path,
    reason: `the text is not in the page or the ${references.length} same-origin asset(s) it loads`,
    status: 200,
  };
}

/* -------------------------------------------------------------------------- */
/* The person's refusal                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A person declining to release what the factory built.
 *
 * Only while a release is actually waiting: before the pull request exists
 * there is nothing to refuse, and after the merge the release already
 * happened. It records the decision, tells the conversation, and stops
 * following — it does not close the pull request, because Brain does not write
 * to the forge; the message says so, so nobody believes it did.
 */
export async function refuseSoftwareRelease(input: {
  requestId: string;
  userId: string;
  reason: string;
}): Promise<{ ok: boolean; reason: string }> {
  const request = await getSoftwareRequest(input.requestId);
  if (!request || request.state !== 'AUTHORIZED') return { ok: false, reason: 'No release is waiting on this request.' };
  const milestones = await listDeliveryMilestones(request.id);
  const ready = has(milestones, 'RELEASE_READY');
  if (!ready) return { ok: false, reason: 'No release is waiting on this request yet.' };
  const ended = milestones.find((m) => ['MERGED', ...TERMINAL_DELIVERY_KINDS].includes(m.kind));
  if (ended) return { ok: false, reason: 'This release has already been decided.' };
  const pr = (ready.detail['pullRequest'] ?? {}) as { number?: number; url?: string };
  const reason = input.reason.trim() || 'No reason given.';
  const result = await milestone({
    request,
    key: 'RELEASE_REFUSED',
    kind: 'RELEASE_REFUSED',
    detail: { reason, pullRequest: pr },
    actorType: 'PERSON',
    actorId: input.userId,
    message:
      `You refused this release: ${reason} Nothing was merged. Brain has stopped following ` +
      `pull request #${pr.number ?? '?'}; close it on GitHub if you want it gone — Brain does not write to the forge.`,
  });
  return result.created
    ? { ok: true, reason: 'refused' }
    : { ok: false, reason: 'This release has already been decided.' };
}

/* -------------------------------------------------------------------------- */
/* The tick                                                                    */
/* -------------------------------------------------------------------------- */

export async function followSoftwareDeliveries(
  limit = 20,
  deps: DeliveryDeps = REAL_DEPS,
): Promise<{ followed: FollowOutcome[]; orphansWritten: number }> {
  const followed: FollowOutcome[] = [];
  for (const request of await listFollowedSoftwareRequests(limit)) {
    try {
      followed.push(await followSoftwareRequest(request, deps));
    } catch (error: unknown) {
      followed.push({ requestId: request.id, recorded: [], note: `could not follow: ${String(error)}` });
    }
  }
  const orphansWritten = await finishOrphanedMessages(20, deps.now());
  return { followed, orphansWritten };
}

/* -------------------------------------------------------------------------- */
/* What a reader of the conversation is shown                                  */
/* -------------------------------------------------------------------------- */

export type DeliveryPhase =
  | 'RUNNING'
  | 'BLOCKED'
  | 'AWAITING_RELEASE'
  | 'RELEASE_REFUSED'
  | 'CLOSED_UNMERGED'
  | 'CANCELLED'
  | 'MERGED'
  | 'DEPLOYED'
  | 'RELEASED'
  | 'LIVE_VERIFIED'
  | 'LIVE_CHECK_FAILED'
  | 'DEPLOY_UNOBSERVABLE';

export interface DeliveryView {
  phase: DeliveryPhase;
  /** What would be released, as recorded when the pull request became ready. */
  release: Record<string, unknown> | null;
  /** The latest checks reading on the pull request, when one was taken after it. */
  latestChecks: Record<string, unknown> | null;
  timeline: { kind: SoftwareDeliveryKind; at: string; text: string | null; byPerson: boolean }[];
  /** True while a person's release decision is what the request waits on. */
  releaseDecisionWaiting: boolean;
}

/** Derived on the read path from the ledger; writes nothing. */
export async function deliveryViewFor(request: RussellSoftwareRequest): Promise<DeliveryView | null> {
  if (request.state !== 'AUTHORIZED') return null;
  const milestones = await listDeliveryMilestones(request.id);
  const last = (kind: SoftwareDeliveryKind) => has(milestones, kind);
  const ready = last('RELEASE_READY');
  const order: [SoftwareDeliveryKind, DeliveryPhase][] = [
    ['LIVE_VERIFIED', 'LIVE_VERIFIED'],
    ['LIVE_CHECK_FAILED', 'LIVE_CHECK_FAILED'],
    ['RELEASED', 'RELEASED'],
    ['DEPLOY_UNOBSERVABLE', 'DEPLOY_UNOBSERVABLE'],
    ['DEPLOYED', 'DEPLOYED'],
    ['MERGED', 'MERGED'],
    ['RELEASE_REFUSED', 'RELEASE_REFUSED'],
    ['CLOSED_UNMERGED', 'CLOSED_UNMERGED'],
    ['CANCELLED', 'CANCELLED'],
  ];
  let phase: DeliveryPhase = ready ? 'AWAITING_RELEASE' : 'RUNNING';
  for (const [kind, name] of order) {
    if (last(kind)) {
      phase = name;
      break;
    }
  }
  /*
   * RUNNING versus BLOCKED before the pull request is the campaign's own state,
   * which `viewOf` reads from the authoritative briefing — a second derivation
   * of it from this ledger would be two readers of one fact.
   */
  const checks = last('CHECKS');
  return {
    phase,
    release: ready?.detail ?? null,
    latestChecks: checks && ready && checks.observedAt >= ready.observedAt ? checks.detail : null,
    timeline: milestones
      .filter((m) => m.kind !== 'CHECKS' || typeof m.detail['message'] === 'string')
      .map((m) => ({
        kind: m.kind,
        at: m.observedAt,
        text: typeof m.detail['message'] === 'string' ? m.detail['message'] : null,
        byPerson: m.actorType === 'PERSON',
      })),
    releaseDecisionWaiting: phase === 'AWAITING_RELEASE',
  };
}

