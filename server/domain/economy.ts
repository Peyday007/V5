/**
 * Economic relationships and per-activity variables.
 *
 * The variable name is an open set on purpose; the evidence status is not.
 * `VERIFIED` names a gated claim, `ESTIMATE` states its basis, and `UNKNOWN`
 * carries no value — an unknown is never a favourable assumption.
 */
export const ECONOMIC_RELATIONS = [
  'SUPPLIES', 'BUYS_FROM', 'ENABLES', 'REQUIRES', 'COMPLEMENTS', 'COMPETES',
] as const;
export type EconomicRelation = (typeof ECONOMIC_RELATIONS)[number];

export const EVIDENCE_STATUSES = ['VERIFIED', 'ESTIMATE', 'UNKNOWN'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const OPERATOR_KINDS = ['ESTABLISHED_OPERATOR', 'REPRODUCIBLE_BY_NEW_OPERATOR'] as const;
export type OperatorKind = (typeof OPERATOR_KINDS)[number];

export type EndpointKind = 'NODE' | 'ACTIVITY';

export interface EconomicEdge {
  id: string;
  projectId: string;
  fromKind: EndpointKind;
  fromRef: string;
  toKind: EndpointKind;
  toRef: string;
  relation: EconomicRelation;
  status: EvidenceStatus;
  sourceClaimId: string | null;
  basis: string | null;
  operatorKind: OperatorKind;
  createdAt: string;
}

export interface ActivityVariable {
  id: string;
  projectId: string;
  activityRef: string;
  name: string;
  value: number | null;
  unit: string | null;
  status: EvidenceStatus;
  sourceClaimId: string | null;
  basis: string | null;
  operatorKind: OperatorKind;
  createdAt: string;
}

export const STAGES = [
  'CODE_SCREEN', 'TARGETED_INVESTIGATION', 'PLAN_CONSTRUCTION', 'DEEP_REASONING', 'EXECUTION',
] as const;
export type Stage = (typeof STAGES)[number];

export interface StageMeasurement {
  id: string;
  projectId: string;
  ownerUserId: string;
  goalId: string;
  stage: Stage;
  durationMs: number;
  screened: number;
  rejected: number;
  advanced: number;
  researchJobs: number;
  premiumAiJobs: number;
  note: string | null;
  measuredAt: string;
}

export const POSSIBILITY_KINDS = ['OPPORTUNITY', 'ACTIVITY', 'VENTURE'] as const;
export type PossibilityKind = (typeof POSSIBILITY_KINDS)[number];

export const POSSIBILITY_RELATIONS = [
  'REQUIRES', 'ENABLES', 'UNLOCKS_AFTER', 'SUPPLIES', 'COMPLEMENTS', 'CONFLICTS',
] as const;
export type PossibilityRelation = (typeof POSSIBILITY_RELATIONS)[number];

/** Requirement categories are open-ended; these are the ones the brief names. */
export interface PossibilityRequirements {
  capital?: string[]; customers?: string[]; time?: string[]; skills?: string[];
  workers?: string[]; equipment?: string[]; permissions?: string[];
  geography?: string[]; suppliers?: string[]; priorGoals?: string[];
  [other: string]: string[] | undefined;
}

export interface Possibility {
  id: string;
  projectId: string;
  ownerUserId: string;
  kind: PossibilityKind;
  title: string;
  requirements: PossibilityRequirements;
  sourceRef: string | null;
  parkedReason: string | null;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PossibilityEdge {
  id: string;
  projectId: string;
  fromId: string;
  toId: string;
  relation: PossibilityRelation;
  createdAt: string;
}

export interface PossibilityCondition {
  id: string;
  projectId: string;
  possibilityId: string;
  conditionKey: string;
  createdAt: string;
  triggeredAt: string | null;
  triggerChangeRef: string | null;
}

/** Refuses a variable or edge whose status does not match its evidence. */
export function evidenceProblem(input: {
  status: EvidenceStatus;
  sourceClaimId?: string | null;
  basis?: string | null;
  value?: number | null;
}): string | null {
  if (input.status === 'VERIFIED' && !input.sourceClaimId) return 'A VERIFIED reading must name its claim.';
  if (input.status === 'ESTIMATE' && !input.basis?.trim()) return 'An ESTIMATE must state its basis.';
  if (input.value !== undefined) {
    if (input.status === 'UNKNOWN' && input.value !== null) return 'An UNKNOWN reading carries no value.';
    if (input.status !== 'UNKNOWN' && (input.value === null || !Number.isFinite(input.value))) {
      return 'A VERIFIED or ESTIMATE reading needs a finite value.';
    }
  }
  return null;
}
