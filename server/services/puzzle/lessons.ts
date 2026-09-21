/**
 * What attempts taught, derived with the sample shown.
 *
 * ---------------------------------------------------------------------------
 * A rule is computed, never stored
 * ---------------------------------------------------------------------------
 *
 * §45 argues it at a deal and it is the same argument here: one observation
 * per row, and whether several amount to a rule is derived on the read path
 * with the count beside it. A stored rule is a generalization nobody can see
 * the sample behind, and the first thing anybody does with one is believe it
 * harder than the three rows underneath it deserve.
 *
 * One observation is reported as an anecdote and **never hidden** — a single
 * rights surprise or a single customer complaint about an ambiguous clue is
 * often the most valuable thing in the table.
 *
 * ---------------------------------------------------------------------------
 * Brain's own derivations are counted apart from a person's
 * ---------------------------------------------------------------------------
 *
 * Four `GENERATOR_DEFECT` rows about one batch are one observation four times
 * over: they were all derived from the same failing validator by the same
 * pass. A person's playtest is a separate reading of the world. Mixing them
 * would let a loud automatic writer manufacture a rule.
 *
 * ---------------------------------------------------------------------------
 * A lesson informs and never gates
 * ---------------------------------------------------------------------------
 *
 * Nothing in this kernel reads this module to decide whether something may
 * proceed. No allocation, no validation, no compilation and no release
 * consults it. §29 draws the same line at its own learning surface, and it is
 * what keeps a derived generalization from quietly becoming a control.
 */
import type { PuzzleSnapshot } from './graph.ts';
import type { PuzzleObservationKind } from '../../domain/types.ts';

/** How many independent observations make a group worth calling a pattern. */
export const PATTERN_MINIMUM = 3;

export interface Lesson {
  kind: PuzzleObservationKind;
  subjectKey: string | null;
  /** Every observation in the group, so the sample is visible rather than implied. */
  sample: { statement: string; observer: 'BRAIN' | 'PERSON'; at: string }[];
  byBrain: number;
  byPerson: number;
  /**
   * Whether this is a pattern or an anecdote.
   *
   * A pattern needs `PATTERN_MINIMUM` observations **and** at least one that
   * Brain did not derive itself — because several derivations of one failing
   * validator are one reading repeated, and calling that a pattern is how a
   * loud automatic writer manufactures a rule.
   */
  reading: 'PATTERN' | 'ANECDOTE';
  why: string;
}

export function readLessons(snapshot: PuzzleSnapshot): Lesson[] {
  const groups = new Map<string, Lesson>();
  for (const observation of snapshot.observations) {
    const key = `${observation.kind}\u0000${observation.subjectKey ?? ''}`;
    const existing = groups.get(key);
    const entry = {
      statement: observation.statement,
      observer: observation.observer,
      at: observation.createdAt,
    };
    if (existing) {
      existing.sample.push(entry);
      if (observation.observer === 'BRAIN') existing.byBrain += 1;
      else existing.byPerson += 1;
      continue;
    }
    groups.set(key, {
      kind: observation.kind,
      subjectKey: observation.subjectKey,
      sample: [entry],
      byBrain: observation.observer === 'BRAIN' ? 1 : 0,
      byPerson: observation.observer === 'PERSON' ? 1 : 0,
      reading: 'ANECDOTE',
      why: '',
    });
  }

  return [...groups.values()]
    .map((lesson) => {
      const isPattern = lesson.sample.length >= PATTERN_MINIMUM && lesson.byPerson > 0;
      return {
        ...lesson,
        reading: (isPattern ? 'PATTERN' : 'ANECDOTE') as Lesson['reading'],
        why: isPattern
          ? `${lesson.sample.length} observations, ${lesson.byPerson} of them somebody's own ` +
            'reading rather than a derivation.'
          : lesson.sample.length < PATTERN_MINIMUM
            ? `${lesson.sample.length} observation(s). Worth reading and not yet a pattern.`
            : `${lesson.sample.length} observations, all of them Brain's own derivations from ` +
              'the same rows. Several derivations of one condition are one reading repeated.',
      };
    })
    .sort(
      (a, b) =>
        b.sample.length - a.sample.length ||
        (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
        ((a.subjectKey ?? '') < (b.subjectKey ?? '') ? -1 : 1),
    );
}
