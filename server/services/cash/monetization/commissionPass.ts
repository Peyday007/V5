/**
 * Asking the questions, and taking back the answers.
 *
 * `commission.ts` decides *what* is worth asking and is a pure function over a
 * recorded snapshot. This is the half that writes: it settles what came back,
 * then asks what the allocator chose, in that order and never the other way
 * round.
 *
 * ---------------------------------------------------------------------------
 * Settle first, deliberately
 * ---------------------------------------------------------------------------
 *
 * A commission that finished on the previous pass has an answer to file, and
 * filing it changes what the allocator sees: a possibility that has just had
 * its revenue established should be deciding about its *next* unknown on this
 * pass rather than on the next one, and the slot it was holding should be free
 * now. Allocating first would make every answer a tick late, for ever —
 * `runIndustryKernel` records the identical ordering for the identical reason.
 *
 * ---------------------------------------------------------------------------
 * Opening is gated by the wind-down. Settling never is.
 * ---------------------------------------------------------------------------
 *
 * Asking a new question is new work, so it stops when somebody winds the sprint
 * down. Taking back the answer to a question already asked is **not**: that
 * activation was already spent, and dropping its result would throw away work
 * already paid for. §30 draws this line for discovery and for the deep dive;
 * this is the same line, at a third question.
 */
import { notWorthResearching } from '../worthResearching.ts';
import { cashPosition } from '../money.ts';
import { cashNow, getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import { createCandidate } from '../../../repos/russellCandidates.ts';
import { latestMissionForCandidate } from '../../../repos/russellMissions.ts';
import { missionsForRounds } from '../../russell/roundMissions.ts';
import { citableClaims } from '../../../repos/research.ts';
import { cardFactsForProject, mayReplace } from '../../../repos/cashCardFacts.ts';
import { listOpportunities } from '../../../repos/cashPortfolio.ts';
import { closedBy } from '../closing.ts';
import { DISQUALIFIED_FIELD } from '../engineCard.ts';
import {
  commissionsFor,
  contradictedPathAnswers,
  listCommissions,
  openCommission,
  openCommissionsByCandidate,
  pathFact,
  recordPathFact,
  settleCommission,
} from '../../../repos/monetization.ts';
import { ATTRIBUTE, isMonetizationAttribute } from '../../../domain/monetization.ts';
import { readMoneyFigures } from '../figures.ts';
import { discoveryAllowed } from '../lifecycle.ts';
import { discoveryAuthority } from '../discoveryAuthority.ts';
import { composeLedger, rankableOf } from './ledger.ts';
import { allocateCommissions } from './commission.ts';
import { researchRoom, type ResearchRoom } from '../researchRoom.ts';
import { diveEpochStart } from '../diveStage.ts';
import { payerEstablished } from '../validation.ts';
import type { CommissionAsk } from './commission.ts';
import type { Ledger } from './ledger.ts';
import type {
  MonetizationAttribute,
  MonetizationCommission,
  ResearchClaim,
  CashCardFact,
} from '../../../domain/types.ts';

const OPENED = 'MONETIZATION_QUESTION_ASKED';
const SETTLED = 'MONETIZATION_QUESTION_SETTLED';
const ANSWERED = 'MONETIZATION_ANSWER_RECORDED';

/** One question actually asked, with the reason it was chosen. */
export interface OpenedCommission {
  commissionId: string;
  pathId: string;
  attribute: MonetizationAttribute;
  round: number;
  candidateId: string;
  reason: string;
  question: string;
}

/** One answer taken back onto the ledger. */
export interface RecordedAnswer {
  pathId: string;
  attribute: MonetizationAttribute;
  claimId: string;
}

export interface CommissionPass {
  opened: OpenedCommission[];
  /** Answers filed onto the ledger, whichever commission's research produced them. */
  recorded: RecordedAnswer[];
  settled: { commissionId: string; state: string; answered: number; outcome: string }[];
  /** Considered and not asked, with the reason. Reported, never acted on. */
  declined: { subject: string; why: string }[];
  openNow: number;
}

const EMPTY: CommissionPass = Object.freeze({
  opened: [],
  recorded: [],
  settled: [],
  declined: [],
  openNow: 0,
});

/**
 * The question a worker is actually handed.
 *
 * Composed from the possibility's own title and the attribute's own declared
 * question and task — both constants somebody reviewed — plus the discovery it
 * is a way of monetizing. **Nothing here is generated prose about the subject**:
 * every clause is either a row's value or a sentence from `ATTRIBUTE`.
 *
 * The round is in the text, and that is load-bearing rather than cosmetic.
 * `launch()` refuses a specification it has already researched, comparing
 * `specificationKey(objective, whyNow)` — so a second asking whose words were
 * identical would be refused with `ALREADY_RESEARCHED` and the round would
 * never run. The second asking says what the first one failed to find, which
 * both changes the key and is the more useful instruction anyway.
 */
export function commissionQuestion(input: {
  pathTitle: string;
  subjectTitle: string | null;
  attribute: MonetizationAttribute;
  round: number;
}): string {
  const declared = ATTRIBUTE[input.attribute];
  const about = input.subjectTitle
    ? `"${input.pathTitle}" as a way of making money from "${input.subjectTitle}"`
    : `"${input.pathTitle}"`;
  const again =
    input.round > 1
      ? ' An earlier search did not settle this, so look somewhere the first one did not: ' +
        'the publisher rather than an aggregator, the regulator rather than a summary of it, ' +
        'the platform’s own terms rather than an article about them. If the published ' +
        'sources still do not settle it, say so plainly — that is the answer.'
      : '';
  return (
    `For ${about}: ${declared.question} ${declared.task}` +
    ` Record the answer under the evidence lane "${input.attribute}".${again}`
  );
}

/**
 * Ask what is worth asking, and file what came back.
 *
 * Takes the ledger it was composed with rather than composing its own: the
 * durable tick already builds one for `runMonetizationLedger`, and two
 * compositions in one pass would be two readings of one fact that could
 * disagree about a rank between them.
 */
export async function runCommissions(input: {
  projectId: string;
  ledger: Ledger;
  now?: string;
}): Promise<CommissionPass> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return EMPTY;

  const finished = await settleFinished({
    projectId: input.projectId,
    currency: mode.currency,
    ledger: input.ledger,
  });
  /*
   * Settling comes first, and abandoning only reaches what is *still being
   * asked*. The order is the whole difference between two records of one
   * event.
   *
   * A run that finished and a possibility archived before the next tick read
   * it is a question that **was answered** and a possibility that was then put
   * away. Abandoning first would record the opposite — the question never
   * answered — and discard gated claims the activation had already been spent
   * on, which is §5 at a settled commission. `inFlight.ts` says the condition
   * in its own sentence: put away *while the question was still being asked*.
   * This is what makes that true of the code rather than only of the comment.
   */
  const abandoned = await abandonPutAway({
    projectId: input.projectId,
    ledger: input.ledger,
  });
  /*
   * A question closed because the possibility was put away is settled work,
   * so it travels in the same list a finished run does. Both are "this is no
   * longer being asked, and here is what came of it", and a reader who had to
   * look in two places to find out whether anything is still running would
   * eventually look in one.
   */
  const settledOut = {
    recorded: finished.recorded,
    settled: [...abandoned, ...finished.settled],
  };
  const alreadyOpen = (await listCommissions({ projectId: input.projectId, state: 'OPEN' })).length;

  /*
   * Winding down stops new questions and nothing else.
   *
   * A skip rather than a refusal: no state moves, nothing is charged, no
   * attempt is spent, and the question is asked by itself the moment the sprint
   * is active again. §30's rule, at a third producer.
   */
  const gate = await discoveryAllowed(input.projectId);
  if (!gate.allowed) {
    return {
      ...settledOut,
      opened: [],
      openNow: alreadyOpen,
      declined: [{ subject: 'every possibility in the ledger', why: gate.reason }],
    };
  }
  /*
   * The same authorization the discovery ran under.
   *
   * Not a second grant and not a second decision. If pressing Start did not
   * authorize research in this project, the candidate would park with exactly
   * that reason anyway; asking here means it is not captured in the first
   * place, so nothing accumulates a park nobody will ever answer.
   */
  if (!(await discoveryAuthority(input.projectId))) {
    return {
      ...settledOut,
      opened: [],
      openNow: alreadyOpen,
      declined: [
        {
          subject: 'every possibility in the ledger',
          why:
            'this project has no standing research authority, so a question here would be ' +
            'captured and immediately parked. Starting the sprint is what grants it.',
        },
      ],
    };
  }

  const commissions = await listCommissions({ projectId: input.projectId });
  const open = commissions.filter((one) => one.state === 'OPEN');
  const openNow = open.length;
  /*
   * A question parked for a person is using no provider capacity, so it holds
   * no slot.
   *
   * The dive room (then a fixed two) was corrected for exactly this and the reason
   * is recorded beside it: counting a parked dive made a Brain with two of them
   * unable to start a thirty-ninth for ever. **What holds a slot is what a
   * worker is working on.** Three commissions parked at `NEEDS_HUMAN` would
   * otherwise stop this loop permanently, which is §24's *waiting nobody can
   * resolve* — except that here the person genuinely can resolve it, and the
   * loop would still be stopped while they did.
   *
   * It is a slot count only. The question itself is still recorded as OPEN, so
   * nothing asks it a second time while it waits, and re-asking it is still
   * bounded by `MAX_COMMISSION_ROUNDS`.
   */
  let holding = 0;
  let unlaunched = 0;
  for (const one of open) {
    const mission = await latestMissionForCandidate(one.candidateId);
    if (mission?.state === 'NEEDS_HUMAN') continue;
    holding += 1;
    // Not launched yet, so it has not reserved its grant slot.
    if (!mission) unlaunched += 1;
  }
  /*
   * How many more may open, derived (§3.4) rather than the fixed three it was:
   * the grant's free slots less one for discovery, the surfaces that could run
   * a question now, and zero while the database is shedding. Never above the
   * person-set grant.
   */
  const room = await researchRoom({ projectId: input.projectId, inFlight: holding, unlaunched });
  /*
   * A question about an opening that can no longer be pursued is not worth an
   * activation. Production, 2026-10-17: duplicates, disqualified and expired
   * openings kept earning research bins that friends' Claude sessions were
   * fired at and handed back. The same four conditions `whyNotDiving` already
   * refuses a deep dive on, read once here, so the two readers agree.
   */
  const closed = await closedOpportunities(input.projectId);
  const live = input.ledger.entries.filter(
    (one) => !(one.subject?.kind === 'OPPORTUNITY' && closed.has(one.subject.id)),
  );
  /*
   * Each opening's change epoch, for the possibilities about it: only askings
   * of the current epoch spend its rounds (`MAX_COMMISSION_ROUNDS`).
   */
  const epochStarts = new Map<string, string>();
  const opportunities = new Map(
    (await listOpportunities({ projectId: input.projectId })).map((one) => [one.id, one]),
  );
  for (const entry of live) {
    if (entry.subject?.kind !== 'OPPORTUNITY') continue;
    const opportunity = opportunities.get(entry.subject.id);
    const start = opportunity ? diveEpochStart(opportunity) : null;
    if (start) epochStarts.set(entry.path.id, start);
  }
  const plan = allocateCommissions({
    entries: live,
    rankable: live.map(rankableOf),
    commissions,
    contradicted: await contradictedPathAnswers(input.projectId),
    slots: room.room,
    now: Date.parse(input.now ?? input.ledger.readAt),
    epochStarts,
  });

  const opened = await openAsks({
    projectId: input.projectId,
    cashModeId: mode.id,
    ledger: input.ledger,
    asks: plan.asks,
  });

  return {
    ...settledOut,
    opened,
    declined: plan.declined,
    openNow: openNow + opened.length,
  };
}

/**
 * Open the questions the allocator chose.
 *
 * The candidate is created **first** and the commission row second, with
 * `ON CONFLICT DO NOTHING`, so a tick that dies between the two leaves a
 * candidate nothing points at. That is harmless by construction: `envelopeIdFor`
 * resolves an envelope for a candidate by looking for the commission row, finds
 * none, and the orphan is never compiled or launched. The next tick's insert
 * collides on the same key and the question is asked exactly once. `openAsks`
 * in `services/industry/expand.ts` records the identical ordering and the
 * identical reason.
 */
async function openAsks(input: {
  projectId: string;
  cashModeId: string;
  ledger: Ledger;
  asks: readonly CommissionAsk[];
}): Promise<OpenedCommission[]> {
  const byPath = new Map(input.ledger.entries.map((one) => [one.path.id, one]));
  const out: OpenedCommission[] = [];

  for (const ask of input.asks) {
    const entry = byPath.get(ask.pathId);
    if (!entry) continue;
    const question = commissionQuestion({
      pathTitle: entry.path.title,
      subjectTitle: entry.subject?.title ?? null,
      attribute: ask.attribute,
      round: ask.round,
    });

    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      conversationId: null,
      sourceMessageId: null,
      title:
        ask.round === 1
          ? `${ATTRIBUTE[ask.attribute].label}: ${entry.path.title}`
          : `${ATTRIBUTE[ask.attribute].label}: ${entry.path.title} (round ${ask.round})`,
      statement: question,
    });

    const opened = await openCommission({
      projectId: input.projectId,
      cashModeId: input.cashModeId,
      pathId: ask.pathId,
      attribute: ask.attribute,
      round: ask.round,
      candidateId: candidate.id,
      reason: ask.reason,
      ruleRank: ask.ruleRank,
    });
    // Lost the race to another tick. Not an error, and nothing is reported:
    // the question is being asked, by whoever won.
    if (!opened.created) continue;

    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: entry.subject?.kind === 'OPPORTUNITY' ? entry.subject.id : null,
      kind: OPENED,
      actorRef: 'BRAIN',
      summary:
        `Brain is researching the ${ATTRIBUTE[ask.attribute].label.toLowerCase()} of ` +
        `"${entry.path.title}" from published sources. Nothing is being contacted or spent.`,
      detail: {
        commissionId: opened.commission.id,
        pathId: ask.pathId,
        attribute: ask.attribute,
        round: ask.round,
        candidateId: candidate.id,
        /*
         * The allocator's own reason, recorded beside the work it produced.
         *
         * `services/dispatch/router.ts` keeps its decision answerable from a
         * recorded input rather than from a re-run, and this is that promise
         * kept for research spending: *why did Brain research this* resolves to
         * a sentence written at the moment it was decided, over a ledger that
         * has since moved.
         */
        why: ask.reason,
        rank: ask.ruleRank,
        position: ask.rank,
      },
    });

    out.push({
      commissionId: opened.commission.id,
      pathId: ask.pathId,
      attribute: ask.attribute,
      round: ask.round,
      candidateId: candidate.id,
      reason: ask.reason,
      question,
    });
  }
  return out;
}

/**
 * File what the finished research established, and close the asking.
 *
 * The link back is the one every kernel in this codebase uses: an open
 * commission names the candidate it asked, a mission names that candidate and
 * the orchestration it launched, and the orchestration's **citable** claims are
 * what the evidence gate accepted. Nothing here re-judges a claim, lowers a
 * bar, or reads a claim's prose to decide where it belongs — the destination is
 * `evidence_lane`, which is a column.
 */
/**
 * Close a question whose possibility has been put away.
 *
 * `ABANDONED` had a reader and no writer. `inFlight.ts` rendered a sentence
 * for it, the CHECK constraint allowed it, `settleCommission` accepted it —
 * and nothing in the pass could produce one, so a state a person could be
 * shown was unreachable by construction. Found by auditing this branch's own
 * new code against the rule it was written to enforce elsewhere, which is the
 * only honest place to find it.
 *
 * The condition is real and reachable four ways, all of which can happen while
 * a question about the path is still being asked: somebody judges it
 * `ARCHIVE`, somebody judges it `INVALIDATE`, it is merged into another
 * possibility, or the discovery it is a way of monetizing is itself archived
 * or declined. `deriveStatus` already turns every one of those into `ARCHIVED`
 * or `INVALIDATED`, so this reads that rather than re-deciding it — a second
 * opinion about what counts as put away is how the surface and the loop come
 * to disagree about the same path.
 *
 * **It is a positive terminal status or nothing.** A path with no ledger entry
 * at all is *not* abandoned here: absence is not evidence, and a composition
 * that transiently omitted an entry would otherwise close live research on a
 * perfectly good possibility.
 *
 * It costs the research nothing it can still deliver and destroys nothing.
 * The mission is left exactly as it is rather than cancelled — its claims keep
 * their rows in `research_claims` with full provenance whatever happens to the
 * path, and §5's rule is that a question ceasing to be worth answering is not
 * a reason to destroy the answer. What it *does* free is the slot: three
 * commissions against archived possibilities would otherwise hold all of
 * every open-question slot for ever, which is §24's *waiting nobody can resolve*
 * and the identical defect `MAX_VALIDATIONS_IN_FLIGHT` already records — here
 * with nobody even able to resolve it, because the person has already said
 * they do not want this.
 */
async function abandonPutAway(input: {
  projectId: string;
  ledger: Ledger;
}): Promise<CommissionPass['settled']> {
  const open = await listCommissions({ projectId: input.projectId, state: 'OPEN' });
  if (open.length === 0) return [];

  const status = new Map(
    input.ledger.entries.map((one) => [
      one.path.id,
      { status: one.status, because: one.statusBecause },
    ]),
  );
  const out: CommissionPass['settled'] = [];

  for (const commission of open) {
    const reading = status.get(commission.pathId);
    if (!reading) continue;
    if (reading.status !== 'ARCHIVED' && reading.status !== 'INVALIDATED') continue;

    const outcome =
      `The possibility was put away while this was being asked, so the answer stopped being ` +
      `worth having: ${reading.because} The research that had already started keeps every ` +
      `claim it filed, and if this possibility is revived the question can be asked again.`;
    const moved = await settleCommission({
      id: commission.id,
      state: 'ABANDONED',
      answered: 0,
      outcome,
    });
    if (!moved) continue;
    out.push({ commissionId: moved.id, state: moved.state, answered: 0, outcome });
  }
  return out;
}

async function settleFinished(input: {
  projectId: string;
  currency: string;
  ledger: Ledger;
}): Promise<Pick<CommissionPass, 'recorded' | 'settled'>> {
  const recorded: RecordedAnswer[] = [];
  const settled: CommissionPass['settled'] = [];

  const live = await openCommissionsByCandidate(input.projectId);
  if (live.size === 0) return { recorded, settled };

  /*
   * Each commission's own idea, read by key (RES-2). This was the hundred most
   * recently updated missions of the project, so a commission whose mission had
   * fallen out of that window was never settled and held its slot for ever —
   * and with two attempts in the window the map kept whichever came last in
   * newest-first order, which is the *older* one.
   */
  const rounds = await missionsForRounds([...live.keys()]);

  for (const [candidateId, commission] of live) {
    const entry = rounds.get(candidateId);
    const state = entry?.latest?.state ?? null;
    /*
     * A run that is still going is not settled, and saying so costs nothing.
     *
     * There is deliberately no stall clock here. §27 measures a single judge
     * pass at over nine minutes and a packet is a plan, a fragment, a
     * verification, a synthesis and three separately-sessioned audit roles —
     * so a clock started at launch would cancel live work doing exactly what
     * it should. What bounds this instead is the *mission*, which has its own
     * attempt ceiling and its own terminal states; when it reaches one, so
     * does the commission. An idea with no mission yet is not finished either:
     * an absent row is never read as a failure.
     */
    if (!entry || !state || (state !== 'DONE' && state !== 'FAILED' && state !== 'CANCELLED')) {
      continue;
    }

    // Every attempt's claims, because a redo answers the same question.
    const claims = (
      await Promise.all(entry.orchestrationIds.map((id) => citableClaims(id)))
    ).flat();
    const filed = await fileAnswers({
      projectId: input.projectId,
      pathId: commission.pathId,
      currency: input.currency,
      claims,
    });
    const answers = filed.recorded;
    recorded.push(...answers);

    /*
     * `answered` is derived from what actually landed, and whether the
     * commission is ANSWERED is decided on **its own** attribute.
     *
     * A run that established four neighbouring attributes and not the one it
     * was asked about has produced real evidence and has not answered the
     * question. Recording it as ANSWERED would let the allocator believe a
     * decisive unknown is closed when the surface still prints it as open —
     * §33's *the evidence was right and the sentence about it was wrong*, which
     * is the failure mode this file cares about most.
     */
    const hitTheAsk = answers.some((one) => one.attribute === commission.attribute);
    /*
     * A claim that answered the question and was refused by authority.
     *
     * The research did its job: a gated claim arrived on the asked attribute,
     * and a stronger answer — somebody's decision, or an earlier gated one —
     * already stood there, so `mayReplace` kept it. Both claims keep their
     * rows in `research_claims` and a reader can hold them against each other,
     * which is exactly what re-asking a contradicted answer is for. Calling
     * that UNRESOLVED would say the sources do not settle it, about a search
     * that settled it.
     */
    const held = !hitTheAsk && filed.heldBack.includes(commission.attribute);
    const outcome = describeOutcome({
      state,
      hitTheAsk,
      held,
      answers: answers.length,
      commission,
    });
    const closed = await settleCommission({
      id: commission.id,
      state: hitTheAsk || held ? 'ANSWERED' : 'UNRESOLVED',
      answered: answers.length,
      outcome,
    });
    // Another tick settled it first. An ordinary outcome, and its own event
    // was recorded by whoever won.
    if (!closed) continue;

    await recordCashEvent({
      projectId: input.projectId,
      kind: SETTLED,
      actorRef: 'BRAIN',
      summary: outcome,
      detail: {
        commissionId: commission.id,
        pathId: commission.pathId,
        attribute: commission.attribute,
        round: commission.round,
        state: closed.state,
        answered: answers.length,
      },
    });
    settled.push({
      commissionId: commission.id,
      state: closed.state,
      answered: answers.length,
      outcome,
    });
  }
  return { recorded, settled };
}

function describeOutcome(input: {
  state: string;
  hitTheAsk: boolean;
  held: boolean;
  answers: number;
  commission: MonetizationCommission;
}): string {
  const label = ATTRIBUTE[input.commission.attribute].label.toLowerCase();
  if (input.held) {
    return (
      `A published source answers the ${label}, and the answer already recorded here outranks ` +
      'it, so that one stands. Both claims keep their rows and can be held against each other.'
    );
  }
  if (input.hitTheAsk) {
    const beside = input.answers - 1;
    return (
      `The ${label} is established from a published source` +
      (beside > 0
        ? `, along with ${beside} other question${beside === 1 ? '' : 's'} the same sources answered.`
        : '.')
    );
  }
  if (input.state === 'FAILED' || input.state === 'CANCELLED') {
    return (
      `The research for this did not finish, so the ${label} is still unknown — which is ` +
      'exactly what it was before. Nothing about the possibility changed.' +
      (input.answers > 0
        ? ` ${input.answers} other question${input.answers === 1 ? ' was' : 's were'} answered ` +
          'by what it did establish, and those are kept.'
        : '')
    );
  }
  return (
    `The published sources do not settle the ${label}, and it stays unknown rather than ` +
    'becoming a no.' +
    (input.answers > 0
      ? ` The search did answer ${input.answers} other question${
          input.answers === 1 ? '' : 's'
        } about this possibility, and those are kept.`
      : '')
  );
}

/**
 * Put every gated claim on the row its own lane names.
 *
 * A claim whose lane is not one of the ledger's attributes is skipped rather
 * than placed somewhere plausible — the worker declared what it answers, and
 * guessing past that declaration is the Westbrook defect (§25) at a table with
 * money in it.
 *
 * `mayReplace` decides whether it may land, so a person's own decision is never
 * overwritten by research and an earlier gated answer is never replaced by a
 * later proposal. That is authority rather than recency, and it is reused whole
 * from `cashCardFacts` rather than restated.
 */
async function fileAnswers(input: {
  projectId: string;
  pathId: string;
  currency: string;
  claims: readonly ResearchClaim[];
}): Promise<{ recorded: RecordedAnswer[]; heldBack: MonetizationAttribute[] }> {
  const out: RecordedAnswer[] = [];
  /*
   * Attributes a gated claim arrived for and could not land on.
   *
   * Reported rather than dropped, because the two cases read identically from
   * the outside and are not the same fact: *nobody publishes this* and *a
   * source answered it and a stronger answer already stands* have opposite
   * meanings, and settling the second as the first would tell a person the
   * research found nothing when it found exactly what it was sent for.
   */
  const heldBack: MonetizationAttribute[] = [];
  const taken = new Set<string>();

  for (const claim of input.claims) {
    const lane = claim.evidenceLane ?? '';
    if (!isMonetizationAttribute(lane)) continue;
    const attribute: MonetizationAttribute = lane;
    // One claim per attribute per pass: the first gated one wins, and the rest
    // stay on their own rows in `research_claims` exactly as submitted. The
    // alternative is a later claim in the same list silently replacing an
    // earlier one of equal standing, which is §17's rule broken inside one loop.
    if (taken.has(attribute)) continue;

    /*
     * A claim that establishes there is nothing published is a real finding
     * about the world and is **not** an answer to "what does this pay".
     *
     * Recording it as one would put "no published rate card was found" in the
     * expected-revenue field, where every reader — and the ranking — would
     * treat it as an established answer. An absence is not a negative answer;
     * it is the commission settling UNRESOLVED with the reason, which is what
     * happens when nothing lands here.
     */
    if (claim.claimType === 'NEGATIVE_EXISTENCE') continue;
    if (!claim.sourceUrl) continue;

    const existing = await pathFact(input.pathId, attribute);
    if (!mayReplace(existing, 'EVIDENCE')) {
      heldBack.push(attribute);
      continue;
    }

    const declared = ATTRIBUTE[attribute];
    const value = clamp(claim.claim, 600);
    /*
     * A CHOICE attribute records a value from its own list or nothing at all.
     *
     * The ranking reads these by index into `choices`, so a sentence stored
     * where a choice belongs sorts as unknown *and* displays as answered —
     * which is the worst of both, because the surface would stop asking the
     * question while nothing could ever read the answer. A claim that plainly
     * states one of the declared values is recorded as that value; anything
     * else leaves the attribute open, which is honest.
     */
    const choice = declared.unit === 'CHOICE' ? matchChoice(claim.claim, declared.choices) : null;
    if (declared.unit === 'CHOICE' && !choice) continue;

    /*
     * The lowest figure the source states, and never a produced one.
     *
     * §33 settles this for a range: the top of one is the number Brain could
     * least defend if asked. A claim stating several is read the same way. Null
     * where the sentence carries no figure in the sprint's own currency at all
     * — which leaves the attribute answered as text with its amount unknown,
     * and an unknown sorts last on the criterion that reads it, exactly as it
     * should.
     */
    const figures = declared.unit === 'MONEY' ? readMoneyFigures(claim.claim, input.currency) : [];
    const figure = figures.reduce<{ cents: number } | null>(
      (lowest, one) => (lowest === null || one.cents < lowest.cents ? one : lowest),
      null,
    );
    const days = declared.unit === 'DAYS' ? readDays(claim.claim) : null;

    await recordPathFact({
      projectId: input.projectId,
      pathId: input.pathId,
      attribute,
      kind: 'EVIDENCE',
      value: choice ?? value,
      amountCents: figure?.cents ?? null,
      days,
      claimId: claim.id,
      decidedBy: 'BRAIN',
    });
    taken.add(attribute);
    out.push({ pathId: input.pathId, attribute, claimId: claim.id });
  }
  return { recorded: out, heldBack };
}

/**
 * The declared choice a claim states, or null.
 *
 * Exact and word-bounded, over the attribute's own list. It reads the value as
 * a token rather than the sentence as prose: there is no scoring, no nearest
 * match and no negation handling, because §8's rule about enums is that a
 * "closest verdict" is how model prose becomes state. A claim that names two of
 * them is ambiguous and answers nothing.
 */
export function matchChoice(text: string, choices: readonly string[] | undefined): string | null {
  if (!choices || choices.length === 0) return null;
  const upper = text.toUpperCase();
  const hits = choices.filter((one) =>
    new RegExp(`(^|[^A-Z_])${one}([^A-Z_]|$)`).test(upper),
  );
  return hits.length === 1 ? (hits[0] as string) : null;
}

/**
 * A number of days a source states, or null.
 *
 * Deliberately narrow, and its failure mode is fixed at **missing** a duration
 * rather than inventing one — `figures.ts`' own contract, at the other unit. It
 * reads a stated count of days, weeks or months and nothing else: no "a couple
 * of", no "next quarter", no arithmetic on a date. A payment term nobody
 * publishes stays unknown.
 */
export function readDays(text: string): number | null {
  const match = /(\d{1,4})(?:\s*[-–]\s*\d{1,4})?\s*(day|business day|week|month)s?\b/i.exec(
    text,
  );
  if (!match) return null;
  const count = Number.parseInt(match[1] as string, 10);
  if (!Number.isFinite(count) || count <= 0 || count > 3_650) return null;
  const unit = (match[2] as string).toLowerCase();
  if (unit === 'week') return count * 7;
  if (unit === 'month') return count * 30;
  return count;
}

function clamp(text: string, max: number): string {
  const tidy = text.trim().replace(/\s+/g, ' ');
  return tidy.length <= max ? tidy : `${tidy.slice(0, max - 1)}…`;
}

/**
 * How many questions may be open at once in this project right now: those
 * holding capacity plus the room to open more. The figure the operator surface
 * prints beside the open count, so the two are read from the same rule the
 * pass applies rather than from a constant.
 */
export async function commissionCapacity(projectId: string): Promise<number> {
  const open = await listCommissions({ projectId, state: 'OPEN' });
  let holding = 0;
  let unlaunched = 0;
  for (const one of open) {
    const mission = await latestMissionForCandidate(one.candidateId);
    if (mission?.state === 'NEEDS_HUMAN') continue;
    holding += 1;
    if (!mission) unlaunched += 1;
  }
  const room: ResearchRoom = await researchRoom({ projectId, inFlight: holding, unlaunched });
  return room.cap;
}

/** Every asking about one possibility, for the operator surface. */
export async function commissionHistory(pathId: string): Promise<MonetizationCommission[]> {
  return commissionsFor(pathId);
}

export { ANSWERED as MONETIZATION_ANSWER_EVENT };

/**
 * Openings no question should be asked about: a duplicate, declined or
 * archived, past its own expiry, or carrying a recorded disqualification.
 */
export async function closedOpportunities(projectId: string): Promise<Set<string>> {
  const now = cashNow();
  const closed = new Set<string>();
  const mode = await getCashMode(projectId);
  let deployable: number | null = null;
  const opportunities = await listOpportunities({ projectId });
  for (const one of opportunities) {
    if (
      one.duplicateOfId ||
      one.state === 'DECLINED' ||
      one.state === 'ARCHIVED' ||
      closedBy(one.expiresAt, now)
    ) {
      closed.add(one.id);
      continue;
    }
    /*
     * And one no answer could make executable now — a marketplace listing, a
     * close inside the runway, or capital the ledger does not hold. The same
     * reading the deep dive refuses on (`worthResearching.ts`), so a
     * monetization question is not spent where a dive would not be.
     */
    deployable ??= Math.max(0, (await cashPosition({ projectId, currency: mode?.currency })).deployableCents);
    if (await notWorthResearching(one, { now, deployableCents: deployable })) closed.add(one.id);
  }
  const facts = await cardFactsForProject(projectId);
  for (const fact of facts) {
    if (fact.field === DISQUALIFIED_FIELD && fact.value.trim().length > 0) closed.add(fact.opportunityId);
  }
  /*
   * And one nobody has shown would pay. Production, 2026-10-22: 254 questions
   * asked, 6 answered — nearly all of them the capital, costs or timing of a
   * market fact (a surplus auction, a domain appraisal, a bug-bounty page)
   * with no payer behind it. Who pays is the deep dive's first question, and
   * until it is answered nothing these questions could settle changes what
   * Brain does next (§65). Answer the payer, and the opening is asked again.
   */
  const payerFacts = new Map<string, CashCardFact>();
  for (const fact of facts) if (fact.field === 'payer') payerFacts.set(fact.opportunityId, fact);
  for (const one of opportunities) {
    if (closed.has(one.id)) continue;
    if (!payerEstablished(one, (field) => (field === 'payer' ? payerFacts.get(one.id) ?? null : null))) {
      closed.add(one.id);
    }
  }
  return closed;
}
