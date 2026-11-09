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
import type { CommitmentReading, CommitmentTransition, Party } from './commitments.ts';

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
    const standing = authority.standing.includes(remedy) && !committing;
    const overCeiling = approval?.ceilingCents !== undefined && f.costCents !== null && f.costCents > approval.ceilingCents;
    const withinAuthority = f.feasible && (standing || (Boolean(approval) && !overCeiling));
    return {
      remedy,
      feasible: f.feasible,
      withinAuthority,
      needsApproval: f.feasible && !withinAuthority
        ? overCeiling
          ? `${approval!.approvedBy}'s approval of ${remedy} covers ${approval!.ceilingCents} cents; it would cost ${f.costCents}`
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
