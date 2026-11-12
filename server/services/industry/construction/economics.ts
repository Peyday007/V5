/**
 * The economics of a constructed business, solved rather than described (§92).
 *
 * Every quantity is a formula over the generic fact keys, written once in the
 * scenario expression grammar (`scenario/expr.ts`) and evaluated two ways by
 * Brain's existing engines:
 *
 *   * deterministically, at the worst, middle and best end of every input's
 *     evidenced range — which is what the decision, the thresholds and the
 *     sensitivity need, and what lets a replan or a value-of-information
 *     check re-run the whole comparison in milliseconds;
 *   * through `quant/reconstruct.ts`, which turns each input's evidence into
 *     an estimate with its tier (DIRECT, COMPARABLE, ASSUMED…) and propagates
 *     them, so a headline range says how much of it rests on a published
 *     figure about another market and never reads as a probability when it
 *     rests on an assumption (§60, §77).
 *
 * An input nobody has evidenced is UNKNOWN. It is never filled in: the
 * business is reported unpriced, and the input is solved for instead — the
 * price, rate, volume or payment term at which the business breaks even —
 * which is the threshold the operator's first conversation with a buyer
 * settles.
 */
import { compile, parse, identifiers } from '../../scenario/expr.ts';
import { reconstruct } from '../../quant/reconstruct.ts';
import { FACT_KEYS, WORKING_DAYS_PER_MONTH, WORKING_DAYS_PER_YEAR, type Asset, type FactKey, type IndustryEvidence, type KnownStatus } from '../../../domain/construction.ts';
import type { Observation, QuantGraph, QuantityNode } from '../../../domain/quant.ts';
import type { Business } from './businesses.ts';
import { resolveFact, type ResolvedFact } from './model.ts';

export type Case = 'WORST' | 'MID' | 'BEST';

/** Inputs where a higher value is better for us; every other input is a cost or a delay. */
const HIGHER_IS_BETTER = new Set<FactKey>([
  'price_per_unit',
  'units_per_capacity_day',
  'pooled_units_per_capacity_day',
  'broker_take_rate',
  'placement_fee',
  'placements_per_month',
  'account_units_per_month',
  'account_win_rate',
  'accounts_reachable',
  'supply_available',
]);

/** Payroll runs weekly: the convention working capital for employed staff is computed on. */
export const PAYROLL_DAYS = 7;
/** Share of an owned unit's price lost if it must be sold in the first months: a stated convention, not evidence. */
export const FORCED_SALE_LOSS = 0.3;
/** Months a failing stage is assumed to run before it is stopped, for downside exposure. */
export const EXPOSURE_MONTHS = 3;

export interface Formulas {
  volume: string;
  /** The value of the work passing through, before anybody's share. */
  billings: string;
  /** Pitching cost per won account. */
  acquisitionPerAccount: string;
  capturePerUnit: string;
  fixedMonthly: string;
  contribution: string;
  upfront: string;
  workingCapital: string;
  firstRevenueDays: string;
  firstCashDays: string;
  exposure: string;
  capacityUnits: string;
}

export interface Threshold {
  key: FactKey;
  label: string;
  status: KnownStatus;
  /** The value at which monthly contribution is zero, others at their middle. Null when no value does it. */
  breakEven: number | null;
  /** Which side of breakEven is viable. */
  viableWhen: 'ABOVE' | 'BELOW';
  low: number | null;
  high: number | null;
  reading: 'CLEARS' | 'STRADDLES' | 'FAILS' | 'UNKNOWN_RANGE' | 'NO_BREAK_EVEN';
  sentence: string;
  /** The bare condition, e.g. "what the paying buyer pays per unit of work ≥ $3.74/unit". */
  condition: string | null;
}

export interface CaseFigures {
  /** Operating profit per month: what is left after direct and fixed costs. */
  contribution: number;
  /** What we keep before fixed costs (gross contribution). */
  revenue: number;
  billings: number;
  /** Paid to supply, labour and equipment per month (direct cost). */
  directCost: number;
  /** Fixed and overhead costs per month (indirect cost). */
  indirectCost: number;
  acquisitionPerAccount: number;
  /** Months of one account's gross contribution to recover what winning it cost. */
  acquisitionPaybackMonths: number | null;
  /** People or independent operators performing the work at this scale. */
  workers: number;
  upfront: number;
  workingCapital: number;
  firstRevenueDays: number;
  firstCashDays: number;
  exposure: number;
  capacityUnits: number;
  capturePerUnit: number;
  fixedMonthly: number;
}

export interface BusinessEconomics {
  accounts: number;
  formulas: Formulas;
  inputs: ResolvedFact[];
  /** Load-bearing inputs nothing has evidenced. */
  unpriced: FactKey[];
  /** Gate costs nobody has stated. */
  unpricedGates: string[];
  worst: CaseFigures | null;
  mid: CaseFigures | null;
  best: CaseFigures | null;
  /** Accounts needed to cover fixed costs, at the middle of every range. */
  breakEvenAccounts: number | null;
  viability: 'VIABLE' | 'CONDITIONAL' | 'NOT_VIABLE' | 'UNPRICED';
  thresholds: Threshold[];
  /** Inputs ordered by how far they swing monthly contribution, worst to best. */
  sensitivity: { key: FactKey; swing: number }[];
  /** The reconstruction engine's reading of the two headline figures. */
  reconstructed: { contribution: RangeReading | null; upfront: RangeReading | null };
}

export interface RangeReading {
  p10: number;
  p50: number;
  p90: number;
  tier: string;
  distributionJustified: boolean;
}

function gateFigures(b: Business, held: ReadonlySet<Asset>): { low: number; high: number; days: number; unpriced: string[] } {
  let low = 0;
  let high = 0;
  let days = 0;
  const unpriced: string[] = [];
  for (const g of b.gates) {
    // A gate whose every grant is already held was passed by an earlier stage.
    if (g.grants.length > 0 && g.grants.every((a) => held.has(a))) continue;
    if (g.upfrontHigh === null) unpriced.push(g.name);
    low += g.upfrontLow ?? g.upfrontHigh ?? 0;
    high += g.upfrontHigh ?? g.upfrontLow ?? 0;
    days = Math.max(days, g.days ?? 0);
  }
  return { low, high, days, unpriced };
}

/** The formulas for one business at a planning scale of `accounts` won accounts. */
export function formulasFor(b: Business, accounts: number, gates: { low: number; high: number; days: number }, gateCase: number, measured: ReadonlySet<FactKey> = new Set()): Formulas {
  const f = formulasCore(b, accounts, gates, gateCase);
  // Reliability is priced only once somebody measured it: failed units are redone or refunded at our cost.
  if (measured.has('failure_rate')) {
    const share = b.position.contract === 'INTRODUCE' || b.position.contract === 'REPRESENT' ? ' * broker_take_rate' : '';
    f.contribution = `${f.contribution} - (${f.billings})${share} * failure_rate`;
  }
  return f;
}

function formulasCore(b: Business, accounts: number, gates: { low: number; high: number; days: number }, gateCase: number): Formulas {
  const p = b.position;
  const A = String(accounts);
  const W = String(WORKING_DAYS_PER_MONTH);
  const U = p.aggregation === 'POOLED' ? 'pooled_units_per_capacity_day' : 'units_per_capacity_day';
  const G = String(gateCase);
  const fixedParts = ['overhead_per_month'];
  if (p.supply === 'EMPLOY') fixedParts.push('manager_cost_per_month');
  if (p.information === 'PLATFORM') fixedParts.push('platform_cost_per_month');
  const fixed = fixedParts.join(' + ');
  const cac = `${A} * outreach_cost_per_account / account_win_rate`;
  const gateDays = String(gates.days);

  if (p.supply === 'RECRUIT') {
    const cpu = 'placement_fee - recruiting_cost_per_placement';
    const contribution = `placements_per_month * (${cpu}) - (${fixed})`;
    return {
      volume: 'placements_per_month',
      billings: 'placements_per_month * placement_fee',
      acquisitionPerAccount: 'outreach_cost_per_account / account_win_rate',
      capturePerUnit: cpu,
      fixedMonthly: fixed,
      contribution,
      upfront: `${G} + ${cac} + (${fixed})`,
      workingCapital: `placements_per_month * recruiting_cost_per_placement * buyer_payment_days / 30`,
      firstRevenueDays: `max(${gateDays}, sales_cycle_days)`,
      firstCashDays: `max(${gateDays}, sales_cycle_days) + buyer_payment_days`,
      exposure: `${G} + ${cac} + ${EXPOSURE_MONTHS} * max(0, -(${contribution}))`,
      capacityUnits: '0',
    };
  }

  const volume = `${A} * account_units_per_month`;
  if (p.contract === 'INTRODUCE' || p.contract === 'REPRESENT') {
    const cpu = 'broker_take_rate * price_per_unit';
    const contribution = `${volume} * ${cpu} - (${fixed})`;
    return {
      volume,
      billings: `${volume} * price_per_unit`,
      acquisitionPerAccount: 'outreach_cost_per_account / account_win_rate',
      capturePerUnit: cpu,
      fixedMonthly: fixed,
      contribution,
      upfront: `${G} + ${cac} + (${fixed})`,
      workingCapital: '0',
      firstRevenueDays: `max(${gateDays}, sales_cycle_days)`,
      firstCashDays: `max(${gateDays}, sales_cycle_days) + buyer_payment_days`,
      exposure: `${G} + ${cac} + ${EXPOSURE_MONTHS} * max(0, -(${contribution}))`,
      capacityUnits: `${volume} / (${W} * units_per_capacity_day)`,
    };
  }

  if (p.supply === 'NETWORK') {
    const supplyPerUnit = p.aggregation === 'POOLED' ? `contractor_day_rate / ${U}` : 'contractor_rate_per_unit';
    const cpu = `price_per_unit - ${supplyPerUnit}`;
    const contribution = `${volume} * (${cpu}) - (${fixed})`;
    const wc = `max(0, buyer_payment_days - supplier_payment_days) * ${volume} * ${supplyPerUnit} / 30`;
    return {
      volume,
      billings: `${volume} * price_per_unit`,
      acquisitionPerAccount: 'outreach_cost_per_account / account_win_rate',
      capturePerUnit: cpu,
      fixedMonthly: fixed,
      contribution,
      upfront: `${G} + ${cac} + ${wc} + (${fixed})`,
      workingCapital: wc,
      firstRevenueDays: `max(${gateDays}, sales_cycle_days)`,
      firstCashDays: `max(${gateDays}, sales_cycle_days) + buyer_payment_days`,
      exposure: `${G} + ${cac} + ${wc} + ${EXPOSURE_MONTHS} * max(0, -(${contribution}))`,
      capacityUnits: `${volume} / (${W} * ${U})`,
    };
  }

  // EMPLOY: whole capacity units, each costing a day whether or not it is full.
  const assetDay = p.assets === 'OWNED' ? 'asset_ownership_cost_per_day' : 'asset_lease_per_day';
  const dayCost = `(labor_cost_per_day + ${assetDay} + variable_cost_per_day + insurance_per_capacity_year / ${WORKING_DAYS_PER_YEAR})`;
  const fleet = `ceil(${volume} / (${W} * ${U}))`;
  const perUnitUpfront = p.assets === 'OWNED' ? `asset_purchase_cost + insurance_per_capacity_year / 4` : `asset_lease_deposit + insurance_per_capacity_year / 4`;
  const contribution = `${volume} * price_per_unit - ${fleet} * ${W} * ${dayCost} - (${fixed})`;
  const wc = `max(0, buyer_payment_days - ${PAYROLL_DAYS}) * ${fleet} * ${W} * ${dayCost} / 30`;
  const assetLoss = p.assets === 'OWNED' ? `${fleet} * asset_purchase_cost * ${FORCED_SALE_LOSS}` : `${fleet} * (asset_lease_deposit + insurance_per_capacity_year / 4)`;
  return {
    volume,
    billings: `${volume} * price_per_unit`,
    acquisitionPerAccount: 'outreach_cost_per_account / account_win_rate',
    capturePerUnit: `price_per_unit - ${dayCost} / ${U}`,
    fixedMonthly: fixed,
    contribution,
    upfront: `${G} + ${cac} + ${fleet} * (${perUnitUpfront}) + ${wc} + (${fixed})`,
    workingCapital: wc,
    firstRevenueDays: `max(${gateDays}, sales_cycle_days, hiring_days)`,
    firstCashDays: `max(${gateDays}, sales_cycle_days, hiring_days) + buyer_payment_days`,
    exposure: `${G} + ${cac} + ${assetLoss} + ${wc} + ${EXPOSURE_MONTHS} * max(0, -(${contribution}))`,
    capacityUnits: fleet,
  };
}

function keysOf(formulas: Formulas): FactKey[] {
  const set = new Set<string>();
  for (const f of Object.values(formulas)) identifiers(parse(f), set);
  return [...set].filter((k): k is FactKey => k in FACT_KEYS);
}

function valueAt(fact: ResolvedFact, c: Case): number {
  if (fact.status === 'UNKNOWN') return NaN;
  const better = HIGHER_IS_BETTER.has(fact.key);
  if (c === 'MID') return (fact.low + fact.high) / 2;
  if (c === 'WORST') return better ? fact.low : fact.high;
  return better ? fact.high : fact.low;
}

/** Evaluate one formula with every input given. */
const COMPILED = new Map<string, { names: string[]; fn: (env: Float64Array) => number }>();

export function evaluate(formula: string, values: Partial<Record<FactKey, number>>): number {
  let c = COMPILED.get(formula);
  if (!c) {
    const node = parse(formula);
    const names = [...identifiers(node)];
    c = { names, fn: compile(node, (name) => names.indexOf(name)) };
    if (COMPILED.size > 5_000) COMPILED.clear();
    COMPILED.set(formula, c);
  }
  const env = new Float64Array(c.names.length);
  for (let i = 0; i < c.names.length; i++) env[i] = values[c.names[i] as FactKey] ?? NaN;
  return c.fn(env);
}

function figures(formulas: Formulas, values: Partial<Record<FactKey, number>>, accounts: number): CaseFigures {
  const ev = (f: string) => evaluate(f, values);
  const contribution = ev(formulas.contribution);
  const fixed = ev(formulas.fixedMonthly);
  const gross = contribution + fixed;
  const billings = ev(formulas.billings);
  const acquisition = ev(formulas.acquisitionPerAccount);
  const perAccount = accounts > 0 ? gross / accounts : gross;
  const capacity = ev(formulas.capacityUnits);
  return {
    contribution,
    revenue: gross,
    billings,
    directCost: Math.max(0, billings - gross),
    indirectCost: fixed,
    acquisitionPerAccount: acquisition,
    acquisitionPaybackMonths: perAccount > 0 ? acquisition / perAccount : null,
    workers: capacity > 0 ? Math.ceil(capacity - 1e-9) : 0,
    upfront: ev(formulas.upfront),
    workingCapital: ev(formulas.workingCapital),
    firstRevenueDays: ev(formulas.firstRevenueDays),
    firstCashDays: ev(formulas.firstCashDays),
    exposure: ev(formulas.exposure),
    capacityUnits: ev(formulas.capacityUnits),
    capturePerUnit: ev(formulas.capturePerUnit),
    fixedMonthly: fixed,
  };
}

function bisect(f: (x: number) => number, lo: number, hi: number): number | null {
  let a = lo;
  let b = hi;
  let fa = f(a);
  const fb = f(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || Math.sign(fa) === Math.sign(fb)) return null;
  for (let i = 0; i < 80; i++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (Math.sign(fm) === Math.sign(fa)) {
      a = m;
      fa = fm;
    } else b = m;
  }
  return (a + b) / 2;
}

function money(x: number): string {
  return `$${Math.round(x).toLocaleString('en-US')}`;
}

function fmtValue(key: FactKey, x: number): string {
  const unit = FACT_KEYS[key].unit;
  if (unit === 'share') return `${(x * 100).toFixed(1)}%`;
  if (unit.startsWith('USD')) return `${x < 20 ? `$${x.toFixed(2)}` : money(x)}${unit.slice(3)}`;
  return `${x < 20 ? x.toFixed(1) : Math.round(x)} ${unit}`;
}

function rangeOf(est: { p10: number; p50: number; p90: number; tier: string; distributionJustified: boolean } | undefined): RangeReading | null {
  if (!est || est.tier === 'UNKNOWN') return null;
  return { p10: est.p10, p50: est.p50, p90: est.p90, tier: est.tier, distributionJustified: est.distributionJustified };
}

/** Reconstruct the two headline figures with Brain's quant engine. */
function reconstructHeadline(formulas: Formulas, inputs: ResolvedFact[], evidence: IndustryEvidence, gates: { low: number; high: number }, now: Date): BusinessEconomics['reconstructed'] {
  const target = evidence.geography ?? 'target market';
  const nodes: QuantityNode[] = inputs.map((fact) => {
    const def = FACT_KEYS[fact.key];
    const kind = def.kind === 'RATE' ? 'RATE' : 'POSITIVE';
    const node: QuantityNode = { key: fact.key, label: def.label, unit: def.unit, kind, min: 0, context: { geography: target } };
    if (fact.status === 'ASSUMPTION') {
      node.assumed = { low: fact.low, high: fact.high, source: { kind: 'OTHER', ref: fact.sources[0]?.title ?? 'assumption' } };
    } else if (fact.status !== 'UNKNOWN') {
      const floor = kind === 'POSITIVE' ? Math.max(1e-3, fact.high * 1e-3) : 0;
      const low = Math.max(floor, Math.min(fact.low, fact.high));
      const high = Math.max(low, fact.high);
      const observations: Observation[] = fact.sources.map((s, i) => ({
        id: `${fact.key}_${i}`,
        value: high > low ? { kind: 'RANGE', low, high } : { kind: 'POINT', value: low },
        // Our own result or a primary source about this market is direct; a published figure is about somewhere else.
        context: { geography: fact.status === 'OBSERVED' || fact.status === 'VERIFIED' ? target : `published: ${s.title}` },
        lineage: [s.url ?? s.title],
        source: { kind: s.url ? 'URL' : s.kind === 'OUTCOME' ? 'LEDGER_ENTRY' : s.claimId ? 'CLAIM' : 'OTHER', ref: s.url ?? s.claimId ?? s.title },
      }));
      node.observations = observations;
    }
    return node;
  });
  nodes.push({
    key: 'gate_costs',
    label: 'Licences, insurance, bonds and program fees paid before the first transaction',
    unit: 'USD',
    kind: 'POSITIVE',
    min: 0,
    assumed: { low: gates.low, high: Math.max(gates.low, gates.high), source: { kind: 'OTHER', ref: 'the gates the evidence names' } },
  });
  const swap = (f: string) => f.replace(/^\d+(?:\.\d+)? \+/, 'gate_costs +');
  nodes.push({ key: 'headline_contribution', label: 'Monthly contribution', unit: 'USD/month', kind: 'REAL', formula: formulas.contribution });
  nodes.push({ key: 'headline_upfront', label: 'Money committed before the first collected dollar', unit: 'USD', kind: 'REAL', formula: swap(formulas.upfront) });
  const graph: QuantGraph = { nodes };
  try {
    const c = reconstruct(graph, 'headline_contribution', now);
    const u = reconstruct(graph, 'headline_upfront', now);
    return { contribution: rangeOf(c.estimates['headline_contribution']), upfront: rangeOf(u.estimates['headline_upfront']) };
  } catch {
    return { contribution: null, upfront: null };
  }
}

/** Solve one business's economics at a planning scale. Pure. */
export function solveEconomics(
  b: Business,
  evidence: IndustryEvidence,
  options: { accounts: number; held?: ReadonlySet<Asset>; reconstructRanges?: boolean; thresholds?: boolean; now?: Date },
): BusinessEconomics {
  const held = options.held ?? new Set<Asset>();
  const gates = gateFigures(b, held);
  const measured = new Set(evidence.facts.map((x) => x.key));
  const build = (gateCase: number) => formulasFor(b, options.accounts, gates, gateCase, measured);
  const formulas = build((gates.low + gates.high) / 2);
  const keys = keysOf(formulas);
  const inputs = keys.map((k) => resolveFact(evidence.facts, k, FACT_KEYS[k].segment ? b.segment.actorId : null));
  const unpriced = inputs.filter((f) => f.status === 'UNKNOWN').map((f) => f.key);
  const valuesAt = (c: Case, override?: { key: FactKey; value: number }) => {
    const v: Partial<Record<FactKey, number>> = {};
    for (const f of inputs) v[f.key] = valueAt(f, c);
    if (override) v[override.key] = override.value;
    return v;
  };
  const priced = unpriced.length === 0;
  const worst = priced ? figures(build(gates.high), valuesAt('WORST'), options.accounts) : null;
  const mid = priced ? figures(formulas, valuesAt('MID'), options.accounts) : null;
  const best = priced ? figures(build(gates.low), valuesAt('BEST'), options.accounts) : null;

  // Thresholds: for each input, the value where contribution crosses zero, others at their middle.
  const thresholds: Threshold[] = [];
  const contributionKeys = new Set(identifiers(parse(formulas.contribution)));
  for (const fact of options.thresholds === false ? [] : inputs) {
    if (!contributionKeys.has(fact.key)) continue;
    const others = inputs.filter((o) => o.key !== fact.key && o.status === 'UNKNOWN');
    if (others.length > 0) continue;
    const def = FACT_KEYS[fact.key];
    const f = (x: number) => evaluate(formulas.contribution, valuesAt('MID', { key: fact.key, value: x }));
    const top = def.kind === 'RATE' ? 1 : Math.max(10 * (Number.isFinite(fact.high) ? fact.high : 0), 1e6);
    const be = bisect(f, 0, top);
    const viableWhen: 'ABOVE' | 'BELOW' = HIGHER_IS_BETTER.has(fact.key) ? 'ABOVE' : 'BELOW';
    const known = fact.status !== 'UNKNOWN';
    let reading: Threshold['reading'];
    if (be === null) reading = f(top / 2) > 0 ? 'CLEARS' : 'NO_BREAK_EVEN';
    else if (!known) reading = 'UNKNOWN_RANGE';
    else {
      const okLow = viableWhen === 'ABOVE' ? fact.low >= be : fact.low <= be;
      const okHigh = viableWhen === 'ABOVE' ? fact.high >= be : fact.high <= be;
      reading = okLow && okHigh ? 'CLEARS' : okLow || okHigh ? 'STRADDLES' : 'FAILS';
    }
    const range = known ? ` (evidence ${fmtValue(fact.key, fact.low)}–${fmtValue(fact.key, fact.high)}, ${fact.status.toLowerCase()})` : ' (no evidence yet)';
    const sentence =
      be === null
        ? reading === 'CLEARS'
          ? `${def.label}: viable across any value${range}.`
          : `${def.label}: no value makes it viable with the other inputs at their middle${range}.`
        : `${def.label} must be ${viableWhen === 'ABOVE' ? 'at least' : 'at most'} ${fmtValue(fact.key, be)}${range}.`;
    // Only inputs that decide something are worth a line.
    if (reading === 'CLEARS' && fact.status !== 'UNKNOWN' && be === null) continue;
    const condition = be === null ? null : `${def.label.charAt(0).toLowerCase()}${def.label.slice(1)} ${viableWhen === 'ABOVE' ? '≥' : '≤'} ${fmtValue(fact.key, be)}`;
    thresholds.push({ key: fact.key, label: def.label, status: fact.status, breakEven: be, viableWhen, low: known ? fact.low : null, high: known ? fact.high : null, reading, sentence, condition });
  }

  const sensitivity: { key: FactKey; swing: number }[] = [];
  if (priced && options.thresholds !== false) {
    for (const fact of inputs) {
      if (!contributionKeys.has(fact.key)) continue;
      const lo = evaluate(formulas.contribution, valuesAt('MID', { key: fact.key, value: valueAt(fact, 'WORST') }));
      const hi = evaluate(formulas.contribution, valuesAt('MID', { key: fact.key, value: valueAt(fact, 'BEST') }));
      sensitivity.push({ key: fact.key, swing: Math.abs(hi - lo) });
    }
    sensitivity.sort((a, b) => b.swing - a.swing);
  }

  let breakEvenAccounts: number | null = null;
  if (mid && b.position.supply !== 'RECRUIT' && options.accounts > 0) {
    const perAccount = (mid.contribution + mid.fixedMonthly) / options.accounts;
    breakEvenAccounts = perAccount > 0 ? mid.fixedMonthly / perAccount : null;
  }

  const viability: BusinessEconomics['viability'] = !priced ? 'UNPRICED' : worst!.contribution > 0 ? 'VIABLE' : best!.contribution > 0 ? 'CONDITIONAL' : 'NOT_VIABLE';
  const reconstructed = options.reconstructRanges && priced ? reconstructHeadline(formulas, inputs, evidence, gates, options.now ?? new Date()) : { contribution: null, upfront: null };
  return {
    accounts: options.accounts,
    formulas,
    inputs,
    unpriced,
    unpricedGates: gates.unpriced,
    worst,
    mid,
    best,
    breakEvenAccounts,
    viability,
    thresholds,
    sensitivity,
    reconstructed,
  };
}
