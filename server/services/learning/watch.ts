/**
 * Rechecking the facts a live goal depends on, and saying when one moves.
 *
 * A sprint's decisions rest on a handful of facts that can change underneath
 * it without any of its own rows moving: the research grant it runs under,
 * whether any execution surface can run work at all, and whether the lesson
 * currently narrowing its launches still holds. Each is a watch — a cursor on
 * one fact — and when a read differs from the cursor Brain records what
 * changed and what it proposes to do about it, in words a person reads in
 * Russell's briefing.
 *
 * Three rules keep it honest:
 *
 * * **A watch reads; it never acts.** What Brain *does* about a change is
 *   decided where that decision already lives (`advise.ts` for launching, the
 *   sprint's own lifecycle for the grant). The proposal sentence says what that
 *   machinery will now do, so the words and the behaviour are one fact.
 * * **The cursor moves by compare-and-swap on the value it was read at**, so two
 *   ticks that both see a change record it once.
 * * **Material, not noisy.** Surfaces are watched as SOME or NONE rather than as
 *   a count, because a count that moves every tick is a change nobody should be
 *   told about; whether *anything* can run is the fact a decision turns on.
 */
import { getCashMode } from '../../repos/cashMode.ts';
import {
  advanceWatch,
  ensureWatch,
  listCorrections,
  listOutcomes,
  recordWatchChange,
  touchWatch,
  type OutcomeWatchChange,
} from '../../repos/learning.ts';
import { discoveryAuthority } from '../cash/discoveryAuthority.ts';
import { capacityReading } from '../fleet/capacity.ts';
import { STREAK_LESSON_KEY, deriveLessons } from './lessons.ts';
import type { WatchFact } from '../../domain/learning.ts';

interface Reading {
  fact: WatchFact;
  ref: string;
  why: string;
  value: string;
  /** The value this fact holds when nothing needs saying. */
  baseline: string;
  describe: (from: string | null, to: string) => { whatChanged: string; proposal: string };
}

async function readings(projectId: string): Promise<Reading[]> {
  const grant = await discoveryAuthority(projectId);
  let surfaces = 'UNREADABLE';
  try {
    surfaces = (await capacityReading()).eligibleNow > 0 ? 'SOME' : 'NONE';
  } catch {
    surfaces = 'UNREADABLE';
  }
  const lessons = deriveLessons({
    outcomes: await listOutcomes(projectId, 'CASH_DEEP_DIVE'),
    corrections: await listCorrections(projectId),
  });
  const streak = lessons.find((lesson) => lesson.key === STREAK_LESSON_KEY) ?? null;

  return [
    {
      fact: 'RESEARCH_GRANT',
      ref: projectId,
      why: 'Every deep dive and every discovery round in this sprint runs under it.',
      value: grant ? 'LIVE' : 'ABSENT',
      baseline: 'LIVE',
      describe: (from, to) =>
        to === 'LIVE'
          ? {
              whatChanged: 'The research grant this sprint runs under is live again.',
              proposal: 'Brain resumes starting deep dives and discovery rounds on the next tick.',
            }
          : {
              whatChanged: `The research grant this sprint runs under is ${to.toLowerCase()} (was ${from ?? 'not yet read'}).`,
              proposal:
                'Brain starts no new deep dive or discovery round; the ones already running are ' +
                'left to finish, and their answers still land. Restarting the sprint restores it.',
            },
    },
    {
      fact: 'HEALTHY_SURFACES',
      ref: 'fleet',
      why: 'A deep dive launched while no surface can run work waits, and counts against its stall window.',
      value: surfaces,
      baseline: 'SOME',
      describe: (from, to) =>
        to === 'SOME'
          ? {
              whatChanged: 'At least one execution surface can run work again.',
              proposal: 'Queued research can be picked up; nothing needs to be restarted.',
            }
          : {
              whatChanged:
                to === 'NONE'
                  ? `No execution surface can run work right now (was ${from ?? 'not yet read'}).`
                  : 'Brain could not read the fleet, so it cannot say whether anything can run.',
              proposal:
                'Dives already out will wait rather than run, and any that stall meanwhile are ' +
                'recorded as never attempted — evidence about the conditions, never about their ' +
                'openings. Brain proposes fixing the fleet first; the People & capacity page ' +
                'names which surface and why.',
            },
    },
    {
      fact: 'ACTIVE_LESSON',
      ref: STREAK_LESSON_KEY,
      why: 'While it holds, Brain launches one probe dive at a time instead of filling every slot.',
      value: streak?.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
      baseline: 'INACTIVE',
      describe: (_from, to) =>
        to === 'ACTIVE'
          ? {
              whatChanged: streak?.statement ?? 'Recent deep dives stopped before any research.',
              proposal:
                'Brain now launches one probe dive at a time rather than two, and proposes fixing ' +
                'the recurring blocker (see Learning: missing capabilities) so the dives can run.',
            }
          : {
              whatChanged:
                'The run of deep dives that never reached research has ended: the most recent ' +
                'settled dive performed research, or a person withdrew the lesson.',
              proposal: 'Brain resumes filling every free slot with deep dives on the next tick.',
            },
    },
  ];
}

/** One pass over one project's watches. Returns the changes it recorded. */
export async function checkWatches(projectId: string): Promise<OutcomeWatchChange[]> {
  if (!(await getCashMode(projectId))) return [];
  const out: OutcomeWatchChange[] = [];
  for (const reading of await readings(projectId)) {
    const watch = await ensureWatch({
      projectId,
      fact: reading.fact,
      factRef: reading.ref,
      why: reading.why,
    });
    if (watch.lastValue === reading.value) {
      await touchWatch(watch.id);
      continue;
    }
    // The first reading is a change only if it is already away from baseline:
    // a sprint whose grant is live on the first read has nothing to report.
    const worthSaying = watch.lastValue !== null || reading.value !== reading.baseline;
    const moved = await advanceWatch({ watchId: watch.id, from: watch.lastValue, to: reading.value });
    if (!moved || !worthSaying) continue;
    const { whatChanged, proposal } = reading.describe(watch.lastValue, reading.value);
    out.push(
      await recordWatchChange({
        watchId: watch.id,
        projectId,
        fromValue: watch.lastValue,
        toValue: reading.value,
        whatChanged,
        proposal,
        observedAt: new Date().toISOString(),
      }),
    );
  }
  return out;
}
