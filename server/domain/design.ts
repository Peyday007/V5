/**
 * The design kernel's vocabulary, and the seed it starts from.
 *
 * ---------------------------------------------------------------------------
 * A seed, and deliberately not a taxonomy
 * ---------------------------------------------------------------------------
 *
 * The tempting thing to put here is every UI pattern, every screen family, every
 * interaction idiom and three hundred heuristics — a design encyclopedia, loaded
 * before the kernel has looked at a single screen. It would be wrong in the way
 * §38 records one subject along: a hardcoded list answers the question the
 * kernel exists to ask, and it is wrong about every distinction the product
 * turns out to need and never knew it would.
 *
 * So what is declared here is **ten concerns every interface has**, and nothing
 * below them. A concern is not a pattern: *information hierarchy* is a thing an
 * interface either gets right or wrong, and it says nothing about how. The
 * branches — editorial layout, dense chronology, destructive actions, command
 * surfaces, multi-pane research tools — are `design_patterns.branch`, which is
 * free text, and a branch exists because patterns accumulated under it rather
 * than because somebody predicted it.
 *
 * `DESIGN_PRIMITIVES` is therefore allowed to grow, and growing it is a code
 * change somebody reviews — the same bar §29 puts on `PREFERENCES` and §16 puts
 * on a second approval envelope. What must never happen is a primitive being
 * *invented at runtime*, because the primitive is the axis the self-model, the
 * findings and the patterns are all indexed on, and an axis a caller can extend
 * is an axis two readers eventually disagree about.
 *
 * ---------------------------------------------------------------------------
 * Why the finding kinds are two lists in one CHECK
 * ---------------------------------------------------------------------------
 *
 * A measured kind is a reading somebody could reproduce from the same capture:
 * a box outside its clipping parent, `elementFromPoint` answering somebody else
 * at a control's own centre, a contrast ratio below a floor. A judged kind is a
 * view: too many containers, the wrong thing emphasised, a density that does not
 * suit the material.
 *
 * They share one column because they are both findings about the same picture
 * and a reader wants them in one list. They are separated by `lane`, which is on
 * the row and never changes, and by `MEASURED_KINDS` / `JUDGED_KINDS` here,
 * which is what stops a worker's opinion arriving dressed as a measurement —
 * `submitJudgedFindings` refuses a judged submission that claims a measured
 * kind, because a view wearing a reading's name is the one thing in this kernel
 * that could not be argued with afterwards.
 */

/* -------------------------------------------------------------------------
 * The concerns
 * ---------------------------------------------------------------------- */

/**
 * Ten things every interface is either getting right or getting wrong.
 *
 * Chosen to be *orthogonal* rather than exhaustive: a finding should have one
 * obvious home, because the self-model counts findings per primitive and an axis
 * whose members overlap counts the same weakness twice and under-reports both.
 */
export const DESIGN_PRIMITIVES = [
  /** What is most important here, and does the page say so. */
  'INFORMATION_HIERARCHY',
  /** Where a person can go, and whether they can tell. */
  'NAVIGATION',
  /** What belongs with what, and whether the page groups it that way. */
  'GROUPING',
  /** Type: size, weight, measure, and what the scale is saying. */
  'TYPOGRAPHY',
  /** How much is on the screen, and how much room it has. */
  'DENSITY',
  /** Whether a thing that can be acted on looks and behaves like one. */
  'INTERACTION',
  /** What the interface says about what it is doing and what just happened. */
  'FEEDBACK',
  /** Whether it still works at the widths people actually hold. */
  'RESPONSIVENESS',
  /** Whether everybody can use it — contrast, target size, reachability. */
  'ACCESSIBILITY',
  /** What the eye is pulled to, and whether that is what matters. */
  'EMPHASIS',
] as const;
export type DesignPrimitive = (typeof DESIGN_PRIMITIVES)[number];

export function isDesignPrimitive(value: string): value is DesignPrimitive {
  return (DESIGN_PRIMITIVES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------
 * Findings
 * ---------------------------------------------------------------------- */

/**
 * Kinds a reading establishes. Reproducible from the capture, by anybody.
 *
 * `RESPONSIVE_REGRESSION` is here rather than in the judged list because it is
 * decided by comparing two captures of one surface at two widths, which is
 * arithmetic — not because breaking a layout is not also an aesthetic problem.
 */
export const MEASURED_KINDS = [
  'CONTENT_CLIPPED',
  'HORIZONTAL_OVERFLOW',
  'CONTROL_UNREACHABLE',
  'CONTROL_OVERLAPPED',
  'CONTENT_MISSING',
  'CONTRAST_BELOW_FLOOR',
  'TOUCH_TARGET_TOO_SMALL',
  'RESPONSIVE_REGRESSION',
  'EMPTY_STATE_MALFORMED',
] as const;

/**
 * Kinds only a reader of the screen can establish.
 *
 * `STATUS_CONTRADICTS_CONTROL` is the one this repository has paid for most
 * often: §29 records it three times — a briefing saying "you are not needed"
 * above an approval nothing could proceed without, a nav badge counting a
 * different fact from the list beside it, a card explaining that Brain would not
 * be asking directly above the control asking. It is a judgement because it
 * needs somebody to read both sentences and notice they disagree.
 */
export const JUDGED_KINDS = [
  'HIERARCHY_UNCLEAR',
  'EMPHASIS_MISPLACED',
  'DENSITY_WRONG',
  'GROUPING_INCOHERENT',
  'CONTAINER_NESTING_EXCESSIVE',
  'CONTROL_REDUNDANT',
  'STATUS_CONTRADICTS_CONTROL',
  'PURPOSE_MISMATCH',
] as const;

export const DESIGN_FINDING_KINDS = [...MEASURED_KINDS, ...JUDGED_KINDS] as const;
export type DesignFindingKind = (typeof DESIGN_FINDING_KINDS)[number];

export type MeasuredKind = (typeof MEASURED_KINDS)[number];
export type JudgedKind = (typeof JUDGED_KINDS)[number];

export function isMeasuredKind(value: string): value is MeasuredKind {
  return (MEASURED_KINDS as readonly string[]).includes(value);
}
export function isJudgedKind(value: string): value is JudgedKind {
  return (JUDGED_KINDS as readonly string[]).includes(value);
}

/**
 * Which concern each kind belongs under.
 *
 * A `Record` over the union rather than a `Map` with a default, so a kind added
 * later is a compile error until somebody says which concern it is about —
 * §27's `REFUSAL_WAIT` shape, and for its reason: two sets that must be total
 * between them are not, and the gap falls silently into whichever branch came
 * first.
 */
export const PRIMITIVE_OF_KIND: Record<DesignFindingKind, DesignPrimitive> = {
  CONTENT_CLIPPED: 'RESPONSIVENESS',
  HORIZONTAL_OVERFLOW: 'RESPONSIVENESS',
  CONTROL_UNREACHABLE: 'ACCESSIBILITY',
  CONTROL_OVERLAPPED: 'ACCESSIBILITY',
  CONTENT_MISSING: 'FEEDBACK',
  CONTRAST_BELOW_FLOOR: 'ACCESSIBILITY',
  TOUCH_TARGET_TOO_SMALL: 'ACCESSIBILITY',
  RESPONSIVE_REGRESSION: 'RESPONSIVENESS',
  EMPTY_STATE_MALFORMED: 'FEEDBACK',
  HIERARCHY_UNCLEAR: 'INFORMATION_HIERARCHY',
  EMPHASIS_MISPLACED: 'EMPHASIS',
  DENSITY_WRONG: 'DENSITY',
  GROUPING_INCOHERENT: 'GROUPING',
  CONTAINER_NESTING_EXCESSIVE: 'GROUPING',
  CONTROL_REDUNDANT: 'INTERACTION',
  STATUS_CONTRADICTS_CONTROL: 'FEEDBACK',
  PURPOSE_MISMATCH: 'INFORMATION_HIERARCHY',
};

export const DESIGN_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR', 'NIT'] as const;
export type DesignSeverity = (typeof DESIGN_SEVERITIES)[number];

/** Worst first, so a list can be ordered without a lookup table at each site. */
export const SEVERITY_RANK: Record<DesignSeverity, number> = {
  BLOCKER: 0,
  MAJOR: 1,
  MINOR: 2,
  NIT: 3,
};

export const DESIGN_LANES = ['MEASURED', 'JUDGED', 'OWNER'] as const;
export type DesignLane = (typeof DESIGN_LANES)[number];

export const DESIGN_FINDING_STATES = [
  'OPEN',
  'REPAIRED',
  'ACCEPTED',
  'WONT_FIX',
  'UNRESOLVED',
  'SUPERSEDED',
] as const;
export type DesignFindingState = (typeof DESIGN_FINDING_STATES)[number];

/* -------------------------------------------------------------------------
 * Scope — shared by corrections and patterns, on purpose
 * ---------------------------------------------------------------------- */

/**
 * How far a lesson reaches.
 *
 * One vocabulary for both tables because a correction becomes a pattern without
 * changing what it is about, and two scope ladders would mean a promotion had to
 * translate between them — which is exactly where a `COMPONENT` correction turns
 * into a `GLOBAL` rule by accident.
 */
export const DESIGN_SCOPES = ['ONE_OFF', 'COMPONENT', 'SCREEN', 'FACULTY', 'GLOBAL'] as const;
export type DesignScope = (typeof DESIGN_SCOPES)[number];

/** Narrowest first. A promotion may never move a lesson down this list. */
export const SCOPE_RANK: Record<DesignScope, number> = {
  ONE_OFF: 0,
  COMPONENT: 1,
  SCREEN: 2,
  FACULTY: 3,
  GLOBAL: 4,
};

/** Scopes that need something to point at. The other two are self-describing. */
export function scopeNeedsRef(scope: DesignScope): boolean {
  return scope !== 'ONE_OFF' && scope !== 'GLOBAL';
}

export const DESIGN_CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type DesignConfidence = (typeof DESIGN_CONFIDENCES)[number];

/* -------------------------------------------------------------------------
 * The self-model
 * ---------------------------------------------------------------------- */

export const DESIGN_ABILITY_STATES = ['ABSENT', 'PARTIAL', 'CONNECTED', 'LIVE'] as const;
export type DesignAbilityState = (typeof DESIGN_ABILITY_STATES)[number];

export const DESIGN_EVIDENCE_STATES = [
  'UNTESTED',
  'FAILING',
  'PASSING',
  'PRODUCTION_PROVEN',
] as const;
export type DesignEvidenceState = (typeof DESIGN_EVIDENCE_STATES)[number];

export const ABILITY_RANK: Record<DesignAbilityState, number> = {
  ABSENT: 0,
  PARTIAL: 1,
  CONNECTED: 2,
  LIVE: 3,
};

export const EVIDENCE_RANK: Record<DesignEvidenceState, number> = {
  UNTESTED: 0,
  FAILING: 1,
  PASSING: 2,
  PRODUCTION_PROVEN: 3,
};

/* -------------------------------------------------------------------------
 * Cycles, reviews, expansions
 * ---------------------------------------------------------------------- */

export const DESIGN_TRIGGERS = [
  'UI_IMPACT',
  'SURFACE_REGISTERED',
  'OWNER_REQUEST',
  'PROACTIVE_EXPANSION',
  'CORRECTION_FOLLOW_UP',
  'SCHEDULED',
] as const;
export type DesignTrigger = (typeof DESIGN_TRIGGERS)[number];

export const DESIGN_STOP_REASONS = [
  'SETTLED',
  'REPAIR_EXHAUSTED',
  'NO_RENDER_RUNTIME',
  'NEEDS_PERSON',
  'ABANDONED',
] as const;
export type DesignStopReason = (typeof DESIGN_STOP_REASONS)[number];

export const DESIGN_VERDICTS = ['CLEAN', 'CHANGES_REQUIRED', 'REFUSED'] as const;
export type DesignVerdict = (typeof DESIGN_VERDICTS)[number];

export const DESIGN_INDEPENDENCE_TIERS = [
  'NOT_APPLICABLE',
  'SESSION_SEPARATED',
  'ROUTINE_SEPARATED',
  'WORKER_SEPARATED',
  'ACCOUNT_SEPARATED',
] as const;
export type DesignIndependenceTier = (typeof DESIGN_INDEPENDENCE_TIERS)[number];

export const DESIGN_EXPANSION_ORIGINS = [
  'PROACTIVE',
  'FAILURE',
  'CORRECTION',
  'OWNER_REQUEST',
] as const;
export type DesignExpansionOrigin = (typeof DESIGN_EXPANSION_ORIGINS)[number];

export const DESIGN_EXPANSION_ROUTES = ['RESEARCH', 'SOFTWARE', 'READING', 'PERSON'] as const;
export type DesignExpansionRoute = (typeof DESIGN_EXPANSION_ROUTES)[number];

export const DESIGN_EXPANSION_STATES = [
  'IDENTIFIED',
  'ROUTED',
  'EVALUATED',
  'PROMOTED',
  'REJECTED',
  'PARKED',
] as const;
export type DesignExpansionState = (typeof DESIGN_EXPANSION_STATES)[number];

export const DESIGN_PATTERN_ORIGINS = ['SEED', 'RESEARCH', 'CORRECTION', 'OPERATION'] as const;
export type DesignPatternOrigin = (typeof DESIGN_PATTERN_ORIGINS)[number];

export const DESIGN_PATTERN_STATES = ['PROPOSED', 'ACTIVE', 'RETIRED'] as const;
export type DesignPatternState = (typeof DESIGN_PATTERN_STATES)[number];

/* -------------------------------------------------------------------------
 * View types
 * ---------------------------------------------------------------------- */

/** A precondition a harness knows how to satisfy, named rather than scripted. */
export const SURFACE_PRECONDITIONS = [
  'SIGNED_IN',
  'BRAIN_ADMINISTRATOR',
  'STANDING_AUTHORITY_GRANTED',
  'DECISION_OUTSTANDING',
  'PROJECT_EXISTS',
] as const;
export type SurfacePrecondition = (typeof SURFACE_PRECONDITIONS)[number];

/** How often a person does this, and what it costs them to have done it. */
export interface SurfaceAction {
  name: string;
  /** Roughly how often. Coarse on purpose: nobody has measured the exact rate. */
  frequency: 'CONSTANT' | 'REGULAR' | 'OCCASIONAL' | 'RARE';
  /** What undoing it takes. The input that decides how loud a control may be. */
  reversibility: 'FREE' | 'RECOVERABLE' | 'COSTLY' | 'IRREVERSIBLE';
  /** Whether this is the thing the screen exists for. */
  primary: boolean;
}

export interface SurfaceViewport {
  name: string;
  width: number;
  height: number;
}

export interface DesignSurface {
  id: string;
  surfaceKey: string;
  screen: string;
  stateKey: string;
  title: string;
  route: string;
  preconditions: SurfacePrecondition[];
  /** Brain's own nouns, so design work here is about the product it is in. */
  concepts: string[];
  actions: SurfaceAction[];
  viewports: SurfaceViewport[];
  faculty: string | null;
  registeredBy: string;
  retiredAt: string | null;
  retiredReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What was read in the page while it was on the screen. */
export interface CaptureReadings {
  /** The document scrolled sideways. §29's "the body must never" as a boolean. */
  horizontalOverflow: boolean;
  /** Elements outside a parent that clips rather than scrolls. */
  clipped: string[];
  /** Elements sticking out past the viewport, with where. */
  offenders: string[];
  /** Controls a thumb cannot land on, asked with `elementFromPoint`. */
  unreachable: string[];
  /** Pairs of absolutely-placed siblings painted over each other. */
  overlaps: string[];
  /** Interactive boxes smaller than the touch floor. */
  smallTargets: string[];
  /** Text whose computed contrast is under the floor, with the ratio. */
  lowContrast: string[];
  /** Chrome destinations a person can actually press right now. */
  reachableControls: string[];
  /** How deep the container nesting goes, and where. A judged input. */
  deepestNesting: { depth: number; where: string } | null;
  /** Counts a judged reviewer needs and cannot get from an image. */
  counts: { interactive: number; headings: number; landmarks: number; textNodes: number };
  /** The page's own heading outline, in order. The hierarchy, as the DOM has it. */
  outline: { level: number; text: string }[];
  /**
   * A reader that could not run at all, so an incomplete reading looks like one.
   *
   * §9's distinction, and it is load-bearing: a capture whose contrast reader
   * threw has no contrast findings, and reporting that as *the contrast is fine*
   * is the false confidence the whole engine exists to prevent. `evaluate.ts`
   * refuses to call a surface clean while this is non-empty.
   */
  unreadable: string[];
  /**
   * A reader that ran and could not answer about *some* elements.
   *
   * Separate from `unreadable`, and the separation was a correction rather than
   * a design: the contrast reader reports every element with no opaque backdrop
   * — text over an image or a gradient — and putting that on `unreadable` meant
   * a real page could never be called clean, because there is always one. A bar
   * with no way over it is a park rather than a standard (§24), so this is
   * reported beside the findings and blocks nothing.
   */
  partial: string[];
}

export interface DesignCapture {
  id: string;
  cycleId: string | null;
  pass: number;
  surfaceKey: string;
  screen: string;
  stateKey: string;
  viewportName: string;
  width: number;
  height: number;
  revision: string | null;
  treeDirty: boolean;
  contentHash: string;
  byteSize: number;
  artifactRef: string;
  engine: string;
  engineVersion: string | null;
  readings: CaptureReadings;
  capturedAt: string;
  createdAt: string;
}

export interface DesignFinding {
  id: string;
  cycleId: string | null;
  reviewId: string | null;
  captureId: string;
  pass: number;
  surfaceKey: string;
  region: string;
  lane: DesignLane;
  kind: DesignFindingKind;
  primitive: DesignPrimitive;
  statement: string;
  whyItMatters: string;
  severity: DesignSeverity;
  evidence: Record<string, unknown>;
  proposedRepair: string;
  state: DesignFindingState;
  resolvedBy: string | null;
  resolution: string | null;
  patternId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DesignReview {
  id: string;
  cycleId: string;
  pass: number;
  lane: 'MEASURED' | 'JUDGED';
  captureDigest: string;
  captureCount: number;
  binId: string | null;
  workerId: string | null;
  sessionRef: string | null;
  accountId: string | null;
  routineId: string | null;
  independenceTier: DesignIndependenceTier | null;
  verdict: DesignVerdict;
  detail: string | null;
  findingsCount: number;
  createdAt: string;
}

export interface DesignCycle {
  id: string;
  triggerKind: DesignTrigger;
  triggerRef: string | null;
  surfaceKeys: string[];
  revision: string | null;
  passes: number;
  state: 'OPEN' | 'CLOSED';
  stopReason: DesignStopReason | null;
  stopDetail: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface DesignCorrection {
  id: string;
  surfaceKey: string | null;
  beforeCaptureId: string | null;
  afterCaptureId: string | null;
  correction: string;
  components: string[];
  lesson: string | null;
  scope: DesignScope;
  scopeRef: string | null;
  confidence: DesignConfidence;
  recordedByUserId: string;
  promotedPatternId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DesignPattern {
  id: string;
  primitive: DesignPrimitive;
  branch: string | null;
  statement: string;
  appliesWhen: string;
  exceptions: string | null;
  scope: DesignScope;
  scopeRef: string | null;
  confidence: DesignConfidence;
  origin: DesignPatternOrigin;
  evidence: string[];
  state: DesignPatternState;
  retiredReason: string | null;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesignCapability {
  id: string;
  capabilityKey: string;
  title: string;
  primitive: DesignPrimitive;
  abilityState: DesignAbilityState;
  evidenceState: DesignEvidenceState;
  route: string | null;
  evaluationMethod: string | null;
  limitations: string[];
  evidence: string[];
  observations: number;
  failures: number;
  createdAt: string;
  updatedAt: string;
}

export interface DesignExpansion {
  id: string;
  capabilityKey: string;
  origin: DesignExpansionOrigin;
  statement: string;
  why: string;
  rankInputs: Record<string, unknown>;
  rank: number;
  route: DesignExpansionRoute;
  routeRef: string | null;
  state: DesignExpansionState;
  outcome: string | null;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
}
