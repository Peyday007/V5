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
 * Nothing here stores, schedules or authorizes: it is a pure derivation over
 * inputs the callers already hold, so it adds no store or authority path.
 * Unknown stays unknown (invariant 39): an unstated fact is named, never
 * assumed favourably, and nothing here names an industry or a category.
 */
import { readCapabilities, type CapabilityState } from '../capabilities.ts';

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
