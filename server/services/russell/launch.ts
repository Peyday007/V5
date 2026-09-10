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
import { createHash } from 'node:crypto';
import { createBin, getBin } from '../../repos/bins.ts';
import { getLayer } from '../../repos/layers.ts';
import {
  countMissionsForCandidate,
  getMission,
  latestMissionForCandidate,
  specificationsTried,
  launchMission as insertMission,
  linkMission,
  transitionMission,
} from '../../repos/russellMissions.ts';
import { getCandidate, transitionCandidate } from '../../repos/russellCandidates.ts';
import {
  checkAuthority,
  releaseReservation,
  reserve,
} from '../../repos/russellAuthority.ts';
import { placePlan, startPacket } from '../research/startPacket.ts';
import { advancePacket } from '../research/packetRunner.ts';
import { getOrchestration, listFragments } from '../../repos/research.ts';
import type { PlannedFragment } from './compiler.ts';
import {
  separationCapacity,
  separationShortfall,
} from '../research/auditAdmission.ts';
import type { SeparationTier } from '../research/independence.ts';
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
  /**
   * A stronger audit separation than the contract's floor, for this mission only.
   *
   * Absent means the floor, which is `SESSION` and which every healthy fleet can
   * supply. Present and unavailable parks *this* mission and nothing else: no
   * other mission is affected, no global state is degraded, and the park lifts by
   * itself on the tick after the missing capability is registered.
   */
  requiredSeparation?: SeparationTier;
  workloadClass?: string | null;
  acceptableSources: string[];
  excludedSources: string[];
  evidence: string[];
  /**
   * The decomposition, compiled with the specification.
   *
   * Present means the packet arrives planned and `startPacket` places these as
   * its fragments; absent means it queues a `RESEARCH_PLAN` work item and a
   * worker proposes them, which is still how Step 9's and Step 10's packets
   * work. Russell's always carry one, because the planning a worker did here is
   * the subsystem that was replaced.
   */
  plan?: PlannedFragment[];
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
  /**
   * When a ceiling refused it, which one — carried through from `reserve`.
   *
   * `AT_ONCE` is a wait and nobody is needed. `IN_TOTAL` is a wall that only a
   * person can move, and it must reach one.
   */
  refusedBy?: 'IN_TOTAL' | 'AT_ONCE';
  /**
   * A named refusal the loop acts on rather than a sentence it matches.
   *
   * `ALREADY_RESEARCHED` is the one that needs an answering transition: the
   * idea's only specification has been researched and did not produce a report,
   * so nothing further will happen to it and leaving it `QUEUED` would be a
   * silent stall on every tick for ever.
   */
  kind?: 'ALREADY_RESEARCHED';
}

/**
 * Promote a candidate into real, dispatchable work.
 *
 * Refusals are ordinary results with a sentence, not exceptions: a parked
 * mission and a thrown error look the same to a caller that only handles
 * success, and the difference matters to the person reading why nothing
 * happened.
 */
/**
 * How many times one idea may be researched before Brain stops trying.
 *
 * Three, matching `MAX_FRAGMENT_ATTEMPTS` and the turn retry ceiling, because
 * the reasoning is identical: a second try is a repair and a third is the last
 * evidence that the approach is wrong rather than the run unlucky. Beyond it
 * the refusal names the count, so a person reading the idea sees why it
 * stopped rather than an idea that quietly went nowhere.
 *
 * It is the protection against a redo loop. Nothing else bounds it: the grant
 * is uncapped by design, and concurrency only decides how many run at once.
 */
export const MAX_MISSION_ATTEMPTS = 3;

/**
 * A backstop on how many mission rows one idea may accumulate, and nothing else.
 *
 * The real bound is one mission per specification, above. This exists so that a
 * defect that somehow produced a new specification on every tick could not
 * write rows for ever, and it is deliberately generous: reaching it means
 * something is wrong with the compiler rather than with the idea, and the
 * refusal says so instead of implying a judgement about the work.
 */
export const MAX_MISSION_ROWS = 8;

/**
 * What "the same specification" means, in one place.
 *
 * Objective and reason-now together: what a mission was launched to establish
 * and why it was worth doing then. The loop compares a candidate's compiled
 * specification against this to tell a mission the retired planning subsystem
 * wrote from one this build produces, and `launch()` refuses a repeat. Two
 * callers deciding "already researched" by two rules is how they come to
 * disagree, so there is one rule and both import it.
 */
export function specificationKey(objective: string, whyNow: string): string {
  return `${objective}\n${whyNow}`;
}

/** A short, stable id for one specification, for use inside an idempotency key. */
function specKey(spec: string): string {
  return createHash('sha256').update(spec, 'utf8').digest('hex').slice(0, 12);
}

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
   * A stronger tier is checked before anything is reserved or created.
   *
   * Parking costs nothing and holds nothing — the candidate stays queued and
   * the next tick asks again — so the honest order is to find out first. The
   * reason is the exact missing capability rather than a status, because
   * "blocked" that names no remedy is the defect §22 recorded three times.
   */
  if (input.requiredSeparation) {
    const shortfall = separationShortfall(input.requiredSeparation, await separationCapacity());
    if (shortfall) return refuse(shortfall);
  }

  /*
   * The key is derived from what is being done — the candidate, the grant, and
   * which try this is.
   *
   * It used to be the candidate and the grant alone, and that was one word too
   * few. `launchMission` inserts `ON CONFLICT (idempotency_key) DO NOTHING`, so
   * a fixed key meant a candidate got exactly **one** mission for the life of
   * its grant: once that mission ended — cancelled by its owner, failed, or
   * parked having produced nothing — the idea could never be researched again.
   * The loop went on selecting it as QUEUED every tick and went on re-finding
   * the same dead row. One bad packet retired an idea permanently, which is
   * §24's missing answering transition at a fourth altitude.
   *
   * The attempt is **derived here from the rows**, never passed in, so a caller
   * cannot choose to spend a second mission and a retry of the same tick cannot
   * become a second one.
   *
   * **What counts is a specification, not a row**, and that correction is
   * recorded rather than quietly applied. The first version of this counted
   * `attempt` on the previous mission, and production showed why that is
   * wrong within four minutes of deployment. `redoable()` creates a re-plan
   * bin asynchronously; `nextLaunchable()` in the same tick still saw the
   * candidate QUEUED carrying its **old** `missionSpec` and launched from it.
   * So `rcn_85f9689b461c4972a1ba` was researched three times between 00:51:29
   * and 00:55:58 on 2026-09-09 under one specification — the §54.2 placeholder,
   * whose every field is the word `test` — and the ceiling was spent on one
   * approach repeated, with nothing learned and nothing filed.
   *
   * §15 already says what that is: *a retry is not a repair*, and no repair may
   * repeat a strategy an earlier attempt already tried. So the ceiling counts
   * **distinct specifications**, and a specification already tried is refused
   * outright rather than launched. A redo therefore waits — silently and
   * correctly — until its re-plan lands and produces a specification that is
   * genuinely different, which is exactly the behaviour §15 asks for.
   *
   *   - no previous mission        -> the key is exactly what it has always
   *                                   been, so every row written before
   *                                   migration 033 keeps its identity;
   *   - a previous one still live  -> replay that row on its own key, which is
   *                                   what makes a repeated tick safe;
   *   - a specification tried      -> refused, however many rows exist;
   *   - a genuinely new one        -> a new mission, up to the ceiling.
   *
   * A mission that reached `DONE` is not redone: the idea was answered, and
   * answering it again is the waste §13 exists to prevent.
   */
  const previous = await latestMissionForCandidate(input.candidateId);
  if (previous?.state === 'DONE') {
    return refuse('that idea has already been researched');
  }

  let key: string;
  let attempt: number;
  let supersedes: string | null = null;
  // `DONE` returned above, so what is left is live or spent.
  const live =
    previous !== null && previous.state !== 'FAILED' && previous.state !== 'CANCELLED';

  if (live && previous) {
    // Its own key, so this replays the row that exists rather than deriving a
    // key that might no longer match how that row was made.
    key = previous.idempotencyKey;
    attempt = previous.attempt;
  } else {
    const tried = await specificationsTried(input.candidateId);
    const spec = specificationKey(input.objective, input.whyNow);
    /*
     * One mission per specification, and that is now the whole of the ceiling.
     *
     * §15 forbids a repair that repeats a strategy an earlier attempt already
     * tried. With a compiled specification there is exactly one specification
     * per idea, so "already researched" and "out of attempts" became the same
     * sentence — and the count they used to share was doing harm rather than
     * work. Production's idea had three mission rows against
     * `MAX_MISSION_ATTEMPTS` of three, every one of them a placeholder the
     * retired planning subsystem wrote; counting them would have left a real
     * specification with nowhere to go because of defects in the thing that
     * produced them.
     *
     * So specifications no compiler produces neither count nor block. What
     * legitimately yields a second attempt at an idea is the compiler changing,
     * which is a reviewed code change, or the idea's own text changing, which
     * is a person's. `MAX_MISSION_ROWS` is underneath both as a runaway guard
     * and nothing else — it is not an evidence rule and it is not a budget.
     */
    if (tried.includes(spec)) {
      return refuse(
        'this specification has already been researched',
        undefined,
        'ALREADY_RESEARCHED',
      );
    }
    const rows = await countMissionsForCandidate(input.candidateId);
    if (rows >= MAX_MISSION_ROWS) {
      return refuse(
        `this idea already has ${rows} mission rows, which is the runaway guard rather than a ` +
          'judgement about the work',
        'IN_TOTAL',
      );
    }
    attempt = tried.length + 1;
    /*
     * A new specification gets a key derived from it. The first one keeps the
     * plain key it has always had, so nothing already written is re-identified;
     * every later one is keyed by its own content, which is what an idempotency
     * key is for — the same specification twice is the same mission, and a
     * different one is a different mission.
     */
    key =
      tried.length === 0
        ? `russell:mission:${input.candidateId}:${authority.goal.id}`
        : `russell:mission:${input.candidateId}:${authority.goal.id}:${specKey(spec)}`;
    supersedes = previous?.id ?? null;
  }

  const reservation = await reserve({
    goalId: authority.goal.id,
    kind: 'MISSION',
    idempotencyKey: key,
  });
  if (!reservation.ok || !reservation.reservation) {
    return refuse(reservation.reason, reservation.refusedBy);
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
    attempt,
    // The row this replaces, so "why was this researched twice" is one join
    // rather than a guess from timestamps. Null on a first attempt.
    supersedesMissionId: supersedes,
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

  /*
   * The reservation is **not** settled here, and that is the fix rather than an
   * omission.
   *
   * It used to be, one line after the mission existed — so a mission's
   * reservation was `HELD` for the length of this function and `SETTLED` for
   * the entire time the mission actually ran. `maxConcurrent` counts live
   * `HELD` rows, so it counted a state no running mission was ever in: the
   * owner's "one at a time" refused two launches in the same instant and never
   * two missions running at once.
   *
   * Settling is what *finishing* does, and `transitionMission` does it on every
   * terminal move. The hold now spans exactly the mission's live span, which is
   * what a concurrency limit is about.
   */
  await transitionCandidate({ candidateId: input.candidateId, from: candidate.state, to: 'QUEUED' });
  return { ok: true, mission: completed.mission, reason: 'launched', replayed: !created };
}

function refuse(
  reason: string,
  refusedBy?: 'IN_TOTAL' | 'AT_ONCE',
  kind?: 'ALREADY_RESEARCHED',
): LaunchOutcome {
  return {
    ok: false,
    mission: null,
    reason,
    replayed: false,
    ...(refusedBy ? { refusedBy } : {}),
    ...(kind ? { kind } : {}),
  };
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
/**
 * Bin states from which no assignment can ever be made again.
 *
 * A packet's claimable work reaches a worker inside a bin. A bin in one of
 * these states is not dispatchable and cannot be assigned, so a packet whose
 * bin is here while its own queue still holds work is a packet nothing can be
 * sent for — the queue says the items are claimable, the fleet has nowhere to
 * put them, and every state column reads as healthy.
 */
const SPENT_BIN: ReadonlySet<string> = new Set(['COMPLETE', 'FAILED', 'CANCELLED']);

/**
 * Packet states in which work *should* be moving, so a spent bin is a fault.
 *
 * `AWAITING_APPROVAL` and `NEEDS_HUMAN` are deliberately absent: those are
 * waiting for a person and each already has its own answering transition. A
 * new bin would put a worker in front of a decision only a person can make,
 * which is the opposite of the repair.
 */
const PACKET_SHOULD_BE_RUNNING: ReadonlySet<string> = new Set([
  'PLANNING',
  'RESEARCHING',
  'VERIFYING',
  'SYNTHESIZING',
  'AUDITING',
  'AWAITING_REPAIR',
]);

/**
 * Whether this mission's bin can still deliver its packet's outstanding work.
 *
 * Read rather than remembered, because `bins.state` moves after the mission
 * row was written and the mission has no column that would notice.
 */
async function binCanStillDeliver(mission: RussellMission): Promise<boolean> {
  if (!mission.binId) return false;
  const bin = await getBin(mission.binId);
  if (!bin) return false;
  return !SPENT_BIN.has(bin.state);
}

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
      ...(input.plan ? { plan: input.plan } : {}),
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
      /*
       * The mission points at the orchestration before the plan is placed.
       *
       * `createFragments` charges the fragments to the standing authority of
       * whichever Russell mission points at the orchestration. Linking after
       * the fragments existed would charge them to nothing, and the reservation
       * rows the owner is shown as spend would quietly stop being written for
       * every compiled packet.
       */
      attach: async (orchestrationId: string) => {
        await linkMission({ missionId: current.id, orchestrationId });
      },
    });
    current = (await getMission(current.id))!;
  }

  /*
   * A plan that was promised and is not there yet.
   *
   * The ordinary path places it inside `startPacket`. This is the crash window:
   * the orchestration was created, the process died before the fragments were
   * written, and the packet now looks unplanned — so the next advance would
   * queue a `RESEARCH_PLAN` work item and a worker would propose the
   * decomposition, which is the subsystem this replaced. Re-entering finishes
   * it instead, and does nothing at all on the ordinary path.
   */
  if (input.plan && input.plan.length > 0 && current.orchestrationId) {
    /*
     * Asked before anything is done, and that ordering is the whole guard.
     *
     * `launch()` is re-entered on every tick while a mission is live, so this
     * block runs constantly. An earlier version called `placePlan`
     * unconditionally and advanced when the counts lined up — and `placePlan`
     * returns the fragments that are already there, so on the ordinary path it
     * advanced the packet again on every pass. That is not harmless: an advance
     * runs the approval gate, so a fragment a person had not approved yet was
     * approved by a replay of a launch that had already happened.
     */
    const existing = await listFragments(current.orchestrationId);
    if (existing.length === 0) {
      const orchestration = await getOrchestration(current.orchestrationId);
      if (orchestration) {
        await placePlan(orchestration, input.plan);
        await advancePacket(orchestration.id);
      }
    }
  }

  /*
   * No bin, or one that can no longer deliver anything.
   *
   * The guard used to be `!current.binId` alone, which is right exactly while a
   * bin outlives its packet. It does not always: a bin reaches `COMPLETE` when
   * `RESEARCH_PACKET_V1` is satisfied, and the packet can be put back to work
   * afterwards — an `OTHER_LAYER` handoff reopens the audit round on a packet
   * that had finished, and `advancePacket` queues the round's items. The bin is
   * terminal and terminal is forever, so the reopened round's items sit
   * claimable with nobody ever sent for them.
   *
   * §24's sentence at a fourth altitude, and the third fix covered exactly one
   * state of it: `reopenAuditRound` reopens a bin parked at `NEEDS_HUMAN`, and
   * says nothing about one that completed. So the condition is the property
   * rather than the state — can this bin still deliver work — and the remedy is
   * the bin the launch already knows how to build.
   *
   * Nothing is reset and nothing is destroyed: the spent bin keeps its row, its
   * attempts, its events and its `created_by_id`, and the mission's pointer
   * moves to the one that can actually be assigned. The bound is the work
   * items' own attempt counters, which are unchanged — a packet whose items are
   * spent goes terminal by itself and stops qualifying, so this cannot loop and
   * adds no ceiling of its own.
   */
  if (!(await binCanStillDeliver(current))) {
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
    /*
     * Three shapes, not two.
     *
     * The first two are the crash windows this was written for: an orchestration
     * or a bin the launch never got as far as creating. The third is a mission
     * that launched perfectly and whose bin has since been spent while its
     * packet still holds claimable work — which no crash produces and which the
     * ordinary path reaches, because a bin completes when its packet does and a
     * packet can be put back to work afterwards.
     *
     * The packet's status is part of the condition rather than checked later:
     * a packet waiting for a person must not have a worker sent to it, and both
     * of those states already have their own answering transition.
     */
    `SELECT m.id FROM russell_missions m
      WHERE m.state IN ('PLANNED','LAUNCHING','RUNNING')
        AND (
          m.orchestration_id IS NULL
          OR m.bin_id IS NULL
          OR EXISTS (
            SELECT 1
              FROM bins b
              JOIN research_orchestrations o ON o.id = m.orchestration_id
             WHERE b.id = m.bin_id
               AND b.state IN ('COMPLETE','FAILED','CANCELLED')
               AND o.status IN ('PLANNING','RESEARCHING','VERIFYING','SYNTHESIZING','AUDITING','AWAITING_REPAIR')
               AND EXISTS (
                 SELECT 1 FROM work_items w
                  WHERE w.orchestration_id = m.orchestration_id
                    AND w.state IN ('QUEUED','LEASED')
               )
          )
        )
      ORDER BY m.created_at, m.rowid`,
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

    /*
     * The bin may exist without the link having been written — the crash
     * window between `createBin` and `linkMission`. Look for it before making
     * another, or the repair is the thing that creates the duplicate.
     */
    if (!mission.binId && mission.orchestrationId) {
      // A bin that can still be assigned, and only that one. After a re-bin
      // the mission's earlier bins are still here with the same
      // `created_by_id`, and linking a spent one would undo the repair.
      const existing = await getDb().all<{ id: string }>(
        `SELECT id FROM bins
          WHERE orchestration_id = ? AND created_by_id = ?
            AND state NOT IN ('COMPLETE','FAILED','CANCELLED')
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [mission.orchestrationId, `russell:${mission.id}`],
      );
      if (existing[0]) {
        await linkMission({ missionId: mission.id, binId: existing[0].id });
        report.completed.push(mission.id);
        continue;
      }
    }

    /*
     * Re-enter the same function that built it.
     *
     * The specification is not on the mission row and does not need to be: it
     * is the candidate's own recorded judgment, which is the identical source
     * the loop launches from. So repair asks the same question the launch
     * asked, gets the same answer, and `completeLaunch` supplies exactly the
     * steps that are missing — a re-entry rather than a second implementation,
     * and a second implementation of a recovery path is the one nobody tests.
     *
     * A mission whose candidate or specification has gone is genuinely
     * unrepairable, and is reported as orphaned rather than marked finished.
     * Calling it complete because there was nothing to do would be the
     * "waiting for a person who cannot resolve it" defect again: a stranded
     * mission that every future repair pass reports as healthy.
     */
    const spec = await specFor(mission);
    if (!spec) {
      report.orphaned.push(mission.id);
      continue;
    }
    const finished = await completeLaunch(mission, { ...spec, candidateId: mission.candidateId ?? '' });
    if (finished.ok) report.completed.push(mission.id);
    else report.orphaned.push(mission.id);
  }
  return report;
}

/**
 * The launch specification behind a mission, from the candidate's judgment.
 *
 * Read rather than remembered, and validated for the parts `completeLaunch`
 * cannot do without. A partial specification is refused outright: repairing a
 * packet with an invented assignment or an absent envelope would produce work
 * nobody authorized, which is worse than leaving it visibly stuck.
 */
async function specFor(mission: RussellMission): Promise<Omit<LaunchInput, 'candidateId'> | null> {
  if (!mission.candidateId) return null;
  const candidate = await getCandidate(mission.candidateId);
  if (!candidate) return null;
  const spec = (candidate.judgment as Record<string, unknown>)['missionSpec'];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const typed = spec as Partial<LaunchInput>;
  if (
    typeof typed.projectId !== 'string' ||
    typeof typed.layerId !== 'string' ||
    typeof typed.title !== 'string' ||
    typeof typed.assignment !== 'string' ||
    typeof typed.envelopeId !== 'string'
  ) {
    return null;
  }
  // The mission's own project and layer win over the specification's, because
  // the row is what everything else already links to. A specification that
  // disagrees is a specification for a different mission.
  return {
    ...(typed as Omit<LaunchInput, 'candidateId'>),
    projectId: mission.projectId,
    layerId: mission.layerId ?? typed.layerId,
  };
}

/** Read the bin behind a mission, for a projection that wants its state. */
export async function missionBin(mission: RussellMission) {
  return mission.binId ? getBin(mission.binId) : null;
}
