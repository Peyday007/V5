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
 * before the rows land. Authority is the caller's: `authorityRequired` and
 * `authorityHeld` are read from the existing authority owner by whoever calls,
 * and this module only refuses when they do not cover the action.
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
import { effectiveStatus, recordedCounterparty, STAGES, stageIndex, type Counterparty, type MissingFact, type Stage } from './ladder.ts';
import {
  decideRecorded,
  doubleCommitted,
  holdsFrom,
  performanceFacts,
  performanceFrom,
  planTransfer,
  remainingCapacity,
  recordedReservationEvents,
  reserve,
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
  /** What a reserve on this commitment requires, and what the actor holds — read from the authority owner by the caller. */
  authorityRequired: readonly string[];
  authorityHeld: readonly string[];
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
    authorityRequired: [...input.authorityRequired],
    authorityHeld: [...input.authorityHeld],
    at: input.at,
  });
  if (answer.ok) return { permitted: true, duplicate: answer.duplicate, counterpartyId: primary.counterpartyId, event: answer.event };
  switch (answer.reason) {
    case 'MISSING_AUTHORITY':
      return {
        permitted: false, counterpartyId: primary.counterpartyId, reason: 'MISSING_AUTHORITY', missingAuthority: answer.missing,
        detail: `not reserved: the actor does not hold ${answer.missing.join(', ')}`,
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
    authorityRequired: [...input.authorityRequired],
    authorityHeld: [...input.authorityHeld],
    at: input.at,
  });
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
  /** Authority a binding acceptance needs, and what the actor holds. */
  authorityRequired: readonly string[];
  authorityHeld: readonly string[];
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
  const missingAuthority = terms.authorityRequired.filter((a) => !terms.authorityHeld.includes(a));
  if (quoted <= terms.priceCeiling) {
    if (missingAuthority.length > 0) return { action: 'MISSING_AUTHORITY', missingAuthority, detail: `accepting ${quoted} needs ${missingAuthority.join(', ')}` };
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

// ---------------------------------------------------------------------------
// The same reading on recorded rows
// ---------------------------------------------------------------------------

/** A transaction named by its candidates' ids; their facts and every business's holds are read from the record. */
export type RecordedTransactionInput = Omit<TransactionInput, 'candidates' | 'events'> & { candidateIds: readonly string[] };

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
  const { candidateIds, ...rest } = input;
  return readTransaction({ ...rest, candidates: await recordedCandidates(candidateIds), events: await recordedReservationEvents(candidateIds) });
}

/**
 * Reserve the primary fulfiller, recorded. The reading is re-made under every
 * candidate's capacity lock, and the reserve event it proposes — only when it
 * is permitted — is the one row written. The returned reading is the one the
 * decision was made on.
 */
export async function reserveRecordedTransaction(input: RecordedTransactionInput, actorRef: string): Promise<TransactionReading> {
  const { candidateIds, ...rest } = input;
  const candidates = await recordedCandidates(candidateIds);
  return decideRecorded(candidateIds, actorRef, (events) => {
    const reading = readTransaction({ ...rest, candidates, events });
    return { result: reading, append: reading.reserve.permitted && reading.reserve.event ? [reading.reserve.event] : [] };
  });
}

/**
 * Carry out the transfer the reading plans after a reported primary failure,
 * recorded: the primary's release and the alternative's hold land together or
 * not at all. When no transfer applies, nothing is written.
 */
export async function transferRecordedTransaction(input: RecordedTransactionInput, actorRef: string): Promise<TransactionReading> {
  const { candidateIds, ...rest } = input;
  const candidates = await recordedCandidates(candidateIds);
  return decideRecorded(candidateIds, actorRef, (events) => {
    const reading = readTransaction({ ...rest, candidates, events });
    const plan = reading.transfer.plan;
    return { result: reading, append: plan && plan.action === 'TRANSFER' ? plan.events : [] };
  });
}
