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
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import {
  getOpportunity,
  listOpportunities,
  updateOpportunity,
} from '../../repos/cashPortfolio.ts';
import { createCandidate, getCandidate } from '../../repos/russellCandidates.ts';
import { latestMissionForCandidate } from '../../repos/russellMissions.ts';
import { citableClaims, getOrchestration } from '../../repos/research.ts';
import {
  cardFact,
  cardFactsFor,
  mayReplace,
  recordCardFact,
} from '../../repos/cashCardFacts.ts';
import { cashEngineCard } from './engineCard.ts';
import { evidenceCard } from './card.ts';
import { cashTier } from './tier.ts';
import { COLUMN } from './answers.ts';
import { discoveryAllowed } from './lifecycle.ts';
import { discoveryAuthority } from './discoveryAuthority.ts';
import type { CashOpportunity, OpportunityValidationState } from '../../domain/types.ts';

/** How many deep dives one project may have in flight. Provider capacity. */
export const MAX_VALIDATIONS_IN_FLIGHT = 2;

/**
 * The states that actually occupy one of those slots.
 *
 * `NEEDS_PERSON` is deliberately absent, and that absence is the whole repair.
 * A slot is provider capacity; a dive parked for a person is using none of it,
 * and counting it made a Brain with two parked missions unable to start a
 * thirty-ninth dive for ever. What holds a slot is what a worker is working on.
 */
const HOLDS_A_SLOT: ReadonlySet<string> = Object.freeze(new Set(['PENDING', 'RUNNING']));

/**
 * How long a deep dive may show no progress at all before Brain stops calling
 * it running.
 *
 * Not a guess about how long research takes — `settleValidations` reads the
 * mission and moves the moment it moves, so a dive that is genuinely working
 * settles on its own however long it takes. This is the backstop for the case
 * the mission row cannot express: launched, never advanced, and nothing left
 * that will ever advance it. Six hours is longer than any production deep dive
 * this Brain has completed and short enough that a slot is not lost for a day.
 *
 * A stalled dive is `BLOCKED` rather than failed, with the elapsed time in the
 * reason, so it can be dived again inside `MAX_VALIDATION_ROUNDS` rather than
 * being written off.
 */
export const VALIDATION_STALL_MS = 6 * 60 * 60 * 1000;

/**
 * How many bounded deep dives one opening may have, in total.
 *
 * A second one exists because the qualification bar rose after some pieces had
 * already been dived: the eligibility, acquisition, exit-evidence and
 * contact-mode lanes did not exist when the first production dives were
 * compiled, so a piece that answered everything its dive asked could still sit
 * one answer short of qualified with `startValidations` skipping it for ever.
 * §24's sentence at a new altitude — every escalation needs an answering
 * transition, and a bar with no way over it is a park rather than a standard.
 *
 * Two, and not a ladder. A third dive against the same published sources asks
 * the same question a third time, which is `repair.ts`'s rule about never
 * running the same search twice. A piece still short after two has an honest
 * answer — the sources do not publish it — and the card says which fields.
 */
export const MAX_VALIDATION_ROUNDS = 2;

export interface StartedValidation {
  opportunityId: string;
  candidateId: string;
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
 */
export function validationQuestion(opportunity: CashOpportunity): string {
  const signal = (opportunity.buyingSignal ?? opportunity.title).replace(/\s+/g, ' ').trim();
  const observed = opportunity.signalObservedAt
    ? ` It was published or observed on ${opportunity.signalObservedAt}.`
    : '';
  const source = opportunity.source ? ` The source is ${opportunity.source}.` : '';
  return (
    `What would somebody need to know before acting on this specific opening: "${signal}".` +
    `${source}${observed} Establish who actually pays and how a supplier reaches them, what ` +
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

/**
 * Start the deep dive on openings that have not had one.
 *
 * Bounded by `MAX_VALIDATIONS_IN_FLIGHT`, which is provider capacity rather
 * than an allowance — the same distinction §24 drew when it removed the
 * lifetime quotas and kept concurrency.
 *
 * Idempotent by the opportunity's own row: `validation_state` moves to PENDING
 * in the same pass that writes the candidate, and a piece that already has one
 * is skipped. A crash between the two leaves a candidate with no state, which
 * the next tick sees as "not started" and replaces — losing one captured idea,
 * which is recoverable, rather than double-spending a research mission, which
 * is not.
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
  const inFlight = all.filter((one) => HOLDS_A_SLOT.has(one.validationState ?? '')).length;
  let room = Math.max(0, MAX_VALIDATIONS_IN_FLIGHT - inFlight);
  const limit = Math.max(1, input.limit ?? 2);

  /*
   * A piece nobody has looked at yet, before a second look at one.
   *
   * `all` is arrival order, and a re-dive candidate sitting earlier in it
   * would take the slot from an opening that has never been qualified at all.
   * A second dive is worth having and is worth less than a first, so the
   * ordering is explicit rather than an accident of `created_at`. Within each
   * group arrival order is kept, so which of two never-dived pieces goes first
   * is still a property of when they were found.
   */
  /*
   * And inside each group, the ones closest to being a decision first.
   *
   * Inside, not across: a re-dive has more answers on it by definition, so one
   * sort over the whole list would put every second dive ahead of every first
   * and undo the rule above. `Array.prototype.sort` is stable, so arrival
   * order still decides between two pieces that have answered the same amount.
   *
   * The ordering is a count of rows rather than a judgement: an opening whose
   * payer and reach are already established needs one more question before a
   * person can act on it, and a raw market observation needs every question it
   * has. Spending both slots on the second while the first waits is exactly
   * what "actionable work sitting behind background work" means here.
   *
   * It is a preference and never a ceiling. Nothing is refused because of it,
   * and a piece at the back still takes a slot the moment one is free.
   */
  const ordered = [
    ...all.filter((one) => one.validationState === null).sort(closestFirst),
    ...all.filter((one) => one.validationState !== null).sort(closestFirst),
  ];

  const out: StartedValidation[] = [];
  for (const opportunity of ordered) {
    if (room <= 0 || out.length >= limit) break;
    if (opportunity.validationState !== null && !(await mayDiveAgain(opportunity))) continue;
    // A piece somebody has already declined, archived or finished is not worth
    // qualifying. DISCOVERED and EVIDENCE_CARD are the two states where the
    // commercial questions are still open.
    if (opportunity.state !== 'DISCOVERED' && opportunity.state !== 'EVIDENCE_CARD') continue;
    // Nothing to quote into the question. An opening with no recorded signal is
    // one a person entered by hand, and Brain has nothing published to work from.
    if (!opportunity.buyingSignal && !opportunity.sourceClaimId) continue;

    const candidate = await createCandidate({
      projectId: input.projectId,
      visibility: 'SHARED',
      title: `Qualify: ${opportunity.title}`,
      statement: validationQuestion(opportunity),
    });
    const round = opportunity.validationRounds + 1;
    const moved = await updateOpportunity(opportunity.id, {
      // `candidate_id` is "the idea this opportunity is", which is the column
      // the compiler reads to know it is compiling a deep dive rather than a
      // bucket. `discovered_by_candidate_id` stays as it was.
      candidate_id: candidate.id,
      validation_state: 'PENDING',
      validation_started_at: new Date().toISOString(),
      validation_rounds: round,
      /*
       * A second round clears the settled stamp and leaves everything else.
       *
       * The first round's orchestration id is deliberately *not* cleared: it
       * is the provenance of every card fact that round produced, and
       * `applyValidationAnswers` reads the current one. Nothing recorded is
       * destroyed — `mayReplace` still decides authority, so a fact from the
       * first dive is only ever replaced by one of at least equal standing.
       */
      validation_settled_at: null,
    });
    if (!moved) continue;

    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_VALIDATION_STARTED',
      actorRef: 'BRAIN',
      summary:
        round > 1
          ? 'Brain is qualifying this opening a second time, for the questions the first ' +
            'pass was never asked. Nothing is being contacted or spent.'
          : 'Brain is qualifying this opening from published sources: who pays, what it pays, ' +
            'what it costs and what would rule it out. Nothing is being contacted or spent.',
      detail: { candidateId: candidate.id, signal: opportunity.buyingSignal, round },
    });
    out.push({ opportunityId: opportunity.id, candidateId: candidate.id });
    room -= 1;
  }
  return out;
}

/**
 * How far along one opening's own card already is, counted from its columns.
 *
 * The columns `answers.ts` maps card fields onto, plus the two evidence
 * columns a signal is born with. Nothing here reads prose and nothing here
 * forms a view about how good any of it is; it is a count of rows, used only
 * to decide which of two pieces is asked about first.
 */
function closestFirst(a: CashOpportunity, b: CashOpportunity): number {
  return answeredCount(b) - answeredCount(a);
}

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
 * Whether an opening that has already been dived may have one more.
 *
 * Four conditions, and none of them is a preference. The dive has to be
 * **over** — a second one started beside a live one is two workers answering
 * the same question with the sprint paying twice. The mission behind it has to
 * be **terminal**, which is the same rule one row along: a dive settled
 * `NEEDS_PERSON` is parked rather than finished, and a person answering it
 * resumes the mission that is already there, so starting a second one would
 * buy the same answer twice. There has to be a **round left**, which is what
 * stops a piece being re-asked for ever. And it has to be genuinely **short of
 * qualified**, read from the card rather than from a state column: a piece
 * that answered everything is finished whatever its round count says.
 *
 * Read in the loop rather than precomputed, because it is asked only of the
 * pieces that already have a terminal dive, and the loop stops at `room`.
 */
async function mayDiveAgain(opportunity: CashOpportunity): Promise<boolean> {
  if (opportunity.validationState !== 'COMPLETE' && opportunity.validationState !== 'BLOCKED') {
    return false;
  }
  if (opportunity.validationRounds >= MAX_VALIDATION_ROUNDS) return false;
  const card = cashEngineCard({
    opportunity,
    facts: await cardFactsFor(opportunity.id),
  });
  const reading = cashTier({
    opportunity,
    card,
    readiness: evidenceCard(opportunity).readiness,
  });
  return reading.tier !== 'QUALIFIED' && reading.tier !== 'READY_TO_TEST';
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
     * `RUNNING` counts against `MAX_VALIDATIONS_IN_FLIGHT`, production had
     * **both** of its two slots held by parked missions. Thirty-eight openings
     * could never be qualified, and no deep dive could ever start again.
     *
     * It is a park with an answering transition rather than a failure: the
     * mission's own Needs You card is what resolves it, the branch above puts
     * the opening back to `RUNNING` when somebody does, and `mayDiveAgain`
     * refuses a second dive meanwhile so the answer is not bought twice.
     */
    if (mission.state === 'NEEDS_HUMAN') {
      if (opportunity.validationState !== 'NEEDS_PERSON') {
        const packet = mission.orchestrationId
          ? await getOrchestration(mission.orchestrationId)
          : null;
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
     * Launched, never advanced, and nothing left that will advance it.
     *
     * The backstop for what the mission row cannot express. Everything above
     * moves the moment the mission moves, so a dive that is genuinely working
     * is never reached here however long it takes; what is reached here is a
     * dive whose mission has been `RUNNING` since before
     * `VALIDATION_STALL_MS` and has produced nothing. `BLOCKED` rather than
     * failed, with the elapsed time in the reason, so `mayDiveAgain` can offer
     * it another round instead of writing it off.
     */
    const startedAt = opportunity.validationStartedAt;
    if (startedAt && Date.now() - Date.parse(startedAt) > VALIDATION_STALL_MS) {
      const hours = Math.floor((Date.now() - Date.parse(startedAt)) / (60 * 60 * 1000));
      await settle(
        projectId,
        opportunity,
        'BLOCKED',
        `The deep dive was launched ${hours} hours ago and its mission has not reached a ` +
          'result. Brain has stopped calling it running and freed the slot; it can be asked ' +
          'again.',
        mission.orchestrationId,
      );
      out.push({ opportunityId: opportunity.id, to: 'BLOCKED' });
      continue;
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
  const started = await startValidations({ projectId });
  return { started, settled };
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
});

export interface AppliedValidation {
  opportunityId: string;
  field: string;
  claimId: string;
}

/**
 * Put the deep dive's accepted claims on the card.
 *
 * Only accepted ones, and only from that opening's own validation packet — a
 * claim that did not clear the gate is not evidence, and a claim from another
 * packet is about something else.
 *
 * Idempotent by the unique index on `(opportunity_id, field)`: re-running
 * rewrites the same row rather than accumulating, and `mayReplace` is what
 * stops a later automatic answer overwriting a person's. Nothing here decides
 * anything about the opportunity's state.
 */
export async function applyValidationAnswers(projectId: string): Promise<AppliedValidation[]> {
  if (!(await getCashMode(projectId))) return [];
  const out: AppliedValidation[] = [];

  for (const opportunity of await listOpportunities({ projectId })) {
    if (opportunity.validationState !== 'COMPLETE') continue;
    if (!opportunity.validationOrchestrationId) continue;

    for (const claim of await citableClaims(opportunity.validationOrchestrationId)) {
      const field = FIELD_BY_LANE[claim.evidenceLane ?? ''];
      if (!field) continue;
      const existing = await cardFact(opportunity.id, field);
      // A person's answer stands, and so does an earlier piece of evidence:
      // `mayReplace` is the order, and it is about authority rather than
      // recency.
      if (!mayReplace(existing, 'EVIDENCE')) continue;
      const value = clampText(claim.claim, 600);
      /*
       * The column as well as the fact, where the field has one.
       *
       * `answers.ts` writes both when a *need's* research settles a card field,
       * and this wrote only the fact — so the same question, answered by the
       * deep dive instead, reached `cash_card_facts` and never reached
       * `evidenceCard`, `readyToTest` or anything else that reads the row. Two
       * writers for one field with only one of them counting is this file's own
       * recurring defect: a rule applied by one of two readers is worse than
       * none, because the two disagree about the same opening.
       *
       * `COLUMN` is imported rather than restated for exactly that reason — a
       * second copy is the thing that drifts. Most of the fields the deep dive
       * fills are engine fields with no column at all, which is why this is a
       * lookup rather than an assumption: `payer` has one, `hours` does not,
       * and a field with none is a card fact and nothing else.
       *
       * It changes no evidence and lowers no bar: the claim already cleared the
       * gate, `mayReplace` still decides authority, and a person's answer still
       * stands.
       */
      const column = COLUMN[field];
      if (column) {
        await updateOpportunity(opportunity.id, { [column]: value } as never);
      }
      await recordCardFact({
        projectId,
        opportunityId: opportunity.id,
        field,
        kind: 'EVIDENCE',
        value,
        claimId: claim.id,
        decidedBy: 'BRAIN',
      });
      out.push({ opportunityId: opportunity.id, field, claimId: claim.id });
    }
  }
  return out;
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
    if (opportunity.validationState !== 'COMPLETE') continue;

    const price = await cardFact(opportunity.id, 'revenueRange');
    const costs = await cardFact(opportunity.id, 'directCosts');
    const payer = await cardFact(opportunity.id, 'payer');
    const disqualifiers = await cardFact(opportunity.id, 'disqualifiers');
    const labor = await cardFact(opportunity.id, 'laborNeeds');
    const delivery = await cardFact(opportunity.id, 'delivery');
    const hours = await cardFact(opportunity.id, 'hours');

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
      const existing = await cardFact(opportunity.id, proposal.field);
      if (!mayReplace(existing, 'RECOMMENDATION')) continue;
      await recordCardFact({
        projectId,
        opportunityId: opportunity.id,
        field: proposal.field,
        kind: 'RECOMMENDATION',
        value: proposal.value,
        basis: proposal.basis,
        assumptions: proposal.assumptions,
        uncertainty: proposal.uncertainty,
        decidedBy: 'BRAIN',
      });
      touched.push(`${opportunity.id}:${proposal.field}`);
    }
  }
  return touched;
}

function clampText(text: string, max: number): string {
  const tidy = text.replace(/\s+/g, ' ').trim();
  return tidy.length <= max ? tidy : `${tidy.slice(0, max - 1)}…`;
}
