/**
 * Doing something outside Brain, and knowing what actually happened (§51).
 *
 * One path, five stages, and each stage is where one of the brief's demands is
 * kept rather than promised:
 *
 *   PREPARE   Every requirement is read *now* — the connection (deployed and
 *             answered for, not merely entered), the project, the standing
 *             commercial authority for a third-party effect, the destination,
 *             and the provider's actual availability. A missing one refuses with
 *             a sentence naming what would resolve it, and nothing is written.
 *             What is written is concrete: what will be sent, to whom, under
 *             which project, and what it is expected to change.
 *
 *   APPROVE   Every action that reaches somebody other than the owner's own
 *             phone waits for a person. Brain forming a view that a buyer should
 *             be emailed is a recommendation; the approval is the authority to
 *             carry it out, and the two are different rows written by different
 *             principals. A worker cannot approve: the route refuses it by type.
 *
 *   EXECUTE   Through Step 6's `runExternalEffect`, keyed from the action id and
 *             nothing else, so a retry, a restart or a second tick is one
 *             logical effect. Every precondition is asked again first — a grant
 *             withdrawn between approval and send stops the send. A rate limit
 *             is backpressure and waits; a refusal is recorded as a refusal; an
 *             unknown outcome is UNCERTAIN and is never resent automatically.
 *
 *   READ BACK The provider is asked what state the effect produced, from its own
 *             identifier, and that answer — not the send's 200 — is what the
 *             product reports. An invoice's three facts (issued, paid, settled)
 *             stay three.
 *
 *   RETURN    The result lands in the originating Russell conversation, on the
 *             opportunity it was for, and on the project's history, by itself.
 *
 * Nothing here holds a credential for longer than one call, and nothing here
 * writes one anywhere: the connection names a deployment secret and
 * `readSecret` is the only thing that reads it.
 */
import crypto from 'node:crypto';
import {
  claimReturn,
  countSentSince,
  getAction,
  getConnection,
  insertAction,
  listActionsInState,
  actionsAwaitingReadback,
  listLiveConnections,
  moveAction,
  recordExternalEvent,
  recordReadback,
  releaseAbandonedOperation,
} from '../../repos/externalActions.ts';
import { recordEvent } from '../../repos/events.ts';
import { addMessage, getConversation } from '../../repos/russellConversations.ts';
import { listOpenRequests } from '../../repos/russellMissions.ts';
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { recordAction } from '../../repos/cashActions.ts';
import { getDb } from '../../db/database.ts';
import { checkCommercialAuthority } from '../cash/authority.ts';
import { actionKey, beginExecution, recordMoneyEvent } from '../cash/opportunities.ts';
import { runExternalEffect } from '../effects/external.ts';
import { OperationInProgress } from '../effects/engine.ts';
import { driverFor, providerForKind } from './drivers.ts';
import {
  HEALTH_RECHECK_MS,
  checkConnection,
  liveReading,
  readConnection,
  readSecret,
  type ConnectionReading,
} from './connections.ts';
import type {
  ExternalAction,
  ExternalActionContent,
  ExternalActionKind,
  ExternalConnection,
} from '../../domain/types.ts';
import { EXTERNAL_ACTION_KINDS } from '../../domain/types.ts';

export const SYSTEM_ACTOR = 'external-actions';

/** Retries of a send the provider definitely did not act on, or de-duplicates. */
export const MAX_SEND_ATTEMPTS = 5;

/** A self-directed channel is still a channel; this bounds a runaway loop. */
export const MAX_NOTIFICATIONS_PER_DAY = 30;

/** A SENDING row older than this belongs to an executor that died. */
const SENDING_STALE_MS = 5 * 60_000;

/** Stop well short of the provider's window, not at its edge. */
const KEY_WINDOW_MARGIN_MS = 2 * 3600_000;

const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;

export function isActionKind(value: unknown): value is ExternalActionKind {
  return typeof value === 'string' && (EXTERNAL_ACTION_KINDS as readonly string[]).includes(value);
}

/** The commercial act a third-party effect of this kind is. */
const COMMERCIAL_FOR: Record<ExternalActionKind, string | null> = {
  NOTIFY_OWNER: null,
  SEND_EMAIL: 'CONTACT_BUYER',
  ISSUE_INVOICE: 'QUOTE_AND_INVOICE',
};

export type Refusal = { ok: false; reason: string; need: string | null };
export type Prepared = { ok: true; action: ExternalAction; created: boolean };

function refuse(reason: string, need: string | null = null): Refusal {
  return { ok: false, reason, need };
}

function describe(kind: ExternalActionKind, destination: string, content: ExternalActionContent, amountCents: number | null, currency: string | null): string {
  switch (kind) {
    case 'NOTIFY_OWNER':
      return `A push message titled "${content.subject ?? 'Brain'}" appears on the phone subscribed to this project's private topic.`;
    case 'SEND_EMAIL':
      return `An email titled "${content.subject}" is delivered to ${destination}, and Brain reads back whether it was delivered.`;
    case 'ISSUE_INVOICE':
      return (
        `An invoice for ${amountCents} minor units of ${currency} is issued to ${destination}, payable ` +
        `within ${content.daysUntilDue ?? 14} days; Brain reads back issued, paid and settled separately.`
      );
  }
}

/**
 * Whether this destination is the owner's own, so no third party is reached.
 *
 * Only the connection's declared self destination counts — never anything the
 * requester says about the address.
 */
function isSelfDirected(kind: ExternalActionKind, destination: string, connection: ExternalConnection): boolean {
  if (kind === 'NOTIFY_OWNER') return true;
  return !!connection.selfDestination && connection.selfDestination.toLowerCase() === destination.toLowerCase();
}

/**
 * Everything that must be true for this action to be sent, asked now.
 *
 * Called at preparation, at approval and immediately before the send, because
 * each of them is a different moment and a grant withdrawn at 3pm must stop a
 * send approved at 2pm.
 */
async function preconditions(input: {
  projectId: string;
  kind: ExternalActionKind;
  destination: string;
  connection: ExternalConnection | null;
}): Promise<
  | { ok: true; connection: ExternalConnection; reading: ConnectionReading; selfDirected: boolean; commercialAction: string | null; authorityId: string | null }
  | Refusal
> {
  const provider = providerForKind(input.kind);
  const driver = driverFor(provider);
  const connection = input.connection;
  if (!connection || connection.state !== 'ACTIVE') {
    return refuse(
      `This needs ${driver.title}, and this project has no live connection to it.`,
      `Connect ${driver.title} on External actions; an administrator then sets the named deployment secret and presses Check.`,
    );
  }
  const reading = await readConnection(connection);
  const selfDirected = isSelfDirected(input.kind, input.destination, connection);

  if (selfDirected ? !reading.usableForTest : !reading.live) {
    return refuse(
      reading.state === 'TEST_ONLY' && !selfDirected
        ? `${driver.title} is connected in TEST mode, which cannot reach a real customer. Only a test action to the connection's own address is possible.`
        : `${driver.title} reads ${reading.state}: ${reading.says}`,
      reading.nextStep,
    );
  }

  if (input.kind !== 'NOTIFY_OWNER' && !EMAIL.test(input.destination)) {
    return refuse('The destination is not a usable email address.', 'Give the recipient’s address exactly.');
  }

  const commercial = selfDirected ? null : COMMERCIAL_FOR[input.kind];
  let authorityId: string | null = null;
  if (commercial) {
    const decision = await checkCommercialAuthority({ projectId: input.projectId, action: commercial });
    if (!decision.ok || !decision.authority) {
      return refuse(
        `Reaching ${input.destination} is ${commercial}, and ${decision.reason}. Connecting a provider ` +
          'does not grant that; a person grants it on the commercial authority, deliberately.',
        `A project administrator grants a standing commercial authority covering ${commercial}.`,
      );
    }
    authorityId = decision.authority.id;
  }
  return { ok: true, connection, reading, selfDirected, commercialAction: commercial, authorityId };
}

function validContent(kind: ExternalActionKind, content: ExternalActionContent, currency: string | null): string | null {
  const subject = content.subject?.trim() ?? '';
  const body = content.body?.trim() ?? '';
  if (kind === 'ISSUE_INVOICE') {
    const lines = content.lines ?? [];
    if (lines.length === 0 || lines.length > 20) return 'An invoice needs between one and twenty lines.';
    for (const line of lines) {
      if (!line.description?.trim() || line.description.length > 500) return 'Every invoice line needs a description of at most 500 characters.';
      if (!Number.isInteger(line.amountCents) || line.amountCents <= 0 || line.amountCents > 100_000_000) {
        return 'Every invoice line needs a positive whole amount in minor units.';
      }
    }
    if (!currency || !/^[A-Z]{3}$/.test(currency)) return 'An invoice needs a three-letter currency code.';
    return null;
  }
  if (!subject || subject.length > 200) return 'A message needs a subject of at most 200 characters.';
  if (!body || body.length > 10_000) return 'A message needs a body of at most 10,000 characters.';
  return null;
}

export async function prepareAction(input: {
  projectId: string;
  kind: ExternalActionKind;
  destination?: string | null;
  content: ExternalActionContent;
  currency?: string | null;
  opportunityId?: string | null;
  conversationId?: string | null;
  requestedByType: 'HUMAN' | 'WORKER' | 'SYSTEM';
  requestedBy: string;
  /** Server-built. See `requestKeyFor`. */
  requestKey?: string;
}): Promise<Prepared | Refusal> {
  const kind = input.kind;
  const destination = kind === 'NOTIFY_OWNER' ? 'the owner’s private topic' : (input.destination ?? '').trim();
  const currency = input.currency ? input.currency.trim().toUpperCase() : null;
  const content: ExternalActionContent = {
    subject: input.content.subject?.trim(),
    body: input.content.body?.trim(),
    ...(kind === 'ISSUE_INVOICE'
      ? { lines: input.content.lines ?? [], daysUntilDue: input.content.daysUntilDue ?? 14 }
      : {}),
  };
  const invalid = validContent(kind, content, currency);
  if (invalid) return refuse(invalid);

  if (input.opportunityId) {
    const opportunity = await getOpportunity(input.opportunityId);
    if (!opportunity || opportunity.projectId !== input.projectId) return refuse('No opening with that id.');
  }
  if (input.conversationId) {
    const conversation = await getConversation(input.conversationId);
    if (!conversation || conversation.projectId !== input.projectId) {
      return refuse('That conversation is not about this project.');
    }
  }

  const provider = providerForKind(kind);
  const connection = (await liveReading(input.projectId, provider))?.connection ?? null;
  const ready = await preconditions({ projectId: input.projectId, kind, destination, connection });
  if (!ready.ok) return ready;

  if (kind === 'NOTIFY_OWNER') {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    if ((await countSentSince(ready.connection.id, since)) >= MAX_NOTIFICATIONS_PER_DAY) {
      return refuse(`This project has sent ${MAX_NOTIFICATIONS_PER_DAY} notifications in a day, which is the bound.`);
    }
  }

  const amountCents =
    kind === 'ISSUE_INVOICE' ? (content.lines ?? []).reduce((sum, line) => sum + line.amountCents, 0) : null;

  const requestKey =
    input.requestKey ??
    requestKeyFor([input.requestedBy, kind, destination, JSON.stringify(content), currency ?? '', input.opportunityId ?? '']);

  const result = await insertAction({
    projectId: input.projectId,
    connectionId: ready.connection.id,
    kind,
    commercialAction: ready.commercialAction,
    opportunityId: input.opportunityId ?? null,
    conversationId: input.conversationId ?? null,
    destination,
    content,
    expectedEffect: describe(kind, destination, content, amountCents, currency),
    amountCents,
    currency,
    // Only the owner's own phone goes without a person. Everything else —
    // including an email to themselves — is shown and approved first.
    approvalRequired: kind !== 'NOTIFY_OWNER',
    requestedByType: input.requestedByType,
    requestedBy: input.requestedBy,
    requestKey,
  });

  if (result.created) {
    await recordExternalEvent({
      projectId: input.projectId,
      actionId: result.action.id,
      connectionId: ready.connection.id,
      kind: 'EXTERNAL_ACTION_PREPARED',
      actorRef: input.requestedBy,
      summary: result.action.expectedEffect,
      detail: { kind, approvalRequired: result.action.approvalRequired, commercialAction: ready.commercialAction },
    });
    await recordEvent({
      projectId: input.projectId,
      entityType: 'external_action',
      entityId: result.action.id,
      eventType: 'EXTERNAL_ACTION_PREPARED',
      payload: { kind, state: result.action.state, requestedByType: input.requestedByType },
    });    // Said where it was asked for, before anything happens: what exactly will
    // be done, and that nothing has been yet.
    if (input.conversationId && result.action.approvalRequired) {
      await addMessage({
        conversationId: input.conversationId,
        role: 'SYSTEM',
        content:
          `Prepared, not sent: ${result.action.expectedEffect} It waits for an administrator of ` +
          'this project to approve exactly this on External actions.',
        metadata: { externalActionId: result.action.id, state: result.action.state },
      });
    }
  }
  return { ok: true, action: result.action, created: result.created };
}

/** A key from server facts, so the same ask prepared twice is one action. */
export function requestKeyFor(parts: readonly string[]): string {
  return 'prep:' + crypto.createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 40);
}

export async function approveAction(input: {
  actionId: string;
  approverUserId: string;
}): Promise<{ ok: true; action: ExternalAction } | Refusal> {
  const action = await getAction(input.actionId);
  if (!action) return refuse('No action with that id.');
  if (action.state !== 'AWAITING_APPROVAL') {
    return refuse(`This action is ${action.state.toLowerCase()}, so there is nothing to approve.`);
  }
  // Asked again: approval is a decision about now, not about when it was prepared.
  const ready = await preconditions({
    projectId: action.projectId,
    kind: action.kind,
    destination: action.destination,
    connection: await getConnection(action.connectionId),
  });
  if (!ready.ok) return ready;

  const at = new Date().toISOString();
  const moved = await moveAction({
    id: action.id,
    from: ['AWAITING_APPROVAL'],
    to: 'APPROVED',
    patch: { approved_by: input.approverUserId, approved_at: at, next_attempt_at: at },
  });
  if (!moved) return refuse('Somebody else acted on this at the same moment.');
  await recordExternalEvent({
    projectId: action.projectId,
    actionId: action.id,
    kind: 'EXTERNAL_ACTION_APPROVED',
    actorRef: input.approverUserId,
    summary: `Approved: ${action.expectedEffect}`,
  });
  await recordEvent({
    projectId: action.projectId,
    entityType: 'external_action',
    entityId: action.id,
    eventType: 'EXTERNAL_ACTION_APPROVED',
    payload: { kind: action.kind },
  });
  return { ok: true, action: (await getAction(action.id))! };
}

export async function cancelAction(input: {
  actionId: string;
  actorRef: string;
  reason: string;
}): Promise<{ ok: true } | Refusal> {
  const action = await getAction(input.actionId);
  if (!action) return refuse('No action with that id.');
  // Only before anything left: an action that may have been sent is resolved,
  // not cancelled, because cancelling it would un-say something that happened.
  const moved = await moveAction({
    id: action.id,
    from: ['AWAITING_APPROVAL', 'APPROVED'],
    to: 'CANCELLED',
    patch: { outcome_detail: `Cancelled before sending: ${input.reason}`, resolved_by: input.actorRef },
  });
  if (!moved) return refuse(`This action is ${action.state.toLowerCase()}; only one that has not been sent can be cancelled.`);
  await recordExternalEvent({
    projectId: action.projectId,
    actionId: action.id,
    kind: 'EXTERNAL_ACTION_CANCELLED',
    actorRef: input.actorRef,
    summary: `Cancelled before sending: ${input.reason}`,
  });
  await returnResult(action.id);
  return { ok: true };
}

/**
 * A person's answer to an UNCERTAIN send.
 *
 * `HAPPENED` needs the provider's own identifier, because a person saying it
 * happened is a claim and the identifier is what Brain then reads back.
 * `DID_NOT_HAPPEN` closes it as failed and never resends: a person who wants
 * it sent prepares it again, deliberately.
 */
export async function resolveUncertain(input: {
  actionId: string;
  actorRef: string;
  outcome: 'HAPPENED' | 'DID_NOT_HAPPEN';
  providerRef?: string | null;
  note: string;
}): Promise<{ ok: true } | Refusal> {
  const action = await getAction(input.actionId);
  if (!action) return refuse('No action with that id.');
  if (action.state !== 'UNCERTAIN') return refuse('Only an action whose outcome is unknown can be resolved.');
  if (input.outcome === 'HAPPENED') {
    const ref = input.providerRef?.trim();
    if (!ref || !/^[A-Za-z0-9_.:-]{3,120}$/.test(ref)) {
      return refuse('Say which provider identifier shows it happened; Brain reads that back rather than taking it on trust.');
    }
    const moved = await moveAction({
      id: action.id,
      from: ['UNCERTAIN'],
      to: 'CONFIRMED',
      patch: { provider_ref: ref, outcome_detail: `Resolved by a person: ${input.note}`, resolved_by: input.actorRef },
    });
    if (!moved) return refuse('Somebody else resolved this at the same moment.');
    await readBack(action.id);
  } else {
    const moved = await moveAction({
      id: action.id,
      from: ['UNCERTAIN'],
      to: 'FAILED',
      patch: { outcome_detail: `Resolved by a person as not having happened: ${input.note}`, resolved_by: input.actorRef },
    });
    if (!moved) return refuse('Somebody else resolved this at the same moment.');
  }
  await recordExternalEvent({
    projectId: action.projectId,
    actionId: action.id,
    kind: 'EXTERNAL_ACTION_RESOLVED',
    actorRef: input.actorRef,
    summary: `${input.outcome === 'HAPPENED' ? 'Resolved as sent' : 'Resolved as not sent'}: ${input.note}`,
  });
  await returnResult(action.id);
  return { ok: true };
}

function backoff(attempts: number, retryAfterSeconds: number | null): string {
  const minutes = [1, 5, 15, 60, 240][Math.min(attempts - 1, 4)] ?? 240;
  const ms = Math.max(minutes * 60_000, (retryAfterSeconds ?? 0) * 1000);
  return new Date(Date.now() + ms).toISOString();
}

export interface ExecutionReport {
  actionId: string;
  state: string;
  detail: string;
}

/**
 * Send one approved action, exactly once, and record what happened.
 *
 * Claimed with a compare-and-swap from APPROVED to SENDING, so two ticks and a
 * person's approval arriving together send once. A stale SENDING row — an
 * executor that died mid-send — is re-entered here too, and Step 6's recovery
 * decides from its attempt rows whether that is a resend (only for a provider
 * that de-duplicates by key), a reconciliation, or UNCERTAIN.
 */
export async function executeAction(actionId: string, now = new Date()): Promise<ExecutionReport> {
  const action = await getAction(actionId);
  if (!action) return { actionId, state: 'MISSING', detail: 'No such action.' };

  const staleSending =
    action.state === 'SENDING' && now.getTime() - Date.parse(action.updatedAt) > SENDING_STALE_MS;
  if (action.state === 'APPROVED') {
    if (action.nextAttemptAt && Date.parse(action.nextAttemptAt) > now.getTime()) {
      return { actionId, state: action.state, detail: `Waiting until ${action.nextAttemptAt}.` };
    }
  } else if (!staleSending) {
    return { actionId, state: action.state, detail: 'Not waiting to be sent.' };
  }

  const connection = await getConnection(action.connectionId);
  const ready = await preconditions({
    projectId: action.projectId,
    kind: action.kind,
    destination: action.destination,
    connection,
  });
  if (!ready.ok) {
    if (action.state === 'SENDING') {
      // Something may already be out there; do not pretend otherwise.
      await moveAction({ id: action.id, from: ['SENDING'], to: 'UNCERTAIN', patch: { outcome_detail: `An earlier send may have left, and it cannot be re-checked: ${ready.reason}` } });
      await returnResult(action.id);
      return { actionId, state: 'UNCERTAIN', detail: ready.reason };
    }
    // Nothing has been sent. A condition that can recover (a stale check) waits;
    // one a person must change (a withdrawn grant, a revoked connection) stops.
    const recoverable = !!ready.need && /Check/.test(ready.need) && connection?.state === 'ACTIVE';
    if (recoverable && action.attempts < MAX_SEND_ATTEMPTS) {
      await moveAction({ id: action.id, from: ['APPROVED'], to: 'APPROVED', patch: { next_attempt_at: backoff(action.attempts + 1, null), attempts: action.attempts + 1, outcome_detail: `Not sent yet: ${ready.reason}` } });
      return { actionId, state: 'APPROVED', detail: ready.reason };
    }
    await moveAction({ id: action.id, from: ['APPROVED'], to: 'FAILED', patch: { outcome_detail: `Not sent, and nothing left Brain: ${ready.reason}` } });
    await returnResult(action.id);
    return { actionId, state: 'FAILED', detail: ready.reason };
  }

  /*
   * A repeat is safe only while the provider still remembers the key. Resend
   * and Stripe de-duplicate for about a day; an action that first left longer
   * ago than that and is being tried again — a restart after a long outage, a
   * stale SENDING row found late — would be a second email or a second invoice
   * wearing the first one's key. It stops at UNCERTAIN for a person instead.
   */
  const window = driverFor(ready.connection.provider).keyWindowMs;
  if (window !== null) {
    const first = await firstSentAt(action.id);
    if (first && now.getTime() - Date.parse(first) > window - KEY_WINDOW_MARGIN_MS) {
      await moveAction({
        id: action.id,
        from: ['APPROVED', 'SENDING'],
        to: 'UNCERTAIN',
        patch: {
          outcome_detail:
            'An earlier attempt left Brain long enough ago that the provider may have forgotten its key, ' +
            'so repeating it could be a second effect. It will not be resent automatically.',
        },
      });
      await returnResult(action.id);
      return { actionId, state: 'UNCERTAIN', detail: 'Outside the provider’s key window.' };
    }
  }

  if (action.state === 'APPROVED') {
    const claimed = await moveAction({
      id: action.id,
      from: ['APPROVED'],
      to: 'SENDING',
      patch: { attempts: action.attempts + 1 },
    });
    if (!claimed) return { actionId, state: 'LOST_RACE', detail: 'Another executor took it.' };
  }

  if (staleSending) {
    await releaseAbandonedOperation({
      actionId: action.id,
      untouchedSince: new Date(now.getTime() - SENDING_STALE_MS).toISOString(),
      at: new Date().toISOString(),
    });
  }

  const secret = readSecret(ready.connection);
  if (!secret) {
    await moveAction({ id: action.id, from: ['SENDING'], to: 'APPROVED', patch: { next_attempt_at: backoff(action.attempts + 1, null) } });
    return { actionId, state: 'APPROVED', detail: 'The credential is not deployed.' };
  }
  const current = (await getAction(action.id))!;
  const adapter = driverFor(ready.connection.provider).adapter({ secret, connection: ready.connection, action: current });

  let outcome;
  try {
    outcome = await runExternalEffect({
      adapter,
      namespace: { name: adapter.namespace, version: 1, principalScope: 'PROJECT', retention: 'PERMANENT' },
      projectId: action.projectId,
      // From the action and nothing else: stable across every attempt (§20).
      key: `xac.${action.id}`,
      businessId: action.id,
      payload: {
        actionId: action.id,
        kind: action.kind,
        destination: action.destination,
        content: action.content,
        amountCents: action.amountCents,
        currency: action.currency,
      },
      principalType: 'SYSTEM',
      principalId: SYSTEM_ACTOR,
      correlationId: action.id,
    });
  } catch (error) {
    if (error instanceof OperationInProgress) {
      return { actionId, state: 'SENDING', detail: 'Another executor holds this operation right now.' };
    }
    /*
     * Something threw inside the effect engine. Whether that is "unknown" or
     * "nothing happened" is a question about the attempt rows, not about the
     * exception: an attempt that reached SENT means something may be out
     * there; none means nothing left Brain, and the action can wait and be
     * tried again without any risk of a second effect.
     */
    if (await anythingSent(action.id)) {
      await moveAction({ id: action.id, from: ['SENDING'], to: 'UNCERTAIN', patch: { outcome_detail: 'The send could not be classified after it left.' } });
      await returnResult(action.id);
      return { actionId, state: 'UNCERTAIN', detail: 'The send could not be classified.' };
    }
    const reason = error instanceof Error ? error.name : 'an internal error';
    if (current.attempts < MAX_SEND_ATTEMPTS) {
      await moveAction({ id: action.id, from: ['SENDING'], to: 'APPROVED', patch: { next_attempt_at: backoff(current.attempts, null), outcome_detail: `Not sent: ${reason} before anything left Brain.` } });
      return { actionId, state: 'APPROVED', detail: reason };
    }
    await moveAction({ id: action.id, from: ['SENDING'], to: 'FAILED', patch: { outcome_detail: `Not sent, and nothing left Brain: ${reason}.` } });
    await returnResult(action.id);
    return { actionId, state: 'FAILED', detail: reason };
  }

  switch (outcome.status) {
    case 'CONFIRMED':
    case 'RECONCILED':
    case 'REPLAYED': {
      const ref = outcome.status === 'REPLAYED' ? outcome.operation.resultRef : outcome.receiptRef;
      if (!ref) {
        await moveAction({ id: action.id, from: ['SENDING'], to: 'UNCERTAIN', patch: { operation_id: outcome.operation.id, outcome_detail: 'The operation completed without a receipt, so what it did is not known.' } });
        await returnResult(action.id);
        return { actionId, state: 'UNCERTAIN', detail: 'No receipt.' };
      }
      await moveAction({
        id: action.id,
        from: ['SENDING', 'UNCERTAIN'],
        to: 'CONFIRMED',
        patch: {
          operation_id: outcome.operation.id,
          provider_ref: ref,
          outcome_detail:
            outcome.status === 'RECONCILED'
              ? 'The send was ambiguous; the provider was asked and confirmed it.'
              : 'The provider accepted it and returned its own identifier.',
        },
      });
      await readBack(action.id);
      await returnResult(action.id);
      return { actionId, state: 'CONFIRMED', detail: ref };
    }
    case 'FAILED': {
      const op = outcome.operation;
      // Step 6 leaves a failure it may repeat RESERVED (the provider definitely
      // did nothing, or de-duplicates on the key) and closes one it may not.
      const retryable = op.state === 'RESERVED';
      const detail = `The provider refused it (${op.failureCategory ?? 'unknown category'}).`;
      if (retryable && current.attempts < MAX_SEND_ATTEMPTS) {
        await moveAction({ id: action.id, from: ['SENDING'], to: 'APPROVED', patch: { operation_id: op.id, next_attempt_at: backoff(current.attempts, null), outcome_detail: `${detail} It will be tried again under the same key.` } });
        return { actionId, state: 'APPROVED', detail };
      }
      await moveAction({ id: action.id, from: ['SENDING'], to: 'REFUSED', patch: { operation_id: op.id, outcome_detail: detail } });
      await returnResult(action.id);
      return { actionId, state: 'REFUSED', detail };
    }
    case 'UNCERTAIN': {
      await moveAction({ id: action.id, from: ['SENDING'], to: 'UNCERTAIN', patch: { operation_id: outcome.operation.id, outcome_detail: `Unknown whether it happened: ${outcome.reason}. It will not be resent automatically.` } });
      await returnResult(action.id);
      return { actionId, state: 'UNCERTAIN', detail: outcome.reason };
    }
  }
}

/**
 * Ask the provider again about a send whose outcome is unknown.
 *
 * Only for an adapter that can be asked. Step 6 answers an operation already
 * UNCERTAIN by reconciling and never by sending, so this cannot produce a
 * second effect; it can only turn "unknown" into "it happened", with the
 * provider's own identifier.
 */
export async function reaskUncertain(actionId: string): Promise<boolean> {
  const action = await getAction(actionId);
  if (!action || action.state !== 'UNCERTAIN' || !action.operationId) return false;
  const connection = await getConnection(action.connectionId);
  if (!connection) return false;
  const secret = readSecret(connection);
  if (!secret) return false;
  const adapter = driverFor(connection.provider).adapter({ secret, connection, action });
  if (adapter.effectClass !== 'EXTERNAL_RECONCILABLE') return false;
  let outcome;
  try {
    outcome = await runExternalEffect({
      adapter,
      namespace: { name: adapter.namespace, version: 1, principalScope: 'PROJECT', retention: 'PERMANENT' },
      projectId: action.projectId,
      key: `xac.${action.id}`,
      businessId: action.id,
      payload: {
        actionId: action.id,
        kind: action.kind,
        destination: action.destination,
        content: action.content,
        amountCents: action.amountCents,
        currency: action.currency,
      },
      principalType: 'SYSTEM',
      principalId: SYSTEM_ACTOR,
      correlationId: action.id,
    });
  } catch {
    return false;
  }
  if (outcome.status !== 'RECONCILED') return false;
  const moved = await moveAction({
    id: action.id,
    from: ['UNCERTAIN'],
    to: 'CONFIRMED',
    patch: { provider_ref: outcome.receiptRef, outcome_detail: 'The outcome was unknown; the provider was asked later and confirmed it.' },
  });
  if (!moved) return false;
  await readBack(action.id);
  await announce(action.id, resultSentence((await getAction(action.id))!));
  return true;
}

/** When the first attempt at this action left Brain, if one did. */
async function firstSentAt(actionId: string): Promise<string | null> {
  const row = await getDb().get<{ at: string | null }>(
    "SELECT MIN(started_at) AS at FROM effect_attempts WHERE request_id = ? AND phase <> 'INTENT'",
    [actionId],
  );
  return row?.at ?? null;
}

/** Whether any attempt at this action reached the provider. */
async function anythingSent(actionId: string): Promise<boolean> {
  const row = await getDb().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM effect_attempts WHERE request_id = ? AND phase <> 'INTENT'",
    [actionId],
  );
  return Number(row?.n ?? 0) > 0;
}

/**
 * Ask the provider what the effect produced, and record it if it moved.
 *
 * Returns the new state when it changed — which is what decides whether the
 * originating conversation is told something new.
 */
export async function readBack(actionId: string): Promise<string | null> {
  const action = await getAction(actionId);
  if (!action || action.state !== 'CONFIRMED' || !action.providerRef) return null;
  const connection = await getConnection(action.connectionId);
  if (!connection) return null;
  const secret = readSecret(connection);
  if (!secret) {
    await recordReadback({ id: action.id, state: action.readbackState ?? 'UNREADABLE', detail: 'The credential is no longer deployed, so the provider cannot be asked.', final: false });
    return null;
  }
  let answer;
  try {
    answer = await driverFor(connection.provider).readback({ secret, connection, action });
  } catch (error) {
    await recordReadback({ id: action.id, state: action.readbackState ?? 'UNREADABLE', detail: error instanceof Error ? error.message : 'The provider could not be asked.', final: false });
    return null;
  }
  const previous = action.readbackState;
  await recordReadback({ id: action.id, state: answer.state, detail: answer.detail, final: answer.final });

  // Asked on every read-back rather than only when the state moved: each entry
  // is keyed, so a second pass writes nothing, and a pass whose entry was
  // refused (no sprint yet, no ACCEPT_PAYMENT grant) is retried next time
  // instead of being lost behind an unchanged state.
  await recordLedgerFacts(action, connection, answer);

  if (previous === answer.state) return null;

  await recordExternalEvent({
    projectId: action.projectId,
    actionId: action.id,
    kind: 'EXTERNAL_ACTION_READ_BACK',
    actorRef: SYSTEM_ACTOR,
    summary: `${answer.state}: ${answer.detail}`,
    detail: { from: previous, to: answer.state },
  });

  if (action.returnedAt) await announce(action.id, `Update: ${answer.detail}`);
  return answer.state;
}

/**
 * Turn a read-back into ledger entries, and only what it establishes.
 *
 * Three separate facts, three separate rows: a payment succeeded
 * (`CUSTOMER_PAYMENT`), the funds became available (`SETTLEMENT`, gross, with
 * the balance transaction as its reference), and what the provider kept
 * (`COST`, the fee, so that available funds come out at the net). An issued
 * invoice and an attempted payment write nothing: neither moved money.
 *
 * Test money is not money, and that is decided twice: the connection must read
 * HEALTHY (a live key the provider answered for), and the provider must say the
 * object itself is live. Either alone can be wrong — a test invoice read back
 * after the secret was rotated to a live key is the case that needs both.
 */
async function recordLedgerFacts(
  action: ExternalAction,
  connection: ExternalConnection,
  answer: { state: string; money?: import('./drivers.ts').Readback['money'] },
): Promise<string[]> {
  const written: string[] = [];
  const money = answer.money;
  if (!money || !action.opportunityId || !action.currency || !action.providerRef) return written;
  if (!money.livemode) return written;
  if ((await readConnection(connection)).state !== 'HEALTHY') return written;
  const mode = await getCashMode(action.projectId);
  if (!mode || mode.currency !== action.currency) return written;
  const paid = money.paidCents ?? 0;
  if (paid <= 0) return written;

  const entries: Array<{ kind: 'CUSTOMER_PAYMENT' | 'SETTLEMENT' | 'COST'; amount: number; reference: string; key: string; note: string }> = [];
  if (answer.state === 'PAYMENT_MADE' || answer.state === 'FUNDS_SETTLED') {
    entries.push({ kind: 'CUSTOMER_PAYMENT', amount: paid, reference: action.providerRef, key: `external:${action.id}:payment`, note: 'Payment read back from the invoice Brain issued.' });
  }
  if (answer.state === 'FUNDS_SETTLED' && money.reference) {
    entries.push({ kind: 'SETTLEMENT', amount: paid, reference: money.reference, key: `external:${action.id}:settlement`, note: 'Funds available in the provider balance, read back.' });
    if (money.feeCents && money.feeCents > 0) {
      entries.push({ kind: 'COST', amount: money.feeCents, reference: money.reference, key: `external:${action.id}:fee`, note: `The provider's processing fee; ${money.netCents ?? paid - money.feeCents} reached the balance.` });
    }
  }
  for (const entry of entries) {
    const result = await recordMoneyEvent({
      projectId: action.projectId,
      opportunityId: action.opportunityId,
      kind: entry.kind,
      amountCents: entry.amount,
      currency: action.currency,
      verifiedReference: entry.reference,
      idempotencyKey: entry.key,
      actorRef: SYSTEM_ACTOR,
      note: entry.note,
    });
    if (result.ok) written.push(entry.kind);
  }
  return written;
}

function resultSentence(action: ExternalAction): string {
  switch (action.state) {
    case 'CONFIRMED':
      /*
       * Accepted, and what reading it back established — two sentences. The
       * expected effect is what was *asked for*; quoting it after "Done" once
       * said an email "is delivered" when the provider had only accepted it.
       */
      return (
        `The provider accepted it and returned its own identifier, ${action.providerRef}. ` +
        (action.readbackState
          ? `Reading it back says ${action.readbackState}: ${action.readbackDetail}`
          : 'Nothing has been read back yet, so what it produced is not established.') +
        ` (What was asked for: ${action.expectedEffect})`
      );
    case 'REFUSED':
      return `Not done: ${action.outcomeDetail ?? 'the provider refused it'}. Nothing was sent.`;
    case 'FAILED':
      return `Not done: ${action.outcomeDetail ?? 'it could not be sent'}`;
    case 'UNCERTAIN':
      return (
        `Unknown: ${action.outcomeDetail ?? 'the send may or may not have happened'} A person resolves it ` +
        'on External actions; Brain will not send it again by itself.'
      );
    case 'CANCELLED':
      return `Cancelled: ${action.outcomeDetail ?? 'nothing was sent'}`;
    default:
      return `This action is ${action.state.toLowerCase()}.`;
  }
}

async function announce(actionId: string, text: string): Promise<void> {
  const action = await getAction(actionId);
  if (!action?.conversationId) return;
  await addMessage({
    conversationId: action.conversationId,
    role: 'SYSTEM',
    content: text,
    metadata: { externalActionId: action.id, state: action.state, readbackState: action.readbackState },
  });
}

/**
 * Put the result where it was asked for, once.
 *
 * The conversation it came from, the opening it was for, and the project's
 * history. `claimReturn` is the compare-and-swap that makes this idempotent:
 * two ticks finishing the same action tell the conversation once.
 */
export async function returnResult(actionId: string): Promise<void> {
  if (!(await claimReturn(actionId))) return;
  const action = (await getAction(actionId))!;
  const sentence = resultSentence(action);

  await recordEvent({
    projectId: action.projectId,
    entityType: 'external_action',
    entityId: action.id,
    eventType: 'EXTERNAL_ACTION_RESULT',
    payload: {
      kind: action.kind,
      state: action.state,
      providerRef: action.providerRef,
      readbackState: action.readbackState,
    },
  });
  await recordExternalEvent({
    projectId: action.projectId,
    actionId: action.id,
    kind: 'EXTERNAL_ACTION_RETURNED',
    actorRef: SYSTEM_ACTOR,
    summary: sentence,
  });
  if (action.conversationId) await announce(action.id, sentence);

  if (action.opportunityId) {
    await recordCashEvent({
      projectId: action.projectId,
      opportunityId: action.opportunityId,
      kind: 'CASH_EXTERNAL_ACTION',
      actorRef: SYSTEM_ACTOR,
      summary: sentence,
      detail: { actionId: action.id, state: action.state, providerRef: action.providerRef },
    });
    // A commercial act that actually happened is the opening's first action.
    if (action.state === 'CONFIRMED' && action.commercialAction) {
      await recordOnOpportunity(action);
    }
  }
}

async function recordOnOpportunity(action: ExternalAction): Promise<void> {
  const opportunity = await getOpportunity(action.opportunityId!);
  if (!opportunity) return;
  const first = {
    action: action.commercialAction!,
    performedBy: 'BRAIN' as const,
    detail: `${action.expectedEffect} Approved by a person; the provider confirmed it.`,
    reference: action.providerRef,
    requestKey: actionKey(opportunity.id, action.commercialAction!, action.id),
  };
  if (opportunity.state === 'READY') {
    await beginExecution({ opportunityId: opportunity.id, actorRef: SYSTEM_ACTOR, firstAction: first });
    return;
  }
  const decision = await checkCommercialAuthority({ projectId: action.projectId, action: first.action });
  if (!decision.ok || !decision.authority) return;
  await recordAction({
    projectId: action.projectId,
    opportunityId: opportunity.id,
    authorityId: decision.authority.id,
    action: first.action,
    performedBy: 'BRAIN',
    reference: first.reference,
    detail: first.detail,
    confirmedBy: SYSTEM_ACTOR,
    requestKey: first.requestKey,
  });
}

/* ------------------------------------------------------------------------- */
/* Telling the owner a decision is waiting                                    */
/* ------------------------------------------------------------------------- */

/**
 * The one workflow this build can run end to end today with no third party.
 *
 * A decision waiting in Brain reaches the owner only if they open Brain. Where
 * a project has a healthy NOTIFY_OWNER connection, each new request for a
 * person — a Needs You card, or an external action waiting for approval — is
 * sent to their phone once, keyed from the request itself. Nothing here
 * contacts anybody else, spends anything or approves anything.
 */
export async function notifyWaitingDecisions(projectId: string): Promise<number> {
  const reading = await liveReading(projectId, 'NTFY');
  if (!reading || reading.state !== 'HEALTHY') return 0;
  let sent = 0;
  const asks: Array<{ key: string; subject: string; body: string }> = [];
  for (const request of await listOpenRequests(projectId)) {
    asks.push({
      key: `notify:request:${request.id}`,
      subject: 'Brain needs a decision',
      body: `${request.authorityNeeded}\n\nOpen Needs you in Brain to answer it.`.slice(0, 1_000),
    });
  }
  for (const action of await listActionsInState(['AWAITING_APPROVAL'], 200)) {
    if (action.projectId !== projectId) continue;
    asks.push({
      key: `notify:approval:${action.id}`,
      subject: 'An action is waiting for your approval',
      body: `${action.expectedEffect}\n\nApprove or cancel it on External actions in Brain.`,
    });
  }
  for (const ask of asks) {
    const prepared = await prepareAction({
      projectId,
      kind: 'NOTIFY_OWNER',
      content: { subject: ask.subject, body: ask.body },
      requestedByType: 'SYSTEM',
      requestedBy: SYSTEM_ACTOR,
      requestKey: ask.key,
    });
    if (prepared.ok && prepared.created) sent += 1;
    if (!prepared.ok) break; // the bound, or the connection went away
  }
  return sent;
}

/* ------------------------------------------------------------------------- */
/* The tick                                                                   */
/* ------------------------------------------------------------------------- */

export interface ExternalTickReport {
  checked: number;
  executed: ExecutionReport[];
  readBack: number;
  notified: number;
}

/**
 * One pass: re-check connections, send what is approved, read back what may
 * still move, and tell owners what is waiting.
 *
 * Derived from rows on every pass rather than hooked to the moment something
 * changed, so it reaches actions a crashed process left behind as well.
 */
export async function externalActionsTick(now = new Date()): Promise<ExternalTickReport> {
  const report: ExternalTickReport = { checked: 0, executed: [], readBack: 0, notified: 0 };
  const projects = new Set<string>();

  for (const connection of await listLiveConnections()) {
    projects.add(connection.projectId);
    if (!readSecret(connection)) continue;
    const reading = await readConnection(connection, now.getTime());
    const last = reading.latest ? Date.parse(reading.latest.checkedAt) : 0;
    if (reading.state === 'CREDENTIAL_CHANGED' || reading.state === 'NOT_CHECKED' || now.getTime() - last > HEALTH_RECHECK_MS) {
      await checkConnection(connection.id, SYSTEM_ACTOR);
      report.checked += 1;
    }
  }

  for (const projectId of projects) {
    report.notified += await notifyWaitingDecisions(projectId);
  }

  for (const action of await listActionsInState(['APPROVED', 'SENDING'], 25)) {
    report.executed.push(await executeAction(action.id, now));
  }
  // A reconcilable send left UNCERTAIN may be answered by asking again —
  // asking is not sending, and `runExternalEffect` refuses to resend it.
  for (const action of await listActionsInState(['UNCERTAIN'], 25)) {
    if (await reaskUncertain(action.id)) report.readBack += 1;
  }
  for (const action of await actionsAwaitingReadback(25)) {
    if (action.readbackAt && now.getTime() - Date.parse(action.readbackAt) < 60_000) continue;
    await readBack(action.id);
    report.readBack += 1;
  }
  return report;
}
