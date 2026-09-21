/**
 * The part where Brain does something about a need, rather than filing it.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * `cash_opportunities.required_capabilities` was written and read by nothing,
 * so a piece could declare that collecting its money needs a payment processor
 * and reach `READY` against a Brain that has none and had never been asked.
 * `closeNeed` set a status and wrote an event: nothing resumed, because nothing
 * recorded what had been waiting. A person could answer the same need over and
 * over and never learn that their answer was recorded and ignored.
 *
 * Both are §24's sentence at a new altitude — a state that says "waiting for a
 * person" which that person cannot resolve is not waiting, it is stuck — and
 * the remedy is the one this repository has reached for every other time:
 * derive the condition from rows instead of hooking the moment it changed. A
 * hook fixes one entrance; rows reach every entrance plus everything already
 * stranded.
 *
 * ---------------------------------------------------------------------------
 * Three passes, and what each of them may not do
 * ---------------------------------------------------------------------------
 *
 * `reconcileCapabilityNeeds` raises one need per capability an opportunity
 * requires and this Brain does not verifiably have, and settles one whose
 * capability has since arrived or is no longer required. It reads the
 * capability at the moment it asks, never a cache: a fleet that lost its last
 * healthy Routine an hour ago must not still be reported as able to research.
 *
 * `runNeedContinuations` retries the transition a settled need was blocking,
 * exactly once, on the far side of a compare-and-swap on `continued_at`. It
 * never invents an action to justify the transition — `beginExecution` without
 * a `firstAction` advances only if something is already on the record, so a
 * resolved need can unblock a piece and cannot fabricate one.
 *
 * `startDependentWork` is what makes a need a *dependent work reference* rather
 * than a note: where the missing thing is a question rather than an
 * integration, Brain captures an idea for it, and from there the ordinary path
 * runs — the archive check first, the judgment, the compiler, the envelope, the
 * evidence gate, all three audit roles. It captures and never launches, because
 * launching is `nextLaunchable`'s and spending is the standing authority's.
 *
 * **None of it gates anything.** No pass here refuses an opportunity, charges
 * an attempt, or stops unrelated work. An open need is a valid execution state
 * and Brain carries on around it, which is exactly what the plan means.
 */
import {
  getOpportunity,
  listNeeds,
  listOpportunities,
  needsAwaitingContinuation,
  claimNeedContinuation,
  deferNeedContinuation,
  finishNeedContinuation,
  setNeedCandidate,
} from '../../repos/cashPortfolio.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { readCapability, needForCapability } from './capabilities.ts';
import { cardFactsFor } from '../../repos/cashCardFacts.ts';
import { evidenceCard } from './card.ts';
import { cashEngineCard } from './engineCard.ts';
import { CAPTURE_INPUTS, cashTier } from './tier.ts';
import { questionKey } from './conditions.ts';
import { closeNeed, raiseNeed } from './needs.ts';
import { applyProposal, applyResearchAnswers, proposeTerms } from './answers.ts';
import { runValidations, type ValidationProgress } from './validation.ts';
import { recordWorkModelReclassification, type Reclassification } from './reclassify.ts';
import type { ResearchApplication } from './answers.ts';
import { actionKey, beginExecution, markReady } from './opportunities.ts';
import { checkCommercialAuthority } from './authority.ts';
import { countActions } from '../../repos/cashActions.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import type { CashNeed, CashOpportunity } from '../../domain/types.ts';

/** Brain acting on its own account, never a person and never a worker. */
const BRAIN = 'BRAIN';

/**
 * The first commercial act on a piece that is ready, and what it needs.
 *
 * Named here rather than chosen per opportunity, because "which action is this"
 * is the thing the grant is asked about — deriving it from prose on the card
 * would be a model judgement deciding what a person authorized.
 */
const CONTACT_ACTION = 'CONTACT_BUYER';
const CONTACT_CAPABILITY = 'SEND_A_MESSAGE';

/**
 * The states worth asking a capability question about.
 *
 * A declined or archived piece is one the sprint stopped pursuing, and raising
 * a need for it would fill the review with remedies nobody wants applied.
 */
const LIVE_STATES = ['DISCOVERED', 'EVIDENCE_CARD', 'READY', 'EXECUTING', 'DELIVERING'] as const;

/**
 * The key a capability need is raised under.
 *
 * Built from the opportunity and the capability, which are both server facts,
 * so the same missing capability raises one need however many ticks read it —
 * and so the pass that settles it can find the row by construction rather than
 * by parsing anything back out of it.
 */
function capabilityKey(opportunityId: string, capabilityId: string): string {
  return `capability:${opportunityId}:${capabilityId}`;
}

export interface CapabilityReconciliation {
  raised: string[];
  settled: string[];
}

export async function reconcileCapabilityNeeds(
  projectId: string,
): Promise<CapabilityReconciliation> {
  const out: CapabilityReconciliation = { raised: [], settled: [] };
  const open = await listNeeds({ projectId, states: ['OPEN'] });
  const byKey = new Map(open.filter((one) => one.requestKey).map((one) => [one.requestKey!, one]));

  const live = await listOpportunities({ projectId, states: [...LIVE_STATES] });
  const wanted = new Set<string>();

  for (const opportunity of live) {
    for (const capabilityId of opportunity.requiredCapabilities) {
      const key = capabilityKey(opportunity.id, capabilityId);
      wanted.add(key);
      const reading = await readCapability(capabilityId);
      const existing = byKey.get(key);

      if (reading.state === 'PRESENT') {
        if (!existing) continue;
        const closed = await closeNeed({
          needId: existing.id,
          to: 'RESOLVED',
          resolution:
            `${reading.id} now reads PRESENT, so this is no longer blocked. Brain checked rather ` +
            'than assumed: the reading comes from the rows the capability is made of.',
          actorUserId: BRAIN,
        });
        if (closed.ok) out.settled.push(existing.id);
        continue;
      }

      if (existing) continue;
      const composed = needForCapability(reading, `Progress "${opportunity.title}"`);
      if (!composed) continue;
      const raised = await raiseNeed({
        projectId,
        opportunityId: opportunity.id,
        actorRef: BRAIN,
        ...composed,
        // What is waiting on it. A *state* rather than a free reference,
        // because a state is what a continuation can actually retry.
        blocksState: 'EXECUTING',
        requestKey: key,
      });
      if (raised.ok && raised.value.createdAt === raised.value.updatedAt) {
        out.raised.push(raised.value.id);
      }
    }
  }

  /*
   * A need for something no longer required is withdrawn, not left open.
   *
   * An opportunity whose card was corrected — the capability was never needed,
   * or the piece was declined — would otherwise keep a remedy in the review for
   * ever, and a review that accumulates answered questions is one people stop
   * reading. Withdrawn rather than resolved: nothing was set up.
   */
  for (const [key, need] of byKey) {
    if (!key.startsWith('capability:') || wanted.has(key)) continue;
    const closed = await closeNeed({
      needId: need.id,
      to: 'WITHDRAWN',
      resolution:
        'Nothing requires this capability any more — the piece stopped needing it, or stopped ' +
        'being pursued. Nothing was set up, so this is withdrawn rather than resolved.',
      actorUserId: BRAIN,
    });
    if (closed.ok) out.settled.push(need.id);
  }

  return out;
}

export interface DiscoverableGap {
  needId: string;
  opportunityId: string;
  field: string;
}

/**
 * Turn the card's *facts* into Brain's work, and leave its decisions alone.
 *
 * `evidenceCard` says which is which, and the set moved. It used to be three
 * fields — the payer, the access route and the buying evidence — with the
 * price, the delivery path, who does the work, the cash dates, the economics
 * and the exposure all classified as the owner's calls. §30 had already
 * corrected the reasoning ("a commercial judgment is not permanently a
 * person's either") and the boolean had not moved with it, so production put
 * ninety-eight of those in front of somebody as decisions while Brain's own
 * screen said it was researching them.
 *
 * What a price, a fee, a settlement date, an eligibility rule or a delivery
 * requirement *is*, is a fact about the world. Brain raises a need and looks it
 * up. What is left for a person is what to offer and what counts as accepted —
 * `BRAIN_PROPOSES`, which Brain proposes and a person may overrule — and those
 * still never become needs, because a researched answer to "what should we
 * charge for this" is invented judgment wearing a citation.
 */
export async function reconcileDiscoverableGaps(projectId: string): Promise<DiscoverableGap[]> {
  const out: DiscoverableGap[] = [];
  const open = await listNeeds({ projectId, states: ['OPEN'] });
  const keys = new Set(open.map((one) => one.requestKey).filter((one): one is string => !!one));

  for (const opportunity of await listOpportunities({
    projectId,
    states: ['DISCOVERED', 'EVIDENCE_CARD'],
  })) {
    /*
     * Only for something Brain has a reason to spend on.
     *
     * Widening the researched set from three fields to seven made this reach
     * every blank on every record — and most records are signals, so a sprint
     * holding thirty-one published price lists would have raised two hundred
     * needs asking what to charge for somebody else's product. A need is
     * Brain's own work item; two hundred of them is the allowance spent
     * qualifying things that are not opportunities.
     *
     * The instrument that moves a **signal** is the bounded deep dive, which
     * asks the payer lane and is capped at two in flight. This is the fallback
     * for what the dive left blank, so it runs once there is a capture thesis
     * — a named payer and something to supply them — which is exactly the
     * point at which spending more on the piece is justified.
     */
    const card = evidenceCard(opportunity);
    const reading = cashTier({
      opportunity,
      card: cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) }),
      readiness: card.readiness,
    });
    /*
     * A signal is asked only the questions that could stop it being one.
     *
     * `captureMechanism` is composed from a payer, an offer and a route, so
     * those are the questions worth spending on while nothing says anybody
     * would pay us. Everything else on the card asks what a *decision* turns
     * on, and there is no decision to make about a published price list —
     * production held thirty-one of them, and asking all seven of each would
     * have been two hundred questions about what to charge for somebody
     * else's product.
     *
     * Skipping a signal *entirely* was the first version and was one bound too
     * many: it left the payer unasked, which is the single question that could
     * have moved the piece.
     */
    const asking =
      reading.tier === 'SIGNAL'
        ? card.fields.filter((one) => (CAPTURE_INPUTS as readonly string[]).includes(one.key))
        : card.fields;

    for (const field of asking) {
      if (!field.loadBearing || field.owner !== 'BRAIN_RESEARCH' || field.value !== null) continue;
      const key = questionKey(opportunity.id, field.key);
      if (keys.has(key)) continue;
      const raised = await raiseNeed({
        projectId,
        opportunityId: opportunity.id,
        actorRef: BRAIN,
        blockedAction: `${field.label} for "${opportunity.title}"`,
        whyItMatters:
          `This card cannot be tested without it, and it is a fact about the world rather than ` +
          'a decision of yours — so Brain looks it up rather than asking you.',
        recommendedPath: field.task,
        setupEffort: 'One bounded look.',
        nextStep: field.task,
        completionCondition: `The ${field.label.toLowerCase()} is recorded on this card.`,
        blocksState: 'EXECUTING',
        requestKey: key,
      });
      if (!raised.ok) continue;
      keys.add(key);
      out.push({ needId: raised.value.id, opportunityId: opportunity.id, field: field.key });
    }
  }

  /*
   * And a gap that has since been filled is settled, by whoever filled it.
   *
   * Derived from the card rather than hooked to the moment somebody typed the
   * answer, so a blank filled by a person, by a worker's accepted claim or by
   * a harvest all reach it — and so do the needs already stranded.
   */
  for (const need of open) {
    if (!need.requestKey?.startsWith('question:') || !need.opportunityId) continue;
    const opportunity = await getOpportunity(need.opportunityId);
    if (!opportunity) continue;
    /*
     * Matched by rebuilding the key, never by slicing it apart.
     *
     * Brain wrote the key from the opportunity and the field, so asking which
     * field produces this key is reading its own row back. Parsing the suffix
     * out would work today and would be wrong the first time a field name
     * carried the separator — and a need that stopped matching would sit open
     * for ever against a card that had already answered it.
     */
    const answered = evidenceCard(opportunity).fields.find(
      (one) => questionKey(need.opportunityId!, one.key) === need.requestKey,
    );
    if (!answered || answered.value === null) continue;
    await closeNeed({
      needId: need.id,
      to: 'RESOLVED',
      resolution: `The ${answered.label.toLowerCase()} is now on the card, so this is answered.`,
      actorUserId: BRAIN,
    });
  }

  return out;
}

export interface Continuation {
  needId: string;
  /** What actually happened, which is not the same fact as that it ran. */
  note: string;
  resumed: boolean;
  /** True when it will be tried again: a wait rather than an answer. */
  retry: boolean;
}

export async function runNeedContinuations(
  projectId: string,
  now?: string,
): Promise<Continuation[]> {
  const out: Continuation[] = [];
  const at = now ?? new Date().toISOString();
  for (const need of await needsAwaitingContinuation(projectId, at)) {
    // Claim first. The effect belongs on the far side of the compare-and-swap,
    // because two ticks reading one resolved need must produce one resumption.
    if (!(await claimNeedContinuation(need.id, at))) continue;
    const result = await continueOne(need);
    if (result.retry) {
      /*
       * Not yet, rather than never.
       *
       * The claim used to be terminal and written *before* the attempt, so a
       * refusal that was only ever going to be temporary — no commercial grant
       * yet, no free execution slot, the piece still at EVIDENCE_CARD — spent
       * the one chance the need had. The ordinary path made that the common
       * case, because a card filled by research leaves a piece short of READY.
       */
      await deferNeedContinuation({
        id: need.id,
        note: result.note,
        attempts: need.continuationAttempts + 1,
        now: at,
      });
    } else {
      await finishNeedContinuation(need.id, result.note);
    }
    out.push({ needId: need.id, note: result.note, resumed: result.resumed, retry: result.retry });
  }
  return out;
}

async function continueOne(
  need: CashNeed,
): Promise<{ note: string; resumed: boolean; retry: boolean }> {
  if (need.state === 'WITHDRAWN') {
    return {
      note: 'Withdrawn, so there was nothing waiting to resume.',
      resumed: false,
      retry: false,
    };
  }
  if (!need.blocksState || !need.opportunityId) {
    return { note: 'Nothing was recorded as waiting on this.', resumed: false, retry: false };
  }
  const opportunity = await getOpportunity(need.opportunityId);
  if (!opportunity) {
    return { note: 'The piece it was blocking no longer exists.', resumed: false, retry: false };
  }
  if (need.blocksState !== 'EXECUTING') {
    return {
      note: `Nothing here knows how to resume a ${need.blocksState} transition.`,
      resumed: false,
      retry: false,
    };
  }
  if (TERMINAL_STATES.has(opportunity.state)) {
    return {
      note: `The piece is ${opportunity.state.toLowerCase()}, so nothing is waiting on this.`,
      resumed: false,
      retry: false,
    };
  }
  if (opportunity.state !== 'READY' && opportunity.state !== 'DISCOVERED' &&
      opportunity.state !== 'EVIDENCE_CARD') {
    return {
      note: `The piece is ${opportunity.state.toLowerCase()}, so the transition it was blocking ` +
        'has already happened.',
      resumed: false,
      retry: false,
    };
  }

  /*
   * Resume from where the piece actually is.
   *
   * A card answered by research leaves it at `EVIDENCE_CARD`, so resuming has
   * to carry it through `markReady` first — the transition the need was
   * genuinely blocking is downstream of one the need's answer just unblocked.
   * Retrying `beginExecution` alone against an EVIDENCE_CARD piece spent the
   * continuation on a state that was never going to accept it.
   */
  if (opportunity.state !== 'READY') {
    const ready = await markReady({ opportunityId: opportunity.id, actorRef: BRAIN });
    if (!ready.ok) {
      return {
        note: `Not ready yet: ${ready.reason}`,
        resumed: false,
        retry: true,
      };
    }
  }

  /*
   * Retried, never forced.
   *
   * No `firstAction`, so this advances the piece only if something is already
   * on the record. A resolved need can unblock work and can never manufacture
   * the evidence that work began — which is the whole of what the
   * `cash_actions` correction is for, and it would be undone by a continuation
   * that supplied its own action to get the transition through.
   */
  const resumed = await beginExecution({ opportunityId: opportunity.id, actorRef: BRAIN });
  if (resumed.ok) {
    return { note: `Resumed: ${resumed.message ?? 'executing'}.`, resumed: true, retry: false };
  }

  /*
   * A refusal that names a condition somebody is about to fix is a wait.
   *
   * §27 settled the same distinction for dispatch refusals: a refusal meaning
   * "setup is missing" is not a refusal meaning "this may not happen", and
   * treating them alike destroys the work. Waiting on a grant, a slot or an
   * action is the first kind; the piece having gone somewhere else is the
   * second.
   */
  return {
    note: `Tried to resume and could not: ${resumed.reason}`,
    resumed: false,
    retry: isTemporary(resumed.reason),
  };
}

/** Opportunity states past which nothing is waiting on a need. */
const TERMINAL_STATES = new Set(['COLLECTED', 'DECLINED', 'ARCHIVED']);

/**
 * Is this refusal a condition that is expected to stop being true?
 *
 * Matched on the refusal's own shape rather than on a string a model wrote —
 * every one of these is composed by `beginExecution` from rows, and each names
 * something an authorized action resolves: granting the authority, finishing
 * something that occupies a slot, funding the account, or recording the first
 * action a person performed.
 */
export function isTemporary(reason: string): boolean {
  return (
    reason.includes('commercial authority') ||
    reason.includes('execution slots are taken') ||
    reason.includes('deployable') ||
    reason.includes('Nothing has happened on this yet')
  );
}

export interface DependentWork {
  needId: string;
  candidateId: string;
}

/**
 * Turn the questions among the open needs into real work.
 *
 * Only where the missing thing is a *question* — an unrecognised capability is
 * something to describe, an absent integration is something to set up, and
 * neither is answered by research. Captured rather than launched: the archive
 * is asked first, the judgment decides, and the standing authority decides
 * whether anything may be spent. None of those is this function's to make.
 */
export async function startDependentWork(projectId: string): Promise<DependentWork[]> {
  if (!(await getCashMode(projectId))) return [];
  const out: DependentWork[] = [];
  for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
    if (need.candidateId || !need.opportunityId) continue;
    if (!need.requestKey?.startsWith('question:')) continue;
    const opportunity = await getOpportunity(need.opportunityId);
    if (!opportunity) continue;
    const candidate = await createCandidate({
      projectId,
      visibility: 'SHARED',
      title: need.blockedAction,
      statement: `${need.whyItMatters} ${need.nextStep}`.trim(),
    });
    await setNeedCandidate(need.id, candidate.id);
    out.push({ needId: need.id, candidateId: candidate.id });
  }
  return out;
}

export interface AutonomousStep {
  opportunityId: string;
  did: 'MARKED_READY' | 'BEGAN_EXECUTION';
  detail: string;
}

export interface WithheldStep {
  opportunityId: string;
  /** What stopped it, in the words a person could act on. */
  because: string;
}

export interface AuthorityAdvance {
  took: AutonomousStep[];
  withheld: WithheldStep[];
}

/**
 * The commercial decisions Brain takes on its own, inside the limits a person
 * set first.
 *
 * §30 used to reserve the offer, the price, the acceptance condition and who
 * fulfils the work to the owner permanently. `proposeTerms` corrected the first
 * half of that — Brain may now *form* a view. This is the second half: a view
 * nobody ever acts on is a form somebody fills in with extra steps, and an
 * operator with high autonomy is the agreed product.
 *
 * Two decisions, and both are bounded by something the person owns rather than
 * by this function's own judgement.
 *
 *   * **Declaring a piece ready to test.** The bound is the card: `markReady`
 *     refuses while a load-bearing field is unknown, and that gate is untouched
 *     — every field it checks got there as evidence somebody sourced, a
 *     recommendation carrying its basis and uncertainty, or a person's own
 *     answer. Brain pressing the button changes who presses it, never what the
 *     button checks.
 *   * **Beginning execution.** The bound is the standing commercial grant, and
 *     the check is the same `checkCommercialAuthority` an HTTP caller goes
 *     through — the action from a closed set, the grant read live, the ceilings
 *     spent by the same compare-and-swap. There is no path here that does not
 *     go through it, which is what stops this being a second set of rules.
 *
 * **It never manufactures a capability it does not have.** Contacting a buyer
 * needs `SEND_A_MESSAGE`, which reads MISSING on this Brain because no
 * integration of that kind exists; so what actually happens today is that the
 * pieces reach READY by themselves and stop there, with the need naming the
 * missing integration already on the record. That is the honest state, and it
 * is reported as withheld rather than as done — a run that said it had
 * contacted somebody would be the one lie this section could tell that costs
 * real money.
 */
export async function advanceWithinAuthority(projectId: string): Promise<AuthorityAdvance> {
  const out: AuthorityAdvance = { took: [], withheld: [] };
  const mode = await getCashMode(projectId);
  if (!mode) return out;

  /*
   * Only while the sprint is running, and this is the one place in Cash Mode
   * where winding down stops something other than discovery.
   *
   * The rule is that the off switch ends new discovery and never a customer's
   * obligation, and every route here keeps working in all three states — a
   * person can still mark a piece ready and still execute one by hand while
   * winding down, because those are their decisions to take. What must not
   * happen is *Brain* starting a new obligation after somebody has said stop.
   * It is a skip rather than a refusal: no state moves, nothing is charged,
   * and it resumes by itself if the sprint is made active again.
   */
  if (mode.state !== 'ACTIVE') return out;

  for (const opportunity of await listOpportunities({
    projectId,
    states: ['DISCOVERED', 'EVIDENCE_CARD'],
  })) {
    // Asked before it is attempted: an incomplete card is the ordinary state of
    // a piece being worked on, and reporting every one of them as withheld
    // every tick would bury the ones that are actually stuck.
    if (!evidenceCard(opportunity).readiness.ready) continue;
    const ready = await markReady({ opportunityId: opportunity.id, actorRef: BRAIN });
    if (ready.ok) {
      out.took.push({
        opportunityId: opportunity.id,
        did: 'MARKED_READY',
        detail: 'Every load-bearing field is answered, so this is ready to test.',
      });
    } else {
      out.withheld.push({ opportunityId: opportunity.id, because: ready.reason });
    }
  }

  for (const opportunity of await listOpportunities({ projectId, states: ['READY'] })) {
    // The person's decision first, because it is the authorization and the
    // other is an operational fact: deny-by-default asks whether this may
    // happen before it asks whether it could.
    const decision = await checkCommercialAuthority({ projectId, action: CONTACT_ACTION });
    if (!decision.ok) {
      out.withheld.push({
        opportunityId: opportunity.id,
        because:
          `Not authorized to ${CONTACT_ACTION}: ${decision.reason}. That is the one decision ` +
          'Brain cannot take for somebody, and nobody has been contacted.',
      });
      continue;
    }

    const reading = await readCapability(CONTACT_CAPABILITY);
    if (reading.state !== 'PRESENT') {
      out.withheld.push({
        opportunityId: opportunity.id,
        because:
          `Reaching the buyer needs ${reading.id}, which reads ${reading.state}. Brain has no ` +
          'integration of that kind, so nobody has been contacted and nothing here says one ' +
          'has. The need naming it is on the record.',
      });
      continue;
    }

    /*
     * And here is where Brain would act.
     *
     * Unreachable on this Brain and deliberately left standing: every
     * capability but `RESEARCH_A_QUESTION` reads MISSING because no
     * integration of that kind exists (§30 says so in code rather than only
     * in prose), so the branch above is what actually happens today. It is
     * not dead code — it is the half that runs the moment a messaging
     * integration is registered, and the alternative to leaving it here is a
     * Brain that has the authorization and still needs somebody to press a
     * button. No run of this has contacted anybody, and nothing here says one
     * has.
     */

    const began = await beginExecution({
      opportunityId: opportunity.id,
      actorRef: BRAIN,
      firstAction: {
        action: CONTACT_ACTION,
        performedBy: 'BRAIN',
        detail:
          `Reached ${opportunity.payer ?? 'the payer'} through ${
            opportunity.reachableChannel ?? 'the recorded channel'
          } with the offer on this card.`,
        // Server-built, from the opportunity and how many actions it already
        // holds. Nothing the caller sent contributes, because nothing here has
        // a caller.
        requestKey: actionKey(
          opportunity.id,
          CONTACT_ACTION,
          String((await countActions(opportunity.id)) + 1),
        ),
      },
    });
    if (began.ok) {
      out.took.push({
        opportunityId: opportunity.id,
        did: 'BEGAN_EXECUTION',
        detail: began.message ?? 'executing',
      });
    } else {
      out.withheld.push({ opportunityId: opportunity.id, because: began.reason });
    }
  }

  return out;
}

/** One project's operating step, for the tick. */
export interface Proposed {
  opportunityId: string;
  fields: string[];
  withheld: string[];
}

/**
 * Brain's commercial view of every piece whose card it can form one about.
 *
 * The rule this replaces said the offer, the price, the acceptance condition
 * and who fulfils the work were permanently a person's — and it is right that a
 * researched answer to "what should we charge" is invented judgment wearing a
 * citation, and wrong that the conclusion is a prohibition. This is meant to be
 * an operator with high autonomy inside limits somebody set, and reserving
 * every commercial judgment to a human makes it a form to fill in.
 *
 * What keeps it honest is three things rather than a rule: every value lands as
 * a `RECOMMENDATION` and is rendered as one, a term with no stated uncertainty
 * cannot be written at all, and a field a person answered is never proposed
 * over. Nothing here touches what may be *spent* — that is the standing
 * commercial authority, and it is unchanged.
 */
export async function proposeCommercialTerms(projectId: string): Promise<Proposed[]> {
  const out: Proposed[] = [];
  for (const opportunity of await listOpportunities({
    projectId,
    states: ['DISCOVERED', 'EVIDENCE_CARD'],
  })) {
    const proposal = await proposeTerms(opportunity);
    if (proposal.terms.length === 0 && proposal.withheld.length === 0) continue;
    const fields = await applyProposal({ opportunity, proposal });
    if (fields.length === 0 && proposal.withheld.length === 0) continue;
    out.push({
      opportunityId: opportunity.id,
      fields,
      withheld: proposal.withheld.map((one) => one.field),
    });
  }
  return out;
}

/** One project's operating step, for the tick. */
export async function operate(
  projectId: string,
  now?: string,
): Promise<{
  /** Non-null exactly once per project, the pass that recorded the change. */
  reclassified: Reclassification | null;
  capabilities: CapabilityReconciliation;
  gaps: DiscoverableGap[];
  research: ResearchApplication;
  proposed: Proposed[];
  continuations: Continuation[];
  dependentWork: DependentWork[];
  validations: ValidationProgress;
  authority: AuthorityAdvance;
}> {
  if (!(await getCashMode(projectId))) {
    return {
      reclassified: null,
      capabilities: { raised: [], settled: [] },
      gaps: [],
      research: { applied: [], unanswered: [] },
      proposed: [],
      continuations: [],
      dependentWork: [],
      validations: { started: [], settled: [] },
      authority: { took: [], withheld: [] },
    };
  }
  /*
   * The order is the order the effects depend on each other in: name what is
   * missing, take back what the research established, form a view on top of
   * it, answer what has become available, then start what research can settle.
   * Each pass is idempotent on its own, so a crash between two of them resumes
   * rather than repeating.
   */
  /*
   * First, and once ever: say on the record that the work model changed.
   *
   * Ahead of everything because it is a *reading* of the portfolio as it stands
   * before this pass touches anything, and because a person who had been
   * reading `1 to act on now, 40 waiting` deserves to find out from the history
   * rather than by noticing. It archives nothing and moves nothing — see
   * `reclassify.ts`.
   */
  const reclassified = await recordWorkModelReclassification(projectId);
  const capabilities = await reconcileCapabilityNeeds(projectId);
  const research = await applyResearchAnswers(projectId);
  const proposed = await proposeCommercialTerms(projectId);
  const gaps = await reconcileDiscoverableGaps(projectId);
  const continuations = await runNeedContinuations(projectId, now);
  const dependentWork = await startDependentWork(projectId);
  /*
   * And the bounded deep dive on each opening, which is where the commercial
   * questions actually get answered.
   *
   * After the needs path rather than instead of it: a need is raised for one
   * blank on one card and is answered by one narrow question, while a
   * validation qualifies a whole opening. They overlap in what they can fill,
   * and `mayReplace` decides which answer stands — by authority rather than by
   * whichever arrived last.
   */
  const validations = await runValidations(projectId);
  /*
   * Last, and that order is the point: a piece only becomes ready because the
   * research landed on its card and the proposal filled what the research could
   * not, both of which happened above. Asking first would ask about last tick's
   * card and defer every decision by one pass.
   */
  const authority = await advanceWithinAuthority(projectId);
  return {
    reclassified,
    capabilities,
    gaps,
    research,
    proposed,
    continuations,
    dependentWork,
    validations,
    authority,
  };
}

export type { CashOpportunity };
