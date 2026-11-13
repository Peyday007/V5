/**
 * One sourced transaction, read end to end (CP-31).
 *
 * Composes the three counterparty modules — the ladder (`ladder.ts`), the
 * comparison (`compare.ts`) and the reservations (`reservations.ts`) — into the
 * single reading a person or the operator asks for: who would fulfil this, who
 * would take over, what is verified and what is still pending, how they compare
 * on cost, capacity and timing, whether a reserve may be made with the
 * authority held, what happens when the primary fails, and whether the sale is
 * deliverable at all.
 *
 * `readTransaction` is pure: a function over a snapshot that writes nothing,
 * schedules nothing and holds no authority of its own. The recorded entry
 * points at the foot of this file are its caller on real rows: they read the
 * counterparties' recorded facts and every business's recorded reservations,
 * and `reserveRecordedTransaction` / `transferRecordedTransaction` re-run the
 * whole reading under every candidate's capacity lock (`decideRecorded`) and
 * append exactly the events it proposed — so the commitment-level guard (no
 * second live hold on one commitment) and the capacity guard (no double-booking
 * across businesses) are both decided on a snapshot nobody else can change
 * before the rows land. Authority is the existing owner's: the reading carries
 * an `AuthorityReading`, and the recorded entry points make it themselves with
 * `authorityFor` — the business's live commercial grant, read under the lock —
 * and accept none from their caller.
 *
 * Rules this reading keeps:
 *
 *   * A sale is deliverable only when the fulfiller now carrying it has reached
 *     CONTRACTED on the ladder (or PERFORMED) and its hold is live. A listing, a
 *     willingness, a capability or a quote is never reported as deliverable, and
 *     neither is a reservation without a contract.
 *   * A reserve is proposed only for a fulfiller that has at least quoted, only
 *     against verified capacity, only with every required authority held, and
 *     never while another live hold already carries the commitment.
 *   * A transfer is planned only after a reported FAILED on the primary hold,
 *     to the best eligible candidate that is not the failed one and has at
 *     least quoted — the same quote gate a first reserve passes — releasing the
 *     primary in the same plan. A hold with no report stays UNKNOWN.
 *
 * Nothing here enumerates a kind of counterparty, an industry or a geography.
 */
import { compareFulfillers, type CandidateReading, type Commitment, type Comparison, type Figure, type FigureName } from './compare.ts';
import { effectiveStatus, recordedCounterparty, STAGES, stageIndex, type Counterparty, type Fact, type MissingFact, type Stage } from './ladder.ts';
import { checkCommercialAuthority, type CommercialAction } from '../../cash/authority.ts';
import {
  authorityFor,
  decideRecorded,
  doubleCommitted,
  holdsFrom,
  performanceFacts,
  performanceFrom,
  planTransfer,
  remainingCapacity,
  recordedReservationEvents,
  reserve,
  RESERVE_ACTION,
  type AuthorityReading,
  type Hold,
  type ReservationEvent,
  type TransferPlan,
} from './reservations.ts';

export interface TransactionInput {
  commitment: Commitment;
  /** Every counterparty considered, wherever they operate. */
  candidates: readonly Counterparty[];
  /** The recorded reservation events across ALL businesses, so capacity is never double-booked. */
  events: readonly ReservationEvent[];
  businessId: string;
  window: { windowStart: string; windowEnd: string };
  /**
   * The authority owner's reading for this business (`authorityFor`). The
   * recorded entry points below make it from the live grant; a pure reading is
   * judged with whatever reading it is handed, and writes nothing.
   */
  authority: AuthorityReading;
  /** ISO-8601 UTC for any event this reading proposes. */
  at: string;
  /** Where the transaction came from (an opening, a buyer's request). Carried, never interpreted. */
  source?: string | null;
}

export interface FactLedger {
  counterpartyId: string;
  /** Dimensions VERIFIED with evidence (or NOT_APPLICABLE with a reason). */
  verified: string[];
  /** What is still missing for the next stages, as tasks. Unknown is never favourable. */
  pending: MissingFact[];
}

export interface ComparedRow {
  counterpartyId: string;
  stage: Stage | null;
  eligible: boolean;
  figures: Record<FigureName, Pick<Figure, 'value' | 'claimed' | 'status'>>;
  reasons: string[];
}

export type ReserveReading =
  | { permitted: true; duplicate: boolean; counterpartyId: string; event: ReservationEvent | null }
  | {
      permitted: false;
      counterpartyId: string | null;
      reason: 'NO_FULFILLER' | 'NOT_QUOTED' | 'ALREADY_HELD' | 'MISSING_AUTHORITY' | 'CAPACITY_UNKNOWN' | 'CAPACITY' | 'INVALID' | 'KEY_CONFLICT';
      /** The authority still needed, named exactly, when that is the reason. */
      missingAuthority: string[];
      detail: string;
    };

export interface TransferReading {
  /** True only when the primary hold is reported FAILED. */
  applicable: boolean;
  from: string | null;
  to: string | null;
  plan: TransferPlan | null;
  detail: string;
}

export interface Deliverability {
  deliverable: boolean;
  /** The fulfiller the sale currently rests on, if any. */
  counterpartyId: string | null;
  stage: Stage | null;
  holdState: Hold['state'] | null;
  reason: string;
}

export interface TransactionReading {
  commitmentId: string;
  source: string | null;
  comparison: Comparison;
  primary: CandidateReading | null;
  alternative: CandidateReading | null;
  facts: FactLedger[];
  compared: ComparedRow[];
  reserve: ReserveReading;
  transfer: TransferReading;
  deliverability: Deliverability;
  /** Commitments with more than one live hold, read from the events (should be empty). */
  doubleCommitted: string[];
  /** True when the commitment needs a person or a role Brain cannot be. */
  needsHumanOperator: boolean;
  /** The authority reading the reserve and transfer were judged with. */
  authority: AuthorityReading;
}

const CONTRACTED = stageIndex('CONTRACTED');
const QUOTE = stageIndex('QUOTE');

function factLedger(counterparty: Counterparty, reading: CandidateReading): FactLedger {
  const verified = new Set<string>();
  for (const fact of counterparty.facts) {
    const status = effectiveStatus(fact);
    if (status === 'VERIFIED' || status === 'NOT_APPLICABLE') verified.add(fact.dimension);
    else verified.delete(fact.dimension);
  }
  const pending = reading.ladder.stages.filter((s) => !s.reached).flatMap((s) => s.missing);
  return { counterpartyId: counterparty.id, verified: [...verified].sort(), pending };
}

function row(reading: CandidateReading): ComparedRow {
  const strip = (f: Figure) => ({ value: f.value, claimed: f.claimed, status: f.status });
  return {
    counterpartyId: reading.counterpartyId,
    stage: reading.stage,
    eligible: reading.eligible,
    figures: { cost: strip(reading.figures.cost), capacity: strip(reading.figures.capacity), timing: strip(reading.figures.timing) },
    reasons: reading.reasons,
  };
}

/** The key a reserve on this commitment with this counterparty uses: the same on every attempt. */
export function reservationKey(commitmentId: string, counterpartyId: string): string {
  return `${commitmentId}:${counterpartyId}`;
}

function commitmentHolds(events: readonly ReservationEvent[], commitmentId: string): Hold[] {
  return holdsFrom(events).filter((h) => h.commitmentId === commitmentId);
}

/**
 * The one quote gate every hold passes through, the first reserve and a
 * transfer's alike: a fulfiller that has not reached QUOTE on the ladder is not
 * given capacity, whatever its verified availableCapacity says. Null when the
 * gate passes; otherwise the sentence saying why it does not.
 */
function notQuoted(candidate: CandidateReading): string | null {
  if (stageIndex(candidate.stage) >= QUOTE) return null;
  return `${candidate.counterpartyId} has reached ${candidate.stage ?? 'no stage'}; a reserve needs a verified quote first`;
}

function readReserve(input: TransactionInput, primary: CandidateReading | null): ReserveReading {
  if (!primary) return { permitted: false, counterpartyId: null, reason: 'NO_FULFILLER', missingAuthority: [], detail: 'no eligible fulfiller to reserve' };
  const live = commitmentHolds(input.events, input.commitment.id).filter((h) => h.state === 'HELD' || h.state === 'FAILED');
  const key = reservationKey(input.commitment.id, primary.counterpartyId);
  const other = live.find((h) => h.key !== key && h.state === 'HELD');
  if (other) {
    return {
      permitted: false, counterpartyId: primary.counterpartyId, reason: 'ALREADY_HELD', missingAuthority: [],
      detail: `${other.counterpartyId} already holds this commitment; a second hold would double-commit it`,
    };
  }
  const unquoted = notQuoted(primary);
  if (unquoted) return { permitted: false, counterpartyId: primary.counterpartyId, reason: 'NOT_QUOTED', missingAuthority: [], detail: unquoted };
  const answer = reserve(input.events, {
    key,
    counterpartyId: primary.counterpartyId,
    commitmentId: input.commitment.id,
    businessId: input.businessId,
    units: input.commitment.capacityUnits,
    windowStart: input.window.windowStart,
    windowEnd: input.window.windowEnd,
    capacityUnits: primary.figures.capacity.value,
    at: input.at,
  }, input.authority);
  if (answer.ok) return { permitted: true, duplicate: answer.duplicate, counterpartyId: primary.counterpartyId, event: answer.event };
  switch (answer.reason) {
    case 'MISSING_AUTHORITY':
      return {
        permitted: false, counterpartyId: primary.counterpartyId, reason: 'MISSING_AUTHORITY', missingAuthority: answer.missing,
        detail: `not reserved: the live commercial authority does not cover ${answer.missing.join(', ')} (${answer.detail})`,
      };
    case 'CAPACITY_UNKNOWN':
      return { permitted: false, counterpartyId: primary.counterpartyId, reason: 'CAPACITY_UNKNOWN', missingAuthority: [], detail: 'capacity is not verified, so nothing can be reserved against it' };
    case 'CAPACITY':
      return { permitted: false, counterpartyId: primary.counterpartyId, reason: 'CAPACITY', missingAuthority: [], detail: `only ${answer.remaining} unit(s) remain in the window across every business` };
    default:
      return { permitted: false, counterpartyId: primary.counterpartyId, reason: answer.reason, missingAuthority: [], detail: answer.detail };
  }
}

function readTransfer(input: TransactionInput, comparison: Comparison): TransferReading {
  const holds = commitmentHolds(input.events, input.commitment.id);
  const failed = holds.find((h) => h.state === 'FAILED');
  if (!failed) {
    const held = holds.find((h) => h.state === 'HELD');
    return {
      applicable: false, from: held?.counterpartyId ?? null, to: null, plan: null,
      detail: held
        ? `${held.counterpartyId} holds the commitment and has not reported a failure; nothing is transferred`
        : 'no hold carries the commitment yet',
    };
  }
  const others = comparison.ranked.filter((r) => r.counterpartyId !== failed.counterpartyId);
  if (others.length === 0) return { applicable: true, from: failed.counterpartyId, to: null, plan: null, detail: 'the primary failed and no eligible alternative remains' };
  // The transfer reserves the alternative, so it passes the same quote gate the first reserve does.
  const to = others.find((r) => notQuoted(r) === null) ?? null;
  if (!to) {
    const best = others[0]!;
    const detail = notQuoted(best)!;
    return {
      applicable: true, from: failed.counterpartyId, to: null,
      plan: { action: 'REFUSED', reason: 'NOT_QUOTED', detail: `no alternative has quoted: ${detail}` },
      detail: `the primary failed and no alternative has quoted, so nothing is transferred: ${detail}`,
    };
  }
  const plan = planTransfer(input.events, {
    primaryKey: failed.key,
    alternativeKey: reservationKey(input.commitment.id, to.counterpartyId),
    alternativeCounterpartyId: to.counterpartyId,
    alternativeCapacityUnits: to.figures.capacity.value,
    at: input.at,
  }, input.authority);
  const detail = plan.action === 'TRANSFER'
    ? `${failed.counterpartyId} reported a failure: release it and hold ${to.counterpartyId} for the same units and window`
    : plan.action === 'UNKNOWN' ? plan.detail : `transfer to ${to.counterpartyId} refused: ${plan.detail}`;
  return { applicable: true, from: failed.counterpartyId, to: to.counterpartyId, plan, detail };
}

function readDeliverability(input: TransactionInput, readings: Map<string, CandidateReading>, primary: CandidateReading | null): Deliverability {
  const holds = commitmentHolds(input.events, input.commitment.id);
  const live = holds.find((h) => h.state === 'HELD') ?? holds.find((h) => h.state === 'PERFORMED');
  const failed = holds.find((h) => h.state === 'FAILED');
  if (!live) {
    const who = failed ?? null;
    const on = primary;
    return {
      deliverable: false,
      counterpartyId: who?.counterpartyId ?? on?.counterpartyId ?? null,
      stage: who ? readings.get(who.counterpartyId)?.stage ?? null : on?.stage ?? null,
      holdState: who?.state ?? null,
      reason: who
        ? `${who.counterpartyId} failed and no other fulfiller holds the commitment; the sale is not deliverable`
        : on
          ? `no fulfiller holds the commitment; ${on.counterpartyId} has reached ${on.stage ?? 'no stage'}, which is not a contract`
          : 'no eligible fulfiller exists',
    };
  }
  const stage = readings.get(live.counterpartyId)?.stage ?? null;
  const contracted = stageIndex(stage) >= CONTRACTED;
  return {
    deliverable: contracted,
    counterpartyId: live.counterpartyId,
    stage,
    holdState: live.state,
    reason: contracted
      ? `${live.counterpartyId} holds the commitment under a verified contract (${stage})`
      : `${live.counterpartyId} holds capacity but has reached ${stage ?? 'no stage'}; until it is ${STAGES[CONTRACTED]} the sale is not deliverable`,
  };
}

export function readTransaction(input: TransactionInput): TransactionReading {
  // What the recorded outcomes say about each candidate is part of the reading:
  // a counterparty that failed before ranks below an equal one that performed.
  const candidates = input.candidates.map((c) => withPerformance(c, input.events, input.at));
  const comparison = compareFulfillers(input.commitment, candidates);
  const all = [...comparison.ranked, ...comparison.ineligible];
  const readings = new Map(all.map((r) => [r.counterpartyId, r]));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const facts: FactLedger[] = [];
  for (const one of [comparison.primary, comparison.alternative]) {
    const party = one ? byId.get(one.counterpartyId) : undefined;
    if (one && party) facts.push(factLedger(party, one));
  }
  return {
    commitmentId: input.commitment.id,
    source: input.source ?? null,
    comparison,
    primary: comparison.primary,
    alternative: comparison.alternative,
    facts,
    compared: all.map(row),
    reserve: readReserve(input, comparison.primary),
    transfer: readTransfer(input, comparison),
    deliverability: readDeliverability(input, readings, comparison.primary),
    doubleCommitted: doubleCommitted(input.events),
    needsHumanOperator: comparison.needsHumanOperator,
    authority: input.authority,
  };
}

// ---------------------------------------------------------------------------
// Learning, negotiation, coordination and workforce planning (CP-31)
// ---------------------------------------------------------------------------

/**
 * The counterparty with its performance read from the recorded outcomes
 * ("learn which counterparties actually perform"). Verified outcomes replace
 * whatever the caller carried for `performanceHistory` and `reliability`,
 * because the events are the record. With no reported outcome the caller's own
 * facts stand, and if there are none the dimensions are added as UNKNOWN: a
 * task, never a favourable default.
 */
export function withPerformance(counterparty: Counterparty, events: readonly ReservationEvent[], asOf: string): Counterparty {
  const reading = performanceFrom(events, counterparty.id, asOf);
  const facts = performanceFacts(reading);
  if (reading.reliability !== null) return { ...counterparty, facts: [...counterparty.facts, ...facts] };
  const has = new Set(counterparty.facts.map((f) => f.dimension));
  const missing = facts.filter((f) => !has.has(f.dimension));
  return missing.length === 0 ? counterparty : { ...counterparty, facts: [...counterparty.facts, ...missing] };
}

/** Terms a person authorized for a negotiation. Brain never moves outside them. */
export interface AuthorizedTerms {
  /** The most Brain may agree to pay per commitment. */
  priceCeiling: number;
  /** The longest lead time acceptable, when one was set. */
  maxLeadTime?: number | null;
  /** Payment terms acceptable, when restricted; absent means any. */
  paymentTerms?: readonly string[] | null;
  /**
   * The authority owner's reading for the business accepting (`authorityFor`,
   * `ENGAGE_CONTRACTOR`): a binding acceptance commits the counterparty.
   */
  authority: AuthorityReading;
}

export type NegotiationStep =
  | { action: 'ACCEPT'; price: number; detail: string }
  | { action: 'COUNTER'; price: number; detail: string }
  | { action: 'DECLINE'; detail: string }
  | { action: 'NEEDS_QUOTE'; missing: MissingFact[]; detail: string }
  | { action: 'MISSING_AUTHORITY'; missingAuthority: string[]; detail: string };

/**
 * The next move on a counterparty's quote within the authorized terms
 * ("negotiate authorized terms"). A pending price is not negotiated against; a
 * figure above the ceiling is countered at the ceiling, once, and never beyond
 * it; a lead time or payment term outside the authorized set is declined; an
 * acceptance without the authority it needs is refused, naming the authority.
 */
export function negotiate(counterparty: Counterparty, terms: AuthorizedTerms): NegotiationStep {
  const facts = counterparty.facts;
  const read = (dimension: string) => {
    const fact = facts.filter((f) => f.dimension === dimension).at(-1);
    return fact && effectiveStatus(fact) === 'VERIFIED' ? fact : null;
  };
  const price = read('price');
  const lead = read('leadTime');
  const payment = read('paymentTerms');
  const missing: MissingFact[] = [];
  if (!price || typeof price.value !== 'number') missing.push({ dimension: 'price', state: price ? 'UNKNOWN' : 'PENDING' });
  if (terms.maxLeadTime != null && (!lead || typeof lead.value !== 'number')) missing.push({ dimension: 'leadTime', state: 'PENDING' });
  if (terms.paymentTerms && terms.paymentTerms.length > 0 && !payment) missing.push({ dimension: 'paymentTerms', state: 'PENDING' });
  if (missing.length > 0) return { action: 'NEEDS_QUOTE', missing, detail: 'nothing is negotiated against a figure that is not verified' };
  if (terms.maxLeadTime != null && (lead!.value as number) > terms.maxLeadTime) {
    return { action: 'DECLINE', detail: `lead time ${String(lead!.value)} exceeds the authorized ${terms.maxLeadTime}` };
  }
  if (terms.paymentTerms && terms.paymentTerms.length > 0 && !terms.paymentTerms.includes(String(payment!.value))) {
    return { action: 'DECLINE', detail: `payment terms ${String(payment!.value)} are not among the authorized terms` };
  }
  const quoted = price!.value as number;
  if (quoted <= terms.priceCeiling) {
    if (!terms.authority.held) {
      return { action: 'MISSING_AUTHORITY', missingAuthority: [terms.authority.action], detail: `accepting ${quoted} needs ${terms.authority.action}: ${terms.authority.reason}` };
    }
    return { action: 'ACCEPT', price: quoted, detail: `${quoted} is within the authorized ceiling ${terms.priceCeiling}` };
  }
  return { action: 'COUNTER', price: terms.priceCeiling, detail: `${quoted} exceeds the authorized ceiling; counter at ${terms.priceCeiling}, never above it` };
}

/** One step of a project a commitment is delivered through. */
export interface ProjectStep {
  id: string;
  /** Steps that must be complete first. */
  dependsOn: readonly string[];
  /** The reservation key that carries this step, once one is held. */
  holdKey?: string | null;
}

export type StepState = 'WAITING' | 'READY' | 'IN_PROGRESS' | 'DONE' | 'FAILED' | 'UNKNOWN';

export interface StepReading {
  id: string;
  state: StepState;
  counterpartyId: string | null;
  detail: string;
}

/**
 * Where each project step stands, read from the reservation events
 * ("coordinate project steps … check completion"). A step is DONE only on a
 * recorded PERFORMED report for its hold — never because its window passed. A
 * hold past its window with no report is UNKNOWN (invariant 26), and its
 * dependants wait rather than assume it finished.
 */
export function coordinateSteps(steps: readonly ProjectStep[], events: readonly ReservationEvent[], asOf: string): StepReading[] {
  const holds = new Map(holdsFrom(events).map((h) => [h.key, h]));
  const own = new Map<string, StepReading>();
  for (const step of steps) {
    const hold = step.holdKey ? holds.get(step.holdKey) : undefined;
    if (!hold) { own.set(step.id, { id: step.id, state: 'READY', counterpartyId: null, detail: 'no fulfiller holds this step' }); continue; }
    const who = hold.counterpartyId;
    if (hold.state === 'PERFORMED') own.set(step.id, { id: step.id, state: 'DONE', counterpartyId: who, detail: `${who} reported it performed` });
    else if (hold.state === 'FAILED') own.set(step.id, { id: step.id, state: 'FAILED', counterpartyId: who, detail: `${who} reported a failure; transfer it` });
    else if (hold.state === 'RELEASED') own.set(step.id, { id: step.id, state: 'READY', counterpartyId: null, detail: `${who} released it; nobody holds it now` });
    else if (hold.windowEnd <= asOf) own.set(step.id, { id: step.id, state: 'UNKNOWN', counterpartyId: who, detail: `${who}'s window ended with no report; ask, do not assume` });
    else own.set(step.id, { id: step.id, state: 'IN_PROGRESS', counterpartyId: who, detail: `${who} holds it` });
  }
  return steps.map((step) => {
    const reading = own.get(step.id)!;
    const blocking = step.dependsOn.filter((d) => own.get(d)?.state !== 'DONE');
    if (blocking.length > 0 && (reading.state === 'READY' || reading.state === 'IN_PROGRESS')) {
      return { ...reading, state: 'WAITING' as const, detail: `waits on ${blocking.join(', ')} being performed` };
    }
    return reading;
  });
}

/** A commitment's need, for workforce planning across businesses. */
export interface WorkforceDemand {
  commitment: Commitment;
  businessId: string;
  window: { windowStart: string; windowEnd: string };
}

export interface WorkforceLine {
  commitmentId: string;
  businessId: string;
  /** Eligible counterparties, of any kind, with verified free capacity in the window. */
  coveredBy: Array<{ counterpartyId: string; kind: string; freeUnits: number }>;
  shortfall: number;
  /**
   * Ways to close a shortfall. Full-time employment is one option among
   * several and never a prerequisite: a hire is listed only beside sourcing.
   */
  options: Array<'SOURCE_COUNTERPARTY' | 'EXTEND_PARTNER_NETWORK' | 'PREPARE_HIRE'>;
  /** What a hiring process or a sourcing search would need to state, from the commitment. */
  roleBrief: { capacityUnits: number; geographies: readonly string[]; humanRequirement: Commitment['humanRequirement'] | null } | null;
  /** Counterparties of any kind with a verified reliability below one half, for performance management. */
  underperformers: string[];
}

/**
 * Workforce planning over every business at once ("support workforce
 * planning, hiring-process preparation, performance management and partner
 * networks"). Capacity is read from the shared reservation events, so a unit
 * free for one business is not counted again for another. Kinds are the
 * caller's words; employees are one kind among the rest.
 */
export function planWorkforce(demands: readonly WorkforceDemand[], candidates: readonly Counterparty[], events: readonly ReservationEvent[], asOf: string): WorkforceLine[] {
  const parties = candidates.map((c) => withPerformance(c, events, asOf));
  // Units this plan has already promised, so two demands in overlapping windows never count one unit twice.
  const promised: Array<{ counterpartyId: string; windowStart: string; windowEnd: string; units: number }> = [];
  const promisedIn = (counterpartyId: string, w: { windowStart: string; windowEnd: string }) =>
    promised.filter((p) => p.counterpartyId === counterpartyId && p.windowStart < w.windowEnd && w.windowStart < p.windowEnd).reduce((n, p) => n + p.units, 0);
  return demands.map((demand) => {
    let need = demand.commitment.capacityUnits;
    const coveredBy: WorkforceLine['coveredBy'] = [];
    // Demand may be split across counterparties, so one too small for the whole of it is still eligible for a part.
    for (const reading of compareFulfillers({ ...demand.commitment, capacityUnits: 1 }, parties).ranked) {
      if (need <= 0) break;
      const total = reading.figures.capacity.value;
      if (total === null) continue;
      const free = remainingCapacity(events, reading.counterpartyId, total, demand.window).remaining - promisedIn(reading.counterpartyId, demand.window);
      if (free <= 0) continue;
      const take = Math.min(free, need);
      promised.push({ counterpartyId: reading.counterpartyId, ...demand.window, units: take });
      coveredBy.push({ counterpartyId: reading.counterpartyId, kind: reading.kind, freeUnits: take });
      need -= take;
    }
    const shortfall = Math.max(0, need);
    const underperformers = parties
      .map((p) => ({ id: p.id, r: p.facts.filter((f) => f.dimension === 'reliability').at(-1) }))
      .filter(({ r }) => r && effectiveStatus(r) === 'VERIFIED' && typeof r.value === 'number' && r.value < 0.5)
      .map(({ id }) => id)
      .sort();
    return {
      commitmentId: demand.commitment.id,
      businessId: demand.businessId,
      coveredBy,
      shortfall,
      options: shortfall > 0 ? ['SOURCE_COUNTERPARTY', 'EXTEND_PARTNER_NETWORK', 'PREPARE_HIRE'] : [],
      roleBrief: shortfall > 0
        ? { capacityUnits: shortfall, geographies: demand.commitment.geographies ?? [], humanRequirement: demand.commitment.humanRequirement ?? null }
        : null,
      underperformers,
    };
  });
}

/**
 * The model's refusals, checked on one reading. Empty when every one holds;
 * otherwise one sentence per breach: a sale reported deliverable below a
 * contract, a reserve permitted without the required authority, or a
 * commitment carried by two live holds. The provider probe and the
 * opportunity reading judge with this one function, so the guarantees cannot
 * be stated twice and drift.
 */
export function transactionBreaches(label: string, reading: TransactionReading): string[] {
  const breaches: string[] = [];
  if (reading.deliverability.deliverable && stageIndex(reading.deliverability.stage) < CONTRACTED) {
    breaches.push(`${label}: reported deliverable at ${reading.deliverability.stage ?? 'no stage'}, below CONTRACTED`);
  }
  if (reading.reserve.permitted && !reading.authority.held) {
    breaches.push(`${label}: a reserve was permitted without the live grant of ${reading.authority.action}`);
  }
  if (reading.doubleCommitted.length > 0) breaches.push(`${label}: double-committed ${reading.doubleCommitted.join(', ')}`);
  return breaches;
}

// ---------------------------------------------------------------------------
// The same reading on recorded rows
// ---------------------------------------------------------------------------

/**
 * A transaction named by its candidates' ids; their facts, every business's
 * holds and the business's live grant are read from the record. There is no
 * authority field: what is held is read, never supplied. `action` names which
 * of the owner's commercial actions commits these counterparties —
 * `ENGAGE_CONTRACTOR` unless they are providers performing an effect of their own.
 */
export type RecordedTransactionInput = Omit<TransactionInput, 'candidates' | 'events' | 'authority'> & {
  candidateIds: readonly string[];
  action?: CommercialAction;
};

async function recordedCandidates(ids: readonly string[]): Promise<Counterparty[]> {
  const out: Counterparty[] = [];
  for (const id of [...new Set(ids)]) {
    const one = await recordedCounterparty(id);
    if (one) out.push(one);
  }
  return out;
}

/** The transaction as the record stands now. Writes nothing. */
export async function readRecordedTransaction(input: RecordedTransactionInput): Promise<TransactionReading> {
  const { candidateIds, action, ...rest } = input;
  return readTransaction({
    ...rest,
    candidates: await recordedCandidates(candidateIds),
    events: await recordedReservationEvents(candidateIds),
    authority: await authorityFor(input.businessId, action ?? RESERVE_ACTION),
  });
}

/**
 * Reserve the primary fulfiller, recorded. The reading is re-made under every
 * candidate's capacity lock, and the reserve event it proposes — only when it
 * is permitted — is the one row written. The returned reading is the one the
 * decision was made on.
 */
export async function reserveRecordedTransaction(input: RecordedTransactionInput, actorRef: string): Promise<TransactionReading> {
  const { candidateIds, action, ...rest } = input;
  const candidates = await recordedCandidates(candidateIds);
  return decideRecorded(candidateIds, actorRef, async (events) => {
    const reading = readTransaction({ ...rest, candidates, events, authority: await authorityFor(input.businessId, action ?? RESERVE_ACTION) });
    return { result: reading, append: reading.reserve.permitted && reading.reserve.event ? [reading.reserve.event] : [] };
  });
}

/**
 * Carry out the transfer the reading plans after a reported primary failure,
 * recorded: the primary's release and the alternative's hold land together or
 * not at all. When no transfer applies, nothing is written.
 */
export async function transferRecordedTransaction(input: RecordedTransactionInput, actorRef: string): Promise<TransactionReading> {
  const { candidateIds, action, ...rest } = input;
  const candidates = await recordedCandidates(candidateIds);
  return decideRecorded(candidateIds, actorRef, async (events) => {
    const reading = readTransaction({ ...rest, candidates, events, authority: await authorityFor(input.businessId, action ?? RESERVE_ACTION) });
    const plan = reading.transfer.plan;
    return { result: reading, append: plan && plan.action === 'TRANSFER' ? plan.events : [] };
  });
}

// ---------------------------------------------------------------------------
// The same reading on a sourced opportunity (S-0469)
// ---------------------------------------------------------------------------

/**
 * Who a sourced opportunity's own rows name as able to fulfil it, and on what
 * record. Nothing here is supplied by the caller: the candidates are read from
 * the opportunity card's `fulfillmentOwner` and from each live agreement's
 * declared fulfilment (`journey/fulfillment.ts` — the supplier or performer a
 * person named), and the facts those rows establish are read from the same
 * rows and the money ledger's supplier commitments (`fulfillment-cost:<id>:…`,
 * the entries `commitments.ts` reads as `owedToSuppliers`, LIFE-29-1).
 *
 * What the rows establish, each with the row it came from as its evidence:
 *
 *   * a named fulfiller is LISTED — on the record, nothing more;
 *   * a supplier commitment in the ledger is a verified price (what Brain
 *     committed to pay, net of reductions) and a verified contract (Brain owes
 *     the supplier on it);
 *   * an accepted delivery of the obligation the fulfiller performed is a
 *     verified completion.
 *
 * Everything else — willingness, availability, capability, payment terms,
 * lead time, capacity — is whatever the counterparty's recorded facts
 * (`recordCounterpartyFacts`) say, and absent until somebody records it: a
 * task, never a default. The recorded facts are read after the row-derived
 * ones, so a later recorded correction is the latest word.
 *
 * Brain itself is not a counterparty: a fulfilment Brain performs (software,
 * research) or a card that names Brain is not offered as a candidate.
 */
export interface SourcedFulfiller {
  counterpartyId: string;
  /** The name the record uses, as first written. */
  name: string;
  /** Where the name was read: `opportunity:<id>:fulfillmentOwner`, `fulfillment:<id>`. */
  sources: string[];
  /** The facts the rows themselves establish, before any recorded fact. */
  facts: Fact[];
  /**
   * The currency the row-derived `price` fact is stated in (the agreement's), or null when the rows
   * establish no price. A price recorded elsewhere carries no currency here, and is never assumed
   * to be in the grant's.
   */
  priceCurrency: string | null;
}

/** The counterparty id a fulfiller's name is filed under, the same for every record that names it. */
export function fulfillerCounterpartyId(name: string): string {
  return `fulfiller:${name.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

const BRAIN_PERFORMS: ReadonlySet<string> = new Set(['SOFTWARE', 'RESEARCH']);
const namesBrain = (name: string) => name.toLowerCase().includes('brain');

/** The fulfillers the opportunity's rows name, with the facts those rows establish. Writes nothing. */
export async function sourcedFulfillers(opportunityId: string): Promise<SourcedFulfiller[]> {
  const [{ getOpportunity }, { readObligations }, { listMoneyEntries }] = await Promise.all([
    import('../../../repos/cashPortfolio.ts'),
    import('../../cash/journey/fulfillment.ts'),
    import('../../../repos/cashLedger.ts'),
  ]);
  const opportunity = await getOpportunity(opportunityId);
  if (!opportunity) return [];
  const [obligations, entries] = await Promise.all([
    readObligations(opportunityId),
    listMoneyEntries({ projectId: opportunity.projectId, opportunityId, limit: 2000 }),
  ]);
  const found = new Map<string, SourcedFulfiller>();
  const named = (name: string, source: string): SourcedFulfiller | null => {
    const clean = name.trim();
    if (!clean || namesBrain(clean)) return null;
    const id = fulfillerCounterpartyId(clean);
    const one = found.get(id) ?? { counterpartyId: id, name: clean, sources: [], facts: [], priceCurrency: null };
    if (!one.sources.includes(source)) one.sources.push(source);
    found.set(id, one);
    return one;
  };

  if (opportunity.fulfillmentOwner) named(opportunity.fulfillmentOwner, `opportunity:${opportunityId}:fulfillmentOwner`);
  for (const o of obligations) {
    const f = o.fulfillment;
    if (!f || BRAIN_PERFORMS.has(f.kind) || o.agreement.releasedAt !== null) continue;
    const one = named(f.kind === 'SUPPLIER' ? f.supplierName ?? f.performer : f.performer, `fulfillment:${f.id}`);
    if (!one) continue;
    const prefix = `fulfillment-cost:${f.id}:`;
    const own = entries.filter((e) => e.idempotencyKey?.startsWith(prefix) && e.currency === o.agreement.currency);
    const committed = own.filter((e) => e.kind === 'UNPAID_COMMITMENT');
    const reduced = own.filter((e) => e.kind === 'COMMITMENT_RELEASED');
    const price = committed.reduce((n, e) => n + e.amountCents, 0) - reduced.reduce((n, e) => n + e.amountCents, 0);
    if (committed.length > 0 && price > 0) {
      const evidence = `ledger supplier commitment ${[...committed, ...reduced].map((e) => e.id).join(', ')} (${o.agreement.currency}, agreement ${o.agreement.id})`;
      one.facts.push({ dimension: 'price', status: 'VERIFIED', evidence, value: price });
      one.priceCurrency = o.agreement.currency;
      one.facts.push({ dimension: 'contract', status: 'VERIFIED', evidence, value: `agreement:${o.agreement.id}` });
    }
    if (o.acceptance.state === 'ACCEPTED' && o.delivery.state === 'DELIVERED') {
      const proof = o.acceptance.evidence ?? o.delivery.evidence;
      if (proof) one.facts.push({ dimension: 'completion', status: 'VERIFIED', evidence: `agreement ${o.agreement.id} accepted: ${proof}`, value: o.agreement.id });
    }
  }
  for (const one of found.values()) {
    one.facts.unshift({ dimension: 'listing', status: 'VERIFIED', evidence: `named on ${one.sources.join(', ')}`, value: one.name });
  }
  return [...found.values()];
}

/** The candidate a sourced fulfiller is: the rows' facts, then everything recorded about it. */
export async function sourcedCandidate(fulfiller: SourcedFulfiller, kindHint: string): Promise<Counterparty> {
  const recorded = await recordedCounterparty(fulfiller.counterpartyId);
  return {
    id: fulfiller.counterpartyId,
    kind: recorded?.kind || kindHint,
    geography: recorded?.geography ?? null,
    ...(recorded?.humanOperator === undefined ? {} : { humanOperator: recorded.humanOperator }),
    facts: [...fulfiller.facts, ...(recorded?.facts ?? [])],
  };
}

/**
 * An opportunity's transaction: the commitment is the opportunity, the business
 * is the project that owns it, the candidates are the fulfillers its rows name
 * (plus any counterparty `alsoConsider` names whose facts are on record, so an
 * alternative sourced elsewhere is compared on the same terms), and the
 * authority is the project's live grant. The caller supplies only the shape of
 * the work — units, window, geographies — never a fact or an authority.
 */
export interface OpportunityTransactionInput {
  opportunityId: string;
  capacityUnits?: number;
  window: { windowStart: string; windowEnd: string };
  geographies?: readonly string[];
  humanRequirement?: Commitment['humanRequirement'];
  alsoConsider?: readonly string[];
  at: string;
  action?: CommercialAction;
}

export interface OpportunityTransaction {
  opportunityId: string;
  businessId: string | null;
  fulfillers: SourcedFulfiller[];
  reading: TransactionReading | null;
  /**
   * The next negotiating move on each candidate's terms, judged against the terms the owner
   * authorized (`negotiate`, S-0468 "negotiate authorized terms"): the live grant's per-action
   * ceiling for engaging a contractor, in the grant's currency. Empty when there is no reading.
   */
  negotiations: OpportunityNegotiation[];
  /** Why there is no reading, when there is none. */
  detail: string;
}

async function opportunityCandidates(input: OpportunityTransactionInput): Promise<{
  businessId: string | null; fulfillers: SourcedFulfiller[]; candidates: Counterparty[]; rest: Omit<TransactionInput, 'candidates' | 'events' | 'authority'> | null;
}> {
  const { getOpportunity } = await import('../../../repos/cashPortfolio.ts');
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return { businessId: null, fulfillers: [], candidates: [], rest: null };
  const fulfillers = await sourcedFulfillers(input.opportunityId);
  const candidates: Counterparty[] = [];
  for (const f of fulfillers) candidates.push(await sourcedCandidate(f, f.sources.some((s) => s.startsWith('fulfillment:')) ? 'supplier' : 'fulfiller'));
  const have = new Set(candidates.map((c) => c.id));
  for (const id of input.alsoConsider ?? []) {
    if (have.has(id)) continue;
    const one = await recordedCounterparty(id);
    if (one) { candidates.push(one); have.add(id); }
  }
  const commitment: Commitment = {
    id: `opportunity:${opportunity.id}`,
    capacityUnits: input.capacityUnits ?? 1,
    ...(input.geographies ? { geographies: input.geographies } : {}),
    ...(input.humanRequirement ? { humanRequirement: input.humanRequirement } : {}),
  };
  return {
    businessId: opportunity.projectId,
    fulfillers,
    candidates,
    rest: {
      commitment,
      businessId: opportunity.projectId,
      window: input.window,
      at: input.at,
      source: `opportunity:${opportunity.id}${opportunity.source ? ` (${opportunity.source})` : ''}`,
    },
  };
}

function noReading(input: OpportunityTransactionInput, found: Awaited<ReturnType<typeof opportunityCandidates>>): OpportunityTransaction | null {
  if (!found.rest) return { opportunityId: input.opportunityId, businessId: null, fulfillers: [], reading: null, negotiations: [], detail: 'no such opportunity' };
  if (found.candidates.length === 0) {
    return { opportunityId: input.opportunityId, businessId: found.businessId, fulfillers: found.fulfillers, reading: null, negotiations: [], detail: 'the opportunity names no fulfiller other than Brain, and nothing else was considered' };
  }
  return null;
}

/** The opportunity's transaction as the record stands now. Writes nothing. */
export async function readOpportunityTransaction(input: OpportunityTransactionInput): Promise<OpportunityTransaction> {
  const found = await opportunityCandidates(input);
  const none = noReading(input, found);
  if (none) return none;
  const ids = found.candidates.map((c) => c.id);
  const reading = readTransaction({
    ...found.rest!,
    candidates: found.candidates,
    events: await recordedReservationEvents(ids),
    authority: await authorityFor(found.businessId!, input.action ?? RESERVE_ACTION),
  });
  const negotiations = await negotiateCandidates(found.businessId!, found.candidates, found.fulfillers);
  return { opportunityId: input.opportunityId, businessId: found.businessId, fulfillers: found.fulfillers, reading, negotiations, detail: reading.deliverability.reason };
}

async function decideOpportunity(
  input: OpportunityTransactionInput,
  actorRef: string,
  toAppend: (reading: TransactionReading) => readonly ReservationEvent[],
): Promise<OpportunityTransaction> {
  const found = await opportunityCandidates(input);
  const none = noReading(input, found);
  if (none) return none;
  const ids = found.candidates.map((c) => c.id);
  const reading = await decideRecorded(ids, actorRef, async (events) => {
    const one = readTransaction({ ...found.rest!, candidates: found.candidates, events, authority: await authorityFor(found.businessId!, input.action ?? RESERVE_ACTION) });
    return { result: one, append: toAppend(one) };
  });
  const negotiations = await negotiateCandidates(found.businessId!, found.candidates, found.fulfillers);
  return { opportunityId: input.opportunityId, businessId: found.businessId, fulfillers: found.fulfillers, reading, negotiations, detail: reading.reserve.permitted ? reading.deliverability.reason : reading.reserve.detail };
}

/** Reserve the opportunity's primary fulfiller under the project's live grant, recorded; only a permitted reserve writes. */
export function reserveOpportunityTransaction(input: OpportunityTransactionInput, actorRef: string): Promise<OpportunityTransaction> {
  return decideOpportunity(input, actorRef, (r) => (r.reserve.permitted && r.reserve.event && !r.reserve.duplicate ? [r.reserve.event] : []));
}

/** Transfer the opportunity's job after its primary reported a failure, recorded: release and new hold together, or nothing. */
export function transferOpportunityTransaction(input: OpportunityTransactionInput, actorRef: string): Promise<OpportunityTransaction> {
  return decideOpportunity(input, actorRef, (r) => (r.transfer.plan && r.transfer.plan.action === 'TRANSFER' ? r.transfer.plan.events : []));
}

// ---------------------------------------------------------------------------
// Negotiation on recorded rows (S-0468 "negotiate authorized terms")
// ---------------------------------------------------------------------------

/** The commercial action whose grant authorizes accepting a contractor's terms. */
export const NEGOTIATE_ACTION: CommercialAction = 'ENGAGE_CONTRACTOR';

export type OpportunityNegotiationStep = NegotiationStep | { action: 'NOT_COMPARABLE'; detail: string };

export interface OpportunityNegotiation {
  counterpartyId: string;
  /** What the authorized terms were read from: the live grant, never the caller. */
  terms: { priceCeiling: number | null; currency: string | null; authorityId: string | null };
  step: OpportunityNegotiationStep;
}

/**
 * The terms the owner authorized for engaging a contractor on this business, read from the live
 * commercial grant by its owner (`checkCommercialAuthority`): the per-action ceiling a person
 * wrote, in the grant's currency. No grant, no terms — the reading says which authority is missing.
 */
export async function authorizedTermsFor(
  businessId: string,
  action: CommercialAction = NEGOTIATE_ACTION,
): Promise<{ terms: AuthorizedTerms | null; currency: string | null; authority: AuthorityReading }> {
  const decision = await checkCommercialAuthority({ projectId: businessId, action });
  const authority: AuthorityReading = {
    businessId,
    action,
    held: decision.ok,
    reason: decision.reason,
    authorityId: decision.ok ? decision.authority?.id ?? null : null,
    policyVersion: decision.policyVersion,
  };
  if (!decision.ok || !decision.authority) return { terms: null, currency: null, authority };
  return { terms: { priceCeiling: decision.authority.maxPerActionCents, authority }, currency: decision.authority.currency, authority };
}

/**
 * One candidate's next move against the authorized terms. A price is compared with the ceiling
 * only when both are in the same, stated currency: a price whose currency the rows do not state is
 * not comparable, never assumed to match (an unknown is never favourable).
 */
export function negotiateOnTerms(
  candidate: Counterparty,
  fulfiller: SourcedFulfiller | null,
  read: { terms: AuthorizedTerms | null; currency: string | null; authority: AuthorityReading },
): OpportunityNegotiation {
  const terms = { priceCeiling: read.terms?.priceCeiling ?? null, currency: read.currency, authorityId: read.authority.authorityId };
  if (!read.terms) {
    return {
      counterpartyId: candidate.id,
      terms,
      step: { action: 'MISSING_AUTHORITY', missingAuthority: [read.authority.action], detail: `no terms are authorized without ${read.authority.action}: ${read.authority.reason}` },
    };
  }
  const price = candidate.facts.filter((f) => f.dimension === 'price').at(-1);
  if (price && effectiveStatus(price) === 'VERIFIED' && typeof price.value === 'number') {
    const currency = fulfiller && fulfiller.facts.includes(price) ? fulfiller.priceCurrency : null;
    if (currency === null || read.currency === null || currency.toUpperCase() !== read.currency.toUpperCase()) {
      return {
        counterpartyId: candidate.id,
        terms,
        step: { action: 'NOT_COMPARABLE', detail: `the price is stated in ${currency ?? 'no recorded currency'} and the authorized ceiling in ${read.currency ?? 'no currency'}; nothing is negotiated across them` },
      };
    }
  }
  return { counterpartyId: candidate.id, terms, step: negotiate(candidate, read.terms) };
}

/** Every candidate's next move, against the business's live authorized terms. Writes nothing. */
async function negotiateCandidates(
  businessId: string,
  candidates: readonly Counterparty[],
  fulfillers: readonly SourcedFulfiller[],
): Promise<OpportunityNegotiation[]> {
  if (candidates.length === 0) return [];
  const read = await authorizedTermsFor(businessId);
  return candidates.map((c) => negotiateOnTerms(c, fulfillers.find((f) => f.counterpartyId === c.id) ?? null, read));
}
