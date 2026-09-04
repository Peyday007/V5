import { getDb } from '../db/database.ts';
import {
  DEFAULT_VERSION_POLICY,
  type Project,
  type ProjectPurpose,
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
    purpose: (row.purpose === 'TECHNICAL' ? 'TECHNICAL' : 'PROJECT') as ProjectPurpose,
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
  /**
   * Declared at creation, because the thing creating the project is the only
   * thing that knows. The verifier and the fault harness say `TECHNICAL`; an
   * ordinary path says nothing and gets the ordinary answer.
   */
  purpose?: ProjectPurpose;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
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
    purpose: input.purpose ?? 'PROJECT',
    created_at: ts,
    updated_at: ts,
  };
  await db.run(
    `INSERT INTO projects (id, slug, name, description, north_star, current_wave, status,
       version_policy, settings, purpose, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.slug, row.name, row.description, row.north_star, row.current_wave, row.status,
      row.version_policy, row.settings, row.purpose, row.created_at, row.updated_at],
  );
  return mapProject(row);
}

export async function listProjects(): Promise<Project[]> {
  return (await getDb().all<ProjectRow>('SELECT * FROM projects ORDER BY created_at'))
    .map(mapProject);
}

export async function getProject(id: string): Promise<Project | null> {
  const row = await getDb().get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id]);
  return row ? mapProject(row) : null;
}

export async function getProjectBySlug(slug: string): Promise<Project | null> {
  const row = await getDb().get<ProjectRow>('SELECT * FROM projects WHERE slug = ?', [slug]);
  return row ? mapProject(row) : null;
}

/** The single active project used when the caller does not name one. */
export async function getDefaultProject(): Promise<Project | null> {
  const row = await getDb().get<ProjectRow>(
    "SELECT * FROM projects WHERE status = 'ACTIVE' ORDER BY created_at LIMIT 1",
  );
  return row ? mapProject(row) : ((await listProjects())[0] ?? null);
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

export async function updateProject(id: string, patch: UpdateProjectInput): Promise<Project | null> {
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
  await getDb().run(`UPDATE projects SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getProject(id);
}
