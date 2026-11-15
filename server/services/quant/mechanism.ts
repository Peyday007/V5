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
import type { Estimate, QuantGraph, QuantityNode } from '../../domain/quant.ts';
import { reconstruct } from './reconstruct.ts';

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
  /**
   * Commercial leverage (S-0103, COM-13-2): optional parts that may be used
   * together on one arrangement. With any lever present the composer traces
   * the combination through cash conversion, margin, supplier risk, delivery
   * capacity, liability, acquisition speed and repeatability, and the
   * transactions are bounded only by real capacity, cash-exposure, authority
   * and contract limits — never by a revenue ceiling derived from owned capital.
   */
  levers?: Levers;
  /** Deeper parts any of the above refer to in their formulas, keyed by name. */
  extra?: QuantityNode[];
  correlations?: QuantGraph['correlations'];
}

/**
 * The levers a candidate may combine. None is a category and none is required;
 * any subset composes onto one arrangement.
 */
export interface Levers {
  /** AI labor: what it costs per transaction and how many transactions it can do per period. */
  aiLabor?: { costPerTransaction: Part; throughput: Part };
  /** Contractor or supplier fulfilment: its capacity per period, the share of its deliveries that fail, and how many days after delivery it must be paid. */
  fulfilment?: { capacity: Part; failureRate: Part; paymentDays: Part };
  /** Distribution through an existing channel: the share of transactions that go through it and its fee per transaction. */
  channel?: { share: Part; fee: Part };
  /** Marketing reach: the factor it adds to reach (0.5 = half as much again), its cost per transaction acquired, and the days to acquire a period's buyers. */
  marketing?: { reachUplift: Part; acquisitionCost: Part; daysToAcquire: Part };
  /**
   * Buyer prepayment — a design possibility, never a presumption. It lowers
   * cash exposure only by the share of buyers verified willing to prepay, net
   * of the share that may have to be refunded, and only when the prepaid money
   * is usable on or before the day the supplier must be paid. When any of
   * those is unstated the credit is not taken (invariant 39).
   */
  prepayment?: { willingness: Part; refundShare: Part; usableDays: Part; supplierPaymentDays?: Part };
  /** Financing: an annual rate, a term in days, and the share of the outlay it advances. */
  financing?: { rate: Part; termDays: Part; advanceShare: Part };
  /** Organisation-wide shared infrastructure: the fixed cost allocated to each transaction. */
  sharedInfrastructure?: { costPerTransaction: Part };
  /** Days after delivery until a buyer who did not prepay has paid in usable money. */
  settlementDays?: Part;
  /**
   * Real limits on how many transactions may run: money available to tie up,
   * the money a person authorised to commit (invariant 38), and a contract's
   * maximum count. Owned capital is not a limit here except as the cash that
   * real exposure actually ties up.
   */
  limits?: { cashAvailable?: Part; authorityCeiling?: Part; contractMax?: Part };
}

/** The traced dimensions, as node keys. */
export interface TracedDimensions {
  /** Days from paying supply to holding usable cash (negative: funded before supply is paid). */
  cashConversion: string;
  /** Contribution per transaction after every lever's cost. */
  margin: string;
  /** Share of supplier deliveries expected to fail. */
  supplierRisk: string;
  /** Transactions the period can deliver: the minimum of demand, supply, AI and supplier throughput and the real limits. */
  deliveryCapacity: string;
  /** Refund obligations plus supplier-default exposure over the period. */
  liability: string;
  /** Transactions acquired per day. */
  acquisitionSpeed: string;
  /** Share of buyers who buy again and whose delivery did not fail. */
  repeatability: string;
  /** Money of ours tied up per transaction before buyers pay. */
  cashExposure: string;
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
  /** Present only when levers were composed. */
  traced?: TracedDimensions;
  /** Present only when levers were composed: whether the prepayment credit was taken, and why not if not. */
  prepayment?: { credited: boolean; reason: string };
}

/** Compose an arrangement into a reconstruction graph. */
export function composeArrangement(a: Arrangement, options: { now?: Date } = {}): ComposedArrangement {
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
  const L = a.levers;
  const uplift = L?.marketing ? part('reach_uplift', 'Reach marketing adds, as a factor', 'factor', 'POSITIVE', L.marketing.reachUplift, { min: 0 }) : null;
  formulas[k('demand')] = uplift ? `${buyers} * ${need} * min(1, ${reach} * (1 + ${uplift})) * ${conversion}` : `${buyers} * ${need} * ${reach} * ${conversion}`;
  nodes.push({ key: k('demand'), label: 'Transactions demand allows', unit: 'transactions', kind: 'POSITIVE', min: 0, formula: formulas[k('demand')] });
  let limit = k('demand');
  if (a.supply) {
    const units = part('supply_units', `Supply capacity per ${a.period}`, 'units', 'POSITIVE', a.supply.units, { min: 0 });
    const acceptance = part('supply_acceptance', 'Share of supply willing', 'share', 'RATE', a.supply.acceptance);
    formulas[k('supply')] = `${units} * ${acceptance}`;
    nodes.push({ key: k('supply'), label: 'Transactions supply allows', unit: 'transactions', kind: 'POSITIVE', min: 0, formula: formulas[k('supply')] });
    limit = `min(${k('demand')}, ${k('supply')})`;
  }
  if (L) limit = composeCapacity(a, L, k, part, nodes, formulas);
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
  let leverResult: Pick<ComposedArrangement, 'traced' | 'prepayment'> | null = null;
  if (L) {
    leverResult = composeLevers(a, L, k, part, nodes, formulas, options.now ?? new Date());
    const contributionNode = nodes.find((one) => one.key === k('contribution'))!;
    contributionNode.formula = formulas[k('contribution')];
  }
  for (const node of a.extra ?? []) nodes.push(node);
  const exposure = leverResult ? leverResult.traced!.cashExposure : formulas[k('exposure')] ? k('exposure') : null;
  return { graph: { nodes, correlations: a.correlations }, transactions: k('transactions'), exposure, revenue: k('revenue'), contribution: k('contribution'), formulas, ...leverResult };
}

type PartFn = (name: string, label: string, unit: string, kind: QuantityNode['kind'], p: Part, bounds?: { min?: number; max?: number }) => string;

/**
 * Whether a resolved quantity is established by evidence: a distribution its
 * observations justify. An assumed range, bounds or nothing resolve to an
 * estimate that is not, so they never pass. The one test for a prepayment
 * condition, shared by the composer's credit and `verifyPrepayment`.
 */
export function establishedEstimate(est: Estimate | undefined): boolean {
  return !!est && est.distributionJustified && est.samples.length > 0;
}

/** Whether `key` resolves on `graph` to an estimate established by evidence. Unresolvable is not established. */
function evidencedIn(graph: QuantGraph, key: string, now: Date): boolean {
  try {
    return establishedEstimate(reconstruct(graph, key, now).estimates[key]);
  } catch {
    return false;
  }
}

/** A key in the graph, emitted once: the given part when there is one, an empty question otherwise. */
function once(nodes: QuantityNode[], key: string, make: () => string): string {
  return nodes.some((one) => one.key === key) ? key : make();
}

/**
 * Delivery capacity: the minimum of every side that can run out — demand,
 * supply, AI-labor throughput, supplier capacity — and the real limits on
 * money and contract. Nothing here is a revenue ceiling from owned capital.
 */
function composeCapacity(a: Arrangement, L: Levers, k: (n: string) => string, part: PartFn, nodes: QuantityNode[], formulas: Record<string, string>): string {
  const caps = [k('demand')];
  if (a.supply) caps.push(k('supply'));
  if (L.aiLabor) caps.push(part('ai_throughput', `Transactions AI labor can do per ${a.period}`, 'transactions', 'POSITIVE', L.aiLabor.throughput, { min: 0 }));
  if (L.fulfilment) caps.push(part('supplier_capacity', `Transactions the supplier can fulfil per ${a.period}`, 'transactions', 'POSITIVE', L.fulfilment.capacity, { min: 0 }));
  const capacityFormula = `min(${caps.join(', ')})`;
  formulas[k('delivery_capacity')] = capacityFormula;
  nodes.push({ key: k('delivery_capacity'), label: 'Transactions the period can deliver', unit: 'transactions', kind: 'POSITIVE', min: 0, formula: capacityFormula });
  const bounds = [k('delivery_capacity')];
  const lim = L.limits;
  if (lim?.cashAvailable || lim?.authorityCeiling) {
    // Exposure is composed later, from parts that do not depend on the count.
    const exposure = k('cash_exposure');
    if (lim.cashAvailable) {
      const cash = part('cash_available', 'Money available to tie up at once', a.currency, 'POSITIVE', lim.cashAvailable, { min: 0 });
      formulas[k('cash_limit')] = `if(${exposure} > 0, ${cash} / ${exposure}, ${k('delivery_capacity')})`;
      nodes.push({ key: k('cash_limit'), label: 'Transactions the cash it ties up allows', unit: 'transactions', kind: 'POSITIVE', min: 0, formula: formulas[k('cash_limit')] });
      bounds.push(k('cash_limit'));
    }
    if (lim.authorityCeiling) {
      const ceiling = part('authority_ceiling', 'Money a person authorised to commit', a.currency, 'POSITIVE', lim.authorityCeiling, { min: 0 });
      formulas[k('authority_limit')] = `if(${exposure} > 0, ${ceiling} / ${exposure}, ${k('delivery_capacity')})`;
      nodes.push({ key: k('authority_limit'), label: 'Transactions the authorised commitment allows', unit: 'transactions', kind: 'POSITIVE', min: 0, formula: formulas[k('authority_limit')] });
      bounds.push(k('authority_limit'));
    }
  }
  if (lim?.contractMax) bounds.push(part('contract_max', 'Transactions the contract allows', 'transactions', 'POSITIVE', lim.contractMax, { min: 0 }));
  return bounds.length === 1 ? bounds[0]! : `min(${bounds.join(', ')})`;
}

/** Trace the levers through margin, exposure, cash conversion, supplier risk, liability, speed and repeatability. */
function composeLevers(a: Arrangement, L: Levers, k: (n: string) => string, part: PartFn, nodes: QuantityNode[], formulas: Record<string, string>, now: Date): Pick<ComposedArrangement, 'traced' | 'prepayment'> {
  const t = k('transactions');
  const c = a.currency;
  const node = (name: string, label: string, unit: string, kind: QuantityNode['kind'], formula: string, bounds?: { min?: number; max?: number }) => {
    formulas[k(name)] = formula;
    nodes.push({ ...bounds, key: k(name), label, unit, kind, formula });
    return k(name);
  };
  // What leaves our account per transaction before a buyer's money arrives.
  const outlay = [a.capture.kind === 'MARGIN' ? k('supply_cost') : null, k('cost')].filter((one): one is string => !!one);
  const costs = [k('cost')];
  if (L.aiLabor) {
    const ai = part('ai_cost', 'AI labor cost per transaction', c, 'POSITIVE', L.aiLabor.costPerTransaction, { min: 0 });
    costs.push(ai);
    outlay.push(ai);
  }
  if (L.channel) {
    const share = part('channel_share', 'Share of transactions through the existing channel', 'share', 'RATE', L.channel.share);
    const fee = part('channel_fee', 'Channel fee per transaction through it', c, 'POSITIVE', L.channel.fee, { min: 0 });
    costs.push(`${share} * ${fee}`);
  }
  if (L.marketing) {
    const acquisition = part('acquisition_cost', 'Marketing cost per transaction acquired', c, 'POSITIVE', L.marketing.acquisitionCost, { min: 0 });
    costs.push(acquisition);
    outlay.push(acquisition);
  }
  if (L.sharedInfrastructure) {
    const infra = part('infrastructure_cost', 'Shared infrastructure allocated per transaction', c, 'POSITIVE', L.sharedInfrastructure.costPerTransaction, { min: 0 });
    costs.push(infra);
    outlay.push(infra);
  }
  const outlayKey = node('outlay', 'Money paid out per transaction before the buyer pays', c, 'POSITIVE', outlay.join(' + '), { min: 0 });
  let advance: string | null = null;
  if (L.financing) {
    const rate = part('financing_rate', 'Annual financing rate', 'share', 'RATE', L.financing.rate);
    const term = part('financing_term_days', 'Financing term', 'days', 'POSITIVE', L.financing.termDays, { min: 0 });
    advance = part('financing_advance', 'Share of the outlay financing advances', 'share', 'RATE', L.financing.advanceShare);
    costs.push(node('financing_cost', 'Financing cost per transaction', c, 'POSITIVE', `${advance} * ${outlayKey} * ${rate} * ${term} / 365`, { min: 0 }));
  }
  const margin = node('margin', 'Margin per transaction after every lever', c, 'REAL', `${k('capture')} - ${costs.join(' - ')}`);

  /*
   * Supplier days: the fulfilment terms, or what the prepayment lever states.
   * Where there is a supplier and neither states them they are an unknown
   * (invariant 39). Where there is no supplier at all — Brain fulfils the work
   * itself, with AI labor or its own cost — there is no supplier to pay, and
   * the outlay leaves on the day of delivery: the reference is day 0, a fact
   * of the design rather than an unknown, and the least favourable reading of
   * it. Emitting an empty part there would make cash conversion unknowable
   * for every self-fulfilled arrangement however well its settlement is
   * evidenced.
   */
  const hasSupplier = !!L.fulfilment || !!a.supply || a.capture.kind === 'MARGIN';
  const supplierDaysPart = L.fulfilment?.paymentDays ?? L.prepayment?.supplierPaymentDays;
  const supplierDays = supplierDaysPart || hasSupplier ? part('supplier_payment_days', 'Days after delivery the supplier must be paid', 'days', 'POSITIVE', supplierDaysPart ?? {}, { min: 0 }) : null;
  const paidOutDay = supplierDays ?? '0';

  // Prepayment: verified willingness, refunds and timing, or no credit at all.
  let credit: string | null = null;
  let prepayment = { credited: false, reason: 'No prepayment lever: buyers pay on settlement.' };
  let willingness: string | null = null;
  let refund: string | null = null;
  if (L.prepayment) {
    willingness = part('prepay_willingness', 'Share of buyers verified willing to prepay', 'share', 'RATE', L.prepayment.willingness);
    refund = part('prepay_refund_share', 'Share of prepaid money that may have to be refunded', 'share', 'RATE', L.prepayment.refundShare);
    const usable = part('prepay_usable_days', 'Days until prepaid money is usable', 'days', 'POSITIVE', L.prepayment.usableDays, { min: 0 });
    /*
     * Each condition must be established by evidence: the same test
     * `verifyPrepayment` applies (`establishedEstimate`). A person's assumed
     * range, bare bounds or nothing at all is a question, so it never earns
     * the credit (S-0103, invariant 39).
     */
    const graphNow: QuantGraph = { nodes: [...nodes, ...(a.extra ?? [])], correlations: a.correlations };
    const missing = [
      evidencedIn(graphNow, willingness, now) ? null : 'buyer willingness',
      evidencedIn(graphNow, refund, now) ? null : 'refund obligations',
      evidencedIn(graphNow, usable, now) ? null : 'when prepaid funds are usable',
      supplierDays === null || evidencedIn(graphNow, supplierDays, now) ? null : 'when the supplier must be paid',
    ].filter((one): one is string => !!one);
    if (missing.length === 0) {
      credit = node('prepay_credit', 'Share of the outlay prepayment funds before the supplier is paid', 'share', 'RATE', `if(${usable} <= ${paidOutDay}, ${willingness} * (1 - ${refund}), 0)`, { min: 0, max: 1 });
      prepayment = { credited: true, reason: 'Willingness, refunds and timing are established by evidence; the credit applies only where prepaid funds are usable before the supplier is paid.' };
    } else {
      prepayment = { credited: false, reason: `Not credited: ${missing.join(', ')} not established by evidence (unstated, bounds only or a person's assumed range) — an unknown is never read as favourable.` };
    }
  }
  const exposureParts = [outlayKey, advance ? `(1 - ${advance})` : null, credit ? `(1 - ${credit})` : null].filter((one): one is string => !!one);
  const cashExposure = node('cash_exposure', 'Money of ours tied up per transaction before buyers pay', c, 'POSITIVE', exposureParts.join(' * '), { min: 0 });

  const settlement = part('settlement_days', 'Days after delivery until a buyer who did not prepay has paid', 'days', 'POSITIVE', L.settlementDays ?? {}, { min: 0 });
  const inflowDays = credit ? `${credit} * ${k('prepay_usable_days')} + (1 - ${credit}) * ${settlement}` : settlement;
  const cashConversion = node('cash_conversion', 'Days from paying supply to holding usable cash', 'days', 'REAL', supplierDays ? `${inflowDays} - ${supplierDays}` : inflowDays);

  // Supplier risk: stated for a supplier, unknown where supply exists unstated, nothing where there is no supplier.
  const failure = L.fulfilment
    ? part('supplier_failure_rate', 'Share of supplier deliveries that fail', 'share', 'RATE', L.fulfilment.failureRate)
    : hasSupplier
      ? part('supplier_failure_rate', 'Share of supplier deliveries that fail', 'share', 'RATE', {})
      : null;
  const supplierRisk = node('supplier_risk', 'Share of supplier deliveries expected to fail', 'share', 'RATE', failure ?? '0', { min: 0, max: 1 });

  const owed = [willingness && refund ? `${k('value')} * ${willingness} * ${refund}` : null, failure ? `${k('value')} * ${failure}` : null].filter((one): one is string => !!one);
  const liability = node('liability', `Refund obligations plus supplier-default exposure per ${a.period}`, c, 'POSITIVE', owed.length ? `${t} * (${owed.join(' + ')})` : '0', { min: 0 });

  const days = L.marketing ? part('days_to_acquire', `Days to acquire a ${a.period}'s buyers`, 'days', 'POSITIVE', L.marketing.daysToAcquire, { min: 0 }) : part('days_to_acquire', `Days to acquire a ${a.period}'s buyers`, 'days', 'POSITIVE', {}, { min: 0 });
  const acquisitionSpeed = node('acquisition_speed', 'Transactions acquired per day', 'transactions/day', 'POSITIVE', `${t} / ${days}`, { min: 0 });

  const repeat = once(nodes, k('repeat_rate'), () => part('repeat_rate', 'Share of buyers who buy again', 'share', 'RATE', {}));
  const repeatability = node('repeatability', 'Share of buyers who buy again and were delivered', 'share', 'RATE', failure ? `${repeat} * (1 - ${failure})` : repeat, { min: 0, max: 1 });

  // Contribution after every lever's cost, keeping the pooling rules.
  if (a.pooling) {
    const fixed = k('fixed_cost');
    formulas[k('contribution')] = a.pooling.threshold ? `if(${t} >= ${k('min_participants')}, ${t} * ${margin} - ${fixed}, 0)` : `${t} * ${margin} - ${fixed}`;
  } else {
    formulas[k('contribution')] = `${t} * ${margin}`;
  }
  return {
    traced: { cashConversion, margin, supplierRisk, deliveryCapacity: k('delivery_capacity'), liability, acquisitionSpeed, repeatability, cashExposure },
    prepayment,
  };
}
