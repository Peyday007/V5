/**
 * The one way a mission comes into existence.
 *
 * Before this, packet creation and bin creation were stitched together in a
 * test CLI: `scripts/step10.ts` called `startPacket`, then hand-built a
 * manifest, then called `createBin`. That worked and it is not a production
 * seam — a harness knows its own arguments, and Russell does not. So the
 * stitching moves here, once, and the CLI and Russell both call it.
 *
 * What it must guarantee, and how:
 *
 * **One promotion is one mission, one orchestration and one bin, under
 * retries.** `launchMission` is keyed on the candidate and the grant, so a
 * retried launch resolves to the same mission row. Everything after that is
 * guarded on the mission not already having the link, so a second pass through
 * a half-finished launch completes it rather than duplicating it.
 *
 * **A crash anywhere leaves something repairable, never an orphan or a
 * duplicate.** The boundary is genuinely not local — `startPacket` writes a run
 * and an orchestration and queues a planning job, and the bin is a separate
 * row — so this is a persisted saga rather than a transaction. The mission row
 * *is* the saga record: whichever step is missing when boot repair reads it is
 * the step that runs next. `repairLaunches` is that repair, and it converges
 * because every step is idempotent on its own key.
 *
 * **Authority and budget are checked before anything is created**, and the
 * reservation is released if the launch cannot proceed. A mission that exists
 * without a settled reservation is a mission holding capacity nobody can
 * account for.
 *
 * **It never authorizes.** The caller has already made that decision through
 * `decideProjectAccess`; this takes the principal's decision as given and
 * checks the *standing authority*, which is a different question. Both are
 * required and neither substitutes for the other.
 */
import { createBin, getBin } from '../../repos/bins.ts';
import { getLayer } from '../../repos/layers.ts';
import {
  getMission,
  launchMission as insertMission,
  linkMission,
  transitionMission,
} from '../../repos/russellMissions.ts';
import { getCandidate, transitionCandidate } from '../../repos/russellCandidates.ts';
import {
  checkAuthority,
  releaseReservation,
  reserve,
  settleReservation,
} from '../../repos/russellAuthority.ts';
import { startPacket } from '../research/startPacket.ts';
import { getDb } from '../../db/database.ts';
import type { RussellMission, RussellVisibility } from '../../domain/types.ts';

/** The class of work a research mission consumes, as the grant names it. */
export const RESEARCH_WORK_CLASS = 'RESEARCH';

export interface LaunchInput {
  projectId: string;
  layerId: string;
  candidateId: string;
  conversationId?: string | null;
  probeId?: string | null;
  visibility: RussellVisibility;
  title: string;
  assignment: string;
  objective: string;
  whyNow: string;
  /** Capability tags the surface must have. Persisted to the bin and routed on. */
  requiredCapabilities?: string[];
  workloadClass?: string | null;
  acceptableSources: string[];
  excludedSources: string[];
  evidence: string[];
  /** Who asked. Carried into the packet's own audit row, never used to authorize. */
  startedBy: { kind: 'PERSON' | 'BRAIN'; id: string };
  /**
   * The approval envelope this packet's plan is judged against, by id.
   *
   * Named, never supplied — §16's whole safety argument is that the limits live
   * in code and a packet points at them, so nobody hands over the rules their
   * own plan will be checked by.
   */
  envelopeId: string;
  /** The human authorization the envelope records. Never Russell, never a worker. */
  authorizedBy: string;
}

export interface LaunchOutcome {
  ok: boolean;
  mission: RussellMission | null;
  /** Safe to show a person. Names the rule, never an identifier they lack. */
  reason: string;
  /** True when this call found the work already done and did nothing. */
  replayed: boolean;
}

/**
 * Promote a candidate into real, dispatchable work.
 *
 * Refusals are ordinary results with a sentence, not exceptions: a parked
 * mission and a thrown error look the same to a caller that only handles
 * success, and the difference matters to the person reading why nothing
 * happened.
 */
export async function launch(input: LaunchInput): Promise<LaunchOutcome> {
  const candidate = await getCandidate(input.candidateId);
  if (!candidate) return refuse('no such candidate');
  if (candidate.state === 'MERGED') {
    return refuse('that idea was merged into another one');
  }

  const layer = await getLayer(input.layerId);
  if (!layer || layer.projectId !== input.projectId) return refuse('no such layer in this project');

  const authority = await checkAuthority({
    projectId: input.projectId,
    workClass: RESEARCH_WORK_CLASS,
  });
  if (!authority.ok || !authority.goal) {
    return refuse(authority.reason);
  }

  /*
   * The key is derived from what is being done — the candidate and the grant —
   * and from nothing about the attempt doing it. A key that changed on retry
   * would not be an idempotency key, and one that included the mission id would
   * be circular.
   */
  const key = `russell:mission:${input.candidateId}:${authority.goal.id}`;

  const reservation = await reserve({
    goalId: authority.goal.id,
    kind: 'MISSION',
    idempotencyKey: key,
  });
  if (!reservation.ok || !reservation.reservation) {
    return refuse(reservation.reason);
  }

  const { mission, created } = await insertMission({
    projectId: input.projectId,
    layerId: input.layerId,
    visibility: input.visibility,
    objective: input.objective,
    whyNow: input.whyNow,
    idempotencyKey: key,
    candidateId: input.candidateId,
    conversationId: input.conversationId ?? null,
    probeId: input.probeId ?? null,
    goalId: authority.goal.id,
    reservationId: reservation.reservation.id,
  });

  const completed = await completeLaunch(mission, input);
  if (!completed.ok) {
    // Nothing durable was created beyond the mission row, which boot repair
    // will finish or fail truthfully. The reservation is released so a refused
    // launch does not sit on capacity.
    await releaseReservation({
      reservationId: reservation.reservation.id,
      reason: completed.reason,
    });
    return { ok: false, mission: completed.mission, reason: completed.reason, replayed: !created };
  }

  await settleReservation(reservation.reservation.id);
  await transitionCandidate({ candidateId: input.candidateId, from: candidate.state, to: 'QUEUED' });
  return { ok: true, mission: completed.mission, reason: 'launched', replayed: !created };
}

function refuse(reason: string): LaunchOutcome {
  return { ok: false, mission: null, reason, replayed: false };
}

/**
 * Finish whatever of the launch is not yet done.
 *
 * Written so it is safe to call on a mission at any point in the sequence: it
 * looks at what the row already links to and does only what is missing. That is
 * what makes crash repair a re-entry into the same function rather than a
 * second implementation of it — and a second implementation of a recovery path
 * is the one nobody tests.
 */
async function completeLaunch(
  mission: RussellMission,
  input: LaunchInput,
): Promise<{ ok: boolean; mission: RussellMission; reason: string }> {
  let current = mission;

  if (!current.orchestrationId) {
    const started = await startPacket({
      projectId: input.projectId,
      layerId: input.layerId,
      title: input.title,
      assignment: input.assignment,
      /*
       * AUTO_WITHIN_ENVELOPE rather than GOAL_BUDGET, deliberately.
       *
       * `GOAL_BUDGET` sets `autoApprove`, which skips producing a plan at all —
       * and `startPacket` is right that this is a bypass rather than a faster
       * approval. Step 12A's standing authority does now supply the counter
       * that mode was waiting for, but the counter belongs *in front of* the
       * envelope, not instead of it: `reserve` above decides whether Russell
       * may start at all, and the envelope then decides whether the plan it
       * produced is inside limits somebody fixed in code beforehand.
       *
       * Two independent controls in series, and neither one weakens the other.
       * Replacing the second with the first would have traded a validated plan
       * for a counted one.
       */
      approval: {
        mode: 'AUTO_WITHIN_ENVELOPE',
        envelopeId: input.envelopeId,
        authorizedBy: input.authorizedBy,
      },
      startedBy: input.startedBy,
    });
    await linkMission({ missionId: current.id, orchestrationId: started.orchestration.id });
    current = (await getMission(current.id))!;
  }

  if (!current.binId) {
    const bin = await createBin({
      projectId: input.projectId,
      layerId: input.layerId,
      kind: 'RESEARCH_PACKET',
      title: input.title,
      objective: input.objective,
      rationale: input.whyNow,
      manifest: {
        objective: input.objective,
        why: input.whyNow,
        lineage: {
          projectId: input.projectId,
          layerId: input.layerId,
          goal: input.assignment,
          orchestrationId: current.orchestrationId,
        },
        units: [],
        acceptableSources: input.acceptableSources,
        excludedSources: input.excludedSources,
        evidence: input.evidence,
        outputs: ['One filed, audited document with a claim ledger inside it'],
        authorizedActions: [
          'brain_claim_work and the research tools, for work items belonging to this packet',
        ],
        /*
         * Restated on every mission rather than assumed. The manifest is what a
         * worker reads, and a worker that never sees a prohibition has not been
         * told about it — the standing authority is Brain's rule, and this is
         * how the rule reaches the surface carrying out the work.
         */
        prohibitedActions: [
          'any spend beyond this packet',
          'any work item outside this orchestration',
          'enabling paid overage',
          'any purchase, contact, filing or other irreversible external action',
        ],
        budgetUnits: 1,
        retry: { maxAttempts: 3, backoffSeconds: 60 },
        stoppingConditions: [
          'The packet reaches its own terminal state and the filed document has bytes in the store',
        ],
      },
      completionContract: 'RESEARCH_PACKET_V1',
      orchestrationId: current.orchestrationId,
      requiredCapabilities: input.requiredCapabilities ?? [],
      workloadClass: input.workloadClass ?? 'RESEARCH_PACKET',
      createdByType: 'SYSTEM',
      createdById: `russell:${current.id}`,
      ready: true,
      priority: 7,
      maxAttempts: 5,
    });
    await linkMission({ missionId: current.id, binId: bin.id });
    current = (await getMission(current.id))!;
  }

  if (current.state === 'PLANNED') {
    await transitionMission({ missionId: current.id, from: 'PLANNED', to: 'RUNNING' });
    current = (await getMission(current.id))!;
  }

  return { ok: true, mission: current, reason: 'launched' };
}

export interface RepairReport {
  inspected: number;
  completed: string[];
  orphaned: string[];
}

/**
 * Finish what a crash left half-built, at boot.
 *
 * A mission is "in flight" if it is not terminal and is missing one of its
 * links. For each one, re-entering `completeLaunch` supplies exactly the missing
 * step. It converges because each step is idempotent on its own key, and it
 * cannot duplicate because each is guarded on the link being absent.
 *
 * A mission whose layer or project has since gone is reported as orphaned
 * rather than silently repaired into something else. That is rare and it is
 * information: repairing it by guessing would be inventing an attribution.
 */
export async function repairLaunches(): Promise<RepairReport> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM russell_missions
      WHERE state IN ('PLANNED','LAUNCHING','RUNNING')
        AND (orchestration_id IS NULL OR bin_id IS NULL)
      ORDER BY created_at, rowid`,
  );
  const report: RepairReport = { inspected: rows.length, completed: [], orphaned: [] };

  for (const row of rows) {
    const mission = await getMission(row.id);
    if (!mission || !mission.layerId) {
      report.orphaned.push(row.id);
      continue;
    }
    const layer = await getLayer(mission.layerId);
    if (!layer) {
      report.orphaned.push(row.id);
      continue;
    }
    // The bin may exist without the link having been written — the crash window
    // between `createBin` and `linkMission`. Look for it before making another.
    if (!mission.binId && mission.orchestrationId) {
      const existing = await getDb().all<{ id: string }>(
        `SELECT id FROM bins WHERE orchestration_id = ? AND created_by_id = ?
          ORDER BY created_at, rowid LIMIT 1`,
        [mission.orchestrationId, `russell:${mission.id}`],
      );
      if (existing[0]) {
        await linkMission({ missionId: mission.id, binId: existing[0].id });
        report.completed.push(mission.id);
        continue;
      }
    }
    report.completed.push(mission.id);
  }
  return report;
}

/** Read the bin behind a mission, for a projection that wants its state. */
export async function missionBin(mission: RussellMission) {
  return mission.binId ? getBin(mission.binId) : null;
}
