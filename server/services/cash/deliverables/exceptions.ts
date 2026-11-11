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
 *  - detection is a pure reading of a `CommitmentReading` (plus the signals a
 *    person or another subsystem has stated, which the rows do not carry);
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
import { cashEventsOfKind, recordCashEvent } from '../../../repos/cashMode.ts';
import { listMoneyEntries } from '../../../repos/cashLedger.ts';
import { getOpportunity, needForKey } from '../../../repos/cashPortfolio.ts';
import { agreementsFor } from '../../../repos/cashJourney.ts';
import { getClaim } from '../../../repos/research.ts';
import { raiseNeed } from '../needs.ts';
import { readCommitments, type CommitmentReading, type CommitmentTransition, type DeclaredTransition, type ExternalDependency, type Party } from './commitments.ts';
// Registers the production probes r01.life-29-1 and r01.life-29-3 wherever the journey tick loads; they reach this module only at call time.
import './lifecycleProbes.ts';

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
  signals.forEach((s, i) => {
    found.push({
      id: `stated:${s.kind.toLowerCase()}:${i}:${s.at}`,
      kind: s.kind,
      source: 'STATED',
      at: s.at,
      transitionId: null,
      detail: s.detail,
      evidence: s.evidence,
      raisedBy: s.raisedBy ?? null,
      valueDeltaCents: s.valueDeltaCents ?? null,
      disputedCents: s.disputedCents ?? null,
    });
  });
  return found;
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

export interface Rehearsal {
  /** A rehearsal is a trace only of a real, sourced case with a recorded failure. */
  valid: boolean;
  refusals: string[];
  sourceRef: string | null;
  steps: RehearsalStep[];
  /** Stages reached by the end of the trace. */
  reached: string[];
}

/** Traces one real case from the rows: state changes, obligations, identities, money, authority and recovery. Pure. */
export function traceCase(input: {
  sourceRef: string | null;
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
  const steps: RehearsalStep[] = [];
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
}): Promise<StoredRehearsal> {
  const reading = await readCommitments({
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    currency: input.currency,
    declared: input.declared,
    dependencies: input.dependencies,
    now: input.now,
  });
  const entries = await listMoneyEntries({ projectId: input.projectId, opportunityId: input.opportunityId, limit: 2000 });
  const detected = detectExceptions(reading, input.signals ?? []);
  const authority: RemedyAuthority =
    input.authority ?? (await remedyAuthorityFor({ projectId: input.projectId, currency: input.currency, at: input.now }));
  const facts = factsFromReading(reading, input.facts);
  const selections = detected.map((exception) => selectRemedy({ reading, exception, facts, authority }));
  const rehearsal = traceCase({ sourceRef: input.sourceRef, reading, entries, selections, recovered: input.recovered });
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
      valid: rehearsal.valid,
      refusals: rehearsal.refusals,
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
 * commitment), quantifies each one's consequence and works out which remedy
 * each would take, strictly inside the authority the project holds — its live
 * commercial grant, read through `checkCommercialAuthority` — so a remedy the
 * grant covers is chosen and what each other one needs is stated. Nothing is
 * carried out here. A new exception is appended
 * once to `cash_events` as `exception.detected`; one already on record (by its
 * id, which is derived from the transition that shows it) is not recorded
 * again, so the tick can run as often as it likes. Stated exceptions (a scope
 * change, a dispute a person reports) come from signals and are not invented
 * here. Nothing is refunded, released or contacted: carrying a remedy out stays
 * with `carryOutApprovedRefund` and a person's approval.
 */
export async function recordDetectedExceptions(input: {
  projectId: string;
  opportunityId: string;
  currency: string;
  now?: string;
}): Promise<{ detected: number; recorded: number }> {
  const reading = await readCommitments({ projectId: input.projectId, opportunityId: input.opportunityId, currency: input.currency, now: input.now });
  const detected = detectExceptions(reading).filter((one) => one.source === 'ROWS');
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
        remedies: selection.options.map((o) => ({ remedy: o.remedy, feasible: o.feasible, withinAuthority: o.withinAuthority, authorizedBy: o.authorizedBy, needsApproval: o.needsApproval, costCents: o.costCents })),
        chosen: selection.chosen?.remedy ?? null,
        authorizedBy: selection.chosen?.authorizedBy ?? null,
        needs: selection.needs,
        safeWork: selection.safeWork,
      },
    });
    known.add(exception.id);
    recorded += 1;
  }
  // Every exception the rows show whose best feasible remedy needs a person is put in front of one, once.
  for (const exception of detected) {
    const selection = selectRemedy({ reading, exception, facts, authority });
    if (selection.chosen) continue;
    await askForRemedyApproval({ projectId: input.projectId, opportunityId: input.opportunityId, exception, selection });
  }
  return { detected: detected.length, recorded };
}

/** The need that asks a person to approve one remedy for one exception. Brain writes the key, so it is read back by id. */
export function remedyApprovalKey(opportunityId: string, exceptionId: string, remedy: Remedy): string {
  return `remedy-approval:${opportunityId}:${exceptionId}:${remedy}`;
}

/** Remedies Brain can carry out itself once a person approved them, through an existing bounded path. */
export const EXECUTABLE_REMEDIES: readonly Remedy[] = ['APPROVED_REFUND'];

/**
 * Raises, once per exception and remedy, the need that asks a person to approve
 * the cheapest feasible remedy the authority held does not cover. The person's
 * answer is the existing need surface: resolving it approves the remedy (their
 * user id is the approver), withdrawing it declines it. Nothing is carried out
 * here. A remedy already asked about (in any state) is not asked about again.
 */
async function askForRemedyApproval(input: {
  projectId: string;
  opportunityId: string;
  exception: DetectedException;
  selection: RemedySelection;
}): Promise<boolean> {
  const option = input.selection.options
    .filter((o) => o.feasible && !o.withinAuthority && o.needsApproval)
    .sort((a, b) => (a.costCents ?? Number.MAX_SAFE_INTEGER) - (b.costCents ?? Number.MAX_SAFE_INTEGER))[0];
  if (!option) return false;
  const key = remedyApprovalKey(input.opportunityId, input.exception.id, option.remedy);
  if (await needForKey(input.projectId, key)) return false;
  const executable = EXECUTABLE_REMEDIES.includes(option.remedy);
  const raised = await raiseNeed({
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    actorRef: 'BRAIN',
    blockedAction: `${option.remedy} for ${input.exception.kind.toLowerCase().replace(/_/g, ' ')} (${input.exception.id})`,
    whyItMatters: `${input.exception.detail}. ${option.why}; it needs ${option.needsApproval}.`.slice(0, 600),
    recommendedPath: executable
      ? `Approve ${option.remedy}${option.costCents !== null ? ` for ${option.costCents} cents` : ''}; Brain then carries it out through the existing bounded path.`
      : `Approve ${option.remedy}; Brain records the decision and the case's recovery, and carrying it out stays with the person who approved it.`,
    expectedCostCents: option.costCents,
    setupEffort: 'One decision.',
    nextStep: 'Resolve this need to approve the remedy, or withdraw it to decline.',
    completionCondition: `A person resolves this need, approving ${option.remedy} for exception ${input.exception.id}.`,
    requestKey: key,
  });
  return raised.ok;
}

export interface RemedyExecutionPass {
  /** Approved remedies carried out (or decided) this pass. */
  carriedOut: number;
  /** Approved remedies the bounded path refused, with why. */
  refused: { exceptionId: string; remedy: Remedy; reason: string }[];
}

/**
 * Carries out the remedies a person approved (LIFE-29-3).
 *
 * An approval is a `remedy-approval:` need a person resolved; the approver is
 * whoever resolved it, and the approved ceiling is the cost the need stated. An
 * approved refund goes through `carryOutApprovedRefund` — the existing refund
 * path, bounded under the cash lock — and is recorded once as
 * `remedy.carried_out`. An approved remedy Brain has no path to carry out
 * itself is recorded as `remedy.decided`: the recovery decision is on record and
 * carrying it out stays with the approver. A refusal is recorded once per
 * approval as `remedy.refused` and never retried by itself. A withdrawn need is
 * a decline and carries nothing out.
 */
export async function carryOutApprovedRemedies(input: { projectId: string; opportunityId: string }): Promise<RemedyExecutionPass> {
  const pass: RemedyExecutionPass = { carriedOut: 0, refused: [] };
  const events = await cashEventsOfKind(input.opportunityId, 'exception.detected');
  if (events.length === 0) return pass;
  const done = new Set<string>();
  for (const kind of ['remedy.carried_out', 'remedy.decided', 'remedy.refused']) {
    for (const event of await cashEventsOfKind(input.opportunityId, kind)) {
      const d = event.detail as { needId?: unknown };
      if (typeof d.needId === 'string') done.add(d.needId);
    }
  }
  for (const event of events) {
    const detail = event.detail as { exceptionId?: unknown; kind?: unknown };
    const exceptionId = typeof detail.exceptionId === 'string' ? detail.exceptionId : null;
    if (!exceptionId) continue;
    for (const remedy of REMEDIES) {
      const need = await needForKey(input.projectId, remedyApprovalKey(input.opportunityId, exceptionId, remedy));
      if (!need || need.state !== 'RESOLVED' || !need.resolvedByUserId || need.resolvedByUserId === 'BRAIN') continue;
      if (done.has(need.id)) continue;
      done.add(need.id);
      const approvedBy = need.resolvedByUserId;
      const base = { needId: need.id, exceptionId, exceptionKind: detail.kind ?? null, remedy, approvedBy, approvedCents: need.expectedCostCents };
      if (!EXECUTABLE_REMEDIES.includes(remedy)) {
        await recordCashEvent({
          projectId: input.projectId,
          opportunityId: input.opportunityId,
          kind: 'remedy.decided',
          actorRef: approvedBy,
          summary: `${remedy} approved by ${approvedBy} for ${exceptionId}; carrying it out stays with them.`,
          detail: base,
        });
        pass.carriedOut += 1;
        continue;
      }
      const refuseWith = async (reason: string) => {
        await recordCashEvent({
          projectId: input.projectId,
          opportunityId: input.opportunityId,
          kind: 'remedy.refused',
          actorRef: 'BRAIN',
          summary: `${remedy} approved by ${approvedBy} was not carried out: ${reason}`.slice(0, 300),
          detail: { ...base, reason },
        });
        pass.refused.push({ exceptionId, remedy, reason });
      };
      const agreement = (await agreementsFor(input.opportunityId)).find((a) => a.projectId === input.projectId);
      if (!agreement) {
        await refuseWith('the deal has no agreement for a refund to belong to');
        continue;
      }
      if (need.expectedCostCents === null || need.expectedCostCents <= 0) {
        await refuseWith('the approval states no amount, and Brain does not compose one');
        continue;
      }
      const outcome = await carryOutApprovedRefund({
        projectId: input.projectId,
        agreementId: agreement.id,
        amountCents: need.expectedCostCents,
        reason: `Approved remedy for ${String(detail.kind ?? 'exception').toLowerCase().replace(/_/g, ' ')} ${exceptionId}`,
        approval: { approvedBy, ceilingCents: need.expectedCostCents },
      });
      if (!outcome.ok) {
        await refuseWith(outcome.reason);
        continue;
      }
      await recordCashEvent({
        projectId: input.projectId,
        opportunityId: input.opportunityId,
        kind: 'remedy.carried_out',
        actorRef: approvedBy,
        summary: `${remedy} of ${need.expectedCostCents} cents approved by ${approvedBy} for ${exceptionId}: ${outcome.detail}.`,
        detail: { ...base, outcome: outcome.detail, agreementId: agreement.id },
      });
      pass.carriedOut += 1;
    }
  }
  return pass;
}

/** The case's source: its research claim's URL, or the source the opportunity names. Null when it names none. */
export async function sourceOfCase(opportunityId: string): Promise<string | null> {
  const opportunity = await getOpportunity(opportunityId);
  if (!opportunity) return null;
  if (opportunity.sourceClaimId) {
    const claim = await getClaim(opportunity.sourceClaimId);
    if (claim?.sourceUrl?.trim()) return claim.sourceUrl.trim();
  }
  return opportunity.source?.trim() || null;
}

/** Recovery decisions on record for a deal: carried-out and decided remedies, by exception. */
async function recoveriesOnRecord(opportunityId: string): Promise<{ exceptionId: string; remedy: Remedy; at: string; by: string }[]> {
  const out: { exceptionId: string; remedy: Remedy; at: string; by: string }[] = [];
  for (const kind of ['remedy.carried_out', 'remedy.decided']) {
    for (const event of await cashEventsOfKind(opportunityId, kind)) {
      const d = event.detail as { exceptionId?: unknown; remedy?: unknown };
      if (typeof d.exceptionId !== 'string' || !REMEDIES.includes(d.remedy as Remedy)) continue;
      out.push({ exceptionId: d.exceptionId, remedy: d.remedy as Remedy, at: event.createdAt, by: event.actorRef });
    }
  }
  return out;
}

/**
 * The journey tick's entry to the acceptance demonstration (LIFE-29-3).
 *
 * A deal is rehearsed once, from its own rows, when it is a real case that went
 * the whole way with a failure on it: it names a source, its work was accepted
 * and its funds settled, the rows show at least one exception, every exception
 * the rows show is on record, and no approval it asked a person for is still
 * open (so the trace carries the recovery decision rather than a pending one).
 * The trace is `rehearseStoredCase`'s, appended to `cash_events`. A deal that
 * already has a valid trace is not traced again. Returns the event id, or why
 * it was not rehearsed.
 */
export async function rehearseSettledCase(input: {
  projectId: string;
  opportunityId: string;
  currency: string;
  now?: string;
}): Promise<{ rehearsed: true; eventId: string; valid: boolean } | { rehearsed: false; why: string }> {
  if ((await cashEventsOfKind(input.opportunityId, 'rehearsal.traced')).length > 0) return { rehearsed: false, why: 'already traced' };
  const reading = await readCommitments({ projectId: input.projectId, opportunityId: input.opportunityId, currency: input.currency, now: input.now });
  if (reading.stages.WORK_ACCEPTED.state !== 'REACHED') return { rehearsed: false, why: 'the work is not accepted yet' };
  if (reading.stages.FUNDS_SETTLED.state !== 'REACHED') return { rehearsed: false, why: 'the funds have not settled yet' };
  const rows = detectExceptions(reading).filter((e) => e.source === 'ROWS');
  if (rows.length === 0) return { rehearsed: false, why: 'the rows show no failure on this case' };
  const recorded = new Set(
    (await cashEventsOfKind(input.opportunityId, 'exception.detected')).map((e) => String((e.detail as { exceptionId?: unknown }).exceptionId ?? '')),
  );
  if (rows.some((e) => !recorded.has(e.id))) return { rehearsed: false, why: 'an exception the rows show is not on record yet' };
  for (const exception of rows) {
    for (const remedy of REMEDIES) {
      const need = await needForKey(input.projectId, remedyApprovalKey(input.opportunityId, exception.id, remedy));
      if (need?.state === 'OPEN') return { rehearsed: false, why: `the approval of ${remedy} for ${exception.id} is still open` };
    }
  }
  const sourceRef = await sourceOfCase(input.opportunityId);
  if (!sourceRef) return { rehearsed: false, why: 'the case names no source' };
  const stored = await rehearseStoredCase({
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    currency: input.currency,
    sourceRef,
    actorRef: 'BRAIN',
    recovered: await recoveriesOnRecord(input.opportunityId),
    now: input.now,
  });
  return { rehearsed: true, eventId: stored.eventId, valid: stored.rehearsal.valid };
}
