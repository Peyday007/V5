/** Vocabulary for search intelligence. Trust is earned from measured runs, never declared. */
export const SEARCH_SCOPES = ['PROJECT', 'USER', 'GENERAL'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const TRUST_STATES = ['PROPOSED', 'TESTING', 'PROVEN', 'DEMOTED', 'RETIRED'] as const;
export type TrustState = (typeof TRUST_STATES)[number];

/** Why a run produced nothing useful - three facts that must stay apart. */
export const RUN_OUTCOMES = ['FOUND', 'NOTHING_SUITABLE', 'SOURCE_UNAVAILABLE', 'TOO_MANY_FALSE_POSITIVES'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const DETECTOR_MODES = ['SHADOW', 'ACTIVE'] as const;
export type DetectorMode = (typeof DETECTOR_MODES)[number];

/** Who is asking; a read returns GENERAL rows plus the asker's own, nothing else. */
export interface SearchViewer {
  projectId?: string | null;
  userId?: string | null;
}

export interface LearnedSubject {
  id: string; scope: SearchScope; projectId: string | null; userId: string | null;
  subject: string; learnedFrom: string | null; createdAt: string;
}

export interface SearchMethod {
  id: string; scope: SearchScope; projectId: string | null; userId: string | null;
  name: string; finds: string; usefulWhen: string | null; sources: string[]; requiredInputs: string[];
  queryFilter: string | null; checkProcedure: string | null; observedLimits: string | null;
  trustState: TrustState; createdAt: string; updatedAt: string;
}

export interface SearchMethodRun {
  id: string; methodId: string; projectId: string | null; startedAt: string; finishedAt: string | null;
  examined: number | null; kept: number | null; falsePositives: number | null;
  outcome: RunOutcome | null; failureCause: string | null;
}

export interface LearnedDetector {
  id: string; methodId: string | null; scope: SearchScope; projectId: string | null; userId: string | null;
  definition: Record<string, unknown>; version: number; mode: DetectorMode; threshold: number | null;
  createdAt: string; updatedAt: string;
}

/** The owner a scope requires: one key for a private scope, none for GENERAL. */
export function scopeOwnerError(scope: SearchScope, projectId: string | null | undefined, userId: string | null | undefined): string | null {
  if (scope === 'PROJECT') return projectId && !userId ? null : 'A PROJECT row needs a project and no user.';
  if (scope === 'USER') return userId && !projectId ? null : 'A USER row needs a user and no project.';
  return !projectId && !userId ? null : 'A GENERAL row names neither a project nor a user.';
}
