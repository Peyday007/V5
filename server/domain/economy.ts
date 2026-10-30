/**
 * How money is made: typed relationships between industry nodes and activities,
 * and an open set of economic variables per activity. A figure is VERIFIED only
 * with the claim it was read from, an ESTIMATE only with its basis stated, and
 * otherwise UNKNOWN. Nothing here is a probability.
 */
export const ECONOMIC_RELATIONS = ['SUPPLIES', 'BUYS_FROM', 'ENABLES', 'REQUIRES', 'COMPLEMENTS', 'COMPETES'] as const;
export type EconomicRelation = (typeof ECONOMIC_RELATIONS)[number];

export const EDGE_ENDPOINT_KINDS = ['NODE', 'ACTIVITY'] as const;
export type EdgeEndpointKind = (typeof EDGE_ENDPOINT_KINDS)[number];

export const EVIDENCE_STATUSES = ['VERIFIED', 'ESTIMATE', 'UNKNOWN'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** Whether the figure holds for somebody already in the business or for a newcomer. */
export const OPERATOR_KINDS = ['ESTABLISHED_OPERATOR', 'REPRODUCIBLE_BY_NEW_OPERATOR'] as const;
export type OperatorKind = (typeof OPERATOR_KINDS)[number];

export const MEASUREMENT_STAGES = ['CODE_SCREEN', 'TARGETED_INVESTIGATION', 'SIMULATION', 'DEEP_REASONING', 'EXECUTION'] as const;
export type MeasurementStage = (typeof MEASUREMENT_STAGES)[number];

/** Who is asking: a project, and a user whose private rows may be read. */
export interface EconomyViewer {
  projectId: string;
  userId: string | null;
}

export interface EconomicEdge {
  id: string; projectId: string; ownerUserId: string | null;
  fromKind: EdgeEndpointKind; fromRef: string; relation: EconomicRelation;
  toKind: EdgeEndpointKind; toRef: string;
  status: EvidenceStatus; claimId: string | null; basis: string | null;
  operatorKind: OperatorKind; createdAt: string;
}

export interface ActivityVariable {
  id: string; projectId: string; ownerUserId: string | null; activityRef: string; name: string;
  valueNum: number | null; valueText: string | null; unit: string | null;
  status: EvidenceStatus; claimId: string | null; basis: string | null;
  operatorKind: OperatorKind; createdAt: string; updatedAt: string;
}

export interface StageMeasurement {
  id: string; projectId: string; ownerUserId: string | null; goalId: string; stage: MeasurementStage;
  /** Null means not measured; zero means measured as zero. */
  durationMs: number | null; screened: number | null; rejected: number | null; advanced: number | null;
  researchJobs: number | null; premiumJobs: number | null; note: string | null; recordedAt: string;
}

/** Why a status is not supported by what accompanies it, or null when it is. */
export function evidenceProblem(input: { status: EvidenceStatus; claimId?: string | null; basis?: string | null }): string | null {
  if (input.status === 'VERIFIED' && !input.claimId) return 'A VERIFIED figure names the claim it was read from.';
  if (input.status === 'ESTIMATE' && !input.basis?.trim()) return 'An ESTIMATE states its basis.';
  return null;
}
