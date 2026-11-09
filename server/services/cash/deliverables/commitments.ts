/**
 * A transaction as a changing system of commitments.
 *
 * There is no "sale made" here, and no boolean that could stand in for one.
 * What a sale is made of are six separately-true things, and each is its own
 * derived reading:
 *
 *   CONTRACT_SIGNED       an agreement exists and has not been let go
 *   PAYMENT_AUTHORIZED    a buyer's payment was verified (it may still be pending)
 *   FUNDS_SETTLED         the money became usable — a different event, later
 *   WORK_ACCEPTED         the buyer accepted a full delivery
 *   MARGIN_EARNED         accepted revenue less every incremental cost, each once
 *   CASH_AVAILABLE        settled funds net of refunds and costs actually paid
 *
 * Nothing here is stored. Every reading is derived from rows Brain already
 * owns: the obligation (`journey/fulfillment.ts` `readObligation`) and the money
 * ledger (`cash_money_entries`, with the arithmetic of `money.ts`). This file
 * adds no store, scheduler or authority path; it is a pure function over those
 * rows plus a thin reader that fetches them.
 *
 * Structure is data, not a template. A transaction may skip steps, branch,
 * restart, split into milestones, or have several purchasers and providers, so
 * the unit is a `CommitmentTransition` carrying who owes what, by when, under
 * which terms, with which evidence and what outcome — and a transition may name
 * a parent, a branch, a restart of an earlier one, or a milestone. No industry,
 * mechanism or example is a whitelist: `kind` and `role` are free text.
 *
 * An unstated deadline is `null`, never invented, and an unstated term is
 * absent rather than assumed (§39).
 */
import type { CashMoneyEntry } from '../../../domain/types.ts';
import type { CashAgreement } from '../../../domain/cashJourney.ts';
import { listMoneyEntries } from '../../../repos/cashLedger.ts';
import { readObligations, type ObligationReading } from '../journey/fulfillment.ts';

export const COMMITMENT_STAGES = [
  'CONTRACT_SIGNED',
  'PAYMENT_AUTHORIZED',
  'FUNDS_SETTLED',
  'WORK_ACCEPTED',
  'MARGIN_EARNED',
  'CASH_AVAILABLE',
] as const;
export type CommitmentStage = (typeof COMMITMENT_STAGES)[number];

/** Per stage: not yet, some of it, all of it, or it was true and has been undone. */
export type StageState = 'NOT_REACHED' | 'PARTIAL' | 'REACHED' | 'REVERSED';

export interface StageReading {
  stage: CommitmentStage;
  state: StageState;
  /** The amount this stage stands for, in the transaction's currency; 0 when it carries none. */
  amountCents: number;
  /** What is still missing for the stage, in words; empty when reached. */
  missing: string[];
  evidence: string[];
}

export interface Party {
  /** Free text: buyer, purchaser, supplier, provider, licensed provider, payer… */
  role: string;
  /** A stable reference (ledger commitment id, agreement id, name); never inferred. */
  ref: string;
}

/**
 * One state change in the transaction.
 *
 * `branchOf`, `restartOf` and `milestone` are what let the same shape carry a
 * transaction that skips, forks, starts over or is paid in parts.
 */
export interface CommitmentTransition {
  id: string;
  /** What kind of step: free text (`agreement`, `delivery`, `deposit`, `supplier bill`, …). */
  kind: string;
  /** Who must do what. `holder` is null when nobody has been named — that is an answer. */
  duty: { holder: Party | null; action: string };
  /** ISO time the duty is due, or null when no deadline was agreed. */
  deadline: string | null;
  /** The agreed terms this step is performed under, verbatim where Brain has them. */
  terms: string[];
  evidence: string[];
  outcome: 'PENDING' | 'DONE' | 'REJECTED' | 'FAILED' | 'RELEASED' | 'UNKNOWN';
  outcomeDetail: string | null;
  /** When the outcome was recorded, if it was. */
  at: string | null;
  amountCents: number | null;
  /** Which stage, if any, this transition contributes to. */
  stage: CommitmentStage | null;
  parties: Party[];
  branchOf: string | null;
  restartOf: string | null;
  milestone: string | null;
}

/**
 * Structure a person or another Brain subsystem has stated and the rows do not
 * carry: a deadline, a branch, a purchaser, an external dependency. Declared
 * steps are merged in as they are; they never override a row.
 */
export interface DeclaredTransition {
  id: string;
  kind: string;
  action: string;
  holder?: Party | null;
  deadline?: string | null;
  terms?: string[];
  evidence?: string[];
  outcome?: CommitmentTransition['outcome'];
  outcomeDetail?: string | null;
  at?: string | null;
  amountCents?: number | null;
  stage?: CommitmentStage | null;
  parties?: Party[];
  branchOf?: string | null;
  restartOf?: string | null;
  milestone?: string | null;
}

/** External conditions that bind the transaction, stated as the contract states them. */
export interface ExternalDependency {
  /** delivery location, delivery method, scheduling window, cancellation provision,
   *  refund exposure, escalation path, payment hold, insurance/licensing, quality check… */
  kind: string;
  detail: string;
  holder?: Party | null;
  deadline?: string | null;
  satisfied?: boolean | null;
}

export interface OwedMoney {
  party: Party;
  /** Positive: still owed. Never negative — an overpaid bill is reported in `overpaidCents`. */
  owedCents: number;
  overpaidCents: number;
  /** Where the figure came from: ledger entry ids. */
  entries: string[];
}

export interface CommitmentReading {
  opportunityId: string;
  currency: string;
  stages: Record<CommitmentStage, StageReading>;
  transitions: CommitmentTransition[];
  /** Everyone who is a party, by role, deduplicated. Several of one role is ordinary. */
  parties: Party[];
  dependencies: ExternalDependency[];
  /** Money Brain still owes a supplier, by supplier commitment. */
  owedToSuppliers: OwedMoney[];
  /** Money Brain still owes a customer: refunds not confirmed, payment received beyond what was agreed. */
  owedToCustomers: { totalCents: number; unconfirmedRefundCents: number; receivedBeyondAgreedCents: number };
  /** True when any figure is not a plain reading of one currency (entries in another were left out). */
  otherCurrencies: string[];
  /** The first stage not reached, in order — or null when all six hold. */
  nextStage: CommitmentStage | null;
  /** Transitions whose deadline has passed without a recorded outcome, at `now`. */
  overdue: string[];
}

export interface CommitmentInput {
  opportunityId: string;
  currency: string;
  obligations: ObligationReading[];
  entries: CashMoneyEntry[];
  declared?: DeclaredTransition[];
  dependencies?: ExternalDependency[];
  now: string;
}

const sumKind = (entries: CashMoneyEntry[], ...kinds: string[]): number =>
  entries.filter((e) => kinds.includes(e.kind)).reduce((n, e) => n + e.amountCents, 0);

const idsOf = (entries: CashMoneyEntry[], ...kinds: string[]): string[] =>
  entries.filter((e) => kinds.includes(e.kind)).map((e) => e.id);

function stageState(have: number, want: number, reversed: boolean): StageState {
  if (want > 0 && have >= want) return 'REACHED';
  if (have > 0) return 'PARTIAL';
  return reversed ? 'REVERSED' : 'NOT_REACHED';
}

function agreementTerms(a: CashAgreement): string[] {
  return [
    `deliverable: ${a.deliverable}`,
    `acceptance: ${a.acceptanceCondition}`,
    `amount: ${a.amountCents} ${a.currency}`,
    `evidence: ${a.evidenceKind} ${a.evidenceRef}`,
  ];
}

/** The transitions the obligation rows state, one agreement at a time. */
function obligationTransitions(o: ObligationReading): CommitmentTransition[] {
  const a = o.agreement;
  const released = a.state === ('RELEASED' as typeof a.state) || a.releasedAt !== null;
  const terms = agreementTerms(a);
  const agreementId = `agreement:${a.id}`;
  const out: CommitmentTransition[] = [];
  const base = {
    terms,
    parties: [{ role: 'agreement', ref: a.id }],
    branchOf: null,
    restartOf: null,
    milestone: null,
    deadline: null,
  };

  out.push({
    ...base,
    id: agreementId,
    kind: 'agreement',
    duty: { holder: { role: 'recorder', ref: a.recordedBy }, action: 'Agree the deliverable and its acceptance condition' },
    evidence: [`${a.evidenceKind}:${a.evidenceRef}`],
    outcome: released ? 'RELEASED' : 'DONE',
    outcomeDetail: released ? a.releasedReason : null,
    at: released ? a.releasedAt : a.createdAt,
    amountCents: a.amountCents,
    stage: 'CONTRACT_SIGNED',
  });

  const workId = `work:${a.id}`;
  const workOutcome: CommitmentTransition['outcome'] =
    o.work.state === 'COMPLETE' ? 'DONE' : o.work.state === 'FAILED' ? 'FAILED' : 'PENDING';
  out.push({
    ...base,
    id: workId,
    kind: 'work',
    duty: { holder: o.work.ref ? { role: 'provider', ref: o.work.ref } : null, action: 'Produce the deliverable' },
    evidence: o.work.artifact ? [o.work.artifact] : [],
    outcome: workOutcome,
    outcomeDetail: o.work.detail,
    at: null,
    amountCents: null,
    stage: null,
    branchOf: agreementId,
  });

  // A delivery in parts is a milestone each; a rejected-and-redelivered round is a restart.
  o.delivery.portions.forEach((p, i) => {
    out.push({
      ...base,
      id: `delivery:${a.id}:${i + 1}`,
      kind: 'delivery',
      duty: { holder: o.work.ref ? { role: 'provider', ref: o.work.ref } : null, action: `Deliver: ${p.detail}` },
      evidence: p.evidence ? [p.evidence] : [],
      outcome: 'DONE',
      outcomeDetail: p.detail,
      at: p.at,
      amountCents: null,
      stage: null,
      branchOf: workId,
      milestone: `portion ${i + 1} of ${o.delivery.portions.length}`,
      restartOf: o.acceptance.state === 'REJECTED' && i > 0 ? `delivery:${a.id}:${i}` : null,
    });
  });

  const acceptOutcome: CommitmentTransition['outcome'] =
    o.acceptance.state === 'ACCEPTED' ? 'DONE' : o.acceptance.state === 'REJECTED' ? 'REJECTED' : 'PENDING';
  out.push({
    ...base,
    id: `acceptance:${a.id}`,
    kind: 'acceptance',
    duty: { holder: { role: 'buyer', ref: a.opportunityId }, action: `Accept against: ${o.acceptance.condition}` },
    evidence: o.acceptance.evidence ? [o.acceptance.evidence] : [],
    outcome: acceptOutcome,
    outcomeDetail: o.acceptance.reason,
    at: null,
    amountCents: a.amountCents,
    stage: 'WORK_ACCEPTED',
    branchOf: workId,
  });

  if (o.failure) {
    out.push({
      ...base,
      id: `failure:${a.id}`,
      kind: 'failure',
      duty: { holder: null, action: 'Resolve the failure by an authorized remedy' },
      evidence: [],
      outcome: 'FAILED',
      outcomeDetail: `${o.failure.kind}: ${o.failure.reason}`,
      at: o.failure.at,
      amountCents: null,
      stage: null,
      branchOf: workId,
    });
  }

  for (const r of o.refunds) {
    const outcome: CommitmentTransition['outcome'] =
      r.state === 'CONFIRMED' ? 'DONE' : r.state === 'FAILED' ? 'FAILED' : r.state === 'UNKNOWN' ? 'UNKNOWN' : 'PENDING';
    out.push({
      ...base,
      id: `refund:${a.id}:${r.refundKey}`,
      kind: 'refund',
      duty: { holder: { role: 'payer', ref: 'brain' }, action: `Refund: ${r.reason}` },
      evidence: r.reference ? [r.reference] : [],
      outcome,
      outcomeDetail: r.outcomeDetail,
      at: r.authorizedAt,
      amountCents: r.amountCents,
      stage: null,
      branchOf: agreementId,
    });
  }
  return out;
}

const LEDGER_KIND: Record<string, { kind: string; action: string; stage: CommitmentStage | null; role: string }> = {
  PIPELINE_AGREED: { kind: 'agreed amount', action: 'Bill the agreed amount', stage: null, role: 'buyer' },
  PIPELINE_RELEASED: { kind: 'agreed amount released', action: 'Agreed work will no longer be billed', stage: null, role: 'buyer' },
  CUSTOMER_PAYMENT: { kind: 'payment', action: 'Pay the buyer-side amount', stage: 'PAYMENT_AUTHORIZED', role: 'buyer' },
  SETTLEMENT: { kind: 'settlement', action: 'Settle the payment into usable funds', stage: 'FUNDS_SETTLED', role: 'payment provider' },
  REFUND: { kind: 'refund paid', action: 'Return money to the buyer', stage: null, role: 'buyer' },
  COST: { kind: 'cost paid', action: 'Pay an incremental cost', stage: null, role: 'supplier' },
  UNPAID_COMMITMENT: { kind: 'supplier commitment', action: 'Pay the supplier when due', stage: null, role: 'supplier' },
  COMMITMENT_PAID: { kind: 'supplier paid', action: 'Close the supplier commitment', stage: null, role: 'supplier' },
  COMMITMENT_RELEASED: { kind: 'supplier commitment released', action: 'Supplier no longer owed', stage: null, role: 'supplier' },
};

function ledgerTransitions(entries: CashMoneyEntry[]): CommitmentTransition[] {
  const out: CommitmentTransition[] = [];
  for (const e of entries) {
    const shape = LEDGER_KIND[e.kind];
    if (!shape) continue; // capital and reserves are the account's, not this transaction's
    const party: Party = {
      role: shape.role,
      ref: e.commitmentId ?? e.verifiedReference ?? e.id,
    };
    out.push({
      id: `ledger:${e.id}`,
      kind: shape.kind,
      duty: { holder: party, action: shape.action },
      deadline: e.kind === 'SETTLEMENT' ? null : e.fundsAvailableAt && e.kind === 'CUSTOMER_PAYMENT' ? e.fundsAvailableAt : null,
      terms: e.note ? [e.note] : [],
      evidence: e.verifiedReference ? [e.verifiedReference] : [],
      outcome: e.kind === 'PIPELINE_RELEASED' || e.kind === 'COMMITMENT_RELEASED' ? 'RELEASED' : 'DONE',
      outcomeDetail: e.note,
      at: e.occurredAt,
      amountCents: e.amountCents,
      stage: shape.stage,
      parties: [party],
      branchOf: e.commitmentId ? `commitment:${e.commitmentId}` : null,
      restartOf: null,
      milestone: null,
    });
  }
  return out;
}

/** Money still owed to each supplier commitment, from the ledger alone. */
function supplierOwed(entries: CashMoneyEntry[]): OwedMoney[] {
  const groups = new Map<string, CashMoneyEntry[]>();
  for (const e of entries) {
    if (!['UNPAID_COMMITMENT', 'COMMITMENT_PAID', 'COMMITMENT_RELEASED'].includes(e.kind)) continue;
    const key = e.commitmentId ?? `unattributed:${e.id}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.entries()]
    .map(([ref, rows]) => {
      const net = sumKind(rows, 'UNPAID_COMMITMENT') - sumKind(rows, 'COMMITMENT_PAID', 'COMMITMENT_RELEASED');
      return {
        party: { role: 'supplier', ref },
        owedCents: Math.max(0, net),
        overpaidCents: Math.max(0, -net),
        entries: rows.map((r) => r.id),
      };
    })
    .sort((a, b) => a.party.ref.localeCompare(b.party.ref));
}

function uniqueParties(ts: CommitmentTransition[]): Party[] {
  const seen = new Map<string, Party>();
  for (const t of ts) for (const p of [...t.parties, ...(t.duty.holder ? [t.duty.holder] : [])]) seen.set(`${p.role}\u0000${p.ref}`, p);
  return [...seen.values()].sort((a, b) => `${a.role}${a.ref}`.localeCompare(`${b.role}${b.ref}`));
}

/**
 * The pure derivation. Same rows in, same reading out; `now` is a parameter so
 * "overdue" is a function of its inputs rather than of the clock.
 */
export function deriveCommitments(input: CommitmentInput): CommitmentReading {
  const entries = input.entries.filter((e) => e.currency === input.currency);
  const otherCurrencies = [...new Set(input.entries.map((e) => e.currency).filter((c) => c !== input.currency))].sort();
  const live = input.obligations.filter((o) => o.agreement.releasedAt === null && o.agreement.currency === input.currency);

  const agreed = Math.max(0, sumKind(entries, 'PIPELINE_AGREED') - sumKind(entries, 'PIPELINE_RELEASED'));
  const payments = sumKind(entries, 'CUSTOMER_PAYMENT');
  const refunds = sumKind(entries, 'REFUND');
  const settled = sumKind(entries, 'SETTLEMENT');
  const costs = sumKind(entries, 'COST');
  const owed = supplierOwed(entries);
  const unpaid = owed.reduce((n, o) => n + o.owedCents, 0);

  const accepted = live.filter((o) => o.acceptance.state === 'ACCEPTED' && o.delivery.state === 'DELIVERED');
  const acceptedCents = accepted.reduce((n, o) => n + o.agreement.amountCents, 0);
  const liveCents = live.reduce((n, o) => n + o.agreement.amountCents, 0);

  const unconfirmedRefundCents = input.obligations
    .flatMap((o) => o.refunds)
    .filter((r) => r.state !== 'CONFIRMED')
    .reduce((n, r) => n + r.amountCents, 0);
  // Received beyond what was agreed is money that is not ours to count as earned.
  const receivedBeyondAgreedCents = Math.max(0, payments - refunds - Math.max(agreed, liveCents));

  // Margin: revenue the buyer accepted, less every incremental cost once
  // (paid as COST, or still owed), less money owed back. Never from a payment.
  const margin = acceptedCents - costs - unpaid - receivedBeyondAgreedCents;
  const cash = settled - refunds - costs;

  const reading = (
    stage: CommitmentStage,
    state: StageState,
    amountCents: number,
    missing: string[],
    evidence: string[],
  ): StageReading => ({ stage, state, amountCents, missing: state === 'REACHED' ? [] : missing, evidence });

  const stages: Record<CommitmentStage, StageReading> = {
    CONTRACT_SIGNED: reading(
      'CONTRACT_SIGNED',
      stageState(live.length, input.obligations.length || 1, input.obligations.length > 0 && live.length === 0),
      agreed,
      ['No live agreement is recorded.'],
      live.map((o) => `agreement:${o.agreement.id}`),
    ),
    PAYMENT_AUTHORIZED: reading(
      'PAYMENT_AUTHORIZED',
      stageState(payments - refunds, agreed, payments > 0 && payments - refunds <= 0),
      payments,
      [`${Math.max(0, agreed - (payments - refunds))} of ${agreed} not yet paid.`],
      idsOf(entries, 'CUSTOMER_PAYMENT'),
    ),
    FUNDS_SETTLED: reading(
      'FUNDS_SETTLED',
      stageState(settled, payments, settled > 0 && settled - refunds <= 0),
      settled,
      [`${Math.max(0, payments - settled)} of ${payments} paid but not yet usable.`],
      idsOf(entries, 'SETTLEMENT'),
    ),
    WORK_ACCEPTED: reading(
      'WORK_ACCEPTED',
      stageState(acceptedCents, liveCents, live.some((o) => o.acceptance.state === 'REJECTED') && acceptedCents === 0),
      acceptedCents,
      live.filter((o) => !accepted.includes(o)).flatMap((o) => o.outstanding),
      accepted.map((o) => `acceptance:${o.agreement.id}`),
    ),
    MARGIN_EARNED: reading(
      'MARGIN_EARNED',
      acceptedCents > 0 && acceptedCents >= liveCents && margin > 0 ? 'REACHED' : acceptedCents > 0 ? 'PARTIAL' : 'NOT_REACHED',
      margin,
      acceptedCents === 0
        ? ['Nothing is accepted, so nothing is earned.']
        : [`Accepted ${acceptedCents} less costs ${costs}, owed ${unpaid}, owed back ${receivedBeyondAgreedCents} leaves ${margin}.`],
      [...idsOf(entries, 'COST', 'UNPAID_COMMITMENT'), ...accepted.map((o) => `acceptance:${o.agreement.id}`)],
    ),
    CASH_AVAILABLE: reading(
      'CASH_AVAILABLE',
      cash > 0 ? 'REACHED' : settled > 0 ? 'PARTIAL' : 'NOT_REACHED',
      Math.max(0, cash),
      ['No settled funds remain after refunds and costs paid.'],
      idsOf(entries, 'SETTLEMENT', 'REFUND', 'COST'),
    ),
  };

  const declared: CommitmentTransition[] = (input.declared ?? []).map((d) => ({
    id: d.id,
    kind: d.kind,
    duty: { holder: d.holder ?? null, action: d.action },
    deadline: d.deadline ?? null,
    terms: d.terms ?? [],
    evidence: d.evidence ?? [],
    outcome: d.outcome ?? 'PENDING',
    outcomeDetail: d.outcomeDetail ?? null,
    at: d.at ?? null,
    amountCents: d.amountCents ?? null,
    stage: d.stage ?? null,
    parties: d.parties ?? [],
    branchOf: d.branchOf ?? null,
    restartOf: d.restartOf ?? null,
    milestone: d.milestone ?? null,
  }));
  const rowIds = new Set<string>();
  const transitions = [
    ...input.obligations.flatMap(obligationTransitions),
    ...ledgerTransitions(entries),
    ...declared,
  ]
    // A declared step never overrides a row of the same id.
    .filter((t) => (rowIds.has(t.id) ? false : (rowIds.add(t.id), true)))
    .sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999') || a.id.localeCompare(b.id));

  const overdue = transitions
    .filter((t) => t.deadline !== null && t.deadline < input.now && (t.outcome === 'PENDING' || t.outcome === 'UNKNOWN'))
    .map((t) => t.id);

  return {
    opportunityId: input.opportunityId,
    currency: input.currency,
    stages,
    transitions,
    parties: uniqueParties(transitions),
    dependencies: input.dependencies ?? [],
    owedToSuppliers: owed.filter((o) => o.owedCents > 0 || o.overpaidCents > 0),
    owedToCustomers: {
      totalCents: unconfirmedRefundCents + receivedBeyondAgreedCents,
      unconfirmedRefundCents,
      receivedBeyondAgreedCents,
    },
    otherCurrencies,
    nextStage: COMMITMENT_STAGES.find((s) => stages[s].state !== 'REACHED') ?? null,
    overdue,
  };
}

/** Read the rows for one opportunity and derive. Writes nothing. */
export async function readCommitments(input: {
  projectId: string;
  opportunityId: string;
  currency: string;
  declared?: DeclaredTransition[];
  dependencies?: ExternalDependency[];
  now?: string;
}): Promise<CommitmentReading> {
  const [obligations, entries] = await Promise.all([
    readObligations(input.opportunityId),
    listMoneyEntries({ projectId: input.projectId, opportunityId: input.opportunityId, limit: 2000 }),
  ]);
  return deriveCommitments({
    opportunityId: input.opportunityId,
    currency: input.currency,
    obligations,
    entries,
    declared: input.declared,
    dependencies: input.dependencies,
    now: input.now ?? new Date().toISOString(),
  });
}
