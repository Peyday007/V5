/**
 * The link between a connected site's record and the Brain object that
 * expresses it.
 *
 * Two rules live here rather than in the service above, because they are the
 * two that must hold however the caller behaves:
 *
 *   * **A write is guarded on the version it claims to supersede.** `upsert`
 *     is an INSERT that collides, then a single `UPDATE ... WHERE
 *     source_version < ?`. A redelivered, replayed or reordered copy of an
 *     older version matches nothing and is reported as `STALE` — never as an
 *     error, because arriving late is an ordinary thing for a delivery to do.
 *
 *   * **Identical content is not a write at all.** The content hash is compared
 *     before the version is, so a poll that finds nothing changed writes
 *     nothing and the record's `updated_at` does not move. That is what lets
 *     the site poll often without the delta feed reporting churn it caused
 *     itself.
 *
 * Nothing here decides who may call it. That is `routes/helpers.ts` and
 * `services/identity/policy.ts`, the same two places every other project-scoped
 * resource is decided in.
 */
import { getDb } from '../db/database.ts';
import type {
  ExternalCommand,
  ExternalRecord,
  ExternalRecordRejection,
  ExternalRecordRejectionRow,
  ExternalRecordRow,
  ExternalRecordType,
  ExternalRejectionReason,
  ExternalSourceSystem,
} from '../domain/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';

function map(row: ExternalRecordRow): ExternalRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceSystem: row.source_system as ExternalSourceSystem,
    sourceRecordType: row.source_record_type as ExternalRecordType,
    sourceRecordId: row.source_record_id,
    sourceVersion: row.source_version,
    sourceCreatedAt: row.source_created_at,
    sourceRef: row.source_ref,
    title: row.title,
    summary: row.summary,
    attributes: parseJson<Record<string, unknown>>(row.attributes, {}),
    provenance: parseJson<Record<string, unknown>>(row.provenance, {}),
    contentHash: row.content_hash,
    idempotencyKey: row.idempotency_key,
    candidateId: row.candidate_id,
    commandedAt: row.commanded_at,
    commandedCommand: row.commanded_command as ExternalCommand | null,
    commandedByLabel: row.commanded_by_label,
    lastSyncedVersion: row.last_synced_version,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  };
}

function mapRejection(row: ExternalRecordRejectionRow): ExternalRecordRejection {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceSystem: row.source_system,
    sourceRecordType: row.source_record_type,
    sourceRecordId: row.source_record_id,
    reason: row.reason as ExternalRejectionReason,
    detail: row.detail,
    firstAt: row.first_at,
    lastAt: row.last_at,
    occurrences: row.occurrences,
  };
}

export interface UpsertInput {
  projectId: string;
  sourceSystem: ExternalSourceSystem;
  sourceRecordType: ExternalRecordType;
  sourceRecordId: string;
  sourceVersion: string;
  sourceCreatedAt: string | null;
  sourceRef: string | null;
  title: string;
  summary: string;
  attributes: Record<string, unknown>;
  provenance: Record<string, unknown>;
  contentHash: string;
  idempotencyKey: string;
  at?: string;
}

/**
 * What one delivery did.
 *
 * Four outcomes, and the caller reports all four rather than collapsing them
 * into "ok". `UNCHANGED` and `STALE` are the two that make a re-run provably
 * free, and a report that could not tell them apart could not prove it.
 */
export type UpsertOutcome = 'IMPORTED' | 'UPDATED' | 'UNCHANGED' | 'STALE';

export interface UpsertResult {
  outcome: UpsertOutcome;
  record: ExternalRecord;
}

export async function upsertExternalRecord(input: UpsertInput): Promise<UpsertResult> {
  const at = input.at ?? nowIso();
  const existing = await findExternalRecord(input.sourceSystem, input.sourceRecordId);

  if (!existing) {
    const id = newId('ext');
    try {
      await getDb().run(
        `INSERT INTO external_records
           (id, project_id, source_system, source_record_type, source_record_id,
            source_version, source_created_at, source_ref, title, summary,
            attributes, provenance, content_hash, idempotency_key,
            candidate_id, commanded_at, commanded_command, commanded_by_label,
            last_synced_version, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        [
          id, input.projectId, input.sourceSystem, input.sourceRecordType, input.sourceRecordId,
          input.sourceVersion, input.sourceCreatedAt, input.sourceRef, input.title, input.summary,
          toJson(input.attributes), toJson(input.provenance), input.contentHash,
          input.idempotencyKey, input.sourceVersion, at, at,
        ],
      );
      const created = await getExternalRecord(id);
      return { outcome: 'IMPORTED', record: created! };
    } catch {
      /*
       * Two deliveries of the same new record at the same moment.
       *
       * The unique key decided it, which is the whole point of putting the
       * decision there rather than in a read-then-write. The loser re-reads and
       * carries on as an update, so a concurrent backfill and poll produce one
       * row rather than an error somebody has to interpret.
       */
      const raced = await findExternalRecord(input.sourceSystem, input.sourceRecordId);
      if (!raced) throw new Error('The record could not be registered.');
      return await applyUpdate(raced, input, at);
    }
  }

  return await applyUpdate(existing, input, at);
}

async function applyUpdate(
  existing: ExternalRecord,
  input: UpsertInput,
  at: string,
): Promise<UpsertResult> {
  // Content first. A delivery that says nothing new is not a write whatever its
  // version claims, so a poll that finds no change moves no timestamps.
  if (existing.contentHash === input.contentHash) {
    return { outcome: 'UNCHANGED', record: existing };
  }

  // The guard, as a single statement. A copy of an older version matches
  // nothing; there is no window in which a reader could see the newer row and
  // then overwrite it.
  const changed = await getDb().run(
    `UPDATE external_records
        SET source_version = ?, source_created_at = ?, source_ref = ?, title = ?,
            summary = ?, attributes = ?, provenance = ?, content_hash = ?,
            last_synced_version = ?, updated_at = ?
      WHERE id = ? AND source_version < ?`,
    [
      input.sourceVersion, input.sourceCreatedAt, input.sourceRef, input.title,
      input.summary, toJson(input.attributes), toJson(input.provenance), input.contentHash,
      input.sourceVersion, at, existing.id, input.sourceVersion,
    ],
  );

  if (changed.changes === 0) {
    return { outcome: 'STALE', record: existing };
  }
  const updated = await getExternalRecord(existing.id);
  return { outcome: 'UPDATED', record: updated! };
}

export async function getExternalRecord(id: string): Promise<ExternalRecord | null> {
  const rows = await getDb().all<ExternalRecordRow>(
    'SELECT * FROM external_records WHERE id = ?',
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function findExternalRecord(
  sourceSystem: string,
  sourceRecordId: string,
): Promise<ExternalRecord | null> {
  const rows = await getDb().all<ExternalRecordRow>(
    'SELECT * FROM external_records WHERE source_system = ? AND source_record_id = ?',
    [sourceSystem, sourceRecordId],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function getExternalRecordByCandidate(
  candidateId: string,
): Promise<ExternalRecord | null> {
  const rows = await getDb().all<ExternalRecordRow>(
    'SELECT * FROM external_records WHERE candidate_id = ? ORDER BY rowid LIMIT 1',
    [candidateId],
  );
  return rows[0] ? map(rows[0]) : null;
}

/**
 * The delta feed, ordered by when Brain last changed the row.
 *
 * `since` is exclusive and is Brain's own `updated_at`, never the site's
 * version: the site is asking "what has changed *here* since I last looked",
 * and Brain's clock is the only one that can answer that consistently. Ties on
 * the same millisecond are broken by insertion order, so a cursor can never
 * skip a row that shares a timestamp with the last one it saw.
 */
export async function listExternalRecords(input: {
  projectId: string;
  sourceSystem: string;
  since?: string | null;
  limit?: number;
}): Promise<ExternalRecord[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = input.since
    ? await getDb().all<ExternalRecordRow>(
        `SELECT * FROM external_records
          WHERE project_id = ? AND source_system = ? AND updated_at > ?
          ORDER BY updated_at, rowid LIMIT ?`,
        [input.projectId, input.sourceSystem, input.since, limit],
      )
    : await getDb().all<ExternalRecordRow>(
        `SELECT * FROM external_records
          WHERE project_id = ? AND source_system = ?
          ORDER BY updated_at, rowid LIMIT ?`,
        [input.projectId, input.sourceSystem, limit],
      );
  return rows.map(map);
}

export async function countExternalRecords(input: {
  projectId: string;
  sourceSystem: string;
}): Promise<number> {
  const rows = await getDb().all<{ n: number }>(
    'SELECT COUNT(*) AS n FROM external_records WHERE project_id = ? AND source_system = ?',
    [input.projectId, input.sourceSystem],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Attach the Brain object this record is expressed as.
 *
 * Guarded on the link being absent, so two commands arriving together attach
 * one candidate rather than the second silently replacing the first. A record
 * that already has one is reported as such and the caller keeps the existing
 * link — losing a candidate would lose everything Russell later attached to it.
 */
export async function linkCandidate(input: {
  recordId: string;
  candidateId: string;
  command: ExternalCommand;
  byLabel: string | null;
  at?: string;
}): Promise<boolean> {
  const at = input.at ?? nowIso();
  const result = await getDb().run(
    `UPDATE external_records
        SET candidate_id = ?, commanded_at = ?, commanded_command = ?,
            commanded_by_label = ?, updated_at = ?
      WHERE id = ? AND candidate_id IS NULL`,
    [input.candidateId, at, input.command, input.byLabel, at, input.recordId],
  );
  return result.changes > 0;
}

/**
 * Move the row's own timestamp without changing anything it says.
 *
 * The delta feed is ordered by `updated_at`, so a record whose *projection*
 * changed — its mission started, its audit finished — has to become visible to
 * a poller that has already seen it. Nothing about the imported content moves,
 * which is why this is separate from `upsertExternalRecord` rather than a flag
 * on it: a touch must never be able to overwrite a version.
 */
export async function touchExternalRecord(recordId: string, at?: string): Promise<void> {
  await getDb().run('UPDATE external_records SET updated_at = ? WHERE id = ?', [
    at ?? nowIso(),
    recordId,
  ]);
}

/**
 * Record a delivery that could not be mapped.
 *
 * Counted rather than duplicated: the same rubbish arriving on every poll is
 * one row with a rising count, so the table stays readable and the fact that it
 * keeps arriving is itself visible.
 */
export async function recordRejection(input: {
  projectId: string;
  sourceSystem: string;
  sourceRecordType: string;
  sourceRecordId: string | null;
  reason: ExternalRejectionReason;
  detail: string;
  at?: string;
}): Promise<void> {
  const at = input.at ?? nowIso();
  const sourceRecordId = input.sourceRecordId ?? '';
  const updated = await getDb().run(
    `UPDATE external_record_rejections
        SET last_at = ?, occurrences = occurrences + 1, detail = ?
      WHERE source_system = ? AND source_record_id = ? AND reason = ?`,
    [at, input.detail, input.sourceSystem, sourceRecordId, input.reason],
  );
  if (updated.changes > 0) return;
  try {
    await getDb().run(
      `INSERT INTO external_record_rejections
         (id, project_id, source_system, source_record_type, source_record_id,
          reason, detail, first_at, last_at, occurrences)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        newId('exr'), input.projectId, input.sourceSystem, input.sourceRecordType,
        sourceRecordId, input.reason, input.detail, at, at,
      ],
    );
  } catch {
    /* two identical refusals at once: the unique key decided, and the count is
       advanced by whichever statement got there. Losing one tick of a counter
       is not worth failing a delivery over. */
    await getDb().run(
      `UPDATE external_record_rejections
          SET last_at = ?, occurrences = occurrences + 1
        WHERE source_system = ? AND source_record_id = ? AND reason = ?`,
      [at, input.sourceSystem, sourceRecordId, input.reason],
    );
  }
}

export async function listRejections(input: {
  projectId: string;
  limit?: number;
}): Promise<ExternalRecordRejection[]> {
  const rows = await getDb().all<ExternalRecordRejectionRow>(
    `SELECT * FROM external_record_rejections
      WHERE project_id = ? ORDER BY last_at DESC, rowid DESC LIMIT ?`,
    [input.projectId, Math.min(Math.max(input.limit ?? 50, 1), 200)],
  );
  return rows.map(mapRejection);
}
