/**
 * The tick that moves a campaign.
 *
 * One function, `tickCampaign`, and everything it does is idempotent, guarded and
 * resumable. That is not a style preference: this is the thing that runs
 * unattended, and the three ways an unattended loop goes wrong are doing an
 * effect twice, advancing on a judgement that did not happen, and parking in a
 * state nothing can answer. So:
 *
 *   * **The tick is claimed.** A compare-and-swap on the campaign's generation,
 *     so two dispatchers cannot both advance one campaign. The loser is refused
 *     rather than retried.
 *   * **Every stage is re-derived from rows.** A tick that crashed halfway leaves
 *     state the next tick reads correctly, because no stage depends on anything
 *     held in memory between ticks. Restart recovery is therefore the ordinary
 *     path rather than a special one.
 *   * **Every escalation has an answering transition.** BLOCKED names an
 *     operational fact from a closed vocabulary and says what would resolve it;
 *     AWAITING_RELEASE has a guarded answer a person can give. A state that says
 *     "waiting for a person" which that person cannot resolve is not waiting, it
 *     is stuck — §24's sentence, which this file is the place that has to honour
 *     it.
 *
 * What the loop will not do is decide that work succeeded. Implementation is
 * decided by the integrator from the repository; the objective is decided by an
 * independent review against the change request; and release is decided by a
 * person. The loop only ever moves work between those judgements.
 */
import type {
  FactoryBlockerKind,
  FactoryCampaign,
  FactoryCampaignState,
  FactoryChangeRequest,
  FactoryWorkUnit,
} from '../../domain/factory.ts';
import {
  claimCampaignTick,
  claimUnits,
  factoryNow,
  findDependencyCycle,
  getCampaign,
  getChangeRequest,
  getUnit,
  listUnits,
  patchCampaign,
  promoteReadyUnits,
  releaseCampaignTick,
  sweepExpiredUnitLeases,
} from '../../repos/factory.ts';
import {
  getRelease,
  getWorker,
  implementingSessions,
  listFindings,
  listReviews,
  recordFactoryEvent,
  requestRelease,
} from '../../repos/factoryFleet.ts';
import { FACTORY_DEFAULT_REPO_ROOT } from '../../env.ts';
import { FACTORY_EVENT_KINDS, campaignMetrics } from './metrics.ts';
import { capacity, readiness } from './registry.ts';
import { decide, type SchedulableUnit, type SchedulerDecision } from './scheduler.ts';
import { executeUnit } from './dispatch.ts';
import {
  baseIsStale,
  ensureIntegrationWorktree,
  integrateUnit,
  rebaseCampaign,
  runVerification,
  verificationPassed,
} from './integrate.ts';
import { reviewCampaign } from './review.ts';
import { gatingFindings, queueRepairs, reconcileRepairs } from './repair.ts';
import { assembleDeliverable } from './assemble.ts';
import { planCampaign } from './architect.ts';

export interface TickOptions {
  repoRoot?: string;
  /** Who is ticking. Recorded on the tick lease, so a stuck tick is attributable. */
  owner?: string;
  /** A ceiling on how many workers one tick will start. Bounded, never unbounded. */
  maxDispatch?: number;
  /** Skip the architect and use units that are already installed. */
  planInstalled?: boolean;
  unitTimeoutMs?: number;
  reviewTimeoutMs?: number;
  /** How many review rounds before the campaign stops and says so. */
  maxReviewRounds?: number;
}

export interface TickReport {
  campaignId: string;
  state: FactoryCampaignState;
  stage: string;
  dispatched: number;
  integrated: number;
  rejected: number;
  reviewed: boolean;
  repairsQueued: number;
  blocker: { kind: FactoryBlockerKind; detail: string } | null;
  progress: boolean;
  notes: string[];
}

const DEFAULT_MAX_REVIEW_ROUNDS = 4;

/* ------------------------------------------------------------------------- */
/* The tick                                                                   */
/* ------------------------------------------------------------------------- */

export async function tickCampaign(
  campaignId: string,
  options: TickOptions = {},
): Promise<TickReport> {
  const owner = options.owner ?? `tick-${process.pid}`;
  const repoRoot = options.repoRoot ?? FACTORY_DEFAULT_REPO_ROOT;

  const claim = await claimCampaignTick(campaignId, owner);
  if (!claim.ok) {
    const campaign = await getCampaign(campaignId);
    return {
      campaignId,
      state: campaign?.state ?? 'BLOCKED',
      stage: 'not this dispatcher\'s tick',
      dispatched: 0,
      integrated: 0,
      rejected: 0,
      reviewed: false,
      repairsQueued: 0,
      blocker: null,
      progress: false,
      notes: [claim.reason],
    };
  }

  try {
    return await runTick(campaignId, repoRoot, options);
  } finally {
    await releaseCampaignTick(campaignId, owner, claim.generation);
  }
}

async function runTick(
  campaignId: string,
  repoRoot: string,
  options: TickOptions,
): Promise<TickReport> {
  const notes: string[] = [];
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error(`factory: no campaign ${campaignId}`);
  const changeRequest = await getChangeRequest(campaign.changeRequestId);
  if (!changeRequest) throw new Error(`factory: campaign ${campaignId} has no change request`);

  const report: TickReport = {
    campaignId,
    state: campaign.state,
    stage: campaign.state,
    dispatched: 0,
    integrated: 0,
    rejected: 0,
    reviewed: false,
    repairsQueued: 0,
    blocker: null,
    progress: false,
    notes,
  };

  if (campaign.state === 'COMPLETE' || campaign.state === 'CANCELLED') return report;

  if (changeRequest.state !== 'APPROVED') {
    return await block(report, campaign, 'CONTRADICTORY_CONTRACT', {
      detail:
        'The change request is not approved. A campaign cannot run against an objective nobody ' +
        'has frozen.',
    });
  }

  // A lease that ran out is claimable work. Sweeping makes the state readable and
  // the metrics honest; the claim query would find those units either way.
  const swept = await sweepExpiredUnitLeases();
  if (swept > 0) notes.push(`${swept} expired lease(s) reclaimed`);

  // Has the world moved underneath the pin? Asked every tick, because a campaign
  // that produced a pull request against a branch that has moved is a campaign a
  // reviewer discovers is stale.
  const staleness = await baseIsStale(repoRoot, campaign, changeRequest.baseBranch);
  if (staleness.stale) {
    await recordFactoryEvent({
      campaignId,
      kind: FACTORY_EVENT_KINDS.staleBase,
      evidenceClass: 'MEASURED',
      detail: {
        pinned: campaign.baseSha,
        branchHead: staleness.headSha,
        behindBy: staleness.behindBy,
      },
    });
    const rebased = await rebaseCampaign(repoRoot, campaign, changeRequest.baseBranch);
    if (rebased.ok) {
      notes.push(`base moved ${staleness.behindBy} commit(s); merged into the integration branch`);
    } else {
      return await block(report, campaign, 'STALE_BASE', {
        detail:
          `The pinned base moved ${staleness.behindBy} commit(s) and bringing it in conflicts: ` +
          `${rebased.detail.slice(0, 600)}. Resolving somebody else's concurrent work ` +
          'automatically is the silent drop integration exists to prevent.',
      });
    }
  }

  const fresh = (await getCampaign(campaignId)) ?? campaign;

  switch (fresh.state) {
    case 'PLANNING':
      return await planningStage(report, fresh, changeRequest, repoRoot, options);
    case 'EXECUTING':
    case 'REPAIRING':
      return await executionStage(report, fresh, changeRequest, repoRoot, options);
    case 'INTEGRATING':
      return await executionStage(report, fresh, changeRequest, repoRoot, options);
    case 'REVIEWING':
      return await reviewStage(report, fresh, changeRequest, repoRoot, options);
    case 'VERIFYING':
      return await verifyStage(report, fresh, changeRequest, repoRoot);
    case 'ASSEMBLING':
      return await assembleStage(report, fresh, changeRequest, repoRoot);
    case 'AWAITING_RELEASE':
      return await releaseStage(report, fresh);
    case 'BLOCKED':
      // A blocked campaign is re-examined rather than abandoned: the blocker may
      // have an operational remedy somebody has since applied.
      return await unblockStage(report, fresh, changeRequest, repoRoot, options);
    default:
      return report;
  }
}

async function block(
  report: TickReport,
  campaign: FactoryCampaign,
  kind: FactoryBlockerKind,
  input: { detail: string },
): Promise<TickReport> {
  await patchCampaign(campaign.id, {
    state: 'BLOCKED',
    blockerKind: kind,
    blockerDetail: input.detail,
    stageDetail: kind,
  });
  await recordFactoryEvent({
    campaignId: campaign.id,
    kind: FACTORY_EVENT_KINDS.campaignState,
    evidenceClass: 'MEASURED',
    detail: { from: campaign.state, to: 'BLOCKED', blockerKind: kind, detail: input.detail },
  });
  return { ...report, state: 'BLOCKED', blocker: { kind, detail: input.detail }, progress: false };
}

async function advance(
  report: TickReport,
  campaign: FactoryCampaign,
  to: FactoryCampaignState,
  stageDetail: string,
): Promise<TickReport> {
  await patchCampaign(campaign.id, {
    state: to,
    stageDetail,
    blockerKind: null,
    blockerDetail: null,
    ...(to === 'COMPLETE' ? { finishedAt: factoryNow() } : {}),
  });
  await recordFactoryEvent({
    campaignId: campaign.id,
    kind: FACTORY_EVENT_KINDS.campaignState,
    evidenceClass: 'MEASURED',
    detail: { from: campaign.state, to, stageDetail },
  });
  return { ...report, state: to, stage: stageDetail, progress: true };
}

/* ------------------------------------------------------------------------- */
/* Planning                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Planning, which in this version is a precondition rather than a stage that
 * spends a worker.
 *
 * A campaign whose units are already installed — by the architect pass, or by a
 * caller that planned deliberately — moves straight on. A campaign with no units
 * and no way to get them says so as a blocker with a remedy, rather than ticking
 * forever over an empty graph.
 */
async function planningStage(
  report: TickReport,
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  repoRoot: string,
  options: TickOptions,
): Promise<TickReport> {
  if (changeRequest.acceptanceConditions.length === 0) {
    return await block(report, campaign, 'CONTRADICTORY_CONTRACT', {
      detail:
        'The contract has no acceptance conditions, so no work could be judged. Acceptance ' +
        'conditions exist before implementation begins, or the campaign does not begin.',
    });
  }

  let units = await listUnits(campaign.id);
  if (units.length === 0) {
    // Nothing is planned yet. An architect decomposes the objective, and its plan
    // is validated against the contract before a single row is written.
    const snapshot = await capacity(changeRequest.repository);
    const architectSlot = snapshot.slots.find(
      (slot) => slot.freeSlots > 0 && slot.capabilities.includes('ARCHITECT'),
    );
    if (!architectSlot) {
      return await block(report, campaign, 'NO_HEALTHY_EXECUTION_SURFACE', {
        detail:
          'The campaign has no work units and no free slot holds ARCHITECT. Register an ' +
          'architect-capable worker, or install a validated plan directly.',
      });
    }
    const architect = await getWorker(architectSlot.workerId);
    if (!architect) {
      return await block(report, campaign, 'NO_HEALTHY_EXECUTION_SURFACE', {
        detail: 'The chosen architect vanished between the snapshot and the dispatch.',
      });
    }
    const planned = await planCampaign({
      repoRoot,
      campaign,
      changeRequest,
      worker: architect,
      model: architect.model,
      timeoutMs: options.unitTimeoutMs,
    });
    if (!planned.ok) {
      report.notes.push(`planning refused: ${planned.reason}`);
      // Not a blocker: a refused plan is a pass that can be re-run, and the
      // campaign stays in PLANNING so the next tick tries again with a different
      // architect or a different model.
      report.progress = false;
      return report;
    }
    report.notes.push(
      `architect proposed ${planned.units} unit(s), ${planned.installed} installed` +
        planned.warnings.map((warning) => `; ${warning}`).join(''),
    );
    units = await listUnits(campaign.id);
    report.progress = true;
  }

  const cycle = await findDependencyCycle(campaign.id);
  if (cycle) {
    return await block(report, campaign, 'DEPENDENCY_CYCLE', {
      detail: `The unit graph has a cycle: ${cycle.join(' -> ')}. Nothing in it can ever be ready.`,
    });
  }

  // The integration branch has to exist before anything is pinned to it.
  await ensureIntegrationWorktree(repoRoot, campaign);
  const promoted = await promoteReadyUnits(campaign.id);
  for (const unit of promoted) {
    await recordFactoryEvent({
      campaignId: campaign.id,
      unitId: unit.id,
      kind: FACTORY_EVENT_KINDS.unitReady,
      evidenceClass: 'MEASURED',
      detail: { unitKey: unit.unitKey, reason: 'no unintegrated dependency' },
    });
  }
  report.notes.push(`${units.length} unit(s) planned, ${promoted.length} ready`);
  void options;
  return await advance(report, campaign, 'EXECUTING', 'dispatching independent lanes');
}

/* ------------------------------------------------------------------------- */
/* Execution and continuous integration                                      */
/* ------------------------------------------------------------------------- */

function schedulable(unit: FactoryWorkUnit): SchedulableUnit {
  return {
    id: unit.id,
    unitKey: unit.unitKey,
    kind: unit.kind,
    role: unit.role,
    modelClass: unit.modelClass,
    ownedPaths: unit.ownedPaths,
    criticalPath: unit.criticalPath,
    downstreamCount: unit.downstreamCount,
    priority: unit.priority,
    risk: unit.risk,
    attempt: unit.attempt,
    maxAttempts: unit.maxAttempts,
  };
}

/**
 * One merge at a time, started the moment a lane lands.
 *
 * Integration has to be continuous to be worth anything: waiting until every
 * lane finished before finding out whether their components connect is how a
 * campaign discovers an interface mismatch after six units were built on it.
 * But two merges racing into one branch is how a campaign ends up with a tree
 * nobody ran the tests on — so the work is serialised through this chain rather
 * than through the end of the tick.
 *
 * An in-process chain is enough *because* the campaign tick is claimed: one
 * dispatcher holds it, and the database guards (`markIntegrated` only from
 * IMPLEMENTED, and the already-merged check) are what protect the branch from a
 * second process regardless.
 */
function integrationQueue(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  repoRoot: string,
): {
  enqueue(unitId: string): void;
  drain(): Promise<{ integrated: number; rejected: number; notes: string[] }>;
} {
  let chain: Promise<void> = Promise.resolve();
  let integrated = 0;
  let rejected = 0;
  const notes: string[] = [];

  return {
    enqueue(unitId: string): void {
      chain = chain.then(async () => {
        const unit = await getUnit(unitId);
        if (!unit || unit.state !== 'IMPLEMENTED') return;
        // The campaign is re-read every time: each merge moves the integration
        // sha, and the next unit must be verified against the tree that exists.
        const fresh = (await getCampaign(campaign.id)) ?? campaign;
        const result = await integrateUnit({
          repoRoot,
          campaign: fresh,
          changeRequest,
          unit,
        });
        if (result.outcome === 'MERGED' || result.outcome === 'ALREADY_MERGED') {
          integrated += 1;
          notes.push(`${unit.unitKey}: ${result.reason}`);
        } else {
          rejected += 1;
          notes.push(`${unit.unitKey} rejected: ${result.reason}`);
        }
      });
    },
    async drain(): Promise<{ integrated: number; rejected: number; notes: string[] }> {
      await chain;
      return { integrated, rejected, notes };
    },
  };
}

/**
 * Build the scheduler's input, then act on its decision.
 *
 * The snapshot is recorded before anything is dispatched, which is what makes
 * "why did this unit go to that worker" answerable afterwards from the input the
 * decision was actually made on.
 */
export async function scheduleAndDispatch(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  repoRoot: string,
  options: TickOptions,
): Promise<{
  decision: SchedulerDecision;
  dispatched: number;
  integrated: number;
  rejected: number;
  notes: string[];
}> {
  const notes: string[] = [];
  const at = factoryNow();
  const units = await listUnits(campaign.id);
  const snapshotCapacity = await capacity(changeRequest.repository);
  const metrics = await campaignMetrics(campaign.id);
  const implementers = await implementingSessions(campaign.id);

  const implementedBy: Record<string, string[]> = {};
  for (const session of implementers) {
    const list = implementedBy[session.workerId] ?? [];
    list.push(session.externalSessionId ?? session.id);
    implementedBy[session.workerId] = list;
  }

  const candidates = units.filter(
    (unit) =>
      (unit.state === 'READY' || (unit.state === 'LEASED' && (unit.leaseExpiresAt ?? '') <= at)) &&
      (unit.notBefore === null || unit.notBefore <= at) &&
      unit.attempt < unit.maxAttempts,
  );
  const live = units
    .filter((unit) => unit.state === 'LEASED' && (unit.leaseExpiresAt ?? '') > at)
    .map((unit) => ({
      unitId: unit.id,
      workerId: unit.leaseWorkerId ?? '',
      ownedPaths: unit.ownedPaths,
    }));

  const decision = decide({
    at,
    campaignId: campaign.id,
    laneTarget: campaign.laneTarget,
    candidates: candidates.map(schedulable),
    live,
    slots: snapshotCapacity.slots,
    evidence: {
      firstPassSuccessRate: metrics.firstPassSuccessRate,
      overlapRefusals: 0,
      rateLimitedSessions: metrics.sessions.rateLimited,
      maxObservedConcurrency: metrics.maxObservedConcurrency,
      mergedUnits: metrics.integration.merged,
      failedUnits: metrics.units.failed,
    },
    implementedBy,
  });

  if (decision.laneTarget !== campaign.laneTarget) {
    await patchCampaign(campaign.id, {
      laneTarget: decision.laneTarget,
      laneTargetReason: decision.laneTargetReason,
    });
    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: FACTORY_EVENT_KINDS.laneTargetChanged,
      evidenceClass: 'DERIVED',
      detail: {
        from: campaign.laneTarget,
        to: decision.laneTarget,
        reason: decision.laneTargetReason,
        // The evidence the tuner actually saw, so the decision is re-readable.
        firstPassSuccessRate: metrics.firstPassSuccessRate,
        rateLimitedSessions: metrics.sessions.rateLimited,
        maxObservedConcurrency: metrics.maxObservedConcurrency,
      },
    });
    notes.push(`lane target ${campaign.laneTarget} -> ${decision.laneTarget}: ${decision.laneTargetReason}`);
  }

  for (const refusal of decision.refusals) {
    await recordFactoryEvent({
      campaignId: campaign.id,
      unitId: refusal.unitId,
      workerId: refusal.workerId,
      kind: FACTORY_EVENT_KINDS.unitRefused,
      evidenceClass: 'DERIVED',
      detail: { reason: refusal.reason, stage: 'SCHEDULE' },
    });
  }

  const ceiling = Math.max(1, options.maxDispatch ?? decision.laneTarget);
  const assignments = decision.assignments.slice(0, ceiling);
  const queue = integrationQueue(campaign, changeRequest, repoRoot);

  // Every lane at once. The claim inside each is the exclusion, so two lanes that
  // both wanted a unit cannot both have it, and the loser is not an error.
  const results = await Promise.all(
    assignments.map(async (assignment) => {
      const worker = await getWorker(assignment.workerId);
      const unit = await getUnit(assignment.unitId);
      if (!worker || !unit) return false;

      const claimed = await claimUnits({
        campaignId: campaign.id,
        workerId: worker.id,
        unitIds: [assignment.unitId],
        limit: 1,
        onSkip: async (row, reason) => {
          await recordFactoryEvent({
            campaignId: campaign.id,
            unitId: row.id,
            workerId: worker.id,
            kind: FACTORY_EVENT_KINDS.unitRefused,
            evidenceClass: 'DERIVED',
            detail: { reason, stage: 'CLAIM' },
          });
        },
      });
      const taken = claimed[0];
      if (!taken) return false;

      const finding = unit.repairsFindingId
        ? (await listFindings(campaign.id)).find((f) => f.id === unit.repairsFindingId) ?? null
        : null;

      const outcome = await executeUnit({
        repoRoot,
        campaign,
        changeRequest,
        claimed: taken,
        worker,
        model: assignment.model,
        role: assignment.role,
        finding,
        timeoutMs: options.unitTimeoutMs,
      });
      // Integrate this lane now rather than at the end of the tick. The queue
      // serialises the merges; it does not wait for the other lanes.
      if (outcome.outcome === 'IMPLEMENTED') queue.enqueue(taken.unit.id);
      return true;
    }),
  );

  const integration = await queue.drain();
  notes.push(...integration.notes);

  return {
    decision,
    dispatched: results.filter(Boolean).length,
    integrated: integration.integrated,
    rejected: integration.rejected,
    notes,
  };
}

/**
 * Integrate everything that is waiting, one at a time.
 *
 * Serially on purpose: each merge changes the tree the next one is verified
 * against, and two merges racing into one branch is how a campaign ends up with a
 * tree nobody ran the tests on.
 */
export async function integrateWaiting(
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  repoRoot: string,
): Promise<{ integrated: number; rejected: number; notes: string[] }> {
  const notes: string[] = [];
  let integrated = 0;
  let rejected = 0;

  for (;;) {
    const fresh = (await getCampaign(campaign.id)) ?? campaign;
    const waiting = (await listUnits(campaign.id)).find((unit) => unit.state === 'IMPLEMENTED');
    if (!waiting) break;
    const result = await integrateUnit({
      repoRoot,
      campaign: fresh,
      changeRequest,
      unit: waiting,
    });
    if (result.outcome === 'MERGED' || result.outcome === 'ALREADY_MERGED') {
      integrated += 1;
      notes.push(`${waiting.unitKey}: ${result.reason}`);
    } else {
      rejected += 1;
      notes.push(`${waiting.unitKey} rejected: ${result.reason}`);
    }
  }

  return { integrated, rejected, notes };
}

async function executionStage(
  report: TickReport,
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  repoRoot: string,
  options: TickOptions,
): Promise<TickReport> {
  const ready = await readiness(changeRequest.repository);
  const units = await listUnits(campaign.id);
  const outstanding = units.filter((unit) =>
    ['BLOCKED', 'READY', 'LEASED', 'IMPLEMENTED'].includes(unit.state),
  );

  if (outstanding.length === 0) {
    // Everything is integrated, failed or cancelled. A campaign with failures is
    // still reviewed: what the failures cost is the review's to judge.
    await reconcileRepairs(campaign.id);
    return await advance(report, campaign, 'REVIEWING', 'independent review against the contract');
  }

  if (!ready.ready && !outstanding.some((unit) => unit.state === 'IMPLEMENTED')) {
    return await block(report, campaign, 'NO_HEALTHY_EXECUTION_SURFACE', { detail: ready.reason });
  }

  const dispatch = await scheduleAndDispatch(campaign, changeRequest, repoRoot, options);
  report.dispatched = dispatch.dispatched;
  report.notes.push(...dispatch.notes);

  // Anything a previous tick left implemented, or that a lane produced after its
  // own integration ran. The dispatch queue has already merged what it could.
  const leftovers = await integrateWaiting(campaign, changeRequest, repoRoot);
  report.integrated = dispatch.integrated + leftovers.integrated;
  report.rejected = dispatch.rejected + leftovers.rejected;
  report.notes.push(...leftovers.notes);

  await reconcileRepairs(campaign.id);
  await promoteReadyUnits(campaign.id);

  const after = await listUnits(campaign.id);
  const stillOutstanding = after.filter((unit) =>
    ['BLOCKED', 'READY', 'LEASED', 'IMPLEMENTED'].includes(unit.state),
  );
  report.progress = dispatch.dispatched > 0 || report.integrated > 0 || report.rejected > 0;

  if (stillOutstanding.length === 0) {
    return await advance(report, campaign, 'REVIEWING', 'independent review against the contract');
  }

  // Nothing moved and nothing can: every outstanding unit has spent its attempts.
  const movable = stillOutstanding.filter(
    (unit) => unit.attempt < unit.maxAttempts || unit.state === 'IMPLEMENTED',
  );
  if (!report.progress && movable.length === 0) {
    const exhausted = stillOutstanding.map((unit) => `${unit.unitKey} (${unit.failureCategory ?? 'no reason recorded'})`);
    return await block(report, campaign, 'UNIT_EXHAUSTED_ATTEMPTS', {
      detail:
        `These units spent every attempt without producing an integrable change: ` +
        `${exhausted.join('; ')}. The campaign stops here rather than repeating a strategy that ` +
        'has already failed.',
    });
  }

  report.state = campaign.state;
  report.stage = `${stillOutstanding.length} unit(s) outstanding`;
  return report;
}

/* ------------------------------------------------------------------------- */
/* Review and repair                                                          */
/* ------------------------------------------------------------------------- */

async function reviewStage(
  report: TickReport,
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  repoRoot: string,
  options: TickOptions,
): Promise<TickReport> {
  const maxRounds = options.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
  const reviewedSha = campaign.integrationSha ?? campaign.baseSha;

  if (reviewedSha === campaign.baseSha) {
    return await block(report, campaign, 'UNIT_EXHAUSTED_ATTEMPTS', {
      detail:
        'Nothing was integrated, so there is no change to review. A campaign with an empty diff ' +
        'has not produced software.',
    });
  }

  const existing = await listReviews(campaign.id);
  const alreadyReviewed = existing.find((review) => review.reviewedSha === reviewedSha);
  if (alreadyReviewed) {
    // This commit has already been judged. Act on the verdict rather than buying
    // a second opinion on the same tree — a review is an effect and paying for it
    // twice is the at-least-once problem in a more expensive form.
    report.notes.push(
      `round ${alreadyReviewed.round} already judged ${reviewedSha.slice(0, 12)}: ${alreadyReviewed.verdict}`,
    );
    return await actOnVerdict(report, campaign, changeRequest, alreadyReviewed.verdict, options);
  }

  if (campaign.reviewRounds >= maxRounds) {
    const open = await gatingFindings(campaign.id);
    return await block(report, campaign, 'UNIT_EXHAUSTED_ATTEMPTS', {
      detail:
        `${maxRounds} review rounds produced findings that are still open: ` +
        `${open.map((f) => f.findingKey).join(', ') || 'none recorded'}. Another identical round ` +
        'would be the same strategy again.',
    });
  }

  const snapshot = await capacity(changeRequest.repository);
  const reviewerSlot = snapshot.slots.find(
    (slot) => slot.freeSlots > 0 && slot.capabilities.includes('REVIEW'),
  );
  if (!reviewerSlot) {
    return await block(report, campaign, 'NO_ELIGIBLE_REVIEWER', {
      detail:
        'No free slot holds REVIEW. Register a reviewer-capable worker; the review is what ' +
        'decides whether the objective was met, so the campaign does not advance without one.',
    });
  }
  const reviewer = await getWorker(reviewerSlot.workerId);
  if (!reviewer) {
    return await block(report, campaign, 'NO_ELIGIBLE_REVIEWER', {
      detail: 'The chosen reviewer vanished between the snapshot and the dispatch.',
    });
  }

  const round = campaign.reviewRounds + 1;
  const outcome = await reviewCampaign({
    repoRoot,
    campaign,
    changeRequest,
    worker: reviewer,
    model: reviewer.model,
    round,
    reviewedSha,
    timeoutMs: options.reviewTimeoutMs,
  });

  if (!outcome.ok) {
    report.notes.push(`review did not complete: ${outcome.reason}`);
    // A review that did not happen moves nothing. The campaign stays in REVIEWING
    // and the next tick tries again, which is what makes a rate-limited reviewer a
    // delay rather than an outcome.
    report.progress = false;
    return report;
  }

  await patchCampaign(campaign.id, { reviewRounds: round });
  report.reviewed = true;
  report.progress = true;
  report.notes.push(
    `round ${round}: ${outcome.review.verdict}, ${outcome.findings.length} finding(s), ${outcome.independence}`,
  );
  const refreshed = (await getCampaign(campaign.id)) ?? campaign;
  return await actOnVerdict(report, refreshed, changeRequest, outcome.review.verdict, options);
}

async function actOnVerdict(
  report: TickReport,
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  verdict: string,
  options: TickOptions,
): Promise<TickReport> {
  const gating = await gatingFindings(campaign.id);

  if (verdict === 'PASS' && gating.length === 0) {
    return await advance(report, campaign, 'VERIFYING', 'final verification on the merged tree');
  }

  if (verdict === 'BLOCKED') {
    return await block(report, campaign, 'CONTRADICTORY_CONTRACT', {
      detail:
        'The reviewer could not review the change. Read the review summary: a review that cannot ' +
        'be performed is not a verdict, and nothing advances on it.',
    });
  }

  const repairs = await queueRepairs(campaign, changeRequest);
  report.repairsQueued = repairs.queued.length;
  report.notes.push(
    `${repairs.queued.length} repair unit(s) queued from ${gating.length} gating finding(s)`,
  );

  if (repairs.queued.length === 0 && gating.length > 0) {
    // Every gating finding already has a repair, and they are not landing.
    const exhausted = await reconcileRepairs(campaign.id);
    if (exhausted.exhausted.length > 0) {
      return await block(report, campaign, 'UNIT_EXHAUSTED_ATTEMPTS', {
        detail:
          `Repairs for these findings spent every attempt: ` +
          `${exhausted.exhausted.map((e) => e.unitKey).join(', ')}. The findings stay open, ` +
          'because a defect nobody fixed is not a defect that went away.',
      });
    }
  }

  void options;
  return await advance(report, campaign, 'REPAIRING', 'repairing review findings');
}

/* ------------------------------------------------------------------------- */
/* Final verification, assembly and release                                   */
/* ------------------------------------------------------------------------- */

/**
 * The whole contract's verification, on the merged tree.
 *
 * Run again at the end even though each unit ran its own: a unit verifies what it
 * touched, and the question at the end is whether the *campaign* works. Two units
 * that each passed can break each other, which is the failure continuous
 * integration catches early and this catches for certain.
 */
async function verifyStage(
  report: TickReport,
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  repoRoot: string,
): Promise<TickReport> {
  const worktreePath = await ensureIntegrationWorktree(repoRoot, campaign);
  const results = await runVerification(worktreePath, changeRequest.verificationCommands, {
    campaignId: campaign.id,
  });

  if (changeRequest.verificationCommands.length > 0 && !verificationPassed(results)) {
    const failed = results.find((result) => result.exitCode !== 0);
    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: FACTORY_EVENT_KINDS.verificationRan,
      evidenceClass: 'MEASURED',
      detail: { stage: 'FINAL', command: failed?.command, exitCode: failed?.exitCode },
    });
    // Not a blocker: a failing final check is work, and the review that produced
    // the last verdict judged a tree that no longer passes. Back to review, which
    // is the stage that turns a defect into repair units.
    report.notes.push(`final verification failed: \`${failed?.command}\` exited ${failed?.exitCode}`);
    await patchCampaign(campaign.id, {
      stageDetail: `final verification failed: ${failed?.command}`,
    });
    return await advance(report, campaign, 'REVIEWING', 'final verification failed; re-reviewing');
  }

  report.notes.push(`final verification passed: ${results.map((r) => r.command).join(', ') || 'no commands'}`);
  return await advance(report, campaign, 'ASSEMBLING', 'assembling the reviewable artifact');
}

async function assembleStage(
  report: TickReport,
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  repoRoot: string,
): Promise<TickReport> {
  const assembled = await assembleDeliverable({ repoRoot, campaign, changeRequest });
  report.notes.push(assembled.summary);

  if (changeRequest.deploymentPolicy === 'NONE') {
    return await advance(report, campaign, 'COMPLETE', 'reviewable artifact produced');
  }

  const metrics = await campaignMetrics(campaign.id);
  const reviews = await listReviews(campaign.id);
  const findings = await listFindings(campaign.id);
  await requestRelease(campaign.id, 'CONTROL_PLANE', {
    integrationBranch: campaign.integrationBranch,
    integrationSha: campaign.integrationSha,
    diffRef: assembled.diffRef,
    unitsIntegrated: metrics.units.integrated,
    reviewRounds: reviews.length,
    lastVerdict: reviews[reviews.length - 1]?.verdict ?? null,
    openFindings: findings.filter((f) => f.state === 'OPEN').length,
    independence: reviews[reviews.length - 1]?.independence ?? 'UNKNOWN',
  });
  await recordFactoryEvent({
    campaignId: campaign.id,
    kind: FACTORY_EVENT_KINDS.releaseRequested,
    evidenceClass: 'MEASURED',
    detail: { kind: 'CONTROL_PLANE', policy: changeRequest.deploymentPolicy },
  });
  return await advance(report, campaign, 'AWAITING_RELEASE', 'a person decides');
}

/**
 * Waiting for a person, in a way that person can actually answer.
 *
 * The release row is the answering transition: `answerRelease` is a guarded
 * update a route can call, and this stage reads its result. A campaign parked
 * here is waiting; it is not stuck.
 */
async function releaseStage(report: TickReport, campaign: FactoryCampaign): Promise<TickReport> {
  const release = await getRelease(campaign.id, 'CONTROL_PLANE');
  if (!release) {
    return await advance(report, campaign, 'ASSEMBLING', 'no release request exists; re-assembling');
  }
  if (release.decision === 'REQUESTED') {
    report.stage = 'waiting for a release decision';
    report.blocker = {
      kind: 'AWAITING_HUMAN_RELEASE',
      detail:
        'The reviewable artifact is ready and a person has not answered. This is the one ' +
        'decision the factory does not make for itself.',
    };
    return report;
  }
  if (release.decision === 'REFUSED') {
    return await advance(
      report,
      campaign,
      'COMPLETE',
      `release refused: ${release.decidedReason ?? 'no reason recorded'}`,
    );
  }
  return await advance(report, campaign, 'COMPLETE', 'release approved');
}

/**
 * A blocked campaign, looked at again.
 *
 * Every blocker in the vocabulary has an operational remedy, so a blocked
 * campaign is re-examined rather than retired: a worker registered, a rate limit
 * expired or a conflict resolved all make the same campaign movable again without
 * anybody re-planning it.
 */
async function unblockStage(
  report: TickReport,
  campaign: FactoryCampaign,
  changeRequest: FactoryChangeRequest,
  repoRoot: string,
  options: TickOptions,
): Promise<TickReport> {
  switch (campaign.blockerKind) {
    case 'NO_HEALTHY_EXECUTION_SURFACE': {
      const ready = await readiness(changeRequest.repository);
      if (!ready.ready) {
        report.blocker = { kind: campaign.blockerKind, detail: ready.reason };
        return report;
      }
      return await advance(report, campaign, 'EXECUTING', 'a surface became available');
    }
    case 'NO_ELIGIBLE_REVIEWER': {
      const snapshot = await capacity(changeRequest.repository);
      const reviewer = snapshot.slots.find(
        (slot) => slot.freeSlots > 0 && slot.capabilities.includes('REVIEW'),
      );
      if (!reviewer) {
        report.blocker = {
          kind: campaign.blockerKind,
          detail: campaign.blockerDetail ?? 'no reviewer',
        };
        return report;
      }
      return await advance(report, campaign, 'REVIEWING', 'a reviewer became available');
    }
    case 'STALE_BASE': {
      const staleness = await baseIsStale(repoRoot, campaign, changeRequest.baseBranch);
      if (staleness.stale) {
        const rebased = await rebaseCampaign(repoRoot, campaign, changeRequest.baseBranch);
        if (!rebased.ok) {
          report.blocker = { kind: 'STALE_BASE', detail: rebased.detail.slice(0, 600) };
          return report;
        }
      }
      return await advance(report, campaign, 'EXECUTING', 'the base was brought in');
    }
    case 'UNIT_EXHAUSTED_ATTEMPTS': {
      const units = await listUnits(campaign.id);
      const movable = units.filter(
        (unit) =>
          (unit.state === 'READY' || unit.state === 'IMPLEMENTED') && unit.attempt < unit.maxAttempts,
      );
      if (movable.length === 0) {
        report.blocker = {
          kind: campaign.blockerKind,
          detail: campaign.blockerDetail ?? 'every attempt is spent',
        };
        return report;
      }
      return await advance(report, campaign, 'EXECUTING', 'a unit became movable again');
    }
    default:
      report.blocker = campaign.blockerKind
        ? { kind: campaign.blockerKind, detail: campaign.blockerDetail ?? '' }
        : null;
      void options;
      return report;
  }
}

/* ------------------------------------------------------------------------- */
/* Driving a campaign to a stop                                              */
/* ------------------------------------------------------------------------- */

export interface RunOptions extends TickOptions {
  /** A ceiling on ticks, so a caller cannot start something unbounded by accident. */
  maxTicks?: number;
  /** Called after each tick, for a caller that wants to show progress. */
  onTick?: (report: TickReport) => void;
}

/**
 * Tick until the campaign stops moving, then say why it stopped.
 *
 * "Stops moving" is a terminal state, a blocker with no remedy available right
 * now, or a tick that made no progress — and the difference between those three
 * is in the report rather than in the reader's interpretation.
 */
export async function runCampaign(
  campaignId: string,
  options: RunOptions = {},
): Promise<{ reports: TickReport[]; final: FactoryCampaign | null }> {
  const maxTicks = Math.max(1, options.maxTicks ?? 60);
  const reports: TickReport[] = [];

  for (let tick = 0; tick < maxTicks; tick += 1) {
    const report = await tickCampaign(campaignId, options);
    reports.push(report);
    options.onTick?.(report);
    if (report.state === 'COMPLETE' || report.state === 'CANCELLED') break;
    if (report.state === 'AWAITING_RELEASE') break;
    if (report.state === 'BLOCKED' && !report.progress) break;
    if (!report.progress && report.dispatched === 0 && !report.reviewed) break;
  }

  return { reports, final: await getCampaign(campaignId) };
}

/** Every live campaign, one tick each. What a scheduled dispatcher would call. */
export async function tickAllCampaigns(options: TickOptions = {}): Promise<TickReport[]> {
  const { listLiveCampaigns } = await import('../../repos/factory.ts');
  const campaigns = await listLiveCampaigns();
  const reports: TickReport[] = [];
  for (const campaign of campaigns) {
    reports.push(await tickCampaign(campaign.id, options));
  }
  return reports;
}
