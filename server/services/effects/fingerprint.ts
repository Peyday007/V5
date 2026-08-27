/**
 * Deciding whether two requests are the same request.
 *
 * An idempotency key says "these are the same operation". A fingerprint checks
 * whether that is true. Without it, a caller could reuse a key with completely
 * different input and be handed the previous operation's result — which is not
 * idempotency, it is a mix-up with a confident name.
 *
 * ---------------------------------------------------------------------------
 * Why not JSON.stringify
 * ---------------------------------------------------------------------------
 *
 * Because it answers a different question. `{"a":1,"b":2}` and `{"b":2,"a":1}`
 * are the same request and different strings. `{"note":""}` and `{"note":null}`
 * and `{}` are three different requests and, once a few common normalisations
 * are applied, easily the same string. `1` and `"1"` are not the same input.
 *
 * So this encodes values with their type, sorts object keys, and gives every
 * distinguishable shape a distinguishable encoding:
 *
 *     absent   -> u          (the key was not there at all)
 *     null     -> z
 *     false    -> b:f        (never collides with 0, "", or absent)
 *     0        -> n:0
 *     ""       -> s:0:
 *     []       -> a:0:
 *     {}       -> o:0:
 *
 * ---------------------------------------------------------------------------
 * Versioning
 * ---------------------------------------------------------------------------
 *
 * The scheme is versioned and the version is stored beside every fingerprint.
 * If canonicalisation ever changes, old rows keep their old meaning instead of
 * being silently reinterpreted — a rule this project already applies to
 * migrations and audit records, for the same reason.
 */
import crypto from 'node:crypto';

/** Bump only alongside a stored `fingerprint_version`, never in place. */
export const FINGERPRINT_VERSION = 1;

/** Deep enough for any real request; short enough that a cycle cannot hide. */
const MAX_DEPTH = 32;
const MAX_KEYS = 512;

export class UncanonicalizableInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncanonicalizableInput';
  }
}

function encodeString(value: string): string {
  // Length-prefixed, so "a:b" and "a" + ":b" cannot encode identically.
  return `s:${value.length}:${value}`;
}

function encode(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) {
    throw new UncanonicalizableInput('This input nests too deeply to fingerprint.');
  }
  if (value === undefined) return 'u';
  if (value === null) return 'z';

  switch (typeof value) {
    case 'boolean':
      return value ? 'b:t' : 'b:f';
    case 'number':
      if (!Number.isFinite(value)) {
        // NaN and the infinities have no canonical form worth agreeing on, and
        // silently mapping them to null would make two different inputs equal.
        throw new UncanonicalizableInput('A number in this input is not finite.');
      }
      // Normalise -0 to 0: they are the same input by every semantic that
      // matters here, and they stringify differently.
      return `n:${Object.is(value, -0) ? 0 : value}`;
    case 'string':
      return encodeString(value);
    case 'bigint':
      return `g:${value.toString()}`;
    case 'object':
      break;
    default:
      throw new UncanonicalizableInput(`A ${typeof value} cannot be fingerprinted.`);
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new UncanonicalizableInput('This input contains a cycle.');
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      // Positional: order is meaning in an array, unlike in an object.
      const parts = object.map((entry) => encode(entry, depth + 1, seen));
      return `a:${parts.length}:${parts.join(',')}`;
    }
    if (object instanceof Date) {
      // A Date is a value, not a structure. ISO so two Dates for the same
      // instant agree whatever their construction.
      return `d:${object.toISOString()}`;
    }
    if (Buffer.isBuffer(object)) {
      // The bytes themselves are never part of a fingerprint — only their
      // digest, so a large upload does not become a large hash input.
      return `x:${crypto.createHash('sha256').update(object).digest('hex')}`;
    }

    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length > MAX_KEYS) {
      throw new UncanonicalizableInput('This input has too many fields to fingerprint.');
    }
    const parts = keys.map(
      (key) => `${encodeString(key)}=${encode(record[key], depth + 1, seen)}`,
    );
    return `o:${parts.length}:${parts.join(',')}`;
  } finally {
    seen.delete(object);
  }
}

/** The canonical encoding, exposed for tests and for diagnosing a conflict. */
export function canonicalize(value: unknown): string {
  return encode(value, 0, new Set());
}

/**
 * The fingerprint of one operation's semantic input.
 *
 * `namespace` and `namespaceVersion` are inside the hash, so the same input
 * under two different operations never fingerprints the same.
 */
export function fingerprintRequest(input: {
  namespace: string;
  namespaceVersion: number;
  projectId: string;
  /** The semantic input only. Never a credential, timestamp or request id. */
  payload: unknown;
}): string {
  const canonical = canonicalize({
    v: FINGERPRINT_VERSION,
    ns: input.namespace,
    nsv: input.namespaceVersion,
    project: input.projectId,
    payload: input.payload,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------------- */
/* Keys                                                                       */
/* ------------------------------------------------------------------------- */

export const MIN_KEY_LENGTH = 8;
export const MAX_KEY_LENGTH = 255;
/** Unreserved URL characters. Wide enough for a UUID, a ULID or a hash. */
const KEY_CHARSET = /^[A-Za-z0-9._~-]+$/;

export class InvalidIdempotencyKey extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdempotencyKey';
  }
}

export function assertValidKey(key: string): string {
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    throw new InvalidIdempotencyKey(
      `An idempotency key must be between ${MIN_KEY_LENGTH} and ${MAX_KEY_LENGTH} characters.`,
    );
  }
  if (!KEY_CHARSET.test(key)) {
    throw new InvalidIdempotencyKey(
      'An idempotency key may contain only letters, digits, and the characters . _ ~ -',
    );
  }
  return key;
}

/**
 * The stored form of a key.
 *
 * A digest, never the key. The key does not have to be secret — nothing is
 * authorized by holding one — but a table of caller-supplied strings is a
 * liability the first time somebody puts something sensitive in one, and
 * storing it buys nothing that the digest does not.
 */
export function fingerprintKey(key: string): string {
  return crypto.createHash('sha256').update(`idemkey:v1:${key}`, 'utf8').digest('hex');
}

/**
 * How widely one key reaches.
 *
 * `PRINCIPAL` — two people doing the same thing are two different intents, so
 * their keys must not collide. `PROJECT` — they are one intent, and the second
 * caller should join the first rather than duplicate it.
 */
export type PrincipalScope = 'PRINCIPAL' | 'PROJECT';

/**
 * The scope a key is interpreted in, built from server-controlled facts only.
 *
 * Nothing the caller sent contributes — not a principal field, not a worker id,
 * not a project in the body, not a namespace they chose. Every input here comes
 * from the authenticated request or from the operation's own declaration, which
 * is what stops one caller reaching another's operation by describing itself
 * differently.
 */
export function scopeHash(input: {
  /** The Brain this is. One installation today; explicit so it stays sound. */
  boundary: string;
  projectId: string;
  namespace: string;
  namespaceVersion: number;
  principalScope: PrincipalScope;
  /** From the authenticated principal. Ignored when the scope is PROJECT. */
  principalType: string;
  principalId: string;
}): string {
  const principal =
    input.principalScope === 'PRINCIPAL'
      ? `${input.principalType}:${input.principalId}`
      : 'project-wide';
  const canonical = canonicalize({
    v: 1,
    boundary: input.boundary,
    project: input.projectId,
    ns: input.namespace,
    nsv: input.namespaceVersion,
    principal,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The logical effect key for work performed under a queue lease.
 *
 * Derived from the *work item* and the operation, and from nothing that changes
 * between attempts. Not the lease id, not the attempt number, not the fencing
 * generation, not the credential, not the request id, not the process, not the
 * clock — every one of those is different on the retry, and a key that differs
 * on the retry is not an idempotency key at all.
 *
 * That stability is what makes a redelivered queue item find the effect it
 * already performed instead of performing it again.
 */
export function logicalEffectKey(input: {
  workItemId: string;
  namespace: string;
  /** For work items that carry more than one distinct effect. */
  discriminator?: string;
}): string {
  const canonical = canonicalize({
    v: 1,
    work: input.workItemId,
    ns: input.namespace,
    d: input.discriminator ?? null,
  });
  return `wk-${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 48)}`;
}
