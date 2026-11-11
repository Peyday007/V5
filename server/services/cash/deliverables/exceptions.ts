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
import { cashEventsOfKind, recordCashEvent } from '../../../repos/cashMode.ts';
import { listMoneyEntries } from '../../../repos/cashLedger.ts';
import { needForKey, openNeedForKey } from '../../../repos/cashPortfolio.ts';
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
  /** What the case looked like when traced, so a caller can trace it again only when it changed. */
  fingerprint?: string | null;
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
  const authority: RemedyAuthority = input.authority ?? { standing: [], approved: [] };
  const selections = detected.map((exception) => selectRemedy({ reading, exception, facts: input.facts ?? {}, authority }));
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
      decisions: selections.map((s) => ({ exceptionId: s.exception.id, chosen: s.chosen?.remedy ?? null, needs: s.needs, consequence: s.consequence })),
      recovered: input.recovered ?? [],
      fingerprint: input.fingerprint ?? null,
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
 * each would take, strictly inside the authority held — which is none, so what
 * each needs is stated and nothing is carried out. A new exception is appended
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
  let recorded = 0;
  for (const exception of detected) {
    if (known.has(exception.id)) continue;
    const selection = selectRemedy({ reading, exception, facts: {}, authority: { standing: [], approved: [] } });
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
        remedies: selection.options.map((o) => ({ remedy: o.remedy, feasible: o.feasible, withinAuthority: o.withinAuthority, needsApproval: o.needsApproval })),
        chosen: selection.chosen?.remedy ?? null,
        needs: selection.needs,
        safeWork: selection.safeWork,
      },
    });
    known.add(exception.id);
    recorded += 1;
  }
  return { detected: detected.length, recorded };
}

/*
 * Recovery on the live path (LIFE-29-3).
 *
 * `recordDetectedExceptions` detects and records; this carries a case forward.
 * The journey tick calls it for every deal with an agreement, so the
 * acceptance demonstration is produced by the running Brain rather than by a
 * test calling `rehearseStoredCase` directly:
 *
 *   1. an exception whose feasible remedy is a refund asks for exactly that
 *      approval, once, on the existing needs register (`cash_needs`, keyed by
 *      the exception), because a refund commits the company and is never taken
 *      on standing authority;
 *   2. once a person resolves that need, the refund is carried out through
 *      `carryOutApprovedRefund` — the existing, cash-locked refund path, bounded
 *      by the amount the request named — and the recovery decision is recorded
 *      once as `exception.recovered`; a person who withdraws it has said no,
 *      and is not asked again;
 *   3. a deal whose case has a source (the opportunity's own `source`, or the
 *      claim it was promoted from) is rehearsed from its rows with every recovery
 *      decided so far, and the trace is persisted — again only when the case
 *      changed, so the tick can run as often as it likes.
 *
 * Nothing here contacts anybody, and nothing is refunded without a named
 * person's approval on record.
 */

export const RECOVERY_EVENT = 'exception.recovered';

/**
 * The scope one refund approval covers: one deal's collected money.
 *
 * Several exceptions can show the same money at risk (a released agreement and
 * the ledger commitment it let go are both a cancellation of one payment), so
 * the approval is asked once per deal, not once per exception, and refunds it once.
 */
export function refundApprovalKey(opportunityId: string): string {
  return `exception-refund:${opportunityId}`;
}

/** The agreement a transition belongs to, read from its id; null when it names none (a ledger row). */
export function agreementOfTransition(transitionId: string | null): string | null {
  const match = transitionId ? /^(?:agreement|delivery|acceptance|failure|refund):([^:]+)/.exec(transitionId) : null;
  return match?.[1] ?? null;
}

/** What a case looked like, so the same case is not traced twice. Pure. */
export function caseFingerprint(input: {
  reading: CommitmentReading;
  detected: readonly DetectedException[];
  recovered: readonly { exceptionId: string; remedy: Remedy }[];
  entries: number;
}): string {
  return JSON.stringify({
    exceptions: input.detected.map((d) => d.id).sort(),
    recovered: input.recovered.map((r) => `${r.exceptionId}:${r.remedy}`).sort(),
    reached: Object.values(input.reading.stages).filter((st) => st.state === 'REACHED').map((st) => st.stage).sort(),
    transitions: input.reading.transitions.length,
    entries: input.entries,
  });
}

export interface RecoveryPass {
  /** Refund approvals newly asked for. */
  asked: number;
  /** Approved refunds carried out this pass. */
  carried: number;
  /** Approved refunds the refund path refused, with its reason. */
  refused: string[];
  /** The rehearsal row written this pass, if the case changed and has a source. */
  rehearsal: { eventId: string; eventKind: StoredRehearsal['eventKind'] } | null;
}

export async function advanceExceptionRecovery(input: {
  projectId: string;
  opportunityId: string;
  currency: string;
  /** The case's source; null when it has none, and then nothing is rehearsed. */
  sourceRef: string | null;
  /** The deal's agreements, used when an exception's transition names none. */
  agreementIds: readonly string[];
  now?: string;
}): Promise<RecoveryPass> {
  const pass: RecoveryPass = { asked: 0, carried: 0, refused: [], rehearsal: null };
  const now = input.now ?? new Date().toISOString();
  const reading = await readCommitments({ projectId: input.projectId, opportunityId: input.opportunityId, currency: input.currency, now });
  const detected = detectExceptions(reading).filter((one) => one.source === 'ROWS');
  if (detected.length === 0) return pass;

  const recoveredRows = await cashEventsOfKind(input.opportunityId, RECOVERY_EVENT);
  const recovered = new Map<string, { exceptionId: string; remedy: Remedy; at: string; by: string }>();
  const usedApprovals = new Set<string>();
  for (const row of recoveredRows) {
    const d = (row.detail ?? {}) as { exceptionIds?: unknown; remedy?: unknown; by?: unknown; needId?: unknown };
    if (typeof d.needId === 'string') usedApprovals.add(d.needId);
    if (!Array.isArray(d.exceptionIds) || typeof d.remedy !== 'string' || typeof d.by !== 'string') continue;
    for (const one of d.exceptionIds) {
      if (typeof one === 'string') recovered.set(one, { exceptionId: one, remedy: d.remedy as Remedy, at: row.createdAt, by: d.by });
    }
  }

  // The exceptions still open whose feasible remedy is returning collected money.
  const refundable = detected
    .filter((exception) => !recovered.has(exception.id))
    .map((exception) => ({
      exception,
      refund: selectRemedy({ reading, exception, facts: {}, authority: { standing: [], approved: [] } }).options.find(
        (o) => o.remedy === 'APPROVED_REFUND' && o.feasible && o.costCents !== null && o.costCents > 0,
      ),
    }))
    .filter((one): one is { exception: DetectedException; refund: RemedyOption & { costCents: number } } => Boolean(one.refund));
  // Prefer the exception that names its agreement, so the refund has an obligation to belong to.
  refundable.sort((a, b) => Number(agreementOfTransition(b.exception.transitionId) !== null) - Number(agreementOfTransition(a.exception.transitionId) !== null));

  const approved: { remedy: Remedy; approvedBy: string; ceilingCents?: number }[] = [];
  const primary = refundable[0];
  if (primary) {
    const amount = Math.max(...refundable.map((one) => one.refund.costCents));
    const key = refundApprovalKey(input.opportunityId);
    const latest = await needForKey(input.projectId, key);
    if (latest?.state === 'RESOLVED' && latest.resolvedByUserId && !usedApprovals.has(latest.id)) {
      const approval = { approvedBy: latest.resolvedByUserId, ceilingCents: latest.expectedCostCents ?? undefined };
      approved.push({ remedy: 'APPROVED_REFUND', ...approval });
      const agreementId = agreementOfTransition(primary.exception.transitionId) ?? (input.agreementIds.length === 1 ? input.agreementIds[0]! : null);
      if (!agreementId) {
        pass.refused.push(`${primary.exception.id}: the exception names no single agreement to refund against`);
      } else {
        const done = await carryOutApprovedRefund({
          projectId: input.projectId,
          agreementId,
          amountCents: amount,
          reason: `${primary.exception.kind.toLowerCase().replace(/_/g, ' ')}: ${primary.exception.detail}`.slice(0, 300),
          approval,
        });
        if (!done.ok) {
          pass.refused.push(`${primary.exception.id}: ${done.reason}`);
        } else {
          const exceptionIds = refundable.map((one) => one.exception.id);
          await recordCashEvent({
            projectId: input.projectId,
            opportunityId: input.opportunityId,
            kind: RECOVERY_EVENT,
            actorRef: approval.approvedBy,
            summary: `approved refund of ${amount} ${input.currency} carried out for ${primary.exception.kind.toLowerCase().replace(/_/g, ' ')}`,
            detail: { exceptionId: primary.exception.id, exceptionIds, remedy: 'APPROVED_REFUND', by: approval.approvedBy, needId: latest.id, agreementId, amountCents: amount },
          });
          for (const exceptionId of exceptionIds) recovered.set(exceptionId, { exceptionId, remedy: 'APPROVED_REFUND', at: now, by: approval.approvedBy });
          pass.carried += 1;
        }
      }
    } else if (!latest || (latest.state !== 'WITHDRAWN' && latest.state !== 'RESOLVED')) {
      // A "no" (withdrawn) is remembered and not asked again; an approval already used is not reused.
      if (!(await openNeedForKey(input.projectId, key))) {
        const raised = await raiseNeed({
          projectId: input.projectId,
          opportunityId: input.opportunityId,
          actorRef: 'BRAIN',
          blockedAction: 'APPROVED_REFUND',
          whyItMatters: `${primary.exception.kind.toLowerCase().replace(/_/g, ' ')}: ${primary.exception.detail}`.slice(0, 500),
          recommendedPath: primary.refund.needsApproval ?? `approve a refund of ${amount} ${input.currency} for this case`,
          expectedCostCents: amount,
          setupEffort: 'One approval from a person; every other transaction and research continues meanwhile.',
          nextStep: `Approve (resolve) or decline (withdraw) a refund of up to ${amount} ${input.currency} for this case.`,
          completionCondition: `A named person has approved or declined a refund of up to ${amount} ${input.currency} for this deal.`,
          requestKey: key,
        });
        if (raised.ok) pass.asked += 1;
      }
    }
  }

  if (!input.sourceRef?.trim()) return pass;
  const entries = await listMoneyEntries({ projectId: input.projectId, opportunityId: input.opportunityId, limit: 2000 });
  const recoveredList = [...recovered.values()];
  const fingerprint = caseFingerprint({ reading, detected, recovered: recoveredList, entries: entries.length });
  const traced = [
    ...(await cashEventsOfKind(input.opportunityId, 'rehearsal.traced')),
    ...(await cashEventsOfKind(input.opportunityId, 'rehearsal.refused')),
  ];
  if (traced.some((row) => (row.detail as { fingerprint?: unknown } | null)?.fingerprint === fingerprint)) return pass;
  const stored = await rehearseStoredCase({
    projectId: input.projectId,
    opportunityId: input.opportunityId,
    currency: input.currency,
    sourceRef: input.sourceRef,
    actorRef: 'BRAIN',
    authority: { standing: [], approved },
    recovered: recoveredList,
    now,
    fingerprint,
  });
  pass.rehearsal = { eventId: stored.eventId, eventKind: stored.eventKind };
  return pass;
}
