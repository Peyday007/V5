/**
 * The MCP endpoint: one path, `POST /mcp`.
 *
 * This is the only place in Brain that is reachable by a protocol other than
 * its own HTTP API, so it is written to be read by somebody asking "what can
 * get in here". The answer, in order:
 *
 *   1. Nothing without a Brain worker credential in an `Authorization: Bearer`
 *      header. Not a cookie, not a query parameter, not a header naming a
 *      worker.
 *   2. Nothing from a browser origin.
 *   3. Nothing over 1 MiB.
 *   4. Nothing but POST.
 *
 * Only then is the body looked at, and only then does an era get chosen.
 */
import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { authenticateRequest } from '../services/identity/authenticate.ts';
import { recordIdentityEvent } from '../repos/identity.ts';
import { contextFromRequest } from '../services/identity/context.ts';
import type { DenialReason, Principal } from '../domain/types.ts';
import { dispatchModern, type DispatchContext } from './modern.ts';
import { handleLegacy } from './legacy.ts';
import { MAX_REQUEST_BYTES } from './limits.ts';
import {
  INTERNAL_ERROR,
  McpProtocolError,
  TRANSPORT_REFUSED,
  errorResponse,
  invalidRequest,
  parseError,
} from './protocol.ts';
import { idOf, looksModern, validateModernRequest } from './validate.ts';

export const MCP_PATH = '/mcp';

/* ------------------------------------------------------------------------ */
/* Refusals                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * A JSON-RPC error with no `id`, which is what the transport section permits
 * for a refusal that happens before a request has been read.
 */
function refuse(res: Response, status: number, code: number, message: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });
}

/**
 * Audit a refused credential — but not an absent one.
 *
 * A request that *presented* something and was refused is always interesting.
 * A request with no credential at all is usually a scanner or a misconfigured
 * client, and recording every one of those would bury the rows worth reading.
 * That is the same judgement `guard.ts` already makes, for the same reason.
 */
async function auditRefusal(req: Request, reason: DenialReason): Promise<void> {
  const context = contextFromRequest(req);
  try {
    await recordIdentityEvent({
      actorType: 'ANONYMOUS',
      action: 'MCP_AUTHENTICATE',
      targetType: 'ROUTE',
      targetId: `POST ${MCP_PATH}`,
      result: 'DENIED',
      // A category, never what was tried.
      reason,
      requestId: context?.requestId ?? null,
      userAgent: context?.userAgent ?? null,
      remoteAddr: context?.remoteAddr ?? null,
    });
  } catch {
    // An audit that cannot be written must not turn a refusal into something else.
  }
}

/* ------------------------------------------------------------------------ */
/* Origin                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * DNS rebinding, which is the attack the transport section names.
 *
 *   > Servers **MUST** validate the `Origin` header on all incoming
 *   > connections to prevent DNS rebinding attacks. If the `Origin` header is
 *   > present and invalid, servers **MUST** respond with HTTP 403 Forbidden.
 *
 * Brain's rule is the strictest one that is still correct: **no browser origin
 * is valid here.** An MCP client is not a page, nothing in Brain's own UI
 * speaks MCP, and no CORS headers are emitted — so a page on any site,
 * including Brain's own, has no business driving this endpoint. An origin that
 * matches the host is allowed only because refusing it would be refusing a
 * request that could not have been forged cross-site anyway.
 *
 * A *missing* Origin is allowed: `curl`, a worker process and every non-browser
 * client legitimately send none, and the credential here is a bearer token that
 * no browser attaches on anybody's behalf.
 */
function originIsAcceptable(req: Request): boolean {
  const origin = req.header('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* Authentication                                                            */
/* ------------------------------------------------------------------------ */

/**
 * A worker, or nothing.
 *
 * A valid *session cookie* is refused here even though it would authenticate
 * elsewhere. A browser is not an MCP client, and accepting the cookie would put
 * a CSRF-reachable credential on a JSON-RPC endpoint that performs mutations —
 * the exact combination `SameSite=Lax` and the origin check exist to prevent on
 * the HTTP API.
 */
async function principalFor(
  req: Request,
): Promise<{ ok: true; principal: Principal } | { ok: false; reason: DenialReason }> {
  const header = req.header('authorization');
  if (!header) return { ok: false, reason: 'NO_CREDENTIALS' };

  const outcome = await authenticateRequest(req);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  // Two doors, one principal. `WORKER_BEARER` is a credential an administrator
  // issued directly; `OAUTH_BEARER` is a token this Brain minted after a human
  // approved the connection. A session cookie is neither, and is refused below.
  if (outcome.principal.authMethod === 'SESSION_COOKIE') {
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }
  return { ok: true, principal: outcome.principal };
}

/* ------------------------------------------------------------------------ */
/* The router                                                                */
/* ------------------------------------------------------------------------ */

/**
 * A body parser scoped to this endpoint, with this endpoint's bound.
 *
 * Mounted here rather than relying on the application-wide parser because that
 * one allows 10 MiB for prompts and pasted audit text. A tool call is
 * arguments; nothing about MCP needs to carry bytes.
 */
const parseBody = express.json({ limit: MAX_REQUEST_BYTES, type: 'application/json' });

function bodyErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!error) {
    next();
    return;
  }
  const failure = error as { type?: string; status?: number };
  if (failure.type === 'entity.too.large') {
    refuse(res, 413, TRANSPORT_REFUSED, 'That request is too large.');
    return;
  }
  if (failure.type === 'entity.parse.failed') {
    const parsed = parseError('That request body is not valid JSON.');
    res.status(parsed.status).json(errorResponse(null, parsed));
    return;
  }
  next(error);
}

export function mcpRouter(): Router {
  const router = Router();

  /**
   * The removed methods.
   *
   * `2026-07-28` deleted the GET stream and, with sessions, the DELETE that
   * terminated them. The revision names the response for a server that receives
   * such traffic from an older client: `405 Method Not Allowed`. Answering
   * anything else — a 404, a silent 200 — would leave a dual-era client unable
   * to tell "this server has moved on" from "this is not an MCP endpoint".
   */
  router.get('/', (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST');
    refuse(res, 405, TRANSPORT_REFUSED, 'This MCP endpoint accepts POST only. The GET stream was removed in 2026-07-28.');
  });

  router.delete('/', (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST');
    refuse(res, 405, TRANSPORT_REFUSED, 'This MCP endpoint accepts POST only. Sessions were removed in 2026-07-28.');
  });

  router.post('/', parseBody, bodyErrorHandler, (req: Request, res: Response) => {
    void (async (): Promise<void> => {
      // Origin before authentication: a rebinding attempt should not get to
      // present a credential and learn whether it was any good.
      if (!originIsAcceptable(req)) {
        refuse(res, 403, TRANSPORT_REFUSED, 'That origin may not reach this endpoint.');
        return;
      }

      /**
       * An `Idempotency-Key` header is refused, not ignored.
       *
       * On the HTTP API that header names one request and Step 6 honours it.
       * Here it would name one *POST*, and a POST is a transport frame rather
       * than an effect — the effect is the tool call inside it, and its key is
       * derived from the work item. Silently ignoring the header would leave
       * the caller believing it has idempotency at the transport level when
       * the guarantee actually lives a layer down and is keyed differently.
       *
       * That is the same reasoning `effects/http.ts` applies to a key in a
       * query string, and the same conclusion: refuse, so the caller finds out.
       * The `idempotency_key` *tool argument* is the supported way to say this.
       */
      if (req.header('idempotency-key') !== undefined) {
        refuse(
          res,
          400,
          TRANSPORT_REFUSED,
          'An Idempotency-Key header is not honoured on this endpoint. Pass idempotency_key ' +
            'as a tool argument instead: the key belongs to the effect, not to the POST.',
        );
        return;
      }

      let auth: Awaited<ReturnType<typeof principalFor>>;
      try {
        auth = await principalFor(req);
      } catch {
        // Fail closed. Not being able to tell who this is is not permission.
        refuse(res, 503, TRANSPORT_REFUSED, 'Not authorized.');
        return;
      }

      if (!auth.ok) {
        if (auth.reason !== 'NO_CREDENTIALS') await auditRefusal(req, auth.reason);
        /**
         * The discovery pointer, which Step 7 deliberately did not emit.
         *
         * Step 7's reasoning was sound for what it knew: advertising OAuth that
         * does not exist sends a client round a flow that cannot end in a
         * usable token. Step 8 built the flow, so the pointer is now true — and
         * it is the *only* way a conformant MCP client discovers where to
         * authenticate. Without it Claude's connector has nothing to go on and
         * simply fails.
         *
         * The refusal itself is unchanged: one sentence, and "invalid",
         * "expired", "revoked" and "unknown" are still the same message.
         */
        const issuer = `${req.protocol}://${req.get('host') ?? 'localhost'}`;
        res.setHeader(
          'WWW-Authenticate',
          `Bearer realm="brain", resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
        );
        refuse(res, 401, TRANSPORT_REFUSED, 'Not authorized. Connect through this Brain, or present a worker credential.');
        return;
      }

      const context = contextFromRequest(req);
      const dispatch: DispatchContext = {
        principal: auth.principal,
        requestId: context?.requestId ?? 'mcp',
        userAgent: context?.userAgent ?? null,
        remoteAddr: context?.remoteAddr ?? null,
      };

      const body: unknown = req.body;

      // A batch is refused before either era sees it. The revision defines one
      // request or notification per POST, and the mirrored headers describe a
      // single message — a batch would make `Mcp-Method` meaningless and the
      // header-body validation unenforceable.
      if (Array.isArray(body)) {
        const error = invalidRequest('This revision defines one request per POST, not a batch.');
        res.status(error.status).json(errorResponse(null, error));
        return;
      }

      /**
       * Choosing an era.
       *
       * Exactly the rule the versioning page gives for a dual-era server: a
       * request carrying modern per-request `_meta` is served statelessly by
       * this revision, and anything else — `initialize` included — selects
       * legacy semantics.
       */
      if (!looksModern(body)) {
        try {
          await handleLegacy(req, res, body, dispatch);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('[mcp] legacy dispatch failed', error);
          if (!res.headersSent) refuse(res, 500, INTERNAL_ERROR, 'That request could not be served.');
        }
        return;
      }

      try {
        const request = validateModernRequest(req, body);
        const response = await dispatchModern(request, dispatch);
        if (!response) {
          // A notification the server accepted. `202 Accepted` with no body, as
          // the transport section requires.
          res.status(202).end();
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json(response);
      } catch (error) {
        if (error instanceof McpProtocolError) {
          // The status is normative and paired with the code: a dual-era client
          // reads exactly this pairing to decide whether to retry with another
          // version or fall back to `initialize`.
          res.status(error.status).json(errorResponse(idOf(body), error));
          return;
        }
        // eslint-disable-next-line no-console
        console.error('[mcp] modern dispatch failed', error);
        res.status(500).json(
          errorResponse(idOf(body), new McpProtocolError(INTERNAL_ERROR, 500, 'That request could not be served.')),
        );
      }
    })();
  });

  return router;
}
