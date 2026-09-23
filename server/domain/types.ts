/**
 * Domain contract for Brain.
 *
 * Row types mirror the SQLite schema exactly (snake_case, 0/1 booleans, TEXT
 * JSON). View types are the shapes the API and UI speak (camelCase, real
 * booleans, parsed JSON). Repositories are the only place the two meet.
 */

// ---------------------------------------------------------------------------
// Enums (kept as const objects + union types so they survive JSON round-trips)
// ---------------------------------------------------------------------------

export const LAYER_STATUSES = [
  'NOT_STARTED',
  'RESEARCHING',
  'INCOMPLETE',
  'BLOCKED',
  'AUDIT_READY',
  'AUDITING',
  'MORE_RESEARCH_REQUIRED',
  'SYNTHESIS_READY',
  'SYNTHESIS_RUNNING',
  'FROZEN',
  'REOPENED',
  'PARKED',
] as const;
export type LayerStatus = (typeof LAYER_STATUSES)[number];

export const DOCUMENT_TYPES = [
  'FOUNDATION',
  'EXPANSION',
  'PATCH',
  'AUDIT',
  'SYNTHESIS',
  'CANONICAL',
  'REFERENCE',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_STATUSES = [
  'EXPECTED',
  'MISSING',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'SUPERSEDED',
  'FROZEN',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const RUN_TYPES = [
  'FOUNDATION',
  'EXPANSION',
  'PATCH',
  'AUDIT',
  'SYNTHESIS',
  'REDO',
  'CROSS_LAYER_AUDIT',
] as const;
export type RunType = (typeof RUN_TYPES)[number];

export const RUN_STATUSES = [
  'PLANNED',
  'READY',
  'BLOCKED',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'AUDIT_REQUIRED',
  'REDO_REQUIRED',
  'APPROVED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const AUDIT_VERDICTS = [
  'PASS',
  'KEEP',
  'PATCH',
  'REDO',
  'MISSING_DEPENDENCY',
  'MORE_RESEARCH',
  'READY_FOR_SYNTHESIS',
  'READY_TO_FREEZE',
  'BLOCKED',
] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

export const AUDIT_FINDING_TYPES = [
  'FAILURE',
  'MISSING_DOCUMENT',
  'REQUIRED_RESEARCH_RUN',
  'REQUIRED_PATCH',
  'NEXT_ACTION',
  /** A real issue this layer does not own; recorded instead of researched here. */
  'OTHER_LAYER_HANDOFF',
  /** An attack the adversarial pass raised, kept whether or not it was upheld. */
  'ADVERSARIAL_FINDING',
] as const;
export type AuditFindingType = (typeof AUDIT_FINDING_TYPES)[number];

/**
 * Every issue an audit raises is classified, because "more could be researched"
 * and "more research is required" are different answers and only the second may
 * hold a layer open.
 */
export const GAP_CLASSIFICATIONS = [
  /** Missing concept that would materially weaken the layer. May justify research. */
  'FOUNDATIONAL_GAP',
  /** Architecture is sound but one bounded unknown needs a focused run first. */
  'TARGETED_RESEARCH_GAP',
  /** Evidence already suffices; correct it in synthesis, no new research. */
  'PATCH',
  /** Real, but another layer owns it. Record the handoff; do not research here. */
  'OTHER_LAYER',
  /** Matters when coding, not for the conceptual foundation. */
  'IMPLEMENTATION_DETAIL',
  /** Needs real-world data or calibration later; never holds research open. */
  'EMPIRICAL_TUNING',
  /** Global architecture is complete; specific domains get plug-ins later. */
  'DOMAIN_PLUGIN',
  /** Would improve quality but is not required for correctness. */
  'OPTIONAL_IMPROVEMENT',
  /** The criticism does not materially require action. */
  'NO_GAP',
] as const;
export type GapClassification = (typeof GAP_CLASSIFICATIONS)[number];

/** Classifications that may legitimately keep a layer open for more research. */
export const RESEARCH_JUSTIFYING_GAPS: readonly GapClassification[] = [
  'FOUNDATIONAL_GAP',
  'TARGETED_RESEARCH_GAP',
];

export const AUDIT_MODES = ['SINGLE_DOCUMENT', 'LAYER_PACKET'] as const;
export type AuditMode = (typeof AUDIT_MODES)[number];

/** One model call in the pipeline. Separation of roles is the point. */
export const AUDIT_PASS_KEYS = ['EXTRACTION', 'PRIMARY', 'ADVERSARIAL', 'JUDGE'] as const;
export type AuditPassKey = (typeof AUDIT_PASS_KEYS)[number];

/** How the requirement pass answers "did this do its assigned job?". */
export const ASSIGNMENT_VERDICTS = ['YES', 'PARTIAL', 'NO'] as const;
export type AssignmentVerdict = (typeof ASSIGNMENT_VERDICTS)[number];

/** How a dependency-pass observation relates two artifacts. */
export const CONSISTENCY_RELATIONS = [
  'CONTRADICTION',
  'REFINEMENT',
  'SUPERSESSION',
  'PARALLEL_DETAIL',
  'FALSE_CONFLICT',
] as const;
export type ConsistencyRelation = (typeof CONSISTENCY_RELATIONS)[number];

export const DEPENDENCY_TYPES = [
  'SOURCE_PACKET',
  'AUDIT_INPUT',
  'CROSS_LAYER',
  'PARENT',
  'REFERENCE',
] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const MESSAGE_ROLES = ['USER', 'ASSISTANT', 'SYSTEM', 'TOOL'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const PROJECT_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETE', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * What a project is for.
 *
 * `TECHNICAL` is the verifier's scope, the fault harness, the queue proof — the
 * machinery exercising itself. Those rows are real and are kept, and they are
 * deliberately not counted as somebody's work. See migration 028.
 */
export const PROJECT_PURPOSES = ['PROJECT', 'TECHNICAL'] as const;
export type ProjectPurpose = (typeof PROJECT_PURPOSES)[number];

export const EVENT_TYPES = [
  'PROJECT_CREATED',
  'DOCUMENT_CREATED',
  'DOCUMENT_IMPORTED',
  'DOCUMENT_COMPLETED',
  'DOCUMENT_SUPERSEDED',
  'DOCUMENT_DELETED',
  'DOCUMENT_FILE_MISSING',
  'DOCUMENT_FILE_RESTORED',
  'DOCUMENT_EXTRACTED',
  'DOCUMENT_EXTRACTION_FAILED',
  'DOCUMENT_REPROCESSED',
  'DOCUMENT_INDEXED',
  'RUN_CREATED',
  'RUN_STARTED',
  'RUN_COMPLETED',
  'RUN_FAILED',
  'RUN_PROMPT_COMPILED',
  'RESEARCH_QUEUED',
  'RESEARCH_PLANNED',
  'RESEARCH_FRAGMENT_ACCEPTED',
  'RESEARCH_FRAGMENT_REJECTED',
  'RESEARCH_FRAGMENT_UNBLOCKED',
  'RESEARCH_SURFACE_RECOVERY',
  'RESEARCH_BLOCKED',
  'RESEARCH_PAUSED_QUOTA',
  'RESEARCH_REPLANNED',
  'RESEARCH_PLAN_REVIEWED',
  'RESEARCH_AWAITING_APPROVAL',
  /** Brain approved a plan against a preauthorized envelope, with no person. */
  'RESEARCH_PLAN_SYSTEM_APPROVED',
  /** A proposed plan fell outside its envelope and went to a person instead. */
  'RESEARCH_PLAN_OUTSIDE_ENVELOPE',
  'RESEARCH_COVERAGE_GAP',
  'RESEARCH_CANCELLED',
  'RESEARCH_FAILED',
  'RESEARCH_COMPLETED',
  'ARCHIVE_IMPORT_STARTED',
  'ARCHIVE_IMPORT_COMPLETED',
  'AUDIT_COMPLETED',
  'LAYER_STATUS_CHANGED',
  'LAYER_EXPECTATIONS_CHANGED',
  'SYNTHESIS_READY',
  'SYNTHESIS_CREATED',
  'LAYER_FROZEN',
  'LAYER_REOPENED',
  'DEPENDENCY_MISSING',
  'DEPENDENCY_RESOLVED',
  'DEPENDENCY_OVERRIDDEN',
  'USER_CORRECTION',
  'AUTO_REDO_CREATED',
  'RECONCILE_COMPLETED',
  'CHAT_ACTION',
  // Who was let into this project, and who was removed. The authoritative
  // identity record is `identity_events`; these two exist so that a project's
  // own history answers "who could see this, and since when" without anybody
  // having to know there is a second log.
  'ACCESS_GRANTED',
  'ACCESS_REVOKED',
  // An offer of access, which is not the same fact as access. A project's own
  // history has to be able to say that somebody was invited and never came, or
  // an invitation that was never accepted leaves no trace anywhere a person
  // reading the project would look.
  'ACCESS_INVITED',

  // Step 12A. A mission's completion writeback is a project-history fact:
  // it is the moment what the project believes actually changed, and the
  // append-only ledger is where that belongs rather than in a bin event,
  // which is best-effort by design and may be swallowed.
  'RUSSELL_MISSION_WRITEBACK',

  // A run that produced nothing, and the try that replaces it.
  //
  // Both are project history rather than bin telemetry: "this idea was
  // researched twice and here is why" is a question about the project, and the
  // failed row's reason is the only place the second attempt's justification
  // lives. `bin_events` is best-effort by design and may be swallowed.
  'RUSSELL_MISSION_FAILED',
  'RUSSELL_MISSION_REDONE',

  // A person deciding what Russell may spend on its own, and withdrawing it.
  //
  // In the project's own append-only history rather than only in
  // `identity_events`, because this is not an identity fact — it is the moment
  // the project agreed to let something run without being asked each time, and
  // "who allowed this, and inside what limits" is a question about the project.
  // `identity_events` records who may *reach* a project; this records what the
  // project itself authorized.
  'RUSSELL_AUTHORITY_GRANTED',
  'RUSSELL_AUTHORITY_REVOKED',
  'RUSSELL_AUTHORITY_RAISED',

  // A document routed to the layer its own audit said owns it.
  //
  // Project history rather than audit telemetry: which layer a document belongs
  // to is a fact about the project, and "why is this filed here" is a question
  // somebody will ask long after the audit that answered it has scrolled away.
  // The payload carries the audit, the gap, both layers, both names and the
  // version of the rule that decided, because a document that changed layers
  // with no row saying why is indistinguishable from one edited by hand.
  'DOCUMENT_HANDED_OFF',

  // A finished mission repointed at what its packet actually produced.
  //
  // A mission's document, audit and layer are a projection of its packet, and a
  // packet re-audited after a handoff moves all three underneath a mission that
  // has already written back. Correcting the projection is not a change of
  // belief and does not supersede anything, so the only record that it happened
  // is this row — which carries every before and after, and the version of the
  // rule that decided. A pointer that changed with nothing saying why is
  // indistinguishable from one edited by hand.
  'RUSSELL_LINKS_RECONCILED',

  // A connected site's record registered here, and what happened to it.
  //
  // Project history rather than connector telemetry: "where did this idea come
  // from" is a question about the project, and the answer — a named record in a
  // named system, at a named version — is the provenance §4 requires of every
  // registered artefact. The payload carries the source system, the source
  // record id and the version, and never the record's contents: those are the
  // site's, and Brain holds only the part it reasons about.
  'EXTERNAL_RECORD_IMPORTED',
  'EXTERNAL_RECORD_UPDATED',
  // A delivery Brain could not map, kept as a fact rather than dropped.
  'EXTERNAL_RECORD_REJECTED',
  // A person on the connected site asked Brain for something, and Brain took it.
  'EXTERNAL_COMMAND_ACCEPTED',

  // An audit round begun again because the audit was not independent.
  //
  // The *second* reason a round may start, and it exists because the first one
  // is the wrong instrument for this: `DOCUMENT_HANDED_OFF` asserts that a
  // document moved layers, and a packet whose author reviewed its own report
  // has not moved anywhere. Writing a handoff to make the boundary lookup come
  // out right would be making the rows say something untrue, which is what
  // `auditRound.ts` exists to refuse.
  //
  // It destroys nothing. Every pass keeps its row and its timestamps, the
  // superseded verdict keeps its gaps and its `created_at`, and the document
  // keeps its bytes. What the row does is move a boundary in *time*, which is
  // the same mechanism the handoff uses and the reason neither has to edit
  // history to work. The payload carries the finding, the document version and
  // hash it is about, which roles run again and which are carried forward with
  // why, the verdict it supersedes, and the authenticated person who asked.
  'AUDIT_ROUND_REOPENED',
  /*
   * A park put back after it was cancelled as abandoned.
   *
   * Its own type rather than a flag on the cancellation, because both happened
   * and history does not mutate: the `RESEARCH_CANCELLED` row stays exactly
   * where it is and this says why the packet came back.
   */
  'RESEARCH_PARK_RESTORED',

  /*
   * A branch the evidence made pointless, closed with the finding that closed
   * it.
   *
   * Its own type rather than a cancellation, because nothing failed: the
   * question is still open and has stopped bearing on the decision, and those
   * are different sentences in a report. The uncertainty keeps its row and its
   * reason; this says which finding retired it.
   */
  'RESEARCH_BRANCH_RETIRED',

  /*
   * The plan grew or shrank while the campaign was running.
   *
   * Recorded on the project's history as well as on `research_plan_revisions`,
   * because "what changed the plan" is a question a person asks from the
   * project timeline rather than from a research table.
   */
  'RESEARCH_PLAN_REVISED',

  /* ----------------------------------------------------------------------- */
  /* The self-expansion kernel                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * A capability blueprint or an amendment became a registered, readable source.
   *
   * On the project's own history rather than in a log, because this is the row
   * every canonical faculty definition later traces back to. An amendment
   * records the source it amends rather than editing it, which is §5 at a new
   * kind of artifact: the original keeps its bytes and its hash.
   */
  'CAPABILITY_SOURCE_REGISTERED',

  /**
   * A worker's reading of a source was validated, and what survived it.
   *
   * Counts rather than prose: how many definitions were proposed, how many were
   * refused, and why. A refusal is kept on the candidate row; this is the event
   * that says the reading happened at all.
   */
  'CAPABILITY_SOURCE_READ',

  /**
   * A source that failed its reading was put back to be read again.
   *
   * It exists because the first real production run needed it and there was
   * nothing: `FAILED` was terminal, `registerSource` dedupes on the content
   * hash so the same bytes could never be registered a second time, and
   * `advanceSources` only ever dispatches a `REGISTERED` source. So a blueprint
   * that failed *because Brain's own extraction contract named the wrong field
   * names* could never be re-read after the contract was corrected — a state
   * saying FAILED that nothing could answer, which is §24's rule at a new
   * altitude and worse than the usual case, because the remedy did not exist.
   *
   * It carries every candidate's refusal verbatim, and that is the point rather
   * than decoration: `putCandidate` is an upsert on `(source_id, slug)`, so the
   * second reading overwrites the first one's rejection reasons in place. The
   * evidence that the contract was wrong would otherwise be destroyed by the
   * fix for it — §5, at the one table where re-reading is the normal case.
   */
  'CAPABILITY_SOURCE_REOPENED',

  /**
   * One faculty definition became canonical.
   *
   * Carries the audit that let it across. Promoting moves exactly one of the
   * six dimensions — the definition — and that is asserted rather than stated:
   * a Brain that read a document about a faculty and reported the faculty as
   * implemented would be lying in the most expensive available direction.
   */
  'FACULTY_PROMOTED',

  // -------------------------------------------------------------------------
  // The labor kernel (§41)
  //
  // On the project's own history rather than on the cash section's, because a
  // workflow is not a sprint. A project may run labor allocation with no Cash
  // Mode at all — an operation Brain performs has tasks and a human remainder
  // whether or not anybody is looking for openings — and putting these on
  // `cash_events` would have made "who does the work here" a question only a
  // sprint could answer.
  // -------------------------------------------------------------------------

  /** A person named a workflow or a task. The one origin Brain may not write. */
  'LABOR_DECLARED',

  /**
   * A workflow or a task is no longer how the work is done.
   *
   * Never a delete: the allocation history and every necessity answer stay, so
   * a retired workflow still answers what was decided and why.
   */
  'LABOR_RETIRED',

  /** Brain asked a published question about who produces one task. */
  'LABOR_ROUND_OPENED',

  /** What a finished labor round established, and what it refused to file. */
  'LABOR_FINDINGS_ABSORBED',

  /**
   * Who produces a task, and what it was before.
   *
   * Carries both ends of the move, because §7's role compression is read from
   * the chain and an event naming only the new value would say a role had
   * changed without saying what it changed from.
   */
  'LABOR_ALLOCATION_DECIDED',
  /* ----------------------------------------------------------------------- */
  /* The manufacturing empire kernel                                          */
  /* ----------------------------------------------------------------------- */

  /**
   * A programme started, and every later move of its lifecycle.
   *
   * Project history rather than kernel telemetry, for `RUSSELL_AUTHORITY_GRANTED`'s
   * reason: starting one is the moment the project agreed that Brain may
   * research what building machines takes, and "who allowed this, and what did
   * it allow" is a question about the project long after the screen that asked
   * has scrolled away.
   */
  'MANUFACTURING_PROGRAMME_STARTED',
  'MANUFACTURING_PROGRAMME_MOVED',

  /** A question opened about a category, with the reason the allocator gave. */
  'MANUFACTURING_ROUND_OPENED',

  /** What the finished questions established, filed into the ladder. */
  'MANUFACTURING_FINDINGS_ABSORBED',

  /**
   * A person naming a category to start from, or deciding not to pursue one.
   *
   * `SEED` is the one category origin Brain may not write, so this is the row
   * that says a human chose it. Retiring is the one verdict no derivation could
   * reach, and it destroys nothing.
   */
  'MANUFACTURING_CATEGORY_SEEDED',
  'MANUFACTURING_CATEGORY_RETIRED',

  /**
   * This company was recorded as holding a capability, or that was withdrawn.
   *
   * The single most consequential row this kernel can write, and the one
   * research may never produce: a capability a product *teaches* is not a
   * capability this company *holds*, and everything downstream — what is
   * enterable, what is missing, what to build next — turns on the difference.
   * The payload carries which of the two kinds of evidence established it and
   * who or what supplied that evidence, because a capability recorded as held
   * for no stated reason is indistinguishable from one somebody guessed.
   */
  'MANUFACTURING_CAPABILITY_HELD',
  'MANUFACTURING_CAPABILITY_WITHDRAWN',
  /** A person read an acquisition candidate and said no. The row stays. */
  'MANUFACTURING_CANDIDATE_SET_ASIDE',
  /** A person answered a question this kernel raises and cannot settle. */
  'MANUFACTURING_DECISION_RESOLVED',
  /** And unanswered one, which the directive's own caution is a reason for. */
  'MANUFACTURING_DECISION_REOPENED',
  // The answering transition for a work item whose attempt ceiling now
  // binds at the claim as well as at `failWork`.
  'WORK_ATTEMPTS_REGRANTED',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type StatusSource = 'DERIVED' | 'MANUAL';

// ---------------------------------------------------------------------------
// Document understanding
// ---------------------------------------------------------------------------

/** What the bytes actually are, decided by magic number rather than extension. */
export const DOCUMENT_FORMATS = [
  'PDF',
  'DOCX',
  'TEXT',
  'MARKDOWN',
  'PASTED',
  'UNSUPPORTED',
] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const EXTRACTION_STATUSES = [
  'QUEUED',
  'EXTRACTING',
  'OCR',
  'INDEXING',
  'READY',
  'READY_WITH_WARNINGS',
  'BLOCKED',
  'FAILED',
  /** A run that was interrupted mid-flight; recoverable, never mistaken for ready. */
  'INTERRUPTED',
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/** Statuses a document may be audited from. Everything else is not evidence. */
export const AUDITABLE_EXTRACTION_STATUSES: readonly ExtractionStatus[] = [
  'READY',
  'READY_WITH_WARNINGS',
];

export const EXTRACTION_METHODS = ['NATIVE', 'OCR', 'DOCX', 'TEXT', 'PASTED'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export const BLOCK_TYPES = [
  'HEADING',
  'PARAGRAPH',
  'LIST_ITEM',
  'TABLE',
  'CAPTION',
  'FOOTNOTE',
  'CODE',
  'PAGE_HEADER',
  'PAGE_FOOTER',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const DOCUMENT_FINDING_TYPES = [
  'CLAIM',
  'DEFINITION',
  'COMPONENT',
  'ACTOR',
  'RELATIONSHIP',
  'ASSUMPTION',
  'EXCLUSION',
  'REQUIREMENT_ANSWERED',
  'OPEN_QUESTION',
  'CONTRADICTION',
] as const;
export type DocumentFindingType = (typeof DOCUMENT_FINDING_TYPES)[number];

export const DOCUMENT_ORIGINS = ['UPLOAD', 'FILESYSTEM', 'PASTED', 'RUN_RESULT'] as const;
export type DocumentOrigin = (typeof DOCUMENT_ORIGINS)[number];

/**
 * What a document is to the project.
 *
 * Almost everything is a LAYER document: one report, about one layer. A master
 * transcript is not — it spans layers, assignments, decisions and artifacts, and
 * filing it under one layer would put most of its content under the wrong
 * heading.
 */
export const DOCUMENT_SCOPES = ['LAYER', 'PROJECT_MASTER_TRANSCRIPT', 'PROJECT_SOURCE'] as const;
export type DocumentScope = (typeof DOCUMENT_SCOPES)[number];

export const IMPORT_JOB_STATUSES = [
  'DISCOVERING',
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'CANCELLED',
  'COMPLETE',
  'FAILED',
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/** Where one discovered file got to. Every file ends in exactly one of these. */
export const IMPORT_FILE_STATUSES = [
  'DISCOVERED',
  'QUEUED',
  'EXTRACTING',
  'OCR',
  'REGISTERED',
  'DUPLICATE',
  'UNSUPPORTED',
  'UNREADABLE',
  'FAILED',
  'NEEDS_REVIEW',
  'SKIPPED',
] as const;
export type ImportFileStatus = (typeof IMPORT_FILE_STATUSES)[number];

/** How a document's layer was decided. A filename is a hint; content is understanding. */
export const CLASSIFICATION_SOURCES = ['FILENAME', 'FOLDER', 'CONTENT', 'MANUAL'] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

export const SEGMENT_TYPES = [
  'CONVERSATION',
  'RESEARCH_ASSIGNMENT',
  'RETURNED_RESEARCH',
  'AUDIT',
  'DECISION',
  'REVISION',
  'SUPERSEDED',
  'OPEN_GAP',
  'ATTACHMENT_REF',
  'OTHER',
] as const;
export type SegmentType = (typeof SEGMENT_TYPES)[number];

export const LINK_TYPES = ['REFERENCE', 'RESEARCH_INPUT', 'COMPLETED_ARTIFACT'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export const LINK_STATUSES = ['PROPOSED', 'ACCEPTED', 'EXCLUDED'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

// ---------------------------------------------------------------------------
// Staged research
// ---------------------------------------------------------------------------

/**
 * The six passes of one research assignment.
 *
 * They are separate because they ask different things and fail differently. A
 * plan that is wrong is cheap to correct; a synthesis built on an unchallenged
 * broad scan is not. AUDIT is Brain's own three-role engine, not another
 * provider call in disguise.
 */
export const RESEARCH_PASS_KEYS = [
  'PLAN',
  'BROAD_SCAN',
  'TARGETED',
  'ADVERSARIAL',
  'VERIFICATION',
  'SYNTHESIS',
  'AUDIT',
] as const;
export type ResearchPassKey = (typeof RESEARCH_PASS_KEYS)[number];

export const RESEARCH_PASS_STATUSES = ['RUNNING', 'COMPLETE', 'FAILED', 'CANCELLED'] as const;
export type ResearchPassStatus = (typeof RESEARCH_PASS_STATUSES)[number];

export const ORCHESTRATION_STATUSES = [
  'QUEUED',
  'PLANNING',
  'RESEARCHING',
  'SYNTHESIZING',
  'AUDITING',
  'AWAITING_REPAIR',
  // Planned, and waiting for a person to say the plan is right before any of
  // the user's allowance is spent on it.
  'AWAITING_APPROVAL',
  'COMPLETE',
  /**
   * Filed, audited, and honestly short of the goal.
   *
   * The judge said MORE_RESEARCH and there is no repair this run can plan or
   * pay for. The workflow is over; the research question is not. Distinguishing
   * this from COMPLETE is what stops a packet whose own judge asked for more
   * work from reading as an answer — which is exactly how the first live packet
   * came to look closeable.
   */
  'COMPLETE_WITH_GAPS',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
  'NEEDS_HUMAN',
  // Out of allowance, not out of work: everything completed is kept and
  // everything queued stays queued until the quota refreshes.
  'PAUSED_QUOTA',
] as const;
export type OrchestrationStatus = (typeof ORCHESTRATION_STATUSES)[number];

/**
 * Where one fragment's own job has got to.
 *
 * ACCEPTED means it passed its evidence gate and its claims may be synthesized.
 * BLOCKED is recoverable — a repair, a narrower question or a different search
 * strategy may still land it. REJECTED is the end of that fragment's line, and
 * its claims never enter a synthesis.
 */
export const FRAGMENT_STATUSES = [
  'PLANNED',
  'QUEUED',
  'RUNNING',
  'VALIDATING',
  'ACCEPTED',
  'BLOCKED',
  'REJECTED',
  'CANCELLED',
  'NEEDS_HUMAN',
] as const;
export type FragmentStatus = (typeof FRAGMENT_STATUSES)[number];

/** What a claim is, which decides what would count as evidence for it. */
/**
 * Whether an empty evidence lane fails the fragment.
 *
 * `REQUIRED` is the only one coverage blocks on. A lane whose own description
 * ends "…if any exists on point" is asking whether something exists, and a
 * fragment must not fail for correctly reporting that it does not — an
 * acceptable *category* of source is not automatically a mandatory coverage
 * requirement. `CONDITIONAL` says the question was asked and left open, and is
 * reported as such; `OPTIONAL` is enrichment and is silent when empty.
 */
export type LaneNecessity = 'REQUIRED' | 'OPTIONAL' | 'CONDITIONAL';

/**
 * One thing a fragment is asking for.
 *
 * The `id` is the key — short, stable, machine-shaped, and what a claim's
 * `evidence_lane` carries. The `description` is the question in full, which is
 * what the worker needs to research it and is never used for matching. Keeping
 * them apart is the whole point: see `domain/evidenceLanes.ts`.
 */
/**
 * What kind of evidence a lane is asking for, which decides its bar.
 *
 * "Two independent sources" is right for a disputed market estimate and wrong
 * for everything else — `standards.ts` has that argument per claim. This is the
 * same argument per *lane*, and it exists because the lane is where a fragment
 * says how many distinct things it needs, which no per-claim standard can know.
 *
 *   SPECIFIC_INSTANCE       one opening, one listing, one solicitation. One
 *                           authoritative primary listing proves its own
 *                           existence, price, deadline and terms. Demanding a
 *                           second publisher for "this posting exists" is
 *                           demanding something that does not exist.
 *   MARKET_PATTERN          the claim is that something *repeats*. One example
 *                           cannot establish a pattern however good it is, so
 *                           this needs several distinct examples — which is a
 *                           different count from several publishers.
 *   GENERALIZED_ECONOMICS   a price, an earnings level, a demand level or a
 *                           margin stated about a market rather than about one
 *                           listing. This is the shape that turns out to be one
 *                           vendor's number repeated, so it needs independent
 *                           publishers or it stays insufficient.
 */
export const LANE_EVIDENCE_KINDS = [
  'SPECIFIC_INSTANCE',
  'MARKET_PATTERN',
  'GENERALIZED_ECONOMICS',
] as const;
export type LaneEvidenceKind = (typeof LANE_EVIDENCE_KINDS)[number];

export interface EvidenceLane {
  id: string;
  description: string;
  necessity: LaneNecessity;
  /** Defaults to SPECIFIC_INSTANCE, which is the bar one listing can clear. */
  evidenceKind?: LaneEvidenceKind;
  /**
   * How many distinct examples this lane needs, when the fragment says.
   *
   * Distinct *examples*, not distinct hosts: three separately-posted listings
   * on one board are three examples of a repeated brief and one publisher.
   * The fragment's completion criteria used to say "at least 3 distinct
   * qualifying postings" in prose that nothing read, and the gate accepted one.
   */
  minDistinctExamples?: number;
}

/**
 * What kind of opening a claim establishes, if it establishes one.
 *
 * Here rather than in `opportunitySignals.ts` because it is a column's
 * vocabulary and this file is where those live; that module holds the mapping
 * to a mechanism and the sentence a worker is shown. `domain/opportunitySignals.ts`
 * has the whole argument for why this is typed rather than matched against a
 * lane id — the short version is that the lane id is a planner's word and this
 * is a closed set.
 */
export const OPPORTUNITY_SIGNALS = [
  'ACTIVE_BUYER_DEMAND',
  'PAID_TASK_OR_CONTRACT',
  'PRICING_OR_INFORMATION_ASYMMETRY',
  'EXPIRING_OPENING',
  'SUPPLY_DEMAND_MISMATCH',
  'RESALABLE_ASSET_OPENING',
  'RECURRING_OUTSOURCED_WORK',
] as const;
export type OpportunitySignal = (typeof OPPORTUNITY_SIGNALS)[number];

/**
 * What a claim establishes about how an industry is put together.
 *
 * ---------------------------------------------------------------------------
 * Why this is typed, and why it is one column rather than four
 * ---------------------------------------------------------------------------
 *
 * `OPPORTUNITY_SIGNALS`' argument, one axis along. Deciding whether a claim
 * establishes a sub-industry, a bottleneck or a capital requirement is a
 * judgement only a reader of the source can make, and a Brain that read it out
 * of the claim sentence would be deriving state from model prose — §8, at the
 * table that decides what the economy looks like. So the reader declares one
 * of these, it is matched exactly on submission, and anything outside the set
 * refuses the whole submission rather than being stored and compared against
 * nothing.
 *
 * One column rather than four because the kinds answer one question — *what
 * does this source establish about how this industry works* — and two columns
 * would be two places a finding is classified, with one of them eventually
 * disagreeing with the other. That has happened in this repository often
 * enough to be a rule.
 *
 * ---------------------------------------------------------------------------
 * What each one is, and what it is not
 * ---------------------------------------------------------------------------
 *
 * Every one of them is a fact about a *published source*, never a view about
 * where money might be. A claim that reasons about what an industry probably
 * needs carries none of these, and that is the common case rather than a
 * deficiency.
 */
export const STRUCTURAL_FINDINGS = [
  /** A narrower industry inside the subject, named by the source. */
  'SUB_INDUSTRY',
  /** A stage of producing or delivering in this industry. */
  'VALUE_CHAIN_LAYER',
  /** A kind of organisation that pays for work in this industry. */
  'BUYER_TYPE',
  /** Who or what actually performs the work that gets paid for. */
  'FULFILMENT_SOURCE',
  /** How money changes hands here: what is bought, on what terms. */
  'TRANSACTION_TYPE',
  /** A published constraint on supply — a shortage, a queue, a chokepoint. */
  'BOTTLENECK',
  /** A different industry the source names as connected to this one. */
  'ADJACENT_INDUSTRY',
  /**
   * Something that materially changes the economics and is not visible from
   * outside. Deliberately not a risk: there is no kind here for "customers may
   * not buy", so the baseline observation has nowhere to go.
   */
  'HIDDEN_CONSTRAINT',
  /** A specific thing that requires owner capital, and what it costs. */
  'CAPITAL_REQUIREMENT',
  /** A published practice that removes, defers or shifts a requirement. */
  'CAPITAL_RESTRUCTURING',
] as const;
export type StructuralFinding = (typeof STRUCTURAL_FINDINGS)[number];

/**
 * What a node in the industry graph is.
 *
 * The same words as the structural findings that create nodes, and that is
 * deliberate: two vocabularies for one idea are two vocabularies that drift.
 * `HIDDEN_CONSTRAINT`, `CAPITAL_REQUIREMENT` and `CAPITAL_RESTRUCTURING` are
 * absent because they are facts *about* a subject rather than subjects of
 * their own — they go in their own tables, and a node kind for them would make
 * the graph a place to put everything.
 */
export const INDUSTRY_NODE_KINDS = [
  'SECTOR',
  'SUB_INDUSTRY',
  'VALUE_CHAIN_LAYER',
  'BUYER_TYPE',
  'FULFILMENT_SOURCE',
  'TRANSACTION_TYPE',
  'BOTTLENECK',
  'ADJACENT_INDUSTRY',
] as const;
export type IndustryNodeKind = (typeof INDUSTRY_NODE_KINDS)[number];

export const INDUSTRY_NODE_ORIGINS = ['SEED', 'BOOTSTRAP', 'DISCOVERED'] as const;
export type IndustryNodeOrigin = (typeof INDUSTRY_NODE_ORIGINS)[number];

export interface IndustryNodeRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  description: string | null;
  origin: string;
  source_claim_id: string | null;
  retired_at: string | null;
  retired_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface IndustryNode {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: IndustryNodeKind;
  name: string;
  description: string | null;
  origin: IndustryNodeOrigin;
  sourceClaimId: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export const INDUSTRY_ROUND_PURPOSES = ['BOOTSTRAP', 'MAP', 'SCAN', 'CAPITAL'] as const;
export type IndustryRoundPurpose = (typeof INDUSTRY_ROUND_PURPOSES)[number];

export interface IndustryRoundRow {
  id: string;
  project_id: string;
  cash_mode_id: string;
  node_id: string | null;
  purpose: string;
  bucket_id: string | null;
  opportunity_id: string | null;
  round: number;
  candidate_id: string;
  state: string;
  opened_at: string;
  harvested_at: string | null;
  found: number | null;
  created_at: string;
  updated_at: string;
}

export interface IndustryRound {
  id: string;
  projectId: string;
  cashModeId: string;
  nodeId: string | null;
  purpose: IndustryRoundPurpose;
  bucketId: string | null;
  opportunityId: string | null;
  round: number;
  candidateId: string;
  state: 'OPEN' | 'HARVESTED' | 'ABANDONED';
  openedAt: string;
  harvestedAt: string | null;
  /** Null while OPEN. Not counted yet is a different fact from none found. */
  found: number | null;
  createdAt: string;
  updatedAt: string;
}

/** What owner capital is actually required *for*. */
export const CAPITAL_REQUIREMENTS = [
  'LABOR',
  'EQUIPMENT',
  'PROPERTY',
  'INVENTORY',
  'LICENSING',
  'CUSTOMER_ACQUISITION',
  'WORKING_CAPITAL',
  'DEPOSIT',
  'INSURANCE',
  'COMPLIANCE',
  'FULFILMENT',
  'TRANSPORT',
  'STORAGE',
  'TECHNOLOGY',
  'MINIMUM_ORDER',
  'GUARANTEE',
] as const;
export type CapitalRequirement = (typeof CAPITAL_REQUIREMENTS)[number];

/**
 * How industry practice removes, defers or shifts a capital requirement.
 *
 * Long on purpose. The brief names these because a requirement is only fixed
 * until somebody knows the mechanism that unfixes it, and a short list would
 * make the headline startup cost look like a fact more often than it is.
 * Every one of them still has to be established from a published source about
 * *this* industry — the list says what to look for, never what is true.
 */
export const CAPITAL_MECHANISMS = [
  'SUBCONTRACT',
  'BROKERAGE',
  'AGENCY',
  'CUSTOMER_DEPOSIT',
  'MILESTONE_BILLING',
  'PRESALE',
  'PURCHASE_ORDER_FINANCE',
  'RECEIVABLES_FINANCE',
  'SUPPLIER_CREDIT',
  'CONSIGNMENT',
  'LEASE',
  'RENTAL',
  'LICENSE_IN',
  'REVENUE_SHARE',
  'JOINT_VENTURE',
  'PROJECT_FINANCE',
  'OFFTAKE',
  'DISTRIBUTION_ADVANCE',
  'GOVERNMENT_INCENTIVE',
  'CAPACITY_RESERVATION',
  'MANAGEMENT_CONTRACT',
  'CONTRACT_MANUFACTURE',
  'THIRD_PARTY_LOGISTICS',
  'WHITE_LABEL',
  'MARKETPLACE',
] as const;
export type CapitalMechanism = (typeof CAPITAL_MECHANISMS)[number];

export interface CapitalStructureRow {
  id: string;
  project_id: string;
  opportunity_id: string;
  entry_kind: string;
  requirement: string | null;
  mechanism: string | null;
  answers_id: string | null;
  amount_cents: number | null;
  residual_cents: number | null;
  statement: string;
  source_claim_id: string;
  created_at: string;
  updated_at: string;
}

export interface CapitalStructure {
  id: string;
  projectId: string;
  opportunityId: string;
  entryKind: 'REQUIREMENT' | 'RESTRUCTURING';
  requirement: CapitalRequirement | null;
  mechanism: CapitalMechanism | null;
  answersId: string | null;
  /** What the source said it costs. Null is unknown and never zero. */
  amountCents: number | null;
  /** What the owner still funds after this restructuring, where stated. */
  residualCents: number | null;
  statement: string;
  sourceClaimId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The constraints worth a row, as a closed set whose omissions are the point.
 *
 * Every entry is something that changes the economics or the feasibility and
 * is not visible from outside the industry. There is deliberately no kind for
 * an obligation any business has — paying people, honouring contracts, the
 * possibility that nobody buys — so a baseline observation cannot be filed
 * here at all. That is a structural separation rather than a filter over
 * prose, and its failure mode is missing a real constraint rather than
 * admitting a platitude, which is the direction §27 says to err in.
 */
export const CONSTRAINT_KINDS = [
  /** The stated cycle excludes acceptance, retakes or review, and is longer. */
  'CYCLE_LONGER_THAN_STATED',
  /** The buyer forbids passing the work on, or passing it offshore. */
  'SUBCONTRACTING_PROHIBITED',
  /** A licence, certification or registration is required to be paid at all. */
  'CREDENTIAL_REQUIRED',
  /** The buyer requires prior credited work of this exact kind. */
  'PRIOR_WORK_REQUIRED',
  /** One reviewer, approver or supervisor caps throughput whatever is hired. */
  'SUPERVISION_CEILING',
  /** Security or confidentiality terms prevent distributed fulfilment. */
  'SECURITY_RESTRICTION',
  /** So few buyers exist that losing one ends the business. */
  'BUYER_CONCENTRATION',
  /** The headline margin does not survive the real revision rate. */
  'MARGIN_ERODED_BY_REWORK',
  /** Nothing is paid until final acceptance, so the whole cycle is floated. */
  'PAYMENT_ON_FINAL_ACCEPTANCE',
  /** The buyer requires bonding or insurance before awarding anything. */
  'BONDING_OR_INSURANCE',
  /** A regulator requires held capital, which no structure can restructure. */
  'REGULATORY_CAPITAL',
  /** The labour or cost spread disappears once management is counted. */
  'ARBITRAGE_LOST_TO_OVERHEAD',
  /** A platform's own terms forbid the arrangement the opening implies. */
  'PLATFORM_TERMS',
  /** The supply the opening depends on cannot currently be obtained. */
  'SUPPLY_UNAVAILABLE',
] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export interface OpportunityConstraintRow {
  id: string;
  project_id: string;
  opportunity_id: string | null;
  node_id: string | null;
  kind: string;
  statement: string;
  effect: string | null;
  source_claim_id: string;
  created_at: string;
  updated_at: string;
}

export interface OpportunityConstraint {
  id: string;
  projectId: string;
  opportunityId: string | null;
  nodeId: string | null;
  kind: ConstraintKind;
  statement: string;
  /** What it does to the economics, where the source says. Null where not. */
  effect: string | null;
  sourceClaimId: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// The labor kernel (§41)
//
// The axis that says who or what produces an output. §38's kernel says *where*
// to look; this one says *by whom the work is done*, and the two vocabularies
// are deliberately separate even where a word appears in both — a
// `FULFILMENT_SOURCE` node is a fact about an industry, and a
// `production_layer` is a decision about this operation.
// ---------------------------------------------------------------------------

/**
 * What kind of producer performs a task.
 *
 * Seven, and the first three are not people. The split is what the CHECK on
 * `labor_allocations` enforces: recording one of the last four without naming
 * which of the six necessity reasons justifies it is impossible, which is the
 * brief's prime directive expressed as a constraint rather than as a
 * paragraph.
 *
 * `EXTERNAL_SERVICE` is a third-party service Brain calls, not an agency of
 * people we engage — that is `AGENCY_OR_VENDOR`, a *sourcing channel*, and
 * conflating the two is how "we use a vendor" comes to stand in for "a person
 * is necessary here".
 */
export const PRODUCTION_LAYERS = [
  'BRAIN',
  'SOFTWARE_TOOL',
  'EXTERNAL_SERVICE',
  'OFFSHORE_HUMAN',
  'DOMESTIC_HUMAN',
  'SPECIALIST_PROFESSIONAL',
  'PHYSICAL_OPERATOR',
] as const;
export type ProductionLayer = (typeof PRODUCTION_LAYERS)[number];

/** The three layers that are not a person. Everything else needs a reason. */
export const NON_HUMAN_LAYERS: readonly ProductionLayer[] = Object.freeze([
  'BRAIN',
  'SOFTWARE_TOOL',
  'EXTERNAL_SERVICE',
]);

/**
 * §3's six role classes, and there is no seventh.
 *
 * In particular there is no class meaning *this is how it has always been
 * done*, so the historical answer has nowhere to go. §38's closed-vocabulary
 * rule, whose failure mode is missing a real reason rather than admitting a
 * habit — and a habit filed as a reason is precisely the human-first operating
 * model this kernel exists to refuse to inherit.
 */
export const HUMAN_NECESSITY_REASONS = [
  /** The interaction itself creates the value: selling, negotiating, trust. */
  'HUMAN_INTERFACE',
  /** A qualified person's judgement beats Brain's verified capability here. */
  'EXPERT_JUDGMENT',
  /** Somebody must legally or contractually sign, certify or be responsible. */
  'ACCOUNTABILITY_LICENSING',
  /** The task requires physical interaction with the world. */
  'PHYSICAL_EXECUTION',
  /** Brain handles the normal path; this is what exceeds its thresholds. */
  'EXCEPTION_HANDLING',
  /** A consequential or hard-to-verify output a person checks independently. */
  'OVERSIGHT_VERIFICATION',
] as const;
export type HumanNecessityReason = (typeof HUMAN_NECESSITY_REASONS)[number];

/**
 * The eight necessity questions that need an answer from somewhere.
 *
 * The brief asks twelve. Four are not here and each is absent for a reason
 * rather than by omission:
 *
 *   1  *what exact output* — `labor_tasks.output`, NOT NULL, because a task
 *      whose output nobody can state cannot be asked any of the others.
 *   2  *can Brain produce it* — derived from `readCapability` on every pass.
 *   7  *can another agent verify it* — derived from `separationCapacity`, the
 *      same reading `auditAdmission` uses, so the two cannot disagree.
 *   12 *what prevents Brain eliminating this* — derived by `necessity.ts` from
 *      the answers to the rest, which is what makes it a diagnosis rather than
 *      a second place to record an opinion.
 *
 * Storing any of the derived three would be a memory of a reading rather than
 * a reading: a fleet that lost its last healthy surface an hour ago would go
 * on reporting that Brain can produce.
 */
export const NECESSITY_QUESTIONS = [
  'BRAIN_IS_FASTER',
  'BRAIN_IS_CHEAPER',
  'BRAIN_QUALITY_AT_LEAST_EQUAL',
  'BRAIN_CAN_SELF_VERIFY',
  'REQUIRES_PHYSICAL_PRESENCE',
  'REQUIRES_LICENSED_HUMAN',
  'HUMAN_INTERACTION_ADDS_VALUE',
  'HANDLES_ONLY_EXCEPTIONS',
] as const;
export type NecessityQuestion = (typeof NECESSITY_QUESTIONS)[number];

export const NECESSITY_ANSWERS = ['YES', 'NO', 'UNKNOWN'] as const;
export type NecessityAnswer = (typeof NECESSITY_ANSWERS)[number];

/**
 * Where a recorded answer came from.
 *
 * There is deliberately no `DERIVED`. An answer Brain reads from its own rows
 * is re-read on every pass and can never be written down, so the rule that
 * derived state is not stored is structural here rather than remembered.
 */
export const NECESSITY_BASES = ['RESEARCHED', 'PERSON'] as const;
export type NecessityBasis = (typeof NECESSITY_BASES)[number];

/**
 * §4's sourcing channels: how a capability is engaged, once a person is
 * established as necessary.
 *
 * Separate from `PRODUCTION_LAYERS` on purpose. The layer says what kind of
 * producer; the channel says how they are engaged, and §4 is explicit that
 * establishing a human is necessary settles nothing about whether that human
 * is domestic, full-time or employed at all.
 */
export const LABOR_CHANNELS = [
  'OFFSHORE_CONTRACTOR',
  'OFFSHORE_EMPLOYEE',
  'SPECIALIST_FREELANCER',
  'DOMESTIC_CONTRACTOR',
  'DOMESTIC_EMPLOYEE',
  'LICENSED_PROFESSIONAL',
  'FRACTIONAL_SPECIALIST',
  'ON_DEMAND_OPERATOR',
  'AGENCY_OR_VENDOR',
  'MANAGED_SERVICE',
  'SOFTWARE_TOOL',
] as const;
export type LaborChannel = (typeof LABOR_CHANNELS)[number];

/** What a published rate is quoted on. A figure with no basis compares to nothing. */
export const RATE_BASES = ['PER_HOUR', 'PER_UNIT', 'PER_MONTH', 'PER_ENGAGEMENT'] as const;
export type RateBasis = (typeof RATE_BASES)[number];

/**
 * What a claim establishes about how work of this kind is produced.
 *
 * Two, and both are facts about a *published source*. There is no kind for
 * "this could probably be automated" or "this seems to need a person", because
 * those are views rather than findings and the gate has nothing to check them
 * against.
 *
 * There was briefly a third, `AUTOMATION_PRECEDENT`, and dropping it is worth
 * recording rather than leaving as an absence. A published instance of this
 * work being done by software *is* a sourcing channel — `SOFTWARE_TOOL` — and
 * a separate kind would have had nowhere to be filed: it answers no necessity
 * question, because somebody else's tool establishes nothing about this
 * Brain's quality, and a finding with no home is one nobody reads. The
 * PRECEDENT round still asks the question, because "is this done without a
 * person" and "where is this sourced" are different questions; what they
 * establish lands in the same row.
 */
export const LABOR_FINDINGS = [
  /** A published rule or practice requires a person, and which reason it is. */
  'HUMAN_REQUIREMENT',
  /** A published way this capability is obtained, and what it costs. */
  'SOURCING_CHANNEL',
] as const;
export type LaborFinding = (typeof LABOR_FINDINGS)[number];

/**
 * The channels that are not a person doing the work for us.
 *
 * `SOFTWARE_TOOL` alone. `MANAGED_SERVICE` means nobody is on *our* payroll,
 * which is what §4 optimizes and is a different question from whether a person
 * performs the work — and a reading that counted it here would report a role
 * as compressed because it had been moved rather than removed.
 */
export const AUTOMATED_CHANNELS: readonly LaborChannel[] = Object.freeze(['SOFTWARE_TOOL']);

export const LABOR_ORIGINS = ['SEED', 'DERIVED'] as const;
export type LaborOrigin = (typeof LABOR_ORIGINS)[number];

export interface LaborWorkflowRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  origin: string;
  opportunity_id: string | null;
  declared_by_ref: string | null;
  retired_at: string | null;
  retired_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface LaborWorkflow {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  origin: LaborOrigin;
  opportunityId: string | null;
  declaredByRef: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LaborTaskRow {
  id: string;
  project_id: string;
  workflow_id: string;
  name: string;
  output: string;
  origin: string;
  capability_id: string | null;
  declared_by_ref: string | null;
  retired_at: string | null;
  retired_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface LaborTask {
  id: string;
  projectId: string;
  workflowId: string;
  name: string;
  /** Question 1 of the necessity test, and the reason it cannot be null. */
  output: string;
  origin: LaborOrigin;
  capabilityId: string | null;
  declaredByRef: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LaborAllocationRow {
  id: string;
  project_id: string;
  task_id: string;
  production_layer: string;
  necessity_reason: string | null;
  decided_by: string;
  decided_by_ref: string | null;
  rationale: string;
  supersedes_id: string | null;
  superseded_at: string | null;
  created_at: string;
}

export interface LaborAllocation {
  id: string;
  projectId: string;
  taskId: string;
  productionLayer: ProductionLayer;
  /** Present exactly when the layer is a person. Enforced by a CHECK. */
  necessityReason: HumanNecessityReason | null;
  decidedBy: 'BRAIN' | 'PERSON';
  decidedByRef: string | null;
  rationale: string;
  supersedesId: string | null;
  supersededAt: string | null;
  createdAt: string;
}

export interface LaborNecessityAnswerRow {
  id: string;
  project_id: string;
  task_id: string;
  question: string;
  answer: string;
  basis: string;
  statement: string;
  source_claim_id: string | null;
  answered_by_ref: string | null;
  superseded_at: string | null;
  created_at: string;
}

export interface LaborNecessityAnswer {
  id: string;
  projectId: string;
  taskId: string;
  question: NecessityQuestion;
  answer: NecessityAnswer;
  basis: NecessityBasis;
  statement: string;
  sourceClaimId: string | null;
  answeredByRef: string | null;
  supersededAt: string | null;
  createdAt: string;
}

export interface LaborMarketOptionRow {
  id: string;
  project_id: string;
  task_id: string;
  channel: string;
  jurisdiction: string | null;
  rate_cents: number | null;
  rate_basis: string | null;
  statement: string;
  source_claim_id: string;
  created_at: string;
  updated_at: string;
}

export interface LaborMarketOption {
  id: string;
  projectId: string;
  taskId: string;
  channel: LaborChannel;
  jurisdiction: string | null;
  /** Null is unknown, never free. */
  rateCents: number | null;
  rateBasis: RateBasis | null;
  statement: string;
  sourceClaimId: string;
  createdAt: string;
  updatedAt: string;
}

export const LABOR_ROUND_PURPOSES = ['NECESSITY', 'MARKET', 'PRECEDENT'] as const;
export type LaborRoundPurpose = (typeof LABOR_ROUND_PURPOSES)[number];

export interface LaborRoundRow {
  id: string;
  project_id: string;
  task_id: string;
  purpose: string;
  round: number;
  candidate_id: string;
  state: string;
  opened_at: string;
  harvested_at: string | null;
  found: number | null;
  created_at: string;
  updated_at: string;
}

export interface LaborRound {
  id: string;
  projectId: string;
  taskId: string;
  purpose: LaborRoundPurpose;
  round: number;
  candidateId: string;
  state: 'OPEN' | 'HARVESTED' | 'ABANDONED';
  openedAt: string;
  harvestedAt: string | null;
  /** Null while OPEN. Not counted yet is a different fact from none found. */
  found: number | null;
  createdAt: string;
  updatedAt: string;
}

export const CLAIM_TYPES = [
  'SOURCED_FACT',
  'SELF_REPORT',
  'UNSUPPORTED_ASSERTION',
  'QUOTATION',
  'INFERENCE',
  'CALCULATION',
  'FORECAST',
  'NEGATIVE_EXISTENCE',
  'RECOMMENDATION',
  'DECISION',
  'INSTRUCTION',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** What a requirement is for; not all of them are research. */
export const REQUIREMENT_KINDS = [
  'RESEARCH',
  'DEFINITION',
  'COMPARISON',
  'CALCULATION',
  'OTHER_LAYER',
  'IMPLEMENTATION',
  'EMPIRICAL_VALIDATION',
  'TUNING',
  'OPTIONAL_ENRICHMENT',
  'IRRELEVANT',
] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const REQUIREMENT_NECESSITIES = ['MANDATORY', 'SUPPORTING', 'OPTIONAL'] as const;
export type RequirementNecessity = (typeof REQUIREMENT_NECESSITIES)[number];

/**
 * How well the archive already answers one requirement.
 *
 * The distinctions carry weight: SATISFIED stops research happening at all,
 * PRESENT_BUT_UNVERIFIED means somebody wrote the answer down but nothing
 * supports it, and DEFINITION_MISMATCH is the one that quietly ruins a packet —
 * a real number about a slightly different thing.
 */
export const COVERAGE_STATUSES = [
  'SATISFIED',
  'PARTIALLY_SATISFIED',
  'PRESENT_BUT_UNVERIFIED',
  'STALE',
  'CONTRADICTED',
  'DEFINITION_MISMATCH',
  'SUPERSEDED',
  'OWNED_ELSEWHERE',
  'NOT_REQUIRED',
  'MISSING',
] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** Why a requirement is not covered, which decides whether research is the answer. */
export const GAP_TYPES = [
  'MISSING_FOUNDATIONAL',
  'MISSING_SUPPORTING',
  'MISSING_CALCULATION_INPUT',
  'MISSING_COMPARISON',
  'MISSING_GEOGRAPHY',
  'MISSING_TIMEFRAME',
  'MISSING_POPULATION',
  'MISSING_DEFINITION',
  'STALE_EVIDENCE',
  'UNVERIFIABLE_CITATION',
  'SOURCE_QUALITY',
  'UNRESOLVED_CONTRADICTION',
  'INSUFFICIENT_INDEPENDENCE',
  'MISSING_COUNTEREVIDENCE',
  'AMBIGUOUS_EVIDENCE',
  'SYNTHESIS_GAP',
  'OTHER_LAYER_OWNERSHIP',
  'IMPLEMENTATION_DETAIL',
  'EMPIRICAL_VALIDATION',
  'TUNING',
  'OPTIONAL_ENRICHMENT',
] as const;
export type GapType = (typeof GAP_TYPES)[number];

/** Whether an existing claim's own source stands up. */
export const VERIFICATION_STATES = [
  'UNVERIFIED',
  'VERIFIED',
  'UNVERIFIABLE',
  'SUPERSEDED',
  'REJECTED',
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

/** What a new finding does to what the project already had. */
export const RECONCILIATION_OUTCOMES = [
  'CONFIRMS',
  'STRENGTHENS',
  'UPDATES_STALE',
  'FILLS_GAP',
  'NARROWS',
  'CONTRADICTS',
  'DUPLICATES',
  'FAILS_REQUIREMENT',
  'RAISES_NEW_QUESTION',
] as const;
export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number];

/** What a bundled job is for, which decides how much model it deserves. */
export const JOB_KINDS = ['DISCOVERY', 'INVESTIGATION', 'VERIFICATION', 'SYNTHESIS'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * What a provider says about the allowance it is running on.
 *
 * UNKNOWN is a real answer and the common one: most tools do not report a
 * quota, and treating silence as exhaustion would stop research that would have
 * worked. Scope matters because a provider's own model allowance and a
 * third-party model's allowance run out separately.
 */
export const QUOTA_STATES = ['AVAILABLE', 'LIMITED', 'EXHAUSTED', 'UNKNOWN'] as const;
export type QuotaState = (typeof QUOTA_STATES)[number];

export const QUOTA_SCOPES = ['GEMINI', 'THIRD_PARTY', 'UNKNOWN'] as const;
export type QuotaScope = (typeof QUOTA_SCOPES)[number];

export interface ProviderQuota {
  state: QuotaState;
  scope: QuotaScope;
  /** Phrased for the user; never a raw CLI line. */
  detail: string;
  resetsAt: string | null;
}

export const JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'CANCELLED',
  'PAUSED_QUOTA',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Does the evidence hold up? Separate from whether there is enough of it. */
export const INTEGRITY_VERDICTS = ['PASS', 'FAIL'] as const;
export type IntegrityVerdict = (typeof INTEGRITY_VERDICTS)[number];

/** Does it actually answer the fragment's question, to the declared coverage? */
export const SUFFICIENCY_VERDICTS = ['SUFFICIENT', 'INSUFFICIENT'] as const;
export type SufficiencyVerdict = (typeof SUFFICIENCY_VERDICTS)[number];

/** What later passes did to a claim. Silence is not agreement, so nothing defaults to SUPPORTED. */
/**
 * Whether the researcher actually got to read the source.
 *
 * Separate from the gate's verdict on purpose, and the distinction is the whole
 * point: a claim whose source is paywalled has not been judged, and a claim
 * that was judged and refused has. Counting the first as the second is how a
 * run that hit four paywalls ends up scored like a run that invented four
 * citations.
 *
 * Anything other than RETRIEVED is neither accepted nor rejected. It is carried
 * into the report as an unresolved item, named, so a reader knows what was not
 * checked rather than being told nothing about it.
 */
export const RETRIEVAL_STATES = [
  'RETRIEVED',
  'PAYWALLED',
  'ROBOTS_BLOCKED',
  'JS_ONLY',
  'NOT_REACHABLE',
] as const;
export type RetrievalState = (typeof RETRIEVAL_STATES)[number];

/**
 * What one fragment needing another actually means.
 *
 * Every dependency used to block: a fragment waited until the one it named was
 * ACCEPTED, and if that never happened it was never researched. For a
 * definition that is right — you cannot answer a question whose terms nobody
 * has settled. For most dependencies it is far too strong, and it cost the
 * first live packet five fragments that were never attempted because a
 * neighbouring question failed.
 *
 * - `HARD` — the dependent cannot be stated at all until this is accepted.
 *   Definitions and scope boundaries.
 * - `CONDITIONAL` — the dependent can be researched now and stated as a
 *   conditional: *if the transaction falls within Article 12-A, then …*. The
 *   assignment carries what the dependency did and did not establish, and the
 *   worker is required to carry the condition into its claims.
 * - `SEQUENCING` — a preference about order and nothing more. Never blocks,
 *   never dooms.
 */
export const DEPENDENCY_KINDS = ['HARD', 'CONDITIONAL', 'SEQUENCING'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export interface FragmentDependency {
  key: string;
  kind: DependencyKind;
}

export const CONTRADICTION_STATES = ['UNCHALLENGED', 'SUPPORTED', 'CONTESTED', 'REFUTED'] as const;
export type ContradictionState = (typeof CONTRADICTION_STATES)[number];

/**
 * What kind of disagreement two claims are actually in.
 *
 * Most "contradictions" are not factual conflicts at all: two figures measured
 * on different populations, in different years, or under different definitions
 * disagree because they are answering different questions. Saying which kind it
 * is decides what to do — a definition mismatch is settled by choosing the
 * definition, a factual conflict needs a source that resolves it, and neither
 * is ever settled by averaging the two numbers.
 */
export const CONTRADICTION_KINDS = [
  'DIRECT_FACTUAL_CONFLICT',
  'DEFINITION_MISMATCH',
  'TIMEFRAME_MISMATCH',
  'GEOGRAPHY_MISMATCH',
  'POPULATION_MISMATCH',
  'METHODOLOGICAL_DIFFERENCE',
  'MEASUREMENT_UNCERTAINTY',
  'FORECAST_DISAGREEMENT',
  'RESOLVED_BY_CONTEXT',
] as const;
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

/** Structural verdict on a claim's source. Only SOURCED counts as evidence. */
export const CLAIM_VALIDATION_STATES = [
  'SOURCED',
  'NO_URL',
  'INVALID_URL',
  'UNSUPPORTED_SCHEME',
  'LOCAL_ADDRESS',
  // A search results page is where you look for a source, not a source.
  'SEARCH_RESULT',
  // A grounding or caching redirect stands between the reader and the source,
  // and stops resolving the moment the tool's session expires.
  'GROUNDING_REDIRECT',
  'NO_EVIDENCE',
] as const;
export type ClaimValidationState = (typeof CLAIM_VALIDATION_STATES)[number];

export interface DocumentSegmentRow {
  id: string;
  document_id: string;
  extraction_run_id: string;
  segment_index: number;
  segment_type: string;
  title: string;
  speaker: string | null;
  timestamp_text: string | null;
  block_start: number;
  block_end: number;
  char_start: number;
  char_end: number;
  text: string;
  content_hash: string;
  confidence: number;
  rationale: string;
  warnings: string;
  created_at: string;
}

export interface DocumentSegment {
  id: string;
  documentId: string;
  extractionRunId: string;
  segmentIndex: number;
  segmentType: SegmentType;
  title: string;
  speaker: string | null;
  timestampText: string | null;
  blockStart: number;
  blockEnd: number;
  charStart: number;
  charEnd: number;
  text: string;
  contentHash: string;
  /** How sure the classifier is, 0..1. Never presented as certainty. */
  confidence: number;
  rationale: string;
  warnings: string[];
  createdAt: string;
}

export interface SegmentLayerLinkRow {
  id: string;
  document_id: string;
  segment_id: string | null;
  layer_id: string;
  version: string | null;
  link_type: string;
  confidence: number;
  rationale: string;
  status: string;
  decided_at: string | null;
  created_at: string;
}

export interface SegmentLayerLink {
  id: string;
  documentId: string;
  /** Null for a whole-document link, as an ordinary imported file produces. */
  segmentId: string | null;
  layerId: string;
  version: string | null;
  linkType: LinkType;
  confidence: number;
  rationale: string;
  status: LinkStatus;
  decidedAt: string | null;
  createdAt: string;
}

export interface IngestionReportRow {
  id: string;
  document_id: string;
  extraction_run_id: string;
  scope: string;
  report: string;
  created_at: string;
}

export interface ImportJobRow {
  id: string;
  project_id: string;
  source_label: string;
  root_path: string;
  status: string;
  scope: string;
  discovered: number;
  processed: number;
  registered: number;
  duplicates: number;
  unsupported: number;
  unreadable: number;
  failed: number;
  needs_review: number;
  message: string | null;
  cancel_reason: string | null;
  heartbeat_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportFileRow {
  id: string;
  job_id: string;
  project_id: string;
  absolute_path: string;
  relative_path: string;
  filename: string;
  file_size: number | null;
  file_hash: string | null;
  detected_format: string | null;
  source_modified_at: string | null;
  status: string;
  document_id: string | null;
  duplicate_of_id: string | null;
  extraction_status: string | null;
  extraction_method: string | null;
  pages: number | null;
  ocr_pages: number | null;
  detail: string | null;
  warnings: string;
  classification: string | null;
  needs_confirmation: number;
  attempts: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoundaryContractRow {
  id: string;
  orchestration_id: string;
  project_id: string;
  layer_id: string;
  primary_question: string;
  decision_supported: string | null;
  audience: string | null;
  included_subjects: string;
  excluded_subjects: string;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: string;
  required_comparisons: string;
  required_calculations: string;
  expected_output: string | null;
  required_confidence: string | null;
  acceptable_uncertainty: string | null;
  prohibited_assumptions: string;
  source_constraints: string;
  completion_standard: string | null;
  ambiguities: string;
  status: string;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequirementRow {
  id: string;
  orchestration_id: string;
  project_id: string;
  layer_id: string;
  requirement_key: string;
  ordinal: number;
  statement: string;
  necessity: string;
  kind: string;
  rationale: string | null;
  required_evidence: string;
  completion_criteria: string;
  depends_on: string;
  owning_layer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExistingClaimRow {
  id: string;
  project_id: string;
  document_id: string;
  extraction_run_id: string | null;
  layer_id: string | null;
  claim: string;
  claim_type: string;
  page: number | null;
  block_index: number | null;
  char_start: number | null;
  char_end: number | null;
  locator: string | null;
  source_url: string | null;
  source_title: string | null;
  source_publisher: string | null;
  source_date: string | null;
  retrieved_at: string | null;
  supporting_passage: string | null;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definition: string | null;
  extraction_confidence: number;
  evidence_confidence: number;
  contradiction_state: string;
  verification_state: string;
  verification_detail: string | null;
  prior_audit_id: string | null;
  document_version: string | null;
  superseded: number;
  content_hash: string;
  created_at: string;
}

export interface RequirementCoverageRow {
  id: string;
  orchestration_id: string;
  requirement_id: string;
  status: string;
  reasons: string;
  claim_ids: string;
  document_ids: string;
  confidence: number;
  gap_type: string | null;
  gap_detail: string | null;
  needs_research: number;
  user_override: string | null;
  overridden_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchJobRow {
  id: string;
  orchestration_id: string;
  project_id: string;
  rationale: string;
  provider: string;
  model: string | null;
  job_kind: string;
  status: string;
  priority: number;
  external_job_id: string | null;
  prompt_sha256: string | null;
  prompt_bytes: number | null;
  output_bytes: number | null;
  duration_ms: number | null;
  failure_reason: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderConnectionRow {
  provider: string;
  installed: number;
  authenticated: number;
  automation_ready: number;
  executable_path: string | null;
  version: string | null;
  model: string | null;
  quota_state: string | null;
  message: string | null;
  diagnostics: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_reason: string | null;
  paid_overage_enabled: number;
  paid_overage_note: string | null;
  paid_overage_set_at: string | null;
  light_model: string | null;
  verified_run_at: string | null;
  verified_run_detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchOrchestrationRow {
  /** Null unless a person preauthorized an envelope this plan may be approved against. */
  approval_envelope_id: string | null;
  approval_envelope_authorized_by: string | null;
  approval_envelope_authorized_at: string | null;
  /** Null unless a person authorized recording unresolved gaps for this packet. */
  unresolved_gap_policy: string | null;
  unresolved_gap_authorized_by: string | null;
  unresolved_gap_authorized_at: string | null;
  id: string;
  project_id: string;
  layer_id: string;
  run_id: string;
  title: string;
  assignment: string;
  target_version: string | null;
  provider: string;
  model: string | null;
  status: string;
  current_pass: string | null;
  attempt: number;
  parent_orchestration_id: string | null;
  repair_reason: string | null;
  report_text: string | null;
  document_id: string | null;
  audit_id: string | null;
  verdict: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  heartbeat_at: string | null;
  auto_approve: number;
  fixture: number;
  approved_at: string | null;
  approval_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchFragmentRow {
  next_retry_at?: string | null;
  requirement_ids: string;
  evidence_lane: string | null;
  why_it_matters: string | null;
  missing_evidence: string | null;
  why_existing_insufficient: string | null;
  existing_claim_ids: string;
  excluded_scope: string | null;
  expected_claim_types: string;
  preferred_source_types: string;
  prohibited_evidence: string;
  required_comparisons: string;
  required_calculations: string;
  contradiction_targets: string;
  failure_conditions: string;
  uncertainty_tolerance: string | null;
  priority: number;
  estimated_effort: string | null;
  max_repairs: number;
  split_from_id: string | null;
  repair_plan: string | null;
  cancelled_reason: string | null;
  id: string;
  orchestration_id: string;
  project_id: string;
  layer_id: string;
  fragment_index: number;
  fragment_key: string;
  question: string;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: string | null;
  required_evidence: string;
  acceptable_source_types: string;
  excluded_source_types: string;
  completion_criteria: string;
  depends_on: string;
  min_independent_sources: number;
  status: string;
  attempt: number;
  parent_fragment_id: string | null;
  repair_reason: string | null;
  repair_strategy: string | null;
  integrity_verdict: string | null;
  sufficiency_verdict: string | null;
  verdict_detail: string | null;
  blocked_reason: string | null;
  queued_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchPassRow {
  id: string;
  orchestration_id: string;
  fragment_id: string | null;
  pass_key: string;
  ordinal: number;
  attempt: number;
  status: string;
  provider: string;
  model: string | null;
  prompt: string;
  prompt_sha256: string;
  raw_response: string | null;
  parsed: string | null;
  error: string | null;
  job_id: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  /** Execution lineage — which worker, Routine, account and session ran this. */
  executor_worker_id: string | null;
  executor_routine_id: string | null;
  executor_account_id: string | null;
  executor_session_ref: string | null;
}

export interface ResearchClaimRow {
  retrieval_state?: string | null;
  claim_type: string;
  source_group: string | null;
  primary_source: number;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definition: string | null;
  requirement_ids: string;
  job_id: string | null;
  reconciliation: string | null;
  reconciled_claim_id: string | null;
  contradiction_kind: string | null;
  reconciliation_detail: string | null;
  id: string;
  orchestration_id: string;
  fragment_id: string | null;
  pass_id: string | null;
  pass_key: string;
  claim: string;
  source_url: string | null;
  source_title: string | null;
  source_publisher: string | null;
  source_date: string | null;
  evidence_excerpt: string | null;
  evidence_locator: string | null;
  evidence_lane: string | null;
  opportunity_signal: string | null;
  monetization_method: string | null;
  structural_finding: string | null;
  structural_subject: string | null;
  structural_qualifier: string | null;
  structural_amount_cents: number | null;
  labor_finding: string | null;
  labor_subject: string | null;
  labor_qualifier: string | null;
  labor_rate_cents: number | null;
  capability_finding: string | null;
  capability_subject: string | null;
  capability_observed_on: string | null;
  capability_qualifier: string | null;
  capability_amount_low_minor: number | null;
  capability_amount_high_minor: number | null;
  capability_currency: string | null;
  capability_basis: string | null;
  deal_finding: string | null;
  deal_subject: string | null;
  deal_equipment: string | null;
  deal_jurisdiction: string | null;
  deal_value: string | null;
  deal_amount_cents: number | null;
  deal_currency: string | null;
  retrieved_at: string | null;
  confidence: number;
  contradiction_state: string;
  contradiction_note: string | null;
  validation_state: string;
  validation_detail: string | null;
  sourced: number;
  derived: number;
  derived_from: string;
  accepted: number;
  rejection_reason: string | null;
  scope_match: string | null;
  content_hash: string;
  created_at: string;
}

/** The machine-readable verdict every extraction run ends with (section 10). */
export interface ExtractionQuality {
  status: ExtractionStatus;
  pagesExpected: number;
  pagesReadable: number;
  pagesOcr: number;
  pagesFailed: number[];
  characterCount: number;
  warnings: string[];
  coverageRatio: number;
  pipelineVersion: string;
  blockedReason: string | null;
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/** A parsed version such as `v3.1A` → { major: 3, minor: 1, branch: 'A' }. */
export interface ParsedVersion {
  raw: string;
  /** Normalised canonical rendering, e.g. `v3.1A`. */
  normalized: string;
  major: number;
  minor: number;
  branch: string;
  /** 0 when there is no branch suffix; 1 = A, 2 = B … 27 = AA. */
  branchIndex: number;
  /** Lexicographically sortable key. Never sort on `raw`. */
  sortKey: string;
  valid: boolean;
}

export interface VersionPolicy {
  /** Version issued for the wave-1 foundation document. */
  foundationVersion: string;
  /** First branch suffix used for sibling expansions (Deal Dispatch starts at B). */
  expansionStartBranch: string;
  /** Version issued for the canonical synthesis. Never auto-incremented. */
  synthesisVersion: string;
  /** Wave in which synthesis happens. */
  synthesisWave: number;
  /** Cap on automatic conceptual redo loops before a human is required. */
  maxAutoRedos: number;
}

export const DEFAULT_VERSION_POLICY: VersionPolicy = {
  foundationVersion: 'v1',
  expansionStartBranch: 'B',
  synthesisVersion: 'v3.1',
  synthesisWave: 3,
  maxAutoRedos: 2,
};

// ---------------------------------------------------------------------------
// Rows (exact database shapes)
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  north_star: string | null;
  current_wave: number;
  status: string;
  version_policy: string;
  settings: string;
  /** 'PROJECT' | 'TECHNICAL' — see migration 028. */
  purpose: string;
  created_at: string;
  updated_at: string;
}

export interface LayerRow {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  order_index: number;
  status: string;
  status_source: string;
  manual_status: string | null;
  manual_status_reason: string | null;
  current_version: string | null;
  current_wave: number;
  canonical_document_id: string | null;
  expected_versions: string;
  parked: number;
  parked_note: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  canonical_name: string;
  version: string;
  version_sort: string;
  wave: number | null;
  document_type: string;
  status: string;
  filename: string | null;
  filesystem_path: string | null;
  storage_key: string | null;
  storage_provider: string | null;
  file_size: number | null;
  file_hash: string | null;
  file_missing: number;
  conversation_title: string | null;
  source_run_id: string | null;
  parent_document_id: string | null;
  superseded_by_document_id: string | null;
  is_canonical: number;
  frozen: number;
  notes: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
  mime_type: string | null;
  detected_format: string | null;
  page_count: number | null;
  extraction_status: string;
  extraction_run_id: string | null;
  pipeline_version: string | null;
  origin: string;
  scope: string;
  classification_source: string | null;
  classification_confidence: number | null;
  import_job_id: string | null;
  source_path: string | null;
  source_modified_at: string | null;
}

export interface ResearchRunRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  target_document_id: string | null;
  target_version: string | null;
  run_type: string;
  attempt_number: number;
  status: string;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  prompt_sections: string;
  required_attachments: string;
  expected_conversation_title: string | null;
  expected_filename: string | null;
  result_text: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  parent_run_id: string | null;
  redo_reason: string | null;
  dependency_override: number;
  dependency_override_reason: string | null;
  external_response_id: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DependencyRow {
  id: string;
  project_id: string;
  dependent_document_id: string | null;
  dependent_run_id: string | null;
  required_document_id: string | null;
  required_canonical_name: string;
  required_layer_id: string | null;
  dependency_type: string;
  required: number;
  notes: string | null;
  created_at: string;
}

export interface AuditRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  run_id: string | null;
  audited_document_id: string | null;
  verdict: string;
  summary: string;
  confidence: number | null;
  synthesis_required: number;
  freeze_eligible: number;
  next_version: string | null;
  next_action: string | null;
  source: string;
  raw: string;
  created_at: string;
  mode: string;
  profile_id: string | null;
  foundational_gap_count: number;
  targeted_research_runs_required: number;
  audited_document_ids: string;
  provider: string | null;
  model: string | null;
  evidence_manifest: string;
}

export interface AuditFindingRow {
  id: string;
  audit_id: string;
  finding_type: string;
  ordinal: number;
  content: string;
  payload: string;
  created_at: string;
}

export interface AuditGapRow {
  id: string;
  audit_id: string;
  ordinal: number;
  classification: string;
  title: string;
  detail: string;
  owning_layer_id: string | null;
  owning_layer_name: string | null;
  justification: string;
  research_question: string | null;
  expected_contribution: string | null;
  source_pass: string;
  created_at: string;
}

export interface AuditPassRow {
  id: string;
  audit_id: string | null;
  pipeline_id: string;
  project_id: string;
  layer_id: string | null;
  pass_key: string;
  ordinal: number;
  provider: string | null;
  model: string | null;
  prompt: string;
  raw_response: string | null;
  parsed: string;
  ok: number;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface ExtractionRunRow {
  id: string;
  document_id: string;
  project_id: string;
  status: string;
  pipeline_version: string;
  detected_format: string | null;
  source_hash: string | null;
  pages_expected: number;
  pages_readable: number;
  pages_ocr: number;
  pages_failed: string;
  character_count: number;
  coverage_ratio: number;
  warnings: string;
  blocked_reason: string | null;
  error: string | null;
  superseded_by_run_id: string | null;
  ocr_engine: string | null;
  ocr_engine_version: string | null;
  ocr_renderer_version: string | null;
  ocr_pages: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentBlockRow {
  id: string;
  extraction_run_id: string;
  document_id: string;
  page_number: number;
  block_index: number;
  block_type: string;
  raw_text: string;
  normalized_text: string;
  char_start: number;
  char_end: number;
  extraction_method: string;
  confidence: number | null;
  warnings: string;
  content_hash: string;
  bbox: string | null;
  created_at: string;
}

export interface DocumentChunkRow {
  id: string;
  extraction_run_id: string;
  document_id: string;
  chunk_index: number;
  page_start: number;
  page_end: number;
  block_start: number;
  block_end: number;
  heading_path: string;
  text: string;
  char_count: number;
  char_start: number;
  char_end: number;
  overlap_prev: number;
  has_ocr: number;
  content_hash: string;
  created_at: string;
}

export interface DocumentFindingRow {
  id: string;
  extraction_run_id: string;
  document_id: string;
  chunk_id: string | null;
  finding_type: string;
  ordinal: number;
  content: string;
  evidence_page: number | null;
  evidence_quote: string;
  confidence: number | null;
  source: string;
  created_at: string;
}

export interface AuditEvidenceRow {
  id: string;
  audit_id: string;
  gap_id: string | null;
  document_id: string | null;
  extraction_run_id: string | null;
  chunk_id: string | null;
  document_label: string;
  page_number: number | null;
  quote: string;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  run_id: string | null;
  title: string;
  provider_conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  metadata: string;
  created_at: string;
}

export interface ProjectEventRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  entity_type: string;
  entity_id: string | null;
  event_type: string;
  payload: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Views (API/UI shapes)
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  northStar: string | null;
  currentWave: number;
  status: ProjectStatus;
  versionPolicy: VersionPolicy;
  settings: Record<string, unknown>;
  /**
   * Whether this project is somebody's work or the machinery proving itself.
   *
   * A `TECHNICAL` scope is as real as any other and is deliberately kept out of
   * the ordinary counts a person reads — see migration 028.
   */
  purpose: ProjectPurpose;
  createdAt: string;
  updatedAt: string;
}

export interface Layer {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  orderIndex: number;
  status: LayerStatus;
  statusSource: StatusSource;
  manualStatus: LayerStatus | null;
  manualStatusReason: string | null;
  currentVersion: string | null;
  currentWave: number;
  canonicalDocumentId: string | null;
  expectedVersions: string[];
  parked: boolean;
  parkedNote: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Document {
  id: string;
  projectId: string;
  layerId: string | null;
  canonicalName: string;
  version: string;
  versionSort: string;
  wave: number | null;
  documentType: DocumentType;
  status: DocumentStatus;
  filename: string | null;
  filesystemPath: string | null;
  /**
   * Where the bytes are, in the document store's own terms.
   *
   * The same string as `filesystemPath` for anything stored locally — a
   * data-root-relative path is a perfectly good key — and an identity-based key
   * for anything stored in the cloud.
   */
  storageKey: string | null;
  /** Which store holds them: LOCAL or SUPABASE. */
  storageProvider: string | null;
  fileSize: number | null;
  fileHash: string | null;
  fileMissing: boolean;
  conversationTitle: string | null;
  sourceRunId: string | null;
  parentDocumentId: string | null;
  supersededByDocumentId: string | null;
  isCanonical: boolean;
  frozen: boolean;
  notes: string | null;
  importedAt: string | null;
  createdAt: string;
  updatedAt: string;
  mimeType: string | null;
  detectedFormat: DocumentFormat | null;
  pageCount: number | null;
  extractionStatus: ExtractionStatus;
  extractionRunId: string | null;
  pipelineVersion: string | null;
  origin: DocumentOrigin;
  /** LAYER for an ordinary report; a project scope for a source spanning layers. */
  scope: DocumentScope;
  /** How the layer was decided. A filename is a hint, never understanding. */
  classificationSource: ClassificationSource | null;
  classificationConfidence: number | null;
  /** The folder import this came from, and where it sat in that folder. */
  importJobId: string | null;
  sourcePath: string | null;
  sourceModifiedAt: string | null;
}

export interface ExtractionRun {
  id: string;
  documentId: string;
  projectId: string;
  status: ExtractionStatus;
  pipelineVersion: string;
  detectedFormat: DocumentFormat | null;
  sourceHash: string | null;
  pagesExpected: number;
  pagesReadable: number;
  pagesOcr: number;
  pagesFailed: number[];
  characterCount: number;
  coverageRatio: number;
  warnings: string[];
  blockedReason: string | null;
  error: string | null;
  supersededByRunId: string | null;
  /** Which OCR engine read this document's scanned pages, if any. */
  ocrEngine: string | null;
  ocrEngineVersion: string | null;
  ocrRendererVersion: string | null;
  /** Per-page OCR provenance: what was rendered, read, and how certainly. */
  ocrPages: OcrPageRecord[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What OCR did to one page.
 *
 * `imageHash` is the identity of the picture that was actually read, which is
 * what makes an OCR reading reproducible rather than merely plausible.
 */
export interface OcrPageRecord {
  page: number;
  ok: boolean;
  imageHash: string | null;
  width: number | null;
  height: number | null;
  dpi: number | null;
  confidence: number | null;
  durationMs: number | null;
  blocks: number;
  characters: number;
  warnings: string[];
}

export interface DocumentBlock {
  id: string;
  extractionRunId: string;
  documentId: string;
  pageNumber: number;
  blockIndex: number;
  blockType: BlockType;
  rawText: string;
  normalizedText: string;
  charStart: number;
  charEnd: number;
  extractionMethod: ExtractionMethod;
  confidence: number | null;
  warnings: string[];
  contentHash: string;
  bbox: [number, number, number, number] | null;
  createdAt: string;
}

export interface DocumentChunk {
  id: string;
  extractionRunId: string;
  documentId: string;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  blockStart: number;
  blockEnd: number;
  headingPath: string[];
  text: string;
  charCount: number;
  charStart: number;
  charEnd: number;
  overlapPrev: number;
  hasOcr: boolean;
  contentHash: string;
  createdAt: string;
}

export interface DocumentFinding {
  id: string;
  extractionRunId: string;
  documentId: string;
  chunkId: string | null;
  findingType: DocumentFindingType;
  ordinal: number;
  content: string;
  evidencePage: number | null;
  evidenceQuote: string;
  confidence: number | null;
  source: string;
  createdAt: string;
}

export interface AuditEvidence {
  id: string;
  auditId: string;
  gapId: string | null;
  documentId: string | null;
  extractionRunId: string | null;
  chunkId: string | null;
  documentLabel: string;
  pageNumber: number | null;
  quote: string;
  createdAt: string;
}

export interface ResearchRun {
  id: string;
  projectId: string;
  layerId: string | null;
  targetDocumentId: string | null;
  targetVersion: string | null;
  runType: RunType;
  attemptNumber: number;
  status: RunStatus;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  promptSections: PromptSection[];
  requiredAttachments: string[];
  expectedConversationTitle: string | null;
  expectedFilename: string | null;
  resultText: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  parentRunId: string | null;
  redoReason: string | null;
  dependencyOverride: boolean;
  dependencyOverrideReason: string | null;
  externalResponseId: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One folder import, and the counted state of everything inside it. */
export interface ImportJob {
  id: string;
  projectId: string;
  sourceLabel: string;
  rootPath: string;
  status: ImportJobStatus;
  scope: DocumentScope;
  discovered: number;
  processed: number;
  registered: number;
  duplicates: number;
  unsupported: number;
  unreadable: number;
  failed: number;
  needsReview: number;
  message: string | null;
  cancelReason: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportFile {
  id: string;
  jobId: string;
  projectId: string;
  absolutePath: string;
  relativePath: string;
  filename: string;
  fileSize: number | null;
  fileHash: string | null;
  detectedFormat: DocumentFormat | null;
  sourceModifiedAt: string | null;
  status: ImportFileStatus;
  documentId: string | null;
  duplicateOfId: string | null;
  extractionStatus: ExtractionStatus | null;
  extractionMethod: string | null;
  pages: number | null;
  ocrPages: number | null;
  detail: string | null;
  warnings: string[];
  classification: unknown;
  needsConfirmation: boolean;
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What this assignment is, and is not, about. Settled before any research. */
export interface BoundaryContract {
  id: string;
  orchestrationId: string;
  projectId: string;
  layerId: string;
  primaryQuestion: string;
  decisionSupported: string | null;
  audience: string | null;
  includedSubjects: string[];
  excludedSubjects: string[];
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: { term: string; definition: string }[];
  requiredComparisons: string[];
  requiredCalculations: string[];
  expectedOutput: string | null;
  requiredConfidence: string | null;
  acceptableUncertainty: string | null;
  prohibitedAssumptions: string[];
  sourceConstraints: string[];
  completionStandard: string | null;
  /** Boundaries the plan could not settle; each is a candidate fragment. */
  ambiguities: { question: string; why: string }[];
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED';
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Requirement {
  id: string;
  orchestrationId: string;
  projectId: string;
  layerId: string;
  requirementKey: string;
  ordinal: number;
  statement: string;
  necessity: RequirementNecessity;
  kind: RequirementKind;
  rationale: string | null;
  requiredEvidence: EvidenceLane[];
  completionCriteria: string[];
  dependsOn: FragmentDependency[];
  owningLayerId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A claim recovered from a document the project already had. */
export interface ExistingClaim {
  id: string;
  projectId: string;
  documentId: string;
  extractionRunId: string | null;
  layerId: string | null;
  claim: string;
  claimType: ClaimType;
  page: number | null;
  blockIndex: number | null;
  charStart: number | null;
  charEnd: number | null;
  locator: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  sourceDate: string | null;
  retrievedAt: string | null;
  supportingPassage: string | null;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definition: string | null;
  extractionConfidence: number;
  evidenceConfidence: number;
  contradictionState: ContradictionState;
  verificationState: VerificationState;
  verificationDetail: string | null;
  priorAuditId: string | null;
  documentVersion: string | null;
  superseded: boolean;
  contentHash: string;
  createdAt: string;
}

/** How well the archive already answers one requirement, and why. */
export interface RequirementCoverage {
  id: string;
  orchestrationId: string;
  requirementId: string;
  status: CoverageStatus;
  reasons: string[];
  claimIds: string[];
  documentIds: string[];
  confidence: number;
  gapType: GapType | null;
  gapDetail: string | null;
  needsResearch: boolean;
  userOverride: string | null;
  overriddenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One execution container, carrying one or more compatible fragments. */
export interface ResearchJob {
  id: string;
  orchestrationId: string;
  projectId: string;
  rationale: string;
  provider: string;
  model: string | null;
  jobKind: JobKind;
  status: JobStatus;
  priority: number;
  externalJobId: string | null;
  promptSha256: string | null;
  promptBytes: number | null;
  outputBytes: number | null;
  durationMs: number | null;
  failureReason: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The fragments this job carries, each still independently judged. */
  fragmentIds: string[];
}

/**
 * What the last connection test found, and when the worker last really worked.
 *
 * "Connected" means a job ran, not that an executable exists — so the last
 * success is tracked separately from the last check.
 */
export interface ProviderConnection {
  provider: string;
  installed: boolean;
  authenticated: boolean;
  automationReady: boolean;
  executablePath: string | null;
  version: string | null;
  model: string | null;
  quotaState: string | null;
  message: string | null;
  diagnostics: unknown;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  /** Off unless the user turned it on. Spending money is never a default. */
  paidOverageEnabled: boolean;
  paidOverageNote: string | null;
  paidOverageSetAt: string | null;
  /** The lighter model for broad discovery; `model` is the strong one. */
  lightModel: string | null;
  /** When a real job last ran here — not when a probe last answered. */
  verifiedRunAt: string | null;
  verifiedRunDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One assignment being worked through, pass by pass.
 *
 * `status` is where the work is; `verdict` is what Brain's audit made of it.
 * They are separate on purpose: a COMPLETE orchestration whose verdict was
 * MORE_RESEARCH_REQUIRED did its job correctly and produced a report that did
 * not pass, which is a different thing from a job that failed.
 */
export interface ResearchOrchestration {
  /**
   * Set only when a person has authorized this packet to record unresolved
   * gaps rather than stop. Null on every packet unless somebody said so, and
   * `advancePacket` refuses to convert an exhausted lane without it.
   */
  unresolvedGapPolicy: 'RECORD_GAPS' | null;
  unresolvedGapAuthorizedBy: string | null;
  unresolvedGapAuthorizedAt: string | null;
  /**
   * The preauthorized envelope this plan may be approved against, if any.
   *
   * A *reference*, never the limits themselves: the envelope is defined in
   * code, so whoever starts a packet cannot supply the rules their own plan
   * will be judged by. Null means the ordinary rule — a person approves.
   */
  approvalEnvelopeId: string | null;
  approvalEnvelopeAuthorizedBy: string | null;
  approvalEnvelopeAuthorizedAt: string | null;
  id: string;
  projectId: string;
  layerId: string;
  runId: string;
  title: string;
  assignment: string;
  targetVersion: string | null;
  provider: string;
  model: string | null;
  status: OrchestrationStatus;
  currentPass: ResearchPassKey | null;
  attempt: number;
  parentOrchestrationId: string | null;
  repairReason: string | null;
  reportText: string | null;
  documentId: string | null;
  auditId: string | null;
  verdict: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  heartbeatAt: string | null;
  /** False means: plan it, show the plan, and wait for a person. */
  autoApprove: boolean;
  /**
   * True when this packet's research was written into the repository rather
   * than found by anybody.
   *
   * A fact about the row rather than something a reader infers from a title,
   * because "is this real research" is a question several places have to answer
   * and none of them should answer it by guessing.
   */
  fixture: boolean;
  approvedAt: string | null;
  approvalNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One bounded piece of an assignment, with the boundaries that make its answer
 * checkable and the bar it has to clear before any of it counts.
 */
/**
 * Why an attempt failed and what the next one must do differently.
 *
 * The point of writing this down is that a repair which is the same prompt with
 * a different adjective is not a repair — it burns an attempt and the user's
 * allowance to produce the same failure. Every field here is something the next
 * attempt can act on, and the ecosystems already tried are recorded so they are
 * not tried again.
 */
export interface RepairPlan {
  /** The requirement that is still not established. */
  failedRequirement: string;
  /** Claims from the failed attempt that were rejected, and why. */
  affectedClaims: { claim: string; why: string }[];
  missingEvidence: string;
  rejectedEvidence: string[];
  unresolvedContradiction: string | null;
  /** Source ecosystems this fragment has already been searched in. */
  ecosystemsAttempted: string[];
  alternativeEcosystems: string[];
  alternativeTerminology: string[];
  alternativeClassifications: string[];
  /** A narrower question, when narrowing is the honest response to the failure. */
  narrowerQuestion: string | null;
  splitRequired: boolean;
  /** Attempts left before this fragment is reported unresolved. */
  remainingBudget: number;
  /** The named strategies this attempt should use, in order. */
  strategies: RepairStrategy[];
}

/**
 * The things that can actually be done differently.
 *
 * A named ladder rather than free text, so a repair cannot repeat the previous
 * attempt's approach and so the reason a fragment was finally abandoned is
 * checkable: every rung was tried.
 */
export const REPAIR_STRATEGIES = [
  'RESOLVE_CANONICAL_LINK',
  'FIND_PRIMARY_DATA',
  'TRY_DIFFERENT_REPOSITORIES',
  'USE_REGULATORY_RECORDS',
  'USE_PROCUREMENT_RECORDS',
  'USE_OFFICIAL_FILINGS',
  'INSPECT_ARCHIVED_SOURCES',
  'FIND_METHODOLOGY_DOCUMENTATION',
  'CHANGE_TERMINOLOGY',
  'USE_CLASSIFICATION_CODES',
  'NARROW_THE_CLAIM',
  'REPLACE_ESTIMATE_WITH_RANGE',
  'MARK_UNRESOLVED',
] as const;
export type RepairStrategy = (typeof REPAIR_STRATEGIES)[number];

export interface ResearchFragment {
  /** The requirements this fragment exists to answer. */
  requirementIds: string[];
  evidenceLane: string | null;
  whyItMatters: string | null;
  missingEvidence: string | null;
  /** Why the archive's own evidence could not answer it. */
  whyExistingInsufficient: string | null;
  existingClaimIds: string[];
  excludedScope: string | null;
  expectedClaimTypes: string[];
  preferredSourceTypes: string[];
  prohibitedEvidence: string[];
  requiredComparisons: string[];
  requiredCalculations: string[];
  contradictionTargets: string[];
  failureConditions: string[];
  uncertaintyTolerance: string | null;
  priority: number;
  estimatedEffort: string | null;
  maxRepairs: number;
  splitFromId: string | null;
  /** The structured plan behind a repair attempt; null on a first attempt. */
  repairPlan: RepairPlan | null;
  /** Set when accepted evidence made this fragment unnecessary. */
  cancelledReason: string | null;
  id: string;
  orchestrationId: string;
  projectId: string;
  layerId: string;
  fragmentIndex: number;
  fragmentKey: string;
  question: string;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: string | null;
  requiredEvidence: EvidenceLane[];
  acceptableSourceTypes: string[];
  excludedSourceTypes: string[];
  completionCriteria: string[];
  dependsOn: FragmentDependency[];
  minIndependentSources: number;
  /**
   * When a planned repair returns, for a fragment waiting rather than working.
   *
   * What makes `AWAITING_REPAIR` provable: a packet in that state must have
   * claimable repair work or a fragment naming a time. Neither, and it is not
   * awaiting anything.
   */
  nextRetryAt: string | null;
  status: FragmentStatus;
  attempt: number;
  parentFragmentId: string | null;
  repairReason: string | null;
  repairStrategy: string | null;
  integrityVerdict: IntegrityVerdict | null;
  sufficiencyVerdict: SufficiencyVerdict | null;
  verdictDetail: unknown;
  blockedReason: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchPass {
  id: string;
  orchestrationId: string;
  fragmentId: string | null;
  passKey: ResearchPassKey;
  ordinal: number;
  attempt: number;
  status: ResearchPassStatus;
  provider: string;
  model: string | null;
  prompt: string;
  promptSha256: string;
  rawResponse: string | null;
  parsed: unknown;
  error: string | null;
  jobId: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  executorWorkerId: string | null;
  executorRoutineId: string | null;
  executorAccountId: string | null;
  executorSessionRef: string | null;
}

export interface ResearchClaim {
  claimType: ClaimType;
  /** Sources that are really one source share a group; copies do not corroborate. */
  sourceGroup: string | null;
  primarySource: boolean;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definition: string | null;
  requirementIds: string[];
  jobId: string | null;
  /** What this finding does to the evidence the project already had. */
  reconciliation: ReconciliationOutcome | null;
  reconciledClaimId: string | null;
  /** How it disagrees with the claim it was reconciled against, when it does. */
  contradictionKind: ContradictionKind | null;
  reconciliationDetail: string | null;
  id: string;
  orchestrationId: string;
  fragmentId: string | null;
  passId: string | null;
  passKey: ResearchPassKey;
  claim: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  sourceDate: string | null;
  evidenceExcerpt: string | null;
  evidenceLocator: string | null;
  /** The fragment evidence lane it fills, if any. Coverage is counted per lane. */
  evidenceLane: string | null;
  /**
   * The kind of opening this claim establishes, if it establishes one.
   *
   * Null for ordinary descriptive evidence, which is most claims. Kept beside
   * the lane rather than instead of it: the lane says which question the claim
   * answers and carries coverage, and this says whether the claim describes a
   * piece of work. Both are true of one claim and neither substitutes.
   */
  opportunitySignal: OpportunitySignal | null;
  /**
   * How this claim says money would be made from the opening it establishes.
   *
   * `opportunitySignal` one axis along again: that one says *this is a piece of
   * work*, and this says *and the way to be paid for it is one the method table
   * would not have produced*. Set only on a claim that also carries a signal —
   * a way of monetizing something has to say what it is a way of monetizing,
   * and reading that out of the claim's prose is the guess §25 records the cost
   * of.
   *
   * Null on every claim written before it existed, and on most claims since,
   * which is correct rather than a gap: nobody was asked.
   */
  monetizationMethod: MonetizationMethod | null;
  /**
   * The structural fact about an industry this claim establishes, if any.
   *
   * `opportunitySignal` one axis along: that one says *this is a piece of
   * work*, and this says *this is how the industry is put together*. A claim
   * routinely carries neither, occasionally one, and can carry both — a
   * subcontracting notice is an opening and a fulfilment source at once.
   */
  structuralFinding: StructuralFinding | null;
  /**
   * What the finding is about, where the claim names something narrower than
   * the fragment's subject: the sub-industry, the layer, the buyer type.
   *
   * Required of a finding that creates a node, because reading the name out of
   * the claim sentence would be the prose-parsing §25 records — and refused on
   * a finding that creates none, so a caller cannot smuggle a subject past the
   * kinds that have nothing to name.
   */
  structuralSubject: string | null;
  /**
   * For a restructuring, the requirement it answers. Null for everything else.
   *
   * Which requirement a structure removes decides whether its published
   * residual reduces anything, so it is declared rather than read out of the
   * claim sentence — the one place where getting it wrong would silently make
   * a piece of work look cheaper than it is.
   */
  structuralQualifier: string | null;
  /**
   * A capital figure a source published, in minor units. Null means unknown.
   *
   * The nullability is the feature: `readCapital` withholds the minimum owner
   * capital entirely when any requirement carries null, rather than summing
   * the rest and producing a number that is wrong in the encouraging
   * direction.
   */
  structuralAmountCents: number | null;
  /**
   * What this claim establishes about who or what produces work of this kind,
   * if it establishes anything.
   *
   * `structuralFinding` one axis along again. That one says *this is how the
   * industry is put together*; this says *this is who actually does the work,
   * and under what rule*. The three axes are independent and a claim may carry
   * all three: a notice that an agency subcontracts transcription to licensed
   * medical typists at a published per-line rate is an opening, a fulfilment
   * source and a sourcing channel at once.
   */
  laborFinding: LaborFinding | null;
  /**
   * What the labor finding is about.
   *
   * From a closed set for the two kinds that have one — a HUMAN_REQUIREMENT
   * names which of the six necessity reasons, a SOURCING_CHANNEL names which
   * of the eleven channels — and free text for an AUTOMATION_PRECEDENT, which
   * names whatever the source says performs the work.
   */
  laborSubject: string | null;
  /**
   * The basis a sourcing channel's rate is quoted on. Null for every other
   * kind, and required wherever a rate is present.
   *
   * Declared rather than read out of the sentence, because "$40" against
   * "$40 an hour" against "$40 a month" is a three-order-of-magnitude
   * difference and the prose-parsing §25 records would get it wrong silently.
   */
  laborQualifier: string | null;
  /**
   * What a published source says a channel charges, in minor units. Null means
   * no source published one.
   *
   * The nullability is the feature, in the same direction `structuralAmount`'s
   * is: a blank read as cheap would make the option nobody had costed look
   * like the best one.
   */
  laborRateCents: number | null;
  /**
   * What this claim establishes about building a machine, or null.
   *
   * A third question beside the opening signal and the industry structure, and
   * a claim can answer all three: a trade report on excavator shipments is a
   * demand signal about a machine category *and* a fact about an industry.
   */
  capabilityFinding: CapabilityFinding | null;
  /** What that finding is about: a name, or a value from that kind's own set. */
  capabilitySubject: string | null;
  /**
   * When the source observed a demand signal.
   *
   * Required of `DEMAND_EVIDENCE` and refused of everything else. §30's rule:
   * an undated buying signal cannot be told apart from one somebody remembers
   * from years ago, and this is the column that decides whether a category may
   * be entered.
   */
  capabilityObservedOn: string | null;
  /**
   * The second closed value a finding names, where its kind has one.
   *
   * A capital requirement names which shape of the business its figure is
   * about; an acquisition candidate names what it would contribute. One column
   * for both, which is `structural_qualifier`'s shape one kernel along and for
   * its reason: the judgement is made once by whoever read the source, and
   * everything after that is a lookup.
   */
  capabilityQualifier: string | null;
  /**
   * The published range, in minor units, and what it is priced in.
   *
   * Both ends or neither. A source that publishes one figure sets them equal,
   * so every reader has one shape; a requirement nobody publishes a figure for
   * carries none, and the reading above it withholds the total rather than
   * summing past the gap.
   */
  capabilityAmountLowMinor: number | null;
  capabilityAmountHighMinor: number | null;
  capabilityCurrency: string | null;
  /**
   * What kind of figure the amount is.
   *
   * A regulator's published fee schedule and an analyst's market estimate are
   * both worth having and are not the same fact. Without this a reading would
   * present the second with the first's authority, which is the shape of error
   * §14 exists to refuse: a claim judged by a standard that does not fit what
   * it claims.
   */
  capabilityBasis: string | null;
  /**
   * What this claim establishes about a cross-border transaction, if anything.
   *
   * The third axis, and separate from the two above it because the three
   * answer different questions about one claim: *is this a piece of work*,
   * *is this how the industry is put together*, and *what does this say about
   * a transaction between two parties in two countries*. A column with two
   * masters is invariant 31, so they are three columns.
   */
  dealFinding: DealFinding | null;
  /** What the finding names: the organisation, the requirement, the cost line. */
  dealSubject: string | null;
  /**
   * Which class of equipment, as the source writes it.
   *
   * Its own field so that two spellings of one class are visibly two classes
   * rather than silently one, and so that a question naming a class verbatim
   * can be declared back unchanged.
   */
  dealEquipment: string | null;
  /**
   * The market it applies in.
   *
   * A column rather than a sentence for §25's reason at its sharpest: the same
   * trailer is legal in one market and unregistrable in the next, so a
   * requirement whose destination was recovered from prose is a confidently
   * wrong answer that every row around it agrees with.
   */
  dealJurisdiction: string | null;
  /** The closed-set value: a compliance layer, a cost component, a structure. */
  dealValue: string | null;
  /** The figure on a cost component, in minor units. Required there, refused elsewhere. */
  dealAmountCents: number | null;
  /**
   * Which currency that figure is in.
   *
   * Declared rather than taken from the sprint, because cross-border prices
   * genuinely arrive in several currencies and stamping them all with one
   * would make the mixed-currency reading unreachable — a mechanism nothing
   * calls, at the number that decides a deal. Brain never converts.
   */
  dealCurrency: string | null;
  retrievedAt: string | null;
  confidence: number;
  contradictionState: ContradictionState;
  retrievalState: RetrievalState;
  contradictionNote: string | null;
  validationState: ClaimValidationState;
  validationDetail: string | null;
  /** False whenever the claim may not be cited as evidence. */
  sourced: boolean;
  /** A calculation or inference rather than something a source states. */
  derived: boolean;
  /** The claims it was derived from; all of them must themselves be accepted. */
  derivedFrom: string[];
  /** Only an accepted claim may enter a synthesis. */
  accepted: boolean;
  rejectionReason: string | null;
  scopeMatch: unknown;
  contentHash: string;
  createdAt: string;
}

export interface Dependency {
  id: string;
  projectId: string;
  dependentDocumentId: string | null;
  dependentRunId: string | null;
  requiredDocumentId: string | null;
  requiredCanonicalName: string;
  requiredLayerId: string | null;
  dependencyType: DependencyType;
  required: boolean;
  notes: string | null;
  createdAt: string;
}

export interface AuditFinding {
  id: string;
  auditId: string;
  findingType: AuditFindingType;
  ordinal: number;
  content: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AuditGap {
  id: string;
  auditId: string;
  ordinal: number;
  classification: GapClassification;
  title: string;
  detail: string;
  owningLayerId: string | null;
  owningLayerName: string | null;
  justification: string;
  researchQuestion: string | null;
  expectedContribution: string | null;
  sourcePass: AuditPassKey;
  createdAt: string;
}

export interface AuditPass {
  id: string;
  auditId: string | null;
  pipelineId: string;
  projectId: string;
  layerId: string | null;
  passKey: AuditPassKey;
  ordinal: number;
  provider: string | null;
  model: string | null;
  prompt: string;
  rawResponse: string | null;
  parsed: unknown;
  ok: boolean;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface Audit {
  id: string;
  projectId: string;
  layerId: string | null;
  runId: string | null;
  auditedDocumentId: string | null;
  verdict: AuditVerdict;
  summary: string;
  confidence: number | null;
  synthesisRequired: boolean;
  freezeEligible: boolean;
  nextVersion: string | null;
  nextAction: string | null;
  source: string;
  raw: Record<string, unknown>;
  createdAt: string;
  findings: AuditFinding[];
  mode: AuditMode;
  profileId: string | null;
  foundationalGapCount: number;
  targetedResearchRunsRequired: number;
  auditedDocumentIds: string[];
  provider: string | null;
  model: string | null;
  gaps: AuditGap[];
  /** Proof of exactly which documents, pages and extraction runs were read. */
  evidenceManifest: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  projectId: string;
  layerId: string | null;
  runId: string | null;
  title: string;
  providerConversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectEvent {
  id: string;
  projectId: string;
  layerId: string | null;
  entityType: string;
  entityId: string | null;
  eventType: EventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Structured audit payload (section 12)
// ---------------------------------------------------------------------------

export interface StructuredAuditResult {
  verdict: AuditVerdict;
  summary: string;
  failures: string[];
  missingDocuments: string[];
  requiredResearchRuns: string[];
  requiredPatches: string[];
  synthesisRequired: boolean;
  freezeEligible: boolean;
  nextVersion: string | null;
  nextAction: string;
  confidence?: number | null;
}

// ---------------------------------------------------------------------------
// Prompt compiler (section 9)
// ---------------------------------------------------------------------------

export type PromptSectionKey =
  | 'PROJECT_CONTEXT'
  | 'LAYER_CONTEXT'
  | 'RUN_TYPE'
  | 'OBJECTIVE'
  | 'SOURCE_PACKET'
  | 'REQUIRED_ATTACHMENTS'
  | 'SCOPE'
  | 'RESEARCH_QUESTIONS'
  | 'PROHIBITED_DUPLICATION'
  | 'CROSS_LAYER_BOUNDARIES'
  | 'AUDIT_FINDINGS'
  | 'PREVIOUS_ATTEMPT'
  | 'OUTPUT_REQUIREMENTS'
  | 'NAMING_RULES'
  | 'FINAL_NAMING_CHECK';

export interface PromptSection {
  key: PromptSectionKey;
  heading: string;
  body: string;
}

export interface CompiledPrompt {
  prompt: string;
  sections: PromptSection[];
  requiredAttachments: string[];
  expectedConversationTitle: string;
  expectedFilename: string;
  targetCanonicalName: string;
  targetVersion: string;
}

// ---------------------------------------------------------------------------
// Dependency checker (section 11)
// ---------------------------------------------------------------------------

export interface DependencyCheckItem {
  canonicalName: string;
  documentId: string | null;
  required: boolean;
  dependencyType: DependencyType;
  present: boolean;
  /** Registered in the DB but the physical file is gone. */
  fileMissing: boolean;
  status: DocumentStatus | null;
}

export interface DependencyCheckResult {
  items: DependencyCheckItem[];
  requiredCount: number;
  presentCount: number;
  missing: string[];
  /** Registered dependencies whose file vanished from disk. */
  inconsistent: string[];
  ready: boolean;
  blocked: boolean;
  /** `6 / 7 READY` */
  summary: string;
}

// ---------------------------------------------------------------------------
// State engine + planner (sections 4 and 5)
// ---------------------------------------------------------------------------

export interface LayerStateSnapshot {
  layerId: string;
  layerName: string;
  status: LayerStatus;
  statusSource: StatusSource;
  reason: string;
  currentVersion: string | null;
  canonicalName: string | null;
  expectedVersions: string[];
  presentVersions: string[];
  missingVersions: string[];
  documentsComplete: number;
  documentsExpected: number;
  activeRunIds: string[];
  missingDependencies: string[];
  inconsistentDocuments: string[];
  /** Documents that are registered and present, but could not be read. */
  unreadableDocuments: string[];
  latestAuditVerdict: AuditVerdict | null;
  frozen: boolean;
  parked: boolean;
  nextAction: string;
  nextVersion: string | null;
}

export type PlannerBucket = 'NOW' | 'NEXT' | 'LATER' | 'BLOCKED';

export interface PlannerItem {
  bucket: PlannerBucket;
  layerId: string;
  layerName: string;
  status: LayerStatus;
  title: string;
  detail: string;
  /** Lower sorts first. Deterministic; never derived from chat memory. */
  priority: number;
  actionType:
    | 'IMPORT_DOCUMENT'
    | 'RUN_FOUNDATION'
    | 'RUN_EXPANSION'
    | 'RUN_AUDIT'
    | 'RUN_REDO'
    | 'RUN_SYNTHESIS'
    | 'FREEZE_LAYER'
    | 'RESOLVE_DEPENDENCY'
    | 'RECONCILE'
    | 'WAIT'
    | 'NONE';
  targetVersion: string | null;
  missing: string[];
}

export interface PlannerResult {
  projectId: string;
  projectName: string;
  wave: number;
  now: PlannerItem[];
  next: PlannerItem[];
  later: PlannerItem[];
  blocked: PlannerItem[];
  nextBestAction: PlannerItem | null;
  nextBestActionText: string;
  layers: LayerStateSnapshot[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Import + reconciliation (sections 7 and 21)
// ---------------------------------------------------------------------------

export interface InferenceResult {
  layerId: string | null;
  layerName: string | null;
  version: string | null;
  documentType: DocumentType | null;
  canonicalName: string | null;
  wave: number | null;
  confidence: number;
  /** Human-readable explanation of every inference decision. */
  reasons: string[];
  ambiguous: boolean;
}

export interface ImportResult {
  filename: string;
  storedPath: string | null;
  inference: InferenceResult;
  documentId: string | null;
  registered: boolean;
  requiresConfirmation: boolean;
  message: string;
  duplicateOfDocumentId?: string | null;
}

export interface ReconcileIssue {
  kind:
    | 'UNREGISTERED_FILE'
    | 'MISSING_PHYSICAL_FILE'
    | 'CHECKSUM_CHANGED'
    | 'ORPHANED_DOCUMENT';
  path: string | null;
  documentId: string | null;
  canonicalName: string | null;
  detail: string;
  inference?: InferenceResult;
  /** True when a one-click fix is available. */
  fixable: boolean;
  suggestedFix: string;
}

export interface ReconcileReport {
  projectId: string;
  scannedFiles: number;
  registeredDocuments: number;
  issues: ReconcileIssue[];
  healthy: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Identity, credentials and authorization (Step 4)
//
// Two kinds of principal, kept apart on purpose. A person signs in and holds a
// session; a worker is issued a credential and presents it. Everything below
// exists so that "who is asking, and may they" is answerable from server-held
// state alone — never from anything the caller supplied about itself.
// ---------------------------------------------------------------------------

/** What kind of thing is making a request. */
export const PRINCIPAL_TYPES = ['HUMAN', 'WORKER'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/**
 * What a person may do inside one project.
 *
 * Ordered, and the order is the authority ordering: every role can do what the
 * ones after it can. `roleAtLeast` in the policy module is the only place that
 * ordering is interpreted, so adding a role means editing one array.
 */
export const PROJECT_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/**
 * What a worker may do inside one project.
 *
 * Deliberately finer-grained than a role: a worker is given exactly the verbs
 * its job needs, and a worker that only files findings has no way to reopen a
 * layer even by accident.
 *
 * There is no queue-claiming scope and no MCP scope. Those belong to Steps 5
 * and 7, and a scope that grants nothing is worse than an absent one — code
 * starts checking for it, and the check reads as protection.
 */
export const WORKER_SCOPES = [
  'project:read',
  'documents:read',
  'research:read',
  'research:write',
  'research:propose',
  'claims:write',
  'sources:write',
  'contradictions:write',
  'checkpoints:write',
  'blockers:report',
  'work:complete',

  // Step 5 — the distributed queue. Each of these permits an operation that
  // exists and is enforced today; none is reserved for a later step.
  //
  // Administering the queue — enqueueing, cancelling — is deliberately absent.
  // That is a human authority derived from the project roles Step 4 already
  // defines, and giving a worker a scope for it would let a leaked worker
  // credential create work for the fleet rather than only perform it.
  'queue:read',
  'queue:claim',
  'queue:heartbeat',
  'queue:complete',

  // Step 12C — a connected site.
  //
  // One scope, not three, because the site connector does exactly one job:
  // keep a project's external records current and pass a person's typed
  // command through. It permits registering and updating records the site
  // already owns, and issuing a command from the closed set in
  // `EXTERNAL_COMMANDS`. It permits nothing else — no enqueueing, no
  // membership, no approval, no research write — so a stolen site credential
  // reaches exactly the surface a site already had.
  'external:sync',
] as const;
export type WorkerScope = (typeof WORKER_SCOPES)[number];

/**
 * What a remote worker gets, decided here rather than by a person ticking boxes.
 *
 * Scopes are real — they bound what a stolen credential reaches. But composing
 * them by hand was a job with no judgement in it and two ways to get it wrong,
 * and both happened within ten minutes of the screen existing: a worker was
 * granted the wrong project, and `work:complete` was ticked in place of
 * `queue:heartbeat` because the names sit next to each other and one of them is
 * used by no remote tool at all.
 *
 * So the Brain composes the set and a person chooses the project. This is
 * exactly what every tool in the remote surface requires and nothing else — not
 * a convenient superset, and not a subset that would make some tool fail
 * confusingly at the worst moment.
 *
 * **Step 9 is what the earlier version of this comment was waiting for.** It
 * said these would matter more "once research tools land and reads evidence
 * stops being the same thing as writes findings". They have landed, so the
 * research scopes are here — and the reason they belong in the same set rather
 * than a second, larger one is worth stating: a worker that can only read is a
 * worker that cannot do the job, and the honest bound on a stolen credential is
 * not "it may not write" but "everything it writes is stored unaccepted and
 * judged by the gate". That is a property of the Brain, not of the scope list.
 *
 * What is still deliberately absent is every scope that would let a worker
 * *administer* anything: enqueueing, cancelling, membership, resolving an
 * uncertain operation. None of them has a worker scope at all, so none of them
 * could be added here by accident.
 *
 * The administration API still accepts an explicit list, for the case that has
 * not come up yet. The console does not ask, because asking produced errors
 * rather than decisions.
 */
export const CONNECTOR_SCOPES: readonly WorkerScope[] = [
  'project:read',
  'documents:read',
  'queue:read',
  'queue:claim',
  'queue:heartbeat',
  'queue:complete',

  // Step 9. One per tool that needs it, and no more:
  //   research:read        brain_get_assignment, brain_get_audit_brief
  //   research:propose     brain_propose_fragments
  //   claims:write         brain_submit_claims
  //   research:write       brain_submit_verification, brain_submit_synthesis,
  //                        brain_submit_audit
  //   contradictions:write brain_report_contradiction
  //   checkpoints:write    brain_checkpoint_work
  //   blockers:report      brain_report_blocker
  'research:read',
  'research:propose',
  'research:write',
  'claims:write',
  'contradictions:write',
  'checkpoints:write',
  'blockers:report',
];

/**
 * What a connected *site* gets, which is not what a research worker gets.
 *
 * Two composed sets rather than one, because the two jobs share nothing. A
 * research worker claims queue items and writes claims, verifications and
 * audits; a site connector does none of that and must not be able to. It reads
 * the project it is attached to and keeps its own records current — and the
 * whole of "keeps its own records current" is one scope, so there is no
 * combination of these two that could be ticked wrongly.
 *
 * Nothing composes these two sets from a picker, and there is no screen that
 * asks which. A site's membership is written from this constant by
 * `services/connect/sites.ts` when somebody connects it in Russell; a research
 * worker's is written from `CONNECTOR_SCOPES` by `npm run admin`. The console
 * that once offered the choice was removed for exactly this reason: the wrong
 * answer fails *silently*, because a site holding the research set is refused
 * by every connector route with the same 404 a missing project gives.
 */
export const SITE_CONNECTOR_SCOPES: readonly WorkerScope[] = [
  'project:read',
  'external:sync',
];

/**
 * What a **factory** worker gets, which is neither of the other two.
 *
 * A third composed set, for the reason there are two already: the jobs share
 * almost nothing, and the wrong answer fails silently. A factory worker takes a
 * bin, reads its manifest, submits unit results, heartbeats, checkpoints, reports
 * an honest blocker and asks for completion. That is the whole of it.
 *
 * What is deliberately absent is the entire research half — `research:write`,
 * `research:propose`, `claims:write`, `contradictions:write` — and its absence is
 * a second, independent lock on the crossing `worker_routing` already refuses.
 * Routing decides what a worker may be *handed*; scopes decide what it could
 * *write* if it were handed one anyway. A factory identity holding this set cannot
 * record a claim, a verification or an audit verdict on anybody's research even if
 * every other guard in this codebase were removed — which is the property worth
 * having, because the defect these two mechanisms exist for was one identity doing
 * both jobs.
 *
 * `external:sync` is absent for the same reason it is absent from
 * `CONNECTOR_SCOPES`: a factory worker is not a connected site.
 */
export const FACTORY_WORKER_SCOPES: readonly WorkerScope[] = [
  'project:read',
  'queue:read',
  'queue:claim',
  'queue:heartbeat',
  'queue:complete',
  'checkpoints:write',
  'blockers:report',
];

/** How a request proved who it was. */
/**
 * `OAUTH_BEARER` is a token this Brain minted for a worker after a human
 * approved the connection. It is a third *way in*, not a third kind of
 * principal: it resolves to the same WORKER principal a `brnw_` credential
 * would, so nothing downstream has to know which door was used.
 */
export const AUTH_METHODS = [
  'SESSION_COOKIE',
  'WORKER_BEARER',
  'OAUTH_BEARER',
  /*
   * A person's conversation-bridge bearer. The only one of the four that
   * resolves to a HUMAN principal without a cookie — a chat client is not a
   * browser, and §21 refuses a cookie on a mutating cross-origin endpoint.
   */
  'BRIDGE_BEARER',
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/**
 * ACTIVE, DISABLED, or gone.
 *
 * `ARCHIVED` is terminal. A disabled worker is paused and can be brought back;
 * an archived one is retired, revoked and hidden, and there is deliberately no
 * way to reverse it. Re-enabling would resurrect an identity somebody chose to
 * remove, and the audit rows naming it read better when its name cannot be
 * taken by something new.
 */
export const WORKER_STATUSES = ['ACTIVE', 'DISABLED', 'ARCHIVED'] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/** Who or what performed an audited action. */
export const ACTOR_TYPES = ['HUMAN', 'WORKER', 'SYSTEM', 'ANONYMOUS'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const IDENTITY_RESULTS = ['SUCCESS', 'DENIED', 'FAILED'] as const;
export type IdentityResult = (typeof IDENTITY_RESULTS)[number];

/**
 * Why something was refused — a category, never a sentence containing evidence.
 *
 * The audit is readable by administrators, and a denial reason that
 * distinguished "no such user" from "wrong password" would turn the log into
 * an oracle for exactly the question an attacker is asking.
 */
export const DENIAL_REASONS = [
  'NO_CREDENTIALS',
  'INVALID_CREDENTIALS',
  'EXPIRED',
  'REVOKED',
  'PRINCIPAL_DISABLED',
  'NOT_A_MEMBER',
  'INSUFFICIENT_ROLE',
  'MISSING_SCOPE',
  'NOT_BRAIN_ADMIN',
  'UNSAFE_TRANSPORT',
  'LAST_ADMIN',
  'PASSWORD_CHANGE_REQUIRED',
  // A name somebody else already signs in by. It is a category about *this
  // Brain's* rows rather than about the caller, so it tells an attacker
  // nothing they could not learn by trying the name at the door — and the
  // administrator reading the audit needs to be able to tell it from a
  // refusal that means the invitation itself was bad.
  'NAME_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export type DenialReason = (typeof DENIAL_REASONS)[number];

// --- rows -------------------------------------------------------------------

export interface UserRow {
  id: string;
  /**
   * Null for a member who enrolled with a passkey.
   *
   * An address is how a password is recovered, and there is no password to
   * recover here (§26's invitation journey is the one that still needs one).
   * Requiring it of somebody who will never use it would be collecting a
   * personal detail for nothing.
   */
  email: string | null;
  display_name: string;
  /** See `UserKind`. Declared at creation, never inferred from a name. */
  kind: string;
  /** Null together with the verifier: a passkey-only account has no password. */
  password_algorithm: string | null;
  password_verifier: string | null;
  password_updated_at: string | null;
  /**
   * The six-digit PIN, as a verifier. Null until this account has set one.
   *
   * Beside the password rather than instead of it: the password is what
   * `/recovery` accepts to let somebody set or reset this, and the PIN is what
   * the ordinary sign-in screen asks for. See migration 078.
   */
  pin_algorithm: string | null;
  pin_verifier: string | null;
  pin_updated_at: string | null;
  /** Consecutive failures since the last success. Rows, not memory: a restart
   *  must not hand an attacker their budget back. */
  pin_failed_count: number;
  /** When the cooldown ends, or null. Compared to the clock, never scheduled. */
  pin_locked_until: string | null;
  must_change_password: number;
  is_brain_admin: number;
  disabled_at: string | null;
  created_by_type: string | null;
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserSessionRow {
  id: string;
  user_id: string;
  token_verifier: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  user_agent: string | null;
  created_ip: string | null;
  /** The device this session was opened by; null for the break-glass door. */
  passkey_id: string | null;
}

/**
 * What a worker may be handed, as stored.
 *
 * `families`, `repositories` and `capabilities` are JSON arrays; repositories are
 * `owner/name` ids, never remotes and never credentials. An explicit row is
 * exhaustive — see `services/bins/routing.ts`.
 */
export interface WorkerRoutingRow {
  worker_id: string;
  families: string;
  repositories: string;
  capabilities: string;
  reason: string;
  set_by: string;
  created_at: string;
  updated_at: string;
}

export interface WorkerRow {
  id: string;
  label: string | null;
  owner_user_id: string | null;
  owner_evidence: string | null;
  name: string;
  display_name: string;
  worker_type: string;
  description: string | null;
  status: string;
  disabled_at: string | null;
  archived_at: string | null;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

export interface WorkerInvitationRow {
  id: string;
  worker_id: string;
  token_prefix: string;
  token_digest: string;
  created_by_user_id: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
  note: string | null;
}

/** An administrator's approval of one worker, made in advance and sent. */
export interface WorkerInvitation {
  id: string;
  workerId: string;
  tokenPrefix: string;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  note: string | null;
}

/**
 * An invitation to a *person*, and the row behind §26's missing journey.
 *
 * Deliberately not `WorkerInvitationRow` under a wider name. A worker
 * invitation names a worker and is redeemed by a browser approving a connector;
 * this one names an email and a role and is redeemed by a person becoming a
 * member. One table serving both would make a lookup for either satisfiable by
 * the other, which is the kind of conflation invariant 23 exists to stop.
 */
export interface ProjectInvitationRow {
  id: string;
  project_id: string;
  invited_email: string;
  role: string;
  token_prefix: string;
  token_digest: string;
  invited_by_user_id: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_user_id: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  note: string | null;
}

/**
 * One offer of membership, made in advance and carried to another browser.
 *
 * Carries `tokenPrefix` and never the digest. The prefix is the public half —
 * it is how the row is found and is safe to display — while a digest of a live
 * credential is still a fact about that credential.
 */
export interface ProjectInvitation {
  id: string;
  projectId: string;
  invitedEmail: string;
  role: ProjectRole;
  tokenPrefix: string;
  invitedByUserId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedUserId: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  note: string | null;
}

export interface WorkerCredentialRow {
  id: string;
  worker_id: string;
  prefix: string;
  verifier: string;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  last_used_at: string | null;
  issued_by_type: string;
  issued_by_id: string;
  rotated_from: string | null;
}

export interface ProjectMembershipRow {
  id: string;
  project_id: string;
  principal_type: string;
  principal_id: string;
  role: string | null;
  scopes: string;
  granted_by_type: string;
  granted_by_id: string;
  granted_at: string;
  revoked_at: string | null;
  updated_at: string;
}

export interface IdentityEventRow {
  id: string;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  credential_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  project_id: string | null;
  result: string;
  reason: string | null;
  request_id: string | null;
  metadata: string;
  user_agent: string | null;
  remote_addr: string | null;
}

// --- views ------------------------------------------------------------------

/**
 * A person, as everything above the repository sees them.
 *
 * There is no password field and no verifier field, deliberately: the only code
 * that may see either lives in the repository and in the hashing module, and a
 * view type without them is what keeps a verifier from being accidentally
 * serialized into an API response.
 */
/**
 * Whether an identity is somebody, or machinery proving itself.
 *
 * `projects.purpose` settled the same question in migration 028 and for the
 * same reason: a screen that asks for *people* must not be handed the two
 * accounts `scripts/verify-hosted.ts` creates to prove authorization works, and
 * deciding that from a display name is a string comparison standing in for a
 * fact. It is declared at creation and read by projections; it grants nothing,
 * refuses nothing, and no authorization decision consults it.
 */
export const USER_KINDS = ['PERSON', 'SYSTEM'] as const;
export type UserKind = (typeof USER_KINDS)[number];

export interface User {
  id: string;
  /** Null for a passkey-only member; see `UserRow.email`. */
  email: string | null;
  displayName: string;
  kind: UserKind;
  isBrainAdmin: boolean;
  mustChangePassword: boolean;
  disabled: boolean;
  disabledAt: string | null;
  /** Null when this account has never had a password. */
  passwordUpdatedAt: string | null;
  /** Null when this account has never set a PIN; never the PIN or its verifier. */
  pinUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Worker {
  id: string;
  /**
   * The neutral operational identity — `worker-01`, `worker-02`, and so on.
   *
   * Server-assigned, stable, unique, and opaque about people. This is the only
   * worker identifier any surface prints and the value `Principal.handle`
   * carries, because a label that reads like a person's name is read as a claim
   * about whose account ran a session and never was one. See migration 074.
   *
   * Nullable in the type only for a row written before labels existed; the
   * migration backfilled every one, and `createWorker` assigns one.
   */
  label: string | null;
  /**
   * The legacy operator handle. A lookup key and nothing else.
   *
   * Two modules resolve a worker by it — connected sites and capability readers
   * — so it is kept rather than rewritten. It authorizes nothing, attributes
   * nothing, and must never be printed as an identity.
   */
  name: string;
  displayName: string;
  /**
   * Whose capacity this is, where Brain can actually prove it, and null
   * otherwise. Filled only from the approver on an authorization code or from a
   * connection a person completed themselves; never inferred from a name.
   */
  ownerUserId: string | null;
  /** How `ownerUserId` was established, so a reader can judge it. */
  ownerEvidence: string | null;
  workerType: string;
  description: string | null;
  status: WorkerStatus;
  /** True for DISABLED and ARCHIVED alike — every refusal path reads this. */
  disabled: boolean;
  disabledAt: string | null;
  archived: boolean;
  archivedAt: string | null;
  createdByType: ActorType;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What an administrator may see about a credential.
 *
 * The prefix is here because it is how a person tells two credentials apart in
 * a list and how they recognise one in the audit. The verifier is not, and no
 * shape anywhere in the application carries it out of the repository.
 */
export interface WorkerCredentialSummary {
  id: string;
  workerId: string;
  prefix: string;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  lastUsedAt: string | null;
  issuedByType: ActorType;
  issuedById: string;
  rotatedFrom: string | null;
  /** Derived, so a caller never has to re-implement the three conditions. */
  active: boolean;
}

export interface ProjectMembership {
  id: string;
  projectId: string;
  principalType: PrincipalType;
  principalId: string;
  role: ProjectRole | null;
  scopes: WorkerScope[];
  grantedByType: ActorType;
  grantedById: string;
  grantedAt: string;
  revokedAt: string | null;
  active: boolean;
}

export interface IdentityEvent {
  id: string;
  createdAt: string;
  actorType: ActorType;
  actorId: string | null;
  credentialId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  projectId: string | null;
  result: IdentityResult;
  reason: DenialReason | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
  userAgent: string | null;
  remoteAddr: string | null;
}

/**
 * Everything an authorization decision is allowed to consider.
 *
 * Assembled by the authentication step from server-held rows only. Nothing a
 * caller sent contributes to it — not a header naming a user, not a body field
 * naming a project, not an id in a path. That is what makes acting as somebody
 * else impossible rather than merely discouraged.
 */
export interface Principal {
  type: PrincipalType;
  id: string;
  /**
   * For a person their email, for a worker its canonical name.
   *
   * Null for a person who enrolled with a passkey and therefore has no address.
   * Nothing authorizes on it — it is what a screen prints and what the password
   * routes look an account up by, and both of those have to say "there is none"
   * rather than substitute something that reads like one.
   */
  handle: string | null;
  displayName: string;
  /** Brain-wide administration. Always false for a worker. */
  isBrainAdmin: boolean;
  mustChangePassword: boolean;
  /** The session id or worker-credential id this request authenticated with. */
  credentialId: string;
  authMethod: AuthMethod;
  /** Live memberships only; a revoked one is not in here at all. */
  memberships: ProjectMembership[];
  /** Correlates every audit row written while serving this request. */
  requestId: string;
}

// ---------------------------------------------------------------------------
// THE DISTRIBUTED WORK QUEUE (Step 5)
//
// A work item is a unit of dispatchable work. A lease is one period of one
// worker owning it. Ownership is proven by a lease id and a fencing generation
// together — never by a worker saying which item it holds.
// ---------------------------------------------------------------------------

export const WORK_ITEM_STATES = ['QUEUED', 'LEASED', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

/** The states nothing may move out of. */
export const TERMINAL_WORK_STATES: readonly WorkItemState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

export const LEASE_OUTCOMES = [
  'SUCCEEDED',
  'FAILED',
  /** The lease ran out before the worker finished, and the item was reclaimed. */
  'EXPIRED',
  'CANCELLED',
  /** The worker gave it back deliberately. */
  'RELEASED',
] as const;
export type LeaseOutcome = (typeof LEASE_OUTCOMES)[number];

/**
 * Why an attempt failed, as a closed set.
 *
 * A category rather than a message, because this is the field the planner and
 * the metrics read. The free-text detail is stored beside it, bounded and
 * sanitized, and nothing branches on it.
 */
export const WORK_FAILURE_CATEGORIES = [
  'WORKER_ERROR',
  'INVALID_INPUT',
  'DEPENDENCY_UNAVAILABLE',
  'TIMEOUT',
  'LEASE_EXPIRED',
  'ATTEMPTS_EXHAUSTED',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type WorkFailureCategory = (typeof WORK_FAILURE_CATEGORIES)[number];

export interface WorkItemRow {
  bundle_key?: string | null;
  /** Which bin this unit belongs to. Null for work that predates Step 10. */
  bin_id?: string | null;
  id: string;
  project_id: string;
  work_type: string;
  state: string;
  priority: number;
  available_at: string;
  payload: string;
  required_scopes: string;
  target_worker_id: string | null;
  attempt_count: number;
  max_attempts: number;
  lease_generation: number;
  lease_id: string | null;
  worker_id: string | null;
  lease_credential_id: string | null;
  leased_at: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  result_ref: string | null;
  result_summary: string | null;
  failure_category: string | null;
  cancelled_reason: string | null;
  correlation_id: string | null;
  orchestration_id: string | null;
  fragment_id: string | null;
  created_by_type: string;
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface WorkItemCheckpointRow {
  id: string;
  work_item_id: string;
  project_id: string;
  attempt_number: number;
  lease_generation: number;
  worker_id: string | null;
  note: string;
  created_at: string;
}

export interface WorkLeaseRow {
  id: string;
  work_item_id: string;
  project_id: string;
  attempt_number: number;
  lease_generation: number;
  worker_id: string;
  credential_id: string | null;
  claimed_at: string;
  expires_at: string;
  last_heartbeat_at: string | null;
  heartbeat_count: number;
  ended_at: string | null;
  outcome: string | null;
  detail: string | null;
  request_id: string | null;
}

export interface WorkItem {
  id: string;
  projectId: string;
  workType: string;
  state: WorkItemState;
  priority: number;
  availableAt: string;
  payload: Record<string, unknown>;
  requiredScopes: WorkerScope[];
  targetWorkerId: string | null;
  attemptCount: number;
  maxAttempts: number;
  /** The fencing token. Advances on every claim and every cancellation. */
  leaseGeneration: number;
  leaseId: string | null;
  workerId: string | null;
  leaseCredentialId: string | null;
  leasedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  resultRef: string | null;
  resultSummary: string | null;
  failureCategory: WorkFailureCategory | null;
  cancelledReason: string | null;
  correlationId: string | null;
  /**
   * The research assignment this item belongs to, when it is research work.
   *
   * A pointer rather than a copy. The worker cannot learn what to research by
   * reading the queue — it has to ask the Brain under the scope that permits
   * it — and the fragment row it is sent to is the same row the gate reads its
   * lanes and its evidence bar from, so the declaration cannot drift from what
   * judges it. Null for every work type that carries its whole subject in its
   * payload.
   */
  orchestrationId: string | null;
  fragmentId: string | null;
  /**
   * The bin this unit belongs to, when it belongs to one.
   *
   * A bin's internal units are ordinary queue rows — same claim, same lease,
   * same fence. This column is the only thing that makes them the bin's, which
   * is what keeps Step 10 from growing a second queue beside the first.
   */
  binId: string | null;
  createdByType: ActorType;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/**
 * A durable note a worker wrote while it still held the lease.
 *
 * The queue is at-least-once, so a lease can expire mid-research and the item
 * is redelivered to somebody who knows nothing about what the first attempt
 * found. Step 6 stops the effect repeating; this is what stops the thinking
 * being thrown away.
 *
 * Append-only, and identified by the generation that wrote it: a note from
 * generation 3 read by generation 4 is useful, and a note whose author cannot
 * be identified is not.
 */
export interface WorkItemCheckpoint {
  id: string;
  workItemId: string;
  projectId: string;
  attemptNumber: number;
  leaseGeneration: number;
  workerId: string | null;
  note: string;
  createdAt: string;
}

export interface WorkLease {
  id: string;
  workItemId: string;
  projectId: string;
  attemptNumber: number;
  leaseGeneration: number;
  workerId: string;
  credentialId: string | null;
  claimedAt: string;
  expiresAt: string;
  lastHeartbeatAt: string | null;
  heartbeatCount: number;
  endedAt: string | null;
  outcome: LeaseOutcome | null;
  detail: string | null;
  requestId: string | null;
}

/**
 * What a worker is handed when it wins a claim.
 *
 * The lease id and generation are in here because every subsequent operation
 * has to present them back. They are not secrets — they prove nothing on their
 * own, because the server also checks that the authenticated worker is the one
 * the lease was issued to.
 */
export interface ClaimedWork {
  workItemId: string;
  projectId: string;
  workType: string;
  payload: Record<string, unknown>;
  priority: number;
  attemptNumber: number;
  maxAttempts: number;
  leaseId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  correlationId: string | null;
}

/** Why an ownership-proving operation was refused. */
export const LEASE_REJECTIONS = [
  'NOT_FOUND',
  'NOT_LEASED',
  'NOT_THE_OWNER',
  'STALE_GENERATION',
  'LEASE_EXPIRED',
  'ALREADY_TERMINAL',
  'CANCELLED',
] as const;
export type LeaseRejection = (typeof LEASE_REJECTIONS)[number];

// ---------------------------------------------------------------------------
// IDEMPOTENCY AND EFFECT CONTROL (Step 6)
//
// Step 5's queue is at-least-once. These types are how an effect performed
// under it stops being repeatable. The guarantee is per effect class rather
// than universal, and `EffectClass` is what records which one was claimed.
// ---------------------------------------------------------------------------

export const OPERATION_STATES = ['RESERVED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN'] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const TERMINAL_OPERATION_STATES: readonly OperationState[] = ['SUCCEEDED', 'FAILED'];

/**
 * What kind of guarantee an effect can honestly be given.
 *
 * These are not interchangeable, and flattening them into one "idempotent"
 * label is the misleading thing this enum exists to prevent.
 */
export const EFFECT_CLASSES = [
  /** Wholly inside the Brain's database. Commits exactly once, transactionally. */
  'SAME_DATABASE',
  /** Database plus the private object store. Digest-keyed, recoverable. */
  'DATABASE_AND_STORAGE',
  /** External, with native idempotency: one stable provider key across retries. */
  'EXTERNAL_IDEMPOTENT',
  /** External, no native key, but authoritative state can be queried. */
  'EXTERNAL_RECONCILABLE',
  /** External, neither. One attempt, then a person decides. */
  'EXTERNAL_OPAQUE',
] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

export const EFFECT_PHASES = ['INTENT', 'SENT', 'CONFIRMED', 'FAILED', 'UNCERTAIN'] as const;
export type EffectPhase = (typeof EFFECT_PHASES)[number];

export const EFFECT_OUTCOMES = ['SUCCEEDED', 'FAILED', 'UNCERTAIN', 'ABANDONED'] as const;
export type EffectOutcome = (typeof EFFECT_OUTCOMES)[number];

/**
 * Why an operation is refused, as a closed set.
 *
 * `FINGERPRINT_CONFLICT` is the interesting one: the same key arriving with
 * materially different input. It is never executed and the previous payload is
 * never disclosed — the caller learns that the key is taken, and nothing else.
 */
export const OPERATION_REJECTIONS = [
  'FINGERPRINT_CONFLICT',
  'IN_PROGRESS',
  'NOT_THE_OWNER',
  'LEASE_LOST',
  'CANCELLED',
  'ALREADY_TERMINAL',
  'RECONCILIATION_REQUIRED',
] as const;
export type OperationRejection = (typeof OPERATION_REJECTIONS)[number];

/** Why an operation failed, or why its outcome is unknown. */
export const EFFECT_FAILURE_CATEGORIES = [
  'INVALID_INPUT',
  'NOT_AUTHORIZED',
  'DEPENDENCY_UNAVAILABLE',
  'PROVIDER_REJECTED',
  'TIMEOUT',
  'INTERNAL_ERROR',
  'ABANDONED',
] as const;
export type EffectFailureCategory = (typeof EFFECT_FAILURE_CATEGORIES)[number];

/**
 * How long a record must outlive the effect it describes.
 *
 * `PERMANENT` is for effects whose identity must never expire while the same
 * effect could still be attempted somewhere — deleting one of those would make
 * a completed external effect silently repeatable, which is the exact failure
 * this table exists to prevent.
 */
export const RETENTION_CLASSES = ['STANDARD', 'EXTENDED', 'PERMANENT'] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export interface IdempotencyOperationRow {
  id: string;
  scope_hash: string;
  key_fingerprint: string;
  namespace: string;
  namespace_version: number;
  project_id: string;
  created_by_type: string;
  created_by_id: string | null;
  correlation_id: string | null;
  work_item_id: string | null;
  lease_generation: number | null;
  request_fingerprint: string;
  fingerprint_version: number;
  state: string;
  attempt_count: number;
  failure_category: string | null;
  uncertainty_reason: string | null;
  recover_after: string | null;
  result_ref: string | null;
  result_status: number | null;
  result_summary: string | null;
  retention_class: string;
  reserved_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EffectAttemptRow {
  id: string;
  operation_id: string;
  attempt_number: number;
  executor_type: string;
  executor_id: string | null;
  work_item_id: string | null;
  lease_id: string | null;
  lease_generation: number | null;
  adapter: string | null;
  provider_key: string | null;
  phase: string;
  receipt_ref: string | null;
  receipt_meta: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  detail: string | null;
  request_id: string | null;
}

export interface IdempotencyOperation {
  id: string;
  scopeHash: string;
  keyFingerprint: string;
  namespace: string;
  namespaceVersion: number;
  projectId: string;
  createdByType: ActorType;
  createdById: string | null;
  correlationId: string | null;
  workItemId: string | null;
  leaseGeneration: number | null;
  requestFingerprint: string;
  fingerprintVersion: number;
  state: OperationState;
  attemptCount: number;
  failureCategory: EffectFailureCategory | null;
  uncertaintyReason: string | null;
  recoverAfter: string | null;
  resultRef: string | null;
  resultStatus: number | null;
  resultSummary: string | null;
  retentionClass: RetentionClass;
  reservedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EffectAttempt {
  id: string;
  operationId: string;
  attemptNumber: number;
  executorType: ActorType;
  executorId: string | null;
  workItemId: string | null;
  leaseId: string | null;
  leaseGeneration: number | null;
  adapter: string | null;
  providerKey: string | null;
  phase: EffectPhase;
  receiptRef: string | null;
  receiptMeta: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
  outcome: EffectOutcome | null;
  detail: string | null;
  requestId: string | null;
}

/* ------------------------------------------------------------------------- */
/* OAuth (Step 8)                                                             */
/* ------------------------------------------------------------------------- */

/**
 * The contract for connecting a worker through Claude's custom connector.
 *
 * Claude offers no way to send a static Authorization header, so the Step 7
 * bearer design cannot be used from it. OAuth is the only affordance, and it
 * turns out to be the better one: connecting a worker sends the operator to a
 * Brain-hosted screen where they authenticate as themselves and approve a named
 * worker, rather than carrying a long-lived secret into a configuration box.
 *
 * The invariant every type below exists to preserve: **a token resolves to the
 * worker, never to the human who approved it.**
 */

export const OAUTH_TOKEN_KINDS = ['ACCESS', 'REFRESH'] as const;
export type OAuthTokenKind = (typeof OAUTH_TOKEN_KINDS)[number];

export interface OAuthClientRow {
  id: string;
  client_id: string;
  secret_digest: string | null;
  client_name: string;
  redirect_uris: string;
  token_auth_method: string;
  created_at: string;
  disabled_at: string | null;
}

export interface OAuthClient {
  id: string;
  clientId: string;
  /** True when the client registered a secret. The secret itself never leaves the database. */
  confidential: boolean;
  clientName: string;
  redirectUris: string[];
  tokenAuthMethod: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface OAuthAuthorizationCodeRow {
  id: string;
  code_digest: string;
  client_id: string;
  worker_id: string;
  approved_by_user_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string | null;
  scope: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
}

export interface OAuthAuthorizationCode {
  id: string;
  clientId: string;
  /** The identity the token will carry. Chosen by the human, never by the client. */
  workerId: string;
  /** Who approved it. For the audit only — this never becomes the principal. */
  approvedByUserId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
  scope: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
}

export interface OAuthTokenRow {
  id: string;
  token_digest: string;
  token_prefix: string;
  kind: OAuthTokenKind;
  client_id: string;
  worker_id: string;
  scope: string;
  resource: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  parent_token_id: string | null;
}

export interface OAuthToken {
  id: string;
  kind: OAuthTokenKind;
  clientId: string;
  /** The principal. There is no user id here, deliberately. */
  workerId: string;
  scope: string;
  resource: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  parentTokenId: string | null;
}

// ---------------------------------------------------------------------------
// Step 10 — bins
// ---------------------------------------------------------------------------
//
// A bin is one complete idea: the objective, the manifest that fully specifies
// it, and the contract that decides whether it was finished. It is deliberately
// subject-free — the dispatcher must stay indifferent to what a bin is about,
// or Step 12 cannot add a new kind of mission without rewriting it.

export const BIN_STATES = [
  'DRAFT',
  'READY',
  'LEASED',
  'COMPLETE',
  'FAILED',
  'NEEDS_HUMAN',
  'CANCELLED',
] as const;
export type BinState = (typeof BIN_STATES)[number];

/** Which server-side predicate decides that a bin is finished. */
/* ------------------------------------------------------------------------- */
/* Step 11 — the fleet                                                        */
/* ------------------------------------------------------------------------- */

/**
 * What a surface may be.
 *
 * One vocabulary for accounts and Routines, because the operator's question is
 * the same at both levels — may work go here — and two different vocabularies
 * would mean two different answers to it.
 *
 * `DRAINING` is the one worth naming: it finishes what it holds and receives
 * nothing new, which is how a surface is removed without abandoning the work
 * already on it. `QUARANTINED` differs from `UNAVAILABLE` in who set it —
 * health did, rather than a person — and therefore in how it is cleared.
 */
export const FLEET_STATES = [
  'ENABLED',
  'DRAINING',
  'UNAVAILABLE',
  'QUARANTINED',
  'RETIRED',
] as const;
export type FleetState = (typeof FLEET_STATES)[number];

/**
 * What kind of fact a capacity number is.
 *
 * The honesty requirement of the whole step, as an enum. An unknown five-hour
 * allowance is `UNKNOWN` and stays `UNKNOWN`; it never becomes a percentage
 * because a percentage renders better. A refusal the provider issued is
 * `PROVIDER_ENFORCED` and outranks anything Brain inferred — optimism must not
 * be able to overwrite a wall somebody actually hit.
 */
export const CAPACITY_EVIDENCE = [
  'UNKNOWN',
  'MEASURED',
  'INFERRED',
  'PROVIDER_ENFORCED',
  'OPERATOR_POLICY',
] as const;
export type CapacityEvidence = (typeof CAPACITY_EVIDENCE)[number];

export const POLICY_SCOPES = ['FLEET', 'ACCOUNT', 'ROUTINE'] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

export interface FleetAccountRow {
  id: string;
  provider: string;
  name: string;
  kind: string;
  plan_label: string | null;
  declared_plan_power: string | null;
  state: string;
  state_reason: string | null;
  retry_at: string | null;
  last_refusal_at: string | null;
  last_refusal_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Whether an account is capacity somebody bought, or a verification fixture.
 *
 * `verify-hosted-account-a` and `-b` expect the sentinel secret
 * `VERIFY_HOSTED_NEVER_SET`, which is never deployed, so the dispatcher already
 * leaves them out of routing and reports them under `missingSecrets`. This is
 * the same fact said once, in a column, instead of by every reader comparing
 * the name against a prefix.
 */
export const FLEET_ACCOUNT_KINDS = ['CAPACITY', 'VERIFICATION'] as const;
export type FleetAccountKind = (typeof FLEET_ACCOUNT_KINDS)[number];

export interface FleetAccount {
  id: string;
  provider: string;
  name: string;
  kind: FleetAccountKind;
  planLabel: string | null;
  /** What the operator says they bought. A label, never arithmetic. */
  declaredPlanPower: string | null;
  state: FleetState;
  stateReason: string | null;
  retryAt: string | null;
  lastRefusalAt: string | null;
  lastRefusalReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FleetRoutineRow {
  id: string;
  account_id: string;
  routine_ref: string;
  name: string;
  routine_version: string | null;
  base_url: string | null;
  token_secret_name: string;
  token_digest: string | null;
  worker_id: string | null;
  capabilities: string;
  state: string;
  state_reason: string | null;
  fire_generation: number;
  consecutive_failures: number;
  consecutive_no_shows: number;
  total_fires: number;
  total_refusals: number;
  last_fired_at: string | null;
  last_check_in_at: string | null;
  retry_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FleetRoutine {
  id: string;
  accountId: string;
  routineRef: string;
  name: string;
  routineVersion: string | null;
  baseUrl: string | null;
  /** The NAME of the deployment secret. Never the secret. */
  tokenSecretName: string;
  tokenDigest: string | null;
  workerId: string | null;
  capabilities: string[];
  state: FleetState;
  stateReason: string | null;
  /** The compare-and-swap value a fire slot is claimed against. */
  fireGeneration: number;
  consecutiveFailures: number;
  consecutiveNoShows: number;
  totalFires: number;
  totalRefusals: number;
  lastFiredAt: string | null;
  lastCheckInAt: string | null;
  retryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FleetPolicyRow {
  id: string;
  scope: string;
  scope_id: string | null;
  version: number;
  target: number;
  auto_scale: number;
  auto_scale_ceiling: number | null;
  min_reserve: number;
  boost_target: number | null;
  boost_until: string | null;
  boost_reason: string | null;
  explore_ceiling: number | null;
  explore_until: string | null;
  paused: number;
  actor: string;
  reason: string;
  created_at: string;
}

export interface FleetPolicy {
  id: string;
  scope: PolicyScope;
  scopeId: string | null;
  version: number;
  /** Concurrent activations this scope may have in flight. */
  target: number;
  autoScale: boolean;
  autoScaleCeiling: number | null;
  minReserve: number;
  boostTarget: number | null;
  boostUntil: string | null;
  boostReason: string | null;
  exploreCeiling: number | null;
  exploreUntil: string | null;
  paused: boolean;
  actor: string;
  reason: string;
  createdAt: string;
}

export const COMPLETION_CONTRACTS = [
  'RESEARCH_PACKET_V1',
  'DETERMINISTIC_UNITS_V1',
  // Establishes what a worker's execution surface can and cannot reach, in a
  // closed vocabulary, so that "blocked" stops being one word for four facts.
  'SURFACE_PROBE_V1',
  // One conversation turn. The worker submits a structured proposal and Brain
  // decides what, if anything, it causes — see `services/russell/turn.ts`.
  'RUSSELL_TURN_V1',
  // One discovery lens that only a reader can answer. The worker submits
  // findings that each cite rows the project already holds; Brain validates
  // them, discards the ones whose citations do not resolve or that restate
  // something already held, and stores the rest as proposals a person accepts.
  // See `services/russell/inquiry.ts`.
  'RUSSELL_LENS_V1',
  // One captured idea, read. The worker submits what only a reader of the
  // question can judge — is the uncertainty cheap to reduce, what would a
  // packet have to establish, what is it worth — and Brain turns that into a
  // priority with `judge()`. Brain asks its own archive first and never asks
  // the worker whether the project already answers the question; see
  // `services/russell/planning.ts`.
  //
  // A software objective, decomposed. The worker reads the pinned repository and
  // proposes work units; Brain validates the proposal with `validatePlan`, which
  // refuses the whole plan for an unknown field, an invented verification
  // command, a path outside the approved scope, a dependency cycle or a mandatory
  // condition no unit serves. A plan is a proposal, and this is the contract that
  // says so at the bin boundary.
  'FACTORY_PLAN_V1',
  // Software, written. Each unit in the manifest is one bounded change with its
  // own branch and its own declared paths; the worker implements it in a checkout
  // Brain does not have and pushes it. Brain judges the bin by asking the *forge*
  // what moved — never by reading the worker's summary of what it did.
  'FACTORY_UNITS_V1',
  // Software, assembled. One bin moves the campaign's one branch: it merges the
  // unit branches Brain verified, runs the contract's own commands on the merged
  // tree, and pushes only if they pass. Brain confirms with the forge that the
  // branch is where the report says, that it contains every unit branch it names,
  // and that the whole range touched no path outside those units' declared ones.
  'FACTORY_INTEGRATION_V1',
  // Software, delivered. The worker opens or updates exactly one pull request,
  // using a title and body Brain composed from rows, and Brain reads the request
  // back from the forge to confirm it points at the commit that was integrated.
  // It stops there: merging is a person's decision and no worker scope grants it.
  'FACTORY_DELIVERY_V1',
  // A capability blueprint, read. Brain declares one unit per section it found
  // in the document's own headings, so coverage is a question about rows rather
  // than about a summary, and the worker proposes one structured definition per
  // unit. Every definition must quote the source; the quote is anchored in the
  // extracted text by Brain and the page comes from the block it was found in,
  // never from the model. See `services/capability/extraction.ts`.
  'BLUEPRINT_EXTRACTION_V1',
  // That reading, judged by a session that did not produce it. One verdict per
  // proposed definition, matched exactly against a closed set, and only
  // `FAITHFUL` may reach `promoteCandidate`. A candidate nobody judged is not
  // promoted: an unjudged definition that became canonical because nobody got to
  // it is exactly the vacuous satisfaction the candidate stage exists to prevent.
  'BLUEPRINT_AUDIT_V1',
  // A rendered interface, judged by somebody who did not build it. The measured
  // lane has already reported everything geometry settles — clipping, overflow,
  // a control covered at its own centre — so this contract is only for the half
  // that needs a reader: whether the screen emphasises what matters, whether the
  // grouping follows the material, and whether a sentence on the screen
  // contradicts a control beside it. The submission is validated exactly, and a
  // judgement submitted under a *measured* kind's name is refused, because a
  // view wearing a measurement's name cannot be argued with afterwards. See
  // `services/design/judge.ts`.
  'DESIGN_REVIEW_V1',
  // A picture of the product, taken where a browser exists. The deployed Brain
  // has none and must not acquire one, so the half of the design loop that needs
  // one is work handed to a surface that has it — and what comes back is capture
  // *metadata*: the surface, the width, the engine, the sha-256 of the bytes and
  // the readings taken in the live document. The bytes stay with the renderer,
  // because the address is an address and the digest is the evidence. Validated
  // exactly: a width the surface does not declare, a hash that is not a sha-256,
  // or a second picture of one thing refuses the whole submission. See
  // `services/design/render.ts`.
  'DESIGN_RENDER_V1',
] as const;
export type CompletionContract = (typeof COMPLETION_CONTRACTS)[number];

export const BIN_DISPATCH_STATES = ['PENDING', 'SENDING', 'SENT', 'ABANDONED', 'SUPERSEDED'] as const;
export type BinDispatchState = (typeof BIN_DISPATCH_STATES)[number];

/**
 * One internal unit of a generic bin.
 *
 * `transform` names a pure function Brain can run itself, which is what makes
 * `DETERMINISTIC_UNITS_V1` a check rather than an echo: the worker submits an
 * answer and Brain recomputes it from `input` instead of taking the answer's
 * word for itself.
 */
export interface BinUnitSpec {
  key: string;
  establishes: string;
  input: string;
  transform: string;
  dependsOn: string[];
}

/**
 * The complete work package, authored by Brain before assignment.
 *
 * Every field here is something the worker is told rather than something it
 * decides. A worker that could choose its own scope, its own unit count or its
 * own stopping condition would be planning, and planning is not what an
 * interchangeable worker is for.
 */
/**
 * The repository a bin's work happens in, for the bins that have one.
 *
 * Optional because most bins are about a question rather than a codebase, and a
 * required field every research manifest had to fill with a placeholder would be
 * a field nobody could trust. Present, it is the whole of what a worker is told
 * about where to stand: a remote, the ref and commit the contract pinned, the
 * branch Brain named for the integration, and the pull request to update rather
 * than duplicate.
 *
 * There is deliberately **no credential here**. A manifest is stored, shown and
 * read back; requirement 9's "never in prompts, logs, database content or
 * browser output" is satisfied by there being nothing to put anywhere. How a
 * worker comes to be able to push is granted where the worker runs — §22's rule,
 * and the reason Brain must never mint its own workers.
 */
export interface BinRepository {
  remote: string;
  ref: string;
  baseSha: string;
  integrationBranch: string;
  /** An existing pull request to update, or null to open one. */
  pullRequest: number | null;
}

export interface BinManifest {
  objective: string;
  why: string;
  /** Set for a bin whose work is a change to a repository. */
  repository?: BinRepository;
  lineage: {
    projectId: string;
    layerId: string | null;
    goal: string | null;
    orchestrationId: string | null;
  };
  units: BinUnitSpec[];
  acceptableSources: string[];
  excludedSources: string[];
  evidence: string[];
  outputs: string[];
  authorizedActions: string[];
  prohibitedActions: string[];
  budgetUnits: number | null;
  retry: { maxAttempts: number; backoffSeconds: number };
  stoppingConditions: string[];
}

export interface BinRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  kind: string;
  title: string;
  objective: string;
  rationale: string | null;
  manifest: string;
  completion_contract: string;
  contract_version: number;
  state: string;
  priority: number;
  orchestration_id: string | null;
  budget_units: number | null;
  attempt_count: number;
  max_attempts: number;
  dispatch_not_before: string | null;
  lease_generation: number;
  lease_id: string | null;
  worker_id: string | null;
  lease_credential_id: string | null;
  lease_session_ref: string | null;
  leased_at: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  lease_renewals: number;
  checkpoint: string | null;
  checkpoint_at: string | null;
  terminal_reason: string | null;
  last_refusal: string | null;
  refusal_count: number;
  /*
   * Added by migration 026 and, until Step 12A, present in neither this type
   * nor the create path. The router read it through
   * `(bin as unknown as { requiredCapabilities?: string[] | null })`, which
   * compiles and routes nothing: a cast asserts a shape rather than reading
   * one, so a bin that declared a capability was dispatched as if it had
   * declared none. Both columns are now mapped end to end.
   */
  required_capabilities: string | null;
  workload_class: string | null;
  /**
   * The one surface this bin may be fired at, or null for every ordinary bin.
   *
   * Restrictive only, written by Brain, and read by the fire router alone — see
   * `067_routine_pin.sql` for why a pool cannot be verified without it.
   */
  pinned_routine_id: string | null;
  created_by_type: string;
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  completed_at: string | null;
  factory_campaign_id: string | null;
}

export interface Bin {
  id: string;
  projectId: string;
  layerId: string | null;
  kind: string;
  title: string;
  objective: string;
  rationale: string | null;
  manifest: BinManifest;
  completionContract: CompletionContract;
  contractVersion: number;
  state: BinState;
  priority: number;
  orchestrationId: string | null;
  budgetUnits: number | null;
  attemptCount: number;
  maxAttempts: number;
  /**
   * When Brain may next spend a *fire* on this bin, or null for now.
   *
   * Set when an arriving session was refused by an admission guard, so the
   * dispatcher stops starting activations that cannot take the work. It is
   * deliberately not part of `DISPATCHABLE_SQL`: the assigner ignores it, so a
   * fresh eligible session arriving for any reason still gets the bin at once.
   */
  dispatchNotBefore: string | null;
  /** The fencing token. Advances on every assignment and every cancellation. */
  leaseGeneration: number;
  leaseId: string | null;
  workerId: string | null;
  leaseCredentialId: string | null;
  leaseSessionRef: string | null;
  leasedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  leaseRenewals: number;
  checkpoint: Record<string, unknown> | null;
  checkpointAt: string | null;
  terminalReason: string | null;
  /** Capability tags a Routine must have to be eligible for this bin. */
  requiredCapabilities: string[];
  /** What kind of work this is, for capacity attribution. */
  workloadClass: string | null;
  /**
   * The only Routine this bin may be fired at, when it has one.
   *
   * Null on every ordinary bin. Set on a surface probe, because proving that
   * *this* Routine runs as the worker it is bound to requires firing that
   * Routine rather than whichever one the pool happened to favour. It narrows
   * the candidate list and does nothing else: the pinned surface still has to
   * pass every check, and admission is still decided on the authenticated
   * worker.
   */
  pinnedRoutineId: string | null;
  lastRefusal: string | null;
  refusalCount: number;
  createdByType: string;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  completedAt: string | null;
  /**
   * The factory campaign this bin serves, or null.
   *
   * Its own column rather than a second meaning on `orchestrationId`, which
   * already means a research packet: one column with two meanings makes every
   * query about either of them ambiguous.
   */
  factoryCampaignId: string | null;
}

export interface BinDispatchRow {
  id: string;
  bin_id: string;
  lease_generation: number;
  state: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  routine_ref: string | null;
  routine_version: string | null;
  fire_event_id: string | null;
  session_ref: string | null;
  last_error_kind: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export interface BinDispatch {
  id: string;
  binId: string;
  leaseGeneration: number;
  state: BinDispatchState;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  routineRef: string | null;
  routineVersion: string | null;
  fireEventId: string | null;
  sessionRef: string | null;
  lastErrorKind: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface BinUnitResultRow {
  id: string;
  bin_id: string;
  unit_key: string;
  work_item_id: string | null;
  value: string;
  content_hash: string;
  lease_id: string | null;
  lease_generation: number | null;
  submitted_by: string | null;
  created_at: string;
}

export interface BinUnitResult {
  id: string;
  binId: string;
  unitKey: string;
  workItemId: string | null;
  value: string;
  contentHash: string;
  leaseId: string | null;
  leaseGeneration: number | null;
  submittedBy: string | null;
  createdAt: string;
}

export interface BinEventRow {
  id: string;
  event_type: string;
  at: string;
  bin_id: string | null;
  project_id: string | null;
  layer_id: string | null;
  orchestration_id: string | null;
  work_item_id: string | null;
  worker_id: string | null;
  session_ref: string | null;
  routine_ref: string | null;
  routine_version: string | null;
  fire_event_id: string | null;
  provider: string | null;
  lease_id: string | null;
  lease_generation: number | null;
  attempt: number | null;
  duration_ms: number | null;
  measures: string;
  outcome: string | null;
  reason: string | null;
  is_proxy: number;
  account_id: string | null;
  routine_id: string | null;
  evidence_class: string | null;
  workload_class: string | null;
}

export interface BinEvent {
  id: string;
  eventType: string;
  at: string;
  binId: string | null;
  projectId: string | null;
  layerId: string | null;
  orchestrationId: string | null;
  workItemId: string | null;
  workerId: string | null;
  sessionRef: string | null;
  routineRef: string | null;
  routineVersion: string | null;
  fireEventId: string | null;
  provider: string | null;
  leaseId: string | null;
  leaseGeneration: number | null;
  attempt: number | null;
  durationMs: number | null;
  measures: Record<string, unknown>;
  outcome: string | null;
  reason: string | null;
  /** True when a usage figure here is an observable proxy, not the provider's own accounting. */
  isProxy: boolean;
  /**
   * The capacity ledger's four attribution columns, §23's ledger read back.
   *
   * They were on the table and on the insert and absent from this type, so
   * every reader that went through `listBinEvents` saw a fire with no account
   * and no Routine — only `workloadProfile`, which writes its own SELECT, could
   * see them at all. A column nothing can read is not a ledger entry.
   */
  accountId: string | null;
  routineId: string | null;
  /**
   * `PROVIDER_ENFORCED`, `MEASURED` or `UNKNOWN`. A ceiling nobody has observed
   * stays `UNKNOWN` and is never upgraded by a report that wants a number.
   */
  evidenceClass: string | null;
  workloadClass: string | null;
}

// ---------------------------------------------------------------------------
// RUSSELL (Step 12A)
//
// Russell is the user-facing name of this Brain. These are the records that
// turn it on: a conversation that knows what it is about, a candidate that
// carries Russell's own judgment, a bounded probe, a standing authority with a
// budget, a mission that links the whole chain, the knowledge a finished
// mission writes back, the human decisions Russell may not take itself, and the
// loop that keeps going while nobody is watching.
//
// Every one of them carries its project and visibility from creation. There is
// no unscoped Russell row, because privacy applied on the way out is privacy
// that leaks through the first count, cache or duplicate match nobody filtered.
// ---------------------------------------------------------------------------

export const RUSSELL_VISIBILITIES = ['PRIVATE', 'SHARED'] as const;
export type RussellVisibility = (typeof RUSSELL_VISIBILITIES)[number];

export const ATTACHMENT_SOURCES = ['NONE', 'AUTOMATIC', 'USER', 'MIGRATED'] as const;
export type AttachmentSource = (typeof ATTACHMENT_SOURCES)[number];

export const RUSSELL_MESSAGE_ROLES = ['USER', 'RUSSELL', 'SYSTEM'] as const;
export type RussellMessageRole = (typeof RUSSELL_MESSAGE_ROLES)[number];

export const RUSSELL_MESSAGE_STATES = ['COMPLETE', 'PENDING', 'FAILED'] as const;
export type RussellMessageState = (typeof RUSSELL_MESSAGE_STATES)[number];

/**
 * A candidate's life.
 *
 * `PARKED` is not a bin. Every parked candidate has an authorized way back to
 * `QUEUED`, and `MERGED` has a guarded split, because a model's confidence
 * score may not permanently erase a valid idea.
 */
export const CANDIDATE_STATES = [
  'CAPTURED',
  'PROBING',
  'PROMOTED',
  'QUEUED',
  'PARKED',
  'REJECTED',
  'MERGED',
  'DONE',
] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

/**
 * Russell's priority labels, internal spelling.
 *
 * Ordered strongest-first, so a comparison is an index comparison in one place
 * rather than a switch in several. The user-facing wording lives in the
 * translation table and never in a component: **snake case is never product
 * copy.**
 */
export const CANDIDATE_PRIORITIES = [
  'MUST_DO',
  'BIG_MOVE',
  'WORTH_DOING',
  'EXPLORE',
  'PARKED',
] as const;
export type CandidatePriority = (typeof CANDIDATE_PRIORITIES)[number];

/** What a person reads. One mapping, tested, not scattered through the UI. */
export const CANDIDATE_PRIORITY_LABELS: Record<CandidatePriority, string> = {
  MUST_DO: 'Must do',
  BIG_MOVE: 'Big move',
  WORTH_DOING: 'Worth doing',
  EXPLORE: 'Explore',
  PARKED: 'Parked',
};

export const PROBE_STATES = ['PENDING', 'RUNNING', 'COMPLETE', 'FAILED'] as const;
export type ProbeState = (typeof PROBE_STATES)[number];

export const PROBE_OUTCOMES = [
  'SUPPORTED',
  'WEAKENED',
  'DUPLICATE',
  'UNKNOWN',
  'REFUSED',
] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/**
 * How one lookup went.
 *
 * Deliberately the same vocabulary Step 10's `SURFACE_PROBE_V1` uses, and for
 * the same reason: "blocked" is four different facts that lead to four
 * different actions, and collapsing them loses the only information that says
 * what to do next.
 */
export const PROBE_RETRIEVALS = [
  'RETRIEVED',
  'REFUSED',
  'BLOCKED',
  'UNREACHABLE',
  'NOT_FOUND',
] as const;
export type ProbeRetrieval = (typeof PROBE_RETRIEVALS)[number];

export const GOAL_STATES = ['ACTIVE', 'PAUSED', 'REVOKED', 'EXPIRED'] as const;
export const WORK_POLICIES = ['UNCAPPED', 'CAPPED'] as const;
export type WorkPolicy = (typeof WORK_POLICIES)[number];

export type GoalState = (typeof GOAL_STATES)[number];

export const RESERVATION_KINDS = ['MISSION', 'FRAGMENT', 'PROBE'] as const;
export type ReservationKind = (typeof RESERVATION_KINDS)[number];

export const RESERVATION_STATES = ['HELD', 'SETTLED', 'RELEASED', 'EXPIRED'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

export const MISSION_STATES = [
  'PLANNED',
  'LAUNCHING',
  'RUNNING',
  'WAITING',
  'NEEDS_HUMAN',
  'DONE',
  'FAILED',
  'CANCELLED',
] as const;
export type MissionState = (typeof MISSION_STATES)[number];

/** The five groups a person sees, and the states each one projects from. */
export const MISSION_GROUPS = [
  'WORKING_NOW',
  'UP_NEXT',
  'EXPLORING',
  'WAITING',
  'FINISHED',
] as const;
export type MissionGroup = (typeof MISSION_GROUPS)[number];

export const KNOWLEDGE_KINDS = [
  'CONCLUSION',
  'ASSUMPTION',
  'UNKNOWN',
  'DECISION',
  'GAP',
  'CONTRADICTION',
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_AUTHORS = ['RUSSELL', 'HUMAN', 'PIPELINE'] as const;
export type KnowledgeAuthor = (typeof KNOWLEDGE_AUTHORS)[number];

/** Confidence follows evidence, never tone. */
export const KNOWLEDGE_CONFIDENCE = [
  'ESTABLISHED',
  'SUPPORTED',
  'UNCERTAIN',
  'DISPUTED',
] as const;
export type KnowledgeConfidence = (typeof KNOWLEDGE_CONFIDENCE)[number];

export const HUMAN_REQUEST_URGENCIES = ['URGENT', 'BLOCKING', 'WHENEVER'] as const;
export type HumanRequestUrgency = (typeof HUMAN_REQUEST_URGENCIES)[number];

export const HUMAN_REQUEST_STATES = ['OPEN', 'ANSWERED', 'RESUMED', 'WITHDRAWN'] as const;
export type HumanRequestState = (typeof HUMAN_REQUEST_STATES)[number];

export const CYCLE_STATES = ['RUNNING', 'PAUSED', 'STOPPED'] as const;
export type CycleState = (typeof CYCLE_STATES)[number];

// --- rows -------------------------------------------------------------------

export interface RussellConversationRow {
  id: string;
  owner_user_id: string;
  project_id: string | null;
  title: string;
  purpose: string;
  visibility: string;
  attachment_confidence: number | null;
  attachment_source: string;
  grounding: string;
  legacy_conversation_id: string | null;
  collection_id: string | null;
  collection_source: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * What a conversation is for.
 *
 * `GENERAL` is the default and the overwhelmingly common case: somebody
 * thinking out loud with Russell. `PROJECT` is a thread that belongs to a
 * project — attached by a person or by the router, or one that produced work
 * against it. The other two exist so that a thread deliberately opened as
 * operations or as technical work can say so; nothing derives either of them,
 * because deriving a category from a thread's words is the guess this whole
 * field replaces.
 */
export const CONVERSATION_PURPOSES = ['GENERAL', 'PROJECT', 'OPERATIONAL', 'TECHNICAL'] as const;
export type ConversationPurpose = (typeof CONVERSATION_PURPOSES)[number];

export interface RussellConversationContextRow {
  id: string;
  conversation_id: string;
  project_id: string | null;
  source: string;
  confidence: number | null;
  reason: string;
  actor_user_id: string | null;
  created_at: string;
}

export interface RussellMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  author_user_id: string | null;
  content: string;
  status: string;
  pending_reason: string | null;
  produced: string;
  metadata: string;
  /**
   * The person's message this turn is an attempt at, and which attempt it is.
   *
   * NULL on every ordinary turn — a first attempt has nothing to record — which
   * is what lets the unique index over the pair arbitrate concurrent retries
   * without a backfill: NULLs are distinct on both backends.
   */
  answers_message_id: string | null;
  attempt: number | null;
  created_at: string;
  updated_at: string;
}

export interface RussellCandidateRow {
  id: string;
  project_id: string | null;
  visibility: string;
  conversation_id: string | null;
  source_message_id: string | null;
  title: string;
  statement: string;
  fingerprint: string;
  state: string;
  canonical_candidate_id: string | null;
  priority: string | null;
  ordinal: number | null;
  confidence: number | null;
  reason: string | null;
  judgment: string;
  supporting: string;
  contradicting: string;
  override_user_id: string | null;
  override_reason: string | null;
  override_at: string | null;
  superseded_decision: string | null;
  follow_on_of_mission_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RussellCandidateMergeRow {
  id: string;
  candidate_id: string;
  canonical_id: string;
  action: string;
  method: string;
  confidence: number | null;
  reason: string;
  actor_user_id: string | null;
  created_at: string;
}

export interface RussellProbeRow {
  id: string;
  candidate_id: string;
  project_id: string | null;
  visibility: string;
  question: string;
  allowed_sources: string;
  max_lookups: number;
  deadline_at: string;
  reservation_id: string | null;
  state: string;
  outcome: string | null;
  explanation: string | null;
  lookups_used: number;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface RussellProbeObservationRow {
  id: string;
  probe_id: string;
  ordinal: number;
  source_url: string;
  retrieval: string;
  note: string | null;
  observed_at: string;
}

export interface RussellGoalRow {
  id: string;
  project_id: string;
  owner_user_id: string;
  name: string;
  policy_version: number;
  allowed_work: string;
  prohibitions: string;
  max_missions: number;
  max_fragments: number;
  max_concurrent: number;
  max_probes: number;
  work_policy?: string | null;
  max_external_spend: number;
  starts_at: string;
  expires_at: string | null;
  state: string;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  revoked_reason: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface RussellReservationRow {
  id: string;
  goal_id: string;
  kind: string;
  amount: number;
  idempotency_key: string;
  state: string;
  expires_at: string;
  settled_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  created_at: string;
}

export interface RussellMissionRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  visibility: string;
  candidate_id: string | null;
  conversation_id: string | null;
  probe_id: string | null;
  goal_id: string | null;
  reservation_id: string | null;
  objective: string;
  why_now: string;
  state: string;
  waiting_on: string | null;
  orchestration_id: string | null;
  bin_id: string | null;
  document_id: string | null;
  audit_id: string | null;
  writeback_at: string | null;
  next_mission_id: string | null;
  terminal_reason: string | null;
  idempotency_key: string;
  attempt?: number | null;
  supersedes_mission_id?: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface RussellKnowledgeRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  visibility: string;
  kind: string;
  statement: string;
  detail: string | null;
  provenance: string;
  author_type: string;
  confidence: string;
  as_of: string | null;
  last_confirmed_at: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  mission_id: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RussellHumanRequestRow {
  id: string;
  project_id: string;
  visibility: string;
  mission_id: string | null;
  candidate_id: string | null;
  conversation_id: string | null;
  authority_needed: string;
  why_not_russell: string;
  recommendation: string | null;
  choices: string;
  urgency: string;
  state: string;
  answered_by_user_id: string | null;
  answered_choice: string | null;
  answered_reason: string | null;
  answered_at: string | null;
  resume_key: string;
  created_at: string;
  updated_at: string;
}

export interface RussellCycleRow {
  id: string;
  generation: number;
  cursor_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  state: string;
  pause_reason: string | null;
  paused_by_user_id: string | null;
  max_launches_per_cycle: number;
  max_followons_per_cycle: number;
  max_events_per_cycle: number;
  max_retry_age_minutes: number;
  last_ran_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// --- views ------------------------------------------------------------------

export interface RussellConversation {
  id: string;
  ownerUserId: string;
  projectId: string | null;
  title: string;
  /**
   * What this thread is for, stated rather than inferred from a default.
   *
   * `projectId` says *which* project a thread is about; this says whether it
   * is about one at all. They were one field, and the consequence was that a
   * client passing the first project in a list made every general conversation
   * in this Brain a Deal Dispatch conversation — see migration 084.
   */
  purpose: ConversationPurpose;
  visibility: RussellVisibility;
  attachmentConfidence: number | null;
  attachmentSource: AttachmentSource;
  grounding: Record<string, unknown>;
  legacyConversationId: string | null;
  /** Which collection this thread sits in, or null while unfiled. */
  collectionId: string | null;
  /** Who filed it. A person's choice is never overwritten by the automatic pass. */
  collectionSource: CollectionSource;
  /** When somebody said this thread was done. Never derived. */
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What kind of thing a collection groups. */
export const COLLECTION_KINDS = ['PROJECT', 'CATEGORY', 'PERSONAL'] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];

/** Who decided a thread belongs in a collection. `NONE` means nobody yet. */
export const COLLECTION_SOURCES = ['NONE', 'AUTOMATIC', 'USER'] as const;
export type CollectionSource = (typeof COLLECTION_SOURCES)[number];

export interface RussellCollection {
  id: string;
  ownerUserId: string;
  projectId: string | null;
  name: string;
  kind: CollectionKind;
  source: 'AUTOMATIC' | 'USER';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RussellCollectionRow {
  id: string;
  owner_user_id: string;
  project_id: string | null;
  name: string;
  kind: string;
  source: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RussellConversationContext {
  id: string;
  conversationId: string;
  projectId: string | null;
  source: AttachmentSource;
  confidence: number | null;
  reason: string;
  actorUserId: string | null;
  createdAt: string;
}

export interface RussellMessage {
  id: string;
  conversationId: string;
  role: RussellMessageRole;
  authorUserId: string | null;
  content: string;
  status: RussellMessageState;
  pendingReason: string | null;
  produced: Record<string, unknown>;
  metadata: Record<string, unknown>;
  /**
   * Which question this turn answers, and which attempt at it this is.
   *
   * Both null on an ordinary turn and on every turn recorded before retries
   * existed, which reads correctly as "the first attempt". `answersMessageId`
   * being non-null is the one predicate that identifies a retry, so nothing
   * that counts turns can mistake one for a fresh question.
   */
  answersMessageId: string | null;
  attempt: number | null;
  createdAt: string;
  updatedAt: string;
  /** True when this row came from a pre-12A `messages` row through the union. */
  legacy?: boolean;
  /**
   * What this turn is waiting for **right now**, derived on the read path by
   * `services/russell/pending.ts` from the bin and its dispatch.
   *
   * View-only, like `legacy`: there is no column behind it. `pendingReason` is
   * the sentence stored when the turn was created and is part of the row's
   * history; this is the one that can become wrong and therefore the one worth
   * showing. Absent on anything that is not `PENDING`.
   */
  pendingDetail?: string | null;
}

export interface RussellCandidate {
  id: string;
  projectId: string | null;
  visibility: RussellVisibility;
  conversationId: string | null;
  sourceMessageId: string | null;
  title: string;
  statement: string;
  fingerprint: string;
  state: CandidateState;
  canonicalCandidateId: string | null;
  priority: CandidatePriority | null;
  ordinal: number | null;
  confidence: number | null;
  reason: string | null;
  judgment: Record<string, unknown>;
  supporting: string[];
  contradicting: string[];
  overrideUserId: string | null;
  overrideReason: string | null;
  overrideAt: string | null;
  supersededDecision: string | null;
  /**
   * The mission whose completion produced this idea, when one did.
   *
   * An idea, not a mission: it is judged against the archive like everything
   * else, because the parent mission has just changed what the archive says.
   * The parent learns its `next_mission_id` only if and when this launches.
   */
  followOnOfMissionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RussellProbe {
  id: string;
  candidateId: string;
  projectId: string | null;
  visibility: RussellVisibility;
  question: string;
  allowedSources: string[];
  maxLookups: number;
  deadlineAt: string;
  reservationId: string | null;
  state: ProbeState;
  outcome: ProbeOutcome | null;
  explanation: string | null;
  lookupsUsed: number;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RussellProbeObservation {
  id: string;
  probeId: string;
  ordinal: number;
  sourceUrl: string;
  retrieval: ProbeRetrieval;
  note: string | null;
  observedAt: string;
}

export interface RussellGoal {
  id: string;
  projectId: string;
  ownerUserId: string;
  name: string;
  policyVersion: number;
  allowedWork: string[];
  prohibitions: string[];
  maxMissions: number;
  maxFragments: number;
  maxConcurrent: number;
  maxProbes: number;
  /**
   * Whether the cumulative ceilings above stop anything.
   *
   * `UNCAPPED` is the product default: ordinary authorized work runs
   * continuously on the subscription that backs it, and the numbers stay as
   * accounting rather than as a lifetime allowance somebody has to replenish.
   * `CAPPED` restores them, and exists so the mechanism is a policy rather
   * than a deletion — a genuinely bounded experiment can still ask for one.
   *
   * `maxConcurrent` is *not* governed by this. Concurrency is real provider
   * capacity, not an artificial quota.
   */
  workPolicy: WorkPolicy;
  maxExternalSpend: number;
  startsAt: string;
  expiresAt: string | null;
  state: GoalState;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokedReason: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RussellReservation {
  id: string;
  goalId: string;
  kind: ReservationKind;
  amount: number;
  idempotencyKey: string;
  state: ReservationState;
  expiresAt: string;
  settledAt: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  createdAt: string;
}

export interface RussellMission {
  id: string;
  projectId: string;
  layerId: string | null;
  visibility: RussellVisibility;
  candidateId: string | null;
  conversationId: string | null;
  probeId: string | null;
  goalId: string | null;
  reservationId: string | null;
  objective: string;
  whyNow: string;
  state: MissionState;
  waitingOn: string | null;
  orchestrationId: string | null;
  binId: string | null;
  documentId: string | null;
  auditId: string | null;
  writebackAt: string | null;
  nextMissionId: string | null;
  terminalReason: string | null;
  idempotencyKey: string;
  /** Which try this is. 1 for a first mission; a redo increments it. */
  attempt: number;
  /** The mission this one was launched to replace, when it is a redo. */
  supersedesMissionId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RussellKnowledge {
  id: string;
  projectId: string;
  layerId: string | null;
  visibility: RussellVisibility;
  kind: KnowledgeKind;
  statement: string;
  detail: string | null;
  provenance: Record<string, unknown>;
  authorType: KnowledgeAuthor;
  confidence: KnowledgeConfidence;
  asOf: string | null;
  lastConfirmedAt: string | null;
  supersedesId: string | null;
  supersededById: string | null;
  missionId: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/* --------------------------------------------------------------------------
 * The Discovery Frontier (Step 12B, S11)
 * ------------------------------------------------------------------------ */

/**
 * The five regions of a project's edge.
 *
 * They are not a gradient. Solid and weak are both *believed*; an open question
 * is known to be unanswered; an unexamined area is one nobody has looked at at
 * all; and a new path is something Brain found rather than something anybody
 * asked for. Collapsing any two of them loses the difference that decides what
 * to do next.
 */
export const FRONTIER_REGIONS = [
  'SOLID_GROUND',
  'WEAK_GROUND',
  'OPEN_QUESTION',
  'UNEXAMINED',
  'NEW_PATH',
] as const;
export type FrontierRegion = (typeof FRONTIER_REGIONS)[number];

/** What a person reads for each. One mapping, not scattered through the UI. */
export const FRONTIER_REGION_LABELS: Record<FrontierRegion, string> = {
  SOLID_GROUND: 'Solid ground',
  WEAK_GROUND: 'Weak ground',
  OPEN_QUESTION: 'Open questions',
  UNEXAMINED: 'Unexamined',
  NEW_PATH: 'New paths',
};

/** Which authoritative row a reading was derived from. `ABSENCE` is a real one. */
export const FRONTIER_SOURCE_KINDS = [
  'KNOWLEDGE',
  'LAYER',
  'AUDIT_GAP',
  'CANDIDATE',
  'CONTRADICTION',
  'ABSENCE',
] as const;
export type FrontierSourceKind = (typeof FRONTIER_SOURCE_KINDS)[number];

export interface RussellFrontierItem {
  id: string;
  projectId: string;
  region: FrontierRegion;
  subject: string;
  detail: string | null;
  sourceKind: FrontierSourceKind;
  sourceId: string | null;
  lens: string | null;
  fingerprint: string;
  visibility: RussellVisibility;
  dismissedAt: string | null;
  dismissedByUserId: string | null;
  dismissedReason: string | null;
  resolvedAt: string | null;
  version: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface RussellFrontierRow {
  id: string;
  project_id: string;
  region: string;
  subject: string;
  detail: string | null;
  source_kind: string;
  source_id: string | null;
  lens: string | null;
  fingerprint: string;
  visibility: string;
  dismissed_at: string | null;
  dismissed_by_user_id: string | null;
  dismissed_reason: string | null;
  resolved_at: string | null;
  version: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface RussellHumanRequest {
  id: string;
  projectId: string;
  visibility: RussellVisibility;
  missionId: string | null;
  candidateId: string | null;
  conversationId: string | null;
  authorityNeeded: string;
  whyNotRussell: string;
  recommendation: string | null;
  choices: HumanRequestChoice[];
  urgency: HumanRequestUrgency;
  state: HumanRequestState;
  answeredByUserId: string | null;
  answeredChoice: string | null;
  answeredReason: string | null;
  answeredAt: string | null;
  resumeKey: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One thing a person may choose.
 *
 * `consequence` is required because a card that offers a choice without saying
 * what it causes is asking somebody to guess. An option must also have a
 * guarded server transition behind it — an action a person can press where
 * nothing happens is worse than no action at all.
 */
export interface HumanRequestChoice {
  key: string;
  label: string;
  consequence: string;
}

export interface RussellCycle {
  id: string;
  generation: number;
  cursorAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  state: CycleState;
  pauseReason: string | null;
  pausedByUserId: string | null;
  maxLaunchesPerCycle: number;
  maxFollowonsPerCycle: number;
  maxEventsPerCycle: number;
  maxRetryAgeMinutes: number;
  lastRanAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The Software Factory's own contract.
 *
 * Re-exported here so `domain/types.ts` stays the one place above the database
 * that describes a row, and kept in its own file because a type surface several
 * parallel workers need to change at once is one two of them will collide in.
 */
export * from './factory.ts';
// ---------------------------------------------------------------------------
// Step 12C — a connected site
// ---------------------------------------------------------------------------
//
// The whole contract between Brain and a site it is the intelligence behind.
// It is deliberately small: identity, provenance, a version, a bounded set of
// attributes Brain can reason about, and one command. Everything a site is
// actually *for* — its pipeline, its money, its calls — stays on the site,
// which remains the master of its own operational fields.

/**
 * The sites this Brain speaks to, matched exactly.
 *
 * A closed set in code rather than a CHECK constraint, so connecting a second
 * site is a reviewed code change rather than a schema migration. Anything not
 * in this list is refused at the door with the source system named nowhere in
 * the refusal.
 */
export const EXTERNAL_SOURCE_SYSTEMS = ['DEAL_DISPATCH'] as const;
export type ExternalSourceSystem = (typeof EXTERNAL_SOURCE_SYSTEMS)[number];

/** What kind of thing the site's record is. One per site, so far. */
export const EXTERNAL_RECORD_TYPES = ['OPPORTUNITY'] as const;
export type ExternalRecordType = (typeof EXTERNAL_RECORD_TYPES)[number];

/**
 * Why a delivery was refused, from a closed vocabulary.
 *
 * A category, never a sentence containing the payload. The detail beside it is
 * Brain's own words about the shape of the delivery — "no source version" —
 * and never the delivery itself.
 */
export const EXTERNAL_REJECTION_REASONS = [
  'MISSING_SOURCE_ID',
  'MISSING_VERSION',
  'UNPARSEABLE_VERSION',
  'MISSING_TITLE',
  'UNKNOWN_RECORD_TYPE',
  'OVERSIZED',
  'MALFORMED',
] as const;
export type ExternalRejectionReason = (typeof EXTERNAL_REJECTION_REASONS)[number];

/**
 * What a person on the site may ask Brain to do.
 *
 * One command, and it is the cheapest useful one: put this record on Brain's
 * list of things to form an opinion about. It creates an *idea*, not work — the
 * decision to spend anything on it is still Russell's, still bounded by the
 * standing authority a person granted in Russell, and still refused outright
 * when no authority exists (§24). A connector cannot create its own work, and
 * this is not a way around that.
 */
export const EXTERNAL_COMMANDS = ['RESEARCH_FURTHER'] as const;
export type ExternalCommand = (typeof EXTERNAL_COMMANDS)[number];

/**
 * What the site is told about a record, and the six answers it may get.
 *
 * These are the states the assignment asked to be distinguishable, and they are
 * derived from rows rather than asserted:
 *
 *   NOT_EVALUATED  registered here; nobody has asked Brain for anything
 *   QUEUED         asked for, and waiting its turn — the idea exists
 *   IN_PROGRESS    a mission for it is running
 *   NEEDS_PERSON   something is waiting on a human decision, and it says which
 *   COMPLETED      finished, with what was concluded
 *   FAILED         over, with the actual reason it ended
 *
 * There is no optimistic seventh. A record whose idea Brain parked because the
 * archive already answered it is `COMPLETED` with that as its reason, not
 * "in progress".
 */
export const EXTERNAL_PROJECTION_STATES = [
  'NOT_EVALUATED',
  'QUEUED',
  'IN_PROGRESS',
  'NEEDS_PERSON',
  'COMPLETED',
  'FAILED',
] as const;
export type ExternalProjectionState = (typeof EXTERNAL_PROJECTION_STATES)[number];

export interface ExternalRecordRow {
  id: string;
  project_id: string;
  source_system: string;
  source_record_type: string;
  source_record_id: string;
  source_version: string;
  source_created_at: string | null;
  source_ref: string | null;
  title: string;
  summary: string;
  attributes: string;
  provenance: string;
  content_hash: string;
  idempotency_key: string;
  candidate_id: string | null;
  commanded_at: string | null;
  commanded_command: string | null;
  commanded_by_label: string | null;
  last_synced_version: string;
  first_seen_at: string;
  updated_at: string;
}

export interface ExternalRecord {
  id: string;
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
  candidateId: string | null;
  commandedAt: string | null;
  commandedCommand: ExternalCommand | null;
  commandedByLabel: string | null;
  lastSyncedVersion: string;
  firstSeenAt: string;
  updatedAt: string;
}

export interface ExternalRecordRejectionRow {
  id: string;
  project_id: string;
  source_system: string;
  source_record_type: string;
  source_record_id: string;
  reason: string;
  detail: string;
  first_at: string;
  last_at: string;
  occurrences: number;
}

export interface ExternalRecordRejection {
  id: string;
  projectId: string;
  sourceSystem: string;
  sourceRecordType: string;
  sourceRecordId: string;
  reason: ExternalRejectionReason;
  detail: string;
  firstAt: string;
  lastAt: string;
  occurrences: number;
}

export interface StorageReadingRow {
  id: string;
  observed_at: string;
  provider: string;
  database_bytes: number | null;
  object_bytes: number | null;
  object_count: number | null;
  object_bytes_raw: number | null;
  categories: string;
}

/* ------------------------------------------------------------------------- */
/* A software change asked for in a conversation                             */
/* ------------------------------------------------------------------------- */

/**
 * PROPOSED is the only state a worker can cause, and it spends nothing.
 *
 * The two terminal states are a person's: AUTHORIZED means somebody submitted
 * and approved the objective through the existing factory path, and DECLINED
 * means they said no and the reason is kept. There is no state a model can move
 * this row into, which is what makes "a model proposes, the server decides" true
 * at this seam rather than merely intended.
 */
export const SOFTWARE_REQUEST_STATES = ['PROPOSED', 'AUTHORIZED', 'DECLINED'] as const;
export type SoftwareRequestState = (typeof SOFTWARE_REQUEST_STATES)[number];

export interface RussellSoftwareRequest {
  id: string;
  projectId: string;
  conversationId: string;
  /** The person's own message, so a card quotes what was asked. */
  messageId: string | null;
  title: string;
  objective: string;
  expectedOutcome: string;
  /** Chosen by the person at authorization, never proposed by a worker. */
  grantId: string | null;
  repositoryId: string | null;
  baseBranch: string | null;
  /** The scope it ran under, as shown before approval. */
  requestedScope: string[] | null;
  submissionKey: string;
  state: SoftwareRequestState;
  changeRequestId: string | null;
  campaignId: string | null;
  authorizedByUserId: string | null;
  declineReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RussellSoftwareRequestRow {
  id: string;
  project_id: string;
  conversation_id: string;
  message_id: string | null;
  title: string;
  objective: string;
  expected_outcome: string;
  grant_id: string | null;
  repository_id: string | null;
  base_branch: string | null;
  requested_scope: string | null;
  submission_key: string;
  state: string;
  change_request_id: string | null;
  campaign_id: string | null;
  authorized_by_user_id: string | null;
  decline_reason: string | null;
  created_at: string;
  updated_at: string;
}

/* ==========================================================================
 * Cash Mode (§30)
 *
 * The temporary operating section. Every enum here is a closed set matched
 * exactly — there is no substring matching, no "closest state" and no inferred
 * label anywhere downstream — and every money figure is integer cents.
 * ======================================================================== */

/**
 * Where a cash sprint is in its life.
 *
 * `WINDING_DOWN` and `ARCHIVED` stop exactly one thing: **new discovery**.
 * Delivery, collection, settlement, needs and every existing opportunity keep
 * their ordinary execution in all three, because a sprint ending is not a
 * customer's obligation ending.
 */
export const CASH_MODE_STATES = ['ACTIVE', 'WINDING_DOWN', 'ARCHIVED'] as const;
export type CashModeState = (typeof CASH_MODE_STATES)[number];

/**
 * The search buckets, from the plan's own table.
 *
 * Closed so a mechanism is a fact rather than free text, and deliberately
 * non-exhaustive in spirit: `OTHER` exists because the mandate is broad
 * discovery and a bucket list that refused an unlisted opening would be the
 * invented preference the plan explicitly forbids.
 */
export const CASH_MECHANISMS = [
  'EXISTING_BUYING_SIGNAL',
  'DIAGNOSTIC_OPPORTUNITY',
  'EXPLICIT_PAID_REQUEST',
  'TEMPORARY_EXPLOIT',
  'SUPPLY_DEMAND_MISMATCH',
  'PAIN_TRIGGERED_IMPLEMENTATION',
  'RESALE_OR_ASSET',
  /*
   * The second wave, added when the mandate was made explicit: maximise usable
   * cash inside a week, from any lawful shape of transaction, without bias
   * toward building a durable company.
   *
   * The five above were the plan's original table and they are all *demand you
   * can already see published*. These five are the shapes that were missing,
   * and each one is a different reason money is available rather than a
   * different industry — which is what keeps the table a list of mechanisms
   * instead of a list of niches.
   */
  'INFORMATION_ASYMMETRY',
  'PRODUCTIZED_SERVICE',
  'CAPABILITY_ARBITRAGE',
  'SUBCONTRACTED_FULFILMENT',
  'JIGSAW_COMBINATION',
  'OTHER',
] as const;
export type CashMechanism = (typeof CASH_MECHANISMS)[number];

export const CASH_OPPORTUNITY_STATES = [
  'DISCOVERED',
  'EVIDENCE_CARD',
  'READY',
  'EXECUTING',
  'DELIVERING',
  'COLLECTED',
  'DECLINED',
  'ARCHIVED',
] as const;
export type CashOpportunityState = (typeof CASH_OPPORTUNITY_STATES)[number];

/**
 * What a person should do with this piece, derived on the read path.
 *
 * Never stored. A row is not a decision: a stored label is stale the moment the
 * dependency it was waiting on settles, and two readers deriving it separately
 * is how one screen comes to disagree with another.
 *
 * The first four are **work**: something a person could act on, or something
 * genuinely held up. The last three are not, and separating them is the whole
 * correction recorded in §44 — a published price list is neither a thing to do
 * nor a thing being waited for, and calling it either put thirty-one facts
 * about other people's markets in front of somebody as their current work.
 *
 *   * `EVIDENCE_ONLY` — Brain found this and cannot yet say how we would be
 *     paid from it. It belongs with the evidence, not in a queue.
 *   * `BEING_QUALIFIED` — the capture thesis exists and Brain is establishing
 *     the rest. Brain's own work, and nobody is waiting on a person.
 *   * `ARCHIVED` — stopped or passed on, and kept.
 */
export const CASH_DISPOSITIONS = [
  'EXECUTE_NOW',
  'RUN_IN_PARALLEL',
  'WAIT_FOR_DEPENDENCY',
  'TEST_A_DECISIVE_UNKNOWN',
  'BEING_QUALIFIED',
  'EVIDENCE_ONLY',
  'ARCHIVED',
] as const;
export type CashDisposition = (typeof CASH_DISPOSITIONS)[number];

/**
 * An execution job: the first thing in Cash Mode that is somebody's.
 *
 * Discovery, evidence and the opportunity itself are shared across the whole
 * Brain. A job is where separation begins, because it is the first moment there
 * is anything private to separate — an owner, a budget, a credential, a
 * decision. `RELEASED` hands the work back without destroying the row, so a
 * reassignment keeps the history of who held it before.
 */
/* --------------------------------------------------------------------------
 * Passkeys, member slots and the links that fill them
 * ------------------------------------------------------------------------ */

/** How a registered device came to exist, so an audit can tell the cases apart. */
export const PASSKEY_ORIGINS = ['ENROLLMENT', 'ADDED_DEVICE', 'RECOVERY'] as const;
export type PasskeyOrigin = (typeof PASSKEY_ORIGINS)[number];

export interface UserPasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  algorithm: number;
  sign_count: number;
  label: string;
  origin_kind: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface UserPasskey {
  id: string;
  userId: string;
  /** The authenticator's own id, base64url. */
  credentialId: string;
  /** The COSE public key, base64url. Public, so stored as it is. */
  publicKey: string;
  algorithm: number;
  signCount: number;
  label: string;
  originKind: PasskeyOrigin;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export const ENROLLMENT_KINDS = ['ENROLLMENT', 'RECOVERY'] as const;
export type EnrollmentKind = (typeof ENROLLMENT_KINDS)[number];

export interface MemberEnrollmentRow {
  id: string;
  user_id: string;
  display_name: string;
  kind: string;
  token_prefix: string;
  token_digest: string;
  issued_by_user_id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface MemberEnrollment {
  id: string;
  /** The slot this link fills. Fixed at issue; the acceptor does not choose it. */
  userId: string;
  displayName: string;
  kind: EnrollmentKind;
  tokenPrefix: string;
  tokenDigest: string;
  issuedByUserId: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export const CASH_JOB_STATES = [
  'UNASSIGNED',
  'ASSIGNED',
  'EXECUTING',
  'DELIVERING',
  'COLLECTED',
  'RELEASED',
] as const;
export type CashJobState = (typeof CASH_JOB_STATES)[number];

/**
 * Who may read a job's working state.
 *
 * `PRIVATE` is the default in the schema rather than here, because the safe
 * answer must not be the one somebody remembers to choose.
 */
export const CASH_JOB_VISIBILITIES = ['PRIVATE', 'SHARED'] as const;
export type CashJobVisibility = (typeof CASH_JOB_VISIBILITIES)[number];

export interface CashJobRow {
  id: string;
  opportunity_id: string;
  project_id: string;
  state: string;
  owner_user_id: string | null;
  visibility: string;
  budget_cents: number | null;
  currency: string;
  note: string | null;
  assigned_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CashJob {
  id: string;
  opportunityId: string;
  projectId: string;
  state: CashJobState;
  /** Null is ordinary: a job may wait for dependencies before anybody holds it. */
  ownerUserId: string | null;
  visibility: CashJobVisibility;
  /** Null means no ceiling of its own; the grant on the root is the outer bound. */
  budgetCents: number | null;
  currency: string;
  note: string | null;
  assignedAt: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const CASH_COMMITMENT_STATES = ['HELD', 'SETTLED', 'RELEASED'] as const;
export type CashCommitmentState = (typeof CASH_COMMITMENT_STATES)[number];

export const CASH_MONEY_KINDS = [
  'CAPITAL_IN',
  'CAPITAL_OUT',
  'PIPELINE_AGREED',
  'CUSTOMER_PAYMENT',
  'SETTLEMENT',
  'REFUND',
  'COST',
  'UNPAID_COMMITMENT',
  'COMMITMENT_PAID',
  'RESERVE',
  'RESERVE_RELEASE',
] as const;
export type CashMoneyKind = (typeof CASH_MONEY_KINDS)[number];

export const CASH_NEED_STATES = ['OPEN', 'RESOLVED', 'WITHDRAWN'] as const;
export type CashNeedState = (typeof CASH_NEED_STATES)[number];

export const CASH_AUTHORITY_STATES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
export type CashAuthorityState = (typeof CASH_AUTHORITY_STATES)[number];

export interface CashModeRow {
  id: string;
  project_id: string;
  owner_user_id: string;
  objective: string;
  horizon_days: number;
  envelope_id: string;
  currency: string;
  state: string;
  activated_at: string;
  wound_down_at: string | null;
  archived_at: string | null;
  state_reason: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface CashMode {
  id: string;
  projectId: string;
  ownerUserId: string;
  objective: string;
  horizonDays: number;
  envelopeId: string;
  /**
   * The one currency this sprint is denominated in.
   *
   * Every money entry, every commitment and every derived figure is in it, and
   * an entry in another currency is refused rather than converted — Brain does
   * not choose an exchange rate. A second currency is a second sprint.
   */
  currency: string;
  state: CashModeState;
  activatedAt: string;
  woundDownAt: string | null;
  archivedAt: string | null;
  stateReason: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CashAuthorityRow {
  id: string;
  project_id: string;
  owner_user_id: string;
  name: string;
  policy_version: number;
  allowed_actions: string;
  prohibitions: string;
  max_committed_cents: number;
  max_per_action_cents: number;
  max_concurrent: number;
  currency: string;
  starts_at: string;
  expires_at: string | null;
  state: string;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  revoked_reason: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface CashAuthority {
  id: string;
  projectId: string;
  ownerUserId: string;
  name: string;
  policyVersion: number;
  allowedActions: string[];
  prohibitions: string[];
  maxCommittedCents: number;
  maxPerActionCents: number;
  maxConcurrent: number;
  currency: string;
  startsAt: string;
  expiresAt: string | null;
  state: CashAuthorityState;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokedReason: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a piece of the portfolio is in its bounded commercial validation.
 *
 * `null` is "not started", which is the state every opening is born in.
 *
 * `NEEDS_PERSON` is the fifth, and it exists because of a measured production
 * deadlock. A deep dive's mission can reach `NEEDS_HUMAN` — the packet stopped
 * at a decision only a person can make — and `settleValidations` had a branch
 * for `DONE`, for `FAILED` and for `CANCELLED` and none for that. So the
 * opening stayed `RUNNING` for ever while nothing was running, and because
 * `RUNNING` counts against `MAX_VALIDATIONS_IN_FLIGHT`, **both** of the two
 * slots in this Brain were held by parked missions: the other thirty-eight
 * openings could never be qualified and no new deep dive could ever start.
 *
 * It is not a failure and it is not terminal. The mission has its own answering
 * transition — the Needs You card §24 built — and this says, truthfully, that
 * the deep dive is waiting on a person rather than on a provider. It holds no
 * provider capacity, because no provider is working on it.
 */
export const OPPORTUNITY_VALIDATION_STATES = [
  'PENDING',
  'RUNNING',
  'NEEDS_PERSON',
  'COMPLETE',
  'BLOCKED',
] as const;
export type OpportunityValidationState = (typeof OPPORTUNITY_VALIDATION_STATES)[number];

export interface CashOpportunityRow {
  id: string;
  project_id: string;
  cash_mode_id: string;
  owner_user_id: string;
  title: string;
  mechanism: string;
  industry: string | null;
  source: string | null;
  candidate_id: string | null;
  external_record_id: string | null;
  source_claim_id: string | null;
  discovered_by_candidate_id: string | null;
  orchestration_id: string | null;
  fragment_id: string | null;
  discovery_round_id: string | null;
  validation_orchestration_id: string | null;
  validation_state: string | null;
  validation_started_at: string | null;
  validation_settled_at: string | null;
  /** How many bounded deep dives this piece has had. Null reads as one. */
  validation_rounds: number | null;
  /**
   * What kind of opening the claim behind this established, kept on the piece.
   *
   * `mechanism` is derived from it and is lossy — two signals share one
   * mechanism — and it is the *signal* that decides what this evidence proves
   * and what it does not. See `services/cash/tier.ts`. Null for a piece
   * captured by hand and for anything promoted before the column existed;
   * `reconcileOpportunitySignals` fills the second case from the source claim.
   */
  opportunity_signal: string | null;
  /**
   * The industry node whose scan opened this, where one did.
   *
   * Null for the pieces that predate the axis and for anything a person
   * entered by hand, which is honest rather than a gap: nothing said which
   * industry it was in, and deriving one from the title would be a guess
   * wearing a foreign key.
   */
  industry_node_id: string | null;
  payer: string | null;
  reachable_channel: string | null;
  buying_signal: string | null;
  signal_observed_at: string | null;
  offer_scope: string | null;
  acceptance_condition: string | null;
  price_cents: number | null;
  currency: string;
  payment_terms: string | null;
  fulfillment_owner: string | null;
  delivery_method: string | null;
  required_inputs: string | null;
  deadline: string | null;
  economics_note: string | null;
  peak_funding_cents: number | null;
  human_hours: number | null;
  expires_at: string | null;
  expiry_reason: string | null;
  depends_on_id: string | null;
  duplicate_of_id: string | null;
  required_capabilities: string;
  execution_asset: string | null;
  asset_revision: string | null;
  state: string;
  exhausted_at: string | null;
  exhausted_reason: string | null;
  next_action: string | null;
  next_action_due: string | null;
  outcome: string | null;
  stop_rule: string | null;
  declined_by_user_id: string | null;
  declined_reason: string | null;
  reoffered_from_id: string | null;
  archived_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CashOpportunity {
  id: string;
  projectId: string;
  cashModeId: string;
  ownerUserId: string;
  title: string;
  mechanism: CashMechanism;
  industry: string | null;
  source: string | null;
  candidateId: string | null;
  externalRecordId: string | null;
  /**
   * The accepted research claim this opportunity was harvested from.
   *
   * Present only for one Brain found rather than one a person entered, and it
   * is the provenance: the claim carries the source URL, the publisher and the
   * date, so "why does Brain think there is an opening here" resolves to a
   * passage rather than to a summary.
   */
  sourceClaimId: string | null;
  /**
   * The discovery bucket whose mission found it, which is a different fact from
   * `candidateId`.
   *
   * `candidateId` is the idea this opportunity *is* — what a person captured,
   * or what Brain is researching on this opportunity's own behalf. A bucket is
   * a broad question that found dozens of unrelated openings, and it is never
   * research about any one of them. The wind-down guard reads the difference.
   */
  discoveredByCandidateId: string | null;
  /**
   * The packet, the fragment and the round this came out of.
   *
   * Written at promotion. `sourceClaimId` alone resolves to a claim and leaves
   * "what research established this, under which question, in which round" to
   * be walked backwards through a mission row — which four production packets
   * started by an administrator simply do not have, and which made their 69
   * accepted claims unreachable. A round of null is honest rather than a gap:
   * nobody asked a bucket for it.
   */
  orchestrationId: string | null;
  fragmentId: string | null;
  discoveryRoundId: string | null;
  /**
   * The bounded deep dive that turns an opening into a decision, and where it is.
   *
   * Discovery answers "somebody published a request". It does not answer who
   * pays, what to offer, what it costs or when the cash arrives — and forcing a
   * broad discovery fragment to answer all of that before it may report an
   * opening is what made those fragments impossible to satisfy. So the
   * commercial questions are a *second*, bounded assignment against this piece,
   * and these say which one and how it went.
   */
  validationOrchestrationId: string | null;
  validationState: OpportunityValidationState | null;
  validationStartedAt: string | null;
  validationSettledAt: string | null;
  /** How many bounded deep dives this piece has had. One after the first. */
  validationRounds: number;
  /** What kind of opening its evidence establishes, or null where nothing said. */
  opportunitySignal: OpportunitySignal | null;
  /** The industry node whose scan opened it, or null where nothing said. */
  industryNodeId: string | null;
  payer: string | null;
  reachableChannel: string | null;
  buyingSignal: string | null;
  signalObservedAt: string | null;
  offerScope: string | null;
  acceptanceCondition: string | null;
  priceCents: number | null;
  currency: string;
  paymentTerms: string | null;
  fulfillmentOwner: string | null;
  deliveryMethod: string | null;
  requiredInputs: string | null;
  deadline: string | null;
  economicsNote: string | null;
  peakFundingCents: number | null;
  humanHours: number | null;
  expiresAt: string | null;
  expiryReason: string | null;
  dependsOnId: string | null;
  duplicateOfId: string | null;
  requiredCapabilities: string[];
  executionAsset: string | null;
  assetRevision: string | null;
  state: CashOpportunityState;
  exhaustedAt: string | null;
  exhaustedReason: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  outcome: string | null;
  stopRule: string | null;
  declinedByUserId: string | null;
  declinedReason: string | null;
  reofferedFromId: string | null;
  archivedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CashCommitmentRow {
  id: string;
  authority_id: string;
  project_id: string;
  opportunity_id: string | null;
  amount_cents: number;
  currency: string;
  purpose: string;
  expected_result: string;
  stop_condition: string;
  idempotency_key: string;
  payload_fingerprint: string | null;
  state: string;
  spent_cents: number | null;
  settled_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CashCommitment {
  id: string;
  authorityId: string;
  projectId: string;
  opportunityId: string | null;
  amountCents: number;
  currency: string;
  purpose: string;
  expectedResult: string;
  stopCondition: string;
  idempotencyKey: string;
  state: CashCommitmentState;
  /**
   * How much of the hold was actually spent, once it settled.
   *
   * Null while held. A settlement writes the matching cost for exactly this
   * amount and lets the remainder stop being held, so a partial spend is
   * neither rounded up to the whole commitment nor silently lost.
   */
  spentCents: number | null;
  settledAt: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CashMoneyEntryRow {
  id: string;
  project_id: string;
  opportunity_id: string | null;
  commitment_id: string | null;
  idempotency_key: string | null;
  payload_fingerprint: string | null;
  kind: string;
  amount_cents: number;
  currency: string;
  verified_reference: string | null;
  funds_available_at: string | null;
  occurred_at: string;
  note: string | null;
  recorded_by: string;
  created_at: string;
}

export interface CashMoneyEntry {
  id: string;
  projectId: string;
  opportunityId: string | null;
  /** The commitment this entry settles, when Brain derived it from one. */
  commitmentId: string | null;
  idempotencyKey: string | null;
  payloadFingerprint: string | null;
  kind: CashMoneyKind;
  amountCents: number;
  currency: string;
  verifiedReference: string | null;
  fundsAvailableAt: string | null;
  occurredAt: string;
  note: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface CashNeedRow {
  id: string;
  project_id: string;
  opportunity_id: string | null;
  blocked_action: string;
  why_it_matters: string;
  recommended_path: string;
  expected_cost_cents: number | null;
  setup_effort: string;
  next_step: string;
  completion_condition: string | null;
  occurrence: number;
  verified_by: string | null;
  continuation_claimed_at: string | null;
  continuation_attempts: number;
  continuation_not_before: string | null;
  blocks_state: string | null;
  candidate_id: string | null;
  request_key: string | null;
  continued_at: string | null;
  continuation_note: string | null;
  state: string;
  resolution: string | null;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CashNeed {
  id: string;
  projectId: string;
  opportunityId: string | null;
  blockedAction: string;
  whyItMatters: string;
  recommendedPath: string;
  expectedCostCents: number | null;
  setupEffort: string;
  nextStep: string;
  /**
   * What settles it, in a form somebody can check.
   *
   * Null only on a need raised before Brain asked for one. Backfilling it from
   * `nextStep` would assert a condition nobody wrote, so what an old row says
   * is that it has none.
   */
  completionCondition: string | null;
  /**
   * Which return of this blockage this is.
   *
   * A capability that goes missing again is a new occurrence rather than the
   * old row reopened, because the old row's resolution was true when it was
   * written and rewriting it would make the history say something else.
   */
  occurrence: number;
  /**
   * How the completion condition was established, or null while it is open.
   *
   * `BRAIN_READ_THE_ROW` means Brain checked and the condition holds.
   * `PERSON_SUBSTITUTE` means it does not and somebody authorized a manual way
   * round it, which is a different fact and must not read as the first.
   */
  verifiedBy: 'BRAIN_READ_THE_ROW' | 'PERSON_SUBSTITUTE' | null;
  /** When a continuation took its lease. Reclaimable once it goes stale. */
  continuationClaimedAt: string | null;
  continuationAttempts: number;
  /** Not retried before this, after a temporary refusal. */
  continuationNotBefore: string | null;
  /**
   * The opportunity transition waiting on it, when one is.
   *
   * A state rather than a free reference, because that is what a continuation
   * can actually retry — one that had to read prose to know what to resume
   * would be model output deciding a transition.
   */
  blocksState: CashOpportunityState | null;
  /** The idea Brain started because of this need, when it could start one. */
  candidateId: string | null;
  /** What made it unique, so the same condition raises one need. */
  requestKey: string | null;
  /** When its continuation ran. Set once, by a guarded write. */
  continuedAt: string | null;
  /** What the continuation actually did, which is not the same as that it ran. */
  continuationNote: string | null;
  state: CashNeedState;
  resolution: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Who actually did it. There is no third value — see migration 055. */
export const CASH_ACTION_PERFORMERS = ['BRAIN', 'PERSON'] as const;
export type CashActionPerformer = (typeof CASH_ACTION_PERFORMERS)[number];

export interface CashActionRow {
  id: string;
  project_id: string;
  opportunity_id: string;
  authority_id: string;
  action: string;
  performed_by: string;
  reference: string | null;
  detail: string;
  confirmed_by: string;
  request_key: string;
  created_at: string;
}

/**
 * One commercial action that actually happened.
 *
 * An opportunity is EXECUTING because one of these exists, never because a
 * transition was requested. Append-only: what happened is history.
 */
export interface CashAction {
  id: string;
  projectId: string;
  opportunityId: string;
  /** The grant it ran under, read when it was recorded rather than assumed. */
  authorityId: string;
  /**
   * One of `COMMERCIAL_ACTIONS`, checked by `services/cash/authority.ts`.
   *
   * A string here for the same reason `allowedActions` is: the vocabulary is
   * the service's, and a domain type that imported it would invert the
   * dependency to make one field narrower.
   */
  action: string;
  performedBy: CashActionPerformer;
  /**
   * Whatever identifies it outside Brain.
   *
   * Free text because Brain cannot verify any of them, and a structured column
   * would imply it had.
   */
  reference: string | null;
  detail: string;
  confirmedBy: string;
  requestKey: string;
  createdAt: string;
}

export interface CashCardFactRow {
  id: string;
  project_id: string;
  opportunity_id: string;
  field: string;
  kind: string;
  value: string;
  claim_id: string | null;
  need_id: string | null;
  basis: string | null;
  assumptions: string | null;
  uncertainty: string | null;
  decided_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * One answer on an evidence card, and what kind of answer it is.
 *
 * The kind is the load-bearing part. A card that rendered Brain's proposal the
 * same way it renders a published source would have told somebody a guess was
 * checked, which is the one thing this whole section may not do.
 */
export interface CashCardFact {
  id: string;
  projectId: string;
  opportunityId: string;
  field: string;
  /**
   * `EVIDENCE` resolves to a claim and therefore to a source, a publisher and a
   * date. `RECOMMENDATION` is Brain's own proposal and carries its basis, its
   * assumptions and what would change it. `PERSON` is somebody's decision and
   * nothing automatic replaces one.
   */
  kind: 'EVIDENCE' | 'RECOMMENDATION' | 'PERSON';
  value: string;
  claimId: string | null;
  needId: string | null;
  basis: string | null;
  assumptions: string | null;
  uncertainty: string | null;
  decidedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CashDiscoveryRoundRow {
  id: string;
  project_id: string;
  cash_mode_id: string;
  bucket_id: string;
  mechanism: string;
  round: number;
  candidate_id: string;
  state: string;
  opened_at: string;
  harvested_at: string | null;
  found: number;
  created_at: string;
  updated_at: string;
}

/**
 * One asking of one discovery bucket.
 *
 * The durable answer to three questions the activity feed was being asked and
 * could not keep answering: which buckets have run, which Russell idea asked
 * each one, and whether a given candidate is discovery work at all.
 */
export interface CashDiscoveryRound {
  id: string;
  projectId: string;
  cashModeId: string;
  bucketId: string;
  mechanism: string;
  /** Which asking this is. A bucket may be re-asked; each time is its own row. */
  round: number;
  candidateId: string;
  state: 'OPEN' | 'HARVESTED' | 'ABANDONED';
  openedAt: string;
  harvestedAt: string | null;
  /** How many openings it produced. Zero is a finding about where Brain looked. */
  found: number;
  createdAt: string;
  updatedAt: string;
}

export interface CashEventRow {
  id: string;
  project_id: string;
  opportunity_id: string | null;
  kind: string;
  actor_ref: string;
  summary: string;
  detail: string;
  created_at: string;
}

export interface CashEvent {
  id: string;
  projectId: string;
  opportunityId: string | null;
  kind: string;
  actorRef: string;
  summary: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// SHARED FINDINGS
//
// One Brain, four private operations, and one pool of validated findings
// between them. The row is a promotion record — pointers and state — and holds
// no statement, no source and no passage, because `research_claims` already
// holds all three and a copy is a second place for the truth to live.
// ---------------------------------------------------------------------------

export type SharedFindingState = 'ACTIVE' | 'REVOKED';

export interface SharedFindingRow {
  id: string;
  claim_id: string;
  origin_project_id: string;
  origin_orchestration_id: string;
  origin_fragment_id: string | null;
  origin_layer_id: string | null;
  origin_worker_id: string | null;
  origin_session_ref: string | null;
  rule_version: string;
  state: string;
  valid_until: string | null;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  revoked_reason: string | null;
  promoted_at: string;
  created_at: string;
  updated_at: string;
}

export interface SharedFinding {
  id: string;
  claimId: string;
  originProjectId: string;
  originOrchestrationId: string;
  originFragmentId: string | null;
  originLayerId: string | null;
  originWorkerId: string | null;
  originSessionRef: string | null;
  ruleVersion: string;
  state: SharedFindingState;
  validUntil: string | null;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokedReason: string | null;
  promotedAt: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// CONNECTING A CLAUDE ACCOUNT
//
// A member contributing a Routine does six things in Claude; Brain does three;
// and one of Brain's three is a privileged operation Brain structurally cannot
// perform. `resolveToken` reads `process.env[secretName]`, and nothing in this
// repository can write a deployment secret — so the trigger's bearer reaches
// the environment and never the database, and the journey has to survive being
// half-finished for as long as the administrator takes.
//
// So it is rows. Every state below is one somebody can be *in* rather than a
// message about a failure, and each names either the next thing its owner can
// do or the one thing they are waiting for.
// ---------------------------------------------------------------------------

export const CAPACITY_CONNECTION_STATES = [
  'NOT_STARTED',
  /**
   * The member asked for their one-time connector link.
   *
   * It exists because the link is a Brain administrator's to issue — it mints a
   * worker identity and grants it a project membership — and a member who could
   * not *ask* for one was reading "add a custom connector in Claude" as their
   * next step and being refused at a consent screen. An escalation with no
   * answering transition is stuck rather than waiting; this is the transition.
   */
  'INVITATION_REQUESTED',
  'CONNECTOR_AUTHORIZED',
  'ROUTINE_DETAILS_NEEDED',
  'WAITING_FOR_ADMIN',
  'CONFIGURED',
  'PROBE_SENT',
  'ARRIVED',
  'HEALTHY',
  /**
   * The registered Routine is not the one this row names, or is bound to
   * another worker.
   *
   * Derived on the read path and **never acted on**. Brain firing a surface its
   * own record does not name is what §27 records at length, so it has to have a
   * word; repointing it is `fleet repoint-worker`, an operator's decision,
   * because the Routine in question may well be somebody else's.
   */
  'MISBOUND',
  /**
   * Given back. The tokens are revoked and the surface is not fired.
   *
   * Reversible by its owner: `reconnect` puts the journey back at the start
   * with the trigger, the account and the Routine intact, and the reason this
   * one was revoked stays on the row as history.
   */
  'REVOKED',
  'FAILED',
] as const;
export type CapacityConnectionState = (typeof CAPACITY_CONNECTION_STATES)[number];

export interface CapacityConnectionRow {
  id: string;
  user_id: string;
  connector_name: string;
  routine_name: string;
  secret_name: string;
  trigger_ref: string | null;
  account_id: string | null;
  routine_id: string | null;
  worker_id: string | null;
  state: string;
  failure_reason: string | null;
  probe_bin_id: string | null;
  probe_sent_at: string | null;
  healthy_at: string | null;
  invitation_requested_at: string | null;
  invitation_issued_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  revoked_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CapacityConnection {
  id: string;
  userId: string;
  /** The three names Brain assigned. Nobody invents one and no two collide. */
  connectorName: string;
  routineName: string;
  secretName: string;
  /** The trig_… id the member read out of Claude. Never a credential. */
  triggerRef: string | null;
  accountId: string | null;
  routineId: string | null;
  /**
   * The worker this connection's Claude account authenticates as.
   *
   * Written when Brain mints the worker, and by `adoptSurface` when a person
   * says an already-registered surface is theirs. Null means *we have not been
   * told*, and the screen falls back to resolving a worker by the name it
   * would have minted — which is what made the owner of this Brain read as
   * disconnected while their surfaces fired 350 times. See migration 085.
   */
  workerId: string | null;
  state: CapacityConnectionState;
  failureReason: string | null;
  probeBinId: string | null;
  probeSentAt: string | null;
  /** When Brain last read the four-row chain and found it complete. */
  healthyAt: string | null;
  /** When the member asked for their connector link, and when one was issued. */
  invitationRequestedAt: string | null;
  invitationIssuedAt: string | null;
  /** Why it was given back, and by whom. Kept through a reconnect, as history. */
  revokedAt: string | null;
  revokedReason: string | null;
  revokedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Research Intelligence (migration 076 / pg 067)
// ---------------------------------------------------------------------------
//
// The judgement layer above the research engine. None of these types carries
// evidence, scope or ordering that another table already owns: the boundary
// contract still says what the research is bounded by, `research_claims` still
// says what was established, and `research_fragments.depends_on` still says what
// runs before what. These say what the work is *for*, what is still unknown that
// matters, and what a finding changed about the plan.

/** How much rides on being right. Feeds depth; never feeds a gate. */
export const RESEARCH_STAKES = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'] as const;
export type ResearchStakes = (typeof RESEARCH_STAKES)[number];

/** What acting on a wrong answer would cost. */
export const RESEARCH_REVERSIBILITY = ['REVERSIBLE', 'COSTLY', 'IRREVERSIBLE'] as const;
export type ResearchReversibility = (typeof RESEARCH_REVERSIBILITY)[number];

export const PROBLEM_MODEL_SOURCES = [
  'COMPILED',
  'CONTRACT',
  'ASSIGNMENT',
  'PROPOSAL',
  'PERSON',
] as const;
export type ProblemModelSource = (typeof PROBLEM_MODEL_SOURCES)[number];

/**
 * A constraint or a preference, with the reason it exists.
 *
 * The reason is what lets Brain later ask whether it still applies. A
 * constraint recorded without one can only ever be obeyed literally, for ever,
 * which is how a temporary choice becomes policy.
 */
export interface StatedConstraint {
  statement: string;
  reason: string | null;
}

/**
 * An example the person gave, and the property it was an example of.
 *
 * `property` is the whole reason this is not a list of strings. Three named
 * industries are an illustration of *a kind of buyer*; stored without that,
 * the only safe reading is a whitelist, and search never looks beyond them.
 */
export interface StatedExample {
  statement: string;
  property: string | null;
}

export interface ResearchProblemModelRow {
  id: string;
  orchestration_id: string;
  project_id: string;
  boundary_contract_id: string | null;
  version: number;
  outcome_sought: string;
  decision_supported: string | null;
  why_it_matters: string | null;
  stakes: string;
  reversibility: string;
  consequence_if_wrong: string | null;
  time_horizon: string | null;
  success_criteria: string;
  constraints: string;
  preferences: string;
  examples: string;
  assumptions: string;
  non_goals: string;
  useless_if: string;
  authority_granted: string;
  derived_from: string;
  rationale: string | null;
  revised_from_version: number | null;
  revision_reason: string | null;
  created_at: string;
}

export interface ResearchProblemModel {
  id: string;
  orchestrationId: string;
  projectId: string;
  boundaryContractId: string | null;
  version: number;
  outcomeSought: string;
  decisionSupported: string | null;
  whyItMatters: string | null;
  stakes: ResearchStakes;
  reversibility: ResearchReversibility;
  consequenceIfWrong: string | null;
  timeHorizon: string | null;
  successCriteria: string[];
  constraints: StatedConstraint[];
  preferences: StatedConstraint[];
  examples: StatedExample[];
  assumptions: string[];
  nonGoals: string[];
  uselessIf: string[];
  authorityGranted: string[];
  derivedFrom: ProblemModelSource;
  rationale: string | null;
  revisedFromVersion: number | null;
  revisionReason: string | null;
  createdAt: string;
}

export const UNCERTAINTY_CONSUMERS = [
  'DECISION',
  'CONCLUSION',
  'CALCULATION',
  'FRAGMENT',
  'REQUIREMENT',
] as const;
export type UncertaintyConsumer = (typeof UNCERTAINTY_CONSUMERS)[number];

export const BELIEF_BASES = ['UNKNOWN', 'ASSUMED', 'ARCHIVE', 'EVIDENCE', 'PERSON'] as const;
export type BeliefBasis = (typeof BELIEF_BASES)[number];

export const CHANGE_RATES = ['STABLE', 'SLOW', 'VOLATILE'] as const;
export type ChangeRate = (typeof CHANGE_RATES)[number];

/**
 * Where an uncertainty stands.
 *
 * `RETIRED` is the one worth naming: it means the question is still open and no
 * longer *bears on the decision*, which is a completely different fact from
 * `UNRESOLVABLE` and leads to a different sentence in the report.
 */
export const UNCERTAINTY_DISPOSITIONS = [
  'OPEN',
  'INVESTIGATING',
  'RESOLVED',
  'REFUTED',
  'UNRESOLVABLE',
  'RETIRED',
  'DEFERRED',
  'PERSON_ONLY',
] as const;
export type UncertaintyDisposition = (typeof UNCERTAINTY_DISPOSITIONS)[number];

/**
 * How much looking a question deserves.
 *
 * Three rungs rather than a number, because a number invites arithmetic nobody
 * justified. `SINGLE_PRIMARY` is a statutory or documentary fact one directly
 * inspected source settles; `CORROBORATED` is the ordinary bar;
 * `CONTESTED_DEEP` is what a consequential question with conflicting sources
 * earns. `standards.ts` still decides the bar per *claim* — this decides how
 * hard to look before stopping.
 */
export const RESEARCH_DEPTHS = ['SINGLE_PRIMARY', 'CORROBORATED', 'CONTESTED_DEEP'] as const;
export type ResearchDepth = (typeof RESEARCH_DEPTHS)[number];

export const UNCERTAINTY_ORIGINS = [
  'PLAN',
  'FINDING',
  'CONTRADICTION',
  'COVERAGE_GAP',
  'ARCHIVE',
  'PERSON',
] as const;
export type UncertaintyOrigin = (typeof UNCERTAINTY_ORIGINS)[number];

export interface ResearchUncertaintyRow {
  id: string;
  orchestration_id: string;
  project_id: string;
  problem_model_id: string | null;
  uncertainty_key: string;
  question: string;
  why_it_matters: string;
  consumer_kind: string;
  consumer_ref: string | null;
  current_belief: string | null;
  belief_basis: string;
  consequence: string;
  reversibility: string;
  change_rate: string;
  uncertainty_level: number;
  invalidating: number;
  stopping_condition: string;
  disposition: string;
  disposition_reason: string | null;
  resolved_by_fragment_id: string | null;
  resolved_at: string | null;
  depth: string;
  depth_basis: string | null;
  origin: string;
  origin_ref: string | null;
  plan_version: number;
  created_at: string;
  updated_at: string;
}

// THE MANUFACTURING EMPIRE KERNEL
//
// A second graph beside the industry map, answering a question containment
// cannot hold: which machine to build next, and what building it makes
// possible. See `domain/manufacturing.ts` for what each finding creates and
// `docs/MANUFACTURING-KERNEL.md` for why a capability a product teaches is
// never a capability this company holds.
// ---------------------------------------------------------------------------

/**
 * What a source can establish about building a machine.
 *
 * Nine kinds, and the split between them is what makes the brief's core
 * principle enforceable: two of them say somebody is buying and there is a
 * route to them, two say what building takes and what it teaches, and the rest
 * are what stands in the way. A category is enterable only when the first two
 * are established, which is *demand pulling manufacturing* expressed as rows
 * rather than as a sentence in a prompt.
 */
export const CAPABILITY_FINDINGS = [
  /** A narrower or more specific class of machine inside the subject. */
  'PRODUCT_CATEGORY',
  /** A class of machine the sources name as reached sideways from this one. */
  'ADJACENT_CATEGORY',
  /** Producing in this category requires this capability, per the source. */
  'CAPABILITY_REQUIRED',
  /** Producing in this category develops this capability, per the source. */
  'CAPABILITY_TAUGHT',
  /** Published evidence that buyers in this category are actually buying. */
  'DEMAND_EVIDENCE',
  /** A route by which product in this category actually reaches a buyer. */
  'DISTRIBUTION_CHANNEL',
  /** A documented failure, gap or unmet need in what incumbents supply. */
  'INCUMBENT_WEAKNESS',
  /** Something that must be obtained, certified or built before entering. */
  'ENTRY_BARRIER',
  /** A component or subsystem producers in this category buy rather than make. */
  'BOUGHT_IN_COMPONENT',
  /**
   * A published figure for one thing entering this category costs.
   *
   * The directive names required capital as the first item under ENTRY, and it
   * is the one entry fact the other eight cannot carry: a barrier is a *thing
   * to obtain* and this is an *amount*, with a range, a currency, a date, a
   * shape of business it is about and a kind of figure it is.
   */
  'CAPITAL_REQUIREMENT',
  /**
   * A firm a source names, and what buying it would contribute.
   *
   * Identifying one is research. Approaching, valuing, offering, committing to
   * or buying one is not, is separately authorized, and no route in this kernel
   * reaches any of them.
   */
  'ACQUISITION_CANDIDATE',
] as const;
export type CapabilityFinding = (typeof CAPABILITY_FINDINGS)[number];

/**
 * What kind of demand signal a source published.
 *
 * Closed, because "demand exists" asserted in prose is exactly the claim the
 * brief refuses — it wants the observation, and each of these names an
 * observation somebody published rather than an impression somebody formed.
 */
export const DEMAND_SIGNAL_KINDS = [
  'UNIT_SHIPMENTS',
  'REGISTRATIONS',
  'FLEET_PURCHASE',
  'TENDER_OR_CONTRACT',
  'REPLACEMENT_CYCLE',
  'PRICE_REALIZED',
  'BACKLOG_OR_LEAD_TIME',
  'INSTALLED_BASE',
] as const;
export type DemandSignalKind = (typeof DEMAND_SIGNAL_KINDS)[number];

/** How product in a category actually reaches whoever pays for it. */
export const DISTRIBUTION_CHANNEL_KINDS = [
  'DEALER_NETWORK',
  'DISTRIBUTOR',
  'DIRECT_TO_BUYER',
  'FLEET_OR_CONTRACT_SALE',
  'RETAIL',
  'MARKETPLACE',
  'RENTAL_FLEET',
  'OEM_SUPPLY',
  'AFTERMARKET_AND_PARTS',
  'SERVICE_NETWORK',
] as const;
export type DistributionChannelKind = (typeof DISTRIBUTION_CHANNEL_KINDS)[number];

/**
 * Where what is on the market today is documented to fall short.
 *
 * The brief's step 5 — *determine where existing manufacturers are weak* — and
 * every value is something a source records rather than something a reader
 * concludes. There is deliberately no `GENERALLY_POOR` or `EXPENSIVE`, so an
 * impression has nowhere to go.
 */
export const INCUMBENT_WEAKNESS_KINDS = [
  'FAILURE_MODE',
  'RECALL_OR_SAFETY_ACTION',
  'SERVICE_COVERAGE_GAP',
  'PARTS_AVAILABILITY',
  'LEAD_TIME',
  'PRICE_GAP',
  'UNMET_REQUIREMENT',
  'SUPPORT_QUALITY',
  'DURABILITY_IN_SERVICE',
] as const;
export type IncumbentWeaknessKind = (typeof INCUMBENT_WEAKNESS_KINDS)[number];

/**
 * What stands between this company and producing in a category.
 *
 * Kept apart from `CAPITAL_REQUIREMENTS`, which answers *what needs owner
 * money*. These answer *what needs to exist at all* — a certification nobody
 * can buy their way past is not a capital requirement, and filing it as one
 * would make an unreachable category look like an expensive one.
 */
export const ENTRY_BARRIER_KINDS = [
  'TYPE_APPROVAL_OR_HOMOLOGATION',
  'SAFETY_CERTIFICATION',
  'EMISSIONS_COMPLIANCE',
  'AIRWORTHINESS_CERTIFICATION',
  'PRODUCTION_LICENCE',
  'TOOLING_LEAD_TIME',
  'MINIMUM_PRODUCTION_SCALE',
  'SUPPLIER_QUALIFICATION',
  'DEALER_OR_SERVICE_REQUIREMENT',
  'INTELLECTUAL_PROPERTY',
  'TEST_FACILITY',
  'SKILLED_LABOUR_AVAILABILITY',
] as const;
export type EntryBarrierKind = (typeof ENTRY_BARRIER_KINDS)[number];

export const MACHINE_CATEGORY_KINDS = ['PRODUCT_CATEGORY', 'ADJACENT_CATEGORY'] as const;
export type MachineCategoryKind = (typeof MACHINE_CATEGORY_KINDS)[number];

export const MACHINE_CATEGORY_ORIGINS = ['SEED', 'BOOTSTRAP', 'DISCOVERED'] as const;
export type MachineCategoryOrigin = (typeof MACHINE_CATEGORY_ORIGINS)[number];

/**
 * How Brain came to record that this company holds a capability.
 *
 * One value, because today there is exactly one thing that could establish it:
 * a person with ADMIN on the project saying so. Nothing in this Brain can
 * observe that a company built a machine — Cash Mode delivers services and the
 * Software Factory delivers code, and neither is evidence of that — so a
 * derived second value would be a mechanism nothing calls, wearing an enum.
 *
 * There is deliberately no `RESEARCHED`, and there never will be. A source
 * establishing that ATV production develops chassis engineering is a fact about
 * ATVs; it is not evidence about this company, and a value here is the only way
 * the two could ever be confused.
 */
export const CAPABILITY_HELD_EVIDENCE = ['DECLARED'] as const;
export type CapabilityHeldEvidence = (typeof CAPABILITY_HELD_EVIDENCE)[number];

export const CAPABILITY_RELATIONS = ['REQUIRES', 'TEACHES'] as const;
export type CapabilityRelation = (typeof CAPABILITY_RELATIONS)[number];

export const CATEGORY_EVIDENCE_KINDS = [
  'DEMAND_EVIDENCE',
  'DISTRIBUTION_CHANNEL',
  'INCUMBENT_WEAKNESS',
  'ENTRY_BARRIER',
  'BOUGHT_IN_COMPONENT',
] as const;
export type CategoryEvidenceKind = (typeof CATEGORY_EVIDENCE_KINDS)[number];

export const MANUFACTURING_ROUND_PURPOSES = [
  'BOOTSTRAP',
  'MAP',
  'DEMAND',
  'CAPABILITY',
  'INTEGRATION',
  /** What entering costs, requirement by requirement, from published figures. */
  'CAPITAL',
  /** Who could be bought instead of built, and what that would contribute. */
  'ACQUISITION',
] as const;
export type ManufacturingRoundPurpose = (typeof MANUFACTURING_ROUND_PURPOSES)[number];

export const MANUFACTURING_PROGRAM_STATES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type ManufacturingProgramState = (typeof MANUFACTURING_PROGRAM_STATES)[number];

export interface ManufacturingProgramRow {
  id: string;
  project_id: string;
  objective: string;
  state: string;
  blueprint_path: string | null;
  blueprint_sha256: string | null;
  owner_user_id: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface ResearchUncertainty {
  id: string;
  orchestrationId: string;
  projectId: string;
  problemModelId: string | null;
  uncertaintyKey: string;
  question: string;
  whyItMatters: string;
  consumerKind: UncertaintyConsumer;
  consumerRef: string | null;
  currentBelief: string | null;
  beliefBasis: BeliefBasis;
  consequence: ResearchStakes;
  reversibility: ResearchReversibility;
  changeRate: ChangeRate;
  uncertaintyLevel: number;
  /** Could a bad answer here make the whole path pointless? */
  invalidating: boolean;
  stoppingCondition: string;
  disposition: UncertaintyDisposition;
  dispositionReason: string | null;
  resolvedByFragmentId: string | null;
  resolvedAt: string | null;
  depth: ResearchDepth;
  depthBasis: string | null;
  origin: UncertaintyOrigin;
  originRef: string | null;
  planVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ManufacturingProgram {
  id: string;
  projectId: string;
  objective: string;
  state: ManufacturingProgramState;
  /**
   * The directive this programme runs under, and the sha-256 of its bytes.
   *
   * Both written by the server from the file it opened. A hash is integrity and
   * never use: what makes the directive *operative* is
   * `services/manufacturing/directive.ts` carrying its contents into the
   * questions, and a test fails if that stops happening while these keep being
   * written.
   */
  blueprintPath: string | null;
  blueprintSha256: string | null;
  ownerUserId: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How one uncertainty bears on another.
 *
 * Distinct from `FragmentDependency`, which is about execution order. These are
 * about reasoning, and the difference decides what a failure costs:
 * a HARD_PREREQUISITE failing strands its dependent, an EVIDENTIARY one failing
 * costs nothing, and a COMPARATIVE one failing makes its sibling *more*
 * decisive rather than less.
 */
export const UNCERTAINTY_LINK_KINDS = [
  'HARD_PREREQUISITE',
  'CONDITIONAL',
  'EVIDENTIARY',
  'COMPARATIVE',
  'FOLLOW_UP',
  'CHALLENGES',
] as const;
export type UncertaintyLinkKind = (typeof UNCERTAINTY_LINK_KINDS)[number];

export interface ResearchUncertaintyLinkRow {
  id: string;
  orchestration_id: string;
  from_key: string;
  to_key: string;
  kind: string;
  reason: string | null;
  created_at: string;
}

export interface ResearchUncertaintyLink {
  id: string;
  orchestrationId: string;
  fromKey: string;
  toKey: string;
  kind: UncertaintyLinkKind;
  reason: string | null;
  createdAt: string;
}

export const PLAN_REVISION_REASONS = [
  'INITIAL_PLAN',
  'EVIDENCE_ARRIVED',
  'CONTRADICTION',
  'BRANCH_RETIRED',
  'COVERAGE_GAP',
  'SUFFICIENCY',
  'PERSON',
] as const;
export type PlanRevisionReason = (typeof PLAN_REVISION_REASONS)[number];

export interface ResearchPlanRevisionRow {
  id: string;
  orchestration_id: string;
  project_id: string;
  version: number;
  reason: string;
  summary: string;
  decisions: string;
  applied: string;
  actor_kind: string;
  actor_ref: string | null;
  created_at: string;
}

export interface ResearchPlanRevision {
  id: string;
  orchestrationId: string;
  projectId: string;
  version: number;
  reason: PlanRevisionReason;
  summary: string;
  /** Everything the director proposed, refusals included. */
  decisions: unknown[];
  /** What the deterministic layer actually let through. */
  applied: unknown[];
  actorKind: 'BRAIN' | 'PERSON' | 'WORKER';
  actorRef: string | null;
  createdAt: string;
}

export const RETROSPECTIVE_SCOPES = ['CAMPAIGN_CLOSED', 'OUTCOME_OBSERVED'] as const;
export type RetrospectiveScope = (typeof RETROSPECTIVE_SCOPES)[number];

/** The level a lesson is actually true at. Only DOMAIN and GENERAL are reusable. */
export const LESSON_ABSTRACTIONS = ['CAMPAIGN', 'DOMAIN', 'GENERAL'] as const;
export type LessonAbstraction = (typeof LESSON_ABSTRACTIONS)[number];

export interface ResearchRetrospectiveRow {
  id: string;
  orchestration_id: string;
  project_id: string;
  lesson_key: string;
  scope: string;
  abstraction: string;
  lesson: string;
  evidence: string;
  metrics: string;
  created_at: string;
}

export interface ResearchRetrospective {
  id: string;
  orchestrationId: string;
  projectId: string;
  lessonKey: string;
  scope: RetrospectiveScope;
  abstraction: LessonAbstraction;
  lesson: string;
  evidence: string[];
  metrics: Record<string, number>;
  createdAt: string;
}

export interface MachineCategoryRow {
  id: string;
  program_id: string;
  project_id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  description: string | null;
  origin: string;
  source_claim_id: string | null;
  retired_at: string | null;
  retired_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface MachineCategory {
  id: string;
  programId: string;
  projectId: string;
  parentId: string | null;
  kind: MachineCategoryKind;
  name: string;
  description: string | null;
  origin: MachineCategoryOrigin;
  sourceClaimId: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityRow {
  id: string;
  program_id: string;
  project_id: string;
  name: string;
  slug: string;
  description: string | null;
  origin: string;
  source_claim_id: string | null;
  held_at: string | null;
  held_evidence: string | null;
  held_by: string | null;
  held_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Capability {
  id: string;
  programId: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  origin: 'SEED' | 'DISCOVERED';
  sourceClaimId: string | null;
  /** Null unless something outside research established that we hold it. */
  heldAt: string | null;
  heldEvidence: CapabilityHeldEvidence | null;
  heldBy: string | null;
  heldNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityEdgeRow {
  id: string;
  program_id: string;
  category_id: string;
  capability_id: string;
  relation: string;
  statement: string;
  source_claim_id: string;
  created_at: string;
  updated_at: string;
}

export interface CapabilityEdge {
  id: string;
  programId: string;
  categoryId: string;
  capabilityId: string;
  relation: CapabilityRelation;
  statement: string;
  sourceClaimId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryEvidenceRow {
  id: string;
  program_id: string;
  category_id: string;
  kind: string;
  subject: string;
  statement: string;
  observed_on: string | null;
  source_claim_id: string;
  created_at: string;
  updated_at: string;
}

export interface CategoryEvidenceEntry {
  id: string;
  programId: string;
  categoryId: string;
  kind: CategoryEvidenceKind;
  subject: string;
  statement: string;
  observedOn: string | null;
  sourceClaimId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManufacturingRoundRow {
  id: string;
  program_id: string;
  project_id: string;
  category_id: string | null;
  purpose: string;
  round: number;
  candidate_id: string;
  state: string;
  opened_at: string;
  harvested_at: string | null;
  found: number | null;
  created_at: string;
  updated_at: string;
}

export interface ManufacturingRound {
  id: string;
  programId: string;
  projectId: string;
  categoryId: string | null;
  purpose: ManufacturingRoundPurpose;
  round: number;
  candidateId: string;
  state: 'OPEN' | 'HARVESTED' | 'ABANDONED';
  openedAt: string;
  harvestedAt: string | null;
  /** Null while OPEN. Not counted yet is a different fact from none found. */
  found: number | null;
  createdAt: string;
  updatedAt: string;
}

/* --------------------------------------------------------------------------
 * The cross-border industrial dealflow kernel
 *
 * A third declaration axis on a research claim, beside `opportunity_signal`
 * (what kind of opening this is) and `structural_finding` (how an industry is
 * put together). This one answers a different question again: **what does this
 * source establish about a cross-border transaction** — who needs the
 * equipment, who can build it, what the destination market demands of it, what
 * it costs to land, and how people in this trade actually get paid.
 *
 * It is a separate axis rather than more values on an existing one because the
 * three answer different questions about one claim and a column with two
 * masters is invariant 31. A claim may carry all three, any one, or — as most
 * claims do — none.
 * ------------------------------------------------------------------------ */

/**
 * What a claim establishes about a cross-border transaction.
 *
 * Seven kinds, and the discipline is `opportunitySignals.ts`': the judgement
 * is made once, by the only party that can make it — somebody who read the
 * source — and everything after that is Brain matching a value from a closed
 * set exactly. Nothing downstream inspects a sentence.
 */
export const DEAL_FINDINGS = [
  /** A named organisation that needs a named class of equipment. */
  'BUYER_NEED',
  /** A named manufacturer or supplier that can build or supply that class. */
  'SUPPLIER_CAPABILITY',
  /** Who decides a purchase at an organisation already on the map. */
  'DECISION_MAKER',
  /** Something the destination market, or the buyer, demands of the goods. */
  'COMPLIANCE_REQUIREMENT',
  /**
   * A documented search establishing that one layer demands nothing.
   *
   * Its own kind rather than a flag, because §14 is explicit: a claim that
   * something does not exist is established by a documented search of the
   * places it would be, or not at all. So this kind — and only this kind —
   * requires the claim to name where the worker looked.
   */
  'REQUIREMENT_ABSENCE',
  /** A published figure for one component of the landed cost. */
  'COST_COMPONENT',
  /** Evidence that a named commercial structure is actually used in this trade. */
  'COMMERCIAL_PRECEDENT',
] as const;
export type DealFinding = (typeof DEAL_FINDINGS)[number];

/**
 * The four layers of "may this equipment be sold and operated there", kept
 * apart because collapsing them is the single most expensive mistake available
 * in this trade.
 *
 * ISO 9001 at a factory does not prove a particular tanker may be registered
 * in the destination market, and a market approval does not prove the buyer
 * will accept it. A kernel that reported one as the other would tell somebody
 * a deal was clear when it was not — and the equipment would be built before
 * anybody found out.
 *
 * `IMPORT_BARRIER` is a fifth entry and deliberately not a "layer" in the same
 * sense: it is the one posture that cannot be satisfied by doing more work.
 */
export const COMPLIANCE_LAYERS = [
  /** What the factory itself must hold: quality systems, welding approvals. */
  'FACTORY_CERTIFICATION',
  /** What this product must hold: type approval, pressure testing, marking. */
  'PRODUCT_CERTIFICATION',
  /** What the destination state demands before it may be registered or used. */
  'MARKET_APPROVAL',
  /** What this buyer demands beyond anything a government requires. */
  'BUYER_ACCEPTANCE',
  /** A duty, quota, ban or restriction on bringing the goods in at all. */
  'IMPORT_BARRIER',
] as const;
export type ComplianceLayer = (typeof COMPLIANCE_LAYERS)[number];

/**
 * What a requirement row says about the layer it names.
 *
 * `NOT_ESTABLISHED` is never written: it is the *absence* of rows, and the
 * whole reason `REQUIREMENT_ABSENCE` exists as its own finding is so that
 * "nobody has looked" and "somebody looked and there is nothing" can never
 * read the same. §30's rule, at the number that decides whether a deal is
 * legal.
 */
export const REQUIREMENT_POSTURES = [
  /** It applies and something must be done about it. */
  'REQUIRED',
  /** A documented search found the layer demands nothing here. */
  'NONE_FOUND',
  /** The goods may not enter, or may not be used, at all. */
  'PROHIBITED',
] as const;
export type RequirementPosture = (typeof REQUIREMENT_POSTURES)[number];

/**
 * The components a landed cost is actually made of.
 *
 * Closed, because a total assembled from free-text components is a total
 * nobody can check for a missing one — and a landed cost missing its duty line
 * is exactly the error that makes a deal look profitable.
 *
 * `BUYER_ALTERNATIVE` is not a cost of ours. It is what the buyer pays today,
 * and it is here because it is the only figure that says whether the saving is
 * real; keeping it in the same table as the costs, with its own kind, is what
 * stops it being added to them.
 */
export const COST_COMPONENTS = [
  'FACTORY_PRICE',
  'INLAND_ORIGIN',
  'EXPORT_HANDLING',
  'OCEAN_FREIGHT',
  'INSURANCE',
  'IMPORT_DUTY',
  'IMPORT_TAX',
  'CUSTOMS_CLEARANCE',
  'INLAND_DESTINATION',
  'INSPECTION',
  'CERTIFICATION_COST',
  'FINANCING_COST',
  'BUYER_ALTERNATIVE',
] as const;
export type CostComponent = (typeof COST_COMPONENTS)[number];

/**
 * How we could be paid, and — the half that matters — what each one requires
 * us to fund.
 *
 * The request's own §13: separate the transaction's value from our required
 * capital. A tanker costing a quarter of a million dollars is not a quarter of
 * a million dollars of ours unless the structure makes it so, and most of
 * these structures do not.
 */
export const COMMERCIAL_STRUCTURES = [
  'REFERRAL_COMMISSION',
  'SALES_REPRESENTATION',
  'SOURCING_FEE',
  'PROCUREMENT_FEE',
  'BROKER_COMMISSION',
  'BUYER_SIDE_REPRESENTATION',
  'SUPPLIER_SIDE_REPRESENTATION',
  'TRADING_COMPANY_MARKUP',
  'LOGISTICS_COORDINATION_FEE',
  'INSPECTION_COORDINATION',
  'SPARE_PARTS_SUPPLY',
  'AFTER_SALES_COORDINATION',
  'RECURRING_PROCUREMENT',
] as const;
export type CommercialStructure = (typeof COMMERCIAL_STRUCTURES)[number];

/** Which side of the transaction a party is on. */
export const DEAL_PARTY_KINDS = ['BUYER', 'SUPPLIER'] as const;
export type DealPartyKind = (typeof DEAL_PARTY_KINDS)[number];

export const DEAL_PARTY_ORIGINS = ['SEED', 'DISCOVERED'] as const;
export type DealPartyOrigin = (typeof DEAL_PARTY_ORIGINS)[number];

export interface DealPartyRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  country: string | null;
  equipment_class: string;
  equipment_key: string;
  note: string | null;
  decision_maker: string | null;
  decision_maker_claim_id: string | null;
  origin: string;
  source_claim_id: string | null;
  retired_at: string | null;
  retired_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface DealParty {
  id: string;
  projectId: string;
  kind: DealPartyKind;
  name: string;
  /** Where they are. Read from the claim's own column, never from its prose. */
  country: string | null;
  /** As the source writes it, for a person to read. */
  equipmentClass: string;
  /** The normalized form two rows are matched on. Never shown. */
  equipmentKey: string;
  note: string | null;
  decisionMaker: string | null;
  decisionMakerClaimId: string | null;
  origin: DealPartyOrigin;
  sourceClaimId: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DealRequirementRow {
  id: string;
  project_id: string;
  destination: string;
  equipment_class: string;
  equipment_key: string;
  layer: string;
  posture: string;
  statement: string;
  authority: string | null;
  effective_date: string | null;
  source_claim_id: string;
  created_at: string;
  updated_at: string;
}

export interface DealRequirement {
  id: string;
  projectId: string;
  /** The market the requirement applies in. */
  destination: string;
  equipmentClass: string;
  equipmentKey: string;
  layer: ComplianceLayer;
  posture: RequirementPosture;
  statement: string;
  /** Who imposes it, where the source names them. */
  authority: string | null;
  /** When the source says it took effect, so freshness is readable. */
  effectiveDate: string | null;
  sourceClaimId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DealCostRow {
  id: string;
  project_id: string;
  equipment_class: string;
  equipment_key: string;
  origin_country: string | null;
  destination: string | null;
  component: string;
  amount_cents: number;
  currency: string;
  basis: string;
  source_claim_id: string;
  created_at: string;
  updated_at: string;
}

export interface DealCost {
  id: string;
  projectId: string;
  equipmentClass: string;
  equipmentKey: string;
  originCountry: string | null;
  destination: string | null;
  component: CostComponent;
  amountCents: number;
  currency: string;
  /** What the figure is per — one unit, one container, one shipment. */
  basis: string;
  sourceClaimId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DealStructureEvidenceRow {
  id: string;
  project_id: string;
  equipment_class: string;
  equipment_key: string;
  structure: string;
  statement: string;
  rate_note: string | null;
  source_claim_id: string;
  created_at: string;
  updated_at: string;
}

export interface DealStructureEvidence {
  id: string;
  projectId: string;
  equipmentClass: string;
  equipmentKey: string;
  structure: CommercialStructure;
  statement: string;
  /** What the source says it pays, in its own words. Never parsed into a rate. */
  rateNote: string | null;
  sourceClaimId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How far a deal has actually got.
 *
 * Everything through `OUTREACH_READY` is **derived** from rows on the read
 * path and stored nowhere, for `tier.ts`' reason: a row is not a decision, and
 * a stored stage is stale the moment the evidence it was waiting on arrives.
 *
 * Everything after it is read from the Cash opportunity the deal was promoted
 * into, because those stages record things that happened in the world and no
 * derivation recovers them.
 *
 * **`NEGOTIATING` is in this list and is never derived.** It is a real stage
 * of this trade and the brief names it, and Brain holds no row that
 * establishes it: `COMMERCIAL_ACTIONS` has no action for negotiating, so there
 * is nothing to read. Inferring it from a quote having gone out would be a
 * status more precise than the evidence, which §29 records teaching a person
 * to stop believing the status. It stays here so a reader can see that it is a
 * gap in what Brain can observe rather than a stage somebody forgot — and
 * `maturity.ts` says the same thing beside the map that does the deriving.
 */
export const DEAL_STAGES = [
  'SIGNAL',
  'HYPOTHESIS',
  'DISCOVERED',
  'RESEARCHED',
  'QUALIFIED',
  'COMMERCIAL_PATH',
  'OUTREACH_READY',
  'ENGAGED',
  'QUOTING',
  'NEGOTIATING',
  'CONTRACTING',
  'PAID',
  'LOST',
  'BLOCKED',
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export interface DealRow {
  id: string;
  project_id: string;
  buyer_party_id: string;
  supplier_party_id: string;
  equipment_class: string;
  equipment_key: string;
  opportunity_id: string | null;
  blocked_reason: string | null;
  outcome: string | null;
  outcome_note: string | null;
  outcome_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Deal {
  id: string;
  projectId: string;
  buyerPartyId: string;
  supplierPartyId: string;
  equipmentClass: string;
  equipmentKey: string;
  /** The Cash opportunity this was promoted into, once it was. */
  opportunityId: string | null;
  /** An operational fact with an operational remedy, never a verdict. */
  blockedReason: string | null;
  outcome: string | null;
  outcomeNote: string | null;
  outcomeAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What the kernel asks about next, from a closed set of purposes. */
export const DEAL_ROUND_PURPOSES = [
  /** The first question of all: which classes this pattern actually trades. */
  'SEED_EQUIPMENT',
  /** Who needs this class, and what triggered it. */
  'DEMAND',
  /** Who builds this class competitively for export. */
  'SUPPLY',
  /** The four-layer envelope for this class into this destination. */
  'COMPLIANCE',
  /** What it costs to land one, component by component. */
  'LANDED_COST',
  /** Which commercial structures this trade actually uses, and what they pay. */
  'STRUCTURE',
  /** Who decides the purchase at one named organisation. */
  'DECISION_MAKER',
  /** What else a buyer we have actually transacted with procures. */
  'ADJACENT',
] as const;
export type DealRoundPurpose = (typeof DEAL_ROUND_PURPOSES)[number];

export const DEAL_ROUND_STATES = ['OPEN', 'SETTLED'] as const;
export type DealRoundState = (typeof DEAL_ROUND_STATES)[number];

export interface DealRoundRow {
  id: string;
  project_id: string;
  cash_mode_id: string;
  purpose: string;
  equipment_key: string | null;
  equipment_class: string | null;
  destination: string | null;
  party_id: string | null;
  deal_id: string | null;
  round: number;
  candidate_id: string;
  state: string;
  opened_at: string;
  harvested_at: string | null;
  found: number | null;
  created_at: string;
  updated_at: string;
}

export interface DealRound {
  id: string;
  projectId: string;
  cashModeId: string;
  purpose: DealRoundPurpose;
  equipmentKey: string | null;
  equipmentClass: string | null;
  destination: string | null;
  partyId: string | null;
  dealId: string | null;
  round: number;
  candidateId: string;
  state: DealRoundState;
  openedAt: string;
  harvestedAt: string | null;
  /**
   * What the round established. Null while OPEN, and both readers say *not
   * counted yet* rather than nought — §33's defect, not repeated here.
   */
  found: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What an attempt taught, recorded one observation at a time.
 *
 * A lesson is never written by generalizing: each row is one observed outcome
 * with its own jurisdiction, equipment class and provenance. Whether several
 * of them amount to a rule is **derived** on the read path, with the sample
 * size reported beside it, because §10's own instruction is not to generalize
 * prematurely — and a stored rule is a generalization nobody can see the
 * sample behind.
 */
export const DEAL_OBSERVATION_KINDS = [
  'BUYER_RESPONDED',
  'BUYER_IGNORED',
  'SUPPLIER_ENGAGED',
  'SUPPLIER_REFUSED',
  'PRICE_DISCREPANCY',
  'CERTIFICATION_SURPRISE',
  'LOGISTICS_SURPRISE',
  'PAYMENT_PREFERENCE',
  'COMMISSION_ACCEPTED',
  'COMMISSION_REFUSED',
  'FALSE_SIGNAL',
  'CYCLE_LENGTH',
] as const;
export type DealObservationKind = (typeof DEAL_OBSERVATION_KINDS)[number];

export interface DealObservationRow {
  id: string;
  project_id: string;
  deal_id: string | null;
  kind: string;
  jurisdiction: string | null;
  equipment_key: string | null;
  statement: string;
  recorded_by: string;
  source_claim_id: string | null;
  created_at: string;
}

export interface DealObservation {
  id: string;
  projectId: string;
  dealId: string | null;
  kind: DealObservationKind;
  jurisdiction: string | null;
  equipmentKey: string | null;
  statement: string;
  /** Whose observation it is: a person, or Brain reading its own rows. */
  recordedBy: string;
  sourceClaimId: string | null;
  createdAt: string;
}


/**
 * What owner capital entering a machine category is actually spent on.
 *
 * Deliberately **not** §38's `CAPITAL_REQUIREMENTS`, and the reason is the
 * subject rather than the words. That list answers what opening a service
 * business in an industry needs — labour, customer acquisition, insurance, a
 * minimum order — and it hangs off `cash_opportunities`. This answers what
 * producing a machine needs, and it hangs off `machine_categories`. The two
 * can never be about one observation, so they cannot drift into disagreeing
 * about one; what forcing a factory's tooling, type approval and test rig into
 * EQUIPMENT, COMPLIANCE and COMPLIANCE *would* do is make the grouped reading
 * answer an easier question than the one asked.
 */
export const MACHINE_CAPITAL_REQUIREMENTS = [
  'TOOLING_AND_EQUIPMENT',
  'FACILITY',
  'CERTIFICATION_AND_APPROVAL',
  'ENGINEERING_AND_DEVELOPMENT',
  'WORKING_CAPITAL',
  'INVENTORY_AND_PARTS',
  'SUPPLIER_ONBOARDING',
  'DISTRIBUTION_AND_SERVICE_NETWORK',
  'INTELLECTUAL_PROPERTY_OR_LICENCE',
  'TEST_AND_VALIDATION',
] as const;
export type MachineCapitalRequirement = (typeof MACHINE_CAPITAL_REQUIREMENTS)[number];

/**
 * Which shape of the business a figure is about.
 *
 * The directive asks for a range or a scenario, and the scenario is the half
 * that carries meaning: what it costs to build the first credible machine and
 * what it costs to produce at volume are two facts, and a reading that summed
 * them would report a number nobody could act on. Ordered smallest first, and
 * that order is read — `capital.ts` reports the cheapest scenario any
 * requirement is priced under rather than guessing across them.
 */
export const CAPITAL_SCENARIOS = [
  'SMALLEST_CREDIBLE_ENTRY',
  'TYPICAL_ENTRY',
  'AT_PRODUCTION_SCALE',
] as const;
export type CapitalScenario = (typeof CAPITAL_SCENARIOS)[number];

/**
 * What kind of figure a published amount is.
 *
 * Ordered strongest first, and the order is reported rather than used to
 * discount anything: a reader weighing a regulator's fee schedule against an
 * analyst's estimate is doing §14's job — *no claim judged by a standard that
 * does not fit what it claims* — and Brain's part is to make the difference
 * visible, never to apply a coefficient to it.
 */
export const CAPITAL_BASES = [
  'REGULATORY_FEE_SCHEDULE',
  'PUBLISHED_PRICE_OR_SCHEDULE',
  'COMPARABLE_FIRM_DISCLOSURE',
  'TRADE_PUBLICATION_ESTIMATE',
  'ANALYST_OR_MARKET_ESTIMATE',
] as const;
export type CapitalBasis = (typeof CAPITAL_BASES)[number];

export interface CategoryCapitalRow {
  id: string;
  program_id: string;
  category_id: string;
  requirement: string;
  scenario: string;
  amount_low_minor: number | null;
  amount_high_minor: number | null;
  currency: string | null;
  basis: string;
  as_of: string;
  statement: string;
  source_claim_id: string;
  created_at: string;
  updated_at: string;
}

export interface CategoryCapitalEntry {
  id: string;
  programId: string;
  categoryId: string;
  requirement: MachineCapitalRequirement;
  scenario: CapitalScenario;
  /**
   * The published range in minor units, or null on both when the requirement is
   * established and nothing publishes a figure for it.
   *
   * Null is a fact the reading uses rather than a blank to be filled: a total
   * summed past an unpriced requirement is smaller than anything published
   * says, which is the direction nobody checks because it looks like a
   * bargain.
   */
  amountLowMinor: number | null;
  amountHighMinor: number | null;
  currency: string | null;
  basis: CapitalBasis;
  /** When the figure was true, per the source. Money ages. */
  asOf: string;
  statement: string;
  sourceClaimId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What buying a firm would contribute.
 *
 * Every value names something the ladder already reasons about, so a candidate
 * resolves to a gap rather than to an impression. There is deliberately no
 * `STRATEGIC_FIT` and no `SYNERGY`: an acquisition nobody can say what it
 * supplies is one nobody can argue with.
 */
export const ACQUISITION_CONTRIBUTIONS = [
  'CAPABILITY',
  'PRODUCTION_CAPACITY',
  'DISTRIBUTION_OR_DEALER_NETWORK',
  'SUPPLY_OR_COMPONENT_SOURCE',
  'CERTIFICATION_OR_APPROVAL',
  'INTELLECTUAL_PROPERTY',
  'ENGINEERING_TEAM',
  'BRAND_OR_MARKET_POSITION',
] as const;
export type AcquisitionContribution = (typeof ACQUISITION_CONTRIBUTIONS)[number];

export interface AcquisitionCandidateRow {
  id: string;
  program_id: string;
  category_id: string | null;
  capability_id: string | null;
  name: string;
  contribution: string;
  statement: string;
  source_claim_id: string;
  set_aside_at: string | null;
  set_aside_reason: string | null;
  set_aside_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AcquisitionCandidate {
  id: string;
  programId: string;
  categoryId: string | null;
  capabilityId: string | null;
  name: string;
  contribution: AcquisitionContribution;
  statement: string;
  sourceClaimId: string;
  /** A person read it and said no. The row and its evidence stay. */
  setAsideAt: string | null;
  setAsideReason: string | null;
  setAsideBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A decision this kernel cannot make and must not forget.
 *
 * One topic, because one is what the directive raises: it asks for a single
 * master brand that could sit on a pressure washer and on a cargo aircraft,
 * and then says not to lock the division names prematurely. Both halves are
 * load-bearing — inventing a name would be Brain deciding something reserved
 * to a person, and dropping the concern because it cannot be decided would
 * lose the requirement. **`OPEN` is valid state.**
 *
 * There is no free-text topic, for the reason `PREFERENCES` is a closed set: a
 * topic somebody could invent by posting is one nobody reviewed the criteria
 * for, and the criteria are what make a decision answerable.
 */
export const PROGRAMME_DECISION_TOPICS = ['MASTER_BRAND_ARCHITECTURE'] as const;
export type ProgrammeDecisionTopic = (typeof PROGRAMME_DECISION_TOPICS)[number];

export interface ProgrammeDecisionRow {
  id: string;
  program_id: string;
  topic: string;
  state: string;
  resolution: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProgrammeDecision {
  id: string;
  programId: string;
  topic: ProgrammeDecisionTopic;
  state: 'OPEN' | 'RESOLVED';
  /** A person's own words. Nothing derives it and no round may write it. */
  resolution: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/* --------------------------------------------------------------------------
 * The monetization possibility ledger
 *
 * The vocabularies are here, with every other closed set this codebase
 * matches exactly. What a method structurally requires and produces, what each
 * attribute asks, and which relations fall out of the method table are in
 * `domain/monetization.ts`, which imports these — the same split
 * `domain/industry.ts` already has, and the reason `types.ts` imports nothing.
 * ------------------------------------------------------------------------ */

/**
 * The things a shape of transaction consumes or produces.
 *
 * Deliberately not "capabilities": `services/cash/capabilities.ts` answers what
 * *this Brain* can verifiably do, from rows, which is a different question from
 * what a method structurally requires of whoever runs it. The two meet in
 * `services/cash/monetization/status.ts`, where a required endowment with no
 * capability behind it is what makes a path BLOCKED rather than unproven.
 */
export const ENDOWMENTS = [
  /** A route that actually reaches somebody who can approve payment. */
  'BUYER_ACCESS',
  /** A route to the thing being sold, at a price, now. */
  'SUPPLY_ACCESS',
  /** People who already listen. */
  'AUDIENCE',
  /** Recorded observations somebody else would pay to have. */
  'DATA',
  /** Named people who would take the call. */
  'RELATIONSHIPS',
  /** Cash that has to go out before any comes back. */
  'CAPITAL',
  /** Somebody or something that can actually do the work. */
  'FULFILMENT_CAPACITY',
  /** A tool that does the work again without a person. */
  'SOFTWARE',
  /** A licence, registration, qualification or standing. */
  'CREDENTIAL',
  /** A name a stranger would transact with. */
  'BRAND',
  /** Money that arrives again without being sold again. */
  'RECURRING_REVENUE',
] as const;
export type Endowment = (typeof ENDOWMENTS)[number];

/**
 * Which side of the transaction a method puts you on.
 *
 * This is what makes *competes with* derivable. Two paths on one subject that
 * put you in the same role are two ways of being the same party, and you are
 * one of them or the other — a seller who is also the broker of the same
 * transaction is one transaction, not two. Two paths in different roles coexist
 * by construction, which is the honest default: selling a report about a market
 * does not stop you trading in it.
 */
export const TRANSACTION_ROLES = [
  'PRINCIPAL',
  'INTERMEDIARY',
  'INFORMATION',
  'CAPITAL',
  'PLATFORM',
] as const;
export type TransactionRole = (typeof TRANSACTION_ROLES)[number];

/**
 * Every shape of transaction Brain knows about.
 *
 * Closed, and the failure mode is deliberately **missing** a method rather than
 * admitting a vague one — §27 records what happens to a closed list that has to
 * be complete over ordinary English, and the answer there was to fix the
 * failure mode rather than to keep widening. A method nobody can name costs one
 * enumerated possibility; a method that is really a feeling costs a ledger
 * entry that ranks against real ones.
 */
export const MONETIZATION_METHODS = [
  'DIRECT_SALE',
  'PRODUCTIZED_SERVICE',
  'CONSULTING',
  'DONE_WITH_YOU',
  'TRAINING',
  'AUDIT_OR_ASSESSMENT',
  'MANAGED_SERVICE',
  'MAINTENANCE_CONTRACT',
  'SUBCONTRACTED_FULFILMENT',
  'AGENCY_REPRESENTATION',
  'BROKERAGE',
  'LEAD_GENERATION',
  'REFERRAL_FEE',
  'AFFILIATE',
  'MARKETPLACE',
  'PLATFORM_FEE',
  'ADVERTISING',
  'SPONSORSHIP',
  'DATA_SUBSCRIPTION',
  'INTELLIGENCE_REPORT',
  'API_ACCESS',
  'SOFTWARE_TOOL',
  'TEMPLATE_OR_ASSET_SALE',
  'COMMUNITY_MEMBERSHIP',
  'CERTIFICATION',
  'EVENTS',
  'LICENSING',
  'WHITE_LABEL',
  'FRANCHISE',
  'ARBITRAGE',
  'RESALE',
  'DROP_SHIP',
  'CONSIGNMENT',
  'RENTAL',
  'LEASING',
  'AUCTION',
  'BOUNTY',
  'COMPETITION_PRIZE',
  'GRANT',
  'PROCUREMENT_CONTRACT',
  'TENDER_SUPPORT',
  'RECOVERY_OR_CLAIMS',
  'COMPLIANCE_SERVICE',
  'REVENUE_SHARE',
  'JOINT_VENTURE',
  'PURCHASE_ORDER_FINANCE',
  'RECEIVABLES_FINANCE',
] as const;
export type MonetizationMethod = (typeof MONETIZATION_METHODS)[number];

/**
 * What every path in the ledger has to answer.
 *
 * The brief's own list, minus the four it asks for that are structural rather
 * than answers — the method, the underlying discovery, the dependencies and the
 * evidence are columns, edges and claims — and minus the four that are derived:
 * the margin, the status, the rank and what is still unknown.
 */
export const MONETIZATION_ATTRIBUTES = [
  'requiredCapability',
  'requiredRelationships',
  'requiredCapital',
  'expectedRevenue',
  'directCosts',
  'timeToCash',
  'probabilityOfSuccess',
  'executionDifficulty',
  'legalRequirements',
  'externalDependencies',
  'competition',
  'scalability',
  'repeatability',
] as const;
export type MonetizationAttribute = (typeof MONETIZATION_ATTRIBUTES)[number];

/**
 * The statuses the brief asks for.
 *
 * Five of the seven are **derived** on the read path — a row is not a decision,
 * and a stored status is stale the moment the evidence it was waiting on
 * arrives. The two that no derivation could recover are that a person said this
 * cannot work and that a person put it away, and those are judgement rows.
 *
 * Ordered strongest first, which is also the first comparison the ranking makes.
 */
export const MONETIZATION_STATUSES = [
  /** Evidence supports it and nothing named is in its way. */
  'ACTIVE',
  /** Somebody asked to be kept informed rather than to act. */
  'WATCH',
  /** Something named has to happen first: a capability, a dependency, a person. */
  'BLOCKED',
  /** Answered, and what it answers is not good: no margin, saturated, one-off by hand. */
  'WEAK',
  /** Nothing has established anything about it yet. */
  'UNPROVEN',
  /** Established as not working, and why. */
  'INVALIDATED',
  /** Put away, deliberately, by somebody. */
  'ARCHIVED',
] as const;
export type MonetizationStatus = (typeof MONETIZATION_STATUSES)[number];

/**
 * What a person may record about a path.
 *
 * Deliberately not a status setter. Three judgements a derivation cannot make,
 * and `REVIVE`, which is the answering transition for the last two — an
 * escalation with no way out is stuck rather than waiting. Everything else
 * about where a path stands is read from rows, so there is no shape of this
 * that lets somebody mark a path healthy over evidence that says otherwise.
 */
export const PATH_JUDGMENTS = ['WATCH', 'INVALIDATE', 'ARCHIVE', 'REVIVE'] as const;
export type PathJudgment = (typeof PATH_JUDGMENTS)[number];

/**
 * How a path came to be in the ledger.
 *
 * `ENUMERATED` is the method table applied to a subject's own recorded facts:
 * arithmetic, reading no prose and claiming nothing beyond *this is a shape of
 * transaction that could apply here*. `EVIDENCED` is a worker that read a
 * source declaring one, and carries the claim. `SEED` is a person, and it is
 * the one origin Brain may never write — §22's rule at a new table: a machine
 * that could name its own possibilities would be deciding what the space is.
 */
export const PATH_ORIGINS = ['SEED', 'ENUMERATED', 'EVIDENCED'] as const;
export type PathOrigin = (typeof PATH_ORIGINS)[number];

/**
 * Where an answer on a path came from.
 *
 * The same three words `cash_card_facts.kind` carries, and the same meaning:
 * EVIDENCE resolves to a claim, RECOMMENDATION is Brain's own proposal and
 * carries its basis, its assumptions and what would change it, and PERSON is
 * somebody's decision that nothing automatic replaces.
 */
export const FACT_KINDS = ['EVIDENCE', 'RECOMMENDATION', 'PERSON'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/**
 * How one path relates to another.
 *
 * Most of these are derived from the method table rather than stored, so §21's
 * chain is a consequence of the vocabulary rather than a second graph somebody
 * maintains beside it.
 */
export const MONETIZATION_EDGE_KINDS = [
  /** Running the first makes the second possible. */
  'ENABLES',
  /** The second cannot start until the first has. */
  'REQUIRES',
  /** They are two ways of being the same party in one transaction. */
  'COMPETES_WITH',
  /** They can both run, and neither costs the other anything. */
  'COEXISTS_WITH',
  /** The first produces observations the second sells or uses. */
  'PRODUCES_DATA_FOR',
  /** The first produces the people the second needs. */
  'PRODUCES_RELATIONSHIPS_FOR',
  /** The first is the cheaper thing to do on the way to the second. */
  'STEPPING_STONE_TO',
  /** The second only works once the first has produced volume or an audience. */
  'VIABLE_ONLY_AT_SCALE_OF',
] as const;
export type MonetizationEdgeKind = (typeof MONETIZATION_EDGE_KINDS)[number];

/** Where a recorded edge came from. A derived one is not recorded at all. */
export const EDGE_SOURCES = ['PERSON', 'EVIDENCED'] as const;
export type EdgeSource = (typeof EDGE_SOURCES)[number];

/**
 * Why a path is not where it was.
 *
 * A closed set, because "the reason for ranking movement" has to be answerable
 * by group across a ledger and a sentence somebody composed is not. Each one is
 * derived from the comparison that actually changed, never from an account
 * anything gives of itself.
 */
export const RANK_MOVEMENT_REASONS = [
  /** It has only just arrived, so there is no previous position. */
  'ENTERED_THE_LEDGER',
  /** Something about this path was established or changed. */
  'ITS_OWN_EVIDENCE_CHANGED',
  /** Its derived status moved. */
  'ITS_STATUS_CHANGED',
  /** Nothing about it changed; something else did. */
  'THE_FIELD_AROUND_IT_CHANGED',
  /** A person recorded a judgement about it. */
  'A_PERSON_DECIDED',
] as const;
export type RankMovementReason = (typeof RANK_MOVEMENT_REASONS)[number];

/* --------------------------------------------------------------------------
 * The ledger's rows
 *
 * What a method structurally requires and produces, what each attribute asks
 * and what would answer it, and which relations fall out of the method table
 * are in `domain/monetization.ts`. These are the rows and the shapes the
 * repositories map them to.
 * ------------------------------------------------------------------------ */

export interface MonetizationPathRow {
  id: string;
  project_id: string;
  opportunity_id: string | null;
  industry_node_id: string | null;
  method: string;
  title: string;
  thesis: string | null;
  origin: string;
  source_claim_id: string | null;
  merged_into_id: string | null;
  split_from_id: string | null;
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MonetizationPath {
  id: string;
  projectId: string;
  /** Exactly one of these is set, enforced by a CHECK rather than by a caller. */
  opportunityId: string | null;
  industryNodeId: string | null;
  method: MonetizationMethod;
  title: string;
  /** Who would pay, for what. Null until something establishes a payer. */
  thesis: string | null;
  origin: PathOrigin;
  sourceClaimId: string | null;
  /**
   * §20's lineage, and neither of these is a delete.
   *
   * A merged path keeps its id, its facts, its judgements and its whole rank
   * history; the merge is one column and clearing it is the reversal. A split
   * child names the parent it came out of.
   */
  mergedIntoId: string | null;
  splitFromId: string | null;
  /** When the derivation last looked at it. Null before the first pass. */
  lastEvaluatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonetizationPathFactRow {
  id: string;
  project_id: string;
  path_id: string;
  attribute: string;
  kind: string;
  value: string;
  amount_cents: number | null;
  days: number | null;
  claim_id: string | null;
  basis: string | null;
  assumptions: string | null;
  uncertainty: string | null;
  decided_by: string;
  created_at: string;
  updated_at: string;
}

export interface MonetizationPathFact {
  id: string;
  projectId: string;
  pathId: string;
  attribute: MonetizationAttribute;
  /** `EVIDENCE` carries a claim; `RECOMMENDATION` carries all three of its own. */
  kind: FactKind;
  value: string;
  /**
   * The structured reading, where the attribute declares a unit.
   *
   * Supplied by whoever established the fact and never parsed out of `value`:
   * §25's Westbrook defect is what a number read from a sentence costs, and
   * here it would be a figure nobody published wearing the authority of one
   * that was. Null is unknown, and an unknown sorts last rather than best.
   */
  amountCents: number | null;
  days: number | null;
  claimId: string | null;
  basis: string | null;
  assumptions: string | null;
  uncertainty: string | null;
  decidedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface MonetizationPathJudgmentRow {
  id: string;
  project_id: string;
  path_id: string;
  judgment: string;
  reason: string;
  decided_by_id: string | null;
  channel: string;
  created_at: string;
}

export interface MonetizationPathJudgment {
  id: string;
  projectId: string;
  pathId: string;
  judgment: PathJudgment;
  reason: string;
  /** Whose authority it carries, resolved from rows. */
  decidedById: string | null;
  /** How the call got in. Brain cannot check one, so it never assumes the stronger. */
  channel: 'BROWSER_SESSION' | 'DELEGATED_TERMINAL';
  createdAt: string;
}

export interface MonetizationPathEdgeRow {
  id: string;
  project_id: string;
  from_path_id: string;
  to_path_id: string;
  kind: string;
  rationale: string;
  source: string;
  source_claim_id: string | null;
  decided_by_id: string | null;
  created_at: string;
}

export interface MonetizationPathEdge {
  id: string;
  projectId: string;
  fromPathId: string;
  toPathId: string;
  kind: MonetizationEdgeKind;
  rationale: string;
  source: EdgeSource;
  sourceClaimId: string | null;
  decidedById: string | null;
  createdAt: string;
}

export interface MonetizationRankSnapshotRow {
  id: string;
  project_id: string;
  path_id: string;
  rank: number;
  previous_rank: number | null;
  reason: string;
  status: string;
  criterion: string | null;
  evaluated_at: string;
}

export interface MonetizationRankSnapshot {
  id: string;
  projectId: string;
  pathId: string;
  rank: number;
  previousRank: number | null;
  reason: RankMovementReason;
  status: MonetizationStatus;
  /** The first ranking comparison that came out differently. Null on entry. */
  criterion: string | null;
  evaluatedAt: string;
}
