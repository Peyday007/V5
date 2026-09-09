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
 * **What only a reader of the question can judge is asked of a worker, never
 * guessed.** Whether uncertainty is cheap to reduce, what a mission would
 * actually have to establish, what it is worth — these are semantic and Brain
 * has no model of its own. They are asked through the subscription fleet, the
 * same bin path a conversation turn already uses, and the answer is validated
 * with the same zero trust `validateProposal` applies. §8: a model proposes and
 * the server decides.
 *
 * **Brain keeps the decision.** The worker supplies observations; `judge()` —
 * deterministic, in code, unchanged — turns them into a priority and a state.
 * `alreadyAnswered`, `supporting` and `contradicting` are *never* taken from the
 * worker: they come from `coverBeforeWork` against real claims, because a model
 * asked whether the archive already answers something has every incentive to
 * say no. The inputs are stored beside the verdict, so a judgment can be read
 * back and argued with.
 *
 * What is missing stays missing. There is no `judge({})` anywhere in this file:
 * a candidate with no coverage answer and no worker observations is left
 * unjudged, which reads as "nothing has happened yet" rather than as an opinion
 * Brain never formed.
 */
import { createBin, getBin, listBinUnitResults } from '../../repos/bins.ts';
import { getCandidate, recordJudgment } from '../../repos/russellCandidates.ts';
import { getConversation } from '../../repos/russellConversations.ts';
import { listLayers } from '../../repos/layers.ts';
import { checkAuthority } from '../../repos/russellAuthority.ts';
import { getDb } from '../../db/database.ts';
import { parseJson } from '../../repos/util.ts';
import { coverBeforeWork } from './coverage.ts';
import { judge, type JudgmentInputs } from './judgment.ts';
import { RESEARCH_WORK_CLASS, specificationKey } from './launch.ts';
import { specificationsTried } from '../../repos/russellMissions.ts';
import type { BinManifest, ExistingClaim, RussellCandidate } from '../../domain/types.ts';

/** The one unit a planning bin asks for. */
export const PLAN_UNIT_KEY = 'plan';

/** The contract its completion is evaluated against. */
export const PLAN_CONTRACT = 'RUSSELL_PLAN_V1';

/** How a planning bin is addressed back to its candidate. */
export const PLAN_CREATED_BY = 'russell:plan:';
/**
 * The separator marking a second, post-probe planning pass.
 *
 * A colon-delimited suffix rather than a different prefix, so `applyPlan` still
 * recovers the candidate from the bin by taking everything before it — one
 * parse, one place, and a bin whose key it cannot read is not a plan.
 */
export const PLAN_AFTER_PROBE = ':probed:';

/**
 * The separator marking a third planning pass, after a run that produced
 * nothing. Same shape and same reason as the post-probe one: `planTarget`
 * recovers the candidate by taking everything before whichever marker it
 * finds, so one parse still reads every kind of plan bin.
 */
export const PLAN_AFTER_FAILURE = ':redo:';

/**
 * Bounds on what a worker may say, enforced exactly.
 *
 * Stated on the manifest as well as enforced here — the lesson this seam has
 * already taught twice is that a rule the worker is not told is a trap rather
 * than a rule.
 */
export const PLAN_LIMITS = {
  title: 200,
  objective: 2_000,
  assignment: 4_000,
  whyNow: 1_000,
  blockedBy: 300,
  source: 200,
  evidenceLine: 500,
  listItems: 12,
} as const;

/**
 * The other end of those bounds, and the more important one.
 *
 * Every field above had a maximum and no minimum, so a mission specification of
 * `{title: 'test', objective: 'test', assignment: 'test', whyNow: 'test'}`
 * passed validation completely. On 2026-09-07 one did: the judgment pass for
 * S12A-ACC-2 produced exactly that, Brain accepted it, reserved a mission and
 * twelve fragments against the owner's standing authority, created an
 * orchestration and a bin, and fired the fleet. The next worker read the
 * manifest and released it three times — "This packet's own manifest is
 * corrupted placeholder content", then "Same corrupted orchestration as
 * before", then "Third release of the same corrupted orchestration" — the
 * planning item failed, and the packet parked for a person.
 *
 * Every part of that behaved correctly except the one that let it start. The
 * worker was right, `requestCompletion` was right to refuse to file, and the
 * park was right to happen. What was missing was the check that a thing being
 * spent on is an assignment at all.
 *
 * §12 already holds this rule for the other producer of prose: a provider
 * returning placeholder content "declares `placeholder: true` and is refused
 * for staged research outright". Brain applied it to a provider's output and
 * not to a worker's plan.
 *
 * **This is a floor, not a judgement of quality.** It asks whether there is an
 * assignment here, exactly as `shouldCapture` asks whether there is an idea
 * here, and it refuses rather than rewriting. Deciding whether a well-formed
 * assignment is a *good* one is model prose judging model prose, and nothing
 * here does that.
 */
export const PLAN_MINIMUMS = {
  title: 12,
  objective: 40,
  assignment: 80,
  whyNow: 30,
} as const;

/**
 * Whole fields that are placeholders rather than content.
 *
 * Matched against the entire trimmed, lowercased value — never as a substring.
 * §8's rule about enums is the same rule: "latest test results" is a real
 * title that contains "test", and a substring check would refuse it. A field
 * that *is* the word is a field nobody wrote.
 *
 * It is a short list on purpose. It cannot catch a determined placeholder and
 * is not the control that matters — `PLAN_MINIMUMS` is. It catches the exact
 * shape that reached production, which is worth refusing by name.
 */
const PLACEHOLDER_FIELDS = new Set([
  'test',
  'testing',
  'test test',
  'todo',
  'tbd',
  'n/a',
  'na',
  'none',
  'placeholder',
  'example',
  'sample',
  'string',
  'foo',
  'bar',
  'lorem ipsum',
  'asdf',
  'xxx',
  '...',
  '-',
]);

/** Is this field a placeholder rather than something somebody meant? */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_FIELDS.has(value.trim().toLowerCase());
}

/** What a worker may observe about an idea. Brain decides what follows from it. */
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

export type PlanValidation =
  | { ok: true; observations: PlanObservations; spec: MissionSpec }
  | { ok: false; reason: string };

const ALLOWED_PLAN_FIELDS = new Set(['observations', 'mission']);
const ALLOWED_OBSERVATION_FIELDS = new Set(['cheapToReduce', 'expectedValue', 'blockedBy']);
const ALLOWED_MISSION_FIELDS = new Set([
  'title',
  'objective',
  'assignment',
  'whyNow',
  'acceptableSources',
  'excludedSources',
  'evidence',
  'followOn',
]);
const ALLOWED_FOLLOW_ON_FIELDS = new Set(['title', 'question', 'whyNow']);

function boundedList(value: unknown, max: number, label: string): string[] | string {
  if (!Array.isArray(value)) return `${label} must be a list`;
  if (value.length === 0) return `${label} must not be empty`;
  if (value.length > PLAN_LIMITS.listItems) return `${label} has too many entries`;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return `${label} must be a list of strings`;
    const trimmed = entry.trim();
    if (!trimmed) return `${label} contains an empty entry`;
    if (trimmed.length > max) return `${label} contains an entry that is too long`;
    out.push(trimmed);
  }
  return out;
}

/**
 * Zero-trust validation of a worker's plan.
 *
 * Deliberately the same shape as `validateProposal`: an unrecognised field
 * refuses the whole thing, every bound is exact, and nothing is coerced. A plan
 * that is nearly right is refused, because the alternative is Brain guessing
 * what a model meant and then launching a mission on the guess.
 */
export function validatePlan(input: { raw: unknown }): PlanValidation {
  const raw = input.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'the plan was not a structured object' };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_PLAN_FIELDS.has(key)) {
      return { ok: false, reason: 'the plan carried a field that is not part of the contract' };
    }
  }

  const observationsRaw = record['observations'];
  if (!observationsRaw || typeof observationsRaw !== 'object' || Array.isArray(observationsRaw)) {
    return { ok: false, reason: 'the plan carried no observations' };
  }
  const obs = observationsRaw as Record<string, unknown>;
  for (const key of Object.keys(obs)) {
    if (!ALLOWED_OBSERVATION_FIELDS.has(key)) {
      return { ok: false, reason: 'the observations carried a field that is not part of the contract' };
    }
  }
  if (typeof obs['cheapToReduce'] !== 'boolean') {
    return { ok: false, reason: 'cheapToReduce must be true or false' };
  }
  const expectedValue = obs['expectedValue'];
  if (
    typeof expectedValue !== 'number' ||
    !Number.isFinite(expectedValue) ||
    expectedValue < 0 ||
    expectedValue > 100
  ) {
    return { ok: false, reason: 'expectedValue must be a number from 0 to 100' };
  }
  const blockedByRaw = obs['blockedBy'];
  let blockedBy: string | null = null;
  if (blockedByRaw !== null && blockedByRaw !== undefined) {
    if (typeof blockedByRaw !== 'string') {
      return { ok: false, reason: 'blockedBy must be text or null' };
    }
    const trimmed = blockedByRaw.trim();
    if (trimmed.length > PLAN_LIMITS.blockedBy) {
      return { ok: false, reason: 'blockedBy is too long' };
    }
    blockedBy = trimmed || null;
  }

  const missionRaw = record['mission'];
  if (!missionRaw || typeof missionRaw !== 'object' || Array.isArray(missionRaw)) {
    return { ok: false, reason: 'the plan carried no mission specification' };
  }
  const mission = missionRaw as Record<string, unknown>;
  for (const key of Object.keys(mission)) {
    if (!ALLOWED_MISSION_FIELDS.has(key)) {
      return { ok: false, reason: 'the mission carried a field that is not part of the contract' };
    }
  }
  const text = (key: keyof MissionSpec, max: number): string | null => {
    const value = mission[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > max) return null;
    return trimmed;
  };
  const title = text('title', PLAN_LIMITS.title);
  const objective = text('objective', PLAN_LIMITS.objective);
  const assignment = text('assignment', PLAN_LIMITS.assignment);
  const whyNow = text('whyNow', PLAN_LIMITS.whyNow);
  if (!title) return { ok: false, reason: 'the mission needs a title within its length' };
  if (!objective) return { ok: false, reason: 'the mission needs an objective within its length' };
  if (!assignment) return { ok: false, reason: 'the mission needs an assignment within its length' };
  if (!whyNow) return { ok: false, reason: 'the mission needs a reason it is worth doing now' };

  /*
   * And the floor, which is the half that was missing. See PLAN_MINIMUMS.
   *
   * Refused as a whole plan rather than field by field, for the reason every
   * other validator here refuses whole: a partly-accepted specification is one
   * whose author believes they declared something they did not.
   *
   * The refusal names the field and the number, because a worker told only
   * "too short" cannot tell whether it missed by ten characters or by a
   * hundred — and a rule enforced against somebody who was never told it is a
   * trap, which is the sentence this file has now needed four times.
   */
  const floors: [string, string, number][] = [
    ['title', title, PLAN_MINIMUMS.title],
    ['objective', objective, PLAN_MINIMUMS.objective],
    ['assignment', assignment, PLAN_MINIMUMS.assignment],
    ['whyNow', whyNow, PLAN_MINIMUMS.whyNow],
  ];
  for (const [name, value, floor] of floors) {
    if (isPlaceholder(value)) {
      return {
        ok: false,
        reason: `the mission's ${name} is placeholder text rather than a specification`,
      };
    }
    if (value.length < floor) {
      return {
        ok: false,
        reason: `the mission's ${name} is ${value.length} characters; a packet is not ` +
          `researched from fewer than ${floor}`,
      };
    }
  }

  const acceptableSources = boundedList(
    mission['acceptableSources'],
    PLAN_LIMITS.source,
    'acceptableSources',
  );
  if (typeof acceptableSources === 'string') return { ok: false, reason: acceptableSources };
  const excludedSources = boundedList(
    mission['excludedSources'],
    PLAN_LIMITS.source,
    'excludedSources',
  );
  if (typeof excludedSources === 'string') return { ok: false, reason: excludedSources };
  const evidence = boundedList(mission['evidence'], PLAN_LIMITS.evidenceLine, 'evidence');
  if (typeof evidence === 'string') return { ok: false, reason: evidence };

  /*
   * The follow-on, validated with the same suspicion as everything else.
   *
   * Absent and null are the same answer — no follow-on — and both are ordinary.
   * Present and malformed refuses the whole plan rather than being dropped,
   * because a worker that believed it had declared the next question and had it
   * silently discarded is exactly the seam `RUN_PROBE` was: accepted, and
   * performed by nothing.
   */
  let followOn: MissionSpec['followOn'] = null;
  const followOnRaw = mission['followOn'];
  if (followOnRaw !== undefined && followOnRaw !== null) {
    if (typeof followOnRaw !== 'object' || Array.isArray(followOnRaw)) {
      return { ok: false, reason: 'the follow-on was not readable' };
    }
    const body = followOnRaw as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (!ALLOWED_FOLLOW_ON_FIELDS.has(key)) {
        return { ok: false, reason: 'the follow-on carried a field that is not part of the contract' };
      }
    }
    const bounded = (key: string, max: number): string | null => {
      const value = body[key];
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > max) return null;
      return trimmed;
    };
    const followTitle = bounded('title', PLAN_LIMITS.title);
    const question = bounded('question', PLAN_LIMITS.objective);
    const followWhyNow = bounded('whyNow', PLAN_LIMITS.whyNow);
    if (!followTitle || !question || !followWhyNow) {
      return { ok: false, reason: 'a follow-on needs a title, a question and a reason, each within its length' };
    }
    followOn = { title: followTitle, question, whyNow: followWhyNow };
  }

  return {
    ok: true,
    observations: { cheapToReduce: obs['cheapToReduce'], expectedValue, blockedBy },
    spec: {
      title,
      objective,
      assignment,
      whyNow,
      acceptableSources,
      excludedSources,
      evidence,
      followOn,
    },
  };
}

/** What the archive says about an idea, before anything is spent. */
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
  ok: boolean;
  reason: string;
  /** Set when a judgment was recorded. */
  priority: string | null;
  /** True when the archive settled it and nothing was dispatched. */
  answeredByArchive: boolean;
  /** Set when a worker is needed and a planning bin was created. */
  binId: string | null;
}

/**
 * Judge one captured candidate, spending nothing unless it has to.
 *
 * The order is the whole design. The archive is asked first because it is free
 * and because §13 says the default is not to research. Only a candidate the
 * project does *not* already answer is worth a worker's attention, and only
 * then is a planning bin created.
 *
 * Idempotent by the candidate's own state: a candidate that already carries a
 * priority is left alone, and a planning bin is created once. The queue is
 * at-least-once, so a tick that runs twice must not dispatch twice.
 */
export async function judgeCandidate(
  candidateId: string,
  options: {
    claims?: ExistingClaim[];
    /**
     * The cheap look, now that it has been taken.
     *
     * `judge` sends an idea to `EXPLORE` when a bounded look could settle it
     * more cheaply than a packet, the loop opens a probe, and the probe reaches
     * a verdict — and that was the end of the road. `exploring()` skips a
     * candidate that already has a probe and `nextLaunchable()` only reads
     * `QUEUED`, so an explored idea was selected by neither: it sat at
     * `EXPLORE` forever, with its answer recorded beside it and nothing
     * reading it. A dead end, not a decision.
     *
     * Supplying this is the second pass. The archive is asked again — it may
     * have moved — the probe's verdict goes to the worker that reads the
     * question, and the judgment it produces supersedes the `EXPLORE`.
     */
    afterProbe?: { probeId: string; outcome: string; explanation: string };
    /**
     * The run that produced nothing, now that it has ended.
     *
     * A redo must not relaunch the specification that failed. This one's
     * `missionSpec` is the very thing being replaced — and in the case this
     * was written for it is the placeholder specification of §54.2, which
     * `PLAN_MINIMUMS` would now refuse outright. Reusing it would spend a
     * second mission to reach the same dead end.
     *
     * So a redo is a third planning pass, exactly parallel to the post-probe
     * one: the archive is asked again, the failed run's recorded reason goes to
     * the worker with the question, and the judgment it produces supersedes the
     * one that led nowhere. The failed mission keeps its row, its reason and
     * its packet — §5 — and the new specification is judged by today's floor
     * rather than the one in force when the first was written.
     */
    afterFailedMission?: { missionId: string; attempt: number; reason: string };
  } = {},
): Promise<JudgeOutcome> {
  const candidate = await getCandidate(candidateId);
  if (!candidate) return outcome(false, 'no such idea');
  if (candidate.state === 'MERGED') return outcome(false, 'that idea was merged into another one');
  /*
   * One priority may be superseded, and only one.
   *
   * A first pass judges an unjudged idea. A post-probe pass judges an idea
   * whose only verdict so far was "look at this cheaply first", which the look
   * has now answered. Everything else — `QUEUED`, `PARKED`, `REJECTED`, a
   * person's override — is a decision, and a decision is not re-taken because
   * a probe happens to exist beside it.
   */
  if (options.afterProbe) {
    if (candidate.priority !== 'EXPLORE' || candidate.state !== 'CAPTURED') {
      return outcome(false, 'this idea is not waiting on a cheap look');
    }
  } else if (options.afterFailedMission) {
    /*
     * Queued and launched, and the run it was launched for is over. Anything
     * else is a decision somebody made — a park, a rejection, an override —
     * and a failed mission beside it is not a reason to re-take it.
     */
    if (candidate.state !== 'QUEUED') {
      return outcome(false, 'this idea is not queued for research');
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

  // Not answered, so somebody has to read the question. One bin, once — and a
  // post-probe pass is a *different* one, keyed by the probe that settled, so
  // the first pass's completed bin does not read as this one already running.
  const createdById = options.afterProbe
    ? `${PLAN_CREATED_BY}${candidate.id}${PLAN_AFTER_PROBE}${options.afterProbe.probeId}`
    : options.afterFailedMission
      ? `${PLAN_CREATED_BY}${candidate.id}${PLAN_AFTER_FAILURE}${options.afterFailedMission.missionId}`
      : `${PLAN_CREATED_BY}${candidate.id}`;
  const existing = await getDb().all<{ id: string; state: string }>(
    `SELECT id, state FROM bins WHERE created_by_id = ?`,
    [createdById],
  );
  const live = existing.find((row) => row.state !== 'CANCELLED' && row.state !== 'FAILED');
  if (live) {
    return { ok: true, reason: 'a worker is already looking at this', priority: null, answeredByArchive: false, binId: live.id };
  }

  const bin = await createBin({
    projectId: candidate.projectId,
    kind: 'RUSSELL_PLAN',
    title: 'Judge one idea and specify the work',
    objective: 'Say what a bounded look or a research packet would have to establish.',
    rationale: 'Russell captured an idea and the archive does not already answer it.',
    manifest: planManifest(
      candidate,
      archive,
      options.afterProbe ?? null,
      options.afterFailedMission ?? null,
    ),
    completionContract: PLAN_CONTRACT,
    createdByType: 'SYSTEM',
    createdById,
    ready: true,
    priority: 7,
    maxAttempts: 2,
    workloadClass: 'RUSSELL_PLAN',
  });
  return { ok: true, reason: 'asked a worker to read it', priority: null, answeredByArchive: false, binId: bin.id };
}

function outcome(ok: boolean, reason: string): JudgeOutcome {
  return { ok, reason, priority: null, answeredByArchive: false, binId: null };
}

/** What the worker is told, generated from the constants it is judged against. */
function planManifest(
  candidate: RussellCandidate,
  archive: ArchiveAnswer,
  afterProbe: { probeId: string; outcome: string; explanation: string } | null,
  afterFailedMission: { missionId: string; attempt: number; reason: string } | null,
): BinManifest {
  // How many of the project's own claims the archive check weighed. Carried in
  // the "why" rather than a field of its own, so a worker reading the bin knows
  // the check actually ran against something.
  void archive;
  return {
    objective: 'Say what a bounded look or a research packet would have to establish.',
    why: `Russell captured an idea and checked its own archive against ${archive.claimsConsidered} accepted claims. The archive does not answer it, so somebody has to read the question and say what settling it would take.`,
    lineage: {
      // Non-null by the time a plan is asked for: `judgeCandidate` refuses a
      // candidate with no project before it reaches here, because there is
      // nothing to judge it against.
      projectId: candidate.projectId ?? '',
      layerId: null,
      goal: candidate.statement,
      orchestrationId: null,
    },
    units: [
      {
        key: PLAN_UNIT_KEY,
        establishes: 'one judgment observation set and one mission specification',
        input: [
          `IDEA: ${candidate.title}`,
          `STATEMENT: ${candidate.statement}`,
          /*
           * What the cheap look found, when one was taken.
           *
           * The verdict and the explanation the probe recorded, verbatim, and
           * nothing more — no pages, no fetched text. A probe's verdict is a
           * claim about presence, never about truth (§24), so it is offered as
           * one finding among the things to weigh rather than as an answer.
           */
          ...(afterProbe
            ? [
                `A BOUNDED LOOK HAS ALREADY BEEN TAKEN. Its verdict: ${afterProbe.outcome}.`,
                `What it found: ${afterProbe.explanation}`,
              ]
            : []),
          /*
           * What the last try did, when there was one.
           *
           * §15's rule at this altitude: a repair that repeats a strategy an
           * earlier attempt already tried is not a repair. The reason is the
           * packet's own recorded words, so this is a fact about the run
           * rather than a summary of it, and it is offered as something to
           * avoid repeating rather than as an instruction.
           */
          ...(afterFailedMission
            ? [
                `THIS IDEA HAS BEEN RESEARCHED BEFORE AND PRODUCED NOTHING. ` +
                  `That was attempt ${afterFailedMission.attempt}.`,
                `Why it ended: ${afterFailedMission.reason}`,
                'Write a specification that would not fail the same way. If the question ' +
                  'cannot be researched as asked, say so in whyNow rather than restating it.',
              ]
            : []),
        ].join('\n'),
        transform: 'none',
        dependsOn: [],
      },
    ],
    acceptableSources: ["the idea itself", "the project's accepted knowledge"],
    excludedSources: ['anything outside this project'],
    /*
     * Every rule, stated. This seam has cost two real turns by enforcing rules
     * a worker was never told, and one more by offering an action nothing could
     * carry out, so the contract is written out in full and generated from the
     * constants the validator reads.
     */
    evidence: [
      'one JSON object with exactly two fields: "observations" and "mission"',
      ...(afterProbe
        ? [
            'observations.cheapToReduce must be false: the bounded look has been taken and ' +
              'there is not a second one — Russell ignores a true here',
          ]
        : [
            'observations.cheapToReduce is true or false — could a bounded look settle this more cheaply than a full packet?',
          ]),
      'observations.expectedValue is a whole-ish number from 0 to 100 — how much would settling this move the project goal?',
      'observations.blockedBy is text naming what must happen first, or null',
      `mission.title is from ${PLAN_MINIMUMS.title} to ${PLAN_LIMITS.title} characters`,
      `mission.objective is from ${PLAN_MINIMUMS.objective} to ${PLAN_LIMITS.objective} characters`,
      `mission.assignment is from ${PLAN_MINIMUMS.assignment} to ${PLAN_LIMITS.assignment} characters and says what to research`,
      `mission.whyNow is from ${PLAN_MINIMUMS.whyNow} to ${PLAN_LIMITS.whyNow} characters`,
      /*
       * Stated because it was not, and a real packet was created from the word
       * "test" four times over. See PLAN_MINIMUMS.
       */
      'these are real work that gets spent on: a placeholder — "test", "TBD", ' +
        '"placeholder" — refuses the whole plan, and so does a field too short to ' +
        'be the thing it names. If you cannot specify the mission, say so in ' +
        'observations.blockedBy instead of filling the fields in',
      `mission.acceptableSources, mission.excludedSources and mission.evidence are non-empty lists of at most ${PLAN_LIMITS.listItems} strings`,
      /*
       * Offered, never required.
       *
       * A mission that settles its subject leaves nothing behind and says so by
       * omitting this. The field exists because the opposite case is common and
       * had nowhere to go: a report that answers "do they publish" almost
       * always raises "on what terms", and until now that question was lost the
       * moment the mission finished.
       */
      'optional "mission.followOn": the one question finishing this would obviously ' +
        'leave open, as {title, question, whyNow} — omit it when there is not one',
      `mission.followOn.title is at most ${PLAN_LIMITS.title} characters, question at most ` +
        `${PLAN_LIMITS.objective}, whyNow at most ${PLAN_LIMITS.whyNow}`,
      'a follow-on is a question Russell will judge against the archive afterwards, ' +
        'not a second mission you are starting',
      'do not say whether the project already answers this — Brain has already checked its own archive and decided it does not',
      'no other field — an unrecognised one refuses the whole plan',
    ],
    outputs: [`one plan submitted as the unit result under the key "${PLAN_UNIT_KEY}"`],
    authorizedActions: ['reading this project', 'submitting one unit result'],
    prohibitedActions: [
      'any spend',
      'any external effect',
      'writing project state directly',
      'starting the mission you are specifying',
    ],
    budgetUnits: 1,
    retry: { maxAttempts: 2, backoffSeconds: 30 },
    stoppingConditions: ['one plan has been submitted'],
  };
}

export interface ApplyPlanResult {
  ok: boolean;
  reason: string;
  /** True when this call found the candidate already judged and did nothing. */
  alreadyJudged: boolean;
  priority: string | null;
  /** True when the plan produced a specification a mission can launch from. */
  launchable: boolean;
}

/**
 * Take a worker's plan and turn it into Brain's judgment.
 *
 * The order matters and is the same one `applyTurn` uses: validate first, and
 * only then act. A plan that fails validation records the refusal against the
 * candidate rather than being thrown away, because a judgment that never
 * happened and a judgment that was refused look identical from the outside and
 * lead to different remedies.
 *
 * **The worker's observations do not become the verdict.** They are inputs to
 * `judge()`, which is deterministic and in code, and `alreadyAnswered` is
 * overwritten from Brain's own archive check on the way in — so a worker
 * cannot talk its way past §13 by omitting it.
 *
 * `recordJudgment` is guarded on the candidate not being `MERGED` and this
 * function is guarded on it not already carrying a priority, so a redelivered
 * bin judges once. The queue is at-least-once by design; a second delivery must
 * not overwrite a judgment a person may already have overridden.
 */
export async function applyPlan(binId: string): Promise<ApplyPlanResult> {
  const bin = await getBin(binId);
  if (!bin) return planResult(false, 'no such bin');
  const target = planTarget(bin.createdById);
  if (!target) return planResult(false, 'this bin is not a plan');

  const candidate = await getCandidate(target.candidateId);
  if (!candidate) return planResult(false, 'the idea is gone');
  /*
   * The same rule `judgeCandidate` applied when it created this bin, applied
   * again when the answer lands — because the two are minutes or hours apart
   * and anything may have happened in between, including a person overriding
   * the very judgment this pass was going to supersede.
   *
   * A post-probe pass may replace `EXPLORE` and nothing else. A first pass may
   * only judge an idea with no priority at all.
   */
  if (target.afterProbe) {
    if (candidate.priority !== 'EXPLORE' || candidate.state !== 'CAPTURED') {
      return {
        ok: true,
        reason: 'this idea is no longer waiting on a cheap look',
        alreadyJudged: true,
        priority: candidate.priority,
        launchable: false,
      };
    }
  } else if (target.redo) {
    /*
     * A redo replaces the specification of an idea that is still queued for
     * research. If a person has parked, rejected or overridden it since the
     * plan was dispatched, that decision stands — the same rule the post-probe
     * pass applies, for the same reason.
     */
    if (candidate.state !== 'QUEUED') {
      return {
        ok: true,
        reason: 'this idea is no longer queued for research',
        alreadyJudged: true,
        priority: candidate.priority,
        launchable: false,
      };
    }
  } else if (candidate.priority) {
    return { ok: true, reason: 'already judged', alreadyJudged: true, priority: candidate.priority, launchable: false };
  }

  const results = await listBinUnitResults(bin.id);
  const submitted = results.find((row) => row.unitKey === PLAN_UNIT_KEY);
  if (!submitted) return planResult(false, 'no plan was submitted');

  const validated = validatePlan({ raw: parseJson<unknown>(submitted.value, null) });
  if (!validated.ok) {
    /*
     * Refused, and recorded as refused.
     *
     * Left unjudged on purpose: a plan Brain would not act on must not produce
     * a priority, and the candidate stays exactly where it was so the next
     * attempt can do it properly. What is recorded is *why*, on the bin's own
     * project events, so this is visible without reading a model's output.
     */
    return { ok: false, reason: validated.reason, alreadyJudged: false, priority: null, launchable: false };
  }

  /*
   * A repair that repeats the strategy that just failed is not a repair.
   *
   * §15 is explicit about both halves: no repair may reuse a search an earlier
   * attempt already tried, and when the ladder runs out the honest outcome is
   * "unresolved", recorded as such. `launch()` enforces the first half by
   * refusing the specification — but a refusal there leaves the idea `QUEUED`
   * with a launchable judgment nothing will ever launch, and this bin still
   * the newest mission's re-plan, so the arm above would hand it back on every
   * tick for ever. Silently stuck, which §24 forbids at every altitude.
   *
   * So Brain says the second half out loud. The idea is parked with what
   * actually happened, the worker's plan is kept beside it as `proposedMission`
   * because somebody paid for it, and `PARKED` is a state with a documented way
   * back to `QUEUED` — a person's override — rather than a bin.
   *
   * Compared on the same key `launch()` refuses on, from the same helper, so
   * the two can never disagree about what "already researched" means.
   */
  if (target.redo) {
    const tried = await specificationsTried(candidate.id);
    if (tried.includes(specificationKey(validated.spec.objective, validated.spec.whyNow))) {
      const reason = 'planning this again produced the approach that has already been researched';
      const parked = await recordJudgment({
        candidateId: candidate.id,
        state: 'PARKED',
        // `PARKED` / `PARKED`, the same pair `judge()` writes for every other
        // park. A parked idea still labelled `WORTH_DOING` would read to every
        // projection as work waiting to start.
        priority: 'PARKED',
        reason,
        judgment: {
          decidedBy: 'WORKER_OBSERVATIONS',
          redoOfMissionId: bin.createdById?.slice(bin.createdById.indexOf(PLAN_AFTER_FAILURE) + PLAN_AFTER_FAILURE.length) ?? null,
          proposedMission: validated.spec,
        },
      });
      return { ok: parked, reason, alreadyJudged: false, priority: 'PARKED', launchable: false };
    }
  }

  // Brain's own answer, taken again rather than trusted from the bin: the
  // archive may have moved between dispatch and completion, and §13's check is
  // Brain's to make.
  const archive = await askArchive(candidate);
  const authority = await standingAuthority(candidate.projectId!);

  /*
   * Four sources, and each supplies only what it can actually know.
   *
   * The archive says whether the project already answers it and what supports
   * or contradicts it. The worker says what only a reader of the question can:
   * is the uncertainty cheap to reduce, and what is settling it worth. And the
   * project's own standing authority says whether research may happen at all —
   * which is a dependency like any other, so it goes in as `blockedBy` and
   * `judge()` parks it with a reason a person can act on.
   *
   * Authority wins over the worker's own `blockedBy` when both are present,
   * because it is the harder blocker: no amount of upstream work makes a
   * mission launchable in a project nobody has authorized.
   */
  const inputs: JudgmentInputs = {
    alreadyAnswered: archive.fullyAnswered,
    supporting: archive.supporting,
    contradicting: archive.contradicting,
    /*
     * The cheap look is taken once.
     *
     * On a post-probe pass Brain overrides the worker's answer to false, and
     * this is not a matter of taste: `judge` sends `cheapToReduce` straight
     * back to `EXPLORE`, the probe for this candidate already exists so
     * `exploring()` will not open another, and the post-probe step would find
     * the same settled probe and ask again. A worker that answered true twice —
     * honestly, having read a question that genuinely does look cheap — would
     * put the idea in a loop it could never leave.
     *
     * Brain knows the thing the worker cannot: that the look has already
     * happened. So it decides this input from its own state, and the manifest
     * says so rather than leaving the override silent.
     */
    /*
     * False on a second or third pass, whichever kind it is.
     *
     * The post-probe reason is below. A redo is the same shape: the idea has
     * already had a full mission spent on it, so answering "a cheap look would
     * settle this" sends a question that has *already been researched* back to
     * the beginning of the queue, and the redo step would find it again.
     */
    cheapToReduce:
      target.afterProbe || target.redo ? false : validated.observations.cheapToReduce,
    expectedValue: validated.observations.expectedValue,
    blockedBy: authority.blockedBy ?? validated.observations.blockedBy,
  };
  const verdict = judge(inputs);

  /*
   * A mission specification is stored only for a verdict that could launch one.
   *
   * `nextLaunchable` reads `judgment.missionSpec`, so writing one onto a PARKED
   * or EXPLORE candidate would make a park launchable the moment somebody
   * changed its state by hand. The spec is kept either way — under a different
   * key when it is not yet usable — because it is the worker's real work and
   * throwing it away would mean paying for it twice.
   */
  const launchable = verdict.state === 'QUEUED';
  const spec = await missionSpecFor(candidate, validated.spec);
  const recorded = await recordJudgment({
    candidateId: candidate.id,
    state: verdict.state,
    priority: verdict.priority,
    confidence: null,
    reason: verdict.reason,
    judgment: {
      ...verdict.inputs,
      decidedBy: 'WORKER_OBSERVATIONS',
      claimsConsidered: archive.claimsConsidered,
      ...(launchable && spec ? { missionSpec: spec } : { proposedMission: validated.spec }),
    },
    supporting: archive.supporting,
    contradicting: archive.contradicting,
  });

  return {
    ok: recorded,
    reason: verdict.reason,
    alreadyJudged: false,
    priority: verdict.priority,
    launchable: launchable && Boolean(spec),
  };
}

/**
 * Which idea a plan bin is about, and which pass it is.
 *
 * `russell:plan:<candidateId>` is the first pass;
 * `russell:plan:<candidateId>:probed:<probeId>` is the second, after a bounded
 * look has settled. Split rather than pattern-matched so a key this version
 * does not understand yields null — "not a plan" — instead of a candidate id
 * assembled out of the wrong half of a string.
 */
function planTarget(
  createdById: string | null,
): { candidateId: string; afterProbe: boolean; redo: boolean } | null {
  if (!createdById || !createdById.startsWith(PLAN_CREATED_BY)) return null;
  const rest = createdById.slice(PLAN_CREATED_BY.length);
  for (const marker of [PLAN_AFTER_PROBE, PLAN_AFTER_FAILURE]) {
    const at = rest.indexOf(marker);
    if (at === -1) continue;
    const candidateId = rest.slice(0, at);
    const suffix = rest.slice(at + marker.length);
    // Both halves must be present. A truncated key is not a plan, and half of
    // one is not a candidate id.
    if (!candidateId || !suffix) return null;
    return {
      candidateId,
      afterProbe: marker === PLAN_AFTER_PROBE,
      redo: marker === PLAN_AFTER_FAILURE,
    };
  }
  return rest ? { candidateId: rest, afterProbe: false, redo: false } : null;
}

function planResult(ok: boolean, reason: string): ApplyPlanResult {
  return { ok, reason, alreadyJudged: false, priority: null, launchable: false };
}

/**
 * Complete the worker's specification with the parts only Brain may decide.
 *
 * The worker writes what a mission is *about*. Everything that decides what it
 * is *allowed to do* — the layer, the visibility, the approval envelope, the
 * human authorization behind it — is filled in here from rows, and the envelope
 * is named rather than supplied. §16's whole safety argument is that nobody
 * hands over the rules their own plan will be judged by, and a mission
 * specification that carried its own envelope id would be exactly that.
 *
 * Returns null when the project has no standing authority or no layer to hang
 * the work on. That is not a failure of the plan; it is a fact about the
 * project, and the candidate is judged all the same — it simply cannot launch
 * until somebody grants the authority.
 */
async function missionSpecFor(
  candidate: RussellCandidate,
  spec: MissionSpec,
): Promise<Record<string, unknown> | null> {
  if (!candidate.projectId) return null;
  const authority = await standingAuthority(candidate.projectId);
  if (!authority.ok || !authority.layerId) return null;

  const conversation = candidate.conversationId
    ? await getConversation(candidate.conversationId)
    : null;

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
    // Brain started it, on the authority of the person who holds the goal. The
    // approver is never Russell and never a worker.
    startedBy: { kind: 'BRAIN', id: `russell:plan:${candidate.id}` },
    // Named, not supplied: the envelope lives in code and the packet points at
    // it. See §16 — nobody hands over the limits their own plan is judged by.
    envelopeId: 'RUSSELL_STATE_LICENSING_V1',
    // The person whose standing authority this runs under. Read from the goal
    // row, falling back to the thread's owner — never Russell, never a worker.
    authorizedBy: authority.authorizedBy ?? conversation?.ownerUserId ?? '',
  };
}
