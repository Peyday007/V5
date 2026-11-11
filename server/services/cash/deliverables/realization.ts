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

/* ---------------------------------------------------------------------------
 * The running Brain: realization read from rows, on the journey tick
 * ------------------------------------------------------------------------ */

/**
 * Everything above is a derivation; this is where the running Brain consumes it.
 *
 *   * `realizationInputsFromRows` turns one deal's rows into the derivation's
 *     inputs. The scope is each live agreement's stated deliverable; the
 *     fulfiller is the obligation's declared performer (`journey/fulfillment.ts`
 *     `declare`) — a Brain capability for SOFTWARE and RESEARCH, read live from
 *     `capabilities.ts`, the named supplier for SUPPLIER, the named person for
 *     PERSON, whose responsibility stays with them. A performer whose name is the
 *     deal's payer is the buyer named as fulfiller, and is refused. Deliveries and
 *     acceptances are the obligation's own `DELIVERED` / `ACCEPTED` / `REJECTED`
 *     events with their evidence and times; the accounting is the deal's position
 *     (`journey/position.ts`), the same figures every surface reads.
 *   * `recordRealization` (called by the journey tick) appends the reading to
 *     `cash_events` as `realization.read` whenever it differs from the last one on
 *     record, and appends each repeat-business signal the rows show as
 *     `aftercare.recorded` once, keyed by the rows that show it.
 *   * `recordAftercareEvent` is the write path for a relationship a person or an
 *     adapter states (a satisfaction rating, a renewal, a referral), validated by
 *     `recordAftercare` and appended to the same event kind.
 *   * `repeatBusinessObservations` is what deal construction (`construct.ts`)
 *     reads: every stated value of repeat business, as an `Observation` about the
 *     payer it was with, so a buyer who came back is evidence about what that
 *     buyer pays — never an assumption that any other buyer will.
 *
 * No new table, scheduler or authority: the rows are the obligation, the ledger
 * and `cash_events`, and the tick that writes them is the existing journey tick.
 */

export const REALIZATION_EVENT = 'realization.read';
export const AFTERCARE_EVENT = 'aftercare.recorded';

/** The capability a declared fulfilment kind asks Brain to hold; none for a person or a supplier. */
export const KIND_CAPABILITY: Readonly<Record<string, string | null>> = {
  SOFTWARE: 'BUILD_SOFTWARE',
  RESEARCH: 'RESEARCH_A_QUESTION',
  PERSON: null,
  SUPPLIER: null,
};

const normName = (text: string | null | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** One live agreement and what its obligation's rows say, as the derivation reads it. Pure. */
export interface RowObligation {
  agreementId: string;
  deliverable: string;
  agreementState: string;
  fulfillment: { kind: string; performer: string; supplierName: string | null } | null;
  events: { kind: string; evidenceRef: string | null; detail: string; createdAt: string }[];
}

export interface RealizationInputs {
  scope: ScopeItem[];
  parties: Party[];
  deliveries: DeliveryRecord[];
  acceptances: AcceptanceRecord[];
  redos: RedoObligation[];
  buyerId: string;
}

/** Build the derivation's inputs from one deal's rows. Pure, so it is tested without a database. */
export function realizationInputsFromRows(input: { opportunityId: string; payer: string | null; obligations: RowObligation[] }): RealizationInputs {
  const buyerId = `buyer:${input.opportunityId}`;
  const buyer: Party = { id: buyerId, name: input.payer?.trim() || 'the buyer', role: 'BUYER', canPerform: [] };
  const parties: Party[] = [buyer];
  const scope: ScopeItem[] = [];
  const deliveries: DeliveryRecord[] = [];
  const acceptances: AcceptanceRecord[] = [];
  for (const o of input.obligations) {
    if (o.agreementState !== 'AGREED') continue; // a released agreement promises nothing any more
    const item: ScopeItem = { key: o.agreementId, promise: o.deliverable };
    const f = o.fulfillment;
    if (f) {
      const capability = KIND_CAPABILITY[f.kind] ?? null;
      if (capability) item.capabilityId = capability;
      const performer = (f.kind === 'SUPPLIER' ? f.supplierName || f.performer : f.performer).trim();
      const isBuyer = !!input.payer && normName(performer) !== '' && normName(performer) === normName(input.payer);
      if (isBuyer) buyer.canPerform!.push(o.agreementId);
      else if (f.kind === 'SUPPLIER') parties.push({ id: `supplier:${o.agreementId}`, name: performer, role: 'SUPPLIER', canPerform: [o.agreementId] });
      else if (f.kind === 'PERSON') {
        // A person was stated as performing it: the responsibility is theirs and stays theirs.
        item.accountable = true;
        parties.push({ id: `person:${o.agreementId}`, name: performer, role: 'PERSON', canPerform: [o.agreementId] });
      }
    }
    scope.push(item);
    for (const e of o.events) {
      if (e.kind === 'DELIVERED') deliveries.push({ stepKey: o.agreementId, deliveredAt: e.createdAt, evidence: e.evidenceRef ?? '' });
      else if (e.kind === 'ACCEPTED' || e.kind === 'REJECTED') {
        acceptances.push({ stepKey: o.agreementId, outcome: e.kind, at: e.createdAt, evidence: e.evidenceRef ?? (e.kind === 'REJECTED' ? e.detail : ''), reason: e.kind === 'REJECTED' ? e.detail : undefined });
      }
    }
  }
  return { scope, parties, deliveries, acceptances, redos: [], buyerId };
}

/** What `realization.read` stores, and what the probe recomputes and compares. */
export interface StoredRealization {
  fingerprint: string;
  buyerId: string;
  scopeKeys: string[];
  plan: DeliveryPlan;
  reading: RealizationReading;
  /** The position's own contribution: the truthful accounting result every surface reads. */
  positionContributionCents: number | null;
  aftercare: { evidence: number; repeatPartyIds: string[]; statedRepeatValueCents: number | null };
}

async function fingerprintOf(value: unknown): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

/** Read one deal's realization from its rows, now. Writes nothing. */
export async function readDealRealization(input: { projectId: string; opportunityId: string; currency: string }): Promise<StoredRealization | null> {
  const { getOpportunity } = await import('../../../repos/cashPortfolio.ts');
  const { agreementsFor } = await import('../../../repos/cashJourney.ts');
  const { fulfillmentForAgreement, fulfillmentEvents } = await import('../../../repos/cashFulfillment.ts');
  const { dealPosition } = await import('../journey/position.ts');
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) return null;
  const obligations: RowObligation[] = [];
  for (const agreement of await agreementsFor(opportunity.id)) {
    if (agreement.currency !== input.currency) continue;
    const fulfillment = await fulfillmentForAgreement(agreement.id);
    const events = fulfillment ? await fulfillmentEvents(fulfillment.id) : [];
    obligations.push({
      agreementId: agreement.id,
      deliverable: agreement.deliverable,
      agreementState: agreement.state,
      fulfillment: fulfillment ? { kind: fulfillment.kind, performer: fulfillment.performer, supplierName: fulfillment.supplierName } : null,
      events: events.map((e) => ({ kind: e.kind, evidenceRef: e.evidenceRef, detail: e.detail, createdAt: e.createdAt })),
    });
  }
  const inputs = realizationInputsFromRows({ opportunityId: opportunity.id, payer: opportunity.payer, obligations });
  const plan = deriveDeliveryPlan({ scope: inputs.scope, parties: inputs.parties, readings: await readScopeCapabilities(inputs.scope) });
  const position = await dealPosition({ opportunity, currency: input.currency });
  const reading = readRealization({
    plan,
    deliveries: inputs.deliveries,
    acceptances: inputs.acceptances,
    redos: inputs.redos,
    accounting: {
      billedCents: position.pnl.invoicedCents,
      receivedCents: position.pnl.customerPaymentsCents,
      refundedCents: position.pnl.refundsCents,
      costCents: position.pnl.incrementalCostsCents + position.pnl.unpaidCommitmentsCents,
    },
  });
  const aftercare = recordAftercare(await aftercareRecordsFor(input.projectId, opportunity.id));
  const body = {
    buyerId: inputs.buyerId,
    scopeKeys: inputs.scope.map((s) => s.key),
    plan,
    reading,
    positionContributionCents: position.pnl.contributionCents,
    aftercare: { evidence: aftercare.evidence.length, repeatPartyIds: aftercare.repeatPartyIds, statedRepeatValueCents: aftercare.statedRepeatValueCents },
  };
  return { fingerprint: await fingerprintOf(body), ...body };
}

interface StoredAftercare extends AftercareRecord {
  recordKey: string;
  payer: string | null;
}

/** The aftercare records on file for one deal, as `recordAftercare` reads them. */
async function aftercareRecordsFor(projectId: string, opportunityId: string): Promise<AftercareRecord[]> {
  const { cashEventsOfKind } = await import('../../../repos/cashMode.ts');
  return (await cashEventsOfKind(opportunityId, AFTERCARE_EVENT))
    .filter((e) => e.projectId === projectId)
    .map((e) => e.detail as unknown as StoredAftercare)
    .filter((d) => d && typeof d.kind === 'string');
}

/**
 * Repeat business the rows themselves show: a later agreement with the payer of
 * a deal whose delivery that payer accepted. The new agreement's amount is the
 * stated value, and its own evidence is the evidence. Nothing else is inferred —
 * satisfaction, referrals and the rest are stated through `recordAftercareEvent`.
 */
export function repeatSignalsFromRows(input: {
  deal: { opportunityId: string; payer: string | null; acceptedAt: string | null };
  laterAgreements: { id: string; opportunityId: string; payer: string | null; amountCents: number; evidenceRef: string; createdAt: string; state: string }[];
}): StoredAftercare[] {
  const { deal } = input;
  if (!deal.acceptedAt || !normName(deal.payer)) return [];
  return input.laterAgreements
    .filter((a) => a.opportunityId !== deal.opportunityId && a.state === 'AGREED' && normName(a.payer) === normName(deal.payer) && a.createdAt > deal.acceptedAt!)
    .map((a) => ({
      recordKey: `repeat:${deal.opportunityId}:${a.id}`,
      kind: 'FOLLOW_UP_REQUEST' as const,
      partyId: `payer:${normName(deal.payer)}`,
      payer: deal.payer,
      at: a.createdAt,
      evidence: `agreement ${a.id} (${a.evidenceRef}) with the same payer after delivery was accepted`,
      valueCents: a.amountCents,
      detail: `a further agreement on opportunity ${a.opportunityId}`,
    }));
}

/**
 * Record an aftercare relationship a person or an adapter states. Validated by
 * `recordAftercare`; a refused record is returned as refused and nothing is
 * written. Idempotent by `recordKey`.
 */
export async function recordAftercareEvent(input: {
  projectId: string;
  opportunityId: string;
  record: AftercareRecord;
  recordKey: string;
  actorRef: string;
}): Promise<{ ok: true; created: boolean } | { ok: false; reason: string }> {
  const { getOpportunity } = await import('../../../repos/cashPortfolio.ts');
  const { cashEventsOfKind, recordCashEvent } = await import('../../../repos/cashMode.ts');
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) return { ok: false, reason: 'No opportunity with that id.' };
  if (!input.recordKey.trim()) return { ok: false, reason: 'An aftercare record needs a key, so a retry is the same record.' };
  const checked = recordAftercare([input.record]);
  if (checked.refused.length > 0) return { ok: false, reason: checked.refused.join('; ') };
  const existing = await cashEventsOfKind(opportunity.id, AFTERCARE_EVENT);
  if (existing.some((e) => (e.detail as { recordKey?: unknown } | null)?.recordKey === input.recordKey)) return { ok: true, created: false };
  const stored: StoredAftercare = { ...input.record, recordKey: input.recordKey, payer: opportunity.payer };
  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    kind: AFTERCARE_EVENT,
    actorRef: input.actorRef,
    summary: `${input.record.kind.toLowerCase().replace(/_/g, ' ')}: ${input.record.evidence}`.slice(0, 300),
    detail: stored as unknown as Record<string, unknown>,
  });
  return { ok: true, created: true };
}

/**
 * The journey tick's consumer of LIFE-29-2, for one deal with an agreement:
 * record repeat-business signals the rows show (once each), then append the
 * realization reading when it differs from the last one on record.
 */
export async function recordRealization(input: { projectId: string; opportunityId: string; currency: string }): Promise<{ recorded: boolean; aftercare: number }> {
  const { getOpportunity } = await import('../../../repos/cashPortfolio.ts');
  const { agreementsInProject } = await import('../../../repos/cashJourney.ts');
  const { fulfillmentForAgreement, fulfillmentEvents } = await import('../../../repos/cashFulfillment.ts');
  const { cashEventsOfKind, recordCashEvent } = await import('../../../repos/cashMode.ts');
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity || opportunity.projectId !== input.projectId) return { recorded: false, aftercare: 0 };

  // When this deal's buyer accepted a delivery: the earliest ACCEPTED event on any of its obligations.
  const all = await agreementsInProject(input.projectId);
  let acceptedAt: string | null = null;
  for (const agreement of all.filter((a) => a.opportunityId === opportunity.id)) {
    const f = await fulfillmentForAgreement(agreement.id);
    for (const e of f ? await fulfillmentEvents(f.id) : []) {
      if (e.kind === 'ACCEPTED' && (!acceptedAt || e.createdAt < acceptedAt)) acceptedAt = e.createdAt;
    }
  }
  let aftercare = 0;
  if (acceptedAt) {
    const payers = new Map<string, string | null>();
    for (const a of all) if (!payers.has(a.opportunityId)) payers.set(a.opportunityId, (await getOpportunity(a.opportunityId))?.payer ?? null);
    const signals = repeatSignalsFromRows({
      deal: { opportunityId: opportunity.id, payer: opportunity.payer, acceptedAt },
      laterAgreements: all.map((a) => ({ id: a.id, opportunityId: a.opportunityId, payer: payers.get(a.opportunityId) ?? null, amountCents: a.amountCents, evidenceRef: a.evidenceRef, createdAt: a.createdAt, state: a.state })),
    });
    for (const s of signals) {
      const { recordKey, payer: _payer, ...record } = s;
      const done = await recordAftercareEvent({ projectId: input.projectId, opportunityId: opportunity.id, record, recordKey, actorRef: 'BRAIN' });
      if (done.ok && done.created) aftercare += 1;
    }
  }

  const reading = await readDealRealization(input);
  if (!reading) return { recorded: false, aftercare };
  const last = (await cashEventsOfKind(opportunity.id, REALIZATION_EVENT)).at(-1);
  if ((last?.detail as { fingerprint?: unknown } | null)?.fingerprint === reading.fingerprint) return { recorded: false, aftercare };
  const r = reading.reading;
  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: opportunity.id,
    kind: REALIZATION_EVENT,
    actorRef: 'BRAIN',
    summary:
      `${reading.plan.steps.length} delivery step(s) from the scope (${reading.plan.unassigned.length} unassigned, ${reading.plan.refused.length} refused); ` +
      `${r.delivered.length} delivered, ${r.accepted.length} accepted, ${r.redoObligations.filter((x) => x.open).length} redo open; ` +
      (r.realized ? 'realized.' : 'not realized.'),
    detail: reading as unknown as Record<string, unknown>,
  });
  return { recorded: true, aftercare };
}

/**
 * What deal construction reads: every aftercare record that states a value of
 * repeat business, as an observation about the payer it was with. A payer with
 * none is unknown, never a buyer who will not return.
 */
export async function repeatBusinessObservations(projectId: string, currency: string): Promise<import('../../../domain/quant.ts').Observation[]> {
  const { cashEventsOfKindInProject } = await import('../../../repos/cashMode.ts');
  const events = await cashEventsOfKindInProject(projectId, AFTERCARE_EVENT);
  const out: import('../../../domain/quant.ts').Observation[] = [];
  for (const e of events) {
    const d = e.detail as unknown as StoredAftercare | null;
    if (!d || !REPEAT_KINDS.has(d.kind) || !validCents(d.valueCents) || d.valueCents === 0 || !normName(d.payer)) continue;
    if (recordAftercare([d]).refused.length > 0) continue;
    out.push({
      id: `aftercare:${e.id}`,
      value: { kind: 'POINT', value: d.valueCents / 100 },
      context: { payer: normName(d.payer), arrangement: 'repeat' },
      lineage: [`cash_event:${e.id}`],
      observedAt: e.createdAt,
      source: { kind: 'CASH_OPPORTUNITY', ref: e.opportunityId ?? e.id },
      measures: `repeat business (${d.kind.toLowerCase().replace(/_/g, ' ')}) stated with this payer${currency ? ` in ${currency}` : ''}`,
    });
  }
  return out;
}
