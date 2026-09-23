/**
 * Where an outcome changes a decision.
 *
 * This is the whole of the "learning changes behaviour" path, and it is small
 * on purpose. `startValidations` asks two questions before it launches deep
 * dives — how many, and in what order — and this module answers both from the
 * lessons `lessons.ts` derives. Every answer that differs from what Brain would
 * have done without the lesson is written to `outcome_decisions` with what the
 * default was, what was chosen instead, the lesson, and the exact outcome ids
 * it rested on. A decision that used a lesson a person later withdrew can
 * therefore be found, and the next decision after the withdrawal stops using it.
 *
 * ---------------------------------------------------------------------------
 * Repeat, revise or stop
 * ---------------------------------------------------------------------------
 *
 * When the last attempts never reached research, filling every slot again is
 * *repeating* an approach that is failing for a reason that is not about the
 * work. Stopping outright would be wrong in the other direction: nothing would
 * ever find out that the condition had cleared. So Brain *revises* — one probe
 * at a time, and a new probe only when something could have changed: the Brain
 * serving is a different revision, or a day has passed since the last probe.
 * The first probe that reaches research ends the lesson and full launching
 * resumes by itself.
 */
import { listCorrections, listDecisions, listOutcomes, recordDecision } from '../../repos/learning.ts';
import {
  STREAK_LESSON_KEY,
  deriveLessons,
  type Lesson,
} from './lessons.ts';
import type { CashOpportunity } from '../../domain/types.ts';

/** How long a failed probe is left alone when nothing about Brain has changed. */
export const PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The revision this process is serving, as the deploy stamped it. */
export function servingRevision(): string {
  return process.env['BRAIN_REVISION']?.trim() || 'unrecorded';
}

export interface LaunchAdvice {
  /** At most this many dives may start this pass. */
  cap: number;
  /** The order to consider openings in. */
  ordered: CashOpportunity[];
  /** Decision rows written, one per lesson that changed something. */
  decisionIds: string[];
  /** The decision a probe launch belongs to, for its prediction. */
  probeDecisionId: string | null;
  /** The sentence for a person: what Brain did and why. */
  explanation: string | null;
  lessons: Lesson[];
}

export async function adviseDeepDiveLaunch(input: {
  projectId: string;
  /** What `startValidations` would launch without any lesson. */
  defaultCap: number;
  /** Dives currently holding a slot. */
  slotsHeld: number;
  ordered: CashOpportunity[];
  now?: Date;
}): Promise<LaunchAdvice> {
  const now = input.now ?? new Date();
  const [outcomes, corrections] = await Promise.all([
    listOutcomes(input.projectId, 'CASH_DEEP_DIVE'),
    listCorrections(input.projectId),
  ]);
  const lessons = deriveLessons({ outcomes, corrections });
  const decisionIds: string[] = [];
  let explanation: string | null = null;

  // Which opening goes first: subject lessons move a kind later, never out.
  let ordered = input.ordered;
  const demote = lessons.filter(
    (lesson) => lesson.status === 'ACTIVE' && lesson.changes === 'CASH_DEEP_DIVE_ORDER',
  );
  if (demote.length > 0 && ordered.length > 1) {
    const signals = new Set(demote.map((lesson) => String(lesson.scope['signal'])));
    const neverDived = ordered.filter((one) => one.validationState === null);
    const rest = ordered.filter((one) => one.validationState !== null);
    const reordered = [
      ...neverDived.filter((one) => !signals.has(one.opportunitySignal ?? '')),
      ...neverDived.filter((one) => signals.has(one.opportunitySignal ?? '')),
      ...rest,
    ];
    if (reordered[0]?.id !== ordered[0]?.id) {
      for (const lesson of demote) {
        const { decision } = await recordDecision({
          projectId: input.projectId,
          decision: 'CASH_DEEP_DIVE_ORDER',
          subjectId: input.projectId,
          defaultChoice: `first: ${ordered[0]?.id ?? '—'}`,
          chosen: `first: ${reordered[0]?.id ?? '—'}`,
          lessonKey: lesson.key,
          lessonFingerprint: lesson.fingerprint,
          outcomeIds: lesson.outcomeIds,
          reason: `${lesson.statement} ${lesson.effect}`,
        });
        decisionIds.push(decision.id);
      }
    }
    ordered = reordered;
  }

  // How many: a conditions lesson replaces full slots with one probe.
  const streak = lessons.find(
    (lesson) => lesson.key === STREAK_LESSON_KEY && lesson.status === 'ACTIVE',
  );
  if (!streak || input.defaultCap <= 0) {
    return { cap: input.defaultCap, ordered, decisionIds, probeDecisionId: null, explanation, lessons };
  }

  const revision = servingRevision();
  const priorProbes = (await listDecisions(input.projectId))
    .filter((row) => row.decision === 'CASH_DEEP_DIVE_LAUNCH' && row.chosen.startsWith('PROBE'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const lastProbe = priorProbes[priorProbes.length - 1] ?? null;
  const lastProbeAt = lastProbe ? Date.parse(lastProbe.createdAt) : null;
  const sameRevision = lastProbe ? String(lastProbe.context['revision'] ?? '') === revision : false;
  const dueAt = lastProbeAt !== null ? new Date(lastProbeAt + PROBE_INTERVAL_MS) : null;

  let cap: number;
  let chosen: string;
  if (input.slotsHeld > 0) {
    cap = 0;
    chosen = 'WAIT: a dive is already out';
    explanation =
      `${streak.statement} So Brain launches one dive at a time, and one is already out; ` +
      `without this lesson it would have started ${input.defaultCap} more now.`;
  } else if (lastProbe && sameRevision && dueAt && dueAt.getTime() > now.getTime()) {
    cap = 0;
    chosen = `WAIT: next probe due ${dueAt.toISOString()} or on a new revision`;
    explanation =
      `${streak.statement} The last probe went out at ${lastProbe.createdAt} under this same ` +
      `revision (${revision}) and failed the same way, so repeating it now would learn nothing. ` +
      `The next probe is due at ${dueAt.toISOString()}, or sooner if a new revision is deployed.`;
  } else {
    cap = 1;
    // Which opening the probe goes to is decided by the launcher's own
    // eligibility check, after this; the prediction it writes carries this
    // decision's id and names the subject, so the trace joins on rows rather
    // than on a guess made here.
    chosen = 'PROBE: launch 1';
    explanation =
      `${streak.statement} So Brain is sending one probe instead of ${input.defaultCap} dives, ` +
      'to find out whether the condition has cleared.';
  }
  if (cap >= input.defaultCap) {
    return { cap: input.defaultCap, ordered, decisionIds, probeDecisionId: null, explanation: null, lessons };
  }
  const { decision } = await recordDecision({
    projectId: input.projectId,
    decision: 'CASH_DEEP_DIVE_LAUNCH',
    subjectId: input.projectId,
    defaultChoice: `launch ${input.defaultCap}`,
    chosen,
    lessonKey: streak.key,
    lessonFingerprint: streak.fingerprint,
    outcomeIds: streak.outcomeIds,
    reason: explanation ?? streak.statement,
    context: { revision, slotsHeld: input.slotsHeld, defaultCap: input.defaultCap },
  });
  decisionIds.push(decision.id);
  return {
    cap,
    ordered,
    decisionIds,
    probeDecisionId: chosen.startsWith('PROBE') ? decision.id : null,
    explanation,
    lessons,
  };
}
