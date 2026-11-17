/**
 * The ingestion-and-understanding processing graph (KNOW-25-1).
 *
 * Brain chooses the methods that fit one source and one question. This module
 * holds the catalogue of possible stages and a pure planner that, from evidence
 * about a source and the decision a question feeds, picks which stages run and
 * in what order, marks each one CODE or LLM with the reason, and records the
 * judgment in a serializable plan. It is an adaptable graph, never a mandatory
 * linear recipe: two different source/question pairs give two different graphs.
 *
 * Code handles repeatable transformations. A stage is given to an LLM only when
 * the case states a reason that justifies it — ambiguity, novelty, source
 * interpretation or a consequential decision — and the reason is written into
 * the stage.
 *
 * Retrieval prefers authoritative structured, bulk and incremental routes over
 * paged polling. Which resource carries the data and what constraints it states
 * is `../feeds/access.ts`'s judgment (`resolveAccess`, `UpdateMechanism`); this
 * planner only reads that judgment. A permission constraint removes a route;
 * it is never worked around, and when no permitted route remains the plan says
 * so instead of retrieving.
 *
 * No category, industry or example is a whitelist: nothing here keys on what a
 * source is about, only on its stated structure, access and history and on the
 * value of the decision its answer feeds. Pure — no I/O, no clock.
 */
import type { ResourceKind, UpdateMechanism } from '../feeds/access.ts';

export const PROCESSING_GRAPH_VERSION = 1;

/** Every stage the graph may contain. Order here is a default, not a sequence a plan must follow. */
export const STAGES = [
  'SOURCE_INDEXING',
  'QUERY_PLANNING',
  'RETRIEVAL',
  'CHANGE_DATA_CAPTURE',
  'PARSE_NORMALIZE',
  'ENTITY_IDENTIFICATION',
  'EVENT_DETECTION',
  'RELATIONSHIP_EXTRACTION',
  'CONTRADICTION_FRESHNESS',
  'EVIDENCE_ATTACHMENT',
  'MATH_RECONSTRUCTION',
  'GOAL_UPDATE',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_DESCRIPTION: Record<Stage, string> = {
  SOURCE_INDEXING: 'source indexing: record what the source holds and how it is reached',
  QUERY_PLANNING: 'query planning: turn the question into the records it needs',
  RETRIEVAL: 'permitted feed/API/bulk retrieval',
  CHANGE_DATA_CAPTURE: 'resumable change-data capture: read only what changed since the last checkpoint',
  PARSE_NORMALIZE: 'parsing and normalization',
  ENTITY_IDENTIFICATION: 'entity identification, resolving identity collisions before matching',
  EVENT_DETECTION: 'event detection',
  RELATIONSHIP_EXTRACTION: 'economic relationship extraction',
  CONTRADICTION_FRESHNESS: 'contradiction and freshness checks',
  EVIDENCE_ATTACHMENT: 'evidence attachment: exact span or record, observation date, scope, units, parser version',
  MATH_RECONSTRUCTION: 'mathematical reconstruction',
  GOAL_UPDATE: 'goal/venture updates',
};

export type Executor = 'CODE' | 'LLM';
/** The only reasons an LLM may be given a stage. */
export type LlmReason = 'AMBIGUITY' | 'NOVELTY' | 'SOURCE_INTERPRETATION' | 'CONSEQUENTIAL_DECISION';

/** How the source's content is shaped, judged from the source, never from its subject. */
export type SourceStructure = 'STRUCTURED' | 'SEMI_STRUCTURED' | 'UNSTRUCTURED';

/** One way to reach the source's content, as `resolveAccess` describes it. */
export interface RouteEvidence {
  url: string;
  kind: ResourceKind;
  updateMechanism: UpdateMechanism;
  /** False when a stated constraint (login, key, restriction) stops an automated read. */
  automatable: boolean;
  constraints?: readonly string[];
}

export interface SourceEvidence {
  sourceId: string;
  structure: SourceStructure;
  /** Whether the publisher is the authority for what it states. */
  authoritative: boolean;
  routes: readonly RouteEvidence[];
  /** True when Brain has read this source before and holds a checkpoint/validators. */
  hasCheckpoint: boolean;
  /** True when the content fingerprint changed since the last read (null = unknown / first read). */
  contentChanged: boolean | null;
  /** Parser runs on this source: how many, and how many produced records. */
  priorParserRuns: number;
  priorParserSuccesses: number;
  /** True when entity mappings for this source are already established. */
  establishedEntityMappings: boolean;
  /** True when records name entities whose identity is not settled (similar names, missing identifiers). */
  identityCollisionsSuspected: boolean;
  /** True when the source carries timestamps of things that happened (events), not only states. */
  timeSeries: boolean;
}

export interface QuestionEvidence {
  questionId: string;
  /** The decision the answer feeds. A question without one is not planned. */
  decision: string | null;
  /** Value of the decision the answer can change, in the goal's currency units. */
  decisionValue: number;
  /** 0..1: how unsure Brain is of the answer today. */
  uncertainty: number;
  /** True when the answer needs a quantity reconstructed from parts (market size, unit economics…). */
  needsReconstruction: boolean;
  /** True when the answer is about relationships between parties (who pays whom, supplies, competes). */
  needsRelationships: boolean;
  /** True when the question is of a kind Brain has not answered before. */
  novel: boolean;
}

/** Capacity available for costly reasoning now; the threshold rises as it shrinks. */
export interface Capacity {
  /** 0..1 share of LLM capacity idle now. */
  llmIdleShare: number;
}

export interface PlannedStage {
  stage: Stage;
  executor: Executor;
  /** Present exactly when executor is LLM. */
  llmReason: LlmReason | null;
  why: string;
}

export interface RetrievalChoice {
  route: RouteEvidence;
  mode: 'FULL' | 'INCREMENTAL';
  why: string;
}

export interface ProcessingPlan {
  version: number;
  sourceId: string;
  questionId: string;
  status: 'PLANNED' | 'NO_PERMITTED_ROUTE' | 'NO_DECISION' | 'UNCHANGED';
  stages: PlannedStage[];
  retrieval: RetrievalChoice | null;
  /** Routes set aside, with the constraint that removed each. Never routed around. */
  removedRoutes: { url: string; reason: string }[];
  /** Stages considered and left out, with why. */
  skipped: { stage: Stage; why: string }[];
  /** Value-of-information judgment used to decide whether to deepen with an LLM. */
  deepening: { valueOfInformation: number; threshold: number; deepen: boolean; why: string };
  /** The whole judgment in one line, for the record. */
  judgment: string;
}

/** Lower is better: an authoritative route that pushes or exports in bulk before one polled page by page. */
const MECHANISM_RANK: Record<UpdateMechanism, number> = {
  EVENT_SUBSCRIPTION: 0,
  BULK_SNAPSHOT: 1,
  CONDITIONAL_FETCH: 2,
  PAGED_API: 4,
  UNKNOWN: 5,
};
const KIND_RANK: Record<ResourceKind, number> = { BULK: 0, FEED: 0.5, DOCUMENT: 1, API: 2, LANDING_PAGE: 4 };

/** Removes routes a permission constraint stops, and ranks the rest. Pure. */
export function chooseRoute(routes: readonly RouteEvidence[]): { chosen: RouteEvidence | null; removed: { url: string; reason: string }[] } {
  const removed: { url: string; reason: string }[] = [];
  const permitted: { r: RouteEvidence; i: number }[] = [];
  routes.forEach((r, i) => {
    if (!r.automatable) {
      removed.push({ url: r.url, reason: `not permitted for an automated read: ${(r.constraints ?? []).join('; ') || 'a stated access constraint'}` });
      return;
    }
    if (r.kind === 'LANDING_PAGE') {
      removed.push({ url: r.url, reason: 'a landing page, not the data' });
      return;
    }
    permitted.push({ r, i });
  });
  permitted.sort((a, b) => MECHANISM_RANK[a.r.updateMechanism] + KIND_RANK[a.r.kind] - (MECHANISM_RANK[b.r.updateMechanism] + KIND_RANK[b.r.kind]) || a.i - b.i);
  return { chosen: permitted[0]?.r ?? null, removed };
}

/**
 * Value of information: what the decision is worth times how much the answer
 * could still move it. The threshold to spend LLM reasoning rises as idle
 * capacity falls; it is never a keyword list.
 */
export function deepeningJudgment(q: QuestionEvidence, capacity: Capacity): ProcessingPlan['deepening'] {
  const uncertainty = Math.min(1, Math.max(0, q.uncertainty));
  const valueOfInformation = Math.max(0, q.decisionValue) * uncertainty;
  const idle = Math.min(1, Math.max(0, capacity.llmIdleShare));
  // With all capacity idle a small value earns deepening; with none idle only a large one does.
  const threshold = 50 / Math.max(0.05, idle);
  const deepen = valueOfInformation >= threshold || q.novel;
  const why = q.novel
    ? 'the question is novel: no tested method exists, so reasoning is justified regardless of the threshold'
    : deepen
      ? `value of information ${valueOfInformation.toFixed(2)} ≥ threshold ${threshold.toFixed(2)} at ${Math.round(idle * 100)}% idle capacity`
      : `value of information ${valueOfInformation.toFixed(2)} < threshold ${threshold.toFixed(2)} at ${Math.round(idle * 100)}% idle capacity: cheap code only`;
  return { valueOfInformation, threshold, deepen, why };
}

const code = (stage: Stage, why: string): PlannedStage => ({ stage, executor: 'CODE', llmReason: null, why });
const llm = (stage: Stage, llmReason: LlmReason, why: string): PlannedStage => ({ stage, executor: 'LLM', llmReason, why });

/**
 * Plans the processing graph for one source and one question. Pure and
 * deterministic; the result is plain JSON for recording.
 */
export function planProcessing(source: SourceEvidence, question: QuestionEvidence, capacity: Capacity = { llmIdleShare: 1 }): ProcessingPlan {
  const deepening = deepeningJudgment(question, capacity);
  const { chosen, removed } = chooseRoute(source.routes);
  const base = { version: PROCESSING_GRAPH_VERSION, sourceId: source.sourceId, questionId: question.questionId, removedRoutes: removed, deepening };

  if (!question.decision || question.decision.trim() === '') {
    return { ...base, status: 'NO_DECISION', stages: [], retrieval: null, skipped: [], judgment: 'no decision consumes this question’s answer: nothing is processed' };
  }
  if (!chosen) {
    return {
      ...base,
      status: 'NO_PERMITTED_ROUTE',
      stages: [code('SOURCE_INDEXING', 'record the source and the constraints that stop an automated read')],
      retrieval: null,
      skipped: [],
      judgment: 'no permitted automated route: the constraint is recorded and an authorized route must be sought; nothing is read around it',
    };
  }
  if (source.hasCheckpoint && source.contentChanged === false) {
    return {
      ...base,
      status: 'UNCHANGED',
      stages: [code('CHANGE_DATA_CAPTURE', 'the content fingerprint is unchanged since the checkpoint: no fact or model is recomputed')],
      retrieval: null,
      skipped: [],
      judgment: 'unchanged since the last checkpoint: nothing is re-ingested or recomputed',
    };
  }

  const stages: PlannedStage[] = [];
  const skipped: { stage: Stage; why: string }[] = [];
  const incremental = source.hasCheckpoint;

  if (!source.hasCheckpoint) stages.push(code('SOURCE_INDEXING', 'first read: index what the source holds and how it is reached'));
  else skipped.push({ stage: 'SOURCE_INDEXING', why: 'already indexed; a checkpoint exists' });

  if (chosen.kind === 'API' && chosen.updateMechanism === 'PAGED_API') {
    stages.push(code('QUERY_PLANNING', 'a paged API is queried for only the records the question needs'));
  } else skipped.push({ stage: 'QUERY_PLANNING', why: `the chosen route is ${chosen.kind.toLowerCase()} (${chosen.updateMechanism}); no query to plan` });

  const retrieval: RetrievalChoice = {
    route: chosen,
    mode: incremental ? 'INCREMENTAL' : 'FULL',
    why: `${chosen.kind} via ${chosen.updateMechanism}${source.authoritative ? ' from the authoritative publisher' : ''}, preferred over ${source.routes.length - removed.length - 1} other permitted route(s)`,
  };
  if (incremental) {
    stages.push(code('CHANGE_DATA_CAPTURE', 'resume from the checkpoint and read only changed records; only affected facts are recomputed'));
  } else {
    stages.push(code('RETRIEVAL', `full read of the ${chosen.kind.toLowerCase()} route, checkpointed for resumption`));
  }

  const parserTested = source.priorParserRuns > 0 && source.priorParserSuccesses / source.priorParserRuns >= 0.9;
  if (source.structure === 'STRUCTURED' || parserTested) {
    stages.push(code('PARSE_NORMALIZE', parserTested ? 'the tested parser for this source is reused' : 'structured records are parsed by code'));
  } else {
    stages.push(
      llm(
        'PARSE_NORMALIZE',
        'SOURCE_INTERPRETATION',
        `${source.structure.toLowerCase()} content with no tested parser (${source.priorParserSuccesses}/${source.priorParserRuns} prior successes): interpreting it needs reasoning`,
      ),
    );
  }

  if (source.identityCollisionsSuspected && !source.establishedEntityMappings) {
    stages.push(llm('ENTITY_IDENTIFICATION', 'AMBIGUITY', 'identity collisions are suspected and no mapping is established: similar names must not be fused'));
  } else {
    stages.push(code('ENTITY_IDENTIFICATION', source.establishedEntityMappings ? 'established entity mappings are preserved and reused' : 'identifiers are exact: matched by code'));
  }

  if (source.timeSeries) stages.push(code('EVENT_DETECTION', 'the source records things that happened: events are detected from timestamps'));
  else skipped.push({ stage: 'EVENT_DETECTION', why: 'the source records states, not events' });

  if (question.needsRelationships) {
    stages.push(
      deepening.deepen
        ? llm('RELATIONSHIP_EXTRACTION', question.novel ? 'NOVELTY' : 'CONSEQUENTIAL_DECISION', `relationships feed “${question.decision}”: ${deepening.why}`)
        : code('RELATIONSHIP_EXTRACTION', `candidate relationships are found by code; ${deepening.why}`),
    );
  } else skipped.push({ stage: 'RELATIONSHIP_EXTRACTION', why: 'the question does not turn on relationships between parties' });

  stages.push(code('CONTRADICTION_FRESHNESS', 'new facts are checked against held facts and their observation dates before acceptance'));
  stages.push(code('EVIDENCE_ATTACHMENT', 'each fact keeps its source, exact span or record, observation date, scope, units and parser version'));

  if (question.needsReconstruction) stages.push(code('MATH_RECONSTRUCTION', 'the quantity is reconstructed from its parts by code'));
  else skipped.push({ stage: 'MATH_RECONSTRUCTION', why: 'no quantity needs reconstructing' });

  stages.push(
    deepening.deepen && question.decisionValue > 0
      ? llm('GOAL_UPDATE', 'CONSEQUENTIAL_DECISION', `the update can change “${question.decision}”: ${deepening.why}`)
      : code('GOAL_UPDATE', 'the goal variables are updated mechanically from accepted facts'),
  );

  const llmCount = stages.filter((s) => s.executor === 'LLM').length;
  return {
    ...base,
    status: 'PLANNED',
    stages,
    retrieval,
    skipped,
    judgment: `${stages.length} stage(s), ${llmCount} by LLM; ${retrieval.mode.toLowerCase()} read via ${chosen.updateMechanism}; ${removed.length} route(s) removed by constraint`,
  };
}

/** Invariant check used by tests and by any recorder: an LLM stage always carries its reason, a CODE stage never does. */
export function planIsWellFormed(plan: ProcessingPlan): boolean {
  return plan.stages.every((s) => (s.executor === 'LLM' ? s.llmReason !== null && s.why.length > 0 : s.llmReason === null));
}
