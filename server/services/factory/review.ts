/**
 * Independent review: reading the change against the objective, not against the
 * report.
 *
 * Two properties make this a review rather than a second opinion from the author:
 *
 *   * **The reviewer is a different session.** Enforced from recorded execution
 *     lineage — which worker, which account, which session — exactly as §23
 *     decides audit independence, and never from a role label, because a label
 *     is something a caller could choose. The floor is session separation; worker
 *     and account separation are stronger tiers that are *reported* when the
 *     fleet happens to supply them and never claimed when it does not.
 *
 *   * **The reviewer cannot change what it reviews.** Its worktree is detached at
 *     the reviewed commit and its tool allowance has no writing tool in it. "A
 *     reviewer cannot silently mutate reviewed work" is therefore a property of
 *     the execution rather than a rule in a prompt.
 *
 * The verdict is validated the way §8 validates an audit: enums matched exactly,
 * no substring matching, no closest-verdict, no inferred approval. An unparsable
 * reply is a review failure — nothing is recorded as a verdict and the campaign
 * does not advance — because a verdict you cannot trace is not a review.
 */
import path from 'node:path';
import type {
  FactoryCampaign,
  FactoryChangeRequest,
  FactoryFinding,
  FactoryFindingSeverity,
  FactoryIndependenceTier,
  FactoryReview,
  FactoryReviewVerdict,
  FactorySession,
  FactoryWorker,
} from '../../domain/factory.ts';
import { listUnits } from '../../repos/factory.ts';
import {
  closeSession,
  implementingSessions,
  listFindings,
  openSession,
  putArtifact,
  recordFactoryEvent,
  recordReview,
  recordWorkerFailure,
  recordWorkerRateLimit,
  recordWorkerSuccess,
} from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { REVIEW_FENCE, compileReviewAssignment } from './prompts.ts';
import { executorFor } from './executors/index.ts';
import { campaignWorkspace, ensureWorktree, git, gitOrThrow, mergeBase } from './git.ts';

/** A reviewer reads. It does not write, and the allowance is how that is true. */
export const REVIEWER_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git status:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(grep:*)',
  'Bash(find:*)',
  'Bash(wc:*)',
];

export const DEFAULT_REVIEW_TIMEOUT_MS = 25 * 60 * 1000;

/* ------------------------------------------------------------------------- */
/* Independence                                                              */
/* ------------------------------------------------------------------------- */

export interface LineageCandidate {
  sessionId: string;
  workerId: string;
  accountRef: string;
}

export type IndependenceVerdict =
  | { ok: true; tier: FactoryIndependenceTier; detail: string }
  | { ok: false; reason: string };

/**
 * What separation this reviewer would actually achieve.
 *
 * The refusal is the floor: a session that implemented something in this campaign
 * may not review it. Everything above the floor is a *report* — the tier the
 * fleet happened to supply — and is never rounded up. A same-account result is
 * not described as cross-account independent, and an unknown lineage fails closed
 * rather than passing as "we could not tell".
 */
export function decideIndependence(
  reviewer: LineageCandidate,
  implementers: LineageCandidate[],
): IndependenceVerdict {
  if (!reviewer.sessionId || !reviewer.workerId || !reviewer.accountRef) {
    return {
      ok: false,
      reason:
        'The reviewer has no resolvable lineage. An independence that cannot be established has ' +
        'not been established.',
    };
  }
  if (reviewer.sessionId.startsWith('future:')) {
    return {
      ok: false,
      reason: 'A predicted session is allocator reasoning, never evidence of independence.',
    };
  }
  if (implementers.some((candidate) => candidate.sessionId === reviewer.sessionId)) {
    return {
      ok: false,
      reason: 'That session implemented this work. One model context reviewing itself is the ' +
        'thing an independent review exists to defeat.',
    };
  }
  if (implementers.length === 0) {
    return {
      ok: false,
      reason: 'Nothing has been implemented in this campaign, so there is nothing to review.',
    };
  }

  const sameWorker = implementers.some((c) => c.workerId === reviewer.workerId);
  const sameAccount = implementers.some((c) => c.accountRef === reviewer.accountRef);
  if (!sameAccount) {
    return { ok: true, tier: 'ACCOUNT_SEPARATED', detail: 'a different account reviewed it' };
  }
  if (!sameWorker) {
    return { ok: true, tier: 'WORKER_SEPARATED', detail: 'a different worker on the same account' };
  }
  return {
    ok: true,
    tier: 'SESSION_SEPARATED',
    detail: 'a different session of the same worker, which is the floor',
  };
}

/* ------------------------------------------------------------------------- */
/* Validating what a reviewer said                                           */
/* ------------------------------------------------------------------------- */

export interface ValidatedReview {
  verdict: FactoryReviewVerdict;
  summary: string;
  findings: {
    key: string;
    severity: FactoryFindingSeverity;
    category: string;
    statement: string;
    evidence: string;
    acceptanceConditionId: string | null;
    suggestedPaths: string[];
  }[];
}

const VERDICTS: FactoryReviewVerdict[] = ['PASS', 'CHANGES_REQUIRED', 'BLOCKED'];
const SEVERITIES: FactoryFindingSeverity[] = ['BLOCKER', 'MAJOR', 'MINOR'];

export type ReviewParse =
  | { ok: true; review: ValidatedReview }
  | { ok: false; reason: string };

/**
 * Read the reviewer's block, strictly.
 *
 * Exact enum matching and nothing else: no substring search for "pass", no
 * treating an absent verdict as approval, no closest match. The forgiving path
 * does not exist here on purpose — §8's separation between a human pasting a
 * verdict in and a model's own output taking the strict route.
 */
export function parseReview(text: string): ReviewParse {
  const fenced = new RegExp('```(?:' + REVIEW_FENCE + '|json)?\\s*([\\s\\S]*?)```', 'g');
  const blocks: string[] = [];
  for (const match of text.matchAll(fenced)) if (match[1]) blocks.push(match[1]);
  if (blocks.length === 0) return { ok: false, reason: 'The reviewer wrote no structured block.' };

  for (const block of blocks.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;

    const verdict = record['verdict'];
    if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as FactoryReviewVerdict)) {
      return {
        ok: false,
        reason: `\`${String(verdict)}\` is not one of ${VERDICTS.join(', ')}. No verdict is inferred.`,
      };
    }

    const rawFindings = record['findings'];
    if (rawFindings !== undefined && !Array.isArray(rawFindings)) {
      return { ok: false, reason: '`findings` is present and is not an array.' };
    }

    const findings: ValidatedReview['findings'] = [];
    const seen = new Set<string>();
    for (const entry of (rawFindings ?? []) as unknown[]) {
      if (typeof entry !== 'object' || entry === null) {
        return { ok: false, reason: 'A finding is not an object.' };
      }
      const finding = entry as Record<string, unknown>;
      const severity = String(finding['severity'] ?? '');
      if (!SEVERITIES.includes(severity as FactoryFindingSeverity)) {
        return { ok: false, reason: `\`${severity}\` is not one of ${SEVERITIES.join(', ')}.` };
      }
      const statement = String(finding['statement'] ?? '').trim();
      if (statement.length < 8) {
        return { ok: false, reason: 'A finding with no statement is not a finding.' };
      }
      const evidence = String(finding['evidence'] ?? '').trim();
      if (evidence.length < 4) {
        return {
          ok: false,
          reason:
            `The finding "${statement.slice(0, 60)}" has no evidence. An impression sends a ` +
            'worker to rewrite something that was correct.',
        };
      }
      let key = String(finding['key'] ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      key = key.replace(/^-+|-+$/g, '').slice(0, 60);
      if (key.length < 3) key = `finding-${findings.length + 1}`;
      if (seen.has(key)) key = `${key}-${findings.length + 1}`;
      seen.add(key);

      const suggested = Array.isArray(finding['suggestedPaths'])
        ? (finding['suggestedPaths'] as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          )
        : [];

      findings.push({
        key,
        severity: severity as FactoryFindingSeverity,
        category: String(finding['category'] ?? 'unspecified').slice(0, 60),
        statement,
        evidence,
        acceptanceConditionId:
          typeof finding['acceptanceConditionId'] === 'string'
            ? (finding['acceptanceConditionId'] as string)
            : null,
        suggestedPaths: suggested,
      });
    }

    // The cross-check: a PASS while a blocker is open is refused outright, the
    // same way an advancing audit verdict is refused while a foundational gap is
    // open. A reviewer that can contradict itself is a reviewer that can approve
    // anything.
    if (
      verdict === 'PASS' &&
      findings.some((finding) => finding.severity === 'BLOCKER')
    ) {
      return {
        ok: false,
        reason: 'The reviewer returned PASS while reporting a BLOCKER. The verdict contradicts ' +
          'its own findings, so nothing is recorded.',
      };
    }

    return {
      ok: true,
      review: {
        verdict: verdict as FactoryReviewVerdict,
        summary: String(record['summary'] ?? '').slice(0, 4000),
        findings,
      },
    };
  }
  return { ok: false, reason: 'No structured block in the reply could be read as a review.' };
}

/* ------------------------------------------------------------------------- */
/* Running a review                                                          */
/* ------------------------------------------------------------------------- */

export interface ReviewInput {
  repoRoot: string;
  campaign: FactoryCampaign;
  changeRequest: FactoryChangeRequest;
  worker: FactoryWorker;
  model: string;
  round: number;
  reviewedSha: string;
  timeoutMs?: number;
}

export type ReviewOutcome =
  | {
      ok: true;
      review: FactoryReview;
      findings: FactoryFinding[];
      independence: FactoryIndependenceTier;
      sessionId: string;
    }
  | { ok: false; reason: string; sessionId: string | null };

/**
 * Review the campaign's integration branch against the change request.
 *
 * Fails closed in every direction that matters: no eligible reviewer, an
 * unreadable verdict, a verdict that contradicts its own findings — all of them
 * record the failure and move nothing. A campaign is never advanced by a review
 * that did not happen.
 */
export async function reviewCampaign(input: ReviewInput): Promise<ReviewOutcome> {
  const { campaign, changeRequest, worker } = input;

  const implementers = (await implementingSessions(campaign.id))
    .filter((session: FactorySession) => session.externalSessionId !== null)
    .map((session) => ({
      sessionId: session.externalSessionId ?? session.id,
      workerId: session.workerId,
      accountRef: session.accountRef,
    }));

  const executor = executorFor(worker.kind);
  if (!executor) {
    return { ok: false, reason: `No executor implements ${worker.kind}.`, sessionId: null };
  }

  const session = await openSession({
    campaignId: campaign.id,
    unitId: null,
    workerId: worker.id,
    accountRef: worker.accountRef,
    attempt: input.round,
    role: 'REVIEWER',
    model: input.model,
  });

  // A detached worktree at the reviewed commit. Detached rather than on the
  // branch so nothing a reviewer did could move the campaign's own ref.
  const worktreePath = path.join(campaignWorkspace(campaign.id), `review-r${input.round}`);
  const existing = await git(input.repoRoot, ['worktree', 'list', '--porcelain']);
  if (!existing.stdout.includes(worktreePath)) {
    await gitOrThrow(input.repoRoot, ['worktree', 'add', '--detach', worktreePath, input.reviewedSha]);
  } else {
    await gitOrThrow(worktreePath, ['checkout', '--detach', input.reviewedSha]);
  }

  const units = await listUnits(campaign.id);
  const previousFindings = (await listFindings(campaign.id)).map((finding) => ({
    key: finding.findingKey,
    statement: finding.statement,
    state: finding.state,
  }));

  // What this campaign added, rather than everything that landed on the base
  // branch since the pin. A campaign merges its base in whenever that branch
  // moves, so the pinned base is the wrong end of the diff for a reviewer.
  const effectiveBase =
    (await mergeBase(input.repoRoot, changeRequest.baseBranch, input.reviewedSha)) ??
    campaign.baseSha;

  const assignment = compileReviewAssignment({
    changeRequest,
    round: input.round,
    reviewedSha: input.reviewedSha,
    baseSha: effectiveBase,
    diffCommand: `git diff ${effectiveBase.slice(0, 12)}..${input.reviewedSha.slice(0, 12)}`,
    units: units
      .filter((unit) => unit.state === 'INTEGRATED')
      .map((unit) => ({
        unitKey: unit.unitKey,
        title: unit.title,
        objective: unit.objective,
        ownedPaths: unit.ownedPaths,
      })),
    previousFindings,
  });

  const result = await executor.execute({
    campaignId: campaign.id,
    unitId: null as unknown as string,
    sessionId: session.id,
    worktreePath,
    branch: campaign.integrationBranch,
    model: input.model,
    assignment,
    timeoutMs: input.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    allowedTools: REVIEWER_ALLOWED_TOOLS,
  });

  if (result.rawLog) {
    await putArtifact({
      campaignId: campaign.id,
      sessionId: session.id,
      kind: 'WORKER_LOG',
      text: result.rawLog,
    });
  }

  // The lineage question is asked with the session identity the run actually
  // produced, because that is the id the review is recorded against.
  const independence = decideIndependence(
    {
      sessionId: result.externalSessionId ?? session.id,
      workerId: worker.id,
      accountRef: worker.accountRef,
    },
    implementers,
  );

  if (!independence.ok) {
    await closeSession(session.id, { state: 'FAILED', exitReason: independence.reason });
    await recordFactoryEvent({
      campaignId: campaign.id,
      workerId: worker.id,
      sessionId: session.id,
      kind: FACTORY_EVENT_KINDS.unitRefused,
      evidenceClass: 'MEASURED',
      detail: { stage: 'REVIEW', reason: independence.reason, round: input.round },
    });
    return { ok: false, reason: independence.reason, sessionId: session.id };
  }

  if (result.outcome !== 'COMPLETED') {
    await closeSession(session.id, {
      state: result.outcome === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'FAILED',
      exitReason: result.detail,
      externalSessionId: result.externalSessionId,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      usage: result.usage,
    });
    if (result.outcome === 'RATE_LIMITED') {
      /*
       * A provider refusal at the review is backpressure, exactly as it is at a
       * unit — and it was missing both halves of the treatment the dispatch path
       * gives it. Nothing wrote it to the ledger, so the campaign's own
       * throughput report could not see a refusal that had happened; and nothing
       * deferred the worker, so the next tick chose the same refusing surface
       * immediately. The failure streak is still untouched: an account at its
       * ceiling is busy, not broken.
       */
      const until = await recordWorkerRateLimit(worker.id, result.retryAfterMs ?? 5 * 60 * 1000);
      await recordFactoryEvent({
        campaignId: campaign.id,
        workerId: worker.id,
        sessionId: session.id,
        accountRef: worker.accountRef,
        kind: FACTORY_EVENT_KINDS.sessionRateLimited,
        durationMs: result.durationMs,
        evidenceClass: 'PROVIDER_ENFORCED',
        detail: {
          stage: 'REVIEW',
          round: input.round,
          until,
          // No unit attempt was spent, so there is none to refund: the campaign
          // simply stays in REVIEWING and the next tick tries again.
          attemptRefunded: false,
          attemptCharged: false,
          workerFailureCharged: false,
        },
      });
    } else {
      await recordWorkerFailure(worker.id);
    }
    return {
      ok: false,
      reason: `The reviewer did not finish: ${result.detail}`,
      sessionId: session.id,
    };
  }

  const parsed = parseReview(result.summary);
  if (!parsed.ok) {
    await closeSession(session.id, {
      state: 'FAILED',
      exitReason: parsed.reason,
      externalSessionId: result.externalSessionId,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      usage: result.usage,
    });
    await recordFactoryEvent({
      campaignId: campaign.id,
      workerId: worker.id,
      sessionId: session.id,
      kind: FACTORY_EVENT_KINDS.reviewCompleted,
      evidenceClass: 'MEASURED',
      detail: { round: input.round, recorded: false, reason: parsed.reason },
    });
    return { ok: false, reason: parsed.reason, sessionId: session.id };
  }

  await closeSession(session.id, {
    state: 'FINISHED',
    exitReason: result.detail,
    externalSessionId: result.externalSessionId,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    usage: result.usage,
  });
  await recordWorkerSuccess(worker.id);

  const stored = await recordReview({
    campaignId: campaign.id,
    round: input.round,
    scope: 'CAMPAIGN',
    reviewerSessionId: session.id,
    reviewedSha: input.reviewedSha,
    verdict: parsed.review.verdict,
    summary: parsed.review.summary,
    independence: independence.tier,
    findings: parsed.review.findings.map((finding) => ({
      key: finding.key,
      severity: finding.severity,
      category: finding.category,
      statement: finding.statement,
      // The suggested paths travel with the finding, because the repair unit's
      // ownership is derived from them — after being held against the approved
      // mutation scope, which is the only thing that decides what may be touched.
      evidence:
        finding.suggestedPaths.length > 0
          ? `${finding.evidence}\n\nSuggested paths: ${finding.suggestedPaths.join(', ')}`
          : finding.evidence,
      acceptanceConditionId: finding.acceptanceConditionId,
    })),
  });

  await recordFactoryEvent({
    campaignId: campaign.id,
    workerId: worker.id,
    sessionId: session.id,
    accountRef: worker.accountRef,
    kind: FACTORY_EVENT_KINDS.reviewCompleted,
    durationMs: result.durationMs,
    evidenceClass: 'MEASURED',
    detail: {
      round: input.round,
      verdict: parsed.review.verdict,
      findings: stored.findings.length,
      blockers: stored.findings.filter((f) => f.severity === 'BLOCKER').length,
      independence: independence.tier,
      independenceDetail: independence.detail,
      reviewedSha: input.reviewedSha,
    },
  });

  for (const finding of stored.findings) {
    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: FACTORY_EVENT_KINDS.findingRecorded,
      evidenceClass: 'MEASURED',
      detail: {
        findingKey: finding.findingKey,
        severity: finding.severity,
        category: finding.category,
        acceptanceConditionId: finding.acceptanceConditionId,
      },
    });
  }

  return {
    ok: true,
    review: stored.review,
    findings: stored.findings,
    independence: independence.tier,
    sessionId: session.id,
  };
}
