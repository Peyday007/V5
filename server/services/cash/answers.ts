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
import { getMission } from '../../repos/russellMissions.ts';
import { missionsForRounds } from '../russell/roundMissions.ts';
import { getOpportunity, listOpportunities, updateOpportunity } from '../../repos/cashPortfolio.ts';
import { listNeeds } from '../../repos/cashPortfolio.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import {
  cardFact,
  clearColumnIfStill,
  mayReplace,
  recordCardFact,
  withdrawRecommendationValue,
} from '../../repos/cashCardFacts.ts';
import { listAllocations, listTasks, listWorkflows } from '../../repos/labor.ts';
import { evidenceCard } from './card.ts';
import { questionKey } from './conditions.ts';
import { closeNeed } from './needs.ts';
import { readCapabilities } from './capabilities.ts';
import { formatMoney, readMoneyFigures } from './figures.ts';
import { NON_HUMAN_LAYERS } from '../../domain/types.ts';
import type {
  CashCardFact,
  CashNeed,
  CashOpportunity,
  LaborAllocation,
  ResearchClaim,
} from '../../domain/types.ts';

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
export const COLUMN: Record<string, string> = {
  payer: 'payer',
  access: 'reachable_channel',
  offer: 'offer_scope',
  acceptance: 'acceptance_condition',
  price: 'price_cents',
  delivery: 'delivery_method',
  fulfillment: 'fulfillment_owner',
  economics: 'economics_note',
  nextAction: 'next_action',
  /*
   * The exposure, which was load-bearing and answered by nothing.
   *
   * `evidenceCard` refuses readiness while it is blank, `reconcileDiscoverableGaps`
   * raised a research need for it, and `applyOne` then returned false because
   * there was no column to put the answer in — so the need sat open beside a
   * finished mission for ever and no piece could reach READY_TO_TEST without a
   * person typing a number. §24's *waiting nobody can resolve*, at a column.
   */
  exposure: 'peak_funding_cents',
};

/**
 * Which columns hold minor units rather than prose, and which end of a stated
 * range each one takes.
 *
 * A research claim is a sentence, and writing the sentence into an integer
 * column is wrong twice: SQLite stores the text and `money()` renders nonsense,
 * and Postgres refuses the statement, which throws out of `applyResearchAnswers`
 * and stops every pass after it in the operating step. So a money field is read
 * through `readMoneyFigures` — which refuses bare numbers, shorthand and
 * percentages, so its failure mode is missing a figure rather than inventing
 * one — and a claim with no figure in it does not answer a money field.
 *
 * The end chosen is the unfavourable one in both directions: the lowest price
 * anybody published, and the highest cost. An unknown may never be read as the
 * favourable assumption, and the end of a range is a choice between two
 * published figures rather than an estimate.
 */
export const MONEY_FIELD: Readonly<Record<string, 'LOW' | 'HIGH'>> = Object.freeze({
  price: 'LOW',
  exposure: 'HIGH',
});

/**
 * The largest amount the two integer columns hold on Postgres.
 *
 * `price_cents` and `peak_funding_cents` are `INTEGER` there and unbounded on
 * SQLite, so a figure above this would be stored by one backend and refused by
 * the other — the same throw out of `applyResearchAnswers` this module exists to
 * prevent. Such a figure answers nothing rather than being clipped.
 */
export const MAX_COLUMN_CENTS = 2_147_483_647;

/**
 * The figure a sentence states for a money field, or null when it states none.
 *
 * A figure stated per something — an hour, a word, a month — is not a total and
 * is left out, because a rate read as a price or an exposure is wrong by however
 * many units the work takes.
 */
export function figureFor(field: string, text: string, currency: string): number | null {
  const end = MONEY_FIELD[field];
  if (!end) return null;
  const figures = readMoneyFigures(text, currency).filter(
    (figure) => !figure.perUnit && figure.cents <= MAX_COLUMN_CENTS,
  );
  if (figures.length === 0) return null;
  return end === 'LOW' ? figures[0]!.cents : figures[figures.length - 1]!.cents;
}

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

  /*
   * Each need's own idea, read by key (RES-2). This was the hundred most
   * recently updated missions of the project, so a need whose mission had
   * fallen out of the window read NEVER_STARTED about research that had run —
   * and with two attempts in the window the map kept the older one.
   */
  const byCandidate = await missionsForRounds(
    open.map((one) => one.candidateId).filter((one): one is string => one !== null),
  );

  for (const need of open) {
    if (!need.candidateId || !need.opportunityId || !need.requestKey?.startsWith('question:')) {
      continue;
    }
    const opportunity = await getOpportunity(need.opportunityId);
    if (!opportunity) continue;
    const field = fieldOf(need, opportunity);
    if (!field) continue;

    const rounds = byCandidate.get(need.candidateId);
    const mission = rounds?.latest ?? null;
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
    const supporting = (
      await Promise.all((rounds?.orchestrationIds ?? []).map((id) => citableClaims(id)))
    )
      .flat()
      .filter(
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
    /*
     * The first supporting claim that actually answers the field.
     *
     * Taking `supporting[0]` alone was right while every field took prose; a
     * money field takes only a claim that states a figure, and the one that
     * does may not be first. A finished mission none of whose claims can
     * answer the field is reported rather than skipped silently, because an
     * open need beside a DONE mission otherwise reads as research in progress.
     */
    let claim: ResearchClaim | null = null;
    for (const candidate of assessed.supporting) {
      if (
        await applyOne({
          opportunity: assessed.opportunity,
          field: assessed.field,
          need: assessed.need,
          claim: candidate,
        })
      ) {
        claim = candidate;
        break;
      }
    }
    if (!claim) {
      if (MONEY_FIELD[assessed.field]) {
        out.unanswered.push({
          needId: assessed.need.id,
          opportunityId: assessed.opportunity.id,
          field: assessed.field,
          state: 'NO_SUPPORT',
          detail:
            `The research finished and none of its ${assessed.supporting.length} gated ` +
            `claim${assessed.supporting.length === 1 ? '' : 's'} states a figure in ` +
            `${assessed.opportunity.currency}, so the ${assessed.field} stays unknown rather ` +
            'than being read out of a sentence.',
        });
      }
      continue;
    }
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
  const patch: Record<string, string | number | null> = { [column]: value };
  if (MONEY_FIELD[input.field]) {
    const cents = figureFor(input.field, input.claim.claim, input.opportunity.currency);
    if (cents === null) return false;
    patch[column] = cents;
  }
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
  withheld: {
    field: string;
    because: string;
    /**
     * Earlier proposals this reading no longer supports, by their exact text.
     * Withdrawn only while the card still holds that recommendation (RES-6).
     */
    retracts?: readonly string[];
  }[];
}

/**
 * The two sentences the old derivation wrote from `RESEARCH_A_QUESTION` alone.
 *
 * Being able to research a question is not evidence that Brain can deliver what
 * a buyer is paying for: a Christmas-tree supply bid, a bug bounty and gig
 * hauling all read "Brain, with a person reviewing" (RES-6). Named exactly so a
 * correction withdraws only these and never a person's answer or a proposal
 * built from anything else.
 */
const RESEARCH_ONLY_DELIVERY = Object.freeze([
  'Researched and assembled by Brain, reviewed before it is sent.',
]);
const RESEARCH_ONLY_FULFILMENT = Object.freeze(['Brain, with a person reviewing']);

/** Labor layers that are a physical person on site, whatever else is true. */
const PHYSICAL = (allocation: LaborAllocation): boolean =>
  allocation.productionLayer === 'PHYSICAL_OPERATOR' ||
  allocation.necessityReason === 'PHYSICAL_EXECUTION';

type DeliveryReading =
  | { kind: 'PROPOSE'; delivery: string; fulfillment: string; basis: string }
  | { kind: 'WITHHOLD'; because: string };

/**
 * How this opening would be delivered and by whom, from the rows that say what
 * delivering it requires (RES-6).
 *
 * Two authoritative records, and nothing else:
 *
 * - the opening's own `required_capabilities`, each read now through
 *   `readCapability`;
 * - the labor kernel's workflow for this opening, its tasks, and who each one's
 *   live allocation says produces it.
 *
 * A physical deliverable — any task allocated to a physical operator, or kept
 * with a person for physical execution — is never proposed as Brain's. Neither
 * is an opening whose requirements nobody has recorded, one with a required
 * capability that is not PRESENT, or one with a task nobody has allocated. In
 * each case the field stays unknown with the reason, and the missing
 * capability stays visible as its own need, because concealing an unmet
 * requirement and proposing past it are the same mistake.
 */
export async function deliveryReading(opportunity: CashOpportunity): Promise<DeliveryReading> {
  const workflow = (await listWorkflows(opportunity.projectId)).find(
    (one) => one.opportunityId === opportunity.id && one.retiredAt === null,
  );
  const tasks = workflow
    ? (await listTasks(opportunity.projectId)).filter(
        (one) => one.workflowId === workflow.id && one.retiredAt === null,
      )
    : [];
  const live = new Map<string, LaborAllocation>();
  if (tasks.length > 0) {
    for (const allocation of await listAllocations(opportunity.projectId)) {
      if (allocation.supersededAt === null) live.set(allocation.taskId, allocation);
    }
  }

  const physical = tasks.filter((task) => {
    const allocation = live.get(task.id);
    return allocation ? PHYSICAL(allocation) : false;
  });
  if (physical.length > 0) {
    return {
      kind: 'WITHHOLD',
      because:
        `Delivering this needs physical work (${physical.map((one) => one.name).join(', ')}), ` +
        'which Brain cannot do and nobody has been named for. Being able to research it is ' +
        'not being able to perform it.',
    };
  }

  const required = await readCapabilities(opportunity.requiredCapabilities);
  if (required.length === 0 && tasks.length === 0) {
    return {
      kind: 'WITHHOLD',
      because:
        'Nothing records what delivering this requires, so who could deliver it is unknown. ' +
        'Brain being able to research a question is not evidence it can produce what the ' +
        'buyer is paying for.',
    };
  }
  const notPresent = required.filter((one) => one.state !== 'PRESENT');
  if (notPresent.length > 0) {
    return {
      kind: 'WITHHOLD',
      because:
        `Delivering this needs ${notPresent.map((one) => `${one.id} (${one.state})`).join(', ')}, ` +
        'which Brain does not have now; that gap is raised as its own need.',
    };
  }
  const unallocated = tasks.filter((task) => !live.has(task.id));
  if (unallocated.length > 0) {
    return {
      kind: 'WITHHOLD',
      because:
        `Who produces ${unallocated.map((one) => one.name).join(', ')} has not been decided.`,
    };
  }

  const people = tasks
    .map((task) => ({ task, allocation: live.get(task.id)! }))
    .filter(({ allocation }) => !NON_HUMAN_LAYERS.includes(allocation.productionLayer));
  const basis =
    `Required capabilities read now: ${
      required.map((one) => `${one.id} ${one.state}`).join(', ') || 'none recorded'
    }. Labor allocations: ${
      tasks.map((task) => `${task.name} → ${live.get(task.id)!.productionLayer}`).join(', ') ||
      'no tasks'
    }.`;
  if (people.length > 0) {
    const names = people
      .map(({ task, allocation }) => `${task.name} by ${allocation.productionLayer.toLowerCase()}`)
      .join(', ');
    return {
      kind: 'PROPOSE',
      delivery: `Brain for what its capabilities cover; ${names}.`,
      fulfillment: `Brain with people: ${names}.`,
      basis,
    };
  }
  return {
    kind: 'PROPOSE',
    delivery: `Produced by Brain through ${required.map((one) => one.id).join(', ') || 'its allocated tasks'}, reviewed before it is sent.`,
    fulfillment: 'Brain, with a person reviewing',
    basis,
  };
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

  // The same predicate research's writer applies, so the two writers of
  // `price_cents` cannot disagree: a rate is not a price, and a figure the
  // Postgres column cannot hold is not proposed at all.
  const figures = sources.flatMap((source) =>
    readMoneyFigures(source.text, opportunity.currency)
      .filter((figure) => !figure.perUnit && figure.cents <= MAX_COLUMN_CENTS)
      .map((figure) => ({
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
  // The exposure, read from what the costs are published at
  // ---------------------------------------------------------------------
  //
  // The most money out before any comes back is a reading of the published
  // direct costs, and only where they state a figure: the highest one, because
  // a cost is the unfavourable direction and the top of a range is what could
  // actually be spent. A cost sentence with no figure in it — "nothing to buy",
  // "a few tools" — proposes nothing, because a zero read out of prose is the
  // single most flattering thing this card could say.
  const costs = await cardFact(opportunity.id, 'directCosts');
  const costCents =
    costs && costs.kind === 'EVIDENCE' ? figureFor('exposure', costs.value, opportunity.currency) : null;
  /*
   * Only a proposal may replace a proposal. A figure already on the column with
   * no card fact behind it, or behind a source or a person, is left exactly as
   * it is — and the margin below is computed against whichever value the card
   * will actually hold after this pass, so the economics sentence and
   * `peak_funding_cents` can never disagree.
   */
  const exposureFact = await cardFact(opportunity.id, 'exposure');
  const mayPropose =
    costCents !== null &&
    (exposureFact ? exposureFact.kind === 'RECOMMENDATION' : opportunity.peakFundingCents === null);
  const exposureCents = mayPropose ? costCents : opportunity.peakFundingCents;
  if (mayPropose) {
    out.terms.push({
      field: 'exposure',
      cents: costCents!,
      value:
        `At most ${formatMoney(costCents!, opportunity.currency)} out before the buyer pays — ` +
        'the highest direct cost the sources publish.',
      basis: `The published direct costs${costs!.claimId ? ` (claim ${costs!.claimId})` : ''}: ` +
        `${clamp(costs!.value, 200)}.`,
      assumptions:
        'That the published costs are the whole of what has to be paid before the money ' +
        'arrives, and that they are paid once rather than per attempt.',
      uncertainty:
        'A cost the sources do not publish is not in this figure, and an unsuccessful test ' +
        'spends it without anything coming back.',
    });
  } else if (opportunity.peakFundingCents === null) {
    out.withheld.push({
      field: 'exposure',
      because:
        'No published cost on this card states a figure, so the most money out before payment ' +
        'is unknown. Reading zero out of that would make the piece look free to test.',
    });
  }

  // ---------------------------------------------------------------------
  // Delivery, and who does it
  // ---------------------------------------------------------------------
  const delivery = await deliveryReading(opportunity);
  if (delivery.kind === 'PROPOSE') {
    out.terms.push(
      {
        field: 'delivery',
        value: delivery.delivery,
        basis: delivery.basis,
        assumptions: 'That the requirements recorded for this opening are all it needs.',
        uncertainty:
          'A requirement nobody has recorded is not in this reading, and a capability being ' +
          'present says Brain can do that kind of work, not that this piece is inside it.',
      },
      {
        field: 'fulfillment',
        value: delivery.fulfillment,
        basis: delivery.basis,
        assumptions: 'That somebody is available to review before anything is sent.',
        uncertainty: 'Nothing here reserves that person\u2019s time.',
      },
    );
  } else {
    out.withheld.push(
      { field: 'delivery', because: delivery.because, retracts: RESEARCH_ONLY_DELIVERY },
      { field: 'fulfillment', because: delivery.because, retracts: RESEARCH_ONLY_FULFILMENT },
    );
  }

  // ---------------------------------------------------------------------
  // The margin, which needs both halves
  // ---------------------------------------------------------------------
  // The price the card will actually hold after this pass: the proposal only
  // where `applyProposal` would write it, otherwise what is already there.
  const priceProposable = mayReplace(await cardFact(opportunity.id, 'price'), 'RECOMMENDATION');
  const price = (priceProposable ? low?.cents : undefined) ?? opportunity.priceCents;
  const exposure = exposureCents;
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

  /*
   * A proposal this reading no longer supports is taken back (RES-6), guarded
   * on the card still holding exactly that recommendation, so a person's
   * answer — or anything written since — is never touched, and a second tick
   * withdraws nothing.
   */
  const retracted: string[] = [];
  for (const withheld of input.proposal.withheld) {
    for (const value of withheld.retracts ?? []) {
      if (
        await withdrawRecommendationValue({
          opportunityId: input.opportunity.id,
          field: withheld.field,
          value,
        })
      ) {
        const column = COLUMN[withheld.field];
        if (column) await clearColumnIfStill({ opportunityId: input.opportunity.id, column, value });
        retracted.push(withheld.field);
      }
    }
  }
  if (retracted.length > 0) {
    await recordCashEvent({
      projectId: input.opportunity.projectId,
      opportunityId: input.opportunity.id,
      kind: 'CASH_TERMS_WITHDRAWN',
      actorRef: BRAIN,
      summary:
        `Brain withdrew its proposal for ${retracted.join(' and ')}: it rested only on being ` +
        'able to research a question, which is not being able to deliver this.',
      detail: {
        fields: retracted,
        because: input.proposal.withheld.find((one) => retracted.includes(one.field))?.because,
      },
    });
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
