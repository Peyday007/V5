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
 * This is a **temporary, coarse gate**: one shared credential, everyone who has
 * it sees everything. It exists so the first Cloud Brain is not public while the
 * real thing is built. Step 4 replaces it with actual identities — per-worker
 * credentials, per-user authorisation, revocation, and the carry-forward
 * register — and this file should be deleted when that lands, not extended.
 *
 * Step 4 is identity and authorization, and nothing else. Knowing which worker
 * is calling does not make it safe for two of them to claim one job: that is
 * Step 5's distributed queue, atomic claiming, leases and heartbeats, and
 * making the *effects* of a re-run job safe is Step 6's again. Nothing in this
 * file should ever grow toward either of them. See `docs/ROADMAP.md`.
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

  if (!token && options.cloud) {
    throw new AccessGateError(
      'This Brain is configured for cloud persistence but has no BRAIN_ACCESS_TOKEN.',
      'A cloud-backed Brain has a URL, and behind that URL are every document, every ' +
        'claim and an endpoint that accepts uploads. Set BRAIN_ACCESS_TOKEN to a long ' +
        'random secret — `openssl rand -base64 32` — in the host’s environment ' +
        'settings. Brain will not start without one, because a deployment you forgot to ' +
        'protect is worse than a deployment that failed.',
    );
  }

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
    if (OPEN_PATHS.has(req.path)) {
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
    ? `private · shared token (temporary; Step 4 replaces this with identities)`
    : 'open · no token set (local development only)';
}
