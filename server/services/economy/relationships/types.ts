/**
 * Economic relationships between industry nodes and activities, and the
 * per-activity variables an arrangement rests on.
 *
 * Pure data and pure functions: nothing here reads a row, so it extends the
 * industry kernel's graph without becoming a second one. A caller hands in
 * what the kernel holds and gets back readings; goalScenario.ts remains the
 * only calculator.
 */
import type { SourceRef } from '../../../domain/scenario.ts';

export const RELATIONSHIP_KINDS = ['SUPPLIES', 'BUYS_FROM', 'ENABLES', 'REQUIRES', 'COMPLEMENTS', 'COMPETES_WITH'] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

/** Whether a figure was read from a source, reasoned to, or is not known. */
export const VARIABLE_STATES = ['VERIFIED', 'ESTIMATE', 'UNKNOWN'] as const;
export type VariableState = (typeof VARIABLE_STATES)[number];

/** Whose economics a figure describes. */
export const OPERATOR_BASES = ['ESTABLISHED_OPERATOR', 'REPRODUCIBLE_BY_NEW_OPERATOR'] as const;
export type OperatorBasis = (typeof OPERATOR_BASES)[number];

/** A node in the industry graph or an activity inside one. */
export interface EconomicSubject {
  kind: 'INDUSTRY_NODE' | 'ACTIVITY';
  id: string;
}

export interface EconomicRelationship {
  id: string;
  kind: RelationshipKind;
  from: EconomicSubject;
  to: EconomicSubject;
  state: VariableState;
  /** A claim or document for VERIFIED; the basis in `basis` for ESTIMATE. */
  source: SourceRef | null;
  basis: string | null;
}

/**
 * The keys the goal model reads today. The set of variables is open: any other
 * key is carried and compared, it just is not consumed by the model yet.
 */
export const CONSUMED_VARIABLES = ['price', 'capital', 'hours', 'daysToCash', 'close', 'directCost'] as const;
export type ConsumedVariable = (typeof CONSUMED_VARIABLES)[number];

export interface ActivityVariable {
  activityId: string;
  /** Open set: 'price', 'marginPct', 'refundRate', 'requiredPermission'... */
  key: string;
  state: VariableState;
  /** Major units of the goal currency, days, hours or a 0-1 rate per key. */
  value: number | null;
  low: number | null;
  high: number | null;
  source: SourceRef | null;
  basis: string | null;
  operatorBasis: OperatorBasis;
}

export interface Arrangement {
  /** direct sale, brokerage, subcontract, referral, resale, ... */
  key: string;
  /** What underlying need it serves; arrangements compare only on the same need. */
  needId: string;
  activityId: string;
}
