/**
 * WebAuthn registration and assertion, verified against Node's own crypto.
 *
 * ---------------------------------------------------------------------------
 * What is hand-written here, and what is deliberately not
 * ---------------------------------------------------------------------------
 *
 * **The parsing is here. The cryptography is not.** CBOR decoding, the
 * authenticator-data layout and the COSE key shape are all format work — tedious
 * and checkable. Signature verification is `crypto.verify` over a key imported
 * as a JWK, so the part that would be dangerous to get subtly wrong is done by
 * the platform rather than by this file.
 *
 * The CBOR decoder is deliberately partial: it reads the major types WebAuthn
 * actually produces and throws on anything else. A decoder that silently
 * tolerated an unexpected shape would be one that accepted a structure nobody
 * designed, which is how a parser becomes a vulnerability.
 *
 * **Only `none` attestation is accepted**, because only `none` is requested.
 * Attestation tells you which make of authenticator was used; this Brain does
 * not care, and asking for it would collect a hardware identifier for nothing.
 *
 * **Only ES256 and RS256 are accepted.** Those are what platform authenticators
 * produce. An algorithm that is not offered cannot arrive, and an algorithm
 * this file cannot verify must be refused rather than assumed valid.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

export const ES256 = -7;
export const RS256 = -257;
/** Offered to the browser, in preference order. */
export const SUPPORTED_ALGORITHMS = [ES256, RS256] as const;

export function base64urlToBuffer(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function bufferToBase64url(value: Buffer): string {
  return value.toString('base64url');
}

/* --------------------------------------------------------------------------
 * A partial CBOR reader
 * ------------------------------------------------------------------------ */

interface Cursor {
  readonly bytes: Buffer;
  offset: number;
}

type CborValue = number | string | Buffer | boolean | null | CborValue[] | Map<CborValue, CborValue>;

function readArgument(cursor: Cursor, info: number): number {
  if (info < 24) return info;
  if (info === 24) return cursor.bytes.readUInt8(cursor.offset++);
  if (info === 25) {
    const value = cursor.bytes.readUInt16BE(cursor.offset);
    cursor.offset += 2;
    return value;
  }
  if (info === 26) {
    const value = cursor.bytes.readUInt32BE(cursor.offset);
    cursor.offset += 4;
    return value;
  }
  /*
   * 27 is a 64-bit length and 28-30 are reserved. Neither appears in an
   * attestation object or a COSE key, and a length this file cannot represent
   * exactly is refused rather than truncated into one it can.
   */
  throw new Error('CBOR: unsupported length encoding');
}

function readValue(cursor: Cursor): CborValue {
  const initial = cursor.bytes.readUInt8(cursor.offset++);
  const major = initial >> 5;
  const info = initial & 0x1f;

  switch (major) {
    case 0:
      return readArgument(cursor, info);
    case 1:
      return -1 - readArgument(cursor, info);
    case 2: {
      const length = readArgument(cursor, info);
      const slice = cursor.bytes.subarray(cursor.offset, cursor.offset + length);
      cursor.offset += length;
      return slice;
    }
    case 3: {
      const length = readArgument(cursor, info);
      const slice = cursor.bytes.subarray(cursor.offset, cursor.offset + length);
      cursor.offset += length;
      return slice.toString('utf8');
    }
    case 4: {
      const length = readArgument(cursor, info);
      const items: CborValue[] = [];
      for (let i = 0; i < length; i += 1) items.push(readValue(cursor));
      return items;
    }
    case 5: {
      const length = readArgument(cursor, info);
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < length; i += 1) {
        const key = readValue(cursor);
        map.set(key, readValue(cursor));
      }
      return map;
    }
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error('CBOR: unsupported simple value');
    default:
      throw new Error('CBOR: unsupported major type');
  }
}

/** Decode one CBOR item, and say so if bytes are left over. */
export function decodeCbor(bytes: Buffer): { value: CborValue; bytesRead: number } {
  const cursor: Cursor = { bytes, offset: 0 };
  const value = readValue(cursor);
  return { value, bytesRead: cursor.offset };
}

/* --------------------------------------------------------------------------
 * Authenticator data
 * ------------------------------------------------------------------------ */

export interface AuthenticatorData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  credentialId: Buffer | null;
  cosePublicKey: Buffer | null;
}

/**
 * The fixed-layout prefix, then the optional attested credential.
 *
 * Lengths are checked before every read. A truncated buffer must raise rather
 * than produce a short field that happens to compare equal to something.
 */
export function parseAuthenticatorData(bytes: Buffer): AuthenticatorData {
  if (bytes.length < 37) throw new Error('authenticator data is too short');
  const rpIdHash = bytes.subarray(0, 32);
  const flags = bytes.readUInt8(32);
  const signCount = bytes.readUInt32BE(33);

  const attested = (flags & 0x40) !== 0;
  if (!attested) {
    return {
      rpIdHash,
      userPresent: (flags & 0x01) !== 0,
      userVerified: (flags & 0x04) !== 0,
      signCount,
      credentialId: null,
      cosePublicKey: null,
    };
  }

  if (bytes.length < 55) throw new Error('attested credential data is too short');
  const idLength = bytes.readUInt16BE(53);
  const idStart = 55;
  const idEnd = idStart + idLength;
  if (bytes.length < idEnd) throw new Error('credential id runs past the end');
  const credentialId = bytes.subarray(idStart, idEnd);

  /*
   * The COSE key is the remainder, and CBOR says how long it really is. Taking
   * "the rest of the buffer" would accept trailing bytes nobody wrote; decoding
   * and then measuring is what makes a trailing-garbage credential a refusal.
   */
  const rest = bytes.subarray(idEnd);
  const { bytesRead } = decodeCbor(rest);
  if (bytesRead !== rest.length) throw new Error('trailing bytes after the credential public key');

  return {
    rpIdHash,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount,
    credentialId,
    cosePublicKey: rest,
  };
}

/* --------------------------------------------------------------------------
 * COSE keys
 * ------------------------------------------------------------------------ */

function coseMap(bytes: Buffer): Map<CborValue, CborValue> {
  const { value } = decodeCbor(bytes);
  if (!(value instanceof Map)) throw new Error('COSE key is not a map');
  return value;
}

/** The algorithm the credential was made with, from the key itself. */
export function coseAlgorithm(cosePublicKey: Buffer): number {
  const alg = coseMap(cosePublicKey).get(3);
  if (typeof alg !== 'number') throw new Error('COSE key declares no algorithm');
  return alg;
}

/**
 * A COSE key as something `crypto.verify` accepts.
 *
 * Imported as a JWK rather than assembled into DER by hand: the platform
 * already knows both shapes, and hand-built ASN.1 is exactly the kind of code
 * that is wrong in a way tests pass over.
 */
function publicKeyFrom(cosePublicKey: Buffer, algorithm: number) {
  const key = coseMap(cosePublicKey);
  if (algorithm === ES256) {
    const x = key.get(-2);
    const y = key.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error('ES256 key is missing a coordinate');
    return createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: bufferToBase64url(x), y: bufferToBase64url(y) },
      format: 'jwk',
    });
  }
  if (algorithm === RS256) {
    const n = key.get(-1);
    const e = key.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('RS256 key is missing a parameter');
    return createPublicKey({
      key: { kty: 'RSA', n: bufferToBase64url(n), e: bufferToBase64url(e) },
      format: 'jwk',
    });
  }
  throw new Error(`unsupported COSE algorithm ${algorithm}`);
}

/* --------------------------------------------------------------------------
 * The two verifications
 * ------------------------------------------------------------------------ */

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function readClientData(clientDataJSON: string): ClientData {
  const parsed: unknown = JSON.parse(base64urlToBuffer(clientDataJSON).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('client data is not an object');
  const data = parsed as Record<string, unknown>;
  if (typeof data['type'] !== 'string') throw new Error('client data has no type');
  if (typeof data['challenge'] !== 'string') throw new Error('client data has no challenge');
  if (typeof data['origin'] !== 'string') throw new Error('client data has no origin');
  return {
    type: data['type'],
    challenge: data['challenge'],
    origin: data['origin'],
    ...(typeof data['crossOrigin'] === 'boolean' ? { crossOrigin: data['crossOrigin'] } : {}),
  };
}

export type VerifyOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface RegistrationResult {
  credentialId: string;
  publicKey: string;
  algorithm: number;
  signCount: number;
}

/**
 * A new credential.
 *
 * Every condition is checked and a failure names which — but the *caller*
 * decides what to tell the outside world, because "your challenge was stale"
 * and "that origin is not this Brain" are both just a refusal to somebody
 * probing.
 */
export function verifyRegistration(input: {
  clientDataJSON: string;
  attestationObject: string;
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRpId: string;
  /** Require the authenticator to have verified the person, not just presence. */
  requireUserVerification?: boolean;
}): VerifyOutcome<RegistrationResult> {
  let client: ClientData;
  try {
    client = readClientData(input.clientDataJSON);
  } catch (error) {
    return { ok: false, reason: `client data unreadable: ${(error as Error).message}` };
  }

  if (client.type !== 'webauthn.create') return { ok: false, reason: 'wrong client data type' };
  if (client.challenge !== input.expectedChallenge) return { ok: false, reason: 'challenge mismatch' };
  if (client.origin !== input.expectedOrigin) return { ok: false, reason: 'origin mismatch' };

  let authData: AuthenticatorData;
  try {
    const { value } = decodeCbor(base64urlToBuffer(input.attestationObject));
    if (!(value instanceof Map)) return { ok: false, reason: 'attestation object is not a map' };
    const fmt = value.get('fmt');
    /*
     * Only `none`, because only `none` is asked for. A registration arriving
     * with a format this Brain did not request is refused rather than parsed:
     * accepting an attestation nobody asked for means verifying a statement
     * this file has no rule for.
     */
    if (fmt !== 'none') return { ok: false, reason: `unexpected attestation format ${String(fmt)}` };
    const raw = value.get('authData');
    if (!Buffer.isBuffer(raw)) return { ok: false, reason: 'attestation object has no authenticator data' };
    authData = parseAuthenticatorData(raw);
  } catch (error) {
    return { ok: false, reason: `attestation unreadable: ${(error as Error).message}` };
  }

  const expectedRpIdHash = createHash('sha256').update(input.expectedRpId).digest();
  if (!authData.rpIdHash.equals(expectedRpIdHash)) return { ok: false, reason: 'relying party mismatch' };
  if (!authData.userPresent) return { ok: false, reason: 'no user present' };
  if (input.requireUserVerification !== false && !authData.userVerified) {
    return { ok: false, reason: 'user was not verified by the authenticator' };
  }
  if (!authData.credentialId || !authData.cosePublicKey) {
    return { ok: false, reason: 'registration carried no credential' };
  }

  let algorithm: number;
  try {
    algorithm = coseAlgorithm(authData.cosePublicKey);
    // Proves the key is importable now, rather than at the first sign-in.
    publicKeyFrom(authData.cosePublicKey, algorithm);
  } catch (error) {
    return { ok: false, reason: `public key unusable: ${(error as Error).message}` };
  }
  if (!(SUPPORTED_ALGORITHMS as readonly number[]).includes(algorithm)) {
    return { ok: false, reason: `unsupported algorithm ${algorithm}` };
  }

  return {
    ok: true,
    value: {
      credentialId: bufferToBase64url(authData.credentialId),
      publicKey: bufferToBase64url(authData.cosePublicKey),
      algorithm,
      signCount: authData.signCount,
    },
  };
}

/**
 * A sign-in with a credential already registered.
 *
 * The signature is over `authenticatorData || sha256(clientDataJSON)` — the
 * concatenation is the whole reason a replayed client data blob does not work,
 * because the challenge inside it is covered by the signature.
 */
export function verifyAssertion(input: {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRpId: string;
  storedPublicKey: string;
  storedAlgorithm: number;
  storedSignCount: number;
  requireUserVerification?: boolean;
}): VerifyOutcome<{ signCount: number }> {
  let client: ClientData;
  try {
    client = readClientData(input.clientDataJSON);
  } catch (error) {
    return { ok: false, reason: `client data unreadable: ${(error as Error).message}` };
  }

  if (client.type !== 'webauthn.get') return { ok: false, reason: 'wrong client data type' };
  if (client.challenge !== input.expectedChallenge) return { ok: false, reason: 'challenge mismatch' };
  if (client.origin !== input.expectedOrigin) return { ok: false, reason: 'origin mismatch' };

  const authBytes = base64urlToBuffer(input.authenticatorData);
  let authData: AuthenticatorData;
  try {
    authData = parseAuthenticatorData(authBytes);
  } catch (error) {
    return { ok: false, reason: `authenticator data unreadable: ${(error as Error).message}` };
  }

  const expectedRpIdHash = createHash('sha256').update(input.expectedRpId).digest();
  if (!authData.rpIdHash.equals(expectedRpIdHash)) return { ok: false, reason: 'relying party mismatch' };
  if (!authData.userPresent) return { ok: false, reason: 'no user present' };
  if (input.requireUserVerification !== false && !authData.userVerified) {
    return { ok: false, reason: 'user was not verified by the authenticator' };
  }

  const signed = Buffer.concat([
    authBytes,
    createHash('sha256').update(base64urlToBuffer(input.clientDataJSON)).digest(),
  ]);

  let good = false;
  try {
    const key = publicKeyFrom(base64urlToBuffer(input.storedPublicKey), input.storedAlgorithm);
    good = cryptoVerify(
      'sha256',
      signed,
      input.storedAlgorithm === RS256 ? key : { key, dsaEncoding: 'der' },
      base64urlToBuffer(input.signature),
    );
  } catch (error) {
    return { ok: false, reason: `signature unverifiable: ${(error as Error).message}` };
  }
  if (!good) return { ok: false, reason: 'signature did not verify' };

  /*
   * A counter that has not advanced is the documented signal of a cloned
   * credential — but only when the authenticator keeps one at all. Most
   * platform passkeys report zero forever, so zero is not evidence of anything
   * and must not be treated as it.
   */
  if (input.storedSignCount > 0 && authData.signCount > 0 && authData.signCount <= input.storedSignCount) {
    return { ok: false, reason: 'signature counter did not advance' };
  }

  return { ok: true, value: { signCount: authData.signCount } };
}
