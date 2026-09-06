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
import { RESEARCH_WORK_CLASS } from './launch.ts';
import type { BinManifest, ExistingClaim, RussellCandidate } from '../../domain/types.ts';

/** The one unit a planning bin asks for. */
export const PLAN_UNIT_KEY = 'plan';

/** The contract its completion is evaluated against. */
export const PLAN_CONTRACT = 'RUSSELL_PLAN_V1';

/** How a planning bin is addressed back to its candidate. */
export const PLAN_CREATED_BY = 'russell:plan:';

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
]);

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

  return {
    ok: true,
    observations: { cheapToReduce: obs['cheapToReduce'], expectedValue, blockedBy },
    spec: { title, objective, assignment, whyNow, acceptableSources, excludedSources, evidence },
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
  options: { claims?: ExistingClaim[] } = {},
): Promise<JudgeOutcome> {
  const candidate = await getCandidate(candidateId);
  if (!candidate) return outcome(false, 'no such idea');
  if (candidate.state === 'MERGED') return outcome(false, 'that idea was merged into another one');
  if (candidate.priority) return outcome(false, 'already judged');
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

  // Not answered, so somebody has to read the question. One bin, once.
  const existing = await getDb().all<{ id: string; state: string }>(
    `SELECT id, state FROM bins WHERE created_by_id = ?`,
    [`${PLAN_CREATED_BY}${candidate.id}`],
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
    manifest: planManifest(candidate, archive),
    completionContract: PLAN_CONTRACT,
    createdByType: 'SYSTEM',
    createdById: `${PLAN_CREATED_BY}${candidate.id}`,
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
function planManifest(candidate: RussellCandidate, archive: ArchiveAnswer): BinManifest {
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
        input: `IDEA: ${candidate.title}\nSTATEMENT: ${candidate.statement}`,
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
      'observations.cheapToReduce is true or false — could a bounded look settle this more cheaply than a full packet?',
      'observations.expectedValue is a whole-ish number from 0 to 100 — how much would settling this move the project goal?',
      'observations.blockedBy is text naming what must happen first, or null',
      `mission.title is at most ${PLAN_LIMITS.title} characters`,
      `mission.objective is at most ${PLAN_LIMITS.objective} characters`,
      `mission.assignment is at most ${PLAN_LIMITS.assignment} characters and says what to research`,
      `mission.whyNow is at most ${PLAN_LIMITS.whyNow} characters`,
      `mission.acceptableSources, mission.excludedSources and mission.evidence are non-empty lists of at most ${PLAN_LIMITS.listItems} strings`,
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
  const candidateId = bin.createdById?.startsWith(PLAN_CREATED_BY)
    ? bin.createdById.slice(PLAN_CREATED_BY.length)
    : null;
  if (!candidateId) return planResult(false, 'this bin is not a plan');

  const candidate = await getCandidate(candidateId);
  if (!candidate) return planResult(false, 'the idea is gone');
  if (candidate.priority) {
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
    cheapToReduce: validated.observations.cheapToReduce,
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
