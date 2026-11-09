/**
 * A Factory program: one approved specification, implemented across many
 * campaigns, and finished only when every requirement it states is verified on
 * production (ARCHITECTURE-RECORD §96).
 *
 * The program sits *above* change requests and campaigns and owns nothing they
 * already own. A campaign is still one change request with immutable acceptance
 * conditions, still admitted by the line, still reviewed, repaired and released
 * by the machinery that has always done it. What the program adds is the thing
 * no campaign could hold: the verbatim source, the requirement map derived from
 * it, the plan of campaigns that covers that map, and the requirement-level
 * ledger of production verification.
 */

/** The verification vocabulary a requirement may use. Every one runs on production. */
export type RequirementCheck =
  | { kind: 'HTTP'; path: string; expectStatus: number; expectText?: string; statement?: string }
  | { kind: 'BUNDLE_TEXT'; text: string; statement?: string }
  | { kind: 'PROBE'; probe: string; args?: Record<string, string | number | boolean>; statement?: string };

export type RequirementKind = 'CAPABILITY' | 'INTERACTION';

/**
 * The lifecycle a person reads. Derived on every read from rows and never
 * stored, because a stored status is stale the moment the campaign it
 * summarises moves.
 *
 * SPECIFIED  — in the map, not yet assigned to work or to an existing implementation.
 * MAPPED     — assigned to a campaign (or an existing implementation) that has not delivered.
 * IMPLEMENTED — its campaign delivered code (a pull request) that production does not run.
 * INTEGRATED — production runs the code; its own checks have not all passed there yet.
 * PRODUCTION_VERIFIED — every check passed on production, and so did every requirement it depends on.
 * BLOCKED    — stopped on something named: an open ambiguity, a person's decision, repeated repair failure.
 * NOT_DONE   — production verification failed; the requirement is reopened and under repair.
 */
export const REQUIREMENT_STATUSES = [
  'SPECIFIED',
  'MAPPED',
  'IMPLEMENTED',
  'INTEGRATED',
  'PRODUCTION_VERIFIED',
  'BLOCKED',
  'NOT_DONE',
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** One normative or contextual piece of the source, located exactly. */
export interface SourceItem {
  /** `S-0001`… in document order. Stable because the source is immutable. */
  id: string;
  /** The heading path the item sits under, e.g. ["3. PROGRAM-LEVEL COORDINATION"]. */
  section: string[];
  /** Character offsets into the source, [start, end). */
  start: number;
  end: number;
  /** 1-based inclusive line range. */
  lineStart: number;
  lineEnd: number;
  /** Exactly `source.slice(start, end)`. */
  text: string;
  /** Whether the item states something that must be true (must/shall/never/every…). */
  normative: boolean;
  /** Words that make the item open to more than one reading, verbatim. */
  ambiguityMarkers: string[];
}

export interface RequirementAmbiguity {
  /** The source item the ambiguity is in. */
  item: string;
  /** What is unclear, in the mapper's words. */
  question: string;
  /**
   * The reading Factory proposes, or null when none is safe to propose. A null
   * interpretation blocks the requirement until a person answers it; a proposed
   * one is shown to the person who approves the program and is theirs once they do.
   */
  interpretation: string | null;
  /** Set by a person's amendment, never by Factory. */
  resolvedBy?: string | null;
}

/** One requirement, as the map states it. Immutable once the program is approved. */
export interface ProgramRequirement {
  key: string;
  kind: RequirementKind;
  title: string;
  subsystem: string;
  /** Source item ids this requirement answers, and optionally the exact clause it covers. */
  source: string[];
  quote: string | null;
  behavior: string;
  inputs: string[];
  outputs: string[];
  constraints: string[];
  dependsOn: string[];
  /** For an INTERACTION, the requirements whose implementations must work together. */
  interactsWith: string[];
  /** What already implements it, with the files that are the evidence. Never enough alone. */
  existing: { paths: string[]; evidence: string } | null;
  /** The work still missing; empty only when `existing` claims the whole behavior. */
  missingWork: string;
  /** The files the missing work is expected to change. */
  paths: string[];
  verification: RequirementCheck[];
  ambiguities: RequirementAmbiguity[];
  /**
   * When the work is wanted, never whether (§97). Campaigns are put in the line
   * in this order; the line still admits by capacity and file ownership, so
   * independent lower-priority work runs beside higher-priority work whenever a
   * slot is free. Absent means P2.
   */
  priority?: RequirementPriority;
  /**
   * Specified and kept ready, but not started until another requirement that is
   * not prepared depends on it (directly, transitively, or through a dependency
   * Factory discovered). §22 of the first program: a capability prepared in
   * advance consumes no worker until a live objective needs it.
   */
  prepared?: boolean;
}

export const REQUIREMENT_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];
/** The line priority (lower starts sooner) a campaign carries, by its most urgent requirement. Repairs are 1. */
export const LINE_PRIORITY: Record<RequirementPriority, number> = { P0: 2, P1: 3, P2: 4, P3: 6 };

export interface RequirementMap {
  requirements: ProgramRequirement[];
  /** Source items that state no requirement, each with the reason. A normative item cannot be one. */
  context: Array<{ item: string; reason: string }>;
}

export type ProgramCampaignKind = 'BUILD' | 'REPAIR' | 'STRUCTURAL';

/** One bounded campaign of the plan. Becomes exactly one change request. */
export interface PlannedCampaign {
  key: string;
  kind: ProgramCampaignKind;
  title: string;
  subsystem: string;
  /** Requirements this campaign implements. A requirement is implemented by one campaign. */
  implements: string[];
  /** Campaign keys that must be integrated before this one starts. */
  dependsOn: string[];
  /** Union of the implemented requirements' paths. */
  mutationScope: string[];
  /** For a REPAIR or STRUCTURAL campaign, the failure it answers. */
  repairOf: { requirement: string; episode: number; failures: string[] } | null;
}

export interface ProgramPlan {
  campaigns: PlannedCampaign[];
  /** Requirements no campaign implements because existing code is claimed; verified on production. */
  verifyOnly: string[];
  /** Ordering edges added because two campaigns would otherwise own the same files at once. */
  serialized: Array<{ campaign: string; after: string; paths: string[] }>;
}

export type ProgramIssueCode =
  | 'SOURCE_ITEM_UNKNOWN'
  | 'OMITTED_REQUIREMENT'
  | 'CONTEXT_IS_NORMATIVE'
  | 'QUOTE_NOT_IN_SOURCE'
  | 'DUPLICATE_KEY'
  | 'DUPLICATE_REQUIREMENT'
  | 'CONFLICTING_INTERPRETATION'
  | 'UNKNOWN_DEPENDENCY'
  | 'DEPENDENCY_CYCLE'
  | 'INTERACTION_NEEDS_PARTICIPANTS'
  | 'UNVERIFIABLE'
  | 'NO_BEHAVIOR'
  | 'EXISTING_WITHOUT_EVIDENCE'
  | 'NO_WORK_DECLARED'
  | 'AMBIGUITY_HIDDEN'
  | 'INVALID_CHECK'
  | 'INVALID_PRIORITY'
  | 'AMENDMENT_MOVES_ITEMS'
  | 'REQUIREMENT_DROPPED'
  | 'REQUIREMENT_REDEFINED'
  | 'RELATIONSHIP_LOST'
  | 'UNASSIGNED_REQUIREMENT'
  | 'DUPLICATE_IMPLEMENTATION'
  | 'UNKNOWN_REQUIREMENT'
  | 'CAMPAIGN_DEPENDENCY_MISSING'
  | 'CAMPAIGN_CYCLE'
  | 'OVERSIZED_CAMPAIGN'
  | 'EMPTY_CAMPAIGN'
  | 'UNSERIALIZED_OVERLAP'
  | 'PROTECTED_VERIFICATION_SCOPE'
  | 'NO_MUTATION_SCOPE';

export interface ProgramIssue {
  code: ProgramIssueCode;
  /** The requirement, item or campaign the issue is about. */
  subject: string;
  detail: string;
}

export interface ProgramValidation {
  ok: boolean;
  errors: ProgramIssue[];
  warnings: ProgramIssue[];
}

export type ProgramState = 'DRAFT' | 'APPROVED' | 'WITHDRAWN';

/**
 * A numbered release appended to a program's source (§97). The program's
 * specification is its original source followed by every amendment in order;
 * no earlier text moves, so every earlier item keeps its id.
 */
export interface ProgramAmendment {
  number: number;
  title: string;
  sourceText: string;
  sourceSha256: string;
  actorType: 'PERSON' | 'FACTORY';
  actorId: string | null;
  createdAt: string;
}

export interface FactoryProgram {
  id: string;
  projectId: string;
  submissionKey: string;
  title: string;
  /** The verbatim specification as first submitted. Authoritative; the map never replaces it. */
  sourceText: string;
  sourceSha256: string;
  /** Releases appended since, in order. The whole specification is `programSource(program)`. */
  amendments: ProgramAmendment[];
  repository: string;
  baseBranch: string;
  state: ProgramState;
  /** Whether the approving person authorized LOW-risk campaigns to release themselves (§58). */
  autoRelease: boolean;
  approvedByUserId: string | null;
  approvedAt: string | null;
  mapVersion: number;
  planVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type VerificationOutcome = 'PASS' | 'FAIL' | 'UNKNOWN';

/** One production verification of one requirement. Append-only. */
export interface RequirementVerification {
  id: string;
  programId: string;
  requirementKey: string;
  outcome: VerificationOutcome;
  /** The production revision that answered. */
  revision: string | null;
  checks: Array<{ check: string; ok: boolean | null; detail: string }>;
  at: string;
}

/** A dependency Factory discovered while implementing — the how, never the what. */
export interface DiscoveredDependency {
  requirementKey: string;
  dependsOn: string;
  reason: string;
  actorType: 'PERSON' | 'FACTORY';
  at: string;
}

/** What one planned campaign has become, read from the existing campaign rows. */
export interface CampaignProgress {
  key: string;
  changeRequestId: string | null;
  campaignId: string | null;
  /** The existing objective outcome (BUILDING/VERIFYING/RELEASING/LIVE/BLOCKED/CANCELLED), or null if not started. */
  outcome: 'BUILDING' | 'VERIFYING' | 'RELEASING' | 'LIVE' | 'BLOCKED' | 'CANCELLED' | null;
  /** A pull request exists carrying the work (delivered but maybe not merged). */
  delivered: boolean;
  needsPerson: boolean;
  blocker: string | null;
}

export interface RequirementReading {
  key: string;
  kind: RequirementKind;
  title: string;
  status: RequirementStatus;
  /** Why it is in this status, in one line. */
  reason: string;
  campaign: string | null;
  reopened: boolean;
  lastVerification: RequirementVerification | null;
}

export type ProgramVerdict = 'DONE' | 'NOT_DONE' | 'BLOCKED';

export interface ProgramReading {
  programId: string;
  verdict: ProgramVerdict;
  counts: Record<RequirementStatus, number>;
  requirements: RequirementReading[];
  /** Every reason the verdict is not DONE, one line each. */
  unmet: string[];
}

/** Bounds on a campaign the planner derives. */
export const MAX_REQUIREMENTS_PER_CAMPAIGN = 8;
/** Repairs of one requirement before Factory asks for a structural change instead. */
export const MAX_REPAIR_EPISODES = 3;
/**
 * The verification machinery itself. A campaign that could edit it could make
 * its own checks pass; no implementing campaign's scope may reach it.
 */
export const PROTECTED_VERIFICATION_PATHS = ['server/services/factory/program/**', 'server/domain/factoryProgram.ts'];
