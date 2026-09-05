/**
 * A pending turn has to say what it is actually waiting for.
 *
 * The owner sent a message to Russell and watched it sit for half an hour under
 * the words "Russell is thinking — a worker is picking this up." That sentence
 * is stored on the row at creation, before anything has picked anything up, and
 * it never changes — so it read exactly the same whether a worker was mid-run,
 * whether no worker had been called at all, or whether the dispatch had run out
 * of attempts.
 *
 * These tests pin the difference. Each one drives the *database* into one real
 * condition and asserts the sentence a person would see, because the whole
 * point is that the sentence follows the rows rather than the other way round.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import { createConversation, listTurns } from '../server/repos/russellConversations.ts';
import { beginTurn, PENDING_REASON } from '../server/services/russell/turn.ts';
import { withPendingDetail } from '../server/services/russell/pending.ts';
import { getBin } from '../server/repos/bins.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `pending-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Test person',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

function membership(id: string): ProjectMembership {
  return {
    id: `mem_${id}`,
    projectId: id,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'MEMBER',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
    grantedAt: '2026-01-01T00:00:00.000Z',
    active: true,
  } as ProjectMembership;
}

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'test@example.test',
    displayName: 'Test person',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships: [membership(projectId)],
    requestId: 'req_test',
  } as Principal;
}

/** One turn, and the ids the tests need to drive it. */
async function aTurn(): Promise<{ messageId: string; binId: string; conversationId: string }> {
  const conversation = await createConversation({
    ownerUserId: userId,
    title: 'A thread',
    projectId,
    visibility: 'PRIVATE',
  });
  const started = await beginTurn({
    principal: principal(),
    conversationId: conversation.id,
    content: 'What is the state of the monetization work?',
  });
  expect(started.ok).toBe(true);
  expect(started.binId).not.toBeNull();
  return {
    messageId: started.pendingMessage!.id,
    binId: started.binId!,
    conversationId: conversation.id,
  };
}

/** What a person would read, through the same path the route uses. */
async function shown(conversationId: string): Promise<string> {
  const turns = await withPendingDetail(await listTurns(conversationId, 20));
  const pending = turns.find((turn) => turn.role === 'RUSSELL' && turn.status === 'PENDING')!;
  expect(pending).toBeTruthy();
  return pending.pendingDetail ?? pending.pendingReason ?? '';
}

describe('a pending turn explains its actual condition', () => {
  it('says it is waiting to be handed to a worker before any dispatch exists', async () => {
    const { conversationId } = await aTurn();
    expect(await shown(conversationId)).toMatch(/waiting to be handed to a worker/i);
  });

  it('distinguishes a worker called from a worker working', async () => {
    const { binId, conversationId } = await aTurn();
    const bin = (await getBin(binId))!;

    await getDb().run(
      `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, 'SENT', ?, ?, ?)`,
      ['disp_sent', binId, bin.leaseGeneration, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    );
    expect(await shown(conversationId)).toMatch(/has been called .* has not started/i);

    /*
     * The same bin, now genuinely leased. The lease columns go with it because
     * the schema's CHECK makes a lease exist *iff* the bin is LEASED — §19's
     * invariant, which refused the shortcut of setting the state alone.
     */
    const worker = await createWorker({
      name: 'pending-worker',
      displayName: 'pending-worker',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await getDb().run(
      `UPDATE bins
          SET state = 'LEASED', lease_id = ?, worker_id = ?, lease_expires_at = ?
        WHERE id = ?`,
      ['lease_pending_test', worker.id, '2099-01-01T00:00:00.000Z', binId],
    );
    expect(await shown(conversationId)).toMatch(/working on this now/i);
  });

  it('says so when the dispatch ran out of attempts', async () => {
    /*
     * The loudest case, and the one the static sentence hid completely. A bin
     * whose intent is ABANDONED has no worker coming, and telling a person
     * "a worker is picking this up" is not optimism, it is wrong.
     */
    const { binId, conversationId } = await aTurn();
    const bin = (await getBin(binId))!;
    await getDb().run(
      `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, 'ABANDONED', 5, ?, ?, ?)`,
      ['disp_dead', binId, bin.leaseGeneration, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    );
    const text = await shown(conversationId);
    expect(text).toMatch(/could not reach a worker/i);
    expect(text).not.toMatch(/picking this up/i);
  });

  it('says a decision is needed rather than pretending to wait', async () => {
    const { binId, conversationId } = await aTurn();
    await getDb().run(
      `UPDATE bins SET state = 'NEEDS_HUMAN', terminal_reason = ? WHERE id = ?`,
      ['the budget for this is not authorized', binId],
    );
    const text = await shown(conversationId);
    expect(text).toMatch(/needs a decision from you/i);
    expect(text).toMatch(/budget for this is not authorized/);
  });

  it('does not leave a turn with no bin looking patient', async () => {
    /*
     * A crash between `addMessage` and `createBin` leaves a pending row with
     * nothing behind it, and nothing will ever answer it. That is the one case
     * where the interface must tell a person to ask again.
     */
    const { binId, conversationId } = await aTurn();
    await getDb().run(`DELETE FROM bins WHERE id = ?`, [binId]);
    const text = await shown(conversationId);
    expect(text).toMatch(/did not reach a worker/i);
    expect(text).toMatch(/ask me again/i);
  });

  it('mentions how long it has been once the wait is real', async () => {
    const { messageId, conversationId } = await aTurn();
    await getDb().run(`UPDATE russell_messages SET created_at = ? WHERE id = ?`, [
      new Date(Date.now() - 31 * 60_000).toISOString(),
      messageId,
    ]);
    expect(await shown(conversationId)).toMatch(/waiting 3[01] minutes/);
  });

  it('does not mention a duration for an ordinary short wait', async () => {
    const { conversationId } = await aTurn();
    expect(await shown(conversationId)).not.toMatch(/waiting \d/);
  });

  it('leaves the stored reason alone', async () => {
    /*
     * The projection must not become a write. `pending_reason` is what was true
     * when the turn was created and is part of the row's history; overwriting it
     * with a live reading would destroy that and make the two indistinguishable.
     */
    const { conversationId } = await aTurn();
    await shown(conversationId);
    const turns = await listTurns(conversationId, 20);
    const pending = turns.find((turn) => turn.role === 'RUSSELL')!;
    expect(pending.pendingReason).toBe(PENDING_REASON);
    expect(pending.pendingDetail).toBeUndefined();
  });

  it('adds nothing to a turn that is already answered', async () => {
    const { messageId, conversationId } = await aTurn();
    await getDb().run(
      `UPDATE russell_messages SET status = 'COMPLETE', content = ? WHERE id = ?`,
      ['Here is the answer.', messageId],
    );
    const turns = await withPendingDetail(await listTurns(conversationId, 20));
    const answered = turns.find((turn) => turn.id === messageId)!;
    expect(answered.pendingDetail).toBeUndefined();
  });

  it('names no internal resource', async () => {
    /*
     * The conversation route deliberately withholds the bin id from a person.
     * An explanation that leaked it, or a Routine reference, or a session,
     * would be the same disclosure through a different field.
     */
    const { binId, conversationId } = await aTurn();
    const text = await shown(conversationId);
    expect(text).not.toContain(binId);
    expect(text).not.toMatch(/trig_|ses_|bin_|routine/i);
  });
});
