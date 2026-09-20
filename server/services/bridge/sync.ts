/**
 * The conversation entrance: what arrives, in what order, and what Brain then
 * does about it.
 *
 * ---------------------------------------------------------------------------
 * The one thing this module is for
 * ---------------------------------------------------------------------------
 *
 * A conversation held in somebody else's client is the largest body of
 * decisions this Brain has never been able to read. The whole of §11 exists for
 * the same problem one artefact along — a transcript is a record of thinking,
 * it is untrusted, and storing it is not reading it — and every rule there
 * holds here:
 *
 *   * **Storing is not understanding.** This module stores exactly, orders
 *     exactly, and then hands the person's own words to the machinery that
 *     already interprets them: `beginTurn`, which persists a PENDING turn and a
 *     bin the fixed-subscription fleet answers. No inference is bought, which
 *     is the requirement §24 states and the deployed Brain enforces by having
 *     no provider at all.
 *   * **Imported text is untrusted data.** Nothing found inside a transcript is
 *     ever executed and none of it moves project state by itself. What it can
 *     do is exactly what a person typing into Russell can do, which is the
 *     point: this is a way *in*, not a way around.
 *   * **A hole is reported, never smoothed.** A client that starts at position
 *     40 has told Brain the first 40 are missing, and the receipt says so. A
 *     transcript with a gap can be read as saying the opposite of what it said,
 *     so the gap is part of the answer.
 *
 * ---------------------------------------------------------------------------
 * Idempotency, and what it does *not* mean
 * ---------------------------------------------------------------------------
 *
 * A retry is not a second delivery. The request key is built from
 * server-controlled facts — the authenticated person, the conversation Brain
 * resolved, and a fingerprint of the batch's own content — and never from
 * anything that changes between two attempts at the same delivery. §20's rule,
 * and its corollary: **idempotency means the effect is present after either
 * call, not that the second call does nothing.** A replay re-reads the receipt
 * and returns it; it does not silently return an empty one.
 *
 * Duplicate *content* is separately free: a message whose position, id and hash
 * already exist is recognised and counted rather than written again, so a
 * client that re-sends its whole transcript on every sync is cheap and correct.
 */
import crypto from 'node:crypto';
import type { Principal } from '../../domain/types.ts';
import type { BridgeRole, BridgeRouting, BridgeSource } from '../../domain/register.ts';
import {
  completeReceipt,
  findBridgeConversation,
  getBridgeConversation,
  insertBridgeConversation,
  insertBridgeMessage,
  listBridgeMessages,
  missingOrdinals,
  refreshBridgeConversation,
  reserveReceipt,
  revisionsAt,
  supersedeBridgeMessage,
  hashContent,
} from '../../repos/bridge.ts';
import { createConversation } from '../../repos/russellConversations.ts';
import { beginTurn } from '../russell/turn.ts';
import type { BridgeConversation, BridgeMessage, BridgeReceipt } from '../../domain/register.ts';

/** One turn as a client presents it. */
export interface IncomingMessage {
  /** The client's own position in the conversation, from zero. */
  ordinal: number;
  role: BridgeRole;
  /** Stored byte for byte. Nothing here trims or reformats it. */
  content: string;
  externalId?: string | null;
  authorLabel?: string | null;
  /** When the client says it was said, not when Brain received it. */
  saidAt?: string | null;
}

export interface SyncInput {
  principal: Principal;
  source: BridgeSource;
  /** The client's own id for the conversation. Scoped by owner and source. */
  externalId: string;
  title: string;
  messages: IncomingMessage[];
  /**
   * Whether to hand the last person turn to Russell.
   *
   * Default true, and a client that is back-filling history says false — a
   * back-fill that opened a turn per batch would ask a worker to answer a
   * question from six months ago.
   */
  interpret?: boolean;
}

export interface SyncResult {
  conversation: BridgeConversation;
  receipt: BridgeReceipt;
  /** True when this call performed the delivery; false when it replayed one. */
  performed: boolean;
}

/**
 * The idempotency scope.
 *
 * Owner and conversation are server-controlled. The batch fingerprint is over
 * the content the caller sent, which is exactly right: two attempts at the same
 * delivery carry the same bytes, and a *different* batch is a different
 * operation rather than a repeat of this one. Nothing in it is a clock, an
 * attempt number or a request id, all of which change on the retry and would
 * make the key useless.
 */
function requestKeyFor(input: {
  ownerUserId: string;
  conversationId: string;
  messages: IncomingMessage[];
}): string {
  const canonical = input.messages
    .map((one) => `${one.ordinal}\u0000${one.role}\u0000${one.externalId ?? ''}\u0000${hashContent(one.content)}`)
    .sort()
    .join('\u0001');
  const digest = crypto
    .createHash('sha256')
    .update(`${input.ownerUserId}\u0000${input.conversationId}\u0000${canonical}`, 'utf8')
    .digest('hex');
  return `bridge:sync:${digest}`;
}

/**
 * Find or open the durable conversation this external one is.
 *
 * Two rows, not one: a `russell_conversations` thread — so a person following
 * the link lands on the thread Russell has actually been reasoning about rather
 * than a copy of it — and a `bridge_conversations` row that says which external
 * conversation that thread is. Opening is the ordinary case exactly once; every
 * later sync finds it.
 */
async function resolveConversation(input: {
  principal: Principal;
  source: BridgeSource;
  externalId: string;
  title: string;
}): Promise<BridgeConversation> {
  const existing = await findBridgeConversation({
    ownerUserId: input.principal.id,
    source: input.source,
    externalId: input.externalId,
  });
  if (existing) return existing;

  const thread = await createConversation({
    ownerUserId: input.principal.id,
    title: input.title,
  });
  return await insertBridgeConversation({
    ownerUserId: input.principal.id,
    source: input.source,
    externalId: input.externalId,
    title: input.title,
    russellConversationId: thread.id,
  });
}

/**
 * Take a batch of turns.
 *
 * The per-message decision has exactly four outcomes and each is counted:
 *
 *   * **New** — nothing at this position yet. Written as revision 1.
 *   * **Duplicate** — a live revision at this position already has this hash.
 *     Counted and not written: a client re-sending its whole transcript is the
 *     ordinary case, not an error.
 *   * **Revision** — the client's own id matches a live revision whose content
 *     differs. The person edited it. The new text is written as the next
 *     revision and the previous is superseded, **kept**.
 *   * **Branch** — a different message arrives at an occupied position with no
 *     id linking it to what is there. That is a fork, which is a real shape a
 *     conversation can have, so both are kept and the newcomer carries a note
 *     saying so. Picking one would be resolving an ambiguity by guessing.
 */
export async function syncConversation(input: SyncInput): Promise<SyncResult> {
  const conversation = await resolveConversation({
    principal: input.principal,
    source: input.source,
    externalId: input.externalId,
    title: input.title,
  });

  const requestKey = requestKeyFor({
    ownerUserId: input.principal.id,
    conversationId: conversation.id,
    messages: input.messages,
  });

  const reservation = await reserveReceipt({ conversationId: conversation.id, requestKey });
  if (!reservation.mine) {
    // Somebody already did this exact delivery. Re-read and replay, which is
    // what "the effect is present after either call" means.
    const current = await getBridgeConversation(conversation.id);
    return {
      conversation: current ?? conversation,
      receipt: reservation.receipt,
      performed: false,
    };
  }

  let accepted = 0;
  let duplicates = 0;
  let revisions = 0;
  let branches = 0;

  // Sorted by position, so out-of-order delivery is reordered rather than
  // appended. A transcript's meaning depends on its order and a client cannot
  // be relied upon to send one.
  const ordered = [...input.messages].sort((a, b) => a.ordinal - b.ordinal);

  for (const incoming of ordered) {
    const at = await revisionsAt(conversation.id, incoming.ordinal);
    const live = at.filter((one) => one.supersededAt === null);
    const hash = hashContent(incoming.content);

    const identical = live.find((one) => one.contentHash === hash);
    if (identical) {
      duplicates += 1;
      continue;
    }

    const sameId =
      incoming.externalId != null
        ? live.find((one) => one.externalId === incoming.externalId)
        : undefined;

    const nextRevision = at.reduce((top, one) => Math.max(top, one.revision), 0) + 1;

    if (sameId) {
      await supersedeBridgeMessage(sameId.id);
      await insertBridgeMessage({
        conversationId: conversation.id,
        ordinal: incoming.ordinal,
        revision: nextRevision,
        externalId: incoming.externalId ?? null,
        role: incoming.role,
        authorLabel: incoming.authorLabel ?? null,
        content: incoming.content,
        saidAt: incoming.saidAt ?? null,
        branchNote: null,
      });
      revisions += 1;
      continue;
    }

    const branched = live.length > 0;
    await insertBridgeMessage({
      conversationId: conversation.id,
      ordinal: incoming.ordinal,
      revision: nextRevision,
      externalId: incoming.externalId ?? null,
      role: incoming.role,
      authorLabel: incoming.authorLabel ?? null,
      content: incoming.content,
      saidAt: incoming.saidAt ?? null,
      branchNote: branched
        ? 'A different message arrived at this position with nothing linking it to the one already here. Both are kept.'
        : null,
    });
    if (branched) branches += 1;
    else accepted += 1;
  }

  const refreshed = (await refreshBridgeConversation(conversation.id, input.title)) ?? conversation;
  const missing = await missingOrdinals(conversation.id);

  const routing =
    input.interpret === false
      ? ({
          outcome: 'NOTHING',
          reason: 'This was a back-fill, so nothing was handed to Russell to answer.',
        } as BridgeRouting)
      : await interpretLatest({ principal: input.principal, conversation: refreshed });

  const receipt = await completeReceipt({
    id: reservation.receipt.id,
    accepted,
    duplicates,
    revisions,
    branches,
    firstOrdinal: ordered.length ? (ordered[0]?.ordinal ?? null) : null,
    lastOrdinal: ordered.length ? (ordered[ordered.length - 1]?.ordinal ?? null) : null,
    missing,
    routing,
  });

  return { conversation: refreshed, receipt, performed: true };
}

/**
 * Hand the person's latest words to the machinery that already interprets them.
 *
 * **Deterministic storage cannot understand an arbitrary conversation**, and
 * nothing here pretends otherwise. What it does is open a Russell turn, which
 * is a PENDING row and a bin — so a fleet worker reads the thread, and every
 * gate after that is the one that already exists: `validateProposal`'s closed
 * action set, `softwareTarget`'s refusal to guess a project, the capture gate,
 * the standing authority, the evidence gate. A transcript cannot reach any of
 * them except by being a person's message in a person's thread, which is
 * exactly what it now is.
 *
 * Only a `USER` turn is handed over. Another model's reply is not a request,
 * and feeding one to Russell would be asking Brain to act on something nobody
 * asked for.
 */
async function interpretLatest(input: {
  principal: Principal;
  conversation: BridgeConversation;
}): Promise<BridgeRouting> {
  const messages = await listBridgeMessages(input.conversation.id);
  const lastPersonTurn = [...messages].reverse().find((one) => one.role === 'USER');

  if (!lastPersonTurn) {
    return {
      outcome: 'NOTHING',
      reason: 'The transcript holds nothing the person said, so there was nothing to act on.',
    };
  }

  const turn = await beginTurn({
    principal: input.principal,
    conversationId: input.conversation.russellConversationId,
    content: lastPersonTurn.content,
  });

  if (!turn.ok) {
    return {
      outcome: 'REFUSED',
      reason: turn.reason,
      projectId: null,
    };
  }

  /*
   * A bin is the difference between "a worker will answer this" and "Russell
   * already did". `beginTurn` resolves the turn in-request when it cannot tell
   * which project the thread is about — and a receipt that called that
   * `TURN_OPENED` would leave a client waiting for a worker nobody sent for.
   */
  return {
    outcome: turn.binId ? 'TURN_OPENED' : 'ANSWERED',
    messageId: turn.pendingMessage?.id ?? turn.userMessage?.id,
    binId: turn.binId,
    projectId: turn.attachedProjectId,
    reason: turn.reason,
  };
}

/** The transcript as it currently reads, for the return path. */
export async function transcriptOf(
  conversationId: string,
  options?: { includeSuperseded?: boolean },
): Promise<BridgeMessage[]> {
  return await listBridgeMessages(conversationId, options);
}
