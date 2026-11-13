/**
 * Who can perform a commercial commitment, and how far each claim about them has
 * actually been established.
 *
 * ---------------------------------------------------------------------------
 * A listing is not a willingness, and a quote is not a reservation
 * ---------------------------------------------------------------------------
 *
 * A counterparty climbs seven stages — LISTING, WILLINGNESS, CAPABILITY, QUOTE,
 * RESERVED, CONTRACTED, PERFORMED — and each is a different fact with a
 * different kind of evidence. A directory entry proves only that somebody is
 * listed. The ladder is read from recorded facts and never stored: the stage a
 * counterparty has reached is whatever its facts support today, so a fact that
 * goes stale or is withdrawn lowers it without anybody remembering to.
 *
 * The reading is pure: a function over a snapshot, so "why did Brain think
 * this supplier could perform" is answerable afterwards from the input. The
 * snapshot is durable: `recordCounterpartyFacts` appends each fact as one
 * append-only `cash_events` row (kind `COUNTERPARTY_FACT`) on the
 * counterparty's ledger, and `recordedCounterparty` folds them back. A
 * correction is a new row beside the old one, never an edit (invariant 17).
 *
 * ---------------------------------------------------------------------------
 * Three rules this module keeps
 * ---------------------------------------------------------------------------
 *
 *   * A fact is VERIFIED only with evidence. A claimed-verified fact that names
 *     no evidence is read as PENDING, because "verified" is a statement about a
 *     source and an absent source is not one.
 *   * A stage is reached only when every fact it needs is VERIFIED (or
 *     NOT_APPLICABLE with a stated reason), and only when every earlier stage
 *     was reached. A signed contract does not retroactively make a counterparty
 *     willing; it makes the record inconsistent, and the reading says so.
 *   * An unknown is never favourable. UNKNOWN and PENDING are carried to the
 *     reader as what is still missing — a task, not a default.
 *
 * Nothing here enumerates a kind of counterparty or an industry. `kind` is the
 * caller's word.
 */
import type { HumanNecessityReason } from '../../../domain/types.ts';
import { cashEventsOfKind, recordCashEvent } from '../../../repos/cashMode.ts';

export const STAGES = ['LISTING', 'WILLINGNESS', 'CAPABILITY', 'QUOTE', 'RESERVED', 'CONTRACTED', 'PERFORMED'] as const;
export type Stage = (typeof STAGES)[number];

export type FactStatus = 'VERIFIED' | 'PENDING' | 'UNKNOWN' | 'NOT_APPLICABLE';

/**
 * One recorded fact about a counterparty. `dimension` is open: the ones the
 * ladder needs are named in `STAGE_REQUIRES`; others (response speed, quality,
 * reliability, cancellation rights, switching cost …) are carried and reported.
 */
export interface Fact {
  dimension: string;
  status: FactStatus;
  /** Where it was established. Required for VERIFIED; the reason for NOT_APPLICABLE. */
  evidence?: string | null;
  /** The figure or label the fact states, when it states one. */
  value?: number | string | null;
}

/** Dimensions the stage rules read. A counterparty may carry any others. */
export const STAGE_REQUIRES: Readonly<Record<Stage, readonly string[]>> = Object.freeze({
  LISTING: ['listing'],
  WILLINGNESS: ['willingness', 'availability'],
  CAPABILITY: ['eligibility', 'scope', 'qualifications', 'geography'],
  QUOTE: ['price', 'paymentTerms', 'leadTime'],
  RESERVED: ['reservedCapacity'],
  CONTRACTED: ['contract'],
  PERFORMED: ['completion'],
});

export interface Counterparty {
  id: string;
  /** The caller's own word: contractor, carrier, software service, partner … Never validated against a list. */
  kind: string;
  /** Where it operates, as a label. Search is never anchored to the owner's location. */
  geography?: string | null;
  /** Whether a person acts for this counterparty (an operator, a licensed signatory). */
  humanOperator?: boolean;
  facts: readonly Fact[];
}

/** A commitment can need something Brain cannot itself, or legally, be. */
export interface HumanRequirement {
  /** One of the necessity reasons, or `ROLE_UNFULFILLABLE` for a role or licence Brain cannot hold. */
  reason: HumanNecessityReason | 'ROLE_UNFULFILLABLE';
  note?: string;
}

export interface MissingFact {
  dimension: string;
  /** What the record says now: PENDING, UNKNOWN, or ABSENT when no fact names the dimension. */
  state: 'PENDING' | 'UNKNOWN' | 'ABSENT';
}

export interface StageReading {
  stage: Stage;
  reached: boolean;
  /** Reached on its own facts but an earlier stage is not: the record is inconsistent. */
  inconsistent: boolean;
  missing: MissingFact[];
}

export interface LadderReading {
  counterpartyId: string;
  kind: string;
  /** The highest stage reached with every earlier stage reached; null when not even listed. */
  stage: Stage | null;
  stages: StageReading[];
  /** Facts the ladder does not read, carried so nothing the record knows is dropped. */
  other: Fact[];
}

/** A fact as the ladder reads it: VERIFIED without evidence is PENDING. */
export function effectiveStatus(fact: Fact): FactStatus {
  const evidence = (fact.evidence ?? '').trim();
  if (fact.status === 'VERIFIED' && evidence === '') return 'PENDING';
  if (fact.status === 'NOT_APPLICABLE' && evidence === '') return 'UNKNOWN';
  return fact.status;
}

/** The latest word on a dimension. Later entries replace earlier ones, as a correction would. */
export function factFor(facts: readonly Fact[], dimension: string): Fact | undefined {
  let found: Fact | undefined;
  for (const fact of facts) if (fact.dimension === dimension) found = fact;
  return found;
}

function settled(status: FactStatus): boolean {
  return status === 'VERIFIED' || status === 'NOT_APPLICABLE';
}

export function readLadder(counterparty: Counterparty): LadderReading {
  const stages: StageReading[] = [];
  let contiguous = true;
  let stage: Stage | null = null;
  for (const name of STAGES) {
    const missing: MissingFact[] = [];
    for (const dimension of STAGE_REQUIRES[name]) {
      const fact = factFor(counterparty.facts, dimension);
      if (!fact) missing.push({ dimension, state: 'ABSENT' });
      else {
        const status = effectiveStatus(fact);
        if (!settled(status)) missing.push({ dimension, state: status === 'UNKNOWN' ? 'UNKNOWN' : 'PENDING' });
      }
    }
    const own = missing.length === 0;
    stages.push({ stage: name, reached: own && contiguous, inconsistent: own && !contiguous, missing });
    if (own && contiguous) stage = name;
    else contiguous = false;
  }
  const read = new Set<string>(Object.values(STAGE_REQUIRES).flat());
  return {
    counterpartyId: counterparty.id,
    kind: counterparty.kind,
    stage,
    stages,
    other: counterparty.facts.filter((fact) => !read.has(fact.dimension)),
  };
}

export function stageIndex(stage: Stage | null): number {
  return stage === null ? -1 : STAGES.indexOf(stage);
}

/**
 * Whether a commitment needs a person or a role Brain cannot be. Surfaced, never
 * assumed away: a counterparty without a human operator cannot satisfy it.
 */
export function humanRequirementReading(requirement: HumanRequirement | null | undefined, counterparty: Counterparty): {
  required: boolean;
  satisfied: boolean | null;
  reason: HumanRequirement['reason'] | null;
} {
  if (!requirement) return { required: false, satisfied: null, reason: null };
  return { required: true, satisfied: counterparty.humanOperator === true, reason: requirement.reason };
}

// ---------------------------------------------------------------------------
// The recorded facts
// ---------------------------------------------------------------------------

/** The `cash_events.kind` every counterparty fact is recorded under. */
export const FACT_EVENT_KIND = 'COUNTERPARTY_FACT';

/** The ledger a counterparty's rows are filed on; the same one its reservations use. */
export function counterpartyFactLedger(counterpartyId: string): string {
  return `counterparty:${counterpartyId}`;
}

const STATUSES: ReadonlySet<string> = new Set<FactStatus>(['VERIFIED', 'PENDING', 'UNKNOWN', 'NOT_APPLICABLE']);

/**
 * Record facts about a counterparty, one append-only row each, under the
 * business (`projectId`) that learned them. Profile fields are recorded with
 * every row so the latest word on them is readable; nothing earlier is edited.
 */
export async function recordCounterpartyFacts(input: {
  projectId: string;
  counterparty: Pick<Counterparty, 'id' | 'kind' | 'geography' | 'humanOperator'>;
  facts: readonly Fact[];
  actorRef: string;
}): Promise<number> {
  const { id, kind, geography, humanOperator } = input.counterparty;
  if (!id.trim()) throw new Error('a counterparty has an id');
  let written = 0;
  for (const fact of input.facts) {
    if (!fact.dimension.trim() || !STATUSES.has(fact.status)) throw new Error(`not a fact: ${JSON.stringify(fact)}`);
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: counterpartyFactLedger(id),
      kind: FACT_EVENT_KIND,
      actorRef: input.actorRef,
      summary: `${id} ${fact.dimension}: ${fact.status}`,
      detail: {
        counterparty: { id, kind, geography: geography ?? null, humanOperator: humanOperator ?? null },
        fact: { dimension: fact.dimension, status: fact.status, evidence: fact.evidence ?? null, value: fact.value ?? null },
      },
    });
    written += 1;
  }
  return written;
}

/** The counterparty its recorded facts describe, from every business, or null when nothing is recorded. */
export async function recordedCounterparty(counterpartyId: string): Promise<Counterparty | null> {
  const rows = await cashEventsOfKind(counterpartyFactLedger(counterpartyId), FACT_EVENT_KIND);
  let profile: { kind: string; geography: string | null; humanOperator: boolean | null } | null = null;
  const facts: Fact[] = [];
  for (const row of rows) {
    const who = row.detail['counterparty'] as { id?: unknown; kind?: unknown; geography?: unknown; humanOperator?: unknown } | undefined;
    const f = row.detail['fact'] as { dimension?: unknown; status?: unknown; evidence?: unknown; value?: unknown } | undefined;
    if (!who || who.id !== counterpartyId || !f || typeof f.dimension !== 'string' || !STATUSES.has(String(f.status))) continue;
    const previousKind: string = profile === null ? '' : (profile as { kind: string }).kind;
    profile = {
      kind: typeof who.kind === 'string' ? who.kind : previousKind,
      geography: typeof who.geography === 'string' ? who.geography : null,
      humanOperator: typeof who.humanOperator === 'boolean' ? who.humanOperator : null,
    };
    const value = typeof f.value === 'number' || typeof f.value === 'string' ? f.value : null;
    facts.push({ dimension: f.dimension, status: f.status as FactStatus, evidence: typeof f.evidence === 'string' ? f.evidence : null, value });
  }
  if (!profile) return null;
  return {
    id: counterpartyId,
    kind: profile.kind,
    geography: profile.geography,
    ...(profile.humanOperator === null ? {} : { humanOperator: profile.humanOperator }),
    facts,
  };
}
