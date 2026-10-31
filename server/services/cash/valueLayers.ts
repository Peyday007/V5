/**
 * What may count toward a goal, read from the separated value layers.
 *
 * Two layers can count: the ledger (money agreed or received, VERIFIED only)
 * and realistic revenue — and realistic revenue counts only while something
 * supports it, a recorded completed transaction or present buyer demand that
 * is itself sourced and not UNKNOWN. A realistic figure written with nothing
 * behind it is reported as unsupported and contributes zero, so a large
 * advertised price cannot become achievable revenue by being copied into the
 * wrong row. The layers are never added into one number here: the result keeps
 * them apart so a reader can see what each contributed and why.
 */
import type { LayerStatus, ValueLayer, ValueLayerReading } from '../../domain/cashValueLayers.ts';
import { LAYER_STATUSES, VALUE_LAYERS } from '../../domain/cashValueLayers.ts';

export interface LayerInput {
  layer: ValueLayer;
  status: LayerStatus;
  amountCents?: number | null;
  currency?: string | null;
  source?: string | null;
  note?: string | null;
}

/** Why a layer cannot be recorded as written, or null when it can. */
export function refuseLayer(input: LayerInput): string | null {
  if (!VALUE_LAYERS.includes(input.layer)) return `"${input.layer}" is not a value layer.`;
  if (!LAYER_STATUSES.includes(input.status)) return `"${input.status}" is not a layer status.`;
  const amount = input.amountCents ?? null;
  if (amount !== null && (!Number.isInteger(amount) || amount < 0)) {
    return 'An amount is a whole number of cents, not negative.';
  }
  if (input.status === 'UNKNOWN') {
    return amount === null ? null : 'An UNKNOWN layer holds no amount: a blank is not a figure.';
  }
  if (!input.source || input.source.trim() === '') {
    return `A ${input.status} layer must say where it came from.`;
  }
  if (amount !== null && !input.currency) return 'An amount needs its currency.';
  return null;
}

export interface GoalContribution {
  /** The only amount that may count toward a goal. */
  countedCents: number;
  realisticCents: number;
  ledgerCents: number;
  /** Words for why each part counted or did not. */
  realisticReason: string;
  ledgerReason: string;
  /** Layers that hold a figure and contribute nothing, by name. */
  zeroed: ValueLayer[];
}

function byLayer(readings: ValueLayerReading[]): Map<ValueLayer, ValueLayerReading> {
  return new Map(readings.map((r) => [r.layer, r]));
}

function supports(r: ValueLayerReading | undefined): boolean {
  return !!r && r.status !== 'UNKNOWN' && !!r.source;
}

export function goalContribution(readings: ValueLayerReading[], currency: string): GoalContribution {
  const layers = byLayer(readings);
  const zeroed: ValueLayer[] = [];
  for (const layer of ['ADVERTISED_VALUE', 'TRANSACTION_EVIDENCE', 'BUYER_DEMAND', 'ACCESSIBILITY', 'COST_AND_CAPITAL'] as const) {
    const r = layers.get(layer);
    if (r && r.amountCents !== null && r.amountCents > 0) zeroed.push(layer);
  }

  let realisticCents = 0;
  let realisticReason = 'No realistic revenue has been recorded.';
  const realistic = layers.get('REALISTIC_REVENUE');
  if (realistic && realistic.status !== 'UNKNOWN' && realistic.amountCents !== null) {
    if (realistic.currency !== currency) {
      realisticReason = `Realistic revenue is in ${realistic.currency ?? 'an unstated currency'}, not ${currency}, so it is not counted.`;
    } else if (!supports(layers.get('TRANSACTION_EVIDENCE')) && !supports(layers.get('BUYER_DEMAND'))) {
      realisticReason = 'Realistic revenue has no completed-transaction or buyer-demand evidence behind it, so it counts as nothing.';
    } else {
      realisticCents = realistic.amountCents;
      realisticReason = `Supported by ${supports(layers.get('TRANSACTION_EVIDENCE')) ? 'recorded transactions' : 'present buyer demand'}.`;
    }
  }

  let ledgerCents = 0;
  let ledgerReason = 'Nothing has been agreed or received.';
  const ledger = layers.get('LEDGER');
  if (ledger && ledger.amountCents !== null) {
    if (ledger.status !== 'VERIFIED') ledgerReason = 'Only a VERIFIED ledger entry counts.';
    else if (ledger.currency !== currency) ledgerReason = `The ledger is in ${ledger.currency ?? 'an unstated currency'}, not ${currency}.`;
    else {
      ledgerCents = ledger.amountCents;
      ledgerReason = 'Agreed or received, recorded in the ledger.';
    }
  }

  return {
    countedCents: realisticCents + ledgerCents,
    realisticCents,
    ledgerCents,
    realisticReason,
    ledgerReason,
    zeroed,
  };
}
