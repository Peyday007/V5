/**
 * Learned subjects, search methods, their runs, learned detectors and the
 * examples that measure them. Every read is filtered by scope for the reader;
 * nothing is deleted.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import {
  scopeProblem,
  type DetectorExample,
  type DetectorMode,
  type ExampleVerdict,
  type LearnedDetector,
  type LearnedSubject,
  type MethodTrustState,
  type RunExecutor,
  type RunOutcome,
  type ScopeRef,
  type SearchMethod,
  type SearchMethodRun,
  type SearchReader,
} from '../domain/searchIntelligence.ts';

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** SQL that keeps GENERAL rows and the reader's own PROJECT and USER rows. */
function visibleSql(reader: SearchReader, alias = ''): { sql: string; params: SqlParam[] } {
  const p = alias ? `${alias}.` : '';
  const parts = [`${p}scope = 'GENERAL'`];
  const params: SqlParam[] = [];
  if (reader.projectIds.length > 0) {
    parts.push(`(${p}scope = 'PROJECT' AND ${p}project_id IN (${reader.projectIds.map(() => '?').join(', ')}))`);
    params.push(...reader.projectIds);
  }
  if (reader.userId) {
    parts.push(`(${p}scope = 'USER' AND ${p}user_id = ?)`);
    params.push(reader.userId);
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

function requireScope(ref: ScopeRef): void {
  const problem = scopeProblem(ref);
  if (problem) throw new Error(problem);
}

const toSubject = (r: Row): LearnedSubject => ({
  id: str(r.id),
  scope: r.scope as LearnedSubject['scope'],
  projectId: optStr(r.project_id),
  userId: optStr(r.user_id),
  subjectKey: str(r.subject_key),
  label: str(r.label),
  description: optStr(r.description),
  origin: str(r.origin),
  sourceRef: optStr(r.source_ref),
  state: r.state as LearnedSubject['state'],
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

const toMethod = (r: Row): SearchMethod => ({
  id: str(r.id),
  scope: r.scope as SearchMethod['scope'],
  projectId: optStr(r.project_id),
  userId: optStr(r.user_id),
  methodKey: str(r.method_key),
  subjectId: optStr(r.subject_id),
  finds: str(r.finds),
  usefulWhen: optStr(r.useful_when),
  sources: parseJson<string[]>(optStr(r.sources), []),
  requiredInputs: parseJson<string[]>(optStr(r.required_inputs), []),
  query: optStr(r.query),
  checkProcedure: str(r.check_procedure),
  limits: optStr(r.limits),
  trustState: r.trust_state as MethodTrustState,
  trustReason: optStr(r.trust_reason),
  version: Number(r.version),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

const toRun = (r: Row): SearchMethodRun => ({
  id: str(r.id),
  methodId: str(r.method_id),
  executor: r.executor as RunExecutor,
  outcome: r.outcome as RunOutcome,
  failureCause: optStr(r.failure_cause),
  examined: Number(r.examined),
  surfaced: Number(r.surfaced),
  confirmed: Number(r.confirmed),
  rejected: Number(r.rejected),
  startedAt: str(r.started_at),
  finishedAt: str(r.finished_at),
});

const toDetector = (r: Row): LearnedDetector => ({
  id: str(r.id),
  scope: r.scope as LearnedDetector['scope'],
  projectId: optStr(r.project_id),
  userId: optStr(r.user_id),
  methodId: optStr(r.method_id),
  detectorKey: str(r.detector_key),
  version: Number(r.version),
  definition: parseJson<unknown>(optStr(r.definition), null),
  mode: r.mode as DetectorMode,
  threshold: Number(r.threshold),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

const toExample = (r: Row): DetectorExample => ({
  id: str(r.id),
  detectorId: str(r.detector_id),
  itemRef: str(r.item_ref),
  fired: Number(r.fired) === 1,
  verdict: r.verdict as ExampleVerdict,
  labelledBy: str(r.labelled_by),
  createdAt: str(r.created_at),
});

// ---- learned subjects -------------------------------------------------------

export async function upsertLearnedSubject(
  input: ScopeRef & { subjectKey: string; label: string; description?: string | null; origin: string; sourceRef?: string | null },
): Promise<LearnedSubject> {
  requireScope(input);
  const db = getDb();
  const at = nowIso();
  const project = input.projectId ?? null;
  const user = input.userId ?? null;
  await db.run(
    `INSERT INTO learned_subjects
       (id, scope, project_id, user_id, subject_key, label, description, origin, source_ref, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
     ON CONFLICT DO NOTHING`,
    [newId('lsj'), input.scope, project, user, input.subjectKey, input.label, input.description ?? null, input.origin, input.sourceRef ?? null, at, at],
  );
  const row = await db.get<Row>(
    `SELECT * FROM learned_subjects
      WHERE scope = ? AND COALESCE(project_id, '') = ? AND COALESCE(user_id, '') = ? AND subject_key = ?`,
    [input.scope, project ?? '', user ?? '', input.subjectKey],
  );
  if (!row) throw new Error('A learned subject was not found after it was written.');
  return toSubject(row);
}

export async function listLearnedSubjects(reader: SearchReader, opts: { includeRetired?: boolean } = {}): Promise<LearnedSubject[]> {
  const vis = visibleSql(reader);
  const rows = await getDb().all<Row>(
    `SELECT * FROM learned_subjects WHERE ${vis.sql}${opts.includeRetired ? '' : " AND state = 'ACTIVE'"}
      ORDER BY created_at, id`,
    vis.params,
  );
  return rows.map(toSubject);
}

export async function retireLearnedSubject(id: string): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE learned_subjects SET state = 'RETIRED', updated_at = ? WHERE id = ? AND state = 'ACTIVE'`,
    [nowIso(), id],
  );
  return (r.changes ?? 0) > 0;
}

// ---- search methods ---------------------------------------------------------

export async function createSearchMethod(
  input: ScopeRef & {
    methodKey: string;
    subjectId?: string | null;
    finds: string;
    usefulWhen?: string | null;
    sources: string[];
    requiredInputs?: string[];
    query?: string | null;
    checkProcedure: string;
    limits?: string | null;
    version?: number;
  },
): Promise<SearchMethod> {
  requireScope(input);
  const db = getDb();
  const at = nowIso();
  const project = input.projectId ?? null;
  const user = input.userId ?? null;
  const version = input.version ?? 1;
  await db.run(
    `INSERT INTO search_methods
       (id, scope, project_id, user_id, method_key, subject_id, finds, useful_when, sources, required_inputs,
        query, check_procedure, limits, trust_state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      newId('smd'), input.scope, project, user, input.methodKey, input.subjectId ?? null, input.finds,
      input.usefulWhen ?? null, toJson(input.sources), toJson(input.requiredInputs ?? []), input.query ?? null,
      input.checkProcedure, input.limits ?? null, version, at, at,
    ],
  );
  const row = await db.get<Row>(
    `SELECT * FROM search_methods
      WHERE scope = ? AND COALESCE(project_id, '') = ? AND COALESCE(user_id, '') = ? AND method_key = ? AND version = ?`,
    [input.scope, project ?? '', user ?? '', input.methodKey, version],
  );
  if (!row) throw new Error('A search method was not found after it was written.');
  return toMethod(row);
}

export async function getSearchMethod(reader: SearchReader, id: string): Promise<SearchMethod | null> {
  const vis = visibleSql(reader);
  const row = await getDb().get<Row>(`SELECT * FROM search_methods WHERE id = ? AND ${vis.sql}`, [id, ...vis.params]);
  return row ? toMethod(row) : null;
}

export async function listSearchMethods(reader: SearchReader, opts: { trustState?: MethodTrustState } = {}): Promise<SearchMethod[]> {
  const vis = visibleSql(reader);
  const params = [...vis.params];
  let extra = '';
  if (opts.trustState) {
    extra = ' AND trust_state = ?';
    params.push(opts.trustState);
  }
  const rows = await getDb().all<Row>(
    `SELECT * FROM search_methods WHERE ${vis.sql}${extra} ORDER BY created_at, id`,
    params,
  );
  return rows.map(toMethod);
}

/** Move a method's trust state; guarded on the state the caller read. */
export async function setMethodTrust(id: string, from: MethodTrustState, to: MethodTrustState, reason: string): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE search_methods SET trust_state = ?, trust_reason = ?, updated_at = ? WHERE id = ? AND trust_state = ?`,
    [to, reason, nowIso(), id, from],
  );
  return (r.changes ?? 0) > 0;
}

// ---- runs -------------------------------------------------------------------

export async function recordMethodRun(input: {
  methodId: string;
  executor: RunExecutor;
  outcome: RunOutcome;
  failureCause?: string | null;
  examined?: number;
  surfaced?: number;
  confirmed?: number;
  rejected?: number;
  startedAt?: string;
  finishedAt?: string;
}): Promise<SearchMethodRun> {
  const id = newId('smr');
  const finished = input.finishedAt ?? nowIso();
  await getDb().run(
    `INSERT INTO search_method_runs
       (id, method_id, executor, outcome, failure_cause, examined, surfaced, confirmed, rejected, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.methodId, input.executor, input.outcome, input.failureCause ?? null, input.examined ?? 0, input.surfaced ?? 0,
      input.confirmed ?? 0, input.rejected ?? 0, input.startedAt ?? finished, finished],
  );
  const row = await getDb().get<Row>(`SELECT * FROM search_method_runs WHERE id = ?`, [id]);
  if (!row) throw new Error('A method run was not found after it was written.');
  return toRun(row);
}

/** Runs of a method the reader can see, oldest first. */
export async function listMethodRuns(reader: SearchReader, methodId: string): Promise<SearchMethodRun[]> {
  if (!(await getSearchMethod(reader, methodId))) return [];
  const rows = await getDb().all<Row>(
    `SELECT * FROM search_method_runs WHERE method_id = ? ORDER BY finished_at, id`,
    [methodId],
  );
  return rows.map(toRun);
}

// ---- detectors --------------------------------------------------------------

export async function createLearnedDetector(
  input: ScopeRef & { detectorKey: string; methodId?: string | null; definition: unknown; threshold: number; version?: number },
): Promise<LearnedDetector> {
  requireScope(input);
  const db = getDb();
  const at = nowIso();
  const project = input.projectId ?? null;
  const user = input.userId ?? null;
  const version = input.version ?? 1;
  await db.run(
    `INSERT INTO learned_detectors
       (id, scope, project_id, user_id, method_id, detector_key, version, definition, mode, threshold, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SHADOW', ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [newId('ldt'), input.scope, project, user, input.methodId ?? null, input.detectorKey, version, toJson(input.definition), input.threshold, at, at],
  );
  const row = await db.get<Row>(
    `SELECT * FROM learned_detectors
      WHERE scope = ? AND COALESCE(project_id, '') = ? AND COALESCE(user_id, '') = ? AND detector_key = ? AND version = ?`,
    [input.scope, project ?? '', user ?? '', input.detectorKey, version],
  );
  if (!row) throw new Error('A learned detector was not found after it was written.');
  return toDetector(row);
}

export async function listLearnedDetectors(reader: SearchReader, opts: { mode?: DetectorMode } = {}): Promise<LearnedDetector[]> {
  const vis = visibleSql(reader);
  const params = [...vis.params];
  let extra = '';
  if (opts.mode) {
    extra = ' AND mode = ?';
    params.push(opts.mode);
  }
  const rows = await getDb().all<Row>(
    `SELECT * FROM learned_detectors WHERE ${vis.sql}${extra} ORDER BY created_at, id`,
    params,
  );
  return rows.map(toDetector);
}

/** Change a detector's mode; guarded on the mode the caller read. */
export async function setDetectorMode(id: string, from: DetectorMode, to: DetectorMode): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE learned_detectors SET mode = ?, updated_at = ? WHERE id = ? AND mode = ?`,
    [to, nowIso(), id, from],
  );
  return (r.changes ?? 0) > 0;
}

/** A labelled example; the first label for an (detector, item) pair stands. */
export async function recordDetectorExample(input: {
  detectorId: string;
  itemRef: string;
  fired: boolean;
  verdict: ExampleVerdict;
  labelledBy: string;
}): Promise<boolean> {
  const r = await getDb().run(
    `INSERT INTO detector_examples (id, detector_id, item_ref, fired, verdict, labelled_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (detector_id, item_ref) DO NOTHING`,
    [newId('dex'), input.detectorId, input.itemRef, input.fired ? 1 : 0, input.verdict, input.labelledBy, nowIso()],
  );
  return (r.changes ?? 0) > 0;
}

export async function listDetectorExamples(reader: SearchReader, detectorId: string): Promise<DetectorExample[]> {
  const vis = visibleSql(reader, 'd');
  const rows = await getDb().all<Row>(
    `SELECT e.* FROM detector_examples e JOIN learned_detectors d ON d.id = e.detector_id
      WHERE e.detector_id = ? AND ${vis.sql} ORDER BY e.created_at, e.id`,
    [detectorId, ...vis.params],
  );
  return rows.map(toExample);
}
