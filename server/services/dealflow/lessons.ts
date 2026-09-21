/**
 * What the attempts taught, derived from observations with the sample printed
 * beside it.
 *
 * ---------------------------------------------------------------------------
 * A lesson is derived, never stored
 * ---------------------------------------------------------------------------
 *
 * The brief's own instruction is not to generalize prematurely, and a stored
 * rule is a generalization nobody can see the sample behind. So
 * `deal_observations` holds one observed outcome per row — with its own
 * jurisdiction, equipment class and provenance — and whether several of them
 * amount to a rule is computed here, on the read path, with the count
 * reported as part of the answer rather than hidden inside a confidence score.
 *
 * ---------------------------------------------------------------------------
 * Two observations is the floor, and the floor is honest rather than safe
 * ---------------------------------------------------------------------------
 *
 * One observation is an anecdote and is reported as one — it is not
 * suppressed, because a single certification surprise is often the most
 * valuable thing in the table. What changes at the floor is the *word*: below
 * it Brain says "observed once", at it and above Brain says "observed N
 * times". Nothing else changes, and in particular nothing is ever hidden for
 * having too small a sample.
 *
 * ---------------------------------------------------------------------------
 * Brain's own derivations are not independent observations
 * ---------------------------------------------------------------------------
 *
 * `recorded_by` separates a person recording what happened from Brain reading
 * its own rows, and the two are counted separately. Four of Brain's own
 * derivations about one deal are one observation four times over, and
 * presenting them as a sample of four would be the arithmetic-on-a-fiction
 * §23 corrected once already.
 *
 * ---------------------------------------------------------------------------
 * A lesson informs; it never gates
 * ---------------------------------------------------------------------------
 *
 * Nothing downstream reads these to refuse a deal, lower a bar or skip a
 * question. A pattern across three attempts in one market is worth telling a
 * person about and is nowhere near evidence enough to stop the fourth.
 */
import { equipmentKey, jurisdictionKey } from '../../domain/dealflow.ts';
import type { DealObservation, DealObservationKind } from '../../domain/types.ts';

/** Below this a lesson is reported as a single observation rather than a pattern. */
export const PATTERN_FLOOR = 2;

export interface Lesson {
  kind: DealObservationKind;
  /** The scope it is about, from the rows' own columns. Null means unscoped. */
  jurisdiction: string | null;
  equipmentClass: string | null;
  /** How many independent observations, and by whom. Never summed together. */
  byPerson: number;
  byBrain: number;
  /** True once the person-recorded sample reaches the floor. */
  isPattern: boolean;
  /** The observations themselves, newest first, so every one can be read. */
  observations: DealObservation[];
  /** When it was last seen, so a reader can tell a live pattern from an old one. */
  lastSeenAt: string;
  /** The sentence a person reads, composed here so two screens cannot differ. */
  says: string;
}

const KIND_PHRASE: Readonly<Record<DealObservationKind, string>> = Object.freeze({
  BUYER_RESPONDED: 'buyers responded',
  BUYER_IGNORED: 'buyers did not respond',
  SUPPLIER_ENGAGED: 'suppliers engaged',
  SUPPLIER_REFUSED: 'suppliers refused',
  PRICE_DISCREPANCY: 'the price differed from what was researched',
  CERTIFICATION_SURPRISE: 'a certification requirement turned up that research had missed',
  LOGISTICS_SURPRISE: 'logistics cost or took longer than researched',
  PAYMENT_PREFERENCE: 'a payment preference was stated',
  COMMISSION_ACCEPTED: 'a commission was accepted',
  COMMISSION_REFUSED: 'a commission was refused',
  FALSE_SIGNAL: 'a buying signal turned out not to be one',
  CYCLE_LENGTH: 'the buying cycle was measured',
});

function scopeKey(one: DealObservation): string {
  return [
    one.kind,
    one.jurisdiction ? jurisdictionKey(one.jurisdiction) : '-',
    one.equipmentKey ?? '-',
  ].join('|');
}

/**
 * Group the observations into what they amount to.
 *
 * Grouped by (kind, jurisdiction, class) exactly — never by "similar market" or
 * "related equipment", because a lesson about fuel tankers into Zambia is not
 * evidence about dump trailers into Kenya and a grouping that blurred them
 * would produce the confident wrong generalization this module exists to
 * refuse. An unscoped observation groups with other unscoped ones and says so.
 */
export function lessonsFrom(observations: readonly DealObservation[]): Lesson[] {
  const groups = new Map<string, DealObservation[]>();
  for (const one of observations) {
    const key = scopeKey(one);
    const list = groups.get(key);
    if (list) list.push(one);
    else groups.set(key, [one]);
  }

  const out: Lesson[] = [];
  for (const rows of groups.values()) {
    const sorted = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const head = sorted[0];
    if (!head) continue;
    const byPerson = sorted.filter((one) => one.recordedBy !== 'BRAIN').length;
    const byBrain = sorted.length - byPerson;
    const isPattern = byPerson >= PATTERN_FLOOR;

    out.push({
      kind: head.kind,
      jurisdiction: head.jurisdiction,
      equipmentClass: head.equipmentKey,
      byPerson,
      byBrain,
      isPattern,
      observations: sorted,
      lastSeenAt: head.createdAt,
      says: say({ head, byPerson, byBrain, isPattern }),
    });
  }

  // Strongest sample first, then most recent. A deterministic order, and not a
  // ranking: nothing here decides which lesson matters more.
  return out.sort(
    (a, b) => b.byPerson - a.byPerson || (a.lastSeenAt < b.lastSeenAt ? 1 : -1),
  );
}

function say(input: {
  head: DealObservation;
  byPerson: number;
  byBrain: number;
  isPattern: boolean;
}): string {
  const scope = [
    input.head.equipmentKey ? `for ${input.head.equipmentKey}` : null,
    input.head.jurisdiction ? `in ${input.head.jurisdiction}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const where = scope ? ` ${scope}` : '';
  const phrase = KIND_PHRASE[input.head.kind];

  if (input.byPerson === 0) {
    return (
      `Brain derived this from its own rows ${input.byBrain} time` +
      `${input.byBrain === 1 ? '' : 's'}${where}, and nobody has observed it in an actual ` +
      'attempt. That is a reading rather than a lesson.'
    );
  }
  if (!input.isPattern) {
    return (
      `Observed once${where}: ${phrase}. One attempt is an anecdote, and it is reported ` +
      'because a single surprise is often the most valuable thing in this table — not ' +
      'because it generalizes.'
    );
  }
  return (
    `Observed ${input.byPerson} times${where}: ${phrase}. That is a pattern worth acting on ` +
    `and it rests on ${input.byPerson} attempts, which is what makes it checkable.` +
    (input.byBrain > 0
      ? ` Brain's own ${input.byBrain} derivation${input.byBrain === 1 ? '' : 's'} are counted ` +
        'separately and add nothing to that.'
      : '')
  );
}

/**
 * The lessons that bear on one class and market.
 *
 * Exact scope match, plus the unscoped ones — which is the only widening this
 * module does and the only one it can justify: an observation recorded with no
 * jurisdiction is about the trade rather than about a market, so it applies
 * everywhere or it should not have been recorded.
 */
export function lessonsFor(input: {
  lessons: readonly Lesson[];
  equipmentClass?: string | null;
  destination?: string | null;
}): Lesson[] {
  const key = input.equipmentClass ? equipmentKey(input.equipmentClass) : null;
  const dest = input.destination ? jurisdictionKey(input.destination) : null;
  return input.lessons.filter((one) => {
    const classOk = one.equipmentClass === null || one.equipmentClass === key;
    const destOk =
      one.jurisdiction === null || (dest !== null && jurisdictionKey(one.jurisdiction) === dest);
    return classOk && destOk;
  });
}
