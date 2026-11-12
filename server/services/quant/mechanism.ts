/**
 * Constructing an economic arrangement nobody has a name for.
 *
 * An arrangement is not a business template. It is a small set of economic
 * relationships Brain can establish independently and then connect:
 *
 *   * a **demand side** — how many buyers have the need, how often, what share
 *     can be reached, what share of those reached agree;
 *   * optionally a **supply side** — how much capacity exists that could meet
 *     it, and what share of it is willing — because an intermediary can never
 *     sell more transactions than the scarcer side allows;
 *   * a **value** per transaction, and how the arranger is paid from it: a
 *     commission (a share of the value), a fee (a fixed amount), or a margin
 *     (the value less what supply is paid);
 *   * a **cost** per transaction to the arranger.
 *
 * Brokerage, matchmaking, subcontracting, resale, delegated operations and
 * arrangements with no established name all fit, because what is composed is
 * the economics rather than a category. Each part is an ordinary quantity
 * node — with its own observations, its own formula and its own sub-parts — so
 * the whole thing is resolved by `reconstruct` exactly like any other graph,
 * and a part may itself be rebuilt from deeper parts.
 */
import type { QuantGraph, QuantityNode } from '../../domain/quant.ts';

/** A part of an arrangement: a node without its key, which the composer assigns. */
export type Part = Omit<QuantityNode, 'key' | 'label' | 'unit' | 'kind'> & { label?: string };

export interface Arrangement {
  key: string;
  label: string;
  /** The period the counts are per — "the goal window", "a month". */
  period: string;
  currency: string;
  demand: {
    buyers: Part;
    /** Needs per buyer per period. */
    needRate: Part;
    /** Share of buyers the arranger can actually reach. */
    reach: Part;
    /** Share of those reached who agree. */
    conversion: Part;
  };
  supply?: {
    /** Units of capacity per period that could serve the need. */
    units: Part;
    /** Share of that capacity willing to take the work on these terms. */
    acceptance: Part;
  };
  value: Part;
  capture: { kind: 'COMMISSION'; rate: Part } | { kind: 'FEE'; fee: Part } | { kind: 'MARGIN'; supplyCost: Part };
  cost: Part;
  /**
   * Several buyers sharing one fulfilment run (§82): a fixed cost paid once per
   * run whatever the number of buyers, and the participation it needs. With a
   * threshold the run is bought only once `minParticipants` have committed and
   * everybody is refunded otherwise, so a short run contributes nothing rather
   * than losing the fixed cost.
   */
  pooling?: { fixedCost: Part; minParticipants: Part; threshold: boolean };
  /** Share of the money buyers pay before the fulfilment is bought (§82). */
  funding?: { prepayShare: Part };
  /** Share of buyers who buy again in a later run or period (§82): asked, never multiplied in. */
  repeat?: { rate: Part };
  /** Deeper parts any of the above refer to in their formulas, keyed by name. */
  extra?: QuantityNode[];
  correlations?: QuantGraph['correlations'];
}

export interface ComposedArrangement {
  graph: QuantGraph;
  /** The node keys the caller reads. */
  transactions: string;
  /** Money of the arranger's tied up before buyers pay, per run or deal (§82); null when the design ties up none. */
  exposure: string | null;
  revenue: string;
  contribution: string;
  /** Which side limits the transactions in the formula, as written. */
  formulas: Record<string, string>;
}

/** Compose an arrangement into a reconstruction graph. */
export function composeArrangement(a: Arrangement): ComposedArrangement {
  const k = (name: string) => `${a.key}_${name}`;
  const nodes: QuantityNode[] = [];
  const part = (name: string, label: string, unit: string, kind: QuantityNode['kind'], p: Part, bounds?: { min?: number; max?: number }) => {
    nodes.push({ ...bounds, ...p, key: k(name), label: p.label ?? label, unit, kind });
    return k(name);
  };
  const buyers = part('buyers', 'Buyers who have the need', 'buyers', 'POSITIVE', a.demand.buyers, { min: 0 });
  const need = part('need_rate', `Needs per buyer per ${a.period}`, 'needs/buyer', 'POSITIVE', a.demand.needRate, { min: 0 });
  const reach = part('reach', 'Share of buyers reachable', 'share', 'RATE', a.demand.reach);
  const conversion = part('conversion', 'Share of reached buyers who agree', 'share', 'RATE', a.demand.conversion);
  const formulas: Record<string, string> = {};
  formulas[k('demand')] = `${buyers} * ${need} * ${reach} * ${conversion}`;
  nodes.push({ key: k('demand'), label: 'Transactions demand allows', unit: 'transactions', kind: 'POSITIVE', min: 0, formula: formulas[k('demand')] });
  let limit = k('demand');
  if (a.supply) {
    const units = part('supply_units', `Supply capacity per ${a.period}`, 'units', 'POSITIVE', a.supply.units, { min: 0 });
    const acceptance = part('supply_acceptance', 'Share of supply willing', 'share', 'RATE', a.supply.acceptance);
    formulas[k('supply')] = `${units} * ${acceptance}`;
    nodes.push({ key: k('supply'), label: 'Transactions supply allows', unit: 'transactions', kind: 'POSITIVE', min: 0, formula: formulas[k('supply')] });
    limit = `min(${k('demand')}, ${k('supply')})`;
  }
  formulas[k('transactions')] = limit;
  nodes.push({ key: k('transactions'), label: 'Transactions', unit: 'transactions', kind: 'POSITIVE', min: 0, formula: limit });
  const value = part('value', 'What a buyer pays per transaction', a.currency, 'POSITIVE', a.value, { min: 0 });
  let capture: string;
  if (a.capture.kind === 'COMMISSION') capture = `${value} * ${part('commission', 'Commission share', 'share', 'RATE', a.capture.rate)}`;
  else if (a.capture.kind === 'FEE') capture = part('fee', 'Fee per transaction', a.currency, 'POSITIVE', a.capture.fee, { min: 0 });
  else capture = `${value} - ${part('supply_cost', 'What supply is paid per transaction', a.currency, 'POSITIVE', a.capture.supplyCost, { min: 0 })}`;
  formulas[k('capture')] = capture;
  nodes.push({ key: k('capture'), label: 'What the arranger keeps per transaction, before its own costs', unit: a.currency, kind: 'REAL', formula: capture });
  const cost = part('cost', 'Arranger cost per transaction', a.currency, 'POSITIVE', a.cost, { min: 0 });
  const t = k('transactions');
  formulas[k('revenue')] = `${t} * ${k('capture')}`;
  formulas[k('contribution')] = `${t} * (${k('capture')} - ${cost})`;
  const prepay = a.funding ? part('prepay_share', 'Share of the price buyers pay before fulfilment is bought', 'share', 'RATE', a.funding.prepayShare) : null;
  const unfunded = prepay ? ` * (1 - ${prepay})` : '';
  if (a.pooling) {
    const fixed = part('fixed_cost', 'Fixed cost of one shared run', a.currency, 'POSITIVE', a.pooling.fixedCost, { min: 0 });
    const minimum = part('min_participants', 'Buyers one run needs', 'buyers', 'POSITIVE', a.pooling.minParticipants, { min: 0 });
    if (a.pooling.threshold) {
      formulas[k('revenue')] = `if(${t} >= ${minimum}, ${t} * ${k('capture')}, 0)`;
      formulas[k('contribution')] = `if(${t} >= ${minimum}, ${t} * (${k('capture')} - ${cost}) - ${fixed}, 0)`;
      // Nothing is bought until enough have prepaid: no exposure node at all.
    } else {
      formulas[k('contribution')] = `${t} * (${k('capture')} - ${cost}) - ${fixed}`;
      formulas[k('exposure')] = `${fixed}${unfunded}`;
    }
  } else if (a.capture.kind === 'MARGIN') {
    formulas[k('exposure')] = `${k('supply_cost')}${unfunded}`;
  }
  if (formulas[k('exposure')]) nodes.push({ key: k('exposure'), label: 'Money of ours tied up before buyers pay, per run or deal', unit: a.currency, kind: 'REAL', formula: formulas[k('exposure')] });
  if (a.repeat) part('repeat_rate', 'Share of buyers who buy again', 'share', 'RATE', a.repeat.rate);
  nodes.push(
    { key: k('revenue'), label: 'Revenue to the arranger', unit: a.currency, kind: 'REAL', formula: formulas[k('revenue')] },
    { key: k('contribution'), label: 'Contribution to the arranger', unit: a.currency, kind: 'REAL', formula: formulas[k('contribution')] },
  );
  for (const node of a.extra ?? []) nodes.push(node);
  return { graph: { nodes, correlations: a.correlations }, transactions: k('transactions'), exposure: formulas[k('exposure')] ? k('exposure') : null, revenue: k('revenue'), contribution: k('contribution'), formulas };
}
