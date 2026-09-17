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
import { cardFact, mayReplace, recordCardFact } from '../../repos/cashCardFacts.ts';
import { discoveryAllowed } from './lifecycle.ts';
import { discoveryAuthority } from './discoveryAuthority.ts';
import type { CashOpportunity, OpportunityValidationState } from '../../domain/types.ts';

/** How many deep dives one project may have in flight. Provider capacity. */
export const MAX_VALIDATIONS_IN_FLIGHT = 2;

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
    'and whether anything published would disqualify it outright.'
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
  const inFlight = all.filter(
    (one) => one.validationState === 'PENDING' || one.validationState === 'RUNNING',
  ).length;
  let room = Math.max(0, MAX_VALIDATIONS_IN_FLIGHT - inFlight);
  const limit = Math.max(1, input.limit ?? 2);

  const out: StartedValidation[] = [];
  for (const opportunity of all) {
    if (room <= 0 || out.length >= limit) break;
    if (opportunity.validationState !== null) continue;
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
    const moved = await updateOpportunity(opportunity.id, {
      // `candidate_id` is "the idea this opportunity is", which is the column
      // the compiler reads to know it is compiling a deep dive rather than a
      // bucket. `discovered_by_candidate_id` stays as it was.
      candidate_id: candidate.id,
      validation_state: 'PENDING',
      validation_started_at: new Date().toISOString(),
    });
    if (!moved) continue;

    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_VALIDATION_STARTED',
      actorRef: 'BRAIN',
      summary:
        'Brain is qualifying this opening from published sources: who pays, what it pays, ' +
        'what it costs and what would rule it out. Nothing is being contacted or spent.',
      detail: { candidateId: candidate.id, signal: opportunity.buyingSignal },
    });
    out.push({ opportunityId: opportunity.id, candidateId: candidate.id });
    room -= 1;
  }
  return out;
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
    if (opportunity.validationState !== 'PENDING' && opportunity.validationState !== 'RUNNING') {
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

    if (opportunity.validationState === 'PENDING' && mission.state === 'RUNNING') {
      await updateOpportunity(opportunity.id, {
        validation_state: 'RUNNING',
        validation_orchestration_id: mission.orchestrationId,
      });
      out.push({ opportunityId: opportunity.id, to: 'RUNNING' });
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
const FIELD_BY_LANE: Readonly<Record<string, string>> = Object.freeze({
  payer: 'payer',
  price_evidence: 'revenueRange',
  cost_evidence: 'directCosts',
  timing: 'timeToFirstCash',
  effort: 'hours',
  delivery_requirements: 'laborNeeds',
  disqualifier: 'disqualifiers',
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
      await recordCardFact({
        projectId,
        opportunityId: opportunity.id,
        field,
        kind: 'EVIDENCE',
        value: clampText(claim.claim, 600),
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
