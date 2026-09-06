/**
 * A failed turn had no way back, and now it has one.
 *
 * `resolveMessage` is a compare-and-swap on `PENDING`. That is exactly what
 * makes a turn answer once, and it also meant a turn that ended `FAILED` could
 * never be re-settled — so when Brain refused its own worker's proposal over a
 * rule the worker had never been told, the only remedy the product had was the
 * sentence it shows the person: *ask me again*. Retyping a question that was
 * never defective is the product admitting it lost the turn.
 *
 * §24 says every escalation needs an answering transition. These tests pin that
 * transition, and — just as importantly — pin what it must never do: touch the
 * failed attempt, invent a user message, or write an answer nobody produced.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  addMessage,
  createConversation,
  getMessage,
  listTurns,
  resolveMessage,
} from '../server/repos/russellConversations.ts';
import {
  beginTurn,
  MAX_TURN_ATTEMPTS,
  retryTurn,
  TURN_UNIT_KEY,
} from '../server/services/russell/turn.ts';
import { getBin } from '../server/repos/bins.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let otherUserId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `retry-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Test person',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const other = await createUser({
    email: `other-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Somebody else',
    password: 'correct horse battery staple',
  });
  otherUserId = other.id;
});

function membership(forUser: string): ProjectMembership {
  return {
    id: `mem_${forUser}`,
    projectId,
    principalType: 'HUMAN',
    principalId: forUser,
    role: 'MEMBER',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
    grantedAt: '2026-01-01T00:00:00.000Z',
    active: true,
  } as ProjectMembership;
}

function principal(forUser = userId): Principal {
  return {
    type: 'HUMAN',
    id: forUser,
    handle: 'test@example.test',
    displayName: 'Test person',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships: [membership(forUser)],
    requestId: 'req_test',
  } as Principal;
}

/**
 * One turn asked and then failed the way the real one did — a proposal the
 * validator refused, stored as a refusal rather than thrown away.
 */
async function aFailedTurn(question = 'What is the state of the monetization work?'): Promise<{
  conversationId: string;
  failedId: string;
  binId: string;
  userMessageId: string;
}> {
  const conversation = await createConversation({
    ownerUserId: userId,
    title: 'A thread',
    projectId,
    visibility: 'PRIVATE',
  });
  const started = await beginTurn({
    principal: principal(),
    conversationId: conversation.id,
    content: question,
  });
  expect(started.ok).toBe(true);
  const failedId = started.pendingMessage!.id;
  await resolveMessage({
    messageId: failedId,
    content:
      'I could not answer that one — the reply I got back was not something I am allowed to act on.',
    status: 'FAILED',
    pendingReason: 'the proposed action was missing the part it acts on',
  });
  return {
    conversationId: conversation.id,
    failedId,
    binId: started.binId!,
    userMessageId: started.userMessage!.id,
  };
}

describe('a failed turn can be handed back to the fleet', () => {
  it('creates a new pending turn and a new bin, and dispatches nothing else', async () => {
    const { conversationId, failedId } = await aFailedTurn();

    const again = await retryTurn({ principal: principal(), messageId: failedId });
    expect(again.ok).toBe(true);
    expect(again.attempt).toBe(2);
    expect(again.binId).not.toBeNull();

    const pending = (await getMessage(again.pendingMessage!.id))!;
    expect(pending.role).toBe('RUSSELL');
    expect(pending.status).toBe('PENDING');
    // Nothing is written for it. The retry waits for a worker exactly like the
    // first attempt did; it never fabricates the answer that was missing.
    expect(pending.content).toBe('');

    const bin = (await getBin(again.binId!))!;
    expect(bin.state).toBe('READY');
    expect(bin.workloadClass).toBe('RUSSELL_TURN');
    // The link `applyTurn` walks back along, so the retry rejoins the ordinary
    // pipeline rather than needing one of its own.
    expect(bin.createdById).toBe(`russell:turn:${pending.id}`);
    expect(bin.manifest.units[0]!.key).toBe(TURN_UNIT_KEY);

    // Exactly one new turn. No second copy of the person's own words.
    const turns = await listTurns(conversationId, 50);
    expect(turns.filter((turn) => turn.role === 'USER')).toHaveLength(1);
    expect(turns.filter((turn) => turn.role === 'RUSSELL')).toHaveLength(2);
  });

  it('leaves the failed attempt and its bin exactly as they were', async () => {
    const { failedId, binId } = await aFailedTurn();
    const before = (await getMessage(failedId))!;
    const binBefore = (await getBin(binId))!;

    await retryTurn({ principal: principal(), messageId: failedId });

    const after = (await getMessage(failedId))!;
    expect(after.status).toBe('FAILED');
    expect(after.pendingReason).toBe('the proposed action was missing the part it acts on');
    expect(after.content).toBe(before.content);
    expect(after.updatedAt).toBe(before.updatedAt);
    // The evidence of why it failed is the point. A retry that tidied the bin
    // away would destroy the only record of the refusal.
    const binAfter = (await getBin(binId))!;
    expect(binAfter.state).toBe(binBefore.state);
    expect(binAfter.leaseGeneration).toBe(binBefore.leaseGeneration);
  });

  it('answers the question the person actually asked, not a new one', async () => {
    const { failedId } = await aFailedTurn('Where did the fee negotiation land?');
    const again = await retryTurn({ principal: principal(), messageId: failedId });
    const bin = (await getBin(again.binId!))!;
    expect(bin.manifest.lineage.goal).toBe('Where did the fee negotiation land?');
    // And it is linked to that question on the row, so the thread reads back as
    // one question with several attempts.
    const pending = (await getMessage(again.pendingMessage!.id))!;
    expect(pending.metadata?.['retryOf']).toBe(failedId);
    expect(pending.metadata?.['attempt']).toBe(2);
  });

  it('does not show the worker the refusal sentence as though it were an answer', async () => {
    const { failedId } = await aFailedTurn();
    const again = await retryTurn({ principal: principal(), messageId: failedId });
    const bin = (await getBin(again.binId!))!;
    const transcript = String(bin.manifest.units[0]!.input);
    expect(transcript).not.toMatch(/not something I am allowed to act on/);
  });
});

describe('what a retry refuses', () => {
  it('refuses somebody who does not own the thread, in the words of a miss', async () => {
    const { failedId } = await aFailedTurn();
    const again = await retryTurn({ principal: principal(otherUserId), messageId: failedId });
    expect(again.ok).toBe(false);
    // Absent and forbidden are one answer. A reader of a shared thread learns
    // nothing about whether that turn is there.
    expect(again.reason).toBe('no such turn');
    expect(again.binId).toBeNull();

    const missing = await retryTurn({ principal: principal(), messageId: 'rmsg_nope' });
    expect(missing.reason).toBe('no such turn');
  });

  it('refuses a turn that was answered, and one still running', async () => {
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'A thread',
      projectId,
      visibility: 'PRIVATE',
    });
    const started = await beginTurn({
      principal: principal(),
      conversationId: conversation.id,
      content: 'Something answerable',
    });

    const stillGoing = await retryTurn({
      principal: principal(),
      messageId: started.pendingMessage!.id,
    });
    expect(stillGoing.ok).toBe(false);
    expect(stillGoing.reason).toMatch(/has not finished/);

    await resolveMessage({ messageId: started.pendingMessage!.id, content: 'Here you go.' });
    const done = await retryTurn({
      principal: principal(),
      messageId: started.pendingMessage!.id,
    });
    expect(done.ok).toBe(false);
    expect(done.reason).toMatch(/was answered/);
  });

  it("refuses a person's own message — a retry is of Russell's turn", async () => {
    const { userMessageId } = await aFailedTurn();
    const again = await retryTurn({ principal: principal(), messageId: userMessageId });
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/not one of my turns/);
  });

  it('refuses while another attempt is already in flight', async () => {
    const { failedId } = await aFailedTurn();
    const first = await retryTurn({ principal: principal(), messageId: failedId });
    expect(first.ok).toBe(true);

    // Pressing twice must not pay twice.
    const second = await retryTurn({ principal: principal(), messageId: failedId });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already having another go/);
    expect(second.binId).toBeNull();
  });

  it('stops at the attempt ceiling rather than spending the fleet forever', async () => {
    const { conversationId, failedId } = await aFailedTurn();

    let latest = failedId;
    for (let attempt = 2; attempt <= MAX_TURN_ATTEMPTS; attempt += 1) {
      const again = await retryTurn({ principal: principal(), messageId: latest });
      expect(again.ok).toBe(true);
      expect(again.attempt).toBe(attempt);
      latest = again.pendingMessage!.id;
      await resolveMessage({
        messageId: latest,
        content: 'Still no.',
        status: 'FAILED',
        pendingReason: 'the proposed action was missing the part it acts on',
      });
    }

    const past = await retryTurn({ principal: principal(), messageId: latest });
    expect(past.ok).toBe(false);
    expect(past.reason).toMatch(/as many times as I am allowed/);

    // The ceiling counts the whole question, so retrying an *earlier* attempt
    // is not a way around it.
    const sideways = await retryTurn({ principal: principal(), messageId: failedId });
    expect(sideways.ok).toBe(false);

    // And every attempt is still on the record.
    const turns = await listTurns(conversationId, 50);
    expect(turns.filter((turn) => turn.role === 'RUSSELL' && turn.status === 'FAILED')).toHaveLength(
      MAX_TURN_ATTEMPTS,
    );
  });

  it('refuses a thread with no project, because there is nothing to ground an answer in', async () => {
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'Unfiled',
      projectId: null,
      visibility: 'PRIVATE',
    });
    const failed = await addMessage({
      conversationId: conversation.id,
      role: 'RUSSELL',
      content: 'I could not answer that one.',
      status: 'FAILED',
      pendingReason: 'the proposal was refused',
    });
    const again = await retryTurn({ principal: principal(), messageId: failed.id });
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/which project/);
  });

  it('refuses when it cannot find the question the turn was answering', async () => {
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'Orphan',
      projectId,
      visibility: 'PRIVATE',
    });
    // A Russell turn with nothing before it. Nothing to re-ask, and inventing
    // one would be fabricating the person's question.
    const failed = await addMessage({
      conversationId: conversation.id,
      role: 'RUSSELL',
      content: 'I could not answer that one.',
      status: 'FAILED',
      pendingReason: 'the proposal was refused',
    });
    const again = await retryTurn({ principal: principal(), messageId: failed.id });
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/cannot find what that turn was answering/);
    // Nothing was created on the way to refusing.
    const bins = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bins WHERE created_by_id = ?`,
      [`russell:turn:${failed.id}`],
    );
    expect(Number(bins[0]!.n)).toBe(0);
  });
});
