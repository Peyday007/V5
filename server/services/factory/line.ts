/**
 * The factory as a production line: what keeps it fed, and what says it stopped.
 *
 * Stage-to-stage movement was already Brain's own — a completed bin ticks its
 * campaign and dispatches what that created, and a twenty-second loop is the
 * fallback. What was not Brain's was the step *between* campaigns. When one
 * campaign finished, blocked, or delivered a pull request that now waits for a
 * person to merge it, nothing started the next objective; somebody had to run
 * `approve` by hand, and in practice that somebody was a scheduled reminder in a
 * Claude session. A production line whose conveyor is a person's calendar is a
 * sequence of demonstrations.
 *
 * Three rules make this safe rather than a way around the approval boundary:
 *
 * 1. **Brain never approves anything here.** A queue entry exists only because a
 *    person approved the objective and queued it, and `queueObjective` records
 *    that approval as theirs at the moment they do it. What Brain decides is
 *    *when* an already-authorized campaign starts, which is the same decision the
 *    dispatcher already makes about bins.
 * 2. **A campaign that cannot move does not hold a slot.** BLOCKED and
 *    AWAITING_RELEASE campaigns are waiting on something that is not factory
 *    capacity, and a pull request waiting for a merge is COMPLETE. Letting any of
 *    them occupy the line would let one parked objective idle the whole factory.
 * 3. **Idle is derived, and unexplained idle is a fault.** Executable work, free
 *    capacity and nothing running at once is reported as exactly that, with a
 *    start and an end on the ledger, rather than inferred from a quiet screen.
 */
import type { FactoryBlockerKind, FactoryCampaign } from '../../domain/factory.ts';
import type { Bin } from '../../domain/types.ts';
import {
  ensureCampaign,
  getCampaign,
  getCampaignByChangeRequest,
  getChangeRequest,
  listLiveCampaigns,
} from '../../repos/factory.ts';
import { listFactoryEvents, recordFactoryEvent } from '../../repos/factoryFleet.ts';
import {
  currentAdmissionPolicy,
  enqueueChangeRequest,
  listQueueEntries,
  markQueueEntryStarted,
  parkedStageBin,
  type AdmissionPolicy,
  type FactoryQueueEntry,
} from '../../repos/factoryLine.ts';
import { listBins, listDispatchesForBin } from '../../repos/bins.ts';
import { approveObjective } from './contract.ts';
import { campaignSpecFor } from './remote.ts';
import { INITIAL_LANE_TARGET } from './scheduler.ts';
import { fleetSnapshot } from '../dispatch/candidates.ts';
import { surfaceIneligibility } from '../dispatch/router.ts';

/** The ledger kinds this module writes. */
export const LINE_EVENT_KINDS = {
  queued: 'OBJECTIVE_QUEUED',
  admitted: 'CAMPAIGN_ADMITTED',
  idleStarted: 'FACTORY_IDLE_STARTED',
  idleEnded: 'FACTORY_IDLE_ENDED',
} as const;

/** States in which a campaign is doing factory work and so holds a slot. */
const WORKING_STATES: ReadonlySet<FactoryCampaign['state']> = new Set([
  'PLANNING',
  'EXECUTING',
  'INTEGRATING',
  'REVIEWING',
  'REPAIRING',
  'VERIFYING',
  'ASSEMBLING',
]);

/**
 * A fire answered within this long is still a worker on its way, not idleness.
 * Measured activations in this Brain arrive in 5–15 seconds; a quarter of an hour
 * is generous on purpose, because calling a booting session idle would teach a
 * reader to stop believing the fault.
 */
export const ARRIVAL_GRACE_MS = 15 * 60_000;

/**
 * Idle that lasts under this long is a tick boundary, not a stop. The remote loop
 * runs every twenty seconds, so between one stage completing and the next bin
 * being fired there is routinely a short gap that says nothing is wrong.
 */
export const IDLE_REPORT_AFTER_MS = 2 * 60_000;

export class LineError extends Error {}

/* ------------------------------------------------------------------------- */
/* Queueing: a person's approval, given in advance                            */
/* ------------------------------------------------------------------------- */

export interface QueueOutcome {
  entry: FactoryQueueEntry;
  created: boolean;
  /** Set when the objective already has a campaign, so queueing it would duplicate work. */
  existingCampaignId: string | null;
}

/**
 * Approve an objective and put it in the line.
 *
 * The approval is the same `approveObjective` every other entrance uses, as the
 * person doing the queueing, so it is refused for exactly the reasons approving
 * directly is refused (no acceptance conditions, not a person). An objective that
 * already has a campaign is not queued: starting it again would be a second
 * campaign on one change request, which `ensureCampaign` would refuse anyway.
 */
export async function queueObjective(input: {
  changeRequestId: string;
  userId: string;
  priority: number;
}): Promise<QueueOutcome> {
  if (!Number.isInteger(input.priority)) throw new LineError('A priority is a whole number.');
  const changeRequest = await getChangeRequest(input.changeRequestId);
  if (!changeRequest) throw new LineError('No such change request.');
  const existing = await getCampaignByChangeRequest(changeRequest.id);
  if (existing) {
    throw new LineError(
      `This objective already has campaign ${existing.id} (${existing.state}); it is not queued again.`,
    );
  }
  const approval = await approveObjective({
    changeRequestId: changeRequest.id,
    via: 'PERSON',
    userId: input.userId,
  });
  if (!approval.ok) throw new LineError(approval.reason ?? 'The objective could not be approved.');

  const { entry, created } = await enqueueChangeRequest({
    changeRequestId: changeRequest.id,
    projectId: changeRequest.projectId,
    priority: input.priority,
    queuedByUserId: input.userId,
  });
  if (created) {
    await recordFactoryEvent({
      kind: LINE_EVENT_KINDS.queued,
      evidenceClass: 'MEASURED',
      detail: { changeRequestId: changeRequest.id, entryId: entry.id, priority: entry.priority },
    });
  }
  return { entry, created, existingCampaignId: null };
}

/* ------------------------------------------------------------------------- */
/* Admission: start the next authorized objective when a slot is free          */
/* ------------------------------------------------------------------------- */

export interface AdmissionReport {
  policy: AdmissionPolicy;
  working: number;
  admitted: Array<{ entryId: string; changeRequestId: string; campaignId: string }>;
  skipped: Array<{ entryId: string; reason: string }>;
}

function inWorkingState(campaign: FactoryCampaign): boolean {
  return campaign.executionMode === 'REMOTE' && WORKING_STATES.has(campaign.state);
}

/**
 * Whether a campaign holds a slot: it is in a working state *and* its stage is
 * not parked on a person. A stage bin that ran out of attempts leaves the
 * campaign reading EXECUTING until somebody answers the bin, and counting that
 * as working is one parked objective idling the whole line — rule 2 above, for
 * the state the campaign column does not show.
 */
async function holdsSlot(campaign: FactoryCampaign): Promise<boolean> {
  if (!inWorkingState(campaign)) return false;
  return (await parkedStageBin(campaign.id)) === null;
}

async function countWorking(campaigns: FactoryCampaign[]): Promise<number> {
  let n = 0;
  for (const campaign of campaigns) if (await holdsSlot(campaign)) n += 1;
  return n;
}

/**
 * Start queued campaigns while fewer than the admission limit are working.
 *
 * Idempotent by rows: `ensureCampaign` is one campaign per change request, and
 * the queue entry is taken with a guarded update, so two ticks racing produce
 * one campaign and one ordinary loser.
 */
export async function admitQueued(): Promise<AdmissionReport> {
  const policy = await currentAdmissionPolicy();
  const live = await listLiveCampaigns();
  let working = await countWorking(live);
  const report: AdmissionReport = { policy, working, admitted: [], skipped: [] };
  if (working >= policy.maxActive) return report;

  for (const entry of await listQueueEntries(['QUEUED'])) {
    if (working >= policy.maxActive) break;
    const changeRequest = await getChangeRequest(entry.changeRequestId);
    if (!changeRequest) {
      report.skipped.push({ entryId: entry.id, reason: 'its change request no longer exists' });
      continue;
    }
    if (changeRequest.state !== 'APPROVED') {
      report.skipped.push({ entryId: entry.id, reason: `its change request is ${changeRequest.state}` });
      continue;
    }

    const already = await getCampaignByChangeRequest(changeRequest.id);
    let campaign = already;
    if (!campaign) {
      const spec = await campaignSpecFor(changeRequest);
      const ensured = await ensureCampaign({
        changeRequestId: changeRequest.id,
        projectId: changeRequest.projectId,
        baseSha: changeRequest.baseSha,
        laneTarget: INITIAL_LANE_TARGET,
        laneTargetReason: 'initial',
        executionMode: spec.executionMode,
        integrationBranch: spec.integrationBranch,
        pullRequest: spec.pullRequest,
      });
      campaign = ensured.campaign;
    }
    const took = await markQueueEntryStarted({ entryId: entry.id, campaignId: campaign.id });
    if (!took) continue;

    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: LINE_EVENT_KINDS.admitted,
      evidenceClass: 'MEASURED',
      detail: {
        entryId: entry.id,
        changeRequestId: changeRequest.id,
        priority: entry.priority,
        workingBefore: working,
        maxActive: policy.maxActive,
        existingCampaign: already !== null,
      },
    });
    report.admitted.push({ entryId: entry.id, changeRequestId: changeRequest.id, campaignId: campaign.id });
    if (await holdsSlot(campaign)) working += 1;
  }
  report.working = working;
  return report;
}

/* ------------------------------------------------------------------------- */
/* The reading: what is executable, what is running, what could run           */
/* ------------------------------------------------------------------------- */

export interface LineCapacitySurface {
  routineId: string;
  routineName: string;
  accountName: string;
  capabilities: string[];
  inFlight: number;
  target: number | null;
  /** Null when the router would consider it; otherwise its own refusal. */
  refusal: string | null;
  free: boolean;
}

export interface LineBin {
  binId: string;
  campaignId: string;
  kind: string;
  state: string;
  readyAt: string | null;
  leasedAt: string | null;
  sessionRef: string | null;
  workerId: string | null;
  lastSentAt: string | null;
  lastRoutine: string | null;
}

/**
 * What a blocked campaign is waiting for. `AUTOMATIC` resolves by itself — the
 * tick re-examines it and nothing a person does would be faster; `PERSON` needs
 * somebody to act, and names what. A `Record` over the whole union, so a blocker
 * kind added later is a compile error until somebody says which it is.
 */
export const BLOCKER_WAIT: Record<FactoryBlockerKind, { wait: 'AUTOMATIC' | 'PERSON'; remedy: string }> = {
  NO_HEALTHY_EXECUTION_SURFACE: {
    wait: 'AUTOMATIC',
    remedy: 'Resumes on the next tick once a surface that can take the stage is eligible.',
  },
  NO_ELIGIBLE_REVIEWER: {
    wait: 'AUTOMATIC',
    remedy: 'Resumes once a session independent of the implementers is available.',
  },
  STALE_BASE: { wait: 'AUTOMATIC', remedy: 'Re-examined on every tick.' },
  UNIT_EXHAUSTED_ATTEMPTS: {
    wait: 'PERSON',
    remedy: 'A unit ran out of attempts: regrant it, amend the contract, or retire the campaign.',
  },
  DEPENDENCY_CYCLE: { wait: 'PERSON', remedy: 'The plan has a cycle; the contract has to be amended.' },
  CONTRADICTORY_CONTRACT: { wait: 'PERSON', remedy: 'The contract contradicts itself; amend it.' },
  AWAITING_HUMAN_RELEASE: { wait: 'PERSON', remedy: 'Approve or refuse the release on Build.' },
  EXTERNAL_CREDENTIAL_REQUIRED: {
    wait: 'PERSON',
    remedy: 'Access has to be granted where the worker runs; Brain holds no repository credential.',
  },
};

export interface LineCampaign {
  campaign: FactoryCampaign;
  objective: string;
  /** Holds an admission slot: in a working state and not parked on a person. */
  working: boolean;
  bins: LineBin[];
  /** Null while it is moving. */
  blocked: null | {
    wait: 'AUTOMATIC' | 'PERSON';
    kind: string;
    detail: string;
    remedy: string;
    since: string | null;
  };
  /** The next thing that has to happen, in words derived from its rows. */
  next: string;
  /** How long the current stage bin has been with a worker, when one has it. */
  elapsedMs: number | null;
}

export interface LineQueued {
  entry: FactoryQueueEntry;
  objective: string;
  position: number;
  /** Whether admission would start it on the next pass. */
  executableNow: boolean;
  why: string;
}

export interface LineReading {
  at: string;
  policy: AdmissionPolicy;
  /** AUTO is on when the line may start anything at all. */
  auto: boolean;
  executable: {
    queued: number;
    readyBins: number;
    total: number;
  };
  active: {
    leasedBins: number;
    /** READY bins whose fire was sent recently enough that a worker may still be arriving. */
    arriving: number;
    workingCampaigns: number;
  };
  capacity: {
    freeSurfaces: number;
    surfaces: LineCapacitySurface[];
  };
  unexplainedIdle: boolean;
  /** The sentence that says why the line is or is not moving. */
  because: string;
  campaigns: LineCampaign[];
  queue: LineQueued[];
}

function newestSent(dispatches: Awaited<ReturnType<typeof listDispatchesForBin>>) {
  let best: { sentAt: string; routine: string | null } | null = null;
  for (const dispatch of dispatches) {
    if (!dispatch.sentAt) continue;
    if (!best || dispatch.sentAt > best.sentAt) best = { sentAt: dispatch.sentAt, routine: dispatch.routineRef };
  }
  return best;
}

function nextFor(campaign: FactoryCampaign, bins: LineBin[], blocked: LineCampaign['blocked']): string {
  if (blocked) return blocked.remedy;
  if (campaign.state === 'COMPLETE') return 'A person merges the pull request.';
  const leased = bins.find((bin) => bin.state === 'LEASED');
  if (leased) return `The ${leased.kind.toLowerCase()} stage finishes, and the next stage is made on completion.`;
  const ready = bins.find((bin) => bin.state === 'READY' || bin.state === 'LEASE_EXPIRED');
  if (ready) {
    return ready.lastSentAt
      ? `A worker arrives for the ${ready.kind.toLowerCase()} stage it was fired for.`
      : `The ${ready.kind.toLowerCase()} stage is fired at the next free surface.`;
  }
  return 'The next tick derives the next stage from what the last one recorded.';
}

/**
 * The line, read once.
 *
 * Capacity is read from the router's own snapshot and its own refusal function,
 * restricted to surfaces declaring `repository` — a factory bin can be fired at
 * nothing else — and to those with headroom under their Routine and account
 * targets. A second definition of "available" here would be the two readers of
 * one fact this repository keeps having to correct.
 *
 * With `projectId`, the campaigns, bins and queue are that project's alone, so a
 * project member reads nothing about another project's work; capacity stays the
 * fleet's, because a surface serves every project and a member is owed what is
 * free. Surface identifiers are for the operator and are left out by the route.
 */
export async function readLine(now: Date = new Date(), options: { projectId?: string } = {}): Promise<LineReading> {
  const nowIso = now.toISOString();
  const policy = await currentAdmissionPolicy();
  const [allLive, allQueued, bins, snapshot] = await Promise.all([
    listLiveCampaigns(),
    listQueueEntries(['QUEUED']),
    listBins({ states: ['READY', 'LEASED'], limit: 500 }),
    fleetSnapshot(now),
  ]);
  const inScope = (projectId: string) => !options.projectId || projectId === options.projectId;
  const live = allLive.filter((campaign) => inScope(campaign.projectId));
  const queue = allQueued.filter((entry) => inScope(entry.projectId));
  const liveIds = new Set(live.map((campaign) => campaign.id));

  const factoryBins = bins.filter(
    (bin: Bin) => bin.factoryCampaignId && (!options.projectId || liveIds.has(bin.factoryCampaignId)),
  );
  const lineBins: LineBin[] = [];
  let readyBins = 0;
  let leasedBins = 0;
  let arriving = 0;
  for (const bin of factoryBins) {
    const sent = newestSent(await listDispatchesForBin(bin.id));
    const leaseLive = bin.state === 'LEASED' && bin.leaseExpiresAt !== null && bin.leaseExpiresAt > nowIso;
    if (leaseLive) leasedBins += 1;
    else {
      readyBins += 1;
      if (sent && now.getTime() - new Date(sent.sentAt).getTime() < ARRIVAL_GRACE_MS) arriving += 1;
    }
    lineBins.push({
      binId: bin.id,
      campaignId: bin.factoryCampaignId!,
      kind: bin.kind,
      state: leaseLive ? 'LEASED' : bin.state === 'LEASED' ? 'LEASE_EXPIRED' : bin.state,
      readyAt: bin.readyAt,
      leasedAt: bin.leasedAt,
      sessionRef: bin.leaseSessionRef,
      workerId: bin.workerId,
      lastSentAt: sent?.sentAt ?? null,
      lastRoutine: sent?.routine ?? null,
    });
  }

  const surfaces: LineCapacitySurface[] = snapshot.candidates
    .filter((candidate) => candidate.routine.capabilities.includes('repository'))
    .map((candidate) => {
      const refusal = surfaceIneligibility(candidate);
      const underRoutine = candidate.routineTarget === null || candidate.routineInFlight < candidate.routineTarget;
      const underAccount = candidate.accountTarget === null || candidate.accountInFlight < candidate.accountTarget;
      return {
        routineId: candidate.routine.id,
        routineName: candidate.routine.name,
        accountName: candidate.account.name,
        capabilities: candidate.routine.capabilities,
        inFlight: candidate.routineInFlight,
        target: candidate.routineTarget ?? candidate.accountTarget,
        refusal,
        free: refusal === null && underRoutine && underAccount,
      };
    });
  const freeSurfaces = surfaces.filter((surface) => surface.free).length;
  // A dispatch row names the Routine by its trigger reference, which is operator
  // depth (§34); a reader is shown the surface's name. An unknown reference —
  // a Routine no longer registered — reads as a surface nobody can name rather
  // than leaking the reference.
  const routineNames = new Map(
    snapshot.candidates.map((candidate) => [candidate.routine.routineRef, candidate.routine.name]),
  );

  const campaigns: LineCampaign[] = [];
  for (const campaign of live) {
    const parked = inWorkingState(campaign) ? await parkedStageBin(campaign.id) : null;
    const campaignBins = lineBins.filter((bin) => bin.campaignId === campaign.id);
    let blocked: LineCampaign['blocked'] = null;
    if (campaign.state === 'BLOCKED' || campaign.state === 'AWAITING_RELEASE') {
      const kind: FactoryBlockerKind =
        campaign.blockerKind ?? (campaign.state === 'AWAITING_RELEASE' ? 'AWAITING_HUMAN_RELEASE' : 'UNIT_EXHAUSTED_ATTEMPTS');
      blocked = {
        wait: BLOCKER_WAIT[kind].wait,
        kind,
        detail: campaign.blockerDetail ?? '',
        remedy: BLOCKER_WAIT[kind].remedy,
        since: campaign.updatedAt ?? null,
      };
    } else if (parked) {
      blocked = {
        wait: 'PERSON',
        kind: 'STAGE_BIN_NEEDS_HUMAN',
        detail: `The ${parked.kind.toLowerCase()} stage bin ${parked.id} ran out of attempts.`,
        remedy: 'Answer the bin (factory answer-bin) once the condition that stopped it is fixed.',
        since: parked.completedAt ?? parked.updatedAt ?? null,
      };
    } else if (campaign.blockerKind) {
      // A derived annotation beside a truthful working state (§27): the stage is
      // waiting for a surface, and the tick takes the sentence away when it can move.
      blocked = {
        wait: BLOCKER_WAIT[campaign.blockerKind].wait,
        kind: campaign.blockerKind,
        detail: campaign.blockerDetail ?? '',
        remedy: BLOCKER_WAIT[campaign.blockerKind].remedy,
        since: campaign.updatedAt ?? null,
      };
    }
    const leased = campaignBins.find((bin) => bin.state === 'LEASED');
    const request = await getChangeRequest(campaign.changeRequestId);
    campaigns.push({
      campaign,
      objective: request?.objective ?? '',
      working: inWorkingState(campaign) && parked === null,
      bins: campaignBins.map((bin) => ({
        ...bin,
        lastRoutine: bin.lastRoutine ? routineNames.get(bin.lastRoutine) ?? 'a surface no longer registered' : null,
      })),
      blocked,
      next: nextFor(campaign, campaignBins, blocked),
      elapsedMs: leased?.leasedAt ? now.getTime() - new Date(leased.leasedAt).getTime() : null,
    });
  }

  const workingCampaigns = campaigns.filter((one) => one.working).length;
  const room = Math.max(0, policy.maxActive - workingCampaigns);
  const admissibleQueued = Math.min(room, queue.length);
  const executableTotal = readyBins + admissibleQueued;
  const unexplainedIdle =
    executableTotal > 0 && freeSurfaces > 0 && leasedBins === 0 && arriving === 0;

  let because: string;
  if (policy.maxActive === 0) because = 'AUTO is off: the admission limit is 0, so nothing new starts.';
  else if (unexplainedIdle)
    because =
      `${executableTotal} piece(s) of executable work and ${freeSurfaces} free surface(s), ` +
      'and nothing is running or arriving. That is a fault, not a wait.';
  else if (leasedBins > 0 || arriving > 0)
    because = `${leasedBins} stage(s) running and ${arriving} worker(s) arriving.`;
  else if (executableTotal > 0)
    because = `${executableTotal} piece(s) of executable work, but no Factory surface is free to take it.`;
  else if (queue.length > 0)
    because = `${queue.length} objective(s) queued behind ${workingCampaigns} working campaign(s), the limit being ${policy.maxActive}.`;
  else because = 'Nothing is queued and no campaign has a stage waiting.';

  const queued: LineQueued[] = [];
  for (const [index, entry] of queue.entries()) {
    const request = await getChangeRequest(entry.changeRequestId);
    const executableNow = policy.maxActive > 0 && index < room;
    queued.push({
      entry,
      objective: request?.objective ?? '',
      position: index + 1,
      executableNow,
      why:
        policy.maxActive === 0
          ? 'AUTO is off.'
          : executableNow
            ? `Priority ${entry.priority}; a slot is free, so the next pass starts it.`
            : `Priority ${entry.priority}; waits for one of ${policy.maxActive} slot(s) to free.`,
    });
  }

  return {
    at: nowIso,
    policy,
    auto: policy.maxActive > 0,
    executable: { queued: admissibleQueued, readyBins, total: executableTotal },
    active: { leasedBins, arriving, workingCampaigns },
    capacity: { freeSurfaces, surfaces },
    unexplainedIdle,
    because,
    campaigns,
    queue: queued,
  };
}

/* ------------------------------------------------------------------------- */
/* Idle as a fault on the ledger                                              */
/* ------------------------------------------------------------------------- */

let idleSince: number | null = null;

/** For tests: forget what the last observation saw. */
export function resetIdleObservation(): void {
  idleSince = null;
}

/**
 * Record when unexplained idle starts and ends.
 *
 * It is written only once it has lasted `IDLE_REPORT_AFTER_MS`, so a stage
 * boundary between two ticks does not become a fault, and only on a transition,
 * so the ledger holds intervals rather than a row every twenty seconds. The
 * previous state is read back from the ledger rather than trusted from memory,
 * because a restart must not open a second interval over one already open.
 */
export async function observeIdle(reading: LineReading, now: Date = new Date()): Promise<'STARTED' | 'ENDED' | null> {
  const events = await listFactoryEvents(null, {
    kinds: [LINE_EVENT_KINDS.idleStarted, LINE_EVENT_KINDS.idleEnded],
  });
  const last = events[events.length - 1];
  const open = last?.kind === LINE_EVENT_KINDS.idleStarted;

  if (!reading.unexplainedIdle) {
    idleSince = null;
    if (!open) return null;
    await recordFactoryEvent({
      kind: LINE_EVENT_KINDS.idleEnded,
      evidenceClass: 'MEASURED',
      detail: { because: reading.because, startedAt: last?.at ?? null },
    });
    return 'ENDED';
  }

  if (idleSince === null) idleSince = now.getTime();
  if (open || now.getTime() - idleSince < IDLE_REPORT_AFTER_MS) return null;
  await recordFactoryEvent({
    kind: LINE_EVENT_KINDS.idleStarted,
    evidenceClass: 'MEASURED',
    detail: {
      because: reading.because,
      executable: reading.executable,
      freeSurfaces: reading.capacity.freeSurfaces,
      observedSince: new Date(idleSince).toISOString(),
    },
  });
  return 'STARTED';
}

/**
 * One pass of the line: admit what may start, then take a reading and record
 * idle transitions. Returns the campaigns it started so the caller can tick them
 * and dispatch immediately rather than on the next wake.
 */
export async function runLinePass(now: Date = new Date()): Promise<{
  admission: AdmissionReport;
  reading: LineReading;
}> {
  const admission = await admitQueued();
  const reading = await readLine(now);
  await observeIdle(reading, now);
  return { admission, reading };
}

/** A campaign by id, for readers that only hold a queue entry. */
export async function campaignForEntry(entry: FactoryQueueEntry): Promise<FactoryCampaign | null> {
  return entry.campaignId ? getCampaign(entry.campaignId) : null;
}
