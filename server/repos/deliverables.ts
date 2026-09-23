/**
 * Deliverables, their versions and their findings, as rows.
 *
 * Three guards here are the ones worth reading:
 *
 *  - **Capture is idempotent by `(project_id, submission_key)`.** The same ask
 *    arriving twice — a redelivered turn, a person repeating themselves — is one
 *    row, and the second caller is told which one.
 *  - **Every stage move is a compare-and-swap naming what was read.** The state
 *    and the active bin together, so two ticks both deciding correctly that a
 *    build should open produce one build and one ordinary loser, and a late tick
 *    acting on an old reading matches nothing.
 *  - **A version is never replaced.** `UNIQUE (deliverable_id, version_number)`
 *    and `UNIQUE (build_bin_id)` make a second ingest of one build a collision
 *    rather than a second version, and nothing here updates a version's content,
 *    bytes or hash after it is written.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import type {
  CheckReport,
  Deliverable,
  DeliverableFinding,
  DeliverableFindingRow,
  DeliverableFormat,
  DeliverableKind,
  DeliverableNeed,
  DeliverableRow,
  DeliverableSpec,
  DeliverableState,
  DeliverableVersion,
  DeliverableVersionRow,
  FindingSeverity,
  FindingStage,
  RequestedFormat,
  ReviewReport,
  VersionReason,
  VersionStatus,
} from '../domain/deliverables.ts';

function toDeliverable(row: DeliverableRow): Deliverable {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    requestedMessageId: row.requested_message_id,
    requestedByUserId: row.requested_by_user_id,
    title: row.title,
    kind: row.kind as DeliverableKind,
    format: row.format as DeliverableFormat,
    requestedFormat: (row.requested_format as RequestedFormat | null) ?? null,
    spec: parseJson<DeliverableSpec>(row.spec, {
      intendedUse: '',
      audience: '',
      requiredContents: [],
      sourceRequirements: '',
      acceptanceConditions: [],
    }),
    needs: parseJson<DeliverableNeed[]>(row.needs, []),
    state: row.state as DeliverableState,
    stateReason: row.state_reason,
    submissionKey: row.submission_key,
    currentVersionId: row.current_version_id,
    activeBinId: row.active_bin_id,
    activeStage: (row.active_stage as 'BUILD' | 'REVIEW' | null) ?? null,
    activeReason: (row.active_reason as VersionReason | null) ?? null,
    activeReasonDetail: row.active_reason_detail,
    pendingCorrection: row.pending_correction,
    buildCount: Number(row.build_count),
    reviewCount: Number(row.review_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVersion(row: DeliverableVersionRow): DeliverableVersion {
  return {
    id: row.id,
    deliverableId: row.deliverable_id,
    versionNumber: Number(row.version_number),
    buildBinId: row.build_bin_id,
    reason: row.reason as VersionReason,
    reasonDetail: row.reason_detail,
    content: parseJson<unknown>(row.content, null),
    citedClaimIds: parseJson<string[]>(row.cited_claim_ids, []),
    storageKey: row.storage_key,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    fileHash: row.file_hash,
    previewKey: row.preview_key,
    status: row.status as VersionStatus,
    checkReport: parseJson<CheckReport>(row.check_report, { readers: [], items: [], measures: {} }),
    reviewReport: parseJson<ReviewReport | null>(row.review_report, null),
    reviewBinId: row.review_bin_id,
    reviewerSessionRef: row.reviewer_session_ref,
    reviewIndependence: row.review_independence,
    announcedAt: row.announced_at,
    announcedMessageId: row.announced_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFinding(row: DeliverableFindingRow): DeliverableFinding {
  return {
    id: row.id,
    deliverableId: row.deliverable_id,
    versionId: row.version_id,
    stage: row.stage as FindingStage,
    severity: row.severity as FindingSeverity,
    code: row.code,
    message: row.message,
    resolvedByVersionId: row.resolved_by_version_id,
    createdAt: row.created_at,
  };
}

export interface CaptureDeliverableInput {
  projectId: string;
  conversationId: string | null;
  requestedMessageId: string | null;
  requestedByUserId: string | null;
  title: string;
  kind: DeliverableKind;
  format: DeliverableFormat;
  requestedFormat: RequestedFormat | null;
  spec: DeliverableSpec;
  needs: DeliverableNeed[];
  submissionKey: string;
}

export async function captureDeliverable(
  input: CaptureDeliverableInput,
): Promise<{ deliverable: Deliverable; created: boolean }> {
  const existing = await getDb().get<DeliverableRow>(
    'SELECT * FROM deliverables WHERE project_id = ? AND submission_key = ?',
    [input.projectId, input.submissionKey],
  );
  if (existing) return { deliverable: toDeliverable(existing), created: false };
  const id = newId('dlv');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO deliverables
       (id, project_id, conversation_id, requested_message_id, requested_by_user_id, title, kind,
        format, requested_format, spec, needs, state, state_reason, submission_key,
        current_version_id, active_bin_id, active_stage, active_reason, active_reason_detail,
        pending_correction, build_count,
        review_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BRIEFED', NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, ?, ?)
     ON CONFLICT (project_id, submission_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.conversationId,
      input.requestedMessageId,
      input.requestedByUserId,
      input.title,
      input.kind,
      input.format,
      input.requestedFormat,
      toJson(input.spec),
      toJson(input.needs),
      input.submissionKey,
      at,
      at,
    ],
  );
  const row = await getDb().get<DeliverableRow>(
    'SELECT * FROM deliverables WHERE project_id = ? AND submission_key = ?',
    [input.projectId, input.submissionKey],
  );
  if (!row) throw new Error('A captured deliverable could not be read back.');
  return { deliverable: toDeliverable(row), created: row.id === id };
}

export async function getDeliverable(id: string): Promise<Deliverable | null> {
  const row = await getDb().get<DeliverableRow>('SELECT * FROM deliverables WHERE id = ?', [id]);
  return row ? toDeliverable(row) : null;
}

export async function getDeliverableByActiveBin(binId: string): Promise<Deliverable | null> {
  const row = await getDb().get<DeliverableRow>('SELECT * FROM deliverables WHERE active_bin_id = ?', [binId]);
  return row ? toDeliverable(row) : null;
}

export async function listDeliverablesForProject(projectId: string): Promise<Deliverable[]> {
  return (
    await getDb().all<DeliverableRow>(
      'SELECT * FROM deliverables WHERE project_id = ? ORDER BY created_at DESC, id DESC',
      [projectId],
    )
  ).map(toDeliverable);
}

export async function listDeliverablesForConversation(conversationId: string): Promise<Deliverable[]> {
  return (
    await getDb().all<DeliverableRow>(
      'SELECT * FROM deliverables WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
      [conversationId],
    )
  ).map(toDeliverable);
}

/** Deliverables with something for the tick to do. */
export async function listAdvanceableDeliverables(limit: number): Promise<Deliverable[]> {
  return (
    await getDb().all<DeliverableRow>(
      `SELECT * FROM deliverables
        WHERE state IN ('BRIEFED', 'BUILDING', 'REVIEWING')
           OR (state IN ('DELIVERED', 'NEEDS_PERSON') AND pending_correction IS NOT NULL)
           OR (state = 'DELIVERED' AND current_version_id IN
                 (SELECT id FROM deliverable_versions WHERE announced_at IS NULL))
        ORDER BY updated_at ASC, id ASC
        LIMIT ?`,
      [limit],
    )
  ).map(toDeliverable);
}

/**
 * Move a deliverable from the stage it was read in to the next one.
 *
 * The guard is the state *and* the active bin together. Returns whether this
 * caller won; a loser is an ordinary outcome and changes nothing.
 */
export async function moveDeliverable(input: {
  id: string;
  fromState: DeliverableState;
  fromBinId: string | null;
  toState: DeliverableState;
  activeBinId: string | null;
  activeStage: 'BUILD' | 'REVIEW' | null;
  activeReason?: VersionReason | null;
  activeReasonDetail?: string | null;
  stateReason?: string | null;
  incrementBuild?: boolean;
  /** Start the build count again at this build — a person's revision is a new round. */
  restartBuilds?: boolean;
  incrementReview?: boolean;
  /** A new version gets its own review attempts. */
  restartReviews?: boolean;
  currentVersionId?: string | null;
  clearCorrection?: boolean;
}): Promise<boolean> {
  const sets = [
    'state = ?',
    'active_bin_id = ?',
    'active_stage = ?',
    'state_reason = ?',
    'updated_at = ?',
  ];
  const params: SqlParam[] = [
    input.toState,
    input.activeBinId,
    input.activeStage,
    input.stateReason ?? null,
    nowIso(),
  ];
  if (input.activeReason !== undefined) {
    sets.push('active_reason = ?', 'active_reason_detail = ?');
    params.push(input.activeReason, input.activeReasonDetail ?? null);
  }
  if (input.restartBuilds) sets.push('build_count = 1');
  else if (input.incrementBuild) sets.push('build_count = build_count + 1');
  if (input.restartReviews) sets.push('review_count = 0');
  else if (input.incrementReview) sets.push('review_count = review_count + 1');
  if (input.currentVersionId !== undefined) {
    sets.push('current_version_id = ?');
    params.push(input.currentVersionId);
  }
  if (input.clearCorrection) sets.push('pending_correction = NULL');
  const binGuard = input.fromBinId === null ? 'active_bin_id IS NULL' : 'active_bin_id = ?';
  params.push(input.id, input.fromState);
  if (input.fromBinId !== null) params.push(input.fromBinId);
  const result = await getDb().run(
    `UPDATE deliverables SET ${sets.join(', ')} WHERE id = ? AND state = ? AND ${binGuard}`,
    params,
  );
  return result.changes === 1;
}

/** Record a person's correction for the next build to take. */
export async function requestCorrection(id: string, correction: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE deliverables SET pending_correction = ?, updated_at = ?
      WHERE id = ? AND state IN ('DELIVERED', 'NEEDS_PERSON', 'BUILDING', 'REVIEWING', 'BRIEFED')`,
    [correction, nowIso(), id],
  );
  return result.changes === 1;
}

export async function nextVersionNumber(deliverableId: string): Promise<number> {
  const row = await getDb().get<{ n: number | null }>(
    'SELECT MAX(version_number) AS n FROM deliverable_versions WHERE deliverable_id = ?',
    [deliverableId],
  );
  return Number(row?.n ?? 0) + 1;
}

export interface RecordVersionInput {
  deliverableId: string;
  versionNumber: number;
  buildBinId: string;
  reason: VersionReason;
  reasonDetail: string | null;
  content: unknown;
  citedClaimIds: string[];
  storageKey: string;
  filename: string;
  contentType: string;
  byteSize: number;
  fileHash: string;
  previewKey: string | null;
  status: VersionStatus;
  checkReport: CheckReport;
}

/** Write a version once. A second ingest of one build reads back the first. */
export async function recordVersion(input: RecordVersionInput): Promise<{ version: DeliverableVersion; created: boolean }> {
  const existing = await getDb().get<DeliverableVersionRow>(
    'SELECT * FROM deliverable_versions WHERE build_bin_id = ?',
    [input.buildBinId],
  );
  if (existing) return { version: toVersion(existing), created: false };
  const id = newId('dlvv');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO deliverable_versions
       (id, deliverable_id, version_number, build_bin_id, reason, reason_detail, content,
        cited_claim_ids, storage_key, filename, content_type, byte_size, file_hash, preview_key,
        status, check_report, review_report, review_bin_id, reviewer_session_ref,
        review_independence, announced_at, announced_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT (build_bin_id) DO NOTHING`,
    [
      id,
      input.deliverableId,
      input.versionNumber,
      input.buildBinId,
      input.reason,
      input.reasonDetail,
      toJson(input.content),
      toJson(input.citedClaimIds),
      input.storageKey,
      input.filename,
      input.contentType,
      input.byteSize,
      input.fileHash,
      input.previewKey,
      input.status,
      toJson(input.checkReport),
      at,
      at,
    ],
  );
  const row = await getDb().get<DeliverableVersionRow>(
    'SELECT * FROM deliverable_versions WHERE build_bin_id = ?',
    [input.buildBinId],
  );
  if (!row) throw new Error('A recorded version could not be read back.');
  return { version: toVersion(row), created: row.id === id };
}

export async function getVersion(id: string): Promise<DeliverableVersion | null> {
  const row = await getDb().get<DeliverableVersionRow>('SELECT * FROM deliverable_versions WHERE id = ?', [id]);
  return row ? toVersion(row) : null;
}

export async function getVersionByNumber(deliverableId: string, versionNumber: number): Promise<DeliverableVersion | null> {
  const row = await getDb().get<DeliverableVersionRow>(
    'SELECT * FROM deliverable_versions WHERE deliverable_id = ? AND version_number = ?',
    [deliverableId, versionNumber],
  );
  return row ? toVersion(row) : null;
}

export async function getVersionByReviewBin(binId: string): Promise<DeliverableVersion | null> {
  const row = await getDb().get<DeliverableVersionRow>('SELECT * FROM deliverable_versions WHERE review_bin_id = ?', [binId]);
  return row ? toVersion(row) : null;
}

export async function listVersions(deliverableId: string): Promise<DeliverableVersion[]> {
  return (
    await getDb().all<DeliverableVersionRow>(
      'SELECT * FROM deliverable_versions WHERE deliverable_id = ? ORDER BY version_number ASC',
      [deliverableId],
    )
  ).map(toVersion);
}

/** The newest version, whatever its status. */
export async function latestVersion(deliverableId: string): Promise<DeliverableVersion | null> {
  const row = await getDb().get<DeliverableVersionRow>(
    'SELECT * FROM deliverable_versions WHERE deliverable_id = ? ORDER BY version_number DESC LIMIT 1',
    [deliverableId],
  );
  return row ? toVersion(row) : null;
}

export async function attachReviewBin(versionId: string, binId: string): Promise<void> {
  await getDb().run('UPDATE deliverable_versions SET review_bin_id = ?, updated_at = ? WHERE id = ?', [
    binId,
    nowIso(),
    versionId,
  ]);
}

/** Settle a version's review, guarded on it still being CHECKED. */
export async function settleReview(input: {
  versionId: string;
  status: 'REVIEW_PASSED' | 'REVIEW_FAILED';
  report: ReviewReport;
  reviewerSessionRef: string | null;
  independence: string | null;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE deliverable_versions
        SET status = ?, review_report = ?, reviewer_session_ref = ?, review_independence = ?, updated_at = ?
      WHERE id = ? AND status = 'CHECKED'`,
    [input.status, toJson(input.report), input.reviewerSessionRef, input.independence, nowIso(), input.versionId],
  );
  return result.changes === 1;
}

/** Claim the right to announce a version. Claim, then act. */
export async function claimAnnouncement(versionId: string): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE deliverable_versions SET announced_at = ?, updated_at = ? WHERE id = ? AND announced_at IS NULL',
    [nowIso(), nowIso(), versionId],
  );
  return result.changes === 1;
}

export async function recordAnnouncement(versionId: string, messageId: string): Promise<void> {
  await getDb().run('UPDATE deliverable_versions SET announced_message_id = ?, updated_at = ? WHERE id = ?', [
    messageId,
    nowIso(),
    versionId,
  ]);
}

export async function recordFinding(input: {
  deliverableId: string;
  versionId: string | null;
  stage: FindingStage;
  severity: FindingSeverity;
  code: string;
  message: string;
}): Promise<DeliverableFinding> {
  const id = newId('dlvf');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO deliverable_findings
       (id, deliverable_id, version_id, stage, severity, code, message, resolved_by_version_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [id, input.deliverableId, input.versionId, input.stage, input.severity, input.code, input.message.slice(0, 4000), at],
  );
  return {
    id,
    deliverableId: input.deliverableId,
    versionId: input.versionId,
    stage: input.stage,
    severity: input.severity,
    code: input.code,
    message: input.message.slice(0, 4000),
    resolvedByVersionId: null,
    createdAt: at,
  };
}

export async function listFindings(deliverableId: string): Promise<DeliverableFinding[]> {
  return (
    await getDb().all<DeliverableFindingRow>(
      'SELECT * FROM deliverable_findings WHERE deliverable_id = ? ORDER BY created_at ASC, id ASC',
      [deliverableId],
    )
  ).map(toFinding);
}

/** Mark every open finding resolved by a version that passed. Nothing is deleted. */
export async function resolveOpenFindings(deliverableId: string, versionId: string): Promise<number> {
  const result = await getDb().run(
    `UPDATE deliverable_findings SET resolved_by_version_id = ?
      WHERE deliverable_id = ? AND resolved_by_version_id IS NULL AND (version_id IS NULL OR version_id <> ?)`,
    [versionId, deliverableId, versionId],
  );
  return result.changes;
}
