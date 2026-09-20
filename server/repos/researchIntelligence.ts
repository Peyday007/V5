/**
 * Rows for the judgement layer above the research engine.
 *
 * Five tables, one module, and one rule running through all of it: **nothing
 * here writes evidence.** A problem model says what the work is for, an
 * uncertainty says what is still unknown that matters, a link says how two of
 * them bear on each other, a revision says what changed the plan and a
 * retrospective says what the campaign taught. None of them can accept a claim,
 * move a coverage status, lower an independent-source minimum or advance an
 * audit verdict — those live where they already lived.
 *
 * Every insert is idempotent by something the caller does not choose: the
 * problem model by its version, the uncertainty by its key, the link by its
 * edge, the revision by its version, the lesson by its key. That is what makes
 * the director safe to run on every advance, from two instances, after a
 * restart — the same property `shared_findings` gets from its unique index, for
 * the same reason.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  BeliefBasis,
  ChangeRate,
  LessonAbstraction,
  PlanRevisionReason,
  ProblemModelSource,
  ResearchDepth,
  ResearchPlanRevision,
  ResearchPlanRevisionRow,
  ResearchProblemModel,
  ResearchProblemModelRow,
  ResearchRetrospective,
  ResearchRetrospectiveRow,
  ResearchReversibility,
  ResearchStakes,
  ResearchUncertainty,
  ResearchUncertaintyLink,
  ResearchUncertaintyLinkRow,
  ResearchUncertaintyRow,
  RetrospectiveScope,
  StatedConstraint,
  StatedExample,
  UncertaintyConsumer,
  UncertaintyDisposition,
  UncertaintyLinkKind,
  UncertaintyOrigin,
} from '../domain/types.ts';

// ---------------------------------------------------------------------------
// Problem models
// ---------------------------------------------------------------------------

function mapModel(row: ResearchProblemModelRow): ResearchProblemModel {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    projectId: row.project_id,
    boundaryContractId: row.boundary_contract_id,
    version: row.version,
    outcomeSought: row.outcome_sought,
    decisionSupported: row.decision_supported,
    whyItMatters: row.why_it_matters,
    stakes: row.stakes as ResearchStakes,
    reversibility: row.reversibility as ResearchReversibility,
    consequenceIfWrong: row.consequence_if_wrong,
    timeHorizon: row.time_horizon,
    successCriteria: parseJson<string[]>(row.success_criteria, []),
    constraints: parseJson<StatedConstraint[]>(row.constraints, []),
    preferences: parseJson<StatedConstraint[]>(row.preferences, []),
    examples: parseJson<StatedExample[]>(row.examples, []),
    assumptions: parseJson<string[]>(row.assumptions, []),
    nonGoals: parseJson<string[]>(row.non_goals, []),
    uselessIf: parseJson<string[]>(row.useless_if, []),
    authorityGranted: parseJson<string[]>(row.authority_granted, []),
    derivedFrom: row.derived_from as ProblemModelSource,
    rationale: row.rationale,
    revisedFromVersion: row.revised_from_version,
    revisionReason: row.revision_reason,
    createdAt: row.created_at,
  };
}

export interface RecordProblemModelInput {
  orchestrationId: string;
  projectId: string;
  boundaryContractId?: string | null;
  version: number;
  outcomeSought: string;
  decisionSupported?: string | null;
  whyItMatters?: string | null;
  stakes?: ResearchStakes;
  reversibility?: ResearchReversibility;
  consequenceIfWrong?: string | null;
  timeHorizon?: string | null;
  successCriteria?: string[];
  constraints?: StatedConstraint[];
  preferences?: StatedConstraint[];
  examples?: StatedExample[];
  assumptions?: string[];
  nonGoals?: string[];
  uselessIf?: string[];
  authorityGranted?: string[];
  derivedFrom: ProblemModelSource;
  rationale?: string | null;
  revisedFromVersion?: number | null;
  revisionReason?: string | null;
}

/**
 * Write one version of a packet's interpretation.
 *
 * Returns the row that ends up in the database, which on a collision is the one
 * that was already there rather than the one this caller built. Two ticks
 * deriving the same version is an ordinary outcome, not an error — exactly the
 * shape `ensureDispatchIntent` uses, and for the same reason: the arbiter is
 * the unique index, never a process-local check.
 */
export async function recordProblemModel(
  input: RecordProblemModelInput,
): Promise<ResearchProblemModel> {
  const db = getDb();
  const id = newId('rpm');
  await db.run(
    `INSERT INTO research_problem_models (
       id, orchestration_id, project_id, boundary_contract_id, version,
       outcome_sought, decision_supported, why_it_matters, stakes, reversibility,
       consequence_if_wrong, time_horizon, success_criteria, constraints, preferences,
       examples, assumptions, non_goals, useless_if, authority_granted,
       derived_from, rationale, revised_from_version, revision_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (orchestration_id, version) DO NOTHING`,
    [
      id,
      input.orchestrationId,
      input.projectId,
      input.boundaryContractId ?? null,
      input.version,
      input.outcomeSought,
      input.decisionSupported ?? null,
      input.whyItMatters ?? null,
      input.stakes ?? 'MODERATE',
      input.reversibility ?? 'REVERSIBLE',
      input.consequenceIfWrong ?? null,
      input.timeHorizon ?? null,
      toJson(input.successCriteria ?? []),
      toJson(input.constraints ?? []),
      toJson(input.preferences ?? []),
      toJson(input.examples ?? []),
      toJson(input.assumptions ?? []),
      toJson(input.nonGoals ?? []),
      toJson(input.uselessIf ?? []),
      toJson(input.authorityGranted ?? []),
      input.derivedFrom,
      input.rationale ?? null,
      input.revisedFromVersion ?? null,
      input.revisionReason ?? null,
      nowIso(),
    ],
  );
  const row = await db.get<ResearchProblemModelRow>(
    'SELECT * FROM research_problem_models WHERE orchestration_id = ? AND version = ?',
    [input.orchestrationId, input.version],
  );
  // The insert either landed or collided with a row for this exact version, so
  // one of the two is always there.
  return mapModel(row!);
}

/** The interpretation in force: the highest version. */
export async function currentProblemModel(
  orchestrationId: string,
): Promise<ResearchProblemModel | null> {
  const row = await getDb().get<ResearchProblemModelRow>(
    `SELECT * FROM research_problem_models
      WHERE orchestration_id = ?
      ORDER BY version DESC
      LIMIT 1`,
    [orchestrationId],
  );
  return row ? mapModel(row) : null;
}

/** Every version, oldest first, so what changed is readable. */
export async function listProblemModels(
  orchestrationId: string,
): Promise<ResearchProblemModel[]> {
  const rows = await getDb().all<ResearchProblemModelRow>(
    'SELECT * FROM research_problem_models WHERE orchestration_id = ? ORDER BY version ASC',
    [orchestrationId],
  );
  return rows.map(mapModel);
}

// ---------------------------------------------------------------------------
// Uncertainties
// ---------------------------------------------------------------------------

function mapUncertainty(row: ResearchUncertaintyRow): ResearchUncertainty {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    projectId: row.project_id,
    problemModelId: row.problem_model_id,
    uncertaintyKey: row.uncertainty_key,
    question: row.question,
    whyItMatters: row.why_it_matters,
    consumerKind: row.consumer_kind as UncertaintyConsumer,
    consumerRef: row.consumer_ref,
    currentBelief: row.current_belief,
    beliefBasis: row.belief_basis as BeliefBasis,
    consequence: row.consequence as ResearchStakes,
    reversibility: row.reversibility as ResearchReversibility,
    changeRate: row.change_rate as ChangeRate,
    uncertaintyLevel: row.uncertainty_level,
    invalidating: row.invalidating === 1,
    stoppingCondition: row.stopping_condition,
    disposition: row.disposition as UncertaintyDisposition,
    dispositionReason: row.disposition_reason,
    resolvedByFragmentId: row.resolved_by_fragment_id,
    resolvedAt: row.resolved_at,
    depth: row.depth as ResearchDepth,
    depthBasis: row.depth_basis,
    origin: row.origin as UncertaintyOrigin,
    originRef: row.origin_ref,
    planVersion: row.plan_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface OpenUncertaintyInput {
  orchestrationId: string;
  projectId: string;
  problemModelId?: string | null;
  uncertaintyKey: string;
  question: string;
  whyItMatters: string;
  consumerKind: UncertaintyConsumer;
  consumerRef?: string | null;
  currentBelief?: string | null;
  beliefBasis?: BeliefBasis;
  consequence?: ResearchStakes;
  reversibility?: ResearchReversibility;
  changeRate?: ChangeRate;
  uncertaintyLevel?: number;
  invalidating?: boolean;
  stoppingCondition: string;
  depth?: ResearchDepth;
  depthBasis?: string | null;
  origin?: UncertaintyOrigin;
  originRef?: string | null;
  planVersion?: number;
}

/**
 * Open an uncertainty, or return the one already open under that key.
 *
 * Never an update. A key that already exists means this question was already
 * asked, and overwriting it would let a later derivation quietly re-rank a
 * question a person may have been shown — or, worse, reset a disposition
 * somebody set. Changing one is `setUncertaintyDisposition` or
 * `reassessUncertainty`, both of which say what they changed.
 */
export async function openUncertainty(
  input: OpenUncertaintyInput,
): Promise<{ uncertainty: ResearchUncertainty; created: boolean }> {
  const db = getDb();
  const id = newId('unc');
  const ts = nowIso();
  const before = await db.get<ResearchUncertaintyRow>(
    'SELECT * FROM research_uncertainties WHERE orchestration_id = ? AND uncertainty_key = ?',
    [input.orchestrationId, input.uncertaintyKey],
  );
  if (before) return { uncertainty: mapUncertainty(before), created: false };

  await db.run(
    `INSERT INTO research_uncertainties (
       id, orchestration_id, project_id, problem_model_id, uncertainty_key, question,
       why_it_matters, consumer_kind, consumer_ref, current_belief, belief_basis,
       consequence, reversibility, change_rate, uncertainty_level, invalidating,
       stopping_condition, disposition, disposition_reason, resolved_by_fragment_id,
       resolved_at, depth, depth_basis, origin, origin_ref, plan_version,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, NULL,
             ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (orchestration_id, uncertainty_key) DO NOTHING`,
    [
      id,
      input.orchestrationId,
      input.projectId,
      input.problemModelId ?? null,
      input.uncertaintyKey,
      input.question,
      input.whyItMatters,
      input.consumerKind,
      input.consumerRef ?? null,
      input.currentBelief ?? null,
      input.beliefBasis ?? 'UNKNOWN',
      input.consequence ?? 'MODERATE',
      input.reversibility ?? 'REVERSIBLE',
      input.changeRate ?? 'SLOW',
      input.uncertaintyLevel ?? 100,
      input.invalidating ? 1 : 0,
      input.stoppingCondition,
      input.depth ?? 'CORROBORATED',
      input.depthBasis ?? null,
      input.origin ?? 'PLAN',
      input.originRef ?? null,
      input.planVersion ?? 1,
      ts,
      ts,
    ],
  );
  const row = await db.get<ResearchUncertaintyRow>(
    'SELECT * FROM research_uncertainties WHERE orchestration_id = ? AND uncertainty_key = ?',
    [input.orchestrationId, input.uncertaintyKey],
  );
  return { uncertainty: mapUncertainty(row!), created: row!.id === id };
}

export async function listUncertainties(
  orchestrationId: string,
): Promise<ResearchUncertainty[]> {
  const rows = await getDb().all<ResearchUncertaintyRow>(
    `SELECT * FROM research_uncertainties
      WHERE orchestration_id = ?
      ORDER BY created_at ASC, uncertainty_key ASC`,
    [orchestrationId],
  );
  return rows.map(mapUncertainty);
}

export async function getUncertainty(
  orchestrationId: string,
  key: string,
): Promise<ResearchUncertainty | null> {
  const row = await getDb().get<ResearchUncertaintyRow>(
    'SELECT * FROM research_uncertainties WHERE orchestration_id = ? AND uncertainty_key = ?',
    [orchestrationId, key],
  );
  return row ? mapUncertainty(row) : null;
}

/**
 * Move an uncertainty's disposition, naming the state it is moving from.
 *
 * A compare-and-swap on `disposition` rather than a blind write, for the reason
 * every other transition in this codebase is one: two ticks reading the same
 * open uncertainty must produce one transition, and a late writer must lose
 * rather than overwrite. `from` being a list is what lets a caller say "either
 * of the two live states" without having to read first and race.
 *
 * Returns false when nothing matched, which is an ordinary outcome.
 */
export async function setUncertaintyDisposition(input: {
  orchestrationId: string;
  uncertaintyKey: string;
  from: UncertaintyDisposition[];
  to: UncertaintyDisposition;
  reason: string;
  resolvedByFragmentId?: string | null;
  belief?: string | null;
  beliefBasis?: BeliefBasis;
  uncertaintyLevel?: number;
}): Promise<boolean> {
  if (input.from.length === 0) return false;
  const terminal = input.to !== 'OPEN' && input.to !== 'INVESTIGATING';
  const placeholders = input.from.map(() => '?').join(', ');
  const result = await getDb().run(
    `UPDATE research_uncertainties
        SET disposition = ?,
            disposition_reason = ?,
            resolved_by_fragment_id = COALESCE(?, resolved_by_fragment_id),
            resolved_at = CASE WHEN ? = 1 THEN ? ELSE resolved_at END,
            current_belief = COALESCE(?, current_belief),
            belief_basis = COALESCE(?, belief_basis),
            uncertainty_level = COALESCE(?, uncertainty_level),
            updated_at = ?
      WHERE orchestration_id = ?
        AND uncertainty_key = ?
        AND disposition IN (${placeholders})`,
    [
      input.to,
      input.reason,
      input.resolvedByFragmentId ?? null,
      terminal ? 1 : 0,
      nowIso(),
      input.belief ?? null,
      input.beliefBasis ?? null,
      input.uncertaintyLevel ?? null,
      nowIso(),
      input.orchestrationId,
      input.uncertaintyKey,
      ...input.from,
    ],
  );
  return (result.changes ?? 0) > 0;
}

/**
 * Re-rank a live uncertainty as evidence changes what it is worth.
 *
 * Only the ranking inputs, and only while it is still live: a resolved question
 * that could have its consequence rewritten afterwards would make the record of
 * why it was investigated first unreadable.
 */
export async function reassessUncertainty(input: {
  orchestrationId: string;
  uncertaintyKey: string;
  consequence?: ResearchStakes;
  uncertaintyLevel?: number;
  invalidating?: boolean;
  depth?: ResearchDepth;
  depthBasis?: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE research_uncertainties
        SET consequence = COALESCE(?, consequence),
            uncertainty_level = COALESCE(?, uncertainty_level),
            invalidating = COALESCE(?, invalidating),
            depth = COALESCE(?, depth),
            depth_basis = COALESCE(?, depth_basis),
            updated_at = ?
      WHERE orchestration_id = ?
        AND uncertainty_key = ?
        AND disposition IN ('OPEN','INVESTIGATING')`,
    [
      input.consequence ?? null,
      input.uncertaintyLevel ?? null,
      input.invalidating === undefined ? null : input.invalidating ? 1 : 0,
      input.depth ?? null,
      input.depthBasis ?? null,
      nowIso(),
      input.orchestrationId,
      input.uncertaintyKey,
    ],
  );
  return (result.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function mapLink(row: ResearchUncertaintyLinkRow): ResearchUncertaintyLink {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    fromKey: row.from_key,
    toKey: row.to_key,
    kind: row.kind as UncertaintyLinkKind,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export async function linkUncertainties(input: {
  orchestrationId: string;
  fromKey: string;
  toKey: string;
  kind: UncertaintyLinkKind;
  reason?: string | null;
}): Promise<ResearchUncertaintyLink | null> {
  if (input.fromKey === input.toKey) return null;
  const db = getDb();
  await db.run(
    `INSERT INTO research_uncertainty_links
       (id, orchestration_id, from_key, to_key, kind, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (orchestration_id, from_key, to_key, kind) DO NOTHING`,
    [
      newId('unl'),
      input.orchestrationId,
      input.fromKey,
      input.toKey,
      input.kind,
      input.reason ?? null,
      nowIso(),
    ],
  );
  const row = await db.get<ResearchUncertaintyLinkRow>(
    `SELECT * FROM research_uncertainty_links
      WHERE orchestration_id = ? AND from_key = ? AND to_key = ? AND kind = ?`,
    [input.orchestrationId, input.fromKey, input.toKey, input.kind],
  );
  return row ? mapLink(row) : null;
}

export async function listUncertaintyLinks(
  orchestrationId: string,
): Promise<ResearchUncertaintyLink[]> {
  const rows = await getDb().all<ResearchUncertaintyLinkRow>(
    `SELECT * FROM research_uncertainty_links
      WHERE orchestration_id = ?
      ORDER BY created_at ASC, from_key ASC, to_key ASC`,
    [orchestrationId],
  );
  return rows.map(mapLink);
}

// ---------------------------------------------------------------------------
// Plan revisions
// ---------------------------------------------------------------------------

function mapRevision(row: ResearchPlanRevisionRow): ResearchPlanRevision {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    projectId: row.project_id,
    version: row.version,
    reason: row.reason as PlanRevisionReason,
    summary: row.summary,
    decisions: parseJson<unknown[]>(row.decisions, []),
    applied: parseJson<unknown[]>(row.applied, []),
    actorKind: row.actor_kind as 'BRAIN' | 'PERSON' | 'WORKER',
    actorRef: row.actor_ref,
    createdAt: row.created_at,
  };
}

/**
 * Record a revision at the next version.
 *
 * The version is computed from `MAX(version)` and the insert is guarded by the
 * unique index, so two ticks racing produce one revision and the loser is told.
 * `null` on a collision rather than a retry loop: the caller already applied
 * nothing in that case, because applying happens before this is written only
 * when the decision itself is idempotent.
 */
export async function recordPlanRevision(input: {
  orchestrationId: string;
  projectId: string;
  reason: PlanRevisionReason;
  summary: string;
  decisions?: unknown[];
  applied?: unknown[];
  actorKind?: 'BRAIN' | 'PERSON' | 'WORKER';
  actorRef?: string | null;
}): Promise<ResearchPlanRevision | null> {
  const db = getDb();
  const highest = await db.get<{ top: number | null }>(
    'SELECT MAX(version) AS top FROM research_plan_revisions WHERE orchestration_id = ?',
    [input.orchestrationId],
  );
  const version = (highest?.top ?? 0) + 1;
  const id = newId('rpv');
  await db.run(
    `INSERT INTO research_plan_revisions
       (id, orchestration_id, project_id, version, reason, summary, decisions, applied,
        actor_kind, actor_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (orchestration_id, version) DO NOTHING`,
    [
      id,
      input.orchestrationId,
      input.projectId,
      version,
      input.reason,
      input.summary,
      toJson(input.decisions ?? []),
      toJson(input.applied ?? []),
      input.actorKind ?? 'BRAIN',
      input.actorRef ?? null,
    ].concat([nowIso()]),
  );
  const row = await db.get<ResearchPlanRevisionRow>(
    'SELECT * FROM research_plan_revisions WHERE id = ?',
    [id],
  );
  return row ? mapRevision(row) : null;
}

export async function listPlanRevisions(
  orchestrationId: string,
): Promise<ResearchPlanRevision[]> {
  const rows = await getDb().all<ResearchPlanRevisionRow>(
    'SELECT * FROM research_plan_revisions WHERE orchestration_id = ? ORDER BY version ASC',
    [orchestrationId],
  );
  return rows.map(mapRevision);
}

export async function currentPlanVersion(orchestrationId: string): Promise<number> {
  const row = await getDb().get<{ top: number | null }>(
    'SELECT MAX(version) AS top FROM research_plan_revisions WHERE orchestration_id = ?',
    [orchestrationId],
  );
  return row?.top ?? 0;
}

// ---------------------------------------------------------------------------
// Retrospectives
// ---------------------------------------------------------------------------

function mapLesson(row: ResearchRetrospectiveRow): ResearchRetrospective {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    projectId: row.project_id,
    lessonKey: row.lesson_key,
    scope: row.scope as RetrospectiveScope,
    abstraction: row.abstraction as LessonAbstraction,
    lesson: row.lesson,
    evidence: parseJson<string[]>(row.evidence, []),
    metrics: parseJson<Record<string, number>>(row.metrics, {}),
    createdAt: row.created_at,
  };
}

export async function recordLesson(input: {
  orchestrationId: string;
  projectId: string;
  lessonKey: string;
  scope: RetrospectiveScope;
  abstraction: LessonAbstraction;
  lesson: string;
  evidence?: string[];
  metrics?: Record<string, number>;
}): Promise<ResearchRetrospective> {
  const db = getDb();
  const id = newId('rrl');
  await db.run(
    `INSERT INTO research_retrospectives
       (id, orchestration_id, project_id, lesson_key, scope, abstraction, lesson,
        evidence, metrics, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (orchestration_id, lesson_key) DO NOTHING`,
    [
      id,
      input.orchestrationId,
      input.projectId,
      input.lessonKey,
      input.scope,
      input.abstraction,
      input.lesson,
      toJson(input.evidence ?? []),
      toJson(input.metrics ?? {}),
      nowIso(),
    ],
  );
  const row = await db.get<ResearchRetrospectiveRow>(
    'SELECT * FROM research_retrospectives WHERE orchestration_id = ? AND lesson_key = ?',
    [input.orchestrationId, input.lessonKey],
  );
  return mapLesson(row!);
}

export async function listLessons(orchestrationId: string): Promise<ResearchRetrospective[]> {
  const rows = await getDb().all<ResearchRetrospectiveRow>(
    `SELECT * FROM research_retrospectives
      WHERE orchestration_id = ?
      ORDER BY created_at ASC, lesson_key ASC`,
    [orchestrationId],
  );
  return rows.map(mapLesson);
}

/**
 * The reusable lessons a project has accumulated.
 *
 * CAMPAIGN lessons are deliberately excluded: they are true about one packet and
 * reading them as guidance is exactly the "always do what the user said last
 * time" failure this table exists to avoid.
 */
export async function reusableLessons(projectId: string): Promise<ResearchRetrospective[]> {
  const rows = await getDb().all<ResearchRetrospectiveRow>(
    `SELECT * FROM research_retrospectives
      WHERE project_id = ?
        AND abstraction IN ('DOMAIN','GENERAL')
      ORDER BY created_at DESC, lesson_key ASC
      LIMIT 50`,
    [projectId],
  );
  return rows.map(mapLesson);
}
