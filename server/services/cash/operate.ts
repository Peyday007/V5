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
  recordNeedContinuation,
  setNeedCandidate,
} from '../../repos/cashPortfolio.ts';
import { createCandidate } from '../../repos/russellCandidates.ts';
import { readCapability, needForCapability } from './capabilities.ts';
import { evidenceCard } from './card.ts';
import { closeNeed, raiseNeed } from './needs.ts';
import { beginExecution } from './opportunities.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import type { CashNeed, CashOpportunity } from '../../domain/types.ts';

/** Brain acting on its own account, never a person and never a worker. */
const BRAIN = 'BRAIN';

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

/**
 * The key a discoverable blank is raised under.
 *
 * `question:` rather than `capability:` because the two are answered by
 * different things, and `startDependentWork` reads exactly that prefix to
 * decide what research can settle. A missing payer is a fact somebody could
 * look up; a missing payment processor is an integration, and captured ideas
 * about integrations are questions nobody can research.
 */
function questionKey(opportunityId: string, field: string): string {
  return `question:${opportunityId}:${field}`;
}

export interface DiscoverableGap {
  needId: string;
  opportunityId: string;
  field: string;
}

/**
 * Turn the card's *facts* into Brain's work, and leave its decisions alone.
 *
 * `evidenceCard` now says which is which. Who can approve payment, how to reach
 * them and what they published are things somebody could look up, so putting
 * them on a person's review is Brain asking for homework it could have done —
 * and the review's own claim that answering one group releases three cards is
 * false when the three are three different buyers.
 *
 * What to offer, what to charge, what counts as accepted and who does the work
 * are the owner's calls. Brain never captures an idea for one of those, because
 * a researched answer to "what should we charge" is invented judgment wearing a
 * citation.
 */
export async function reconcileDiscoverableGaps(projectId: string): Promise<DiscoverableGap[]> {
  const out: DiscoverableGap[] = [];
  const open = await listNeeds({ projectId, states: ['OPEN'] });
  const keys = new Set(open.map((one) => one.requestKey).filter((one): one is string => !!one));

  for (const opportunity of await listOpportunities({
    projectId,
    states: ['DISCOVERED', 'EVIDENCE_CARD'],
  })) {
    const card = evidenceCard(opportunity);
    for (const field of card.fields) {
      if (!field.loadBearing || !field.discoverable || field.value !== null) continue;
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
}

export async function runNeedContinuations(projectId: string): Promise<Continuation[]> {
  const out: Continuation[] = [];
  for (const need of await needsAwaitingContinuation(projectId)) {
    // Claim first. The effect belongs on the far side of the compare-and-swap,
    // because two ticks reading one resolved need must produce one resumption.
    if (!(await claimNeedContinuation(need.id))) continue;
    const result = await continueOne(need);
    await recordNeedContinuation(need.id, result.note);
    out.push({ needId: need.id, ...result });
  }
  return out;
}

async function continueOne(need: CashNeed): Promise<{ note: string; resumed: boolean }> {
  if (need.state === 'WITHDRAWN') {
    return { note: 'Withdrawn, so there was nothing waiting to resume.', resumed: false };
  }
  if (!need.blocksState || !need.opportunityId) {
    return { note: 'Nothing was recorded as waiting on this.', resumed: false };
  }
  const opportunity = await getOpportunity(need.opportunityId);
  if (!opportunity) {
    return { note: 'The piece it was blocking no longer exists.', resumed: false };
  }
  if (need.blocksState !== 'EXECUTING') {
    return {
      note: `Nothing here knows how to resume a ${need.blocksState} transition.`,
      resumed: false,
    };
  }
  if (opportunity.state !== 'READY') {
    return {
      note: `The piece is ${opportunity.state.toLowerCase()}, so the transition it was blocking ` +
        'has already happened or no longer applies.',
      resumed: false,
    };
  }

  /*
   * Retried, never forced.
   *
   * No `firstAction`, so this advances the piece only if something is already
   * on the record. A resolved need can unblock work and can never manufacture
   * the evidence that work began — which is the whole of what the `cash_actions`
   * correction is for, and it would be undone by a continuation that supplied
   * its own action to get the transition through.
   */
  const resumed = await beginExecution({ opportunityId: opportunity.id, actorRef: BRAIN });
  return resumed.ok
    ? { note: `Resumed: ${resumed.message ?? 'executing'}.`, resumed: true }
    : { note: `Tried to resume and could not: ${resumed.reason}`, resumed: false };
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

/** One project's operating step, for the tick. */
export async function operate(projectId: string): Promise<{
  capabilities: CapabilityReconciliation;
  gaps: DiscoverableGap[];
  continuations: Continuation[];
  dependentWork: DependentWork[];
}> {
  if (!(await getCashMode(projectId))) {
    return {
      capabilities: { raised: [], settled: [] },
      gaps: [],
      continuations: [],
      dependentWork: [],
    };
  }
  /*
   * The order is the order the effects depend on each other in: name what is
   * missing, then answer what has become available, then start what research
   * can settle. Each pass is idempotent on its own, so a crash between two of
   * them resumes rather than repeating.
   */
  return {
    capabilities: await reconcileCapabilityNeeds(projectId),
    gaps: await reconcileDiscoverableGaps(projectId),
    continuations: await runNeedContinuations(projectId),
    dependentWork: await startDependentWork(projectId),
  };
}

export type { CashOpportunity };
