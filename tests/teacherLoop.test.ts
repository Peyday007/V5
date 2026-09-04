/**
 * The teacher loop.
 *
 * Two failures this is written against, both of which read as features until
 * you say them out loud.
 *
 * "Route the review to whichever account has spare capacity" hands somebody's
 * private conversation to a surface belonging to somebody else. Capacity is a
 * scheduling fact; who may read a thread is an authorization question; and the
 * moment they meet in one function the cheap answer wins.
 *
 * "The reviewer learned something, so Russell now behaves differently" makes a
 * model into policy. A reviewer proposes; a person decides; and there is no
 * argument anywhere that lets a caller skip the middle step.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { addMessage, createConversation, setVisibility } from '../server/repos/russellConversations.ts';
import {
  completeReview,
  decideRule,
  getRule,
  listPendingReviews,
  proposeRule,
  queueReview,
  reviewerMayCarry,
  standingInstructions,
} from '../server/services/conversation/review.ts';

let projectId = '';
let ownerId = '';
let otherId = '';
let conversationId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const owner = await createUser({
    email: 'owner@example.test',
    displayName: 'The owner',
    password: 'a-long-enough-password',
    isBrainAdmin: false,
  });
  ownerId = owner.id;
  const other = await createUser({
    email: 'other@example.test',
    displayName: 'Somebody else',
    password: 'a-long-enough-password',
    isBrainAdmin: false,
  });
  otherId = other.id;
  const conversation = await createConversation({
    ownerUserId: ownerId,
    title: 'A thread',
    projectId,
    visibility: 'PRIVATE',
  });
  conversationId = conversation.id;
});

async function say(content: string): Promise<string> {
  const message = await addMessage({
    conversationId,
    role: 'USER',
    content,
    authorUserId: ownerId,
  });
  return message.id;
}

describe('a review reads a manifest, never a conversation', () => {
  it('refuses a manifest naming a turn from somewhere else', async () => {
    await say('the first thing');
    const outcome = await queueReview({
      conversationId,
      messageIds: ['rms_not_from_here'],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/its own conversation/);
  });

  it('refuses an empty manifest rather than reviewing everything', async () => {
    await say('the first thing');
    const outcome = await queueReview({ conversationId, messageIds: [] });
    // The dangerous default: "no turns given" quietly meaning "all of them".
    expect(outcome.ok).toBe(false);
  });

  it('inherits the conversation’s visibility rather than choosing one', async () => {
    const first = await say('a private thing');
    const outcome = await queueReview({ conversationId, messageIds: [first] });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.review.visibility).toBe('PRIVATE');
  });
});

describe('who may carry a review is an authorization question', () => {
  it('keeps a private thread to a surface belonging to its owner', async () => {
    const first = await say('something personal');
    const outcome = await queueReview({ conversationId, messageIds: [first] });
    if (!outcome.ok) throw new Error('the fixture did not queue');

    expect(
      reviewerMayCarry(outcome.review, { forUserId: ownerId, forProjectIds: [] }).allowed,
    ).toBe(true);
    // A friend's account with spare capacity is still somebody else's account.
    expect(
      reviewerMayCarry(outcome.review, { forUserId: otherId, forProjectIds: [projectId] }).allowed,
    ).toBe(false);
    expect(
      reviewerMayCarry(outcome.review, { forUserId: null, forProjectIds: [projectId] }).allowed,
    ).toBe(false);
  });

  it('lets a shared thread go to a surface authorized for its project, and no further', async () => {
    await setVisibility(conversationId, 'SHARED');
    const first = await say('something the project may see');
    const outcome = await queueReview({ conversationId, messageIds: [first] });
    if (!outcome.ok) throw new Error('the fixture did not queue');

    expect(
      reviewerMayCarry(outcome.review, { forUserId: otherId, forProjectIds: [projectId] }).allowed,
    ).toBe(true);
    expect(
      reviewerMayCarry(outcome.review, { forUserId: otherId, forProjectIds: ['prj_other'] })
        .allowed,
    ).toBe(false);
  });
});

describe('reviews are debounced by version, not by a timer', () => {
  it('queues at most one review per conversation version', async () => {
    const first = await say('one');
    const a = await queueReview({ conversationId, messageIds: [first] });
    const b = await queueReview({ conversationId, messageIds: [first] });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.review.id).toBe(b.review.id);
      expect(b.created).toBe(false);
    }
    expect(await listPendingReviews()).toHaveLength(1);
  });

  it('queues a new one once the conversation has moved on', async () => {
    const first = await say('one');
    await queueReview({ conversationId, messageIds: [first] });
    const second = await say('two');
    const next = await queueReview({ conversationId, messageIds: [first, second] });
    expect(next.ok && next.created).toBe(true);
    expect(await listPendingReviews()).toHaveLength(2);
  });

  it('records only a classification from the closed set', async () => {
    const first = await say('one');
    const queued = await queueReview({ conversationId, messageIds: [first] });
    if (!queued.ok) throw new Error('the fixture did not queue');
    expect(
      await completeReview({
        reviewId: queued.review.id,
        classification: 'NEARLY_RIGHT' as never,
        findings: [],
      }),
    ).toBe(false);
    expect(
      await completeReview({
        reviewId: queued.review.id,
        classification: 'CORRECT',
        findings: ['the fee figure was out of date'],
      }),
    ).toBe(true);
  });
});

describe('a lesson is a proposal until a person decides', () => {
  it('cannot be created already accepted', async () => {
    const rule = await proposeRule({
      scope: 'PROJECT',
      scopeId: projectId,
      statement: 'Always say which state a licensing answer is about.',
      rationale: 'A reader assumed Michigan and it was Florida.',
      proposedBy: 'reviewer',
    });
    // There is no argument that could have made this ACCEPTED, which is the
    // point: a reviewer that could promote its own rule is a model writing
    // policy.
    expect(rule.state).toBe('PROPOSED');
  });

  it('is not fed to the model until somebody accepts it', async () => {
    const rule = await proposeRule({
      scope: 'PROJECT',
      scopeId: projectId,
      statement: 'Always name the state.',
      rationale: 'because',
      proposedBy: 'reviewer',
    });
    expect(await standingInstructions({ projectId })).toEqual([]);
    expect(await decideRule({ ruleId: rule.id, accept: true, decidedByUserId: ownerId })).toBe(
      true,
    );
    expect(await standingInstructions({ projectId })).toEqual(['Always name the state.']);
  });

  it('decides once however many times the answer arrives', async () => {
    const rule = await proposeRule({
      scope: 'GLOBAL',
      statement: 'Be brief.',
      rationale: 'because',
      proposedBy: 'reviewer',
    });
    expect(await decideRule({ ruleId: rule.id, accept: true, decidedByUserId: ownerId })).toBe(
      true,
    );
    // A second answer, perhaps the opposite one, does not overwrite the first.
    expect(await decideRule({ ruleId: rule.id, accept: false, decidedByUserId: otherId })).toBe(
      false,
    );
    expect((await getRule(rule.id))!.state).toBe('ACCEPTED');
  });

  it('keeps a rejected rule rather than deleting the argument', async () => {
    const rule = await proposeRule({
      scope: 'GLOBAL',
      statement: 'Never mention sources.',
      rationale: 'a reviewer thought it was noise',
      proposedBy: 'reviewer',
    });
    await decideRule({
      ruleId: rule.id,
      accept: false,
      decidedByUserId: ownerId,
      note: 'citations are the point',
    });
    const after = (await getRule(rule.id))!;
    expect(after.state).toBe('REJECTED');
    expect(after.decisionNote).toBe('citations are the point');
    expect(await standingInstructions({})).toEqual([]);
  });

  it('does not let another project’s rule reach this one', async () => {
    const rule = await proposeRule({
      scope: 'PROJECT',
      scopeId: 'prj_somewhere_else',
      statement: 'A rule for elsewhere.',
      rationale: 'because',
      proposedBy: 'reviewer',
    });
    await decideRule({ ruleId: rule.id, accept: true, decidedByUserId: ownerId });
    expect(await standingInstructions({ projectId })).toEqual([]);
  });
});
