/**
 * The fast conversation lane, and the money.
 *
 * The lane is a convenience; the ceiling is a guarantee, and the two are tested
 * with very different levels of suspicion. A lane that routes a turn badly
 * costs somebody three minutes. A ceiling that can be exceeded costs money that
 * nobody authorised, silently, at whatever rate concurrency allows.
 *
 * So the properties here are mostly about refusal: nothing spends by default,
 * a missing price fails closed, concurrent callers cannot collectively exceed a
 * ceiling each of them individually respected, and an unknown outcome keeps its
 * hold rather than assuming the cheap answer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import {
  createAuthorization,
  ledgerFor,
  listModels,
  periodKeyFor,
  registerModel,
  release,
  remainingFor,
  reserve,
  reservationByKey,
  markUnknown,
  settle,
  worstCaseMicros,
  type LlmModel,
  type SpendAuthorization,
} from '../server/repos/spend.ts';
import {
  answerFast,
  chooseModel,
  fastLaneReadiness,
  liveAuthorization,
  noFastLane,
  reservationKey,
  usableModels,
} from '../server/services/conversation/fastLane.ts';
import { decideLane, FAST_LANE_MAY_NOT } from '../server/services/conversation/lanes.ts';
import { collect, scriptedAdapter, unavailableAdapter } from '../server/services/conversation/adapter.ts';
import { compileHat, estimateTokens } from '../server/services/conversation/contextHat.ts';
import { createConversation, addMessage } from '../server/repos/russellConversations.ts';

let projectId = '';
let ownerId = '';
let conversationId = '';
const AT = '2026-09-04T12:00:00.000Z';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const owner = await createUser({
    email: 'spender@example.test',
    displayName: 'The spender',
    password: 'a-long-enough-password',
    isBrainAdmin: false,
  });
  ownerId = owner.id;
  const conversation = await createConversation({
    ownerUserId: ownerId,
    title: 'A thread',
    projectId,
    visibility: 'PRIVATE',
  });
  conversationId = conversation.id;
});

/** One model, priced. Nothing in the product declares a default. */
async function model(over: Partial<Parameters<typeof registerModel>[0]> = {}): Promise<LlmModel> {
  return registerModel({
    provider: 'anthropic',
    modelId: 'a-model-id',
    label: 'A model',
    lane: 'FAST',
    // 1000 micro-dollars per million tokens, so the arithmetic is legible.
    inputMicrosPerMTok: 1000,
    outputMicrosPerMTok: 5000,
    pricingVersion: '2026-09',
    pricingAsOf: '2026-09-01',
    maxOutputTokens: 1000,
    contextTokens: 200_000,
    enabled: true,
    ...over,
  });
}

async function authorization(
  over: Partial<Parameters<typeof createAuthorization>[0]> = {},
): Promise<SpendAuthorization> {
  return createAuthorization({
    ownerUserId: ownerId,
    provider: 'anthropic',
    allowedModelIds: [],
    ceilingMicros: 1_000_000,
    period: 'MONTH',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    enabled: true,
    actorUserId: ownerId,
    reason: 'a person turned this on',
    ...over,
  });
}

describe('nothing spends by default', () => {
  it('refuses when there is no authorization at all', async () => {
    expect(await liveAuthorization(ownerId, 'anthropic', AT)).toBeNull();
  });

  it('refuses a disabled authorization, a zero ceiling, and one not yet in force', async () => {
    await authorization({ enabled: false });
    expect(await liveAuthorization(ownerId, 'anthropic', AT)).toBeNull();

    await getDb().run('DELETE FROM spend_authorizations');
    await authorization({ ceilingMicros: 0 });
    // A ceiling of zero is a permission to spend nothing, which is a refusal.
    expect(await liveAuthorization(ownerId, 'anthropic', AT)).toBeNull();

    await getDb().run('DELETE FROM spend_authorizations');
    await authorization({ effectiveFrom: '2027-01-01T00:00:00.000Z' });
    expect(await liveAuthorization(ownerId, 'anthropic', AT)).toBeNull();

    await getDb().run('DELETE FROM spend_authorizations');
    await authorization({ effectiveUntil: '2026-01-02T00:00:00.000Z' });
    expect(await liveAuthorization(ownerId, 'anthropic', AT)).toBeNull();
  });

  it('does not widen an authorization when a new model is enabled', async () => {
    const first = await model();
    const auth = await authorization({ allowedModelIds: [first.id] });
    const second = await model({ modelId: 'another-model', pricingVersion: '2026-09' });
    expect((await listModels({ enabledOnly: true })).length).toBe(2);
    // The list is explicit, so enabling something in the catalogue is not a
    // grant. The second model is enabled and still not usable here.
    const usable = await usableModels(auth);
    expect(usable.map((entry) => entry.id)).toEqual([first.id]);
    expect(usable.some((entry) => entry.id === second.id)).toBe(false);
  });

  it('treats a Brain with no credential as having no fast lane, not as an error', async () => {
    const readiness = await fastLaneReadiness({
      ownerUserId: ownerId,
      provider: 'anthropic',
      adapter: noFastLane(),
      at: AT,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.failure).toBe('NO_CREDENTIAL');
  });

  it('produces no text at all when there is no fast lane', async () => {
    // §24: a mock answer shaped like grounded Russell output must never reach
    // production, and a placeholder adapter that returns prose is the quickest
    // way to violate it.
    const events = unavailableAdapter('NO_CREDENTIAL').stream({
      modelId: 'x',
      system: '',
      messages: [],
      maxOutputTokens: 10,
    });
    const outcome = await collect(events);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.partial).toBe('');
  });
});

describe('a ceiling is a guarantee, not a check', () => {
  it('reserves the worst case rather than the expected case', async () => {
    const priced = await model();
    // 10,000 input at 1000/M = 10 micros; 1,000 output at 5000/M = 5 micros.
    expect(
      worstCaseMicros({ model: priced, maxInputTokens: 10_000, maxOutputTokens: 1_000 }),
    ).toBe(15);
  });

  it('refuses the reservation that would go past the ceiling', async () => {
    const priced = await model();
    const auth = await authorization({ allowedModelIds: [priced.id], ceilingMicros: 20 });
    const first = await reserve({
      authorization: auth,
      model: priced,
      ownerUserId: ownerId,
      maxInputTokens: 10_000,
      maxOutputTokens: 1_000,
      idempotencyKey: 'k1',
      at: AT,
    });
    expect(first.ok).toBe(true);
    const second = await reserve({
      authorization: auth,
      model: priced,
      ownerUserId: ownerId,
      maxInputTokens: 10_000,
      maxOutputTokens: 1_000,
      idempotencyKey: 'k2',
      at: AT,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/ceiling/);
  });

  it('cannot be exceeded by concurrent callers', async () => {
    const priced = await model();
    const auth = await authorization({ allowedModelIds: [priced.id], ceilingMicros: 45 });
    // Three fit; six ask at once.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        reserve({
          authorization: auth,
          model: priced,
          ownerUserId: ownerId,
          maxInputTokens: 10_000,
          maxOutputTokens: 1_000,
          idempotencyKey: `concurrent-${index}`,
          at: AT,
        }),
      ),
    );
    const won = results.filter((result) => result.ok);
    expect(won).toHaveLength(3);
    const budget = await remainingFor(auth, AT);
    expect(budget.heldMicros).toBe(45);
    expect(budget.remainingMicros).toBe(0);
  });

  it('makes over-commitment impossible in the database, not merely unlikely', async () => {
    const priced = await model();
    const auth = await authorization({ allowedModelIds: [priced.id], ceilingMicros: 10 });
    const ledger = await ledgerFor(auth, AT);
    // Straight past the application, at the row. The CHECK is the guarantee the
    // comments above the reservation code rely on.
    await expect(
      getDb().run('UPDATE spend_ledger SET held_micros = ? WHERE id = ?', [11, ledger.id]),
    ).rejects.toThrow();
  });

  it('reserves once for a retried attempt', async () => {
    const priced = await model();
    const auth = await authorization({ allowedModelIds: [priced.id] });
    const key = reservationKey({ conversationId, messageId: 'msg_1', lane: 'FAST' });
    const first = await reserve({
      authorization: auth,
      model: priced,
      ownerUserId: ownerId,
      maxInputTokens: 1_000,
      maxOutputTokens: 100,
      idempotencyKey: key,
      at: AT,
    });
    const again = await reserve({
      authorization: auth,
      model: priced,
      ownerUserId: ownerId,
      maxInputTokens: 1_000,
      maxOutputTokens: 100,
      idempotencyKey: key,
      at: AT,
    });
    expect(first.ok && again.ok).toBe(true);
    if (first.ok && again.ok) {
      expect(again.replayed).toBe(true);
      expect(again.reservation.id).toBe(first.reservation.id);
    }
    expect((await remainingFor(auth, AT)).heldMicros).toBe(
      first.ok ? first.reservation.reservedMicros : -1,
    );
  });

  it('does not change with the attempt, the clock or the lane it is retried on', () => {
    const a = reservationKey({ conversationId: 'c', messageId: 'm', lane: 'FAST' });
    const b = reservationKey({ conversationId: 'c', messageId: 'm', lane: 'FAST' });
    expect(a).toBe(b);
    // A different lane is a genuinely different operation with a different
    // cost, so it is a different key. Same lane, same turn, same key.
    expect(reservationKey({ conversationId: 'c', messageId: 'm', lane: 'DEEP' })).not.toBe(a);
  });

  it('settles from the provider’s own usage and releases the difference', async () => {
    const priced = await model();
    const auth = await authorization({ allowedModelIds: [priced.id] });
    const reserved = await reserve({
      authorization: auth,
      model: priced,
      ownerUserId: ownerId,
      maxInputTokens: 100_000,
      maxOutputTokens: 1_000,
      idempotencyKey: 'settle-me',
      at: AT,
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.reservation.reservedMicros).toBe(105);

    const settled = await settle({
      reservationId: reserved.reservation.id,
      inputTokens: 10_000,
      outputTokens: 200,
      at: AT,
    });
    expect(settled.actualMicros).toBe(11);
    const budget = await remainingFor(auth, AT);
    expect(budget.heldMicros).toBe(0);
    expect(budget.settledMicros).toBe(11);
  });

  it('settles once however many times the callback arrives', async () => {
    const priced = await model();
    const auth = await authorization({ allowedModelIds: [priced.id] });
    const reserved = await reserve({
      authorization: auth,
      model: priced,
      ownerUserId: ownerId,
      maxInputTokens: 10_000,
      maxOutputTokens: 1_000,
      idempotencyKey: 'once',
      at: AT,
    });
    if (!reserved.ok) throw new Error('the fixture did not reserve');
    await settle({ reservationId: reserved.reservation.id, inputTokens: 1, outputTokens: 1, at: AT });
    const second = await settle({
      reservationId: reserved.reservation.id,
      inputTokens: 1,
      outputTokens: 1,
      at: AT,
    });
    expect(second.ok).toBe(false);
  });
});

describe('an unknown outcome keeps its hold', () => {
  it('does not release money when the provider may already have done the work', async () => {
    const priced = await model();
    const auth = await authorization({ allowedModelIds: [priced.id] });
    const reserved = await reserve({
      authorization: auth,
      model: priced,
      ownerUserId: ownerId,
      maxInputTokens: 10_000,
      maxOutputTokens: 1_000,
      idempotencyKey: 'unknown',
      at: AT,
    });
    if (!reserved.ok) throw new Error('the fixture did not reserve');
    const before = (await remainingFor(auth, AT)).heldMicros;

    await markUnknown({
      reservationId: reserved.reservation.id,
      reason: 'the stream ended without a completion',
      at: AT,
    });

    // Step 6's rule about effects, applied to money: a timeout is not evidence
    // that nothing was spent, and releasing here would assume the answer most
    // likely to be wrong.
    expect((await remainingFor(auth, AT)).heldMicros).toBe(before);
    expect((await reservationByKey('unknown'))!.state).toBe('UNKNOWN');
  });

  it('does release money for a call that provably never reached the provider', async () => {
    const priced = await model();
    const auth = await authorization({ allowedModelIds: [priced.id] });
    const reserved = await reserve({
      authorization: auth,
      model: priced,
      ownerUserId: ownerId,
      maxInputTokens: 10_000,
      maxOutputTokens: 1_000,
      idempotencyKey: 'released',
      at: AT,
    });
    if (!reserved.ok) throw new Error('the fixture did not reserve');
    await release({
      reservationId: reserved.reservation.id,
      reason: 'no credential, so no request was made',
      at: AT,
    });
    expect((await remainingFor(auth, AT)).heldMicros).toBe(0);
  });

  it('keeps the hold when a turn times out end to end', async () => {
    const priced = await model();
    const auth = await authorization({ allowedModelIds: [priced.id] });
    const result = await answerFast({
      adapter: scriptedAdapter([
        { kind: 'TEXT', text: 'half an ans' },
        { kind: 'ERROR', failure: 'TIMEOUT', detail: 'took too long', retryable: true },
      ]),
      provider: 'anthropic',
      ownerUserId: ownerId,
      conversationId,
      messageId: 'msg_timeout',
      projectId,
      projectName: 'Deal Dispatch',
      text: 'what did we decide about the fee',
      turnCount: 2,
      at: AT,
    });
    expect(result.failure).toBe('TIMEOUT');
    expect(result.answer).toBeNull();
    expect((await remainingFor(auth, AT)).heldMicros).toBeGreaterThan(0);
  });
});

describe('the lane is decided by what is asked, not by how busy the fleet is', () => {
  const base = { turnCount: 1, fastLaneAvailable: true };

  it('answers ordinary discussion on the fast lane', () => {
    const decision = decideLane({ ...base, text: 'what did we decide about the fee in Michigan?' });
    expect(decision.lane).toBe('FAST');
    expect(decision.explanation).toBeNull();
  });

  it('sends anything that asks for work to the Routines', () => {
    for (const text of [
      'go and research the Florida position',
      'please remember this for later',
      'start work on the licensing question',
    ]) {
      expect(decideLane({ ...base, text }).lane).toBe('WORK');
    }
  });

  it('escalates a high-stakes or spending question to the deeper lane', () => {
    expect(decideLane({ ...base, text: 'is this legal in Michigan?' }).lane).toBe('DEEP');
    expect(decideLane({ ...base, text: 'should we buy the data set?' }).lane).toBe('DEEP');
  });

  it('escalates when the answer would conflict with what is established', () => {
    const decision = decideLane({
      ...base,
      text: 'so the fee is two hundred dollars, right?',
      conflictsWithKnowledge: true,
    });
    expect(decision.lane).toBe('DEEP');
    expect(decision.escalations).toContain('CONFLICTS_WITH_KNOWLEDGE');
  });

  it('honours an explicit deep-check', () => {
    const decision = decideLane({ ...base, text: 'deep-check this for me' });
    expect(decision.escalations).toContain('ASKED_FOR_DEEP_CHECK');
    expect(decision.lane).toBe('DEEP');
  });

  it('falls back to the Routines rather than to nothing when there is no fast lane', () => {
    const decision = decideLane({ ...base, fastLaneAvailable: false, text: 'just a question' });
    expect(decision.lane).toBe('WORK');
    expect(decision.explanation).not.toBeNull();
  });

  it('says in plain words why an answer is taking longer', () => {
    const decision = decideLane({ ...base, text: 'is this legal?' });
    expect(decision.explanation).toMatch(/legal, financial or safety/);
    expect(decision.explanation).not.toMatch(/HIGH_STAKES|escalat/i);
  });

  it('names what the fast lane may never do', () => {
    // A contract written down in one place so it can be argued with, rather
    // than six conditions nobody can find.
    expect(FAST_LANE_MAY_NOT).toContain('authorize spending');
    expect(FAST_LANE_MAY_NOT).toContain('overwrite canonical knowledge');
  });

  it('never falls a deep turn down to a fast model', () => {
    const fastOnly = [
      { id: 'a', lane: 'FAST' } as LlmModel,
    ];
    expect(chooseModel(fastOnly, 'DEEP')).toBeNull();
    expect(chooseModel(fastOnly, 'FAST')).not.toBeNull();
  });
});

describe('the context hat is bounded, ordered and honest about what it dropped', () => {
  it('carries the project’s state and says what did not fit', async () => {
    await addMessage({
      conversationId,
      role: 'USER',
      content: 'what is the position on the fee?',
      authorUserId: ownerId,
    });
    const generous = await compileHat({
      conversationId,
      projectId,
      projectName: 'Deal Dispatch',
      ownerUserId: ownerId,
    });
    expect(generous.parts.map((part) => part.section)).toContain('PROJECT_STATE');
    expect(generous.omitted).toEqual([]);

    const tight = await compileHat({
      conversationId,
      projectId,
      projectName: 'Deal Dispatch',
      ownerUserId: ownerId,
      budgetCharacters: 2_000,
    });
    // Identity survives a tight budget; an assistant with no instructions is a
    // different assistant. Whatever else went is named.
    expect(tight.parts[0]!.section).toBe('IDENTITY');
    expect(tight.characters).toBeLessThanOrEqual(2_000 + tight.parts[0]!.text.length);
  });

  it('does not send the whole transcript', async () => {
    for (let index = 0; index < 60; index += 1) {
      await addMessage({
        conversationId,
        role: 'USER',
        content: `message ${index}`,
        authorUserId: ownerId,
      });
    }
    const hat = await compileHat({
      conversationId,
      projectId,
      projectName: 'Deal Dispatch',
      ownerUserId: ownerId,
      recentTurns: 20,
    });
    expect(hat.messages.length).toBeLessThanOrEqual(20);
  });

  it('estimates tokens conservatively, because the estimate reserves money', () => {
    // Fewer characters per token means a larger estimate means a larger
    // reservation. Being wrong in the cheap direction is the expensive mistake.
    expect(estimateTokens(3200)).toBeGreaterThanOrEqual(1000);
  });
});

describe('period keys', () => {
  it('bucket by the authorization’s own period', () => {
    expect(periodKeyFor('DAY', AT)).toBe('2026-09-04');
    expect(periodKeyFor('MONTH', AT)).toBe('2026-09');
    expect(periodKeyFor('TOTAL', AT)).toBe('TOTAL');
  });

  it('keeps a period’s ceiling as it was when the period opened', async () => {
    const priced = await model();
    const auth = await authorization({ allowedModelIds: [priced.id], ceilingMicros: 100 });
    await ledgerFor(auth, AT);
    await getDb().run('UPDATE spend_authorizations SET ceiling_micros = 5 WHERE id = ?', [auth.id]);
    // Lowering an authorization tomorrow does not make today's committed
    // spending retroactively over budget.
    const budget = await remainingFor({ ...auth, ceilingMicros: 5 }, AT);
    expect(budget.ceilingMicros).toBe(100);
  });
});

describe('recall is not an instruction', () => {
  const base = { turnCount: 1, fastLaneAvailable: true };

  it('keeps a question about the past on the fast lane', () => {
    // The defect this pins: a bare `decide` in the verb list sent "what did we
    // decide about the fee?" — pure recall, the exact thing the fast lane
    // exists for — to a three-minute Routine activation.
    for (const text of [
      'what did we decide about the fee?',
      'remind me what we found out about Michigan',
      'do we know whether the registration is separate?',
      'did we ever plan the outreach sequence?',
    ]) {
      expect(decideLane({ ...base, text }).lane, text).toBe('FAST');
    }
  });

  it('still escalates a recall question that is high stakes', () => {
    // Recall suppresses the *work* escalation, not the others. "What did we
    // decide about the licence?" is still a legal question.
    const decision = decideLane({ ...base, text: 'what did we decide about the licence?' });
    expect(decision.lane).toBe('DEEP');
    expect(decision.escalations).toContain('HIGH_STAKES');
  });

  it('still sends a genuine instruction to the Routines', () => {
    for (const text of [
      'please decide whether we pursue Florida',
      'go and research the fee schedule',
      'remember this for next time',
    ]) {
      expect(decideLane({ ...base, text }).lane, text).toBe('WORK');
    }
  });
});

describe('a turn actually takes the fast lane, or falls through unchanged', () => {
  it('answers without creating a bin, and records which lane answered', async () => {
    const { beginTurn } = await import('../server/services/russell/turn.ts');
    const { grantMembership } = await import('../server/repos/identity.ts');
    const { listBins } = await import('../server/repos/bins.ts');
    const { listTurns } = await import('../server/repos/russellConversations.ts');

    const priced = await model();
    await authorization({ allowedModelIds: [priced.id] });
    await grantMembership({
      projectId,
      principalType: 'HUMAN',
      principalId: ownerId,
      role: 'MEMBER',
      scopes: [],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });

    const result = await beginTurn({
      principal: {
        type: 'HUMAN',
        id: ownerId,
        handle: 'spender@example.test',
        displayName: 'The spender',
        isBrainAdmin: false,
        mustChangePassword: false,
        credentialId: 'ses_1',
        authMethod: 'SESSION_COOKIE',
        memberships: [],
        requestId: 'req_1',
      },
      conversationId,
      content: 'what did we decide about the fee?',
      adapter: scriptedAdapter([
        { kind: 'TEXT', text: 'We settled on the statutory figure.' },
        { kind: 'DONE', usage: { inputTokens: 900, outputTokens: 40 } },
      ]),
    });

    expect(result.ok).toBe(true);
    // The whole point: no bin, so no dispatch, no activation, no three minutes.
    expect(result.binId).toBeNull();
    expect(await listBins({ projectId, limit: 50 })).toHaveLength(0);

    const turns = await listTurns(conversationId, 20);
    const answer = turns.find((turn) => turn.role === 'RUSSELL');
    expect(answer!.status).toBe('COMPLETE');
    expect(answer!.content).toContain('statutory figure');
    // The acceptance reporter reads this, and so does a person asking where an
    // answer came from.
    expect(JSON.stringify(answer!.metadata)).toContain('FAST');
  });

  it('falls through to a bin when there is no fast lane, exactly as before', async () => {
    const { beginTurn } = await import('../server/services/russell/turn.ts');
    const { grantMembership } = await import('../server/repos/identity.ts');
    await grantMembership({
      projectId,
      principalType: 'HUMAN',
      principalId: ownerId,
      role: 'MEMBER',
      scopes: [],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    const result = await beginTurn({
      principal: {
        type: 'HUMAN',
        id: ownerId,
        handle: 'spender@example.test',
        displayName: 'The spender',
        isBrainAdmin: false,
        mustChangePassword: false,
        credentialId: 'ses_1',
        authMethod: 'SESSION_COOKIE',
        memberships: [],
        requestId: 'req_1',
      },
      conversationId,
      content: 'what did we decide about the fee?',
      // No adapter, which is what the deployed Brain has.
      });
    expect(result.ok).toBe(true);
    expect(result.binId).not.toBeNull();
  });
});
