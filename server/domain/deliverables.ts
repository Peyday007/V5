/**
 * What a deliverable is, in types. The reasoning is §51 of CLAUDE.md and the
 * header of `093_deliverables.sql`.
 */

export const DELIVERABLE_KINDS = ['WRITTEN', 'STRUCTURED'] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

/** What Brain can actually produce, and verify in its native form. */
export const DELIVERABLE_FORMATS = ['DOCX', 'XLSX'] as const;
export type DeliverableFormat = (typeof DELIVERABLE_FORMATS)[number];

/**
 * What a person may ask for.
 *
 * Wider than what Brain produces on purpose: a request for a PDF or a slide
 * deck is a real request, and the honest answer is the nearest format Brain can
 * build and verify plus a named need for the rest — never a silent swap and
 * never a refusal of the work that can be done.
 */
export const REQUESTED_FORMATS = ['DOCX', 'XLSX', 'CSV', 'PDF', 'PPTX', 'MARKDOWN', 'ANY'] as const;
export type RequestedFormat = (typeof REQUESTED_FORMATS)[number];

export const DELIVERABLE_STATES = [
  'BRIEFED',
  'BUILDING',
  'REVIEWING',
  'DELIVERED',
  'NEEDS_PERSON',
] as const;
export type DeliverableState = (typeof DELIVERABLE_STATES)[number];

export const VERSION_STATUSES = ['CHECK_FAILED', 'CHECKED', 'REVIEW_PASSED', 'REVIEW_FAILED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const VERSION_REASONS = ['INITIAL', 'REPAIR', 'REVISION'] as const;
export type VersionReason = (typeof VERSION_REASONS)[number];

export const FINDING_STAGES = ['CHECK', 'REVIEW', 'PERSON', 'BUILD'] as const;
export type FindingStage = (typeof FINDING_STAGES)[number];

export const FINDING_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** A finding that stops a version being delivered as passing. */
export function isMaterial(severity: FindingSeverity): boolean {
  return severity === 'BLOCKER' || severity === 'MAJOR';
}

/**
 * What the deliverable is for, as Russell established it from the request.
 *
 * Every field is something a check or a reviewer is held against later, which
 * is why none of them is optional prose: a required content nobody listed is a
 * required content nothing can be shown to have covered.
 */
export interface DeliverableSpec {
  intendedUse: string;
  audience: string;
  requiredContents: string[];
  sourceRequirements: string;
  acceptanceConditions: string[];
}

/** A missing integration the request depends on, and what it would take. */
export interface DeliverableNeed {
  capability: string;
  detail: string;
}

export interface Deliverable {
  id: string;
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
  state: DeliverableState;
  stateReason: string | null;
  submissionKey: string;
  currentVersionId: string | null;
  activeBinId: string | null;
  activeStage: 'BUILD' | 'REVIEW' | null;
  activeReason: VersionReason | null;
  activeReasonDetail: string | null;
  pendingCorrection: string | null;
  buildCount: number;
  reviewCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  requested_message_id: string | null;
  requested_by_user_id: string | null;
  title: string;
  kind: string;
  format: string;
  requested_format: string | null;
  spec: string;
  needs: string;
  state: string;
  state_reason: string | null;
  submission_key: string;
  current_version_id: string | null;
  active_bin_id: string | null;
  active_stage: string | null;
  active_reason: string | null;
  active_reason_detail: string | null;
  pending_correction: string | null;
  build_count: number;
  review_count: number;
  created_at: string;
  updated_at: string;
}

export interface DeliverableVersion {
  id: string;
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
  reviewReport: ReviewReport | null;
  reviewBinId: string | null;
  reviewerSessionRef: string | null;
  reviewIndependence: string | null;
  announcedAt: string | null;
  announcedMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableVersionRow {
  id: string;
  deliverable_id: string;
  version_number: number;
  build_bin_id: string;
  reason: string;
  reason_detail: string | null;
  content: string;
  cited_claim_ids: string;
  storage_key: string;
  filename: string;
  content_type: string;
  byte_size: number;
  file_hash: string;
  preview_key: string | null;
  status: string;
  check_report: string;
  review_report: string | null;
  review_bin_id: string | null;
  reviewer_session_ref: string | null;
  review_independence: string | null;
  announced_at: string | null;
  announced_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliverableFinding {
  id: string;
  deliverableId: string;
  versionId: string | null;
  stage: FindingStage;
  severity: FindingSeverity;
  code: string;
  message: string;
  resolvedByVersionId: string | null;
  createdAt: string;
}

export interface DeliverableFindingRow {
  id: string;
  deliverable_id: string;
  version_id: string | null;
  stage: string;
  severity: string;
  code: string;
  message: string;
  resolved_by_version_id: string | null;
  created_at: string;
}

/** One thing the native check established, or failed to. */
export interface CheckItem {
  code: string;
  passed: boolean;
  severity: FindingSeverity;
  detail: string;
}

/** What opening the file in its native form established. */
export interface CheckReport {
  /** The reader that opened it, so "it opens" names what opened it. */
  readers: string[];
  items: CheckItem[];
  /** Figures a person can check the report against at a glance. */
  measures: Record<string, number>;
}

export interface ReviewFinding {
  severity: FindingSeverity;
  /** Which acceptance condition, required content, or "purpose" it is about. */
  about: string;
  statement: string;
  repair: string;
}

export interface ReviewReport {
  verdict: 'PASS' | 'REPAIR';
  findings: ReviewFinding[];
  coverage: Array<{ requiredContent: number; met: boolean; note: string }>;
  summary: string;
}
