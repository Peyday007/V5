/**
 * Learned subjects, search methods and their runs, learned detectors and the
 * examples they were judged on. Every read is scope-filtered: GENERAL rows plus
 * the asker's own PROJECT / USER rows, never another's. A read with neither a
 * project nor a user sees GENERAL only.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import {
  scopeOwnerError, TRUST_STATES,
  type LearnedDetector, type LearnedSubject, type RunOutcome, type SearchMethod, type SearchMethodRun,
  type SearchScope, type SearchViewer, type TrustState,
} from '../domain/searchIntelligence.ts';

/** `(scope = 'GENERAL' OR (scope = 'PROJECT' AND project_id = ?) OR (scope = 'USER' AND user_id = ?))` */
function visible(v: SearchViewer): { sql: string; params: (string | null)[] } {
  return {
    sql: `(scope = 'GENERAL' OR (scope = 'PROJECT' AND project_id = ?) OR (scope = 'USER' AND user_id = ?))`,
    params: [v.projectId ?? null, v.userId ?? null],
  };
}

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null ? null : String(v));

function mapSubject(r: Row): LearnedSubject {
  return { id: String(r.id), scope: r.scope as SearchScope, projectId: s(r.project_id), userId: s(r.user_id), subject: String(r.subject), learnedFrom: s(r.learned_from), createdAt: String(r.created_at) };
}
function mapMethod(r: Row): SearchMethod {
  return {
    id: String(r.id), scope: r.scope as SearchScope, projectId: s(r.project_id), userId: s(r.user_id), name: String(r.name), finds: String(r.finds),
    usefulWhen: s(r.useful_when), sources: parseJson<string[]>(s(r.sources), []), requiredInputs: parseJson<string[]>(s(r.required_inputs), []),
    queryFilter: s(r.query_filter), checkProcedure: s(r.check_procedure), observedLimits: s(r.observed_limits),
    trustState: r.trust_state as TrustState, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}
function mapRun(r: Row): SearchMethodRun {
  const n = (v: unknown): number | null => (v == null ? null : Number(v));
  return { id: String(r.id), methodId: String(r.method_id), projectId: s(r.project_id), startedAt: String(r.started_at), finishedAt: s(r.finished_at), examined: n(r.examined), kept: n(r.kept), falsePositives: n(r.false_positives), outcome: (s(r.outcome) as RunOutcome | null), failureCause: s(r.failure_cause) };
}
function mapDetector(r: Row): LearnedDetector {
  return { id: String(r.id), methodId: s(r.method_id), scope: r.scope as SearchScope, projectId: s(r.project_id), userId: s(r.user_id), definition: parseJson<Record<string, unknown>>(s(r.definition), {}), version: Number(r.version), mode: r.mode as LearnedDetector['mode'], threshold: r.threshold == null ? null : Number(r.threshold), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}

export async function recordSubject(input: { scope: SearchScope; projectId?: string | null; userId?: string | null; subject: string; learnedFrom?: string | null }): Promise<LearnedSubject> {
  const bad = scopeOwnerError(input.scope, input.projectId, input.userId);
  if (bad) throw new Error(bad);
  const db = getDb();
  const id = newId('lsub');
  await db.run(
    `INSERT INTO learned_subjects (id, scope, project_id, user_id, subject, learned_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [id, input.scope, input.projectId ?? null, input.userId ?? null, input.subject, input.learnedFrom ?? null, nowIso()],
  );
  const row = await db.get<Row>(
    `SELECT * FROM learned_subjects WHERE scope = ? AND COALESCE(project_id, '') = ? AND COALESCE(user_id, '') = ? AND subject = ?`,
    [input.scope, input.projectId ?? '', input.userId ?? '', input.subject],
  );
  return mapSubject(row!);
}

export async function listSubjects(v: SearchViewer): Promise<LearnedSubject[]> {
  const f = visible(v);
  return (await getDb().all<Row>(`SELECT * FROM learned_subjects WHERE ${f.sql} ORDER BY created_at, id`, f.params)).map(mapSubject);
}

export async function createMethod(input: {
  scope: SearchScope; projectId?: string | null; userId?: string | null; name: string; finds: string;
  usefulWhen?: string | null; sources?: string[]; requiredInputs?: string[]; queryFilter?: string | null;
  checkProcedure?: string | null; observedLimits?: string | null;
}): Promise<SearchMethod> {
  const bad = scopeOwnerError(input.scope, input.projectId, input.userId);
  if (bad) throw new Error(bad);
  const id = newId('smeth');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO search_methods (id, scope, project_id, user_id, name, finds, useful_when, sources, required_inputs, query_filter, check_procedure, observed_limits, trust_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?)`,
    [id, input.scope, input.projectId ?? null, input.userId ?? null, input.name, input.finds, input.usefulWhen ?? null,
      toJson(input.sources ?? []), toJson(input.requiredInputs ?? []), input.queryFilter ?? null, input.checkProcedure ?? null, input.observedLimits ?? null, at, at],
  );
  return (await getMethod(id, { projectId: input.projectId, userId: input.userId }))!;
}

export async function getMethod(id: string, v: SearchViewer): Promise<SearchMethod | null> {
  const f = visible(v);
  const r = await getDb().get<Row>(`SELECT * FROM search_methods WHERE id = ? AND ${f.sql}`, [id, ...f.params]);
  return r ? mapMethod(r) : null;
}

export async function listMethods(v: SearchViewer, opts: { trustState?: TrustState } = {}): Promise<SearchMethod[]> {
  const f = visible(v);
  const rows = opts.trustState
    ? await getDb().all<Row>(`SELECT * FROM search_methods WHERE ${f.sql} AND trust_state = ? ORDER BY created_at, id`, [...f.params, opts.trustState])
    : await getDb().all<Row>(`SELECT * FROM search_methods WHERE ${f.sql} ORDER BY created_at, id`, f.params);
  return rows.map(mapMethod);
}

/** Guarded on the state that was read, so two writers produce one move. */
export async function setTrustState(input: { id: string; from: TrustState; to: TrustState }): Promise<boolean> {
  if (!TRUST_STATES.includes(input.to)) return false;
  const r = await getDb().run(`UPDATE search_methods SET trust_state = ?, updated_at = ? WHERE id = ? AND trust_state = ?`, [input.to, nowIso(), input.id, input.from]);
  return r.changes === 1;
}

export async function startRun(input: { methodId: string; projectId?: string | null }): Promise<string> {
  const id = newId('smrun');
  await getDb().run(`INSERT INTO search_method_runs (id, method_id, project_id, started_at) VALUES (?, ?, ?, ?)`, [id, input.methodId, input.projectId ?? null, nowIso()]);
  return id;
}

/** Finish a run once; the first result stands. */
export async function finishRun(input: { id: string; examined: number; kept: number; falsePositives: number; outcome: RunOutcome; failureCause?: string | null }): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE search_method_runs SET finished_at = ?, examined = ?, kept = ?, false_positives = ?, outcome = ?, failure_cause = ? WHERE id = ? AND finished_at IS NULL`,
    [nowIso(), input.examined, input.kept, input.falsePositives, input.outcome, input.failureCause ?? null, input.id],
  );
  return r.changes === 1;
}

export async function listRuns(methodId: string, v: SearchViewer): Promise<SearchMethodRun[]> {
  if (!(await getMethod(methodId, v))) return [];
  return (await getDb().all<Row>(`SELECT * FROM search_method_runs WHERE method_id = ? ORDER BY started_at, id`, [methodId])).map(mapRun);
}

export async function createDetector(input: { scope: SearchScope; projectId?: string | null; userId?: string | null; methodId?: string | null; definition: Record<string, unknown>; threshold?: number | null }): Promise<LearnedDetector> {
  const bad = scopeOwnerError(input.scope, input.projectId, input.userId);
  if (bad) throw new Error(bad);
  const id = newId('ldet');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO learned_detectors (id, method_id, scope, project_id, user_id, definition, version, mode, threshold, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'SHADOW', ?, ?, ?)`,
    [id, input.methodId ?? null, input.scope, input.projectId ?? null, input.userId ?? null, toJson(input.definition), input.threshold ?? null, at, at],
  );
  return (await getDetector(id, { projectId: input.projectId, userId: input.userId }))!;
}

export async function getDetector(id: string, v: SearchViewer): Promise<LearnedDetector | null> {
  const f = visible(v);
  const r = await getDb().get<Row>(`SELECT * FROM learned_detectors WHERE id = ? AND ${f.sql}`, [id, ...f.params]);
  return r ? mapDetector(r) : null;
}

export async function listDetectors(v: SearchViewer): Promise<LearnedDetector[]> {
  const f = visible(v);
  return (await getDb().all<Row>(`SELECT * FROM learned_detectors WHERE ${f.sql} ORDER BY created_at, id`, f.params)).map(mapDetector);
}

/** Guarded mode change: SHADOW and ACTIVE only move on the mode that was read. */
export async function setDetectorMode(input: { id: string; from: 'SHADOW' | 'ACTIVE'; to: 'SHADOW' | 'ACTIVE' }): Promise<boolean> {
  const r = await getDb().run(`UPDATE learned_detectors SET mode = ?, updated_at = ? WHERE id = ? AND mode = ?`, [input.to, nowIso(), input.id, input.from]);
  return r.changes === 1;
}

export async function addExample(input: { detectorId: string; itemRef: string; label: 'POSITIVE' | 'NEGATIVE' }): Promise<boolean> {
  const r = await getDb().run(
    `INSERT INTO detector_examples (id, detector_id, item_ref, label, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [newId('dex'), input.detectorId, input.itemRef, input.label, nowIso()],
  );
  return r.changes === 1;
}

export async function listExamples(detectorId: string, v: SearchViewer): Promise<{ itemRef: string; label: 'POSITIVE' | 'NEGATIVE' }[]> {
  if (!(await getDetector(detectorId, v))) return [];
  const rows = await getDb().all<{ item_ref: string; label: string }>(`SELECT item_ref, label FROM detector_examples WHERE detector_id = ? ORDER BY created_at, id`, [detectorId]);
  return rows.map((r) => ({ itemRef: r.item_ref, label: r.label as 'POSITIVE' | 'NEGATIVE' }));
}
