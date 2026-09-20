/**
 * Opening the kernel's questions, and absorbing what comes back.
 *
 * ---------------------------------------------------------------------------
 * This is an entrance, not a pipeline
 * ---------------------------------------------------------------------------
 *
 * Nothing here researches anything. It creates a Russell candidate and lets
 * the path that already exists do all of it: `judgeCandidate` asks the archive
 * first (§13), the compiler writes the specification, the approval envelope
 * decides whether it may start, the evidence gate decides what may be claimed,
 * and all three audit roles decide whether it stands. Everything this kernel
 * adds is a new way *in* to machinery Steps 4 to 12C already built.
 *
 * ---------------------------------------------------------------------------
 * Absorbing is a lookup, never a reading
 * ---------------------------------------------------------------------------
 *
 * Every row this writes comes from a claim that cleared the gate and carries a
 * declaration from a closed set. Nothing here inspects a sentence, infers that
 * a job sounds like it needs a person, or decides that a rate is probably per
 * hour. That is §8 at the table that decides whether somebody is employed, and
 * it is the reason this map can be trusted to be about published reality
 * rather than about what a model expected a job to be like.
 *
 * ---------------------------------------------------------------------------
 * Three of the six reasons answer nothing, and that is the point
 * ---------------------------------------------------------------------------
 *
 * `questionAnsweredBy` returns null for `EXPERT_JUDGMENT`,
 * `EXCEPTION_HANDLING` and `OVERSIGHT_VERIFICATION`, because no published
 * source about an industry can settle one of them. A trade body can tell you a
 * notary must sign; it cannot tell you whether *this* Brain verifies its own
 * output well enough. Those findings are recorded as evidence on their claims
 * and move no question, which is a refusal rather than a gap.
 */
import { recordEvent } from '../../repos/events.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { listMissions } from '../../repos/russellMissions.ts';
import { laborClaims } from '../../repos/research.ts';
import {
  closeLaborRound,
  openLaborRound,
  openLaborRoundsByCandidate,
  recordMarketOption,
  recordNecessityAnswer,
} from '../../repos/labor.ts';
import {
  isHumanNecessityReason,
  isLaborChannel,
  isRateBasis,
  questionAnsweredBy,
} from '../../domain/labor.ts';
import {
  contextFor,
  marketQuestion,
  marketTitle,
  necessityQuestion,
  necessityTitle,
  precedentQuestion,
  precedentTitle,
  type QuestionSubject,
} from './questions.ts';
import type { Ask } from './allocate.ts';
import type { LaborSnapshot } from './map.ts';
import type {
  LaborMarketOption,
  LaborNecessityAnswer,
  LaborRound,
  LaborRoundPurpose,
  ResearchClaim,
} from '../../domain/types.ts';

const OPENED = 'LABOR_ROUND_OPENED';
const ABSORBED = 'LABOR_FINDINGS_ABSORBED';

export interface OpenedRound {
  roundId: string;
  taskId: string;
  purpose: LaborRoundPurpose;
  candidateId: string;
  round: number;
  question: string;
  why: string;
}

/**
 * Turn the allocator's decisions into work.
 *
 * The round is written *after* the candidate and the insert is
 * `ON CONFLICT DO NOTHING`, so a tick that dies between the two leaves a
 * candidate nothing points at — harmless, because the next tick's insert
 * collides on the same key and the orphan is never asked anything. The shape
 * `openRound` and `openAsks` already have, for the same reason.
 */
export async function openAsks(input: {
  projectId: string;
  asks: readonly Ask[];
  snapshot: LaborSnapshot;
}): Promise<OpenedRound[]> {
  const byTask = new Map(input.snapshot.coverage.map((one) => [one.task.id, one]));
  const out: OpenedRound[] = [];

  for (const ask of input.asks) {
    const coverage = byTask.get(ask.taskId);
    if (!coverage) continue;

    const subject: QuestionSubject = {
      workflow: coverage.workflow.name,
      task: coverage.task.name,
      output: coverage.task.output,
    };
    const context = contextFor({ workflow: coverage.workflow.name });
    const composed = compose(ask.purpose, subject, context, ask.round);

    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title: ask.round === 1 ? composed.title : `${composed.title} (round ${ask.round})`,
      statement: composed.question,
    });

    const opened = await openLaborRound({
      projectId: input.projectId,
      taskId: ask.taskId,
      purpose: ask.purpose,
      round: ask.round,
      candidateId: candidate.id,
    });
    if (!opened.created) continue;

    await recordEvent({
      projectId: input.projectId,
      entityType: 'labor_task',
      entityId: ask.taskId,
      eventType: OPENED,
      payload: {
        roundId: opened.round.id,
        purpose: ask.purpose,
        candidateId: candidate.id,
        round: ask.round,
        subject: ask.subject,
        /*
         * The allocator's own reason, recorded beside the work it produced.
         *
         * The allocator is pure over a snapshot that has since moved, so this
         * is that promise kept: "why did Brain research this" resolves to a
         * sentence written at the moment it was decided rather than to a
         * re-run against a different database.
         */
        why: ask.why,
        rank: ask.rank,
      },
    });

    out.push({
      roundId: opened.round.id,
      taskId: ask.taskId,
      purpose: ask.purpose,
      candidateId: candidate.id,
      round: ask.round,
      question: composed.question,
      why: ask.why,
    });
  }
  return out;
}

function compose(
  purpose: LaborRoundPurpose,
  subject: QuestionSubject,
  context: string,
  round: number,
): { title: string; question: string } {
  if (purpose === 'NECESSITY') {
    return {
      title: necessityTitle(subject),
      question: necessityQuestion({ subject, context, round }),
    };
  }
  if (purpose === 'MARKET') {
    return { title: marketTitle(subject), question: marketQuestion({ subject, context, round }) };
  }
  return {
    title: precedentTitle(subject),
    question: precedentQuestion({ subject, context, round }),
  };
}

export interface Absorbed {
  answers: LaborNecessityAnswer[];
  options: LaborMarketOption[];
  /** Rounds settled this pass, with what each one produced. */
  settled: { roundId: string; found: number }[];
  /** Declarations that could not be filed, and why. Reported, never guessed. */
  refused: { claimId: string; why: string }[];
}

/**
 * File what the kernel's questions established.
 *
 * Not gated by anything the sprint does, deliberately and for the reason
 * `harvest` and `absorb` are not: filing what research already found is not
 * new discovery — the spending happened when it ran — and dropping results
 * because something wound down would throw away work already paid for.
 */
export async function absorb(input: {
  projectId: string;
  limit?: number;
}): Promise<Absorbed> {
  const out: Absorbed = { answers: [], options: [], settled: [], refused: [] };

  const limit = Math.max(1, input.limit ?? 60);
  const live = await openLaborRoundsByCandidate(input.projectId);
  if (live.size === 0) return out;

  /*
   * Which round each orchestration belongs to.
   *
   * Through the mission, exactly as `harvest` and the industry kernel do it,
   * because a mission is what links a round's candidate to the orchestration
   * it launched. An orchestration with no mission belongs to no labor round,
   * which is honest rather than a gap: nobody asked a labor question for it,
   * and absorbing its claims would answer a necessity question about a task
   * nothing chose.
   */
  const missions = await listMissions({ projectId: input.projectId });
  const byOrchestration = new Map<
    string,
    { round: LaborRound; settles: 'HARVESTED' | 'ABANDONED' | null }
  >();
  for (const mission of missions) {
    if (!mission.orchestrationId || !mission.candidateId) continue;
    const round = live.get(mission.candidateId);
    if (round) {
      byOrchestration.set(mission.orchestrationId, {
        round,
        /*
         * A round settles on *any* terminal mission, not only a successful one.
         *
         * A mission that failed or was cancelled has answered this question as
         * far as it is going to, and a round left OPEN is precisely what stops
         * that purpose being asked again — for ever, since nothing else will
         * ever close it. §24's *waiting nobody can resolve*, arriving through
         * a table nobody would think to look at. The two outcomes stay
         * distinct, because "it ran and found nothing" and "it never finished"
         * have different remedies and the allocator's barren rule reads the
         * first.
         */
        settles:
          mission.state === 'DONE'
            ? 'HARVESTED'
            : mission.state === 'FAILED' || mission.state === 'CANCELLED'
              ? 'ABANDONED'
              : null,
      });
    }
  }
  if (byOrchestration.size === 0) return out;

  const foundPerRound = new Map<string, number>();

  const claims = await laborClaims({
    projectId: input.projectId,
    orchestrationIds: [...byOrchestration.keys()],
    limit,
  });
  for (const entry of claims) {
    const context = byOrchestration.get(entry.orchestrationId);
    if (!context) continue;
    const filed = await file({
      projectId: input.projectId,
      claim: entry.claim,
      round: context.round,
      out,
    });
    if (filed) {
      foundPerRound.set(context.round.id, (foundPerRound.get(context.round.id) ?? 0) + 1);
    }
  }

  /*
   * A round settles by its own bookkeeping rather than by the loop ending.
   *
   * `found` is what the next round is decided against, so a round whose
   * mission has finished has to record what it produced — **including
   * nothing**. Leaving a barren round OPEN would stop it ever being asked
   * again while looking like it was still running, which is the state this
   * kernel is built to make impossible.
   */
  for (const { round, settles } of byOrchestration.values()) {
    if (!settles) continue;
    const found = foundPerRound.get(round.id) ?? 0;
    if (await closeLaborRound({ id: round.id, to: settles, found })) {
      out.settled.push({ roundId: round.id, found });
    }
  }

  if (out.answers.length + out.options.length > 0) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'labor_kernel',
      eventType: ABSORBED,
      payload: {
        answers: out.answers.length,
        options: out.options.length,
        answerIds: out.answers.map((one) => one.id),
        optionIds: out.options.map((one) => one.id),
        // What could not be filed, kept beside what could. A refusal that went
        // nowhere would make a barren round and a refused one read the same.
        refused: out.refused,
      },
    });
  }
  return out;
}

/**
 * One declared finding into the one place its kind belongs.
 *
 * Every branch refuses rather than improvises. A finding whose subject is not
 * in the vocabulary is *reported* as refused rather than filed under the
 * nearest plausible value — filing it would be Brain deciding which of six
 * reasons somebody meant, which is the confidently wrong answer §25 records at
 * the column that decides whether a person is needed.
 */
async function file(input: {
  projectId: string;
  claim: ResearchClaim;
  round: LaborRound;
  out: Absorbed;
}): Promise<boolean> {
  const { claim, round, out } = input;
  const finding = claim.laborFinding;
  const subject = claim.laborSubject;
  if (!finding || !subject) return false;

  if (finding === 'HUMAN_REQUIREMENT') {
    if (!isHumanNecessityReason(subject)) {
      out.refused.push({
        claimId: claim.id,
        why: `"${subject}" is not one of the six reasons Brain records a human role under.`,
      });
      return false;
    }
    const question = questionAnsweredBy(subject);
    if (!question) {
      /*
       * A real finding that moves nothing, and saying so is the honest
       * outcome. `EXPERT_JUDGMENT`, `EXCEPTION_HANDLING` and
       * `OVERSIGHT_VERIFICATION` are statements about this operation's
       * confidence in its own Brain, and a published source about an industry
       * has no standing to settle one. It stays as evidence on its claim.
       */
      out.refused.push({
        claimId: claim.id,
        why:
          `It establishes a ${subject} reason, which is a judgement about this operation rather ` +
          'than a fact a published source can settle. It stays as evidence on its claim and ' +
          'answers no question automatically.',
      });
      return false;
    }
    const recorded = await recordNecessityAnswer({
      projectId: input.projectId,
      taskId: round.taskId,
      question,
      /*
       * A requirement establishing a person is needed answers YES to the
       * question it maps to. There is no branch here that could write NO from
       * a HUMAN_REQUIREMENT, because the finding means what it says — and a
       * negative is established by a *negative claim* naming what was
       * searched, which the assignment asks for and which arrives carrying no
       * labor finding at all.
       */
      answer: 'YES',
      basis: 'RESEARCHED',
      statement: claim.claim,
      sourceClaimId: claim.id,
    });
    if (recorded) {
      out.answers.push(recorded);
      return true;
    }
    return false;
  }

  if (!isLaborChannel(subject)) {
    out.refused.push({
      claimId: claim.id,
      why: `"${subject}" is not one of the sourcing channels Brain records.`,
    });
    return false;
  }

  const basis = claim.laborQualifier;
  if (claim.laborRateCents !== null && !isRateBasis(basis)) {
    // The validator refuses this at both doors, so reaching it means a row
    // predating the rule. Refused rather than filed with a null basis, because
    // a figure nobody can compare is worse than no figure.
    out.refused.push({
      claimId: claim.id,
      why: 'It carries a rate with no basis, so the figure compares to nothing.',
    });
    return false;
  }

  const recorded = await recordMarketOption({
    projectId: input.projectId,
    taskId: round.taskId,
    channel: subject,
    // The scope the claim itself declared, never one read out of its sentence.
    jurisdiction: claim.geography,
    rateCents: claim.laborRateCents,
    rateBasis: isRateBasis(basis) ? basis : null,
    statement: claim.claim,
    sourceClaimId: claim.id,
  });
  if (recorded) {
    out.options.push(recorded);
    return true;
  }
  return false;
}
