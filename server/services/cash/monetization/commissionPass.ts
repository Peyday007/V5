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
import { getCashMode, recordCashEvent } from '../../../repos/cashMode.ts';
import { createCandidate } from '../../../repos/russellCandidates.ts';
import { listMissions } from '../../../repos/russellMissions.ts';
import { citableClaims, getClaim } from '../../../repos/research.ts';
import { mayReplace } from '../../../repos/cashCardFacts.ts';
import {
  commissionsFor,
  listCommissions,
  openCommission,
  openCommissionsByCandidate,
  pathFact,
  pathFactsForProject,
  recordPathFact,
  settleCommission,
} from '../../../repos/monetization.ts';
import { ATTRIBUTE, isMonetizationAttribute } from '../../../domain/monetization.ts';
import { readMoneyFigures } from '../figures.ts';
import { discoveryAllowed } from '../lifecycle.ts';
import { discoveryAuthority } from '../discoveryAuthority.ts';
import { composeLedger, rankableOf } from './ledger.ts';
import { allocateCommissions, MAX_OPEN_COMMISSIONS } from './commission.ts';
import type { CommissionAsk } from './commission.ts';
import type { Ledger } from './ledger.ts';
import type {
  MonetizationAttribute,
  MonetizationCommission,
  ResearchClaim,
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

  const settledOut = await settleFinished({
    projectId: input.projectId,
    currency: mode.currency,
    ledger: input.ledger,
  });
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
  const openNow = commissions.filter((one) => one.state === 'OPEN').length;
  const plan = allocateCommissions({
    entries: input.ledger.entries,
    rankable: input.ledger.entries.map(rankableOf),
    commissions,
    contradicted: await contradictedAnswers(input.projectId),
    slots: Math.max(0, MAX_OPEN_COMMISSIONS - openNow),
    now: Date.parse(input.now ?? input.ledger.readAt),
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
 * Which recorded answers rest on a claim that has since been contradicted.
 *
 * A row, never a reading: `contradiction_state` is written by
 * `brain_report_contradiction` and nothing here interprets what the
 * contradiction says. The answer stays exactly where it is — §17's rule that
 * new evidence never silently overwrites old — and the attribute becomes worth
 * asking about again so that both can stand.
 */
async function contradictedAnswers(projectId: string): Promise<ReadonlySet<string>> {
  const out = new Set<string>();
  for (const fact of await pathFactsForProject(projectId)) {
    if (fact.kind !== 'EVIDENCE' || !fact.claimId) continue;
    const claim = await getClaim(fact.claimId);
    if (claim && claim.contradictionState !== 'UNCHALLENGED') {
      out.add(`${fact.pathId}::${fact.attribute}`);
    }
  }
  return out;
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
async function settleFinished(input: {
  projectId: string;
  currency: string;
  ledger: Ledger;
}): Promise<Pick<CommissionPass, 'recorded' | 'settled'>> {
  const recorded: RecordedAnswer[] = [];
  const settled: CommissionPass['settled'] = [];

  const live = await openCommissionsByCandidate(input.projectId);
  if (live.size === 0) return { recorded, settled };

  const missions = await listMissions({ projectId: input.projectId });
  const byCommission = new Map<
    string,
    { commission: MonetizationCommission; orchestrationId: string | null; state: string }
  >();
  for (const mission of missions) {
    if (!mission.candidateId) continue;
    const commission = live.get(mission.candidateId);
    if (!commission) continue;
    byCommission.set(commission.id, {
      commission,
      orchestrationId: mission.orchestrationId,
      state: mission.state,
    });
  }

  for (const { commission, orchestrationId, state } of byCommission.values()) {
    /*
     * A run that is still going is not settled, and saying so costs nothing.
     *
     * There is deliberately no stall clock here. §27 measures a single judge
     * pass at over nine minutes and a packet is a plan, a fragment, a
     * verification, a synthesis and three separately-sessioned audit roles —
     * so a clock started at launch would cancel live work doing exactly what
     * it should. What bounds this instead is the *mission*, which has its own
     * attempt ceiling and its own terminal states; when it reaches one, so
     * does the commission.
     */
    if (state !== 'DONE' && state !== 'FAILED' && state !== 'CANCELLED') continue;

    const claims = orchestrationId ? await citableClaims(orchestrationId) : [];
    const answers = await fileAnswers({
      projectId: input.projectId,
      pathId: commission.pathId,
      currency: input.currency,
      claims,
    });
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
    const outcome = describeOutcome({ state, hitTheAsk, answers: answers.length, commission });
    const closed = await settleCommission({
      id: commission.id,
      state: hitTheAsk ? 'ANSWERED' : 'UNRESOLVED',
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
  answers: number;
  commission: MonetizationCommission;
}): string {
  const label = ATTRIBUTE[input.commission.attribute].label.toLowerCase();
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
}): Promise<RecordedAnswer[]> {
  const out: RecordedAnswer[] = [];
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
    if (!mayReplace(existing, 'EVIDENCE')) continue;

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
  return out;
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

/** Every asking about one possibility, for the operator surface. */
export async function commissionHistory(pathId: string): Promise<MonetizationCommission[]> {
  return commissionsFor(pathId);
}

export { ANSWERED as MONETIZATION_ANSWER_EVENT };
