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
 * Re-resolve every dependency in a project against current documents.
 * Returns the canonical names that newly resolved and that newly broke.
 */
export async function resolveProjectDependencies(projectId: string): Promise<{
  resolved: string[];
  broken: string[];
}> {
  const db = getDb();
  const rows = await db.all<DependencyRow & { doc_id: string | null }>(
    `SELECT d.*, doc.id AS doc_id
     FROM dependencies d
     LEFT JOIN documents doc
       ON doc.project_id = d.project_id
      AND doc.canonical_name = d.required_canonical_name COLLATE NOCASE
      AND doc.status IN ('COMPLETE','FROZEN')
      AND doc.file_missing = 0
     WHERE d.project_id = ?`,
    [projectId],
  );
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
