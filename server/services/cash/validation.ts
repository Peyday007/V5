/**
 * The bounded deep dive that turns an opening into a decision.
 *
 * ---------------------------------------------------------------------------
 * Why discovery cannot answer these questions
 * ---------------------------------------------------------------------------
 *
 * A discovery bucket asks a market a broad question — *which buyers have
 * published a paid request* — and answers it with openings. It has no single
 * payer, no single price and no single delivery path, because it is not about
 * one thing. Asking it for all of those anyway is what produced fragments no
 * worker could satisfy: a production packet declared lanes for the buyer, the
 * scope, the payment terms and the closing condition, found one qualifying
 * solicitation against a target of three, and filed with the rest unresolved.
 * Its own judge said so.
 *
 * So the commercial questions are a **second, bounded assignment**, against one
 * opening that already exists, with that opening's own published source quoted
 * into the question. Discovery finds; validation qualifies. Each is answerable.
 *
 * ---------------------------------------------------------------------------
 * It adds no new way to act, and no new way in
 * ---------------------------------------------------------------------------
 *
 * It creates a Russell candidate and lets the path that already exists do
 * everything: `judgeCandidate` asks the archive first, the compiler writes the
 * specification, `RUSSELL_CASH_VALIDATION_V1` decides whether it may start, the
 * evidence gate decides what may be claimed, and all three audit roles decide
 * whether it stands. Nothing here bypasses any of it and nothing here is a
 * second pipeline.
 *
 * The envelope it runs under takes its source classes and its forbidden actions
 * verbatim from the discovery envelope, so a deep dive authorizes exactly what
 * pressing Start authorized: reading published sources. Contacting the buyer to
 * ask their budget is the obvious way to answer half of these questions and is
 * refused, because that is a `COMMERCIAL_ACTION` under a grant a person makes
 * separately.
 */
import { listingSentenceFor, retrieveDueListings } from './listings.ts';
import { closedBy } from './closing.ts';
import { describeNotWorthResearching, notWorthResearching, type NotWorthResearching } from './worthResearching.ts';
import { getDb } from '../../db/database.ts';
import {
  cashEventsOfKind,
  cashNow,
  getCashMode,
  listCashEventsFor,
  recordCashEvent,
} from '../../repos/cashMode.ts';
import {
  getOpportunity,
  listOpportunities,
  resumeBlockedValidation,
  updateOpportunity,
} from '../../repos/cashPortfolio.ts';
import { createCandidate, getCandidate, transitionCandidate } from '../../repos/russellCandidates.ts';
import { latestMissionForCandidate, missionsForCandidate } from '../../repos/russellMissions.ts';
import { citableClaims, getClaim, getFragment, getOrchestration, listPasses } from '../../repos/research.ts';
import {
  cardFactsFor,
  mayReplace,
  recordEvidenceFact,
  recordRecommendationFact,
  clearColumnIfStill,
  withdrawEvidenceFact,
  withdrawRecommendationsResting,
  cardFactMap,
} from '../../repos/cashCardFacts.ts';
import {
  DISQUALIFIED_FIELD,
  RULED_OUT_CLEARED_FIELD,
  UNCLASSIFIED_DISQUALIFIER_FIELD,
  cashEngineCard,
} from './engineCard.ts';
import { evidenceCard } from './card.ts';
import { cashTier } from './tier.ts';
import { COLUMN } from './answers.ts';
import { discoveryAllowed } from './lifecycle.ts';
import { discoveryAuthority } from './discoveryAuthority.ts';
import { researchMissionSlotsFull } from '../russell/launch.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { cashPosition } from './money.ts';
import { CAPTURE_INPUTS, type QualificationKey, type TierReading, type CashTier } from './tier.ts';
import { DIVE_STARTED_EVENT, diveEpochStart, diveStarts, type DiveStage, type DiveStart } from './diveStage.ts';
export { diveEpochStart } from './diveStage.ts';
import { researchRoom, type ResearchRoom, type RoomLimit } from './researchRoom.ts';
import { recordReopenCondition, reopenConditionsFor } from '../../repos/cashReconsideration.ts';
import { formatBlockerKey } from '../../domain/types.ts';
import type { CashCardFact, CashOpportunity, OpportunityValidationState } from '../../domain/types.ts';

/**
 * The states that actually occupy capacity.
 *
 * `NEEDS_PERSON` is deliberately absent, and that absence is the whole repair.
 * Capacity is provider capacity; a dive parked for a person is using none of
 * it, and counting it made a Brain with two parked missions unable to start a
 * thirty-ninth dive for ever. What holds capacity is what a worker is working on.
 */
const HOLDS_A_SLOT: ReadonlySet<string> = Object.freeze(new Set(['PENDING', 'RUNNING']));

/**
 * How long a deep dive may go **without a pass finishing** before Brain stops
 * calling it running.
 *
 * Not a bound on how long research may take, and the difference is the whole
 * of it: a validation packet is a plan, its fragments, a verification, a
 * synthesis and three separately-sessioned audit roles, each waiting on an
 * activation, and §27 measures one judge pass alone at nine minutes and
 * forty-four seconds. A clock started at launch would cancel live work doing
 * exactly what it should. What is measured is the gap since the last thing a
 * worker actually finished, so a dive whose passes keep completing is never
 * reached however long it runs.
 *
 * Six hours is longer than the gap between any two completed passes this
 * Brain has recorded, and short enough that a slot is not lost for a day. A
 * stalled dive is `BLOCKED` rather than failed, with the gap in the reason, so
 * it can be asked again inside its epoch's rounds rather than written off — and
 * nothing it produced is destroyed.
 */
export const VALIDATION_STALL_MS = 6 * 60 * 60 * 1000;

/**
 * How many full deep dives one opening may have **per change epoch**.
 *
 * It used to be per lifetime, and that made a second look at an opening
 * impossible however much changed underneath it: production held openings whose
 * payer appeared in the shared pool weeks after both of their dives were spent,
 * and nothing could ask again. An epoch begins at creation and again at each
 * distinct change — a reconsideration (`reconsider_requested_at` later than the
 * last dive started), recorded by the ledger whose primary key refuses the
 * same change twice (`cash_reconsideration_triggers`). There is deliberately no
 * cap on epochs: what bounds re-asking is that a new epoch needs a distinct
 * change, and inside an epoch this count and `repair.ts`'s rule that the same
 * search never runs twice.
 *
 * Two inside an epoch, and not a ladder. A third dive against the same
 * published sources in the same epoch asks the same question a third time. A
 * piece still short after two has an honest answer for this epoch — the
 * sources do not publish it — and the card says which fields.
 */
export const MAX_VALIDATION_ROUNDS = 2;

/**
 * The stage-one screen an epoch may have, on top of its full dives.
 *
 * A screen asks three lanes rather than sixteen, so it does not spend one of
 * the epoch's full dives: an opening that passes it still gets the depth it
 * had before stages existed. One, because a second screen in the same epoch
 * would ask the same kill questions of the same sources.
 */
export const MAX_SCREENS_PER_EPOCH = 1;

/** Extra rounds an opening may have only to classify an older dive's possible disqualifier. */
export const CLASSIFICATION_ROUNDS = 1;

/**
 * The card fields a stage-one screen settles: who pays, and whether anything
 * rules the opening out (whether it is still open is a disqualifier found).
 * Each can end an opening by itself, which is why they are asked first.
 */
export const STAGE_ONE_FIELDS: readonly QualificationKey[] = Object.freeze(['payer', 'disqualifiers']);

/* --------------------------------------------------------------------------
 * The change epoch
 * ------------------------------------------------------------------------ */

export interface DiveEpoch {
  startedAt: string | null;
  /**
   * True when a distinct change arrived after the last dive started, so no dive
   * of this epoch has run yet.
   */
  fresh: boolean;
  /** Dives started in this epoch, screens included. */
  roundsUsed: number;
}

/**
 * The epoch, as a pure reading of the opportunity's own columns.
 *
 * `validation_rounds` counts the dives of the epoch the latest dive belongs to:
 * `startValidations` restarts it at one for the first dive after a change. So
 * when the change is later than the last dive's start the epoch is fresh and
 * nothing has been used in it, and otherwise the column is the count.
 */
export function diveEpoch(opportunity: CashOpportunity): DiveEpoch {
  const startedAt = diveEpochStart(opportunity);
  const lastDive = opportunity.validationStartedAt ?? null;
  const fresh =
    startedAt !== null && opportunity.validationState !== null && (lastDive === null || startedAt > lastDive);
  return { startedAt, fresh, roundsUsed: fresh ? 0 : opportunity.validationRounds };
}

/** The dives started inside the current epoch, from their own started events. */
function startsInEpoch(starts: readonly DiveStart[], epoch: DiveEpoch): DiveStart[] {
  if (epoch.fresh) return [];
  if (epoch.startedAt === null) return [...starts];
  return starts.filter((one) => one.at >= epoch.startedAt!);
}

/* --------------------------------------------------------------------------
 * The stage
 * ------------------------------------------------------------------------ */

/**
 * Whether the opening's payer is established, from its row or its card.
 *
 * A documented search that found nobody never lands here: `applyValidationAnswers`
 * refuses to write a NEGATIVE_EXISTENCE payer and withdraws any that once did.
 */
export function payerEstablished(
  opportunity: CashOpportunity,
  fact: (field: string) => CashCardFact | null,
): boolean {
  if (opportunity.payer && opportunity.payer.trim().length > 0) return true;
  const payer = fact('payer');
  return Boolean(payer && payer.kind !== 'RECOMMENDATION' && payer.value.trim().length > 0);
}

/**
 * Which stage the next dive of this opening asks.
 *
 * The kill question first: with no payer established, the next dive is a
 * `SCREEN` that asks who pays, whether the opening is still open, and whether
 * anything rules it out — and nothing else. With a payer established the
 * screen has nothing left to settle, so the dive is `FULL`. No bar moves:
 * QUALIFIED still needs every qualification field.
 */
export function nextDiveStage(
  opportunity: CashOpportunity,
  fact: (field: string) => CashCardFact | null,
): DiveStage {
  return payerEstablished(opportunity, fact) ? 'FULL' : 'SCREEN';
}

/**
 * Why a particular opening is not being qualified right now.
 *
 * ---------------------------------------------------------------------------
 * Why this is a value rather than a comment
 * ---------------------------------------------------------------------------
 *
 * *Why is nothing being refined* had no answer that was not a guess. Every
 * surface could say a piece's **state** and none could say what had refused
 * it, so the only reading available was `passes 0/0` — which is a true
 * statement about a packet and no statement at all about whether the lifecycle
 * is stuck, waiting on a person, or working exactly as designed.
 *
 * "Nothing is running" and "nothing may run, for these named reasons, read off
 * these rows" are different facts with different remedies, and the second is
 * the one somebody can act on. §30's rule at a new reading: an unknown is never
 * a favourable assumption, and *we did not look* must never read the same as
 * *we checked*.
 *
 * ---------------------------------------------------------------------------
 * Why the producer derives it rather than the report
 * ---------------------------------------------------------------------------
 *
 * `startValidations` decides this on every tick; a report that re-derived it
 * would be the *two readers of one fact* defect this repository records more
 * than any other, and it would be the copy nobody exercises that drifts. So
 * the loop below is written in terms of this function, and reading it is the
 * same call the loop makes. A refusal the report prints is therefore the
 * refusal that actually happened.
 *
 * `SLOTS_TAKEN` is deliberately **not** here: it is a fact about the project
 * rather than about the opening, and it is decided before the loop reaches any
 * of them. `sprintCanRefine` answers that, and the two are reported side by
 * side because collapsing them would say a piece was ineligible when what was
 * missing was capacity.
 */
export type DiveRefusal =
  /** Nothing refuses it; it starts as soon as there is room. */
  | { kind: 'ELIGIBLE' }
  /** A worker is on it now. This one is holding capacity. */
  | { kind: 'IN_FLIGHT'; state: OpportunityValidationState }
  /**
   * Parked at a decision only a person can make.
   *
   * It holds no capacity, and a second dive is refused on purpose: answering
   * the mission's own card resumes the mission that is already there, so
   * starting another would buy the same answer twice.
   */
  | { kind: 'AWAITING_PERSON' }
  /**
   * This epoch's dives are spent. A stalled round counts too, so this says
   * nothing about the sources. A new epoch — a distinct change — opens it again.
   */
  | { kind: 'EPOCH_SPENT'; rounds: number; cap: number; epochStartedAt: string | null }
  /**
   * This epoch's stage-one screen settled without the kill questions passing:
   * no payer is established. The full dive is not spent on it; it is dormant
   * until the reopen conditions recorded for it change.
   */
  | { kind: 'STAGE_ONE_FAILED'; open: string[]; epochStartedAt: string | null }
  /** It got there. A qualified piece has nothing left for a dive to ask. */
  | { kind: 'ALREADY_QUALIFIED'; tier: string }
  /**
   * A dive already found a published fact that rules it out.
   *
   * A second round would ask the same sources the same questions about an
   * opening whose deadline has passed or whose terms exclude us — production
   * spent a second ~25-minute dive on each closed RFP. New evidence that the
   * fact stopped being true arrives through discovery, not by asking again.
   */
  | { kind: 'DISQUALIFIED'; reason: string }
  /** Declined, archived or already being executed — the commercial questions are closed. */
  | { kind: 'NOT_A_QUALIFYING_STATE'; state: string }
  /** No published signal and no source claim, so there is nothing to quote into a question. */
  | { kind: 'NOTHING_PUBLISHED_TO_ASK_ABOUT' }
  /** A second record of an opening already in the portfolio; the survivor is dived instead. */
  | { kind: 'DUPLICATE'; of: string }
  /** Its recorded closing date has passed, so there is nothing left to win. */
  | { kind: 'EXPIRED'; at: string }
  /**
   * No answer a dive could find would make it executable now: a marketplace
   * listing, a close inside the runway, or capital the ledger does not hold.
   * Derived on every read, so it lifts by itself (`worthResearching.ts`).
   */
  | { kind: 'NOT_WORTH_RESEARCHING'; reason: NotWorthResearching };

/** One line, for a report or an operator. */
export function describeDiveRefusal(refusal: DiveRefusal): string {
  switch (refusal.kind) {
    case 'ELIGIBLE':
      return 'eligible — starts as soon as there is room';
    case 'IN_FLIGHT':
      return `a worker is on it (${refusal.state}), holding capacity`;
    case 'AWAITING_PERSON':
      return 'waiting on a person: its mission stopped at a decision only they can make';
    case 'EPOCH_SPENT':
      // Not "the sources do not publish the rest": a round closed by the stall
      // backstop researched nothing. What each dive established is in its own
      // reason, not in this count.
      return (
        `this epoch's dives are spent (${refusal.rounds}/${refusal.cap}); a distinct change ` +
        'opens a new epoch, and each dive’s own reason says what it established'
      );
    case 'STAGE_ONE_FAILED':
      return (
        `its stage-one screen settled with ${refusal.open.join(' and ') || 'the kill questions'} ` +
        'unanswered, so no full dive was spent on it; it reopens when that evidence changes'
      );
    case 'ALREADY_QUALIFIED':
      return `already ${refusal.tier} — a dive has nothing left to ask`;
    case 'DISQUALIFIED':
      return `disqualified by a published fact: ${refusal.reason.slice(0, 140)}`;
    case 'NOT_A_QUALIFYING_STATE':
      return `state ${refusal.state}: the commercial questions are closed`;
    case 'NOTHING_PUBLISHED_TO_ASK_ABOUT':
      return 'no buying signal and no source claim — nothing published to ask about';
    case 'DUPLICATE':
      return `a second record of ${refusal.of} (same source, same kind of opening) — that one is dived instead`;
    case 'EXPIRED':
      return `closed on ${refusal.at} — a dive cannot win an opening that has already closed`;
    case 'NOT_WORTH_RESEARCHING':
      return `not worth a dive now: ${describeNotWorthResearching(refusal.reason)}`;
  }
}

/**
 * The per-opening half of the decision, in the order the loop applies it.
 *
 * Every branch reads a row. The one clock read compares a closing date a row
 * states; nothing consults a count of workers or anything a caller supplied.
 */
export async function whyNotDiving(opportunity: CashOpportunity): Promise<DiveRefusal> {
  if (opportunity.validationState !== null) {
    if (HOLDS_A_SLOT.has(opportunity.validationState)) {
      return { kind: 'IN_FLIGHT', state: opportunity.validationState };
    }
    if (opportunity.validationState === 'NEEDS_PERSON') return { kind: 'AWAITING_PERSON' };
    const fact = await cardFactMap(opportunity.id);
    const disqualified = fact(DISQUALIFIED_FIELD);
    if (disqualified?.value) return { kind: 'DISQUALIFIED', reason: disqualified.value };

    const epoch = diveEpoch(opportunity);
    if (!epoch.fresh) {
      const inEpoch = startsInEpoch(await diveStarts(opportunity.id), epoch);
      const current = opportunity.candidateId
        ? [...inEpoch].reverse().find((one) => one.candidateId === opportunity.candidateId)
        : undefined;
      /*
       * The screen this epoch asked, and it did not pass.
       *
       * Only a settled screen: one still running is IN_FLIGHT above, and a
       * screen that found the payer has passed — the next dive is the full
       * one. What it found stays on the card, and the opening is dormant until
       * the reopen conditions recorded for it (`concludeScreens`) change.
       */
      /*
       * And only a screen that ran. A screen whose idea never became a mission
       * — closed by the stall backstop — searched nothing, so "no payer was
       * found" is not something it established. Production, 2026-10-19:
       * `cop_f895296d38f542c18b9e` went dormant as "no published source names a
       * payer" from a screen with no mission at all. It falls through, and
       * `resumeUnlaunchedDives` gives that round back.
       */
      if (
        current?.stage === 'SCREEN' &&
        !payerEstablished(opportunity, fact) &&
        (await latestMissionForCandidate(current.candidateId)) !== null
      ) {
        return { kind: 'STAGE_ONE_FAILED', open: ['payer'], epochStartedAt: epoch.startedAt };
      }
      const screens = inEpoch.filter((one) => one.stage === 'SCREEN').length;
      const cap = MAX_VALIDATION_ROUNDS + Math.min(screens, MAX_SCREENS_PER_EPOCH);
      /*
       * One bounded round more, to classify what an older dive left unclassified.
       *
       * A dive compiled before `ruled_out` existed could record a possible
       * disqualifier without saying whether it rules the opening out, and that
       * blocks qualification. Refusing another dive would make the block
       * permanent, since another dive — which offers `ruled_out` and asks the
       * open-or-closed question first — is exactly what settles it. So it gets
       * exactly one, and the bound is the round count rather than a flag.
       */
      const classifying =
        epoch.roundsUsed < cap + CLASSIFICATION_ROUNDS &&
        Boolean(fact(UNCLASSIFIED_DISQUALIFIER_FIELD)?.value) &&
        !fact(RULED_OUT_CLEARED_FIELD)?.value;
      if (epoch.roundsUsed >= cap && !classifying) {
        return {
          kind: 'EPOCH_SPENT',
          rounds: epoch.roundsUsed,
          cap,
          epochStartedAt: epoch.startedAt,
        };
      }
    }
    const tier = await qualifiedTier(opportunity);
    if (tier === 'QUALIFIED' || tier === 'READY_TO_TEST') {
      return { kind: 'ALREADY_QUALIFIED', tier };
    }
  }
  if (opportunity.state !== 'DISCOVERED' && opportunity.state !== 'EVIDENCE_CARD') {
    return { kind: 'NOT_A_QUALIFYING_STATE', state: opportunity.state };
  }
  if (opportunity.duplicateOfId) return { kind: 'DUPLICATE', of: opportunity.duplicateOfId };
  // The one clock read here, against a closing date a row states. Brain's own
  // clock, never a worker's; an opening with no recorded date is not assumed
  // closed (invariant 39).
  if (closedBy(opportunity.expiresAt, cashNow())) {
    return { kind: 'EXPIRED', at: opportunity.expiresAt! };
  }
  if (!opportunity.buyingSignal && !opportunity.sourceClaimId) {
    return { kind: 'NOTHING_PUBLISHED_TO_ASK_ABOUT' };
  }
  const waste = await notWorthResearching(opportunity, { now: cashNow() });
  if (waste) return { kind: 'NOT_WORTH_RESEARCHING', reason: waste };
  return { kind: 'ELIGIBLE' };
}

export { closedBy } from './closing.ts';

/** The card's own reading of how far this piece has got. */
async function qualifiedTier(opportunity: CashOpportunity): Promise<string> {
  const card = cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) });
  return cashTier({ opportunity, card, readiness: evidenceCard(opportunity).readiness }).tier;
}

/* --------------------------------------------------------------------------
 * Room: how many dives may start, derived (§3.4)
 * ------------------------------------------------------------------------ */

/**
 * How many more deep dives this project may start right now.
 *
 * The minimum of the grant's free `AT_ONCE` slots (one held back for discovery,
 * never the last), the research surfaces that could run one now, and zero while
 * the database is shedding — with one always allowed in flight while the grant
 * has a free slot. See `researchRoom.ts`. It replaces the fixed two, and it is
 * never above the person-set grant.
 */
export async function diveRoom(projectId: string, opportunities?: readonly CashOpportunity[]): Promise<ResearchRoom> {
  const all = opportunities ?? (await listOpportunities({ projectId }));
  const inFlight = all.filter((one) => HOLDS_A_SLOT.has(one.validationState ?? '')).length;
  // A PENDING dive has not launched, so it has not reserved its grant slot yet.
  const unlaunched = all.filter((one) => one.validationState === 'PENDING').length;
  return researchRoom({ projectId, inFlight, unlaunched });
}

/**
 * Why the **sprint** cannot start another dive, whatever any opening says.
 *
 * Reported beside the per-opening refusals rather than folded into them,
 * because *this piece is ineligible* and *there is no capacity for any piece*
 * are different facts with different remedies — and reading the second as the
 * first is how somebody concludes a healthy sprint is broken.
 */
export type SprintRefinementState =
  | { kind: 'NO_SPRINT' }
  | { kind: 'WOUND_DOWN'; reason: string }
  | { kind: 'NO_RESEARCH_AUTHORITY' }
  | { kind: 'SLOTS_TAKEN'; inFlight: number; cap: number; limitedBy: RoomLimit; reason: string }
  | { kind: 'READY'; free: number; cap: number; limitedBy: RoomLimit; reason: string };

export async function sprintCanRefine(projectId: string): Promise<SprintRefinementState> {
  if (!(await getCashMode(projectId))) return { kind: 'NO_SPRINT' };
  const gate = await discoveryAllowed(projectId);
  if (!gate.allowed) return { kind: 'WOUND_DOWN', reason: gate.reason ?? 'the sprint is not active' };
  if (!(await discoveryAuthority(projectId))) return { kind: 'NO_RESEARCH_AUTHORITY' };
  const room = await diveRoom(projectId);
  if (room.room <= 0) {
    return {
      kind: 'SLOTS_TAKEN',
      inFlight: room.inFlight,
      cap: room.cap,
      limitedBy: room.limitedBy,
      reason: room.reason,
    };
  }
  return { kind: 'READY', free: room.room, cap: room.cap, limitedBy: room.limitedBy, reason: room.reason };
}

export interface StartedValidation {
  opportunityId: string;
  candidateId: string;
  stage: DiveStage;
}

export interface ValidationProgress {
  started: StartedValidation[];
  settled: { opportunityId: string; to: OpportunityValidationState }[];
}

/**
 * The question a deep dive actually asks, composed from rows.
 *
 * The opening's own published words and its source, so the worker is
 * qualifying *this* thing rather than the category it belongs to. Nothing here
 * is invented: the signal is the claim's own sentence, which reached the
 * opportunity only by clearing the evidence gate.
 *
 * A `SCREEN` asks only the kill questions, in the order that makes each one
 * cheap: still open, who pays, what would rule it out. Everything else is the
 * full dive's, which is asked only once the screen passes.
 */
export function validationQuestion(
  opportunity: CashOpportunity,
  stage: DiveStage = 'FULL',
  /** `listingIdentitySentence`: the listing's id and original link, from its source claim. */
  listing = '',
): string {
  const signal = (opportunity.buyingSignal ?? opportunity.title).replace(/\s+/g, ' ').trim();
  const observed = opportunity.signalObservedAt
    ? ` It was published or observed on ${opportunity.signalObservedAt}.`
    : '';
  const source = (opportunity.source ? ` The source is ${opportunity.source}.` : '') + listing;
  if (stage === 'SCREEN') {
    return (
      `Before anything else is asked about this specific opening — "${signal}" — settle the ` +
      `three questions that can each end it.${source}${observed} ` +
      'First establish whether it is still open to a supplier like us: whether its closing ' +
      'date, expiry or listing status has passed, or a published rule excludes us. If it has ' +
      'closed or excludes us, submit that one fact in the ruled_out lane with its source and ' +
      'stop. Otherwise establish who actually pays for it, named in a published source, and ' +
      'how a supplier reaches them; and whether anything published would disqualify it ' +
      'outright. Nothing else about it is asked at this stage. Where no published source ' +
      'names a payer, say so plainly with where you looked rather than naming a kind of buyer.'
    );
  }
  return (
    `What would somebody need to know before acting on this specific opening: "${signal}".` +
    `${source}${observed} ` +
    /*
     * The decisive question first, because it is the cheap one.
     *
     * Production, Cash Mode 1: nine of the dives that reached their
     * disqualifier recorded a closing date already passed or a listing already
     * closed — after twenty to thirty minutes spent on the payer, the price, the
     * costs and the effort of something nobody could take. Whether an opening
     * is still open is one look at its own source, and when the answer is no it
     * is the whole answer.
     */
    'First establish whether this opening is still open to a supplier like us: whether its ' +
    'closing date, expiry or listing status has passed, or a published rule excludes us. If ' +
    'it has closed or excludes us, submit that one fact in the ruled_out lane with its ' +
    'source and stop; nothing else about it needs answering. Otherwise establish who ' +
    'actually pays and how a supplier reaches them, what ' +
    'comparable work is published at, what delivering it would cost, what capital it needs ' +
    'before any money arrives, how long published terms say payment takes, how much human ' +
    'time comparable work is published as taking, whether selling, calling, fulfilment or ' +
    'subcontracted labour is required, what the first steps would be, what the bottleneck is, ' +
    'and whether anything published would disqualify it outright. Establish also what rule ' +
    'decides whether a supplier like this one is eligible at all, what is published about ' +
    'acquiring the thing itself now and from whom, whether anything actually sells at the ' +
    'higher figure after fees rather than merely being listed or appraised at it, and whether ' +
    'the only published route to the buyer is a telephone call. ' +
    'A price somebody else charges, an asking price and an appraisal are evidence about a ' +
    'market and are not evidence that anybody would pay us: where that is all there is, say ' +
    'so plainly rather than treating it as an answer.'
  );
}

/* --------------------------------------------------------------------------
 * Decision-value order (§3.3(c)) — lexicographic, never weighted
 * ------------------------------------------------------------------------ */

/**
 * The card fields research should pursue on this opening **now**, kill
 * questions first.
 *
 * The `feeds()` principle from `commission.ts`, applied to card fields: a blank
 * that cannot move the tier until an earlier one clears is not worth a research
 * need yet. Pure, and it reads no prose:
 *
 *   * with the payer open, only the stage-one kill fields — nothing past them
 *     can move the opening while nobody is known to pay;
 *   * a SIGNAL needs a capture thesis, which Brain composes from a payer, a way
 *     to reach them and published buying evidence — so those inputs, where open;
 *   * otherwise the open requirements on the current rung, kill fields first.
 *
 * `answered` reads the engine card when the caller has one; without it the
 * tier's own open set is used, and for a SIGNAL the opportunity's columns.
 * The caller filters by owner: this says what is worth asking, not who asks.
 */
export function fieldsWorthResearching(
  opportunity: CashOpportunity,
  tier: TierReading,
  answered?: (key: QualificationKey) => boolean,
): QualificationKey[] {
  const open = new Set(tier.toAdvance.map((one) => one.key));
  const column: Partial<Record<QualificationKey, unknown>> = {
    payer: opportunity.payer,
    access: opportunity.reachableChannel,
    buyingEvidence: opportunity.buyingSignal,
  };
  const isAnswered =
    answered ??
    ((key: QualificationKey): boolean =>
      tier.tier === 'SIGNAL'
        ? Boolean(String(column[key] ?? '').trim())
        : !open.has(key));
  if (tier.tier === 'QUALIFIED' || tier.tier === 'READY_TO_TEST') {
    return tier.toAdvance.map((one) => one.key);
  }
  const killOpen = STAGE_ONE_FIELDS.filter((key) => !isAnswered(key));
  if (killOpen.includes('payer')) return killOpen;
  if (tier.tier === 'SIGNAL') {
    return [...killOpen, ...CAPTURE_INPUTS.filter((key) => !isAnswered(key) && !killOpen.includes(key))];
  }
  const rest = tier.toAdvance.map((one) => one.key).filter((key) => !killOpen.includes(key));
  return [...killOpen.filter((key) => open.has(key) || !isAnswered(key)), ...rest];
}

/** What the order compares, read from rows. Every field is a recorded fact. */
export interface DiveValueFacts {
  id: string;
  createdAt: string;
  /** A distinct change arrived after its last dive started. */
  reconsidered: boolean;
  /** One answer could move it a tier, or only kill questions stand in its way. */
  crossesTier: boolean;
  /** The stage its next dive would ask. */
  stage: DiveStage;
  /** Its recorded peak funding against deployable cash; unknown is its own value. */
  capital: 'FITS' | 'EXCEEDS' | 'UNKNOWN';
  /** Days to first cash a source on its card states, or null. */
  timeToCashDays: number | null;
  /** How much of its card is already answered — the archive partly answers it. */
  answered: number;
  /**
   * Published price less published exposure, per sale, or null. Optional so a
   * caller built before it existed still compares; null and absent sort last.
   */
  contributionCents?: number | null;
  /**
   * What earlier deep dives on openings of the same mechanism achieved, read
   * from rows (`mechanismYield`). Optional so a caller built before it existed
   * still compares; absent reads as UNMEASURED.
   */
  mechanismYield?: MechanismYield;
}

/**
 * Whether deep dives on openings of one mechanism have changed decisions.
 *
 * `UNPRODUCTIVE` needs `MECHANISM_MIN_SAMPLE` settled dives and not one of them
 * ending in a decision — qualified, or declined/archived. Anything less is
 * `UNMEASURED`, which ranks exactly as `PRODUCTIVE` does: a mechanism with no
 * history is never pushed back for lacking one (exploration is preserved), and
 * one success is enough to restore a mechanism to the front. It orders; it
 * never refuses — an opening of an unproductive mechanism still starts the
 * moment there is room ahead of nothing better.
 */
export type MechanismYield = 'PRODUCTIVE' | 'UNMEASURED' | 'UNPRODUCTIVE';
export const MECHANISM_MIN_SAMPLE = 8;

export function mechanismYields(
  pieces: readonly { mechanism: string | null | undefined; validationState: string | null; tier: CashTier; state: string }[],
): Map<string, { settled: number; decided: number; yield: MechanismYield }> {
  const out = new Map<string, { settled: number; decided: number; yield: MechanismYield }>();
  for (const piece of pieces) {
    if (!piece.mechanism) continue;
    if (piece.validationState !== 'COMPLETE' && piece.validationState !== 'BLOCKED') continue;
    const row = out.get(piece.mechanism) ?? { settled: 0, decided: 0, yield: 'UNMEASURED' as MechanismYield };
    row.settled += 1;
    const decided =
      piece.tier === 'QUALIFIED' ||
      piece.tier === 'READY_TO_TEST' ||
      piece.state === 'DECLINED' ||
      piece.state === 'ARCHIVED';
    if (decided) row.decided += 1;
    out.set(piece.mechanism, row);
  }
  for (const row of out.values()) {
    row.yield =
      row.decided > 0 ? 'PRODUCTIVE' : row.settled >= MECHANISM_MIN_SAMPLE ? 'UNPRODUCTIVE' : 'UNMEASURED';
  }
  return out;
}

const CAPITAL_ORDER: Readonly<Record<DiveValueFacts['capital'], number>> = Object.freeze({
  FITS: 0,
  EXCEEDS: 1,
  // Unknowns last (invariant 39): a blank is never the reason something rises.
  UNKNOWN: 2,
});

/**
 * Which of two openings to dive first. A comparator over recorded facts, in a
 * fixed order — the first criterion two openings differ on decides, and nothing
 * below it is consulted. No number is computed and nothing is weighted:
 *
 *   1. reconsidered since its last dive;
 *   2. an answer could cross a tier boundary;
 *   2a. its mechanism's earlier dives have not been measured unproductive;
 *   3. a kill question (a screen) before refinement;
 *   4. capital known to fit deployable cash, then known time to cash, shortest
 *      first — unknowns last;
 *   5. the card already partly answered;
 *   6. arrival order.
 */
export function compareDiveValue(a: DiveValueFacts, b: DiveValueFacts): number {
  if (a.reconsidered !== b.reconsidered) return a.reconsidered ? -1 : 1;
  if (a.crossesTier !== b.crossesTier) return a.crossesTier ? -1 : 1;
  const ua = a.mechanismYield === 'UNPRODUCTIVE';
  const ub = b.mechanismYield === 'UNPRODUCTIVE';
  if (ua !== ub) return ua ? 1 : -1;
  if (a.stage !== b.stage) return a.stage === 'SCREEN' ? -1 : 1;
  if (a.capital !== b.capital) return CAPITAL_ORDER[a.capital] - CAPITAL_ORDER[b.capital];
  if (a.timeToCashDays !== b.timeToCashDays) {
    if (a.timeToCashDays === null) return 1;
    if (b.timeToCashDays === null) return -1;
    return a.timeToCashDays - b.timeToCashDays;
  }
  /*
   * Expected usable profit, from published figures only. Larger first; an
   * unknown contribution never outranks a known one (invariant 39).
   */
  const ca = a.contributionCents ?? null;
  const cb = b.contributionCents ?? null;
  if (ca !== cb) {
    if (ca === null) return 1;
    if (cb === null) return -1;
    return cb - ca;
  }
  if (a.answered !== b.answered) return b.answered - a.answered;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The facts the order compares, for one opening. Pure. */
export function diveValueFacts(input: {
  opportunity: CashOpportunity;
  tier: TierReading;
  fact: (field: string) => CashCardFact | null;
  deployableCents: number | null;
  readDays: (text: string) => number | null;
}): DiveValueFacts {
  const { opportunity, tier, fact } = input;
  const epoch = diveEpoch(opportunity);
  const worth = fieldsWorthResearching(opportunity, tier);
  const funding = opportunity.peakFundingCents;
  const capital: DiveValueFacts['capital'] =
    funding === null || funding === undefined || input.deployableCents === null
      ? 'UNKNOWN'
      : funding <= input.deployableCents
        ? 'FITS'
        : 'EXCEEDS';
  const time = fact('timeToFirstCash');
  return {
    id: opportunity.id,
    createdAt: opportunity.createdAt,
    reconsidered: epoch.fresh && opportunity.validationStartedAt !== null,
    crossesTier:
      worth.length === 1 || (worth.length > 0 && worth.every((key) => STAGE_ONE_FIELDS.includes(key))),
    stage: nextDiveStage(opportunity, fact),
    capital,
    timeToCashDays: time?.value ? input.readDays(time.value) : null,
    answered: answeredCount(opportunity),
    contributionCents:
      opportunity.priceCents !== null && funding !== null && funding !== undefined
        ? opportunity.priceCents - funding
        : null,
  };
}

/**
 * Start the deep dive on openings that may have one.
 *
 * Bounded by `diveRoom`, which is the person-set grant, the surfaces that could
 * run it and the database's pressure — never a fixed number, and never above
 * the grant. An optional `limit` lowers it further and never raises it.
 *
 * Idempotent by the opportunity's own row: `validation_state` moves to PENDING
 * in the same transaction that writes the dive's started event, and a piece
 * that already has one is skipped. A crash between creating the candidate and
 * that transaction leaves a candidate with no owner, which nothing compiles —
 * losing one captured idea, which is recoverable, rather than double-spending a
 * research mission, which is not.
 */
export async function startValidations(input: {
  projectId: string;
  limit?: number;
}): Promise<StartedValidation[]> {
  const mode = await getCashMode(input.projectId);
  if (!mode) return [];
  /*
   * Winding down stops this, exactly as it stops `openDiscovery`.
   *
   * A deep dive is bounded and it is still new spending on a question nobody
   * has yet asked, so starting one after somebody has said stop is Brain
   * beginning something after the off switch. What is *not* gated is
   * `settleValidations` and `applyValidationAnswers` below: the answers to what
   * already started must still arrive, because the spending happened when it
   * ran and dropping the results would throw away work already paid for.
   */
  const gate = await discoveryAllowed(input.projectId);
  if (!gate.allowed) return [];
  /*
   * The same authorization the discovery ran under.
   *
   * Not a second grant and not a second decision: if pressing Start did not
   * authorize research here, a deep dive is not authorized either, and the
   * candidate would park with that reason anyway. Checking here means it is
   * not captured in the first place.
   */
  if (!(await discoveryAuthority(input.projectId))) return [];

  const all = await listOpportunities({ projectId: input.projectId });
  const derived = await diveRoom(input.projectId, all);
  let room = derived.room;
  if (input.limit !== undefined) room = Math.min(room, Math.max(0, Math.trunc(input.limit)));
  if (room <= 0) return [];

  /*
   * The order is the decision-value order, and it is a preference rather than
   * a ceiling: nothing is refused because of it, and a piece at the back still
   * starts the moment there is room. Facts are read once per pass — the card
   * facts for the whole project in one query.
   */
  const factsById = new Map<string, CashCardFact[]>();
  for (const one of await cardFactsForProject(input.projectId)) {
    factsById.set(one.opportunityId, [...(factsById.get(one.opportunityId) ?? []), one]);
  }
  const position = await cashPosition({ projectId: input.projectId, currency: mode.currency }).catch(
    () => null,
  );
  const { readDays } = await import('./monetization/commissionPass.ts');
  const lookup = (id: string) => {
    const facts = factsById.get(id) ?? [];
    return (field: string): CashCardFact | null => facts.find((one) => one.field === field) ?? null;
  };
  const tiered = all.map((opportunity) => {
    const facts = factsById.get(opportunity.id) ?? [];
    const tier = cashTier({
      opportunity,
      card: cashEngineCard({ opportunity, facts }),
      readiness: evidenceCard(opportunity).readiness,
    });
    return { opportunity, tier };
  });
  const yields = mechanismYields(
    tiered.map(({ opportunity, tier }) => ({
      mechanism: opportunity.mechanism,
      validationState: opportunity.validationState,
      tier: tier.tier,
      state: opportunity.state,
    })),
  );
  const valued = tiered.map(({ opportunity, tier }) => ({
    opportunity,
    value: {
      ...diveValueFacts({
        opportunity,
        tier,
        fact: lookup(opportunity.id),
        deployableCents: position?.deployableCents ?? null,
        readDays,
      }),
      mechanismYield: (opportunity.mechanism && yields.get(opportunity.mechanism)?.yield) || 'UNMEASURED',
    } as DiveValueFacts,
  }));
  valued.sort((a, b) => compareDiveValue(a.value, b.value));

  const out: StartedValidation[] = [];
  for (const { opportunity, value } of valued) {
    if (out.length >= room) break;
    /*
     * One condition, and `refinement-report` reads the same one.
     *
     * Every refusal — a dive already over, a state where the commercial
     * questions are closed, nothing published to ask about, an epoch spent, a
     * screen failed — is applied by `whyNotDiving`, which exists because a
     * report that re-derived them would be the *two readers of one fact*
     * defect this repository records more than any other.
     */
    if ((await whyNotDiving(opportunity)).kind !== 'ELIGIBLE') continue;

    const stage = value.stage;
    const epoch = diveEpoch(opportunity);
    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      title: `${stage === 'SCREEN' ? 'Screen' : 'Qualify'}: ${opportunity.title}`,
      // The listing's id and original link travel with the question, so the
      // worker reads this listing rather than rebuilding an address for it.
      statement: validationQuestion(opportunity, stage, await listingSentenceFor(opportunity)),
    });
    /*
     * The first dive after a distinct change is round one of its epoch, so the
     * column counts this epoch's dives and nothing older. A screen counts as a
     * round too; the epoch's cap allows for the one screen it may have.
     */
    const round = epoch.fresh ? 1 : opportunity.validationRounds + 1;
    const startedAt = new Date().toISOString();
    let moved = false;
    await getDb().transaction(async () => {
      const written = await updateOpportunity(opportunity.id, {
        // `candidate_id` is "the idea this opportunity is", which is the column
        // the compiler reads to know it is compiling a deep dive rather than a
        // bucket. `discovered_by_candidate_id` stays as it was.
        candidate_id: candidate.id,
        validation_state: 'PENDING',
        validation_started_at: startedAt,
        validation_rounds: round,
        /*
         * A later round clears the settled stamp and leaves everything else.
         *
         * An earlier round's orchestration id is deliberately *not* cleared: it
         * is the provenance of every card fact that round produced, and
         * `applyValidationAnswers` reads every round's packet. Nothing recorded
         * is destroyed — `mayReplace` still decides authority, so a fact from an
         * earlier dive is only ever replaced by one of at least equal standing.
         */
        validation_settled_at: null,
      });
      if (!written) return;
      moved = true;
      /*
       * In the same transaction as the candidate's name on the row: the stage
       * is what the compiler reads to choose the screen profile, so there is no
       * moment at which the opening names an idea whose stage nobody recorded.
       */
      await recordCashEvent({
        projectId: input.projectId,
        opportunityId: opportunity.id,
        kind: DIVE_STARTED_EVENT,
        actorRef: 'BRAIN',
        summary:
          stage === 'SCREEN'
            ? 'Brain is screening this opening from published sources: whether it is still open, ' +
              'who actually pays, and whether anything rules it out — the questions that can ' +
              'each end it. Nothing is being contacted or spent.'
            : round > 1
              ? 'Brain is qualifying this opening again, for the questions the last pass did not ' +
                'settle. Nothing is being contacted or spent.'
              : 'Brain is qualifying this opening from published sources: who pays, what it pays, ' +
                'what it costs and what would rule it out. Nothing is being contacted or spent.',
        detail: {
          candidateId: candidate.id,
          signal: opportunity.buyingSignal,
          round,
          stage,
          epochStartedAt: epoch.startedAt,
        },
      });
    });
    if (!moved) continue;
    out.push({ opportunityId: opportunity.id, candidateId: candidate.id, stage });
  }
  return out;
}

/**
 * How far along one opening's own card already is, counted from its columns.
 *
 * The columns `answers.ts` maps card fields onto, plus the two evidence
 * columns a signal is born with. Nothing here reads prose and nothing here
 * forms a view about how good any of it is; it is a count of rows, used only
 * as one criterion of the decision-value order.
 */
function answeredCount(one: CashOpportunity): number {
  const values = [
    one.payer,
    one.reachableChannel,
    one.offerScope,
    one.acceptanceCondition,
    one.priceCents,
    one.deliveryMethod,
    one.fulfillmentOwner,
    one.economicsNote,
    one.peakFundingCents,
  ];
  return values.filter((value) => value !== null && value !== undefined && value !== '').length;
}

/**
 * Move each deep dive to where its own mission actually is.
 *
 * Derived from rows on every tick rather than hooked to the moment a mission
 * finishes, which is the distinction this repository has needed five times: a
 * hook fixes one entrance, and rows reach every entrance plus everything
 * already stranded.
 *
 * It reads the mission and the packet and says what they say. It forms no view
 * about whether the answers were good — that is the card's job, and the card
 * reads the accepted claims themselves.
 */
export async function settleValidations(projectId: string): Promise<
  { opportunityId: string; to: OpportunityValidationState }[]
> {
  if (!(await getCashMode(projectId))) return [];
  const out: { opportunityId: string; to: OpportunityValidationState }[] = [];

  for (const opportunity of await listOpportunities({ projectId })) {
    /*
     * `NEEDS_PERSON` is re-read on every tick as well, and that is the half
     * that makes it a park rather than a dead end.
     *
     * A person answering the mission's Needs You card puts it back to
     * `RUNNING`, and nothing else in this loop would notice: the opening would
     * sit at `NEEDS_PERSON` while the packet it names finished. So the states
     * this pass reconciles are every non-terminal one, and the mission below
     * decides where each goes — which is the same shape `settleValidations`
     * already had, with the state that was missing from it added.
     */
    if (
      opportunity.validationState !== 'PENDING' &&
      opportunity.validationState !== 'RUNNING' &&
      opportunity.validationState !== 'NEEDS_PERSON'
    ) {
      continue;
    }
    if (!opportunity.candidateId) continue;
    const candidate = await getCandidate(opportunity.candidateId);
    if (!candidate) continue;

    const mission = await latestMissionForCandidate(opportunity.candidateId);
    if (!mission) {
      /*
       * Parked before it ever launched, and the reason is worth carrying.
       *
       * A candidate that reached `PARKED` has been judged and has nowhere to
       * go — most often because the compiler refused its specification. That
       * is a blocked validation rather than one still waiting, and reporting it
       * as pending would be the "waiting nobody can resolve" shape §24 records.
       */
      if (candidate.state === 'PARKED') {
        await settle(projectId, opportunity, 'BLOCKED', candidate.reason ?? 'The deep dive was parked.');
        out.push({ opportunityId: opportunity.id, to: 'BLOCKED' });
        continue;
      }
      /*
       * And launched, but no mission ever appeared.
       *
       * The stall backstop below cannot see this: it is guarded on
       * `mission.state === 'RUNNING'`, and here there is no mission at all. So
       * a dive whose candidate never got judged held a slot with **no bound on
       * it whatever** — `PENDING` counts against the dive room,
       * and nothing in this function could ever take it back.
       *
       * Under ordinary operation the Russell tick judges a candidate within
       * minutes and it becomes a mission or reaches `PARKED`, which the branch
       * above answers. This is what happens when that stops: §24's *waiting
       * nobody can resolve*, at the one state that is also scarce.
       *
       * Found by reading production rather than the code. The first causal
       * reading of a live sprint printed two `PENDING` dives holding both
       * slots with `candidate=QUEUED mission=— packet=—`, against four parked
       * dives whose missions had appeared in 5, 19, 31 and 44 minutes. One of
       * them had been waiting an hour and a half. Nothing was wrong with it
       * yet, and nothing would ever have been able to say so.
       *
       * The same window and the same verdict as a stalled mission, for the
       * same reason: `BLOCKED` keeps every row, frees the slot, and leaves
       * `whyNotDiving` free to offer the second round.
       */
      const launchedAt = opportunity.validationStartedAt;
      if (launchedAt && Date.now() - Date.parse(launchedAt) > VALIDATION_STALL_MS) {
        /*
         * Not while the only thing in the way is a full mission slot.
         *
         * Production, 2026-10-04: the research grant's six slots were held by
         * missions whose packets had no worker to run on — every research
         * surface was quarantined — so no idea could launch. This backstop
         * closed each waiting dive at six hours anyway, the next dive took the
         * freed dive slot and could not launch either, and twenty-four of forty
         * openings ended `ROUNDS_SPENT` with no research ever having run. An
         * idea refused `AT_ONCE` is queued, not stalled: `launch()` itself
         * treats that refusal as an ordinary wait. So the dive keeps its slot
         * and its round, and launches the moment a mission slot frees. Any
         * other reason it has not launched is still closed at six hours.
         */
        if (candidate.state === 'QUEUED' && (await researchMissionSlotsFull(projectId)) === true) {
          continue;
        }
        const hours = Math.floor((Date.now() - Date.parse(launchedAt)) / (60 * 60 * 1000));
        await settle(
          projectId,
          opportunity,
          'BLOCKED',
          `The deep dive was launched ${hours} hours ago and no mission has been created for ` +
            'it, so nothing is researching it. Brain has freed the slot; it can be asked again.',
        );
        out.push({ opportunityId: opportunity.id, to: 'BLOCKED' });
      }
      continue;
    }

    if (opportunity.validationState !== 'RUNNING' && mission.state === 'RUNNING') {
      /*
       * Reached from `PENDING` — the ordinary launch — and from
       * `NEEDS_PERSON`, which is a person having answered the mission's card.
       * Both are the same fact: a worker is on it now.
       */
      await updateOpportunity(opportunity.id, {
        validation_state: 'RUNNING',
        validation_settled_at: null,
        validation_orchestration_id: mission.orchestrationId,
      });
      out.push({ opportunityId: opportunity.id, to: 'RUNNING' });
      continue;
    }

    /*
     * The mission stopped at a decision only a person can make.
     *
     * This branch did not exist, and its absence was a deadlock rather than an
     * untidy state. `NEEDS_HUMAN` is none of `DONE`, `FAILED` or `CANCELLED`,
     * so the opening stayed `RUNNING` for ever while nothing ran — and because
     * `RUNNING` counts against the dive room (then a fixed two), production had
     * **both** of its two slots held by parked missions. Thirty-eight openings
     * could never be qualified, and no deep dive could ever start again.
     *
     * It is a park with an answering transition rather than a failure: the
     * mission's own Needs You card is what resolves it, the branch above puts
     * the opening back to `RUNNING` when somebody does, and `whyNotDiving`
     * answers `AWAITING_PERSON` meanwhile so the answer is not bought twice.
     */
    if (mission.state === 'NEEDS_HUMAN') {
      const packet = mission.orchestrationId ? await getOrchestration(mission.orchestrationId) : null;
      /*
       * A judge asking for more research is not a person's decision for the opening.
       *
       * Production, 2026-10-19: 30 openings sat at AWAITING_PERSON, nearly all
       * because their dive's report drew a PATCH or MORE_RESEARCH verdict. The
       * accepted claims of that packet already reach the card (a BLOCKED dive's
       * citable claims are read like a COMPLETE one's), and the remedy the
       * verdict names — more research — is exactly the next dive this epoch
       * still allows. So the dive settles BLOCKED with the verdict as its
       * reason, `whyNotDiving` offers the next round against what is still
       * open, and the packet's own Needs You card is left exactly as it is for
       * whoever wants to answer it. A park for anything else — an envelope, an
       * authorization — still waits on its person.
       */
      const parkedFor = packet?.failureReason ?? mission.waitingOn ?? mission.terminalReason ?? null;
      if (judgeAskedForResearch(parkedFor)) {
        await settle(
          projectId,
          opportunity,
          'BLOCKED',
          `The deep dive's report was sent back for more research; what it established is on the card, ` +
            `and the next round asks what is still open. ${parkedFor}`,
          mission.orchestrationId,
        );
        out.push({ opportunityId: opportunity.id, to: 'BLOCKED' });
        continue;
      }
      if (opportunity.validationState !== 'NEEDS_PERSON') {
        await settle(
          projectId,
          opportunity,
          'NEEDS_PERSON',
          packet?.failureReason ??
            mission.terminalReason ??
            'The deep dive stopped at a decision only a person can make. Answering it in Needs ' +
              'you is what restarts it.',
          mission.orchestrationId,
        );
        out.push({ opportunityId: opportunity.id, to: 'NEEDS_PERSON' });
      }
      continue;
    }

    /*
     * Launched, and nothing has happened since.
     *
     * The backstop for what the mission row cannot express, and the condition
     * is **no progress** rather than elapsed time. That distinction is the
     * whole of it: a research packet legitimately takes hours — §27 measures a
     * single judge pass at nine minutes and forty-four seconds, and a
     * validation packet is a plan, fragments, a verification, a synthesis and
     * three separately-sessioned audit roles — so a clock started at launch
     * would cancel live work that is doing exactly what it should. What is
     * measured instead is the gap since the last thing a worker actually
     * *finished*, and a dive whose passes keep completing is never reached
     * here however long it runs.
     *
     * `BLOCKED` rather than failed, with the gap in the reason, so
     * `whyNotDiving` can offer another round instead of writing it off. And
     * nothing is destroyed: every pass, claim and raw response stays exactly
     * where it is.
     */
    const startedAt = opportunity.validationStartedAt;
    /*
     * A **running** mission that has gone quiet, and only that.
     *
     * The guard on `RUNNING` is what keeps this from reaching a mission that
     * has already finished. Without it, a dive whose packet completed
     * yesterday and whose tick was down overnight would be read here first —
     * its last pass is older than the window — and settled `BLOCKED`,
     * throwing away a `COMPLETE` and the card facts `applyValidationAnswers`
     * would have taken from it. A backstop that can destroy a result is worse
     * than no backstop.
     */
    if (startedAt && mission.state === 'RUNNING') {
      const passes = mission.orchestrationId ? await listPasses(mission.orchestrationId) : [];
      const finished = passes
        .map((pass) => pass.completedAt)
        .filter((at): at is string => at !== null);
      // The most recent sign of life, which is the launch itself when a worker
      // has not finished anything yet.
      const lastMovedAt = finished.reduce((latest, at) => (at > latest ? at : latest), startedAt);
      const quiet = Date.now() - Date.parse(lastMovedAt);
      if (quiet > VALIDATION_STALL_MS) {
        const hours = Math.floor(quiet / (60 * 60 * 1000));
        await settle(
          projectId,
          opportunity,
          'BLOCKED',
          `The deep dive has produced nothing for ${hours} hours` +
            `${finished.length > 0 ? ` — its last completed pass was ${lastMovedAt}` : ' and no pass has finished at all'}. ` +
            'Brain has stopped calling it running and freed the slot; it can be asked again.',
          mission.orchestrationId,
        );
        out.push({ opportunityId: opportunity.id, to: 'BLOCKED' });
        continue;
      }
    }

    if (mission.state === 'DONE') {
      await settle(
        projectId,
        opportunity,
        'COMPLETE',
        'The deep dive finished and its accepted claims are on the card.',
        mission.orchestrationId,
      );
      out.push({ opportunityId: opportunity.id, to: 'COMPLETE' });
      continue;
    }
    if (mission.state === 'FAILED' || mission.state === 'CANCELLED') {
      const packet = mission.orchestrationId ? await getOrchestration(mission.orchestrationId) : null;
      await settle(
        projectId,
        opportunity,
        'BLOCKED',
        packet?.failureReason ??
          mission.terminalReason ??
          'The deep dive did not produce a report.',
        mission.orchestrationId,
      );
      out.push({ opportunityId: opportunity.id, to: 'BLOCKED' });
    }
  }
  return out;
}

async function settle(
  projectId: string,
  opportunity: CashOpportunity,
  to: OpportunityValidationState,
  why: string,
  orchestrationId?: string | null,
): Promise<void> {
  await updateOpportunity(opportunity.id, {
    validation_state: to,
    validation_settled_at: new Date().toISOString(),
    ...(orchestrationId ? { validation_orchestration_id: orchestrationId } : {}),
  });
  await recordCashEvent({
    projectId,
    opportunityId: opportunity.id,
    /*
     * Two event kinds for five states, and `NEEDS_PERSON` deliberately reports
     * as the blocked one rather than gaining a third.
     *
     * The vocabulary is what the history reads back, and a park is what a
     * reader of that history most needs to see beside a block — both mean "no
     * answer arrived and here is why". The `detail` carries the exact state,
     * so nothing is lost, and adding a kind would have meant a reader that did
     * not know it showing a blank row.
     */
    kind: to === 'COMPLETE' ? 'CASH_VALIDATION_COMPLETE' : 'CASH_VALIDATION_BLOCKED',
    actorRef: 'BRAIN',
    summary: why,
    detail: { validationState: to, orchestrationId: orchestrationId ?? null },
  });
}

/**
 * Give back a round that researched nothing, by resuming the dive that spent it.
 *
 * Production, 2026-10-01: 32 of 40 openings sat `BLOCKED` at round 2 of 2 with
 * `candidate=QUEUED mission=— passes 0/0`. The idea behind each dive never
 * launched — `nextLaunchable` took `LIMIT 50` over ideas that could never
 * launch and nothing behind them was looked at — and the six-hour backstop in
 * `settleValidations` closed each one. Both of each opening's rounds were spent
 * on stalls, so `whyNotDiving` read `ROUNDS_SPENT` and nothing would ask again.
 *
 * Derived from rows on every tick, so it reaches the openings already stranded
 * as well as any future one. What makes a round restorable is read, never
 * assumed:
 *
 *   - the opening is `BLOCKED` and its current idea is still `QUEUED` with no
 *     mission at all — research never started, so nothing it found can exist;
 *   - each earlier round is read from its own `CASH_VALIDATION_STARTED` event,
 *     and only a round whose idea has no mission is given back. A round whose
 *     idea launched counts, whatever came of it;
 *   - an opening with no started events keeps every round it has — a history
 *     Brain cannot read is never read as "nothing ran".
 *
 * It resumes rather than restarts: the same idea, the same question, the
 * opening back to `PENDING` with the clock reset, so `settleValidations`
 * follows its mission when it launches. An earlier round's idea that never
 * launched is parked, because once the launch window is open it would
 * otherwise launch a mission no opening owns. Nothing is deleted: the block,
 * the stalled ideas and their events all stay, and `CASH_VALIDATION_RESUMED`
 * records what was given back and why.
 *
 * Bounded twice: one resume per idea, ever, so an idea that cannot launch for
 * some other reason stalls once more and stays `BLOCKED`; and it takes only
 * free slots, ahead of new dives, because finishing a question already asked
 * comes before asking a new one.
 */
export async function resumeUnlaunchedDives(projectId: string): Promise<string[]> {
  const gate = await discoveryAllowed(projectId);
  if (!gate.allowed) return [];
  if (!(await discoveryAuthority(projectId))) return [];

  const all = await listOpportunities({ projectId });
  let room = (await diveRoom(projectId, all)).room;
  const out: string[] = [];

  for (const opportunity of all) {
    if (room <= 0) break;
    if (opportunity.validationState !== 'BLOCKED' || !opportunity.candidateId) continue;
    const current = await getCandidate(opportunity.candidateId);
    if (!current || current.state !== 'QUEUED') continue;
    if (await latestMissionForCandidate(current.id)) continue;

    const events = await listCashEventsFor(opportunity.id, 500);
    const candidateOf = (detail: Record<string, unknown> | null | undefined) =>
      typeof detail?.['candidateId'] === 'string' ? (detail['candidateId'] as string) : null;
    /*
     * Twice per idea, never more — and the second only for an idea that was
     * always launchable.
     *
     * The first bound was once, ever, so that an idea which cannot launch for
     * some reason of its own stalls once more and stays `BLOCKED`. Production
     * found the case that bound was not written for: ideas with a compiled
     * specification, stalled twice only because every mission slot was held
     * by missions with no worker, each resume spent before the stall backstop
     * knew to wait (see `settleValidations`). That backstop now waits on a
     * full slot, so a launchable idea resumed a second time cannot be closed
     * again by the same cause, and the cap of two still ends a loop for any
     * other one.
     */
    const resumes = events.filter(
      (event) => event.kind === 'CASH_VALIDATION_RESUMED' && candidateOf(event.detail) === current.id,
    ).length;
    if (resumes >= 2) continue;
    if (resumes === 1 && !hasCompiledSpecification(current.judgment)) continue;
    const started = [
      ...new Set(
        events
          .filter((event) => event.kind === 'CASH_VALIDATION_STARTED')
          .map((event) => candidateOf(event.detail))
          .filter((id): id is string => id !== null),
      ),
    ];

    /*
     * Rounds are counted per epoch, so only this epoch's launched dives count
     * against what is given back. Every epoch's unlaunched ideas are still
     * parked, because any of them would otherwise launch a mission no opening
     * owns.
     */
    const epoch = diveEpoch(opportunity);
    const inEpoch = new Set(
      events
        .filter(
          (event) =>
            event.kind === DIVE_STARTED_EVENT &&
            (epoch.startedAt === null || event.createdAt >= epoch.startedAt),
        )
        .map((event) => candidateOf(event.detail))
        .filter((id): id is string => id !== null),
    );
    const parked: string[] = [];
    let launched = 0;
    for (const candidateId of started) {
      if (candidateId === current.id) continue;
      if (await latestMissionForCandidate(candidateId)) {
        if (inEpoch.has(candidateId)) launched += 1;
        continue;
      }
      const earlier = await getCandidate(candidateId);
      if (earlier?.state === 'QUEUED') {
        await transitionCandidate({ candidateId, from: 'QUEUED', to: 'PARKED' });
      }
      parked.push(candidateId);
    }
    // No readable history: keep what is there. The resume still happens, so
    // the dive is not lost, but nothing is given back on a guess.
    // A change since the dive started makes the resumed dive this epoch's first.
    const toRounds = epoch.fresh
      ? 1
      : started.length === 0
        ? opportunity.validationRounds
        : Math.min(opportunity.validationRounds, launched + 1);

    const resumed = await resumeBlockedValidation({
      id: opportunity.id,
      fromRounds: opportunity.validationRounds,
      toRounds,
      startedAt: new Date().toISOString(),
    });
    if (!resumed) continue;
    await recordCashEvent({
      projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_VALIDATION_RESUMED',
      actorRef: 'BRAIN',
      summary:
        'This deep dive never started researching: its idea was never launched, so the six-hour ' +
        'backstop closed it with nothing found. Brain has resumed the same question and given back ' +
        `the ${opportunity.validationRounds - toRounds === 1 ? 'round' : 'rounds'} that researched nothing.`,
      detail: {
        candidateId: current.id,
        fromRounds: opportunity.validationRounds,
        toRounds,
        restoredRounds: opportunity.validationRounds - toRounds,
        parkedCandidates: parked,
      },
    });
    out.push(opportunity.id);
    room -= 1;
  }
  return out;
}

/**
 * Whether the compiler has written a launchable specification for this idea.
 *
 * The same test `nextLaunchable` applies (`judgment LIKE '%"missionSpec"%'`),
 * read from the parsed judgment rather than by pattern.
 */
function hasCompiledSpecification(judgment: unknown): boolean {
  const parsed =
    typeof judgment === 'string'
      ? (() => {
          try {
            return JSON.parse(judgment) as unknown;
          } catch {
            return null;
          }
        })()
      : judgment;
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>)['missionSpec'] === 'object' &&
    (parsed as Record<string, unknown>)['missionSpec'] !== null
  );
}

/** Both halves, for the tick. */
export async function runValidations(projectId: string): Promise<ValidationProgress> {
  // Settling first, so a deep dive that finished this tick frees its slot for
  // the next one rather than waiting a whole pass for it.
  const settled = await settleValidations(projectId);
  // Then what it found, and then what Brain reads from that. The order is the
  // order the effects depend on each other in: a proposal is built from the
  // evidence, so applying the evidence first is what stops the proposal being
  // made against last tick's card.
  await applyValidationAnswers(projectId);
  await proposeEngineTerms(projectId);
  // A question already asked is resumed before a new one takes a slot.
  await resumeUnlaunchedDives(projectId);
  // A screen that settled without a payer is dormant with its reopen
  // conditions, rather than spending a full dive (§3.3(a)).
  await concludeScreens(projectId);
  // Known listings are retrieved before a dive starts, so its worker is handed
  // the listing rather than told to go and find it. Bounded and best effort: a
  // listing that cannot be read never holds up a dive or any other work.
  await retrieveDueListings({ projectId }).catch(() => []);
  const started = await startValidations({ projectId });
  return { started, settled };
}

/**
 * The reopen conditions a failed stage-one screen leaves behind.
 *
 * A screen that settled with no payer established means nobody is known to pay
 * for the opening, so the full sixteen-lane dive is not spent on it
 * (`whyNotDiving` answers `STAGE_ONE_FAILED`). That is a dormancy, never a
 * verdict: what would change it is evidence about the payer — in the own or
 * shared citable pool (`EVIDENCE:payer`), or on this opening's own card
 * (`FIELD:payer`) — and both are recorded as typed reopen conditions through
 * the reconsideration ledger, so the change that meets one opens a new epoch
 * and the opening is screened again. No lifetime cap: a new epoch needs a
 * distinct change, which the ledger's key enforces.
 *
 * Once per screen: a condition already recorded since this dive started, or
 * still untriggered from an earlier one, is not recorded again. Derived from
 * rows on the tick, so it reaches a screen that settled while the tick was down.
 */
export async function concludeScreens(
  projectId: string,
): Promise<{ opportunityId: string; reopenWhen: string[] }[]> {
  if (!(await getCashMode(projectId))) return [];
  const out: { opportunityId: string; reopenWhen: string[] }[] = [];
  const keys = [formatBlockerKey('EVIDENCE', 'payer'), formatBlockerKey('FIELD', 'payer')];
  for (const opportunity of await listOpportunities({ projectId })) {
    if (opportunity.validationState !== 'COMPLETE' && opportunity.validationState !== 'BLOCKED') continue;
    const refusal = await whyNotDiving(opportunity);
    if (refusal.kind !== 'STAGE_ONE_FAILED') continue;
    const since = opportunity.validationStartedAt ?? '';
    const held = await reopenConditionsFor(opportunity.id);
    const missing = keys.filter(
      (key) =>
        !held.some(
          (condition) =>
            condition.blockerKey === key && (condition.triggeredAt === null || condition.createdAt >= since),
        ),
    );
    if (missing.length === 0) continue;
    for (const key of missing) {
      await recordReopenCondition({
        projectId,
        opportunityId: opportunity.id,
        blockerKey: key,
        // The epoch's dives are spent: a failed screen ends the epoch.
        recordedFrom: 'ROUNDS_SPENT',
        observedAtRecord: 'NO_PAYER_ESTABLISHED',
        actorRef: 'BRAIN',
      });
    }
    await recordCashEvent({
      projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_VALIDATION_BLOCKED',
      actorRef: 'BRAIN',
      summary:
        'The first-stage screen found no published source naming who would pay for this ' +
        'opening, so Brain has not spent a full deep dive on it. It is dormant, and it is ' +
        'screened again when evidence about its payer changes.',
      detail: {
        stage: 'SCREEN',
        outcome: 'STAGE_ONE_FAILED',
        candidateId: opportunity.candidateId,
        reopenWhen: keys,
      },
    });
    out.push({ opportunityId: opportunity.id, reopenWhen: keys });
  }
  return out;
}

export { getOpportunity };

// ---------------------------------------------------------------------------
// What the deep dive found, on the card
// ---------------------------------------------------------------------------

/**
 * Which card field each validation lane answers.
 *
 * A row, not a reading. The lane is declared by the compiler profile, the claim
 * records which lane it fills, and the gate has already decided the claim is
 * evidence — so "this claim answers the price question" is a column, and
 * nothing here infers from a claim's prose which blank it fills. That is the
 * same rule `answers.ts` established for the needs path and the reason a card
 * field resolves to a passage exactly as a report's sentence does.
 */
export const FIELD_BY_LANE: Readonly<Record<string, string>> = Object.freeze({
  payer: 'payer',
  price_evidence: 'revenueRange',
  cost_evidence: 'directCosts',
  timing: 'timeToFirstCash',
  effort: 'hours',
  delivery_requirements: 'laborNeeds',
  disqualifier: 'disqualifiers',
  /*
   * The four the audit found nothing was asking. The lanes above are untouched
   * on purpose: a deep dive compiled before these existed still submits
   * against them, and a running mission must not be invalidated by a key that
   * changed underneath it.
   */
  eligibility: 'eligibility',
  acquisition_access: 'acquisitionAccess',
  exit_evidence: 'exitEvidence',
  contact_mode: 'phoneDependency',
  /*
   * A declared disqualifier answers "what would rule it out" as well as
   * stopping the opening; `applyValidationAnswers` records the second.
   */
  ruled_out: 'disqualifiers',
});

/**
 * A lane that answers a second card field as well as its own.
 *
 * `contact_mode` asks for the published route to the buyer — a portal, an
 * address, a form, a bid submission or a phone number — and that *is* the
 * `access` field: "a channel that actually reaches them". It used to fill
 * `phoneDependency` alone, so a dive could establish exactly how to reach the
 * buyer and the card would still read `access` as unknown. Production, Cash
 * Mode 1: seven openings stood one field from QUALIFIED with that field
 * `access`, and Brain launched separate "Access for …" research missions — one
 * of them holding a mission slot while the opening's own dive ran beside it.
 *
 * Never from a `NEGATIVE_EXISTENCE` claim: a documented absence of a route is
 * a finding, and it is the opposite of access.
 */
export const ALSO_ANSWERS_BY_LANE: Readonly<Record<string, string>> = Object.freeze({
  contact_mode: 'access',
});

/** The lane where a dive records what bears on ruling an opening out, absences included. */
export const DISQUALIFIER_LANE = 'disqualifier';

/** The lane where a dive declares a fact that does rule the opening out. */
export const RULED_OUT_LANE = 'ruled_out';

export interface AppliedValidation {
  opportunityId: string;
  field: string;
  claimId: string;
}

/**
 * Put every deep dive's accepted claims on the card.
 *
 * Only citable ones, and only from that opening's own validation packets — a
 * claim that did not clear the gate is not evidence, and a claim from another
 * packet is about something else.
 *
 * Every dive the opening has had, not only its current one, and a dive that
 * settled BLOCKED as well as one that settled COMPLETE. Both used to be
 * excluded, and production measured what that cost: the New Jersey Department
 * of Health dive `orc_381e9bb31d4f49ecb7cc` ended with four accepted, sourced
 * claims (payer, price, timing, disqualifier) in a fragment whose integrity
 * passed and whose coverage fell short. `citableClaims` already includes such
 * claims, on the reasoning written beside it — a fragment falling short on
 * coverage says the question was incompletely answered, not that its claims are
 * unsound. But the reader asked only for openings settled `COMPLETE`, and a dive
 * whose only fragment is BLOCKED never completes; and by then the opening had
 * moved on to its second round, so `validation_orchestration_id` no longer named
 * that packet at all. Thirty-nine of forty cards sat at their starting answers.
 *
 * What this changes is which packets are read, never what counts as evidence:
 *
 *   - `citableClaims` still decides — accepted claims of ACCEPTED or BLOCKED
 *     fragments, nothing from a REJECTED or CANCELLED one — and a claim with no
 *     source is skipped;
 *   - a packet is read only once its mission is finished, so nothing still
 *     being researched lands early;
 *   - `recordEvidenceFact` applies `mayReplace` in the statement that writes,
 *     so a person's answer and earlier evidence both stand, and two ticks
 *     reading one empty field cannot each write a different claim;
 *   - nothing here touches the dive's own state. A BLOCKED dive stays BLOCKED,
 *     and its requirement stays unanswered; only the claims carry across.
 *
 * Dives are read oldest first and claims in gate order, so which claim fills a
 * field is deterministic and survives a restart. It is derived from rows on the
 * tick, so it reaches the openings already stranded with nothing replayed.
 */
export async function applyValidationAnswers(projectId: string): Promise<AppliedValidation[]> {
  if (!(await getCashMode(projectId))) return [];
  const out: AppliedValidation[] = [];

  /*
   * One read per card, and one per fragment, per pass.
   *
   * This walks every citable claim of every finished dive on every tick, and
   * almost every claim is a replay that writes nothing — so asking the
   * database once per claim per field (`cardFact`), once per claim for its
   * fragment, and re-reading the whole packet once per claim to learn whether
   * it ruled anything out was 219 825 single-field reads, 82 503 fragment reads
   * and a citable-claims join per claim in eight hours of production
   * (2026-10-15/16). The answers are the same rows read once: the card is
   * re-read after each write, so a later claim on the same field still sees
   * what an earlier one just wrote, exactly as before.
   */
  const fragmentDeclares = new Map<string, boolean>();
  const declares = async (fragmentId: string | null): Promise<boolean> => {
    if (!fragmentId) return false;
    const known = fragmentDeclares.get(fragmentId);
    if (known !== undefined) return known;
    const answer = await declaresRuledOut(fragmentId);
    fragmentDeclares.set(fragmentId, answer);
    return answer;
  };

  for (const opportunity of await listOpportunities({ projectId })) {
    let card: ((field: string) => CashCardFact | null) | null = null;
    for (const orchestrationId of await finishedDivePackets(opportunity)) {
      const claims = await citableClaims(orchestrationId);
      const ruledOut = claims.some(
        (one) => one.evidenceLane === RULED_OUT_LANE && one.claimType !== 'NEGATIVE_EXISTENCE',
      );
      for (const claim of claims) {
        if (!claim.sourceUrl) continue;
        const lane = claim.evidenceLane ?? '';
        const fields: string[] = [];
        /*
         * A search that found nothing is not the thing it looked for.
         *
         * For most lanes a documented absence *is* the answer — no licence is
         * required, nothing rules it out, no call is needed. For these it is
         * not: a search that found no payer, no published price, no published
         * cost, no payment terms or no effort figure leaves that field unknown,
         * and writing it there made production read "No payer was found" as the
         * payer and compose a capture thesis from it. The claim still stands as
         * evidence; it simply answers nothing.
         */
        const absenceAnswersNothing =
          claim.claimType === 'NEGATIVE_EXISTENCE' && ABSENCE_IS_NOT_AN_ANSWER.has(lane);
        if (FIELD_BY_LANE[lane] && !absenceAnswersNothing) fields.push(FIELD_BY_LANE[lane]);
        if (ALSO_ANSWERS_BY_LANE[lane] && claim.claimType !== 'NEGATIVE_EXISTENCE') {
          fields.push(ALSO_ANSWERS_BY_LANE[lane]);
        }
        /*
         * "No disqualifier found" and "disqualifier found" are two answers.
         *
         * Found is declared: a claim filed in `ruled_out` answers the question
         * and stops the opening. None found is a NEGATIVE_EXISTENCE claim in
         * `disqualifier`, which answers the question and stops nothing.
         *
         * A dive compiled before `ruled_out` existed had only `disqualifier`,
         * and production's held absences, closed RFPs and mere risks side by
         * side. The absences are typed and read as absences; anything else is
         * a statement nobody classified, recorded as a *possible* disqualifier
         * that blocks qualification and says so — never as clear.
         */
        const classifying = await declares(claim.fragmentId);
        if (claim.claimType !== 'NEGATIVE_EXISTENCE') {
          if (lane === RULED_OUT_LANE) {
            fields.push(DISQUALIFIED_FIELD);
          } else if (lane === DISQUALIFIER_LANE && !classifying) {
            fields.push(UNCLASSIFIED_DISQUALIFIER_FIELD);
          }
        } else if (
          lane === DISQUALIFIER_LANE &&
          classifying &&
          !ruledOut
        ) {
          // A dive that was offered `ruled_out`, used none, and documented that
          // nothing excludes it: the one answer that clears an unclassified one.
          fields.push(RULED_OUT_CLEARED_FIELD);
        }
        for (const field of fields) {
          card ??= await cardFactMap(opportunity.id);
          const existing = card(field);
          // Already this claim: nothing to do, which is what a replay must find.
          if (existing?.claimId === claim.id) continue;
          // A person's answer stands, and so does an earlier piece of evidence:
          // `mayReplace` is the order, and it is about authority rather than
          // recency. Asked here to skip the write, and again inside it.
          if (!mayReplace(existing, 'EVIDENCE')) continue;
          const value = clampText(claim.claim, 600);
          const written = await recordEvidenceFact({
            projectId,
            opportunityId: opportunity.id,
            field,
            value,
            claimId: claim.id,
          });
          // Whatever happened, the card may have moved: read it again before the next claim.
          card = null;
          if (!written) continue;
          /*
           * The column as well as the fact, where the field has one.
           *
           * `answers.ts` writes both when a *need's* research settles a card
           * field, and this once wrote only the fact — so the same question,
           * answered by the deep dive instead, reached `cash_card_facts` and never
           * reached `evidenceCard`, `readyToTest` or anything else that reads the
           * row. `COLUMN` is imported rather than restated, because a second copy
           * is the thing that drifts. Written only once the fact is this claim's,
           * so the column and the fact cannot name two different claims.
           */
          const column = COLUMN[field];
          if (column) {
            await updateOpportunity(opportunity.id, { [column]: value } as never);
          }
          out.push({ opportunityId: opportunity.id, field, claimId: claim.id });
        }
      }
    }
    await withdrawAbsencesWrittenAsAnswers(projectId, opportunity);
  }
  return out;
}

/**
 * Lanes whose documented absence leaves the field unknown rather than answering it.
 *
 * Only the payer. For the other lanes an absence can genuinely be the answer —
 * "no fee is charged" is a cost, "no licence is required" is eligibility — and
 * the claim's type alone cannot tell that apart from "no price is published",
 * so narrowing them would withdraw real answers.
 */
export const ABSENCE_IS_NOT_AN_ANSWER: ReadonlySet<string> = new Set(['payer']);

/**
 * Take back an absence that was written onto a card as the answer.
 *
 * Before the guard above, a NEGATIVE_EXISTENCE claim in the payer lane filled
 * the payer — production carried "No payer was found" as one opening's payer,
 * and a capture thesis was then composed from it. The fact and its column are
 * cleared, every recommendation Brain composed from that claim is withdrawn
 * with it, and the correction is an append-only event carrying the value it
 * replaced. Nothing is written in its place: an absence is not evidence that
 * there is no payer either, so the field is simply unknown.
 *
 * One transaction, because the fact is also the only guard: deleted alone and
 * then interrupted, the column would keep the absence for ever with nothing
 * left to notice it. Each write is guarded on the value it replaces, so a
 * person's answer and newer evidence are untouched and a replay changes
 * nothing.
 */
async function withdrawAbsencesWrittenAsAnswers(
  projectId: string,
  opportunity: CashOpportunity,
): Promise<void> {
  const byField = new Map((await cardFactsFor(opportunity.id)).map((one) => [one.field, one]));
  for (const lane of ABSENCE_IS_NOT_AN_ANSWER) {
    const field = FIELD_BY_LANE[lane];
    if (!field) continue;
    const fact = byField.get(field);
    if (!fact || fact.kind !== 'EVIDENCE' || !fact.claimId) continue;
    const claim = await getClaim(fact.claimId);
    if (!claim || claim.claimType !== 'NEGATIVE_EXISTENCE') continue;
    await getDb().transaction(async () => {
      if (!(await withdrawEvidenceFact({ opportunityId: opportunity.id, field, claimId: claim.id }))) return;
      const column = COLUMN[field];
      if (column) await clearColumnIfStill({ opportunityId: opportunity.id, column, value: fact.value });
      const composed = await withdrawRecommendationsResting({ opportunityId: opportunity.id, claimId: claim.id });
      await recordCashEvent({
        projectId,
        opportunityId: opportunity.id,
        kind: 'CASH_CARD_FACT_WITHDRAWN',
        actorRef: 'BRAIN',
        summary:
          `The ${field} on this card was a search that found nothing, not an answer. It is unknown ` +
          'again, and nothing Brain composed from it stands.',
        detail: { field, claimId: claim.id, value: fact.value, withdrawnRecommendations: composed },
      });
    });
  }
}

/** Whether a dive's fragment offered its worker the `ruled_out` lane. */
async function declaresRuledOut(fragmentId: string | null): Promise<boolean> {
  if (!fragmentId) return false;
  const fragment = await getFragment(fragmentId);
  return Boolean(fragment?.requiredEvidence.some((lane) => lane.id === RULED_OUT_LANE));
}

const FINISHED_MISSION = new Set(['DONE', 'FAILED', 'CANCELLED']);

/** The judge's own words when a report needs more research, as `packetRunner` records them. */
export function judgeAskedForResearch(reason: string | null): boolean {
  return reason !== null && /^The judge's verdict was (?:PATCH|MORE_RESEARCH)\b/.test(reason);
}

/**
 * Every packet a deep dive of this opening produced, whose mission has finished.
 *
 * Each round's idea is named by its own `CASH_VALIDATION_STARTED` event, so the
 * history is read from the rows that recorded it rather than from the one
 * column the latest round overwrites. The column is still read too, for an
 * opening settled before those events existed. Oldest first.
 */
async function finishedDivePackets(opportunity: CashOpportunity): Promise<string[]> {
  const packets: string[] = [];
  const add = (id: string | null | undefined): void => {
    if (id && !packets.includes(id)) packets.push(id);
  };
  // By the epoch each event recorded, then its round within that epoch: two
  // rounds started in one millisecond would otherwise sort by their generated
  // ids, and which claim fills a field must not depend on that. Rounds restart
  // at one in each epoch, so the epoch comes first; an event from before epochs
  // were recorded belongs to the first one.
  const epochOf = (detail: Record<string, unknown>): string =>
    typeof detail['epochStartedAt'] === 'string' ? detail['epochStartedAt'] : '';
  const roundOf = (detail: Record<string, unknown>): number =>
    typeof detail['round'] === 'number' ? detail['round'] : Number.MAX_SAFE_INTEGER;
  const started = (await cashEventsOfKind(opportunity.id, DIVE_STARTED_EVENT)).sort((a, b) => {
    const ea = epochOf(a.detail);
    const eb = epochOf(b.detail);
    if (ea !== eb) return ea < eb ? -1 : 1;
    return roundOf(a.detail) - roundOf(b.detail);
  });
  for (const event of started) {
    const candidateId = event.detail['candidateId'];
    if (typeof candidateId !== 'string') continue;
    for (const mission of await missionsForCandidate(candidateId)) {
      if (FINISHED_MISSION.has(mission.state)) add(mission.orchestrationId);
    }
  }
  if (
    opportunity.validationState === 'COMPLETE' ||
    opportunity.validationState === 'BLOCKED'
  ) {
    add(opportunity.validationOrchestrationId);
  }
  return packets;
}

/**
 * The five things the deep dive cannot find published, that Brain proposes.
 *
 * Capital, the first steps, the bottleneck, the scaling lever and a confidence
 * reading are not facts anybody publishes about somebody else's opening. They
 * are a reading of what *is* on the card, so each is recorded as a
 * `RECOMMENDATION` carrying its basis, its assumptions and what would change
 * it — the shape `proposeTerms` already established and the reason a
 * recommendation is never shown the way a source is shown.
 *
 * It proposes nothing it has no basis for. Where the card is empty, the field
 * stays unknown and says what would settle it, because deriving a number and
 * explaining it afterwards is the invented judgment §30 refuses.
 */
export async function proposeEngineTerms(projectId: string): Promise<string[]> {
  if (!(await getCashMode(projectId))) return [];
  const touched: string[] = [];

  for (const opportunity of await listOpportunities({ projectId })) {
    /*
     * Once a dive has settled — COMPLETE or BLOCKED — and never while one is
     * in flight.
     *
     * COMPLETE alone was the gate, and it is the same defect
     * `applyValidationAnswers` carried: a dive whose fragment fell short on
     * coverage settles BLOCKED, its citable claims now reach the card, and
     * nothing then read them. In production 22 openings held a gated payer and
     * a proposed offer and not one capture thesis, so all forty stayed SIGNAL.
     * Every proposal below is still composed only from facts already on the
     * card; a BLOCKED dive stays BLOCKED and nothing here moves it.
     *
     * PENDING, RUNNING and NEEDS_PERSON are skipped because the card is still
     * being filled, and a recommendation is never replaced by a later one — a
     * proposal made mid-dive would stand over the better one the finished dive
     * would have made.
     */
    if (opportunity.validationState !== 'COMPLETE' && opportunity.validationState !== 'BLOCKED') {
      continue;
    }

    const fact = await cardFactMap(opportunity.id);
    const price = fact('revenueRange');
    const costs = fact('directCosts');
    const payer = fact('payer');
    const disqualifiers = fact('disqualifiers');
    const labor = fact('laborNeeds');
    const delivery = fact('delivery');
    const hours = fact('hours');

    const proposals: {
      field: string;
      value: string;
      basis: string;
      assumptions: string;
      uncertainty: string;
    }[] = [];

    /*
     * Capital, and only where a cost is actually known.
     *
     * With no published cost this is withheld rather than set to zero. A
     * required capital of nothing is the single most flattering thing this card
     * could say, and saying it from an absence is invariant 39 exactly.
     */
    if (costs?.value) {
      proposals.push({
        field: 'requiredCapital',
        value:
          `At most the direct costs above, paid before any money arrives: ${clampText(costs.value, 200)}.`,
        basis: `The published direct costs${costs.claimId ? ` (claim ${costs.claimId})` : ''}.`,
        assumptions:
          'That nothing else has to be bought first, and that the costs above are the whole of ' +
          'what delivering this needs.',
        uncertainty:
          'Anything the sources do not publish a price for is not in this figure. A cost that ' +
          'turns up later raises it.',
      });
    }

    /*
     * The capture thesis, and only where somebody would actually pay *us*.
     *
     * This is the field the whole Signal / Candidate boundary turns on, so
     * what it rests on matters more than what it says. It is composed from a
     * payer and something to supply them — both already on the card, both
     * arrived through the gate — and it is withheld entirely where there is no
     * payer, because a mechanism with nobody at the other end of it is the
     * favourable assumption in its purest form.
     *
     * That is what keeps a vendor's published price a signal for ever unless
     * research finds an actual buyer: nothing about Rev charging $1.99 a
     * minute names anybody who would pay us, so no payer ever lands, so no
     * capture thesis is ever proposed. No phrase is matched to reach that
     * outcome — see `tier.ts` for why a keyword list was refused.
     */
    const supplies = opportunity.offerScope ?? delivery?.value ?? null;
    if (payer?.value && supplies) {
      proposals.push({
        field: 'captureMechanism',
        value:
          `Supply ${clampText(supplies, 220)} to ${clampText(payer.value, 160)}` +
          `${opportunity.reachableChannel ? `, reached through ${clampText(opportunity.reachableChannel, 120)}` : ''}` +
          ', and be paid by them for it.',
        basis:
          `A payer established from a published source${payer.claimId ? ` (claim ${payer.claimId})` : ''}` +
          ', and something recorded that we would supply them.',
        assumptions:
          'That the payer is still buying, and that what we would supply is what they are ' +
          'paying for rather than something adjacent to it.',
        uncertainty:
          'Nothing here establishes that they would choose us. It establishes that there is ' +
          'somebody for a price to be quoted to, which is the thing market evidence alone ' +
          'never gives.',
      });
    }

    /*
     * How the work actually gets done, read from what is published about it.
     *
     * Composed from the delivery requirements and the published hours rather
     * than from how the work sounds, and withheld where neither exists — §30's
     * rule that a blank may never be the reason something rises, applied to
     * the field a person uses to tell a business from a job.
     */
    if (labor?.value || delivery?.value || hours?.value) {
      const parts: string[] = [];
      if (delivery?.value) parts.push(`Delivery, as published: ${clampText(delivery.value, 200)}`);
      if (labor?.value) parts.push(`What it requires: ${clampText(labor.value, 200)}`);
      if (hours?.value) parts.push(`Published effort: ${clampText(hours.value, 140)}`);
      proposals.push({
        field: 'fulfilmentModel',
        value:
          `${parts.join('. ')}. Which of AI, software, delegation, subcontracting or manual ` +
          'work covers each part is what the published requirements above describe; what they ' +
          'do not cover is human work that stays with whoever takes this on.',
        basis:
          'The published delivery requirements and effort on this card' +
          `${delivery?.claimId ? ` (claim ${delivery.claimId})` : ''}.`,
        assumptions:
          'That what is published about delivering comparable work is what delivering this ' +
          'one would take.',
        uncertainty:
          'How much of it automates is not published anywhere and is not asserted here. What ' +
          'is published is what the requirements are.',
      });
    }

    if (payer?.value) {
      proposals.push({
        field: 'firstSteps',
        value:
          '1. Re-read the published request at its source and confirm it is still open. ' +
          '2. Write the one-page reply the request itself asks for. ' +
          '3. Put the reply in front of the payer through the channel the source publishes. ' +
          'Step 3 needs a commercial authorization from a person; the first two do not.',
        basis: `The request names its own payer and its own reply route${payer.claimId ? ` (claim ${payer.claimId})` : ''}.`,
        assumptions: 'That the request has not been amended or filled since it was observed.',
        uncertainty:
          'Whether the reply route published is the one that actually reaches a decision-maker.',
      });
      proposals.push({
        field: 'bottleneck',
        value: labor?.value
          ? `Reaching the payer at all: ${clampText(labor.value, 200)}`
          : 'Reaching the payer at all. Everything else on this card is work; this is access.',
        basis: 'The card has a payer and a published channel, and no recorded contact with them.',
        assumptions: 'That the published channel is monitored by somebody who can decide.',
        uncertainty:
          'A bottleneck only shows itself once the first step is taken. This is the one the ' +
          'evidence points at, not the one that will necessarily bite.',
      });
    }

    if (price?.value) {
      proposals.push({
        field: 'scalingLever',
        value:
          'Doing the same thing again for a different buyer in the same market, once the first ' +
          'one has produced a deliverable that can be shown.',
        basis: `Comparable work is published at a comparable price${price.claimId ? ` (claim ${price.claimId})` : ''}, which is what makes a second one worth the same.`,
        assumptions:
          'That the deliverable generalises, and that the market has more than one buyer of it.',
        uncertainty:
          'Nothing here establishes how many buyers there are. That is its own question.',
      });
    }

    /*
     * Brain's own answer to "would you do this", and only with a basis.
     *
     * It is the last question a decision turns on and **nothing wrote it**,
     * which made `QUALIFIED` unreachable — a bar with no way over it, which is
     * the defect this file records at four other altitudes. The deployment
     * smoke test is what found it: it drives a sprint the way a person does
     * and timed out waiting for a piece to become ready.
     *
     * It needs a price and a cost, because that is when `derivedEconomics`
     * can state a margin and there is something to recommend *from*; with
     * either missing the field stays unknown and says what would settle it.
     * A recommendation composed out of blanks would be the invented judgment
     * §30 refuses, and it would be worse here than anywhere else on the card,
     * because this is the line a person reads last.
     */
    if (price?.value && costs?.value) {
      proposals.push({
        field: 'recommendation',
        value:
          `Worth testing if the published price (${clampText(price.value, 120)}) less the ` +
          `published costs (${clampText(costs.value, 120)}) is a margin you would work for, ` +
          `and nothing in the disqualifiers rules it out` +
          `${disqualifiers?.value ? `: ${clampText(disqualifiers.value, 160)}` : '.'}`,
        basis:
          'The published price and the published direct costs on this card' +
          `${price.claimId ? ` (claims ${price.claimId}` : ''}` +
          `${price.claimId && costs.claimId ? `, ${costs.claimId})` : price.claimId ? ')' : ''}.`,
        assumptions:
          'That comparable work is a fair comparison for this one, and that nothing has to be ' +
          'bought that no source publishes a price for.',
        uncertainty:
          'Whether this buyer would choose us at that price. Nothing published settles that, ' +
          'and only making the offer does.',
      });
    }

    /*
     * Confidence, derived from what is actually answered rather than felt.
     *
     * The count is of gated evidence on the card, which is a row. A sentence
     * about how promising something feels would be the model prose §8 keeps
     * out of state, and it would read as a measurement.
     */
    const answered = [price, costs, payer, disqualifiers, labor].filter(
      (fact) => fact && fact.kind === 'EVIDENCE' && fact.value.trim().length > 0,
    ).length;
    proposals.push({
      field: 'confidence',
      value:
        `${answered} of the five load-bearing commercial questions — payer, price, costs, ` +
        `labour and disqualifiers — are answered from published sources.`,
      basis: 'A count of the gated claims on this card, not a judgement about the opening.',
      assumptions: 'That a source answering a question is a source that is still current.',
      uncertainty:
        'A well-sourced answer to four questions says nothing about the fifth. What is unknown ' +
        'is listed on the card rather than averaged into this.',
    });

    for (const proposal of proposals) {
      // The map read above: the write below is guarded in its own statement, so a
      // person answering in between still keeps their answer.
      const existing = fact(proposal.field);
      if (!mayReplace(existing, 'RECOMMENDATION')) continue;
      // Into an empty field only, decided in the statement that writes: a
      // person answering between the read above and this write keeps their
      // answer, and two ticks proposing at once leave one row.
      const written = await recordRecommendationFact({
        projectId,
        opportunityId: opportunity.id,
        field: proposal.field,
        value: proposal.value,
        basis: proposal.basis,
        assumptions: proposal.assumptions,
        uncertainty: proposal.uncertainty,
      });
      if (written) touched.push(`${opportunity.id}:${proposal.field}`);
    }
  }
  return touched;
}

function clampText(text: string, max: number): string {
  const tidy = text.replace(/\s+/g, ' ').trim();
  return tidy.length <= max ? tidy : `${tidy.slice(0, max - 1)}…`;
}
