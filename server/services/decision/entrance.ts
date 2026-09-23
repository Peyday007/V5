/**
 * Where a person asking "what can we actually do?" enters the decision.
 *
 * Deterministic, on the person's own words, and narrow by construction — the
 * same shape as `asksForExecution` in `russell/software.ts`, for its reason:
 * the failure mode must stay *missing* a request, which a later message can
 * restate, rather than inventing one, which would put a decision brief in
 * front of somebody who was only thinking aloud.
 *
 * No model is asked anything here. The brief is derived from rows, so it can
 * be answered in the request that asked for it rather than after a fleet
 * activation — which is also what makes it available on a Brain with no
 * worker connected at all.
 *
 * Which objective it is about is read from records first:
 *
 *  1. an objective the person states in the same message ("our goal is…",
 *     "I want to…", "the objective is…") is recorded as theirs;
 *  2. otherwise an objective already open in this conversation is reused;
 *  3. otherwise the project's own recorded objective — a Cash sprint's — is
 *     adopted, because it is what somebody already wrote down that this
 *     project is for;
 *  4. otherwise Brain asks for the one thing it cannot establish: what the
 *     person is trying to achieve. That is the only question this asks, and it
 *     asks it because the answer changes everything downstream.
 */
import { getCashMode } from '../../repos/cashMode.ts';
import { ensureObjective, listObjectives, type Objective } from '../../repos/objectives.ts';
import { NEGATORS, clauseBefore } from '../russell/negation.ts';
import { listTurns, resolveMessage } from '../../repos/russellConversations.ts';
import { advanceObjective } from './act.ts';

/**
 * Phrasings that ask Brain for a decision rather than for information.
 *
 * Each is a question somebody asks when they want to be told what to do. A
 * past-tense report ("we decided what to do") and a remark ("it is hard to
 * know what to do") match nothing, which is what the tests pin.
 */
const DECISION_ASKS: readonly RegExp[] = [
  /\bwhat\s+can\s+(?:we|i)\s+(?:actually\s+|really\s+|realistically\s+)?do\b/i,
  /\bwhat\s+should\s+(?:we|i)\s+(?:actually\s+|really\s+)?(?:do|pursue|work\s+on|focus\s+on|build|try)\b/i,
  /\bwhat\s+do\s+you\s+recommend\b/i,
  /\b(?:what(?:'s|\s+is)|which\s+is)\s+(?:the|our)\s+(?:(?:best|next|first)\s+)+(?:move|step|option|path|bet)\b/i,
  /\b(?:give|show|write)\s+me\s+(?:a|the)\s+decision\b/i,
  /\bhow\s+(?:can|could|do|should)\s+(?:we|i)\s+(?:actually\s+)?(?:make|earn|generate)\s+(?:money|cash|revenue|income)\b/i,
  /\bwhat\s+(?:would|do)\s+you\s+do\s+(?:next|first|now)\b/i,
];

/** An objective stated in the message itself. */
const STATED_OBJECTIVE =
  /\b(?:our\s+goal\s+is|my\s+goal\s+is|the\s+goal\s+is|our\s+objective\s+is|the\s+objective\s+is|i\s+want\s+to|we\s+want\s+to|i\s+need\s+to|we\s+need\s+to|i'?m\s+trying\s+to|we'?re\s+trying\s+to)\s+(?:to\s+)?(.{12,})/i;

export interface DecisionAsk {
  asks: boolean;
  /** The objective stated in the message, where one was. */
  stated: string | null;
}

export function asksForDecision(message: string): DecisionAsk {
  const text = message.replace(/\s+/g, ' ').trim();
  const match = DECISION_ASKS.map((pattern) => pattern.exec(text)).find((one) => one !== null) ?? null;
  if (!match) return { asks: false, stated: null };
  if (NEGATORS.test(clauseBefore(text, match.index))) return { asks: false, stated: null };
  const stated = STATED_OBJECTIVE.exec(text);
  let objective = stated?.[1]?.trim() ?? null;
  if (objective) {
    // Up to the end of that sentence, and without the question that followed it.
    objective = objective.split(/(?<=[.?!])\s/)[0]!.replace(/[.?!,;:]+$/, '').trim();
    if (objective.length < 12) objective = null;
  }
  return { asks: true, stated: objective };
}

export type ResolvedObjective =
  | { kind: 'OBJECTIVE'; objective: Objective; created: boolean; how: string }
  | { kind: 'ASK'; question: string };

export async function resolveObjective(input: {
  projectId: string;
  conversationId: string;
  messageId: string;
  userId: string;
  stated: string | null;
}): Promise<ResolvedObjective> {
  if (input.stated) {
    const { objective, created } = await ensureObjective({
      projectId: input.projectId,
      statement: input.stated,
      sourceKind: 'CONVERSATION',
      sourceRef: input.messageId,
      conversationId: input.conversationId,
      createdByUserId: input.userId,
    });
    return { kind: 'OBJECTIVE', objective, created, how: 'as you stated it' };
  }
  const here = await listObjectives({ conversationId: input.conversationId, projectId: input.projectId });
  const last = here[here.length - 1];
  if (last) return { kind: 'OBJECTIVE', objective: last, created: false, how: 'the objective already open in this conversation' };
  const mode = await getCashMode(input.projectId);
  if (mode && mode.objective.trim().length > 0) {
    const { objective, created } = await ensureObjective({
      projectId: input.projectId,
      statement: mode.objective.trim(),
      sourceKind: 'CASH_MODE',
      sourceRef: mode.id,
      conversationId: input.conversationId,
      createdByUserId: input.userId,
    });
    return {
      kind: 'OBJECTIVE',
      objective,
      created,
      how: 'the objective already recorded on this project’s Cash Mode sprint',
    };
  }
  return {
    kind: 'ASK',
    question:
      'What are you trying to achieve with this project? Tell me the outcome you want — for example ' +
      '"our goal is to …" — and I will compare what Brain already holds against it and tell you what ' +
      'I recommend doing first. Nothing on this project records an objective yet, and I would rather ' +
      'ask than guess at one.',
  };
}

/**
 * The decision lane of a Russell turn.
 *
 * Returns null when the message is not asking for a decision, and the turn
 * carries on exactly as it always has. Otherwise it resolves the objective,
 * advances it — which records the step and, inside a grant somebody set,
 * turns it into work — and settles the pending turn with the brief in the
 * same request. `produced` carries the objective id, so the conversation can
 * show the live brief beside the words rather than a stale copy of them.
 */
export async function answerDecisionTurn(input: {
  projectId: string;
  conversationId: string;
  userMessageId: string;
  pendingMessageId: string;
  userId: string;
  content: string;
}): Promise<{ objectiveId: string | null; asked: boolean } | null> {
  const ask = asksForDecision(input.content);
  let stated = ask.stated;
  if (!ask.asks) {
    // A reply to Brain's own question about what the objective is.
    const turns = await listTurns(input.conversationId, 50);
    const prior = turns.filter(
      (one) => one.role === 'RUSSELL' && one.id !== input.pendingMessageId && one.status !== 'PENDING',
    );
    const last = prior[prior.length - 1];
    const text = input.content.replace(/\s+/g, ' ').trim();
    if (!last || last.produced?.['objectiveAsk'] !== true || text.length < 12) return null;
    stated = STATED_OBJECTIVE.exec(text)?.[1]?.replace(/[.?!]+$/, '').trim() ?? text.replace(/[.?!]+$/, '');
  }

  const resolved = await resolveObjective({
    projectId: input.projectId,
    conversationId: input.conversationId,
    messageId: input.userMessageId,
    userId: input.userId,
    stated,
  });
  if (resolved.kind === 'ASK') {
    await resolveMessage({
      messageId: input.pendingMessageId,
      content: resolved.question,
      produced: { objectiveAsk: true },
    });
    return { objectiveId: null, asked: true };
  }

  // Not announced as a change: the answer *is* this message.
  const advanced = await advanceObjective(resolved.objective.id, { announce: false });
  const brief = advanced?.brief ?? null;
  await resolveMessage({
    messageId: input.pendingMessageId,
    content: brief
      ? `I read this against ${resolved.how}.\n\n${brief.text}`
      : 'That objective is closed, so there is nothing to decide about it.',
    produced: {
      objectiveId: resolved.objective.id,
      verdict: brief?.verdict ?? null,
      stepId: brief?.currentStep?.step.id ?? null,
    },
  });
  return { objectiveId: resolved.objective.id, asked: false };
}
