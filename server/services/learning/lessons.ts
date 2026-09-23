/**
 * What the outcomes teach, derived on every read with the sample beside it.
 *
 * ---------------------------------------------------------------------------
 * Two kinds of lesson, and they must never be confused
 * ---------------------------------------------------------------------------
 *
 * A **conditions** lesson is about the approach as Brain is currently running
 * it: "the last N deep dives never reached research at all". It is learned only
 * from attempts that did no work, and it says nothing about any opening —
 * which is exactly why it may change *how many* dives Brain starts and must
 * never change *which* openings are worth one.
 *
 * A **subject** lesson is about a kind of subject: "deep dives on openings of
 * this signal end without a payer". It is learned only from attempts that did
 * work, because an attempt that never touched its subject is not evidence
 * about it. Twenty-two refused plans are twenty-two facts about a refusal, and
 * zero facts about the openings they were meant to study.
 *
 * ---------------------------------------------------------------------------
 * Independence, not count
 * ---------------------------------------------------------------------------
 *
 * Two dives on two openings that came out of one discovery packet, launched in
 * the same minute, about one market, are one observation made twice. §14 says
 * sources that are really one source are counted as one; the same rule applies
 * to outcomes. Below `PATTERN_FLOOR` independent observations a subject lesson
 * is an anecdote: it is shown, never hidden, and it changes nothing.
 *
 * ---------------------------------------------------------------------------
 * A lesson changes little, and says exactly what
 * ---------------------------------------------------------------------------
 *
 * The strongest thing a conditions lesson does is replace full slots with one
 * probe. The strongest thing a subject lesson does is move a kind of opening
 * later in the queue. Neither refuses anything, neither lowers a bar, and
 * neither survives the evidence that made it: a probe that performs research
 * ends the streak on the next read, and a person withdrawing a lesson ends it
 * immediately.
 */
import { createHash } from 'node:crypto';
import {
  PATTERN_FLOOR,
  STREAK_FLOOR,
  type Approach,
  type BlockerClass,
  type LearningDecision,
} from '../../domain/learning.ts';
import {
  currentOutcomes,
  withdrawnTargets,
  type OutcomeCorrection,
  type OutcomeRecord,
} from '../../repos/learning.ts';

export type LessonKind = 'CONDITIONS' | 'SUBJECT';
export type LessonLevel = 'ANECDOTE' | 'PATTERN';

export interface Lesson {
  key: string;
  approach: Approach;
  kind: LessonKind;
  level: LessonLevel;
  /** ACTIVE may change a decision; the other two never do. */
  status: 'ACTIVE' | 'BELOW_FLOOR' | 'WITHDRAWN';
  statement: string;
  /** The scope the lesson holds in, from the outcomes' own columns. */
  scope: Record<string, string | number | null>;
  /** Every outcome it rests on, so each can be opened. */
  outcomeIds: string[];
  /** How many of those count as independent, and what made them so. */
  independent: number;
  independenceRule: string;
  /** Changes when the sample changes; decisions are keyed on it. */
  fingerprint: string;
  /** Which decision it may change, and how — or why it changes nothing. */
  changes: LearningDecision | null;
  effect: string;
  withdrawnBecause: string | null;
  lastSeenAt: string | null;
}

export const STREAK_LESSON_KEY = 'CASH_DEEP_DIVE:NO_WORK_STREAK';

export function signalLessonKey(signal: string): string {
  return `CASH_DEEP_DIVE:SIGNAL:${signal}`;
}

export function fingerprintOf(ids: string[]): string {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 16);
}

/**
 * Every lesson the deep-dive outcomes support, including the ones that do not
 * clear their floor — those are the half that stop an anecdote becoming a rule.
 */
export function deriveLessons(input: {
  outcomes: OutcomeRecord[];
  corrections: OutcomeCorrection[];
}): Lesson[] {
  const withdrawn = withdrawnTargets(input.corrections);
  const usable = currentOutcomes(input.outcomes).filter(
    (outcome) => !withdrawn.has(`OUTCOME|${outcome.id}`),
  );
  const dives = usable.filter((outcome) => outcome.approach === 'CASH_DEEP_DIVE');
  const lessons = [streakLesson(dives), ...signalLessons(dives)].filter(
    (lesson): lesson is Lesson => lesson !== null,
  );
  return lessons.map((lesson) => {
    const correction = withdrawn.get(`LESSON|${lesson.key}`);
    if (!correction) return lesson;
    return {
      ...lesson,
      status: 'WITHDRAWN',
      withdrawnBecause: correction.reason,
      effect: `Withdrawn by a person, so it changes nothing: ${correction.reason}`,
    };
  });
}

/**
 * The trailing run of settled attempts that never reached their subject.
 *
 * Only settled results count — an attempt still running is neither evidence
 * for the streak nor against it — and the run is broken by the first attempt,
 * counting back from the newest, that performed any work at all.
 */
function streakLesson(dives: OutcomeRecord[]): Lesson | null {
  const settled = dives.filter((outcome) => outcome.result !== 'ONGOING' && outcome.result !== 'UNKNOWN');
  if (settled.length === 0) return null;
  const streak: OutcomeRecord[] = [];
  for (let index = settled.length - 1; index >= 0; index -= 1) {
    const outcome = settled[index]!;
    if (outcome.workPerformed || outcome.result !== 'NOT_ATTEMPTED') break;
    streak.push(outcome);
  }
  if (streak.length === 0) return null;
  streak.reverse();

  const byBlocker = new Map<string, number>();
  for (const outcome of streak) {
    const key = outcome.blockerClass ?? 'OTHER';
    byBlocker.set(key, (byBlocker.get(key) ?? 0) + 1);
  }
  const blockers = [...byBlocker.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([blocker, count]) => `${count} ${blocker}`)
    .join(', ');
  const subjects = new Set(streak.map((outcome) => outcome.subjectId)).size;
  const active = streak.length >= STREAK_FLOOR;
  const last = streak[streak.length - 1]!;
  return {
    key: STREAK_LESSON_KEY,
    approach: 'CASH_DEEP_DIVE',
    kind: 'CONDITIONS',
    level: active ? 'PATTERN' : 'ANECDOTE',
    status: active ? 'ACTIVE' : 'BELOW_FLOOR',
    statement:
      `The last ${streak.length} deep dive(s) in a row, on ${subjects} different opening(s), ended ` +
      `without a single research pass (${blockers}). The approach is failing before it reaches ` +
      'any opening, so these outcomes say nothing about the openings themselves.',
    scope: { approach: 'CASH_DEEP_DIVE', dominantBlocker: dominant(byBlocker) },
    outcomeIds: streak.map((outcome) => outcome.id),
    independent: subjects,
    independenceRule:
      'Each attempt on a different opening counts once; a condition that stops every attempt ' +
      'is exactly what repeated attempts on different subjects reveal.',
    fingerprint: fingerprintOf(streak.map((outcome) => outcome.id)),
    changes: active ? 'CASH_DEEP_DIVE_LAUNCH' : null,
    effect: active
      ? 'Launch one probe dive at a time instead of filling every slot, until a probe performs ' +
        'research. Nothing is refused, no opening is judged, and the first probe that reaches ' +
        'research ends this lesson on the next read.'
      : `Below the floor of ${STREAK_FLOOR} consecutive attempts, so it changes nothing yet.`,
    withdrawnBecause: null,
    lastSeenAt: last.observedAt,
  };
}

function dominant(counts: Map<string, number>): BlockerClass | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best as BlockerClass | null;
}

/**
 * One lesson per signal, from the attempts that did work — and a note on how
 * many attempts on that signal were set aside for doing none.
 */
function signalLessons(dives: OutcomeRecord[]): Lesson[] {
  const bySignal = new Map<string, OutcomeRecord[]>();
  for (const outcome of dives) {
    const signal = outcome.conditions['signal'];
    if (typeof signal !== 'string' || !signal) continue;
    const list = bySignal.get(signal) ?? [];
    list.push(outcome);
    bySignal.set(signal, list);
  }
  const out: Lesson[] = [];
  for (const [signal, all] of [...bySignal.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const settled = all.filter((outcome) => outcome.result !== 'ONGOING' && outcome.result !== 'UNKNOWN');
    const worked = settled.filter((outcome) => outcome.workPerformed);
    const setAside = settled.length - worked.length;
    if (worked.length === 0) {
      if (setAside === 0) continue;
      out.push({
        key: signalLessonKey(signal),
        approach: 'CASH_DEEP_DIVE',
        kind: 'SUBJECT',
        level: 'ANECDOTE',
        status: 'BELOW_FLOOR',
        statement:
          `${setAside} deep dive(s) on ${signal} openings ended, and none of them performed ` +
          'research, so there is no evidence at all about how this kind of opening qualifies.',
        scope: { approach: 'CASH_DEEP_DIVE', signal },
        outcomeIds: [],
        independent: 0,
        independenceRule: 'Only attempts that performed research count as evidence about a subject.',
        fingerprint: fingerprintOf([]),
        changes: null,
        effect:
          `Changes nothing. Reading ${setAside} failure(s) as "${signal} openings do not ` +
          'qualify" would be learning about the openings from attempts that never looked at them.',
        withdrawnBecause: null,
        lastSeenAt: settled[settled.length - 1]?.observedAt ?? null,
      });
      continue;
    }
    const sources = new Set(
      worked.map((outcome) => String(outcome.conditions['sourceOrchestrationId'] ?? outcome.subjectId)),
    );
    const independent = sources.size;
    const succeeded = worked.filter((outcome) => outcome.result === 'SUCCEEDED').length;
    const allShort = succeeded === 0;
    const pattern = independent >= PATTERN_FLOOR;
    const active = pattern && allShort;
    out.push({
      key: signalLessonKey(signal),
      approach: 'CASH_DEEP_DIVE',
      kind: 'SUBJECT',
      level: pattern ? 'PATTERN' : 'ANECDOTE',
      status: active ? 'ACTIVE' : 'BELOW_FLOOR',
      statement:
        `${worked.length} deep dive(s) on ${signal} openings performed research; ${succeeded} ` +
        `established who pays. They come from ${independent} independent source packet(s)` +
        (setAside > 0 ? `, and ${setAside} more were set aside for performing no research.` : '.'),
      scope: { approach: 'CASH_DEEP_DIVE', signal },
      outcomeIds: worked.map((outcome) => outcome.id),
      independent,
      independenceRule:
        'Openings found by the same discovery packet count once: they are one finding about one ' +
        'market, researched twice.',
      fingerprint: fingerprintOf(worked.map((outcome) => outcome.id)),
      changes: active ? 'CASH_DEEP_DIVE_ORDER' : null,
      effect: active
        ? `Queue ${signal} openings after openings of other kinds. They are not refused and they ` +
          'keep their place among themselves.'
        : pattern
          ? 'At least one of these established a payer, so there is nothing to act on.'
          : `Only ${independent} independent observation(s), below the floor of ${PATTERN_FLOOR}; ` +
            'reported so it can be read, and it changes nothing.',
      withdrawnBecause: null,
      lastSeenAt: worked[worked.length - 1]?.observedAt ?? null,
    });
  }
  return out;
}
