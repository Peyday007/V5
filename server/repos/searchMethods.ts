/**
 * Learned subjects, search methods, their runs and learned detectors.
 *
 * Every read takes the asker's project and user and returns only what that
 * asker may see: GENERAL rows, PROJECT rows of the asker's project, USER rows
 * of the asker. The filter is in the statement, not applied afterwards.
 * Trust is not set here: `trust_state` starts PROPOSED and is moved by the
 * lifecycle service on recorded results.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { subjectKey } from '../domain/searchIntelligence.ts';
import type {
  LearnedSubject, MethodFailureCause, SearchMethod, SearchMethodRun, SearchScope, TrustState,
} from '../domain/searchIntelligence.ts';

export interface Viewer {
  projectId: string | null;
  userId: string | null;
}

const VISIBLE = `(scope = 'GENERAL'
  OR (scope = 'PROJECT' AND project_id = ?)
  OR (scope = 'USER' AND user_id = ?))`;

function visibleArgs(v: Viewer): [string | null, string | null] {
  return [v.projectId, v.userId];
}

interface SubjectRow {
  id: string; project_id: string | null; user_id: string | null; scope: string; target_kind: string;
  name: string; source: string; discovered_by: string | null; created_at: string;
}

function mapSubject(r: SubjectRow): LearnedSubject {
  return {
    id: r.id, projectId: r.project_id, userId: r.user_id, scope: r.scope as SearchScope,
    targetKind: r.target_kind, name: r.name, source: r.source, discoveredBy: r.discovered_by, createdAt: r.created_at,
  };
}

export interface NewSubject {
  scope: SearchScope;
  projectId?: string | null;
  userId?: string | null;
  targetKind: string;
  name: string;
  source: string;
  discoveredBy?: string | null;
}

/** Store a subject with the source it came from; the same name in the same scope is one subject. */
export async function recordSubject(input: NewSubject): Promise<LearnedSubject> {
  if (!input.source.trim()) throw new Error('A learned subject must say where it came from.');
  if (input.scope === 'PROJECT' && !input.projectId) throw new Error('A PROJECT subject needs its project.');
  if (input.scope === 'USER' && !input.userId) throw new Error('A USER subject needs its user.');
  const key = subjectKey(input.name);
  const projectId = input.scope === 'PROJECT' ? input.projectId ?? null : null;
  const userId = input.scope === 'USER' ? input.userId ?? null : null;
  const db = getDb();
  const existing = await db.get<SubjectRow>(
    `SELECT * FROM learned_subjects WHERE scope = ? AND name_key = ?
       AND COALESCE(project_id, '') = ? AND COALESCE(user_id, '') = ?`,
    [input.scope, key, projectId ?? '', userId ?? ''],
  );
  if (existing) return mapSubject(existing);
  const id = newId('lsb');
  await db.run(
    `INSERT INTO learned_subjects
       (id, project_id, user_id, scope, target_kind, name, name_key, source, discovered_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, userId, input.scope, input.targetKind, input.name.trim(), key, input.source,
      input.discoveredBy ?? null, nowIso()],
  );
  const row = await db.get<SubjectRow>('SELECT * FROM learned_subjects WHERE id = ?', [id]);
  if (!row) throw new Error('The subject disappeared immediately after being written.');
  return mapSubject(row);
}

export async function listSubjects(viewer: Viewer): Promise<LearnedSubject[]> {
  const rows = await getDb().all<SubjectRow>(
    `SELECT * FROM learned_subjects WHERE ${VISIBLE} ORDER BY created_at, id`, visibleArgs(viewer),
  );
  return rows.map(mapSubject);
}

interface MethodRow {
  id: string; subject_id: string | null; project_id: string | null; user_id: string | null; scope: string;
  name: string; finds: string; useful_when: string | null; sources: string; required_inputs: string;
  query_filter: string | null; check_procedure: string | null; observed_limits: string | null;
  trust_state: string; paused_until: string | null; pause_cause: string | null;
  created_at: string; updated_at: string;
}

function parseList(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function mapMethod(r: MethodRow): SearchMethod {
  return {
    id: r.id, subjectId: r.subject_id, projectId: r.project_id, userId: r.user_id, scope: r.scope as SearchScope,
    name: r.name, finds: r.finds, usefulWhen: r.useful_when, sources: parseList(r.sources),
    requiredInputs: parseList(r.required_inputs), queryFilter: r.query_filter, checkProcedure: r.check_procedure,
    observedLimits: r.observed_limits, trustState: r.trust_state as TrustState, pausedUntil: r.paused_until,
    pauseCause: r.pause_cause as MethodFailureCause | null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export interface NewMethod {
  scope: SearchScope;
  projectId?: string | null;
  userId?: string | null;
  subjectId?: string | null;
  name: string;
  finds: string;
  usefulWhen?: string | null;
  sources?: string[];
  requiredInputs?: string[];
  queryFilter?: string | null;
  checkProcedure?: string | null;
  observedLimits?: string | null;
}

/** A new method is always PROPOSED. Nothing here can create one that is already trusted. */
export async function createMethod(input: NewMethod): Promise<SearchMethod> {
  if (input.scope === 'PROJECT' && !input.projectId) throw new Error('A PROJECT method needs its project.');
  if (input.scope === 'USER' && !input.userId) throw new Error('A USER method needs its user.');
  const id = newId('smt');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO search_methods
       (id, subject_id, project_id, user_id, scope, name, finds, useful_when, sources, required_inputs,
        query_filter, check_procedure, observed_limits, trust_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?)`,
    [id, input.subjectId ?? null, input.scope === 'PROJECT' ? input.projectId ?? null : null,
      input.scope === 'USER' ? input.userId ?? null : null, input.scope, input.name, input.finds,
      input.usefulWhen ?? null, JSON.stringify(input.sources ?? []), JSON.stringify(input.requiredInputs ?? []),
      input.queryFilter ?? null, input.checkProcedure ?? null, input.observedLimits ?? null, at, at],
  );
  const row = await getDb().get<MethodRow>('SELECT * FROM search_methods WHERE id = ?', [id]);
  if (!row) throw new Error('The method disappeared immediately after being written.');
  return mapMethod(row);
}

export async function listMethods(viewer: Viewer, subjectId?: string): Promise<SearchMethod[]> {
  const rows = await getDb().all<MethodRow>(
    `SELECT * FROM search_methods WHERE ${VISIBLE}${subjectId ? ' AND subject_id = ?' : ''} ORDER BY created_at, id`,
    subjectId ? [...visibleArgs(viewer), subjectId] : visibleArgs(viewer),
  );
  return rows.map(mapMethod);
}

export async function getMethod(viewer: Viewer, id: string): Promise<SearchMethod | null> {
  const row = await getDb().get<MethodRow>(
    `SELECT * FROM search_methods WHERE id = ? AND ${VISIBLE}`, [id, ...visibleArgs(viewer)],
  );
  return row ? mapMethod(row) : null;
}

/**
 * Move a method's trust state, guarded on the state the caller read: two callers
 * produce one move and one ordinary loser. Returns whether this call moved it.
 */
export async function moveTrust(id: string, from: TrustState, to: TrustState): Promise<boolean> {
  const res = await getDb().run(
    'UPDATE search_methods SET trust_state = ?, updated_at = ? WHERE id = ? AND trust_state = ?',
    [to, nowIso(), id, from],
  );
  return res.changes > 0;
}

export interface NewRun {
  methodId: string;
  relevant?: number;
  verified?: number;
  duplicates?: number;
  falsePositives?: number;
  searchMs?: number | null;
  aiJobsUsed?: number;
  aiJobsAvoided?: number;
  validatedOpportunities?: number;
  failureCause?: MethodFailureCause | null;
  note?: string | null;
}

interface RunRow {
  id: string; method_id: string; ran_at: string; relevant: number; verified: number; duplicates: number;
  false_positives: number; search_ms: number | null; ai_jobs_used: number; ai_jobs_avoided: number;
  validated_opportunities: number; failure_cause: string | null; note: string | null;
}

function mapRun(r: RunRow): SearchMethodRun {
  return {
    id: r.id, methodId: r.method_id, ranAt: r.ran_at, relevant: r.relevant, verified: r.verified,
    duplicates: r.duplicates, falsePositives: r.false_positives, searchMs: r.search_ms,
    aiJobsUsed: r.ai_jobs_used, aiJobsAvoided: r.ai_jobs_avoided, validatedOpportunities: r.validated_opportunities,
    failureCause: r.failure_cause as MethodFailureCause | null, note: r.note,
  };
}

export async function recordRun(input: NewRun): Promise<SearchMethodRun> {
  const id = newId('smr');
  await getDb().run(
    `INSERT INTO search_method_runs
       (id, method_id, ran_at, relevant, verified, duplicates, false_positives, search_ms,
        ai_jobs_used, ai_jobs_avoided, validated_opportunities, failure_cause, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.methodId, nowIso(), input.relevant ?? 0, input.verified ?? 0, input.duplicates ?? 0,
      input.falsePositives ?? 0, input.searchMs ?? null, input.aiJobsUsed ?? 0, input.aiJobsAvoided ?? 0,
      input.validatedOpportunities ?? 0, input.failureCause ?? null, input.note ?? null],
  );
  const row = await getDb().get<RunRow>('SELECT * FROM search_method_runs WHERE id = ?', [id]);
  if (!row) throw new Error('The run disappeared immediately after being written.');
  return mapRun(row);
}

export async function listRuns(methodId: string): Promise<SearchMethodRun[]> {
  const rows = await getDb().all<RunRow>(
    'SELECT * FROM search_method_runs WHERE method_id = ? ORDER BY ran_at, id', [methodId],
  );
  return rows.map(mapRun);
}
