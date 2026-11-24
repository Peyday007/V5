import { getDb } from '../db/database.ts';
import type { Dependency, DependencyRow, DependencyType } from '../domain/types.ts';
import { fromBool, newId, nowIso, toBool } from './util.ts';

export function mapDependency(row: DependencyRow): Dependency {
  return {
    id: row.id,
    projectId: row.project_id,
    dependentDocumentId: row.dependent_document_id,
    dependentRunId: row.dependent_run_id,
    requiredDocumentId: row.required_document_id,
    requiredCanonicalName: row.required_canonical_name,
    requiredLayerId: row.required_layer_id,
    dependencyType: row.dependency_type as DependencyType,
    required: toBool(row.required),
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export interface CreateDependencyInput {
  projectId: string;
  dependentDocumentId?: string | null;
  dependentRunId?: string | null;
  requiredDocumentId?: string | null;
  requiredCanonicalName: string;
  requiredLayerId?: string | null;
  dependencyType?: DependencyType;
  required?: boolean;
  notes?: string | null;
}

export async function createDependency(input: CreateDependencyInput): Promise<Dependency> {
  const id = newId('dep');
  await getDb().run(
    `INSERT INTO dependencies (id, project_id, dependent_document_id, dependent_run_id,
       required_document_id, required_canonical_name, required_layer_id, dependency_type,
       required, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.dependentDocumentId ?? null, input.dependentRunId ?? null,
      input.requiredDocumentId ?? null, input.requiredCanonicalName, input.requiredLayerId ?? null,
      input.dependencyType ?? 'SOURCE_PACKET', fromBool(input.required ?? true),
      input.notes ?? null, nowIso()],
  );
  return (await getDependency(id))!;
}

export async function getDependency(id: string): Promise<Dependency | null> {
  const row = await getDb().get<DependencyRow>('SELECT * FROM dependencies WHERE id = ?', [id]);
  return row ? mapDependency(row) : null;
}

export async function listDependenciesForRun(runId: string): Promise<Dependency[]> {
  return (await getDb().all<DependencyRow>('SELECT * FROM dependencies WHERE dependent_run_id = ? ORDER BY created_at', [
      runId,
    ]))
    .map(mapDependency);
}

/**
 * Runs whose dependencies one statement reads (`missingRunRequirements` in
 * services/dependencies.ts). Bounds the IN list and, at most, the rows one
 * statement can return: at production's widest packet (~2,200 documents a run)
 * ~22,000.
 */
export const RUN_DEPENDENCY_CHUNK = 10;

/** What a dependency row asks for, as the checker evaluates it: nothing about the run that holds it. */
export interface RunRequirement {
  requiredCanonicalName: string;
  requiredDocumentId: string | null;
  dependencyType: DependencyType;
  required: boolean;
}

/**
 * The distinct requirements of a group of runs, first-named first.
 *
 * Readiness used to ask per run (`listDependenciesForRun`, plus a re-read of
 * the run itself): 2,800 of each in twelve minutes of production on
 * 2026-10-12. It then read every run dependency of the project in one
 * statement, and on 2026-11-24 production's largest project held 216,844 of
 * them (110 automatic redos waiting BLOCKED, each carrying ~2,190 documents).
 * Read ten runs at a time it no longer ran out of heap, but it still read every
 * row of every waiting run on every recompute and for every layer with an open
 * run — 3,967,986 rows in eight minutes, 5,316 statements, ten times the next
 * statement's rows and most of what the heap was churning through (production
 * `heap-sources`, run 45427328790). Those redos carry the same packet, and what
 * a row says about readiness depends only on what it names, so a group's
 * distinct requirements are read and each is evaluated once.
 */
export async function listRunRequirements(runIds: readonly string[]): Promise<RunRequirement[]> {
  const unique = [...new Set(runIds)];
  if (unique.length === 0) return [];
  const rows = await getDb().all<{
    required_canonical_name: string;
    required_document_id: string | null;
    dependency_type: string;
    required: number;
    first_at: string;
  }>(
    `SELECT required_canonical_name, required_document_id, dependency_type, required, MIN(created_at) AS first_at
       FROM dependencies WHERE dependent_run_id IN (${unique.map(() => '?').join(', ')})
      GROUP BY required_canonical_name, required_document_id, dependency_type, required
      ORDER BY first_at, required_canonical_name`,
    unique,
  );
  return rows.map((row) => ({
    requiredCanonicalName: row.required_canonical_name,
    requiredDocumentId: row.required_document_id,
    dependencyType: row.dependency_type as DependencyType,
    required: toBool(row.required),
  }));
}

/** Names per statement in `listRunsRequiring`'s IN list. */
const REQUIRED_NAME_BATCH = 200;

/**
 * Which of the runs hold a required row naming one of these documents, as
 * (run, name, linked document) — the three columns that decide it, once each.
 */
export async function listRunsRequiring(
  runIds: readonly string[],
  names: readonly string[],
): Promise<Array<{ runId: string; requiredCanonicalName: string; requiredDocumentId: string | null }>> {
  const runs = [...new Set(runIds)];
  const wanted = [...new Set(names)];
  const out: Array<{ runId: string; requiredCanonicalName: string; requiredDocumentId: string | null }> = [];
  if (runs.length === 0) return out;
  for (let i = 0; i < wanted.length; i += REQUIRED_NAME_BATCH) {
    const chunk = wanted.slice(i, i + REQUIRED_NAME_BATCH);
    const rows = await getDb().all<{ dependent_run_id: string; required_canonical_name: string; required_document_id: string | null }>(
      `SELECT DISTINCT dependent_run_id, required_canonical_name, required_document_id FROM dependencies
        WHERE dependent_run_id IN (${runs.map(() => '?').join(', ')}) AND required = ?
          AND required_canonical_name IN (${chunk.map(() => '?').join(', ')})`,
      [...runs, fromBool(true), ...chunk],
    );
    for (const row of rows) {
      out.push({ runId: row.dependent_run_id, requiredCanonicalName: row.required_canonical_name, requiredDocumentId: row.required_document_id });
    }
  }
  return out;
}

export async function listDependenciesForDocument(documentId: string): Promise<Dependency[]> {
  return (await getDb().all<DependencyRow>(
      'SELECT * FROM dependencies WHERE dependent_document_id = ? ORDER BY created_at',
      [documentId],
    ))
    .map(mapDependency);
}

export async function listDependenciesForProject(projectId: string): Promise<Dependency[]> {
  return (await getDb().all<DependencyRow>('SELECT * FROM dependencies WHERE project_id = ? ORDER BY created_at', [
      projectId,
    ]))
    .map(mapDependency);
}

/** Dependencies naming a document, whether or not they are resolved. */
export async function listDependentsOfCanonicalName(projectId: string, canonicalName: string): Promise<Dependency[]> {
  return (await getDb().all<DependencyRow>(
      'SELECT * FROM dependencies WHERE project_id = ? AND required_canonical_name = ? COLLATE NOCASE',
      [projectId, canonicalName],
    ))
    .map(mapDependency);
}

export async function linkDependencyToDocument(dependencyId: string, documentId: string | null): Promise<void> {
  await getDb().run('UPDATE dependencies SET required_document_id = ? WHERE id = ?', [documentId, dependencyId]);
}

/**
 * The project's dependency links that differ from what current documents say:
 * each dependency joined to the complete, present document its canonical name
 * names, kept only where that document is not the one it links to.
 *
 * The comparison is made by the database (2026-11-24). It used to return every
 * link of the project with every column and compare them here — production's
 * largest project held 216,844 dependency rows, ~280 MB of heap per read
 * measured on that shape, read on every recompute and nearly always to learn
 * that nothing had moved. The rows that come back are exactly the ones the
 * comparison here used to keep.
 */
async function driftedLinks(
  projectId: string,
  limit?: number,
): Promise<{ id: string; required_document_id: string | null; required_canonical_name: string; doc_id: string | null }[]> {
  return getDb().all<{ id: string; required_document_id: string | null; required_canonical_name: string; doc_id: string | null }>(
    `SELECT d.id AS id, d.required_document_id AS required_document_id,
            d.required_canonical_name AS required_canonical_name, doc.id AS doc_id
     FROM dependencies d
     LEFT JOIN documents doc
       ON doc.project_id = d.project_id
      AND doc.canonical_name = d.required_canonical_name COLLATE NOCASE
      AND doc.status IN ('COMPLETE','FROZEN')
      AND doc.file_missing = 0
     WHERE d.project_id = ?
       AND ((doc.id IS NULL AND d.required_document_id IS NOT NULL)
         OR (doc.id IS NOT NULL AND (d.required_document_id IS NULL OR d.required_document_id <> doc.id)))${
           limit === undefined ? '' : `\n     LIMIT ${Math.max(1, Math.floor(limit))}`
         }`,
    [projectId],
  );
}

/**
 * Whether any dependency's link differs from what current documents say.
 *
 * A read and nothing else, so a caller can skip opening a transaction for the
 * ordinary case where nothing changed (INF-5: a no-change recompute's one
 * remaining transaction was this refresh, held only to read). One row at most
 * comes back (`driftedLinks`).
 */
export async function dependenciesDrifted(projectId: string): Promise<boolean> {
  return (await driftedLinks(projectId, 1)).length > 0;
}

/**
 * Re-resolve every dependency in a project against current documents.
 * Returns the canonical names that newly resolved and that newly broke.
 */
export async function resolveProjectDependencies(projectId: string): Promise<{
  resolved: string[];
  broken: string[];
}> {
  const db = getDb();
  const rows = await driftedLinks(projectId);
  const resolved: string[] = [];
  const broken: string[] = [];
  for (const row of rows) {
    const shouldBe = row.doc_id ?? null;
    if (shouldBe === row.required_document_id) continue;
    await db.run('UPDATE dependencies SET required_document_id = ? WHERE id = ?', [shouldBe, row.id]);
    if (shouldBe) resolved.push(row.required_canonical_name);
    else broken.push(row.required_canonical_name);
  }
  return { resolved: [...new Set(resolved)], broken: [...new Set(broken)] };
}

export async function deleteDependenciesForRun(runId: string): Promise<void> {
  await getDb().run('DELETE FROM dependencies WHERE dependent_run_id = ?', [runId]);
}
