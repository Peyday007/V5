/**
 * What attempting this has taught, derived with its sample shown.
 *
 * ---------------------------------------------------------------------------
 * Derived, never stored, and the sample travels with the rule
 * ---------------------------------------------------------------------------
 *
 * §45 settled the shape one kernel along and the argument is the same: one
 * observation per row, and whether several amount to a rule is computed on the
 * read path with the count beside it. A stored rule is a generalization nobody
 * can see the sample behind, and the first thing a reader does with one is
 * believe it.
 *
 * A single observation is reported as an anecdote and **never hidden**. One
 * customer complaint about a puzzle nobody could finish is often the most
 * valuable row in the table, and a threshold that suppressed it until it
 * happened three times would be a threshold that waits for the damage.
 *
 * ---------------------------------------------------------------------------
 * A person's observation and Brain's own reading are counted apart
 * ---------------------------------------------------------------------------
 *
 * Four of Brain's own derivations about one product are one observation four
 * times over, and presenting them as a sample of four would be arithmetic on a
 * fiction. `recorded_by` is what keeps them apart, and the reading says which
 * kind it has.
 *
 * ---------------------------------------------------------------------------
 * A lesson informs and never gates
 * ---------------------------------------------------------------------------
 *
 * Nothing here refuses a round, blocks a product, lowers a bar or changes an
 * allocation. It is read by the surface and by a person. §40 draws the same
 * line for research retrospectives and gives the reason: the easy version of
 * learning is to replay what happened last time, which learns *always do
 * exactly what worked before* and gets worse the more of it there is.
 */
import type { PuzzleObservation, PuzzleObservationKind } from '../../domain/types.ts';

export interface Lesson {
  /** What the observations have in common. */
  subject: string;
  kind: PuzzleObservationKind;
  /** How many observations stand behind it, and how many are a person's. */
  observations: number;
  fromPeople: number;
  /** The rows themselves, so the reader can check rather than believe. */
  statements: string[];
  /** Whether this is a pattern or a single thing that happened. */
  strength: 'ANECDOTE' | 'PATTERN';
}

/** How many observations of one kind about one subject make it a pattern. */
export const PATTERN_FLOOR = 3;

export function readLessons(observations: readonly PuzzleObservation[]): Lesson[] {
  /*
   * Grouped by (kind, subject) where the subject is the format or the product
   * — never by kind alone. "Three submissions were rejected" is a fact about
   * the trade and says nothing anybody can act on; "three word-search
   * submissions were rejected" names something to look at.
   */
  const groups = new Map<string, PuzzleObservation[]>();
  for (const one of observations) {
    const subject = one.formatKey ?? one.productId ?? one.monetizationRoute ?? 'the sprint';
    const key = `${one.kind}\u0000${subject}`;
    groups.set(key, [...(groups.get(key) ?? []), one]);
  }

  const out: Lesson[] = [];
  for (const [key, group] of groups) {
    const [kind = 'SALE', subject = ''] = key.split('\u0000') as [PuzzleObservationKind, string];
    const fromPeople = group.filter((one) => one.recordedBy !== 'BRAIN').length;
    out.push({
      subject,
      kind,
      observations: group.length,
      fromPeople,
      statements: group.map((one) => one.statement),
      /*
       * Counted on what a person recorded rather than on the group's size.
       * Brain re-deriving the same thing on four ticks is one observation,
       * and a pattern built from it would be a pattern in Brain's own
       * scheduling.
       */
      strength: fromPeople >= PATTERN_FLOOR ? 'PATTERN' : 'ANECDOTE',
    });
  }

  return out.sort(
    (a, b) => b.observations - a.observations || a.subject.localeCompare(b.subject),
  );
}
