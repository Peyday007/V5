/**
 * From a captured idea to work Brain may actually start.
 *
 * Capture was connected. Everything after it was not. `applyJudgment` existed,
 * was tested, and had no production caller, so every captured candidate sat at
 * `priority = NULL` with an empty judgment — which is precisely what
 * `exploring()` and `nextLaunchable()` select against. No probe could open and
 * no mission could launch, whatever a person or a worker asked for. This module
 * is that missing middle.
 *
 * Three properties decide its shape.
 *
 * **The archive answers first, and it answers for free.** §13's default is not
 * to research. `coverBeforeWork` reads the project's own claims and can settle a
 * question with no model, no worker and no allowance — so it runs first, and a
 * candidate the archive already covers is judged and parked without anything
 * being dispatched. That is the cheapest correct outcome and it must never be
 * skipped in order to reach the interesting one.
 *
 * **The specification is compiled, not asked for.** This used to send the idea
 * to a subscription worker in a `RUSSELL_PLAN` bin and launch from whatever
 * came back. Three times, across two days, that worker answered with padded
 * placeholders, and Brain refused all three correctly and got nowhere. So
 * `services/russell/compiler.ts` writes the specification from rows: the
 * candidate, the person's own message, the project's archive answer, and the
 * limits of the approval envelope this project's standing authorization names.
 * Nothing about the world is asserted in it. Specifying is not researching, and
 * the research is still entirely the fleet's.
 *
 * **Brain keeps the decision.** `judge()` — deterministic, in code, unchanged —
 * turns the inputs into a priority and a state. `alreadyAnswered`, `supporting`
 * and `contradicting` come from `coverBeforeWork` against real claims. What no
 * longer arrives at all is a *view*: `cheapToReduce` and `expectedValue` were
 * the two genuinely semantic judgements a reader could make, and a compiler
 * cannot make them, so it makes neither and the judgment records them as
 * `NOT_ASSESSED` rather than as an opinion Brain never formed.
 *
 * The visible consequence of that is stated rather than hidden: nothing now
 * sends an idea to `EXPLORE` because a bounded look would be cheaper. The probe
 * path is untouched and is still reached the other way — the archive holding
 * claims that contradict the idea — and by a person's override.
 */

import { getCandidate, recordJudgment } from '../../repos/russellCandidates.ts';
import { getConversation } from '../../repos/russellConversations.ts';
import { getProject } from '../../repos/projects.ts';
import { listLayers } from '../../repos/layers.ts';
import { checkAuthority } from '../../repos/russellAuthority.ts';
import { coverBeforeWork } from './coverage.ts';
import {
  compileMission,
  MISSION_COMPILER_VERSION,
  type CompiledMission,
} from './compiler.ts';
import { judge, type JudgmentInputs } from './judgment.ts';
import { RESEARCH_WORK_CLASS } from './launch.ts';
import type { ExistingClaim, RussellCandidate } from '../../domain/types.ts';


export interface PlanObservations {
  /** Could a bounded look settle the uncertainty more cheaply than a packet? */
  cheapToReduce: boolean;
  /** How much settling this would move the project's goal, 0..100. */
  expectedValue: number;
  /** Something that must happen first, in the project's own words, or null. */
  blockedBy: string | null;
}

/** The specification a mission is launched from, once Brain accepts it. */
export interface MissionSpec {
  title: string;
  objective: string;
  assignment: string;
  whyNow: string;
  acceptableSources: string[];
  excludedSources: string[];
  evidence: string[];
  /**
   * The one question finishing this mission would obviously leave open.
   *
   * Optional, and it is the worker's call whether there is one — a mission
   * that settles its subject completely declares none, and inventing one to
   * fill the field would be Brain buying research nobody wanted.
   *
   * It is a declaration, not a launch. When the parent finishes accepted, this
   * becomes an ordinary idea against the parent's project, and it is judged
   * against the archive like any other — the archive the parent has just
   * changed. Invariant 13 applies to a follow-on exactly as it does to a first
   * question, so a follow-on the report already answered spends nothing.
   */
  followOn: { title: string; question: string; whyNow: string } | null;
}


export interface ArchiveAnswer {
  /** True when the project's own accepted claims settle it. */
  fullyAnswered: boolean;
  supporting: string[];
  /**
   * Claims the archive holds that argue *against* the idea.
   *
   * `CONTRADICTED` is one of the ten coverage statuses and it is the one that
   * changes the answer rather than the confidence: `judge()` sends a contested
   * idea for a cheap look before anything larger, which is exactly right and
   * was unreachable while this was hard-coded empty.
   */
  contradicting: string[];
  claimsConsidered: number;
}

/**
 * Ask the archive first.
 *
 * §13's rule at candidate scale: researching a requirement the project already
 * answers spends the allowance to learn something it knew. The candidate's own
 * statement becomes one proposed requirement — in memory, never persisted,
 * which is what `coverBeforeWork` is built for — and the verdict decides
 * whether anything further is worth asking.
 *
 * A project with no layers, or one whose claims cannot be read, returns
 * `fullyAnswered: false` with nothing supporting: **not answered** is the
 * honest reading of "we could not tell", and it leads to asking rather than to
 * parking work that may be needed.
 */
export async function askArchive(
  candidate: RussellCandidate,
  /**
   * Supplied by a caller that already read them; otherwise loaded.
   *
   * The same seam `coverBeforeWork` already exposes, and passed straight
   * through to it. It exists so the archive path can be exercised against real
   * coverage logic rather than a stub of it — the classifier is the part worth
   * testing, and a fake would test the fake.
   */
  claims?: ExistingClaim[],
): Promise<ArchiveAnswer> {
  const unknown: ArchiveAnswer = {
    fullyAnswered: false,
    supporting: [],
    contradicting: [],
    claimsConsidered: 0,
  };
  if (!candidate.projectId) return unknown;
  const layers = await listLayers(candidate.projectId);
  const layer = layers[0];
  if (!layer) return unknown;
  try {
    const coverage = await coverBeforeWork({
      projectId: candidate.projectId,
      layerId: layer.id,
      requirements: [
        {
          key: `candidate:${candidate.id}`,
          statement: candidate.statement,
        },
      ],
      ...(claims ? { claims } : {}),
    });
    return {
      fullyAnswered: coverage.fullyAnswered,
      supporting: coverage.answered.flatMap((verdict) => verdict.claimIds).slice(0, 20),
      contradicting: coverage.verdicts
        .filter((verdict) => verdict.status === 'CONTRADICTED')
        .flatMap((verdict) => verdict.claimIds)
        .slice(0, 20),
      claimsConsidered: coverage.claimsConsidered,
    };
  } catch {
    // A coverage check that cannot run is not evidence that nothing is covered,
    // and it is certainly not evidence that everything is. Unknown, and the
    // candidate goes on to be asked about properly.
    return unknown;
  }
}

/**
 * Whether the project may have research done for it at all.
 *
 * Read once and used twice: it decides whether a judgment can end anywhere
 * launchable, and it supplies the layer the mission would hang on. Both callers
 * need the same answer and asking twice invites them to disagree.
 *
 * A project with no standing authority is not a project whose ideas are
 * worthless — it is one where a person has not yet said what Russell may do.
 * That distinction is the difference between `PARKED` with an actionable reason
 * and `QUEUED` forever behind a launch that can never happen, which is the
 * "waiting for something nobody can resolve" defect §22 recorded three times.
 */
async function standingAuthority(projectId: string): Promise<{
  ok: boolean;
  /** Names what is missing, in words a person can act on. Null when fine. */
  blockedBy: string | null;
  layerId: string | null;
  authorizedBy: string | null;
}> {
  const layers = await listLayers(projectId);
  const layerId = layers[0]?.id ?? null;
  if (!layerId) {
    return { ok: false, blockedBy: 'this project having a layer to file the work under', layerId: null, authorizedBy: null };
  }
  const decision = await checkAuthority({ projectId, workClass: RESEARCH_WORK_CLASS });
  if (!decision.ok || !decision.goal) {
    return {
      ok: false,
      // The decision's own words when it has them: it already distinguishes no
      // standing authority from an expired one from a budget that is spent, and
      // restating that here in worse words would lose the distinction.
      blockedBy: decision.reason ?? 'a standing authority for research on this project',
      layerId,
      authorizedBy: null,
    };
  }
  return { ok: true, blockedBy: null, layerId, authorizedBy: decision.goal.createdByUserId ?? null };
}

export interface JudgeOutcome {
  /** True when the judgment produced a specification a mission can launch from. */
  launchable?: boolean;
  ok: boolean;
  reason: string;
  /** Set when a judgment was recorded. */
  priority: string | null;
  /** True when the archive settled it and nothing was dispatched. */
  answeredByArchive: boolean;
  /**
   * Always null now, and kept so callers and reports do not have to change.
   *
   * It named the planning bin a worker was sent. There is no planning bin: the
   * specification is compiled in this call, so there is nothing outstanding to
   * point at. `launchable` is what a caller wants instead.
   */
  binId: string | null;
}

/**
 * Judge one captured idea, and compile the work it implies.
 *
 * The order is the whole design. The archive is asked first because it is free
 * and because §13 says the default is not to research. Only a candidate the
 * project does *not* already answer is compiled at all.
 *
 * Synchronous, and that is the change. There is no bin, no dispatch and no
 * waiting: a captured idea is judged and specified inside one tick, so the
 * crash window this used to have — a plan bin out with a worker while the
 * candidate sat unjudged — no longer exists, and neither does the class of
 * defect where the answer came back and nothing opened it.
 *
 * Idempotent by the candidate's own state: a candidate that already carries a
 * priority is left alone unless this is one of the three passes allowed to
 * supersede one.
 */
export async function judgeCandidate(
  candidateId: string,
  options: {
    claims?: ExistingClaim[];
    /**
     * The cheap look, now that it has been taken.
     *
     * An idea reaches `EXPLORE` when the archive holds claims that argue
     * against it. The loop opens a probe, the probe settles, and this is what
     * reads the answer: the idea is judged again with the probe's verdict on
     * the record, and the judgment supersedes the `EXPLORE`.
     */
    afterProbe?: { probeId: string; outcome: string; explanation: string };
    /**
     * The run that produced nothing, now that it has ended.
     *
     * §15: a repair is planned from what failed. With a compiled specification
     * there is exactly one specification per idea, so what this pass can
     * legitimately do is narrower than it was and is stated plainly — it
     * recompiles, and `launch()` refuses the result if it is the specification
     * that already failed. A redo that repeats itself is therefore a refusal
     * with a reason rather than a second identical packet.
     */
    afterFailedMission?: { missionId: string; attempt: number; reason: string };
    /**
     * The mission whose specification this build no longer produces.
     *
     * Recovery, not repair. `rms_8e96b5f246464c069451`, `rms_91f7bda7a9964066b269`,
     * `rms_49ae5e29a42a49ffad71` and `rms_b37b8fe4688c46e0a48d` were all launched
     * from specifications the retired worker-planning subsystem wrote — three
     * placeholders and one padded placeholder. They are defects rather than
     * attempts at the idea, so recompiling over them consumes nothing: the rows
     * and their reasons stay exactly where they are, and `launch()` counts a
     * specification rather than a row.
     */
    afterRetiredPlanning?: { missionId: string; reason: string };
  } = {},
): Promise<JudgeOutcome> {
  const candidate = await getCandidate(candidateId);
  if (!candidate) return outcome(false, 'no such idea');
  if (candidate.state === 'MERGED') return outcome(false, 'that idea was merged into another one');

  /*
   * Which decisions may be superseded, and by what.
   *
   * A first pass judges an unjudged idea. A post-probe pass judges an idea
   * whose only verdict was "look at this cheaply first". A redo and a recovery
   * both judge an idea that is queued and whose run is over. Everything else —
   * `PARKED`, `REJECTED`, a person's override — is a decision, and a decision
   * is not re-taken because something happened beside it.
   */
  if (options.afterProbe) {
    if (candidate.priority !== 'EXPLORE' || candidate.state !== 'CAPTURED') {
      return outcome(false, 'this idea is not waiting on a cheap look');
    }
  } else if (options.afterFailedMission || options.afterRetiredPlanning) {
    if (candidate.state !== 'QUEUED') {
      return outcome(false, 'this idea is not queued for research');
    }
    if (candidate.overrideUserId) {
      return outcome(false, 'a person decided this idea, so Brain does not re-take it');
    }
  } else if (candidate.priority) {
    return outcome(false, 'already judged');
  }
  if (!candidate.projectId) return outcome(false, 'no project to judge it against');

  const archive = await askArchive(candidate, options.claims);
  if (archive.fullyAnswered) {
    /*
     * The cheapest correct answer, and the one this whole ordering exists for.
     *
     * `judge` turns `alreadyAnswered` into PARKED/REJECTED with a reason naming
     * why — so a person reading it sees "the project already answers this"
     * rather than an idea that silently vanished. Nothing is dispatched, no
     * allowance is touched, and the supporting claim ids are stored beside the
     * verdict so the conclusion can be checked.
     */
    const verdict = judge({ alreadyAnswered: true, supporting: archive.supporting });
    const recorded = await recordJudgment({
      candidateId: candidate.id,
      state: verdict.state,
      priority: verdict.priority,
      reason: verdict.reason,
      judgment: { ...verdict.inputs, decidedBy: 'ARCHIVE', claimsConsidered: archive.claimsConsidered },
      supporting: archive.supporting,
      contradicting: archive.contradicting,
    });
    return {
      ok: recorded,
      reason: verdict.reason,
      priority: verdict.priority,
      answeredByArchive: true,
      binId: null,
    };
  }

  const project = await getProject(candidate.projectId);
  if (!project) return outcome(false, 'the project this idea belongs to is gone');

  const compiled = await compileMission({
    candidate,
    project,
    archive: { claimsConsidered: archive.claimsConsidered, contradicting: archive.contradicting },
  });
  if (!compiled.ok) {
    /*
     * Refused, and recorded as refused rather than thrown away.
     *
     * A compiler refusal is a fact about the idea or about what this project is
     * authorized to research — the question names a jurisdiction nobody
     * authorized, or the project has no standing envelope at all. Those have
     * remedies, and a person can only act on one they can see, so the candidate
     * is parked carrying the reason instead of being left in a state that reads
     * as "nothing has happened yet".
     */
    const recorded = await recordJudgment({
      candidateId: candidate.id,
      state: 'PARKED',
      priority: 'PARKED',
      reason: `Brain could not specify this: ${compiled.reason}`,
      judgment: {
        decidedBy: 'COMPILER',
        compilerVersion: MISSION_COMPILER_VERSION,
        refusal: compiled.reason,
        claimsConsidered: archive.claimsConsidered,
      },
      supporting: archive.supporting,
      contradicting: archive.contradicting,
    });
    return {
      ok: recorded,
      reason: compiled.reason,
      priority: 'PARKED',
      answeredByArchive: false,
      binId: null,
    };
  }

  const authority = await standingAuthority(candidate.projectId);

  /*
   * Three inputs, and each supplies only what it can actually know.
   *
   * The archive says whether the project already answers the question and what
   * argues against it. The project's standing authority says whether research
   * may happen here at all — which is a dependency like any other, so it goes
   * in as `blockedBy` and `judge()` parks with a reason a person can act on.
   * And the compiler supplies neither of the two semantic observations,
   * deliberately: see the module comment.
   */
  const inputs: JudgmentInputs = {
    alreadyAnswered: false,
    supporting: archive.supporting,
    contradicting: archive.contradicting,
    cheapToReduce: false,
    blockedBy: authority.blockedBy ?? null,
  };
  const verdict = judge(inputs);

  /*
   * A mission specification is stored only for a verdict that could launch one.
   *
   * `nextLaunchable` reads `judgment.missionSpec`, so writing one onto a PARKED
   * or EXPLORE candidate would make a park launchable the moment somebody
   * changed its state by hand. The compiled specification is kept either way —
   * under a different key when it is not yet usable — because it is free to
   * recompute and useful to read.
   */
  const launchable = verdict.state === 'QUEUED';
  const spec = await missionSpecFor(candidate, compiled.mission);
  const recorded = await recordJudgment({
    candidateId: candidate.id,
    state: verdict.state,
    priority: verdict.priority,
    reason: verdict.reason,
    judgment: {
      ...verdict.inputs,
      decidedBy: 'COMPILER',
      compilerVersion: compiled.mission.compilerVersion,
      envelopeId: compiled.mission.envelopeId,
      jurisdiction: compiled.mission.jurisdiction,
      // Said out loud, because the alternative is a `false` and a `0` that read
      // as findings. Neither was assessed; nothing formed a view.
      cheapToReduceAssessed: 'NOT_ASSESSED',
      expectedValueAssessed: 'NOT_ASSESSED',
      claimsConsidered: archive.claimsConsidered,
      ...(options.afterProbe ? { afterProbe: options.afterProbe } : {}),
      ...(options.afterFailedMission ? { afterFailedMission: options.afterFailedMission } : {}),
      ...(options.afterRetiredPlanning
        ? { supersededRetiredPlanning: options.afterRetiredPlanning }
        : {}),
      ...(launchable && spec ? { missionSpec: spec } : { proposedMission: compiled.mission.spec }),
    },
    supporting: archive.supporting,
    contradicting: archive.contradicting,
  });

  return {
    ok: recorded,
    reason: verdict.reason,
    priority: verdict.priority,
    answeredByArchive: false,
    binId: null,
    launchable: launchable && Boolean(spec),
  };
}

function outcome(ok: boolean, reason: string): JudgeOutcome {
  return { ok, reason, priority: null, answeredByArchive: false, binId: null };
}


/**
 * Complete the compiled specification with the parts only Brain may decide.
 *
 * The compiler writes what a mission is *about*. Everything that decides what
 * it is *allowed to do* — the layer, the visibility, the approval envelope, the
 * human authorization behind it — is filled in here from rows.
 *
 * The envelope id comes from the compiler, which read it from a table keyed by
 * project slug in code. It used to be the literal string
 * `RUSSELL_STATE_LICENSING_V1` written on every Russell mission in every
 * project — an acceptance envelope for one licensing question about Florida and
 * California, with Michigan in its own `forbiddenScope`. So every genuine Deal
 * Dispatch idea was measured against limits for a different question about a
 * different place, and refused. §16 is satisfied either way, because neither
 * the compiler nor the packet defines the envelope: it names one.
 *
 * Returns null when the project has no standing authority or no layer to hang
 * the work on. That is not a failure of the specification; it is a fact about
 * the project, and the candidate is judged all the same.
 */
async function missionSpecFor(
  candidate: RussellCandidate,
  compiled: CompiledMission,
): Promise<Record<string, unknown> | null> {
  if (!candidate.projectId) return null;
  const authority = await standingAuthority(candidate.projectId);
  if (!authority.ok || !authority.layerId) return null;

  const conversation = candidate.conversationId
    ? await getConversation(candidate.conversationId)
    : null;

  const spec = compiled.spec;
  return {
    projectId: candidate.projectId,
    layerId: authority.layerId,
    conversationId: candidate.conversationId ?? null,
    visibility: candidate.visibility,
    title: spec.title,
    objective: spec.objective,
    assignment: spec.assignment,
    whyNow: spec.whyNow,
    acceptableSources: spec.acceptableSources,
    excludedSources: spec.excludedSources,
    evidence: spec.evidence,
    // Carried rather than acted on. Nothing reads it until the mission
    // finishes accepted, and what it produces then is an idea, not a mission.
    followOn: spec.followOn,
    workloadClass: 'RESEARCH',
    /*
     * The decomposition travels with the specification.
     *
     * `startPacket` places these as the packet's fragments instead of queueing
     * a `RESEARCH_PLAN` work item for a worker, so the packet arrives at the
     * approval gate already planned. That is the second half of removing the
     * worker from planning: leaving it would have meant a compiled mission
     * whose fragments were still whatever a worker chose to submit, which is
     * exactly what produced `test-placeholder-fragment`.
     */
    plan: compiled.fragments,
    // Brain started it, on the authority of the person who holds the goal. The
    // approver is never Russell and never a worker.
    startedBy: { kind: 'BRAIN', id: `russell:compiled:${candidate.id}` },
    // Named, not supplied: the envelope lives in code and the packet points at
    // it. See §16 — nobody hands over the limits their own plan is judged by.
    envelopeId: compiled.envelopeId,
    // The person whose standing authority this runs under. Read from the goal
    // row, falling back to the thread's owner — never Russell, never a worker.
    authorizedBy: authority.authorizedBy ?? conversation?.ownerUserId ?? '',
  };
}
