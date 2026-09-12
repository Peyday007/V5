/**
 * The rows behind a re-audit that exists because the audit was not independent.
 *
 * A repository rather than SQL inside the service, for the reason every other
 * one here is: the guarded statements are the mechanism, and a mechanism spread
 * across a service is a mechanism two callers can disagree about.
 *
 * Three statements carry the whole design:
 *
 *   - `openReopen` is `INSERT ... ON CONFLICT DO NOTHING` on a key derived from
 *     server-controlled facts, then a read of whatever row now exists. Exactly
 *     one caller inserts; a duplicate request, a retry after a lost response and
 *     a restart mid-request all read back the same row. §20, at a smaller scale.
 *   - `resolveReopen` is a guarded `UPDATE` from `OPEN`, so two ticks that both
 *     see a finished round settle it once.
 *   - `supersedeReopen` is the other guarded exit: the bytes the finding was
 *     about are no longer the document's, so the finding is history rather than
 *     a condition, and saying so is not the same as saying it was answered.
 *
 * Nothing here deletes, and nothing here edits a row's `created_at`.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type { AuditRole } from '../services/queue/workTypes.ts';

/** Why a round was begun again. A closed set, matched exactly. */
export const INTEGRITY_FINDINGS = ['AUTHOR_REVIEWED_OWN_WORK'] as const;
export type IntegrityFinding = (typeof INTEGRITY_FINDINGS)[number];

export const REOPEN_STATES = ['OPEN', 'RESOLVED', 'SUPERSEDED_BY_VERSION'] as const;
export type ReopenState = (typeof REOPEN_STATES)[number];

/**
 * How the call that opened a reopen was authenticated — never who authorized it.
 *
 * These are two different facts and conflating them is the thing this vocabulary
 * exists to stop. `requested_by_id` is *whose authority the recovery carries*,
 * resolved from `users`. This is *how the request got in*:
 *
 *   `BROWSER_SESSION`     an authenticated HTTP principal held a live session.
 *   `DELEGATED_TERMINAL`  a shell inside the deployment, reached by somebody
 *                         holding the credential that grants shell access.
 *                         Brain cannot identify that party any further and does
 *                         not pretend to.
 *
 * `--admin <email>` resolves an enabled administrator and proves such a person
 * exists and may authorize this. It proves nothing about who typed the command,
 * so a terminal recovery is `DELEGATED_TERMINAL` however impeccable the email.
 */
export const AUTHORITY_CHANNELS = ['BROWSER_SESSION', 'DELEGATED_TERMINAL'] as const;
export type AuthorityChannel = (typeof AUTHORITY_CHANNELS)[number];

/** A role kept from the previous round, and the reason it may be kept. */
export interface CarriedRole {
  role: AuditRole;
  reason: string;
}

export interface AuditIntegrityReopen {
  id: string;
  orchestrationId: string;
  projectId: string;
  documentId: string;
  documentVersion: string;
  documentHash: string;
  finding: IntegrityFinding;
  findingDetail: string;
  supersededAuditId: string | null;
  rolesRerun: AuditRole[];
  rolesCarried: CarriedRole[];
  requestedByType: 'PERSON';
  /** Whose authority this recovery carries, resolved from `users`. */
  requestedById: string;
  /** How the call was authenticated. Never the same fact as `requestedById`. */
  authorityChannel: AuthorityChannel;
  /**
   * What the caller said it was, unverified.
   *
   * A terminal can name a workflow run or a session and Brain cannot check one
   * word of it, so every reader prints this as *reported* rather than as
   * established. Null when nothing was offered, which is the ordinary case.
   */
  executedByRef: string | null;
  requestKey: string;
  roundStartedAt: string;
  state: ReopenState;
  resolvedAuditId: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  orchestration_id: string;
  project_id: string;
  document_id: string;
  document_version: string;
  document_hash: string;
  finding: string;
  finding_detail: string;
  superseded_audit_id: string | null;
  roles_rerun: string;
  roles_carried: string;
  requested_by_type: string;
  requested_by_id: string;
  authority_channel: string;
  executed_by_ref: string | null;
  request_key: string;
  round_started_at: string;
  state: string;
  resolved_audit_id: string | null;
  resolved_at: string | null;
  created_at: string;
}

function toView(row: Row): AuditIntegrityReopen {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    projectId: row.project_id,
    documentId: row.document_id,
    documentVersion: row.document_version,
    documentHash: row.document_hash,
    finding: row.finding as IntegrityFinding,
    findingDetail: row.finding_detail,
    supersededAuditId: row.superseded_audit_id,
    rolesRerun: parseJson<AuditRole[]>(row.roles_rerun, []),
    rolesCarried: parseJson<CarriedRole[]>(row.roles_carried, []),
    requestedByType: 'PERSON',
    requestedById: row.requested_by_id,
    authorityChannel: row.authority_channel as AuthorityChannel,
    executedByRef: row.executed_by_ref,
    requestKey: row.request_key,
    roundStartedAt: row.round_started_at,
    state: row.state as ReopenState,
    resolvedAuditId: row.resolved_audit_id,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

const COLUMNS = `id, orchestration_id, project_id, document_id, document_version, document_hash,
  finding, finding_detail, superseded_audit_id, roles_rerun, roles_carried,
  requested_by_type, requested_by_id, authority_channel, executed_by_ref,
  request_key, round_started_at, state,
  resolved_audit_id, resolved_at, created_at`;

export interface OpenReopenInput {
  orchestrationId: string;
  projectId: string;
  documentId: string;
  documentVersion: string;
  documentHash: string;
  finding: IntegrityFinding;
  findingDetail: string;
  supersededAuditId: string | null;
  rolesRerun: AuditRole[];
  rolesCarried: CarriedRole[];
  requestedById: string;
  authorityChannel: AuthorityChannel;
  executedByRef?: string | null;
  requestKey: string;
  roundStartedAt: string;
}

/**
 * Reserve this reopen, or read back the one that already exists.
 *
 * `created` says which happened, and the caller needs that answer rather than
 * just the row: the side effects of a reopen — cancelling the round's stale
 * work items, moving the packet back to auditing, building a bin — belong to
 * the caller that *won* the insert. A replay performs none of them and reports
 * the same outcome, which is what makes a lost response safe to retry.
 */
export async function openReopen(
  input: OpenReopenInput,
): Promise<{ reopen: AuditIntegrityReopen; created: boolean }> {
  const id = newId('air');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO audit_integrity_reopens
       (id, orchestration_id, project_id, document_id, document_version, document_hash,
        finding, finding_detail, superseded_audit_id, roles_rerun, roles_carried,
        requested_by_type, requested_by_id, authority_channel, executed_by_ref,
        request_key, round_started_at, state,
        resolved_audit_id, resolved_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PERSON', ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.orchestrationId,
      input.projectId,
      input.documentId,
      input.documentVersion,
      input.documentHash,
      input.finding,
      input.findingDetail,
      input.supersededAuditId,
      toJson(input.rolesRerun),
      toJson(input.rolesCarried),
      input.requestedById,
      input.authorityChannel,
      input.executedByRef ?? null,
      input.requestKey,
      input.roundStartedAt,
      at,
    ],
  );
  const stored = await reopenByKey(input.requestKey);
  if (!stored) {
    // The insert did nothing and nothing is there: the row was removed between
    // the two statements, which nothing in this codebase does. Reported rather
    // than retried, because a silent second insert would be the duplicate this
    // whole design refuses.
    throw new Error('the reopen could not be reserved or read back');
  }
  return { reopen: stored, created: stored.id === id };
}

export async function reopenByKey(requestKey: string): Promise<AuditIntegrityReopen | null> {
  const row = await getDb().get<Row>(
    `SELECT ${COLUMNS} FROM audit_integrity_reopens WHERE request_key = ?`,
    [requestKey],
  );
  return row ? toView(row) : null;
}

export async function getReopen(id: string): Promise<AuditIntegrityReopen | null> {
  const row = await getDb().get<Row>(
    `SELECT ${COLUMNS} FROM audit_integrity_reopens WHERE id = ?`,
    [id],
  );
  return row ? toView(row) : null;
}

/**
 * Every reopen this packet has, newest first.
 *
 * Ordered by `created_at` then `id` rather than by an identity column, because
 * an `ORDER BY` must be sayable in both dialects and a tiebreak on `rowid` is
 * the easiest way to write one that is not.
 */
export async function listReopens(orchestrationId: string): Promise<AuditIntegrityReopen[]> {
  const rows = await getDb().all<Row>(
    `SELECT ${COLUMNS} FROM audit_integrity_reopens
      WHERE orchestration_id = ?
      ORDER BY created_at DESC, id DESC`,
    [orchestrationId],
  );
  return rows.map(toView);
}

/** The open reopen for this packet, or null. At most one can be open at a time. */
export async function openReopenFor(
  orchestrationId: string,
): Promise<AuditIntegrityReopen | null> {
  const rows = await getDb().all<Row>(
    `SELECT ${COLUMNS} FROM audit_integrity_reopens
      WHERE orchestration_id = ? AND state = 'OPEN'
      ORDER BY created_at DESC, id DESC`,
    [orchestrationId],
  );
  const first = rows[0];
  return first ? toView(first) : null;
}

/** Every open reopen in the Brain, for the reporters. */
export async function listOpenReopens(limit = 100): Promise<AuditIntegrityReopen[]> {
  const rows = await getDb().all<Row>(
    `SELECT ${COLUMNS} FROM audit_integrity_reopens
      WHERE state = 'OPEN'
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [Math.max(1, limit)],
  );
  return rows.map(toView);
}

/**
 * The correction landed: a fresh verdict was recorded for this round.
 *
 * Guarded on `OPEN` so two ticks that both read a finished round settle it
 * once, and so a reopen already superseded by a new document version is never
 * quietly reported as answered.
 */
export async function resolveReopen(input: {
  id: string;
  auditId: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE audit_integrity_reopens
        SET state = 'RESOLVED', resolved_audit_id = ?, resolved_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.auditId, nowIso(), input.id],
  );
  return (result.changes ?? 0) > 0;
}

/**
 * The document is not the bytes this finding was about any more.
 *
 * A different outcome from `RESOLVED` on purpose: nothing re-audited anything,
 * and reporting it as answered would be claiming an assurance nobody earned.
 * The finding stays readable, with its own reason for stopping.
 */
export async function supersedeReopen(id: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE audit_integrity_reopens
        SET state = 'SUPERSEDED_BY_VERSION', resolved_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [nowIso(), id],
  );
  return (result.changes ?? 0) > 0;
}
