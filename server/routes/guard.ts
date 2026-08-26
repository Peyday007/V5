/**
 * The middleware that decides whether a request gets any further.
 *
 * Order matters and is the whole design:
 *
 *   1. establish the request context, so everything downstream — including the
 *      resolvers in `helpers.ts` — can find out who is asking;
 *   2. authenticate, from server-held rows only;
 *   3. refuse, unless this exact path is one of the two that may be reached
 *      without credentials.
 *
 * Deny by default is not a slogan here: the allowlist is a literal set of two
 * entries, everything else falls through to a refusal, and a route added
 * tomorrow is protected because it was never given a way not to be.
 *
 * The static client is deliberately *outside* this. A person who is not signed
 * in has to be able to load the page that lets them sign in, and the bundle
 * contains no project data — it is a program that asks the API for everything,
 * and the API is behind this.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { DenialReason } from '../domain/types.ts';
import { recordIdentityEvent } from '../repos/identity.ts';
import {
  authenticateRequest,
  originIsSameSite,
} from '../services/identity/authenticate.ts';
import {
  attachContext,
  contextFromRequest,
  newRequestId,
  runInRequestContext,
  type RequestContext,
} from '../services/identity/context.ts';

/**
 * Reachable with no credentials at all.
 *
 * `/api/auth/login` because there is no other way to acquire credentials, and
 * `/api/auth/session` because the client asks "am I signed in?" before it knows.
 * Both answer with the least they can: the first refuses without saying which
 * half was wrong, the second says no.
 */
const PUBLIC_API_PATHS = new Set(['/api/auth/login', '/api/auth/session']);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Everything the request context needs, gathered once. */
function contextFor(req: Request): RequestContext {
  return {
    principal: null,
    requestId: newRequestId(),
    method: req.method,
    path: req.originalUrl.split('?')[0] ?? req.path,
    remoteAddr: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

/**
 * Refuse, saying as little as possible.
 *
 * One body for every reason. "No such user", "wrong password", "your session
 * expired" and "you are not a member of that" are the same sentence, because
 * the differences between them are precisely what somebody probing would like
 * to learn.
 */
function refuse(res: Response, status: number): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error: 'Not authorized.' });
}

/**
 * Whether a failed authentication is worth an audit row.
 *
 * A request with no credentials at all is usually a browser that has not signed
 * in yet, and recording every one of those would fill the audit with noise and
 * make the interesting rows harder to find. A request that *presented*
 * something and was refused is always interesting.
 */
function worthAuditing(reason: DenialReason, method: string): boolean {
  if (reason !== 'NO_CREDENTIALS') return true;
  return !SAFE_METHODS.has(method);
}

async function auditDenial(
  req: Request,
  context: RequestContext,
  reason: DenialReason,
): Promise<void> {
  try {
    await recordIdentityEvent({
      actorType: 'ANONYMOUS',
      action: 'AUTHENTICATE',
      targetType: 'ROUTE',
      targetId: `${req.method} ${context.path}`,
      result: 'DENIED',
      reason,
      requestId: context.requestId,
      userAgent: context.userAgent,
      remoteAddr: context.remoteAddr,
    });
  } catch {
    // The audit failing must not turn a refusal into something else. It is
    // already a refusal; losing the record of it is the lesser harm, and the
    // database being unreachable is about to be loud in its own right.
  }
}

/**
 * Establish the request context for every request, authenticated or not.
 *
 * Mounted before everything so that a correlation id exists even for requests
 * that never reach a route.
 */
export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const context = contextFor(req);
    // On the request first, so that a handler can re-enter it even if an
    // intervening middleware loses the async context (see context.ts).
    attachContext(req, context);
    res.setHeader('X-Request-Id', context.requestId);
    runInRequestContext(context, () => {
      next();
    });
  };
}

/**
 * Authenticate, and refuse anything that is not on the allowlist.
 *
 * Mounted on `/api` and on `/files`. Both, because a document's bytes are the
 * thing most worth protecting and serving them from a route that merely looked
 * safe is how that gets missed.
 */
export function requireAuthentication(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async (): Promise<void> => {
      const context = contextFromRequest(req);
      if (!context) {
        // The context middleware did not run. That is a wiring mistake, and the
        // safe response to a wiring mistake in the authorization path is to
        // refuse rather than to continue without one.
        refuse(res, 500);
        return;
      }

      if (PUBLIC_API_PATHS.has(context.path)) {
        next();
        return;
      }

      let outcome: Awaited<ReturnType<typeof authenticateRequest>>;
      try {
        outcome = await authenticateRequest(req);
      } catch {
        // Fail closed. An unreachable database means we cannot tell who this is,
        // and "cannot tell" is not "allow".
        await auditDenial(req, context, 'INTERNAL_ERROR');
        refuse(res, 503);
        return;
      }

      if (!outcome.ok) {
        if (worthAuditing(outcome.reason, req.method)) {
          await auditDenial(req, context, outcome.reason);
        }
        refuse(res, 401);
        return;
      }

      // Cross-site request forgery: the second lock behind SameSite=Lax, and
      // only for the cookie path — a bearer credential is never attached by a
      // browser on somebody else's behalf.
      if (
        outcome.principal.authMethod === 'SESSION_COOKIE' &&
        !SAFE_METHODS.has(req.method) &&
        !originIsSameSite(req)
      ) {
        await auditDenial(req, context, 'UNSAFE_TRANSPORT');
        refuse(res, 403);
        return;
      }

      outcome.principal.requestId = context.requestId;
      context.principal = outcome.principal;

      // Somebody who must choose a password can do exactly three things: look at
      // who they are, change it, and leave. Anything else waits. Without this a
      // bootstrapped administrator could work indefinitely on the password that
      // was handed to them in a deployment secret.
      if (
        outcome.principal.mustChangePassword &&
        !context.path.startsWith('/api/auth/')
      ) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(403).json({
          error: 'This account must choose a new password before it can be used.',
          code: 'PASSWORD_CHANGE_REQUIRED',
        });
        return;
      }

      next();
    })();
  };
}
