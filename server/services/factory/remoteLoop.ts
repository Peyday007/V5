/**
 * The hosted factory's own tick: a campaign that advances with nobody watching.
 *
 * Everything here is the same state machine `loop.ts` already runs — plan, then
 * implement, then review, then repair, then finish — with one difference that
 * changes where it can run. `loop.ts` moves a campaign by *doing* the work: it
 * spawns a process, merges a branch, runs a command. This moves a campaign by
 * **making the next thing available to a worker that is somewhere else**, and by
 * believing the repository rather than the worker when the work comes back.
 *
 * That is what lets the control plane live on a machine with no checkout, and it
 * is why this is a second loop rather than a flag inside the first. The two
 * verify differently: one reads a diff it has, the other asks a forge. A single
 * function pretending to do both would have one of those paths untested in
 * whichever environment it was not running in.
 *
 * ---------------------------------------------------------------------------
 * Why every step is idempotent by its own rows
 * ---------------------------------------------------------------------------
 *
 * A tick can run twice — two instances, a restart mid-tick, a redelivered
 * timer — so nothing here may depend on having run exactly once. It does not
 * keep a cursor and it does not mark bins as read. Instead every step is a
 * no-op the second time *because of what the first one changed*: a plan that
 * installed leaves units, so the planning branch is not taken; an accepted report
 * leaves the unit INTEGRATED, so `claimUnits` hands nothing back; a recorded
 * review leaves a row for that round, so a second ingestion finds it and stops.
 *
 * That is deliberately stronger than a flag. A flag can be set by a tick that
 * then dies before doing the work it claimed; rows cannot.
 */
import type { Bin } from '../../domain/types.ts';
import type { FactoryBlockerKind, FactoryCampaign, FactoryChangeRequest } from '../../domain/factory.ts';
import {
  advanceUnitAttempt,
  claimCampaignTick,
  extendCampaignTick,
  getCampaign,
  getChangeRequest,
  listLiveCampaigns,
  listUnits,
  patchCampaign,
  promoteReadyUnits,
  releaseCampaignTick,
  reopenUnit,
} from '../../repos/factory.ts';
import {
  listFactoryEvents,
  listReviews,
  recordFactoryEvent,
  recordReview,
} from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { installPlan, validatePlan } from './planner.ts';
import { gatingFindings, queueRepairs, reconcileRepairs } from './repair.ts';
import { recordCampaignOutcome } from './writeback.ts';
import {
  acceptIntegration,
  integrationBranchDrift,
  acceptUnitReport,
  binBaseOf,
  binIdentity,
  campaignBins,
  createDeliverBin,
  declaredBranchFor,
  createIntegrateBin,
  createPlanBin,
  createReviewBin,
  createUnitsBin,
  integrationChecks,
  liveBinOfKind,
  pullRequestNumber,
  readDeliveryReport,
  readIntegrationReport,
  readPlanProposal,
  reviewLineage,
  readReviewReport,
  readUnitReports,
  remoteBranchFor,
  roundBaseFor,
  verifyDelivery,
  verifyIntegrationReport,
  verifyUnitReport,
} from './remote.ts';
import { parseRemote } from './forge.ts';
import { pullRequestFor } from './pullRequest.ts';

/** How long a dispatcher may hold a campaign's tick, and how often it renews. */
const TICK_HEARTBEAT_MS = 15_000;

export interface RemoteTickReport {
  campaignId: string;
  /**
   * The project the campaign belongs to.
   *
   * Here because a caller asking "did anything become available for *me*" cannot
   * answer it from a campaign id, and resolving one afterwards would be a second
   * read of a row this already had in its hand.
   */
  projectId: string;
  state: string;
  stage: string;
  notes: string[];
  created: string[];
  ingested: string[];
  progress: boolean;
  tickHeld: boolean;
}

function empty(
  campaignId: string,
  projectId: string,
  state: string,
  stage: string,
  note: string,
): RemoteTickReport {
  return {
    campaignId,
    projectId,
    state,
    stage,
    notes: [note],
    created: [],
    ingested: [],
    progress: false,
    tickHeld: false,
  };
}

/* ------------------------------------------------------------------------- */
/* Reading what a worker finished                                             */
/* ------------------------------------------------------------------------- */

/**
 * A completed plan bin becomes units, or it becomes nothing.
 *
 * `validatePlan` is run again here even though the bin's contract already ran it.
 * That is not belt-and-braces: the contract evaluated the plan against the change
 * request *as it was when the worker called complete*, and an amendment between
 * then and now would make the installed plan answer a contract nobody approved.
 * Re-validating costs a pure function call and closes that window.
 */
async function ingestPlanBin(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  bin: Bin,
  report: RemoteTickReport,
): Promise<boolean> {
  const existing = await listUnits(campaign.id);
  if (existing.length > 0) return false;

  const proposal = await readPlanProposal(bin.id);
  if (proposal === null) {
    report.notes.push(`The plan bin ${bin.id} completed with nothing to install.`);
    return false;
  }
  const validation = validatePlan(proposal, changeRequest);
  if (!validation.ok) {
    // The contract passed it and this did not, which can only mean the contract
    // moved underneath. Said plainly rather than installed anyway.
    report.notes.push(
      `The plan that satisfied bin ${bin.id} no longer validates against the contract: ` +
        validation.errors.join(' '),
    );
    return false;
  }
  const installed = await installPlan(campaign.id, validation.units);
  for (const unit of validation.units) {
    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: FACTORY_EVENT_KINDS.unitPlanned,
      evidenceClass: 'MEASURED',
      detail: {
        unitKey: unit.key,
        kind: unit.kind,
        ownedPaths: unit.ownedPaths,
        dependsOn: unit.dependsOn,
        serves: unit.serves,
      },
    });
  }
  await promoteReadyUnits(campaign.id);
  report.ingested.push(`plan:${bin.id}`);
  report.notes.push(`${installed.created} unit(s) installed from the plan.`);
  return true;
}

/**
 * A completed implementation bin becomes integrated units — each one verified
 * against the forge a second time, in the statement that moves the row.
 *
 * The contract already verified to decide the bin. This verifies to decide the
 * *row*, and the difference matters: between the two, a branch could have been
 * force-pushed. Checking again here means the commit Brain records as integrated
 * is one it confirmed at the moment it recorded it.
 */
async function ingestUnitsBin(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  bin: Bin,
  report: RemoteTickReport,
): Promise<boolean> {
  const repository = parseRemote(changeRequest.repository);
  if (!repository) {
    report.notes.push(`"${changeRequest.repository}" is not a repository this Brain can read.`);
    return false;
  }
  const { reports, problems } = await readUnitReports(bin.id);
  for (const problem of problems) report.notes.push(problem);
  if (reports.size === 0) return false;
  const who = await binIdentity(bin);

  const units = await listUnits(campaign.id);
  let moved = 0;
  for (const [key, unitReport] of reports) {
    const unit = units.find((candidate) => candidate.unitKey === key);
    if (!unit) continue;
    /*
     * Only a unit still waiting for a report is acted on.
     *
     * This said `state === 'INTEGRATED'` and nothing else, which left IMPLEMENTED
     * — the state a *successful* acceptance produces — being re-verified on the
     * very next tick. With the expected branch derived from the attempt counter
     * that the acceptance itself had just incremented, the re-verification refused
     * the report it had accepted a second earlier. Both halves are fixed; this one
     * is the idempotency, and it is the same shape as every other step here: a
     * no-op the second time because of what the first one changed.
     */
    if (unit.state !== 'READY') continue;
    // And this bin's report for this unit has not already been acted on. The state
    // alone is not the guard: a refused integration returns a unit to READY.
    if (await alreadyActedOn(campaign.id, unit.id, bin.id)) continue;
    if (unitReport.outcome === 'BLOCKED') {
      report.notes.push(`${key} reported blocked: ${unitReport.blockedReason ?? 'no reason given'}`);
      await refuseUnit(
        campaign,
        unit,
        'WORKER_ERROR',
        unitReport.blockedReason ?? 'The worker reported it blocked without a reason.',
        report,
        bin.id,
      );
      continue;
    }
    const verdict = await verifyUnitReport(
      repository,
      {
        // The name this bin handed out, not one derived now from a counter the
        // acceptance is about to change.
        branch: declaredBranchFor(bin, key) ?? remoteBranchFor(campaign, unit),
        baseSha: binBaseOf(bin, campaign),
        ownedPaths: unit.ownedPaths,
      },
      unitReport,
    );
    if (!verdict.ok) {
      report.notes.push(`${key} was not confirmed by the forge: ${verdict.problems.join(' ')}`);
      await refuseUnit(
        campaign,
        unit,
        'OUT_OF_SCOPE_MUTATION',
        verdict.problems.join(' '),
        report,
        bin.id,
      );
      continue;
    }
    const accepted = await acceptUnitReport({
      campaign,
      unit,
      report: unitReport,
      files: verdict.files,
      workerId: who.workerId ?? 'unknown-worker',
      sessionId: who.sessionId,
      binId: bin.id,
    });
    if (!accepted.accepted) {
      report.notes.push(`${key} could not be recorded: ${accepted.reason}`);
      continue;
    }
    moved += 1;
  }
  if (moved > 0) {
    await promoteReadyUnits(campaign.id);
    report.ingested.push(`units:${bin.id}`);
    report.notes.push(`${moved} unit(s) confirmed by the forge and integrated.`);
  }
  return moved > 0;
}

/**
 * A completed review bin becomes a review row, its findings, and repair units.
 *
 * Idempotent by the round: a review already recorded for this round is not
 * recorded twice, which is what stops a redelivered tick from inventing a second
 * verdict on one reading.
 */
async function ingestReviewBin(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  bin: Bin,
  report: RemoteTickReport,
): Promise<boolean> {
  const round = (await listReviews(campaign.id)).length + 1;
  const review = await readReviewReport(bin.id);
  if (!review.ok) {
    report.notes.push(`The review bin ${bin.id} completed without a usable review.`);
    return false;
  }
  const already = (await listReviews(campaign.id)).some(
    (row) => row.reviewedSha === review.value.reviewedSha && row.verdict === review.value.verdict,
  );
  if (already) return false;

  /*
   * Is the reviewer independent of the work, and how independent?
   *
   * Refused rather than labelled when it is not: a verdict from a session that
   * wrote the code is the one thing an independent review exists to prevent, so
   * nothing is recorded and the bin's own reasons say why. The tier that *is*
   * recorded is the one the lineage actually supports — this used to be a
   * hard-coded `SESSION_SEPARATED`, which is a claim rather than a reading, and
   * the correction is recorded here rather than quietly applied.
   */
  const reviewer = await binIdentity(bin);
  const lineage = await reviewLineage(campaign.id, reviewer);
  if (!lineage.ok) {
    report.notes.push(lineage.reason ?? 'the reviewer was not independent of the work');
    await recordFactoryEvent({
      campaignId: campaign.id,
      sessionId: reviewer.sessionId,
      workerId: reviewer.workerId,
      kind: FACTORY_EVENT_KINDS.unitRefused,
      evidenceClass: 'MEASURED',
      detail: { stage: 'REVIEW', binId: bin.id, reason: lineage.reason },
    });
    return false;
  }

  const recorded = await recordReview({
    campaignId: campaign.id,
    round,
    scope: 'CAMPAIGN',
    reviewerSessionId: reviewer.sessionId,
    reviewedSha: review.value.reviewedSha,
    verdict: review.value.verdict === 'BLOCKED' ? 'BLOCKED' : review.value.verdict,
    independence: lineage.independence,
    summary: review.value.summary,
    findings: review.value.findings.map((finding) => ({
      key: finding.key,
      severity: finding.severity,
      category: finding.category,
      statement: finding.statement,
      evidence: finding.evidence,
      acceptanceConditionId: finding.acceptanceConditionId,
    })),
  });
  await recordFactoryEvent({
    campaignId: campaign.id,
    sessionId: reviewer.sessionId,
    workerId: reviewer.workerId,
    kind: FACTORY_EVENT_KINDS.reviewCompleted,
    evidenceClass: 'MEASURED',
    detail: {
      round,
      verdict: recorded.review.verdict,
      findings: recorded.findings.length,
      reviewedSha: review.value.reviewedSha,
    },
  });
  await patchCampaign(campaign.id, { reviewRounds: round });

  const repairs = await queueRepairs(campaign, changeRequest);
  for (const queued of repairs.queued) {
    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: FACTORY_EVENT_KINDS.repairQueued,
      evidenceClass: 'DERIVED',
      detail: queued as unknown as Record<string, unknown>,
    });
  }
  if (repairs.queued.length > 0) await promoteReadyUnits(campaign.id);
  report.ingested.push(`review:${bin.id}`);
  report.notes.push(
    `round ${round}: ${recorded.review.verdict}, ${recorded.findings.length} finding(s), ` +
      `${repairs.queued.length} repair(s) queued`,
  );
  return true;
}

/**
 * A unit whose report Brain would not believe.
 *
 * Two things happen and both matter. The unit goes back to READY with the reason
 * recorded — or to FAILED if it has no attempt left, which `reopenUnit` already
 * decides — and it is charged an attempt. The charge is what makes the next round
 * different work rather than the same work: the branch name carries the attempt,
 * so a re-implementation gets a clean branch instead of pushing on top of commits
 * Brain has already refused.
 *
 * Without it a refusal would cost nothing and the loop would offer the identical
 * unit on the identical branch forever, which is a stuck campaign wearing the
 * costume of a busy one.
 */
async function refuseUnit(
  campaign: FactoryCampaign,
  unit: { id: string; unitKey: string; attempt: number },
  category: 'OUT_OF_SCOPE_MUTATION' | 'VERIFICATION_FAILED' | 'WORKER_ERROR' | 'INTEGRATION_CONFLICT',
  detail: string,
  report: RemoteTickReport,
  binId: string,
): Promise<void> {
  const reopened = await reopenUnit(unit.id, category, detail);
  if (reopened) await advanceUnitAttempt(unit.id);
  await recordFactoryEvent({
    campaignId: campaign.id,
    unitId: unit.id,
    kind: FACTORY_EVENT_KINDS.unitFailed,
    evidenceClass: 'MEASURED',
    // The bin is part of the record because it is what makes the refusal
    // idempotent: one bin's report is refused once, however many ticks read it.
    detail: { unitKey: unit.unitKey, category, binId, detail: detail.slice(0, 500) },
  });
  report.notes.push(`${unit.unitKey} goes back for another attempt: ${category}.`);
}

/**
 * Has this bin's report for this unit already been acted on, either way?
 *
 * Read from the ledger, because neither outcome is idempotent by its own effect.
 *
 * A refusal puts the unit back to `READY`, which is exactly the state the next
 * tick offers the same completed bin for again. In production that charged three
 * attempts in one pass and retired the unit `FAILED` before any worker had a
 * second go — and the second and third refusals were for the branch *name*, which
 * the attempt counter had just changed underneath them.
 *
 * **An acceptance is not idempotent by its effect either, and believing it was is
 * the same mistake one move later.** It leaves the unit `IMPLEMENTED`, so the
 * state guard holds while nothing else returns it to `READY` — and a refused
 * integration does precisely that. Then this bin's old report is read again and
 * accepts the unit straight back to the commit the integration just refused, on
 * the next tick, for ever: refuse, re-accept, integrate, refuse. So the question
 * is asked of the bin, which cannot change, rather than of a state two other
 * transitions can write.
 */
async function alreadyActedOn(
  campaignId: string,
  unitId: string,
  binId: string,
): Promise<boolean> {
  const events = await listFactoryEvents(campaignId, {
    kinds: [FACTORY_EVENT_KINDS.unitFailed, FACTORY_EVENT_KINDS.unitImplemented],
    limit: 500,
  });
  return events.some((event) => {
    if (event.unitId !== unitId) return false;
    const detail = (event.detail ?? {}) as { binId?: unknown };
    return detail.binId === binId;
  });
}

/**
 * A completed integration bin moves the campaign's branch, or it moves nothing.
 *
 * The verification is run again here for the same reason the plan is re-validated:
 * the contract judged the bin, and this judges the *rows*. Between the two a
 * branch could have been force-pushed, so the commit Brain records as the
 * campaign's head is one it confirmed at the moment it recorded it.
 *
 * A BLOCKED integration is an outcome rather than an error. The units that were
 * waiting to be integrated go back for another attempt carrying the reason — a
 * conflict, or a command that failed on the merged tree — because the thing that
 * needs to change is the work, not the merge.
 */
async function ingestIntegrateBin(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  bin: Bin,
  report: RemoteTickReport,
): Promise<boolean> {
  const repository = parseRemote(changeRequest.repository);
  if (!repository) {
    report.notes.push(`"${changeRequest.repository}" is not a repository this Brain can read.`);
    return false;
  }
  const parsed = await readIntegrationReport(bin.id);
  if (!parsed.ok) {
    report.notes.push(`The integration bin ${bin.id} completed without a usable report.`);
    return false;
  }
  const who = await binIdentity(bin);
  const units = await listUnits(campaign.id);
  const implemented = units.filter((unit) => unit.state === 'IMPLEMENTED' && unit.headSha !== null);
  /*
   * Already ingested, asked two ways, and the second one is not redundant.
   *
   * A confirmed integration moves its units to INTEGRATED, so `implemented` is
   * empty on the next pass and the bin is skipped by its own effect. A *surface*
   * blocker deliberately changes nothing — that is the point of it — so by that
   * test the same completed bin is ingested again on every tick, recording a fresh
   * refusal each time: the ledger fills with rejections nothing new happened to
   * produce, and the ceiling counted from them trips immediately. So the question
   * is also asked of the bin, which cannot change. Same correction as the unit
   * ingest, at the stage above it.
   */
  if (implemented.length === 0) return false;
  if (await integrationAlreadyIngested(campaign.id, bin.id)) return false;

  if (parsed.value.outcome === 'BLOCKED') {
    const failed = parsed.value.commands.filter((command) => command.exitCode !== 0);
    const why =
      parsed.value.blockedReason ??
      (failed.length > 0
        ? `\`${failed[0]?.command}\` exited ${failed[0]?.exitCode} on the merged tree.`
        : 'The integration was reported blocked.');
    /*
     * Which of the two things went wrong, derived from the rows rather than read
     * out of the sentence about it.
     *
     * A conflict, or a command that exited non-zero on the merged tree, is a fact
     * about the *work*: the branches disagree, or the contract rejects the tree
     * they make, and the thing that has to change is the code. Sending the units
     * back is right, and costing them an attempt is right.
     *
     * A blocker with neither is a fact about the *surface*. The integrator never
     * got as far as judging anything — no credential for the remote, a host that
     * refused it, a checkout it could not make — so nothing examined the work and
     * there is nothing for the work to answer. Refusing the units there charges
     * two forge-confirmed commits for a condition that was never about them,
     * which is §23's correction one altitude down: a refusal is not misconduct.
     * The units stay IMPLEMENTED, the stage becomes available again, and a
     * surface that *can* push may take it.
     *
     * Derived, never declared: a worker saying "this is a surface problem" would
     * be model prose deciding state, and a worker that wanted to avoid the cost
     * of a failed verification could say it. The conflict list and the exit codes
     * are things it reported about what it ran, and Brain reads them.
     */
    const aboutTheWork = parsed.value.conflicts.length > 0 || failed.length > 0;
    if (aboutTheWork) {
      for (const unit of implemented) {
        if (await alreadyActedOn(campaign.id, unit.id, bin.id)) continue;
        await refuseUnit(
          campaign,
          unit,
          parsed.value.conflicts.length > 0 ? 'INTEGRATION_CONFLICT' : 'VERIFICATION_FAILED',
          why,
          report,
          bin.id,
        );
      }
    }
    await recordFactoryEvent({
      campaignId: campaign.id,
      sessionId: who.sessionId,
      workerId: who.workerId,
      kind: FACTORY_EVENT_KINDS.integrationRejected,
      evidenceClass: 'MEASURED',
      detail: {
        reason: why.slice(0, 500),
        // The discriminator, on the row, so the ceiling below counts the same
        // fact this ingest decided on rather than re-deriving it from prose.
        surface: !aboutTheWork,
        binId: bin.id,
        conflicts: parsed.value.conflicts,
        failedCommands: failed.map((command) => command.command),
        units: implemented.map((unit) => unit.unitKey),
      },
    });
    report.ingested.push(`integrate:${bin.id}`);
    report.notes.push(
      aboutTheWork
        ? `the integration did not land: ${why}`
        : `the integration did not land and the work was never judged: ${why} ` +
            'The units keep their commits and the stage is offered again.',
    );
    return true;
  }

  const base = binBaseOf(bin, campaign);
  const verdict = await verifyIntegrationReport(
    repository,
    {
      integrationBranch: campaign.integrationBranch,
      baseSha: base,
      units: implemented.map((unit) => ({
        unitKey: unit.unitKey,
        headSha: unit.headSha as string,
        ownedPaths: unit.ownedPaths,
      })),
    },
    parsed.value,
  );
  if (!verdict.ok) {
    report.notes.push(`the integration was not confirmed by the forge: ${verdict.problems.join(' ')}`);
    return false;
  }

  const accepted = await acceptIntegration({
    campaign,
    units: implemented,
    report: parsed.value,
    verdict,
    baseSha: base,
    workerId: who.workerId ?? 'unknown-worker',
    sessionId: who.sessionId,
    binId: bin.id,
  });
  if (accepted.integrated.length === 0) {
    report.notes.push('the integration was confirmed but no unit moved; nothing recorded.');
    return false;
  }

  /*
   * And what the repository's own continuous integration says about the commit.
   *
   * Recorded rather than judged. A worker reported the exit codes it saw and that
   * is kept; this is the same question answered by something that did not take
   * part, which is the strongest form of it available without a checkout. Its
   * absence is recorded as absence — `UNKNOWN` — because a project with no CI has
   * not told Brain that anything passed.
   */
  const checks = await integrationChecks(repository, parsed.value.headSha);
  await recordFactoryEvent({
    campaignId: campaign.id,
    kind: FACTORY_EVENT_KINDS.verificationRan,
    evidenceClass: checks === null || checks.none ? 'UNKNOWN' : 'MEASURED',
    detail: {
      sha: parsed.value.headSha,
      source: 'forge-checks',
      present: checks !== null && !checks.none,
      pending: checks?.pending ?? false,
      failed: (checks?.failed ?? []).map((check) => check.name),
      workerReported: parsed.value.commands,
    },
  });

  await promoteReadyUnits(campaign.id);
  report.ingested.push(`integrate:${bin.id}`);
  report.notes.push(
    `${accepted.integrated.length} unit(s) integrated at ${parsed.value.headSha.slice(0, 12)}` +
      (checks && checks.failed.length > 0
        ? `; the repository's own checks report ${checks.failed.length} failure(s)`
        : ''),
  );
  return true;
}

/**
 * A completed delivery bin becomes the campaign's pull request pointer.
 *
 * Read back from the forge before anything is written, so `prRef` and `prUrl`
 * name a request that exists and points at the commit this campaign integrated.
 * Idempotent because the pointer is the evidence: a campaign that already names
 * this request at this head has nothing to record.
 */
async function ingestDeliverBin(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  bin: Bin,
  report: RemoteTickReport,
): Promise<boolean> {
  const repository = parseRemote(changeRequest.repository);
  if (!repository) return false;
  const parsed = await readDeliveryReport(bin.id);
  if (!parsed.ok) {
    report.notes.push(`The delivery bin ${bin.id} completed without a usable report.`);
    return false;
  }
  if (parsed.value.outcome === 'BLOCKED') {
    report.notes.push(`the pull request was not delivered: ${parsed.value.blockedReason}`);
    return false;
  }
  const head = campaign.integrationSha ?? campaign.baseSha;
  const verdict = await verifyDelivery(
    repository,
    { headSha: head, baseBranch: changeRequest.baseBranch, pullRequest: pullRequestNumber(campaign) },
    parsed.value,
  );
  if (!verdict.ok) {
    report.notes.push(`the pull request was not confirmed: ${verdict.problems.join(' ')}`);
    return false;
  }
  if (pullRequestNumber(campaign) === verdict.number && campaign.prUrl === verdict.url) {
    return false;
  }
  await patchCampaign(campaign.id, {
    prRef: verdict.number === null ? null : `#${verdict.number}`,
    prUrl: verdict.url,
  });
  const deliverer = await binIdentity(bin);
  await recordFactoryEvent({
    campaignId: campaign.id,
    sessionId: deliverer.sessionId,
    workerId: deliverer.workerId,
    kind: FACTORY_EVENT_KINDS.prDelivered,
    evidenceClass: 'MEASURED',
    detail: {
      pullRequest: verdict.number,
      action: parsed.value.action,
      headSha: verdict.headSha,
      verifiedBy: 'forge',
    },
  });
  report.ingested.push(`deliver:${bin.id}`);
  report.notes.push(`pull request #${verdict.number} carries ${head.slice(0, 12)}`);
  return true;
}

/**
 * How many times one stage may be handed out before it is a person's problem.
 *
 * Not a retry count on a bin — a bin has its own `maxAttempts` and the dispatcher
 * already respects it. This is the count of *bins*, which is what the loop would
 * otherwise create without limit: `liveBinOfKind` deliberately ignores a FAILED
 * bin, so a stage that fails its way to exhaustion would be handed out again on
 * the very next tick, forever, and a campaign spinning is harder to notice than
 * one that stopped.
 */
const MAX_BINS_PER_STAGE = 3;

/**
 * Whether a stage has stopped being worth handing out again, and why.
 *
 * Two different facts with two different remedies, which is why they are not one
 * message. A bin at `NEEDS_HUMAN` has its own guarded way out and is waiting for
 * somebody — so the campaign names the bin rather than creating a second one
 * beside it. A stage that has burned through `MAX_BINS_PER_STAGE` is a stage the
 * fleet cannot do as specified, and the remedy is a person's: amend the contract,
 * or stop.
 *
 * Neither is terminal. The campaign is BLOCKED and re-examined on the next tick,
 * so cancelling the stuck bins or amending the contract starts it moving again
 * without anybody reaching into a row.
 */
function stalledStage(bins: Bin[], kind: string): { detail: string } | null {
  const mine = bins.filter((bin) => bin.kind === kind);
  const waiting = mine.find((bin) => bin.state === 'NEEDS_HUMAN');
  if (waiting) {
    return {
      detail:
        `Bin ${waiting.id} (${kind}) is waiting for a person. It has its own answer; until it ` +
        'is given one this stage is not handed out again, because a second bin beside it would ' +
        'duplicate the work rather than unblock it.',
    };
  }
  const failed = mine.filter((bin) => bin.state === 'FAILED').length;
  if (failed >= MAX_BINS_PER_STAGE) {
    return {
      detail:
        `${failed} ${kind} bins have failed on this campaign. The fleet cannot do this stage as ` +
        'specified, so it is not handed out a fourth time. Amending the contract — which may ' +
        'narrow a scope or add a verification command, and may never change what success is — ' +
        'or stopping the campaign are the ways out.',
    };
  }
  return null;
}

/** Has this integration bin's report already become rows, either way? */
async function integrationAlreadyIngested(campaignId: string, binId: string): Promise<boolean> {
  const events = await listFactoryEvents(campaignId, {
    kinds: [FACTORY_EVENT_KINDS.integrationRejected, FACTORY_EVENT_KINDS.integrationMerged],
    limit: 200,
  });
  return events.some((event) => {
    const detail = (event.detail ?? {}) as { binId?: unknown };
    return detail.binId === binId;
  });
}

/**
 * How long to leave a stage alone after a surface blocked it, and how many of
 * those are too many.
 *
 * The cool-off is the load-bearing half, and the first version of this had only
 * the ceiling — which was wrong in a way worth recording rather than quietly
 * fixing. **Brain cannot tell which surface will arrive**, because the MCP
 * credential is per-connector rather than per-session, so a stage that only some
 * surfaces can perform is offered to whichever one turns up. On a fleet where the
 * surface Brain can *fire* cannot push and the ones that can push arrive on their
 * own schedule, a hard ceiling counted in surface blocks is reached by the wrong
 * surface in minutes — and then the stage is blocked before the right surface has
 * had a single turn. That is not a ceiling, it is a livelock with a tidy blocker
 * row on it.
 *
 * So a surface block *defers* the stage rather than stopping it: the waste is
 * bounded to one fire per cool-off instead of one per tick, and the stage is still
 * there when a surface that can push asks. A ceiling remains, far above anything
 * ordinary, because a campaign that has been refused this many times really is
 * something a person must fix — and it has `FACTORY_STAGE_REAUTHORIZED` as its
 * answer.
 */
const SURFACE_BLOCK_COOLOFF_MS = 5 * 60_000;
const SURFACE_BLOCK_CEILING = 20;

/**
 * The surface-blocked integrations since the last re-authorization, and when the
 * newest of them was.
 *
 * Read from the ledger, on the discriminator the ingest wrote. A work-related
 * block refuses the units and spends their attempts, so it bounds itself; a
 * surface block deliberately spends nothing, so the bound has to be here.
 */
async function surfaceBlockedIntegrations(
  campaignId: string,
): Promise<{ count: number; newestAt: string | null }> {
  const events = await listFactoryEvents(campaignId, {
    kinds: [FACTORY_EVENT_KINDS.integrationRejected, FACTORY_EVENT_KINDS.stageReauthorized],
    limit: 200,
  });
  /*
   * Counted from the newest re-authorization, not from the beginning of the
   * campaign.
   *
   * Without that, the ceiling is a permanent stop: the count never falls, so
   * granting the repository to a worker surface — the remedy the blocker itself
   * names — could not start the campaign again, and a person would have fixed the
   * thing and watched nothing happen. §24's sentence for the fifth time, and the
   * same answer: the escalation gets a guarded transition rather than none.
   */
  /*
   * In the order the ledger returns them, which is `at, rowid` ascending — not
   * re-sorted here by `at` alone. Two rows written in the same millisecond are a
   * tie that a timestamp cannot break, and a re-authorization that sorted before
   * the refusals it answers would count for nothing. The row order is the one
   * monotonic fact available, so it is the one used.
   */
  const bins = new Set<string>();
  let newestAt: string | null = null;
  for (const event of events) {
    if (event.kind === FACTORY_EVENT_KINDS.stageReauthorized) {
      bins.clear();
      newestAt = null;
      continue;
    }
    const detail = (event.detail ?? {}) as { surface?: unknown; binId?: unknown };
    if (detail.surface !== true) continue;
    bins.add(typeof detail.binId === 'string' ? detail.binId : event.id);
    newestAt = event.at;
  }
  return { count: bins.size, newestAt };
}

/**
 * Stop, with a reason somebody can act on, rather than handing a stage out again.
 *
 * The kind is a parameter because the two reasons a stage stops have different
 * remedies and a blocker row naming the wrong one is the row somebody will
 * believe later: a stage the fleet cannot do *as specified* is the contract's
 * problem, and a stage no surface can perform is an access problem wherever the
 * workers run.
 */
async function blockStage(
  campaign: FactoryCampaign,
  stage: string,
  stall: { detail: string },
  report: RemoteTickReport,
  kind: FactoryBlockerKind = 'UNIT_EXHAUSTED_ATTEMPTS',
): Promise<RemoteTickReport> {
  await patchCampaign(campaign.id, {
    state: 'BLOCKED',
    blockerKind: kind,
    blockerDetail: stall.detail,
    stageDetail: `${stage} cannot be handed out again`,
  });
  report.notes.push(stall.detail);
  report.state = 'BLOCKED';
  report.stage = `${stage} cannot be handed out again`;
  return report;
}

/* ------------------------------------------------------------------------- */
/* One tick                                                                   */
/* ------------------------------------------------------------------------- */

async function runRemoteTick(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
): Promise<RemoteTickReport> {
  const report: RemoteTickReport = {
    campaignId: campaign.id,
    projectId: campaign.projectId,
    state: campaign.state,
    stage: campaign.stageDetail ?? campaign.state,
    notes: [],
    created: [],
    ingested: [],
    progress: false,
    tickHeld: false,
  };

  /*
   * Whatever was blocking is no longer blocking, whenever a stage is actually
   * handed out again.
   *
   * Spread into the same patch that moves the state rather than cleared in a
   * second write: a blocker left behind beside a working stage is a campaign that
   * reads stuck while it runs, and a person who learns to ignore that line stops
   * reading the one that matters.
   */
  const cleared = { blockerKind: null, blockerDetail: null } as const;

  const bins = await campaignBins(campaign.id);

  // 1. Read anything a worker finished. Before creating work, so a decision about
  //    what to do next is taken against what the campaign now knows.
  for (const bin of bins) {
    if (bin.state !== 'COMPLETE') continue;
    if (bin.kind === 'FACTORY_PLAN') {
      if (await ingestPlanBin(campaign, changeRequest, bin, report)) report.progress = true;
    } else if (bin.kind === 'FACTORY_UNITS') {
      if (await ingestUnitsBin(campaign, changeRequest, bin, report)) report.progress = true;
    } else if (bin.kind === 'FACTORY_INTEGRATE') {
      if (await ingestIntegrateBin(campaign, changeRequest, bin, report)) report.progress = true;
    } else if (bin.kind === 'FACTORY_REVIEW') {
      if (await ingestReviewBin(campaign, changeRequest, bin, report)) report.progress = true;
    } else if (bin.kind === 'FACTORY_DELIVER') {
      if (await ingestDeliverBin(campaign, changeRequest, bin, report)) report.progress = true;
    }
  }

  /*
   * Close out the findings whose repair has landed, before anything decides what
   * the campaign now needs.
   *
   * `reconcileRepairs` had exactly one caller — the in-process orchestrator in
   * `loop.ts` — and the hosted plane is the other runner. **A rule applied by one
   * of two runners is worse than none**, because the two then disagree about the
   * same campaign, and §24 has recorded this exact shape before:
   * `reconcileAcceptedFragment` moved a requirement's coverage and was called only
   * by the orchestrator, so production showed `MISSING` on a packet that was
   * COMPLETE.
   *
   * Here it showed as a pull request. The repair integrated, its commit became the
   * request's head, the repository's own checks passed on it — and the body a
   * person reads still listed the finding under *remaining limitations*, because
   * nothing on this plane had ever moved it to `REPAIRED`. The evidence was right
   * and the sentence about it was wrong, which is the failure mode this file cares
   * about most.
   *
   * It changes no evidence: a finding becomes `REPAIRED` because its unit reached
   * `INTEGRATED` — the diff was inside its ownership and the contract's commands
   * passed on the merged tree — and never because a worker said so.
   */
  await reconcileRepairs(campaign.id);

  const fresh = (await getCampaign(campaign.id)) ?? campaign;
  const units = await listUnits(fresh.id);
  const liveBins = await campaignBins(fresh.id);

  // 2. Make the next thing available, at most one bin per stage.
  if (units.length === 0) {
    if (liveBinOfKind(liveBins, 'FACTORY_PLAN')) {
      report.notes.push('waiting for a worker to take the plan');
      return report;
    }
    const stall = stalledStage(liveBins, 'FACTORY_PLAN');
    if (stall) return await blockStage(fresh, 'planning', stall, report);
    const bin = await createPlanBin(fresh, changeRequest);
    report.created.push(`plan:${bin.id}`);
    await noteBin(fresh, bin, 'the objective has no units yet');
    await patchCampaign(fresh.id, {
      state: 'PLANNING',
      stageDetail: 'waiting for a plan',
      ...cleared,
    });
    report.progress = true;
    return report;
  }

  const ready = units.filter((unit) => unit.state === 'READY');
  const implemented = units.filter(
    (unit) => unit.state === 'IMPLEMENTED' && unit.branch !== null && unit.headSha !== null,
  );
  const outstanding = units.filter(
    (unit) =>
      unit.state !== 'INTEGRATED' &&
      unit.state !== 'CANCELLED' &&
      unit.state !== 'FAILED' &&
      unit.state !== 'IMPLEMENTED',
  );

  if (ready.length > 0) {
    if (liveBinOfKind(liveBins, 'FACTORY_UNITS')) {
      report.notes.push(`waiting for a worker on ${ready.length} ready unit(s)`);
      return report;
    }
    const stall = stalledStage(liveBins, 'FACTORY_UNITS');
    if (stall) return await blockStage(fresh, 'implementation', stall, report);
    const bin = await createUnitsBin(fresh, changeRequest, ready);
    if (bin) {
      report.created.push(`units:${bin.id}`);
      await noteBin(fresh, bin, `${ready.length} unit(s) ready`);
      await patchCampaign(fresh.id, {
        state: 'EXECUTING',
        stageDetail: `${ready.length} unit(s) with the fleet`,
        ...cleared,
      });
      report.progress = true;
    }
    return report;
  }

  /*
   * 2b. Implemented work waits for an integration, and that is its own stage.
   *
   * A unit confirmed on its own branch is not yet part of the campaign: §25's
   * rule is that a dependency is satisfied by integration rather than by
   * implementation, so nothing downstream may start until these branches have
   * been brought together on one tree and the contract's commands have passed on
   * it. It is also a separate lease, so on a fleet with more than one surface
   * that can push it is a separate session — which is a property of the fleet
   * rather than a guarantee of this stage, and is never reported as one. What the
   * stage does guarantee is that only it moves the campaign's branch.
   */
  if (implemented.length > 0) {
    if (liveBinOfKind(liveBins, 'FACTORY_INTEGRATE')) {
      report.notes.push(`waiting for an integrator on ${implemented.length} unit(s)`);
      return report;
    }
    const stall = stalledStage(liveBins, 'FACTORY_INTEGRATE');
    if (stall) return await blockStage(fresh, 'integration', stall, report);
    const surface = await surfaceBlockedIntegrations(fresh.id);
    if (surface.count >= SURFACE_BLOCK_CEILING) {
      return await blockStage(
        fresh,
        'integration',
        {
          detail:
            `${surface.count} integrations were blocked before the work was judged — every surface ` +
            'that took this stage could not push to the remote. The units keep their commits and ' +
            'nothing about the work is in question. The remedy is where the workers run: attach ' +
            'the repository to a worker surface. Brain holds no repository credential and must ' +
            'not. Then say so, and the stage is handed out again.',
        },
        report,
        'EXTERNAL_CREDENTIAL_REQUIRED',
      );
    }
    if (surface.newestAt !== null) {
      const since = Date.now() - Date.parse(surface.newestAt);
      if (Number.isFinite(since) && since < SURFACE_BLOCK_COOLOFF_MS) {
        const wait = Math.ceil((SURFACE_BLOCK_COOLOFF_MS - since) / 1000);
        const detail =
          `${surface.count} integration(s) blocked before the work was judged; waiting ${wait}s ` +
          'for a surface that can push';
        report.notes.push(detail);
        // `cleared` for the same reason every other live-stage patch carries it: a
        // blocker left behind beside a stage that is working reads stuck while it
        // runs, and a person who learns to ignore that line stops reading the one
        // that matters.
        await patchCampaign(fresh.id, {
          state: 'INTEGRATING',
          stageDetail: detail,
          ...cleared,
        });
        return report;
      }
    }
    /*
     * And whether anybody moved the branch Brain is about to move.
     *
     * Read before the bin is created, recorded whatever it says, and never a
     * refusal — see `integrationBranchDrift`. A prohibition in a manifest is not a
     * control, so the control is that Brain knows, says so on the campaign's own
     * ledger, and tells the integrator.
     */
    const forge = parseRemote(changeRequest.repository);
    const drift = forge ? await integrationBranchDrift(forge, fresh) : null;
    if (drift) {
      await recordFactoryEvent({
        campaignId: fresh.id,
        kind: FACTORY_EVENT_KINDS.staleBase,
        evidenceClass: 'MEASURED',
        detail: {
          branch: fresh.integrationBranch,
          brainLeftItAt: drift.expected,
          forgeSaysItIsAt: drift.actual,
          note:
            'Something other than an integration moved the campaign branch. The integration ' +
            'still judges the whole range from the base Brain recorded, and delivery still ' +
            'refuses a pull request whose head is not the commit Brain integrated.',
        },
      });
      report.notes.push(
        `${fresh.integrationBranch} is at ${drift.actual.slice(0, 12)} and Brain left it at ` +
          `${drift.expected.slice(0, 12)}; recorded, and the integrator is told`,
      );
    }
    const bin = await createIntegrateBin(fresh, changeRequest, implemented, drift);
    if (bin) {
      report.created.push(`integrate:${bin.id}`);
      await noteBin(fresh, bin, `${implemented.length} implemented unit(s) to integrate`);
      await patchCampaign(fresh.id, {
        state: 'INTEGRATING',
        stageDetail: `${implemented.length} unit(s) to bring together on ${roundBaseFor(fresh).slice(0, 12)}`,
        ...cleared,
      });
      report.progress = true;
    }
    return report;
  }

  if (outstanding.length > 0) {
    report.notes.push(`${outstanding.length} unit(s) still in flight`);
    await patchCampaign(fresh.id, { state: 'EXECUTING', stageDetail: 'units in flight' });
    return report;
  }

  /*
   * A unit that has used every attempt stops the campaign, and it has to be
   * looked at *before* the review.
   *
   * `outstanding` excludes FAILED, correctly — nothing is going to happen to it —
   * and the effect of that alone was a campaign whose only unit had retired
   * walking straight into the review stage with nothing integrated, asking a
   * reviewer to judge the base commit against a contract nothing had implemented.
   * A verdict on that would have been a verdict about the wrong tree.
   *
   * It is BLOCKED with the unit's own recorded reason rather than failed: the
   * work is intact, every attempt kept its row, and the ways out are a person's —
   * amend the contract, which may narrow a scope or add a verification command
   * and may never change what success is, or stop. Re-examined every tick, so
   * either one starts it moving without anybody reaching into a row.
   */
  const failed = units.filter((unit) => unit.state === 'FAILED');
  if (failed.length > 0) {
    await patchCampaign(fresh.id, {
      state: 'BLOCKED',
      blockerKind: 'UNIT_EXHAUSTED_ATTEMPTS',
      blockerDetail: failed
        .map(
          (unit) =>
            `${unit.unitKey} used all ${unit.maxAttempts} attempts` +
            `${unit.failureCategory ? ` (${unit.failureCategory})` : ''}: ` +
            `${unit.failureDetail ?? 'no reason was recorded'}`,
        )
        .join(' — '),
      stageDetail: `${failed.length} unit(s) out of attempts`,
    });
    report.notes.push(`${failed.length} unit(s) out of attempts; the campaign is blocked`);
    report.state = 'BLOCKED';
    report.stage = `${failed.length} unit(s) out of attempts`;
    return report;
  }

  // 3. Everything landed. Review, unless a passing review already stands.
  const reviews = await listReviews(fresh.id);
  const latest = reviews[reviews.length - 1];
  const gating = await gatingFindings(fresh.id);

  if (!latest || gating.length > 0 || latest.verdict !== 'PASS') {
    // A review is wanted when there is none, or when the last one asked for
    // changes that have since been repaired and nobody has looked again.
    const reviewedSha = fresh.integrationSha ?? fresh.baseSha;
    const alreadyReviewed = reviews.some((row) => row.reviewedSha === reviewedSha);
    if (gating.length > 0) {
      report.notes.push(`${gating.length} gating finding(s) still open`);
      await patchCampaign(fresh.id, {
        state: 'REPAIRING',
        stageDetail: 'repairing review findings',
      });
      return report;
    }
    if (alreadyReviewed && latest?.verdict === 'PASS') {
      report.notes.push('the current commit already passed review');
    } else if (liveBinOfKind(liveBins, 'FACTORY_REVIEW')) {
      report.notes.push('waiting for a reviewer');
      return report;
    } else if (stalledStage(liveBins, 'FACTORY_REVIEW')) {
      const stall = stalledStage(liveBins, 'FACTORY_REVIEW');
      if (stall) return await blockStage(fresh, 'review', stall, report);
    } else if (!alreadyReviewed || latest?.verdict !== 'PASS') {
      const bin = await createReviewBin(fresh, changeRequest, reviewedSha, reviews.length + 1);
      report.created.push(`review:${bin.id}`);
      await noteBin(fresh, bin, `round ${reviews.length + 1} against ${reviewedSha.slice(0, 12)}`);
      await patchCampaign(fresh.id, {
        state: 'REVIEWING',
        stageDetail: 'independent review against the contract',
        ...cleared,
      });
      report.progress = true;
      return report;
    }
  }

  /*
   * 4. A passing review with nothing gating is work a person has to be able to
   *    read, and that is one more bin rather than a finished campaign.
   *
   * Brain composes the artifact from rows and a worker performs the one action
   * Brain cannot: the credential that may write to the repository lives where the
   * worker runs. "Exactly once" is a property of this branch — a delivery bin is
   * created per integrated commit and only when no bin already exists for it, so
   * a redelivered tick finds the bin rather than opening a second request.
   */
  if (latest?.verdict === 'PASS' && gating.length === 0) {
    const head = fresh.integrationSha ?? fresh.baseSha;
    const deliveries = liveBins.filter(
      (bin) => bin.kind === 'FACTORY_DELIVER' && binBaseOf(bin, fresh) === head,
    );
    const usable = deliveries.filter((bin) => bin.state !== 'FAILED' && bin.state !== 'CANCELLED');
    const stuck = usable.find((bin) => bin.state === 'NEEDS_HUMAN');
    if (stuck) {
      // An answering transition rather than a silent wait: the bin has its own
      // guarded way out, and the campaign says which bin and why.
      await patchCampaign(fresh.id, {
        state: 'BLOCKED',
        blockerKind: 'EXTERNAL_CREDENTIAL_REQUIRED',
        blockerDetail:
          `The pull request could not be opened or updated by the worker that took bin ` +
          `${stuck.id}. A worker may only push and open a request where it has been granted ` +
          'that itself; Brain holds no credential for this repository and cannot do it instead.',
        stageDetail: 'the pull request needs a worker that may open one',
      });
      report.notes.push(`delivery needs a person: bin ${stuck.id}`);
      return report;
    }
    const stall = stalledStage(liveBins, 'FACTORY_DELIVER');
    if (stall && usable.length === 0) return await blockStage(fresh, 'delivery', stall, report);
    if (usable.length === 0) {
      const deliverable = await pullRequestFor(fresh.id);
      if (!deliverable) {
        report.notes.push('the pull request body could not be composed from this campaign.');
        return report;
      }
      const bin = await createDeliverBin(fresh, changeRequest, deliverable);
      report.created.push(`deliver:${bin.id}`);
      await noteBin(fresh, bin, `the reviewed commit ${head.slice(0, 12)} is ready to read`);
      await recordFactoryEvent({
        campaignId: fresh.id,
        kind: FACTORY_EVENT_KINDS.prAssembled,
        evidenceClass: 'DERIVED',
        detail: {
          headSha: head,
          pullRequest: pullRequestNumber(fresh),
          bodyChars: deliverable.body.length,
        },
      });
      await patchCampaign(fresh.id, {
        state: 'ASSEMBLING',
        stageDetail: 'putting the work in front of a person as a pull request',
        ...cleared,
      });
      report.progress = true;
      return report;
    }
    if (fresh.prUrl === null) {
      /*
       * A delivery bin that *finished* and still left no pull request Brain can
       * confirm is not patience, it is stuck — and stuck has to say so.
       *
       * The contract verifies the request before it lets the bin complete, so a
       * completed bin means the request was right at that moment and is not right
       * now: something moved its head, retargeted it or closed it. That is a
       * person's to look at, and the block clears by itself — ingestion runs at
       * the top of every tick, so the next pass after the request is sound again
       * records it and the campaign carries on.
       */
      const finished = usable.filter((bin) => bin.state === 'COMPLETE');
      if (finished.length > 0) {
        await patchCampaign(fresh.id, {
          state: 'BLOCKED',
          blockerKind: 'EXTERNAL_CREDENTIAL_REQUIRED',
          blockerDetail:
            `Bin ${finished[0]?.id} delivered a pull request that Brain can no longer confirm ` +
            `points at ${head.slice(0, 12)}. Its head may have been moved, its base retargeted ` +
            'or the request closed. Brain will record it again by itself once it is sound; ' +
            'nothing here needs repeating.',
          stageDetail: 'the pull request no longer matches the work',
        });
        report.notes.push(`the delivered pull request no longer matches ${head.slice(0, 12)}`);
        return report;
      }
      report.notes.push('waiting for the pull request to be opened or updated');
      await patchCampaign(fresh.id, {
        state: 'ASSEMBLING',
        stageDetail: 'waiting for the pull request',
      });
      return report;
    }
  }

  // 5. Reviewed, integrated and readable. That is a finished campaign.
  if (latest?.verdict === 'PASS' && gating.length === 0 && fresh.prUrl !== null) {
    if (fresh.state !== 'COMPLETE') {
      await patchCampaign(fresh.id, {
        state: 'COMPLETE',
        stageDetail: 'reviewed and confirmed by the forge',
        finishedAt: new Date().toISOString(),
      });
      await recordFactoryEvent({
        campaignId: fresh.id,
        kind: FACTORY_EVENT_KINDS.campaignState,
        evidenceClass: 'DERIVED',
        detail: { from: fresh.state, to: 'COMPLETE', stageDetail: 'reviewed and confirmed' },
      });
      report.progress = true;
    }
    const written = await recordCampaignOutcome(fresh.id);
    if (written.recorded) {
      await recordFactoryEvent({
        campaignId: fresh.id,
        kind: FACTORY_EVENT_KINDS.writeback,
        evidenceClass: 'MEASURED',
        detail: { eventId: written.event?.id ?? null },
      });
      report.notes.push('writeback recorded');
    }
    report.state = 'COMPLETE';
    report.stage = 'reviewed and confirmed by the forge';
  }
  return report;
}

async function noteBin(campaign: FactoryCampaign, bin: Bin, why: string): Promise<void> {
  await recordFactoryEvent({
    campaignId: campaign.id,
    kind: FACTORY_EVENT_KINDS.binCreated,
    evidenceClass: 'MEASURED',
    detail: {
      binId: bin.id,
      kind: bin.kind,
      contract: bin.completionContract,
      units: bin.manifest.units.length,
      why,
    },
  });
}

/**
 * One campaign, under its own tick claim.
 *
 * The claim is the same compare-and-swap `loop.ts` takes, for the same reason:
 * two dispatchers both deciding a stage is next would create two bins for it, and
 * the loser is refused rather than retried.
 */
export async function tickRemoteCampaign(campaignId: string): Promise<RemoteTickReport> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return empty(campaignId, '', 'UNKNOWN', 'unknown', 'no such campaign');
  if (campaign.executionMode !== 'REMOTE') {
    return empty(campaignId, campaign.projectId, campaign.state, campaign.state, 'not a remote campaign');
  }
  const changeRequest = await getChangeRequest(campaign.changeRequestId);
  if (!changeRequest) {
    return empty(
      campaignId,
      campaign.projectId,
      campaign.state,
      campaign.state,
      'the campaign has no change request',
    );
  }
  if (changeRequest.state !== 'APPROVED') {
    return empty(
      campaignId,
      campaign.projectId,
      campaign.state,
      campaign.state,
      'the objective is not approved, so nothing may be created for it',
    );
  }
  if (campaign.state === 'CANCELLED') {
    return empty(campaignId, campaign.projectId, campaign.state, campaign.state, 'cancelled');
  }

  const owner = `factory-remote-${process.pid}`;
  const claim = await claimCampaignTick(campaignId, owner);
  if (!claim.ok) {
    const held = empty(campaignId, campaign.projectId, campaign.state, campaign.state, claim.reason);
    held.tickHeld = true;
    return held;
  }
  const keep = setInterval(() => {
    void extendCampaignTick(campaignId, owner, claim.generation);
  }, TICK_HEARTBEAT_MS);
  try {
    const report = await runRemoteTick(campaign, changeRequest);
    /*
     * What the report says the campaign is, read back from the row rather than
     * carried from the start of the tick.
     *
     * `report.state` was set once from the campaign as it was *before* the pass and
     * updated again only on the paths that block — so every pass that made progress
     * described the campaign it had just changed using the state it had before the
     * change. A tick that creates an integration bin and reports BLOCKED because
     * that is what the row said a second ago is an operator surface lying about the
     * thing it just did. One re-read, at the one place every path returns through.
     */
    const after = await getCampaign(campaignId);
    if (after) {
      report.state = after.state;
      report.stage = after.stageDetail ?? after.state;
    }
    return report;
  } finally {
    clearInterval(keep);
    await releaseCampaignTick(campaignId, owner, claim.generation);
  }
}

/** Every live remote campaign, one tick each. What a scheduled dispatcher calls. */
export async function tickAllRemoteCampaigns(): Promise<RemoteTickReport[]> {
  const reports: RemoteTickReport[] = [];
  for (const campaign of await listLiveCampaigns()) {
    if (campaign.executionMode !== 'REMOTE') continue;
    try {
      reports.push(await tickRemoteCampaign(campaign.id));
    } catch (error: unknown) {
      reports.push(
        empty(
          campaign.id,
          campaign.projectId,
          campaign.state,
          campaign.state,
          `the tick threw: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  return reports;
}

/* ------------------------------------------------------------------------- */
/* The loop                                                                   */
/* ------------------------------------------------------------------------- */

const DEFAULT_INTERVAL_MS = 20_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Start ticking, beside the dispatcher.
 *
 * Twenty seconds because the cost of a tick with nothing to do is two small
 * queries, and the benefit of a short one is that a stage becomes available while
 * the worker that will take it is *still in its activation* — which is what makes
 * a whole campaign finish inside one hourly firing instead of one stage per hour.
 */
export function startFactoryRemoteLoop(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void tickAllRemoteCampaigns()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
}

export function stopFactoryRemoteLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
