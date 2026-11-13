/**
 * Exceptions are state changes with a price and a remedy (LIFE-29-3).
 *
 * A buyer changes scope, a supplier misses a date, a customer cancels, a payment
 * fails, a delivered result is disputed. None of these is an error to log: each
 * is a change to the commitment model that `commitments.ts` already derives from
 * the obligation rows and the money ledger, and each has a consequence that can
 * be counted and a remedy that can be chosen — or that nobody is yet authorized
 * to choose.
 *
 * This file adds no store, scheduler or authority path:
 *
 *  - detection is a pure reading of a `CommitmentReading` and of the buyer's
 *    own recorded observations (a counter-offer or a refusal after agreement is
 *    a scope change, a cancellation or — once something was delivered — a
 *    dispute), plus any signals a caller states that no row carries;
 *  - consequence is arithmetic over that reading, and an unstated figure is
 *    `null`, never a guess (§39);
 *  - a remedy is chosen only inside the authority the caller holds. A refund
 *    goes through the existing `authorizeRefund` — bounded under the cash lock —
 *    and only with a named person's approval. Anything that commits the company
 *    in law or in money and has not been approved is returned as the specific
 *    approval that is missing, and everything else carries on.
 *
 * The rehearsal is not a simulated pipeline. It is a trace of one real, sourced
 * case, built from the same rows, and it refuses to call itself a trace without
 * a source and at least one recorded failure.
 */
import type { CashMoneyEntry } from '../../../domain/types.ts';
import { authorizeRefund } from '../journey/fulfillment.ts';
import { checkCommercialAuthority, type CommercialAction } from '../authority.ts';
import { createHash } from 'node:crypto';
import type { CashNeed } from '../../../domain/types.ts';
import { cashEventsOfKind, getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import { listMoneyEntries } from '../../../repos/cashLedger.ts';
import { getOpportunity } from '../../../repos/cashPortfolio.ts';
import { observationsFor } from '../../../repos/cashJourney.ts';
import type { CashObservation } from '../../../domain/cashJourney.ts';
import { getMembership } from '../../../repos/identity.ts';
import { raiseNeed } from '../needs.ts';
import { readCommitments, type CommitmentReading, type CommitmentTransition, type DeclaredTransition, type ExternalDependency, type Party } from './commitments.ts';

export const EXCEPTION_KINDS = ['SCOPE_CHANGE', 'MISSED_DATE', 'CANCELLATION', 'PAYMENT_FAILURE', 'DISPUTE'] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const REMEDIES = [
  'SUBSTITUTE_PROVIDER',
  'RENEGOTIATE_SCOPE',
  'RESCHEDULE',
  'PARTIAL_DELIVERY',
  'APPROVED_REFUND',
  'ALTERNATE_COLLECTION',
  'ESCALATE',
  'ORDERLY_CANCELLATION',
] as const;
export type Remedy = (typeof REMEDIES)[number];

/** What the rows do not carry: a scope change, a dispute, a cancellation request. Stated, with evidence. */
export interface ExceptionSignal {
  kind: ExceptionKind;
  at: string;
  detail: string;
  evidence: string[];
  /** Who raised it, by ref. */
  raisedBy?: Party | null;
  /** The change in agreed value, in cents (positive: more owed to us), when it was stated. */
  valueDeltaCents?: number | null;
  /** The amount in dispute, when stated. */
  disputedCents?: number | null;
}

export interface DetectedException {
  id: string;
  kind: ExceptionKind;
  /** `ROWS` when the commitment rows show it, `STATED` when a signal does. */
  source: 'ROWS' | 'STATED';
  at: string | null;
  transitionId: string | null;
  detail: string;
  evidence: string[];
  raisedBy: Party | null;
  valueDeltaCents: number | null;
  disputedCents: number | null;
}

/** Detects each kind as a state change on the commitment model. Pure. */
export function detectExceptions(reading: CommitmentReading, signals: readonly ExceptionSignal[] = []): DetectedException[] {
  const found: DetectedException[] = [];
  const holder = (t: CommitmentTransition): Party | null => t.duty.holder ?? t.parties[0] ?? null;

  for (const t of reading.transitions) {
    const paymentStage = t.stage === 'PAYMENT_AUTHORIZED' || t.stage === 'FUNDS_SETTLED';
    if (paymentStage && (t.outcome === 'FAILED' || t.outcome === 'REJECTED')) {
      found.push({
        id: `payment-failure:${t.id}`,
        kind: 'PAYMENT_FAILURE',
        source: 'ROWS',
        at: t.at,
        transitionId: t.id,
        detail: `${t.kind}: ${t.outcomeDetail ?? t.outcome.toLowerCase()}`,
        evidence: t.evidence,
        raisedBy: holder(t),
        valueDeltaCents: null,
        disputedCents: t.amountCents,
      });
    }
    if (t.stage === 'WORK_ACCEPTED' && t.outcome === 'REJECTED') {
      found.push({
        id: `dispute:${t.id}`,
        kind: 'DISPUTE',
        source: 'ROWS',
        at: t.at,
        transitionId: t.id,
        detail: `the delivered result was rejected: ${t.outcomeDetail ?? 'no reason recorded'}`,
        evidence: t.evidence,
        raisedBy: holder(t),
        valueDeltaCents: null,
        disputedCents: t.amountCents,
      });
    }
    if (t.outcome === 'RELEASED') {
      found.push({
        id: `cancellation:${t.id}`,
        kind: 'CANCELLATION',
        source: 'ROWS',
        at: t.at,
        transitionId: t.id,
        detail: `${t.kind} was let go: ${t.outcomeDetail ?? 'no reason recorded'}`,
        evidence: t.evidence,
        raisedBy: holder(t),
        valueDeltaCents: null,
        disputedCents: null,
      });
    }
  }
  for (const id of reading.overdue) {
    const t = reading.transitions.find((one) => one.id === id);
    if (!t) continue;
    found.push({
      id: `missed-date:${id}`,
      kind: 'MISSED_DATE',
      source: 'ROWS',
      at: t.deadline,
      transitionId: id,
      detail: `${t.duty.action || t.kind} was due ${t.deadline ?? '(no date)'} with no outcome recorded`,
      evidence: t.evidence,
      raisedBy: t.duty.holder,
      valueDeltaCents: null,
      disputedCents: null,
    });
  }
  found.push(...statedExceptions(signals));
  return found;
}

/** What a caller stated that no row carries, as exceptions. Pure. */
export function statedExceptions(signals: readonly ExceptionSignal[]): DetectedException[] {
  return signals.map((s, i) => ({
    id: `stated:${s.kind.toLowerCase()}:${i}:${s.at}`,
    kind: s.kind,
    source: 'STATED' as const,
    at: s.at,
    transitionId: null,
    detail: s.detail,
    evidence: s.evidence,
    raisedBy: s.raisedBy ?? null,
    valueDeltaCents: s.valueDeltaCents ?? null,
    disputedCents: s.disputedCents ?? null,
  }));
}

/**
 * What the buyer's own recorded observations say about an agreed deal. Pure.
 *
 * `cash_observations` is where every buyer answer lands — from the outreach
 * provider or from a person — and an answer recorded after an agreement is a
 * state change of that agreement, not a new negotiation:
 *
 *  - a counter-offer before anything was delivered is a SCOPE_CHANGE, whose
 *    value change is the countered amount against the agreed one (null when
 *    either is unstated or in another currency);
 *  - a refusal before anything was delivered is a CANCELLATION the buyer asked
 *    for, even though nobody has released the agreement yet;
 *  - a counter-offer or a refusal after a delivery was recorded contests the
 *    delivered result: a DISPUTE over the agreed amount, or over the difference
 *    when the buyer stated what they would pay instead.
 *
 * An answer before any agreement is ordinary negotiation and is not an
 * exception. A delivery already rejected on the acceptance row is that row's
 * dispute, so an answer after it adds no second one.
 */
export function exceptionsFromObservations(reading: CommitmentReading, observations: readonly CashObservation[]): DetectedException[] {
  const found: DetectedException[] = [];
  const agreements = reading.transitions
    .filter((t) => t.kind === 'agreement' && t.outcome === 'DONE' && t.at !== null)
    .sort((a, b) => (a.at as string).localeCompare(b.at as string));
  const rejected = new Set(
    reading.transitions.filter((t) => t.stage === 'WORK_ACCEPTED' && t.outcome === 'REJECTED').map((t) => t.id.replace(/^acceptance:/, '')),
  );
  for (const o of observations) {
    if (o.kind !== 'BUYER_COUNTERED' && o.kind !== 'BUYER_DECLINED') continue;
    const agreement = [...agreements].reverse().find((t) => (t.at as string) <= o.observedAt);
    if (!agreement) continue;
    const agreementId = agreement.id.replace(/^agreement:/, '');
    const delivered = reading.transitions.some(
      (t) => t.kind === 'delivery' && t.id.startsWith(`delivery:${agreementId}:`) && t.at !== null && t.at <= o.observedAt,
    );
    const sameCurrency = o.amountCents !== null && (o.currency === null || o.currency === reading.currency);
    const agreed = agreement.amountCents;
    const evidence = [`observation:${o.id}`, o.evidenceRef].filter((e) => e.trim() !== '');
    const raisedBy: Party = { role: 'buyer', ref: o.opportunityId };
    const said = o.note?.trim() ? `: ${o.note.trim()}` : '';
    if (delivered) {
      if (rejected.has(agreementId)) continue;
      const disputed = o.kind === 'BUYER_COUNTERED' && sameCurrency && agreed !== null ? Math.max(0, agreed - (o.amountCents as number)) : agreed;
      found.push({
        id: `dispute:observation:${o.id}`,
        kind: 'DISPUTE',
        source: 'ROWS',
        at: o.observedAt,
        transitionId: agreement.id,
        detail: `the buyer ${o.kind === 'BUYER_COUNTERED' ? 'countered' : 'refused'} after delivery${said}`,
        evidence,
        raisedBy,
        valueDeltaCents: null,
        disputedCents: disputed,
      });
    } else if (o.kind === 'BUYER_COUNTERED') {
      found.push({
        id: `scope-change:observation:${o.id}`,
        kind: 'SCOPE_CHANGE',
        source: 'ROWS',
        at: o.observedAt,
        transitionId: agreement.id,
        detail: `the buyer countered the agreed terms${o.amountCents !== null ? ` at ${o.amountCents} ${o.currency ?? reading.currency} cents` : ''}${said}`,
        evidence,
        raisedBy,
        valueDeltaCents: sameCurrency && agreed !== null ? (o.amountCents as number) - agreed : null,
        disputedCents: null,
      });
    } else {
      found.push({
        id: `cancellation:observation:${o.id}`,
        kind: 'CANCELLATION',
        source: 'ROWS',
        at: o.observedAt,
        transitionId: agreement.id,
        detail: `the buyer withdrew from the agreement${said}`,
        evidence,
        raisedBy,
        valueDeltaCents: null,
        disputedCents: null,
      });
    }
  }
  return found;
}

/**
 * Every exception one deal's rows show: the commitment model's own and the
 * buyer's recorded answers. The one reader the journey tick, the rehearsal and
 * the production probe share, so none of them can see less than another.
 */
export async function detectFromRows(input: {
  projectId: string;
  opportunityId: string;
  currency: string;
  now?: string;
  declared?: DeclaredTransition[];
  dependencies?: ExternalDependency[];
}): Promise<{ reading: CommitmentReading; detected: DetectedException[] }> {
  const [reading, observations] = await Promise.all([
    readCommitments({
      projectId: input.projectId,
      opportunityId: input.opportunityId,
      currency: input.currency,
      declared: input.declared,
      dependencies: input.dependencies,
      now: input.now,
    }),
    observationsFor(input.opportunityId),
  ]);
  return { reading, detected: [...detectExceptions(reading), ...exceptionsFromObservations(reading, observations)] };
}

export interface Consequence {
  /** Customer money collected that could be owed back, cents; null when no row states it. */
  refundExposureCents: number | null;
  /** Money Brain still owes suppliers on commitments this exception touches or leaves open. */
  owedToSuppliersCents: number;
  /** Money Brain already owes a customer. */
  owedToCustomersCents: number;
  /** The change in agreed value, when stated. */
  valueDeltaCents: number | null;
  /** The amount in dispute, when stated. */
  disputedCents: number | null;
  /** Net cash at risk: what would leave less what has already settled and is ours; null when unknowable. */
  cashAtRiskCents: number | null;
  /** Contractual provisions that bind the remedy: cancellation, refund exposure, escalation path, payment hold… */
  bindingTerms: string[];
  unknowns: string[];
}

/** Quantifies the contractual and economic consequence from the reading. Pure. */
export function quantifyConsequence(reading: CommitmentReading, exception: DetectedException): Consequence {
  const unknowns: string[] = [];
  const authorized = reading.stages.PAYMENT_AUTHORIZED;
  const settled = reading.stages.FUNDS_SETTLED;
  const collected = settled.state === 'NOT_REACHED' && authorized.state === 'NOT_REACHED' ? null : settled.amountCents;
  const refunded = reading.owedToCustomers.unconfirmedRefundCents;
  const refundExposureCents = collected === null ? null : Math.max(0, collected);
  if (refundExposureCents === null) unknowns.push('no customer money has been recorded, so refund exposure is not stated');
  const owedToSuppliersCents = reading.owedToSuppliers.reduce((n, o) => n + o.owedCents, 0);
  if (reading.otherCurrencies.length) unknowns.push(`entries in ${reading.otherCurrencies.join(', ')} are not counted`);
  const cashAtRiskCents =
    refundExposureCents === null
      ? null
      : Math.max(0, refundExposureCents - refunded) + owedToSuppliersCents + (exception.valueDeltaCents && exception.valueDeltaCents < 0 ? -exception.valueDeltaCents : 0);
  const bindingTerms = reading.dependencies
    .filter((d) => /cancel|refund|escalat|hold|licen|insur|quality|schedul/i.test(d.kind) && d.satisfied !== true)
    .map((d) => `${d.kind}: ${d.detail}`);
  return {
    refundExposureCents,
    owedToSuppliersCents,
    owedToCustomersCents: reading.owedToCustomers.totalCents,
    valueDeltaCents: exception.valueDeltaCents,
    disputedCents: exception.disputedCents,
    cashAtRiskCents,
    bindingTerms,
    unknowns,
  };
}

/** What the caller is authorized to do. Everything absent is not permitted. */
export interface RemedyAuthority {
  /** Remedies that need no person's decision under the existing standing authority. */
  standing: readonly Remedy[];
  /** Remedies a named person has approved for this case. */
  approved: readonly { remedy: Remedy; approvedBy: string; ceilingCents?: number }[];
  /**
   * The grant's per-action ceiling, when the standing list came from a live
   * commercial grant. A remedy that spends is standing only when its stated
   * cost fits under it; an unstated cost never does (§39).
   */
  standingCeilingCents?: number | null;
  /** Which grant the standing list was read from, for the record. Null: none is live. */
  grant?: { id: string; name: string; policyVersion: number } | null;
}

/**
 * Which commercial action each remedy is, under the grant a person wrote
 * (`authority.ts`). A remedy that commits the company in law or in money maps
 * to nothing: no standing grant covers it, and it needs a person's approval for
 * the case. The grant is about effects, so the mapping is too — reaching the
 * buyer to escalate or reschedule is CONTACT_BUYER, bringing in another
 * provider is ENGAGE_CONTRACTOR, and so on.
 */
export const REMEDY_ACTION: Readonly<Record<Remedy, CommercialAction | null>> = {
  SUBSTITUTE_PROVIDER: 'ENGAGE_CONTRACTOR',
  RENEGOTIATE_SCOPE: null,
  RESCHEDULE: 'CONTACT_BUYER',
  PARTIAL_DELIVERY: 'QUOTE_AND_INVOICE',
  APPROVED_REFUND: null,
  ALTERNATE_COLLECTION: 'ACCEPT_PAYMENT',
  ESCALATE: 'CONTACT_BUYER',
  ORDERLY_CANCELLATION: null,
};

/** Remedies that spend the owner's money, so the grant's per-action ceiling and currency bind them. */
const SPENDING_REMEDIES: readonly Remedy[] = ['SUBSTITUTE_PROVIDER'];

/**
 * The authority a project actually holds over remedies, read from its live
 * commercial grant through `checkCommercialAuthority` — the one authority path,
 * so a prohibition, an expiry or a revocation refuses here exactly as it does
 * everywhere else. Standing covers only non-committing remedies; per-case
 * approvals are not standing authority and are passed by the caller that holds
 * them (`rehearseStoredCase`, `carryOutApprovedRefund`).
 */
export async function remedyAuthorityFor(input: { projectId: string; currency: string; at?: string }): Promise<RemedyAuthority> {
  const standing: Remedy[] = [];
  let grant: RemedyAuthority['grant'] = null;
  let ceiling: number | null = null;
  const decisions = new Map<CommercialAction, Awaited<ReturnType<typeof checkCommercialAuthority>>>();
  for (const remedy of REMEDIES) {
    const action = REMEDY_ACTION[remedy];
    if (!action || COMMITTING_REMEDIES.includes(remedy)) continue;
    let decision = decisions.get(action);
    if (!decision) {
      decision = await checkCommercialAuthority({ projectId: input.projectId, action, at: input.at });
      decisions.set(action, decision);
    }
    if (decision.authority) {
      grant = { id: decision.authority.id, name: decision.authority.name, policyVersion: decision.authority.policyVersion };
      ceiling = decision.authority.maxPerActionCents;
    }
    if (!decision.ok) continue;
    if (SPENDING_REMEDIES.includes(remedy) && decision.authority?.currency !== input.currency) continue;
    standing.push(remedy);
  }
  return { standing, approved: [], standingCeilingCents: ceiling, grant };
}

/**
 * Facts the reading itself states: a declared escalation path, scheduling
 * window, substitute provider or alternate collection channel. A dependency
 * recorded as unsatisfied is not a fact that the remedy is available. Explicit
 * facts win over what is read.
 */
export function factsFromReading(reading: CommitmentReading, explicit: RemedyFacts = {}): RemedyFacts {
  const has = (re: RegExp): boolean | undefined =>
    reading.dependencies.some((d) => re.test(d.kind) && d.satisfied !== false) ? true : undefined;
  const read: RemedyFacts = {
    escalationPath: has(/escalat/i),
    rescheduleWindowAvailable: has(/schedul/i),
    substituteProviderAvailable: has(/substitut|alternate provider|backup provider/i),
    alternateCollectionChannel: has(/collection channel|alternate (payment|collection)/i),
    partialDeliveryPossible: has(/milestone|partial/i),
  };
  const merged: RemedyFacts = {};
  for (const key of Object.keys(read) as (keyof RemedyFacts)[]) {
    const value = explicit[key] ?? read[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** What exists to carry a remedy out. Unstated means unavailable. */
export interface RemedyFacts {
  substituteProviderAvailable?: boolean;
  rescheduleWindowAvailable?: boolean;
  partialDeliveryPossible?: boolean;
  alternateCollectionChannel?: boolean;
  escalationPath?: boolean;
}

/** Remedies that commit the company in law or in money: never taken on standing authority alone. */
export const COMMITTING_REMEDIES: readonly Remedy[] = ['RENEGOTIATE_SCOPE', 'APPROVED_REFUND', 'ORDERLY_CANCELLATION'];

export interface RemedyOption {
  remedy: Remedy;
  feasible: boolean;
  /** Feasible and inside authority: it may be carried out now. */
  withinAuthority: boolean;
  /** What authority covers it, feasible or not: the standing grant, a named approval, or nothing. */
  authorizedBy: string | null;
  /** The specific smallest approval missing, when feasible but not authorized. */
  needsApproval: string | null;
  why: string;
  /** What carrying it out would cost, where the reading states it. */
  costCents: number | null;
}

export interface RemedySelection {
  exception: DetectedException;
  consequence: Consequence;
  options: RemedyOption[];
  /** The chosen remedy, or null when nothing feasible is within authority. */
  chosen: RemedyOption | null;
  /** When nothing may proceed: the one approval that would unblock the best feasible option. */
  needs: string | null;
  /** Work that carries on regardless: what is not touched by this exception. */
  safeWork: string[];
}

/** Which remedies address which kind: a starting set the evidence then narrows, not a closed rule. */
const CANDIDATES: Readonly<Record<ExceptionKind, readonly Remedy[]>> = {
  SCOPE_CHANGE: ['RENEGOTIATE_SCOPE', 'PARTIAL_DELIVERY', 'ESCALATE', 'ORDERLY_CANCELLATION'],
  MISSED_DATE: ['SUBSTITUTE_PROVIDER', 'RESCHEDULE', 'PARTIAL_DELIVERY', 'ESCALATE', 'APPROVED_REFUND'],
  CANCELLATION: ['ORDERLY_CANCELLATION', 'APPROVED_REFUND', 'RENEGOTIATE_SCOPE', 'ESCALATE'],
  PAYMENT_FAILURE: ['ALTERNATE_COLLECTION', 'RESCHEDULE', 'ESCALATE', 'ORDERLY_CANCELLATION'],
  DISPUTE: ['PARTIAL_DELIVERY', 'APPROVED_REFUND', 'RENEGOTIATE_SCOPE', 'ESCALATE'],
};

function feasibility(remedy: Remedy, facts: RemedyFacts, c: Consequence): { feasible: boolean; why: string; costCents: number | null } {
  switch (remedy) {
    case 'SUBSTITUTE_PROVIDER':
      return facts.substituteProviderAvailable
        ? { feasible: true, why: 'a substitute provider is available', costCents: c.owedToSuppliersCents || null }
        : { feasible: false, why: 'no substitute provider is stated as available', costCents: null };
    case 'RESCHEDULE':
      return facts.rescheduleWindowAvailable
        ? { feasible: true, why: 'a scheduling window is open', costCents: 0 }
        : { feasible: false, why: 'no scheduling window is stated', costCents: null };
    case 'PARTIAL_DELIVERY':
      return facts.partialDeliveryPossible
        ? { feasible: true, why: 'part of the scope can be delivered and accepted on its own', costCents: null }
        : { feasible: false, why: 'the scope is not stated as separable', costCents: null };
    case 'ALTERNATE_COLLECTION':
      return facts.alternateCollectionChannel
        ? { feasible: true, why: 'another collection channel exists', costCents: null }
        : { feasible: false, why: 'no other collection channel is stated', costCents: null };
    case 'ESCALATE':
      return facts.escalationPath
        ? { feasible: true, why: 'the agreement names an escalation path', costCents: 0 }
        : { feasible: false, why: 'no escalation path is stated', costCents: null };
    case 'APPROVED_REFUND':
      return c.refundExposureCents && c.refundExposureCents > 0
        ? { feasible: true, why: 'customer money was collected and can be returned', costCents: c.disputedCents ?? c.refundExposureCents }
        : { feasible: false, why: 'no collected customer money is recorded, so there is nothing to refund', costCents: null };
    case 'RENEGOTIATE_SCOPE':
      return { feasible: true, why: 'terms can be reopened with the buyer', costCents: null };
    case 'ORDERLY_CANCELLATION':
      return { feasible: true, why: 'the agreement can be released in order, settling what is owed', costCents: c.owedToSuppliersCents };
  }
}

/** Chooses a feasible remedy strictly inside the authority held. Pure; carries nothing out. */
export function selectRemedy(input: {
  reading: CommitmentReading;
  exception: DetectedException;
  facts: RemedyFacts;
  authority: RemedyAuthority;
}): RemedySelection {
  const { reading, exception, facts, authority } = input;
  const consequence = quantifyConsequence(reading, exception);
  const options: RemedyOption[] = CANDIDATES[exception.kind].map((remedy) => {
    const f = feasibility(remedy, facts, consequence);
    const approval = authority.approved.find((a) => a.remedy === remedy);
    const committing = COMMITTING_REMEDIES.includes(remedy);
    const standingCeiling = authority.standingCeilingCents ?? null;
    const overStandingCeiling =
      SPENDING_REMEDIES.includes(remedy) && standingCeiling !== null && (f.costCents === null || f.costCents > standingCeiling);
    const granted = authority.standing.includes(remedy) && !committing;
    const standing = granted && !overStandingCeiling;
    const overCeiling = approval?.ceilingCents !== undefined && f.costCents !== null && f.costCents > approval.ceilingCents;
    const withinAuthority = f.feasible && (standing || (Boolean(approval) && !overCeiling));
    const grantName = authority.grant ? `the standing commercial authority "${authority.grant.name}"` : 'standing authority';
    return {
      remedy,
      feasible: f.feasible,
      withinAuthority,
      authorizedBy: standing
        ? `${grantName} (${REMEDY_ACTION[remedy] ?? remedy})`
        : approval && !overCeiling
          ? `${approval.approvedBy}'s approval`
          : null,
      needsApproval: f.feasible && !withinAuthority
        ? overCeiling
          ? `${approval!.approvedBy}'s approval of ${remedy} covers ${approval!.ceilingCents} cents; it would cost ${f.costCents}`
          : granted && overStandingCeiling
            ? `${grantName} covers ${standingCeiling} cents per action; ${remedy} would cost ${f.costCents ?? 'an unstated amount'}`
            : committing
            ? `a person's approval of ${remedy} for this case (it commits the company)`
            : `standing authority for ${remedy}`
        : null,
      why: f.why,
      costCents: f.costCents,
    };
  });
  // Cheapest authorized remedy first; an unstated cost sorts after a stated one.
  const authorized = options.filter((o) => o.withinAuthority).sort((a, b) => (a.costCents ?? Number.MAX_SAFE_INTEGER) - (b.costCents ?? Number.MAX_SAFE_INTEGER));
  const chosen = authorized[0] ?? null;
  const blocked = options.find((o) => o.feasible && !o.withinAuthority) ?? null;
  const safeWork = [
    'record the exception and its evidence',
    'keep every settled amount, supplier obligation and customer obligation in the ledger as it stands',
    ...(reading.owedToSuppliers.length ? ['honour supplier commitments already made'] : []),
    ...(chosen ? [] : ['continue every other transaction and research that this exception does not touch']),
  ];
  return { exception, consequence, options, chosen, needs: chosen ? null : blocked?.needsApproval ?? 'no feasible remedy is stated; name the missing fact', safeWork };
}

/**
 * Carries out an approved refund through the existing refund path, which
 * bounds it under the cash lock. Refuses without a named approver and outside
 * the approved ceiling; never refunds on standing authority.
 */
export async function carryOutApprovedRefund(input: {
  projectId: string;
  agreementId: string;
  amountCents: number;
  reason: string;
  approval: { approvedBy: string; ceilingCents?: number } | null;
}): Promise<{ ok: true; detail: string } | { ok: false; reason: string }> {
  if (!input.approval?.approvedBy.trim()) return { ok: false, reason: 'A refund needs a named person’s approval; none was given.' };
  if (input.approval.ceilingCents !== undefined && input.amountCents > input.approval.ceilingCents) {
    return { ok: false, reason: `The approval covers ${input.approval.ceilingCents} cents; this refund is ${input.amountCents}.` };
  }
  const outcome = await authorizeRefund({
    projectId: input.projectId,
    agreementId: input.agreementId,
    amountCents: input.amountCents,
    reason: input.reason,
    actorRef: input.approval.approvedBy,
  });
  const result = outcome as { ok?: boolean; error?: string; message?: string; reason?: string };
  if (result.ok === false) return { ok: false, reason: String(result.error ?? result.message ?? result.reason ?? 'The refund was refused.') };
  return { ok: true, detail: 'the refund went through the existing refund path' };
}

export interface RehearsalStep {
  at: string | null;
  kind: 'STATE_CHANGE' | 'OBLIGATION' | 'IDENTITY' | 'MONEY' | 'AUTHORITY' | 'EXCEPTION' | 'RECOVERY';
  detail: string;
  ref: string | null;
}

/** Where the case began: the buyer's request, as the opportunity row records it. */
export interface CaseRequest {
  /** When the request was recorded. */
  at: string;
  /** The opportunity (or other row) that holds the request. */
  ref: string;
  detail: string;
}

/**
 * What S-0460 asks a demonstration to span, each read from the rows: the case
 * is traced from its request, through accepted fulfilment, to funds that
 * settled and reconcile. A trace missing any of these is not end to end.
 */
export interface EndToEnd {
  /** The request is on record and precedes the first agreement. */
  requestTraced: boolean;
  /** Every live agreement was delivered and accepted (WORK_ACCEPTED reached). */
  fulfilmentAccepted: boolean;
  /** The buyer paid in full and the payment settled (PAYMENT_AUTHORIZED and FUNDS_SETTLED reached). */
  fundsSettled: boolean;
  /** Nothing is left open on the money: no unconfirmed refund, nothing received beyond what was agreed, no supplier owed or overpaid, one currency. */
  reconciled: boolean;
}

export interface Rehearsal {
  /**
   * A rehearsal is a trace only of a real, sourced case with a recorded
   * failure, traced end to end: from the request through accepted fulfilment
   * and funds reconciliation (S-0460).
   */
  valid: boolean;
  refusals: string[];
  sourceRef: string | null;
  request: CaseRequest | null;
  endToEnd: EndToEnd;
  steps: RehearsalStep[];
  /** Stages reached by the end of the trace. */
  reached: string[];
}

/** Which parts of an end-to-end case the reading shows, and what is missing, in words. Pure. */
export function endToEndOf(reading: CommitmentReading, request: CaseRequest | null): { endToEnd: EndToEnd; missing: string[] } {
  const firstAgreement = reading.transitions
    .filter((t) => t.stage === 'CONTRACT_SIGNED' && t.at)
    .map((t) => t.at as string)
    .sort()[0];
  const requestTraced = Boolean(request && request.at.trim() && request.ref.trim() && (!firstAgreement || request.at <= firstAgreement));
  const fulfilmentAccepted = reading.stages.WORK_ACCEPTED.state === 'REACHED';
  const fundsSettled = reading.stages.PAYMENT_AUTHORIZED.state === 'REACHED' && reading.stages.FUNDS_SETTLED.state === 'REACHED';
  const reconciled =
    fundsSettled &&
    reading.otherCurrencies.length === 0 &&
    reading.owedToCustomers.totalCents === 0 &&
    reading.owedToSuppliers.every((o) => o.owedCents === 0 && o.overpaidCents === 0);
  const missing: string[] = [];
  if (!requestTraced) {
    missing.push(request ? 'the request is recorded after the agreement it led to, so the trace does not begin at the request' : 'the case has no request on record; the trace must begin at the request');
  }
  if (!fulfilmentAccepted) missing.push(`fulfilment was not accepted (${reading.stages.WORK_ACCEPTED.missing.join('; ') || reading.stages.WORK_ACCEPTED.state.toLowerCase()})`);
  if (!fundsSettled) {
    const why = [...reading.stages.PAYMENT_AUTHORIZED.missing, ...reading.stages.FUNDS_SETTLED.missing].join('; ');
    missing.push(`funds did not settle (${why || 'no settlement on the ledger'})`);
  } else if (!reconciled) {
    const open: string[] = [];
    if (reading.otherCurrencies.length > 0) open.push(`entries in ${reading.otherCurrencies.join(', ')} are not read`);
    if (reading.owedToCustomers.unconfirmedRefundCents > 0) open.push(`${reading.owedToCustomers.unconfirmedRefundCents} in refunds is unconfirmed`);
    if (reading.owedToCustomers.receivedBeyondAgreedCents > 0) open.push(`${reading.owedToCustomers.receivedBeyondAgreedCents} was received beyond what was agreed`);
    for (const o of reading.owedToSuppliers) {
      if (o.owedCents > 0) open.push(`${o.owedCents} is still owed to ${o.party.ref}`);
      if (o.overpaidCents > 0) open.push(`${o.party.ref} was overpaid by ${o.overpaidCents}`);
    }
    missing.push(`funds do not reconcile (${open.join('; ')})`);
  }
  return { endToEnd: { requestTraced, fulfilmentAccepted, fundsSettled, reconciled }, missing };
}

/** Traces one real case from the rows: state changes, obligations, identities, money, authority and recovery. Pure. */
export function traceCase(input: {
  sourceRef: string | null;
  /** The request the case began with; null when none is on record, which is refused. */
  request: CaseRequest | null;
  reading: CommitmentReading;
  entries: readonly CashMoneyEntry[];
  selections: readonly RemedySelection[];
  /** Recovery decisions actually made, by exception id. */
  recovered?: readonly { exceptionId: string; remedy: Remedy; at: string; by: string }[];
}): Rehearsal {
  const { reading, entries, selections } = input;
  const refusals: string[] = [];
  if (!input.sourceRef?.trim()) refusals.push('the case names no source; a rehearsal is of a real, sourced case');
  if (reading.transitions.length === 0) refusals.push('the commitment model has no transitions to trace');
  if (selections.length === 0) refusals.push('no failure path was recorded; a trace without one does not establish the recovery');
  // S-0460: from request through accepted fulfilment and funds reconciliation.
  const span = endToEndOf(reading, input.request);
  for (const why of span.missing) refusals.push(`not end to end: ${why}`);
  const steps: RehearsalStep[] = [];
  if (input.request) steps.push({ at: input.request.at, kind: 'STATE_CHANGE', detail: `request: ${input.request.detail}`, ref: input.request.ref });
  for (const t of reading.transitions) {
    steps.push({ at: t.at, kind: 'STATE_CHANGE', detail: `${t.kind}: ${t.outcome}${t.outcomeDetail ? ` (${t.outcomeDetail})` : ''}`, ref: t.id });
    if (t.duty.holder) steps.push({ at: t.deadline, kind: 'OBLIGATION', detail: `${t.duty.holder.role} to ${t.duty.action || t.kind}${t.deadline ? ` by ${t.deadline}` : ''}`, ref: t.id });
  }
  for (const p of reading.parties) steps.push({ at: null, kind: 'IDENTITY', detail: p.role, ref: p.ref });
  for (const e of entries) {
    steps.push({ at: e.occurredAt, kind: 'MONEY', detail: `${e.kind} ${e.amountCents} ${e.currency}`, ref: e.id });
  }
  for (const s of selections) {
    steps.push({ at: s.exception.at, kind: 'EXCEPTION', detail: `${s.exception.kind}: ${s.exception.detail}`, ref: s.exception.id });
    const authorityText = s.chosen
      ? `${s.chosen.remedy} is within authority`
      : `no remedy within authority; needs ${s.needs ?? 'a named approval'}`;
    steps.push({ at: s.exception.at, kind: 'AUTHORITY', detail: authorityText, ref: s.exception.id });
    const done = input.recovered?.find((r) => r.exceptionId === s.exception.id);
    if (done) steps.push({ at: done.at, kind: 'RECOVERY', detail: `${done.remedy} decided by ${done.by}`, ref: s.exception.id });
  }
  steps.sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'));
  return {
    valid: refusals.length === 0,
    refusals,
    sourceRef: input.sourceRef?.trim() || null,
    request: input.request,
    endToEnd: span.endToEnd,
    steps,
    reached: Object.values(reading.stages).filter((s) => s.state === 'REACHED').map((s) => s.stage),
  };
}

export interface StoredRehearsal {
  rehearsal: Rehearsal;
  detected: DetectedException[];
  selections: RemedySelection[];
  /** The `cash_events` row that persists the trace; its kind says whether the trace was valid. */
  eventId: string;
  eventKind: 'rehearsal.traced' | 'rehearsal.refused';
}

/**
 * Rehearses one stored, sourced case and persists the trace (LIFE-29-3).
 *
 * Reads the case from the rows (obligations and the money ledger) through the
 * existing readers, detects its exceptions, selects each remedy strictly inside
 * the authority given, traces it, and appends the whole trace to `cash_events` —
 * the append-only audit table that already owns cash history. No new store. A
 * trace the rules refuse (no source, no failure path) is still recorded, as
 * `rehearsal.refused` with its refusals, so a refusal is on record rather than
 * silent and is never mistaken for a demonstration. Nothing is refunded or
 * released here; carrying a remedy out stays with `carryOutApprovedRefund`.
 */
export async function rehearseStoredCase(input: {
  projectId: string;
  opportunityId: string;
  currency: string;
  sourceRef: string | null;
  actorRef: string;
  signals?: readonly ExceptionSignal[];
  facts?: RemedyFacts;
  authority?: RemedyAuthority;
  declared?: DeclaredTransition[];
  dependencies?: ExternalDependency[];
  recovered?: readonly { exceptionId: string; remedy: Remedy; at: string; by: string }[];
  now?: string;
  /** What the case looked like when traced, so the tick traces a case again only when it changed. */
  fingerprint?: string | null;
}): Promise<StoredRehearsal> {
  const { reading, detected: fromRows } = await detectFromRows({
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    currency: input.currency,
    declared: input.declared,
    dependencies: input.dependencies,
    now: input.now,
  });
  const entries = await listMoneyEntries({ projectId: input.projectId, opportunityId: input.opportunityId, limit: 2000 });
  const detected = [...fromRows, ...statedExceptions(input.signals ?? [])];
  const authority: RemedyAuthority =
    input.authority ?? (await remedyAuthorityFor({ projectId: input.projectId, currency: input.currency, at: input.now }));
  const facts = factsFromReading(reading, input.facts);
  const selections = detected.map((exception) => selectRemedy({ reading, exception, facts, authority }));
  const opportunity = await getOpportunity(input.opportunityId);
  const request: CaseRequest | null = opportunity
    ? { at: opportunity.createdAt, ref: opportunity.id, detail: opportunity.title }
    : null;
  const rehearsal = traceCase({ sourceRef: input.sourceRef, request, reading, entries, selections, recovered: input.recovered });
  const eventKind = rehearsal.valid ? 'rehearsal.traced' : 'rehearsal.refused';
  const event = await recordCashEvent({
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    kind: eventKind,
    actorRef: input.actorRef,
    summary: rehearsal.valid
      ? `rehearsed ${rehearsal.steps.length} steps over ${detected.length} exception(s), reaching ${rehearsal.reached.join(', ') || 'no stage'}`
      : `rehearsal refused: ${rehearsal.refusals.join('; ')}`,
    detail: {
      sourceRef: rehearsal.sourceRef,
      fingerprint: input.fingerprint ?? null,
      recovered: input.recovered ?? [],
      valid: rehearsal.valid,
      refusals: rehearsal.refusals,
      request: rehearsal.request,
      endToEnd: rehearsal.endToEnd,
      reached: rehearsal.reached,
      steps: rehearsal.steps,
      exceptions: detected.map((d) => ({ id: d.id, kind: d.kind, source: d.source })),
      authority: { grant: authority.grant ?? null, standing: authority.standing, approved: authority.approved.map((a) => ({ remedy: a.remedy, approvedBy: a.approvedBy })) },
      decisions: selections.map((s) => ({ exceptionId: s.exception.id, chosen: s.chosen?.remedy ?? null, authorizedBy: s.chosen?.authorizedBy ?? null, needs: s.needs, consequence: s.consequence })),
    },
  });
  return { rehearsal, detected, selections, eventId: event.id, eventKind };
}

/**
 * The journey tick's consumer of the commitment model (LIFE-29-3).
 *
 * Reads one deal's commitments from the rows, detects the exceptions the rows
 * show (a missed date, a payment that failed, a rejected delivery, a released
 * commitment, and the buyer's recorded counter-offer or refusal after agreement:
 * a scope change, a cancellation or a dispute), quantifies each one's consequence and works out which remedy
 * each would take, strictly inside the authority the project holds — its live
 * commercial grant, read through `checkCommercialAuthority` — so a remedy the
 * grant covers is chosen and what each other one needs is stated. Nothing is
 * carried out here. A new exception is appended
 * once to `cash_events` as `exception.detected`; one already on record (by its
 * id, which is derived from the transition that shows it) is not recorded
 * again, so the tick can run as often as it likes. A scope change or a dispute
 * is read from the buyer's own recorded answer (`exceptionsFromObservations`),
 * never invented from silence. Nothing is refunded, released or contacted: carrying a remedy out stays
 * with `carryOutApprovedRefund` and a person's approval.
 */
export async function recordDetectedExceptions(input: {
  projectId: string;
  opportunityId: string;
  currency: string;
  now?: string;
}): Promise<{ detected: number; recorded: number }> {
  const { reading, detected } = await detectFromRows({ projectId: input.projectId, opportunityId: input.opportunityId, currency: input.currency, now: input.now });
  if (detected.length === 0) return { detected: 0, recorded: 0 };
  const known = new Set(
    (await cashEventsOfKind(input.opportunityId, 'exception.detected')).map((event) => String((event.detail as { exceptionId?: unknown } | null)?.exceptionId ?? '')),
  );
  // The project's own limits: its live commercial grant, read through the one authority path.
  const authority = await remedyAuthorityFor({ projectId: input.projectId, currency: input.currency, at: input.now });
  const facts = factsFromReading(reading);
  let recorded = 0;
  for (const exception of detected) {
    if (known.has(exception.id)) continue;
    const selection = selectRemedy({ reading, exception, facts, authority });
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: input.opportunityId,
      kind: 'exception.detected',
      actorRef: 'BRAIN',
      summary: `${exception.kind.toLowerCase().replace(/_/g, ' ')}: ${exception.detail}`.slice(0, 300),
      detail: {
        exceptionId: exception.id,
        kind: exception.kind,
        source: exception.source,
        transitionId: exception.transitionId,
        evidence: exception.evidence,
        consequence: selection.consequence,
        authority: { grant: authority.grant ?? null, standing: authority.standing },
        remedies: selection.options.map((o) => ({ remedy: o.remedy, feasible: o.feasible, withinAuthority: o.withinAuthority, authorizedBy: o.authorizedBy, needsApproval: o.needsApproval })),
        chosen: selection.chosen?.remedy ?? null,
        authorizedBy: selection.chosen?.authorizedBy ?? null,
        needs: selection.needs,
        safeWork: selection.safeWork,
      },
    });
    known.add(exception.id);
    recorded += 1;
    await raiseRefundApproval({ projectId: input.projectId, opportunityId: input.opportunityId, reading, selection });
  }
  return { detected: detected.length, recorded };
}

/*
 * Carrying a remedy out (LIFE-29-3).
 *
 * A refund commits the company's money, so no standing grant covers it and the
 * tick never takes one by itself. When a recorded exception has a feasible
 * refund that is not within authority, the tick asks for exactly that approval
 * as a need — the surface a person already uses to answer Brain (§35) — keyed
 * by the exception, the agreement and the amount. Resolving that need is the
 * approval; withdrawing it is the refusal. The need continuation
 * (`operate.ts`), which already owns "a person answered, now resume the work"
 * and claims each answered need once with a compare-and-swap, hands a resolved
 * one to `carryOutApprovedRemedy`, which carries the refund out through
 * `carryOutApprovedRefund` and the existing bounded refund path. No new store,
 * claim or authority path.
 */
export const REMEDY_APPROVAL_PREFIX = 'remedy-approval:';

export function remedyApprovalKey(remedy: Remedy, agreementId: string, exceptionId: string): string {
  return `${REMEDY_APPROVAL_PREFIX}${remedy}:${agreementId}:${exceptionId}`;
}

export function parseRemedyApprovalKey(key: string | null | undefined): { remedy: Remedy; agreementId: string; exceptionId: string } | null {
  if (!key?.startsWith(REMEDY_APPROVAL_PREFIX)) return null;
  const rest = key.slice(REMEDY_APPROVAL_PREFIX.length);
  const first = rest.indexOf(':');
  const second = first < 0 ? -1 : rest.indexOf(':', first + 1);
  if (first <= 0 || second <= first + 1 || second === rest.length - 1) return null;
  const remedy = rest.slice(0, first) as Remedy;
  if (!REMEDIES.includes(remedy)) return null;
  return { remedy, agreementId: rest.slice(first + 1, second), exceptionId: rest.slice(second + 1) };
}

/** The agreement an exception's transition belongs to, read from the transition's own parties. */
function agreementOf(reading: CommitmentReading, exception: DetectedException): string | null {
  const t = reading.transitions.find((one) => one.id === exception.transitionId);
  return t?.parties.find((p) => p.role === 'agreement')?.ref ?? null;
}

async function raiseRefundApproval(input: {
  projectId: string;
  opportunityId: string;
  reading: CommitmentReading;
  selection: RemedySelection;
}): Promise<void> {
  const { selection } = input;
  if (selection.chosen) return;
  const refund = selection.options.find((o) => o.remedy === 'APPROVED_REFUND');
  if (!refund || !refund.feasible || refund.withinAuthority) return;
  const amount = refund.costCents;
  if (amount === null || !Number.isInteger(amount) || amount <= 0) return;
  const agreementId = agreementOf(input.reading, selection.exception);
  if (!agreementId) return;
  const kind = selection.exception.kind.toLowerCase().replace(/_/g, ' ');
  await raiseNeed({
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    actorRef: 'BRAIN',
    blockedAction: `Refund ${amount} cents to the buyer as the remedy for a ${kind}`,
    whyItMatters: `${selection.exception.detail}. A refund commits the company's money, so it needs a person's approval for this case.`.slice(0, 500),
    recommendedPath: 'Resolve this need to approve the refund; Brain then carries it out through the bounded refund path, for at most the amount stated. Withdraw it to decline.',
    expectedCostCents: amount,
    setupEffort: 'One decision by a project owner or administrator.',
    nextStep: 'Resolve to approve, or withdraw to decline.',
    completionCondition: `A project owner or administrator resolves this need, approving a refund of at most ${amount} cents on agreement ${agreementId}.`,
    requestKey: remedyApprovalKey('APPROVED_REFUND', agreementId, selection.exception.id),
  });
}

/** Whether a person may approve a refund: the Cash Mode owner, or an active project owner or administrator. */
async function mayApproveRefund(projectId: string, userId: string): Promise<boolean> {
  const mode = await getCashMode(projectId);
  if (mode?.ownerUserId === userId) return true;
  const membership = await getMembership(projectId, 'HUMAN', userId);
  return Boolean(membership?.active && (membership.role === 'OWNER' || membership.role === 'ADMIN'));
}

export const REMEDY_CARRIED_OUT = 'remedy.carried_out';
export const REMEDY_REFUSED = 'remedy.refused';

/**
 * Carries out the remedy a person approved by resolving its need. Called once
 * per answered need by the need continuation, which claimed it first. A
 * refusal is recorded and never retried (§26); the refund path's own key joins
 * a repeat of the same request rather than paying twice.
 */
export async function carryOutApprovedRemedy(need: CashNeed): Promise<{ ok: boolean; note: string }> {
  const key = parseRemedyApprovalKey(need.requestKey);
  if (!key) return { ok: false, note: 'This need does not approve a remedy.' };
  const record = async (ok: boolean, note: string, approvedBy: string | null): Promise<{ ok: boolean; note: string }> => {
    await recordCashEvent({
      projectId: need.projectId,
      opportunityId: need.opportunityId,
      kind: ok ? REMEDY_CARRIED_OUT : REMEDY_REFUSED,
      actorRef: approvedBy ?? 'BRAIN',
      summary: `${key.remedy.toLowerCase().replace(/_/g, ' ')}: ${note}`.slice(0, 300),
      detail: { needId: need.id, exceptionId: key.exceptionId, remedy: key.remedy, agreementId: key.agreementId, amountCents: need.expectedCostCents, approvedBy, ok, note },
    });
    return { ok, note };
  };
  if (need.state !== 'RESOLVED') return record(false, `The approval was ${need.state.toLowerCase()}, so nothing was carried out.`, need.resolvedByUserId);
  const approvedBy = need.resolvedByUserId;
  if (!approvedBy || approvedBy === 'BRAIN') return record(false, 'No person resolved this need, so nothing was approved.', null);
  if (!(await mayApproveRefund(need.projectId, approvedBy))) {
    return record(false, 'The person who resolved this need may not approve a refund (it needs a project owner or administrator).', approvedBy);
  }
  if (key.remedy !== 'APPROVED_REFUND') return record(false, `Nothing here carries out ${key.remedy}.`, approvedBy);
  const amount = need.expectedCostCents;
  if (amount === null || amount <= 0) return record(false, 'The approval states no amount.', approvedBy);
  const done = await carryOutApprovedRefund({
    projectId: need.projectId,
    agreementId: key.agreementId,
    amountCents: amount,
    reason: `Approved remedy for ${key.exceptionId}: ${need.resolution ?? 'approved'}`,
    approval: { approvedBy, ceilingCents: amount },
  });
  return done.ok ? record(true, done.detail, approvedBy) : record(false, done.reason, approvedBy);
}

/** Recovery decisions actually carried out on this case, for the trace. */
export async function recoveredRemedies(opportunityId: string): Promise<{ exceptionId: string; remedy: Remedy; at: string; by: string }[]> {
  return (await cashEventsOfKind(opportunityId, REMEDY_CARRIED_OUT)).map((event) => {
    const d = (event.detail ?? {}) as { exceptionId?: unknown; remedy?: unknown; approvedBy?: unknown };
    return { exceptionId: String(d.exceptionId ?? ''), remedy: String(d.remedy ?? '') as Remedy, at: event.createdAt, by: String(d.approvedBy ?? event.actorRef) };
  }).filter((r) => r.exceptionId !== '' && REMEDIES.includes(r.remedy));
}

/** Where a case came from, as the opportunity records it. Null: it names no source. */
export function caseSourceRef(opportunity: { source: string | null; sourceClaimId: string | null }): string | null {
  const source = opportunity.source?.trim();
  if (source) return source;
  return opportunity.sourceClaimId ? `claim:${opportunity.sourceClaimId}` : null;
}

/**
 * The journey tick's entry to the rehearsal (LIFE-29-3): a real, sourced case
 * whose rows show a failure is traced through `rehearseStoredCase`, and traced
 * again only when the case changed — a new transition or outcome, a new
 * exception, a remedy carried out. A case that names no source is not traced:
 * a rehearsal is of a real, sourced case, and an unsourced one is left alone
 * rather than recorded as a refusal every tick.
 */
export async function rehearseCaseOnTick(input: {
  projectId: string;
  opportunityId: string;
  currency: string;
  now?: string;
}): Promise<{ rehearsed: boolean; eventKind: StoredRehearsal['eventKind'] | null }> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return { rehearsed: false, eventKind: null };
  const sourceRef = caseSourceRef(opportunity);
  if (!sourceRef) return { rehearsed: false, eventKind: null };
  const { reading, detected } = await detectFromRows({ projectId: input.projectId, opportunityId: input.opportunityId, currency: input.currency, now: input.now });
  if (detected.length === 0) return { rehearsed: false, eventKind: null };
  const recovered = await recoveredRemedies(input.opportunityId);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([
      sourceRef,
      reading.transitions.map((t) => [t.id, t.outcome, t.at]),
      detected.map((d) => d.id).sort(),
      recovered.map((r) => [r.exceptionId, r.remedy, r.at]),
    ]))
    .digest('hex')
    .slice(0, 32);
  for (const kind of ['rehearsal.traced', 'rehearsal.refused'] as const) {
    const prior = await cashEventsOfKind(input.opportunityId, kind);
    if (prior.some((event) => (event.detail as { fingerprint?: unknown } | null)?.fingerprint === fingerprint)) {
      return { rehearsed: false, eventKind: null };
    }
  }
  const stored = await rehearseStoredCase({
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    currency: input.currency,
    sourceRef,
    actorRef: 'BRAIN',
    recovered,
    now: input.now,
    fingerprint,
  });
  return { rehearsed: true, eventKind: stored.eventKind };
}
