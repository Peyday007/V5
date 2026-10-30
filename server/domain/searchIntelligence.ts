/**
 * Search intelligence vocabulary: what a learned subject, a search method, a
 * method run and a learned detector may say, in closed sets.
 */

export const SEARCH_SCOPES = ['PROJECT', 'USER', 'GENERAL'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const METHOD_TRUST_STATES = ['PROPOSED', 'TESTING', 'PROVEN', 'DEMOTED', 'RETIRED'] as const;
export type MethodTrustState = (typeof METHOD_TRUST_STATES)[number];

export const RUN_EXECUTORS = ['CODE', 'CHEAP_LANE', 'CLAUDE'] as const;
export type RunExecutor = (typeof RUN_EXECUTORS)[number];

/** Three different facts about a search that returned nothing useful. */
export const RUN_OUTCOMES = ['FOUND', 'NOTHING_SUITABLE', 'SOURCE_UNAVAILABLE', 'FALSE_POSITIVES', 'ERROR'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const DETECTOR_MODES = ['SHADOW', 'ACTIVE'] as const;
export type DetectorMode = (typeof DETECTOR_MODES)[number];

export const EXAMPLE_VERDICTS = ['CONFIRMED', 'REJECTED'] as const;
export type ExampleVerdict = (typeof EXAMPLE_VERDICTS)[number];

/** Who is asking: reads return only rows this reader may see. */
export interface SearchReader {
  projectIds: readonly string[];
  userId: string | null;
}

/** Where a row lives. GENERAL names neither a project nor a user. */
export interface ScopeRef {
  scope: SearchScope;
  projectId?: string | null;
  userId?: string | null;
}

export function scopeProblem(ref: ScopeRef): string | null {
  const project = ref.projectId ?? null;
  const user = ref.userId ?? null;
  if (ref.scope === 'PROJECT') return project ? null : 'A PROJECT-scoped row must name its project.';
  if (ref.scope === 'USER') return user ? null : 'A USER-scoped row must name its user.';
  return project || user ? 'A GENERAL row must name neither a project nor a user.' : null;
}

export interface LearnedSubject {
  id: string;
  scope: SearchScope;
  projectId: string | null;
  userId: string | null;
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
  userId: string | null;
  methodKey: string;
  subjectId: string | null;
  finds: string;
  usefulWhen: string | null;
  sources: string[];
  requiredInputs: string[];
  query: string | null;
  checkProcedure: string;
  limits: string | null;
  trustState: MethodTrustState;
  trustReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SearchMethodRun {
  id: string;
  methodId: string;
  executor: RunExecutor;
  outcome: RunOutcome;
  failureCause: string | null;
  examined: number;
  surfaced: number;
  confirmed: number;
  rejected: number;
  startedAt: string;
  finishedAt: string;
}

export interface LearnedDetector {
  id: string;
  scope: SearchScope;
  projectId: string | null;
  userId: string | null;
  methodId: string | null;
  detectorKey: string;
  version: number;
  definition: unknown;
  mode: DetectorMode;
  threshold: number;
  createdAt: string;
  updatedAt: string;
}

export interface DetectorExample {
  id: string;
  detectorId: string;
  itemRef: string;
  fired: boolean;
  verdict: ExampleVerdict;
  labelledBy: string;
  createdAt: string;
}
