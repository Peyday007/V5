/**
 * Turning a capability gap into research, and knowing when to stop.
 *
 * ---------------------------------------------------------------------------
 * Brain owns the agenda; a Routine is replaceable capacity
 * ---------------------------------------------------------------------------
 *
 * The question this module answers is *what does Brain not know that would
 * change what it builds* — and that is Brain's question, decided from the
 * packet's own gaps and the archive's own claims. What a Routine does is
 * research one bounded question it was handed. Nothing here asks a worker what
 * to research next, and nothing here lets a worker's answer widen the agenda.
 *
 * ---------------------------------------------------------------------------
 * The archive first, for §13's reason
 * ---------------------------------------------------------------------------
 *
 * The default is **not** to research. A gap is a question about the world only
 * after `coverBeforeWork` has been asked whether the Brain already answers it,
 * and that check is the same one every other mission goes through — reused
 * whole rather than reimplemented, because a second copy of the archive check
 * would eventually disagree with the first about what counts as answered.
 *
 * Researching something the archive already settles spends the allowance to
 * learn what Brain knew, which is the same waste as never reading the archive.
 *
 * ---------------------------------------------------------------------------
 * A gap that is not research is reported as such
 * ---------------------------------------------------------------------------
 *
 * Most realization gaps are not research questions at all. `MUST_BE_BUILT` is
 * implementation, `REQUIRES_PERSON_AUTHORITY` is a decision, and
 * `EXISTS_BUT_DISCONNECTED` is wiring. Turning any of those into a research
 * mission would spend the fleet on a question whose answer is already known and
 * whose remedy is somebody doing something else. Only `MUST_BE_RESEARCHED`
 * becomes a question, and `NEEDS_A_READING` becomes a *reading* — which is a
 * different and much cheaper thing, and is the one this kernel produces most of.
 *
 * ---------------------------------------------------------------------------
 * Stopping is a decision with a recorded reason
 * ---------------------------------------------------------------------------
 *
 * `decisionReadiness` is the blueprint's own stopping condition made checkable,
 * and it reports every clause rather than a verdict. "More research would not
 * change what we build" and "we have run out of things we know how to ask" are
 * different reasons to stop, and a packet that recorded only *that* it stopped
 * would send the next reader to the wrong question.
 */
import { coverBeforeWork, explainCoverage, type PreMissionCoverage } from '../russell/coverage.ts';
import { getFaculty } from '../../repos/faculties.ts';
import { listComponents } from '../selfmodel/scan.ts';
import { getPacket, listGaps, setGapState, type PacketGap } from './packet.ts';
import type { GapKind } from './gaps.ts';

/**
 * Which gap kinds are a question about the world.
 *
 * Exactly one. The others are all real gaps with real remedies, and none of
 * those remedies is research — which is §13's "a gap that is real but is not
 * research is reported as such and never becomes a fragment", applied to a
 * capability rather than to a goal.
 */
export const RESEARCHABLE: readonly GapKind[] = ['MUST_BE_RESEARCHED'];

/** What a gap that is not research actually needs, in one word each. */
export const REMEDY: Record<GapKind, string> = {
  EXISTS_AND_LIVE: 'nothing — it is already serving this requirement',
  EXISTS_BUT_DISCONNECTED: 'wiring: the component exists and nothing reaches it',
  EXISTS_BUT_INSUFFICIENT: 'a change to something that already exists',
  MUST_BE_BUILT: 'implementation, through the Factory',
  MUST_BE_REPLACED: 'implementation, replacing something that already exists',
  MUST_BE_RESEARCHED: 'research: Brain does not know the answer and cannot read it from itself',
  REQUIRES_PERSON_AUTHORITY: "a person's decision, which no amount of building answers",
  NEEDS_A_READING: 'a reading: somebody compares the requirement against the component',
};

export interface CapabilityQuestion {
  gapId: string;
  key: string;
  /** The question, in the requirement's own words plus what makes it decidable. */
  statement: string;
  aspect: string;
  /** What the answer would change. A question that changes nothing is not asked. */
  decides: string;
  completionCriteria: string[];
}

/**
 * Compose one bounded question from one gap.
 *
 * Composed from the packet's own rows — the faculty, the exact requirement, the
 * aspect it came from and what the self-model said — rather than from a
 * template with the gap pasted into it. The difference matters because the
 * *decides* clause is what makes a question worth asking: a research question
 * whose answer changes nothing is the waste §13 exists to prevent, and it can
 * only be written from the gap's own classification.
 *
 * Deliberately short. §12's rule — never send a whole transcript to a provider
 * — is the same rule as never pasting one giant research prompt into every
 * Routine, and the subject here is a row the worker reads through a scoped tool
 * rather than a payload.
 */
export function questionFor(
  gap: PacketGap,
  faculty: { slug: string; canonicalName: string },
): CapabilityQuestion {
  return {
    gapId: gap.id,
    key: `${faculty.slug.toLowerCase()}-${gap.aspect}-${gap.id.slice(-8)}`,
    statement:
      `For ${faculty.canonicalName}, establish from published sources what would satisfy this ` +
      `requirement: "${gap.requirement}". ` +
      `Brain's own reading of itself found: ${gap.evidence}`,
    aspect: gap.aspect,
    decides:
      'Whether this requirement can be served by something that already exists, and if not, ' +
      'what a bounded implementation of it would have to do. The answer decides whether a ' +
      'change request is made at all and what it asks for.',
    completionCriteria: [
      'a named, citable approach with a source that states it',
      'what it would cost to adopt, in the terms the source uses',
      'what it would not solve, stated rather than implied',
    ],
  };
}

export interface DirectorPass {
  packetId: string;
  /** Gaps that are a question about the world at all. */
  researchable: number;
  /** Of those, the ones the archive already settles. */
  alreadyAnswered: number;
  /** Of those, the ones that are a genuine external-research gap. */
  questions: CapabilityQuestion[];
  /** Gaps that are real and are not research, with what each actually needs. */
  notResearch: Array<{ gapId: string; kind: GapKind; remedy: string }>;
  coverage: PreMissionCoverage | null;
  explanation: string;
}

/**
 * What this packet should research next, if anything.
 *
 * Read-only: it creates no mission, spends nothing and moves no state except
 * marking a gap the archive settled as closed. That last one is a write and is
 * worth being explicit about — it is recording that a question was *answered*,
 * from claims that already existed, which is the cheapest possible outcome and
 * the one §13 says should be the default.
 */
export async function directorPass(input: {
  packetId: string;
  projectId: string;
  layerId: string;
}): Promise<DirectorPass> {
  const packet = await getPacket(input.packetId);
  if (!packet) throw new Error(`No such packet: ${input.packetId}`);
  const faculty = await getFaculty(packet.facultyId);
  if (!faculty) throw new Error(`Packet ${input.packetId} names a faculty that does not exist.`);

  const open = await listGaps(input.packetId, { states: ['OPEN'] });

  const notResearch = open
    .filter((gap) => !RESEARCHABLE.includes(gap.kind))
    .map((gap) => ({ gapId: gap.id, kind: gap.kind, remedy: REMEDY[gap.kind] }));

  const researchable = open.filter((gap) => RESEARCHABLE.includes(gap.kind));
  if (researchable.length === 0) {
    return {
      packetId: input.packetId,
      researchable: 0,
      alreadyAnswered: 0,
      questions: [],
      notResearch,
      coverage: null,
      explanation:
        notResearch.length === 0
          ? 'Every gap on this packet is closed or waived, so there is nothing to research.'
          : `Nothing here is a question about the world. ${notResearch.length} gap(s) are real ` +
            'and need something other than research.',
    };
  }

  const questions = researchable.map((gap) => questionFor(gap, faculty));

  /*
   * The archive, before anything is spent.
   *
   * `coverBeforeWork` is reused whole rather than reimplemented. A second copy
   * of the archive check would eventually disagree with the first about what
   * counts as answered, and the copy is always the one that goes stale — which
   * is the sentence this repository has had to write about `reconcileRepairs`,
   * `reconcileAcceptedFragment` and `sentences()` already.
   */
  const coverage = await coverBeforeWork({
    projectId: input.projectId,
    layerId: input.layerId,
    requirements: questions.map((question) => ({
      key: question.key,
      statement: question.statement,
      completionCriteria: question.completionCriteria,
    })),
  });

  const answeredKeys = new Set(coverage.answered.map((verdict) => verdict.requirementKey));
  for (const question of questions) {
    if (!answeredKeys.has(question.key)) continue;
    const verdict = coverage.answered.find((row) => row.requirementKey === question.key);
    await setGapState({
      gapId: question.gapId,
      state: 'CLOSED',
      reason:
        'The archive already answers this. ' +
        `${verdict?.reasons.join(' ') ?? ''} ` +
        `Claims: ${verdict?.claimIds.join(', ') ?? 'none recorded'}. ` +
        'Researching it would spend the allowance to learn what Brain already knew.',
    });
  }

  const remaining = questions.filter((question) => !answeredKeys.has(question.key));

  return {
    packetId: input.packetId,
    researchable: researchable.length,
    alreadyAnswered: answeredKeys.size,
    questions: remaining,
    notResearch,
    coverage,
    explanation: explainCoverage(coverage),
  };
}

/* ------------------------------------------------------------------------- */
/* Stopping                                                                   */
/* ------------------------------------------------------------------------- */

export interface StoppingCondition {
  clause: string;
  holds: boolean;
  detail: string;
}

export interface DecisionReadiness {
  decisionReady: boolean;
  conditions: StoppingCondition[];
  /** Why it stopped, in one sentence, whichever way it went. */
  reason: string;
  /** What is left unresolved, named rather than counted. */
  unresolved: string[];
}

/**
 * May the research stop?
 *
 * The blueprint's own stopping condition, made checkable, and every clause is
 * reported whether or not it holds. "More research would not change what we
 * build" and "we have run out of things we know how to ask" are different
 * reasons to stop, and a packet that recorded only *that* it stopped would send
 * the next reader to the wrong question.
 *
 * It never decides that a gap is resolved. It reads gap states, which
 * something else moved, and says what they add up to — so there is no path here
 * through which stopping could be achieved by lowering a bar.
 */
export async function decisionReadiness(packetId: string): Promise<DecisionReadiness> {
  const packet = await getPacket(packetId);
  if (!packet) throw new Error(`No such packet: ${packetId}`);
  const faculty = await getFaculty(packet.facultyId);
  const gaps = await listGaps(packetId);
  const open = gaps.filter((gap) => gap.state === 'OPEN' || gap.state === 'ASSIGNED');

  const stillResearching = open.filter((gap) => RESEARCHABLE.includes(gap.kind));
  const stillUnread = open.filter((gap) => gap.kind === 'NEEDS_A_READING');
  const awaitingPerson = open.filter((gap) => gap.kind === 'REQUIRES_PERSON_AUTHORITY');
  const buildable = open.filter(
    (gap) => gap.kind === 'MUST_BE_BUILT' || gap.kind === 'MUST_BE_REPLACED',
  );

  const conditions: StoppingCondition[] = [
    {
      clause: 'the promised power is explicit',
      holds: Boolean(faculty?.definition.promisedPower),
      detail:
        faculty?.definition.promisedPower ??
        'the faculty records no promised power, so there is nothing to build towards',
    },
    {
      clause: 'every gap has been classified by a reading or a derivation',
      holds: stillUnread.length === 0,
      detail:
        stillUnread.length === 0
          ? 'nothing is waiting on somebody to compare a requirement against a component'
          : `${stillUnread.length} gap(s) still need a reading`,
    },
    {
      clause: 'no question about the world is still outstanding',
      holds: stillResearching.length === 0,
      detail:
        stillResearching.length === 0
          ? 'nothing is waiting on evidence'
          : `${stillResearching.length} question(s) are still open`,
    },
    {
      clause: 'every authority this needs has been granted',
      holds: awaitingPerson.length === 0,
      detail:
        awaitingPerson.length === 0
          ? 'nothing here waits on a decision only a person can make'
          : `${awaitingPerson.length} requirement(s) name an authority nobody has granted`,
    },
    {
      clause: 'there is something to build',
      holds: buildable.length > 0,
      detail:
        buildable.length > 0
          ? `${buildable.length} gap(s) are classified as needing implementation`
          : 'nothing is classified as needing to be built, so a change request would ask for ' +
            'nothing. That is a real outcome: this faculty needs connecting, evaluating or ' +
            'authorising rather than building.',
    },
  ];

  const failed = conditions.filter((condition) => !condition.holds);
  const decisionReady = failed.length === 0;

  return {
    decisionReady,
    conditions,
    reason: decisionReady
      ? 'Every clause of the stopping condition holds: the promise is explicit, nothing is ' +
        'waiting on a reading, evidence or an authority, and there is something to build.'
      : `Not decision-ready: ${failed.map((condition) => condition.clause).join('; ')}.`,
    unresolved: [
      ...stillUnread.map((gap) => `needs a reading: ${gap.requirement}`),
      ...stillResearching.map((gap) => `needs evidence: ${gap.requirement}`),
      ...awaitingPerson.map((gap) => `needs a person: ${gap.requirement}`),
    ],
  };
}

/**
 * A question whose answer arrived and did not settle it.
 *
 * Kept as its own function rather than folded into the pass, because the
 * distinction it draws is the one §12 insists on and the one a caller most
 * easily loses: **retrieval failure is not evidence rejection.** A source
 * nobody could reach leaves the question open and is a reason to look
 * somewhere else; a claim the gate refused leaves it open and is a reason to
 * ask differently. Collapsing them sends the next attempt to repeat the search
 * that already failed.
 */
export function classifyOutcome(input: {
  claimsSubmitted: number;
  claimsAccepted: number;
  unreachableSources: number;
}): { outcome: 'ANSWERED' | 'UNREACHABLE' | 'INSUFFICIENT' | 'NOTHING_SUBMITTED'; detail: string } {
  if (input.claimsAccepted > 0) {
    return {
      outcome: 'ANSWERED',
      detail: `${input.claimsAccepted} claim(s) cleared the gate.`,
    };
  }
  if (input.claimsSubmitted === 0 && input.unreachableSources > 0) {
    return {
      outcome: 'UNREACHABLE',
      detail:
        `${input.unreachableSources} source(s) could not be read. Nothing was rejected: the ` +
        'question is unanswered because nobody could look, which is a reason to look somewhere ' +
        'else rather than to ask differently.',
    };
  }
  if (input.claimsSubmitted === 0) {
    return {
      outcome: 'NOTHING_SUBMITTED',
      detail:
        'No claim was submitted at all. That is not the same as the evidence being refused, and ' +
        'the two have different remedies.',
    };
  }
  return {
    outcome: 'INSUFFICIENT',
    detail:
      `${input.claimsSubmitted} claim(s) were submitted and none cleared the gate. The sources ` +
      'were reachable and what they said did not establish the requirement, which is a reason ' +
      'to ask differently rather than to search again.',
  };
}

/** Every component the self-model holds, for a caller composing a reading task. */
export async function readingContext(): Promise<string[]> {
  return (await listComponents()).map((component) => component.componentKey);
}
