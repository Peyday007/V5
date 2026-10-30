/**
 * How money is made, as typed relationships and open-set variables.
 *
 * Every fact carries how well it is known. An UNKNOWN is a recorded answer and
 * is never a favourable value; a VERIFIED fact names the claim that states it,
 * and an ESTIMATE names its basis.
 */
export const EVIDENCE_STATUSES = ['VERIFIED', 'ESTIMATE', 'UNKNOWN'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const OPERATOR_KINDS = ['ESTABLISHED_OPERATOR', 'REPRODUCIBLE_BY_NEW_OPERATOR'] as const;
export type OperatorKind = (typeof OPERATOR_KINDS)[number];

export const ECONOMIC_RELATIONS = ['SUPPLIES', 'BUYS_FROM', 'ENABLES', 'REQUIRES', 'COMPLEMENTS', 'COMPETES'] as const;
export type EconomicRelation = (typeof ECONOMIC_RELATIONS)[number];

export const ENDPOINT_KINDS = ['NODE', 'ACTIVITY'] as const;
export type EndpointKind = (typeof ENDPOINT_KINDS)[number];

/** Names Brain recognises; the set is open, so any other name is stored as written. */
export const KNOWN_VARIABLES = [
  'revenue_per_transaction', 'margin', 'acquisition_cost', 'acquisition_time_days', 'conversion',
  'demand_volume', 'frequency', 'completion_time_days', 'capacity', 'failure_rate', 'refund_rate',
  'upfront_capital', 'money_tied_up', 'payment_timing_days', 'repeat_rate',
  'required_skills', 'required_equipment', 'required_permissions',
] as const;

export interface EconomicEdge {
  id: string;
  projectId: string;
  ownerUserId: string | null;
  fromKind: EndpointKind;
  fromId: string;
  toKind: EndpointKind;
  toId: string;
  relation: EconomicRelation;
  status: EvidenceStatus;
  sourceClaimId: string | null;
  basis: string | null;
  operatorKind: OperatorKind | null;
  createdAt: string;
  retiredAt: string | null;
}

export interface EconomicEdgeRow {
  id: string;
  project_id: string;
  owner_user_id: string | null;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  relation: string;
  status: string;
  source_claim_id: string | null;
  basis: string | null;
  operator_kind: string | null;
  created_at: string;
  retired_at: string | null;
}

export interface ActivityVariable {
  id: string;
  projectId: string;
  ownerUserId: string | null;
  activityId: string;
  name: string;
  valueNumber: number | null;
  valueText: string | null;
  unit: string | null;
  status: EvidenceStatus;
  sourceClaimId: string | null;
  basis: string | null;
  operatorKind: OperatorKind;
  createdAt: string;
  supersededAt: string | null;
}

export interface ActivityVariableRow {
  id: string;
  project_id: string;
  owner_user_id: string | null;
  activity_id: string;
  name: string;
  value_number: number | null;
  value_text: string | null;
  unit: string | null;
  status: string;
  source_claim_id: string | null;
  basis: string | null;
  operator_kind: string;
  created_at: string;
  superseded_at: string | null;
}

/** The evidence rule shared by edges and variables, checked before the database is. */
export function evidenceProblem(input: {
  status: EvidenceStatus;
  sourceClaimId?: string | null;
  basis?: string | null;
}): string | null {
  if (input.status === 'VERIFIED' && !input.sourceClaimId) return 'A VERIFIED fact must name the claim that states it.';
  if (input.status === 'ESTIMATE' && !input.basis?.trim()) return 'An ESTIMATE must state its basis.';
  return null;
}
