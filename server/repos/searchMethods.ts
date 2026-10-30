/**
 * Learned subjects, search methods, their runs, and data-defined detectors.
 * Every read is filtered by who is asking, in the statement itself.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import {
  scopeKeyFor,
  type DetectorExample,
  type DetectorMode,
  type ExampleLabel,
  type LearnedDetector,
  type LearnedSubject,
  type MethodTrustState,
  type RunExecutor,
  type RunOutcome,
  type SearchMethod,
  type SearchMethodRun,
  type SearchScope,
  type SearchViewer,
} from '../domain/searchIntelligence.ts';

/** SQL that admits GENERAL, the viewer's projects and the viewer's own user rows. */
function visibleSql(viewer: SearchViewer, alias = ''): { sql: string; params: SqlParam[] } {
  const a = alias ? `${alias}.` : '';
  const parts = [`${a}scope = 'GENERAL'`];
  const params: SqlParam[] = [];
  if (viewer.projectIds.length > 0) {
    parts.push(`(${a}scope = 'PROJECT' AND ${a}project_id IN (${viewer.projectIds.map(() => '?').join(', ')}))`);
    params.push(...viewer.projectIds);
  }
  if (viewer.userId) {
    parts.push(`(${a}scope = 'USER' AND ${a}owner_user_id = ?)`);
    params.push(viewer.userId);
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

interface Scoped {
  scope: SearchScope;
  projectId?: string | null;
  ownerUserId?: string | null;
}

// ---------------------------------------------------------------- subjects

interface SubjectRow {
  id: string; scope: SearchScope; project_id: string | null; owner_user_id: string | null;
  subject_key: string; label: string; description: string | null; origin: string;
  source_ref: string | null; state: 'ACTIVE' | 'RETIRED'; created_at: string; updated_at: string;
}
const toSubject = (r: SubjectRow): LearnedSubject => ({
  id: r.id, scope: r.scope, projectId: r.project_id, ownerUserId: r.owner_user_id,
  subjectKey: r.subject_key, label: r.label, description: r.description, origin: r.origin,
  sourceRef: r.source_ref, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Retain a subject; the same subject in the same scope is one row. */
export async function upsertLearnedSubject(
  input: Scoped & { subjectKey: string; label: string; description?: string | null; origin: string; sourceRef?: string | null },
): Promise<LearnedSubject> {
  const projectId = input.projectId ?? null;
  const ownerUserId = input.ownerUserId ?? null;
  const scopeKey = scopeKeyFor(input.scope, projectId, ownerUserId);
  const at = nowIso();
  await getDb().run(
    `INSERT INTO learned_subjects
       (id, scope, project_id, owner_user_id, scope_key, subject_key, label, description, origin, source_ref, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
     ON CONFLICT (scope_key, subject_key) DO NOTHING`,
    [newId('lsb'), input.scope, projectId, ownerUserId, scopeKey, input.subjectKey, input.label, input.description ?? null, input.origin, input.sourceRef ?? null, at, at],
  );
  const row = await getDb().get<SubjectRow>('SELECT * FROM learned_subjects WHERE scope_key = ? AND subject_key = ?', [scopeKey, input.subjectKey]);
  if (!row) throw new Error('Learned subject vanished after insert.');
  return toSubject(row);
}

export async function listLearnedSubjects(viewer: SearchViewer, opts: { includeRetired?: boolean } = {}): Promise<LearnedSubject[]> {
  const v = visibleSql(viewer);
  const rows = await getDb().all<SubjectRow>(
    `SELECT * FROM learned_subjects WHERE ${v.sql}${opts.includeRetired ? '' : " AND state = 'ACTIVE'"} ORDER BY created_at, id`,
    v.params,
  );
  return rows.map(toSubject);
}

export async function retireLearnedSubject(id: string): Promise<boolean> {
  const r = await getDb().run(`UPDATE learned_subjects SET state = 'RETIRED', updated_at = ? WHERE id = ? AND state = 'ACTIVE'`, [nowIso(), id]);
  return (r.changes ?? 0) > 0;
}

// ----------------------------------------------------------------- methods

interface MethodRow {
  id: string; scope: SearchScope; project_id: string | null; owner_user_id: string | null;
  subject_id: string | null; name: string; finds: string; useful_when: string | null;
  sources: string; required_inputs: string; query_filter: string | null; check_procedure: string | null;
  observed_limits: string; trust_state: MethodTrustState; trust_reason: string | null;
  trust_changed_at: string | null; version: number; created_at: string; updated_at: string;
}
const toMethod = (r: MethodRow): SearchMethod => ({
  id: r.id, scope: r.scope, projectId: r.project_id, ownerUserId: r.owner_user_id,
  subjectId: r.subject_id, name: r.name, finds: r.finds, usefulWhen: r.useful_when,
  sources: parseJson<string[]>(r.sources, []), requiredInputs: parseJson<string[]>(r.required_inputs, []),
  queryFilter: r.query_filter, checkProcedure: r.check_procedure,
  observedLimits: parseJson<string[]>(r.observed_limits, []), trustState: r.trust_state,
  trustReason: r.trust_reason, trustChangedAt: r.trust_changed_at, version: r.version,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

/** A new method is always PROPOSED; trust is earned by runs, never supplied. */
export async function createSearchMethod(
  input: Scoped & {
    subjectId?: string | null; name: string; finds: string; usefulWhen?: string | null;
    sources?: string[]; requiredInputs?: string[]; queryFilter?: string | null; checkProcedure?: string | null;
  },
): Promise<SearchMethod> {
  scopeKeyFor(input.scope, input.projectId ?? null, input.ownerUserId ?? null);
  const id = newId('smt');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO search_methods
       (id, scope, project_id, owner_user_id, subject_id, name, finds, useful_when, sources, required_inputs,
        query_filter, check_procedure, observed_limits, trust_state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'PROPOSED', 1, ?, ?)`,
    [id, input.scope, input.projectId ?? null, input.ownerUserId ?? null, input.subjectId ?? null, input.name, input.finds,
      input.usefulWhen ?? null, toJson(input.sources ?? []), toJson(input.requiredInputs ?? []),
      input.queryFilter ?? null, input.checkProcedure ?? null, at, at],
  );
  return (await getSearchMethod(id))!;
}

async function getSearchMethod(id: string): Promise<SearchMethod | null> {
  const row = await getDb().get<MethodRow>('SELECT * FROM search_methods WHERE id = ?', [id]);
  return row ? toMethod(row) : null;
}

/** Absent and not-yours are the same answer. */
export async function readSearchMethod(viewer: SearchViewer, id: string): Promise<SearchMethod | null> {
  const v = visibleSql(viewer);
  const row = await getDb().get<MethodRow>(`SELECT * FROM search_methods WHERE id = ? AND ${v.sql}`, [id, ...v.params]);
  return row ? toMethod(row) : null;
}

export async function listSearchMethods(viewer: SearchViewer, opts: { trustState?: MethodTrustState } = {}): Promise<SearchMethod[]> {
  const v = visibleSql(viewer);
  const rows = await getDb().all<MethodRow>(
    `SELECT * FROM search_methods WHERE ${v.sql}${opts.trustState ? ' AND trust_state = ?' : ''} ORDER BY created_at, id`,
    opts.trustState ? [...v.params, opts.trustState] : v.params,
  );
  return rows.map(toMethod);
}

/** Move trust, guarded on the state the caller read. A loser gets false. */
export async function setMethodTrust(id: string, from: MethodTrustState, to: MethodTrustState, reason: string): Promise<boolean> {
  const at = nowIso();
  const r = await getDb().run(
    'UPDATE search_methods SET trust_state = ?, trust_reason = ?, trust_changed_at = ?, updated_at = ? WHERE id = ? AND trust_state = ?',
    [to, reason, at, at, id, from],
  );
  return (r.changes ?? 0) > 0;
}

/** Observed limits only grow; each is kept verbatim. */
export async function addObservedLimit(id: string, limit: string): Promise<void> {
  const m = await getSearchMethod(id);
  if (!m || m.observedLimits.includes(limit)) return;
  await getDb().run('UPDATE search_methods SET observed_limits = ?, updated_at = ? WHERE id = ?', [toJson([...m.observedLimits, limit]), nowIso(), id]);
}

// -------------------------------------------------------------------- runs

interface RunRow {
  id: string; method_id: string; method_version: number; executor: RunExecutor; started_at: string;
  finished_at: string | null; items_examined: number | string; items_found: number | string;
  items_accepted: number | string; false_positives: number | string; outcome: RunOutcome; failure_note: string | null;
}
const toRun = (r: RunRow): SearchMethodRun => ({
  id: r.id, methodId: r.method_id, methodVersion: r.method_version, executor: r.executor,
  startedAt: r.started_at, finishedAt: r.finished_at, itemsExamined: Number(r.items_examined),
  itemsFound: Number(r.items_found), itemsAccepted: Number(r.items_accepted),
  falsePositives: Number(r.false_positives), outcome: r.outcome, failureNote: r.failure_note,
});

export async function startMethodRun(methodId: string, executor: RunExecutor): Promise<SearchMethodRun> {
  const m = await getSearchMethod(methodId);
  if (!m) throw new Error('No such search method.');
  const id = newId('smr');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO search_method_runs (id, method_id, method_version, executor, started_at, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, 'RUNNING', ?)`,
    [id, methodId, m.version, executor, at, at],
  );
  return toRun((await getDb().get<RunRow>('SELECT * FROM search_method_runs WHERE id = ?', [id]))!);
}

/** A run finishes once; a second finish matches nothing. */
export async function finishMethodRun(
  id: string,
  result: { itemsExamined: number; itemsFound: number; itemsAccepted: number; falsePositives: number; outcome: Exclude<RunOutcome, 'RUNNING'>; failureNote?: string | null },
): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE search_method_runs SET finished_at = ?, items_examined = ?, items_found = ?, items_accepted = ?,
       false_positives = ?, outcome = ?, failure_note = ? WHERE id = ? AND outcome = 'RUNNING'`,
    [nowIso(), result.itemsExamined, result.itemsFound, result.itemsAccepted, result.falsePositives, result.outcome, result.failureNote ?? null, id],
  );
  return (r.changes ?? 0) > 0;
}

export async function listMethodRuns(methodId: string, limit = 50): Promise<SearchMethodRun[]> {
  const rows = await getDb().all<RunRow>('SELECT * FROM search_method_runs WHERE method_id = ? ORDER BY started_at DESC, id DESC LIMIT ?', [methodId, limit]);
  return rows.map(toRun);
}

// --------------------------------------------------------------- detectors

interface DetectorRow {
  id: string; method_id: string | null; scope: SearchScope; project_id: string | null; owner_user_id: string | null;
  rule_key: string; version: number; definition: string; mode: DetectorMode; threshold: number | string;
  mode_reason: string | null; mode_changed_at: string | null; created_at: string; updated_at: string;
}
const toDetector = (r: DetectorRow): LearnedDetector => ({
  id: r.id, methodId: r.method_id, scope: r.scope, projectId: r.project_id, ownerUserId: r.owner_user_id,
  ruleKey: r.rule_key, version: r.version, definition: parseJson<unknown>(r.definition, null), mode: r.mode,
  threshold: Number(r.threshold), modeReason: r.mode_reason, modeChangedAt: r.mode_changed_at,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

/** A learned detector starts SHADOW. Re-creating the same (rule, version) returns the first. */
export async function createLearnedDetector(
  input: Scoped & { methodId?: string | null; ruleKey: string; version?: number; definition: unknown; threshold?: number },
): Promise<LearnedDetector> {
  scopeKeyFor(input.scope, input.projectId ?? null, input.ownerUserId ?? null);
  const version = input.version ?? 1;
  const at = nowIso();
  await getDb().run(
    `INSERT INTO learned_detectors
       (id, method_id, scope, project_id, owner_user_id, rule_key, version, definition, mode, threshold, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SHADOW', ?, ?, ?)
     ON CONFLICT (rule_key, version) DO NOTHING`,
    [newId('ldt'), input.methodId ?? null, input.scope, input.projectId ?? null, input.ownerUserId ?? null, input.ruleKey, version,
      toJson(input.definition), input.threshold ?? 0.9, at, at],
  );
  return toDetector((await getDb().get<DetectorRow>('SELECT * FROM learned_detectors WHERE rule_key = ? AND version = ?', [input.ruleKey, version]))!);
}

export async function listLearnedDetectors(viewer: SearchViewer, opts: { mode?: DetectorMode } = {}): Promise<LearnedDetector[]> {
  const v = visibleSql(viewer);
  const rows = await getDb().all<DetectorRow>(
    `SELECT * FROM learned_detectors WHERE ${v.sql}${opts.mode ? ' AND mode = ?' : ''} ORDER BY created_at, id`,
    opts.mode ? [...v.params, opts.mode] : v.params,
  );
  return rows.map(toDetector);
}

/** Move a detector's mode, guarded on the mode the caller read. */
export async function setDetectorMode(id: string, from: DetectorMode, to: DetectorMode, reason: string): Promise<boolean> {
  const at = nowIso();
  const r = await getDb().run(
    'UPDATE learned_detectors SET mode = ?, mode_reason = ?, mode_changed_at = ?, updated_at = ? WHERE id = ? AND mode = ?',
    [to, reason, at, at, id, from],
  );
  return (r.changes ?? 0) > 0;
}

interface ExampleRow {
  id: string; detector_id: string; item_ref: string; label: ExampleLabel; predicted: number; labelled_by: string; created_at: string;
}

/** One label per (detector, item); a repeat is left as first written. */
export async function addDetectorExample(input: { detectorId: string; itemRef: string; label: ExampleLabel; predicted: boolean; labelledBy: string }): Promise<boolean> {
  const r = await getDb().run(
    `INSERT INTO detector_examples (id, detector_id, item_ref, label, predicted, labelled_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (detector_id, item_ref) DO NOTHING`,
    [newId('dex'), input.detectorId, input.itemRef, input.label, input.predicted ? 1 : 0, input.labelledBy, nowIso()],
  );
  return (r.changes ?? 0) > 0;
}

export async function listDetectorExamples(detectorId: string): Promise<DetectorExample[]> {
  const rows = await getDb().all<ExampleRow>('SELECT * FROM detector_examples WHERE detector_id = ? ORDER BY created_at, id', [detectorId]);
  return rows.map((r) => ({
    id: r.id, detectorId: r.detector_id, itemRef: r.item_ref, label: r.label,
    predicted: r.predicted === 1, labelledBy: r.labelled_by, createdAt: r.created_at,
  }));
}
