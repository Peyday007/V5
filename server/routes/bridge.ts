/**
 * The conversation entrance's door.
 *
 * ---------------------------------------------------------------------------
 * Two kinds of caller, and why they are told apart by credential
 * ---------------------------------------------------------------------------
 *
 * **A person in a browser** manages their own credentials here, over the
 * session cookie, exactly as they manage their passkeys. Issuing one is
 * `requirePerson` and the subject is the **authenticated principal** — there is
 * no path segment naming a user, so there is no id somebody could substitute to
 * mint a credential for anybody else.
 *
 * **A conversation client** presents that credential as a bearer and reaches
 * only the sync and read routes. It resolves to the same person, so every
 * project decision it meets is the one that person already had — this is a way
 * *in* and not a way around, which is §21's own sentence at a new door.
 *
 * Both are `requirePerson`, so a **worker principal is refused by type** at
 * every route including the reads. A machine that could write into somebody's
 * conversation could put words in their mouth, and §22's split exists to stop
 * exactly that.
 *
 * ---------------------------------------------------------------------------
 * What a bridge credential cannot do
 * ---------------------------------------------------------------------------
 *
 * It is not an administrator however its holder's account is configured:
 * `authenticateBridge` writes `isBrainAdmin: false` unconditionally. So
 * everything an administrator may do stays behind the cookie, and a leaked
 * bridge key loses that person's conversations and nothing else.
 *
 * It also cannot mint another credential. Issuing is cookie-only, asserted by a
 * test, because a key that could mint keys is a key that cannot be revoked.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalString,
  pathId,
  requiredEnum,
  requiredString,
  requirePerson,
} from './helpers.ts';
import { BRIDGE_ROLES, BRIDGE_SOURCES, type BridgeRole, type BridgeSource } from '../domain/register.ts';
import {
  getBridgeConversation,
  insertBridgeCredential,
  listBridgeConversations,
  listBridgeCredentials,
  revokeBridgeCredential,
} from '../repos/bridge.ts';
import { generateBridgeCredential } from '../services/identity/secrets.ts';
import { syncConversation, transcriptOf, type IncomingMessage } from '../services/bridge/sync.ts';
import { statusFor } from '../services/bridge/status.ts';
import { parseTranscript } from '../services/bridge/import.ts';
import { currentPrincipal } from '../services/identity/context.ts';

export const bridgeRouter: Router = Router();

/**
 * Issuing is cookie-only, and that is the control rather than a convention.
 *
 * A bridge credential that could mint another bridge credential would survive
 * its own revocation: revoke the one you know about, and the one it made is
 * still there. So the mint refuses any caller that arrived on one.
 */
function requireBrowserSession(): void {
  const principal = currentPrincipal();
  /*
   * Named positively, for the reason `/mcp`'s door had to be corrected.
   *
   * Written as *refuse `BRIDGE_BEARER`* this would be right today and wrong the
   * day a fifth authentication method exists — a door that names its exception
   * admits everything nobody thought of. So it names the one method it admits,
   * and anything else is refused until somebody writes it in.
   */
  if (!principal || principal.authMethod !== 'SESSION_COOKIE') {
    throw notFound('No such route.');
  }
}

bridgeRouter.get(
  '/bridge/credentials',
  handler(async () => {
    const principal = requirePerson();
    return { credentials: await listBridgeCredentials(principal.id) };
  }),
);

/**
 * Mint one. Shown exactly once.
 *
 * The plaintext is returned in this response and is recoverable afterwards by
 * nobody, including an administrator — the row holds a sha-256 digest and
 * nothing else. §17's rule, at the fifth door in this Brain built that way.
 */
bridgeRouter.post(
  '/bridge/credentials',
  handler(async (req) => {
    requireBrowserSession();
    const principal = requirePerson();
    const body = bodyOf(req);
    const label = requiredString(body.label, 'label');
    const expiresAt = optionalString(body.expiresAt, 'expiresAt') ?? null;

    const generated = generateBridgeCredential();
    const credential = await insertBridgeCredential({
      userId: principal.id,
      label,
      prefix: generated.prefix,
      verifier: generated.digest,
      expiresAt,
    });
    return {
      credential,
      // The only time this value exists anywhere outside the holder's hands.
      secret: generated.plaintext,
      shownOnce: true,
    };
  }),
);

bridgeRouter.post(
  '/bridge/credentials/:credentialId/revoke',
  handler(async (req) => {
    requireBrowserSession();
    const principal = requirePerson();
    const reason = requiredString(bodyOf(req).reason, 'reason');
    const revoked = await revokeBridgeCredential(pathId(req, 'credentialId'), principal.id, reason);
    // Unknown and already-revoked are one answer, so a caller cannot use this
    // to learn whether somebody else's credential id exists.
    return { revoked };
  }),
);

bridgeRouter.get(
  '/bridge/conversations',
  handler(async () => {
    const principal = requirePerson();
    return { conversations: await listBridgeConversations(principal.id) };
  }),
);

/**
 * Submit or synchronize a transcript.
 *
 * Idempotent by the batch's own content against a server-built scope, so a
 * retry after a lost response returns the receipt the first attempt produced
 * rather than delivering twice. See `sync.ts` for why the key is built the way
 * it is and what "idempotent" means precisely here.
 */
bridgeRouter.post(
  '/bridge/conversations/sync',
  handler(async (req) => {
    const principal = requirePerson();
    const body = bodyOf(req);

    const raw = body.messages;
    if (!Array.isArray(raw)) throw badRequest('"messages" must be an array.');

    const messages: IncomingMessage[] = raw.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw badRequest(`"messages[${index}]" must be an object.`);
      }
      const one = entry as Record<string, unknown>;
      const ordinal = one.ordinal;
      if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0) {
        throw badRequest(
          `"messages[${index}].ordinal" must be the message's own position in the conversation, from zero.`,
        );
      }
      return {
        ordinal,
        role: requiredEnum<BridgeRole>(one.role, BRIDGE_ROLES as readonly BridgeRole[], `messages[${index}].role`),
        content: requiredString(one.content, `messages[${index}].content`),
        externalId: optionalString(one.externalId, `messages[${index}].externalId`) ?? null,
        authorLabel: optionalString(one.authorLabel, `messages[${index}].authorLabel`) ?? null,
        saidAt: optionalString(one.saidAt, `messages[${index}].saidAt`) ?? null,
      };
    });

    const result = await syncConversation({
      principal,
      source: requiredEnum<BridgeSource>(
        body.source,
        BRIDGE_SOURCES as readonly BridgeSource[],
        'source',
      ),
      externalId: requiredString(body.externalId, 'externalId'),
      title: requiredString(body.title, 'title'),
      messages,
      interpret: body.interpret !== false,
    });

    return {
      conversationId: result.conversation.id,
      russellConversationId: result.conversation.russellConversationId,
      receipt: result.receipt,
      /*
       * False means this exact delivery had already been performed and the
       * receipt above is the one it produced. It is reported rather than
       * hidden: a client that cannot tell a replay from a delivery cannot tell
       * whether its retry worked.
       */
      performed: result.performed,
    };
  }),
);

/**
 * Import a pasted or exported conversation.
 *
 * The same storage path as a live sync — there is no second entrance with its
 * own rules. What differs is only the reading that turned a blob into turns,
 * and which reading happened is reported, because a paste stored as one
 * unknown-role passage and a parsed export are very different things to a
 * person deciding whether the import worked.
 *
 * `interpret` defaults to **false** here. An import is usually history, and
 * opening a turn on a six-month-old question would ask a worker to answer
 * something nobody is asking.
 */
bridgeRouter.post(
  '/bridge/conversations/import',
  handler(async (req) => {
    const principal = requirePerson();
    const body = bodyOf(req);
    const parsed = parseTranscript({
      body: requiredString(body.body, 'body'),
      title: optionalString(body.title, 'title'),
    });

    if (parsed.messages.length === 0) {
      throw badRequest('There was nothing readable in that.');
    }

    const result = await syncConversation({
      principal,
      source: 'IMPORT',
      externalId:
        optionalString(body.externalId, 'externalId') ??
        parsed.externalId ??
        `paste:${new Date().toISOString()}`,
      title: parsed.title,
      messages: parsed.messages,
      interpret: body.interpret === true,
    });

    return {
      conversationId: result.conversation.id,
      russellConversationId: result.conversation.russellConversationId,
      receipt: result.receipt,
      performed: result.performed,
      format: parsed.format,
      /* What could not be read, said plainly rather than left out. */
      notes: parsed.notes,
    };
  }),
);

/** The transcript as Brain holds it, with superseded revisions on request. */
bridgeRouter.get(
  '/bridge/conversations/:conversationId/transcript',
  handler(async (req) => {
    const conversation = await requireOwn(pathId(req, 'conversationId'));
    return {
      conversation,
      messages: await transcriptOf(conversation.id, {
        includeSuperseded: req.query.history === 'true',
      }),
    };
  }),
);

/** The return path: what Brain did with what was said. */
bridgeRouter.get(
  '/bridge/conversations/:conversationId/status',
  handler(async (req) => {
    const conversation = await requireOwn(pathId(req, 'conversationId'));
    return await statusFor(conversation);
  }),
);

/**
 * A conversation this caller owns, or a miss.
 *
 * Owned, not readable: a bridge conversation is somebody's own thread, and a
 * shared project does not make it somebody else's to read — the same line §34
 * draws between a shared frontier and a private job. Absent and forbidden are
 * one answer with one body.
 */
async function requireOwn(id: string) {
  const principal = requirePerson();
  const conversation = await getBridgeConversation(id);
  if (!conversation || conversation.ownerUserId !== principal.id) {
    throw notFound('No such conversation.');
  }
  return conversation;
}
