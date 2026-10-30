/** Search intelligence: learned subjects, search methods and their trust, learned detectors. */
export const SEARCH_SCOPES = ['PROJECT', 'USER', 'GENERAL'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const TRUST_STATES = ['PROPOSED', 'TESTING', 'PROVEN', 'DEMOTED', 'RETIRED'] as const;
export type TrustState = (typeof TRUST_STATES)[number];

export const METHOD_FAILURE_CAUSES = ['SOURCE_UNAVAILABLE', 'NO_SUITABLE_RESULTS', 'HIGH_FALSE_POSITIVES', 'STALE'] as const;
export type MethodFailureCause = (typeof METHOD_FAILURE_CAUSES)[number];

export const DETECTOR_MODES = ['SHADOW', 'ACTIVE'] as const;
export type DetectorMode = (typeof DETECTOR_MODES)[number];

export interface LearnedSubject {
  id: string;
  projectId: string | null;
  userId: string | null;
  scope: SearchScope;
  targetKind: string;
  name: string;
  source: string;
  discoveredBy: string | null;
  createdAt: string;
}

export interface SearchMethod {
  id: string;
  subjectId: string | null;
  projectId: string | null;
  userId: string | null;
  scope: SearchScope;
  name: string;
  finds: string;
  usefulWhen: string | null;
  sources: string[];
  requiredInputs: string[];
  queryFilter: string | null;
  checkProcedure: string | null;
  observedLimits: string | null;
  trustState: TrustState;
  pausedUntil: string | null;
  pauseCause: MethodFailureCause | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchMethodRun {
  id: string;
  methodId: string;
  ranAt: string;
  relevant: number;
  verified: number;
  duplicates: number;
  falsePositives: number;
  searchMs: number | null;
  aiJobsUsed: number;
  aiJobsAvoided: number;
  validatedOpportunities: number;
  failureCause: MethodFailureCause | null;
  note: string | null;
}

export interface LearnedDetector {
  id: string;
  methodId: string | null;
  name: string;
  definition: string;
  mode: DetectorMode;
  precisionThreshold: number;
  createdAt: string;
  updatedAt: string;
}

/** A subject's identity: case and spacing only, so two spellings are one subject. */
export function subjectKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
