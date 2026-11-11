/**
 * Revenue realization: from a credible offer to a customer who received the
 * promised result, and what that relationship is worth afterwards (LIFE-29-2).
 *
 * Four things are decided here, each from rows or stated input and none from a
 * generic "AI can fulfil it":
 *
 *   1. **Delivery steps come from the stated scope.** Every scope item names the
 *      capability it needs; the steps are the items, in order, plus the
 *      acceptance step the agreement states. No scope, no steps.
 *   2. **A fulfiller is never the buyer, and a capability is never claimed
 *      unproven.** An item is assigned to a verified Brain capability (read
 *      from `capabilities.ts`, never a constant here), an existing supplier, or
 *      a specifically sourced provider. A buyer named as fulfiller is refused.
 *      An item with no such fulfiller is `UNASSIGNED` and says what is missing.
 *   3. **Responsibility that belongs to a licensed provider or an accountable
 *      person stays with them.** An item flagged as such is assigned only to a
 *      named human or licensed supplier; Brain's own capability never absorbs it.
 *   4. **Delivery, acceptance, redo obligations, accounting and aftercare are
 *      recorded as evidence.** Aftercare relationships (follow-ups, service
 *      levels, satisfaction, referrals, renewals, upsell, cross-sell) are
 *      returned as `Observation`-shaped economic evidence that deal
 *      construction reads through `aftercareEvidence`.
 *
 * The derivations are pure. The running Brain reaches them through
 * `recordRealization`, which the journey tick calls for every deal with an
 * agreement: it reads each declared obligation's own rows (the agreement's
 * deliverable is the scope, the fulfilment declaration names the performer,
 * the opportunity names the buyer, the fulfilment events are the delivery and
 * acceptance evidence, the money ledger is the accounting) and appends what
 * changed to the existing append-only `cash_events` log as `delivery.realized`
 * and `aftercare.recorded`. No table, schedule or authority path is added.
 * Arrangement construction (`construct.ts`) reads the aftercare back through
 * `aftercareByPayer` as observations of a buyer's repeat rate.
 *
 * Unknown stays unknown (invariant 39): an unstated fact is named, never
 * assumed favourably, and nothing here names an industry or a category.
 */
import { createHash } from 'node:crypto';
import { readCapabilities, type CapabilityState } from '../capabilities.ts';
import { agreementsFor, agreementsInProject } from '../../../repos/cashJourney.ts';
import { fulfillmentEvents, fulfillmentForAgreement } from '../../../repos/cashFulfillment.ts';
import { getOpportunity } from '../../../repos/cashPortfolio.ts';
import { totalsByKind } from '../../../repos/cashLedger.ts';
import { cashEventsOfKind, cashEventsOfKindInProject, recordCashEvent } from '../../../repos/cashMode.ts';
import type { CashAgreement } from '../../../domain/cashJourney.ts';
import type { CashFulfillment, CashFulfillmentEvent } from '../../../domain/cashFulfillment.ts';

/* ---------------------------------------------------------------------------
 * Scope and fulfillers
 * ------------------------------------------------------------------------ */

export interface ScopeItem {
  key: string;
  /** What the buyer is promised, in the agreement's words. */
  promise: string;
  /** The capability id (`capabilities.ts`) that would produce it, when Brain is to. */
  capabilityId?: string;
  /** True when the law or the contract puts this on a licensed provider or accountable person. */
  accountable?: boolean;
  /** Item keys that must complete first. */
  after?: string[];
  /** When it must be delivered, ISO-8601 UTC. */
  dueAt?: string;
}

export type FulfillerKind = 'BRAIN_CAPABILITY' | 'EXISTING_SUPPLIER' | 'SOURCED_PROVIDER' | 'ACCOUNTABLE_PERSON';

export interface Party {
  id: string;
  name: string;
  /** The role this party holds in the transaction. */
  role: 'BUYER' | 'SUPPLIER' | 'PROVIDER' | 'PERSON';
  licensed?: boolean;
  /** Scope item keys this party is stated to be able to perform. */
  canPerform?: string[];
}

export interface DeliveryStep {
  key: string;
  promise: string;
  order: number;
  after: string[];
  dueAt: string | null;
  fulfiller: { kind: FulfillerKind; ref: string } | null;
  status: 'ASSIGNED' | 'UNASSIGNED' | 'REFUSED';
  /** Why a step is not simply assigned. Empty when it is. */
  reasons: string[];
  /** Responsibility preserved on a licensed provider or accountable person. */
  responsibility: string | null;
}

export interface DeliveryPlan {
  steps: DeliveryStep[];
  /** Steps nobody verified can do: each is a need, not a guess. */
  unassigned: string[];
  refused: string[];
  /** True only when every step has a real fulfiller and the order has no cycle. */
  executable: boolean;
  problems: string[];
}

/**
 * Derive the delivery plan from the scope, the parties, and the capability
 * readings. `readings` is injected so the derivation is testable; use
 * `readScopeCapabilities` to take it from the running Brain.
 */
export function deriveDeliveryPlan(input: {
  scope: ScopeItem[];
  parties: Party[];
  readings: ReadonlyMap<string, CapabilityState>;
}): DeliveryPlan {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const item of input.scope) {
    if (!item.key.trim() || !item.promise.trim()) problems.push('a scope item has no key or no promise');
    if (keys.has(item.key)) problems.push(`scope item ${item.key} is stated twice`);
    keys.add(item.key);
  }
  for (const item of input.scope) {
    for (const dep of item.after ?? []) if (!keys.has(dep)) problems.push(`${item.key} waits on ${dep}, which the scope does not state`);
  }
  if (input.scope.length === 0) problems.push('no scope is stated, so no delivery step can be derived');

  const order = topologicalOrder(input.scope);
  if (order === null) problems.push('the scope items wait on each other in a cycle');

  const byKey = new Map(input.scope.map((item) => [item.key, item]));
  const sequence = order ?? input.scope.map((item) => item.key);
  const steps: DeliveryStep[] = sequence.map((key, index) => {
    const item = byKey.get(key)!;
    const reasons: string[] = [];
    const capable = input.parties.filter((p) => (p.canPerform ?? []).includes(item.key));
    const buyerNamed = capable.filter((p) => p.role === 'BUYER');
    if (buyerNamed.length > 0) reasons.push(`${buyerNamed.map((p) => p.name).join(', ')} is the buyer and cannot be the fulfiller`);
    const candidates = capable.filter((p) => p.role !== 'BUYER');

    let fulfiller: DeliveryStep['fulfiller'] = null;
    let responsibility: string | null = null;

    if (item.accountable) {
      // Never Brain's own capability: only a licensed provider/supplier or a named person.
      const holder = candidates.find((p) => p.role === 'PERSON' || p.licensed === true);
      if (holder) {
        fulfiller = { kind: 'ACCOUNTABLE_PERSON', ref: holder.id };
        responsibility = `${holder.name} remains accountable for ${item.promise}`;
      } else reasons.push('this is a licensed or accountable responsibility and no licensed provider or accountable person is named');
    } else {
      const supplier = candidates.find((p) => p.role === 'SUPPLIER');
      const provider = candidates.find((p) => p.role === 'PROVIDER' || p.role === 'PERSON');
      const state = item.capabilityId ? input.readings.get(item.capabilityId.trim()) ?? 'UNKNOWN' : null;
      if (item.capabilityId && state === 'PRESENT') fulfiller = { kind: 'BRAIN_CAPABILITY', ref: item.capabilityId.trim() };
      else if (supplier) fulfiller = { kind: 'EXISTING_SUPPLIER', ref: supplier.id };
      else if (provider) fulfiller = { kind: 'SOURCED_PROVIDER', ref: provider.id };
      else if (!item.capabilityId) reasons.push('no capability, supplier or provider is stated for this item');
      else reasons.push(`capability ${item.capabilityId} reads ${state}, not PRESENT, and no supplier or provider is named`);
    }

    const refused = buyerNamed.length > 0 && fulfiller === null;
    return {
      key,
      promise: item.promise,
      order: index + 1,
      after: item.after ?? [],
      dueAt: item.dueAt ?? null,
      fulfiller,
      status: fulfiller ? 'ASSIGNED' : refused ? 'REFUSED' : 'UNASSIGNED',
      reasons: fulfiller ? [] : reasons,
      responsibility,
    };
  });

  const unassigned = steps.filter((s) => s.status === 'UNASSIGNED').map((s) => s.key);
  const refused = steps.filter((s) => s.status === 'REFUSED').map((s) => s.key);
  return {
    steps,
    unassigned,
    refused,
    executable: problems.length === 0 && unassigned.length === 0 && refused.length === 0 && steps.length > 0,
    problems,
  };
}

function topologicalOrder(scope: ScopeItem[]): string[] | null {
  const remaining = new Map(scope.map((item) => [item.key, new Set((item.after ?? []).filter((d) => scope.some((s) => s.key === d)))]));
  const out: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([key]) => key);
    if (ready.length === 0) return null;
    for (const key of ready) {
      remaining.delete(key);
      out.push(key);
    }
    for (const deps of remaining.values()) for (const key of ready) deps.delete(key);
  }
  return out;
}

/** Read the capability states a scope names, from the running Brain, never cached. */
export async function readScopeCapabilities(scope: ScopeItem[]): Promise<Map<string, CapabilityState>> {
  const ids = scope.flatMap((item) => (item.capabilityId ? [item.capabilityId] : []));
  const readings = await readCapabilities(ids);
  return new Map(readings.map((r) => [r.id, r.state]));
}

/* ---------------------------------------------------------------------------
 * Delivery, acceptance, redo, accounting
 * ------------------------------------------------------------------------ */

export interface DeliveryRecord {
  stepKey: string;
  deliveredAt: string;
  /** What shows it was delivered: a reference, a file, a message. Required. */
  evidence: string;
}

export interface AcceptanceRecord {
  /** Step keys the buyer accepted or rejected. */
  stepKey: string;
  outcome: 'ACCEPTED' | 'REJECTED';
  at: string;
  evidence: string;
  reason?: string;
}

export interface RedoObligation {
  stepKey: string;
  /** What the agreement obliges Brain's side to correct or redo. */
  obligation: string;
  dueAt?: string;
}

export interface AccountingInput {
  billedCents: number;
  receivedCents: number;
  refundedCents: number;
  costCents: number;
}

export interface RealizationReading {
  delivered: string[];
  awaitingDelivery: string[];
  accepted: string[];
  rejected: string[];
  /** Delivered steps nobody has accepted or rejected yet. */
  awaitingAcceptance: string[];
  /** Records refused because they carried no evidence, or named no plan step. */
  refusedRecords: string[];
  redoObligations: (RedoObligation & { open: boolean })[];
  /** True only when every step is delivered with evidence, accepted with evidence, and no redo is open. */
  realized: boolean;
  accounting: {
    /** Cash retained after refunds, before cost. Null when any figure is not a valid amount. */
    collectedCents: number | null;
    /** Collected minus cost; negative is a real loss. Null when unknowable. */
    contributionCents: number | null;
    /** Billed and not yet received. */
    owedToUsCents: number | null;
    unknowns: string[];
  };
}

const validCents = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;

export function readRealization(input: {
  plan: DeliveryPlan;
  deliveries: DeliveryRecord[];
  acceptances: AcceptanceRecord[];
  redos: RedoObligation[];
  accounting?: AccountingInput;
}): RealizationReading {
  const stepKeys = new Set(input.plan.steps.map((s) => s.key));
  const refusedRecords: string[] = [];

  // Latest record per step wins; a record without evidence or for an unknown step is not a record.
  const latest = <T extends { stepKey: string; evidence: string }>(rows: T[], at: (r: T) => string, label: string) => {
    const out = new Map<string, T>();
    for (const row of [...rows].sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)))) {
      if (!stepKeys.has(row.stepKey)) {
        refusedRecords.push(`${label} for ${row.stepKey}: no such step in the plan`);
      } else if (!row.evidence.trim() || !Number.isFinite(Date.parse(at(row)))) {
        refusedRecords.push(`${label} for ${row.stepKey}: no evidence or no valid time`);
      } else out.set(row.stepKey, row);
    }
    return out;
  };
  const delivered = latest(input.deliveries, (r) => r.deliveredAt, 'delivery');
  const decided = latest(input.acceptances, (r) => r.at, 'acceptance');

  const accepted: string[] = [];
  const rejected: string[] = [];
  const awaitingAcceptance: string[] = [];
  for (const step of input.plan.steps) {
    if (!delivered.has(step.key)) continue;
    const decision = decided.get(step.key);
    // An acceptance older than the delivery it judged does not accept the newer delivery.
    const fresh = decision && Date.parse(decision.at) >= Date.parse(delivered.get(step.key)!.deliveredAt);
    if (!fresh) awaitingAcceptance.push(step.key);
    else if (decision.outcome === 'ACCEPTED') accepted.push(step.key);
    else rejected.push(step.key);
  }

  const redoObligations = input.redos
    .filter((r) => stepKeys.has(r.stepKey))
    .map((r) => ({ ...r, open: !accepted.includes(r.stepKey) || rejected.includes(r.stepKey) }));
  // A rejected step is itself an open redo, even when the agreement stated none.
  for (const key of rejected) {
    if (!redoObligations.some((r) => r.stepKey === key)) {
      redoObligations.push({ stepKey: key, obligation: 'the buyer rejected this delivery; the agreement states no remedy', open: true });
    }
  }

  const unknowns: string[] = [];
  let collected: number | null = null;
  let contribution: number | null = null;
  let owed: number | null = null;
  const a = input.accounting;
  if (!a) unknowns.push('no accounting figures stated');
  else if (![a.billedCents, a.receivedCents, a.refundedCents, a.costCents].every(validCents)) {
    unknowns.push('an accounting figure is not a valid non-negative whole amount');
  } else {
    collected = a.receivedCents - a.refundedCents;
    contribution = collected - a.costCents;
    owed = Math.max(0, a.billedCents - a.receivedCents);
    if (collected < 0) unknowns.push('refunds exceed money received');
  }

  const every = input.plan.steps.length > 0;
  return {
    delivered: input.plan.steps.filter((s) => delivered.has(s.key)).map((s) => s.key),
    awaitingDelivery: input.plan.steps.filter((s) => !delivered.has(s.key)).map((s) => s.key),
    accepted,
    rejected,
    awaitingAcceptance,
    refusedRecords,
    redoObligations,
    realized:
      every &&
      input.plan.steps.every((s) => accepted.includes(s.key)) &&
      redoObligations.every((r) => !r.open),
    accounting: { collectedCents: collected, contributionCents: contribution, owedToUsCents: owed, unknowns },
  };
}

/* ---------------------------------------------------------------------------
 * Aftercare relationships as economic evidence
 * ------------------------------------------------------------------------ */

export const AFTERCARE_KINDS = [
  'FOLLOW_UP_REQUEST',
  'SERVICE_LEVEL',
  'SATISFACTION',
  'REFERRAL',
  'RENEWAL',
  'UPSELL',
  'CROSS_SELL',
  'TRUST_OR_REPUTATION',
] as const;
export type AftercareKind = (typeof AFTERCARE_KINDS)[number];

export interface AftercareRecord {
  kind: AftercareKind;
  /** The counterparty the relationship is with. */
  partyId: string;
  at: string;
  /** What shows it: a message, a rating, a signed renewal. Required. */
  evidence: string;
  /** A stated value in cents, where the relationship has one (a renewal's price). */
  valueCents?: number;
  /** A stated rating, 0..1, where the kind is a satisfaction or trust reading. */
  score?: number;
  detail?: string;
}

export interface AftercareEvidence {
  kind: AftercareKind;
  partyId: string;
  at: string;
  evidence: string;
  valueCents: number | null;
  score: number | null;
  detail: string | null;
}

export interface AftercareReading {
  /** Accepted records, ready for deal construction to read as economic evidence. */
  evidence: AftercareEvidence[];
  refused: string[];
  /** Parties with at least one repeat-business signal (renewal, follow-up, upsell, cross-sell, referral). */
  repeatPartyIds: string[];
  /** Stated value of repeat business, summed only over records that state one; null when none do. */
  statedRepeatValueCents: number | null;
  /** Mean of stated scores; null when no record states one. Never a default. */
  meanScore: number | null;
}

const REPEAT_KINDS: ReadonlySet<AftercareKind> = new Set(['FOLLOW_UP_REQUEST', 'RENEWAL', 'UPSELL', 'CROSS_SELL', 'REFERRAL']);

/**
 * Validate and summarize aftercare records. A record with no evidence, an
 * unknown kind, a non-finite value or a score outside 0..1 is refused and named
 * rather than coerced, and an absent value stays `null` (invariant 39).
 */
export function recordAftercare(records: AftercareRecord[]): AftercareReading {
  const evidence: AftercareEvidence[] = [];
  const refused: string[] = [];
  for (const r of records) {
    const label = `${String(r.kind)} for ${r.partyId}`;
    if (!(AFTERCARE_KINDS as readonly string[]).includes(r.kind)) refused.push(`${label}: unknown kind`);
    else if (!r.partyId.trim()) refused.push(`${label}: no counterparty`);
    else if (!r.evidence.trim()) refused.push(`${label}: no evidence`);
    else if (!Number.isFinite(Date.parse(r.at))) refused.push(`${label}: no valid time`);
    else if (r.valueCents !== undefined && !validCents(r.valueCents)) refused.push(`${label}: value is not a valid non-negative whole amount`);
    else if (r.score !== undefined && !(Number.isFinite(r.score) && r.score >= 0 && r.score <= 1)) refused.push(`${label}: score is outside 0..1`);
    else {
      evidence.push({
        kind: r.kind,
        partyId: r.partyId,
        at: r.at,
        evidence: r.evidence,
        valueCents: r.valueCents ?? null,
        score: r.score ?? null,
        detail: r.detail ?? null,
      });
    }
  }
  const valued = evidence.filter((e) => REPEAT_KINDS.has(e.kind) && e.valueCents !== null);
  const scored = evidence.filter((e) => e.score !== null);
  return {
    evidence,
    refused,
    repeatPartyIds: [...new Set(evidence.filter((e) => REPEAT_KINDS.has(e.kind)).map((e) => e.partyId))].sort(),
    statedRepeatValueCents: valued.length ? valued.reduce((t, e) => t + e.valueCents!, 0) : null,
    meanScore: scored.length ? scored.reduce((t, e) => t + e.score!, 0) / scored.length : null,
  };
}

/**
 * The aftercare evidence deal construction reads: per counterparty, whether
 * there is a repeat-business signal and what it stated. Construction treats a
 * party with no evidence as unknown, never as a customer who will not return.
 */
export function aftercareEvidence(reading: AftercareReading): { partyId: string; repeat: boolean; statedValueCents: number | null; evidenceCount: number }[] {
  const byParty = new Map<string, AftercareEvidence[]>();
  for (const e of reading.evidence) byParty.set(e.partyId, [...(byParty.get(e.partyId) ?? []), e]);
  return [...byParty.entries()]
    .map(([partyId, rows]) => {
      const valued = rows.filter((e) => REPEAT_KINDS.has(e.kind) && e.valueCents !== null);
      return {
        partyId,
        repeat: rows.some((e) => REPEAT_KINDS.has(e.kind)),
        statedValueCents: valued.length ? valued.reduce((t, e) => t + e.valueCents!, 0) : null,
        evidenceCount: rows.length,
      };
    })
    .sort((a, b) => a.partyId.localeCompare(b.partyId));
}

/* ---------------------------------------------------------------------------
 * The running Brain: obligations read from their rows
 * ------------------------------------------------------------------------ */

/** A declared obligation's delivery plan and realization, appended when they change. */
export const DELIVERY_REALIZED_EVENT = 'delivery.realized';
/** One aftercare relationship a deal's rows show, appended once. */
export const AFTERCARE_EVENT = 'aftercare.recorded';

/** How a fulfilment kind would be produced by Brain itself; a person or supplier is a party instead. */
const KIND_CAPABILITY: Readonly<Record<string, string>> = { SOFTWARE: 'BUILD_SOFTWARE', RESEARCH: 'RESEARCH_A_QUESTION' };

/** One spelling of a counterparty, so the buyer named on two openings is one party. */
export const partyKey = (name: string | null | undefined): string => (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export interface ObligationRows {
  agreement: CashAgreement;
  fulfillment: CashFulfillment;
  /** The opportunity's payer: the buyer. Null when nobody established one. */
  payer: string | null;
  events: CashFulfillmentEvent[];
  /** Stated only when the opportunity's ledger belongs to this one agreement. */
  accounting?: AccountingInput;
}

/**
 * The scope and parties of one declared obligation. The scope is the
 * agreement's own deliverable, verbatim; the performer is who the declaration
 * names; a performer who is the buyer is entered as the buyer, so the plan
 * refuses it. Pure.
 */
export function scopeOfObligation(rows: ObligationRows): { scope: ScopeItem[]; parties: Party[] } {
  const key = rows.agreement.id;
  const capabilityId = KIND_CAPABILITY[rows.fulfillment.kind];
  const scope: ScopeItem[] = [{ key, promise: rows.agreement.deliverable, ...(capabilityId ? { capabilityId } : {}) }];
  const parties: Party[] = [];
  const buyer = partyKey(rows.payer);
  if (buyer) parties.push({ id: `buyer:${buyer}`, name: rows.payer!, role: 'BUYER' });
  if (rows.fulfillment.kind === 'SUPPLIER' || rows.fulfillment.kind === 'PERSON') {
    const name = rows.fulfillment.kind === 'SUPPLIER' ? rows.fulfillment.supplierName ?? rows.fulfillment.performer : rows.fulfillment.performer;
    const isBuyer = buyer !== '' && partyKey(name) === buyer;
    const role: Party['role'] = isBuyer ? 'BUYER' : rows.fulfillment.kind === 'SUPPLIER' ? 'SUPPLIER' : 'PERSON';
    parties.push({ id: `${role.toLowerCase()}:${partyKey(name)}`, name, role, canPerform: [key] });
  }
  return { scope, parties };
}

/** The plan and the realization of one obligation, from its rows and the capability readings. Pure. */
export function realizationOfObligation(
  rows: ObligationRows,
  readings: ReadonlyMap<string, CapabilityState>,
): { plan: DeliveryPlan; realization: RealizationReading } {
  const { scope, parties } = scopeOfObligation(rows);
  const plan = deriveDeliveryPlan({ scope, parties, readings });
  const stepKey = rows.agreement.id;
  const said = (e: CashFulfillmentEvent) => (e.evidenceRef?.trim() || e.detail.trim());
  const deliveries: DeliveryRecord[] = rows.events
    .filter((e) => e.kind === 'DELIVERED')
    .map((e) => ({ stepKey, deliveredAt: e.createdAt, evidence: said(e) }));
  const acceptances: AcceptanceRecord[] = rows.events
    .filter((e) => e.kind === 'ACCEPTED' || e.kind === 'REJECTED')
    .map((e) => ({ stepKey, outcome: e.kind as 'ACCEPTED' | 'REJECTED', at: e.createdAt, evidence: said(e), reason: e.detail }));
  const realization = readRealization({ plan, deliveries, acceptances, redos: [], accounting: rows.accounting });
  return { plan, realization };
}

/** Every declared obligation on an opportunity, read from its rows. Released agreements are history, not obligations. */
export async function readObligationRows(projectId: string, opportunityId: string, currency: string): Promise<ObligationRows[]> {
  const opportunity = await getOpportunity(opportunityId);
  const live = (await agreementsFor(opportunityId)).filter((a) => a.projectId === projectId && !a.releasedAt);
  const out: ObligationRows[] = [];
  for (const agreement of live) {
    const fulfillment = await fulfillmentForAgreement(agreement.id);
    if (!fulfillment) continue;
    let accounting: AccountingInput | undefined;
    if (live.length === 1 && agreement.currency === currency) {
      const totals = await totalsByKind({ projectId, opportunityId, currency });
      accounting = { billedCents: agreement.amountCents, receivedCents: totals.CUSTOMER_PAYMENT ?? 0, refundedCents: totals.REFUND ?? 0, costCents: totals.COST ?? 0 };
    }
    out.push({ agreement, fulfillment, payer: opportunity?.payer ?? null, events: await fulfillmentEvents(fulfillment.id), ...(accounting ? { accounting } : {}) });
  }
  return out;
}

const REPEAT_AFTER_ACCEPTANCE: Record<'SAME' | 'OTHER', AftercareKind> = { SAME: 'RENEWAL', OTHER: 'FOLLOW_UP_REQUEST' };

/**
 * The aftercare the rows show for one obligation. Pure. An accepted delivery is
 * the buyer's stated satisfaction with its acceptance condition (no score is
 * invented); a later agreement from the same buyer is repeat business — a
 * renewal on the same opening, a follow-up request on another — carrying its
 * own amount and evidence.
 */
export function aftercareFromRows(input: {
  rows: ObligationRows;
  realization: RealizationReading;
  later: { agreement: CashAgreement; payer: string | null }[];
}): (AftercareRecord & { key: string })[] {
  const buyer = partyKey(input.rows.payer);
  if (!buyer || !input.realization.accepted.includes(input.rows.agreement.id)) return [];
  const acceptedAt = input.rows.events.filter((e) => e.kind === 'ACCEPTED').map((e) => e.createdAt).sort().at(-1);
  const acceptance = input.rows.events.filter((e) => e.kind === 'ACCEPTED').at(-1);
  if (!acceptedAt || !acceptance) return [];
  const out: (AftercareRecord & { key: string })[] = [
    {
      key: `SATISFACTION:${input.rows.agreement.id}`,
      kind: 'SATISFACTION',
      partyId: buyer,
      at: acceptedAt,
      evidence: acceptance.evidenceRef?.trim() || acceptance.detail.trim(),
      detail: `accepted the delivery of agreement ${input.rows.agreement.id} against "${input.rows.agreement.acceptanceCondition}"`,
    },
  ];
  for (const next of input.later) {
    if (next.agreement.id === input.rows.agreement.id || partyKey(next.payer) !== buyer || next.agreement.createdAt <= acceptedAt) continue;
    const kind = REPEAT_AFTER_ACCEPTANCE[next.agreement.opportunityId === input.rows.agreement.opportunityId ? 'SAME' : 'OTHER'];
    out.push({
      key: `${kind}:${input.rows.agreement.id}->${next.agreement.id}`,
      kind,
      partyId: buyer,
      at: next.agreement.createdAt,
      evidence: next.agreement.evidenceRef,
      ...(next.agreement.currency === input.rows.agreement.currency ? { valueCents: next.agreement.amountCents } : {}),
      detail: `agreed "${next.agreement.deliverable}" after accepting agreement ${input.rows.agreement.id}`,
    });
  }
  return out;
}

function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * The journey tick's step for one deal: derive each declared obligation's
 * delivery plan from its agreed scope, read its delivery, acceptance, redo and
 * accounting from its rows, and append what changed; then append each aftercare
 * relationship the rows show, once. Idempotent, so the tick may run as often as
 * it likes. Writes nothing but `cash_events` rows.
 */
export async function recordRealization(input: {
  projectId: string;
  opportunityId: string;
  currency: string;
}): Promise<{ obligations: number; recorded: number; aftercare: number }> {
  const all = await readObligationRows(input.projectId, input.opportunityId, input.currency);
  if (all.length === 0) return { obligations: 0, recorded: 0, aftercare: 0 };
  const prior = await cashEventsOfKind(input.opportunityId, DELIVERY_REALIZED_EVENT);
  const knownAftercare = new Set(
    (await cashEventsOfKindInProject(input.projectId, AFTERCARE_EVENT)).map((e) => String((e.detail as { aftercareKey?: unknown }).aftercareKey ?? '')),
  );
  let later: { agreement: CashAgreement; payer: string | null }[] | null = null;
  let recorded = 0;
  let aftercare = 0;
  for (const rows of all) {
    const { scope } = scopeOfObligation(rows);
    const { plan, realization } = realizationOfObligation(rows, await readScopeCapabilities(scope));
    const digest = digestOf({ plan, realization });
    const last = prior.filter((e) => (e.detail as { agreementId?: unknown }).agreementId === rows.agreement.id).at(-1);
    if ((last?.detail as { digest?: unknown } | undefined)?.digest !== digest) {
      await recordCashEvent({
        projectId: input.projectId,
        opportunityId: input.opportunityId,
        kind: DELIVERY_REALIZED_EVENT,
        actorRef: 'BRAIN',
        summary: (
          `${plan.steps.length} delivery step(s) from the agreed scope; ` +
          `${realization.delivered.length} delivered, ${realization.accepted.length} accepted, ${realization.rejected.length} rejected, ` +
          `${realization.redoObligations.filter((r) => r.open).length} redo open${realization.realized ? '; realized' : ''}`
        ).slice(0, 300),
        detail: {
          agreementId: rows.agreement.id,
          fulfillmentId: rows.fulfillment.id,
          scopeFrom: 'agreement.deliverable',
          buyer: rows.payer,
          digest,
          plan,
          realization,
        },
      });
      recorded += 1;
    }
    if (realization.accepted.length === 0 || !partyKey(rows.payer)) continue;
    if (later === null) {
      const agreements = (await agreementsInProject(input.projectId)).filter((a) => !a.releasedAt);
      const payers = new Map<string, string | null>();
      for (const a of agreements) if (!payers.has(a.opportunityId)) payers.set(a.opportunityId, (await getOpportunity(a.opportunityId))?.payer ?? null);
      later = agreements.map((agreement) => ({ agreement, payer: payers.get(agreement.opportunityId) ?? null }));
    }
    const found = aftercareFromRows({ rows, realization, later });
    const valid = recordAftercare(found);
    for (const record of found) {
      if (knownAftercare.has(record.key)) continue;
      const evidence = valid.evidence.find((e) => e.kind === record.kind && e.at === record.at && e.evidence === record.evidence);
      if (!evidence) continue;
      await recordCashEvent({
        projectId: input.projectId,
        opportunityId: input.opportunityId,
        kind: AFTERCARE_EVENT,
        actorRef: 'BRAIN',
        summary: `${record.kind.toLowerCase().replace(/_/g, ' ')} from ${rows.payer}: ${record.detail ?? ''}`.slice(0, 300),
        detail: { aftercareKey: record.key, agreementId: rows.agreement.id, payer: rows.payer, record: evidence },
      });
      knownAftercare.add(record.key);
      aftercare += 1;
    }
  }
  return { obligations: all.length, recorded, aftercare };
}

export interface PayerAftercare {
  /** The buyer's name as the opening states it. */
  payer: string;
  /** Deliveries this buyer accepted. */
  accepted: number;
  /** Repeat business after an accepted delivery: renewals, follow-ups, upsells, cross-sells, referrals. */
  repeats: number;
  statedRepeatValueCents: number | null;
  /** The `cash_events` rows it rests on. */
  eventIds: string[];
  lastAt: string;
}

/**
 * The aftercare on record, by buyer, for deal construction to read. Records are
 * re-validated through `recordAftercare`, so a malformed row is dropped rather
 * than counted. A buyer with no record is absent — unknown, never "will not return".
 */
export async function aftercareByPayer(projectId: string): Promise<Map<string, PayerAftercare>> {
  const events = await cashEventsOfKindInProject(projectId, AFTERCARE_EVENT);
  const out = new Map<string, PayerAftercare>();
  for (const event of events) {
    const detail = event.detail as { payer?: unknown; record?: AftercareEvidence };
    if (typeof detail.payer !== 'string' || !detail.record) continue;
    // Stored evidence carries null for what it did not state; the validator reads absent as undefined.
    const { valueCents, score, detail: said, ...rest } = detail.record;
    const reading = recordAftercare([
      { ...rest, ...(valueCents !== null && valueCents !== undefined ? { valueCents } : {}), ...(score !== null && score !== undefined ? { score } : {}), ...(said ? { detail: said } : {}) },
    ]);
    const one = reading.evidence[0];
    if (!one) continue;
    const key = partyKey(detail.payer);
    const slot = out.get(key) ?? { payer: detail.payer, accepted: 0, repeats: 0, statedRepeatValueCents: null, eventIds: [], lastAt: one.at };
    if (one.kind === 'SATISFACTION') slot.accepted += 1;
    if (REPEAT_KINDS.has(one.kind)) {
      slot.repeats += 1;
      if (one.valueCents !== null) slot.statedRepeatValueCents = (slot.statedRepeatValueCents ?? 0) + one.valueCents;
    }
    slot.eventIds.push(event.id);
    if (one.at > slot.lastAt) slot.lastAt = one.at;
    out.set(key, slot);
  }
  return out;
}
