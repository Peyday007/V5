/**
 * The seven values an opportunity can be said to have, and the one rule about
 * which of them may count toward a goal.
 *
 * Advertised value, market size, a published award, a buyer's budget, a resale
 * asking price and an unagreed commission are all real numbers somebody
 * published. None of them is money anyone owes us, so none of them counts.
 */
export const VALUE_LAYERS = [
  'ADVERTISED_VALUE',
  'TRANSACTION_EVIDENCE',
  'BUYER_DEMAND',
  'ACCESSIBILITY',
  'COST_AND_CAPITAL',
  'REALISTIC_REVENUE',
  'LEDGER',
] as const;
export type ValueLayer = (typeof VALUE_LAYERS)[number];

export const LAYER_STATUSES = ['VERIFIED', 'ESTIMATE', 'UNKNOWN'] as const;
export type LayerStatus = (typeof LAYER_STATUSES)[number];

export interface ValueLayerReading {
  id: string;
  projectId: string;
  opportunityId: string;
  layer: ValueLayer;
  status: LayerStatus;
  amountCents: number | null;
  currency: string | null;
  source: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValueLayerRow {
  id: string;
  project_id: string;
  opportunity_id: string;
  layer: string;
  status: string;
  amount_cents: number | null;
  currency: string | null;
  source: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}
