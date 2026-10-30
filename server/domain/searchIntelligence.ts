/**
 * Search intelligence: what Brain has learned exists, how to find it, and what
 * a method has earned from measured results. Trust is derived from runs and is
 * never declared by the method's author.
 */
export const SEARCH_SCOPES = ['PROJECT', 'USER', 'GENERAL'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const METHOD_TRUST_STATES = ['PROPOSED', 'TESTING', 'PROVEN', 'DEMOTED', 'RETIRED'] as const;
export type MethodTrustState = (typeof METHOD_TRUST_STATES)[number];

export const RUN_EXECUTORS = ['CODE', 'CHEAP_LANE', 'CLAUDE'] as const;
export type RunExecutor = (typeof RUN_EXECUTORS)[number];

/** Source unavailable, nothing suitable and too many false positives are three different facts. */
export const RUN_OUTCOMES = ['RUNNING', 'FOUND', 'NOTHING_SUITABLE', 'SOURCE_UNAVAILABLE', 'TOO_MANY_FALSE_POSITIVES', 'ERROR'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const DETECTOR_MODES = ['SHADOW', 'ACTIVE', 'DEMOTED'] as const;
export type DetectorMode = (typeof DETECTOR_MODES)[number];

export const EXAMPLE_LABELS = ['POSITIVE', 'NEGATIVE'] as const;
export type ExampleLabel = (typeof EXAMPLE_LABELS)[number];

/** Who is asking; every read is filtered by it. */
export interface SearchViewer {
  projectIds: readonly string[];
  userId: string | null;
}

export interface LearnedSubject {
  id: string;
  scope: SearchScope;
  projectId: string | null;
  ownerUserId: string | null;
  subjectKey: string;
  label: string;
  description: string | null;
  origin: string;
  sourceRef: string | null;
  state: 'ACTIVE' | 'RETIRED';
  createdAt: string;
  updatedAt: string;
}

export interface SearchMethod {
  id: string;
  scope: SearchScope;
  projectId: string | null;
  ownerUserId: string | null;
  subjectId: string | null;
  name: string;
  finds: string;
  usefulWhen: string | null;
  sources: string[];
  requiredInputs: string[];
  queryFilter: string | null;
  checkProcedure: string | null;
  observedLimits: string[];
  trustState: MethodTrustState;
  trustReason: string | null;
  trustChangedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SearchMethodRun {
  id: string;
  methodId: string;
  methodVersion: number;
  executor: RunExecutor;
  startedAt: string;
  finishedAt: string | null;
  itemsExamined: number;
  itemsFound: number;
  itemsAccepted: number;
  falsePositives: number;
  outcome: RunOutcome;
  failureNote: string | null;
}

export interface LearnedDetector {
  id: string;
  methodId: string | null;
  scope: SearchScope;
  projectId: string | null;
  ownerUserId: string | null;
  ruleKey: string;
  version: number;
  definition: unknown;
  mode: DetectorMode;
  threshold: number;
  modeReason: string | null;
  modeChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DetectorExample {
  id: string;
  detectorId: string;
  itemRef: string;
  label: ExampleLabel;
  predicted: boolean;
  labelledBy: string;
  createdAt: string;
}

/** The key that makes one scope's rows unique without NULLs in a unique index. */
export function scopeKeyFor(scope: SearchScope, projectId: string | null, ownerUserId: string | null): string {
  if (scope === 'PROJECT') {
    if (!projectId) throw new Error('A PROJECT-scoped row names its project.');
    return `P:${projectId}`;
  }
  if (scope === 'USER') {
    if (!ownerUserId) throw new Error('A USER-scoped row names its user.');
    return `U:${ownerUserId}`;
  }
  return 'GENERAL';
}

/** May this viewer read a row of this scope? */
export function mayRead(
  viewer: SearchViewer,
  row: { scope: SearchScope; projectId: string | null; ownerUserId: string | null },
): boolean {
  if (row.scope === 'GENERAL') return true;
  if (row.scope === 'PROJECT') return row.projectId !== null && viewer.projectIds.includes(row.projectId);
  return row.ownerUserId !== null && row.ownerUserId === viewer.userId;
}
