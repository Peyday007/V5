/**
 * Rows about outcomes: what Brain expected, what happened, who corrected it,
 * which decisions a lesson changed, what is being watched, and what a person
 * decided about a capability.
 *
 * Every write is an insert. There is no `UPDATE` of an outcome, a prediction,
 * a correction, a decision or a watch change anywhere in this file — a result
 * that changes appends a row, a correction appends a row, and the only column
 * that moves in place is a watch's `last_value`, which is a cursor rather than
 * a record (the record of every change is `outcome_watch_changes`). A test
 * reads this file and holds it to that.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  CapabilityDecisionRow,
  OutcomeCorrectionRow,
  OutcomeDecisionRow,
  OutcomePredictionRow,
  OutcomeRecordRow,
  OutcomeWatchChangeRow,
  OutcomeWatchRow,
} from '../domain/types.ts';
import {
  validateMeasure,
  type Approach,
  type BlockerClass,
  type CapabilityRoute,
  type GoalKind,
  type LearningDecision,
  type OutcomeMeasure,
  type OutcomeResult,
  type WatchFact,
} from '../domain/learning.ts';

// ---------------------------------------------------------------------------
// Predictions
// ---------------------------------------------------------------------------

export interface OutcomePrediction {
  id: string;
  projectId: string;
  approach: Approach;
  subjectKind: string;
  subjectId: string;
  attempt: number;
  recommendation: string;
  expected: string;
  basis: string;
  provenance: 'RECORDED' | 'RECONSTRUCTED';
  decisionId: string | null;
  decidedAt: string;
}

function mapPrediction(row: OutcomePredictionRow): OutcomePrediction {
  return {
    id: row.id,
    projectId: row.project_id,
    approach: row.approach as Approach,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    attempt: row.attempt,
    recommendation: row.recommendation,
    expected: row.expected,
    basis: row.basis,
    provenance: row.provenance as 'RECORDED' | 'RECONSTRUCTED',
    decisionId: row.decision_id,
    decidedAt: row.decided_at,
  };
}

/** One prediction per (approach, subject, attempt); the first writer wins. */
export async function recordPrediction(input: {
  projectId: string;
  approach: Approach;
  subjectKind: string;
  subjectId: string;
  attempt: number;
  recommendation: string;
  expected: string;
  basis: string;
  provenance: 'RECORDED' | 'RECONSTRUCTED';
  decisionId?: string | null;
  decidedAt?: string;
}): Promise<{ prediction: OutcomePrediction; created: boolean }> {
  const id = newId('opr');
  const at = nowIso();
  const result = await getDb().run(
    `INSERT INTO outcome_predictions
       (id, project_id, approach, subject_kind, subject_id, attempt, recommendation,
        expected, basis, provenance, decision_id, decided_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.approach,
      input.subjectKind,
      input.subjectId,
      input.attempt,
      input.recommendation,
      input.expected,
      input.basis,
      input.provenance,
      input.decisionId ?? null,
      input.decidedAt ?? at,
      at,
    ],
  );
  const row = await getDb().get<OutcomePredictionRow>(
    'SELECT * FROM outcome_predictions WHERE approach = ? AND subject_id = ? AND attempt = ?',
    [input.approach, input.subjectId, input.attempt],
  );
  if (!row) throw new Error('A prediction was written and could not be read back.');
  return { prediction: mapPrediction(row), created: result.changes > 0 };
}

export async function getPrediction(
  approach: Approach,
  subjectId: string,
  attempt: number,
): Promise<OutcomePrediction | null> {
  const row = await getDb().get<OutcomePredictionRow>(
    'SELECT * FROM outcome_predictions WHERE approach = ? AND subject_id = ? AND attempt = ?',
    [approach, subjectId, attempt],
  );
  return row ? mapPrediction(row) : null;
}

export async function listPredictions(projectId: string): Promise<OutcomePrediction[]> {
  const rows = await getDb().all<OutcomePredictionRow>(
    'SELECT * FROM outcome_predictions WHERE project_id = ? ORDER BY decided_at, id',
    [projectId],
  );
  return rows.map(mapPrediction);
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export interface OutcomeRecord {
  id: string;
  projectId: string;
  approach: Approach;
  subjectKind: string;
  subjectId: string;
  attempt: number;
  goalKind: GoalKind;
  successCondition: string;
  result: OutcomeResult;
  workPerformed: boolean;
  blockerClass: BlockerClass | null;
  explanation: string;
  measures: OutcomeMeasure[];
  /** The facts a lesson may be scoped by: signal, source packet, round... */
  conditions: Record<string, string | number | null>;
  sourceRefs: string[];
  predictionId: string | null;
  observedAt: string;
}

function mapOutcome(row: OutcomeRecordRow): OutcomeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    approach: row.approach as Approach,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    attempt: row.attempt,
    goalKind: row.goal_kind as GoalKind,
    successCondition: row.success_condition,
    result: row.result as OutcomeResult,
    workPerformed: row.work_performed === 1,
    blockerClass: (row.blocker_class as BlockerClass | null) ?? null,
    explanation: row.explanation,
    measures: parseJson<OutcomeMeasure[]>(row.measures, []),
    conditions: parseJson<Record<string, string | number | null>>(row.conditions, {}),
    sourceRefs: parseJson<string[]>(row.source_refs, []),
    predictionId: row.prediction_id,
    observedAt: row.observed_at,
  };
}

export type NewOutcome = Omit<OutcomeRecord, 'id'>;

/**
 * Append an observed result. Idempotent by (approach, subject, attempt,
 * result): observing the same result twice writes one row, and a result that
 * moved appends a second rather than editing the first.
 */
export async function recordOutcome(
  input: NewOutcome,
): Promise<{ outcome: OutcomeRecord; created: boolean }> {
  for (const measure of input.measures) {
    const problem = validateMeasure(measure);
    if (problem) throw new Error(`Refusing an outcome whose measure is malformed: ${problem}.`);
  }
  const id = newId('ocr');
  const result = await getDb().run(
    `INSERT INTO outcome_records
       (id, project_id, approach, subject_kind, subject_id, attempt, goal_kind,
        success_condition, result, work_performed, blocker_class, explanation,
        measures, conditions, source_refs, prediction_id, observed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.approach,
      input.subjectKind,
      input.subjectId,
      input.attempt,
      input.goalKind,
      input.successCondition,
      input.result,
      input.workPerformed ? 1 : 0,
      input.blockerClass,
      input.explanation,
      toJson(input.measures),
      toJson(input.conditions),
      toJson(input.sourceRefs),
      input.predictionId,
      input.observedAt,
      nowIso(),
    ],
  );
  const row = await getDb().get<OutcomeRecordRow>(
    `SELECT * FROM outcome_records
      WHERE approach = ? AND subject_id = ? AND attempt = ? AND result = ?`,
    [input.approach, input.subjectId, input.attempt, input.result],
  );
  if (!row) throw new Error('An outcome was written and could not be read back.');
  return { outcome: mapOutcome(row), created: result.changes > 0 };
}

/** Every outcome row, oldest observation first. */
export async function listOutcomes(projectId: string, approach?: Approach): Promise<OutcomeRecord[]> {
  const rows = approach
    ? await getDb().all<OutcomeRecordRow>(
        `SELECT * FROM outcome_records WHERE project_id = ? AND approach = ?
          ORDER BY observed_at, created_at, id`,
        [projectId, approach],
      )
    : await getDb().all<OutcomeRecordRow>(
        'SELECT * FROM outcome_records WHERE project_id = ? ORDER BY observed_at, created_at, id',
        [projectId],
      );
  return rows.map(mapOutcome);
}

/**
 * The current result of each attempt: the newest row per (subject, attempt).
 * The older rows stay in the table and in `listOutcomes`; this is the view a
 * lesson reads, because an attempt that parked and then completed is one
 * attempt, not two.
 */
export function currentOutcomes(all: OutcomeRecord[]): OutcomeRecord[] {
  const latest = new Map<string, OutcomeRecord>();
  for (const outcome of all) {
    const key = `${outcome.approach}|${outcome.subjectId}|${outcome.attempt}`;
    const seen = latest.get(key);
    if (!seen || seen.observedAt <= outcome.observedAt) latest.set(key, outcome);
  }
  return [...latest.values()].sort((a, b) =>
    a.observedAt === b.observedAt ? a.id.localeCompare(b.id) : a.observedAt.localeCompare(b.observedAt),
  );
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export interface OutcomeCorrection {
  id: string;
  projectId: string;
  targetKind: 'LESSON' | 'OUTCOME';
  targetKey: string;
  action: 'WITHDRAW' | 'REINSTATE';
  reason: string;
  decidedById: string | null;
  authorityChannel: 'BROWSER' | 'SHELL';
  createdAt: string;
}

function mapCorrection(row: OutcomeCorrectionRow): OutcomeCorrection {
  return {
    id: row.id,
    projectId: row.project_id,
    targetKind: row.target_kind as 'LESSON' | 'OUTCOME',
    targetKey: row.target_key,
    action: row.action as 'WITHDRAW' | 'REINSTATE',
    reason: row.reason,
    decidedById: row.decided_by_id,
    authorityChannel: row.authority_channel as 'BROWSER' | 'SHELL',
    createdAt: row.created_at,
  };
}

export async function recordCorrection(input: {
  projectId: string;
  targetKind: 'LESSON' | 'OUTCOME';
  targetKey: string;
  action: 'WITHDRAW' | 'REINSTATE';
  reason: string;
  decidedById: string | null;
  authorityChannel: 'BROWSER' | 'SHELL';
}): Promise<OutcomeCorrection> {
  if (!input.reason.trim()) {
    throw new Error('A correction needs a reason, or nobody can tell later why a lesson stopped applying.');
  }
  const id = newId('ocx');
  await getDb().run(
    `INSERT INTO outcome_corrections
       (id, project_id, target_kind, target_key, action, reason, decided_by_id,
        authority_channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.targetKind,
      input.targetKey,
      input.action,
      input.reason.trim(),
      input.decidedById,
      input.authorityChannel,
      nowIso(),
    ],
  );
  const row = await getDb().get<OutcomeCorrectionRow>(
    'SELECT * FROM outcome_corrections WHERE id = ?',
    [id],
  );
  if (!row) throw new Error('A correction was written and could not be read back.');
  return mapCorrection(row);
}

export async function listCorrections(projectId: string): Promise<OutcomeCorrection[]> {
  const rows = await getDb().all<OutcomeCorrectionRow>(
    'SELECT * FROM outcome_corrections WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapCorrection);
}

/**
 * Which targets stand withdrawn now: the latest correction per target decides,
 * so a withdrawal can be reinstated and the history of both stays readable.
 */
export function withdrawnTargets(
  corrections: OutcomeCorrection[],
): Map<string, OutcomeCorrection> {
  const latest = new Map<string, OutcomeCorrection>();
  for (const correction of corrections) {
    latest.set(`${correction.targetKind}|${correction.targetKey}`, correction);
  }
  const out = new Map<string, OutcomeCorrection>();
  for (const [key, correction] of latest) {
    if (correction.action === 'WITHDRAW') out.set(key, correction);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decisions a lesson changed
// ---------------------------------------------------------------------------

export interface OutcomeDecision {
  id: string;
  projectId: string;
  decision: LearningDecision;
  subjectId: string;
  defaultChoice: string;
  chosen: string;
  lessonKey: string;
  lessonFingerprint: string;
  outcomeIds: string[];
  reason: string;
  context: Record<string, string | number | null>;
  createdAt: string;
}

function mapDecision(row: OutcomeDecisionRow): OutcomeDecision {
  return {
    id: row.id,
    projectId: row.project_id,
    decision: row.decision as LearningDecision,
    subjectId: row.subject_id,
    defaultChoice: row.default_choice,
    chosen: row.chosen,
    lessonKey: row.lesson_key,
    lessonFingerprint: row.lesson_fingerprint,
    outcomeIds: parseJson<string[]>(row.outcome_ids, []),
    reason: row.reason,
    context: parseJson<Record<string, string | number | null>>(row.context, {}),
    createdAt: row.created_at,
  };
}

/**
 * Record that a lesson changed a decision. Once per (decision, subject, lesson
 * sample, choice): a tick that makes the same change for the same reason on
 * the same evidence does not write a second row, and a new outcome — which
 * changes the fingerprint — does.
 */
export async function recordDecision(input: {
  projectId: string;
  decision: LearningDecision;
  subjectId: string;
  defaultChoice: string;
  chosen: string;
  lessonKey: string;
  lessonFingerprint: string;
  outcomeIds: string[];
  reason: string;
  context?: Record<string, string | number | null>;
}): Promise<{ decision: OutcomeDecision; created: boolean }> {
  const id = newId('odc');
  const result = await getDb().run(
    `INSERT INTO outcome_decisions
       (id, project_id, decision, subject_id, default_choice, chosen, lesson_key,
        lesson_fingerprint, outcome_ids, reason, context, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.decision,
      input.subjectId,
      input.defaultChoice,
      input.chosen,
      input.lessonKey,
      input.lessonFingerprint,
      toJson(input.outcomeIds),
      input.reason,
      toJson(input.context ?? {}),
      nowIso(),
    ],
  );
  const row = await getDb().get<OutcomeDecisionRow>(
    `SELECT * FROM outcome_decisions
      WHERE decision = ? AND subject_id = ? AND lesson_fingerprint = ? AND chosen = ?`,
    [input.decision, input.subjectId, input.lessonFingerprint, input.chosen],
  );
  if (!row) throw new Error('A decision was written and could not be read back.');
  return { decision: mapDecision(row), created: result.changes > 0 };
}

export async function listDecisions(projectId: string): Promise<OutcomeDecision[]> {
  const rows = await getDb().all<OutcomeDecisionRow>(
    'SELECT * FROM outcome_decisions WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapDecision);
}

// ---------------------------------------------------------------------------
// Watches
// ---------------------------------------------------------------------------

export interface OutcomeWatch {
  id: string;
  projectId: string;
  fact: WatchFact;
  factRef: string;
  why: string;
  lastValue: string | null;
  lastCheckedAt: string | null;
}

function mapWatch(row: OutcomeWatchRow): OutcomeWatch {
  return {
    id: row.id,
    projectId: row.project_id,
    fact: row.fact as WatchFact,
    factRef: row.fact_ref,
    why: row.why,
    lastValue: row.last_value,
    lastCheckedAt: row.last_checked_at,
  };
}

export async function ensureWatch(input: {
  projectId: string;
  fact: WatchFact;
  factRef: string;
  why: string;
}): Promise<OutcomeWatch> {
  await getDb().run(
    `INSERT INTO outcome_watches (id, project_id, fact, fact_ref, why, last_value, last_checked_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT DO NOTHING`,
    [newId('owt'), input.projectId, input.fact, input.factRef, input.why, nowIso()],
  );
  const row = await getDb().get<OutcomeWatchRow>(
    'SELECT * FROM outcome_watches WHERE project_id = ? AND fact = ? AND fact_ref = ?',
    [input.projectId, input.fact, input.factRef],
  );
  if (!row) throw new Error('A watch was written and could not be read back.');
  return mapWatch(row);
}

export async function listWatches(projectId: string): Promise<OutcomeWatch[]> {
  const rows = await getDb().all<OutcomeWatchRow>(
    'SELECT * FROM outcome_watches WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapWatch);
}

/**
 * Move a watch's cursor, guarded on the value it was read at. Two ticks that
 * both saw the change produce one move and one ordinary loser, so the change is
 * recorded exactly once.
 */
export async function advanceWatch(input: {
  watchId: string;
  from: string | null;
  to: string;
}): Promise<boolean> {
  const at = nowIso();
  const result =
    input.from === null
      ? await getDb().run(
          `UPDATE outcome_watches SET last_value = ?, last_checked_at = ?
            WHERE id = ? AND last_value IS NULL`,
          [input.to, at, input.watchId],
        )
      : await getDb().run(
          `UPDATE outcome_watches SET last_value = ?, last_checked_at = ?
            WHERE id = ? AND last_value = ?`,
          [input.to, at, input.watchId, input.from],
        );
  return result.changes > 0;
}

export async function touchWatch(watchId: string): Promise<void> {
  await getDb().run('UPDATE outcome_watches SET last_checked_at = ? WHERE id = ?', [nowIso(), watchId]);
}

export interface OutcomeWatchChange {
  id: string;
  watchId: string;
  projectId: string;
  fromValue: string | null;
  toValue: string;
  whatChanged: string;
  proposal: string;
  observedAt: string;
}

function mapWatchChange(row: OutcomeWatchChangeRow): OutcomeWatchChange {
  return {
    id: row.id,
    watchId: row.watch_id,
    projectId: row.project_id,
    fromValue: row.from_value,
    toValue: row.to_value,
    whatChanged: row.what_changed,
    proposal: row.proposal,
    observedAt: row.observed_at,
  };
}

export async function recordWatchChange(input: Omit<OutcomeWatchChange, 'id'>): Promise<OutcomeWatchChange> {
  const id = newId('owc');
  await getDb().run(
    `INSERT INTO outcome_watch_changes
       (id, watch_id, project_id, from_value, to_value, what_changed, proposal, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.watchId,
      input.projectId,
      input.fromValue,
      input.toValue,
      input.whatChanged,
      input.proposal,
      input.observedAt,
    ],
  );
  const row = await getDb().get<OutcomeWatchChangeRow>(
    'SELECT * FROM outcome_watch_changes WHERE id = ?',
    [id],
  );
  if (!row) throw new Error('A watch change was written and could not be read back.');
  return mapWatchChange(row);
}

export async function listWatchChanges(projectId: string, limit = 50): Promise<OutcomeWatchChange[]> {
  const rows = await getDb().all<OutcomeWatchChangeRow>(
    `SELECT * FROM outcome_watch_changes WHERE project_id = ?
      ORDER BY observed_at DESC, id DESC LIMIT ?`,
    [projectId, limit],
  );
  return rows.map(mapWatchChange);
}

// ---------------------------------------------------------------------------
// Capability decisions
// ---------------------------------------------------------------------------

export interface CapabilityDecision {
  id: string;
  projectId: string;
  blockerKey: string;
  route: CapabilityRoute;
  reason: string;
  changeRequestId: string | null;
  landedAt: string | null;
  decidedById: string | null;
  authorityChannel: 'BROWSER' | 'SHELL';
  createdAt: string;
}

function mapCapabilityDecision(row: CapabilityDecisionRow): CapabilityDecision {
  return {
    id: row.id,
    projectId: row.project_id,
    blockerKey: row.blocker_key,
    route: row.route as CapabilityRoute,
    reason: row.reason,
    changeRequestId: row.change_request_id,
    landedAt: row.landed_at,
    decidedById: row.decided_by_id,
    authorityChannel: row.authority_channel as 'BROWSER' | 'SHELL',
    createdAt: row.created_at,
  };
}

/**
 * A person's answer to a capability proposal. Append-only: changing one's mind
 * is a second row, and "the change is live now" is a second row too, carrying
 * `landed_at`, because verification needs to know the instant and a later
 * reader needs to know who said so.
 */
export async function recordCapabilityDecision(input: {
  projectId: string;
  blockerKey: string;
  route: CapabilityRoute;
  reason: string;
  changeRequestId?: string | null;
  landedAt?: string | null;
  decidedById: string | null;
  authorityChannel: 'BROWSER' | 'SHELL';
}): Promise<CapabilityDecision> {
  if (!input.reason.trim()) throw new Error('A capability decision needs a reason.');
  const id = newId('ocd');
  await getDb().run(
    `INSERT INTO capability_decisions
       (id, project_id, blocker_key, route, reason, change_request_id, landed_at,
        decided_by_id, authority_channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.blockerKey,
      input.route,
      input.reason.trim(),
      input.changeRequestId ?? null,
      input.landedAt ?? null,
      input.decidedById,
      input.authorityChannel,
      nowIso(),
    ],
  );
  const row = await getDb().get<CapabilityDecisionRow>(
    'SELECT * FROM capability_decisions WHERE id = ?',
    [id],
  );
  if (!row) throw new Error('A capability decision was written and could not be read back.');
  return mapCapabilityDecision(row);
}

export async function listCapabilityDecisions(projectId: string): Promise<CapabilityDecision[]> {
  const rows = await getDb().all<CapabilityDecisionRow>(
    'SELECT * FROM capability_decisions WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapCapabilityDecision);
}
