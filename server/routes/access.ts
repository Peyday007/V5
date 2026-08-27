/**
 * The gate in front of a deployed Brain.
 *
 * A Brain that is only ever reached on localhost needs no door: the operating
 * system is the door. The moment it has a public URL that stops being true, and
 * what is behind that URL is somebody's entire research archive — every
 * document, every claim, every source, and an import endpoint that accepts
 * files. Reachable and unprotected is not a smaller problem than unreachable.
 *
 * So the rule is the same one the database and the store already follow, and it
 * is enforced the same way: **a Brain configured for the cloud refuses to boot
 * without an access token.** Not a warning, not a default password, not "you
 * probably meant to set this" — it does not start. Forgetting to protect a
 * deployment should cost a failed deploy, which you notice immediately, rather
 * than an exposure, which you may not notice at all.
 *
 * Local mode is deliberately exempt. Requiring a password to run `npm run dev`
 * against a SQLite file would be security theatre that people work around, and
 * a workaround people rely on eventually reaches production.
 *
 * HTTP Basic is the mechanism, chosen for what it does not require: no login
 * page, no session store, no cookie handling, no token in a URL, and no change
 * to a single line of the client. The browser prompts, remembers for the
 * origin, and then attaches credentials to every request the app makes —
 * including `EventSource` streams and document downloads, which a bearer-token
 * scheme in application code would each have had to be taught separately.
 *
 * ---------------------------------------------------------------------------
 * Step 4 landed, and this is no longer the security model.
 * ---------------------------------------------------------------------------
 *
 * Real authentication now sits behind this: every `/api` route and every
 * document byte resolves to a principal and an explicit authorization decision
 * (`routes/guard.ts`, `services/identity/`). What is left here is an **optional
 * outer layer** — one shared credential in front of the whole site, off unless
 * somebody sets `BRAIN_ACCESS_TOKEN`.
 *
 * It is kept rather than deleted for two reasons, and neither is inertia:
 *
 *   * a second, cruder lock in front of a deployment is a reasonable thing to
 *     want while a Brain is not meant to be discoverable at all — it keeps the
 *     sign-in page itself off the open internet;
 *   * deleting it would silently open every installation that had been relying
 *     on it, at the moment they upgraded.
 *
 * What did change is that it is no longer **required**. A cloud-backed Brain
 * used to refuse to boot without a token, because without one it was reachable
 * and unprotected. That is no longer true: without a token it is reachable and
 * *authenticated*, and the invariant has moved rather than been dropped — boot
 * now reports loudly when a Brain has no accounts, because a Brain nobody can
 * sign in to is the other way to have a deployment nobody can use.
 *
 * This file grants nothing and identifies nobody. It cannot authorize, it has no
 * notion of a project, and it must never acquire one: if it starts to look like
 * it is deciding who may do what, that logic belongs in the policy module.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Paths a probe may reach without credentials.
 *
 * Only liveness. A hosting platform has to be able to ask "is this process
 * up?" without holding a secret, and answering that question reveals nothing:
 * the response is a fixed string and names no project, no configuration and no
 * version. Everything that says anything about this Brain — including
 * `/api/health`, which names the database host and the bucket — is behind the
 * gate.
 */
const OPEN_PATHS = new Set(['/healthz']);

/**
 * Paths that carry their own authentication and must not also meet a Basic
 * prompt.
 *
 * `/mcp` is the whole set, and the reason is mechanical rather than a matter of
 * preference: an HTTP request has one `Authorization` header, this gate wants
 * `Basic <shared token>` in it, and an MCP client must put
 * `Bearer brnw_…` there. They cannot both have it, and an MCP client has no way
 * to send a second one.
 *
 * This is not a hole. Since Step 4 the shared token has explicitly not been the
 * security model — it is an optional outer layer, off unless somebody sets one
 * — and `/mcp` is behind real authentication that resolves a worker principal
 * from server-held rows, refuses a session cookie, refuses a credential in a
 * query string, validates `Origin`, and authorizes every single tool call
 * through the same policy module every HTTP route uses. The outer token would
 * add a second lock to a door that already has a better one, at the cost of
 * making the door unopenable by the clients it exists for.
 */
const OWN_AUTHENTICATION_PATHS = new Set(['/mcp']);

export interface AccessGateConfig {
  /** The shared secret. Absent means no gate. */
  token: string | null;
  /** The username half of the Basic prompt. Cosmetic; the token is the secret. */
  username: string;
}

export class AccessGateError extends Error {
  readonly detail: string;
  constructor(message: string, detail = '') {
    super(message);
    this.name = 'AccessGateError';
    this.detail = detail;
  }
}

function read(name: string): string | null {
  const value = (process.env[name] ?? '').trim();
  return value.length > 0 ? value : null;
}

/**
 * Read the gate's configuration, and refuse a cloud deployment without one.
 *
 * `cloud` is passed in rather than read from the environment here, because what
 * matters is the persistence Brain actually opened — the same distinction the
 * rest of the boot makes between a variable being set and a backend answering.
 */
export function accessGateConfig(options: { cloud: boolean }): AccessGateConfig {
  const token = read('BRAIN_ACCESS_TOKEN');

  // `options.cloud` no longer makes a token mandatory. It is kept in the
  // signature because the banner and the documentation still distinguish a
  // deployed Brain from a local one, and because reinstating a requirement here
  // — if this ever became the only lock again — should be a one-line change
  // rather than a re-plumb.
  void options;

  if (token && token.length < 16) {
    throw new AccessGateError(
      'BRAIN_ACCESS_TOKEN is too short to be worth having.',
      'Use at least 16 characters, and generate them rather than choosing them: ' +
        '`openssl rand -base64 32`. The value itself is not repeated here.',
    );
  }

  return { token, username: read('BRAIN_ACCESS_USER') ?? 'brain' };
}

/** Constant-time comparison, so the gate cannot be probed one character at a time. */
function matches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Both sides are hashed to a fixed width first so every comparison
  // costs the same whatever was sent.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Pull the token out of an Authorization header.
 *
 * Basic is what a browser sends. Bearer is accepted too, because a script or a
 * `curl` reaching the API should not have to base64 anything to do it.
 */
function suppliedToken(header: string | undefined): string | null {
  if (!header) return null;

  const basic = /^Basic\s+(.+)$/i.exec(header);
  if (basic) {
    let decoded: string;
    try {
      decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
    } catch {
      return null;
    }
    const colon = decoded.indexOf(':');
    // The password half is the secret; the username is not checked, so a person
    // typing anything memorable into the browser prompt still gets in.
    return colon === -1 ? null : decoded.slice(colon + 1);
  }

  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  return bearer ? bearer[1]!.trim() : null;
}

/**
 * The middleware itself.
 *
 * Returns a pass-through when there is no token, which is the local-development
 * case and the only case where the gate is absent.
 */
export function accessGate(config: AccessGateConfig): RequestHandler {
  if (!config.token) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  const expected = config.token;
  const realm = 'Brain';

  return (req: Request, res: Response, next: NextFunction) => {
    if (OPEN_PATHS.has(req.path) || OWN_AUTHENTICATION_PATHS.has(req.path)) {
      next();
      return;
    }

    const supplied = suppliedToken(req.header('authorization'));
    if (supplied !== null && matches(supplied, expected)) {
      next();
      return;
    }

    // The browser needs this header to show its prompt. The response body says
    // nothing about why — not whether the username was wrong, not whether a
    // token was sent at all, and nothing about what is behind the gate.
    res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    // A refused request must never be cached, by anything.
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).json({ error: 'This Brain is private.' });
  };
}

/** For the boot banner. Never the token — only whether there is one. */
export function describeAccessGate(config: AccessGateConfig): string {
  return config.token
    ? 'shared token in front of the site (optional outer layer; accounts are the real gate)'
    : 'none (accounts are the gate; set BRAIN_ACCESS_TOKEN to add an outer layer)';
}
