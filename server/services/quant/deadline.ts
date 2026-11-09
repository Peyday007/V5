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
import type { CashMoneyEntry } from '../../domain/types.ts';

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
    | 'FUNDS_RECEIVED' // money reached the account
    | 'SUPPLIER_OUTLAY'
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
  refundsAndChargebacks: number | null;
  /** Billed but not yet received. */
  receivables: number | null;
  /** Largest cumulative cash shortfall while outlays and receipts overlap. */
  peakWorkingCapital: number | null;
  /** Funds received minus encumbered funds minus refunds; null when no funds row exists. */
  usableCash: number | null;
  excludedFromUsable: number;
  /** The nine identities as stated; unstated ones are null. Never summed or substituted. */
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
  const spendBy = (who: 'CUSTOMER' | 'SELF') => (outlays.some((o) => o.fundedBy === who) ? sum(outlays.filter((o) => o.fundedBy === who).map((o) => o.amount)) : null);
  const unattributed = outlays.filter((o) => !o.fundedBy);
  if (outlays.length === 0) unknowns.push('no supplier outlay row');
  else if (unattributed.length > 0) unknowns.push('some supplier outlays do not say who funded them');

  const billings = of('BILLING');
  const funds = of('FUNDS_RECEIVED');
  const returned = [...of('REFUND'), ...of('CHARGEBACK')];
  const billed = billings.length ? sum(billings.map((e) => e.amount)) : null;
  const received = funds.length ? sum(funds.map((e) => e.amount)) : null;
  const encumbered = sum(funds.filter((e) => e.encumbered).map((e) => e.amount));
  const refunds = returned.length ? sum(returned.map((e) => e.amount)) : null;

  const firstFunds = funds.length ? funds.map((e) => e.at).sort()[0] : undefined;
  const lead = daysBetween(route.leadAt, route.commitmentAt);
  const toFunds = daysBetween(route.commitmentAt, firstFunds);
  const toUsable = daysBetween(firstFunds, route.usableCashAt);
  if (lead === null) unknowns.push('lead-to-commitment time not stated');
  if (toFunds === null) unknowns.push('commitment-to-funds time not stated');
  if (toUsable === null) unknowns.push('funds-to-usable-cash time not stated');

  // Receivables are only knowable when billings are; received can exceed billed (advances), floor at 0.
  const receivables = billed === null ? null : Math.max(0, billed - (received ?? 0));
  if (billed === null) unknowns.push('no billing row, receivables unknown');

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

  const usable = received === null ? null : Math.max(0, received - encumbered - (refunds ?? 0));
  if (received === null) unknowns.push('no funds-received row, usable cash unknown');

  const identities = {} as Record<CashIdentity, number | null>;
  for (const k of CASH_IDENTITIES) identities[k] = route.identities?.[k] ?? null;
  // USABLE_CASH is the one identity this model computes, from funds actually received.
  if (identities.USABLE_CASH === null) identities.USABLE_CASH = usable;
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
    refundsAndChargebacks: refunds,
    receivables,
    peakWorkingCapital: peak,
    usableCash: usable,
    excludedFromUsable: encumbered + (refunds ?? 0),
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
 * Rank routes for an objective. Contribution is the stated gross margin times the
 * probability it is collected; turnover divides by the capital held for the cycle.
 * A route with an unknown input is scored null and sorted last, never as zero, and
 * retaining all cash is not a requirement: nothing here reads RETAINED_CASH.
 */
export function scoreRoutes(
  routes: { money: RouteMoneyVelocity; collectionProbability?: number }[],
  objective: 'TURNOVER' | 'CONTRIBUTION',
): RouteScore[] {
  const scored = routes.map(({ money, collectionProbability }) => {
    const margin = money.identities.GROSS_MARGIN;
    const p = collectionProbability;
    const contribution = margin === null || p === undefined || p < 0 || p > 1 ? null : margin * p;
    const cycle =
      money.daysLeadToCommitment !== null && money.daysCommitmentToFunds !== null && money.daysFundsToUsableCash !== null
        ? money.daysLeadToCommitment + money.daysCommitmentToFunds + money.daysFundsToUsableCash
        : null;
    const capital = money.peakWorkingCapital;
    const turnover = contribution === null || cycle === null || capital === null ? null : contribution / (Math.max(capital, 1) * Math.max(cycle, 1));
    return { routeKey: money.routeKey, capitalTurnover: turnover, riskAdjustedContribution: contribution };
  });
  const key = (s: RouteScore) => (objective === 'TURNOVER' ? s.capitalTurnover : s.riskAdjustedContribution);
  return scored.sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity));
}

/**
 * The consumer of the route money model: reads the project's append-only money
 * ledger (`cash_money_entries`) into `MoneyEvent`s, one route per opportunity,
 * and quantifies each. This is what puts the figures on production rows — nothing
 * here stores a result or adds a scheduler.
 *
 * Mapping, every line a stated row and nothing inferred:
 *  - PIPELINE_AGREED is a billing, and its earliest date the commitment;
 *  - CUSTOMER_PAYMENT is funds received; SETTLEMENT is the same money becoming
 *    usable, so it dates usable cash and is never counted as a second receipt;
 *  - COST and COMMITMENT_PAID are supplier outlays whose funder no row states
 *    (so spend stays unattributed rather than assumed self-funded);
 *  - REFUND is a refund. Lead time has no ledger row and stays unknown.
 * Entries with no opportunity belong to no route and are left out.
 */
export function routeInputsFromEntries(entries: readonly CashMoneyEntry[]): RouteMoneyInput[] {
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
        case 'COST':
        case 'COMMITMENT_PAID':
          events.push({ at: e.occurredAt, kind: 'SUPPLIER_OUTLAY', amount });
          break;
        case 'REFUND':
          events.push({ at: e.occurredAt, kind: 'REFUND', amount });
          break;
        default:
          break;
      }
    }
    inputs.push({
      routeKey,
      commitmentAt: agreed.sort()[0],
      usableCashAt: settled.sort()[0],
      events,
    });
  }
  return inputs;
}

/** Read one project's money ledger and quantify every route in it, in one currency. */
export async function readRouteMoney(input: { projectId: string; currency: string }): Promise<RouteMoneyVelocity[]> {
  const entries = await listMoneyEntries({ projectId: input.projectId, currency: input.currency, limit: 2000 });
  return routeInputsFromEntries(entries).map(quantifyRouteMoney);
}

/** The same routes ranked for an objective; unknown inputs score null and sort last. */
export async function rankRoutesFromLedger(input: {
  projectId: string;
  currency: string;
  objective: 'TURNOVER' | 'CONTRIBUTION';
  collectionProbability?: Record<string, number>;
}): Promise<{ money: RouteMoneyVelocity[]; ranking: RouteScore[] }> {
  const money = await readRouteMoney(input);
  const ranking = scoreRoutes(
    money.map((m) => ({ money: m, collectionProbability: input.collectionProbability?.[m.routeKey] })),
    input.objective,
  );
  return { money, ranking };
}
