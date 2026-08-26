/**
 * Who is making the request currently being served.
 *
 * Held in `AsyncLocalStorage` rather than threaded through every function,
 * for one specific reason: the resolvers in `routes/helpers.ts` —
 * `requireProject`, `requireLayer`, `requireRun`, `requireDocument` — are
 * already called by essentially every route that touches project data, and
 * making *them* the authorization point is what turns eighty-four separate
 * decisions into one. They are called from deep inside handlers that do not
 * have the request, and passing it down to them would mean editing every
 * signature and every call site, which is exactly the kind of change where one
 * omission is a hole nobody notices.
 *
 * The same mechanism already carries the current transaction (see
 * `db/adapters/*.ts`), so this is the codebase's existing answer to
 * "request-scoped thing that everything below needs", not a new idea.
 *
 * Reading the principal from here is safe in a way that reading it from a
 * header is not: it is put there once, by the authentication middleware, from
 * rows the server owns.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import type { Principal } from '../../domain/types.ts';

export interface RequestContext {
  /** Null only inside the few places that run before authentication. */
  principal: Principal | null;
  requestId: string;
  method: string;
  /** The path as routed, used to look up any authorization override. */
  path: string;
  remoteAddr: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * The context is also kept on the request object, and that is not redundancy
 * for its own sake.
 *
 * `AsyncLocalStorage` propagates through promises and timers, but **not**
 * through callbacks that an EventEmitter invokes: a listener runs in the
 * context of whatever emitted the event, not the context it was registered in.
 * Multipart uploads go through `multer`, which finishes by calling `next()`
 * from a `busboy` event driven by the socket — a resource that existed before
 * any of this ran. The context is simply gone by the time the route body
 * executes, and the symptom is an authenticated request being told the project
 * does not exist.
 *
 * Measured, not guessed: it is what the import tests fail with.
 *
 * So the request carries its own context, and `handler()` re-enters it before
 * calling a route body. That makes the guarantee structural — every route is
 * inside its request's context — rather than dependent on which middleware
 * happens to sit in front of it.
 */
const CONTEXT_KEY = Symbol.for('brain.requestContext');

export function attachContext(target: object, context: RequestContext): void {
  (target as Record<symbol, unknown>)[CONTEXT_KEY] = context;
}

export function contextFromRequest(target: object | undefined | null): RequestContext | null {
  if (!target) return null;
  const found = (target as Record<symbol, unknown>)[CONTEXT_KEY];
  return (found as RequestContext | undefined) ?? null;
}

export function runInRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | null {
  return storage.getStore() ?? null;
}

/**
 * The principal, or null.
 *
 * Null means one of two things — no authentication has happened yet, or this
 * is code running outside a request (boot, a background queue). Both are cases
 * where an authorization check must refuse rather than assume, and the
 * distinction between them is deliberately not offered here: a caller that
 * wanted to treat "background work" as "allowed" would be writing the bypass
 * this module exists to prevent.
 */
export function currentPrincipal(): Principal | null {
  return storage.getStore()?.principal ?? null;
}

export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

export function newRequestId(): string {
  return `req_${crypto.randomBytes(9).toString('base64url')}`;
}

/**
 * Run something with no principal at all.
 *
 * For boot and for background queues, which act on the whole Brain and have no
 * caller to authorize. It grants nothing: every check refuses a null principal.
 * Its purpose is to make the absence explicit at the call site rather than
 * incidental, so a reader can tell "this runs unauthenticated" from "somebody
 * forgot".
 */
export function runAsSystem<T>(fn: () => T): T {
  return storage.run(
    {
      principal: null,
      requestId: newRequestId(),
      method: 'SYSTEM',
      path: '',
      remoteAddr: null,
      userAgent: null,
    },
    fn,
  );
}
