/**
 * Resuming a campaign whose process died, from rows alone.
 *
 * Nothing here claims work, integrates a diff or advances a unit through its
 * own state machine — that is the seed kernel's, in `repos/factory.ts`,
 * `repos/factoryFleet.ts` and `services/factory/{dispatch,integrate}.ts`, and it
 * stays untouched. This module only closes what a dead process left open,
 * using the primitives those files already expose:
 *
 *   * A `RUNNING` session whose unit no longer holds a live lease for it is a
 *     session whose process is gone, and is closed through `closeSession` —
 *     which already guards on `state = 'RUNNING'`, so a session a live worker
 *     is still updating is never touched by a concurrent recovery.
 *   * An expired unit lease is reclaimed through `sweepExpiredUnitLeases`,
 *     never by writing to `lease_generation` here.
 *   * A worktree is disk, not a row, and the seed kernel never removes one —
 *     so a finished campaign accumulates a full checkout per attempt forever
 *     unless something retires them. Retiring is safe only for a unit whose
 *     work is over (`INTEGRATED`, `CANCELLED`, `SUPERSEDED`, or `FAILED` with
 *     no attempts left), and only when it is clean: a dirty worktree might be
 *     the one piece of evidence a person still needs to look at.
 *   * A campaign's own `state` can be left describing a pipeline stage that
 *     nothing underneath it supports — the process that would have advanced it
 *     died first. That is corrected from what the unit rows actually show,
 *     through `patchCampaign`, and the correction is recorded as an event
 *     rather than made silently.
 *
 * Nothing is ever deleted: not a checkpoint, not an event, not a session, not a
 * finding, not an integration, not a unit. A campaign's history is exactly as
 * large after recovery as before it.
 */
import path from 'node:path';
import type {
  FactoryCampaign,
  FactoryCampaignState,
  FactorySession,
  FactoryWorkUnit,
} from '../../domain/factory.ts';
import {
  claimCampaignTick,
  factoryNow,
  getCampaign,
  listLiveCampaigns,
  listUnits,
  patchCampaign,
  releaseCampaignTick,
  sweepExpiredUnitLeases,
} from '../../repos/factory.ts';
import { closeSession, listSessions, recordFactoryEvent } from '../../repos/factoryFleet.ts';
import { campaignWorkspace, isDirty, listWorktrees, removeWorktree } from './git.ts';

/**
 * How long an unattached session — an ARCHITECT or REVIEWER pass, which has
 * no unit lease to compare against — may run before recovery treats its
 * process as gone.
 *
 * This must never be shorter than the longest such pass is actually allowed
 * to run: `DEFAULT_REVIEW_TIMEOUT_MS` (review.ts) and `DEFAULT_UNIT_TIMEOUT_MS`
 * (dispatch.ts) are both 25 minutes. `CAMPAIGN_TICK_LEASE_MS` (10 minutes) is
 * the wrong number to reuse here even though it is also a duration on this
 * campaign: it bounds how long one dispatcher may hold the *tick*, not how
 * long a worker may hold a session, and a second dispatcher claiming the tick
 * while the first is still mid-review must not read as the first one's
 * process having died. Matches the bound `abandonOrphanedSessions`
 * (repos/factoryFleet.ts) already uses for this same category of session, so
 * the two mechanisms agree instead of racing each other on different clocks.
 */
export const UNATTACHED_SESSION_STALE_MS = 90 * 60 * 1000;

export interface RecoveryOptions {
  /** The instant recovery reasons from. Defaults to the real clock. */
  now?: string;
  /** Where the repository lives. Worktree pruning is skipped without it. */
  repoRoot?: string;
  /** How long an unattached session may run before it counts as stale. Defaults to `UNATTACHED_SESSION_STALE_MS`. */
  staleAfterMs?: number;
  /**
   * Who is running this recovery, recorded on the campaign's tick lease while
   * `recoverAll` holds it. Meaningless to `recoverCampaign` called on its own,
   * since that path never takes the tick claim itself.
   */
  owner?: string;
}

export interface RecoveryReport {
  campaignId: string;
  /** RUNNING sessions closed as ABANDONED because their process is gone. */
  sessionsClosed: number;
  /** Expired unit leases reclaimed back to READY, for this campaign. */
  leasesReclaimed: number;
  /** Worktrees of terminal units removed from disk. */
  worktreesPruned: number;
  /** Worktrees that would have qualified but were left in place because they were dirty. */
  worktreesSkippedDirty: number;
  /** Set when the campaign's recorded state was patched back to what the units support. */
  stateRederived: { from: FactoryCampaignState; to: FactoryCampaignState } | null;
}

function emptyReport(campaignId: string): RecoveryReport {
  return {
    campaignId,
    sessionsClosed: 0,
    leasesReclaimed: 0,
    worktreesPruned: 0,
    worktreesSkippedDirty: 0,
    stateRederived: null,
  };
}

/**
 * Is this session's process actually gone?
 *
 * A session attached to a unit is alive exactly while that unit is still
 * `LEASED`, still names this session as its lease holder, and that lease has
 * not expired — three separate ways for the answer to be no, because a unit
 * can move on (implemented, failed, taken over by a later lease) without ever
 * updating the session row that started it.
 */
function attachedSessionIsDead(session: FactorySession, unit: FactoryWorkUnit | undefined, now: string): boolean {
  if (!unit) return true;
  if (unit.state !== 'LEASED') return true;
  if (unit.leaseSessionId !== session.id) return true;
  if (!unit.leaseExpiresAt || unit.leaseExpiresAt <= now) return true;
  return false;
}

/** A session with no unit — an architect or a reviewer — is bounded by age instead. */
function unattachedSessionIsDead(session: FactorySession, now: string, staleAfterMs: number): boolean {
  const startedMs = new Date(session.startedAt).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - startedMs > staleAfterMs;
}

function isTerminalForPruning(unit: FactoryWorkUnit): boolean {
  if (unit.state === 'INTEGRATED' || unit.state === 'CANCELLED' || unit.state === 'SUPERSEDED') return true;
  return unit.state === 'FAILED' && unit.attempt >= unit.maxAttempts;
}

const MID_PIPELINE_STATES: FactoryCampaignState[] = [
  'INTEGRATING',
  'REVIEWING',
  'REPAIRING',
  'VERIFYING',
  'ASSEMBLING',
];

/**
 * What the unit rows actually support, when the campaign claims to be past
 * `EXECUTING` but nothing underneath it agrees.
 *
 * Deliberately narrow: this is not a reimplementation of the campaign state
 * machine that lives in `loop.ts`, only the one correction a dead process can
 * leave behind — a mid-pipeline state with no unit that has reached it and at
 * least one still doing the work `EXECUTING` describes.
 */
function deriveExpectedState(
  campaign: FactoryCampaign,
  units: FactoryWorkUnit[],
): FactoryCampaignState | null {
  if (!MID_PIPELINE_STATES.includes(campaign.state)) return null;
  if (units.length === 0) return null;
  const anyImplementedOrBeyond = units.some((u) => u.state === 'IMPLEMENTED' || u.state === 'INTEGRATED');
  const anyStillExecuting = units.some(
    (u) => u.state === 'READY' || u.state === 'LEASED' || u.state === 'BLOCKED',
  );
  if (!anyImplementedOrBeyond && anyStillExecuting) return 'EXECUTING';
  return null;
}

/** Recover one campaign: close dead sessions, reclaim leases, prune worktrees, re-derive state. */
export async function recoverCampaign(
  campaignId: string,
  options: RecoveryOptions = {},
): Promise<RecoveryReport> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return emptyReport(campaignId);

  const now = options.now ?? factoryNow();
  const staleAfterMs = options.staleAfterMs ?? UNATTACHED_SESSION_STALE_MS;

  /* Step 1: close sessions a dead process left RUNNING. */
  const unitsBeforeSweep = await listUnits(campaignId);
  const unitsById = new Map(unitsBeforeSweep.map((u) => [u.id, u]));
  const sessions = await listSessions(campaignId);
  let sessionsClosed = 0;
  for (const session of sessions) {
    if (session.state !== 'RUNNING') continue;
    const dead = session.unitId
      ? attachedSessionIsDead(session, unitsById.get(session.unitId), now)
      : unattachedSessionIsDead(session, now, staleAfterMs);
    if (!dead) continue;
    const exitReason = session.unitId
      ? "The unit this session was running no longer holds a live lease for it; its process is gone."
      : 'No unit and no activity within the stale bound; reclaimed on recovery.';
    await closeSession(session.id, { state: 'ABANDONED', exitReason });
    sessionsClosed += 1;
  }

  /* Step 2: reclaim expired unit leases, through the existing sweep only. */
  await sweepExpiredUnitLeases();
  const unitsAfterSweep = await listUnits(campaignId);
  const afterById = new Map(unitsAfterSweep.map((u) => [u.id, u]));
  let leasesReclaimed = 0;
  for (const before of unitsBeforeSweep) {
    if (before.state !== 'LEASED') continue;
    const after = afterById.get(before.id);
    if (after && after.state === 'READY') leasesReclaimed += 1;
  }

  /* Step 3: prune terminal units' worktrees, only when told where the repository is. */
  let worktreesPruned = 0;
  let worktreesSkippedDirty = 0;
  if (options.repoRoot) {
    const repoRoot = options.repoRoot;
    const onDisk = new Set((await listWorktrees(repoRoot)).map((w) => path.resolve(w.path)));
    for (const unit of unitsAfterSweep) {
      if (!isTerminalForPruning(unit)) continue;
      const highestAttempt = Math.max(unit.attempt, 1);
      for (let attempt = 1; attempt <= highestAttempt; attempt += 1) {
        const candidate = path.join(campaignWorkspace(campaign.id), `${unit.unitKey}-a${attempt}`);
        if (!onDisk.has(path.resolve(candidate))) continue;
        let dirty = true;
        try {
          dirty = await isDirty(candidate);
        } catch {
          dirty = true; // unreadable is not provably clean; never remove on a guess
        }
        if (dirty) {
          worktreesSkippedDirty += 1;
          continue;
        }
        if (await removeWorktree(repoRoot, candidate)) worktreesPruned += 1;
      }
    }
  }

  /* Step 4: re-derive the campaign's own state from what the units now show. */
  let stateRederived: RecoveryReport['stateRederived'] = null;
  if (campaign.state !== 'COMPLETE' && campaign.state !== 'CANCELLED') {
    const expected = deriveExpectedState(campaign, unitsAfterSweep);
    if (expected && expected !== campaign.state) {
      await patchCampaign(campaignId, { state: expected });
      await recordFactoryEvent({
        campaignId,
        kind: 'CAMPAIGN_RECOVERED',
        evidenceClass: 'DERIVED',
        detail: {
          from: campaign.state,
          to: expected,
          sessionsClosed,
          leasesReclaimed,
          worktreesPruned,
        },
      });
      stateRederived = { from: campaign.state, to: expected };
    }
  }

  return {
    campaignId,
    sessionsClosed,
    leasesReclaimed,
    worktreesPruned,
    worktreesSkippedDirty,
    stateRederived,
  };
}

/**
 * Recover every campaign a tick would otherwise look at. Never calls the
 * dispatcher or the scheduler.
 *
 * `recoverCampaign` mutates the same rows — units, sessions, the campaign's
 * own state — a live tick is free to mutate at any moment, and its only
 * previous caller (`runTick`) was safe only because it always ran after that
 * campaign's own tick claim already excluded every other dispatcher. Calling
 * it here, independently of any particular tick, is safe on the identical
 * condition: each campaign's tick is claimed before it is recovered, and
 * released immediately after. A campaign whose tick another dispatcher
 * currently holds is left alone rather than recovered out from under it —
 * that dispatcher's own tick already recovers it, right after claiming — so
 * this can under-recover a live campaign and can never race one.
 */
export async function recoverAll(options: RecoveryOptions = {}): Promise<RecoveryReport[]> {
  const owner = options.owner ?? `recover-all-${process.pid}`;
  const campaigns = await listLiveCampaigns();
  const reports: RecoveryReport[] = [];
  for (const campaign of campaigns) {
    const claim = await claimCampaignTick(campaign.id, owner);
    if (!claim.ok) continue;
    try {
      reports.push(await recoverCampaign(campaign.id, options));
    } finally {
      await releaseCampaignTick(campaign.id, owner, claim.generation);
    }
  }
  return reports;
}
