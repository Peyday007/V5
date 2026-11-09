/**
 * Program rows. The source text has no update path: once written it is the
 * authoritative reference for everything the program does, so the only writer
 * of `source_text` is the insert. Maps and plans are versioned inserts; a
 * verification is an insert. The only mutable columns are the program's state
 * and approval, written once each by `approveProgram` / `withdrawProgram`.
 */
import { getDb } from '../db/database.ts';
import type {
  DiscoveredDependency,
  FactoryProgram,
  ProgramPlan,
  RequirementMap,
  RequirementVerification,
} from '../domain/factoryProgram.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';

interface ProgramRow {
  id: string;
  project_id: string;
  submission_key: string;
  title: string;
  source_text: string;
  source_sha256: string;
  repository: string;
  base_branch: string;
  state: FactoryProgram['state'];
  auto_release: number;
  approved_by_user_id: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  map_version: number | null;
  plan_version: number | null;
}

const SELECT_PROGRAM = `
  SELECT p.*,
         (SELECT MAX(version) FROM factory_program_maps m WHERE m.program_id = p.id) AS map_version,
         (SELECT MAX(version) FROM factory_program_plans l WHERE l.program_id = p.id) AS plan_version
    FROM factory_programs p`;

function mapProgram(row: ProgramRow): FactoryProgram {
  return {
    id: row.id,
    projectId: row.project_id,
    submissionKey: row.submission_key,
    title: row.title,
    sourceText: row.source_text,
    sourceSha256: row.source_sha256,
    repository: row.repository,
    baseBranch: row.base_branch,
    state: row.state,
    autoRelease: row.auto_release === 1,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at,
    mapVersion: Number(row.map_version ?? 0),
    planVersion: Number(row.plan_version ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getProgram(id: string): Promise<FactoryProgram | null> {
  const row = await getDb().get<ProgramRow>(`${SELECT_PROGRAM} WHERE p.id = ?`, [id]);
  return row ? mapProgram(row) : null;
}

export async function listPrograms(states: FactoryProgram['state'][] = ['DRAFT', 'APPROVED']): Promise<FactoryProgram[]> {
  const marks = states.map(() => '?').join(', ');
  const rows = await getDb().all<ProgramRow>(`${SELECT_PROGRAM} WHERE p.state IN (${marks}) ORDER BY p.created_at`, states);
  return rows.map(mapProgram);
}

/** Insert a program, or return the one this submission key already made. */
export async function ensureProgram(input: {
  projectId: string;
  submissionKey: string;
  title: string;
  sourceText: string;
  sourceSha256: string;
  repository: string;
  baseBranch: string;
}): Promise<{ program: FactoryProgram; created: boolean }> {
  const db = getDb();
  const existing = await db.get<ProgramRow>(`${SELECT_PROGRAM} WHERE p.project_id = ? AND p.submission_key = ?`, [
    input.projectId,
    input.submissionKey,
  ]);
  if (existing) return { program: mapProgram(existing), created: false };
  const id = newId('fpg');
  const at = nowIso();
  await db.run(
    `INSERT INTO factory_programs (id, project_id, submission_key, title, source_text, source_sha256,
       repository, base_branch, state, auto_release, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 0, ?, ?)
     ON CONFLICT (project_id, submission_key) DO NOTHING`,
    [id, input.projectId, input.submissionKey, input.title, input.sourceText, input.sourceSha256, input.repository, input.baseBranch, at, at],
  );
  const row = await db.get<ProgramRow>(`${SELECT_PROGRAM} WHERE p.project_id = ? AND p.submission_key = ?`, [
    input.projectId,
    input.submissionKey,
  ]);
  if (!row) throw new Error('factory program vanished immediately after insert');
  return { program: mapProgram(row), created: row.id === id };
}

/** DRAFT → APPROVED, once. Returns whether this call moved it. */
export async function markProgramApproved(input: { programId: string; userId: string; autoRelease: boolean }): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE factory_programs SET state = 'APPROVED', approved_by_user_id = ?, approved_at = ?, auto_release = ?, updated_at = ?
      WHERE id = ? AND state = 'DRAFT'`,
    [input.userId, at, input.autoRelease ? 1 : 0, at, input.programId],
  );
  return result.changes > 0;
}

export async function markProgramWithdrawn(programId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE factory_programs SET state = 'WITHDRAWN', updated_at = ? WHERE id = ? AND state <> 'WITHDRAWN'`,
    [nowIso(), programId],
  );
  return result.changes > 0;
}

/* Maps and plans: versioned, append-only. */

export async function insertMapVersion(input: {
  programId: string;
  version: number;
  map: RequirementMap;
  actorType: 'PERSON' | 'FACTORY';
  actorId: string | null;
  reason: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO factory_program_maps (program_id, version, map_json, actor_type, actor_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (program_id, version) DO NOTHING`,
    [input.programId, input.version, toJson(input.map), input.actorType, input.actorId, input.reason, nowIso()],
  );
  return result.changes > 0;
}

export async function getMap(programId: string, version?: number): Promise<{ version: number; map: RequirementMap; actorType: string; reason: string; createdAt: string } | null> {
  const row = await getDb().get<{ version: number; map_json: string; actor_type: string; reason: string; created_at: string }>(
    version === undefined
      ? `SELECT * FROM factory_program_maps WHERE program_id = ? ORDER BY version DESC LIMIT 1`
      : `SELECT * FROM factory_program_maps WHERE program_id = ? AND version = ?`,
    version === undefined ? [programId] : [programId, version],
  );
  return row
    ? { version: Number(row.version), map: parseJson<RequirementMap>(row.map_json, { requirements: [], context: [] }), actorType: row.actor_type, reason: row.reason, createdAt: row.created_at }
    : null;
}

export async function insertPlanVersion(input: { programId: string; version: number; mapVersion: number; plan: ProgramPlan; reason: string }): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO factory_program_plans (program_id, version, map_version, plan_json, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (program_id, version) DO NOTHING`,
    [input.programId, input.version, input.mapVersion, toJson(input.plan), input.reason, nowIso()],
  );
  return result.changes > 0;
}

export async function getPlan(programId: string): Promise<{ version: number; mapVersion: number; plan: ProgramPlan; reason: string } | null> {
  const row = await getDb().get<{ version: number; map_version: number; plan_json: string; reason: string }>(
    `SELECT * FROM factory_program_plans WHERE program_id = ? ORDER BY version DESC LIMIT 1`,
    [programId],
  );
  return row
    ? { version: Number(row.version), mapVersion: Number(row.map_version), plan: parseJson<ProgramPlan>(row.plan_json, { campaigns: [], verifyOnly: [], serialized: [] }), reason: row.reason }
    : null;
}

/* Planned campaign → change request. */

export async function linkCampaign(input: { programId: string; campaignKey: string; changeRequestId: string; planVersion: number }): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO factory_program_campaigns (program_id, campaign_key, change_request_id, plan_version, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT (program_id, campaign_key) DO NOTHING`,
    [input.programId, input.campaignKey, input.changeRequestId, input.planVersion, nowIso()],
  );
  return result.changes > 0;
}

export async function listCampaignLinks(programId: string): Promise<Array<{ campaignKey: string; changeRequestId: string; planVersion: number; createdAt: string }>> {
  const rows = await getDb().all<{ campaign_key: string; change_request_id: string; plan_version: number; created_at: string }>(
    `SELECT * FROM factory_program_campaigns WHERE program_id = ? ORDER BY created_at, campaign_key`,
    [programId],
  );
  return rows.map((r) => ({ campaignKey: r.campaign_key, changeRequestId: r.change_request_id, planVersion: Number(r.plan_version), createdAt: r.created_at }));
}

export async function programOfChangeRequest(changeRequestId: string): Promise<{ programId: string; campaignKey: string } | null> {
  const row = await getDb().get<{ program_id: string; campaign_key: string }>(
    `SELECT program_id, campaign_key FROM factory_program_campaigns WHERE change_request_id = ?`,
    [changeRequestId],
  );
  return row ? { programId: row.program_id, campaignKey: row.campaign_key } : null;
}

/* Verifications: append-only. */

export async function recordVerification(input: Omit<RequirementVerification, 'id' | 'at'> & { at?: string }): Promise<RequirementVerification> {
  const id = newId('fpv');
  const at = input.at ?? nowIso();
  await getDb().run(
    `INSERT INTO factory_program_verifications (id, program_id, requirement_key, outcome, revision, checks, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.programId, input.requirementKey, input.outcome, input.revision, toJson(input.checks), at],
  );
  return { ...input, id, at };
}

export async function listVerifications(programId: string): Promise<RequirementVerification[]> {
  const rows = await getDb().all<{ id: string; program_id: string; requirement_key: string; outcome: RequirementVerification['outcome']; revision: string | null; checks: string; at: string }>(
    `SELECT * FROM factory_program_verifications WHERE program_id = ? ORDER BY at, id`,
    [programId],
  );
  return rows.map((r) => ({
    id: r.id,
    programId: r.program_id,
    requirementKey: r.requirement_key,
    outcome: r.outcome,
    revision: r.revision,
    checks: parseJson(r.checks, []),
    at: r.at,
  }));
}

/* Dependencies discovered during implementation. */

export async function addDiscoveredDependency(input: {
  programId: string;
  requirementKey: string;
  dependsOn: string;
  reason: string;
  actorType: 'PERSON' | 'FACTORY';
  actorId: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO factory_program_dependencies (program_id, requirement_key, depends_on, reason, actor_type, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (program_id, requirement_key, depends_on) DO NOTHING`,
    [input.programId, input.requirementKey, input.dependsOn, input.reason, input.actorType, input.actorId, nowIso()],
  );
  return result.changes > 0;
}

export async function listDiscoveredDependencies(programId: string): Promise<DiscoveredDependency[]> {
  const rows = await getDb().all<{ requirement_key: string; depends_on: string; reason: string; actor_type: 'PERSON' | 'FACTORY'; created_at: string }>(
    `SELECT * FROM factory_program_dependencies WHERE program_id = ? ORDER BY created_at`,
    [programId],
  );
  return rows.map((r) => ({ requirementKey: r.requirement_key, dependsOn: r.depends_on, reason: r.reason, actorType: r.actor_type, at: r.created_at }));
}
