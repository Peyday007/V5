/**
 * The engineering connector's rows: evidence, interventions and blockers.
 *
 * All three are append-only. A property's current reading is derived by
 * `readEvidence` in `domain/engineering.ts` from every observation of it, so an
 * invalidation is a new STALE row rather than an edit, and "what did we believe
 * about this on Tuesday" stays answerable.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson } from './util.ts';
import type {
  BlockerKind,
  EvidenceObservation,
  EvidenceSource,
  EvidenceStatus,
  InterventionKind,
} from '../domain/engineering.ts';
import { INTERVENTION_KINDS } from '../domain/engineering.ts';
import type {
  EngineeringBlockerRow,
  EngineeringEvidenceRow,
  EngineeringInterventionRow,
} from '../domain/types.ts';

export type RecorderType = 'BRAIN' | 'WORKER' | 'OPERATOR';

/** `owner/name`, lower-cased, so two spellings are one repository. */
export function canonicalRepository(repository: string): string {
  return repository
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

export interface RecordEvidenceInput {
  projectId?: string | null;
  repository: string;
  propertyKey: string;
  status: EvidenceStatus;
  source: EvidenceSource;
  evidenceRef: string;
  codeSha?: string | null;
  configFingerprint?: string | null;
  provenAt?: string | null;
  validUntil?: string | null;
  invalidationScope?: string[];
  recordedByType: RecorderType;
  recordedById: string;
  metadata?: Record<string, unknown>;
}

export async function recordEvidence(input: RecordEvidenceInput): Promise<string> {
  const id = newId('eev');
  const now = nowIso();
  await getDb().run(
    `INSERT INTO engineering_evidence
       (id, project_id, repository, property_key, status, source_kind, evidence_ref, code_sha,
        config_fingerprint, proven_at, valid_until, invalidation_scope, recorded_by_type,
        recorded_by_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId ?? null,
      canonicalRepository(input.repository),
      input.propertyKey,
      input.status,
      input.source,
      input.evidenceRef,
      input.codeSha ?? null,
      input.configFingerprint ?? null,
      input.provenAt ?? now,
      input.validUntil ?? null,
      JSON.stringify(input.invalidationScope ?? []),
      input.recordedByType,
      input.recordedById,
      JSON.stringify(input.metadata ?? {}),
      now,
    ],
  );
  return id;
}

function toObservation(row: EngineeringEvidenceRow): EvidenceObservation {
  return {
    status: row.status as EvidenceStatus,
    source: row.source_kind as EvidenceSource,
    evidenceRef: row.evidence_ref,
    codeSha: row.code_sha,
    configFingerprint: row.config_fingerprint,
    provenAt: row.proven_at,
    validUntil: row.valid_until,
    invalidationScope: parseJson<string[]>(row.invalidation_scope, []),
    createdAt: row.created_at,
  };
}

export async function observationsFor(
  repository: string,
  propertyKey: string,
): Promise<EvidenceObservation[]> {
  const rows = await getDb().all<EngineeringEvidenceRow>(
    `SELECT * FROM engineering_evidence WHERE repository = ? AND property_key = ?
      ORDER BY created_at DESC, id`,
    [canonicalRepository(repository), propertyKey],
  );
  return rows.map(toObservation);
}

/**
 * Invalidation is explicit: something relevant changed, and every property that
 * declared that change in its scope gets a STALE row at the strength it was
 * proven at, so the next lookup reads STALE rather than the old proof. Unrelated
 * changes invalidate nothing, because nothing declared them.
 */
export async function invalidateScope(input: {
  repository: string;
  scope: string;
  reason: string;
  recordedByType: RecorderType;
  recordedById: string;
}): Promise<number> {
  const rows = await getDb().all<EngineeringEvidenceRow>(
    'SELECT * FROM engineering_evidence WHERE repository = ? ORDER BY created_at DESC, id',
    [canonicalRepository(input.repository)],
  );
  const seen = new Set<string>();
  let invalidated = 0;
  for (const row of rows) {
    const key = `${row.property_key}\u0000${row.source_kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.status !== 'PROVEN') continue;
    if (!parseJson<string[]>(row.invalidation_scope, []).includes(input.scope)) continue;
    await recordEvidence({
      projectId: row.project_id,
      repository: row.repository,
      propertyKey: row.property_key,
      status: 'STALE',
      source: row.source_kind as EvidenceSource,
      evidenceRef: `invalidated:${input.scope}`,
      invalidationScope: parseJson<string[]>(row.invalidation_scope, []),
      recordedByType: input.recordedByType,
      recordedById: input.recordedById,
      metadata: { reason: input.reason, invalidates: row.id },
    });
    invalidated += 1;
  }
  return invalidated;
}

export interface InterventionInput {
  projectId?: string | null;
  taskRef?: string | null;
  kind: InterventionKind;
  rule: string;
  attemptedAction: string;
  replacementAction: string;
  minutesAvoided?: number | null;
  actorType: string;
  actorId: string;
}

export async function recordIntervention(input: InterventionInput): Promise<string> {
  const id = newId('ein');
  await getDb().run(
    `INSERT INTO engineering_interventions
       (id, project_id, task_ref, kind, rule, attempted_action, replacement_action,
        minutes_avoided, actor_type, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId ?? null,
      input.taskRef ?? null,
      input.kind,
      input.rule,
      input.attemptedAction.slice(0, 2000),
      input.replacementAction.slice(0, 2000),
      input.minutesAvoided ?? null,
      input.actorType,
      input.actorId,
      nowIso(),
    ],
  );
  return id;
}

export interface InterventionView {
  id: string;
  projectId: string | null;
  taskRef: string | null;
  kind: InterventionKind;
  rule: string;
  attemptedAction: string;
  replacementAction: string;
  minutesAvoided: number | null;
  actor: string;
  createdAt: string;
}

export async function listInterventions(limit = 50): Promise<InterventionView[]> {
  const rows = await getDb().all<EngineeringInterventionRow>(
    'SELECT * FROM engineering_interventions ORDER BY created_at DESC, id LIMIT ?',
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    taskRef: row.task_ref,
    kind: row.kind as InterventionKind,
    rule: row.rule,
    attemptedAction: row.attempted_action,
    replacementAction: row.replacement_action,
    minutesAvoided: row.minutes_avoided === null ? null : Number(row.minutes_avoided),
    actor: `${row.actor_type}:${row.actor_id}`,
    createdAt: row.created_at,
  }));
}

/** Counts per kind, and the minutes the ones that could be measured say were avoided. */
export async function interventionMetrics(): Promise<{
  byKind: Record<InterventionKind, number>;
  minutesAvoided: number;
  measuredInterventions: number;
  evidenceRows: number;
  blockers: number;
  humanBlockers: number;
}> {
  const rows = await getDb().all<{ kind: string; n: number | string; minutes: number | string | null; measured: number | string }>(
    `SELECT kind, COUNT(*) AS n, SUM(minutes_avoided) AS minutes, COUNT(minutes_avoided) AS measured
       FROM engineering_interventions GROUP BY kind`,
  );
  const byKind = Object.fromEntries(INTERVENTION_KINDS.map((k) => [k, 0])) as Record<InterventionKind, number>;
  let minutes = 0;
  let measured = 0;
  for (const row of rows) {
    byKind[row.kind as InterventionKind] = Number(row.n);
    minutes += Number(row.minutes ?? 0);
    measured += Number(row.measured);
  }
  const evidence = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM engineering_evidence');
  const blockers = await getDb().get<{ n: number | string; h: number | string | null }>(
    'SELECT COUNT(*) AS n, SUM(needs_human) AS h FROM engineering_blockers',
  );
  return {
    byKind,
    minutesAvoided: minutes,
    measuredInterventions: measured,
    evidenceRows: Number(evidence?.n ?? 0),
    blockers: Number(blockers?.n ?? 0),
    humanBlockers: Number(blockers?.h ?? 0),
  };
}

export async function recordBlocker(input: {
  projectId?: string | null;
  taskRef?: string | null;
  kind: BlockerKind;
  statement: string;
  remedy: string;
  needsHuman: boolean;
  checked: string[];
  actorType: string;
  actorId: string;
}): Promise<string> {
  const id = newId('ebl');
  await getDb().run(
    `INSERT INTO engineering_blockers
       (id, project_id, task_ref, kind, statement, remedy, needs_human, checked, actor_type,
        actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId ?? null,
      input.taskRef ?? null,
      input.kind,
      input.statement.slice(0, 2000),
      input.remedy.slice(0, 2000),
      input.needsHuman ? 1 : 0,
      JSON.stringify(input.checked),
      input.actorType,
      input.actorId,
      nowIso(),
    ],
  );
  return id;
}

export async function listBlockers(taskRef?: string): Promise<EngineeringBlockerRow[]> {
  return taskRef
    ? await getDb().all<EngineeringBlockerRow>(
        'SELECT * FROM engineering_blockers WHERE task_ref = ? ORDER BY created_at DESC, id',
        [taskRef],
      )
    : await getDb().all<EngineeringBlockerRow>(
        'SELECT * FROM engineering_blockers ORDER BY created_at DESC, id LIMIT 100',
      );
}
