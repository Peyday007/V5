/**
 * What the research came back with, and what Brain proposes on top of it.
 *
 * ---------------------------------------------------------------------------
 * The connection that was missing
 * ---------------------------------------------------------------------------
 *
 * `startDependentWork` captured a Russell idea for every discoverable blank on
 * a card and wrote its id onto the need. The only reader of that column hid the
 * need from the review — for ever, and whether the research had completed,
 * failed or never started. So the loop looked like it worked: needs were
 * raised, ideas were created, missions ran, and the card stayed blank while the
 * thing that asked for it was invisible.
 *
 * **A column with one reader that only ever hides something is not a
 * connection.** `applyResearchAnswers` is the consumer: it reads the missions
 * those ideas produced, applies what the accepted claims support, leaves
 * everything else unknown, and puts a blocked or failed one back where a person
 * can see it.
 *
 * ---------------------------------------------------------------------------
 * Which field a claim answers is a row, not a reading
 * ---------------------------------------------------------------------------
 *
 * The need's own key says which field it was raised for — Brain wrote it — and
 * the mission it launched asks that one question. So the field comes from the
 * key, matched by **rebuilding** it per field rather than by slicing it apart,
 * and nothing anywhere infers from a claim's prose which blank it fills.
 *
 * A claim still has to clear the gate before it is here at all, so what reaches
 * a card is sourced, located and scope-matched. What is applied is the claim's
 * own sentence with its claim id beside it, which is why a card field resolves
 * to a passage exactly as a report's sentence does.
 *
 * ---------------------------------------------------------------------------
 * And Brain forms a commercial view, which it was forbidden from doing
 * ---------------------------------------------------------------------------
 *
 * The rule said the offer, the price, the acceptance condition and who fulfils
 * the work were permanently the owner's, because a researched answer to "what
 * should we charge" is invented judgment wearing a citation. That is true of a
 * *citation* and wrong as a prohibition: this is meant to be an operator with
 * high autonomy inside limits a person set, and reserving every commercial
 * judgment to a human makes it a form somebody fills in.
 *
 * So `proposeTerms` prepares them — from the evidence actually on the card,
 * with the assumptions written down and the uncertainty named — and records
 * each one as a `RECOMMENDATION` rather than as a fact. Three properties are
 * what make that safe rather than a loophole:
 *
 *   * **It is never presented as verified.** The kind is a column, the card
 *     reports it, and a recommendation with no stated uncertainty is refused by
 *     construction — all three of basis, assumptions and uncertainty are
 *     required to write one.
 *   * **It proposes nothing it has no basis for.** A price is proposed only
 *     where a source stated a figure; with none, the field stays unknown and
 *     asks for one. Brain does not invent a number and then explain it.
 *   * **It changes no boundary.** The standing commercial authority still
 *     decides what may be spent, executing still needs a recorded action, and a
 *     person's own answer outranks a proposal permanently.
 */
import { citableClaims } from '../../repos/research.ts';
import { getMission, listMissions } from '../../repos/russellMissions.ts';
import { getOpportunity, listOpportunities, updateOpportunity } from '../../repos/cashPortfolio.ts';
import { listNeeds } from '../../repos/cashPortfolio.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { cardFact, mayReplace, recordCardFact } from '../../repos/cashCardFacts.ts';
import { evidenceCard } from './card.ts';
import { questionKey } from './conditions.ts';
import { closeNeed } from './needs.ts';
import { readCapability } from './capabilities.ts';
import { formatMoney, readMoneyFigures } from './figures.ts';
import type { CashCardFact, CashNeed, CashOpportunity, ResearchClaim } from '../../domain/types.ts';

const BRAIN = 'BRAIN';

/**
 * The column each card field is stored in, so an answer reaches the card.
 *
 * `price` is here because a recommendation that reads well and leaves the
 * integer column blank is a card that still is not ready — the sentence and the
 * figure are two halves of one proposal, which is what `ProposedTerm.cents` is
 * for.
 *
 * `cashDates` is deliberately **absent**. The proposal about cash timing is
 * derived *from* the deadline, so writing it back would replace a date with a
 * paragraph about that date, and the next pass would derive from its own
 * output. It is recorded as a card fact, where a person reads it, and changes
 * no column.
 */
const COLUMN: Record<string, string> = {
  payer: 'payer',
  access: 'reachable_channel',
  offer: 'offer_scope',
  acceptance: 'acceptance_condition',
  price: 'price_cents',
  delivery: 'delivery_method',
  fulfillment: 'fulfillment_owner',
  economics: 'economics_note',
  nextAction: 'next_action',
};

export interface AppliedAnswer {
  needId: string;
  opportunityId: string;
  field: string;
  claimId: string;
}

export interface UnansweredResearch {
  needId: string;
  opportunityId: string;
  field: string;
  /** Why it has produced nothing: still running, or finished without support. */
  state: 'RUNNING' | 'NO_SUPPORT' | 'FAILED' | 'NEVER_STARTED';
  detail: string;
}

export interface ResearchApplication {
  applied: AppliedAnswer[];
  unanswered: UnansweredResearch[];
}

function clamp(text: string, max: number): string {
  const tidy = text.replace(/\s+/g, ' ').trim();
  if (tidy.length <= max) return tidy;
  const cut = tidy.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

/**
 * Take what the research established and put it on the card.
 *
 * Derived from rows on every tick rather than hooked to the moment a mission
 * finishes, which is what reaches the needs already stranded — the fifth time
 * this repository has needed that distinction.
 */
export interface ResearchAssessment {
  need: CashNeed;
  opportunity: CashOpportunity;
  field: string;
  state: 'ANSWERED' | UnansweredResearch['state'];
  detail: string;
  /** The gated claims that would answer it, newest-first by fragment order. */
  supporting: ResearchClaim[];
}

/**
 * What each researched need's mission has come back with.
 *
 * **A read, and only a read.** It is called by `applyResearchAnswers`, which
 * acts on it, and by the view, which reports it — and the view is a GET, so a
 * function that both classified and applied would make opening a screen change
 * the cards on it. The same reason `pending.ts` is a projection.
 */
export async function assessResearch(projectId: string): Promise<ResearchAssessment[]> {
  const out: ResearchAssessment[] = [];
  const open = await listNeeds({ projectId, states: ['OPEN'] });
  if (open.length === 0) return out;

  const missions = await listMissions({ projectId });
  const byCandidate = new Map(
    missions.filter((one) => one.candidateId).map((one) => [one.candidateId!, one]),
  );

  for (const need of open) {
    if (!need.candidateId || !need.opportunityId || !need.requestKey?.startsWith('question:')) {
      continue;
    }
    const opportunity = await getOpportunity(need.opportunityId);
    if (!opportunity) continue;
    const field = fieldOf(need, opportunity);
    if (!field) continue;

    const mission = byCandidate.get(need.candidateId);
    if (!mission) {
      out.push({
        need,
        opportunity,
        field,
        state: 'NEVER_STARTED',
        detail:
          'Brain captured the question and no mission has launched for it yet — most often ' +
          'because the project has no standing research authority, or the sprint has wound down.',
        supporting: [],
      });
      continue;
    }
    if (mission.state === 'FAILED' || mission.state === 'CANCELLED') {
      out.push({
        need,
        opportunity,
        field,
        state: 'FAILED',
        detail:
          mission.terminalReason ??
          'The research that would have answered this ended without an answer.',
        supporting: [],
      });
      continue;
    }
    if (mission.state !== 'DONE' || !mission.orchestrationId) {
      out.push({
        need,
        opportunity,
        field,
        state: 'RUNNING',
        detail: `Brain is researching this now (${mission.state.toLowerCase()}).`,
        supporting: [],
      });
      continue;
    }

    /*
     * Everything the gate accepted, and nothing else.
     *
     * A claim that reaches here has a canonical source, a located passage and a
     * scope that matched its fragment's, because that is what being citable
     * means. So applying its sentence to a card field is carrying evidence
     * across rather than forming a view about it.
     */
    const supporting = (await citableClaims(mission.orchestrationId)).filter(
      (claim) => claim.sourceUrl !== null && claim.claimType !== 'NEGATIVE_EXISTENCE',
    );
    out.push({
      need,
      opportunity,
      field,
      state: supporting.length > 0 ? 'ANSWERED' : 'NO_SUPPORT',
      detail:
        supporting.length > 0
          ? `${supporting.length} gated claim${supporting.length === 1 ? '' : 's'} support it.`
          : 'The research finished and nothing it found supports an answer here. The field stays ' +
            'unknown, which is the honest outcome rather than a blank filled in to close a need.',
      supporting,
    });
  }
  return out;
}

/**
 * Take what the research established and put it on the card.
 *
 * Derived from rows on every tick rather than hooked to the moment a mission
 * finishes, which is what reaches the needs already stranded — the fifth time
 * this repository has needed that distinction.
 */
export async function applyResearchAnswers(projectId: string): Promise<ResearchApplication> {
  const out: ResearchApplication = { applied: [], unanswered: [] };
  for (const assessed of await assessResearch(projectId)) {
    if (assessed.state !== 'ANSWERED') {
      out.unanswered.push({
        needId: assessed.need.id,
        opportunityId: assessed.opportunity.id,
        field: assessed.field,
        state: assessed.state,
        detail: assessed.detail,
      });
      continue;
    }
    const claim = assessed.supporting[0]!;
    const applied = await applyOne({
      opportunity: assessed.opportunity,
      field: assessed.field,
      need: assessed.need,
      claim,
    });
    if (!applied) continue;
    out.applied.push({
      needId: assessed.need.id,
      opportunityId: assessed.opportunity.id,
      field: assessed.field,
      claimId: claim.id,
    });
  }
  return out;
}

/** Which card field this need was raised for, rebuilt rather than parsed. */
function fieldOf(need: CashNeed, opportunity: CashOpportunity): string | null {
  for (const one of evidenceCard(opportunity).fields) {
    if (questionKey(opportunity.id, one.key) === need.requestKey) return one.key;
  }
  return null;
}

async function applyOne(input: {
  opportunity: CashOpportunity;
  field: string;
  need: CashNeed;
  claim: ResearchClaim;
}): Promise<boolean> {
  const column = COLUMN[input.field];
  if (!column) return false;

  const existing = await cardFact(input.opportunity.id, input.field);
  if (!mayReplace(existing, 'EVIDENCE')) return false;

  const value = clamp(input.claim.claim, 600);
  const patch: Record<string, string | null> = { [column]: value };
  /*
   * The buying signal carries its observation date or it is not evidence.
   *
   * `evidenceCard` refuses an undated signal, because one cannot be told apart
   * from something somebody remembers from March — so the date travels with the
   * claim rather than being left for somebody to fill in afterwards.
   */
  if (input.field === 'buyingEvidence') {
    patch['buying_signal'] = value;
    delete patch[column];
    patch['signal_observed_at'] = input.claim.sourceDate ?? input.claim.retrievedAt ?? null;
    if (!patch['signal_observed_at']) return false;
  }
  await updateOpportunity(input.opportunity.id, patch as never);

  await recordCardFact({
    projectId: input.opportunity.projectId,
    opportunityId: input.opportunity.id,
    field: input.field,
    kind: 'EVIDENCE',
    value,
    claimId: input.claim.id,
    needId: input.need.id,
    decidedBy: BRAIN,
  });

  await recordCashEvent({
    projectId: input.opportunity.projectId,
    opportunityId: input.opportunity.id,
    kind: 'CASH_CARD_ANSWERED',
    actorRef: BRAIN,
    summary: `The ${input.field} was established by research.`,
    detail: {
      field: input.field,
      claimId: input.claim.id,
      needId: input.need.id,
      sourceUrl: input.claim.sourceUrl,
    },
  });

  await closeNeed({
    needId: input.need.id,
    to: 'RESOLVED',
    resolution: `Established by research: ${clamp(input.claim.claim, 200)}`,
    actorUserId: BRAIN,
    verifiedBy: 'BRAIN_READ_THE_ROW',
  });
  return true;
}

export interface ProposedTerm {
  field: string;
  value: string;
  basis: string;
  assumptions: string;
  uncertainty: string;
  /**
   * The figure, where the field is stored as one.
   *
   * `price` is an integer column and `cashDates` is a date, so a sentence
   * cannot be the only form a proposal takes: without this the recommendation
   * would read well on the card and leave the column that decides readiness
   * still blank. The sentence stays, because it carries the range and the
   * reason the low end was taken.
   */
  cents?: number;
}

export interface Proposal {
  opportunityId: string;
  terms: ProposedTerm[];
  /** What Brain could not propose, and what would let it. */
  withheld: { field: string; because: string }[];
}

/**
 * Brain's commercial proposal for one opportunity.
 *
 * Deterministic and derived from the card's own evidence, which is deliberate:
 * this Brain buys no inference (§24), so a proposal that needed a model would
 * be a bin and a wait. What it produces instead is the reading a careful person
 * would make from the same rows — and where the rows do not support one, it
 * says so and proposes nothing rather than inventing a number and explaining it
 * afterwards.
 *
 * Seven things it settles, which is what a commercial decision actually needs:
 * the offer's scope *and its edges*, the acceptance condition, the price or the
 * range the sources state, the delivery method, who fulfils it, the expected
 * margin, and when the cash would actually arrive. Every one of them carries
 * its basis, its assumptions and its uncertainty, because a recommendation with
 * none of those is a guess wearing a citation.
 *
 * The two arithmetic ones are the ones most easily got wrong, so both refuse
 * rather than estimate. **A margin needs a price and a bounded exposure**, and
 * with either missing it is withheld naming which — a margin computed against
 * an unknown cost is the blank-as-favourable-assumption invariant 39 forbids,
 * and it fails in the direction that makes a piece look worth doing. **Unpriced
 * effort stays unpriced**: the hours are reported beside the margin rather than
 * multiplied by a rate nobody set, because inventing the rate is the same
 * defect one step along.
 */
export async function proposeTerms(opportunity: CashOpportunity): Promise<Proposal> {
  const out: Proposal = { opportunityId: opportunity.id, terms: [], withheld: [] };
  const signal = await cardFact(opportunity.id, 'buyingEvidence');
  const request = signal?.value ?? opportunity.buyingSignal;

  if (!request) {
    out.withheld.push({
      field: 'offer',
      because:
        'Nothing on this card says what was asked for, so there is nothing to scope an offer ' +
        'against. The buying evidence is what a proposal is built from.',
    });
    return out;
  }

  // ---------------------------------------------------------------------
  // The offer, and its edges
  // ---------------------------------------------------------------------
  //
  // A scope with no stated exclusions is the one that gets argued about after
  // the work is done, so the edges are part of the proposal rather than a
  // refinement of it. They are stated as *what this offer does not cover*
  // rather than as a guess at what the buyer also wants.
  const excluded = [
    'anything the request does not name',
    'revisions after the deliverable is accepted',
    ...(opportunity.humanHours === null ? [] : ['work beyond the hours this was scoped at']),
  ];
  out.terms.push({
    field: 'offer',
    value:
      `Deliver exactly what the published request asks for: ${clamp(request, 240)}. ` +
      `Not included: ${excluded.join('; ')}.`,
    basis: `The request itself${signal?.claimId ? ` (claim ${signal.claimId})` : ''}.`,
    assumptions:
      'That the request means what it says, has not been amended since it was published, and ' +
      'that its published wording is the whole of the scope.',
    uncertainty:
      'Anything the request leaves implicit — format, volume, revisions — is unstated here and ' +
      'is what a first reply should settle.',
  });

  out.terms.push({
    field: 'acceptance',
    value:
      'The buyer confirms in writing that the deliverable the request names has been provided ' +
      'in full, against the scope above.',
    basis: 'The request names its own deliverable, and the offer above names its edges.',
    assumptions: 'That the request states the whole of what the buyer will check.',
    uncertainty:
      'A buyer may hold an unpublished standard. Until one is agreed in writing, this is what ' +
      'Brain would work to rather than what the buyer has accepted.',
  });

  // ---------------------------------------------------------------------
  // The price, or the range the sources actually state
  // ---------------------------------------------------------------------
  //
  // Deriving one from nothing is exactly the invented judgment the old rule was
  // worried about, and the worry was right about *that*. What it got wrong was
  // concluding Brain may therefore never propose a price at all: where the
  // request published a budget, a rate or a fee schedule, quoting it back is
  // reading rather than guessing. `readMoneyFigures` is what keeps the
  // difference — it refuses a bare number, shorthand and a percentage, so its
  // failure mode is missing a figure rather than producing one.
  const economics = await cardFact(opportunity.id, 'economics');
  const sources: { text: string; claimId: string | null }[] = [];
  if (economics && economics.kind === 'EVIDENCE') {
    sources.push({ text: economics.value, claimId: economics.claimId });
  }
  if (signal && signal.kind === 'EVIDENCE') {
    sources.push({ text: signal.value, claimId: signal.claimId });
  } else if (opportunity.buyingSignal) {
    sources.push({ text: opportunity.buyingSignal, claimId: null });
  }

  const figures = sources.flatMap((source) =>
    readMoneyFigures(source.text, opportunity.currency).map((figure) => ({
      ...figure,
      claimId: source.claimId,
    })),
  );
  const cited = [...new Set(figures.map((one) => one.claimId).filter((one) => one !== null))];
  const low = figures[0];
  const high = figures[figures.length - 1];

  if (low && high) {
    const range = low.cents !== high.cents;
    out.terms.push({
      field: 'price',
      // The low end when the sources state a range, and the reason is not
      // caution for its own sake: the range is what somebody published, so the
      // top of it is the number Brain would least be able to defend, and an
      // unknown may never be read as the favourable one.
      cents: low.cents,
      value: range
        ? `${formatMoney(low.cents, opportunity.currency)} — the low end of a published range of ` +
          `${formatMoney(low.cents, opportunity.currency)} to ` +
          `${formatMoney(high.cents, opportunity.currency)}, because the top of a range is the ` +
          'figure Brain could least defend if asked.'
        : `${formatMoney(low.cents, opportunity.currency)}, as published.`,
      basis: range
        ? `${figures.length} figures stated in the sources on this card` +
          `${cited.length > 0 ? ` (claim${cited.length === 1 ? '' : 's'} ${cited.join(', ')})` : ''}.`
        : `The figure stated in the source on this card` +
          `${cited.length > 0 ? ` (claim ${cited[0]})` : ''}: ${low.text}.`,
      assumptions: 'That the published figure is what this buyer will actually pay.',
      uncertainty: range
        ? 'A published range says what the market has paid, not what this buyer will. Where it ' +
          'sits inside the range is settled by a reply, not by this.'
        : 'A stated budget is a ceiling as often as it is a price.',
    });
  } else {
    out.withheld.push({
      field: 'price',
      because:
        'No source on this card states a figure in ' +
        `${opportunity.currency}, and a price derived from nothing is a number with an ` +
        'explanation attached rather than a reading. Quote one, or research the published rate.',
    });
  }

  // ---------------------------------------------------------------------
  // Delivery, and who does it
  // ---------------------------------------------------------------------
  const canResearch = await readCapability('RESEARCH_A_QUESTION');
  out.terms.push({
    field: 'delivery',
    value:
      canResearch.state === 'PRESENT'
        ? 'Researched and assembled by Brain, reviewed before it is sent.'
        : 'Done by hand: Brain has no capability here that can produce this.',
    basis: `The capability register reads ${canResearch.id} as ${canResearch.state}.`,
    assumptions: 'That what the request asks for is within what that capability actually does.',
    uncertainty:
      'A capability being present says Brain can do the kind of work, not that this particular ' +
      'piece is inside it.',
  });

  out.terms.push({
    field: 'fulfillment',
    value: canResearch.state === 'PRESENT' ? 'Brain, with a person reviewing' : 'A person',
    basis: 'Follows from the delivery path above.',
    assumptions: 'That somebody is available to review before anything is sent.',
    uncertainty: 'Nothing here reserves that person\u2019s time.',
  });

  // ---------------------------------------------------------------------
  // The margin, which needs both halves
  // ---------------------------------------------------------------------
  const price = low?.cents ?? opportunity.priceCents;
  const exposure = opportunity.peakFundingCents;
  if (price !== null && price !== undefined && exposure !== null) {
    const margin = price - exposure;
    const hours = opportunity.humanHours;
    out.terms.push({
      field: 'economics',
      value:
        `${formatMoney(margin, opportunity.currency)} expected, being ` +
        `${formatMoney(price, opportunity.currency)} less ` +
        `${formatMoney(exposure, opportunity.currency)} of money out` +
        (hours === null
          ? '.'
          : `, before ${hours} hour${hours === 1 ? '' : 's'} of effort this does not price.`),
      basis:
        'The price above and the exposure recorded on this card. Both are figures somebody ' +
        'wrote down; nothing here estimates either.',
      assumptions:
        'That the recorded exposure is the whole of the money out, and that the price is ' +
        'collected in full.',
      uncertainty:
        (margin <= 0
          ? 'This is not positive at the price the sources state, which is a reason to decline ' +
            'rather than a reason to raise the price. '
          : '') +
        (hours === null
          ? 'No effort is recorded against this, so the margin is before whatever time it takes.'
          : 'The hours are reported rather than costed, because nobody has set a rate and ' +
            'inventing one would make this figure look decided.'),
    });
  } else {
    out.withheld.push({
      field: 'economics',
      because:
        price === null || price === undefined
          ? 'A margin needs a price, and no source states one. Whatever it was computed against ' +
            'would be an assumption reported as a figure.'
          : 'A margin needs the money going out, and this card records no bounded exposure. A ' +
            'margin against an unknown cost fails in the direction that makes a piece look ' +
            'worth doing.',
    });
  }

  // ---------------------------------------------------------------------
  // When the cash actually arrives
  // ---------------------------------------------------------------------
  //
  // Read from the rows, in order, and answered as *not known* rather than as a
  // default. "Net 30 from an unstated date" is a sentence that sounds like a
  // date and is not one.
  if (opportunity.paymentTerms) {
    out.terms.push({
      field: 'cashDates',
      value: `Cash arrives on the terms recorded: ${clamp(opportunity.paymentTerms, 160)}.`,
      basis: 'The payment terms on this card.',
      assumptions: 'That the buyer pays to the terms they agreed.',
      uncertainty: 'Agreed terms are when payment is due, never when it lands.',
    });
  } else if (opportunity.deadline) {
    out.terms.push({
      field: 'cashDates',
      value:
        `Delivery is due ${opportunity.deadline}; payment terms are not agreed, so cash is not ` +
        'expected before then and no later date can be stated.',
      basis: 'The deadline on this card, and the absence of any payment terms.',
      assumptions: 'That the deadline is the buyer\u2019s and not an internal one.',
      uncertainty:
        'The gap between delivering and being paid is the whole of the cash timing, and this ' +
        'card does not say what it is.',
    });
  } else {
    out.withheld.push({
      field: 'cashDates',
      because:
        'Neither payment terms nor a deadline is recorded, so nothing here says when the money ' +
        'would arrive. A sprint that cannot say that cannot plan around it.',
    });
  }

  return out;
}

/**
 * Write a proposal onto the card, as proposals.
 *
 * Every value lands as `RECOMMENDATION`, so nothing here can make a card say a
 * guess was checked. A field a person has answered is left exactly alone, and a
 * field already carrying evidence is too — `mayReplace` is where that order
 * lives, and it is about authority rather than recency.
 */
export async function applyProposal(input: {
  opportunity: CashOpportunity;
  proposal: Proposal;
}): Promise<string[]> {
  const written: string[] = [];
  for (const term of input.proposal.terms) {
    const existing = await cardFact(input.opportunity.id, term.field);
    if (!mayReplace(existing, 'RECOMMENDATION')) continue;

    const column = COLUMN[term.field];
    if (column) {
      // The figure where the column holds one, the sentence where it holds
      // prose. A term that declared `cents` and landed in a text column would
      // put "USD 1,200.00 — the low end of…" where an integer belongs.
      const value = term.cents === undefined ? term.value : term.cents;
      await updateOpportunity(input.opportunity.id, { [column]: value } as never);
    }
    await recordCardFact({
      projectId: input.opportunity.projectId,
      opportunityId: input.opportunity.id,
      field: term.field,
      kind: 'RECOMMENDATION',
      value: term.value,
      basis: term.basis,
      assumptions: term.assumptions,
      uncertainty: term.uncertainty,
      decidedBy: BRAIN,
    });
    written.push(term.field);
  }

  if (written.length > 0) {
    await recordCashEvent({
      projectId: input.opportunity.projectId,
      opportunityId: input.opportunity.id,
      kind: 'CASH_TERMS_PROPOSED',
      actorRef: BRAIN,
      summary: `Brain proposed ${written.length} term${written.length === 1 ? '' : 's'}.`,
      detail: { fields: written, withheld: input.proposal.withheld.map((one) => one.field) },
    });
  }
  return written;
}

/**
 * Everything on one project's cards that Brain proposed rather than read.
 *
 * Read by the review so a person sees what Brain decided on their behalf, and
 * by the card so nothing renders a proposal as a source.
 */
export async function proposalsFor(projectId: string): Promise<Map<string, CashCardFact[]>> {
  const { cardFactsForProject } = await import('../../repos/cashCardFacts.ts');
  const out = new Map<string, CashCardFact[]>();
  for (const fact of await cardFactsForProject(projectId)) {
    if (fact.kind !== 'RECOMMENDATION') continue;
    out.set(fact.opportunityId, [...(out.get(fact.opportunityId) ?? []), fact]);
  }
  return out;
}

export { listOpportunities, getMission };
