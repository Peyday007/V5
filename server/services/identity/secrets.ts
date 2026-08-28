/**
 * Turning secrets into things that are safe to store.
 *
 * Two problems that look alike and are not, so they get two answers.
 *
 * A **password** is chosen by a person and therefore has very little entropy
 * however long it is. Its stored form has to be expensive to compute, so that
 * someone holding a stolen database is buying every guess rather than testing
 * millions a second. That is `scrypt`, with parameters recorded beside the
 * result so they can be raised later without invalidating everyone.
 *
 * A **machine credential** is generated here from 32 bytes of
 * `crypto.randomBytes`. Guessing it is not a matter of trying harder; there is
 * nothing to dictionary-attack. Its stored form only has to be irreversible,
 * and it has to be cheap, because a worker presents it on every single request
 * and a deliberately-slow hash would put a hundred milliseconds of CPU in front
 * of each one. That is SHA-256.
 *
 * Using scrypt for both would look more careful and would be worse: it would
 * make the fast path slow for no gain, and slow authentication is what pushes
 * people toward caching decisions, which is how revocation stops working.
 *
 * Nothing in this file logs, and nothing returns a secret it was given. The
 * only value that ever leaves as plaintext is one this module just generated,
 * handed back exactly once for the caller to show a person.
 */
import crypto from 'node:crypto';

/**
 * scrypt parameters. N=16384 is ~50–80ms on the hardware this runs on, which is
 * the right order for a login: unnoticeable to a person, ruinous in bulk.
 */
const SCRYPT = { N: 16_384, r: 8, p: 1, keyLength: 64 } as const;
const SCRYPT_ALGORITHM = 'scrypt';

/** Enough that a generated one is unguessable and a chosen one is not trivial. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/** 256 bits. The number below which none of the reasoning above holds. */
const SECRET_BYTES = 32;
/** Public half of a worker credential: how its row is found, safe to display. */
const PREFIX_BYTES = 8;

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

function scryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      SCRYPT.keyLength,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

/**
 * Reject a password that is too short to be worth hashing.
 *
 * Length only. Composition rules ("one capital, one symbol") measurably push
 * people toward `Password1!`, and this Brain's accounts are created by an
 * administrator rather than self-registered, so the realistic failure is a
 * memorable short one rather than a predictable long one.
 */
export function assertUsablePassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `A password must be at least ${MIN_PASSWORD_LENGTH} characters. ` +
        'Generate one rather than choosing one where you can.',
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `A password may be at most ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
}

/**
 * `scrypt$N=…,r=…,p=…$salt$key`, all base64url.
 *
 * Self-describing so the parameters can change: an old verifier keeps verifying
 * with the parameters it was made with, and is replaced the next time that
 * person types their password.
 */
export async function hashPassword(password: string): Promise<string> {
  assertUsablePassword(password);
  const salt = crypto.randomBytes(16);
  const key = await scryptKey(password, salt);
  return [
    SCRYPT_ALGORITHM,
    `N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}`,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Constant time, and false rather than throwing on anything malformed.
 *
 * A corrupt verifier must not be distinguishable from a wrong password: the
 * difference would tell an attacker which accounts are worth attacking.
 */
export async function verifyPassword(password: string, verifier: string): Promise<boolean> {
  try {
    const parts = verifier.split('$');
    if (parts.length !== 4 || parts[0] !== SCRYPT_ALGORITHM) return false;
    const params = Object.fromEntries(
      parts[1]!.split(',').map((pair) => {
        const [name, value] = pair.split('=');
        return [name ?? '', Number(value)];
      }),
    );
    const N = params.N;
    const r = params.r;
    const p = params.p;
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    // A hostile verifier could otherwise ask for parameters that exhaust memory.
    if (N! > 1 << 20 || r! > 32 || p! > 16) return false;

    const salt = Buffer.from(parts[2]!, 'base64url');
    const expected = Buffer.from(parts[3]!, 'base64url');
    if (salt.length === 0 || expected.length === 0) return false;

    const derived = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(
        password.normalize('NFKC'),
        salt,
        expected.length,
        { N: N!, r: r!, p: p! },
        (error, key) => (error ? reject(error) : resolve(key)),
      );
    });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// High-entropy secrets: sessions and worker credentials
// ---------------------------------------------------------------------------

/** Both sides hashed to a fixed width first, so a length mismatch cannot leak. */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** The stored form of a generated secret. Irreversible, and cheap to check. */
export function digestSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('base64url');
}

export interface GeneratedSessionToken {
  /** Goes in the cookie. Never stored, never logged. */
  secret: string;
  /** Goes in the database. */
  verifier: string;
}

export function generateSessionToken(): GeneratedSessionToken {
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  return { secret, verifier: digestSecret(secret) };
}

/**
 * A worker credential, as issued.
 *
 * `brnw_<prefix>.<secret>`. The scheme is not decoration:
 *
 *   * the `brnw_` marker makes a leaked credential recognisable on sight, in a
 *     log or a paste, as a thing that must be revoked;
 *   * the prefix is a single indexed lookup, so authentication does not verify
 *     every credential in the table to find out which one this is;
 *   * the dot separates what is safe to show from what is not, so an audit row
 *     can name the credential without containing it.
 */
export interface GeneratedWorkerCredential {
  /** The whole thing, shown once and never recoverable afterwards. */
  plaintext: string;
  prefix: string;
  verifier: string;
}

export const WORKER_CREDENTIAL_MARKER = 'brnw_';

export function generateWorkerCredential(): GeneratedWorkerCredential {
  const prefix = `${WORKER_CREDENTIAL_MARKER}${crypto.randomBytes(PREFIX_BYTES).toString('hex')}`;
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  return { plaintext: `${prefix}.${secret}`, prefix, verifier: digestSecret(secret) };
}

export interface ParsedWorkerCredential {
  prefix: string;
  secret: string;
}

/**
 * Split a presented credential without deciding whether it is valid.
 *
 * Returns null for anything that is not the right shape, so the caller's
 * refusal for "malformed" and its refusal for "wrong" are the same refusal.
 */
export function parseWorkerCredential(presented: string): ParsedWorkerCredential | null {
  if (typeof presented !== 'string') return null;
  const trimmed = presented.trim();
  if (!trimmed.startsWith(WORKER_CREDENTIAL_MARKER)) return null;
  const dot = trimmed.indexOf('.');
  if (dot <= WORKER_CREDENTIAL_MARKER.length) return null;
  const prefix = trimmed.slice(0, dot);
  const secret = trimmed.slice(dot + 1);
  if (secret.length < 16 || /[^A-Za-z0-9_-]/.test(secret)) return null;
  if (!/^brnw_[0-9a-f]{16}$/.test(prefix)) return null;
  return { prefix, secret };
}

/* ------------------------------------------------------------------------- */
/* OAuth tokens and codes                                                     */
/* ------------------------------------------------------------------------- */

/**
 * `brnt_<prefix>.<secret>` — a Brain-issued OAuth token.
 *
 * Deliberately the same shape as a worker credential, for the same two reasons:
 * the marker makes a leaked token recognisable on sight, and the prefix is a
 * single indexed lookup so authentication does not have to verify every row.
 *
 * A different marker from `brnw_` because the two are not interchangeable. A
 * worker credential is a long-lived secret an administrator issued; a token is
 * short-lived, minted by the Brain for itself, and tied to the client and the
 * authorization that produced it. Sharing a marker would make a log line
 * ambiguous about which of those had leaked.
 */
export const OAUTH_TOKEN_MARKER = 'brnt_';

/**
 * A worker invitation — an administrator's approval, made in advance.
 *
 * Its own marker rather than reusing `brnt_`, so a value that turns up in a log
 * or a support message is identifiable on sight, and so an invitation can never
 * be mistaken for an access token by a lookup that only checks the shape.
 */
export const INVITATION_MARKER = 'brnv_';

export interface GeneratedOAuthToken {
  plaintext: string;
  prefix: string;
  digest: string;
}

export function generateOAuthToken(): GeneratedOAuthToken {
  const prefix = `${OAUTH_TOKEN_MARKER}${crypto.randomBytes(PREFIX_BYTES).toString('hex')}`;
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  return { plaintext: `${prefix}.${secret}`, prefix, digest: digestSecret(secret) };
}

export function generateInvitationToken(): GeneratedOAuthToken {
  const prefix = `${INVITATION_MARKER}${crypto.randomBytes(PREFIX_BYTES).toString('hex')}`;
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  return { plaintext: `${prefix}.${secret}`, prefix, digest: digestSecret(secret) };
}

export interface ParsedOAuthToken {
  prefix: string;
  secret: string;
}

/** The same shape rules as an access token, against the invitation marker. */
export function parseInvitationToken(presented: string): ParsedOAuthToken | null {
  if (typeof presented !== 'string') return null;
  const trimmed = presented.trim();
  if (!trimmed.startsWith(INVITATION_MARKER)) return null;
  const dot = trimmed.indexOf('.');
  if (dot <= INVITATION_MARKER.length) return null;
  const prefix = trimmed.slice(0, dot);
  const secret = trimmed.slice(dot + 1);
  if (secret.length < 16 || /[^A-Za-z0-9_-]/.test(secret)) return null;
  if (!/^brnv_[0-9a-f]{16}$/.test(prefix)) return null;
  return { prefix, secret };
}

export function parseOAuthToken(presented: string): ParsedOAuthToken | null {
  if (typeof presented !== 'string') return null;
  const trimmed = presented.trim();
  if (!trimmed.startsWith(OAUTH_TOKEN_MARKER)) return null;
  const dot = trimmed.indexOf('.');
  if (dot <= OAUTH_TOKEN_MARKER.length) return null;
  const prefix = trimmed.slice(0, dot);
  const secret = trimmed.slice(dot + 1);
  if (secret.length < 16 || /[^A-Za-z0-9_-]/.test(secret)) return null;
  if (!/^brnt_[0-9a-f]{16}$/.test(prefix)) return null;
  return { prefix, secret };
}

/**
 * An authorization code, and a client secret.
 *
 * Both are opaque random strings kept only as digests. The code is
 * single-use and short-lived; the client secret is optional, because a public
 * client authenticating with PKCE alone is the ordinary case here.
 */
export function generateOpaqueSecret(): { plaintext: string; digest: string } {
  const plaintext = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  return { plaintext, digest: digestSecret(plaintext) };
}

/**
 * PKCE, S256 only.
 *
 * `plain` is still in the OAuth 2.1 draft for legacy reasons and is refused
 * here: it makes the challenge equal to the verifier, so an attacker who can
 * see the authorization request can complete the exchange. Accepting it "for
 * compatibility" would mean the protection is only as strong as the weakest
 * client that ever connects.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false;
  // RFC 7636 bounds the verifier; a short one is brute-forceable.
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (/[^A-Za-z0-9._~-]/.test(verifier)) return false;
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return constantTimeEquals(computed, challenge);
}
