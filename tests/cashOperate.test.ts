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
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { actionsFor, countActions } from '../server/repos/cashActions.ts';
import { getNeed, getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createWorker } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
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
  reconcileCapabilityNeeds,
  reconcileDiscoverableGaps,
  runNeedContinuations,
  startDependentWork,
} from '../server/services/cash/operate.ts';
import { CAPABILITIES, readCapability } from '../server/services/cash/capabilities.ts';
import { updateOpportunity } from '../server/repos/cashPortfolio.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
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

  it('runs once however many ticks read the same answered need', async () => {
    const { needId } = await blockedPiece();
    await closeNeed({ needId, to: 'RESOLVED', resolution: 'Found it.', actorUserId: userId });

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
  it('raises a question for each discoverable blank and none for a decision', async () => {
    // Nothing filled in: every load-bearing field is blank.
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
    // Payer, access and buying evidence are facts about the world. The offer,
    // the acceptance condition, the price, the delivery path, who does the
    // work and the exposure are the owner's own calls, and a researched answer
    // to "what should we charge" is invented judgment wearing a citation.
    expect(gaps.map((one) => one.field).sort()).toEqual(['access', 'buyingEvidence', 'payer']);

    // And once, however many ticks read it.
    expect(await reconcileDiscoverableGaps(projectId)).toEqual([]);
    expect(await listNeeds({ projectId, states: ['OPEN'] })).toHaveLength(3);
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
    expect(await reconcileDiscoverableGaps(projectId)).toHaveLength(3);

    await fillCard({
      opportunityId: captured.value.id,
      actorRef: userId,
      patch: { payer: 'The owner, who signs' },
    });
    await reconcileDiscoverableGaps(projectId);

    const resolved = await listNeeds({ projectId, states: ['RESOLVED'] });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.requestKey).toContain(':payer');
    expect(await listNeeds({ projectId, states: ['OPEN'] })).toHaveLength(2);
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

describe('the operating pass as the tick calls it', () => {
  it('does nothing at all for a project with no sprint', async () => {
    const fixture = await freshProject();
    expect(await operate(fixture.project.id)).toEqual({
      capabilities: { raised: [], settled: [] },
      gaps: [],
      continuations: [],
      dependentWork: [],
    });
  });
});
