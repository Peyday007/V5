/**
 * The clarification conversation, driven end to end.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a test of the helpers
 * ---------------------------------------------------------------------------
 *
 * `softwareTarget` and `asksForExecution` were both correct in isolation and the
 * product was not. A review of the assembled path found two defects that no
 * helper test could see:
 *
 * 1. Brain asked *"which project?"*, the person answered **"V4"**, and the
 *    execution gate declined it as too short — correctly, because "V4" is not a
 *    change request. Nothing joined the answer to the question, so the only way
 *    forward was to retype the whole instruction. That is §24's
 *    *waiting-nobody-can-resolve* wearing a conversation.
 * 2. In a Brain-attached thread, *"Do not change Brain, but fix the broken form
 *    in V4"* passed the gate — correctly, the person did ask for a fix — and
 *    then resolved to **Brain**, because merely *mentioning* the attached
 *    project made it the target. A card would have been produced for the one
 *    project the person had ruled out in the same sentence.
 *
 * So this drives `beginTurn` → a worker answering the bin → `applyValidated`,
 * which is the path a person's message actually takes. The worker is scripted
 * and everything else is real.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { createConversation, listTurns } from '../server/repos/russellConversations.ts';
import { beginTurn, TURN_UNIT_KEY } from '../server/services/russell/turn.ts';
import { assignNextBin, putBinUnitResult, releaseBin } from '../server/repos/bins.ts';
import { requestCompletion } from '../server/services/bins/service.ts';
import { hashUnitValue } from '../server/services/bins/contracts.ts';
import { tick } from '../server/services/russell/loop.ts';
import { listSoftwareRequests } from '../server/repos/russellSoftware.ts';
import { softwareClarificationFor } from '../server/services/russell/software.ts';
import type { Principal, Project, ProjectMembership } from '../server/domain/types.ts';

let projectId = '';
let brain: Project;
let v4: Project;
let userId = '';
let conversationId = '';

beforeEach(async () => {
  await freshProject();
  /*
   * Two projects with the owner's own names, because the defect is about names
   * in a sentence: the seeded fixture is called "Deal Dispatch" and a thread
   * attached to it could never reproduce "do not change Brain".
   */
  brain = await createProject({ name: 'Brain', slug: `brain-${Date.now()}` });
  v4 = await createProject({ name: 'V4', slug: `v4-${Date.now()}` });
  projectId = brain.id;

  const user = await createUser({
    email: `owner-${Math.random().toString(36).slice(2)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
    isBrainAdmin: false,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
  userId = user.id;
  for (const project of [brain, v4]) {
    await grantMembership({
      projectId: project.id,
      principalType: 'HUMAN',
      principalId: userId,
      role: 'MEMBER',
      scopes: ['project:read'],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
  }

  const conversation = await createConversation({
    ownerUserId: userId,
    title: 'The site',
    projectId: brain.id,
    visibility: 'SHARED',
  });
  conversationId = conversation.id;
});

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships: [brain.id, v4.id].map(
      (id) =>
        ({
          id: `mem-${id}`,
          projectId: id,
          principalType: 'HUMAN',
          principalId: userId,
          role: 'MEMBER',
          scopes: ['project:read'],
          grantedByType: 'SYSTEM',
          grantedById: 'test',
          grantedAt: '2026-01-01T00:00:00.000Z',
          active: true,
        }) as ProjectMembership,
    ),
    requestId: 'req',
  } as Principal;
}

/** A worker taking one bin all the way: assigned, submitted, completed. */
async function workerAnswers(binId: string, payload: Record<string, unknown>): Promise<void> {
  const workerId = (
    await createWorker({
      name: `worker-${Math.random().toString(36).slice(2, 8)}`,
      createdByType: 'SYSTEM',
      createdById: 'test',
    })
  ).id;
  let assigned: Awaited<ReturnType<typeof assignNextBin>> = null;
  const setAside: NonNullable<Awaited<ReturnType<typeof assignNextBin>>>[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const offered = await assignNextBin({ workerId, projectIds: [brain.id, v4.id] });
    if (!offered) break;
    if (offered.bin.id === binId) {
      assigned = offered;
      break;
    }
    setAside.push(offered);
  }
  for (const other of setAside) {
    await releaseBin({
      binId: other.bin.id,
      leaseId: other.leaseId,
      leaseGeneration: other.leaseGeneration,
      workerId,
    });
  }
  if (!assigned) throw new Error(`bin ${binId} was never offered`);
  const value = JSON.stringify(payload);
  await putBinUnitResult({
    binId,
    unitKey: TURN_UNIT_KEY,
    value,
    contentHash: hashUnitValue(value),
    leaseId: assigned.leaseId,
    leaseGeneration: assigned.leaseGeneration,
    submittedBy: workerId,
  });
  await requestCompletion({
    workerId,
    proof: { binId, leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, workerId },
  });
}

/** The person says something and a worker answers the turn. */
async function personSays(content: string, proposal: Record<string, unknown>): Promise<void> {
  const started = await beginTurn({ principal: principal(), conversationId, content });
  expect(started.binId, content).toBeTruthy();
  await workerAnswers(started.binId!, proposal);
  // The tick is what applies an answered turn — the same pass production runs.
  await tick('conversation-path');
}

/** What a worker proposes when it reads a request for a software change. */
function softwareProposal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'REQUEST_SOFTWARE_CHANGE',
    answer: 'Understood — writing that down for you to authorize.',
    confidence: 0.9,
    software: {
      title: 'Contact form drops the message',
      objective: 'Fix the contact form so a submitted message is not dropped.',
      expectedOutcome: 'A submitted message arrives.',
    },
    ...over,
  };
}

/** What the newest turn recorded that it did. */
async function lastProduced(): Promise<Record<string, unknown>> {
  const turns = await listTurns(conversationId);
  const answered = turns.filter((turn) => Object.keys(turn.produced).length > 0);
  return answered.at(-1)?.produced ?? {};
}

/* ========================================================================== */

describe('the clarification conversation', () => {
  it('asks, accepts a two-word answer, and files exactly one request', async () => {
    /*
     * The whole defect, walked: a real request Brain will not place, the
     * question it displays, an ordinary short answer, one correctly scoped
     * proposal — and the instruction typed once.
     */
    await personSays(
      'Fix this problem on V4: the contact form drops the message.',
      softwareProposal(),
    );

    // Nothing filed, and the question is on the thread in the server's words.
    expect(await listSoftwareRequests({ projectId: brain.id })).toHaveLength(0);
    expect(await listSoftwareRequests({ projectId: v4.id })).toHaveLength(0);
    const asked = await softwareClarificationFor(conversationId);
    expect(asked?.kind).toBe('AMBIGUOUS_PROJECT');
    expect(asked?.question).toContain('V4');

    /*
     * Two characters. Below the gate's own floor, no verb, nothing to do — and
     * the right answer to the question on screen.
     */
    await personSays('V4', {
      action: 'ANSWER_ONLY',
      answer: 'Right — V4 it is.',
      confidence: 0.9,
    });

    const filed = await listSoftwareRequests({ projectId: v4.id });
    expect(filed).toHaveLength(1);
    expect(filed[0]?.state).toBe('PROPOSED');
    expect(filed[0]?.objective).toContain('contact form');
    // The instruction was typed once and it went to the project named once.
    expect(await listSoftwareRequests({ projectId: brain.id })).toHaveLength(0);
    // And the question stops being asked, because it has been answered.
    expect(await softwareClarificationFor(conversationId)).toBeNull();
  });

  it('accepts "the Brain one" just as readily', async () => {
    await personSays(
      'Fix this problem on V4: the contact form drops the message.',
      softwareProposal(),
    );
    await personSays('The Brain one, please.', {
      action: 'ANSWER_ONLY',
      answer: 'Understood.',
      confidence: 0.9,
    });
    expect(await listSoftwareRequests({ projectId: brain.id })).toHaveLength(1);
    expect(await listSoftwareRequests({ projectId: v4.id })).toHaveLength(0);
  });

  it('leaves the question standing when the answer names neither', async () => {
    await personSays(
      'Fix this problem on V4: the contact form drops the message.',
      softwareProposal(),
    );
    await personSays('Whichever you think, honestly.', {
      action: 'ANSWER_ONLY',
      answer: 'I would rather you chose.',
      confidence: 0.9,
    });
    expect(await listSoftwareRequests({ projectId: brain.id })).toHaveLength(0);
    expect(await listSoftwareRequests({ projectId: v4.id })).toHaveLength(0);
    // Still on screen, because nothing settled it.
    expect((await softwareClarificationFor(conversationId))?.kind).toBe('AMBIGUOUS_PROJECT');
  });

  it('does not file twice when the worker restates the request alongside the answer', async () => {
    /*
     * The reason the resume returns rather than falling through. A worker that
     * has read the thread will often re-propose the change in its own words,
     * and a reworded objective is a different submission key — so one answer
     * would produce two cards for one decision.
     */
    await personSays(
      'Fix this problem on V4: the contact form drops the message.',
      softwareProposal(),
    );
    await personSays(
      'V4',
      softwareProposal({
        answer: 'V4 it is.',
        software: {
          title: 'Contact form loses submissions',
          objective: 'Repair the V4 contact form so that submitted messages are delivered.',
          expectedOutcome: 'The message arrives.',
        },
      }),
    );
    const filed = await listSoftwareRequests({ projectId: v4.id });
    expect(filed).toHaveLength(1);
    // The ask Brain refused, not the worker's second wording of it.
    expect(filed[0]?.objective).toContain('contact form so a submitted message');
  });

  it('still asks when there is nothing to resume', async () => {
    /*
     * A short project name on its own, with no outstanding question, is not a
     * request and must not become one. The resume is an answer to something
     * Brain asked, never a way in of its own.
     */
    await personSays('V4', {
      action: 'ANSWER_ONLY',
      answer: 'What would you like changed?',
      confidence: 0.9,
    });
    expect(await listSoftwareRequests({ projectId: v4.id })).toHaveLength(0);
    expect(await softwareClarificationFor(conversationId)).toBeNull();
  });
});

/* ========================================================================== */

describe('a project the person ruled out is never the target', () => {
  it('does not file against the attached project it was told not to change', async () => {
    await personSays(
      'Do not change Brain, but fix the broken form in V4.',
      softwareProposal({
        software: {
          title: 'Broken form',
          objective: 'Fix the broken form so it submits.',
          expectedOutcome: 'The form submits.',
        },
      }),
    );

    /*
     * The defect in one assertion: before this, the request was filed against
     * Brain — the attached project, mentioned in the sentence, and the one thing
     * the person had explicitly excluded.
     */
    expect(await listSoftwareRequests({ projectId: brain.id })).toHaveLength(0);

    // And the destination the sentence named is where it went.
    const filed = await listSoftwareRequests({ projectId: v4.id });
    expect(filed).toHaveLength(1);
    expect(filed[0]?.state).toBe('PROPOSED');
  });

  it('asks when the exclusion leaves no destination', async () => {
    await personSays(
      'Do not change Brain, but please fix the broken form.',
      softwareProposal({
        software: {
          title: 'Broken form',
          objective: 'Fix the broken form so it submits.',
          expectedOutcome: 'The form submits.',
        },
      }),
    );
    expect(await listSoftwareRequests({ projectId: brain.id })).toHaveLength(0);
    expect(await listSoftwareRequests({ projectId: v4.id })).toHaveLength(0);
    const asked = await softwareClarificationFor(conversationId);
    expect(asked?.kind).toBe('EXCLUDED_PROJECT');
    expect(asked?.question).toContain('Brain');

    // And the same clarification finishes it, without repeating the request.
    await personSays('V4', { action: 'ANSWER_ONLY', answer: 'V4.', confidence: 0.9 });
    expect(await listSoftwareRequests({ projectId: v4.id })).toHaveLength(1);
    expect(await listSoftwareRequests({ projectId: brain.id })).toHaveLength(0);
  });

  it('still treats the attached project as the default when it is not ruled out', async () => {
    /*
     * The rule this correction must not break: a sentence can rule the row out
     * and can never replace it. With no exclusion, naming another project is a
     * disagreement Brain refuses rather than resolves.
     */
    await personSays('Fix the broken form in V4 please.', softwareProposal());
    expect(await listSoftwareRequests({ projectId: v4.id })).toHaveLength(0);
    expect((await softwareClarificationFor(conversationId))?.kind).toBe('AMBIGUOUS_PROJECT');
  });

  it('records what it did, so the thread can be read back', async () => {
    await personSays(
      'Do not change Brain, but fix the broken form in V4.',
      softwareProposal({
        software: {
          title: 'Broken form',
          objective: 'Fix the broken form so it submits.',
          expectedOutcome: 'The form submits.',
        },
      }),
    );
    const produced = await lastProduced();
    expect(produced['softwareRequestId']).toBeTruthy();
  });
});
