/**
 * Combined signals, kept possibilities and stage measurements.
 *
 * A combined signal is always a SIGNAL. Nothing here confirms demand.
 */
export const SIGNAL_SUBJECT_KINDS = ['ORGANISATION', 'PLACE'] as const;
export type SignalSubjectKind = (typeof SIGNAL_SUBJECT_KINDS)[number];

export const POSSIBILITY_STATES = ['KEPT', 'RECONSIDER', 'ADOPTED', 'RETIRED'] as const;
export type PossibilityState = (typeof POSSIBILITY_STATES)[number];

export const POSSIBILITY_RELATIONS = ['REQUIRES', 'ENABLES', 'UNLOCKS_AFTER', 'SUPPLIES', 'COMPLEMENTS', 'CONFLICTS'] as const;
export type PossibilityRelation = (typeof POSSIBILITY_RELATIONS)[number];

export const MEASUREMENT_STAGES = [
  'CODE_SCREEN', 'TARGETED_INVESTIGATION', 'PLAN_CONSTRUCTION', 'DEEP_REASONING', 'EXECUTION',
] as const;
export type MeasurementStage = (typeof MEASUREMENT_STAGES)[number];

/** What a possibility needs before it could be done. Open: unknown keys are kept. */
export interface PossibilityRequirements {
  capital?: string;
  customers?: string;
  time?: string;
  skills?: string[];
  workers?: string[];
  equipment?: string[];
  permissions?: string[];
  geography?: string;
  suppliers?: string[];
  priorGoals?: string[];
  [other: string]: unknown;
}

export interface CombinedSignal {
  id: string;
  projectId: string;
  ownerUserId: string | null;
  subjectKind: SignalSubjectKind;
  subjectKey: string;
  patternKey: string;
  memberDetectionIds: string[];
  industryNodeId: string | null;
  possibleNeed: string | null;
  captureMethods: string[];
  label: 'SIGNAL';
  createdAt: string;
}

export interface CombinedSignalRow {
  id: string;
  project_id: string;
  owner_user_id: string | null;
  subject_kind: string;
  subject_key: string;
  pattern_key: string;
  member_detection_ids: string;
  industry_node_id: string | null;
  possible_need: string | null;
  capture_methods: string;
  label: string;
  created_at: string;
}

export interface Possibility {
  id: string;
  projectId: string;
  ownerUserId: string;
  title: string;
  requirements: PossibilityRequirements;
  state: PossibilityState;
  originRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PossibilityRow {
  id: string;
  project_id: string;
  owner_user_id: string;
  title: string;
  requirements: string;
  state: string;
  origin_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface PossibilityEdge {
  id: string;
  projectId: string;
  ownerUserId: string;
  fromId: string;
  toId: string;
  relation: PossibilityRelation;
  createdAt: string;
}

export interface PossibilityEdgeRow {
  id: string;
  project_id: string;
  owner_user_id: string;
  from_id: string;
  to_id: string;
  relation: string;
  created_at: string;
}

export interface PossibilityCondition {
  id: string;
  possibilityId: string;
  projectId: string;
  ownerUserId: string;
  conditionKey: string;
  detail: string | null;
  metAt: string | null;
  metChangeRef: string | null;
  createdAt: string;
}

export interface PossibilityConditionRow {
  id: string;
  possibility_id: string;
  project_id: string;
  owner_user_id: string;
  condition_key: string;
  detail: string | null;
  met_at: string | null;
  met_change_ref: string | null;
  created_at: string;
}

export interface StageMeasurement {
  id: string;
  projectId: string;
  ownerUserId: string;
  goalId: string;
  stage: MeasurementStage;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  screened: number;
  rejected: number;
  advanced: number;
  researchJobs: number;
  premiumAiJobs: number;
  relevantOpenings: number;
  supportedPlans: number;
  bottleneck: string | null;
  createdAt: string;
}

export interface StageMeasurementRow {
  id: string;
  project_id: string;
  owner_user_id: string;
  goal_id: string;
  stage: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  screened: number;
  rejected: number;
  advanced: number;
  research_jobs: number;
  premium_ai_jobs: number;
  relevant_openings: number;
  supported_plans: number;
  bottleneck: string | null;
  created_at: string;
}
