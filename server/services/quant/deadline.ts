/**
 * Research spends the calendar it is meant to protect.
 *
 * For a squeeze goal — little money, little time — a week of research is a
 * week less to sell, deliver and get paid in. Before an unknown becomes a
 * research question this decides, from numbers rather than habit, which of
 * four things to do about it:
 *
 *   * `IGNORE` — knowing it would not change the decision (its information
 *     value is nothing, or less than the research costs);
 *   * `RESEARCH_FIRST` — it changes the decision, and the research plus the
 *     slowest likely path to cash still fits before the deadline;
 *   * `LEARN_WHILE_EXECUTING` — it changes the decision, but waiting for it
 *     would cost the deadline, and the first real attempt reveals it anyway
 *     (a conversion rate is learned by asking buyers, not by reading about it);
 *   * `ACT_ON_RECONSTRUCTION` — it changes the decision, waiting would cost the
 *     deadline, and nothing during execution reveals it in time: the estimate
 *     already reconstructed is what the decision is made on, said so.
 *
 * A real-world test is never an automatic prerequisite: it is chosen only when
 * it fits the calendar and is worth more than it costs.
 */

import { listMoneyEntries } from '../../repos/cashLedger.ts';
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import type { CashMoneyEntry, CashOpportunity } from '../../domain/types.ts';

export const RESEARCH_DECISIONS = ['IGNORE', 'RESEARCH_FIRST', 'LEARN_WHILE_EXECUTING', 'ACT_ON_RECONSTRUCTION'] as const;
export type ResearchDecision = (typeof RESEARCH_DECISIONS)[number];

export interface ResearchQuestion {
  key: string;
  /** Expected gain in the decision's score from knowing it (from `informationValue`). */
  informationValue: number;
  changesDecision: boolean;
  /** Days the research is expected to take before an answer lands. */
  researchDays: number;
  /** What the research costs, in the score's units (often 0 for subscription research). */
  researchCost?: number;
  /** True when the first real attempt reveals the answer anyway. */
  learnableInExecution: boolean;
}

export interface CalendarInput {
  daysLeft: number;
  /** The slowest likely path from starting to usable cash (a p90), in days. */
  executionDaysP90: number;
}

export interface ResearchVerdict {
  key: string;
  decision: ResearchDecision;
  reason: string;
}

export function decideResearch(question: ResearchQuestion, calendar: CalendarInput): ResearchVerdict {
  const cost = question.researchCost ?? 0;
  if (!question.changesDecision || question.informationValue <= cost) {
    return {
      key: question.key,
      decision: 'IGNORE',
      reason: !question.changesDecision
        ? 'whatever the answer, the same choice is best, so researching it buys nothing'
        : `it could change the choice, but by less (${fmt(question.informationValue)}) than the research costs (${fmt(cost)})`,
    };
  }
  const slack = calendar.daysLeft - calendar.executionDaysP90;
  if (question.researchDays <= slack) {
    return { key: question.key, decision: 'RESEARCH_FIRST', reason: `it changes the choice and ${fmt(question.researchDays)} days of research still leaves the slowest path (${fmt(calendar.executionDaysP90)} days) inside the ${fmt(calendar.daysLeft)} left` };
  }
  if (question.learnableInExecution) {
    return { key: question.key, decision: 'LEARN_WHILE_EXECUTING', reason: `waiting ${fmt(question.researchDays)} days for it would push the slowest path past the deadline; the first real attempt reveals it` };
  }
  return { key: question.key, decision: 'ACT_ON_RECONSTRUCTION', reason: `waiting ${fmt(question.researchDays)} days for it would cost the deadline and nothing during execution reveals it in time; decide on the reconstructed estimate, stated as such` };
}

/** Share of worlds in which a sequence of steps finishes inside the window after a delay. */
export function finishesInTime(steps: number[][], daysLeft: number, delayDays = 0): number {
  if (steps.length === 0) return 1;
  const n = Math.min(...steps.map((one) => one.length));
  let ok = 0;
  for (let i = 0; i < n; i++) {
    let total = delayDays;
    for (const step of steps) total += step[i]!;
    if (total <= daysLeft) ok += 1;
  }
  return n === 0 ? 0 : ok / n;
}

function fmt(x: number): string {
  return Math.abs(x) < 10 ? x.toFixed(2).replace(/\.?0+$/, '') : String(Math.round(x));
}

// ---------------------------------------------------------------------------
// Money velocity and deal structure (MONEY-13-4)
//
// The same calendar that bounds research bounds money: how long from a lead to
// a commitment, from a commitment to funds, from funds to cash that may be
// spent. Every figure here is derived from rows the caller already holds; a
// figure no row states is `null` (unknown), never zero and never assumed.
// Nothing here is a whitelist of categories or industries, and it adds no
// store, scheduler or authority path.
// ---------------------------------------------------------------------------

/** One dated money movement on a route. Amounts are positive; `kind` gives direction. */
export interface MoneyEvent {
  /** ISO-8601 UTC instant the movement happened (or is due). */
  at: string;
  kind:
    | 'BILLING' // invoiced / committed by the buyer
    | 'BILLING_RELEASED' // an agreement that will no longer be billed: the append-only undo of a billing
    | 'FUNDS_RECEIVED' // money reached the account
    | 'SUPPLIER_OUTLAY' // money that has left for a supplier or an incremental cost
    | 'SUPPLIER_LIABILITY' // a supplier cost incurred and owed, not yet paid
    | 'LIABILITY_PAID' // the part of a payment that closes what was owed (the outlay row records the money)
    | 'LIABILITY_RELEASED' // a liability that shrank before it was paid: owed no longer, never a cost
    | 'RESTRICTED' // money protected from use (delivery, tax, operating reserve)
    | 'RESTRICTION_RELEASED'
    | 'OWNER_CAPITAL_IN' // the owner's own capital put in: never billings, settled cash or borrowing
    | 'OWNER_DISTRIBUTION' // capital taken out to the owner
    | 'BORROWED_IN' // borrowed proceeds
    | 'REFUND'
    | 'CHARGEBACK';
  amount: number;
  /** Who funded an outlay. Only meaningful for SUPPLIER_OUTLAY; unstated stays unknown. */
  fundedBy?: 'CUSTOMER' | 'SELF';
  /** True when the money is restricted, refundable, or earmarked for a fulfilment liability. */
  encumbered?: boolean;
}

export interface RouteMoneyInput {
  routeKey: string;
  leadAt?: string;
  commitmentAt?: string;
  usableCashAt?: string;
  events: MoneyEvent[];
  /** Cash identities, each stated by its own row or left undefined. Never derived from each other. */
  identities?: Partial<Record<CashIdentity, number>>;
  /**
   * True when the source the events came from has no way to record borrowed money
   * at all (Brain's ledger has no borrowing kind, and `BORROW_OR_LEVERAGE` is never
   * grantable), so an absence of `BORROWED_IN` is a structural zero rather than an unknown.
   */
  borrowingUnrecordable?: boolean;
  /**
   * True when the rows record every customer receipt and every outlay of the
   * route (a ledger route), so an outlay whose funder no row states is
   * attributed from the rows themselves: the part the customer's money already
   * in hand covered was customer-funded, the rest was self-funded
   * (`attributeFunding`). Left unset, an unstated funder stays unattributed.
   */
  fundingFromReceipts?: boolean;
}

/**
 * Who funded each outlay whose funder no row states, read from the order money
 * moved. Walks the route's movements in time order, drain-first at the same
 * instant (the order peak working capital uses, so a same-moment receipt never
 * funds an outlay): customer receipts fill a pool, refunds and chargebacks give
 * customer money back out of it, and each outlay is customer-funded up to what
 * the pool still holds and self-funded beyond it. An outlay a row already
 * attributes keeps its funder; a customer-funded one draws on the pool. The
 * owner's own capital and borrowing are never customer money. Pure.
 */
export function attributeFunding(events: readonly MoneyEvent[]): { customer: number; self: number; derived: number } {
  const t = (e: MoneyEvent) => Date.parse(e.at);
  const drains = (e: MoneyEvent) => e.kind === 'SUPPLIER_OUTLAY' || e.kind === 'REFUND' || e.kind === 'CHARGEBACK';
  const flow = events
    .filter((e) => Number.isFinite(e.amount) && e.amount >= 0 && Number.isFinite(t(e)))
    .filter((e) => e.kind === 'FUNDS_RECEIVED' || drains(e))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => t(a.e) - t(b.e) || Number(drains(b.e)) - Number(drains(a.e)) || a.i - b.i)
    .map(({ e }) => e);
  let pool = 0;
  let customer = 0;
  let self = 0;
  let derived = 0;
  for (const e of flow) {
    if (e.kind === 'FUNDS_RECEIVED') pool += e.amount;
    else if (e.kind === 'REFUND' || e.kind === 'CHARGEBACK') pool = Math.max(0, pool - e.amount);
    else if (e.fundedBy === 'SELF') self += e.amount;
    else {
      const covered = Math.min(e.amount, pool);
      if (e.fundedBy === 'CUSTOMER') {
        customer += e.amount;
        pool -= covered;
        continue;
      }
      pool -= covered;
      customer += covered;
      self += e.amount - covered;
      derived += e.amount;
    }
  }
  return { customer, self, derived };
}

export const CASH_IDENTITIES = [
  'GROSS_BILLINGS',
  'GROSS_MARGIN',
  'NET_PROFIT',
  'SETTLED_CASH',
  'RETAINED_CASH',
  'OWNER_DISTRIBUTIONS',
  'ENTERPRISE_VALUE',
  'BORROWED_PROCEEDS',
  'USABLE_CASH',
] as const;
export type CashIdentity = (typeof CASH_IDENTITIES)[number];

export interface RouteMoneyVelocity {
  routeKey: string;
  customerFundedSpend: number | null;
  selfFundedSpend: number | null;
  /** Outlays whose funder no row states. */
  unattributedSpend: number | null;
  daysLeadToCommitment: number | null;
  daysCommitmentToFunds: number | null;
  daysFundsToUsableCash: number | null;
  supplierOutlays: { at: string; amount: number }[];
  /** Supplier costs incurred and owed, dated when incurred. */
  supplierLiabilities: { at: string; amount: number }[];
  /** Incurred less paid less released; null when no liability row exists. */
  supplierLiabilityOutstanding: number | null;
  /** Money still restricted (reserved less released); 0 when no reserve row exists. */
  restrictedCash: number;
  /** The owner's own capital put into the route; null when no such row. Never counted as billings, settled cash or borrowing. */
  ownerCapitalIn: number | null;
  refundsAndChargebacks: number | null;
  /** Billed but not yet received. */
  receivables: number | null;
  /** Largest cumulative cash shortfall while outlays and receipts overlap. */
  peakWorkingCapital: number | null;
  /** Funds received minus what is still encumbered, refunded, restricted or owed to suppliers, each dollar once; negative when those exceed receipts; null when no funds row exists. */
  usableCash: number | null;
  excludedFromUsable: number;
  /** The nine identities: row-derived where rows state them (billings, margin, settled, usable, distributions, borrowing), else validated as stated, else null. */
  identities: Record<CashIdentity, number | null>;
  unknowns: string[];
}

function ms(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function daysBetween(from: string | undefined, to: string | undefined): number | null {
  const a = ms(from);
  const b = ms(to);
  if (a === null || b === null || b < a) return null;
  return (b - a) / 86_400_000;
}

function sum(xs: number[]): number {
  return xs.reduce((t, x) => t + x, 0);
}

export function quantifyRouteMoney(route: RouteMoneyInput): RouteMoneyVelocity {
  const unknowns: string[] = [];
  const ev = route.events.filter((e) => Number.isFinite(e.amount) && e.amount >= 0 && ms(e.at) !== null);
  const of = (k: MoneyEvent['kind']) => ev.filter((e) => e.kind === k);

  const outlays = of('SUPPLIER_OUTLAY').sort((a, b) => ms(a.at)! - ms(b.at)!);
  // On a route whose rows record every receipt and outlay, an unstated funder is read from the
  // order money moved; anywhere else it stays unattributed rather than assumed.
  const funding = route.fundingFromReceipts && outlays.length > 0 ? attributeFunding(ev) : null;
  const spendBy = (who: 'CUSTOMER' | 'SELF') =>
    funding ? (who === 'CUSTOMER' ? funding.customer : funding.self)
    : outlays.some((o) => o.fundedBy === who) ? sum(outlays.filter((o) => o.fundedBy === who).map((o) => o.amount)) : null;
  const unattributed = funding ? [] : outlays.filter((o) => !o.fundedBy);
  if (outlays.length === 0) unknowns.push('no supplier outlay row');
  else if (unattributed.length > 0) unknowns.push('some supplier outlays do not say who funded them');

  const billings = of('BILLING');
  const releasedBillings = of('BILLING_RELEASED');
  const funds = of('FUNDS_RECEIVED');
  const returned = [...of('REFUND'), ...of('CHARGEBACK')];
  // An agreement released by its own entry is no longer billed, so it is neither billings nor receivable.
  const billed = billings.length ? Math.max(0, sum(billings.map((e) => e.amount)) - sum(releasedBillings.map((e) => e.amount))) : null;
  if (!billings.length && releasedBillings.length) unknowns.push('a billing release has no billing row to release');
  const received = funds.length ? sum(funds.map((e) => e.amount)) : null;
  const encumbered = sum(funds.filter((e) => e.encumbered).map((e) => e.amount));
  const refunds = returned.length ? sum(returned.map((e) => e.amount)) : null;

  // Earliest receipt by parsed instant, never by string order: offsets and fractional-second
  // formats make ISO strings sort differently from the moments they name.
  const firstFunds = funds.length ? funds.reduce((a, b) => (ms(b.at)! < ms(a.at)! ? b : a)).at : undefined;
  const lead = daysBetween(route.leadAt, route.commitmentAt);
  const toFunds = daysBetween(route.commitmentAt, firstFunds);
  const toUsable = daysBetween(firstFunds, route.usableCashAt);
  // A stage whose end precedes its start is a data error, which is not the same as an absence.
  const stage = (label: string, days: number | null, from: string | undefined, to: string | undefined) => {
    if (days !== null) return;
    const a = ms(from);
    const b = ms(to);
    unknowns.push(a !== null && b !== null && b < a ? `${label} time is inconsistent: the later event is dated before the earlier one` : `${label} time not stated`);
  };
  stage('lead-to-commitment', lead, route.leadAt, route.commitmentAt);
  stage('commitment-to-funds', toFunds, route.commitmentAt, firstFunds);
  stage('funds-to-usable-cash', toUsable, firstFunds, route.usableCashAt);

  // Receivables need both sides stated: a missing funds row is an unknown, never zero received
  // (invariant 39). Received can exceed billed (advances), so floor at 0.
  const receivables = billed === null || received === null ? null : Math.max(0, billed - received);
  if (billed === null) unknowns.push('no billing row, receivables unknown');
  else if (received === null) unknowns.push('no funds-received row, receivables unknown');

  // Peak working capital: walk movements in time order; outlays and refunds drain, receipts refill.
  let peak: number | null = null;
  if (outlays.length > 0 || returned.length > 0) {
    const flow = [
      ...outlays.map((e) => ({ t: ms(e.at)!, d: -e.amount })),
      ...returned.map((e) => ({ t: ms(e.at)!, d: -e.amount })),
      ...funds.map((e) => ({ t: ms(e.at)!, d: e.amount })),
    ].sort((a, b) => a.t - b.t || a.d - b.d);
    let bal = 0;
    let low = 0;
    for (const f of flow) {
      bal += f.d;
      low = Math.min(low, bal);
    }
    peak = -low;
  } else unknowns.push('no outflow rows, peak working capital unknown');

  // Supplier liabilities: incurred and not yet paid is owed (and is needed to fulfil it), so it is
  // excluded from usable cash and is a cost in the margin. A paid liability is recorded as money by its
  // SUPPLIER_OUTLAY row; LIABILITY_PAID only closes what was owed, so it is never a second outlay.
  const liabilities = of('SUPPLIER_LIABILITY').sort((a, b) => ms(a.at)! - ms(b.at)!);
  const liabilityClosed = sum([...of('LIABILITY_PAID'), ...of('LIABILITY_RELEASED')].map((e) => e.amount));
  const liabilityOutstanding = liabilities.length ? Math.max(0, sum(liabilities.map((e) => e.amount)) - liabilityClosed) : null;
  // Restricted money (a reserve) is in the account and not usable until released.
  const restricted = Math.max(0, sum(of('RESTRICTED').map((e) => e.amount)) - sum(of('RESTRICTION_RELEASED').map((e) => e.amount)));
  const ownerIn = of('OWNER_CAPITAL_IN');
  const distributions = of('OWNER_DISTRIBUTION');
  const borrowed = of('BORROWED_IN');

  // A dollar leaves usable cash once. A refund of money that was received encumbered (refundable) is
  // that encumbrance being discharged, so it comes out of the encumbered pool first and only the rest
  // of the refund reduces the unencumbered money. Subtracting both would count the same dollars twice (§37).
  const refundTotal = refunds ?? 0;
  const refundedFromEncumbered = Math.min(refundTotal, encumbered);
  const stillEncumbered = encumbered - refundedFromEncumbered;
  // Not clamped: refunds beyond what was received are a liability, and a negative figure says so.
  const usable = received === null ? null : received - stillEncumbered - refundTotal - restricted - (liabilityOutstanding ?? 0);
  if (received === null) unknowns.push('no funds-received row, usable cash unknown');
  else if (usable !== null && usable < 0) unknowns.push(`refunds and chargebacks exceed funds received by ${-usable}: a liability, not usable cash`);

  const identities = {} as Record<CashIdentity, number | null>;
  // Only NET_PROFIT and GROSS_MARGIN can legitimately be negative; every other identity is a non-negative balance.
  const mayBeNegative = new Set<CashIdentity>(['NET_PROFIT', 'GROSS_MARGIN']);
  for (const k of CASH_IDENTITIES) {
    const stated = route.identities?.[k];
    if (stated === undefined || stated === null) {
      identities[k] = null;
    } else if (typeof stated !== 'number' || !Number.isFinite(stated) || (stated < 0 && !mayBeNegative.has(k))) {
      identities[k] = null;
      unknowns.push(`${k.toLowerCase()} stated value is not a valid amount, ignored`);
    } else identities[k] = stated;
  }
  // Gross margin is row-stated when both of its sides are: billings net of refunds and chargebacks,
  // minus supplier outlays. With no outlay row the cost side is unknown, never zero (invariant 39).
  // A cost incurred and not yet paid is a cost, so an outstanding liability is on the cost side too.
  const costRows = outlays.length > 0 || liabilities.length > 0;
  const margin = billed !== null && costRows ? billed - refundTotal - sum(outlays.map((o) => o.amount)) - (liabilityOutstanding ?? 0) : null;
  const borrowedFromRows = borrowed.length ? sum(borrowed.map((e) => e.amount)) : route.borrowingUnrecordable ? 0 : null;
  // Identities the rows themselves state are derived from the rows; a caller-supplied figure never overrides them.
  const derived: Partial<Record<CashIdentity, number | null>> = {
    GROSS_BILLINGS: billed,
    GROSS_MARGIN: margin,
    SETTLED_CASH: received,
    USABLE_CASH: usable,
    OWNER_DISTRIBUTIONS: distributions.length ? sum(distributions.map((e) => e.amount)) : null,
    BORROWED_PROCEEDS: borrowedFromRows,
  };
  for (const k of Object.keys(derived) as CashIdentity[]) {
    const fromRows = derived[k] ?? null;
    if (fromRows === null) continue;
    if (identities[k] !== null && identities[k] !== fromRows) unknowns.push(`${k.toLowerCase()} stated value disagrees with the rows, rows used`);
    identities[k] = fromRows;
  }
  for (const k of CASH_IDENTITIES) if (identities[k] === null) unknowns.push(`${k.toLowerCase()} not stated`);

  return {
    routeKey: route.routeKey,
    customerFundedSpend: spendBy('CUSTOMER'),
    selfFundedSpend: spendBy('SELF'),
    unattributedSpend: outlays.length ? sum(unattributed.map((o) => o.amount)) : null,
    daysLeadToCommitment: lead,
    daysCommitmentToFunds: toFunds,
    daysFundsToUsableCash: toUsable,
    supplierOutlays: outlays.map((o) => ({ at: o.at, amount: o.amount })),
    supplierLiabilities: liabilities.map((o) => ({ at: o.at, amount: o.amount })),
    supplierLiabilityOutstanding: liabilityOutstanding,
    restrictedCash: restricted,
    ownerCapitalIn: ownerIn.length ? sum(ownerIn.map((e) => e.amount)) : null,
    refundsAndChargebacks: refunds,
    receivables,
    peakWorkingCapital: peak,
    usableCash: usable,
    // What leaves usable cash, each dollar once: usable cash plus this equals funds received.
    excludedFromUsable: stillEncumbered + refundTotal + restricted + (liabilityOutstanding ?? 0),
    identities,
    unknowns,
  };
}

export interface RouteScore {
  routeKey: string;
  /** Collectible contribution per unit of peak capital per day of cycle; null when any input is unknown. */
  capitalTurnover: number | null;
  riskAdjustedContribution: number | null;
}

/**
 * The share of billings the rows show collected, in [0, 1]; null when either side
 * is unstated. Used as the collection probability when the caller states none, so
 * a route on production rows is scored from what was measured, not left unscored.
 */
export function observedCollectionRate(money: RouteMoneyVelocity): number | null {
  const billed = money.identities.GROSS_BILLINGS;
  const received = money.identities.SETTLED_CASH;
  if (billed === null || received === null || billed <= 0) return null;
  return Math.min(1, Math.max(0, received / billed));
}

/**
 * Rank routes for an objective. Contribution is the gross margin times the
 * probability it is collected (stated by the caller, else measured from the rows);
 * turnover divides by the capital held for the cycle.
 * A route with an unknown input is scored null and sorted last, never as zero, and
 * retaining all cash is not a requirement: nothing here reads RETAINED_CASH.
 */
export type RouteObjective = 'TURNOVER' | 'CONTRIBUTION';

/**
 * Collectible contribution per unit of capital held per day of cycle — the one
 * turnover formula, shared by the ledger's route ranking and by the portfolio
 * search that chooses which combination of routes the goal runs. A capital or
 * cycle below one is read as one, so a route that ties up nothing is not
 * infinitely fast.
 */
export function capitalTurnover(contribution: number | null, capital: number | null, cycleDays: number | null): number | null {
  if (contribution === null || capital === null || cycleDays === null) return null;
  if (!Number.isFinite(contribution) || !Number.isFinite(capital) || !Number.isFinite(cycleDays)) return null;
  return contribution / (Math.max(capital, 1) * Math.max(cycleDays, 1));
}

/**
 * Which score decides between candidates that serve the objective equally
 * well. When they reach the objective, the one returning its capital fastest
 * is better (more turnover from the same money); when neither reaches it, the
 * one collecting more risk-adjusted contribution is closer. Retaining cash is
 * never the objective.
 */
export function objectiveScore(score: Pick<RouteScore, 'capitalTurnover' | 'riskAdjustedContribution'>, objective: RouteObjective): number | null {
  return objective === 'TURNOVER' ? score.capitalTurnover : score.riskAdjustedContribution;
}

/** Order candidates by an objective; an unknown score sorts last, never as zero. */
export function rankByObjective<T extends Pick<RouteScore, 'capitalTurnover' | 'riskAdjustedContribution'>>(scores: T[], objective: RouteObjective): T[] {
  return [...scores].sort((a, b) => (objectiveScore(b, objective) ?? -Infinity) - (objectiveScore(a, objective) ?? -Infinity));
}

export function scoreRoutes(
  routes: { money: RouteMoneyVelocity; collectionProbability?: number }[],
  objective: RouteObjective,
): RouteScore[] {
  const scored = routes.map(({ money, collectionProbability }) => {
    const margin = money.identities.GROSS_MARGIN;
    const p = collectionProbability ?? observedCollectionRate(money) ?? undefined;
    const contribution = margin === null || p === undefined || !Number.isFinite(p) || p < 0 || p > 1 ? null : margin * p;
    const cycle =
      money.daysLeadToCommitment !== null && money.daysCommitmentToFunds !== null && money.daysFundsToUsableCash !== null
        ? money.daysLeadToCommitment + money.daysCommitmentToFunds + money.daysFundsToUsableCash
        : null;
    return { routeKey: money.routeKey, capitalTurnover: capitalTurnover(contribution, money.peakWorkingCapital, cycle), riskAdjustedContribution: contribution };
  });
  return rankByObjective(scored, objective);
}

/**
 * The consumer of the route money model: reads the project's append-only money
 * ledger (`cash_money_entries`) into `MoneyEvent`s, one route per opportunity,
 * and quantifies each. This is what puts the figures on production rows — nothing
 * here stores a result or adds a scheduler.
 *
 * Mapping, every line a stated row and nothing inferred:
 *  - PIPELINE_AGREED is a billing, and its earliest date the commitment;
 *    PIPELINE_RELEASED is that billing released, so it leaves billings and receivables;
 *  - CUSTOMER_PAYMENT is funds received; SETTLEMENT is the same money becoming
 *    usable, so it dates usable cash and is never counted as a second receipt;
 *  - COST is a supplier outlay; no row states its funder, so it is attributed
 *    from the route's own rows (`attributeFunding`): covered by customer money
 *    already received is customer-funded, the rest self-funded — never assumed;
 *  - UNPAID_COMMITMENT is a supplier liability, dated when incurred;
 *    COMMITMENT_PAID closes it (the matching COST row is the money, so it is never
 *    a second outlay) and COMMITMENT_RELEASED shrinks it;
 *  - RESERVE restricts money and RESERVE_RELEASE frees it;
 *  - CAPITAL_IN is the owner's own capital (never borrowing, billings or settled
 *    cash) and CAPITAL_OUT an owner distribution;
 *  - REFUND is a refund.
 * Every ledger kind is mapped: the switch is exhaustive over `CashMoneyKind`, so a
 * kind added to the ledger fails the typecheck here instead of being dropped.
 * The ledger has no borrowing kind and borrowing is never grantable, so borrowed
 * proceeds on a ledger route are a structural zero, not an unknown.
 * Lead time has no ledger row: it is the instant the opportunity (the lead) was
 * recorded, passed in `leadAtByRoute` from the opportunity row itself; a route
 * whose lead row is not supplied keeps lead time unknown.
 * Entries with no opportunity belong to no route and are left out.
 */
export function routeInputsFromEntries(
  entries: readonly CashMoneyEntry[],
  leadAtByRoute: ReadonlyMap<string, string> = new Map(),
): RouteMoneyInput[] {
  const byRoute = new Map<string, CashMoneyEntry[]>();
  for (const e of entries) {
    if (!e.opportunityId) continue;
    const list = byRoute.get(e.opportunityId) ?? [];
    list.push(e);
    byRoute.set(e.opportunityId, list);
  }
  const inputs: RouteMoneyInput[] = [];
  for (const [routeKey, rows] of byRoute) {
    const events: MoneyEvent[] = [];
    const agreed: string[] = [];
    const settled: string[] = [];
    for (const e of rows) {
      const amount = e.amountCents / 100;
      switch (e.kind) {
        case 'PIPELINE_AGREED':
          events.push({ at: e.occurredAt, kind: 'BILLING', amount });
          agreed.push(e.occurredAt);
          break;
        case 'CUSTOMER_PAYMENT':
          events.push({ at: e.occurredAt, kind: 'FUNDS_RECEIVED', amount });
          break;
        case 'SETTLEMENT':
          settled.push(e.fundsAvailableAt ?? e.occurredAt);
          break;
        case 'PIPELINE_RELEASED':
          events.push({ at: e.occurredAt, kind: 'BILLING_RELEASED', amount });
          break;
        case 'COST':
          events.push({ at: e.occurredAt, kind: 'SUPPLIER_OUTLAY', amount });
          break;
        case 'UNPAID_COMMITMENT':
          events.push({ at: e.occurredAt, kind: 'SUPPLIER_LIABILITY', amount });
          break;
        case 'COMMITMENT_PAID':
          events.push({ at: e.occurredAt, kind: 'LIABILITY_PAID', amount });
          break;
        case 'COMMITMENT_RELEASED':
          events.push({ at: e.occurredAt, kind: 'LIABILITY_RELEASED', amount });
          break;
        case 'RESERVE':
          events.push({ at: e.occurredAt, kind: 'RESTRICTED', amount });
          break;
        case 'RESERVE_RELEASE':
          events.push({ at: e.occurredAt, kind: 'RESTRICTION_RELEASED', amount });
          break;
        case 'CAPITAL_IN':
          events.push({ at: e.occurredAt, kind: 'OWNER_CAPITAL_IN', amount });
          break;
        case 'CAPITAL_OUT':
          events.push({ at: e.occurredAt, kind: 'OWNER_DISTRIBUTION', amount });
          break;
        case 'REFUND':
          events.push({ at: e.occurredAt, kind: 'REFUND', amount });
          break;
        default: {
          const unmapped: never = e.kind;
          throw new Error(`ledger kind ${String(unmapped)} has no route-money mapping`);
        }
      }
    }
    inputs.push({
      routeKey,
      leadAt: leadAtByRoute.get(routeKey),
      commitmentAt: agreed.sort()[0],
      usableCashAt: settled.sort()[0],
      events,
      borrowingUnrecordable: true,
      // The ledger records every receipt and outlay of the route, so the funder is read from them.
      fundingFromReceipts: true,
    });
  }
  return inputs;
}

/** The most rows `listMoneyEntries` returns in one read; it clamps any larger limit to this. */
export const LEDGER_READ_LIMIT = 2000;

/**
 * A route whose ledger could not be read whole. Every figure is unknown rather
 * than computed from the newest rows alone: a read cut at the limit drops the
 * oldest rows (the agreement, the first cost) while keeping later receipts,
 * which would date the commitment wrongly and misstate receivables, margin and
 * peak working capital while presenting them as measured.
 */
export function partialRouteMoney(routeKey: string, rowsRead: number): RouteMoneyVelocity {
  const blank = quantifyRouteMoney({ routeKey, events: [] });
  return {
    ...blank,
    unknowns: [`ledger read stopped at ${rowsRead} rows for this route, older rows were not read, every figure unknown`, ...blank.unknowns],
  };
}

/**
 * Read one project's money ledger and quantify every route in it, in one currency.
 *
 * Each route is read on its own (`opportunityId`), so one busy route cannot push
 * another route's older rows out of a project-wide read. A route whose own read
 * reaches the limit may hold more rows than were returned, so it is reported as
 * partial with every figure unknown (`partialRouteMoney`), never as measured.
 */
export async function readRouteMoney(input: {
  projectId: string;
  currency: string;
  /** The project's opportunity rows when the caller already read them, so they are not read twice. */
  opportunities?: readonly CashOpportunity[];
  /** Rows read per route; clamped to `LEDGER_READ_LIMIT`. Smaller only to exercise the partial path. */
  rowLimit?: number;
}): Promise<RouteMoneyVelocity[]> {
  const opportunities = input.opportunities ?? (await listOpportunities({ projectId: input.projectId }));
  const limit = Math.max(1, Math.min(LEDGER_READ_LIMIT, Math.floor(input.rowLimit ?? LEDGER_READ_LIMIT)));
  // The opportunity row is the lead, and its creation instant is when the lead was recorded.
  const leadAt = new Map(opportunities.map((o) => [o.id, o.createdAt] as const));
  const out: RouteMoneyVelocity[] = [];
  const ids = [...new Set(opportunities.map((o) => o.id))];
  const BATCH = 16;
  for (let i = 0; i < ids.length; i += BATCH) {
    const reads = await Promise.all(
      ids.slice(i, i + BATCH).map(async (opportunityId) => ({
        opportunityId,
        entries: await listMoneyEntries({ projectId: input.projectId, opportunityId, currency: input.currency, limit }),
      })),
    );
    for (const { opportunityId, entries } of reads) {
      if (entries.length === 0) continue;
      if (entries.length >= limit) {
        out.push(partialRouteMoney(opportunityId, entries.length));
        continue;
      }
      out.push(...routeInputsFromEntries(entries, leadAt).map(quantifyRouteMoney));
    }
  }
  return out;
}

/** The same routes ranked for an objective; unknown inputs score null and sort last. */
export async function rankRoutesFromLedger(input: {
  projectId: string;
  currency: string;
  objective: RouteObjective;
  collectionProbability?: Record<string, number>;
}): Promise<{ money: RouteMoneyVelocity[]; ranking: RouteScore[] }> {
  const money = await readRouteMoney(input);
  const ranking = scoreRoutes(
    money.map((m) => ({ money: m, collectionProbability: input.collectionProbability?.[m.routeKey] })),
    input.objective,
  );
  return { money, ranking };
}
