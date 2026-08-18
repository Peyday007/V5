import { getDb } from '../db/database.ts';
import {
  DEFAULT_VERSION_POLICY,
  type Project,
  type ProjectRow,
  type ProjectStatus,
  type VersionPolicy,
} from '../domain/types.ts';
import { buildUpdate, newId, nowIso, parseJson, slugify, toJson } from './util.ts';

export function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    northStar: row.north_star,
    currentWave: Number(row.current_wave),
    status: row.status as ProjectStatus,
    versionPolicy: { ...DEFAULT_VERSION_POLICY, ...parseJson<Partial<VersionPolicy>>(row.version_policy, {}) },
    settings: parseJson<Record<string, unknown>>(row.settings, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  description?: string | null;
  northStar?: string | null;
  currentWave?: number;
  versionPolicy?: Partial<VersionPolicy>;
  settings?: Record<string, unknown>;
}

export function createProject(input: CreateProjectInput): Project {
  const db = getDb();
  const ts = nowIso();
  const row: ProjectRow = {
    id: newId('prj'),
    slug: input.slug ?? slugify(input.name),
    name: input.name,
    description: input.description ?? null,
    north_star: input.northStar ?? null,
    current_wave: input.currentWave ?? 1,
    status: 'ACTIVE',
    version_policy: toJson({ ...DEFAULT_VERSION_POLICY, ...(input.versionPolicy ?? {}) }),
    settings: toJson(input.settings ?? {}),
    created_at: ts,
    updated_at: ts,
  };
  db.run(
    `INSERT INTO projects (id, slug, name, description, north_star, current_wave, status,
       version_policy, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.slug, row.name, row.description, row.north_star, row.current_wave, row.status,
      row.version_policy, row.settings, row.created_at, row.updated_at],
  );
  return mapProject(row);
}

export function listProjects(): Project[] {
  return getDb()
    .all<ProjectRow>('SELECT * FROM projects ORDER BY created_at')
    .map(mapProject);
}

export function getProject(id: string): Project | null {
  const row = getDb().get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id]);
  return row ? mapProject(row) : null;
}

export function getProjectBySlug(slug: string): Project | null {
  const row = getDb().get<ProjectRow>('SELECT * FROM projects WHERE slug = ?', [slug]);
  return row ? mapProject(row) : null;
}

/** The single active project used when the caller does not name one. */
export function getDefaultProject(): Project | null {
  const row = getDb().get<ProjectRow>(
    "SELECT * FROM projects WHERE status = 'ACTIVE' ORDER BY created_at LIMIT 1",
  );
  return row ? mapProject(row) : (listProjects()[0] ?? null);
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  northStar?: string | null;
  currentWave?: number;
  status?: ProjectStatus;
  versionPolicy?: VersionPolicy;
  settings?: Record<string, unknown>;
}

export function updateProject(id: string, patch: UpdateProjectInput): Project | null {
  const { clause, values } = buildUpdate({
    name: patch.name,
    description: patch.description,
    north_star: patch.northStar,
    current_wave: patch.currentWave,
    status: patch.status,
    version_policy: patch.versionPolicy ? toJson(patch.versionPolicy) : undefined,
    settings: patch.settings ? toJson(patch.settings) : undefined,
  });
  if (!clause) return getProject(id);
  getDb().run(`UPDATE projects SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getProject(id);
}
