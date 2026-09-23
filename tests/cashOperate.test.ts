/**
 * The part where Brain acts on what a piece says it needs.
 *
 * Three things were stored and read by nothing, and each of them is the same
 * defect: a row that looks like a mechanism and is not one.
 *
 * `required_capabilities` was written by the card and consulted nowhere, so a
 * piece could declare that collecting its money needs a payment processor and
 * reach READY against a Brain that has none and had never been asked.
 *
 * `closeNeed` set a status and wrote an event. Nothing resumed, because nothing
 * recorded what had been waiting — so a person could answer the same need over
 * and over and never learn that their answer was recorded and ignored. §24's
 * sentence at a table rather than at a state machine.
 *
 * `beginExecution` moved an opportunity to EXECUTING and emitted an event with
 * no work enqueued, no action performed and nothing anywhere a later reader
 * could point at. "The transaction is being pursued", written on a button
 * press.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { actionsFor, countActions } from '../server/repos/cashActions.ts';
import {
  CONTINUATION_LEASE_MS,
  claimNeedContinuation,
  getNeed,
  getOpportunity,
  listNeeds,
} from '../server/repos/cashPortfolio.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createWorker } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { cardFact, recordCardFact } from '../server/repos/cashCardFacts.ts';
import { applyResearchAnswers } from '../server/services/cash/answers.ts';
import type { Layer } from '../server/domain/types.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
} from '../server/services/cash/authority.ts';
import {
  actionKey,
  beginExecution,
  capture,
  fillCard,
  markReady,
} from '../server/services/cash/opportunities.ts';
import { closeNeed, raiseNeed } from '../server/services/cash/needs.ts';
import {
  operate,
  proposeCommercialTerms,
  reconcileCapabilityNeeds,
  reconcileDiscoverableGaps,
  runNeedContinuations,
  startDependentWork,
} from '../server/services/cash/operate.ts';
import { CAPABILITIES, readCapability } from '../server/services/cash/capabilities.ts';
import { updateOpportunity } from '../server/repos/cashPortfolio.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `operate-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
});

async function granted(): Promise<void> {
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

/** A healthy execution surface, which is what `RESEARCH_A_QUESTION` reads. */
async function healthyFleet(): Promise<void> {
  const worker = await createWorker({
    name: `cash-operate-${Math.random().toString(36).slice(2, 8)}`,
    displayName: 'A worker',
    createdByType: 'HUMAN',
    createdById: userId,
  });
  const account = await createAccount({ name: 'An account', declaredPlanPower: '20x' });
  await createRoutine({
    accountId: account.id,
    routineRef: `rtn-${Math.random().toString(36).slice(2, 8)}`,
    name: 'A Routine',
    tokenSecretName: 'FAKE_SECRET',
    // A digest, never a secret. The capability reads that one exists.
    tokenDigest: 'a'.repeat(64),
    workerId: worker.id,
  });
}

async function readyPiece(
  requiredCapabilities: string[] = [],
): Promise<string> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title: 'A paid intake repair',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    requiredCapabilities,
  });
  if (!captured.ok) throw new Error(captured.reason);
  const filled = await fillCard({
    opportunityId: captured.value.id,
    actorRef: userId,
    patch: {
      payer: 'The owner, who signs',
      reachableChannel: 'Replied on Tuesday',
      buyingSignal: 'Asked for a quote',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      offerScope: 'One fixed-scope intake repair',
      acceptanceCondition: 'Form submits and a test enquiry arrives',
      priceCents: 75_000,
      deliveryMethod: 'One afternoon of configuration',
      fulfillmentOwner: 'Us',
      peakFundingCents: 0,
    },
  });
  expect(filled.ok).toBe(true);
  /*
   * And the rest of the execution thesis, answered by the person.
   *
   * `markReady` asks for more than the short card now: whether we are
   * eligible, how the work actually gets done, whether calling is required,
   * what it costs, when the money arrives. Those are facts Brain researches
   * and they are not *only* Brain's — `mayReplace` is about authority rather
   * than recency, so somebody who knows the answer may give it, and a person's
   * answer then stands against anything automatic. This fixture is a piece
   * somebody captured and filled by hand, so it answers them by hand.
   */
  for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
    await recordCardFact({
      projectId,
      opportunityId: captured.value.id,
      field,
      kind: 'PERSON',
      value: `The owner's own answer to ${field}.`,
      decidedBy: userId,
    });
  }
  expect((await markReady({ opportunityId: captured.value.id, actorRef: userId })).ok).toBe(true);
  return captured.value.id;
}

describe('executing means something happened', () => {
  it('refuses the transition when nothing has', async () => {
    await granted();
    const id = await readyPiece();

    const refused = await beginExecution({ opportunityId: id, actorRef: userId });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toContain('Nothing has happened on this yet');
    expect((await getOpportunity(id))!.state).toBe('READY');
    expect(await countActions(id)).toBe(0);
  });

  it('advances once an action is recorded, and keeps it as history', async () => {
    await granted();
    const id = await readyPiece();

    const moved = await beginExecution({
      opportunityId: id,
      actorRef: userId,
      firstAction: {
        action: 'CONTACT_BUYER',
        performedBy: 'PERSON',
        detail: 'Emailed the owner with a one-line scope and a price.',
        reference: 'msg-8841',
        requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
      },
    });
    expect(moved.ok).toBe(true);
    expect((await getOpportunity(id))!.state).toBe('EXECUTING');

    const actions = await actionsFor(id);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.performedBy).toBe('PERSON');
    expect(actions[0]!.reference).toBe('msg-8841');
    expect(actions[0]!.confirmedBy).toBe(userId);
  });

  it('records one action however many times the same call arrives', async () => {
    await granted();
    const id = await readyPiece();
    const firstAction = {
      action: 'CONTACT_BUYER' as const,
      performedBy: 'PERSON' as const,
      detail: 'Emailed the owner.',
      requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
    };

    expect((await beginExecution({ opportunityId: id, actorRef: userId, firstAction })).ok).toBe(
      true,
    );
    // The lost-response retry. Same key, so the same thing happened once.
    expect((await beginExecution({ opportunityId: id, actorRef: userId, firstAction })).ok).toBe(
      true,
    );
    expect(await countActions(id)).toBe(1);
  });

  it('refuses an action outside the closed commercial vocabulary', async () => {
    await granted();
    const id = await readyPiece();
    const refused = await beginExecution({
      opportunityId: id,
      actorRef: userId,
      firstAction: {
        action: 'DO_WHATEVER_IT_TAKES',
        performedBy: 'PERSON',
        detail: 'Improvised.',
        requestKey: actionKey(id, 'DO_WHATEVER_IT_TAKES', 'first'),
      },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.reason).toContain('not an action this Brain knows how to authorize');
    expect(await countActions(id)).toBe(0);
  });

  it('asks the grant about the action that actually happened', async () => {
    // The grant covers contacting a buyer and nothing else, so recording a
    // publication under it is refused — rather than authorized as a contact
    // and then stored as a publication.
    await createAuthority({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'A narrow grant',
      allowedActions: ['CONTACT_BUYER'],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 100_000,
      maxPerActionCents: 40_000,
      maxConcurrent: 3,
      currency: 'USD',
    });
    const id = await readyPiece();
    const refused = await beginExecution({
      opportunityId: id,
      actorRef: userId,
      firstAction: {
        action: 'PUBLISH_OFFER',
        performedBy: 'PERSON',
        detail: 'Put it on a board.',
        requestKey: actionKey(id, 'PUBLISH_OFFER', 'first'),
      },
    });
    expect(refused.ok).toBe(false);
    expect(await countActions(id)).toBe(0);
  });
});

describe('a capability is read rather than assumed', () => {
  it('tells an absent integration apart from a word it has never heard', async () => {
    const absent = await readCapability('TAKE_A_PAYMENT');
    expect(absent.state).toBe('MISSING');
    expect(absent.definition).not.toBeNull();

    const unheard = await readCapability('SUMMON_A_BUYER');
    expect(unheard.state).toBe('UNKNOWN');
    expect(unheard.definition).toBeNull();
  });

  it('answers research from the fleet rather than from a constant', async () => {
    // With no healthy Routine there is no surface, so Brain cannot research —
    // and saying PRESENT here would be the invented measurement §29 refuses.
    expect((await readCapability('RESEARCH_A_QUESTION')).state).toBe('MISSING');
    await healthyFleet();
    expect((await readCapability('RESEARCH_A_QUESTION')).state).toBe('PRESENT');
  });

  it('names a remedy for every capability it has a word for', () => {
    for (const capability of CAPABILITIES) {
      expect(capability.does.length).toBeGreaterThan(10);
      expect(capability.requires.length).toBeGreaterThan(10);
      expect(capability.nextStep.length).toBeGreaterThan(10);
    }
  });
});

describe('a missing capability becomes a need with somewhere to go', () => {
  it('raises one need per missing capability, and only one', async () => {
    const id = await readyPiece(['TAKE_A_PAYMENT', 'ISSUE_AN_INVOICE']);

    const first = await reconcileCapabilityNeeds(projectId);
    expect(first.raised).toHaveLength(2);

    // A loop that derives a need every tick must add one entry to the review,
    // not one per tick.
    const second = await reconcileCapabilityNeeds(projectId);
    expect(second.raised).toEqual([]);
    expect(await listNeeds({ projectId, states: ['OPEN'] })).toHaveLength(2);

    const needs = await listNeeds({ projectId, states: ['OPEN'] });
    for (const need of needs) {
      expect(need.opportunityId).toBe(id);
      expect(need.completionCondition).toBeTruthy();
      expect(need.blocksState).toBe('EXECUTING');
      expect(need.recommendedPath).toBeTruthy();
      expect(need.nextStep).toBeTruthy();
    }
  });

  it('settles one by itself when the capability arrives', async () => {
    await readyPiece(['RESEARCH_A_QUESTION']);
    expect((await reconcileCapabilityNeeds(projectId)).raised).toHaveLength(1);

    await healthyFleet();
    const settled = await reconcileCapabilityNeeds(projectId);
    expect(settled.settled).toHaveLength(1);

    const need = (await listNeeds({ projectId, states: ['RESOLVED'] }))[0]!;
    expect(need.resolution).toContain('PRESENT');
    // Brain checked. A resolution that said so without reading would be the
    // label this whole module exists to refuse.
    expect(need.resolvedByUserId).toBe('BRAIN');
  });

  it('withdraws one nothing requires any more', async () => {
    const id = await readyPiece(['TAKE_A_PAYMENT']);
    expect((await reconcileCapabilityNeeds(projectId)).raised).toHaveLength(1);

    await updateOpportunity(id, { required_capabilities: JSON.stringify([]) });
    const after = await reconcileCapabilityNeeds(projectId);
    expect(after.settled).toHaveLength(1);

    const need = (await listNeeds({ projectId, states: ['WITHDRAWN'] }))[0]!;
    // Withdrawn rather than resolved: nothing was set up.
    expect(need.resolution).toContain('Nothing was set up');
  });

  it('never stops the piece it is about', async () => {
    // An open need is a valid execution state. Nothing reads this table to
    // decide whether an opportunity may proceed, and this is the assertion.
    await granted();
    const id = await readyPiece(['TAKE_A_PAYMENT']);
    expect((await reconcileCapabilityNeeds(projectId)).raised).toHaveLength(1);

    const moved = await beginExecution({
      opportunityId: id,
      actorRef: userId,
      firstAction: {
        action: 'CONTACT_BUYER',
        performedBy: 'PERSON',
        detail: 'Emailed the owner, who replied.',
        requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
      },
    });
    expect(moved.ok).toBe(true);
    expect((await getOpportunity(id))!.state).toBe('EXECUTING');
  });
});

describe('answering a need resumes what was waiting, exactly once', () => {
  async function blockedPiece(): Promise<{ id: string; needId: string }> {
    await granted();
    const id = await readyPiece();
    const raised = await raiseNeed({
      projectId,
      opportunityId: id,
      actorRef: 'BRAIN',
      blockedAction: 'Reach the buyer',
      whyItMatters: 'Nobody has a way to contact them.',
      recommendedPath: 'Find a published address or number.',
      setupEffort: 'Minutes.',
      nextStep: 'Look at the listing and record the channel.',
      completionCondition: 'A reachable channel is recorded on the card.',
      blocksState: 'EXECUTING',
      requestKey: `question:${id}:contact`,
    });
    if (!raised.ok) throw new Error(raised.reason);
    return { id, needId: raised.value.id };
  }

  it('retries the blocked transition and never invents the evidence for it', async () => {
    const { id, needId } = await blockedPiece();

    // Answered, but nothing actually happened on the piece — so the resumption
    // correctly cannot advance it. A continuation that supplied its own action
    // to get the transition through would undo the whole `cash_actions` rule.
    expect(
      (await closeNeed({ needId, to: 'RESOLVED', resolution: 'Found it.', actorUserId: userId })).ok,
    ).toBe(true);

    const ran = await runNeedContinuations(projectId);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.resumed).toBe(false);
    expect(ran[0]!.note).toContain('Nothing has happened on this yet');
    expect((await getOpportunity(id))!.state).toBe('READY');
  });

  it('resumes for real once something has happened', async () => {
    const { id, needId } = await blockedPiece();
    await beginExecution({
      opportunityId: id,
      actorRef: userId,
      firstAction: {
        action: 'CONTACT_BUYER',
        performedBy: 'PERSON',
        detail: 'Emailed the owner.',
        requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
      },
    });
    // That already advanced it, so put it back to the waiting shape a real
    // resumption starts from: an action on the record, and the piece READY.
    const { transitionOpportunity } = await import('../server/repos/cashPortfolio.ts');
    await transitionOpportunity({ id, from: ['EXECUTING'], to: 'READY' });

    expect(
      (await closeNeed({ needId, to: 'RESOLVED', resolution: 'Found it.', actorUserId: userId })).ok,
    ).toBe(true);
    const ran = await runNeedContinuations(projectId);
    expect(ran[0]!.resumed).toBe(true);
    expect((await getOpportunity(id))!.state).toBe('EXECUTING');
  });

  it('does not spend the continuation on a refusal that is only temporary', async () => {
    /*
     * The claim used to be terminal and was written *before* the attempt, so a
     * refusal that was only ever going to be temporary — no commercial grant
     * yet, no free execution slot, the piece still short of READY — burned the
     * one chance the need had and nothing ever retried.
     *
     * The ordinary path made that the common case rather than the rare one: a
     * card answered by research leaves the piece at EVIDENCE_CARD, so a need
     * resolved then is resolved before READY exists at all.
     */
    const { id, needId } = await blockedPiece();
    expect(
      (await closeNeed({ needId, to: 'RESOLVED', resolution: 'Found it.', actorUserId: userId })).ok,
    ).toBe(true);

    const first = await runNeedContinuations(projectId);
    expect(first).toHaveLength(1);
    expect(first[0]!.resumed).toBe(false);
    expect(first[0]!.retry).toBe(true);
    expect(first[0]!.note).toContain('Nothing has happened on this yet');

    // Still waiting, not finished: the need is retried rather than spent.
    const waiting = (await getNeed(needId))!;
    expect(waiting.continuedAt).toBeNull();
    expect(waiting.continuationAttempts).toBe(1);
    expect(waiting.continuationNotBefore).toBeTruthy();

    // And once the condition it was waiting on stops holding, it resumes.
    await beginExecution({
      opportunityId: id,
      actorRef: userId,
      firstAction: {
        action: 'CONTACT_BUYER',
        performedBy: 'PERSON',
        detail: 'Emailed the owner.',
        requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
      },
    });
    const { transitionOpportunity } = await import('../server/repos/cashPortfolio.ts');
    await transitionOpportunity({ id, from: ['EXECUTING'], to: 'READY' });

    const later = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const second = await runNeedContinuations(projectId, later);
    expect(second[0]!.resumed).toBe(true);
    expect((await getNeed(needId))!.continuedAt).toBeTruthy();
  });

  it('recovers a continuation whose tick died holding the claim', async () => {
    /*
     * Step 5's rule at a new table: an expired lease is claimable work, so
     * recovery never depends on one process staying alive. A flag set by a tick
     * that then dies is a need nothing will ever look at again.
     */
    const { needId } = await blockedPiece();
    await closeNeed({ needId, to: 'RESOLVED', resolution: 'Found it.', actorUserId: userId });

    // A tick claims it and never comes back.
    expect(await claimNeedContinuation(needId)).toBe(true);
    expect((await getNeed(needId))!.continuationClaimedAt).toBeTruthy();

    // Another tick, immediately: the claim is live, so it is left alone.
    expect(await runNeedContinuations(projectId)).toEqual([]);

    // And once the lease goes stale, it is reclaimed.
    const after = new Date(Date.now() + CONTINUATION_LEASE_MS + 60_000).toISOString();
    const retaken = await runNeedContinuations(projectId, after);
    expect(retaken).toHaveLength(1);
  });

  it('runs once however many ticks read the same settled need', async () => {
    const { needId } = await blockedPiece();
    await closeNeed({
      needId,
      to: 'WITHDRAWN',
      resolution: 'Never mind.',
      actorUserId: userId,
    });

    expect(await runNeedContinuations(projectId)).toHaveLength(1);
    expect(await runNeedContinuations(projectId)).toEqual([]);
    expect(await runNeedContinuations(projectId)).toEqual([]);

    const need = (await getNeed(needId))!;
    expect(need.continuedAt).not.toBeNull();
    // What it did, not merely that it ran. The distinction is the point.
    expect(need.continuationNote).toBeTruthy();
  });

  it('says plainly that a withdrawn need had nothing waiting', async () => {
    const { needId } = await blockedPiece();
    await closeNeed({
      needId,
      to: 'WITHDRAWN',
      resolution: 'Never mind.',
      actorUserId: userId,
    });
    const ran = await runNeedContinuations(projectId);
    expect(ran[0]!.resumed).toBe(false);
    expect(ran[0]!.note).toContain('nothing waiting');
  });

  it('leaves an open need alone', async () => {
    await blockedPiece();
    expect(await runNeedContinuations(projectId)).toEqual([]);
  });
});

describe('a fact Brain could look up is Brain’s work, not a person’s', () => {
  it('asks a record that is still only evidence the three questions that could move it', async () => {
    /*
     * A bare record is a *signal*: something was found and nothing says who
     * would pay us for it. The only questions worth spending on are the ones
     * that could stop it being one — a payer, a route to them, and dated
     * evidence they asked. `captureMechanism` is composed from exactly those.
     *
     * The rest of the card asks what a *decision* turns on, and there is no
     * decision to make about a published price list. The set of researchable
     * fields went from three to seven with this change, so on the production
     * sprint — thirty-one price lists, appraisals and listing pages — asking
     * all seven of each would have been two hundred needs about what to charge
     * for somebody else's product.
     */
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A bare opening',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error(captured.reason);

    const gaps = await reconcileDiscoverableGaps(projectId);
    expect(gaps.map((one) => one.field).sort()).toEqual(['access', 'buyingEvidence', 'payer']);
    expect(await listNeeds({ projectId, states: ['OPEN'] })).toHaveLength(3);
  });

  it('raises a question for each researchable blank once there is a capture thesis', async () => {
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'An opening somebody would pay for',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error(captured.reason);
    // A named payer and something to supply them is what makes it worth
    // spending more on. It is the only thing that separates the two cases.
    await recordCardFact({
      projectId,
      opportunityId: captured.value.id,
      field: CAPTURE_KEY,
      kind: 'RECOMMENDATION',
      value: 'Supply the repair to the owner who asked, and be paid for it.',
      basis: 'A payer and an offer on this card.',
      assumptions: 'That they are still buying.',
      uncertainty: 'Whether they would choose us.',
      decidedBy: 'BRAIN',
    });

    const gaps = await reconcileDiscoverableGaps(projectId);
    /*
     * Seven, not three. A price, a delivery path, who does the work and the
     * exposure are facts about the world that Brain looks up — §30 had already
     * said so and the boolean that decided it had not moved. The offer and the
     * acceptance condition stay off this list: Brain proposes those and a
     * person may overrule them, and neither is ever *asked* for.
     */
    expect(gaps.map((one) => one.field).sort()).toEqual([
      'access',
      'buyingEvidence',
      'delivery',
      'exposure',
      'fulfillment',
      'payer',
      'price',
    ]);

    // And once, however many ticks read it.
    expect(await reconcileDiscoverableGaps(projectId)).toEqual([]);
    expect(await listNeeds({ projectId, states: ['OPEN'] })).toHaveLength(7);
  });

  it('settles one the moment the card carries the answer, whoever put it there', async () => {
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A bare opening',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error(captured.reason);
    await recordCardFact({
      projectId,
      opportunityId: captured.value.id,
      field: CAPTURE_KEY,
      kind: 'RECOMMENDATION',
      value: 'Supply the repair to the owner who asked, and be paid for it.',
      basis: 'A payer and an offer on this card.',
      assumptions: 'That they are still buying.',
      uncertainty: 'Whether they would choose us.',
      decidedBy: 'BRAIN',
    });
    // Seven, not three: a capture thesis is what makes the other four worth
    // spending on, and the three above were raised for the signal already.
    expect((await reconcileDiscoverableGaps(projectId)).length).toBe(7);

    await fillCard({
      opportunityId: captured.value.id,
      actorRef: userId,
      patch: { payer: 'The owner, who signs' },
    });
    await reconcileDiscoverableGaps(projectId);

    const resolved = await listNeeds({ projectId, states: ['RESOLVED'] });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.requestKey).toContain(':payer');
    expect(await listNeeds({ projectId, states: ['OPEN'] })).toHaveLength(6);
  });

  it('asks nothing about a piece already past the card', async () => {
    // A READY piece has every load-bearing field answered by construction, and
    // an EXECUTING one is past the question entirely.
    await readyPiece();
    expect(await reconcileDiscoverableGaps(projectId)).toEqual([]);
  });
});

describe('a need that is a question becomes work', () => {
  it('captures an idea for it and never launches one', async () => {
    await granted();
    const id = await readyPiece();
    const raised = await raiseNeed({
      projectId,
      opportunityId: id,
      actorRef: 'BRAIN',
      blockedAction: 'Establish who can approve payment here',
      whyItMatters: 'The card has no payer and the source does not name one.',
      recommendedPath: 'Read the publishing organisation’s own pages.',
      setupEffort: 'One bounded look.',
      nextStep: 'Name the role that signs.',
      completionCondition: 'A payer is recorded on the card.',
      blocksState: 'EXECUTING',
      requestKey: `question:${id}:payer`,
    });
    if (!raised.ok) throw new Error(raised.reason);

    const started = await startDependentWork(projectId);
    expect(started).toHaveLength(1);
    expect(started[0]!.needId).toBe(raised.value.id);

    const { getCandidate } = await import('../server/repos/russellCandidates.ts');
    const candidate = (await getCandidate(started[0]!.candidateId))!;
    // Captured, so the archive is asked first and the standing authority
    // decides whether anything may be spent. Neither is this function's call.
    expect(candidate.state).toBe('CAPTURED');
    expect((await getNeed(raised.value.id))!.candidateId).toBe(candidate.id);

    // And once, however many ticks read it.
    expect(await startDependentWork(projectId)).toEqual([]);
  });

  it('starts nothing for a need that is an integration rather than a question', async () => {
    await readyPiece(['TAKE_A_PAYMENT']);
    await reconcileCapabilityNeeds(projectId);
    // Setting up a payment processor is not answered by research, and a
    // captured idea about it would be a question nobody can research.
    expect(await startDependentWork(projectId)).toEqual([]);
  });
});

describe('what the research established reaches the card', () => {
  /** A finished mission for one need's question, carrying accepted claims. */
  async function researchAnswers(input: {
    needId: string;
    claims: { claim: string; sourceUrl: string | null; observedOn?: string | null }[];
    state?: 'DONE' | 'FAILED';
  }): Promise<void> {
    const need = (await getNeed(input.needId))!;
    const run = await createRun({
      projectId,
      layerId: layer.id,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: need.blockedAction,
    });
    const orchestration = await createOrchestration({
      projectId,
      layerId: layer.id,
      runId: run.id,
      title: need.blockedAction,
      assignment: need.nextStep,
      provider: 'WORKER',
      autoApprove: false,
    });
    await createFragments([
      {
        orchestrationId: orchestration.id,
        projectId,
        layerId: layer.id,
        geography: 'the market this piece is in',
        requiredEvidence: [
          { id: 'demand_signal', description: 'a published source', necessity: 'REQUIRED' },
        ],
        acceptableSourceTypes: ['an organisation’s own published pages'],
        excludedSourceTypes: ['a forecast presented as a current fact'],
        completionCriteria: ['a located passage'],
        minIndependentSources: 1,
        maxRepairs: 2,
        fragmentIndex: 0,
        fragmentKey: 'card-question',
        question: need.nextStep,
        dependsOn: [],
        attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    const [fragment] = await currentFragments(orchestration.id);
    await updateFragment(fragment!.id, {
      status: 'ACCEPTED',
      completedAt: new Date().toISOString(),
      blockedReason: null,
    });
    const inserted = await insertClaims(
      input.claims.map((one) => ({
        orchestrationId: orchestration.id,
        fragmentId: fragment!.id,
        passId: null,
        passKey: 'BROAD_SCAN' as const,
        claim: one.claim,
        sourceUrl: one.sourceUrl,
        sourceTitle: 'A page',
        sourcePublisher: 'The organisation',
        sourceDate: one.observedOn === undefined ? '2026-09-11' : one.observedOn,
        evidenceExcerpt: one.claim,
        evidenceLocator: 'the page body',
        evidenceLane: 'demand_signal',
        retrievedAt: '2026-09-12',
        confidence: 0.9,
        validationState: 'SOURCED' as const,
        validationDetail: null,
        sourced: one.sourceUrl !== null,
        claimType: 'SOURCED_FACT' as const,
        contentHash: `${one.claim}|${one.sourceUrl ?? ''}`,
      })),
    );
    for (const claim of inserted) await decideClaim(claim.id, { accepted: true });

    const { mission } = await launchMission({
      projectId,
      layerId: layer.id,
      visibility: 'SHARED',
      objective: need.blockedAction,
      whyNow: 'a card is blank',
      idempotencyKey: `mission:${orchestration.id}`,
      candidateId: need.candidateId,
    });
    await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
    await transitionMission({
      missionId: mission.id,
      from: 'RUNNING',
      to: input.state ?? 'DONE',
      ...(input.state === 'FAILED' ? { terminalReason: 'Nothing published settles it.' } : {}),
    });
  }

  async function bareOpportunity(): Promise<string> {
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A bare opening',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error(captured.reason);
    await updateOpportunity(captured.value.id, {
      buying_signal: 'A county published a request for eight parcel searches.',
      signal_observed_at: '2026-09-10',
    });
    /*
     * A capture thesis, because `reconcileDiscoverableGaps` is gated on one.
     *
     * A record with nothing saying who would pay us is a signal, and Brain
     * does not raise research needs against signals — it qualifies them with
     * the bounded deep dive instead. These suites are about what happens to a
     * *need* once one exists, so the fixture gets past that gate rather than
     * around it.
     */
    await recordCardFact({
      projectId,
      opportunityId: captured.value.id,
      field: CAPTURE_KEY,
      kind: 'RECOMMENDATION',
      value: 'Supply the parcel searches to the county that asked, and be paid for them.',
      basis: 'The published request names its own buyer.',
      assumptions: 'That the request is still open.',
      uncertainty: 'Whether they would choose us.',
      decidedBy: 'BRAIN',
    });
    return captured.value.id;
  }

  it('puts a gated claim on the card, with the claim beside it', async () => {
    /*
     * `startDependentWork` wrote the candidate id onto the need and the only
     * reader of that column hid the need from the review — for ever, and
     * whether the research had completed, failed or never started. So the loop
     * looked like it worked while the card stayed blank.
     */
    const id = await bareOpportunity();
    await reconcileDiscoverableGaps(projectId);
    await startDependentWork(projectId);

    const payerNeed = (await listNeeds({ projectId, states: ['OPEN'] })).find((one) =>
      one.requestKey?.endsWith(':payer'),
    )!;
    expect(payerNeed.candidateId).toBeTruthy();

    await researchAnswers({
      needId: payerNeed.id,
      claims: [
        {
          claim: 'The drainage authority’s procurement officer approves purchases under $25,000.',
          sourceUrl: 'https://example.test/authority/procurement',
        },
      ],
    });

    const applied = await applyResearchAnswers(projectId);
    expect(applied.applied).toHaveLength(1);
    expect(applied.applied[0]!.field).toBe('payer');

    // On the card, and resolvable to the passage it came from.
    const opportunity = (await getOpportunity(id))!;
    expect(opportunity.payer).toContain('procurement officer');
    const fact = (await cardFact(id, 'payer'))!;
    expect(fact.kind).toBe('EVIDENCE');
    expect(fact.claimId).toBe(applied.applied[0]!.claimId);

    // And the need it answered is closed because the condition holds, not
    // because somebody wrote a sentence.
    const settled = (await getNeed(payerNeed.id))!;
    expect(settled.state).toBe('RESOLVED');
    expect(settled.verifiedBy).toBe('BRAIN_READ_THE_ROW');
  });

  it('leaves the field unknown when nothing found supports one', async () => {
    const id = await bareOpportunity();
    await reconcileDiscoverableGaps(projectId);
    await startDependentWork(projectId);
    const need = (await listNeeds({ projectId, states: ['OPEN'] })).find((one) =>
      one.requestKey?.endsWith(':payer'),
    )!;

    await researchAnswers({ needId: need.id, claims: [] });
    const applied = await applyResearchAnswers(projectId);
    expect(applied.applied).toEqual([]);
    expect(applied.unanswered.find((one) => one.needId === need.id)?.state).toBe('NO_SUPPORT');

    // The honest outcome rather than a blank filled in to close a need.
    expect((await getOpportunity(id))!.payer).toBeNull();
    expect((await getNeed(need.id))!.state).toBe('OPEN');
  });

  it('says so when the research that would have answered it failed', async () => {
    await bareOpportunity();
    await reconcileDiscoverableGaps(projectId);
    await startDependentWork(projectId);
    const need = (await listNeeds({ projectId, states: ['OPEN'] })).find((one) =>
      one.requestKey?.endsWith(':payer'),
    )!;

    await researchAnswers({
      needId: need.id,
      state: 'FAILED',
      claims: [{ claim: 'unused', sourceUrl: 'https://example.test/x' }],
    });
    const applied = await applyResearchAnswers(projectId);
    const blocked = applied.unanswered.find((one) => one.needId === need.id)!;
    expect(blocked.state).toBe('FAILED');
    expect(blocked.detail).toContain('Nothing published settles it');
  });
});

describe('Brain forms a commercial view, and never calls it a fact', () => {
  it('proposes terms from the evidence, with assumptions and uncertainty', async () => {
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A published request',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error(captured.reason);
    await updateOpportunity(captured.value.id, {
      buying_signal: 'A county published a request for eight parcel searches by 30 September.',
      signal_observed_at: '2026-09-10',
    });

    const proposed = await proposeCommercialTerms(projectId);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.fields).toEqual(
      expect.arrayContaining(['offer', 'acceptance', 'delivery', 'fulfillment']),
    );

    const offer = (await cardFact(captured.value.id, 'offer'))!;
    // A recommendation, and never renderable as a reading: all three of basis,
    // assumptions and uncertainty are required to write one.
    expect(offer.kind).toBe('RECOMMENDATION');
    expect(offer.basis).toBeTruthy();
    expect(offer.assumptions).toBeTruthy();
    expect(offer.uncertainty).toBeTruthy();
    expect((await getOpportunity(captured.value.id))!.offerScope).toContain('parcel searches');
  });

  it('withholds a price rather than inventing one, and says why', async () => {
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A request with no figure in it',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error(captured.reason);
    await updateOpportunity(captured.value.id, {
      buying_signal: 'A county published a request for parcel searches.',
      signal_observed_at: '2026-09-10',
    });

    const proposed = await proposeCommercialTerms(projectId);
    expect(proposed[0]!.withheld).toContain('price');
    // Deriving one from nothing is exactly the invented judgment the old rule
    // worried about, and the worry was right about *that*.
    expect((await getOpportunity(captured.value.id))!.priceCents).toBeNull();
    expect(await cardFact(captured.value.id, 'price')).toBeNull();
  });

  it('never proposes over a person’s own answer', async () => {
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'A request somebody has already scoped',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
    });
    if (!captured.ok) throw new Error(captured.reason);
    await updateOpportunity(captured.value.id, {
      buying_signal: 'A county published a request for parcel searches.',
      signal_observed_at: '2026-09-10',
    });
    await recordCardFact({
      projectId,
      opportunityId: captured.value.id,
      field: 'offer',
      kind: 'PERSON',
      value: 'One packet, our own scope, nothing else.',
      decidedBy: userId,
    });
    await updateOpportunity(captured.value.id, {
      offer_scope: 'One packet, our own scope, nothing else.',
    });

    await proposeCommercialTerms(projectId);
    const offer = (await cardFact(captured.value.id, 'offer'))!;
    expect(offer.kind).toBe('PERSON');
    expect((await getOpportunity(captured.value.id))!.offerScope).toBe(
      'One packet, our own scope, nothing else.',
    );
  });
});

describe('a need is answered because something is true', () => {
  it('refuses a resolution whose condition does not hold', async () => {
    await readyPiece(['TAKE_A_PAYMENT']);
    await reconcileCapabilityNeeds(projectId);
    const need = (await listNeeds({ projectId, states: ['OPEN'] }))[0]!;

    // A written explanation is not a working integration.
    const pretended = await closeNeed({
      needId: need.id,
      to: 'RESOLVED',
      resolution: 'Done.',
      actorUserId: userId,
    });
    expect(pretended.ok).toBe(false);
    if (pretended.ok) throw new Error('unreachable');
    expect(pretended.reason).toContain('still reads MISSING');
    expect((await getNeed(need.id))!.state).toBe('OPEN');
  });

  it('records an authorized manual substitute as exactly that', async () => {
    await readyPiece(['TAKE_A_PAYMENT']);
    await reconcileCapabilityNeeds(projectId);
    const need = (await listNeeds({ projectId, states: ['OPEN'] }))[0]!;

    const done = await closeNeed({
      needId: need.id,
      to: 'RESOLVED',
      resolution: 'The buyer paid us directly.',
      actorUserId: userId,
      substitute: 'Taking payment by bank transfer outside Brain for now.',
    });
    expect(done.ok).toBe(true);

    const settled = (await getNeed(need.id))!;
    // The integration is still missing, and that is a different fact from the
    // condition having been met. Brain says which.
    expect(settled.verifiedBy).toBe('PERSON_SUBSTITUTE');
    expect(settled.resolution).toContain('done another way');
    expect((await readCapability('TAKE_A_PAYMENT')).state).toBe('MISSING');
  });

  it('raises a fresh occurrence when the blockage comes back', async () => {
    /*
     * `needForKey` answered with the newest row whatever its state, so once a
     * capability need was resolved the key was spent: the capability going
     * missing again found the resolved row, was told it had already been
     * raised, and never reached the review.
     */
    await healthyFleet();
    const id = await readyPiece(['RESEARCH_A_QUESTION']);
    expect((await reconcileCapabilityNeeds(projectId)).raised).toEqual([]);

    // It goes missing.
    const { listRoutines, setRoutineState } = await import('../server/repos/fleet.ts');
    for (const routine of await listRoutines()) {
      await setRoutineState({
        routineId: routine.id,
        from: routine.state,
        to: 'QUARANTINED',
        reason: 'gone',
      });
    }
    const first = await reconcileCapabilityNeeds(projectId);
    expect(first.raised).toHaveLength(1);
    const firstNeed = (await getNeed(first.raised[0]!))!;
    expect(firstNeed.occurrence).toBe(1);

    // It comes back, and the need settles itself.
    for (const routine of await listRoutines()) {
      await setRoutineState({
        routineId: routine.id,
        from: routine.state,
        to: 'ENABLED',
        reason: 'back',
      });
    }
    expect((await reconcileCapabilityNeeds(projectId)).settled).toContain(firstNeed.id);

    // And it goes missing a second time. This used to be invisible.
    for (const routine of await listRoutines()) {
      await setRoutineState({
        routineId: routine.id,
        from: routine.state,
        to: 'QUARANTINED',
        reason: 'gone again',
      });
    }
    const second = await reconcileCapabilityNeeds(projectId);
    expect(second.raised).toHaveLength(1);
    expect(second.raised[0]).not.toBe(firstNeed.id);
    expect((await getNeed(second.raised[0]!))!.occurrence).toBe(2);
    expect(id).toBeTruthy();
  });
});

describe('the operating pass as the tick calls it', () => {
  it('does nothing at all for a project with no sprint', async () => {
    const fixture = await freshProject();
    expect(await operate(fixture.project.id)).toEqual({
      // Null rather than absent: a project with no sprint has no portfolio to
      // read, so there is nothing to say about how it is classified.
      reclassified: null,
      capabilities: { raised: [], settled: [] },
      gaps: [],
      research: { applied: [], unanswered: [] },
      proposed: [],
      continuations: [],
      dependentWork: [],
      validations: { started: [], settled: [] },
      authority: { took: [], withheld: [] },
      /*
       * The possibility ledger reports nothing too, and that is the assertion
       * rather than an addition to it: `enumeratePossibilities` and
       * `recordMovements` both run on every pass, and a project with no sprint
       * must come out of them having written no path, no snapshot and no
       * evaluation timestamp.
       */
      monetization: {
        pathsAdded: [],
        figuresCarried: [],
        evidenced: [],
        moved: 0,
        evaluated: 0,
        // A project with no sprint asks nothing and settles nothing. Reported
        // as an empty pass rather than omitted, because the shape of what
        // `operate` returns is the contract every reader is written against.
        commissions: { opened: [], recorded: [], settled: [], declined: [], openNow: 0 },
      },
      // And the commercial journey concludes nothing and prepares nothing.
      commerce: { concluded: 0, prepared: null, notPrepared: 'No sprint.' },
    });
  });
});
