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
 *     to the best eligible candidate that is not the failed one, releasing the
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
  planTransfer,
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
  if (stageIndex(primary.stage) < QUOTE) {
    return {
      permitted: false, counterpartyId: primary.counterpartyId, reason: 'NOT_QUOTED', missingAuthority: [],
      detail: `${primary.counterpartyId} has reached ${primary.stage ?? 'no stage'}; a reserve needs a verified quote first`,
    };
  }
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
  const to = comparison.ranked.find((r) => r.counterpartyId !== failed.counterpartyId) ?? null;
  if (!to) return { applicable: true, from: failed.counterpartyId, to: null, plan: null, detail: 'the primary failed and no eligible alternative remains' };
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
  const comparison = compareFulfillers(input.commitment, input.candidates);
  const all = [...comparison.ranked, ...comparison.ineligible];
  const readings = new Map(all.map((r) => [r.counterpartyId, r]));
  const byId = new Map(input.candidates.map((c) => [c.id, c]));
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
