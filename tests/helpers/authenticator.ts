/**
 * A synthetic authenticator, made of Node crypto.
 *
 * A fixture blob copied from a browser would prove the verifier parses that
 * blob. Building the credential here — a genuine P-256 key, CBOR encoded by the
 * caller, a signature over exactly the bytes the specification says are signed —
 * proves the verifier accepts a correct credential, and, more importantly, that
 * every refusal a test exercises is refusing something that would otherwise
 * have worked.
 *
 * It lives beside the tests rather than in `server/` on purpose: nothing in the
 * application may ever be able to mint a credential, because a Brain that could
 * would be manufacturing the one thing a person is supposed to be holding.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { ES256, bufferToBase64url } from '../../server/services/identity/webauthn.ts';

/* ---------------------------------------------------------------- CBOR out */

function cborUnsigned(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  const out = Buffer.alloc(3);
  out.writeUInt8((major << 5) | 25, 0);
  out.writeUInt16BE(value, 1);
  return out;
}

export function cborBytes(value: Buffer): Buffer {
  return Buffer.concat([cborUnsigned(2, value.length), value]);
}

export function cborText(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([cborUnsigned(3, bytes.length), bytes]);
}

export function cborNegative(value: number): Buffer {
  return cborUnsigned(1, -1 - value);
}

export function cborMap(entries: [Buffer, Buffer][]): Buffer {
  return Buffer.concat([cborUnsigned(5, entries.length), ...entries.flat()]);
}

export { cborUnsigned };

/* -------------------------------------------------- a synthetic passkey */

export interface SyntheticAuthenticator {
  credentialId: string;
  register(
    challenge: string,
    options?: { flags?: number; rpId?: string; origin?: string },
  ): { clientDataJSON: string; attestationObject: string };
  assert(
    challenge: string,
    options?: { signCount?: number; origin?: string; flags?: number; rpId?: string },
  ): { clientDataJSON: string; authenticatorData: string; signature: string };
}

export function authenticator(options: { rpId: string; credentialId?: string }): SyntheticAuthenticator {
  const RP_ID = options.rpId;
  const ORIGIN = `https://${RP_ID}`;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const credentialId = Buffer.from(options.credentialId ?? 'a-credential-id-0123');

  const coseKey = cborMap([
    [cborUnsigned(0, 1), cborUnsigned(0, 2)], // kty: EC2
    [cborUnsigned(0, 3), cborNegative(ES256)], // alg: ES256
    [cborNegative(-1), cborUnsigned(0, 1)], // crv: P-256
    [cborNegative(-2), cborBytes(Buffer.from(jwk.x, 'base64url'))],
    [cborNegative(-3), cborBytes(Buffer.from(jwk.y, 'base64url'))],
  ]);

  function authData(opts: {
    attested: boolean;
    flags?: number;
    signCount?: number;
    rpId?: string;
  }): Buffer {
    const rpIdHash = createHash('sha256').update(opts.rpId ?? RP_ID).digest();
    const flags = Buffer.from([opts.flags ?? (opts.attested ? 0x45 : 0x05)]);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(opts.signCount ?? 0);
    if (!opts.attested) return Buffer.concat([rpIdHash, flags, counter]);
    const aaguid = Buffer.alloc(16);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    return Buffer.concat([rpIdHash, flags, counter, aaguid, idLength, credentialId, coseKey]);
  }

  function clientData(type: string, challenge: string, origin = ORIGIN): string {
    return Buffer.from(JSON.stringify({ type, challenge, origin }), 'utf8').toString('base64url');
  }

  return {
    credentialId: bufferToBase64url(credentialId),
    register(challenge, opts = {}) {
      const attestationObject = cborMap([
        [cborText('fmt'), cborText('none')],
        [cborText('attStmt'), cborMap([])],
        [cborText('authData'), cborBytes(authData({ attested: true, ...opts }))],
      ]);
      return {
        clientDataJSON: clientData('webauthn.create', challenge, opts.origin),
        attestationObject: bufferToBase64url(attestationObject),
      };
    },
    assert(challenge, opts = {}) {
      const bytes = authData({ attested: false, ...opts });
      const clientDataJSON = clientData('webauthn.get', challenge, opts.origin);
      const signed = Buffer.concat([
        bytes,
        createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest(),
      ]);
      return {
        clientDataJSON,
        authenticatorData: bufferToBase64url(bytes),
        signature: bufferToBase64url(cryptoSign('sha256', signed, privateKey)),
      };
    },
  };
}
