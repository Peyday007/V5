/**
 * Turning an HTTP request into a principal, or into a refusal.
 *
 * Two ways in, chosen for what each has to work with rather than for symmetry.
 *
 * A **person** presents a cookie. Not a header, because the browser is the one
 * making most of these requests and application code never sees them:
 * `new EventSource('/api/research/…/stream')` and `<a href="/files/…">` both
 * send what the browser decides to send, and what it sends is cookies. A
 * bearer scheme would have left both of those unauthenticated or forced a
 * credential into a URL — where it lands in logs, in history and in referers.
 *
 * A **worker** presents `Authorization: Bearer brnw_…`. It is not a browser, it
 * has no cookie jar, and a header it sets explicitly is exactly right.
 *
 * Neither path trusts anything else the request says about itself. There is no
 * header that names a user, no body field that selects a principal, and no
 * query parameter that carries a credential — a credential in a query string is
 * refused outright rather than accepted with a warning.
 */
import type { Request } from 'express';
import type { DenialReason, Principal, ProjectMembership } from '../../domain/types.ts';
import {
  findLiveSession,
  getUser,
  getWorker,
  findCredentialByPrefix,
  listMembershipsForPrincipal,
  markCredentialUsed,
  touchSession,
} from '../../repos/identity.ts';
import {
  constantTimeEquals,
  digestSecret,
  parseBridgeCredential,
  parseOAuthToken,
  parseWorkerCredential,
} from './secrets.ts';
import { markBridgeCredentialUsed, resolveBridgeCredential } from '../../repos/bridge.ts';
import { findLiveToken, touchToken } from '../../repos/oauth.ts';

/** The cookie a signed-in person carries. */
export const SESSION_COOKIE = 'brain_session';

/**
 * How long a session lives, and why there are two answers.
 *
 * Both are **absolute**. Neither is refreshed on use, and that is deliberate
 * for the reason it has always been: a rolling session never ends, so the only
 * thing that would eventually close it is somebody remembering to sign out.
 *
 * **A device session lasts thirty days.** The credential behind it is a
 * passkey: bound to this origin, held by a device, and released only after that
 * device has verified the person — a fingerprint, a face, or the screen lock.
 * An eight-hour session on top of that asked somebody holding a strong
 * credential to re-present it twice a day, which is friction that buys nothing:
 * the session is a row this server can revoke on any request, the account is
 * re-read on every one of them, and a disabled person is refused mid-sentence.
 * Thirty days is long enough that ordinary use never reaches it and short
 * enough that a browser nobody opens again is not an open session next quarter.
 * It is carried in the cookie's `Max-Age`, so it survives closing the browser —
 * which is the point — and nothing about it is stored where a script can read
 * it.
 *
 * **A password session lasts eight hours**, unchanged. That door is
 * break-glass now (see `passwordDoor.ts`): a session opened by somebody using
 * an emergency credential is not a working session, and the first thing they
 * are there to do is register a device.
 */
export const DEVICE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PASSWORD_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export type AuthOutcome =
  | { ok: true; principal: Principal }
  | { ok: false; reason: DenialReason };

/**
 * Cookies, parsed here rather than by a dependency.
 *
 * One header, one format, and the alternative is another package in the supply
 * chain of the thing that decides who gets in.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  /** Only ever set on a connection the browser considers secure. */
  secure: boolean;
  maxAgeMs?: number;
}

/**
 * `SameSite=Lax` and `HttpOnly`, both load-bearing.
 *
 * HttpOnly keeps the session out of reach of any script on the page, which is
 * the difference between an XSS bug being serious and being total. Lax stops
 * the browser attaching it to a cross-site POST, which is the CSRF class this
 * application would otherwise be wide open to — every mutating route is a
 * simple JSON POST. `Path=/` because `/files` and `/api` both need it.
 */
export function sessionCookie(secret: string, options: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(secret)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  if (options.maxAgeMs !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeMs / 1000)}`);
  return parts.join('; ');
}

export function clearedSessionCookie(options: { secure: boolean }): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Trusts `trust proxy`, which `buildApp` sets, so this is the real scheme. */
export function isSecureRequest(req: Request): boolean {
  return req.secure;
}

/**
 * What a worker is called, everywhere a caller can see.
 *
 * One function, so the answer cannot differ between two readers — and so the
 * fallback to the legacy handle exists in exactly one place, for a row written
 * before migration 074 that somehow escaped its backfill. It is a display
 * decision and never an authorization one: nothing in this codebase branches on
 * what a worker is called.
 */
export function workerIdentity(worker: { label: string | null; name: string }): string {
  return worker.label ?? worker.name;
}

/**
 * A credential in a query string is refused, not accepted.
 *
 * Query strings are logged by proxies, kept in browser history and sent onward
 * in `Referer`. Supporting them "for convenience" would mean the convenient way
 * is the one that leaks.
 */
function hasCredentialInQuery(req: Request): boolean {
  const query = req.query as Record<string, unknown>;
  for (const name of ['token', 'access_token', 'credential', 'api_key', 'apikey', 'password']) {
    if (query[name] !== undefined) return true;
  }
  return false;
}

function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1]!.trim() : null;
}

async function membershipsFor(
  type: 'HUMAN' | 'WORKER',
  id: string,
): Promise<ProjectMembership[]> {
  return await listMembershipsForPrincipal(type, id);
}

/**
 * Resolve the request's principal.
 *
 * Every failure here is one of a small set of categories and none of them says
 * which half of a guess was right: an unknown prefix, a wrong secret and a
 * malformed header are all `INVALID_CREDENTIALS`.
 */
export async function authenticateRequest(req: Request): Promise<AuthOutcome> {
  if (hasCredentialInQuery(req)) return { ok: false, reason: 'UNSAFE_TRANSPORT' };

  const bearer = bearerToken(req);
  if (bearer) {
    // Two kinds of bearer, told apart by their marker rather than by trying
    // each in turn: `brnw_` is a credential an administrator issued directly,
    // `brnt_` is a token this Brain minted after a human approved a connection.
    // Both resolve to the same WORKER principal.
    if (parseOAuthToken(bearer)) return await authenticateOAuth(bearer);
    // `brnc_` is the third marker and the only one that resolves to a person.
    // It is told apart here rather than by trying each in turn, so a worker
    // credential can never fall through into the person branch or the reverse.
    if (parseBridgeCredential(bearer)) return await authenticateBridge(bearer);
    return await authenticateWorker(bearer, req);
  }

  const cookies = parseCookies(req.header('cookie'));
  const secret = cookies[SESSION_COOKIE];
  if (secret) return await authenticateHuman(secret, req);

  return { ok: false, reason: 'NO_CREDENTIALS' };
}

async function authenticateHuman(secret: string, req: Request): Promise<AuthOutcome> {
  const session = await findLiveSession(secret);
  if (!session) return { ok: false, reason: 'INVALID_CREDENTIALS' };

  const user = await getUser(session.userId);
  // A session whose user is gone is not a session. Checked on every request
  // rather than at sign-in, so disabling somebody ends what they are doing now.
  if (!user) return { ok: false, reason: 'INVALID_CREDENTIALS' };
  if (user.disabled) return { ok: false, reason: 'PRINCIPAL_DISABLED' };

  void touchSession(session.id);

  return {
    ok: true,
    principal: {
      type: 'HUMAN',
      id: user.id,
      handle: user.email,
      displayName: user.displayName,
      isBrainAdmin: user.isBrainAdmin,
      mustChangePassword: user.mustChangePassword,
      credentialId: session.id,
      authMethod: 'SESSION_COOKIE',
      memberships: await membershipsFor('HUMAN', user.id),
      requestId: '',
    },
  };
}

/**
 * A conversation bridge credential.
 *
 * **The principal is the person who holds it**, which makes this the one bearer
 * in this Brain that is not a worker — and the reason that is safe rather than
 * a hole is that it can be nothing else. There is no column on
 * `bridge_credentials` naming a worker, so no configuration of it produces a
 * `WORKER` principal, exactly as §22 arranged the converse for `oauth_tokens`.
 *
 * Everything that makes a person's session safe is here too, and read live
 * rather than baked into the credential: the account is re-read on every
 * request, a disabled one is refused mid-sentence, and memberships come from
 * current rows so revoking a project lands on the next call.
 *
 * What it deliberately does **not** carry is `isBrainAdmin`. A bridge
 * credential is a key somebody pasted into a chat client, and a chat client
 * holding Brain administration would be one prompt away from administering
 * this Brain. Everything an administrator may do stays behind the cookie, so
 * losing this credential loses a person's own conversations and nothing else.
 */
async function authenticateBridge(presented: string): Promise<AuthOutcome> {
  const parsed = parseBridgeCredential(presented);
  if (!parsed) return { ok: false, reason: 'INVALID_CREDENTIALS' };

  // Unknown prefix, wrong secret, revoked and expired are one answer, decided
  // inside the repository so no caller can build a different refusal out of
  // them. The differences between them are what somebody probing wants.
  const credential = await resolveBridgeCredential(parsed.prefix, parsed.secret);
  if (!credential) return { ok: false, reason: 'INVALID_CREDENTIALS' };

  const user = await getUser(credential.userId);
  if (!user) return { ok: false, reason: 'INVALID_CREDENTIALS' };
  if (user.disabled) return { ok: false, reason: 'PRINCIPAL_DISABLED' };

  void markBridgeCredentialUsed(credential.id);

  return {
    ok: true,
    principal: {
      type: 'HUMAN',
      id: user.id,
      handle: user.email,
      displayName: user.displayName,
      // Deliberately false however the account is configured. See above.
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: credential.id,
      authMethod: 'BRIDGE_BEARER',
      memberships: await membershipsFor('HUMAN', user.id),
      requestId: '',
    },
  };
}

async function authenticateWorker(presented: string, _req: Request): Promise<AuthOutcome> {
  const parsed = parseWorkerCredential(presented);
  if (!parsed) return { ok: false, reason: 'INVALID_CREDENTIALS' };

  const credential = await findCredentialByPrefix(parsed.prefix);
  if (!credential) return { ok: false, reason: 'INVALID_CREDENTIALS' };

  // Compared in constant time against the stored digest. The prefix lookup
  // above already told us which row; this decides whether the holder has the
  // secret half, and takes the same time whether they are one character out or
  // guessing entirely.
  if (!constantTimeEquals(digestSecret(parsed.secret), credential.verifier)) {
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }

  if (credential.revokedAt !== null) return { ok: false, reason: 'REVOKED' };
  if (credential.expiresAt !== null && credential.expiresAt <= new Date().toISOString()) {
    return { ok: false, reason: 'EXPIRED' };
  }

  const worker = await getWorker(credential.workerId);
  if (!worker) return { ok: false, reason: 'INVALID_CREDENTIALS' };
  // A live credential belonging to a disabled worker is refused. Disabling
  // revokes credentials too, so this is the second of two locks rather than the
  // only one — but a race between the two must fail closed.
  if (worker.disabled) return { ok: false, reason: 'PRINCIPAL_DISABLED' };

  void markCredentialUsed(credential.id);

  return {
    ok: true,
    principal: {
      type: 'WORKER',
      id: worker.id,
      // The neutral label, never the legacy handle. `brain_whoami` answers with
      // this, so a worker that checks in says `worker-03` rather than somebody's
      // first name — which readers took to be a statement about whose account
      // had run the session, and never was. See migration 074.
      handle: workerIdentity(worker),
      displayName: workerIdentity(worker),
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: credential.id,
      authMethod: 'WORKER_BEARER',
      memberships: await membershipsFor('WORKER', worker.id),
      requestId: '',
    },
  };
}

/**
 * A Brain-minted OAuth access token.
 *
 * The principal is the **worker the token was issued for**, never the person
 * who approved the connection. That human is recorded on the authorization
 * code, for the audit, and is deliberately absent from the token — so approving
 * a connection can never make a remote client act as the approver.
 *
 * Membership and scopes are read live here, exactly as they are for a `brnw_`
 * credential, so revoking a worker's access lands on its next call rather than
 * when the token happens to expire.
 */
async function authenticateOAuth(presented: string): Promise<AuthOutcome> {
  const parsed = parseOAuthToken(presented);
  if (!parsed) return { ok: false, reason: 'INVALID_CREDENTIALS' };

  // Unknown, revoked and expired are one answer. The differences between them
  // are exactly what somebody probing would like to learn.
  const token = await findLiveToken(parsed.prefix, parsed.secret, 'ACCESS');
  if (!token) return { ok: false, reason: 'INVALID_CREDENTIALS' };

  const worker = await getWorker(token.workerId);
  if (!worker) return { ok: false, reason: 'INVALID_CREDENTIALS' };
  if (worker.disabled) return { ok: false, reason: 'PRINCIPAL_DISABLED' };

  void touchToken(token.id);

  return {
    ok: true,
    principal: {
      type: 'WORKER',
      id: worker.id,
      // The neutral label, never the legacy handle. `brain_whoami` answers with
      // this, so a worker that checks in says `worker-03` rather than somebody's
      // first name — which readers took to be a statement about whose account
      // had run the session, and never was. See migration 074.
      handle: workerIdentity(worker),
      displayName: workerIdentity(worker),
      isBrainAdmin: false,
      mustChangePassword: false,
      // The token row, so an audit line points at the grant that can be revoked.
      credentialId: token.id,
      authMethod: 'OAUTH_BEARER',
      memberships: await membershipsFor('WORKER', worker.id),
      requestId: '',
    },
  };
}

/**
 * Cross-site request forgery, for the cookie path only.
 *
 * `SameSite=Lax` already stops the browser attaching the session to a
 * cross-site POST, and this is the second lock: a mutating request that
 * authenticated by cookie must carry an `Origin` (or `Referer`) matching the
 * host it arrived at. Requests authenticated by bearer token are exempt because
 * no browser attaches those on anybody's behalf — a forged cross-site request
 * cannot produce one.
 */
export function originIsSameSite(req: Request): boolean {
  const origin = req.header('origin');
  const referer = req.header('referer');
  const source = origin ?? referer;
  // No Origin and no Referer: not a browser form post, and not something a page
  // on another site can produce with a session attached. Allowed, because
  // `curl` and scripts legitimately send neither.
  if (!source) return true;
  try {
    const url = new URL(source);
    return url.host === req.get('host');
  } catch {
    return false;
  }
}
