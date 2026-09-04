/**
 * One fast turn: reserve, call, settle.
 *
 * The order is the whole design and it is not negotiable.
 *
 *   1. Decide the lane. A turn that wants work never reaches a fast model.
 *   2. Find an authorization and a model. No authorization is a refusal with a
 *      name, never a default.
 *   3. Reserve the **worst case**, atomically, before anything is called.
 *   4. Call, and stream.
 *   5. Settle from the provider's own usage report — or, if there is no report,
 *      record the outcome as unknown and keep the money committed.
 *
 * Step 6 wrote step 5 for external effects and it is the same rule for money: a
 * timeout is not evidence that nothing was spent. The tempting shortcut —
 * release the hold when the call fails — assumes the outcome most likely to be
 * wrong, and the ceiling is exactly the thing that assumption would breach.
 *
 * Nothing here writes project state. A fast reply is text and a usage record;
 * anything it *proposes* goes through `services/russell/proposal.ts` and the
 * guarded services behind it, which is §24's rule and is why a fast model
 * cannot become an authority by being fast.
 */
import { createHash } from 'node:crypto';
import {
  authorizationsFor,
  getModel,
  listModels,
  markUnknown,
  release,
  remainingFor,
  reserve,
  settle,
  type LlmModel,
  type SpendAuthorization,
} from '../../repos/spend.ts';
import { nowIso } from '../../repos/util.ts';
import { collect, unavailableAdapter, type ChatAdapter, type AdapterFailure } from './adapter.ts';
import { compileHat, estimateTokens, type ContextHat } from './contextHat.ts';
import { decideLane, type Lane, type LaneDecision } from './lanes.ts';

export interface FastLaneResult {
  lane: Lane;
  decision: LaneDecision;
  /** Present only when a fast or deep model actually answered. */
  answer: string | null;
  /** Why there is no answer, when there is not. Always one of the named set. */
  failure: AdapterFailure | null;
  /** The sentence a person reads. Never a provider's own error text. */
  explanation: string | null;
  /** What was actually spent, in micro-dollars, when it is known. */
  spentMicros: number | null;
  /** The reservation, so a caller can show or reconcile it. */
  reservationId: string | null;
  hat: ContextHat | null;
}

/**
 * Whether this Brain can answer quickly at all.
 *
 * Three separate facts with three separate remedies, reported separately —
 * §16's rule that the engine's readiness and the worker's readiness are
 * different answers, applied here.
 */
export async function fastLaneReadiness(input: {
  ownerUserId: string;
  provider: string;
  adapter: ChatAdapter;
  at?: string;
}): Promise<{ ready: boolean; failure: AdapterFailure | null; remainingMicros: number }> {
  const credential = await input.adapter.ready();
  if (!credential.ready) {
    return { ready: false, failure: credential.failure ?? 'NO_CREDENTIAL', remainingMicros: 0 };
  }
  const authorization = await liveAuthorization(input.ownerUserId, input.provider, input.at);
  if (!authorization) {
    return { ready: false, failure: 'NOT_AUTHORIZED_TO_SPEND', remainingMicros: 0 };
  }
  const budget = await remainingFor(authorization, input.at ?? nowIso());
  if (budget.remainingMicros <= 0) {
    return { ready: false, failure: 'CEILING_REACHED', remainingMicros: 0 };
  }
  const models = await usableModels(authorization);
  if (models.length === 0) {
    return { ready: false, failure: 'MODEL_UNAVAILABLE', remainingMicros: budget.remainingMicros };
  }
  return { ready: true, failure: null, remainingMicros: budget.remainingMicros };
}

/**
 * The authorization in force right now, or none.
 *
 * Every condition is a refusal rather than a warning: disabled, not yet
 * effective, expired, or a ceiling of zero. There is no branch that treats an
 * ambiguous authorization as permission.
 */
export async function liveAuthorization(
  ownerUserId: string,
  provider: string,
  at?: string,
): Promise<SpendAuthorization | null> {
  const now = at ?? nowIso();
  const all = await authorizationsFor(ownerUserId, provider);
  return (
    all.find(
      (authorization) =>
        authorization.enabled &&
        authorization.ceilingMicros > 0 &&
        authorization.effectiveFrom <= now &&
        (authorization.effectiveUntil === null || authorization.effectiveUntil > now),
    ) ?? null
  );
}

/**
 * The models this authorization actually permits.
 *
 * The intersection of "enabled in the catalogue" and "named in the
 * authorization". Enabling a model must not widen an authorization somebody
 * already granted, which is why the list is explicit rather than "everything
 * enabled".
 */
export async function usableModels(authorization: SpendAuthorization): Promise<LlmModel[]> {
  const enabled = await listModels({ enabledOnly: true });
  return enabled.filter(
    (model) =>
      model.provider === authorization.provider && authorization.allowedModelIds.includes(model.id),
  );
}

/**
 * Which model answers a lane.
 *
 * Configuration, not code: the candidates come from rows and the choice is the
 * cheapest that serves the lane. There is no model name in this file, which is
 * the point — the addendum is explicit that Haiku must not be hardcoded before
 * evidence compares it with Sonnet, and the way to keep that true is to have
 * nowhere to hardcode it.
 */
export function chooseModel(models: LlmModel[], lane: Lane): LlmModel | null {
  const wanted = lane === 'DEEP' ? 'DEEP' : 'FAST';
  const exact = models.filter((model) => model.lane === wanted);
  if (exact.length > 0) return exact[0]!;
  // A deep turn may fall *up* to nothing rather than down to a fast model: if
  // no deep model is configured the turn goes to the Routines, which are
  // stronger than the fast lane rather than weaker.
  return wanted === 'FAST' ? (models[0] ?? null) : null;
}

/**
 * The reservation key for one turn.
 *
 * Derived from the message, not from the attempt, the clock or the request —
 * Step 6's rule, and the reason a retry after a timeout reserves once instead
 * of twice. Hashed so a long id does not become a long unique index entry.
 */
export function reservationKey(input: {
  conversationId: string;
  messageId: string;
  lane: Lane;
}): string {
  return createHash('sha256')
    .update(`russell-turn:${input.conversationId}:${input.messageId}:${input.lane}`)
    .digest('hex')
    .slice(0, 48);
}

/**
 * Answer one turn on the fast or deep lane, or say honestly why not.
 *
 * Returns rather than throws for every foreseeable condition. A turn that
 * cannot be answered quickly is not an error — it is a turn for the Routines,
 * which is where every turn went before this existed.
 */
export async function answerFast(input: {
  adapter: ChatAdapter;
  provider: string;
  ownerUserId: string;
  conversationId: string;
  messageId: string;
  projectId: string | null;
  projectName: string | null;
  text: string;
  turnCount: number;
  conflictsWithKnowledge?: boolean;
  standingInstructions?: string[];
  at?: string;
}): Promise<FastLaneResult> {
  const at = input.at ?? nowIso();
  const readiness = await fastLaneReadiness({
    ownerUserId: input.ownerUserId,
    provider: input.provider,
    adapter: input.adapter,
    at,
  });

  const decision = decideLane({
    text: input.text,
    turnCount: input.turnCount,
    conflictsWithKnowledge: input.conflictsWithKnowledge ?? false,
    fastLaneAvailable: readiness.ready,
  });

  if (decision.lane === 'WORK') {
    return {
      lane: 'WORK',
      decision,
      answer: null,
      failure: readiness.failure,
      explanation:
        decision.explanation ??
        'This one is going through the slower path so it can be done properly.',
      spentMicros: null,
      reservationId: null,
      hat: null,
    };
  }

  const authorization = await liveAuthorization(input.ownerUserId, input.provider, at);
  if (!authorization) {
    return refuse(decision, 'NOT_AUTHORIZED_TO_SPEND');
  }
  const model = chooseModel(await usableModels(authorization), decision.lane);
  if (!model) return refuse(decision, 'MODEL_UNAVAILABLE');

  const hat = await compileHat({
    conversationId: input.conversationId,
    projectId: input.projectId,
    projectName: input.projectName,
    ownerUserId: input.ownerUserId,
    ...(input.standingInstructions ? { standingInstructions: input.standingInstructions } : {}),
  });

  const maxInputTokens = estimateTokens(
    hat.characters + hat.messages.reduce((total, message) => total + message.content.length, 0),
  );

  const reserved = await reserve({
    authorization,
    model,
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    idempotencyKey: reservationKey({
      conversationId: input.conversationId,
      messageId: input.messageId,
      lane: decision.lane,
    }),
    at,
  });
  if (!reserved.ok) return refuse(decision, 'CEILING_REACHED');

  const outcome = await collect(
    input.adapter.stream({
      modelId: model.modelId,
      system: hat.system,
      messages: hat.messages,
      maxOutputTokens: model.maxOutputTokens,
    }),
  );

  if (outcome.ok) {
    const settled = await settle({
      reservationId: reserved.reservation.id,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      at,
    });
    return {
      lane: decision.lane,
      decision,
      answer: outcome.text,
      failure: null,
      explanation: decision.explanation,
      spentMicros: settled.actualMicros,
      reservationId: reserved.reservation.id,
      hat,
    };
  }

  /*
   * The call did not produce a usage report.
   *
   * Two cases, and they are not the same. A refusal the adapter issued before
   * it reached the provider provably cost nothing, so the hold is released. A
   * timeout, a cancellation, or an error from a provider that may already have
   * done the work is an unknown outcome: the hold stays and a person settles it
   * against a bill. Guessing the cheaper answer here is how a ceiling is
   * quietly exceeded.
   */
  const provablyNotCharged: AdapterFailure[] = [
    'NO_CREDENTIAL',
    'NOT_AUTHORIZED_TO_SPEND',
    'CEILING_REACHED',
    'MODEL_UNAVAILABLE',
  ];
  if (provablyNotCharged.includes(outcome.failure)) {
    await release({ reservationId: reserved.reservation.id, reason: outcome.detail, at });
  } else {
    await markUnknown({ reservationId: reserved.reservation.id, reason: outcome.detail, at });
  }

  return {
    lane: decision.lane,
    decision,
    answer: null,
    failure: outcome.failure,
    explanation: null,
    spentMicros: null,
    reservationId: reserved.reservation.id,
    hat,
  };
}

function refuse(decision: LaneDecision, failure: AdapterFailure): FastLaneResult {
  return {
    lane: 'WORK',
    decision,
    answer: null,
    failure,
    explanation: null,
    spentMicros: null,
    reservationId: null,
    hat: null,
  };
}

/** The adapter a Brain with nothing configured uses. Exported so it is named. */
export function noFastLane(): ChatAdapter {
  return unavailableAdapter('NO_CREDENTIAL');
}

export { getModel };
